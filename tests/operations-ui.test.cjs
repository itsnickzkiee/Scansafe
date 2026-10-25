'use strict';

// Run the actual controller in a small DOM fixture. No production browser,
// camera, network connection, or external account is used by this suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const projectRoot = path.resolve(__dirname, '..');
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const decode = value => String(value).replace(/&(?:amp|lt|gt|quot|apos|#39|#039);/g, text => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&#039;': "'" }[text]));
const copy = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; let reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const settle = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };

class MiniElement {
  constructor(tagName, ownerDocument, text = '') {
    this.tagName = tagName.toUpperCase(); this.ownerDocument = ownerDocument;
    this.parentElement = null; this.children = []; this.attributes = {}; this.handlers = new Map();
    this.style = {}; this.dataset = {}; this._text = text; this._value = undefined; this.disabled = false; this.hidden = false;
    this.classList = {
      contains: name => this.classes().has(name),
      add: (...names) => { const classes = this.classes(); names.forEach(name => classes.add(name)); this.attributes.class = [...classes].join(' '); },
      remove: (...names) => { const classes = this.classes(); names.forEach(name => classes.delete(name)); this.attributes.class = [...classes].join(' '); },
      toggle: (name, force) => { const classes = this.classes(); const enabled = force ?? !classes.has(name); enabled ? classes.add(name) : classes.delete(name); this.attributes.class = [...classes].join(' '); return enabled; }
    };
  }
  classes() { return new Set((this.attributes.class || '').split(/\s+/).filter(Boolean)); }
  get className() { return this.attributes.class || ''; } set className(value) { this.attributes.class = String(value); }
  get id() { return this.attributes.id || ''; } set id(value) { this.setAttribute('id', value); }
  get name() { return this.attributes.name || ''; }
  get checked() { return this._checked ?? this.hasAttribute('checked'); }
  set checked(value) { this._checked = !!value; }
  get type() { return this.attributes.type || ''; }
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tagName === 'SELECT') return (this.querySelector('option[selected]') || this.querySelector('option'))?.value || '';
    if (this.tagName === 'TEXTAREA') return this.textContent;
    return this.attributes.value ?? (this.tagName === 'OPTION' ? this.textContent : '');
  }
  set value(value) { this._value = String(value); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get innerHTML() { return escape(this._text) + this.children.map(child => child.outerHTML).join(''); }
  set innerHTML(markup) {
    this.children = []; this._text = ''; const stack = [this];
    for (const token of String(markup).match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) || []) {
      if (token.startsWith('<!--')) continue;
      if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
      if (token.startsWith('<')) {
        const tag = token.match(/^<\s*([\w-]+)/)?.[1]; if (!tag) continue;
        const element = new MiniElement(tag, this.ownerDocument);
        const attrSource = token.slice(token.indexOf(tag) + tag.length).replace(/\/?\s*>$/, '');
        for (const attr of attrSource.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) element.setAttribute(attr[1], decode(attr[2] ?? attr[3] ?? attr[4] ?? ''));
        stack.at(-1).appendChild(element);
        if (!/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(tag) && !/\/>$/.test(token)) stack.push(element);
      } else stack.at(-1).appendChild(new MiniElement('#text', this.ownerDocument, decode(token)));
    }
  }
  get outerHTML() {
    if (this.tagName === '#TEXT') return escape(this._text);
    const attrs = Object.entries(this.attributes).map(([key, value]) => ' ' + key + '="' + escape(value) + '"').join('');
    return '<' + this.tagName.toLowerCase() + attrs + '>' + this.innerHTML + '</' + this.tagName.toLowerCase() + '>';
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
    if (name === 'disabled') this.disabled = true;
    if (name === 'hidden') this.hidden = true;
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  removeAttribute(name) { delete this.attributes[name]; if (name === 'disabled') this.disabled = false; if (name === 'hidden') this.hidden = false; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  append(...children) { children.forEach(child => this.appendChild(typeof child === 'string' ? new MiniElement('#text', this.ownerDocument, child) : child)); }
  contains(node) { for (let element = node; element; element = element.parentElement) if (element === this) return true; return false; }
  insertAdjacentHTML(position, markup) { assert.equal(position, 'beforeend'); const fragment = new MiniElement('fragment', this.ownerDocument); fragment.innerHTML = markup; fragment.children.slice().forEach(child => this.appendChild(child)); }
  replaceChildren(...children) { this.children = []; this._text = ''; this.append(...children); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
  matches(selector) {
    return selector.split(',').some(part => {
      const token = part.trim();
      if (token === '*') return true;
      const tag = token.match(/^[\w-]+/)?.[0]; if (tag && tag.toUpperCase() !== this.tagName) return false;
      const id = token.match(/#([\w-]+)/)?.[1]; if (id && id !== this.id) return false;
      for (const match of token.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(match[1])) return false;
      for (const match of token.matchAll(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g)) {
        if (!this.hasAttribute(match[1])) return false;
        if (match[2] !== undefined && this.getAttribute(match[1]) !== match[2]) return false;
      }
      return true;
    });
  }
  closest(selector) { for (let element = this; element; element = element.parentElement) if (element.matches(selector)) return element; return null; }
  querySelectorAll(selector) {
    const all = []; const visit = parent => { for (const child of parent.children) { all.push(child); visit(child); } }; visit(this);
    return all.filter(element => selector.split(',').some(part => {
      const tokens = part.trim().split(/\s+/); if (!element.matches(tokens.pop())) return false;
      let ancestor = element.parentElement;
      while (tokens.length) { const token = tokens.pop(); while (ancestor && !ancestor.matches(token)) ancestor = ancestor.parentElement; if (!ancestor) return false; ancestor = ancestor.parentElement; }
      return true;
    }));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  get elements() { return this.querySelectorAll('input, select, textarea, button'); }
  addEventListener(name, callback) { if (!this.handlers.has(name)) this.handlers.set(name, []); this.handlers.get(name).push(callback); }
  removeEventListener(name, callback) { this.handlers.set(name, (this.handlers.get(name) || []).filter(handler => handler !== callback)); }
  async fire(type, detail = {}) {
    const event = { type, target: this, currentTarget: this, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...detail };
    for (let element = this; element; element = element.parentElement) {
      event.currentTarget = element;
      for (const callback of element.handlers.get(type) || []) await callback(event);
      if (event.stopped) break;
    }
    await settle(); return event;
  }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() {}
}

function documentFixture() {
  const document = new MiniElement('document', null); document.ownerDocument = document;
  document.body = document.appendChild(new MiniElement('body', document)); document.visibilityState = 'visible'; document.activeElement = null;
  document.body.innerHTML = '<main id="evacuationOperationsApp"></main>';
  document.getElementById = id => document.querySelector('#' + id);
  document.createElement = tag => new MiniElement(tag, document);
  return document;
}

function summary(overrides = {}) {
  return { groups: 2, people: 7, evacuees: 3, pending_requests: 2, occupied: 7, capacity: 100, spaces: 6, discrepancies: 0, ...overrides };
}
function operation(overrides = {}) {
  return { operation_id: 9, name: 'October Flood Response', status: 'active', opened_at: '2026-10-25T01:00:00Z', ...overrides };
}
function snapshot(overrides = {}) {
  return { owner_id: 'admin-id', mode: 'admin', current_operation: operation(), history: [], summary: summary(), readmission_groups: [{ group_id: 4, full_name: 'Returning Family', group_size: 3, last_operation_name: 'Previous Flood' }], ...overrides };
}
function harness(configuration = {}) {
  const document = documentFixture();
  const calls = []; const intervals = []; const related = [];
  let identity = { userId: 'admin-id', role: 'admin' };
  let data = configuration.snapshot || snapshot();
  let responder = null;
  const client = { rpc: async (name, args) => {
    calls.push({ name, args: copy(args || {}) });
    if (responder) { const result = await responder(name, args); if (result !== undefined) return result; }
    if (name === 'get_scansafe_operations') return { data: copy(data), error: null };
    if (name === 'preview_close_scansafe_operation') return { data: { operation_id: data.current_operation.operation_id, name: data.current_operation.name, revision: 'revision-v1', summary: copy(data.summary) }, error: null };
    return { data: null, error: null };
  } };
  const context = { document, console, crypto: { randomUUID: crypto.randomUUID },
    setInterval: fn => { intervals.push(fn); return intervals.length; }, clearInterval() {} };
  context.window = context;
  const sandbox = vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(projectRoot, 'assets/evacuation-operations.js'), 'utf8'), sandbox, { filename: 'assets/evacuation-operations.js' });
  const api = sandbox.ScanSafeOperations;
  return { document, calls, api, intervals, related,
    node: id => document.getElementById(id),
    get text() { return document.getElementById('evacuationOperationsApp').textContent; },
    get markup() { return document.getElementById('evacuationOperationsApp').innerHTML; },
    setSnapshot(value) { data = value; },
    setIdentity(value) { identity = value; },
    respond(fn) { responder = fn; },
    async init() { await api.init({ getClient: () => client, getContext: () => identity, refresh: () => { related.push('refresh'); } }); await settle(); },
    async refresh() { await api.refresh(); await settle(); }
  };
}
async function input(h, id, value) {
  const element = h.node(id); assert.ok(element, id + ' exists');
  if (typeof value === 'boolean') element.checked = value; else element.value = value;
  await element.fire('input');
}
async function preview(h) { await h.node('operationsPreviewClose').fire('click'); await settle(); }
async function confirmDraft(h, overrides = {}) {
  const values = { operationsCloseReason: 'All families returned home safely.', operationsConfirmDeparted: true, operationsConfirmText: 'CLOSE', operationsCancelPending: true, ...overrides };
  for (const [id, value] of Object.entries(values)) if (h.node(id)) await input(h, id, value);
}
const mutationCalls = h => h.calls.filter(call => /^(start_scansafe|close_scansafe|reconcile_scansafe|readmit_scansafe)/.test(call.name));

test('initial load and close review perform no mutations', async () => {
  const h = harness(); await h.init(); await preview(h);
  assert.equal(mutationCalls(h).length, 0);
  assert.equal(h.api.inspect().preview.revision, 'revision-v1');
  assert.match(h.text, /End October Flood Response/);
  assert.match(h.text, /2 unresolved needs requests/);
  assert.equal(h.node('operationsConfirmClose').disabled, true);
});

test('only a signed-in administrator can load operation records or use controls', async () => {
  for (const identity of [{ userId: 'staff-id', role: 'staff' }, { userId: 'nick-id', role: 'evacuee' }, { userId: null, role: null }]) {
    const h = harness(); h.setIdentity(identity); await h.init();
    assert.equal(h.calls.length, 0);
    assert.equal(h.node('evacuationOperationsApp').hidden, true);
  }
});

test('close requires a departure checkbox, exact CLOSE, reason and explicit pending cancellation', async () => {
  const missing = [
    { operationsConfirmDeparted: false }, { operationsConfirmText: 'close' },
    { operationsConfirmText: '' }, { operationsCloseReason: '   ' },
    { operationsCancelPending: false }
  ];
  for (const incomplete of missing) {
    const h = harness(); await h.init(); await preview(h); await confirmDraft(h, incomplete);
    assert.equal(h.node('operationsConfirmClose').disabled, true);
    await h.node('operationsCloseForm').fire('submit'); await settle();
    assert.equal(mutationCalls(h).length, 0, 'dispatched form events must enforce each confirmation gate');
  }
});

test('complete close submits the reviewed revision once and refreshes live views after confirmation', async () => {
  const h = harness(); await h.init(); await preview(h); await confirmDraft(h);
  const gate = deferred();
  h.respond((name) => { if (name === 'close_scansafe_operation') return gate.promise; });
  await h.node('operationsCloseForm').fire('submit');
  await h.node('operationsCloseForm').fire('submit');
  assert.equal(mutationCalls(h).length, 1, 'double submit must be ignored');
  assert.deepEqual(mutationCalls(h)[0].args, { p_operation_id: 9, p_expected_revision: 'revision-v1', p_confirm_text: 'CLOSE', p_reason: 'All families returned home safely.', p_cancel_pending: true });
  h.setSnapshot(snapshot({ current_operation: null, summary: summary({ groups: 0, people: 0, evacuees: 0, pending_requests: 0, occupied: 0 }) }));
  gate.resolve({ data: operation({ status: 'closed', summary: { groups: 2, people: 7, evacuees: 3, cancelled_requests: 2 } }), error: null });
  await settle();
  assert.equal(h.api.inspect().preview, null);
  assert.match(h.node('operationsFeedback').textContent, /Evacuation ended/);
  assert.equal(h.related.length, 1);
  assert.equal(h.node('operationsStartForm').hidden, false);
});

test('no pending requests means cancellation is not required and false is sent', async () => {
  const h = harness({ snapshot: snapshot({ summary: summary({ pending_requests: 0 }) }) }); await h.init(); await preview(h); await confirmDraft(h);
  assert.equal(h.node('operationsCancelPending'), null);
  assert.equal(h.node('operationsConfirmClose').disabled, false);
  h.respond((name, args) => name === 'close_scansafe_operation' ? { data: null, error: { code: '40001', message: 'Changed' } } : undefined);
  await h.node('operationsCloseForm').fire('submit'); await settle();
  assert.equal(mutationCalls(h)[0].args.p_cancel_pending, false);
});

test('40001 invalidates review, clears consent and preserves closure reason', async () => {
  const h = harness(); await h.init(); await preview(h); await confirmDraft(h);
  h.respond(name => name === 'close_scansafe_operation' ? { data: null, error: { code: '40001', message: 'Changed' } } : undefined);
  await h.node('operationsCloseForm').fire('submit'); await settle();
  assert.equal(h.api.inspect().preview.stale, true);
  assert.equal(h.node('operationsCloseReason').value, 'All families returned home safely.');
  assert.equal(h.node('operationsConfirmDeparted').checked, false);
  assert.equal(h.node('operationsCancelPending').checked, false);
  assert.equal(h.node('operationsConfirmText').value, '');
  assert.equal(h.node('operationsConfirmClose').disabled, true);
  await h.node('operationsCloseForm').fire('submit');
  assert.equal(mutationCalls(h).length, 1, 'stale preview cannot be resubmitted');
  await h.node('operationsRefreshPreview').fire('click'); await settle();
  assert.equal(h.api.inspect().preview.stale, false);
  assert.equal(h.node('operationsConfirmDeparted').checked, false);
  assert.equal(h.node('operationsConfirmClose').disabled, true, 'refreshing the review never reapproves it');
});

test('polling preserves drafts and invalidates approval only when operation counts change', async () => {
  const h = harness(); await h.init(); await preview(h); await confirmDraft(h);
  await h.refresh();
  assert.equal(h.node('operationsCloseReason').value, 'All families returned home safely.');
  assert.equal(h.node('operationsConfirmDeparted').checked, true);
  h.setSnapshot(snapshot({ summary: summary({ people: 8, occupied: 8 }) }));
  await h.refresh();
  assert.equal(h.api.inspect().preview.stale, true);
  assert.equal(h.node('operationsCloseReason').value, 'All families returned home safely.');
  assert.equal(h.node('operationsConfirmDeparted').checked, false);
});

test('an account change clears private drafts and ignores in-flight records', async () => {
  const h = harness(); const gate = deferred();
  h.respond(name => name === 'get_scansafe_operations' ? gate.promise : undefined);
  const initial = h.init(); await settle();
  h.setIdentity({ userId: 'other-user', role: 'evacuee' });
  await h.refresh();
  gate.resolve({ data: snapshot({ history: [{ name: 'PRIVATE OLD OWNER HISTORY' }] }), error: null });
  await initial; await settle();
  assert.doesNotMatch(h.text, /PRIVATE OLD OWNER HISTORY/);
  assert.equal(h.node('evacuationOperationsApp').hidden, true);
  assert.equal(h.api.inspect().loaded, false);
});

test('an account change ignores an in-flight close confirmation', async () => {
  const h = harness(); await h.init(); await preview(h); await confirmDraft(h);
  const gate = deferred(); h.respond(name => name === 'close_scansafe_operation' ? gate.promise : undefined);
  await h.node('operationsCloseForm').fire('submit');
  h.setIdentity({ userId: 'nick-id', role: 'evacuee' }); await h.refresh();
  gate.resolve({ data: operation({ status: 'closed', summary: { groups: 2, people: 7 } }), error: null }); await settle();
  assert.doesNotMatch(h.text, /Evacuation ended|All families returned home/);
  assert.equal(h.related.length, 0);
});

test('start retries retain the same token until the operation name changes', async () => {
  const h = harness({ snapshot: snapshot({ current_operation: null }) }); await h.init();
  await input(h, 'operationsStartName', 'Next Flood');
  h.respond(name => name === 'start_scansafe_operation' ? { data: null, error: { message: 'Failed to fetch' } } : undefined);
  await h.node('operationsStartForm').fire('submit'); await settle();
  await h.node('operationsStartForm').fire('submit'); await settle();
  const attempts = mutationCalls(h);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].args.p_client_token, attempts[1].args.p_client_token);
  assert.match(attempts[0].args.p_client_token, /^[0-9a-f-]{36}$/);
  assert.equal(h.node('operationsStartName').value, 'Next Flood');
  await input(h, 'operationsStartName', 'New Name'); await h.node('operationsStartForm').fire('submit'); await settle();
  assert.notEqual(mutationCalls(h)[2].args.p_client_token, attempts[0].args.p_client_token);
});

