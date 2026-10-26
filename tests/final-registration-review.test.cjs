const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=r=>fs.readFileSync(path.join(root,r),'utf8');

test('login has password visibility eye',()=>{
  const html=read('index.html');
  const js=read('assets/registration-review.js');
  assert.ok(html.includes('data-login-password-eye'));
  assert.ok(js.includes("input.type=showing?'password':'text'"));
});

test('admin rejection requires reasons and sends private notice',()=>{
  const sql=read('SUPABASE_FINAL_REGISTRATION_REVIEW.sql');
  const js=read('assets/registration-review.js');
  assert.ok(sql.includes('reject_evacuee_registration_v2'));
  assert.ok(sql.includes("'Registration Needs Correction'"));
  assert.ok(sql.includes("'specific','system'"));
  assert.ok(js.includes('Reject & Notify Evacuee'));
  assert.ok(js.includes('invalid_id'));
});

test('rejected evacuee can correct and resubmit only to pending',()=>{
  const sql=read('SUPABASE_FINAL_REGISTRATION_REVIEW.sql');
  const js=read('assets/registration-review.js');
  assert.ok(sql.includes("if v_e.approval_status<>'rejected'"));
  assert.ok(sql.includes("approval_status='pending'"));
  assert.ok(sql.includes('resubmit_my_registration_correction'));
  assert.ok(js.includes('Save Changes & Resubmit for Review'));
});

test('invalid ID rejection requires a newer ID upload',()=>{
  const sql=read('SUPABASE_FINAL_REGISTRATION_REVIEW.sql');
  assert.ok(sql.includes("array['invalid_id','id_unreadable','id_mismatch']"));
  assert.ok(sql.includes('v_id_uploaded_at<=v_e.rejected_at'));
});

test('registration submissions are retained in review history and audit',()=>{
  const sql=read('SUPABASE_FINAL_REGISTRATION_REVIEW.sql');
  assert.ok(sql.includes('scansafe_registration_review_history'));
  assert.ok(sql.includes("'registration_submitted'"));
  assert.ok(sql.includes('registration_submitted_snapshot'));
  assert.ok(sql.includes('scansafe_registration_audit_details'));
});

test('map and scanner logic are not touched by this patch SQL',()=>{
  const sql=read('SUPABASE_FINAL_REGISTRATION_REVIEW.sql');
  assert.ok(!sql.includes('accommodation_assignments'));
  assert.ok(!sql.includes('current_occupancy'));
  assert.ok(!sql.includes('scan_logs'));
});
