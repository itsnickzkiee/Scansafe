/* =========================================================
   ScanSafe Supabase Bridge
   Backend integration only. Does not alter the visual design.
   ========================================================= */
(function(){
  'use strict';

  const cfg = window.SCANSafeSupabaseConfig || {};
  const configured = !!(
    cfg.url && cfg.anonKey &&
    !String(cfg.url).includes('PASTE_YOUR_') &&
    !String(cfg.anonKey).includes('PASTE_YOUR_')
  );

  window.ScanSafeDB = {
    configured,
    client: null,
    session: null,
    profile: null
  };

  window.ScanSafeLoginDebug = async function(){
    const sb=readyClient();
    if(!sb){
      return {configured:false,projectUrl:cfg.url||null};
    }
    const {data:sessionData,error:sessionError}=await sb.auth.getSession();
    const session=sessionData?.session||null;
    let profile=null;
    let profileError=null;
    if(session?.user){
      const result=await sb.rpc('get_my_profile');
      profile=normalizeProfileRpcResult(result.data);
      profileError=result.error?.message||null;
    }
    return {
      configured,
      projectUrl:cfg.url||null,
      authenticated:!!session?.user,
      authUserId:session?.user?.id||null,
      email:session?.user?.email||null,
      profile,
      profileError,
      sessionError:sessionError?.message||null
    };
  };

  function readyClient(){
    if(!configured || !window.supabase || !window.supabase.createClient) return null;
    if(!window.ScanSafeDB.client){
      window.ScanSafeDB.client = window.supabase.createClient(cfg.url, cfg.anonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
    }
    return window.ScanSafeDB.client;
  }

  function uiError(message){
    const el=document.getElementById('loginError');
    if(el){ el.textContent=message; el.style.display='block'; }
    else if(typeof window.toast==='function') window.toast(message);
    else console.error(message);
  }

  function normalizeProfileRpcResult(data){
    if(!data) return null;
    if(Array.isArray(data)) return data[0]||null;
    if(typeof data==='object' && data.id) return data;
    return null;
  }

  async function getProfile(userId){
    const sb=readyClient();
    if(!sb || !userId) return null;

    // Preferred path: server-side helper bound to auth.uid().
    // This avoids false "no profile" results caused by frontend RLS/policy timing.
    try{
      const {data,error}=await sb.rpc('get_my_profile');
      if(!error){
        const profile=normalizeProfileRpcResult(data);
        if(profile && String(profile.id)===String(userId)){
          window.ScanSafeDB.profile=profile;
          return profile;
        }
      }else{
        console.warn('ScanSafe profile RPC:', error.message);
      }
    }catch(err){
      console.warn('ScanSafe profile RPC exception:', err);
    }

    // Compatibility fallback for databases where the login-fix SQL
    // has not yet been applied.
    const {data,error}=await sb
      .from('profiles')
      .select('id,full_name,role')
      .eq('id',userId)
      .maybeSingle();

    if(error){
      console.warn('ScanSafe profile fallback lookup:', error.message);
      return null;
    }

    window.ScanSafeDB.profile=data||null;
    return data||null;
  }

  async function bootstrapSession(){
    const sb=readyClient();
    if(!sb) return;
    const {data}=await sb.auth.getSession();
    const session=data && data.session ? data.session : null;
    window.ScanSafeDB.session=session;
    if(session?.user) await getProfile(session.user.id);
  }

  async function supabaseLogin(event){
    event.preventDefault();
    const sb=readyClient();
    if(!sb){
      if(configured){ uiError('ScanSafe backend is temporarily unavailable. Please reload and try again.'); return; }
      // Prototype fallback is allowed only when Supabase has not been configured.
      return window.__scanSafePrototypeLogin ? window.__scanSafePrototypeLogin(event) : undefined;
    }

    const username=(document.getElementById('loginUsername')?.value||'').trim();
    const password=document.getElementById('loginPassword')?.value||'';
    const err=document.getElementById('loginError');
    if(err) err.style.display='none';

    if(!username.includes('@')){
      uiError('Use the email address registered in Supabase Auth.');
      return;
    }

    const {data,error}=await sb.auth.signInWithPassword({email:username,password});
    if(error || !data?.user){ uiError(error?.message || 'Unable to sign in.'); return; }

    window.ScanSafeDB.session=data.session;

    // Profile request can occasionally race immediately after an Auth session
    // refresh. Retry briefly before treating the account as unprovisioned.
    let profile=null;
    for(let attempt=0; attempt<3 && !profile; attempt++){
      profile=await getProfile(data.user.id);
      if(!profile && attempt<2){
        await new Promise(resolve=>setTimeout(resolve,250));
      }
    }

    if(!profile){
      console.error('ScanSafe login profile mismatch', {
        authUserId:data.user.id,
        email:data.user.email,
        projectUrl:cfg.url
      });
      await sb.auth.signOut();
      uiError('Login succeeded, but ScanSafe could not load this account profile. Refresh the page and try again. If it continues, verify that this site is connected to the same Supabase project as the account.');
      return;
    }

    if(!['admin','staff','evacuee'].includes(String(profile.role||''))){
      await sb.auth.signOut();
      uiError('This ScanSafe account has an invalid access role.');
      return;
    }

    localStorage.setItem('scanSafeLoginRole', profile.role==='evacuee'?'user':profile.role);
    if(typeof window.showScanSafeLoginSplash==='function'){
      window.showScanSafeLoginSplash(profile.role==='evacuee'?'user-portal.html':'admin-dashboard.html');
    }else{
      location.href=profile.role==='evacuee'?'user-portal.html':'admin-dashboard.html';
    }
  }

  async function supabaseLogout(){
    const sb=readyClient();
    if(sb) await sb.auth.signOut();
    localStorage.removeItem('scanSafeLoginRole');
    localStorage.removeItem('scansafePrototypeStateV4');
    sessionStorage.removeItem('scansafePrototypeStateV4');
    sessionStorage.removeItem('scanSafePhase9Guard');
    location.href='index.html';
  }

  async function submitPublicRegistration(event){
    event.preventDefault();
    const sb=readyClient();
    if(!sb){
      if(configured){ if(typeof toast==='function') toast('ScanSafe backend is unavailable. Registration was not submitted.'); return; }
      return window.__scanSafePrototypeRegister ? window.__scanSafePrototypeRegister(event) : undefined;
    }

    const password=document.getElementById('publicPassword')?.value||'';
    const confirmPassword=document.getElementById('publicConfirmPassword')?.value||'';
    if(password.length<8){ if(typeof toast==='function') toast('Password must be at least 8 characters.'); return; }
    if(password!==confirmPassword){ if(typeof toast==='function') toast('Password and confirm password do not match.'); return; }

    const file=document.getElementById('publicValidIdImage')?.files?.[0]||null;
    if(file && file.size>2*1024*1024){ if(typeof toast==='function') toast('Valid ID image must be 2 MB or smaller.'); return; }

    const payload={
      p_full_name:(document.getElementById('publicName')?.value||'').trim(),
      p_email:(document.getElementById('publicEmail')?.value||'').trim().toLowerCase(),
      p_age:Number(document.getElementById('publicAge')?.value||0),
      p_gender:document.getElementById('publicGender')?.value||null,
      p_group_size:Number(document.getElementById('publicGroup')?.value||1),
      p_needs:(document.getElementById('publicNeeds')?.value||'').trim()||'None',
      p_address:(document.getElementById('publicAddress')?.value||'').trim(),
      p_barangay:(document.getElementById('publicBarangay')?.value||'').trim(),
      p_city:(document.getElementById('publicCity')?.value||'').trim(),
      p_valid_id_type:(document.getElementById('publicValidIdType')?.value||'').trim(),
      p_valid_id_number:(document.getElementById('publicValidIdNumber')?.value||'').trim()
    };

    if(!payload.p_full_name || !payload.p_email || !payload.p_valid_id_type || !payload.p_valid_id_number){
      if(typeof toast==='function') toast('Please complete all required registration fields.');
      return;
    }

    // Create the Supabase Auth account first. Password is handled by Supabase Auth
    // and is never written to ScanSafe tables or localStorage.
    const {data:signupData,error:signupError}=await sb.auth.signUp({
      email:payload.p_email,
      password,
      options:{ data:{ full_name:payload.p_full_name, role:'evacuee' } }
    });
    if(signupError || !signupData?.user){
      if(typeof toast==='function') toast('Account could not be created. '+(signupError?.message||''));
      return;
    }

    payload.p_auth_user_id=signupData.user.id;
    const {data,error}=await sb.rpc('submit_public_registration_account', payload);
    if(error){
      console.error(error);
      if(typeof toast==='function') toast('Account was created, but registration could not be saved. '+error.message);
      return;
    }

    if(typeof window.closePublicRegistration==='function') window.closePublicRegistration();
    if(typeof toast==='function') toast('Account created. Registration '+String(data||'')+' is pending admin approval. No QR code is available yet.');

    // Do not keep a newly-created evacuee signed in on the public/admin login page.
    if(signupData.session) await sb.auth.signOut();
  }

  async function loadPendingIntoPrototype(){
    const sb=readyClient();
    if(!sb || typeof window.currentState!=='function' || typeof window.saveScanSafeState!=='function') return;
    const page=(location.pathname.split('/').pop()||'').toLowerCase();
    if(!['admin-dashboard.html','evacuees.html'].includes(page)) return;

    const {data,error}=await sb.from('evacuees')
      .select('evacuee_id,registration_code,full_name,email,age,gender,group_size,needs_summary,address,barangay,city,valid_id_type,valid_id_number,approval_status,registered_at')
      .order('registered_at',{ascending:false})
      .limit(100);
    if(error){ console.warn('ScanSafe evacuee sync:',error.message); return; }

    const s=window.currentState();
    s.requests=(data||[]).map(row=>({
      id:row.registration_code || ('REQ-'+row.evacuee_id),
      dbId:row.evacuee_id,
      evacueeId:'EV-'+String(row.evacuee_id).padStart(3,'0'),
      name:row.full_name,
      email:row.email||'',
      age:row.age||0,
      gender:row.gender||'',
      group:row.group_size||1,
      needs:row.needs_summary||'None',
      address:row.address||'',
      barangay:row.barangay||'',
      city:row.city||'',
      validIdType:row.valid_id_type||'',
      validIdNumber:row.valid_id_number||'',
      submitted:row.registered_at ? new Date(row.registered_at).toLocaleString() : '',
      status:row.approval_status==='approved'?'Approved':row.approval_status==='rejected'?'Rejected':'Pending Approval'
    }));
    window.saveScanSafeState(s);
    if(typeof window.renderDashboardPrototype==='function') window.renderDashboardPrototype();
    if(typeof window.renderEvacs==='function') window.renderEvacs();
  }

  async function approveByRequestId(requestId){
    const sb=readyClient();
    if(!sb){
      if(configured){ if(typeof toast==='function') toast('Backend unavailable. Approval was not changed.'); return; }
      return window.__scanSafePrototypeApprove ? window.__scanSafePrototypeApprove(requestId) : undefined;
    }
    const s=typeof window.currentState==='function'?window.currentState():null;
    const req=s?.requests?.find(r=>r.id===requestId);
    if(!req?.dbId){ if(typeof toast==='function') toast('Database record not found for this request.'); return; }

    const {data,error}=await sb.rpc('approve_evacuee_registration',{p_evacuee_id:req.dbId});
    if(error){ if(typeof toast==='function') toast('Approval failed: '+error.message); return; }
    if(typeof window.closeReviewModal==='function') window.closeReviewModal();
    if(typeof toast==='function') toast('Approved. QR code generated: '+String(data||''));
    await loadPendingIntoPrototype();
  }

  async function rejectByRequestId(requestId){
    const sb=readyClient();
    if(!sb){
      if(configured){ if(typeof toast==='function') toast('Backend unavailable. Rejection was not changed.'); return; }
      return window.__scanSafePrototypeReject ? window.__scanSafePrototypeReject(requestId) : undefined;
    }
    const s=typeof window.currentState==='function'?window.currentState():null;
    const req=s?.requests?.find(r=>r.id===requestId);
    if(!req?.dbId){ if(typeof toast==='function') toast('Database record not found for this request.'); return; }
    const {error}=await sb.rpc('reject_evacuee_registration',{p_evacuee_id:req.dbId});
    if(error){ if(typeof toast==='function') toast('Rejection failed: '+error.message); return; }
    if(typeof window.closeReviewModal==='function') window.closeReviewModal();
    if(typeof toast==='function') toast('Registration rejected.');
    await loadPendingIntoPrototype();
  }


  // =========================================================
  // Phase 4: Supabase-backed Accommodation Map / Assignment
  // This changes behavior only. Existing HTML/CSS/map design stays untouched.
  // =========================================================
  const mapDbCache={ spaces:new Map(), groups:new Map(), ready:false };

  function mapPage(){
    return (location.pathname.split('/').pop()||'').toLowerCase();
  }

  function normalizeDbSpaceStatus(row){
    const cap=Number(row?.capacity||0), occ=Number(row?.current_occupancy||0);
    if(row?.status==='inactive') return 'full';
    if(cap>0 && occ>=cap) return 'full';
    if(cap>0 && occ/cap>.70) return 'near';
    return 'available';
  }

  function syncSpaceIntoExistingMap(row){
    if(typeof HALLWAY_SPACES==='undefined' || !row?.space_code || !HALLWAY_SPACES[row.space_code]) return;
    const d=HALLWAY_SPACES[row.space_code];
    d.name=row.space_name || (row.space_code==='ML'?'Main Lobby':'Hallway '+row.space_code);
    d.cap=Number(row.capacity||0);
    d.occ=Number(row.current_occupancy||0);
    d.status=normalizeDbSpaceStatus(row);
    if(row.space_type) d.type=row.space_type==='hallway'?'Designated Corridor Space':row.space_type==='corridor'?'Designated Corridor Space':row.space_type==='other'?'Designated Accommodation Space':d.type;
  }

  async function loadAccommodationState(){
    const sb=readyClient();
    if(!sb) return false;
    const page=mapPage();
    if(!['shelter-room.html','user-room.html','admin-dashboard.html','evacuees.html'].includes(page)) return false;

    const {data,error}=await sb.from('accommodation_spaces')
      .select('space_id,space_code,space_name,space_type,capacity,current_occupancy,accessible,is_primary,status,shelter_id')
      .neq('status','inactive')
      .order('is_primary',{ascending:false})
      .order('space_code',{ascending:true});
    if(error){ console.warn('ScanSafe map sync:',error.message); return false; }

    mapDbCache.spaces.clear();
    for(const row of data||[]){
      mapDbCache.spaces.set(row.space_code,row);
      syncSpaceIntoExistingMap(row);
    }
    mapDbCache.ready=true;

    // Once database values are loaded, use DB occupancy as the source of truth.
    if(typeof window.__scanSafePrototypeGetDynamicOccupancy!=='function' && typeof window.getDynamicOccupancy==='function'){
      window.__scanSafePrototypeGetDynamicOccupancy=window.getDynamicOccupancy;
    }
    if(typeof window.__scanSafePrototypeGetSpaceStatus!=='function' && typeof window.getSpaceStatus==='function'){
      window.__scanSafePrototypeGetSpaceStatus=window.getSpaceStatus;
    }
    if(typeof window.__scanSafePrototypeGetAvailableSlots!=='function' && typeof window.getAvailableSlots==='function'){
      window.__scanSafePrototypeGetAvailableSlots=window.getAvailableSlots;
    }

    window.getDynamicOccupancy=function(id){
      const row=mapDbCache.spaces.get(id);
      if(row) return Number(row.current_occupancy||0);
      return window.__scanSafePrototypeGetDynamicOccupancy ? window.__scanSafePrototypeGetDynamicOccupancy(id) : 0;
    };
    window.getSpaceStatus=function(id){
      const row=mapDbCache.spaces.get(id);
      if(row) return normalizeDbSpaceStatus(row);
      return window.__scanSafePrototypeGetSpaceStatus ? window.__scanSafePrototypeGetSpaceStatus(id) : 'full';
    };
    window.getAvailableSlots=function(id){
      const row=mapDbCache.spaces.get(id);
      if(row) return Math.max(0,Number(row.capacity||0)-Number(row.current_occupancy||0));
      return window.__scanSafePrototypeGetAvailableSlots ? window.__scanSafePrototypeGetAvailableSlots(id) : 0;
    };

    if(typeof window.renderSpaces==='function') window.renderSpaces();
    if(typeof window.renderDashboardPrototype==='function') window.renderDashboardPrototype();
    return true;
  }

  async function loadEligibleDbGroups(){
    const sb=readyClient();
    if(!sb) return [];

    const [evRes,asgRes]=await Promise.all([
      sb.from('evacuees')
        .select('evacuee_id,group_id,registration_code,full_name,group_size,needs_summary,approval_status,barcodes(barcode_value,status)')
        .eq('approval_status','approved')
        .order('registered_at',{ascending:true}),
      sb.from('accommodation_assignments')
        .select('group_id')
        .eq('assignment_status','active')
    ]);
    if(evRes.error){ console.warn('Eligible evacuees:',evRes.error.message); return []; }
    if(asgRes.error){ console.warn('Assignments lookup:',asgRes.error.message); return []; }

    const assigned=new Set((asgRes.data||[]).map(x=>String(x.group_id)));
    mapDbCache.groups.clear();
    const groups=[];
    for(const row of evRes.data||[]){
      const qr=Array.isArray(row.barcodes)?row.barcodes.find(b=>b.status==='active'):row.barcodes;
      if(!row.group_id || assigned.has(String(row.group_id)) || !qr || qr.status!=='active') continue;
      const item={
        id:'DB:'+row.group_id,
        dbGroupId:Number(row.group_id),
        evacueeId:Number(row.evacuee_id),
        requestId:row.registration_code||'',
        name:row.full_name,
        group:Number(row.group_size||1),
        needs:row.needs_summary||'None'
      };
      mapDbCache.groups.set(String(row.group_id),item);
      groups.push(item);
    }
    return groups;
  }

  async function assignSpaceFromDatabase(spaceCode){
    const sb=readyClient();
    if(!sb){
      if(configured){ if(typeof toast==='function') toast('Backend unavailable. Accommodation data was not changed.'); return; }
      return window.__scanSafePrototypeAssignSpace ? window.__scanSafePrototypeAssignSpace(spaceCode) : undefined;
    }
    const modal=document.getElementById('assignmentModal');
    if(!modal) return;

    await loadAccommodationState();
    const row=mapDbCache.spaces.get(spaceCode);
    if(!row){ if(typeof toast==='function') toast('This map space is not configured in Supabase yet.'); return; }

    const groups=await loadEligibleDbGroups();
    const available=Math.max(0,Number(row.capacity||0)-Number(row.current_occupancy||0));
    const title=document.getElementById('assignmentSpaceTitle');
    const hint=document.getElementById('assignmentHint');
    const list=document.getElementById('eligibleGroupsList');
    if(title) title.textContent=`Assign to ${row.space_name || (spaceCode==='ML'?'Main Lobby':'Hallway '+spaceCode)}`;
    if(hint) hint.textContent=`${available} slot${available===1?'':'s'} available. Only approved evacuees with active QR codes and no current assignment can be assigned.`;
    if(list){
      list.innerHTML=groups.length?groups.map(g=>{
        const fits=Number(g.group)<=available;
        const safeName=typeof esc==='function'?esc(g.name):g.name;
        const safeNeeds=typeof esc==='function'?esc(g.needs||'No special needs'):(g.needs||'No special needs');
        return `<div class="eligible-group ${fits?'':'ineligible'}"><div><b>${safeName}</b><small>Group size: ${g.group} • ${safeNeeds}</small></div><button class="btn ${fits?'red':'soft'}" ${fits?'':'disabled'} onclick="confirmSpaceAssignment('${spaceCode}','${g.id}')">${fits?'Assign':'Insufficient Slots'}</button></div>`;
      }).join(''):`<div class="space-placeholder">No eligible groups right now. Approve a registration and issue its QR first, or verify that the group has no active assignment.</div>`;
    }
    modal.classList.remove('hidden');
  }

  async function confirmSpaceAssignmentDatabase(spaceCode,groupToken){
    const sb=readyClient();
    if(!sb){
      if(configured){ if(typeof toast==='function') toast('Backend unavailable. Assignment was not saved.'); return; }
      return window.__scanSafePrototypeConfirmSpaceAssignment ? window.__scanSafePrototypeConfirmSpaceAssignment(spaceCode,groupToken) : undefined;
    }
    if(!String(groupToken||'').startsWith('DB:')){
      return window.__scanSafePrototypeConfirmSpaceAssignment ? window.__scanSafePrototypeConfirmSpaceAssignment(spaceCode,groupToken) : undefined;
    }
    const groupId=Number(String(groupToken).slice(3));
    const group=mapDbCache.groups.get(String(groupId));
    if(!group){ if(typeof toast==='function') toast('Group record is no longer available. Refresh and try again.'); return; }

    const {data,error}=await sb.rpc('assign_group_to_space',{p_group_id:groupId,p_space_code:spaceCode});
    if(error){ if(typeof toast==='function') toast('Assignment failed: '+error.message); return; }

    if(typeof window.closeAssignmentModal==='function') window.closeAssignmentModal();
    if(typeof toast==='function') toast(`${group.name} assigned successfully.`);
    await loadAccommodationState();
    await loadEligibleDbGroups();
    if(typeof window.selectSpace==='function') window.selectSpace(spaceCode);
    if(typeof window.renderEvacs==='function') window.renderEvacs();
    return data;
  }

  async function loadCurrentEvacueeIntoPrototype(){
    const sb=readyClient();
    if(!sb || typeof window.currentState!=='function' || typeof window.saveScanSafeState!=='function') return;
    const session=window.ScanSafeDB.session;
    if(!session?.user) return;
    const profile=window.ScanSafeDB.profile || await getProfile(session.user.id);
    if(profile?.role!=='evacuee') return;

    const {data:ev,error}=await sb.from('evacuees')
      .select('evacuee_id,auth_user_id,group_id,registration_code,full_name,email,age,gender,group_size,needs_summary,approval_status,current_status')
      .eq('auth_user_id',session.user.id)
      .maybeSingle();
    if(error || !ev){ if(error) console.warn('Evacuee portal sync:',error.message); return; }

    const [{data:qr},{data:asg}]=await Promise.all([
      sb.from('barcodes').select('barcode_value,status').eq('evacuee_id',ev.evacuee_id).eq('status','active').maybeSingle(),
      sb.from('accommodation_assignments').select('space_id,assigned_at').eq('group_id',ev.group_id).eq('assignment_status','active').order('assigned_at',{ascending:false}).limit(1).maybeSingle()
    ]);

    let assignment=null;
    if(asg?.space_id){
      const {data:sp}=await sb.from('accommodation_spaces').select('space_code').eq('space_id',asg.space_id).maybeSingle();
      assignment=sp?.space_code||null;
    }

    const s=window.currentState();
    s.user={...s.user,
      requestId:ev.registration_code || s.user.requestId,
      id:'EV-'+String(ev.evacuee_id).padStart(3,'0'),
      dbId:ev.evacuee_id,
      dbGroupId:ev.group_id,
      name:ev.full_name,
      email:ev.email||session.user.email||'',
      age:Number(ev.age||0),
      gender:ev.gender||'',
      group:Number(ev.group_size||1),
      needs:ev.needs_summary||'None',
      registrationStatus:ev.approval_status==='approved'?'Approved':ev.approval_status==='rejected'?'Rejected':'Pending Approval',
      qrIssued:!!qr?.barcode_value,
      qrCode:qr?.barcode_value||null,
      assignment
    };
    window.saveScanSafeState(s);
    if(typeof window.renderUserPrototype==='function') window.renderUserPrototype();
  }

  document.addEventListener('DOMContentLoaded', async function(){
    // Capture the current prototype functions first, then override only behavior.
    window.__scanSafePrototypeLogin = window.loginDemo;
    window.__scanSafePrototypeRegister = window.registerPublicEvacuee;
    window.__scanSafePrototypeApprove = window.approveRegistration;
    window.__scanSafePrototypeReject = window.rejectRegistration;
    window.__scanSafePrototypeAssignSpace = window.assignSpace;
    window.__scanSafePrototypeConfirmSpaceAssignment = window.confirmSpaceAssignment;

    window.loginDemo = supabaseLogin;
    window.registerPublicEvacuee = submitPublicRegistration;
    window.logout = supabaseLogout;
    window.approveRegistration = approveByRequestId;
    window.rejectRegistration = rejectByRequestId;
    window.assignSpace = assignSpaceFromDatabase;
    window.confirmSpaceAssignment = confirmSpaceAssignmentDatabase;

    await bootstrapSession();
    if(!(await phase9AccessGuard())) return;
    await loadPendingIntoPrototype();
    await loadAccommodationState();
    await loadCurrentEvacueeIntoPrototype();
  });

  // =========================================================
  // Phase 5: Real QR Camera Scanner + Supabase Verification
  // =========================================================
  let scanSafeCamera = null;
  let scanSafeCameraActive = false;
  let scanSafeLastDecoded = null;

  function scanEsc(value){
    return String(value ?? '')
      .replaceAll('&','&amp;')
      .replaceAll('<','&lt;')
      .replaceAll('>','&gt;')
      .replaceAll('"','&quot;')
      .replaceAll("'",'&#039;');
  }

  function scannerPageActive(){
    return mapPage()==='barcode-scanner.html';
  }

  function scannerStartButton(){
    return document.querySelector('.scanner-page-grid .scan-panel .btn.red.full');
  }

  async function ensureQrScannerLibrary(){
    if(window.Html5Qrcode) return true;
    return await new Promise((resolve)=>{
      const existing=document.querySelector('script[data-scansafe-html5qr]');
      if(existing){
        existing.addEventListener('load',()=>resolve(!!window.Html5Qrcode),{once:true});
        existing.addEventListener('error',()=>resolve(false),{once:true});
        return;
      }
      const s=document.createElement('script');
      s.src='https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
      s.async=true;
      s.dataset.scansafeHtml5qr='1';
      s.onload=()=>resolve(!!window.Html5Qrcode);
      s.onerror=()=>resolve(false);
      document.head.appendChild(s);
    });
  }

  function setScannerButton(active){
    const btn=scannerStartButton();
    if(!btn) return;
    btn.textContent=active?'Stop Scanning':'Start Scanning';
  }

  async function stopScanSafeCamera(){
    if(scanSafeCamera && scanSafeCameraActive){
      try{ await scanSafeCamera.stop(); }catch(_){}
      try{ await scanSafeCamera.clear(); }catch(_){}
    }
    scanSafeCameraActive=false;
    scanSafeCamera=null;
    setScannerButton(false);
    const frame=document.querySelector('.scan-frame');
    if(frame && !frame.querySelector('#scanSafeQrReader')){
      frame.innerHTML='<div><div class="barcode" style="width:140px;height:70px"></div><h3 style="font-size:13px;margin:12px 0 4px">Point the camera at the QR code</h3><div class="muted" style="font-size:10px">Ensure the QR code is within the frame.</div></div>';
    }
  }

  function renderQrVerificationResult(data){
    const box=document.getElementById('scanResult');
    if(!box) return;
    box.classList.remove('hidden');

    const ok=!!data?.valid;
    const status=ok?'VERIFIED':String(data?.result||'INVALID').toUpperCase();
    const statusClass=ok?'green':'red';
    const color=ok?'#0a9637':'#b42318';
    const message=ok?'Evacuee record found and verified in ScanSafe.':scanEsc(data?.message||'QR code could not be verified.');
    const assignment=data?.space_name || data?.space_code || 'Not assigned';
    const now=data?.scanned_at ? new Date(data.scanned_at) : new Date();

    box.innerHTML=`
      <div class="verified-mark">${ok?'✓':'!'}</div>
      <h2 style="color:${color};text-align:center;margin:10px 0 4px">${scanEsc(status)}</h2>
      <p style="text-align:center;font-size:10px;color:#667085">${message}</p>
      <div class="detail-list">
        <div class="detail-line"><b>QR Code Value</b><span>${scanEsc(data?.qr_value||'')}</span></div>
        <div class="detail-line"><b>Name</b><span>${scanEsc(data?.full_name||'—')}</span></div>
        <div class="detail-line"><b>Group</b><span>${scanEsc(data?.group_size||'—')}</span></div>
        <div class="detail-line"><b>Space</b><span>${scanEsc(assignment)}</span></div>
        <div class="detail-line"><b>Status</b><span><span class="pill ${statusClass}">${scanEsc(status)}</span></span></div>
        <div class="detail-line"><b>Date & Time</b><span>${scanEsc(now.toLocaleString())}</span></div>
        <div class="detail-line"><b>Scanned By</b><span>${scanEsc(window.ScanSafeDB.profile?.full_name||'Authorized Staff')}</span></div>
      </div>`;

    const lastCard=document.querySelector('.scanner-page-grid > section:nth-child(2)');
    if(lastCard && ok){
      lastCard.innerHTML=`
        <div style="display:flex;justify-content:space-between">
          <h3 class="section-h">Last Scanned Evacuee</h3><span class="muted" style="font-size:10px">Just now</span>
        </div>
        <div style="display:flex;gap:16px;align-items:center">
          <div class="person-round"><svg class="icon xl"><use href="assets/icons.svg#user"></use></svg></div>
          <div>
            <h2 style="font-size:17px;margin:0">${scanEsc(data.full_name||'Evacuee')}</h2>
            <div class="muted" style="font-size:10px;line-height:1.7">
              Age: ${scanEsc(data.age ?? '—')} &nbsp; | &nbsp; ${scanEsc(data.gender||'—')}<br>
              Group: <b>${scanEsc(data.group_size||1)}</b><br>
              Space: <b>${scanEsc(data.space_code||'Not assigned')}</b><br>
              Status: <span class="pill green">Verified</span>
            </div>
          </div>
        </div>
        <div class="detail-list" style="margin-top:20px">
          <div class="detail-line"><b>Shelter</b><span>${scanEsc(data.shelter_name||'Main School Building')}</span></div>
          <div class="detail-line"><b>Accommodation Assignment</b><span>${scanEsc(assignment)}</span></div>
          <div class="detail-line"><b>Group Size</b><span>${scanEsc(data.group_size||1)} members</span></div>
        </div>
        <button class="btn out full" onclick="go('evacuees.html')">View Full Evacuee Details →</button>`;
    }
  }

  async function loadRecentScanHistory(){
    const sb=readyClient();
    if(!sb || !scannerPageActive()) return;
    const {data,error}=await sb.rpc('get_recent_scan_history',{p_limit:10});
    if(error){ console.warn('Scan history:',error.message); return; }
    const table=document.querySelector('.scanner-bottom section:first-child table.table');
    if(!table) return;
    const head=table.querySelector('tr')?.outerHTML || '<tr><th>#</th><th>Name</th><th>QR Code</th><th>Room</th><th>Time</th><th>Status</th></tr>';
    const rows=(data||[]).map((r,i)=>`
      <tr>
        <td>${i+1}</td>
        <td>${scanEsc(r.full_name||'Unknown')}</td>
        <td>${scanEsc(r.qr_value||'')}</td>
        <td>${scanEsc(r.space_code||'—')}</td>
        <td>${scanEsc(new Date(r.scanned_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}))}</td>
        <td><span class="pill ${r.scan_result==='verified'?'green':'yellow'}">${scanEsc(r.scan_result||'')}</span></td>
      </tr>`).join('');
    table.innerHTML=head+(rows||'<tr><td colspan="6" style="text-align:center">No scans yet.</td></tr>');
  }

  async function verifyScanSafeQr(qrValue){
    const sb=readyClient();
    const value=String(qrValue||'').trim();
    if(!value){ if(typeof toast==='function') toast('Enter or scan a QR code.'); return null; }
    if(!sb){
      if(typeof toast==='function') toast('Supabase is not configured yet.');
      return null;
    }

    const {data,error}=await sb.rpc('verify_qr_code',{p_qr_value:value});
    if(error){
      console.error('QR verification:',error);
      renderQrVerificationResult({valid:false,result:'invalid',qr_value:value,message:error.message});
      return null;
    }
    renderQrVerificationResult(data||{valid:false,result:'invalid',qr_value:value,message:'No record returned.'});
    await loadRecentScanHistory();
    return data;
  }

  async function scanNowDatabase(){
    if(!scannerPageActive()) return;
    if(scanSafeCameraActive){
      await stopScanSafeCamera();
      return;
    }

    const loaded=await ensureQrScannerLibrary();
    if(!loaded){
      if(typeof toast==='function') toast('QR scanner library could not load. Use manual QR search.');
      return;
    }

    const frame=document.querySelector('.scan-frame');
    if(!frame) return;
    frame.innerHTML='<div id="scanSafeQrReader" style="width:100%;height:100%"></div>';

    try{
      scanSafeCamera=new window.Html5Qrcode('scanSafeQrReader');
      scanSafeCameraActive=true;
      setScannerButton(true);

      await scanSafeCamera.start(
        {facingMode:'environment'},
        {fps:10, qrbox:{width:180,height:180}, aspectRatio:1.0},
        async(decodedText)=>{
          if(!decodedText || decodedText===scanSafeLastDecoded) return;
          scanSafeLastDecoded=decodedText;
          await stopScanSafeCamera();
          await verifyScanSafeQr(decodedText);
          setTimeout(()=>{ scanSafeLastDecoded=null; },1500);
        },
        ()=>{}
      );
    }catch(err){
      console.error(err);
      await stopScanSafeCamera();
      if(typeof toast==='function'){
        toast('Camera could not start. Allow camera permission and use HTTPS/localhost, or enter the QR manually.');
      }
    }
  }

  async function manualScanDatabase(){
    const value=document.getElementById('manualBarcode')?.value||'';
    await verifyScanSafeQr(value);
  }

  // =========================================================
  // Phase 6: Installable Evacuee PWA
  // Uses the existing user portal/pages and does not redesign them.
  // =========================================================
  function isEvacueeAppPage(){
    return [
      'user-portal.html','my-information.html','user-room.html',
      'user-notifications.html','user-messages.html','profile.html'
    ].includes(mapPage());
  }

  function setupEvacueePwa(){
    if(!isEvacueeAppPage()) return;

    if(!document.querySelector('link[rel="manifest"]')){
      const link=document.createElement('link');
      link.rel='manifest';
      link.href='manifest.webmanifest';
      document.head.appendChild(link);
    }

    if(!document.querySelector('meta[name="theme-color"]')){
      const meta=document.createElement('meta');
      meta.name='theme-color';
      meta.content='#8f0d0d';
      document.head.appendChild(meta);
    }

    if(!document.querySelector('link[rel="apple-touch-icon"]')){
      const apple=document.createElement('link');
      apple.rel='apple-touch-icon';
      apple.href='assets/app-icon-192.png';
      document.head.appendChild(apple);
    }

    if(!(window.Capacitor && typeof window.Capacitor.isNativePlatform==='function' && window.Capacitor.isNativePlatform()) && 'serviceWorker' in navigator){
      navigator.serviceWorker.register('service-worker.js',{scope:'./'})
        .catch(err=>console.warn('ScanSafe service worker:',err.message));
    }
  }

  // Run after the Phase 4 bootstrap handler so the overrides remain last.
  document.addEventListener('DOMContentLoaded', async function(){
    if(scannerPageActive()){
      window.scanNow=scanNowDatabase;
      window.manualScan=manualScanDatabase;
      await loadRecentScanHistory();
    }
    setupEvacueePwa();
  });


  // =========================================================
  // PHASE 7: Real Notifications, Announcements & Messages
  // =========================================================

  let phase78CurrentContactId = null;
  let phase78Contacts = [];
  let phase78NotifCache = [];
  let phase78RefreshTimer = null;
  let phase78RealtimeChannel = null;

  function p78Esc(v){
    return String(v ?? '')
      .replaceAll('&','&amp;')
      .replaceAll('<','&lt;')
      .replaceAll('>','&gt;')
      .replaceAll('"','&quot;')
      .replaceAll("'",'&#039;');
  }

  function p78Initials(name){
    const s=String(name||'User').trim().split(/\s+/).filter(Boolean);
    return (s.slice(0,2).map(x=>x[0]).join('') || 'U').toUpperCase();
  }

  function p78RelativeTime(value){
    if(!value) return '';
    const d=new Date(value), diff=Math.max(0,Date.now()-d.getTime());
    const min=Math.floor(diff/60000);
    if(min<1) return 'Just now';
    if(min<60) return `${min} min ago`;
    const hr=Math.floor(min/60);
    if(hr<24) return `${hr} hr${hr===1?'':'s'} ago`;
    const day=Math.floor(hr/24);
    if(day<7) return `${day} day${day===1?'':'s'} ago`;
    return d.toLocaleDateString();
  }

  function p78FormatDateTime(value){
    if(!value) return '';
    const d=new Date(value);
    return d.toLocaleString([],{
      year:'numeric',month:'short',day:'numeric',
      hour:'2-digit',minute:'2-digit'
    });
  }

  function p78IsStaffPage(){
    return ['messages.html','reports.html'].includes(mapPage());
  }

  async function p78SendAnnouncement(){
    const sb=readyClient();
    if(!sb){ if(typeof toast==='function') toast('Supabase is not configured.'); return; }

    const text=(document.getElementById('announcement')?.value||'').trim();
    if(!text){ if(typeof toast==='function') toast('Type an announcement first.'); return; }

    const target=document.getElementById('announceTo')?.value||'Evacuees';
    const audience=target==='Evacuees'?'evacuees':target==='All Shelter Staff'?'staff':'staff';

    let level='info', category='announcement', title='Shelter Announcement';
    const low=text.toLowerCase();
    if(low.includes('emergency') || low.includes('evacuat') || low.includes('warning')){
      level='urgent'; category='emergency'; title='Emergency Announcement';
    }else if(low.includes('weather') || low.includes('rain') || low.includes('storm')){
      level='warning'; category='announcement'; title='Weather Advisory';
    }

    const {data,error}=await sb.rpc('send_scansafe_announcement',{
      p_title:title,
      p_message:text,
      p_audience:audience,
      p_level:level,
      p_category:category
    });

    if(error){
      console.error('Announcement:',error);
      if(typeof toast==='function') toast(error.message);
      return;
    }

    const ta=document.getElementById('announcement');
    if(ta) ta.value='';
    if(typeof toast==='function') toast(`Announcement sent to ${target}.`);
    return data;
  }

  async function p78LoadUserNotifications(selectFirst=true){
    const sb=readyClient();
    if(!sb || mapPage()!=='user-notifications.html') return;

    const {data,error}=await sb.rpc('get_my_scansafe_notifications');
    if(error){ console.warn('Notifications:',error.message); return; }

    phase78NotifCache=Array.isArray(data)?data:[];
    const list=document.querySelector('.notify-grid > section:first-child');
    if(!list) return;

    list.querySelectorAll('.notif-item,.p78-empty-notif').forEach(el=>el.remove());

    const unread=phase78NotifCache.filter(n=>!n.is_read).length;
    const emergency=phase78NotifCache.filter(n=>n.category==='emergency' || n.notification_level==='urgent').length;
    const tabs=list.querySelectorAll('.tab');
    if(tabs[0]) tabs[0].textContent=`All (${phase78NotifCache.length})`;
    if(tabs[1]) tabs[1].textContent=`Unread (${unread})`;
    if(tabs[2]) tabs[2].textContent=`Emergency (${emergency})`;

    if(!phase78NotifCache.length){
      const empty=document.createElement('div');
      empty.className='p78-empty-notif muted';
      empty.style.cssText='padding:28px;text-align:center;font-size:11px';
      empty.textContent='No notifications yet.';
      list.appendChild(empty);
      const detail=document.getElementById('notifDetail');
      if(detail) detail.innerHTML='<div class="muted" style="text-align:center;padding:40px 10px">Notifications from ScanSafe will appear here.</div>';
      return;
    }

    phase78NotifCache.forEach((n,i)=>{
      const row=document.createElement('div');
      row.className='notif-item'+(i===0?' active':'');
      row.dataset.id=String(n.notification_id);
      const bg=(n.category==='emergency'||n.notification_level==='urgent')?'#d50000':
               n.category==='accommodation'?'#d50000':
               n.notification_level==='warning'?'#ff9f1c':'#1574a6';
      const icon=n.category==='accommodation'?'bed':
                 (n.category==='emergency'||n.notification_level==='urgent')?'alert':'info';
      row.innerHTML=`
        <div class="notice-ico" style="background:${bg}">
          <svg class="icon"><use href="assets/icons.svg#${icon}"></use></svg>
        </div>
        <div style="min-width:0;flex:1">
          <b>${p78Esc(n.title)}</b>
          <div class="muted" style="font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p78Esc(n.message)}</div>
        </div>
        <span class="muted" style="font-size:9px">${p78Esc(p78RelativeTime(n.created_at))} ›</span>`;
      if(!n.is_read) row.style.fontWeight='600';
      row.onclick=()=>p78SelectNotification(n.notification_id);
      list.appendChild(row);
    });

    p78RenderRecentAnnouncements();
    if(selectFirst) await p78SelectNotification(phase78NotifCache[0].notification_id);
  }

  function p78RenderRecentAnnouncements(){
    const grid=document.querySelector('.announcement-grid');
    if(!grid) return;
    const anns=phase78NotifCache.filter(n=>['announcement','emergency','accommodation','system'].includes(n.category)).slice(0,3);
    if(!anns.length){
      grid.innerHTML='<div class="download-card"><b>No announcements yet</b><p class="muted" style="font-size:9px">Official shelter announcements will appear here.</p></div>';
      return;
    }
    grid.innerHTML=anns.map(n=>`
      <div class="download-card">
        <b>${p78Esc(n.title)}</b>
        <div class="muted" style="font-size:9px">${p78Esc(p78FormatDateTime(n.created_at))}</div>
        <p style="font-size:9px">${p78Esc(n.message)}</p>
      </div>`).join('');
  }

  async function p78SelectNotification(id){
    const n=phase78NotifCache.find(x=>String(x.notification_id)===String(id));
    const detail=document.getElementById('notifDetail');
    if(!n || !detail) return;

    document.querySelectorAll('.notif-item').forEach(el=>el.classList.toggle('active',String(el.dataset.id)===String(id)));

    const urgent=n.category==='emergency'||n.notification_level==='urgent';
    const bg=urgent?'#d50000':n.category==='accommodation'?'#d50000':n.notification_level==='warning'?'#ff9f1c':'#1774b8';
    const icon=n.category==='accommodation'?'bed':urgent?'alert':'info';
    const type=(n.category||'announcement').replaceAll('_',' ');

    detail.innerHTML=`
      <div style="display:flex;align-items:center;gap:12px">
        <div class="notice-ico" style="background:${bg}">
          <svg class="icon"><use href="assets/icons.svg#${icon}"></use></svg>
        </div>
        <div>
          <h2 style="margin:0;font-size:20px">${p78Esc(n.title)}</h2>
          <div class="muted" style="font-size:10px;margin-top:4px">${p78Esc(p78FormatDateTime(n.created_at))} • ${p78Esc(type)}</div>
        </div>
      </div>
      <div class="notif-preview-img" style="margin-top:14px">
        <span class="pill ${urgent?'red':'yellow'}" style="width:max-content">${p78Esc((n.notification_level||'info').toUpperCase())}</span>
        <h2 style="font-size:24px;margin:10px 0 6px">${p78Esc(n.title)}</h2>
        <p style="margin:0;font-size:12px">${p78Esc(n.message)}</p>
      </div>
      <p style="font-size:11px;line-height:1.7">${p78Esc(n.message)}</p>
      <div style="background:#fff0f0;border:1px solid #ffdede;border-radius:8px;padding:12px">
        <b style="color:#d60000;font-size:11px">ScanSafe Reminder:</b>
        <p style="font-size:10px;line-height:1.7;margin:6px 0 0">Follow instructions from authorized shelter personnel and monitor ScanSafe for official updates.</p>
      </div>`;

    if(!n.is_read){
      const sb=readyClient();
      if(sb){
        await sb.rpc('mark_scansafe_notification_read',{p_notification_id:Number(n.notification_id)});
        n.is_read=true;
        const row=document.querySelector(`.notif-item[data-id="${CSS.escape(String(id))}"]`);
        if(row) row.style.fontWeight='';
        const tabs=document.querySelectorAll('.notify-grid .tab');
        if(tabs[1]) tabs[1].textContent=`Unread (${phase78NotifCache.filter(x=>!x.is_read).length})`;
      }
    }
  }

  function p78RenderThread(rows, mineId, targetName){
    const thread=document.getElementById('thread');
    if(!thread) return;
    const arr=Array.isArray(rows)?rows:[];
    if(!arr.length){
      thread.innerHTML='<div class="muted" style="text-align:center;padding:40px 15px;font-size:11px">No messages yet. Send the first message below.</div>';
      return;
    }
    thread.innerHTML=arr.map(m=>{
      const mine=String(m.sender_id)===String(mineId);
      const initials=mine?p78Initials(window.ScanSafeDB.profile?.full_name||'Me'):p78Initials(m.sender_name||targetName||'User');
      return mine
        ? `<div class="bubble-row mine"><div class="bubble">${p78Esc(m.message_text)}<div class="muted" style="font-size:8px;margin-top:6px">${p78Esc(p78FormatDateTime(m.sent_at))}</div></div><span class="avatar">${p78Esc(initials)}</span></div>`
        : `<div class="bubble-row"><span class="avatar">${p78Esc(initials)}</span><div class="bubble"><b>${p78Esc(m.sender_name||targetName||'User')}</b><br><br>${p78Esc(m.message_text)}<div class="muted" style="font-size:8px;margin-top:6px">${p78Esc(p78FormatDateTime(m.sent_at))}</div></div></div>`;
    }).join('');
    thread.scrollTop=thread.scrollHeight;
  }

  async function p78LoadUserMessages(){
    const sb=readyClient();
    if(!sb || mapPage()!=='user-messages.html') return;
    const {data,error}=await sb.rpc('get_my_admin_thread');
    if(error){ console.warn('User messages:',error.message); return; }

    const session=window.ScanSafeDB.session || (await sb.auth.getSession()).data.session;
    const mineId=session?.user?.id;
    p78RenderThread(data||[],mineId,'Admin');

    const folders=document.querySelector('.msg-col');
    if(folders){
      const recent=folders.querySelector('h3.section-h');
      if(recent){
        let items=recent.parentElement.querySelectorAll('.folder');
        items.forEach((el,i)=>{ if(i>0) el.remove(); });
        const last=(Array.isArray(data)&&data.length)?data[data.length-1]:null;
        const first=recent.parentElement.querySelector('.folder');
        if(first){
          first.classList.add('active');
          const subj=first.querySelector('.muted');
          if(subj) subj.textContent=last ? String(last.message_text).slice(0,42) : 'Message ScanSafe Admin';
          const count=first.querySelector('.count');
          if(count) count.remove();
        }
      }
    }
  }

  async function p78LoadStaffContacts(selectFirst=true){
    const sb=readyClient();
    if(!sb || mapPage()!=='messages.html') return;
    const {data,error}=await sb.rpc('get_staff_message_contacts');
    if(error){ console.warn('Contacts:',error.message); return; }
    phase78Contacts=Array.isArray(data)?data:[];

    const col=document.querySelector('.messages-grid .msg-col');
    if(!col) return;
    const h3=[...col.querySelectorAll('h3.section-h')].find(x=>x.textContent.includes('Recent Conversations'));
    if(!h3) return;

    let node=h3.nextElementSibling;
    while(node){
      const next=node.nextElementSibling;
      node.remove();
      node=next;
    }

    if(!phase78Contacts.length){
      const empty=document.createElement('div');
      empty.className='muted';
      empty.style.cssText='padding:18px 8px;text-align:center;font-size:10px';
      empty.textContent='No evacuee accounts yet.';
      col.appendChild(empty);
      const thread=document.getElementById('thread');
      if(thread) thread.innerHTML='<div class="muted" style="text-align:center;padding:40px 15px">No conversations yet.</div>';
      return;
    }

    phase78Contacts.forEach((c,i)=>{
      const row=document.createElement('div');
      row.className='folder'+((i===0 && !phase78CurrentContactId)||String(c.user_id)===String(phase78CurrentContactId)?' active':'');
      row.dataset.contactId=c.user_id;
      row.innerHTML=`
        <span class="folder-left">
          <span class="avatar">${p78Esc(p78Initials(c.full_name))}</span>
          <span><b>${p78Esc(c.full_name)}</b><br><span class="muted" style="font-size:9px">${p78Esc(c.last_message||'No messages yet')}</span></span>
        </span>
        ${Number(c.unread_count||0)>0?`<span class="count red">${Number(c.unread_count)}</span>`:''}`;
      row.onclick=()=>p78SelectStaffContact(c.user_id);
      col.appendChild(row);
    });

    const allCount=col.querySelector('.folder .count.red');
    if(allCount && !allCount.closest('[data-contact-id]')){
      allCount.textContent=String(phase78Contacts.reduce((a,c)=>a+Number(c.unread_count||0),0));
    }

    if(selectFirst){
      const target=phase78CurrentContactId || phase78Contacts[0]?.user_id;
      if(target) await p78SelectStaffContact(target);
    }
  }

  async function p78SelectStaffContact(userId){
    const sb=readyClient();
    if(!sb) return;
    phase78CurrentContactId=userId;
    document.querySelectorAll('[data-contact-id]').forEach(el=>el.classList.toggle('active',String(el.dataset.contactId)===String(userId)));

    const contact=phase78Contacts.find(c=>String(c.user_id)===String(userId));
    const {data,error}=await sb.rpc('get_staff_thread',{p_user_id:userId});
    if(error){ console.warn('Staff thread:',error.message); return; }

    const session=window.ScanSafeDB.session || (await sb.auth.getSession()).data.session;
    const mineId=session?.user?.id;
    p78RenderThread(data||[],mineId,contact?.full_name||'Evacuee');

    const head=document.querySelector('.conversation .conv-head');
    if(head && contact){
      head.innerHTML=`
        <div style="display:flex;gap:10px;align-items:center">
          <span class="avatar">${p78Esc(p78Initials(contact.full_name))}</span>
          <div><b>${p78Esc(contact.full_name)}</b><div class="muted" style="font-size:9px">Evacuee • ScanSafe Account</div></div>
        </div>
        <span class="muted" style="font-size:10px">${contact.last_at?p78Esc(p78RelativeTime(contact.last_at)):''}</span>`;
    }
  }

  async function p78SendMessage(){
    const sb=readyClient();
    const inp=document.getElementById('messageInput');
    const message=(inp?.value||'').trim();
    if(!message) return;
    if(!sb){ if(typeof toast==='function') toast('Supabase is not configured.'); return; }

    let result;
    if(mapPage()==='user-messages.html'){
      result=await sb.rpc('send_message_to_scansafe_admin',{p_message:message});
    }else if(mapPage()==='messages.html'){
      if(!phase78CurrentContactId){
        if(typeof toast==='function') toast('Select an evacuee conversation first.');
        return;
      }
      result=await sb.rpc('staff_send_scansafe_message',{p_receiver:phase78CurrentContactId,p_message:message});
    }else return;

    if(result.error){
      console.error('Send message:',result.error);
      if(typeof toast==='function') toast(result.error.message);
      return;
    }

    inp.value='';
    if(mapPage()==='user-messages.html') await p78LoadUserMessages();
    else{
      await p78SelectStaffContact(phase78CurrentContactId);
      await p78LoadStaffContacts(false);
    }
  }

  function p78SetupRealtime(){
    const sb=readyClient();
    if(!sb || phase78RealtimeChannel) return;

    const page=mapPage();
    if(!['user-notifications.html','user-messages.html','messages.html'].includes(page)) return;

    phase78RealtimeChannel=sb.channel('scansafe-phase7-'+Math.random().toString(36).slice(2))
      .on('postgres_changes',{event:'*',schema:'public',table:'notifications'},()=>{
        if(mapPage()==='user-notifications.html') p78LoadUserNotifications(false);
      })
      .on('postgres_changes',{event:'*',schema:'public',table:'messages'},()=>{
        if(mapPage()==='user-messages.html') p78LoadUserMessages();
        if(mapPage()==='messages.html') p78LoadStaffContacts(false).then(()=>{
          if(phase78CurrentContactId) p78SelectStaffContact(phase78CurrentContactId);
        });
      })
      .subscribe();

    phase78RefreshTimer=setInterval(()=>{
      if(mapPage()==='user-notifications.html') p78LoadUserNotifications(false);
      else if(mapPage()==='user-messages.html') p78LoadUserMessages();
      else if(mapPage()==='messages.html') p78LoadStaffContacts(false);
    },20000);
  }


  // =========================================================
  // PHASE 8: Real Reports & Analytics + CSV/PDF
  // =========================================================

  let phase78ReportSummary=null;

  function p78SetText(el,value){
    if(el) el.textContent=String(value ?? '');
  }

  async function p78LoadReports(){
    const sb=readyClient();
    if(!sb || mapPage()!=='reports.html') return;

    const {data,error}=await sb.rpc('get_scansafe_report_summary');
    if(error){ console.warn('Report summary:',error.message); return; }
    phase78ReportSummary=data||{};
    const s=phase78ReportSummary;

    const kpis=document.querySelectorAll('.report-kpis .kpi');
    if(kpis[0]){
      p78SetText(kpis[0].querySelector('.kpi-value'),s.total_evacuees||0);
      p78SetText(kpis[0].querySelector('.kpi-sub'),'Registered records');
    }
    if(kpis[1]){
      p78SetText(kpis[1].querySelector('.kpi-label'),'Approved Evacuees');
      p78SetText(kpis[1].querySelector('.kpi-value'),s.approved_evacuees||0);
      p78SetText(kpis[1].querySelector('.kpi-sub'),'Admin approved');
    }
    if(kpis[2]){
      p78SetText(kpis[2].querySelector('.kpi-value'),s.pending_evacuees||0);
      p78SetText(kpis[2].querySelector('.kpi-sub'),'Awaiting approval');
    }
    if(kpis[3]){
      p78SetText(kpis[3].querySelector('.kpi-value'),s.active_shelters||0);
      p78SetText(kpis[3].querySelector('.kpi-sub'),`of ${s.total_shelters||0} total`);
    }
    if(kpis[4]){
      p78SetText(kpis[4].querySelector('.kpi-label'),'Accommodation Spaces');
      p78SetText(kpis[4].querySelector('.kpi-value'),s.total_spaces||0);
      p78SetText(kpis[4].querySelector('.kpi-sub'),`${s.occupancy_percent||0}% occupied`);
    }

    const occCard=document.querySelectorAll('.report-charts .chart-card')[0];
    if(occCard){
      const donut=occCard.querySelector('.donut');
      if(donut){
        donut.style.background=`conic-gradient(#e20707 0 ${Number(s.occupancy_percent||0)}%, #dce3ea ${Number(s.occupancy_percent||0)}% 100%)`;
        const strong=donut.querySelector('strong');
        if(strong) strong.textContent=`${Number(s.occupancy_percent||0)}%`;
      }
      const vals=occCard.querySelectorAll('.legend-row b');
      if(vals[0]) vals[0].textContent=String(s.current_occupancy||0);
      if(vals[1]) vals[1].textContent=String(s.available_capacity||0);
      if(vals[2]) vals[2].textContent=String(s.total_capacity||0);
    }

    const utilCard=document.querySelectorAll('.report-charts .chart-card')[1];
    if(utilCard){
      const title=utilCard.querySelector('.section-h');
      if(title) title.textContent='Accommodation Space Utilization';
      const chart=utilCard.querySelector('.bar-chart');
      const rows=Array.isArray(s.shelters)?s.shelters:[];
      if(chart){
        if(!rows.length){
          chart.innerHTML='<div class="muted" style="padding:45px 10px">No shelter capacity data yet.</div>';
        }else{
          const maxCap=Math.max(1,...rows.map(x=>Number(x.capacity||0)));
          chart.innerHTML=rows.slice(0,4).map(x=>{
            const cap=Number(x.capacity||0), occ=Number(x.occupied||0);
            const totalH=Math.max(25,Math.round((cap/maxCap)*150));
            const occH=cap?Math.round(totalH*(occ/cap)):0;
            const avaH=Math.max(0,totalH-occH);
            return `<div>
              <div class="stack" style="height:${totalH}px">
                <div class="occ" style="height:${occH}px"></div>
                <div class="ava" style="height:${avaH}px"></div>
              </div>
              <div class="bar-label">${p78Esc(x.shelter_name||'Shelter')}<br>${occ}/${cap}</div>
            </div>`;
          }).join('');
        }
      }
    }

    const trendCard=document.querySelectorAll('.report-charts .chart-card')[2];
    if(trendCard && Array.isArray(s.verification_trend)){
      const trend=s.verification_trend;
      const svg=trendCard.querySelector('.line-chart svg');
      const labels=trendCard.querySelector('.xlabels');
      if(svg && trend.length){
        const max=Math.max(1,...trend.map(x=>Number(x.count||0)));
        const width=555, startX=20, baseY=145, graphH=120;
        const pts=trend.map((x,i)=>{
          const px=startX+(trend.length===1?0:(i/(trend.length-1))*width);
          const py=baseY-(Number(x.count||0)/max)*graphH;
          return `${px.toFixed(1)},${py.toFixed(1)}`;
        }).join(' ');
        svg.innerHTML=`<polyline points="${pts}" fill="none" stroke="#e20707" stroke-width="3"/>`;
      }
      if(labels) labels.innerHTML=trend.map(x=>`<span>${p78Esc(x.label||'')}</span>`).join('');
    }

    const demoCard=document.querySelector('.reports-bottom > section:first-child');
    if(demoCard && s.demographics){
      const vals=[
        Number(s.demographics.age_0_12||0),
        Number(s.demographics.age_13_18||0),
        Number(s.demographics.age_19_30||0),
        Number(s.demographics.age_31_50||0),
        Number(s.demographics.age_51_65||0),
        Number(s.demographics.age_66_plus||0)
      ];
      const max=Math.max(1,...vals);
      const bars=demoCard.querySelector('.mini-bars');
      if(bars) bars.innerHTML=vals.map(v=>`<div class="mini-bar" style="height:${Math.max(14,Math.round((v/max)*100))}px"><b>${v}</b></div>`).join('');
    }

    const groupCard=document.querySelectorAll('.reports-bottom > section')[1];
    if(groupCard && s.group_stats){
      const strong=groupCard.querySelector('.donut strong');
      if(strong) strong.textContent=String(s.total_evacuees||0);
      const rows=groupCard.querySelectorAll('.legend-row');
      const fam=Number(s.group_stats.family_members||0);
      const ind=Number(s.group_stats.individuals||0);
      const senior=Number(s.group_stats.senior_citizens||0);
      const total=Math.max(1,Number(s.total_evacuees||0));
      const data=[
        ['Family / Group Members',fam],
        ['Individuals',ind],
        ['Senior Citizens',senior]
      ];
      rows.forEach((r,i)=>{
        if(!data[i]) return;
        const span=r.querySelector('span'), b=r.querySelector('b');
        if(span) span.textContent=data[i][0];
        if(b) b.textContent=`${Math.round((data[i][1]/total)*100)}%`;
      });
    }

    await p78LoadRecentReports();

    const filters=document.querySelectorAll('.report-filter .select');
    if(filters[0]){
      const now=new Date(), from=new Date(Date.now()-6*86400000);
      filters[0].innerHTML=`<option>${from.toLocaleDateString()} – ${now.toLocaleDateString()}</option>`;
    }

    const genBtn=[...document.querySelectorAll('.report-filter button')].find(b=>b.textContent.includes('Generate Report'));
    if(genBtn) genBtn.onclick=p78GenerateReport;
  }

  async function p78LoadRecentReports(){
    const sb=readyClient();
    if(!sb || mapPage()!=='reports.html') return;
    const {data,error}=await sb.rpc('get_recent_report_exports',{p_limit:10});
    if(error){ console.warn('Recent reports:',error.message); return; }
    const rows=Array.isArray(data)?data:[];
    const table=[...document.querySelectorAll('table.table')].find(t=>t.textContent.includes('Report Name'));
    if(!table) return;
    const head='<tr><th>#</th><th>Report Name</th><th>Report Type</th><th>Date Range</th><th>Generated On</th><th>Generated By</th><th>Status</th><th>Actions</th></tr>';
    table.innerHTML=head+(rows.length?rows.map((r,i)=>`
      <tr>
        <td>${i+1}</td>
        <td>${p78Esc(r.report_name||r.report_type||'ScanSafe Report')}</td>
        <td>${p78Esc(r.report_type||'Summary')}</td>
        <td>${p78Esc(r.date_range||'Current Data')}</td>
        <td>${p78Esc(p78FormatDateTime(r.generated_at))}</td>
        <td>${p78Esc(r.generated_by_name||'Admin')}</td>
        <td><span class="pill green">Generated</span></td>
        <td><span style="color:#d00">${p78Esc((r.format||'').toUpperCase())}</span></td>
      </tr>`).join(''):'<tr><td colspan="8" style="text-align:center">No generated reports yet.</td></tr>');
  }

  async function p78LogReport(format,type='Evacuee / Occupancy Summary'){
    const sb=readyClient();
    if(!sb) return;
    await sb.rpc('log_scansafe_report_export',{
      p_report_type:type,
      p_format:String(format||'PDF').toLowerCase()
    });
  }

  async function p78GenerateReport(){
    await p78LoadReports();
    await p78LogReport('screen','Live Analytics');
    await p78LoadRecentReports();
    if(typeof toast==='function') toast('Report refreshed from Supabase.');
  }

  function p78CsvCell(v){
    const s=String(v??'');
    return `"${s.replaceAll('"','""')}"`;
  }

  async function p78ExportCsv(name='scansafe-evacuee-report.csv'){
    const sb=readyClient();
    if(!sb){ if(typeof toast==='function') toast('Supabase is not configured.'); return; }

    const {data,error}=await sb.rpc('get_scansafe_evacuee_report_rows');
    if(error){
      console.error('CSV:',error);
      if(typeof toast==='function') toast(error.message);
      return;
    }

    const rows=Array.isArray(data)?data:[];
    const headers=['Evacuee ID','Registration Code','Full Name','Age','Gender','Group Size','Approval','Current Status','Accommodation Space','Shelter','Registered At'];
    const lines=[headers.map(p78CsvCell).join(',')];
    rows.forEach(r=>lines.push([
      r.evacuee_id,r.registration_code,r.full_name,r.age,r.gender,r.group_size,
      r.approval_status,r.current_status,r.space_code,r.shelter_name,
      r.registered_at?p78FormatDateTime(r.registered_at):''
    ].map(p78CsvCell).join(',')));

    const blob=new Blob(['\ufeff'+lines.join('\r\n')],{type:'text/csv;charset=utf-8'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download=name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);

    await p78LogReport('csv','Evacuee List Report');
    await p78LoadRecentReports();
    if(typeof toast==='function') toast('CSV generated from live Supabase data.');
  }

  async function p78GeneratePdf(){
    await p78LogReport('pdf','Reports & Analytics');
    await p78LoadRecentReports();
    if(typeof toast==='function') toast('Opening print dialog — choose Save as PDF.');
    setTimeout(()=>window.print(),250);
  }

  async function p78PhaseBootstrap(){
    // Ensure the session/profile from the earlier phases has had time to load.
    await bootstrapSession();
    if(!(await phase9AccessGuard())) return;

    const page=mapPage();

    if(page==='messages.html'){
      window.sendMessage=p78SendMessage;
      window.sendAnnouncement=p78SendAnnouncement;
      await p78LoadStaffContacts(true);
      const compose=document.querySelector('.compose');
      if(compose) compose.onclick=()=>{
        const first=phase78Contacts[0];
        if(first) p78SelectStaffContact(first.user_id);
        else if(typeof toast==='function') toast('No evacuee account is available yet.');
      };
      p78SetupRealtime();
    }

    if(page==='user-messages.html'){
      window.sendMessage=p78SendMessage;
      await p78LoadUserMessages();
      p78SetupRealtime();
    }

    if(page==='user-notifications.html'){
      window.selectNotif=function(){};
      await p78LoadUserNotifications(true);
      p78SetupRealtime();
    }

    if(page==='reports.html'){
      window.exportCSV=p78ExportCsv;
      window.generatePDF=p78GeneratePdf;
      await p78LoadReports();
    }
  }

  document.addEventListener('DOMContentLoaded',()=>{
    setTimeout(()=>p78PhaseBootstrap().catch(err=>console.error('ScanSafe Phase 7/8:',err)),150);
  });

  window.addEventListener('beforeunload',()=>{
    if(phase78RefreshTimer) clearInterval(phase78RefreshTimer);
    const sb=readyClient();
    if(sb && phase78RealtimeChannel) sb.removeChannel(phase78RealtimeChannel);
  });


  // =========================================================
  // PHASE 9: Security guards, session hardening & integrity tools
  // =========================================================

  const phase9AdminOnlyPages=new Set(['user-management.html','settings.html']);
  const phase9StaffPages=new Set([
    'admin-dashboard.html','evacuees.html','shelter-room.html','barcode-scanner.html',
    'messages.html','reports.html','user-management.html','settings.html'
  ]);
  const phase9EvacueePages=new Set([
    'user-portal.html','my-information.html','user-room.html',
    'user-notifications.html','user-messages.html','profile.html'
  ]);

  let phase9AuthListenerReady=false;
  let phase9GuardRunning=false;

  function phase9BackendUnavailable(){
    if(typeof toast==='function') toast('ScanSafe backend is unavailable. No changes were saved.');
  }

  function phase9Redirect(target){
    if(!target) return false;
    const current=mapPage();
    if(current===target) return false;
    location.replace(target);
    return false;
  }

  async function phase9AccessGuard(){
    if(!configured) return true; // local prototype mode only
    if(phase9GuardRunning) return true;
    phase9GuardRunning=true;
    try{
      const sb=readyClient();
      if(!sb){ phase9BackendUnavailable(); return false; }

      const page=mapPage() || 'index.html';
      const protectedPage=phase9StaffPages.has(page) || phase9EvacueePages.has(page);
      if(!protectedPage) return true;

      let session=window.ScanSafeDB.session;
      if(!session){
        const result=await sb.auth.getSession();
        session=result?.data?.session||null;
        window.ScanSafeDB.session=session;
      }
      if(!session?.user) return phase9Redirect('index.html');

      let profile=window.ScanSafeDB.profile;
      if(!profile || String(profile.id)!==String(session.user.id)){
        profile=await getProfile(session.user.id);
      }
      if(!profile){
        await sb.auth.signOut();
        return phase9Redirect('index.html');
      }

      const role=profile.role;
      if(phase9EvacueePages.has(page) && role!=='evacuee'){
        return phase9Redirect('admin-dashboard.html');
      }
      if(phase9StaffPages.has(page) && !['admin','staff'].includes(role)){
        return phase9Redirect('user-portal.html');
      }
      if(phase9AdminOnlyPages.has(page) && role!=='admin'){
        if(typeof toast==='function') toast('Administrator access is required for this page.');
        return phase9Redirect('admin-dashboard.html');
      }
      return true;
    }finally{
      phase9GuardRunning=false;
    }
  }

  function phase9InstallAuthListener(){
    if(phase9AuthListenerReady || !configured) return;
    const sb=readyClient();
    if(!sb) return;
    phase9AuthListenerReady=true;
    sb.auth.onAuthStateChange(async(event,session)=>{
      window.ScanSafeDB.session=session||null;
      if(event==='SIGNED_OUT'){
        window.ScanSafeDB.profile=null;
        localStorage.removeItem('scanSafeLoginRole');
        localStorage.removeItem('scansafePrototypeStateV4');
        sessionStorage.removeItem('scansafePrototypeStateV4');
        const page=mapPage();
        if(phase9StaffPages.has(page)||phase9EvacueePages.has(page)) location.replace('index.html');
      }else if(session?.user){
        await getProfile(session.user.id);
      }
    });
  }

  async function phase9HealthCheck(){
    const sb=readyClient();
    if(!sb) throw new Error('Supabase is not configured.');
    const {data,error}=await sb.rpc('scansafe_security_health_check');
    if(error) throw error;
    console.group('ScanSafe Phase 9 Health Check');
    console.table(data||{});
    console.groupEnd();
    return data;
  }

  async function phase9ReconcileOccupancy(){
    const sb=readyClient();
    if(!sb) throw new Error('Supabase is not configured.');
    const {data,error}=await sb.rpc('reconcile_scansafe_occupancy');
    if(error) throw error;
    await loadAccommodationState();
    return data;
  }

  window.ScanSafePhase9={
    healthCheck:phase9HealthCheck,
    reconcileOccupancy:phase9ReconcileOccupancy,
    guard:phase9AccessGuard
  };

  document.addEventListener('DOMContentLoaded',()=>{
    phase9InstallAuthListener();
    // Remove any real synced record cache left by an older logout/session.
    if(configured && !window.ScanSafeDB.session){
      const role=localStorage.getItem('scanSafeLoginRole');
      if(!role) localStorage.removeItem('scansafePrototypeStateV4');
    }
  });


  // =========================================================
  // PHASE 10: Production diagnostics / deployment verification
  // No visual redesign. Console/API helper only.
  // =========================================================
  async function phase10ProductionCheck(){
    const result={
      timestamp:new Date().toISOString(),
      protocol:location.protocol,
      secure_context:window.isSecureContext===true,
      online:navigator.onLine,
      supabase_configured:configured,
      service_worker_supported:'serviceWorker' in navigator,
      native_app:!!(window.Capacitor && typeof window.Capacitor.isNativePlatform==='function' && window.Capacitor.isNativePlatform()),
      current_page:mapPage() || 'index.html',
      authenticated:false,
      role:null,
      backend_session_ok:false
    };

    try{
      const sb=readyClient();
      if(sb){
        const {data,error}=await sb.auth.getSession();
        result.backend_session_ok=!error;
        result.authenticated=!!data?.session?.user;
        if(data?.session?.user){
          const p=window.ScanSafeDB.profile || await getProfile(data.session.user.id);
          result.role=p?.role || null;
        }
      }
    }catch(err){
      result.backend_session_ok=false;
      result.error=err?.message || String(err);
    }

    console.group('ScanSafe Production Check');
    console.table(result);
    console.groupEnd();
    return result;
  }

  window.ScanSafeProduction={
    check:phase10ProductionCheck,
    version:'phase10-production'
  };


  // =========================================================
  // GBEAA — Greedy-Based Evacuee Accommodation Algorithm
  // UI integration only; the actual decision is made server-side.
  // Existing HTML/CSS/map design is preserved.
  // =========================================================
  const gbeaaRecommendationCache=new Map();

  function gbeaaEscape(v){
    if(typeof esc==='function') return esc(v);
    return String(v??'')
      .replaceAll('&','&amp;')
      .replaceAll('<','&lt;')
      .replaceAll('>','&gt;')
      .replaceAll('"','&quot;')
      .replaceAll("'",'&#039;');
  }

  function gbeaaSpaceName(code){
    const row=mapDbCache.spaces.get(String(code||''));
    if(row) return row.space_name || row.space_code;
    if(window.__scanSafeOriginalFormatSpaceName){
      return window.__scanSafeOriginalFormatSpaceName(code);
    }
    return String(code||'Accommodation Space');
  }

  async function gbeaaGetRecommendation(groupId,force=false){
    const key=String(groupId);
    if(!force && gbeaaRecommendationCache.has(key)){
      return gbeaaRecommendationCache.get(key);
    }

    const sb=readyClient();
    if(!sb) return null;

    const {data,error}=await sb.rpc('gbeaa_recommend_space',{
      p_group_id:Number(groupId)
    });

    const result=error
      ? {recommended:false,reason:error.message,group_id:Number(groupId)}
      : data;

    gbeaaRecommendationCache.set(key,result);
    return result;
  }

  function gbeaaRecommendationText(rec){
    if(!rec) return 'GBEAA recommendation unavailable.';
    if(!rec.recommended) return `GBEAA: ${rec.reason || 'No valid accommodation found.'}`;

    const tier=rec.overflow_used?'Overflow fallback':'Primary';
    const access=rec.requires_accessibility?' • accessibility required':'';
    return `GBEAA: ${rec.space_name} • ${tier} • ${rec.remaining_after} slot${Number(rec.remaining_after)===1?'':'s'} remain after assignment${access}`;
  }

  async function assignSpaceFromDatabaseWithGbeaa(spaceCode){
    const sb=readyClient();
    if(!sb){
      return assignSpaceFromDatabase(spaceCode);
    }

    const modal=document.getElementById('assignmentModal');
    if(!modal) return;

    await loadAccommodationState();
    const selected=mapDbCache.spaces.get(spaceCode);
    if(!selected){
      if(typeof toast==='function') toast('This map space is not configured in Supabase yet.');
      return;
    }

    const groups=await loadEligibleDbGroups();
    gbeaaRecommendationCache.clear();

    const recEntries=await Promise.all(
      groups.map(async g=>[
        String(g.dbGroupId),
        await gbeaaGetRecommendation(g.dbGroupId,true)
      ])
    );
    recEntries.forEach(([id,rec])=>gbeaaRecommendationCache.set(id,rec));

    const available=Math.max(
      0,
      Number(selected.capacity||0)-Number(selected.current_occupancy||0)
    );

    const title=document.getElementById('assignmentSpaceTitle');
    const hint=document.getElementById('assignmentHint');
    const list=document.getElementById('eligibleGroupsList');

    if(title) title.textContent='GBEAA Accommodation Assignment';

    if(hint){
      hint.textContent=
        `Selected map space: ${selected.space_name||spaceCode} (${available} slots available). `+
        `GBEAA evaluates live capacity, group size, accessibility, primary hallway priority, and greedy best-fit before assignment.`;
    }

    if(list){
      list.innerHTML=groups.length
        ? groups.map(g=>{
            const rec=gbeaaRecommendationCache.get(String(g.dbGroupId));
            const manualFits=Number(g.group)<=available;
            const safeName=gbeaaEscape(g.name);
            const safeNeeds=gbeaaEscape(g.needs||'No special needs');
            const safeRec=gbeaaEscape(gbeaaRecommendationText(rec));
            const hasRec=!!rec?.recommended;

            return `
              <div class="eligible-group ${hasRec?'':'ineligible'}">
                <div>
                  <b>${safeName}</b>
                  <small>Group size: ${Number(g.group||1)} • ${safeNeeds}</small>
                  <small style="display:block;margin-top:4px"><b>${safeRec}</b></small>
                </div>
                <div class="review-actions">
                  <button
                    class="btn out"
                    ${manualFits?'':'disabled'}
                    onclick="confirmSpaceAssignment('${spaceCode}','${g.id}')">
                    ${manualFits?'Manual Assign Here':'Insufficient Here'}
                  </button>
                  <button
                    class="btn ${hasRec?'red':'soft'}"
                    ${hasRec?'':'disabled'}
                    onclick="confirmGbeaaAssignment('${g.id}')">
                    ${hasRec?'Assign via GBEAA':'No Valid GBEAA Space'}
                  </button>
                </div>
              </div>`;
          }).join('')
        : `<div class="space-placeholder">
             No eligible groups right now. Approve a registration, issue its QR,
             and confirm that the group has no active assignment.
           </div>`;
    }

    modal.classList.remove('hidden');
  }

  async function confirmGbeaaAssignmentDatabase(groupToken){
    const sb=readyClient();
    if(!sb){
      if(typeof toast==='function') toast('Backend unavailable. GBEAA assignment was not saved.');
      return;
    }

    if(!String(groupToken||'').startsWith('DB:')){
      if(typeof toast==='function') toast('GBEAA requires a Supabase-backed evacuee group.');
      return;
    }

    const groupId=Number(String(groupToken).slice(3));
    const group=mapDbCache.groups.get(String(groupId));

    if(!group){
      if(typeof toast==='function') toast('Group record is no longer available. Refresh and try again.');
      return;
    }

    const {data,error}=await sb.rpc('assign_group_gbeaa',{
      p_group_id:groupId
    });

    if(error){
      if(typeof toast==='function') toast('GBEAA assignment failed: '+error.message);
      return;
    }

    gbeaaRecommendationCache.clear();

    if(typeof window.closeAssignmentModal==='function'){
      window.closeAssignmentModal();
    }

    const overflow=data?.overflow_used?' (overflow fallback)':'';
    if(typeof toast==='function'){
      toast(
        `GBEAA assigned ${group.name} to ${data?.space_name||data?.space_code}`+
        `${overflow}. ${Number(data?.remaining_after||0)} slot(s) remain.`
      );
    }

    await loadAccommodationState();
    await loadEligibleDbGroups();

    const assignedCode=String(data?.space_code||'');
    if(
      assignedCode &&
      typeof HALLWAY_SPACES!=='undefined' &&
      HALLWAY_SPACES[assignedCode] &&
      typeof window.selectSpace==='function'
    ){
      window.selectSpace(assignedCode);
    }

    if(typeof window.renderEvacs==='function') window.renderEvacs();
    return data;
  }

  function installGbeaaUserSpaceCompatibility(){
    if(!window.__scanSafeOriginalFormatSpaceName && typeof window.formatSpaceName==='function'){
      window.__scanSafeOriginalFormatSpaceName=window.formatSpaceName;
    }

    window.formatSpaceName=function(id){
      return gbeaaSpaceName(id);
    };

    if(!window.__scanSafeOriginalRenderUserAssignmentSummary && typeof window.renderUserAssignmentSummary==='function'){
      window.__scanSafeOriginalRenderUserAssignmentSummary=window.renderUserAssignmentSummary;
    }

    window.renderUserAssignmentSummary=function(){
      const box=document.getElementById('userAssignmentSummary');
      if(!box || typeof window.currentState!=='function'){
        return window.__scanSafeOriginalRenderUserAssignmentSummary
          ? window.__scanSafeOriginalRenderUserAssignmentSummary()
          : undefined;
      }

      const u=window.currentState().user;
      if(!u.assignment){
        return window.__scanSafeOriginalRenderUserAssignmentSummary
          ? window.__scanSafeOriginalRenderUserAssignmentSummary()
          : undefined;
      }

      const row=mapDbCache.spaces.get(String(u.assignment));
      if(!row){
        return window.__scanSafeOriginalRenderUserAssignmentSummary
          ? window.__scanSafeOriginalRenderUserAssignmentSummary()
          : undefined;
      }

      const occ=Number(row.current_occupancy||0);
      const cap=Number(row.capacity||0);
      const avail=Math.max(0,cap-occ);
      const type=row.space_type==='overflow_room'
        ? 'Overflow Room'
        : 'Primary Accommodation';

      box.innerHTML=`
        <div class="assignment-state-grid">
          <div class="assignment-state-cell">
            <small>Your Assigned Space</small>
            <strong>${gbeaaEscape(row.space_name||row.space_code)}</strong>
            <span style="font-size:9px;color:#d00">Main School Building • ${gbeaaEscape(type)}</span>
          </div>
          <div class="assignment-state-cell"><small>Capacity</small><strong>${cap}</strong></div>
          <div class="assignment-state-cell"><small>Occupied</small><strong>${occ}</strong></div>
          <div class="assignment-state-cell"><small>Available</small><strong>${avail}</strong></div>
        </div>`;

      if(
        typeof HALLWAY_SPACES!=='undefined' &&
        HALLWAY_SPACES[String(u.assignment)] &&
        typeof window.selectSpace==='function'
      ){
        setTimeout(()=>window.selectSpace(String(u.assignment)),0);
      }
    };
  }

  window.confirmGbeaaAssignment=confirmGbeaaAssignmentDatabase;
  window.ScanSafeGBEAA={
    recommend:async groupId=>gbeaaGetRecommendation(groupId,true),
    assign:async groupId=>confirmGbeaaAssignmentDatabase('DB:'+groupId),
    refresh:async()=>{
      gbeaaRecommendationCache.clear();
      await loadAccommodationState();
      return true;
    }
  };

  document.addEventListener('DOMContentLoaded',async function(){
    await bootstrapSession();
    installGbeaaUserSpaceCompatibility();

    // Make all active accommodation rows available to the name/details cache,
    // including overflow rooms that are intentionally not clickable on the map.
    await loadAccommodationState();

    // Replace only the behavior of the existing assignment button.
    window.assignSpace=assignSpaceFromDatabaseWithGbeaa;
    window.confirmGbeaaAssignment=confirmGbeaaAssignmentDatabase;

    // Re-render an evacuee page once DB space metadata is available.
    if(
      ['user-portal.html','user-room.html','profile.html'].includes(mapPage())
      && typeof window.renderUserPrototype==='function'
    ){
      await loadCurrentEvacueeIntoPrototype();
    }
  });

})();
