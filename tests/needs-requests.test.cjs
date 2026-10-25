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
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

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
  document.body.innerHTML = '<main id="needsApp"></main><span data-needs-count></span>';
  document.getElementById = id => document.querySelector('#' + id);
  document.createElement = tag => new MiniElement(tag, document);
  return document;
}

function sampleSnapshot(options = {}) {
  return {
    mode: options.mode || 'evacuee', owner_id: options.ownerId || 'nick-id', eligible: options.eligible ?? true,
    eligibility_reason: options.eligible === false ? 'Waiting for accommodation assignment.' : '',
    account: { evacuee_id: 50, auth_user_id: options.ownerId || 'nick-id', full_name: 'Nick Reyes', group_id: 12, group_size: 3, assignment_id: 22, space_id: 2, space_code: 'A2', space_name: 'Hallway A2', shelter_name: 'Main School Building' },
    requests: [], stats: { pending: 0, total: 0, active: 0, urgent: 0, updates: 0 },
    ...options
  };
}

function sampleRequest(overrides = {}) {
  return {
    request_id: 100, owner_id: 'nick-id', full_name: 'Nick Reyes', group_id: 12, group_size: 3, assignment_id: 22,
    space_code: 'A2', space_name: 'Hallway A2', shelter_name: 'Main School Building',
    current_assignment: { assignment_id: 22, space_id: 2, space_code: 'A2', space_name: 'Hallway A2', shelter_name: 'Main School Building' },
    notes: 'For our family', priority: 'normal', status: 'pending', response: '', version: 1,
    created_at: '2026-10-24T04:00:00Z', updated_at: '2026-10-24T04:00:00Z', provided_at: null, provided_by: null,
    items: [{ category: 'water', item_name: 'Drinking water', quantity: 3, unit: 'bottles' }], events: [], ...overrides
  };
}

function harness(options = {}) {
  const document = documentFixture(); const calls = []; const intervals = [];
  let identity = { userId: options.mode === 'staff' ? 'admin-id' : 'nick-id', role: options.mode === 'staff' ? 'admin' : 'evacuee' };
  let snapshot = options.snapshot || sampleSnapshot(options.mode === 'staff' ? { mode: 'staff', owner_id: 'admin-id', account: null, eligible: false } : {});
  let responder = null;
  const client = { rpc: async (name, args) => { calls.push({ name, args: args === undefined ? undefined : copy(args) }); if (responder) { const result = await responder(name, args); if (result !== undefined) return result; } if (name === 'get_scansafe_need_requests') return { data: copy(snapshot), error: null }; if (name === 'get_scansafe_need_request_counts') return { data: { mode: snapshot.mode, owner_id: identity.userId, eligible: snapshot.eligible, ...snapshot.stats }, error: null }; return { data: sampleRequest(), error: null }; } };
  const context = { document, location: { pathname: options.page || (options.mode === 'staff' ? '/needs-requests.html' : '/user-needs.html') }, console,
    crypto: { randomUUID: crypto.randomUUID }, setInterval: fn => { intervals.push(fn); return intervals.length; }, clearInterval() {},
    setTimeout: () => 1, clearTimeout() {}, addEventListener() {}, removeEventListener() {}, CustomEvent: class { constructor(type) { this.type = type; } },
    URLSearchParams, HTMLElement: MiniElement, Event: class { constructor(type) { this.type = type; } },
    navigator: {}, toast() {}, ScanSafeDB: { client, session: { user: { id: identity.userId } }, profile: { role: identity.role } }
  };
  context.window = context; const sandbox = vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(projectRoot, 'assets/needs-requests.js'), 'utf8'), sandbox, { filename: 'assets/needs-requests.js' });
  const api = sandbox.ScanSafeNeeds;
  assert.ok(api && typeof api.init === 'function', 'needs controller API must exist');
  return {
    context: sandbox, document, calls, api, intervals,
    node: id => document.getElementById(id),
    get markup() { return document.getElementById('needsApp').innerHTML; },
    get text() { return document.getElementById('needsApp').textContent; },
    setSnapshot(value) { snapshot = value; },
    respond(fn) { responder = fn; },
    setIdentity(value) { identity = value; context.ScanSafeDB.session = value.userId ? { user: { id: value.userId } } : null; context.ScanSafeDB.profile = { role: value.role }; },
    async init() { await api.init({ getClient: () => client, getContext: () => identity }); await settle(); },
    async refresh() { await api.refresh(); await settle(); }
  };
}

