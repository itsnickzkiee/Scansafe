'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(projectRoot, 'assets/app.js'), 'utf8');
const bridgeSource = fs.readFileSync(path.join(projectRoot, 'assets/supabase-bridge.js'), 'utf8');
const missingRpc = { code: 'PGRST202', message: 'Could not find the function public.scansafe_admin_dashboard_snapshot in the schema cache' };
const copy = value => JSON.parse(JSON.stringify(value));

class Element {
  constructor(id = '') {
    this.id = id;
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.textContent = '';
    this.value = '';
    this.handlers = new Map();
    this.buttons = [];
    const classes = new Set(['hidden']);
    this.classList = {
      add: value => classes.add(value),
      remove: value => classes.delete(value),
      contains: value => classes.has(value),
      toggle: value => classes.has(value) ? (classes.delete(value), false) : (classes.add(value), true)
    };
  }
  set innerHTML(value) {
    this.html = value;
    this.buttons = [...value.matchAll(/data-review-request="([^"]+)"/g)].map(match => {
      const button = new Element();
      button.dataset.reviewRequest = match[1];
      return button;
    });
  }
  get innerHTML() { return this.html || ''; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, callback) { this.handlers.set(name, callback); }
  querySelectorAll(selector) { return selector === '[data-review-request]' ? this.buttons : []; }
  querySelector() { return null; }
  appendChild() {}
  remove() {}
}

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
}

function fixtures() {
  return {
    evacuees: [{ evacuee_id: 50, group_id: 12, registration_code: 'REQ-NICK-50', full_name: 'Nick Reyes', email: 'nick@example.test', age: 26, gender: 'Male', group_size: 3, needs_summary: 'None', barangay: 'Abangan Norte', city: 'Marilao', registered_at: '2026-10-23T02:00:00Z', approval_status: 'pending', current_status: 'registered' }],
    accommodation_spaces: [
      { space_id: 1, space_code: 'A1', space_name: 'Hallway A1', capacity: 10, current_occupancy: 4, is_primary: true, status: 'available' },
      { space_id: 2, space_code: 'A2', space_name: 'Hallway A2', capacity: 10, current_occupancy: 10, is_primary: true, status: 'full' },
      { space_id: 3, space_code: 'A3', space_name: 'Closed Hallway', capacity: 100, current_occupancy: 90, is_primary: true, status: 'inactive' }
    ],
    barcodes: [],
    accommodation_assignments: []
  };
}

