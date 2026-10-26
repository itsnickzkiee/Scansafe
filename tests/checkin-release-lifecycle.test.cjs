const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('lifecycle SQL blocks duplicate check-in and exposes release RPC', () => {
  const sql = read('SUPABASE_CHECKIN_RELEASE_LIFECYCLE.sql');
  assert.match(sql, /duplicate_checkin_blocked/);
  assert.match(sql, /scan_state','already_checked_in/);
  assert.match(sql, /release_scansafe_group/);
  assert.match(sql, /get_my_scansafe_stay/);
  assert.match(sql, /checked_in_at/);
  assert.match(sql, /duplicate_checkin_blocked/);
  assert.match(sql, /released_at/);
});

test('scanner renders one-time check-in, duplicate and released states', () => {
  const js = read('assets/scanner.js');
  assert.match(js, /ALREADY CHECKED IN/);
  assert.match(js, /Duplicate scan blocked/);
  assert.match(js, /Accommodated \/ Checked In/);
  assert.match(js, /Arrival Time/);
  assert.match(js, /Shelter stay already ended/);
});

test('admin detail exposes controlled release flow', () => {
  const js = read('assets/supabase-bridge.js');
  assert.match(js, /ScanSafeRelease/);
  assert.match(js, /release_scansafe_group/);
  assert.match(js, /release-stay-button/);
  assert.match(js, /Release reason/);
  assert.match(js, /Departure Time/);
});

test('evacuee UI uses simplified four-step lifecycle', () => {
  const js = read('assets/supabase-bridge.js');
  assert.match(js, /\['Submitted',loaded/);
  assert.match(js, /\['Approved',approved/);
  assert.match(js, /\['Accommodated',accommodated\|\|released/);
  assert.match(js, /\['Released',released/);
  assert.match(js, /renderShelterStayLifecycle/);
});

test('stay cards are present on core evacuee pages', () => {
  for (const rel of ['user-portal.html','my-information.html','profile.html']) {
    assert.match(read(rel), /data-user-stay-card/);
  }
});

test('Request Needs remains assignment-gated', () => {
  const js = read('assets/needs-requests.js');
  assert.match(js, /state\.loaded && state\.eligible === true && !state\.error/);
  assert.match(js, /Waiting for accommodation assignment/);
});

test('service worker cache is bumped', () => {
  assert.match(read('service-worker.js'), /scansafe-pwa-v27-readmission-map-polish/);
});


test('scanner page explains one-time check-in behavior', () => {
  const html = read('barcode-scanner.html');
  assert.match(html, /first valid scan records check-in/i);
  assert.match(html, /Repeat scans are blocked/i);
});

test('status pills polish accommodated and released states', () => {
  const js = read('assets/app.js');
  assert.ok(js.includes('Accommodated / Checked In'));
  assert.ok(js.includes("norm==='Released'?'gray'"));
});
