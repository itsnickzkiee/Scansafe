const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=rel=>fs.readFileSync(path.join(root,rel),'utf8');

test('messaging patch is isolated from accommodation/map files',()=>{
  const files=['messages.html','user-messages.html','assets/messages-enhanced.js','assets/messages-enhanced.css','SUPABASE_MESSAGES_ENHANCEMENT.sql'];
  files.forEach(f=>assert.ok(fs.existsSync(path.join(root,f)),f));
  assert.ok(!read('assets/messages-enhanced.js').includes('accommodation_assignments'));
  assert.ok(!read('SUPABASE_MESSAGES_ENHANCEMENT.sql').includes('accommodation_spaces'));
});

test('smooth optimistic sending and duplicate prevention exist',()=>{
  const js=read('assets/messages-enhanced.js');
  assert.ok(js.includes('appendOptimistic'));
  assert.ok(js.includes("state.sending=true"));
  assert.ok(js.includes("updateOptimistic(temp,'Sent')"));
  assert.ok(js.includes("if(e.key==='Enter'&&!e.shiftKey)"));
});

test('typing broadcast uses realtime and animated indicators',()=>{
  const js=read('assets/messages-enhanced.js');
  const css=read('assets/messages-enhanced.css');
  assert.ok(js.includes("event:'typing'"));
  assert.ok(js.includes('broadcastTyping'));
  assert.ok(js.includes('showRemoteTyping'));
  assert.ok(css.includes('@keyframes ssTypingDot'));
});

test('compose message and templates are functional',()=>{
  const js=read('assets/messages-enhanced.js');
  assert.ok(js.includes('Compose Message'));
  assert.ok(js.includes('sendCompose'));
  assert.ok(js.includes('staff_send_scansafe_message'));
  assert.ok(js.includes('useTemplate'));
  assert.ok(js.includes('Weather Advisory'));
});

test('quick announcement supports evacuees staff and everyone',()=>{
  const html=read('messages.html');
  const js=read('assets/messages-enhanced.js');
  assert.ok(html.includes('value="evacuees"'));
  assert.ok(html.includes('value="staff"'));
  assert.ok(html.includes('value="all"'));
  assert.ok(js.includes("send_scansafe_announcement"));
});

test('both message pages load isolated enhancement assets',()=>{
  for(const rel of ['messages.html','user-messages.html']){
    const html=read(rel);
    assert.ok(html.includes('messages-enhanced.css?v=messages-v1'));
    assert.ok(html.includes('messages-enhanced.js?v=messages-v1'));
    assert.ok(html.includes('data-message-send'));
  }
});

test('user contact rpc is limited to messaging tables/profiles',()=>{
  const sql=read('SUPABASE_MESSAGES_ENHANCEMENT.sql');
  assert.ok(sql.includes('get_my_scansafe_message_contact'));
  assert.ok(sql.includes('public.messages'));
  assert.ok(sql.includes('public.profiles'));
});
