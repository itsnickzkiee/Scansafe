const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=r=>fs.readFileSync(path.join(root,r),'utf8');

test('archived conversations are managed inside Messages',()=>{
  const html=read('messages.html'),js=read('assets/messages-enhanced.js');
  assert.ok(html.includes('data-conversation-mode="archived"'));
  assert.ok(js.includes('loadArchivedContacts'));
  assert.ok(js.includes('restoreArchivedConversation'));
});
test('reports no longer shows archived conversations tab',()=>{
  const html=read('reports.html');
  assert.ok(!html.includes('data-records-tab="archives"'));
  assert.ok(!html.includes('data-records-panel="archives"'));
});
test('delete conversation is safe clear-from-view, not hard delete',()=>{
  const sql=read('SUPABASE_MESSAGE_ARCHIVE_DELETE_UI_FIX.sql');
  const js=read('assets/messages-enhanced.js');
  assert.ok(sql.includes('clear_scansafe_conversation'));
  assert.ok(sql.includes('scansafe_conversation_clears'));
  assert.ok(!sql.includes('delete from public.messages'));
  assert.ok(js.includes('clearCurrentConversation'));
  assert.ok(js.includes('data-delete-conversation'));
});
test('audit details are human readable and algorithm wording hidden',()=>{
  const js=read('assets/admin-records.js');
  assert.ok(js.includes('auditDetails'));
  assert.ok(js.includes("gbeaa_assignment:'Accommodation assigned'"));
  assert.ok(js.includes("hidden=new Set(['algorithm'])"));
  assert.ok(!js.includes('<code>${esc(JSON.stringify(r.details||{}))}</code>'));
});
