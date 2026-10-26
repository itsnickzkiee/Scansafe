const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=r=>fs.readFileSync(path.join(root,r),'utf8');

test('archive UI has ScanSafe active/archived segmented design',()=>{
  const css=read('assets/messages-enhanced.css');
  assert.ok(css.includes('.ss-conversation-switch'));
  assert.ok(css.includes('linear-gradient(135deg,#e60000,#bd0000)'));
  assert.ok(css.includes('.ss-contact-archived'));
  assert.ok(css.includes('.ss-restore-contact'));
});
test('archive/delete buttons are visually distinct',()=>{
  const css=read('assets/messages-enhanced.css');
  assert.ok(css.includes('.ss-archive-conversation'));
  assert.ok(css.includes('.ss-delete-conversation'));
});
test('audit details render as readable cards not raw json',()=>{
  const css=read('assets/admin-records.css');
  assert.ok(css.includes('.records-detail-list'));
  assert.ok(css.includes('grid-template-columns:repeat(2'));
  assert.ok(css.includes('.records-tabs'));
});
