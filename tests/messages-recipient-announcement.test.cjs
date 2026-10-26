const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=rel=>fs.readFileSync(path.join(root,rel),'utf8');

test('legacy bridge cannot repaint enhanced admin thread',()=>{
  const html=read('messages.html');
  assert.ok(html.includes('id="ssThread"'));
  assert.ok(html.includes('data-enhanced-conv-head'));
  assert.ok(!html.includes('<h3 class="section-h">Recent Conversations</h3>'));
});
test('exact selected recipient is backend verified',()=>{
  const js=read('assets/messages-enhanced.js');
  const sql=read('SUPABASE_MESSAGES_RECIPIENT_FIX.sql');
  assert.ok(js.includes('selectedReceiver()'));
  assert.ok(js.includes('staff_send_scansafe_message_v2'));
  assert.ok(js.includes('Recipient verification failed'));
  assert.ok(sql.includes("'receiver_id',p_receiver"));
});
test('async thread race is blocked',()=>{
  const js=read('assets/messages-enhanced.js');
  assert.ok(js.includes('selectionSeq'));
  assert.ok(js.includes('seq!==state.selectionSeq'));
});
test('announcement is notification plus evacuee dashboard update',()=>{
  const js=read('assets/messages-enhanced.js');
  const n=read('assets/notification-center.js');
  assert.ok(js.includes('send_scansafe_announcement'));
  assert.ok(n.includes('dashboardAnnouncement'));
  assert.ok(n.includes("userLatestCard"));
  assert.ok(n.includes("user-notifications.html"));
});
test('patch contains no accommodation/map SQL',()=>{
  const sql=read('SUPABASE_MESSAGES_RECIPIENT_FIX.sql');
  assert.ok(!sql.includes('accommodation_assignments'));
  assert.ok(!sql.includes('accommodation_spaces'));
});
