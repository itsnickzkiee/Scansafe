'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const appSource = read('assets/app.js');
const bridgeSource = read('assets/supabase-bridge.js');
const mapHtml = read('shelter-room.html');
const copy = value => JSON.parse(JSON.stringify(value));
const normalize = value => String(value || '').trim().toUpperCase();
const missingRpc = { code: 'PGRST202', message: 'Could not find the function in the schema cache' };

// A small DOM with a real parent/child tree, parsed marker HTML and browser-like
// events. Unlike the previous source-string tests, appends and removals must
// actually affect the map DOM for an assertion to pass.
class Element {
  constructor(tagName = 'div', ownerDocument = null) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.handlers = new Map();
    this._text = '';
    this._style = {};
    this.hidden = false;
    this.value = '';
    this.complete = true;
    this.naturalWidth = 720;
    this.naturalHeight = 1080;
    this.classList = {
      add: (...values) => this.className = [...new Set([...this.classes(), ...values])].join(' '),
      remove: (...values) => this.className = this.classes().filter(value => !values.includes(value)).join(' '),
      contains: value => this.classes().includes(value),
      toggle: (value, force) => {
        const present = force === undefined ? !this.classes().includes(value) : !!force;
        this.classList[present ? 'add' : 'remove'](value);
        return present;
      }
    };
  }
  classes() { return String(this.className || '').split(/\s+/).filter(Boolean); }
  get className() { return this.attributes.class || ''; }
  set className(value) { this.attributes.class = String(value); }
  get id() { return this.attributes.id || ''; }
  set id(value) { this.attributes.id = String(value); }
  get title() { return this.attributes.title || ''; }
  set title(value) { this.attributes.title = String(value); }
  get parentElement() { return this.parentNode; }
  get style() { return this._style; }
  set style(value) {
    this._style = typeof value === 'object' ? value : parseStyle(value);
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  set innerHTML(value) { this.replaceChildren(); parseHtml(String(value), this); }
  get innerHTML() { return this._text + this.children.map(child => child.outerHTML).join(''); }
  get outerHTML() {
    const attributes = Object.entries(this.attributes).map(([key, value]) => ` ${key}="${value}"`).join('');
    return `<${this.tagName.toLowerCase()}${attributes}>${this.innerHTML}</${this.tagName.toLowerCase()}>`;
  }
  get isConnected() { return !!this.ownerDocument && this.ownerDocument.body.contains(this); }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'style') this.style = value;
    if (name === 'hidden') this.hidden = true;
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; if (name === 'hidden') this.hidden = false; }
  appendChild(child) {
    child.remove(); child.parentNode = this; child.ownerDocument = this.ownerDocument;
    this.children.push(child); return child;
  }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = []; this._text = ''; this.append(...children);
  }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    siblings.splice(siblings.indexOf(this), 1); this.parentNode = null;
  }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  matches(selector) { return matches(this, selector); }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  querySelectorAll(selector) {
    const descendants = [];
    const visit = parent => { for (const child of parent.children) { descendants.push(child); visit(child); } };
    visit(this);
    return descendants.filter(node => selector.split(',').some(part => matchPath(node, part.trim())));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(name, callback, options) {
    const handlers = this.handlers.get(name) || [];
    handlers.push({ callback, once: !!options?.once }); this.handlers.set(name, handlers);
  }
  removeEventListener(name, callback) {
    this.handlers.set(name, (this.handlers.get(name) || []).filter(item => item.callback !== callback));
  }
  dispatchEvent(event) {
    event.target ||= this;
    for (const handler of [...(this.handlers.get(event.type) || [])]) {
      handler.callback.call(this, event);
      if (handler.once) this.removeEventListener(event.type, handler.callback);
    }
    if (typeof this['on' + event.type] === 'function') this['on' + event.type](event);
    return true;
  }
  getBoundingClientRect() {
    const geometry = this.ownerDocument.geometry;
    if (this.classList.contains('floor-image-stage')) return { x: 20, y: 40, left: 20, top: 40, right: 20 + geometry.width, bottom: 40 + geometry.height, ...geometry };
    if (this.classList.contains('floor-plan-image')) return this.parentNode.getBoundingClientRect();
    if (this.classList.contains('map-hotspot') || this.classList.contains('map-occupant-overlay')) {
      const parent = this.parentNode.getBoundingClientRect();
      const number = (value, size) => String(value || '').endsWith('%') ? parseFloat(value) * size / 100 : parseFloat(value) || 0;
      const width = number(this.style.width, parent.width), height = number(this.style.height, parent.height);
      const left = parent.left + number(this.style.left, parent.width), top = parent.top + number(this.style.top, parent.height);
      return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height };
    }
    return { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  }
}