test('unassigned evacuees see the waiting reason and cannot send a request', async () => {
  const snapshot = sampleSnapshot({ eligible: false });
  snapshot.account.assignment_id = null; snapshot.account.space_id = null; snapshot.account.space_name = null; snapshot.account.space_code = null;
  const h = harness({ snapshot }); await h.init();
  assert.equal(h.api.inspect().eligible, false);
  assert.match(h.text, /Waiting for accommodation assignment/i);
  const submit = h.node('needsSubmit'); assert.ok(submit, 'request form submit control is present'); assert.equal(submit.disabled, true);
  const form = h.node('needsForm'); if (form) await form.fire('submit');
  assert.equal(h.calls.filter(call => call.name === 'submit_scansafe_need_request').length, 0, 'assignment gate must block a manually dispatched form event too');
});

test('assigned account details are supplied by the server and enable requesting needs', async () => {
  const h = harness(); await h.init();
  assert.equal(h.api.inspect().eligible, true);
  assert.match(h.text, /Nick Reyes/); assert.match(h.text, /Hallway A2/); assert.match(h.text, /Main School Building/);
  assert.equal(h.node('needsSubmit').disabled, false);
  assert.equal(h.document.querySelector('input[name="owner_id"]'), null, 'identity must not be an editable client field');
  assert.equal(h.document.querySelector('input[name="space_id"]'), null, 'space must be determined on the server');
});

test('empty history shows a truthful empty state without sample people or requests', async () => {
  const h = harness(); await h.init();
  assert.equal(h.api.inspect().requestCount, 0);
  assert.match(h.text, /no.*requests|request.*appear|haven.t.*request/i);
  assert.doesNotMatch(h.text, /Juan Dela Cruz|Maria Santos|Pedro Reyes|REQ-1042/);
});

test('wrong-owner or wrong-mode snapshots fail closed and do not display their requests', async () => {
  for (const invalid of [{ owner_id: 'someone-else' }, { mode: 'staff' }]) {
    const h = harness({ snapshot: sampleSnapshot({ ...invalid, requests: [sampleRequest({ full_name: 'PRIVATE WRONG OWNER', notes: 'PRIVATE NEEDS NOTE' })] }) });
    await h.init();
    assert.equal(h.api.inspect().eligible, false);
    assert.doesNotMatch(h.text, /PRIVATE WRONG OWNER|PRIVATE NEEDS NOTE/);
    assert.ok(h.api.inspect().lastError, 'an invalid scoped snapshot is a visible failure, not an empty history');
  }
});

test('an evacuee snapshot cannot render a request belonging to a different owner', async () => {
  const h = harness({ snapshot: sampleSnapshot({ requests: [sampleRequest({ owner_id: 'other-user', notes: 'OTHER USER PRIVATE REQUEST' })] }) });
  await h.init();
  assert.doesNotMatch(h.text, /OTHER USER PRIVATE REQUEST/);
  assert.equal(h.api.inspect().requestCount, 0);
});

test('staff requests page refuses evacuee access without calling the staff queue', async () => {
  const h = harness({ mode: 'staff' }); h.setIdentity({ userId: 'nick-id', role: 'evacuee' }); await h.init();
  assert.equal(h.calls.filter(call => call.name === 'get_scansafe_need_requests').length, 0);
  assert.match(h.text, /staff|administrator|access|sign in/i);
});

