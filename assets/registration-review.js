(function(){
'use strict';

const page=(location.pathname.split('/').pop()||'index.html').toLowerCase();
const $=s=>document.querySelector(s);
const $$=s=>[...document.querySelectorAll(s)];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let currentReviewId=null,currentReviewDbId=null,wrapTimer=null;

const issueLabels={
  invalid_id:'Invalid ID',
  id_unreadable:'ID image is unreadable',
  id_mismatch:'ID does not match registration',
  missing_information:'Missing information',
  address_verification:'Address needs verification',
  other:'Other correction required'
};

function sb(){
  return window.ScanSafeDB?.client||null;
}
function toast(message){
  if(typeof window.toast==='function') window.toast(message);
  else alert(message);
}
function formatDate(value){
  if(!value) return '—';
  const d=new Date(value);
  return Number.isNaN(d.getTime())?'—':d.toLocaleString();
}

/* Login password eye */
function initPasswordEye(){
  const input=$('#loginPassword'),button=$('[data-login-password-eye]');
  if(!input||!button) return;
  button.addEventListener('click',()=>{
    const showing=input.type==='text';
    input.type=showing?'password':'text';
    button.setAttribute('aria-pressed',String(!showing));
    button.setAttribute('aria-label',showing?'Show password':'Hide password');
    button.title=showing?'Show password':'Hide password';
  });
}

/* ScanSafe rejection dialog */
function rejectionDialog(name){
  return new Promise(resolve=>{
    document.getElementById('registrationRejectDialog')?.remove();
    document.body.insertAdjacentHTML('beforeend',`
      <div class="registration-review-modal" id="registrationRejectDialog" role="dialog" aria-modal="true">
        <button type="button" class="registration-review-backdrop" data-reject-cancel aria-label="Close"></button>
        <section class="registration-review-card">
          <div class="registration-review-icon">!</div>
          <span class="registration-review-kicker">Request Correction</span>
          <h3>Reject ${esc(name||'this registration')}?</h3>
          <p>Select the exact issue. The evacuee will receive this as an account notification and can correct the registration from Profile.</p>
          <div class="registration-review-options">
            ${Object.entries(issueLabels).map(([value,label])=>`
              <label><input type="checkbox" value="${esc(value)}" data-reject-issue><span>${esc(label)}</span></label>
            `).join('')}
          </div>
          <label class="registration-review-note">
            <span>Admin note <small>(optional)</small></span>
            <textarea data-reject-note maxlength="500" placeholder="Example: Please upload a clearer photo of your National ID."></textarea>
          </label>
          <div class="registration-review-error" data-reject-error hidden></div>
          <div class="registration-review-actions">
            <button type="button" class="btn out" data-reject-cancel>Cancel</button>
            <button type="button" class="btn red" data-reject-confirm>Reject & Notify Evacuee</button>
          </div>
        </section>
      </div>`);
    const modal=$('#registrationRejectDialog');
    let done=false;
    const finish=value=>{
      if(done)return;done=true;
      document.removeEventListener('keydown',onKey);
      modal?.remove();
      resolve(value);
    };
    const onKey=e=>{if(e.key==='Escape')finish(null);};
    modal.querySelectorAll('[data-reject-cancel]').forEach(b=>b.addEventListener('click',()=>finish(null)));
    modal.querySelector('[data-reject-confirm]')?.addEventListener('click',()=>{
      const issues=[...modal.querySelectorAll('[data-reject-issue]:checked')].map(x=>x.value);
      const note=modal.querySelector('[data-reject-note]')?.value.trim()||'';
      const error=modal.querySelector('[data-reject-error]');
      if(!issues.length){
        error.hidden=false;error.textContent='Select at least one review issue.';
        return;
      }
      finish({issues,note});
    });
    document.addEventListener('keydown',onKey);
  });
}

function requestById(id){
  const state=window.currentState?.();
  return state?.requests?.find(r=>String(r.id)===String(id))||null;
}

async function loadReviewHistory(requestId){
  const client=sb(),req=requestById(requestId),target=$('#reviewDetails');
  if(!client||!req?.dbId||!target) return;
  currentReviewDbId=req.dbId;
  const {data,error}=await client.rpc('get_scansafe_registration_review_history',{p_evacuee_id:req.dbId});
  if(error){console.warn('Registration review history:',error.message);return;}
  target.querySelector('[data-registration-history]')?.remove();
  const rows=Array.isArray(data)?data:[];
  const block=document.createElement('section');
  block.className='registration-history';
  block.dataset.registrationHistory='';
  block.innerHTML=`
    <div class="registration-history-head">
      <div><b>Registration Review History</b><span>Submitted information and review actions are retained for audit.</span></div>
      <em>${rows.length} record${rows.length===1?'':'s'}</em>
    </div>
    <div class="registration-history-list">
      ${rows.length?rows.map(row=>{
        const snap=row.snapshot||{};
        const issues=(row.issues||[]).map(x=>issueLabels[x]||x);
        return `<article class="registration-history-item ${esc(row.action)}">
          <div class="registration-history-marker"></div>
          <div class="registration-history-content">
            <div class="registration-history-title">
              <b>${esc(row.action==='submitted'?'Registration Submitted':row.action==='rejected'?'Correction Requested':row.action==='resubmitted'?'Registration Resubmitted':'Registration Approved')}</b>
              <span>${esc(formatDate(row.created_at))}</span>
            </div>
            <small>Revision ${esc(row.revision||1)} • ${esc(row.actor_name||'System')}</small>
            ${issues.length?`<div class="registration-history-issues">${issues.map(x=>`<span>${esc(x)}</span>`).join('')}</div>`:''}
            ${row.note?`<p class="registration-history-note">${esc(row.note)}</p>`:''}
            <div class="registration-history-snapshot">
              <span><b>Name</b>${esc(snap.full_name||'—')}</span>
              <span><b>Group</b>${esc(snap.group_size||'—')}</span>
              <span><b>Address</b>${esc([snap.address,snap.barangay,snap.city].filter(Boolean).join(', ')||'—')}</span>
              <span><b>ID</b>${esc([snap.valid_id_type,snap.valid_id_number].filter(Boolean).join(' • ')||'—')}</span>
              <span><b>Needs</b>${esc(snap.needs||'None')}</span>
            </div>
          </div>
        </article>`;
      }).join(''):'<div class="space-placeholder">No review history yet.</div>'}
    </div>`;
  target.appendChild(block);
}

function installReviewWrapper(){
  if(!['admin-dashboard.html','evacuees.html'].includes(page)) return;
  const current=window.reviewRegistration;
  if(typeof current!=='function'||current.__scansafeReviewWrapped) return;
  const wrapped=async function(id){
    currentReviewId=id;
    const req=requestById(id);
    currentReviewDbId=req?.dbId||null;
    const result=await current.apply(this,arguments);
    const reject=$('#rejectBtn');
    if(reject) reject.textContent='Reject / Request Correction';
    await loadReviewHistory(id);
    return result;
  };
  wrapped.__scansafeReviewWrapped=true;
  window.reviewRegistration=wrapped;
}

async function rejectCurrentRegistration(){
  const client=sb();
  const req=requestById(currentReviewId);
  const dbId=currentReviewDbId||req?.dbId;
  if(!client||!dbId){toast('Registration record is not available. Reopen the review.');return;}
  const decision=await rejectionDialog(req?.name||$('#reviewName')?.textContent||'this registration');
  if(!decision)return;
  const rejectBtn=$('#rejectBtn');
  if(rejectBtn){rejectBtn.disabled=true;rejectBtn.textContent='Saving review...';}
  try{
    const {error}=await client.rpc('reject_evacuee_registration_v2',{
      p_evacuee_id:Number(dbId),
      p_issues:decision.issues,
      p_note:decision.note||null
    });
    if(error) throw error;
    window.closeReviewModal?.();
    toast('Registration rejected. The evacuee was notified and can correct it from Profile.');
    await window.ScanSafeAdminLive?.refresh?.();
  }catch(error){
    toast('Rejection failed: '+(error?.message||error));
  }finally{
    if(rejectBtn){rejectBtn.disabled=false;rejectBtn.textContent='Reject / Request Correction';}
  }
}

function initAdminReview(){
  if(!['admin-dashboard.html','evacuees.html'].includes(page)) return;
  document.addEventListener('click',event=>{
    const btn=event.target.closest?.('#rejectBtn');
    if(!btn)return;
    event.preventDefault();
    event.stopImmediatePropagation();
    rejectCurrentRegistration();
  },true);
  installReviewWrapper();
  wrapTimer=setInterval(installReviewWrapper,800);
  setTimeout(()=>{clearInterval(wrapTimer);wrapTimer=null;installReviewWrapper();},12000);
}

/* Evacuee correction */
async function waitForAccount(){
  for(let i=0;i<30;i++){
    if(window.ScanSafeDB?.client&&window.ScanSafeDB?.session?.user?.id&&window.ScanSafeDB?.profile?.role==='evacuee') return true;
    await new Promise(r=>setTimeout(r,200));
  }
  return false;
}

function correctionCard(data,fullForm){
  const r=data.registration||{};
  const issues=(data.issues||[]).map(x=>issueLabels[x]||x);
  const requiresId=!!data.requires_new_id;
  const card=document.createElement('section');
  card.className='registration-correction-card card';
  card.id='registrationCorrectionCard';
  card.dataset.requiresId=requiresId?'1':'0';
  card.innerHTML=`
    <div class="registration-correction-head">
      <div class="registration-correction-alert">!</div>
      <div>
        <span>Action Required</span>
        <h3>Registration needs correction</h3>
        <p>Your account remains active, but approval and barcode issuance are paused until the requested information is corrected and reviewed again.</p>
      </div>
    </div>
    <div class="registration-correction-issues">
      ${issues.map(x=>`<span>${esc(x)}</span>`).join('')}
    </div>
    ${data.note?`<div class="registration-admin-note"><b>Admin note</b><p>${esc(data.note)}</p></div>`:''}
    ${fullForm?`
      <form data-registration-correction-form>
        <div class="registration-correction-grid">
          <label><span>Full Name</span><input name="full_name" value="${esc(r.full_name||'')}" required></label>
          <label><span>Age</span><input name="age" type="number" min="1" max="120" value="${esc(r.age||'')}" required></label>
          <label><span>Gender</span><select name="gender"><option ${r.gender==='Male'?'selected':''}>Male</option><option ${r.gender==='Female'?'selected':''}>Female</option></select></label>
          <label><span>Group Size</span><input name="group_size" type="number" min="1" max="50" value="${esc(r.group_size||1)}" required></label>
          <label><span>Contact Number</span><input name="contact_number" value="${esc(r.contact_number||'')}" placeholder="Add contact number if requested"></label>
          <label><span>Emergency Contact</span><input name="emergency_contact" value="${esc(r.emergency_contact||'')}" placeholder="Optional emergency contact"></label>
          <label class="wide"><span>Special / Medical Needs</span><input name="needs" value="${esc(r.needs||'None')}"></label>
          <label class="wide"><span>Complete Address</span><input name="address" value="${esc(r.address||'')}" required></label>
          <label><span>Barangay</span><input name="barangay" value="${esc(r.barangay||'')}" required></label>
          <label><span>Municipality / City</span><input name="city" value="${esc(r.city||'')}" required></label>
          <label><span>Valid ID Type</span><select name="valid_id_type" required>
            ${['National ID','Barangay ID',"Voter's ID","Driver's License",'School ID','Senior Citizen ID','PWD ID','Passport','Other Government ID'].map(x=>`<option ${r.valid_id_type===x?'selected':''}>${esc(x)}</option>`).join('')}
          </select></label>
          <label><span>Valid ID Number</span><input name="valid_id_number" value="${esc(r.valid_id_number||'')}" required></label>
          <label class="wide registration-id-replacement">
            <span>${requiresId?'Replace Valid ID Image (required)':'Replace Valid ID Image (only if requested)'}</span>
            <input name="valid_id_image" type="file" accept="image/jpeg,image/png,image/webp">
            <small>${requiresId?'Upload a new clear ID image before resubmitting.':'You may keep the current ID unless the admin requested a replacement.'}</small>
          </label>
        </div>
        <div class="registration-correction-status" data-correction-status></div>
        <button class="btn red" type="submit" data-correction-submit>Save Changes & Resubmit for Review</button>
      </form>
    `:`<div class="registration-correction-actions"><a class="btn red" href="profile.html#registration-correction">Correct Registration</a><a class="btn out" href="user-notifications.html">View Notice</a></div>`}
  `;
  return card;
}

async function submitCorrection(form,data){
  const client=sb(),user=window.ScanSafeDB?.session?.user;
  if(!client||!user?.id)return;
  const status=form.querySelector('[data-correction-status]');
  const button=form.querySelector('[data-correction-submit]');
  const fd=new FormData(form),file=fd.get('valid_id_image');
  const requiresId=!!data.requires_new_id;
  if(requiresId && (!(file instanceof File)||!file.size)){
    status.textContent='A new valid ID image is required for this correction.';
    status.className='registration-correction-status error';
    return;
  }
  if(file instanceof File&&file.size){
    if(file.size>2*1024*1024){
      status.textContent='ID image must be 2 MB or smaller.';status.className='registration-correction-status error';return;
    }
  }
  button.disabled=true;button.textContent='Saving corrections...';
  status.textContent='';status.className='registration-correction-status';
  try{
    if(file instanceof File&&file.size){
      if(!window.ScanSafeMedia?.uploadRegistrationId) throw new Error('ID upload service is unavailable. Reload the page.');
      await window.ScanSafeMedia.uploadRegistrationId({file,ownerId:user.id});
    }
    const payload={
      p_full_name:String(fd.get('full_name')||'').trim(),
      p_age:Number(fd.get('age')||0),
      p_gender:String(fd.get('gender')||'').trim(),
      p_group_size:Number(fd.get('group_size')||1),
      p_needs:String(fd.get('needs')||'').trim()||'None',
      p_contact_number:String(fd.get('contact_number')||'').trim()||null,
      p_emergency_contact:String(fd.get('emergency_contact')||'').trim()||null,
      p_address:String(fd.get('address')||'').trim(),
      p_barangay:String(fd.get('barangay')||'').trim(),
      p_city:String(fd.get('city')||'').trim(),
      p_valid_id_type:String(fd.get('valid_id_type')||'').trim(),
      p_valid_id_number:String(fd.get('valid_id_number')||'').trim()
    };
    const {error}=await client.rpc('resubmit_my_registration_correction',payload);
    if(error) throw error;
    status.textContent='Registration resubmitted successfully. Status is now Pending Approval.';
    status.className='registration-correction-status success';
    button.textContent='Resubmitted';
    await window.ScanSafeNotifications?.refresh?.();
    setTimeout(()=>location.reload(),850);
  }catch(error){
    status.textContent=error?.message||'Registration could not be resubmitted.';
    status.className='registration-correction-status error';
    button.disabled=false;button.textContent='Save Changes & Resubmit for Review';
  }
}

async function initEvacueeCorrection(){
  if(!['profile.html','my-information.html','user-portal.html'].includes(page)) return;
  if(!(await waitForAccount())) return;
  const client=sb();
  const {data,error}=await client.rpc('get_my_registration_correction');
  if(error){console.warn('Registration correction:',error.message);return;}
  document.getElementById('registrationCorrectionCard')?.remove();
  if(!data?.registration||data.approval_status!=='rejected') return;

  const full=page==='profile.html'||page==='my-information.html';
  const card=correctionCard(data,full);
  const main=$('.user-main');
  const hero=$('.user-hero');
  if(hero) hero.insertAdjacentElement('afterend',card);
  else main?.prepend(card);

  if(location.hash==='#registration-correction') setTimeout(()=>card.scrollIntoView({behavior:'smooth',block:'start'}),150);
  card.querySelector('[data-registration-correction-form]')?.addEventListener('submit',event=>{
    event.preventDefault();submitCorrection(event.currentTarget,data);
  });
}

/* Admin audit labels for registration events */
function installAuditLabels(){
  if(page!=='reports.html') return;
  // admin-records.js owns rendering; the patched file provides the labels.
}

document.addEventListener('DOMContentLoaded',()=>{
  initPasswordEye();
  initAdminReview();
  initEvacueeCorrection();
  installAuditLabels();
});
})();