function harness(options = {}) {
  const nodes = new Map();
  for (const id of ['adminDataStatus', 'pendingRequestsBody', 'recentActivity', 'dashboardSpaceOverview', 'adminAlerts', 'adminAlertsCount', 'evacBody', 'reviewModal', 'reviewName', 'reviewDetails', 'approveBtn', 'rejectBtn', 'systemUserBody', 'systemUserSearch', 'systemUserRoleFilter']) nodes.set(id, new Element(id));
  const kpis = new Map(['data-pending-count', 'data-kpi-pending', 'data-kpi-approved', 'data-kpi-spaces', 'data-kpi-occupancy', 'data-kpi-capacity', 'data-um-total', 'data-um-admins', 'data-um-roles', 'data-um-evacuees'].map(key => [key, new Element()]));
  const domCallbacks = [];
  const document = {
    body: new Element(),
    visibilityState: 'visible',
    getElementById: id => nodes.get(id) || null,
    querySelector: selector => selector.startsWith('#') ? nodes.get(selector.slice(1)) || null : null,
    querySelectorAll: selector => selector.split(',').flatMap(part => {
      if (part.startsWith('#')) return nodes.has(part.slice(1)) ? [nodes.get(part.slice(1))] : [];
      const attr = part.match(/^\[([^\]]+)\]$/)?.[1];
      return kpis.has(attr) ? [kpis.get(attr)] : [];
    }),
    addEventListener: (name, callback) => { if (name === 'DOMContentLoaded') domCallbacks.push(callback); },
    createElement: () => new Element()
  };
  const tables = options.tables || fixtures();
  const errors = options.errors || {};
  const calls = { rpc: [], table: [], auth: 0 };
  const session = options.authenticated === false ? null : { user: { id: 'admin-id', email: 'admin@example.test' } };
  const profile = { id: 'admin-id', full_name: 'Administrator', role: options.role || 'admin' };
  const client = {
    auth: {
      getSession: async () => { calls.auth++; return { data: { session }, error: null }; },
      signOut: async () => ({ error: null })
    },
    rpc: async (name, args) => {
      calls.rpc.push({ name, args });
      if (name === 'get_my_profile') return { data: profile, error: null };
      if (name === 'scansafe_admin_dashboard_snapshot') return options.snapshot ? options.snapshot() : { data: null, error: missingRpc };
      if (name === 'approve_evacuee_registration') {
        const row = tables.evacuees.find(item => item.evacuee_id === args.p_evacuee_id);
        assert.ok(row, 'approval must target a real database evacuee');
        row.approval_status = 'approved';
        tables.barcodes.push({ evacuee_id: row.evacuee_id, barcode_value: 'LIVE-NICK-50', status: 'active' });
        return { data: 'LIVE-NICK-50', error: null };
      }
      throw new Error('Unexpected RPC: ' + name);
    },
    from(table) {
      const request = { table, filters: [] };
      const query = {
        select(columns) { request.columns = columns; return query; },
        order(column, settings = {}) { request.order = { column, ...settings }; return query; },
        range(start, end) { request.range = [start, end]; return query; },
        eq(column, value) { request.filters.push([column, value, true]); return query; },
        neq(column, value) { request.filters.push([column, value, false]); return query; },
        then(resolve, reject) {
          const result = (async () => {
            calls.table.push(copy(request));
            if (errors[table]) return { data: null, error: errors[table] };
            assert.ok(Object.hasOwn(tables, table), 'unexpected table: ' + table);
            let rows = copy(tables[table]);
            for (const [column, value, equal] of request.filters) rows = rows.filter(row => (row[column] === value) === equal);
            if (request.order) {
              const { column, ascending = true } = request.order;
              rows.sort((a, b) => a[column] < b[column] ? (ascending ? -1 : 1) : a[column] > b[column] ? (ascending ? 1 : -1) : 0);
            }
            if (request.range) rows = rows.slice(request.range[0], request.range[1] + 1);
            return { data: rows, error: null };
          })();
          return result.then(resolve, reject);
        }
      };
      return query;
    }
  };
  const localStorage = storage({ scansafePrototypeStateV4: '{"requests":[{"name":"Juan Dela Cruz"}]}' });
  const sandbox = {
    document, localStorage, sessionStorage: storage(),
    location: { pathname: options.page || '/admin-dashboard.html', search: '', hash: '', replace() {}, reload() {} },
    navigator: {}, URLSearchParams,
    console: { warn() {}, error() {}, log() {}, group() {}, groupEnd() {}, table() {} },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    addEventListener() {},
    SCANSafeSupabaseConfig: { url: 'https://example.test', anonKey: 'local-test-key' },
    supabase: { createClient: () => client }
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  // Load the complete browser scripts; startup callbacks remain registered until
  // a test explicitly runs the core auth/approval bootstrap.
  vm.runInContext(appSource, context, { filename: 'assets/app.js' });
  vm.runInContext(bridgeSource, context, { filename: 'assets/supabase-bridge.js' });
  context.ScanSafeDB.session = session;
  context.ScanSafeDB.profile = session ? profile : null;
  return {
    context, calls, tables, errors, nodes, kpis,
    refresh: () => context.ScanSafeAdminLive.refresh(),
    inspect: () => context.ScanSafeAdminLive.inspect(),
    kpi: name => String(kpis.get(name).textContent),
    async bootstrap() {
      const callback = domCallbacks.find(fn => fn.toString().includes('window.__scanSafePrototypeLogin'));
      assert.ok(callback, 'core bridge bootstrap callback should be registered');
      await callback();
    }
  };
}