test('missing SQL migration is visible and never becomes an empty successful history', async () => {
  const h = harness(); h.respond(async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.get_scansafe_need_requests' } }));
  await h.init();
  assert.equal(h.api.inspect().eligible, false);
  assert.match(h.text, /SUPABASE_NEEDS_REQUESTS\.sql/);
  assert.ok(h.api.inspect().lastError);
});

test('database-provided names, notes, items, responses and history are escaped', async () => {
  const marker = '<img src=x onerror="globalThis.injected=true" data-needs-injected="yes">';
  const request = sampleRequest({ full_name: marker, notes: marker, response: marker, space_name: marker,
    items: [{ category: 'other', item_name: marker, quantity: 1, unit: marker }],
    events: [{ from_status: null, to_status: 'pending', response: marker, actor_name: marker, created_at: '2026-10-24T04:00:00Z' }] });
  const h = harness({ snapshot: sampleSnapshot({ requests: [request] }) }); await h.init();
  assert.equal(h.document.querySelector('[data-needs-injected]'), null);
  assert.equal(h.context.injected, undefined);
  assert.ok(h.text.includes(marker), 'server text must be rendered as text rather than being silently dropped');
});

test('changing signed-in identity discards an in-flight snapshot', async () => {
  const h = harness(); const gate = deferred(); h.respond(async () => gate.promise);
  const loading = h.init(); await settle();
  h.setIdentity({ userId: 'other-owner', role: 'evacuee' });
  gate.resolve({ data: sampleSnapshot({ requests: [sampleRequest({ notes: 'OLD OWNER PRIVATE NOTE' })] }), error: null });
  await loading; await settle();
  assert.doesNotMatch(h.text, /OLD OWNER PRIVATE NOTE|Nick Reyes|Hallway A2/);
  assert.equal(h.api.inspect().eligible, false);
});

async function fillItem(h, values = {}, index = 0) {
  const row = h.document.querySelectorAll('[data-needs-item]')[index]; assert.ok(row, 'request item row exists');
  const fields = { category: '[data-needs-category]', item_name: '[data-needs-item-name]', quantity: '[data-needs-quantity]', unit: '[data-needs-unit]' };
  for (const [key, value] of Object.entries({ category: 'water', item_name: 'Drinking water', quantity: 3, unit: 'bottles', ...values })) {
    const input = row.querySelector(fields[key]); assert.ok(input, 'request item input exists: ' + key); input.value = value; await input.fire('input');
  }
}
const submitCalls = h => h.calls.filter(call => call.name === 'submit_scansafe_need_request');
const updateCalls = h => h.calls.filter(call => call.name === 'update_scansafe_need_request');

test('an assigned evacuee submits multiple item quantities and notes without client-controlled identity fields', async () => {
  const h = harness(); await h.init();
  await fillItem(h);
  await h.document.querySelector('[data-needs-action="add-item"]').fire('click');
  await fillItem(h, { category: 'bedding', item_name: 'Blankets', quantity: 2, unit: 'pcs' }, 1);
  h.node('needsNotes').value = '  For three family members  '; h.node('needsPriority').value = 'urgent';
  h.respond(async name => {
    if (name !== 'submit_scansafe_need_request') return undefined;
    h.setSnapshot(sampleSnapshot({ requests: [sampleRequest()], stats: { total: 1, pending: 1, active: 1 } }));
    return { data: sampleRequest(), error: null };
  });
  await h.node('needsForm').fire('submit');
  const calls = submitCalls(h); assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0].args).sort(), ['p_client_token', 'p_items', 'p_notes', 'p_priority']);
  assert.deepEqual(calls[0].args.p_items, [
    { category: 'water', item_name: 'Drinking water', quantity: 3, unit: 'bottles' },
    { category: 'bedding', item_name: 'Blankets', quantity: 2, unit: 'pcs' }
  ]);
  assert.equal(calls[0].args.p_notes, 'For three family members'); assert.equal(calls[0].args.p_priority, 'urgent');
  assert.match(calls[0].args.p_client_token, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
  assert.equal(h.api.inspect().pendingToken, null); assert.equal(h.node('needsNotes').value, '');
  assert.match(h.text, /Request #100/); assert.match(h.text, /Hallway A2/);
});

test('transport failures preserve both the request draft and retry token', async () => {
  const h = harness(); await h.init(); await fillItem(h);
  h.node('needsNotes').value = 'Keep this draft';
  let attempts = 0;
  h.respond(async name => { if (name === 'submit_scansafe_need_request') { attempts++; if (attempts === 1) throw new TypeError('Failed to fetch'); return { data: sampleRequest(), error: null }; } });
  await h.node('needsForm').fire('submit');
  assert.equal(h.node('needsNotes').value, 'Keep this draft'); assert.equal(h.document.querySelector('[data-needs-item-name]').value, 'Drinking water');
  const retryToken = h.api.inspect().pendingToken; assert.ok(retryToken); assert.match(h.text, /Connection failed|draft.*kept/i);
  await h.node('needsForm').fire('submit');
  assert.equal(submitCalls(h).length, 2); assert.deepEqual(submitCalls(h)[0].args, submitCalls(h)[1].args);
  assert.equal(submitCalls(h)[1].args.p_client_token, retryToken);
});

test('an edited request after a failed transport receives a different retry token', async () => {
  const h = harness(); await h.init(); await fillItem(h);
  h.respond(async name => { if (name === 'submit_scansafe_need_request') throw new TypeError('Failed to fetch'); });
  await h.node('needsForm').fire('submit'); const first = h.api.inspect().pendingToken;
  h.node('needsNotes').value = 'A different request'; await h.node('needsForm').fire('submit');
  assert.equal(submitCalls(h).length, 2); assert.notEqual(submitCalls(h)[1].args.p_client_token, first);
});

test('double submission while the network request is in flight creates one RPC', async () => {
  const h = harness(); await h.init(); await fillItem(h);
  const gate = deferred(); h.respond(async name => name === 'submit_scansafe_need_request' ? gate.promise : undefined);
  await h.node('needsForm').fire('submit'); await h.node('needsForm').fire('submit');
  assert.equal(submitCalls(h).length, 1); assert.equal(h.api.inspect().busy, true); assert.equal(h.node('needsSubmit').disabled, true);
  gate.resolve({ data: sampleRequest(), error: null }); await settle();
  assert.equal(h.api.inspect().busy, false); assert.equal(submitCalls(h).length, 1);
});

