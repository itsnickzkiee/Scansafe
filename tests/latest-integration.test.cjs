const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('account media and notification center are wired into live pages', () => {
  for (const rel of ['index.html','profile.html','admin-dashboard.html','evacuees.html','user-notifications.html']) {
    const html = read(rel);
    assert.match(html, /assets\/account-media\.js/);
    assert.match(html, /assets\/notification-center\.js/);
    assert.match(html, /assets\/account-media\.css/);
    assert.match(html, /assets\/notification-center\.css/);
  }
});

test('profile exposes upload controls and removes redundant Contact Staff action', () => {
  const html = read('profile.html');
  assert.match(html, /id="profilePhotoUpload"/);
  assert.doesNotMatch(html, />Contact Staff<\/button>/);
});

test('bridge initializes private media and notification modules and enriches admin review', () => {
  const js = read('assets/supabase-bridge.js');
  assert.match(js, /ScanSafeMedia\.init/);
  assert.match(js, /ScanSafeNotifications\.init/);
  assert.match(js, /showRegistrationReview/);
  assert.match(js, /reviewRegistrationWithMedia/);
  assert.match(js, /ScanSafe no longer uses email confirmation/);
});

test('registration page states immediate login and barcode approval flow', () => {
  const html = read('index.html');
  assert.match(html, /You can log in immediately/);
  assert.match(html, /Barcode issued after approval/);
  assert.doesNotMatch(html, /QR Code Issued after approval/);
});

test('service worker includes live media and notification assets', () => {
  const sw = read('service-worker.js');
  assert.match(sw, /account-media\.js/);
  assert.match(sw, /notification-center\.js/);
  assert.match(sw, /scansafe-pwa-v27-readmission-map-polish/);
});
