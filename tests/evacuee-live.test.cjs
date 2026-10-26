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
    this.children = [];
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
  removeAttribute(name) { delete this.attributes[name]; }
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
    evacuees: [{ auth_user_id: 'nick-id', evacuee_id: 50, group_id: 12, registration_code: 'REQ-NICK-50', full_name: 'Nick Reyes', email: 'nick@example.test', age: 26, gender: 'Male', group_size: 3, needs_summary: 'None', barangay: 'Abangan Norte', city: 'Marilao', registered_at: '2026-10-23T02:00:00Z', approval_status: 'pending', current_status: 'registered' }],
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
  for (const id of ['adminDataStatus', 'pendingRequestsBody', 'recentActivity', 'dashboardSpaceOverview', 'adminAlerts', 'adminAlertsCount', 'evacBody', 'reviewModal', 'reviewName', 'reviewDetails', 'userStatusHero', 'userQrCard', 'userAccommodationCard', 'userLatestCard', 'userProgressSteps', 'userGroupMembersBody', 'userRegistrationTimeline', 'evacueeDataStatus', 'userBarcodeCard', 'approveBtn', 'rejectBtn', 'systemUserBody', 'systemUserSearch', 'systemUserRoleFilter']) nodes.set(id, new Element(id));
  const kpis = new Map(['data-user-name', 'data-user-email', 'data-user-status', 'data-user-group', 'data-user-age', 'data-pending-count', 'data-kpi-pending', 'data-kpi-approved', 'data-kpi-spaces', 'data-kpi-occupancy', 'data-kpi-capacity', 'data-um-total', 'data-um-admins', 'data-um-roles', 'data-um-evacuees'].map(key => [key, new Element()]));
  const domCallbacks = [];
  const document = {
    body: new Element(),
    visibilityState: 'visible',
    getElementById: id => nodes.get(id) || null,
    querySelector: selector => selector === '.barcode-card' ? nodes.get('userBarcodeCard') : selector.startsWith('#') ? nodes.get(selector.slice(1)) || null : null,
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
  const calls = { rpc: [], table: [], auth: 0, viewerAccounts: [] };
  const authListeners = [];
  const session = options.authenticated === false ? null : { user: { id: 'nick-id', email: 'nick@example.test' } };
  const profile = { id: 'nick-id', full_name: 'Nick Reyes', role: options.role || 'evacuee' };
  const client = {
    auth: {
      getSession: async () => { calls.auth++; return { data: { session }, error: null }; },
      signOut: async () => ({ error: null }),
      onAuthStateChange: callback => { authListeners.push(callback); return { data: { subscription: { unsubscribe() {} } } }; }
    },
    rpc: async (name, args) => {
      calls.rpc.push({ name, args });
      if (name === 'get_my_scansafe_account') return options.accountSnapshot ? options.accountSnapshot() : { data: null, error: missingRpc };
      if (name === 'get_scansafe_map_availability') return options.mapSnapshot ? options.mapSnapshot() : { data: copy(tables.accommodation_spaces.filter(row => row.status !== 'inactive')), error: null };
      if (name === 'get_my_profile') return { data: profile, error: null };
      if (name === 'scansafe_repair_my_registration_link') {
        const row = tables.evacuees.find(item => item.auth_user_id === session?.user?.id);
        return { data: row ? { status: 'linked', evacuee_id: row.evacuee_id, registration_code: row.registration_code, needs_registration_id: false } : { status: 'completion_required', evacuee_id: null, registration_code: null, needs_registration_id: true }, error: null };
      }
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
        limit(count) { request.limit = count; return query; },
        maybeSingle() { request.single = true; return query; },
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
            if (request.limit) rows = rows.slice(0, request.limit);
            return { data: request.single ? rows[0] || null : rows, error: null };
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
    location: { pathname: options.page || '/user-portal.html', search: '', hash: '', replace() {}, reload() {} },
    navigator: {}, URLSearchParams,
    console: { warn() {}, error() {}, log() {}, group() {}, groupEnd() {}, table() {} },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    addEventListener() {},
    SCANSafeSupabaseConfig: { url: 'https://example.test', anonKey: 'local-test-key' },
    supabase: { createClient: () => client },
    ScanSafeBarcodeViewer: { setAccount: account => calls.viewerAccounts.push(copy(account)), open: async () => true, close() {} }
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  // Load the complete browser scripts; startup callbacks remain registered until
  // a test explicitly runs the core auth/approval bootstrap.
  vm.runInContext(appSource, context, { filename: 'assets/app.js' });
  vm.runInContext(bridgeSource, context, { filename: 'assets/supabase-bridge.js' });
  context.ScanSafeBarcode.render = () => {};
  context.ScanSafeDB.session = session;
  context.ScanSafeDB.profile = session ? profile : null;
  return {
    context, calls, tables, errors, nodes, kpis,
    refresh: () => context.ScanSafeRealUser.refresh(),
    inspect: () => context.ScanSafeEvacueeLive.inspect(),
    kpi: name => String(kpis.get(name).textContent),
    switchAccount(nextSession) {
      if (!authListeners.length) {
        const callback = domCallbacks.find(fn => fn.toString().includes('phase9InstallAuthListener();'));
        assert.ok(callback, 'auth listener installer should be registered');
        callback();
      }
      client.auth.getSession = async () => ({ data: { session: nextSession }, error: null });
      authListeners.forEach(callback => callback(nextSession ? 'SIGNED_IN' : 'SIGNED_OUT', nextSession));
    },
    async bootstrap() {
      const callback = domCallbacks.find(fn => fn.toString().includes('window.__scanSafePrototypeLogin'));
      assert.ok(callback, 'core bridge bootstrap callback should be registered');
      await callback();
    }
  };
}

function approvedTables() {
  const tables = fixtures();
  tables.evacuees[0].approval_status = 'approved';
  tables.evacuees[0].approved_at = '2026-10-23T02:05:00Z';
  tables.barcodes = [{ evacuee_id: 50, barcode_value: 'NICK-ACTUAL-50', status: 'active' }];
  return tables;
}
function ownSnapshot(tables = approvedTables()) {
  return { evacuee: tables.evacuees[0] || null, barcode: tables.barcodes[0] || null, assignment: null, space: null, shelter: null };
}

test('approved Nick gets the actual active barcode through schema-compatible owned-table reads', async () => {
  const h = harness({ tables: approvedTables() });
  assert.equal(h.context.localStorage.getItem('scansafePrototypeStateV4'), null);
  await h.refresh();
  assert.equal(h.context.currentState().user.registrationStatus, 'Approved');
  assert.equal(h.context.currentState().user.qrCode, 'NICK-ACTUAL-50');
  assert.match(h.nodes.get('userQrCard').innerHTML, /Show Barcode/);
  assert.doesNotMatch(h.nodes.get('userQrCard').innerHTML, /data-barcode-value|NICK-ACTUAL-50/);
  assert.equal(h.calls.viewerAccounts.at(-1).ownerId, 'nick-id');
  assert.equal(h.calls.viewerAccounts.at(-1).value, 'NICK-ACTUAL-50');
  assert.equal(h.kpi('data-user-name'), 'Nick Reyes');
  const base = h.calls.table.find(call => call.table === 'evacuees');
  assert.equal(base.columns, '*');
  assert.deepEqual(base.filters, [['auth_user_id', 'nick-id', true]]);
  assert.doesNotMatch(h.nodes.get('userGroupMembersBody').innerHTML, /Juan|Maria|Pedro|Ana Cruz/);
});

test('authenticated account RPC supplies Nick without direct-table queries', async () => {
  const h = harness({ accountSnapshot: async () => ({ data: ownSnapshot(), error: null }) });
  await h.refresh();
  assert.equal(h.context.currentState().user.qrCode, 'NICK-ACTUAL-50');
  assert.equal(h.calls.table.length, 0);
  assert.match(h.nodes.get('userStatusHero').innerHTML, /Registration Approved/);
});

test('released stays show an ended stay while preserving the issued account barcode', async () => {
  const tables = approvedTables();
  tables.evacuees[0].current_status = 'released';
  tables.evacuees[0].checked_in_at = '2026-10-23T03:00:00Z';
  const snapshot = ownSnapshot(tables);
  const h = harness({ accountSnapshot: async () => ({ data: snapshot, error: null }) });
  h.nodes.set('userAssignmentSummary', new Element('userAssignmentSummary'));
  await h.refresh();
  assert.equal(h.kpi('data-user-status'), 'Released');
  assert.equal(h.context.currentState().user.checkedIn, false);
  assert.equal(h.context.currentState().user.assignment, null);
  assert.equal(h.context.currentState().user.qrCode, 'NICK-ACTUAL-50');
  assert.match(h.nodes.get('userStatusHero').innerHTML, /Shelter Stay Released/);
  assert.match(h.nodes.get('userAccommodationCard').innerHTML, /Accommodation released/);
  assert.match(h.nodes.get('userLatestCard').innerHTML, /Shelter stay ended/);
  assert.match(h.nodes.get('userAssignmentSummary').innerHTML, /previous accommodation has been released/);
  assert.match(h.nodes.get('userProgressSteps').innerHTML, /Released/);
  assert.doesNotMatch(h.nodes.get('userProgressSteps').innerHTML, /Pending|Checked-In/);
  assert.match(h.nodes.get('userQrCard').innerHTML, /Show Barcode/);
});

test('a previous check-in timestamp does not check in a newly readmitted or assigned stay', async () => {
  for (const currentStatus of ['registered', 'verified', 'accommodated', 'checked_in']) {
    const tables = approvedTables();
    tables.evacuees[0].current_status = currentStatus;
    tables.evacuees[0].checked_in_at = '2026-10-23T03:00:00Z';
    const h = harness({ accountSnapshot: async () => ({ data: ownSnapshot(tables), error: null }) });
    await h.refresh();
    assert.equal(h.context.currentState().user.checkedIn, currentStatus === 'checked_in', currentStatus);
    if (currentStatus !== 'checked_in') assert.doesNotMatch(h.nodes.get('userLatestCard').innerHTML, /Check-in confirmed/);
  }
});

test('an open pending account sees approval and its real barcode on the next refresh', async () => {
  const h = harness();
  await h.refresh();
  assert.equal(h.context.currentState().user.registrationStatus, 'Pending Approval');
  assert.equal(h.context.currentState().user.qrIssued, false);
  h.tables.evacuees[0].approval_status = 'approved';
  h.tables.barcodes.push({ evacuee_id: 50, barcode_value: 'NEW-ACTUAL-CODE', status: 'active' });
  await h.refresh();
  assert.equal(h.context.currentState().user.registrationStatus, 'Approved');
  assert.equal(h.context.currentState().user.qrCode, 'NEW-ACTUAL-CODE');
  assert.doesNotMatch(h.nodes.get('userStatusHero').innerHTML, /Pending Admin Approval/);
});

test('pending, rejected, and revoked snapshots never display stray barcodes', async () => {
  for (const [approval, barcodeStatus] of [['pending', 'active'], ['rejected', 'active'], ['approved', 'revoked']]) {
    const tables = approvedTables();
    tables.evacuees[0].approval_status = approval;
    tables.barcodes[0].status = barcodeStatus;
    const h = harness({ accountSnapshot: async () => ({ data: ownSnapshot(tables), error: null }) });
    await h.refresh();
    assert.equal(h.context.currentState().user.qrIssued, false);
    assert.ok(h.calls.viewerAccounts.length, 'viewer must receive the barcode gate');
    assert.equal(h.calls.viewerAccounts.at(-1)?.value ?? null, null);
    assert.doesNotMatch(h.nodes.get('userQrCard').innerHTML, /NICK-ACTUAL-50/);
  }
});

test('approved registration without a barcode remains approved and never invents a code', async () => {
  const tables = approvedTables(); tables.barcodes = [];
  const h = harness({ tables });
  await h.refresh();
  assert.equal(h.context.currentState().user.registrationStatus, 'Approved');
  assert.equal(h.context.currentState().user.qrCode, null);
  assert.match(h.nodes.get('userQrCard').innerHTML, /Barcode not issued yet/);
  assert.doesNotMatch(h.nodes.get('userStatusHero').innerHTML, /email|Pending Admin Approval/);
});

test('barcode lookup errors do not reset an approved registration to pending', async () => {
  const h = harness({ tables: approvedTables(), errors: { barcodes: { message: 'Read denied' } } });
  await h.refresh();
  assert.equal(h.context.currentState().user.registrationStatus, 'Approved');
  assert.equal(h.context.currentState().user.qrIssued, false);
  assert.ok(h.calls.viewerAccounts.length, 'viewer must receive the barcode gate');
  assert.equal(h.calls.viewerAccounts.at(-1)?.value ?? null, null);
  assert.ok(h.inspect().warnings.includes('Barcode could not be loaded.'));
  assert.match(h.nodes.get('userQrCard').innerHTML, /temporarily unavailable/);
});

test('initial registration query failures show unavailable instead of fabricated pending data', async () => {
  const h = harness({ errors: { evacuees: { message: 'Connection failed' } } });
  assert.equal(await h.refresh(), null);
  assert.equal(h.inspect().loaded, false);
  assert.equal(h.context.currentState().user.registrationStatus, 'Loading');
  assert.match(h.nodes.get('userStatusHero').innerHTML, /Registration unavailable/);
  assert.doesNotMatch(h.nodes.get('userStatusHero').innerHTML, /Pending Admin Approval/);
});

test('same-account refresh failures preserve confirmed data with a visible error', async () => {
  const h = harness({ tables: approvedTables() });
  await h.refresh();
  h.errors.evacuees = { message: 'Offline' };
  await h.refresh();
  assert.equal(h.context.currentState().user.qrCode, 'NICK-ACTUAL-50');
  assert.equal(h.inspect().loaded, true);
  assert.match(h.nodes.get('evacueeDataStatus').innerHTML, /last confirmed data/);
});

test('an authoritative missing registration clears prior barcode and shows completion state', async () => {
  const h = harness({ tables: approvedTables() });
  await h.refresh();
  h.tables.evacuees = [];
  await h.refresh();
  assert.equal(h.inspect().loaded, true);
  assert.equal(h.context.currentState().user.qrCode, null);
  assert.doesNotMatch(h.nodes.get('userQrCard').innerHTML, /NICK-ACTUAL-50/);
  assert.match(h.nodes.get('userQrCard').innerHTML, /Barcode not available yet/);
  assert.match(h.nodes.get('evacueeDataStatus').innerHTML, /Complete Registration/);
});

test('account switching clears Nick data before a different account can render', async () => {
  const h = harness({ tables: approvedTables() });
  await h.refresh();
  h.context.ScanSafeDB.client.auth.getSession = async () => ({ data: { session: { user: { id: 'other-id', email: 'other@example.test' } } }, error: null });
  h.context.ScanSafeDB.profile = { id: 'other-id', full_name: 'Other Account', role: 'evacuee' };
  await h.refresh();
  assert.equal(h.context.currentState().user.authUserId, 'other-id');
  assert.equal(h.context.currentState().user.qrCode, null);
  assert.doesNotMatch(h.nodes.get('userQrCard').innerHTML, /NICK-ACTUAL-50/);
  assert.doesNotMatch(h.nodes.get('userGroupMembersBody').innerHTML, /Nick Reyes/);
});

test('concurrent account refreshes share one request', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = harness({ accountSnapshot: async () => { await gate; return { data: ownSnapshot(), error: null }; } });
  const one = h.refresh(), two = h.refresh();
  assert.equal(one, two);
  release();
  await Promise.all([one, two]);
  assert.equal(h.calls.rpc.filter(call => call.name === 'get_my_scansafe_account').length, 1);
});

test('anonymous and admin sessions cannot query evacuee account data', async () => {
  for (const options of [{ authenticated: false }, { role: 'admin' }]) {
    const h = harness(options);
    await h.refresh();
    assert.equal(h.calls.table.length, 0);
    assert.equal(h.calls.rpc.filter(call => call.name === 'get_my_scansafe_account').length, 0);
    assert.equal(h.inspect().loaded, false);
  }
});

test('RPC responses for another account are rejected without exposing their data', async () => {
  const snapshot = ownSnapshot(); snapshot.evacuee.auth_user_id = 'different-id';
  const h = harness({ accountSnapshot: async () => ({ data: snapshot, error: null }) });
  await h.refresh();
  assert.equal(h.inspect().loaded, false);
  assert.equal(h.context.currentState().user.qrCode, null);
  assert.match(h.nodes.get('evacueeDataStatus').innerHTML, /does not belong/);
});

function assignedSnapshot() {
  const tables = approvedTables();
  return {
    ...ownSnapshot(tables),
    assignment: { assignment_id: 101, group_id: 12, space_id: 1, assignment_status: 'active' },
    space: tables.accommodation_spaces[0],
    shelter: { shelter_id: 1, shelter_name: 'Actual Shelter' }
  };
}

function mapHarness(options = {}) {
  const h = harness({ page: '/user-room.html', accountSnapshot: async () => ({ data: assignedSnapshot(), error: null }), ...options });
  for (const id of ['userAssignmentSummary', 'userSpaceList', 'spaceDetail', 'viewerSpaceTitle', 'viewerSpaceMeta', 'viewerSpaceStatus', 'viewerSpaceEyebrow']) h.nodes.set(id, new Element(id));
  return h;
}

test('evacuee map reads safe room availability RPC without staff table or group queries', async () => {
  const h = mapHarness();
  await h.refresh();
  assert.equal(h.calls.table.length, 0);
  assert.equal(h.calls.rpc.filter(call => call.name === 'get_scansafe_map_availability').length, 1);
  assert.equal(h.context.ScanSafeEvacueeLive.spaces().length, 2);
  assert.match(h.nodes.get('userSpaceList').innerHTML, /Hallway A1|Hallway A2/);
  assert.doesNotMatch(h.nodes.get('userSpaceList').innerHTML, /Closed Hallway/);
  assert.match(h.nodes.get('userAssignmentSummary').innerHTML, /Actual Shelter/);
  assert.equal(h.context.getDynamicOccupancy('A1'), 4);
  assert.equal(h.inspect().warnings.length, 0);
});

test('missing map RPC retains the confirmed owned assignment with a visible setup warning', async () => {
  const h = mapHarness({ mapSnapshot: async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find function public.get_scansafe_map_availability' } }) });
  await h.refresh();
  assert.equal(h.calls.table.length, 0);
  assert.equal(h.context.ScanSafeEvacueeLive.spaces().length, 1);
  assert.equal(h.context.getDynamicOccupancy('A1'), 4);
  assert.match(h.nodes.get('evacueeDataStatus').innerHTML, /latest system update/);
  assert.match(h.nodes.get('userAssignmentSummary').innerHTML, /Hallway A1/);
  assert.equal(h.context.currentState().user.assignment, 'A1');
});

test('map permission and network failures stay visible and never become empty or available data', async () => {
  for (const error of [{ code: '42501', message: 'Permission denied' }, { message: 'Failed to fetch' }]) {
    const h = mapHarness({ mapSnapshot: async () => ({ data: null, error }) });
    await h.refresh();
    assert.equal(h.calls.table.length, 0);
    assert.equal(h.context.ScanSafeEvacueeLive.spaces().length, 1);
    assert.equal(h.context.getDynamicOccupancy('A1'), 4);
    assert.match(h.nodes.get('evacueeDataStatus').innerHTML, /could not be refreshed/);
    assert.doesNotMatch(h.nodes.get('userSpaceList').innerHTML, /No active accommodation spaces/);
  }
});

test('same-owner map errors preserve the last confirmed availability list', async () => {
  let failing = false;
  const h = mapHarness({ mapSnapshot: async () => failing ? { data: null, error: { message: 'Offline' } } : { data: fixtures().accommodation_spaces, error: null } });
  await h.refresh();
  failing = true;
  await h.refresh();
  assert.equal(h.context.ScanSafeEvacueeLive.spaces().length, 2);
  assert.equal(h.context.getDynamicOccupancy('A2'), 10);
  assert.match(h.nodes.get('evacueeDataStatus').innerHTML, /last confirmed space data/);
});

test('fullscreen map details use confirmed counts and show unavailable for unconfigured spaces', async () => {
  const h = mapHarness();
  await h.refresh();
  h.context.showUserMapViewerSpace('A1');
  assert.match(h.nodes.get('viewerSpaceMeta').textContent, /4 \/ 10 occupied \/ 6 available/);
  assert.equal(h.nodes.get('viewerSpaceEyebrow').textContent, 'Your Assigned Space');
  h.context.showUserMapViewerSpace('A6');
  assert.match(h.nodes.get('viewerSpaceMeta').textContent, /unavailable/);
  assert.doesNotMatch(h.nodes.get('viewerSpaceMeta').textContent, /0\/|6 available/);
  assert.equal(h.nodes.get('viewerSpaceStatus').textContent, 'Unavailable');
});

test('an authoritative empty map is distinguished from a failed or incomplete response', async () => {
  const h = mapHarness({ mapSnapshot: async () => ({ data: [], error: null }) });
  await h.refresh();
  assert.equal(h.context.ScanSafeEvacueeLive.spaces().length, 0);
  assert.match(h.nodes.get('userSpaceList').innerHTML, /No active accommodation spaces are configured/);
  assert.equal(h.inspect().warnings.length, 0);
  // The independently confirmed owned assignment still appears in its summary.
  assert.match(h.nodes.get('userAssignmentSummary').innerHTML, /Hallway A1/);
  for (const data of [null, [{ space_code: 'A4', capacity: 10, current_occupancy: null }]]) {
    const incomplete = mapHarness({ mapSnapshot: async () => ({ data, error: null }) });
    await incomplete.refresh();
    assert.equal(incomplete.context.ScanSafeEvacueeLive.spaces().length, 1);
    assert.match(incomplete.nodes.get('evacueeDataStatus').innerHTML, /could not be refreshed/);
  }
});

test('an account switch clears map rows immediately and ignores a pending old-owner map response', async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const mapStarted = new Promise(resolve => { started = resolve; });
  let current = assignedSnapshot();
  let first = true;
  const h = mapHarness({
    accountSnapshot: async () => ({ data: current, error: null }),
    mapSnapshot: async () => {
      if (first) { first = false; started(); await gate; return { data: fixtures().accommodation_spaces, error: null }; }
      return { data: [{ space_id: 4, space_code: 'A4', space_name: 'Current Map', capacity: 6, current_occupancy: 2, status: 'available' }], error: null };
    }
  });
  const refresh = h.refresh();
  await mapStarted;
  h.switchAccount({ user: { id: 'other-id', email: 'other@example.test' } });
  assert.equal(h.context.ScanSafeEvacueeLive.spaces().length, 0);
  assert.doesNotMatch(h.nodes.get('userSpaceList').innerHTML, /Hallway A1/);
  release();
  await refresh;
  assert.equal(h.context.ScanSafeEvacueeLive.spaces().length, 0);
  assert.equal(h.inspect().warnings.length, 0);
  current = ownSnapshot();
  current.evacuee.auth_user_id = 'other-id';
  current.evacuee.full_name = 'Other Account';
  h.context.ScanSafeDB.profile = { id: 'other-id', role: 'evacuee', full_name: 'Other Account' };
  await h.refresh();
  assert.deepEqual(copy(h.context.ScanSafeEvacueeLive.spaces()).map(row => row.space_code), ['A4']);
  assert.doesNotMatch(h.nodes.get('userSpaceList').innerHTML, /Hallway A1|Nick Reyes/);
});
