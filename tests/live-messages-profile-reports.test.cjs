const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=rel=>fs.readFileSync(path.join(root,rel),'utf8');

test('messages UI removes exposed dark shell gaps',()=>{
  const css=read('assets/messages-enhanced.css');
  assert.ok(css.includes('background:#f8fafc!important'));
  assert.ok(css.includes('height:auto!important'));
  assert.ok(css.includes('min-height:calc(100vh - 300px)!important'));
});

test('messages have realtime plus no-refresh fallback',()=>{
  const js=read('assets/messages-enhanced.js');
  assert.ok(js.includes("table:'messages'"));
  assert.ok(js.includes('livePollTimer=setInterval'));
  assert.ok(js.includes("document.visibilityState==='visible'"));
  assert.ok(js.includes('realtimeStatus'));
});

test('profile photos update live across tabs and admin contacts',()=>{
  const media=read('assets/account-media.js');
  const msg=read('assets/messages-enhanced.js');
  const sql=read('SUPABASE_LIVE_MESSAGES_PROFILE_FIX.sql');
  assert.ok(media.includes("table:'scansafe_account_media'"));
  assert.ok(media.includes('scansafe:profile-media-updated'));
  assert.ok(msg.includes('get_staff_message_contacts_v2'));
  assert.ok(msg.includes('profile_path'));
  assert.ok(sql.includes('get_staff_message_contacts_v2'));
  assert.ok(sql.includes('alter publication supabase_realtime add table public.scansafe_account_media'));
});

test('reports page has working filters, exports, live table and refresh',()=>{
  const html=read('reports.html');
  const js=read('assets/reports-live.js');
  assert.ok(html.includes('data-report-range'));
  assert.ok(html.includes('data-report-shelter'));
  assert.ok(html.includes('data-report-type'));
  assert.ok(html.includes('data-report-live-table'));
  assert.ok(js.includes("get_scansafe_report_summary"));
  assert.ok(js.includes("get_scansafe_evacuee_report_rows"));
  assert.ok(js.includes('exportCsv'));
  assert.ok(js.includes('exportPdf'));
  assert.ok(js.includes('setInterval'));
});

test('patch source does not modify map renderer files',()=>{
  const sql=read('SUPABASE_LIVE_MESSAGES_PROFILE_FIX.sql');
  assert.ok(!sql.includes('assign_group'));
  assert.ok(!sql.includes('current_occupancy'));
  assert.ok(!sql.includes('accommodation_assignments'));
});