test('polling preserves user form values and loss of assignment disables only submission', async () => {
  const h = harness(); await h.init(); await fillItem(h, { item_name: 'Family water supplies', quantity: 6 });
  h.node('needsNotes').value = 'Please keep these notes'; h.node('needsPriority').value = 'urgent';
  const originalForm = h.node('needsForm');
  h.setSnapshot(sampleSnapshot({ requests: [sampleRequest({ request_id: 200, items: [{ category: 'bedding', item_name: 'Blanket', quantity: 1, unit: 'pcs' }] })] }));
  await h.refresh();
  assert.equal(h.node('needsForm'), originalForm); assert.equal(h.node('needsNotes').value, 'Please keep these notes'); assert.equal(h.node('needsPriority').value, 'urgent');
  assert.equal(h.document.querySelector('[data-needs-item-name]').value, 'Family water supplies'); assert.equal(h.document.querySelector('[data-needs-quantity]').value, '6');
  const removed = sampleSnapshot({ eligible: false }); removed.account.assignment_id = null; removed.account.space_id = null; h.setSnapshot(removed); await h.refresh();
  assert.equal(h.node('needsSubmit').disabled, true); assert.equal(h.node('needsNotes').value, 'Please keep these notes');
  await h.node('needsForm').fire('submit'); assert.equal(submitCalls(h).length, 0);
});

test('invalid quantities and active duplicate items are rejected before mutation', async () => {
  const h = harness(); await h.init();
  for (const quantity of [0, -1, 0.001, 10001, 'not-a-number']) { await fillItem(h, { quantity }); await h.node('needsForm').fire('submit'); }
  assert.equal(submitCalls(h).length, 0);
  h.setSnapshot(sampleSnapshot({ requests: [sampleRequest()] })); await h.refresh(); await fillItem(h);
  assert.equal(h.node('needsDuplicateWarning').hidden, false); assert.match(h.node('needsDuplicateWarning').textContent, /already.*active request/i);
  await h.node('needsForm').fire('submit'); assert.equal(submitCalls(h).length, 0);
});

test('changing accounts during submission clears the old draft and ignores success', async () => {
  const h = harness(); await h.init(); await fillItem(h); h.node('needsNotes').value = 'PRIVATE OLD DRAFT';
  const gate = deferred(); h.respond(async name => name === 'submit_scansafe_need_request' ? gate.promise : undefined);
  await h.node('needsForm').fire('submit'); h.setIdentity({ userId: 'other-owner', role: 'evacuee' });
  gate.resolve({ data: sampleRequest(), error: null }); await settle();
  assert.doesNotMatch(h.text, /PRIVATE OLD DRAFT|Request submitted|Nick Reyes|Hallway A2/);
  assert.equal(h.api.inspect().pendingToken, null); assert.equal(h.api.inspect().requestCount, 0); assert.equal(h.api.inspect().eligible, false);
});

function staffSnapshot(requests = [sampleRequest()], stats = { pending: 1, active: 1, total: 1 }) {
  return sampleSnapshot({ mode: 'staff', owner_id: 'admin-id', account: null, eligible: false, requests, stats });
}

test('staff filters narrow the real queue by search, category, urgency, status and space', async () => {
  const requests = [sampleRequest(), sampleRequest({ request_id: 101, full_name: 'Mila Santos', space_code: 'B1', space_name: 'Hallway B1', current_assignment: { assignment_id: 23, space_code: 'B1', space_name: 'Hallway B1' }, priority: 'urgent', status: 'preparing', items: [{ category: 'food', item_name: 'Rice meals', quantity: 2, unit: 'packs' }] })];
  const h = harness({ mode: 'staff', snapshot: staffSnapshot(requests) }); await h.init();
  assert.equal(h.document.querySelectorAll('[data-needs-request]').length, 2);
  for (const [id, value, expected] of [['needsSearch', 'Mila', '101'], ['needsCategoryFilter', 'water', '100'], ['needsUrgencyFilter', 'urgent', '101'], ['needsStatusFilter', 'pending', '100'], ['needsSpaceFilter', 'B1', '101']]) {
    h.node(id).value = value; await h.node(id).fire('input');
    const rows = h.document.querySelectorAll('[data-needs-request]'); assert.equal(rows.length, 1, id + ' must filter the queue'); assert.equal(rows[0].dataset.needsRequest, expected);
    h.node(id).value = ''; await h.node(id).fire('input');
  }
});

