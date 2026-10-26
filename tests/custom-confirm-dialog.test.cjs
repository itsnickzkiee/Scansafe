const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=r=>fs.readFileSync(path.join(root,r),'utf8');

test('native confirm removed',()=>{
  const js=read('assets/messages-enhanced.js');
  assert.ok(js.includes('function scansafeConfirm'));
  assert.ok(!js.includes('window.confirm('));
});
test('delete and archive use custom dialog',()=>{
  const js=read('assets/messages-enhanced.js');
  assert.ok(js.includes("actionLabel:'Delete Conversation'"));
  assert.ok(js.includes("actionLabel:'Archive Conversation'"));
});
test('dialog has responsive ScanSafe design',()=>{
  const css=read('assets/messages-enhanced.css');
  assert.ok(css.includes('.ss-confirm-modal'));
  assert.ok(css.includes('.ss-confirm-card.danger'));
  assert.ok(css.includes('.ss-confirm-action.warning'));
});