function parseStyle(value) {
  const style = {};
  for (const declaration of String(value || '').split(';')) {
    const index = declaration.indexOf(':');
    if (index < 0) continue;
    const key = declaration.slice(0, index).trim().replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    style[key] = declaration.slice(index + 1).trim();
  }
  return style;
}

function matches(node, selector) {
  if (!selector || selector === '*') return true;
  let remaining = selector;
  const tag = remaining.match(/^[a-zA-Z][\w-]*/)?.[0];
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  if (tag) remaining = remaining.slice(tag.length);
  for (const [, prefix, name] of remaining.matchAll(/([.#])([\w-]+)/g)) {
    if (prefix === '.' ? !node.classList.contains(name) : node.id !== name) return false;
  }
  for (const [, name, , value] of remaining.matchAll(/\[([\w-]+)(?:=(['"]?)([^\]'"\s]+)\2)?\]/g)) {
    const actual = name.startsWith('data-') ? node.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] : node.getAttribute(name);
    if (value === undefined ? actual == null : String(actual) !== value) return false;
  }
  return true;
}

function matchPath(node, selector) {
  const tokens = selector.split(/\s+/);
  if (!matches(node, tokens.pop())) return false;
  let ancestor = node.parentNode;
  while (tokens.length) {
    const token = tokens.pop();
    while (ancestor && !matches(ancestor, token)) ancestor = ancestor.parentNode;
    if (!ancestor) return false;
    ancestor = ancestor.parentNode;
  }
  return true;
}

function parseHtml(html, parent) {
  const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const stack = [parent];
  const safeHtml = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  for (const token of safeHtml.match(/<[^>]+>|[^<]+/g) || []) {
    if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    if (token.startsWith('<!')) continue;
    if (!token.startsWith('<')) { stack.at(-1)._text += token; continue; }
    const tag = token.match(/^<([\w-]+)/)?.[1];
    if (!tag) continue;
    const node = new Element(tag, parent.ownerDocument);
    const attributes = token.slice(tag.length + 1, token.endsWith('/>') ? -2 : -1);
    for (const [, name, double, single, bare] of attributes.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) node.setAttribute(name, double ?? single ?? bare ?? '');
    stack.at(-1).appendChild(node);
    if (!voidTags.has(tag.toLowerCase()) && !token.endsWith('/>')) stack.push(node);
  }
}

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}

function fixtures(groupCount = 1) {
  return {
    accommodation_spaces: [{ space_id: 1, space_code: 'A1', space_name: 'Hallway A1', capacity: 6, current_occupancy: groupCount, status: 'available', is_primary: true }],
    accommodation_assignments: Array.from({ length: groupCount }, (_, index) => ({ assignment_id: index + 10, group_id: index + 20, space_id: 1, assignment_status: 'active', occupant_count: 1 })),
    evacuee_groups: Array.from({ length: groupCount }, (_, index) => ({ group_id: index + 20, group_size: 1 })),
    evacuees: Array.from({ length: groupCount }, (_, index) => ({ evacuee_id: index + 30, group_id: index + 20, full_name: index === 0 ? 'Nick Reyes' : 'Evacuee ' + (index + 1), approval_status: 'approved', current_status: 'accommodated', group_size: 1 })),
    barcodes: [], scansafe_operation_stays: []
  };
}

function harness(options = {}) {
  const events = new Element('window');
  const document = {
    geometry: { width: 720, height: options.imagePending ? 0 : 1080 },
    visibilityState: 'visible',
    addEventListener() {}, dispatchEvent() {},
    createElement(tag) { return new Element(tag, document); },
    querySelectorAll(selector) { return document.body.querySelectorAll(selector); },
    querySelector(selector) { return document.body.querySelector(selector); },
    getElementById(id) { return document.body.querySelector('#' + id); }
  };
  document.body = new Element('body', document);
  parseHtml(mapHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i)[1], document.body);
  const image = document.querySelector('.floor-plan-image');
  image.complete = !options.imagePending;
  image.naturalHeight = options.imagePending ? 0 : 1080;
  const tables = options.tables || fixtures();
  const calls = { rpc: [], table: [], storage: [] };
  const timers = new Map();
  const observers = [];
  let timerId = 0;
  const client = {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'admin-id' } } }, error: null }) },
    rpc(name, args) {
      calls.rpc.push({ name, args });
      if (name === 'scansafe_admin_dashboard_snapshot') return Promise.resolve({ data: { evacuees: copy(tables.evacuees), spaces: copy(tables.accommodation_spaces), activity: [], stats: {} }, error: null });
      if (name === 'get_scansafe_active_map_occupants') return options.occupantRpc ? options.occupantRpc() : Promise.resolve({ data: null, error: missingRpc });
      if (name === 'get_scansafe_registration_details') return options.photoRpc ? options.photoRpc(args) : Promise.resolve({ data: { profile_photo: null }, error: null });
      throw new Error('Unexpected RPC: ' + name);
    },
    storage: {
      from(bucket) {
        return { createSignedUrl: async (file, expires) => {
          calls.storage.push({ bucket, file, expires });
          return { data: { signedUrl: 'https://media.example.test/' + file }, error: null };
        } };
      }
    },
    from(table) {
      const request = { table, filters: [] };
      const query = {
        select(columns) { request.columns = columns; return query; },
        eq(column, value) { request.filters.push([column, value, 'eq']); return query; },
        neq(column, value) { request.filters.push([column, value, 'neq']); return query; },
        in(column, values) { request.filters.push([column, values, 'in']); return query; },
        order() { return query; },
        range(start, end) { request.range = [start, end]; return query; },
        limit(limit) { request.limit = limit; return query; },
        then(resolve, reject) {
          const result = Promise.resolve().then(() => {
            calls.table.push(copy(request));
            assert.ok(Object.hasOwn(tables, table), 'unexpected table query: ' + table);
            let rows = copy(tables[table]);
            for (const [column, value, operation] of request.filters) rows = rows.filter(row => operation === 'in' ? value.includes(row[column]) : operation === 'eq' ? row[column] === value : row[column] !== value);
            if (request.range) rows = rows.slice(request.range[0], request.range[1] + 1);
            if (request.limit != null) rows = rows.slice(0, request.limit);
            return { data: rows, error: null };
          });
          return result.then(resolve, reject);
        }
      };
      return query;
    }
  };
  const sandbox = {
    document, localStorage: storage(), sessionStorage: storage(), navigator: {}, URLSearchParams,
    location: { pathname: '/shelter-room.html', search: '', hash: '', replace() {}, reload() {} },
    console: { warn() {}, error() {}, log() {}, table() {}, group() {}, groupEnd() {} },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() { return ++timerId; }, clearInterval() {},
    requestAnimationFrame(callback) { return sandbox.setTimeout(callback, 0); }, cancelAnimationFrame(id) { timers.delete(id); },
    addEventListener: (...args) => events.addEventListener(...args),
    removeEventListener: (...args) => events.removeEventListener(...args),
    getComputedStyle: node => ({ display: node.hidden ? 'none' : 'block', position: 'relative', visibility: 'visible', overflow: 'visible', getPropertyValue: name => node.style[name] || '' }),
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(target) { this.target = target; }
      disconnect() { this.target = null; }
    },
    SCANSafeSupabaseConfig: { url: 'https://example.test', anonKey: 'test-public-key' },
    supabase: { createClient: () => client }
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(appSource, context, { filename: 'assets/app.js' });
  vm.runInContext(bridgeSource, context, { filename: 'assets/supabase-bridge.js' });
  context.ScanSafeDB.session = { user: { id: 'admin-id', email: 'admin@example.test' } };
  context.ScanSafeDB.profile = { id: 'admin-id', full_name: 'Admin', role: 'admin' };
  const settle = async () => { for (let index = 0; index < 50; index++) await Promise.resolve(); };
  return {
    context, document, tables, calls, settle,
    inspect: () => context.ScanSafeMapDebug.inspect(),
    rows: () => document.querySelectorAll('#spaceDetail .map-occupant-row'),
    selectSpace: (code = 'A1') => context.selectSpace(code),
    async refresh() {
      await within(context.ScanSafeMapDebug.refresh(), 500, 'map refresh must not wait for optional photos/occupant RPC');
      await settle();
      return context.ScanSafeMapDebug.inspect();
    },
    async adminRefresh() {
      await within(context.ScanSafeAdminLive.refresh(), 500, 'admin refresh must not wait for optional photos/occupant RPC');
      await settle();
      return context.ScanSafeMapDebug.inspect();
    },
    async finishImageLoad() {
      document.geometry.height = 1080; image.complete = true; image.naturalHeight = 1080;
      image.dispatchEvent({ type: 'load' });
      for (const observer of observers) if (observer.target) observer.callback([{ target: observer.target }]);
      events.dispatchEvent({ type: 'resize' });
      const pending = [...timers.values()]; timers.clear();
      pending.forEach(timer => timer.callback());
      await settle();
    },
    async resize(width, height) {
      document.geometry = { width, height };
      for (const observer of observers) if (observer.target) observer.callback([{ target: observer.target }]);
      events.dispatchEvent({ type: 'resize' });
      await settle();
    }
  };
}

