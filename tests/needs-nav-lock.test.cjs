const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('Request Needs navigation visibly locks until eligibility is true', () => {
  const js = read('assets/needs-requests.js');
  const css = read('assets/style.css');

  assert.match(js, /updateNeedsNavigation/);
  assert.match(js, /needs-nav-locked/);
  assert.match(js, /data-needs-lock/);
  assert.match(js, /Waiting for accommodation assignment/);
  assert.match(js, /handleNeedsNavigation/);
  assert.match(css, /\.user-side \.nav-item\.needs-nav-locked/);
  assert.match(css, /\.needs-lock-badge/);
});

test('locked Request Needs navigation is released only from server eligibility', () => {
  const js = read('assets/needs-requests.js');
  assert.match(js, /state\.loaded && state\.eligible === true && !state\.error/);
  assert.match(js, /updateNeedsNavigation\(available, reason\)/);
});

test('duplicate registration diagnostic is read-only', () => {
  const sql = read('SUPABASE_DUPLICATE_REGISTRATION_DIAGNOSTIC.sql');
  assert.match(sql, /from public\.evacuees/i);
  assert.match(sql, /left join auth\.users/i);
  assert.doesNotMatch(sql, /\bdelete\s+from\b/i);
  assert.doesNotMatch(sql, /\bupdate\s+public\./i);
});
