const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('12-hour cooldown and readmission are server controlled', () => {
  const sql = read('SUPABASE_READMISSION_COOLDOWN_MAP.sql');
  assert.match(sql, /interval '12 hours'/);
  assert.match(sql, /confirm_scansafe_readmission/);
  assert.match(sql, /scansafe_stay_history/);
  assert.match(sql, /readmission_ready/);
  assert.match(sql, /cooldown_remaining_seconds/);
  assert.match(sql, /get_scansafe_space_occupants/);
  assert.match(sql, /select e,b into v_evacuee,v_barcode/);
  assert.doesNotMatch(sql, /select e\.\*,b\.\* into v_evacue/);
});

test('scanner has active duplicate, cooldown, and ready-for-readmission states', () => {
  const js = read('assets/scanner.js');
  assert.match(js, /ALREADY CHECKED IN/);
  assert.match(js, /RECENTLY RELEASED/);
  assert.match(js, /READY FOR READMISSION/);
  assert.match(js, /Confirm Readmission/);
  assert.match(js, /confirm_scansafe_readmission/);
  assert.match(js, /Automatic Assignment/);
  assert.doesNotMatch(js, /GBEAA/);
});

test('evacuee current progress resets active stay checks after cooldown while keeping history', () => {
  const js = read('assets/supabase-bridge.js');
  assert.match(js, /readyForReadmission/);
  assert.match(js, /Ready for Readmission/);
  assert.match(js, /previous_stay/);
  assert.match(js, /Previous Shelter Stay/);
  assert.match(js, /\['Accommodated',accommodated\|\|released/);
  assert.match(js, /\['Released',released/);
  assert.match(js, /'current-status':loaded\?status:'--'/);
  assert.match(js, /scheduleReadmissionReadyRefresh/);
});

test('accommodation map is monitoring-first and shows current occupant avatars', () => {
  const bridge = read('assets/supabase-bridge.js');
  const app = read('assets/app.js');
  assert.match(bridge, /get_scansafe_space_occupants/);
  assert.match(bridge, /map-occupant-stack/);
  assert.match(bridge, /Current Occupants/);
  assert.match(bridge, /profile_url/);
  assert.match(bridge, /Automatic Assignment/);
  assert.doesNotMatch(app, /Assign Approved Group/);
});

test('normal UI does not expose algorithm name', () => {
  for (const rel of ['admin-dashboard.html','barcode-scanner.html','shelter-room.html','assets/scanner.js']) {
    assert.doesNotMatch(read(rel), /GBEAA/i, rel + ' should not expose the algorithm name');
  }
});

test('mobile bottom navigation aligns icon and label rows and badges are overlays', () => {
  const css = read('assets/style.css');
  assert.match(css, /\.mobile-bottom-nav a\{[\s\S]*display:grid!important;[\s\S]*grid-template-rows:25px 18px!important;/);
  assert.match(css, /\.mobile-bottom-nav \.nav-badge,[\s\S]*position:absolute!important;/);
  assert.match(css, /\.mobile-bottom-nav \.needs-lock-badge/);
});

test('Request Needs remains controlled by active assignment eligibility', () => {
  const js = read('assets/needs-requests.js');
  assert.match(js, /state\.loaded && state\.eligible === true && !state\.error/);
  assert.match(js, /Waiting for accommodation assignment/);
  assert.match(js, /needs-nav-locked/);
});

test('PWA cache is bumped for readmission/map/mobile changes', () => {
  assert.match(read('service-worker.js'), /scansafe-pwa-v27-readmission-map-polish/);
});
