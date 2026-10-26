const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=rel=>fs.readFileSync(path.join(root,rel),'utf8');

test('map markers have admin assignment fallback',()=>{
  const js=read('assets/supabase-bridge.js');
  assert.ok(js.includes('function adminMapFallbackOccupants()'));
  assert.ok(js.includes('mergeAdminMapOccupants'));
  assert.ok(js.includes("row.assigned_space_code"));
  assert.ok(js.includes("source:'admin_live_fallback'"));
  assert.ok(js.includes('renderedCount:rows.length'));
});

test('map debug helper is available',()=>{
  const js=read('assets/supabase-bridge.js');
  assert.ok(js.includes('window.ScanSafeMapDebug'));
  assert.ok(js.includes('occupantDebug'));
});

test('service worker cache is bumped',()=>{
  assert.ok(read('service-worker.js').includes('scansafe-pwa-v29-map-marker-fallback'));
});