test('a pre-mutation poll cannot overwrite the fresh state after a confirmed mutation', async () => {
  const before = snapshot({ current_operation: null });
  const h = harness({ snapshot: before }); await h.init();
  await input(h, 'operationsStartName', 'Next Flood');
  const staleRead = deferred(); let getCount = 0;
  h.respond(name => {
    if (name === 'get_scansafe_operations') {
      getCount += 1;
      if (getCount === 1) return staleRead.promise;
    }
    if (name === 'start_scansafe_operation') {
      h.setSnapshot(snapshot({ current_operation: operation({ name: 'Next Flood' }) }));
      return { data: operation({ name: 'Next Flood' }), error: null };
    }
    return undefined;
  });
  const poll = h.refresh(); await settle();
  await h.node('operationsStartForm').fire('submit'); await settle();
  assert.equal(h.api.inspect().operationId, 9);
  assert.equal(getCount, 2, 'a separate fresh read runs after the mutation instead of reusing the old promise');
  staleRead.resolve({ data: before, error: null }); await poll; await settle();
  assert.equal(h.api.inspect().operationId, 9, 'late pre-mutation state is ignored');
  assert.equal(h.node('operationsActivePanel').hidden, false);
  assert.equal(h.related.length, 1);
});

test('incomplete start, close and reconcile responses never claim success', async () => {
  const start = harness({ snapshot: snapshot({ current_operation: null }) }); await start.init(); await input(start, 'operationsStartName', 'Next Flood');
  start.respond(name => name === 'start_scansafe_operation' ? { data: { operation_id: 10 }, error: null } : undefined);
  await start.node('operationsStartForm').fire('submit'); await settle();
  assert.doesNotMatch(start.node('operationsFeedback').textContent, /Evacuation started/);
  assert.equal(start.related.length, 0);
  const close = harness(); await close.init(); await preview(close); await confirmDraft(close);
  close.respond(name => name === 'close_scansafe_operation' ? { data: { operation_id: 9, status: 'closed' }, error: null } : undefined);
  await close.node('operationsCloseForm').fire('submit'); await settle();
  assert.doesNotMatch(close.node('operationsFeedback').textContent, /Evacuation ended/);
  assert.equal(close.related.length, 0);
  const reconcile = harness(); await reconcile.init();
  reconcile.respond(name => name === 'reconcile_scansafe_occupancy' ? { data: { spaces_updated: 2 }, error: null } : undefined);
  await reconcile.node('operationsReconcile').fire('click'); await settle();
  assert.doesNotMatch(reconcile.node('operationsFeedback').textContent, /Map occupancy was recalculated/);
  assert.equal(reconcile.related.length, 0);
});

