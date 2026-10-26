const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname,'..');
const read = rel => fs.readFileSync(path.join(root,rel),'utf8');

test('map occupants include active assignments before check-in',()=>{
  const sql=read('SUPABASE_MAP_PROFILE_MARKER_FIX.sql');
  assert.ok(sql.includes("where a.assignment_status='active'"));
  assert.ok(sql.includes('left join lateral'));
  assert.ok(sql.includes("'map_status'"));
  assert.ok(!sql.includes('checked_in_at is not null'));
});

test('map UI differentiates assigned and checked-in occupants',()=>{
  const js=read('assets/supabase-bridge.js');
  assert.ok(js.includes('Assigned — waiting for check-in'));
  assert.ok(js.includes("person.arrival_time?'Checked In':'Assigned'"));
  assert.ok(js.includes('map-occupant-stack'));
});

test('map marker cache bumped',()=>{
  assert.ok(read('service-worker.js').includes('scansafe-pwa-v28-map-profile-marker'));
});