test('admin updates include the displayed version and notify through the real RPC', async () => {
  const record = sampleRequest({ version: 4 }); const h = harness({ mode: 'staff', snapshot: staffSnapshot([record]) }); await h.init();
  const form = h.document.querySelector('[data-needs-update-form]'); form.querySelector('[data-needs-update-status]').value = 'preparing'; form.querySelector('[data-needs-update-response]').value = '  Preparing supplies now  ';
  h.respond(async name => { if (name !== 'update_scansafe_need_request') return undefined; h.setSnapshot(staffSnapshot([sampleRequest({ status: 'preparing', version: 5, response: 'Preparing supplies now' })], { pending: 0, active: 1, total: 1 })); return { data: sampleRequest({ status: 'preparing', version: 5 }), error: null }; });
  await form.fire('submit');
  assert.equal(updateCalls(h).length, 1); assert.deepEqual(updateCalls(h)[0].args, { p_request_id: '100', p_status: 'preparing', p_response: 'Preparing supplies now', p_expected_version: 4 });
  assert.equal(h.api.inspect().busy, false); assert.match(h.text, /Preparing supplies now/); assert.equal(h.document.querySelector('[data-needs-count]').hidden, true);
});

test('staff cannot jump from Pending to Provided and Unavailable requires a reason', async () => {
  const h = harness({ mode: 'staff', snapshot: staffSnapshot() }); await h.init();
  let form = h.document.querySelector('[data-needs-update-form]'); form.querySelector('[data-needs-update-status]').value = 'provided'; await form.fire('submit');
  assert.equal(updateCalls(h).length, 0);
  form = h.document.querySelector('[data-needs-update-form]'); form.querySelector('[data-needs-update-status]').value = 'unavailable'; form.querySelector('[data-needs-update-response]').value = ' '; await form.fire('submit');
  assert.equal(updateCalls(h).length, 0); assert.match(h.text, /reason.*Unavailable|Unavailable.*reason/i);
});

test('concurrent staff updates refresh the version and keep the written reply', async () => {
  const h = harness({ mode: 'staff', snapshot: staffSnapshot([sampleRequest({ version: 4 })]) }); await h.init();
  const form = h.document.querySelector('[data-needs-update-form]'); form.querySelector('[data-needs-update-status]').value = 'preparing'; form.querySelector('[data-needs-update-response]').value = 'KEEP MY REPLY';
  h.respond(async name => { if (name !== 'update_scansafe_need_request') return undefined; h.setSnapshot(staffSnapshot([sampleRequest({ status: 'preparing', version: 5, response: 'Other staff reply' })])); return { data: null, error: { code: '40001', message: 'This request was updated by another staff member' } }; });
  await form.fire('submit');
  assert.equal(updateCalls(h).length, 1); assert.equal(updateCalls(h)[0].args.p_expected_version, 4);
  const refreshed = h.document.querySelector('[data-needs-update-form]'); assert.equal(refreshed.dataset.version, '5'); assert.equal(refreshed.querySelector('[data-needs-update-response]').value, 'KEEP MY REPLY');
  assert.match(h.text, /changed while.*editing|latest status/i);
});

test('polling keeps a staff reply while showing current location and request history', async () => {
  const record = sampleRequest({ current_assignment: { assignment_id: 44, space_code: 'B3', space_name: 'Hallway B3', shelter_name: 'Main School Building' }, events: [{ from_status: null, to_status: 'pending', response: 'Request submitted', actor_name: 'Nick Reyes', created_at: '2026-10-24T04:00:00Z' }] });
  const h = harness({ mode: 'staff', snapshot: staffSnapshot([record]) }); await h.init();
  const reply = h.document.querySelector('[data-needs-update-response]'); reply.value = 'WORK IN PROGRESS'; await reply.fire('input'); reply.focus();
  h.setSnapshot(staffSnapshot([{ ...record, version: 2 }])); await h.refresh();
  assert.equal(h.document.querySelector('[data-needs-update-response]'), reply); assert.equal(reply.value, 'WORK IN PROGRESS');
  assert.match(h.text, /Current location.*Hallway B3/i); assert.match(h.text, /changed since this request/i); assert.match(h.text, /Request history/);
});

test('navigation badge shows pending requests for staff and active requests for evacuees', async () => {
  const staff = harness({ mode: 'staff', snapshot: staffSnapshot([], { pending: 2, active: 5, total: 8 }) }); await staff.init();
  assert.equal(staff.document.querySelector('[data-needs-count]').textContent, '2'); assert.equal(staff.document.querySelector('[data-needs-count]').hidden, false);
  const evacuee = harness({ snapshot: sampleSnapshot({ stats: { pending: 2, active: 3, total: 4 } }) }); await evacuee.init();
  assert.equal(evacuee.document.querySelector('[data-needs-count]').textContent, '3'); assert.equal(evacuee.document.querySelector('[data-needs-count]').hidden, false);
});