async function within(promise, milliseconds, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

function enrichedRow(overrides = {}) {
  return { assignment_id: 10, group_id: 20, space_id: 1, space_code: 'A1', evacuee_id: 30, full_name: 'Nick Reyes', group_size: 1, current_status: 'accommodated', map_status: 'assigned', arrival_time: null, ...overrides };
}

function assertNoMapBubbles(h) {
  assert.equal(h.document.querySelectorAll('.map-occupant-overlay,.map-occupant-stack').length, 0, 'map must not contain current or legacy occupant bubbles');
  assert.equal(h.inspect().renderedMarkers.length, 0, 'debug reports no rendered map markers');
}

for (const kind of ['missing', 'empty']) {
  test(`A1 active assignment appears in Current Occupants before check-in when occupant RPC is ${kind}`, async () => {
    const tables = fixtures();
    tables.accommodation_assignments.push({ assignment_id: 99, group_id: 99, space_id: 1, occupant_count: 1, assignment_status: 'released' });
    const h = harness({ tables, occupantRpc: () => Promise.resolve(kind === 'missing' ? { data: null, error: missingRpc } : { data: [], error: null }) });
    const debug = await h.refresh();
    h.selectSpace('A1');
    assert.equal(h.rows().length, 1, 'one real active A1 assignment must create one Current Occupants row');
    assert.equal(h.rows()[0].querySelectorAll('.map-occupant-avatar').length, 1);
    assert.match(h.rows()[0].textContent, /Nick Reyes/);
    assert.match(h.rows()[0].querySelector('.map-occupant-avatar').textContent, /NR/);
    assert.match(h.rows()[0].textContent, /Assigned/);
    assert.doesNotMatch(h.rows()[0].textContent, /Checked In|GBEAA/);
    assert.equal(debug.activeAssignments.length, 1, 'debug counts only authoritative active assignments');
    assert.ok(debug.hotspotCodes.includes('A1'));
    assertNoMapBubbles(h);
    assert.equal(debug.unmatchedSpaceCodes.length, 0);
    assert.ok(h.calls.table.some(call => call.table === 'accommodation_assignments' && call.filters.some(([column, value, op]) => column === 'assignment_status' && value === 'active' && op === 'eq')), 'table query must filter active assignments');
  });
}

test('a hanging profile request does not block occupant-list initials or map refresh', async () => {
  const h = harness({
    occupantRpc: async () => ({ data: [enrichedRow()], error: null }),
    photoRpc: () => new Promise(() => {})
  });
  await h.refresh();
  h.selectSpace();
  assert.equal(h.rows().length, 1);
  assert.match(h.rows()[0].querySelector('.map-occupant-avatar').textContent, /NR/);
  assert.ok(h.calls.rpc.some(call => call.name === 'get_scansafe_registration_details'), 'photo enrichment was attempted');
  assertNoMapBubbles(h);
});

test('occupant-list profile photo renders when available and broken photo restores initials', async () => {
  const h = harness({
    occupantRpc: async () => ({ data: [enrichedRow()], error: null }),
    photoRpc: async () => ({ data: { profile_photo: { path: 'nick/avatar.jpg' } }, error: null })
  });
  await h.refresh();
  h.selectSpace();
  const img = h.rows()[0]?.querySelector('.map-occupant-avatar img');
  assert.ok(img, 'signed profile image must be rendered');
  assert.equal(img.getAttribute('src'), 'https://media.example.test/nick/avatar.jpg');
  img.dispatchEvent({ type: 'error' });
  assert.match(h.rows()[0].querySelector('.map-occupant-avatar').textContent, /NR/, 'failed profile photo must retain a readable initials fallback');
  assertNoMapBubbles(h);
});

test('space codes normalize trim and uppercase for selected space and occupant list', async () => {
  const tables = fixtures(); tables.accommodation_spaces[0].space_code = '  a1  ';
  const h = harness({ tables });
  const debug = await h.refresh();
  h.selectSpace('  a1  ');
  assert.equal(h.rows().length, 1);
  assert.match(h.rows()[0].textContent, /Nick Reyes/);
  assert.equal(debug.unmatchedSpaceCodes.length, 0);
  assertNoMapBubbles(h);
});

test('checked-in enrichment updates the existing Current Occupants row', async () => {
  let checkedIn = false;
  const h = harness({ occupantRpc: async () => ({ data: [enrichedRow(checkedIn ? { current_status: 'checked_in', map_status: 'checked_in', arrival_time: '2026-10-27T03:00:00Z' } : {})], error: null }) });
  await h.refresh();
  h.selectSpace();
  assert.equal(h.rows().length, 1);
  assert.doesNotMatch(h.rows()[0].textContent, /Checked In/);
  checkedIn = true; await h.refresh();
  assert.equal(h.rows().length, 1, 'checking in must not duplicate the assignment row');
  assert.equal(h.rows()[0].querySelectorAll('.map-occupant-avatar').length, 1);
  assert.match(h.rows()[0].querySelector('em').textContent, /Checked In/, 'checked-in status must be visible in the occupant list');
  assertNoMapBubbles(h);
});

test('checked-in status remains visible when optional occupant RPC is missing', async () => {
  const tables = fixtures(); tables.evacuees[0].current_status = 'checked_in';
  const h = harness({ tables });
  await h.refresh();
  h.selectSpace();
  assert.equal(h.rows().length, 1);
  assert.match(h.rows()[0].querySelector('em').textContent, /Checked In/);
  assertNoMapBubbles(h);
});

test('missing member metadata cannot hide an active assignment', async () => {
  const tables = fixtures(); tables.evacuees = []; tables.evacuee_groups = [];
  const h = harness({ tables });
  const debug = await h.refresh();
  h.selectSpace();
  assert.equal(debug.activeAssignments.length, 1);
  assert.equal(h.rows().length, 1);
  assert.match(h.rows()[0].querySelector('.map-occupant-avatar').textContent, /E/);
  assertNoMapBubbles(h);
});

test('the existing admin refresh updates selected Current Occupants without a debug call', async () => {
  const h = harness();
  await h.adminRefresh();
  h.selectSpace();
  assert.equal(h.rows().length, 1);
  h.tables.accommodation_assignments[0].assignment_status = 'released';
  await h.adminRefresh();
  assert.equal(h.rows().length, 0, 'normal admin refresh must remove the released assignment from selected space list');
  assertNoMapBubbles(h);
});

test('released assignment disappears even with stale RPC occupant and nonzero stored occupancy', async () => {
  const h = harness({ occupantRpc: async () => ({ data: [enrichedRow()], error: null }) });
  await h.refresh(); h.selectSpace(); assert.equal(h.rows().length, 1);
  h.tables.accommodation_assignments[0].assignment_status = 'released';
  h.tables.evacuees[0].current_status = 'released';
  const debug = await h.refresh();
  assert.equal(h.tables.accommodation_spaces[0].current_occupancy, 1, 'fixture intentionally retains stale counter');
  assert.equal(h.rows().length, 0, 'inactive assignment must not be reintroduced by occupant RPC or occupancy counter');
  assert.equal(debug.activeAssignments.length, 0);
  assert.equal(debug.renderedMarkers.length, 0);
  assertNoMapBubbles(h);
});

test('an earlier unresolved occupant response cannot resurrect a released assignment', async () => {
  let resolveOld;
  let rpcCalls = 0;
  const h = harness({ occupantRpc: () => ++rpcCalls === 1
    ? new Promise(resolve => { resolveOld = resolve; })
    : Promise.resolve({ data: [enrichedRow()], error: null }) });
  await h.refresh();
  h.selectSpace();
  assert.equal(h.rows().length, 1, 'authoritative assignment appears in list while optional RPC remains pending');
  assert.equal(typeof resolveOld, 'function');
  h.tables.accommodation_assignments[0].assignment_status = 'released';
  await h.refresh();
  assert.equal(h.rows().length, 0);
  resolveOld({ data: [enrichedRow({ arrival_time: '2026-10-27T03:00:00Z', map_status: 'checked_in' })], error: null });
  await h.settle();
  assert.equal(h.rows().length, 0, 'late response from prior refresh cannot restore the old list row');
  assert.equal(h.inspect().activeAssignments.length, 0);
  assertNoMapBubbles(h);
});

test('occupancy without an active assignment never fabricates a Current Occupants row', async () => {
  const tables = fixtures(); tables.accommodation_assignments = [];
  const h = harness({ tables });
  await h.refresh();
  h.selectSpace();
  assert.equal(h.rows().length, 0);
  assert.equal(h.inspect().activeAssignments.length, 0);
  assertNoMapBubbles(h);
});

test('all five active groups on A1 appear in Current Occupants without map bubbles or +N truncation', async () => {
  const h = harness({ tables: fixtures(5) });
  const debug = await h.refresh();
  h.selectSpace();
  assert.equal(h.rows().length, 5, 'list must show every active assigned group');
  assert.equal(h.document.querySelectorAll('#spaceDetail .map-occupant-avatar').length, 5);
  assert.equal(h.document.querySelectorAll('#spaceDetail .map-occupant-more').length, 0);
  assert.match(h.rows()[0].textContent, /Nick Reyes/);
  assert.match(h.rows()[4].textContent, /Evacuee 5/);
  assert.equal(debug.activeAssignments.length, 5);
  assertNoMapBubbles(h);
});

test('active assignments without matching map hotspots are reported in debug output', async () => {
  const tables = fixtures(); tables.accommodation_spaces[0].space_code = '  b9  ';
  const h = harness({ tables });
  const debug = await h.refresh();
  assert.ok(debug.unmatchedSpaceCodes.includes('B9'));
  assert.equal(debug.activeAssignments.length, 1);
  assert.ok(Array.isArray(debug.occupants), 'debug must expose occupants as well as assignments and markers');
  assertNoMapBubbles(h);
});

test('image load and resize preserve the selected occupant list and never add map bubbles', async () => {
  const h = harness({ imagePending: true });
  await h.refresh();
  h.selectSpace();
  assert.equal(h.rows().length, 1, 'list must work before floor-plan image has height');
  assertNoMapBubbles(h);
  const hotspot = h.document.querySelector('.map-hotspot[data-space="A1"]');
  const geometry = { left: hotspot.style.left, top: hotspot.style.top, width: hotspot.style.width, height: hotspot.style.height };
  await h.finishImageLoad();
  assert.equal(h.rows().length, 1);
  assertNoMapBubbles(h);
  await h.resize(960, 1440);
  assert.equal(h.rows().length, 1);
  assertNoMapBubbles(h);
  assert.deepEqual({ left: hotspot.style.left, top: hotspot.style.top, width: hotspot.style.width, height: hotspot.style.height }, geometry, 'existing map hotspot geometry is preserved');
});