test('reconcile refreshes only after explicit reconciled true confirmation', async () => {
  const h = harness(); await h.init(); await preview(h);
  h.respond(name => name === 'reconcile_scansafe_occupancy' ? { data: { reconciled: true, spaces_updated: 1 }, error: null } : undefined);
  await h.node('operationsReconcile').fire('click'); await settle();
  assert.equal(h.related.length, 1);
  assert.equal(h.api.inspect().preview.stale, true);
  assert.match(h.node('operationsFeedback').textContent, /Map occupancy was recalculated/);
});

test('readmission uses a real server group, requires reason and explains that scanning assigns space', async () => {
  const h = harness(); await h.init();
  await input(h, 'operationsReadmitGroup', '999'); await input(h, 'operationsReadmitReason', 'Flood returned');
  await h.node('operationsReadmitForm').fire('submit'); await settle();
  assert.equal(mutationCalls(h).length, 0);
  await input(h, 'operationsReadmitGroup', '4');
  h.respond(name => name === 'readmit_scansafe_group' ? { data: { group_id: 4, operation_id: 9, readmitted: true }, error: null } : undefined);
  await h.node('operationsReadmitForm').fire('submit'); await settle();
  assert.equal(mutationCalls(h).length, 1);
  assert.deepEqual(mutationCalls(h)[0].args, { p_group_id: 4, p_reason: 'Flood returned' });
  assert.match(h.node('operationsFeedback').textContent, /Scan an approved barcode/);
});