test('cancelled requests remain in staff history and filters without an edit or delivery action', async () => {
  const cancelled = sampleRequest({ status: 'cancelled', response: 'All families have returned home', current_assignment: null,
    events: [{ from_status: 'pending', to_status: 'cancelled', actor_name: 'Actual Admin', response: 'All families have returned home', created_at: '2026-10-25T04:00:00Z' }] });
  const h = harness({ mode: 'staff', snapshot: staffSnapshot([cancelled, sampleRequest({ request_id: 101 })], { pending: 1, active: 1, cancelled: 1, total: 2 }) });
  await h.init();
  assert.equal(h.document.querySelectorAll('[data-needs-request]')[0].dataset.needsRequest, '101', 'active requests come before closed requests');
  h.node('needsStatusFilter').value = 'cancelled'; await h.node('needsStatusFilter').fire('input');
  assert.equal(h.document.querySelectorAll('[data-needs-request]').length, 1);
  assert.match(h.text, /Cancelled/); assert.match(h.text, /All families have returned home/);
  assert.equal(h.document.querySelector('[data-needs-update-form]'), null);
  assert.doesNotMatch(h.text, /Confirm the recipient location|arranging delivery/);
  assert.equal(h.document.querySelector('[data-needs-count]').textContent, '1');
});

test('a stale staff form cannot edit a request cancelled by operation closure', async () => {
  const h = harness({ mode: 'staff', snapshot: staffSnapshot() }); await h.init();
  const staleForm = h.document.querySelector('[data-needs-update-form]');
  staleForm.querySelector('[data-needs-update-response]').value = 'STALE REPLY';
  h.setSnapshot(staffSnapshot([sampleRequest({ status: 'cancelled', response: 'Operation ended', version: 2 })], { pending: 0, active: 0, cancelled: 1, total: 1 }));
  await h.refresh();
  await staleForm.fire('submit');
  assert.equal(updateCalls(h).length, 0);
  assert.equal(h.document.querySelector('[data-needs-update-form]'), null);
  assert.match(h.text, /Operation ended/);
});

test('cancelled historical items do not block a fresh request during a new assigned stay', async () => {
  const h = harness({ snapshot: sampleSnapshot({ requests: [sampleRequest({ status: 'cancelled', response: 'Previous evacuation closed' })], stats: { pending: 0, active: 0, cancelled: 1, total: 1 } }) });
  await h.init(); await fillItem(h);
  h.respond(async name => name === 'submit_scansafe_need_request' ? { data: sampleRequest({ request_id: 102 }), error: null } : undefined);
  await h.node('needsForm').fire('submit');
  assert.equal(submitCalls(h).length, 1);
});

test('retrying a received request after closure reports its cancellation without claiming a new submission', async () => {
  const h = harness(); await h.init(); await fillItem(h);
  h.respond(async name => name === 'submit_scansafe_need_request' ? { data: sampleRequest({ status: 'cancelled', response: 'Evacuation ended' }), error: null } : undefined);
  await h.node('needsForm').fire('submit');
  assert.equal(submitCalls(h).length, 1);
  assert.match(h.text, /earlier request.*cancelled.*operation ended/i);
  assert.doesNotMatch(h.text, /Request submitted\. Shelter staff can now see/);
});

test('missing identity or eligibility metadata cannot unlock a request form', async () => {
  for (const missing of ['owner_id', 'eligible', 'requests', 'stats']) {
    const snapshot = sampleSnapshot(); delete snapshot[missing];
    const h = harness({ snapshot }); await h.init();
    assert.equal(h.api.inspect().eligible, false, missing + ' must fail closed'); assert.ok(h.api.inspect().lastError);
    assert.equal(h.node('needsSubmit').disabled, true);
  }
  const snapshot = sampleSnapshot({ requests: [sampleRequest({ owner_id: undefined, notes: 'UNSCOPED PRIVATE REQUEST' })] });
  const h = harness({ snapshot }); await h.init(); assert.doesNotMatch(h.text, /UNSCOPED PRIVATE REQUEST/); assert.equal(h.api.inspect().eligible, false);
});

test('the eligible flag cannot replace the actual assignment and space identifiers', async () => {
  for (const missing of ['assignment_id', 'space_id']) {
    const snapshot = sampleSnapshot(); snapshot.account[missing] = null;
    const h = harness({ snapshot }); await h.init();
    assert.equal(h.api.inspect().eligible, false); assert.equal(h.node('needsSubmit').disabled, true);
  }
});

