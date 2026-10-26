const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=rel=>fs.readFileSync(path.join(root,rel),'utf8');

test('active assignment RPC is the deterministic map source',()=>{
  const sql=read('SUPABASE_ACTIVE_MAP_OCCUPANTS_FIX.sql');
  assert.ok(sql.includes("where a.assignment_status='active'"));
  assert.ok(sql.includes('get_scansafe_active_map_occupants'));
});

test('renderer creates a stage-level visible overlay',()=>{
  const js=read('assets/supabase-bridge.js');
  assert.ok(js.includes("sb.rpc('get_scansafe_active_map_occupants')"));
  assert.ok(js.includes("overlay.className='map-occupant-overlay'"));
  assert.ok(js.includes("stage.appendChild(overlay)"));
  assert.ok(js.includes("getBoundingClientRect()"));
});

test('overlay css is intentionally high visibility',()=>{
  const css=read('assets/style.css');
  assert.ok(css.includes('.map-occupant-overlay{'));
  assert.ok(css.includes('z-index')); // inline JS z-index + CSS visibility
  assert.ok(css.includes('visibility:visible!important'));
});

test('cache bumped',()=>{
  assert.ok(read('service-worker.js').includes('scansafe-pwa-v31-deterministic-map-occupants'));
});