function rpcSnapshot() {
  return {
    evacuees: fixtures().evacuees,
    spaces: fixtures().accommodation_spaces.filter(row => row.status !== 'inactive'),
    activity: [{ title: 'Real registration', description: 'Nick Reyes', created_at: '2026-10-23T02:00:00Z' }],
    stats: { pending_registrations: 9, approved_evacuees: 15, current_occupancy: 14, total_capacity: 20, occupancy_percent: 70, available_spaces: 1 }
  };
}

test('missing dashboard RPC loads Nick and preserves the real database ID through review and approval', async () => {
  const h = harness();
  assert.equal(h.context.localStorage.getItem('scansafePrototypeStateV4'), null);
  assert.equal(h.context.currentState().requests.length, 0);
  await h.bootstrap();
  assert.equal(h.inspect().error, null);
  assert.equal(h.kpi('data-kpi-pending'), '1');
  assert.equal(h.kpi('data-kpi-occupancy'), '70%');
  assert.equal(h.kpi('data-kpi-spaces'), '1');
  assert.match(h.nodes.get('pendingRequestsBody').innerHTML, /Nick Reyes/);
  assert.match(h.nodes.get('pendingRequestsBody').innerHTML, /Abangan Norte, Marilao/);
  assert.doesNotMatch(h.nodes.get('pendingRequestsBody').innerHTML, /Juan Dela Cruz|Maria Santos/);
  assert.equal(h.context.currentState().requests[0].dbId, 50);
  const reviewButton = h.nodes.get('pendingRequestsBody').buttons[0];
  reviewButton.handlers.get('click')();
  assert.equal(h.nodes.get('reviewName').textContent, 'Nick Reyes');
  assert.equal(h.nodes.get('reviewModal').classList.contains('hidden'), false);
  await h.nodes.get('approveBtn').onclick();
  const approval = h.calls.rpc.find(call => call.name === 'approve_evacuee_registration');
  assert.equal(approval.args.p_evacuee_id, 50);
  assert.equal(h.kpi('data-kpi-pending'), '0');
  assert.equal(h.kpi('data-kpi-approved'), '1');
  assert.equal(h.context.currentState().requests[0].qrCode, 'LIVE-NICK-50');
  assert.equal(h.calls.rpc.filter(call => call.name === 'scansafe_admin_dashboard_snapshot').length, 1, 'known-missing RPC should not repeat on refresh');
});

test('table fallback paginates beyond 1000 registrations without dropping Nick', async () => {
  const tables = fixtures();
  tables.evacuees = Array.from({ length: 1003 }, (_, index) => ({ ...tables.evacuees[0], evacuee_id: index + 1, registration_code: 'REQ-' + (index + 1), full_name: index === 0 ? 'Nick Reyes' : 'Registrant ' + (index + 1) }));
  const h = harness({ tables });
  await h.refresh();
  assert.equal(h.inspect().evacuees.length, 1003);
  assert.equal(h.inspect().stats.pending_registrations, 1003);
  assert.ok(h.inspect().evacuees.some(row => row.evacuee_id === 1 && row.full_name === 'Nick Reyes'));
  assert.deepEqual(h.calls.table.filter(call => call.table === 'evacuees').map(call => call.range), [[0, 999], [1000, 1999]]);
});

test('optional accommodation, barcode and assignment failures still display registrations with visible warnings', async () => {
  const error = { message: 'relation is unavailable', code: '42P01' };
  const h = harness({ errors: { accommodation_spaces: error, barcodes: error, accommodation_assignments: error } });
  await h.refresh();
  assert.equal(h.inspect().loaded, true);
  assert.equal(h.inspect().error, null);
  assert.equal(h.inspect().evacuees[0].full_name, 'Nick Reyes');
  assert.equal(h.inspect().warnings.length, 3);
  assert.equal(h.kpi('data-kpi-pending'), '1');
  assert.equal(h.kpi('data-kpi-occupancy'), '--');
  assert.equal(h.kpi('data-kpi-spaces'), '--');
  assert.match(h.nodes.get('adminDataStatus').innerHTML, /Accommodation spaces could not be loaded/);
  assert.match(h.nodes.get('pendingRequestsBody').innerHTML, /Nick Reyes/);
});

