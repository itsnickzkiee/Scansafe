const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=rel=>fs.readFileSync(path.join(root,rel),'utf8');

test('marker is appended directly inside the accommodation hotspot',()=>{
  const js=read('assets/supabase-bridge.js');
  assert.ok(js.includes("hotspot.appendChild(stack)"));
  assert.ok(js.includes("map-occupant-stack-anchored"));
  assert.ok(js.includes('.map-hotspot[data-space='));
  assert.ok(!js.includes("stack.style.left=left+'%'"));
});

test('direct assignment fallback does not depend on occupant RPC',()=>{
  const js=read('assets/supabase-bridge.js');
  assert.ok(js.includes('adminMapDirectAssignmentOccupants'));
  assert.ok(js.includes("sb.from('accommodation_assignments')"));
  assert.ok(js.includes("directAssignmentCount"));
  assert.ok(js.includes("source:'direct_assignment_fallback'"));
});

test('anchored bubble css is visible and centered',()=>{
  const css=read('assets/style.css');
  assert.ok(css.includes('.map-occupant-stack.map-occupant-stack-anchored'));
  assert.ok(css.includes('left:50%!important'));
  assert.ok(css.includes('top:50%!important'));
  assert.ok(css.includes('z-index:30!important'));
});

test('cache is bumped for v30 marker renderer',()=>{
  assert.ok(read('service-worker.js').includes('scansafe-pwa-v30-anchored-map-profile-bubble'));
});