test('missing migration is visible and wrong-owner records never render', async () => {
  const missing = harness(); missing.respond(() => ({ data: null, error: { code: 'PGRST202', message: 'Could not find function' } })); await missing.init();
  assert.match(missing.text, /SUPABASE_EVACUATION_OPERATIONS\.sql/);
  const wrong = harness({ snapshot: snapshot({ owner_id: 'another-admin', current_operation: operation({ name: 'PRIVATE WRONG OWNER' }) }) }); await wrong.init();
  assert.doesNotMatch(wrong.text, /PRIVATE WRONG OWNER/);
  assert.equal(wrong.api.inspect().loaded, false);
});

test('operation history and archived stays escape names, reasons, spaces and request statuses', async () => {
  const marker = '<img src=x onerror="globalThis.injected=true" data-ops-injected="yes">';
  const h = harness({ snapshot: snapshot({ history: [operation({ name: marker, status: 'closed', close_reason: marker, closed_at: '2026-10-25T03:00:00Z', summary: { groups: 1, people: 3, evacuees: 1, cancelled_requests: 1 }, stays: [{ group_id: 4, full_name: marker, group_size: 3, admitted_at: '2026-10-24T03:00:00Z', released_at: '2026-10-25T03:00:00Z', status: marker, assignments: [{ space_name: marker, assignment_status: marker, assigned_at: '2026-10-24T03:00:00Z', completed_at: '2026-10-25T03:00:00Z' }], requests: [{ request_id: 14, status: marker }] }] })] }) });
  await h.init();
  assert.equal(h.document.querySelector('[data-ops-injected]'), null);
  assert.ok(h.text.includes(marker));
  assert.match(h.text, /Archived stays/);
  assert.match(h.text, /Admitted:/);
  assert.match(h.text, /Released:/);
});