test('failed refresh keeps the last real snapshot and reports the escaped error', async () => {
  const h = harness();
  await h.refresh();
  const loadedAt = h.inspect().updatedAt;
  h.errors.evacuees = { message: 'Connection lost <script>unsafe</script>' };
  assert.equal(await h.refresh(), null);
  assert.equal(h.inspect().loaded, true);
  assert.equal(h.inspect().updatedAt, loadedAt);
  assert.equal(h.inspect().evacuees[0].full_name, 'Nick Reyes');
  assert.equal(h.kpi('data-kpi-pending'), '1');
  assert.equal(h.nodes.get('adminDataStatus').getAttribute('role'), 'alert');
  assert.match(h.nodes.get('adminDataStatus').innerHTML, /Showing the last loaded records/);
  assert.match(h.nodes.get('adminDataStatus').innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(h.nodes.get('adminDataStatus').innerHTML, /<script>/);
  delete h.errors.evacuees;
  await h.refresh();
  assert.equal(h.inspect().error, null);
  assert.equal(h.nodes.get('adminDataStatus').getAttribute('role'), 'status');
});

test('initial required-query failure displays an error and never fabricates empty success', async () => {
  const h = harness({ errors: { evacuees: { message: 'Permission denied', code: '42501' } } });
  await h.refresh();
  assert.equal(h.inspect().loaded, false);
  assert.equal(h.inspect().error, 'Permission denied');
  assert.equal(h.kpi('data-kpi-pending'), '--');
  assert.match(h.nodes.get('pendingRequestsBody').innerHTML, /could not be loaded/);
});

test('unauthenticated and evacuee sessions never query the admin RPC or tables', async () => {
  for (const options of [{ authenticated: false }, { role: 'evacuee' }]) {
    const h = harness(options);
    assert.equal(await h.refresh(), null);
    assert.equal(h.inspect().loaded, false);
    assert.match(h.inspect().error, /administrator or staff/i);
    assert.equal(h.calls.rpc.length, 0);
    assert.equal(h.calls.table.length, 0);
  }
});

test('concurrent refreshes share one pending request and release it for the next refresh', async () => {
  let finishRpc;
  const gate = new Promise(resolve => { finishRpc = resolve; });
  const h = harness({ snapshot: () => gate });
  const first = h.refresh();
  const second = h.refresh();
  assert.equal(first, second);
  assert.equal(h.calls.rpc.length, 1);
  finishRpc({ data: null, error: missingRpc });
  await Promise.all([first, second]);
  assert.equal(h.calls.table.filter(call => call.table === 'evacuees').length, 1);
  await h.refresh();
  assert.equal(h.calls.table.filter(call => call.table === 'evacuees').length, 2);
});

test('installed snapshot RPC supplies statistics without invoking table fallback', async () => {
  const snapshot = rpcSnapshot();
  const h = harness({ snapshot: async () => ({ data: snapshot, error: null }) });
  const result = await h.refresh();
  assert.equal(result, snapshot);
  assert.equal(h.calls.table.length, 0);
  assert.equal(h.kpi('data-kpi-pending'), '9');
  assert.equal(h.kpi('data-kpi-approved'), '15');
  assert.match(h.nodes.get('recentActivity').innerHTML, /Real registration/);
});

test('non-missing RPC errors never silently fall back to direct table reads', async () => {
  const h = harness({ snapshot: async () => ({ data: null, error: { code: '42501', message: 'Administrator access denied' } }) });
  await h.refresh();
  assert.equal(h.inspect().loaded, false);
  assert.equal(h.inspect().error, 'Administrator access denied');
  assert.equal(h.calls.table.length, 0);
});

test('later prototype dashboard render hooks preserve the live RPC metrics', async () => {
  const h = harness({ snapshot: async () => ({ data: rpcSnapshot(), error: null }) });
  await h.refresh();
  const state = h.context.currentState();
  state.requests = [{ id: 'MOCK', name: 'Juan Dela Cruz', status: 'Approved' }];
  h.context.saveScanSafeState(state);
  h.context.renderDashboardPrototype();
  h.context.updatePrototypeCounts();
  h.context.renderDashboardSpaceOverview();
  assert.equal(h.kpi('data-kpi-pending'), '9');
  assert.equal(h.kpi('data-kpi-approved'), '15');
  assert.equal(h.kpi('data-kpi-spaces'), '1');
  assert.equal(h.kpi('data-kpi-occupancy'), '70%');
  assert.equal(h.context.currentState().requests[0].name, 'Nick Reyes');
  assert.doesNotMatch(h.nodes.get('pendingRequestsBody').innerHTML, /Juan Dela Cruz/);
});
test('table enrichment uses active barcodes and assignments and keeps pending registrations without a barcode', async () => {
  const tables = fixtures();
  tables.evacuees.push({ ...tables.evacuees[0], evacuee_id: 70, group_id: 14, registration_code: 'REQ-70', full_name: 'Approved evacuee', approval_status: 'approved' });
  tables.barcodes = [
    { evacuee_id: 50, barcode_value: 'STRAY-PENDING-CODE', status: 'active' },
    { evacuee_id: 70, barcode_value: 'REVOKED-CODE', status: 'revoked' },
    { evacuee_id: 70, barcode_value: 'REAL-ACTIVE-CODE', status: 'active' }
  ];
  tables.accommodation_assignments = [
    { group_id: 14, space_id: 2, assignment_status: 'released' },
    { group_id: 14, space_id: 1, assignment_status: 'active' }
  ];
  const h = harness({ tables });
  await h.refresh();
  const pending = h.inspect().evacuees.find(row => row.evacuee_id === 50);
  const approved = h.inspect().evacuees.find(row => row.evacuee_id === 70);
  assert.equal(pending.barcode_value, null);
  assert.equal(approved.barcode_value, 'REAL-ACTIVE-CODE');
  assert.equal(approved.assigned_space_code, 'A1');
  assert.equal(approved.assigned_space_name, 'Hallway A1');
  assert.equal(h.kpi('data-kpi-approved'), '1');
});

test('live map capacity overrides static map defaults and missing spaces cannot appear assignable', async () => {
  const h = harness();
  await h.bootstrap();
  assert.equal(h.context.getDynamicOccupancy('A1'), 4);
  assert.equal(h.context.getAvailableSlots('A1'), 6);
  assert.equal(h.context.getSpaceStatus('A2'), 'full');
  assert.equal(h.context.getAvailableSlots('A2'), 0);
  assert.equal(h.context.getSpaceStatus('A6'), 'full');
  assert.equal(h.context.getAvailableSlots('A6'), 0);
  assert.equal(h.kpi('data-kpi-spaces'), '1', 'map bootstrap must preserve the database available-space count');
});

test('personnel page loads real profiles separately from evacuee registrations and filters roles', async () => {
  const tables = fixtures();
  tables.profiles = [
    { id: 'admin-id', full_name: 'Actual Administrator', role: 'admin' },
    { id: 'staff-id', full_name: 'Actual Staff', role: 'staff' },
    { id: 'nick-id', full_name: 'Nick Reyes', role: 'evacuee' }
  ];
  const h = harness({ page: '/user-management.html', tables });
  await h.refresh();
  const body = h.nodes.get('systemUserBody');
  assert.match(body.innerHTML, /Actual Administrator/);
  assert.match(body.innerHTML, /Actual Staff/);
  assert.doesNotMatch(body.innerHTML, /Nick Reyes/);
  assert.equal(h.kpi('data-um-total'), '2');
  assert.equal(h.kpi('data-um-admins'), '1');
  assert.equal(h.kpi('data-um-evacuees'), '1');
  h.nodes.get('systemUserRoleFilter').value = 'staff';
  h.context.ScanSafeAdminLive.renderSystemUsers();
  assert.match(body.innerHTML, /Actual Staff/);
  assert.doesNotMatch(body.innerHTML, /Actual Administrator/);
});