test('a lost submission response remains retryable after polling discovers its committed request', async () => {
  const h = harness(); await h.init(); await fillItem(h); h.node('needsNotes').value = 'Same payload';
  let attempts = 0;
  h.respond(async name => { if (name !== 'submit_scansafe_need_request') return undefined; attempts++; if (attempts === 1) throw new TypeError('Failed to fetch'); return { data: sampleRequest(), error: null }; });
  await h.node('needsForm').fire('submit'); const token = h.api.inspect().pendingToken;
  h.setSnapshot(sampleSnapshot({ requests: [sampleRequest()], stats: { pending: 1, active: 1, total: 1 } })); await h.refresh();
  assert.equal(h.node('needsDuplicateWarning').hidden, false, 'new duplicate appears in the server history');
  await h.node('needsForm').fire('submit');
  assert.equal(submitCalls(h).length, 2, 'the same token retries a known outcome instead of creating a second request');
  assert.equal(submitCalls(h)[1].args.p_client_token, token); assert.deepEqual(submitCalls(h)[1].args, submitCalls(h)[0].args);
});

test('a failed stale refresh clears old account data after the signed-in owner changes', async () => {
  const h = harness({ snapshot: sampleSnapshot({ requests: [sampleRequest({ notes: 'PREVIOUS OWNER SECRET' })] }) }); await h.init();
  assert.match(h.text, /PREVIOUS OWNER SECRET/);
  const gate = deferred(); h.respond(async name => name === 'get_scansafe_need_requests' ? gate.promise : undefined);
  const loading = h.refresh(); await settle(); h.setIdentity({ userId: 'new-owner', role: 'evacuee' }); gate.reject(new TypeError('Failed to fetch'));
  await loading;
  assert.doesNotMatch(h.text, /PREVIOUS OWNER SECRET|Nick Reyes|Hallway A2/); assert.equal(h.api.inspect().requestCount, 0);
});

test('shared navigation uses lightweight scoped counts and clears a wrong-owner badge', async () => {
  const h = harness({ mode: 'staff', page: '/admin-dashboard.html', snapshot: staffSnapshot([], { pending: 6, active: 8, total: 10 }) });
  h.node('needsApp').remove(); await h.init();
  assert.equal(h.calls.filter(call => call.name === 'get_scansafe_need_requests').length, 0);
  assert.equal(h.calls.filter(call => call.name === 'get_scansafe_need_request_counts').length, 1);
  assert.equal(h.document.querySelector('[data-needs-count]').textContent, '6'); assert.equal(h.document.querySelector('[data-needs-count]').hidden, false);
  h.respond(async () => ({ data: { mode: 'staff', owner_id: 'other-admin', eligible: false, pending: 500, active: 500, total: 500 }, error: null })); await h.refresh();
  assert.equal(h.document.querySelector('[data-needs-count]').hidden, true); assert.ok(h.api.inspect().lastError);
});

test('removal of the active accommodation space rejects a submission and disables the gate', async () => {
  const h = harness(); await h.init(); await fillItem(h);
  h.respond(async name => name === 'submit_scansafe_need_request' ? { data: null, error: { code: 'P0001', message: 'Waiting for an active accommodation space.' } } : undefined);
  await h.node('needsForm').fire('submit');
  assert.equal(h.api.inspect().eligible, false); assert.equal(h.node('needsSubmit').disabled, true);
  assert.equal(h.document.querySelector('[data-needs-item-name]').value, 'Drinking water');
});

