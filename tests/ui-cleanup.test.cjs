const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('Quick Actions stay while Contact Staff is removed', () => {
  const info = read('my-information.html');
  const room = read('user-room.html');

  assert.doesNotMatch(info, />Contact Staff</);
  assert.match(info, /Quick Actions/);
  assert.match(info, />View Barcode</);
  assert.match(info, />View Notifications</);

  assert.doesNotMatch(room, />Contact Staff</);
  assert.match(room, /Quick Actions/);
  assert.match(room, />Report an Issue</);
});

test('profile photo upload is attached to avatar and ID re-upload is not exposed', () => {
  const profile = read('profile.html');
  const media = read('assets/account-media.js');
  assert.match(profile, /class="profile-photo-control"/);
  assert.match(profile, /data-profile-photo-picker/);
  assert.match(profile, /id="profilePhotoUpload"/);
  assert.doesNotMatch(profile, /Upload ID image/);
  assert.match(media, /input\.click\(\)/);
  assert.match(media, /upload\('profile'/);
  assert.doesNotMatch(media, /data-media-upload="valid-id"/);
  assert.doesNotMatch(media, /Upload ID image/);
});

test('admin registration review still retains registration ID preview support', () => {
  const media = read('assets/account-media.js');
  assert.match(media, /Uploaded registration ID/);
  assert.match(media, /\['profile_photo', 'valid_id'\]/);
});

test('service worker cache is bumped for UI cleanup', () => {
  assert.match(read('service-worker.js'), /scansafe-pwa-v26-checkin-release-lifecycle/);
});