test('a poll started before submission cannot hide the newly committed request', async () => {
  const h = harness(); await h.init(); await fillItem(h);
  const oldPoll = deferred(); let readCount = 0;
  h.respond(async name => {
    if (name === 'get_scansafe_need_requests' && ++readCount === 1) return oldPoll.promise;
    if (name === 'submit_scansafe_need_request') {
      h.setSnapshot(sampleSnapshot({ requests: [sampleRequest()], stats: { pending: 1, active: 1, total: 1 } }));
      return { data: sampleRequest(), error: null };
    }
  });
  const polling = h.refresh(); await settle(); await h.node('needsForm').fire('submit');
  assert.equal(h.api.inspect().requestCount, 1, 'successful submission triggers a fresh read rather than reusing an old poll');
  oldPoll.resolve({ data: sampleSnapshot(), error: null }); await polling;
  assert.equal(h.api.inspect().requestCount, 1); assert.match(h.text, /Request #100/); assert.equal(h.document.querySelector('[data-needs-count]').textContent, '1');
});

test('a poll started before staff update cannot revert its new status or version', async () => {
  const oldRecord = sampleRequest({ version: 4 }); const h = harness({ mode: 'staff', snapshot: staffSnapshot([oldRecord]) }); await h.init();
  const oldPoll = deferred(); let readCount = 0;
  h.respond(async name => {
    if (name === 'get_scansafe_need_requests' && ++readCount === 1) return oldPoll.promise;
    if (name === 'update_scansafe_need_request') {
      h.setSnapshot(staffSnapshot([sampleRequest({ status: 'preparing', version: 5, response: 'New staff response' })], { pending: 0, active: 1, total: 1 }));
      return { data: sampleRequest({ status: 'preparing', version: 5 }), error: null };
    }
  });
  const polling = h.refresh(); await settle();
  const form = h.document.querySelector('[data-needs-update-form]'); form.querySelector('[data-needs-update-status]').value = 'preparing'; form.querySelector('[data-needs-update-response]').value = 'New staff response'; await form.fire('submit');
  assert.equal(h.document.querySelector('[data-needs-update-form]').dataset.version, '5');
  oldPoll.resolve({ data: staffSnapshot([oldRecord]), error: null }); await polling;
  assert.equal(h.document.querySelector('[data-needs-update-form]').dataset.version, '5'); assert.match(h.text, /New staff response/);
  assert.equal(h.document.querySelector('[data-needs-count]').hidden, true);
});

test('Provided by retains the original releasing staff and time after a later staff reply', async () => {
  const suppliedAt = '2026-10-24T02:00:00Z'; const repliedAt = '2026-10-25T03:00:00Z';
  const record = sampleRequest({ status: 'provided', provided_by: 'staff-a', provided_at: suppliedAt, version: 5,
    events: [
      { from_status: 'ready_for_pickup', to_status: 'provided', actor_id: 'staff-a', actor_name: 'Original Staff A', response: 'Supplies released', created_at: suppliedAt },
      { from_status: 'provided', to_status: 'provided', actor_id: 'staff-b', actor_name: 'Later Staff B', response: 'Follow-up reply', created_at: repliedAt }
    ] });
  const h = harness({ snapshot: sampleSnapshot({ requests: [record] }) }); await h.init();
  const attribution = h.document.querySelectorAll('.needs-request-meta').find(element => /^Provided by /.test(element.textContent));
  assert.ok(attribution, 'fulfilled requests show who released the supplies');
  assert.match(attribution.textContent, /Provided by Original Staff A/); assert.doesNotMatch(attribution.textContent, /Later Staff B/);
  assert.ok(attribution.textContent.includes(new Date(suppliedAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })), 'the original provided_at timestamp stays attached to the releasing staff');
  assert.ok(!attribution.textContent.includes(new Date(repliedAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })), 'a later reply must not replace the actual release time');
  assert.match(h.document.querySelector('.needs-events').textContent, /Original Staff A/); assert.match(h.document.querySelector('.needs-events').textContent, /Later Staff B/);
});

test('unconfirmed submission responses preserve the draft and retry token without claiming success', async () => {
  for (const data of [null, sampleRequest({ owner_id: 'another-owner' })]) {
    const h = harness(); await h.init(); await fillItem(h); h.node('needsNotes').value = 'KEEP UNCONFIRMED DRAFT';
    h.respond(async name => name === 'submit_scansafe_need_request' ? { data, error: null } : undefined);
    await h.node('needsForm').fire('submit');
    assert.equal(submitCalls(h).length, 1); assert.equal(h.api.inspect().pendingToken, submitCalls(h)[0].args.p_client_token);
    assert.equal(h.node('needsNotes').value, 'KEEP UNCONFIRMED DRAFT'); assert.equal(h.document.querySelector('[data-needs-item-name]').value, 'Drinking water');
    assert.match(h.text, /server response could not be confirmed/i); assert.doesNotMatch(h.text, /Request submitted\. Shelter staff/i);
    assert.equal(h.api.inspect().busy, false);
  }
});

test('unconfirmed staff update responses retain the reply without claiming an update', async () => {
  for (const data of [sampleRequest({ request_id: 999, version: 5 }), sampleRequest({ owner_id: 'another-owner', version: 5 }), sampleRequest({ version: undefined })]) {
    const h = harness({ mode: 'staff', snapshot: staffSnapshot([sampleRequest({ version: 4 })]) }); await h.init();
    const form = h.document.querySelector('[data-needs-update-form]'); form.querySelector('[data-needs-update-status]').value = 'preparing'; form.querySelector('[data-needs-update-response]').value = 'KEEP UNCONFIRMED REPLY';
    h.respond(async name => name === 'update_scansafe_need_request' ? { data, error: null } : undefined);
    await form.fire('submit');
    assert.equal(updateCalls(h).length, 1); assert.equal(h.document.querySelector('[data-needs-update-response]').value, 'KEEP UNCONFIRMED REPLY');
    assert.match(h.text, /server response could not be confirmed/i); assert.doesNotMatch(h.text, /Request updated\. The evacuee can see/i);
    assert.equal(h.api.inspect().busy, false);
  }
});
