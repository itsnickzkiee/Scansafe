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

  window.ScanSafeEvacueeAuth = {
    project: function(){
      return {
        configured,
        projectUrl:cfg.url||null
      };
    }
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

  function registrationResult(message,isError=false){
    const box=document.getElementById('registrationResult');
    if(box){
      box.hidden=!message;
      box.textContent=message||'';
      box.className='registration-result'+(isError?' is-error':'');
      box.setAttribute('role',isError?'alert':'status');
    }
    if(message && typeof window.toast==='function') window.toast(message);
  }

  let publicRegistrationInFlight=false;
  let publicRegistrationCompletionMode=false;

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

    // Repair path for evacuee accounts created before the automatic
    // auth->profile trigger was installed.
    try{
      const repair=await sb.rpc('repair_my_evacuee_profile');
      if(!repair.error){
        const repaired=normalizeProfileRpcResult(repair.data);
        if(repaired && String(repaired.id)===String(userId)){
          window.ScanSafeDB.profile=repaired;
          return repaired;
        }
      }else{
        console.warn('ScanSafe profile repair:', repair.error.message);
      }
    }catch(err){
      console.warn('ScanSafe profile repair exception:', err);
    }

    // Compatibility fallback.
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

  window.ScanSafeEvacueeAccountCheck = async function(){
    const sb=readyClient();
    if(!sb) return {configured:false,projectUrl:cfg.url||null};

    const {data:sessionData,error:sessionError}=await sb.auth.getSession();
    const session=sessionData?.session||null;

    if(!session?.user){
      return {
        configured,
        projectUrl:cfg.url||null,
        authenticated:false,
        sessionError:sessionError?.message||null
      };
    }

    const [profileResult, evacResult]=await Promise.all([
      sb.rpc('get_my_profile'),
      sb.from('evacuees')
        .select('evacuee_id,registration_code,approval_status,current_status,auth_user_id,email')
        .eq('auth_user_id',session.user.id)
        .maybeSingle()
    ]);

    return {
      configured,
      projectUrl:cfg.url||null,
      authenticated:true,
      authUserId:session.user.id,
      email:session.user.email,
      profile:normalizeProfileRpcResult(profileResult.data),
      profileError:profileResult.error?.message||null,
      evacuee:evacResult.data||null,
      evacueeError:evacResult.error?.message||null,
      sessionError:sessionError?.message||null
    };
  };

  function registrationRecoveryRpcMissing(error){
    return ['PGRST202','42883'].includes(String(error?.code||'')) || /could not find.*function|function.*does not exist/i.test(String(error?.message||''));
  }
  async function repairMyRegistrationLink(sb=readyClient()){
    if(!sb) throw new Error('ScanSafe backend is unavailable.');
    const {data,error}=await sb.rpc('scansafe_repair_my_registration_link');
    if(error){
      if(registrationRecoveryRpcMissing(error)) throw new Error('Registration recovery is not installed yet. Run SUPABASE_AUTH_REGISTRATION_LINK_RECOVERY.sql in Supabase.');
      throw error;
    }
    return data||{status:'completion_required',needs_registration_id:true};
  }
  function rememberRegistrationCompletion(user,profile){
    sessionStorage.setItem('scansafeRegistrationCompletion','1');
    sessionStorage.setItem('scansafeRegistrationCompletionEmail',user?.email||'');
    sessionStorage.setItem('scansafeRegistrationCompletionName',profile?.full_name||user?.user_metadata?.full_name||'');
  }
  function clearRegistrationCompletion(){
    sessionStorage.removeItem('scansafeRegistrationCompletion');
    sessionStorage.removeItem('scansafeRegistrationCompletionEmail');
    sessionStorage.removeItem('scansafeRegistrationCompletionName');
  }
  function goToRegistrationCompletion(){
    const user=window.ScanSafeDB.session?.user,profile=window.ScanSafeDB.profile;
    if(user) rememberRegistrationCompletion(user,profile);
    location.href='index.html?completeRegistration=1';
  }
  window.ScanSafeCompleteRegistration=goToRegistrationCompletion;
  async function configureRegistrationCompletionMode(){
    if(mapPage()!=='index.html') return false;
    const params=new URLSearchParams(location.search);
    const requested=params.get('completeRegistration')==='1'||sessionStorage.getItem('scansafeRegistrationCompletion')==='1';
    if(!requested) return false;
    const sb=readyClient(); if(!sb) return false;
    const {data,error}=await sb.auth.getSession(); if(error||!data?.session?.user) return false;
    const session=data.session; window.ScanSafeDB.session=session;
    const profile=await getProfile(session.user.id); if(profile?.role!=='evacuee') return false;
    let recovery=null;
    try{ recovery=await repairMyRegistrationLink(sb); }
    catch(error){ uiError(error.message||'Registration recovery could not be checked.'); return false; }
    if(recovery?.status!=='completion_required'&&!recovery?.needs_registration_id){ clearRegistrationCompletion(); location.replace('user-portal.html'); return true; }
    publicRegistrationCompletionMode=true; rememberRegistrationCompletion(session.user,profile);
    if(typeof window.openPublicRegistration==='function') window.openPublicRegistration();
    const form=document.querySelector('.public-register'); if(form) form.dataset.registrationMode='complete';
    const title=document.querySelector('.public-register .dialog-head h2'); if(title) title.textContent=recovery?.needs_registration_id&&recovery?.status!=='completion_required'?'Complete Registration ID':'Complete Registration';
    const intro=document.querySelector('.public-register > p.muted'); if(intro) intro.textContent='Your ScanSafe login account is active, but the evacuee registration is incomplete. Complete the details below; admin approval will still control Barcode issuance.';
    const name=document.getElementById('publicName'),email=document.getElementById('publicEmail');
    if(name&&!name.value) name.value=profile.full_name||session.user.user_metadata?.full_name||sessionStorage.getItem('scansafeRegistrationCompletionName')||'';
    if(email){ email.value=session.user.email||sessionStorage.getItem('scansafeRegistrationCompletionEmail')||''; email.readOnly=true; }
    for(const id of ['publicPassword','publicConfirmPassword']){ const input=document.getElementById(id); if(input){ input.required=false; input.removeAttribute('minlength'); const field=input.closest('.field'); if(field) field.hidden=true; } }
    if(recovery?.status!=='completion_required'){
      try{ const account=await sb.rpc('get_my_scansafe_account'),ev=account?.data?.evacuee; const set=(id,value)=>{const el=document.getElementById(id);if(el&&value!=null&&value!=='')el.value=value;};
        if(ev){ set('publicName',ev.full_name);set('publicAge',ev.age);set('publicGender',ev.gender);set('publicGroup',ev.group_size);set('publicNeeds',ev.needs_summary||'None');set('publicAddress',ev.address);set('publicBarangay',ev.barangay);set('publicCity',ev.city);set('publicValidIdType',ev.valid_id_type);set('publicValidIdNumber',ev.valid_id_number); }
      }catch(error){ console.warn('ScanSafe registration prefill:',error.message); }
    }
    const button=document.getElementById('publicRegistrationSubmit'); if(button) button.textContent='Complete Registration';
    registrationResult('Your login is active. Complete the missing registration so the admin can review it.');
    return true;
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
      uiError('ScanSafe backend is unavailable. Please reload and try again.');
      return;
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
    if(error || !data?.user){
      const code=String(error?.code||'');
      console.warn('ScanSafe Auth sign-in failed:', {
        code,
        status:error?.status||null,
        message:error?.message||null,
        email:username,
        projectUrl:cfg.url
      });

      if(code==='email_not_confirmed'){
        uiError('This account was created under an older authentication setup. ScanSafe no longer uses email confirmation. Please register a new evacuee account or have the administrator reset this test account.');
      }else if(code==='invalid_credentials'){
        uiError('Invalid email or password. Use the exact email and password created during registration.');
      }else if(code==='email_provider_disabled' || code==='provider_disabled'){
        uiError('Email/password login is currently disabled in Supabase Authentication settings.');
      }else if(Number(error?.status)===429){
        uiError('Too many login attempts. Please try again later.');
      }else{
        uiError(error?.message || 'Unable to sign in.');
      }
      return;
    }

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

    if(profile.role==='evacuee'){
      try{
        const recovery=await repairMyRegistrationLink(sb);
        if(recovery?.status==='completion_required'||recovery?.needs_registration_id){
          rememberRegistrationCompletion(data.user,profile);
          location.href='index.html?completeRegistration=1';
          return;
        }
      }catch(linkError){
        uiError(linkError.message||'Login succeeded, but ScanSafe could not verify the registration link.');
        return;
      }
    }
    localStorage.setItem('scanSafeLoginRole', profile.role==='evacuee'?'user':profile.role);
    if(typeof window.showScanSafeLoginSplash==='function'){
      window.showScanSafeLoginSplash(profile.role==='evacuee'?'user-portal.html':'admin-dashboard.html');
    }else{
      location.href=profile.role==='evacuee'?'user-portal.html':'admin-dashboard.html';
    }
  }

  async function supabaseLogout(){
    window.ScanSafeOperations?.reset();
    window.ScanSafeAppPromo?.reset();
    window.ScanSafeMedia?.reset();
    window.ScanSafeNotifications?.reset();
    const sb=readyClient();
    if(sb) await sb.auth.signOut();
    localStorage.removeItem('scanSafeLoginRole');
    localStorage.removeItem('scansafePrototypeStateV4');
    localStorage.removeItem('scansafeLiveStateV1');
    sessionStorage.removeItem('scansafePrototypeStateV4');
    sessionStorage.removeItem('scanSafePhase9Guard');
    location.href='index.html';
  }

  async function submitPublicRegistration(event){
    event.preventDefault();
    if(publicRegistrationInFlight) return;
    const sb=readyClient();
    if(!sb){
      if(typeof toast==='function') toast('ScanSafe backend is unavailable. Registration was not submitted.');
      return;
    }

    const sessionResult=await sb.auth.getSession();
    const existingSession=sessionResult?.data?.session||null;
    const completingExisting=!!(publicRegistrationCompletionMode&&existingSession?.user?.id);
    const password=document.getElementById('publicPassword')?.value||'';
    const confirmPassword=document.getElementById('publicConfirmPassword')?.value||'';
    if(!completingExisting){
      if(password.length<8){ if(typeof toast==='function') toast('Password must be at least 8 characters.'); return; }
      if(password!==confirmPassword){ if(typeof toast==='function') toast('Password and confirm password do not match.'); return; }
    }

    const file=document.getElementById('publicValidIdImage')?.files?.[0]||null;
    if(!file){registrationResult('Please upload your valid ID image before submitting.',true);return;}
    if(file && file.size>2*1024*1024){ if(typeof toast==='function') toast('Valid ID image must be 2 MB or smaller.'); return; }
    if(!['image/jpeg','image/png','image/webp'].includes(String(file.type||''))){registrationResult('Use a JPG, PNG or WEBP valid ID image.',true);return;}

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
    if(completingExisting){
      if(String(existingSession.user.email||'').toLowerCase()!==payload.p_email){ registrationResult('The registration email must match the signed-in ScanSafe account.',true); return; }
      publicRegistrationInFlight=true; const submitButton=document.getElementById('publicRegistrationSubmit');
      if(submitButton){submitButton.disabled=true;submitButton.textContent='Saving...';} registrationResult('');
      try{
        const {data,error}=await sb.rpc('scansafe_complete_my_registration',payload); if(error) throw error; const code=data?.registration_code||'your registration';
        if(!window.ScanSafeMedia?.uploadRegistrationId) throw new Error('The registration ID upload service is unavailable. Reload ScanSafe and try again.');
        if(window.ScanSafeMedia?.init) await window.ScanSafeMedia.init({getClient:readyClient,getContext:()=>({userId:existingSession.user.id,role:'evacuee',profile:window.ScanSafeDB.profile||{id:existingSession.user.id,full_name:payload.p_full_name,role:'evacuee'}})});
        const uploaded=await window.ScanSafeMedia.uploadRegistrationId({file,ownerId:existingSession.user.id});
        if(!uploaded?.valid_id?.path) throw new Error('The valid ID image upload was not confirmed.');
        clearRegistrationCompletion(); publicRegistrationCompletionMode=false;
        registrationResult('Registration '+code+' is complete and pending admin approval. Your Barcode will be issued only after approval.');
        if(typeof window.closePublicRegistration==='function') window.closePublicRegistration(); setTimeout(()=>location.replace('user-portal.html'),250);
      }catch(error){ registrationResult('Registration could not be completed. '+(error?.message||'Please try again.'),true); }
      finally{ publicRegistrationInFlight=false; if(submitButton){submitButton.disabled=false;submitButton.textContent='Complete Registration';} }
      return;
    }

    publicRegistrationInFlight=true;
    const submitButton=document.getElementById('publicRegistrationSubmit');
    if(submitButton){submitButton.disabled=true;submitButton.textContent='Submitting...';}
    let temporarySession=false;
    let registrationSaved=false;
    registrationResult('');
    try{
    // Passwords stay inside Supabase Auth calls. Registration approval still
    // controls barcode issuance; it does not control account sign-in.
    const {data:signupData,error:signupError}=await sb.auth.signUp({
      email:payload.p_email,
      password,
      options:{
        data:{ full_name:payload.p_full_name, role:'evacuee' }
      }
    });
    if(signupError || !signupData?.user){
      const code=String(signupError?.code||'');
      console.warn('ScanSafe Auth sign-up failed:', {
        code,
        status:signupError?.status||null,
        message:signupError?.message||null,
        email:payload.p_email,
        projectUrl:cfg.url
      });

      if(code==='email_exists' || /already registered/i.test(String(signupError?.message||''))){
        if(typeof toast==='function') toast('This email already has a ScanSafe account. Log in instead, or reset the account password in Supabase if needed.');
      }else if(code==='weak_password'){
        if(typeof toast==='function') toast('Password is too weak. Use a stronger password with at least 8 characters.');
      }else if(code==='email_provider_disabled' || code==='provider_disabled'){
        if(typeof toast==='function') toast('Email/password registration is disabled in Supabase Authentication settings.');
      }else{
        if(typeof toast==='function') toast('Account could not be created. '+(signupError?.message||''));
      }
      return;
    }

    if(Array.isArray(signupData.user.identities) && signupData.user.identities.length===0){
      registrationResult('This email may already have a ScanSafe account. Log in using your existing email and password.',true);
      return;
    }

    let authSession=signupData.session||null;
    if(!authSession){
      // Compatibility when the backend returns a user without a session. This
      // succeeds only if normal password sign-in is allowed by Supabase.
      const signIn=await sb.auth.signInWithPassword({email:payload.p_email,password});
      if(!signIn.error && signIn.data?.session?.user?.id===signupData.user.id) authSession=signIn.data.session;
    }
    if(authSession){
      temporarySession=true;
      window.ScanSafeDB.session=authSession;
      window.ScanSafeDB.profile=null;
    }

    payload.p_auth_user_id=signupData.user.id;
    let registrationData=null,registrationError=null;
    { const result=await sb.rpc('submit_public_registration_account',payload); registrationData=result.data; registrationError=result.error; }
    if(registrationError&&authSession){ const ownPayload={...payload}; delete ownPayload.p_auth_user_id; const fallback=await sb.rpc('scansafe_complete_my_registration',ownPayload); if(!fallback.error){registrationData=fallback.data?.registration_code||null;registrationError=null;} else console.warn('ScanSafe authenticated registration fallback:',fallback.error.message); }
    if(registrationError){ console.error(registrationError); registrationResult('Account was created, but the registration could not be linked. Log in with this account and ScanSafe will open Complete Registration automatically.',true); return; }
    const data=typeof registrationData==='string'?registrationData:registrationData?.registration_code;
    if(typeof data!=='string'||!data.trim()) throw new Error('Registration confirmation was not received. Please check the account before submitting again.');
    registrationSaved=true;
    const loginEmail=document.getElementById('loginUsername');
    if(loginEmail) loginEmail.value=payload.p_email;

    if(!authSession){
      registrationResult('Registration '+data+' is saved, but this Supabase project is still requiring email confirmation. ScanSafe does not use email confirmation. Turn Confirm Email OFF in Supabase Authentication, then create a new test account.',true);
      if(typeof window.closePublicRegistration==='function') window.closePublicRegistration();
      return;
    }
    if(!window.ScanSafeMedia?.uploadRegistrationId) throw new Error('The ID upload service is unavailable. Reload ScanSafe and try again.');
    if(window.ScanSafeMedia?.init){
      await window.ScanSafeMedia.init({
        getClient:readyClient,
        getContext:()=>({
          userId:signupData.user.id,
          role:'evacuee',
          profile:{id:signupData.user.id,full_name:payload.p_full_name,role:'evacuee'}
        })
      });
    }
    const uploaded=await window.ScanSafeMedia.uploadRegistrationId({file,ownerId:signupData.user.id});
    if(!uploaded?.valid_id?.path) throw new Error('The ID image upload was not confirmed. Upload it from Profile after signing in.');

    if(typeof window.closePublicRegistration==='function') window.closePublicRegistration();

    registrationResult('Registration '+data+' and your ID image have been saved. You may log in now using the same email and password. Your barcode will be issued after admin approval.');
    for(const id of ['publicPassword','publicConfirmPassword']){const input=document.getElementById(id);if(input) input.value='';}
    }catch(error){
      registrationResult((registrationSaved?'Your registration is saved, but the ID image upload did not finish. Log in again and ScanSafe will reopen Complete Registration. ':'Registration could not be completed. ')+(error?.message||'Please try again.'),true);
      if(registrationSaved && typeof window.closePublicRegistration==='function') window.closePublicRegistration();
    }finally{
      if(temporarySession){
        try{await sb.auth.signOut();}catch(error){console.warn('ScanSafe registration session cleanup failed');}
        window.ScanSafeDB.session=null;
        window.ScanSafeDB.profile=null;
        window.ScanSafeMedia?.reset();
      }
      publicRegistrationInFlight=false;
      if(submitButton){submitButton.disabled=false;submitButton.textContent='Submit Registration';}
    }
  }


  // =========================================================
  // ADMIN LIVE DATA — NO PROTOTYPE / MOCK RECORDS
  // =========================================================
  const adminLiveCache={
    loaded:false,
    stats:null,
    evacuees:[],
    spaces:[],
    activity:[],
    error:null,
    warnings:[],
    updatedAt:null,
    profiles:null
  };
  let adminLiveRefreshPromise=null;
  let adminSnapshotRpcUnavailable=false;

  function adminLivePage(){
    return (location.pathname.split('/').pop()||'').toLowerCase();
  }

  function adminLiveEsc(value){
    if(typeof esc==='function') return esc(value);
    return String(value??'')
      .replaceAll('&','&amp;')
      .replaceAll('<','&lt;')
      .replaceAll('>','&gt;')
      .replaceAll('"','&quot;')
      .replaceAll("'",'&#039;');
  }

  function adminLiveRelativeTime(value){
    if(!value) return '';
    const d=new Date(value);
    if(Number.isNaN(d.getTime())) return '';
    const seconds=Math.max(0,Math.floor((Date.now()-d.getTime())/1000));
    if(seconds<60) return 'Now';
    if(seconds<3600) return `${Math.floor(seconds/60)}m`;
    if(seconds<86400) return `${Math.floor(seconds/3600)}h`;
    return d.toLocaleDateString();
  }

  function lifecycleDate(value){
    if(!value) return 'Not recorded';
    const d=new Date(value);
    return Number.isNaN(d.getTime())?'Not recorded':d.toLocaleString();
  }

  function lifecycleDuration(arrival,departure,seconds){
    let total=Number(seconds);
    if(!Number.isFinite(total) && arrival){
      const start=new Date(arrival).getTime();
      const end=departure?new Date(departure).getTime():Date.now();
      if(Number.isFinite(start)&&Number.isFinite(end)) total=Math.max(0,Math.floor((end-start)/1000));
    }
    if(!Number.isFinite(total)) return 'Not recorded';
    const days=Math.floor(total/86400);
    const hours=Math.floor((total%86400)/3600);
    const minutes=Math.floor((total%3600)/60);
    const parts=[];
    if(days) parts.push(days+'d');
    if(hours) parts.push(hours+'h');
    if(minutes || !parts.length) parts.push(minutes+'m');
    return parts.join(' ');
  }

  function adminLiveStatus(row){
    if(String(row.current_status||'').trim().toLowerCase()==='released') return 'Released';
    if(row.approval_status==='approved'){
      return ['accommodated','checked_in'].includes(String(row.current_status||'').toLowerCase())
        ? 'Accommodated'
        : 'Approved';
    }
    if(row.approval_status==='rejected') return 'Rejected';
    return 'Pending Approval';
  }

  function adminLiveRequest(row){
    return {
      id:row.registration_code || ('REQ-'+String(row.evacuee_id).padStart(4,'0')),
      dbId:Number(row.evacuee_id),
      evacueeId:'EV-'+String(row.evacuee_id).padStart(3,'0'),
      name:row.full_name || 'Evacuee',
      email:row.email || '',
      age:row.age ?? '',
      gender:row.gender || '',
      group:Number(row.group_size||1),
      needs:row.needs_summary || 'None',
      address:row.address || '',
      barangay:row.barangay || '',
      city:row.city || '',
      validIdType:row.valid_id_type || '',
      validIdNumber:row.valid_id_number || '',
      submitted:row.registered_at
        ? new Date(row.registered_at).toLocaleString()
        : '',
      status:adminLiveStatus(row),
      approvalStatus:row.approval_status,
      currentStatus:row.current_status,
      barcodeValue:row.barcode_value || null,
      qrIssued:!!row.barcode_value,
      qrCode:row.barcode_value || null,
      assignment:row.assigned_space_code || null,
      assignmentName:row.assigned_space_name || null,
      dbGroupId:Number(row.group_id||0)||null,
      stayStatus:row.stay_status || null,
      arrivalTime:row.arrival_time || null,
      departureTime:row.departure_time || null,
      contactNumber:row.contact_number || ''
    };
  }

  function adminFindKpiCard(label){
    const wanted=String(label).toLowerCase();
    return [...document.querySelectorAll('.kpi-card,.stat-card,.summary-card,.card')]
      .find(el=>{
        const text=(el.textContent||'').toLowerCase();
        return text.includes(wanted);
      }) || null;
  }

  function adminSetKpi(label,value,subtext){
    const card=adminFindKpiCard(label);
    if(!card) return;

    const candidates=[
      ...card.querySelectorAll('[data-kpi-value],.kpi-value,.stat-value,h1,h2,h3,strong')
    ];
    const valueEl=candidates.find(el=>{
      const t=(el.textContent||'').trim();
      return /^-?\d+(?:\.\d+)?%?$/.test(t) || el.matches('[data-kpi-value],.kpi-value,.stat-value');
    });
    if(valueEl) valueEl.textContent=String(value);

    if(subtext){
      const sub=card.querySelector('.kpi-sub,.stat-sub,.muted,small');
      if(sub) sub.textContent=String(subtext);
    }
  }

  function adminLiveCoverage(row){
    return /abangan norte/i.test(row.barangay||'') && /marilao/i.test(row.city||'')?'Within Coverage':'Requires Verification';
  }

  function renderAdminLiveEvacuees(){
    const body=document.querySelector('#evacBody');
    if(!body) return;

    if(!adminLiveCache.loaded){
      body.innerHTML='<tr><td colspan="11" style="text-align:center;padding:24px">'+(adminLiveCache.error?'Evacuees could not be loaded. Use Refresh to try again.':'Loading evacuees...')+'</td></tr>';
      return;
    }

    const term=(document.querySelector('#evacSearch')?.value||'').trim().toLowerCase();
    const statusFilter=document.querySelector('#evacStatus')?.value||'all';
    const coverageFilter=document.querySelector('#evacCoverage')?.value||'all';

    const rows=adminLiveCache.evacuees
      .map(adminLiveRequest)
      .filter(row=>{
        const matchesTerm=!term ||
          String(row.name).toLowerCase().includes(term) ||
          String(row.evacueeId).toLowerCase().includes(term) ||
          String(row.id).toLowerCase().includes(term) ||
          String(row.email).toLowerCase().includes(term) ||
          [row.address,row.barangay,row.city].join(' ').toLowerCase().includes(term);

        const matchesStatus=statusFilter==='all' ||
          row.status===statusFilter ||
          row.approvalStatus===String(statusFilter).toLowerCase();

        return matchesTerm && matchesStatus && (coverageFilter==='all' || adminLiveCoverage(row)===coverageFilter);
      });

    body.innerHTML=rows.length
      ? rows.map(row=>`
          <tr onclick="showEvac('${adminLiveEsc(row.evacueeId)}')">
            <td><input type="checkbox"></td>
            <td>${adminLiveEsc(row.evacueeId)}</td>
            <td>
              <b>${adminLiveEsc(row.name)}</b><br>
              <span class="muted">${adminLiveEsc(row.id)}</span>
            </td>
            <td>${adminLiveEsc(row.age)}</td>
            <td>${adminLiveEsc(row.gender)}</td>
            <td>${row.group}</td>
            <td>${row.qrIssued?'<span class="pill green">Issued</span>':'<span class="pill gray">Not Issued</span>'}</td>
            <td>${adminLiveEsc(adminLiveCoverage(row))}</td>
            <td>${adminLiveEsc(row.assignmentName||row.assignment||'Waiting for assignment')}</td>
            <td>${typeof statusPill==='function'?statusPill(row.status):adminLiveEsc(row.status)}</td>
            <td>
              <button class="icon-btn" onclick="event.stopPropagation();showEvac('${adminLiveEsc(row.evacueeId)}')">
                ${typeof ico==='function'?ico('eye','sm'):'View'}
              </button>
            </td>
          </tr>`).join('')
      : `<tr><td colspan="10" style="text-align:center;padding:24px;color:#7d8998">No evacuee records found in Supabase.</td></tr>`;
  }

  async function loadAdminGroupStay(source){
    if(!source?.group_id || source.__stayLoaded) return source;
    source.__stayLoaded=true;
    const sb=readyClient();
    if(!sb) return source;
    try{
      const {data,error}=await sb.rpc('get_scansafe_staff_group_stay',{
        p_group_id:Number(source.group_id)
      });
      if(error){
        const missing=error.code==='PGRST202'||error.code==='42883'||
          /could not find.*get_scansafe_staff_group_stay|function.*does not exist/i.test(error.message||'');
        if(!missing) console.warn('ScanSafe staff stay:',error.message);
        return source;
      }
      if(data){
        source.stay_status=data.stay_status||null;
        source.arrival_time=data.arrival_time||null;
        source.departure_time=data.departure_time||null;
        source.stay_duration_seconds=data.stay_duration_seconds??null;
        source.readmission_ready=data.readmission_ready===true;
        source.cooldown_remaining_seconds=Number(data.cooldown_remaining_seconds||0);
        source.cooldown_until=data.cooldown_until||null;
        source.stay_display_status=data.display_status||null;
        source.previous_stay=data.previous_stay||null;
        if(!source.assigned_space_name && data.space_name) source.assigned_space_name=data.space_name;
      }
    }catch(error){
      console.warn('ScanSafe staff stay:',error);
    }
    return source;
  }

  async function showAdminLiveEvacuee(id){
    const box=document.querySelector('#evacDetail');
    if(!box) return;

    const source=adminLiveCache.evacuees
      .find(x=>String('EV-'+String(x.evacuee_id).padStart(3,'0'))===String(id) ||
        String(x.registration_code||'')===String(id));
    if(source) await loadAdminGroupStay(source);
    const row=source?adminLiveRequest(source):null;

    if(!row){
      box.innerHTML='<div class="space-placeholder">Evacuee record not found in Supabase.</div>';
      return;
    }

    const canReview=row.approvalStatus==='pending';
    const canRelease=row.approvalStatus==='approved' &&
      !!row.arrivalTime &&
      !!row.assignment &&
      !!row.dbGroupId;

    const barcode=row.barcodeValue
      ? `<div class="prototype-qr-wrap">${typeof qrMarkup==='function'?qrMarkup(row.barcodeValue):adminLiveEsc(row.barcodeValue)}</div>`
      : `<div class="space-placeholder" style="margin-top:12px">Barcode not issued yet.</div>`;

    const readmissionReady=source?.readmission_ready===true;
    const stayStatus=readmissionReady
      ? 'Ready for Readmission'
      : String(row.currentStatus||'').toLowerCase()==='released'
        ? 'Released / Cooldown'
        : row.arrivalTime
          ? 'Accommodated / Checked In'
          : row.approvalStatus==='approved'
            ? 'Approved — Waiting for Check-In'
            : row.status;
    const previousStay=source?.previous_stay||null;

    box.innerHTML=`
      <div class="admin-detail-heading">
        <div>
          <h3 class="section-h">${typeof ico==='function'?ico('user'):''} Evacuee Details</h3>
          <p class="muted admin-detail-sub">Registration, barcode, accommodation and shelter-stay lifecycle.</p>
        </div>
        <div class="admin-detail-actions">
          ${canReview?`<button class="btn red" onclick="reviewRegistration('${adminLiveEsc(row.id)}')">Review</button>`:''}
          ${canRelease?`<button class="btn out release-stay-button" onclick="ScanSafeRelease.open(${Number(row.dbGroupId)},'${adminLiveEsc(row.name).replaceAll("'","&#39;")}',${Number(row.group||1)})">Release ${row.group>1?'Evacuee Group':'Evacuee'}</button>`:''}
        </div>
      </div>

      <div class="detail-top admin-detail-person">
        <div class="person-round">${typeof ico==='function'?ico('user','xl'):''}</div>
        <div>
          <h2>${adminLiveEsc(row.name)}</h2>
          <div class="muted">ID: ${adminLiveEsc(row.evacueeId)}</div>
          <div class="admin-status-row">${typeof statusPill==='function'?statusPill(row.status):adminLiveEsc(row.status)}</div>
        </div>
      </div>

      <section class="admin-stay-card ${readmissionReady?'is-ready':String(row.currentStatus||'').toLowerCase()==='released'?'is-released':canRelease?'is-active':''}">
        <div class="admin-stay-card-head">
          <div>
            <small>Shelter Stay</small>
            <strong>${adminLiveEsc(stayStatus)}</strong>
          </div>
          <span class="stay-state-dot"></span>
        </div>
        <div class="admin-stay-metrics">
          <div><small>Arrival Time</small><b>${adminLiveEsc(readmissionReady?'Not started':lifecycleDate(row.arrivalTime))}</b></div>
          <div><small>Departure Time</small><b>${adminLiveEsc(readmissionReady?'--':lifecycleDate(row.departureTime))}</b></div>
          <div><small>Stay Duration</small><b>${adminLiveEsc(readmissionReady?'--':row.arrivalTime?lifecycleDuration(row.arrivalTime,row.departureTime,source?.stay_duration_seconds):'Not started')}</b></div>
          <div><small>Assigned Space</small><b>${adminLiveEsc(readmissionReady?'Not assigned':row.assignmentName||row.assignment||'Not assigned')}</b></div>
        </div>
        ${previousStay?`<div class="admin-previous-stay"><small>Previous Shelter Stay</small><b>${adminLiveEsc(lifecycleDate(previousStay.arrival_time))} → ${adminLiveEsc(lifecycleDate(previousStay.departure_time))}</b><span>${adminLiveEsc(previousStay.space_name||'Previous space not recorded')} • ${adminLiveEsc(lifecycleDuration(previousStay.arrival_time,previousStay.departure_time,previousStay.stay_duration_seconds))}</span></div>`:''}
      </section>

      ${barcode}

      <div class="detail-list admin-profile-list">
        <div class="detail-line"><b>Email</b><span>${adminLiveEsc(row.email||'Not provided')}</span></div>
        <div class="detail-line"><b>Contact Number</b><span>${adminLiveEsc(row.contactNumber||'Not provided')}</span></div>
        <div class="detail-line"><b>Age / Gender</b><span>${adminLiveEsc(row.age)} | ${adminLiveEsc(row.gender)}</span></div>
        <div class="detail-line"><b>Group Size</b><span>${row.group} member${row.group===1?'':'s'}</span></div>
        <div class="detail-line"><b>Barcode Status</b><span>${row.qrIssued?'Issued':'Not Issued'}</span></div>
        <div class="detail-line"><b>Accommodation</b><span>${adminLiveEsc(row.assignmentName||row.assignment||(row.currentStatus==='released'?'Released':'Not assigned yet'))}</span></div>
        <div class="detail-line"><b>Special Needs</b><span>${adminLiveEsc(row.needs||'None')}</span></div>
        <div class="detail-line"><b>Address</b><span>${adminLiveEsc(row.address||'Not provided')}</span></div>
      </div>`;

    if(window.ScanSafeBarcode?.render) setTimeout(()=>window.ScanSafeBarcode.render(),0);
  }

  let scanSafeReleaseState={groupId:null,name:'',groupSize:1,busy:false};

  function ensureScanSafeReleaseModal(){
    let modal=document.getElementById('scanSafeReleaseModal');
    if(modal) return modal;
    modal=document.createElement('div');
    modal.id='scanSafeReleaseModal';
    modal.className='release-stay-modal';
    modal.hidden=true;
    modal.innerHTML=`
      <div class="release-stay-backdrop" data-release-close></div>
      <section class="release-stay-dialog" role="dialog" aria-modal="true" aria-labelledby="releaseStayTitle">
        <div class="release-stay-icon">${typeof ico==='function'?ico('logout'):''}</div>
        <h2 id="releaseStayTitle">Release Shelter Stay</h2>
        <p id="releaseStayCopy">Confirm that this evacuee has departed the evacuation center.</p>
        <div class="release-stay-warning" id="releaseStayWarning"></div>
        <label for="releaseStayReason">Release reason</label>
        <textarea id="releaseStayReason" maxlength="500" rows="3" placeholder="e.g. Family returned home safely"></textarea>
        <div class="release-stay-actions">
          <button type="button" class="btn out" data-release-close>Cancel</button>
          <button type="button" class="btn red" id="releaseStayConfirm">Confirm Release</button>
        </div>
        <p class="release-stay-feedback" id="releaseStayFeedback" role="status" aria-live="polite"></p>
      </section>`;
    document.body.appendChild(modal);
    modal.querySelectorAll('[data-release-close]').forEach(el=>el.addEventListener('click',()=>window.ScanSafeRelease.close()));
    modal.querySelector('#releaseStayConfirm')?.addEventListener('click',()=>window.ScanSafeRelease.confirm());
    return modal;
  }

  window.ScanSafeRelease={
    open(groupId,name,groupSize=1){
      if(!groupId) return;
      const modal=ensureScanSafeReleaseModal();
      scanSafeReleaseState={groupId:Number(groupId),name:String(name||'Evacuee'),groupSize:Number(groupSize||1),busy:false};
      modal.hidden=false;
      document.body.classList.add('release-stay-open');
      const copy=modal.querySelector('#releaseStayCopy');
      const warning=modal.querySelector('#releaseStayWarning');
      const reason=modal.querySelector('#releaseStayReason');
      const feedback=modal.querySelector('#releaseStayFeedback');
      if(copy) copy.textContent='Release '+scanSafeReleaseState.name+' from the current shelter stay?';
      if(warning) warning.textContent=scanSafeReleaseState.groupSize>1
        ? 'This will release all '+scanSafeReleaseState.groupSize+' people in this registration group, close the active assignment, and free the occupied capacity.'
        : 'This will close the active assignment and free the occupied capacity.';
      if(reason) reason.value='';
      if(feedback) feedback.textContent='';
      setTimeout(()=>reason?.focus(),0);
    },
    close(){
      if(scanSafeReleaseState.busy) return;
      const modal=document.getElementById('scanSafeReleaseModal');
      if(modal) modal.hidden=true;
      document.body.classList.remove('release-stay-open');
      scanSafeReleaseState={groupId:null,name:'',groupSize:1,busy:false};
    },
    async confirm(){
      const modal=ensureScanSafeReleaseModal();
      const reason=modal.querySelector('#releaseStayReason')?.value.trim()||'';
      const feedback=modal.querySelector('#releaseStayFeedback');
      const button=modal.querySelector('#releaseStayConfirm');
      if(!reason){
        if(feedback) feedback.textContent='Enter a release reason before confirming.';
        return;
      }
      const sb=readyClient();
      if(!sb){
        if(feedback) feedback.textContent='Backend unavailable. Nothing was changed.';
        return;
      }
      scanSafeReleaseState.busy=true;
      if(button){button.disabled=true;button.textContent='Releasing...';}
      try{
        const {data,error}=await sb.rpc('release_scansafe_group',{
          p_group_id:scanSafeReleaseState.groupId,
          p_reason:reason
        });
        if(error) throw error;
        if(feedback) feedback.textContent='Released successfully. Departure time and shelter-stay history were recorded.';
        if(typeof toast==='function') toast(scanSafeReleaseState.name+' released. Occupancy updated.');
        await Promise.allSettled([loadAdminLiveSnapshot(),loadAccommodationState(),window.ScanSafeNeeds?.refresh?.()]);
        setTimeout(()=>{
          scanSafeReleaseState.busy=false;
          if(button){button.disabled=false;button.textContent='Confirm Release';}
          window.ScanSafeRelease.close();
        },450);
        return data;
      }catch(error){
        scanSafeReleaseState.busy=false;
        if(button){button.disabled=false;button.textContent='Confirm Release';}
        if(feedback) feedback.textContent=error?.message||'Release failed. No confirmed change was made.';
      }
    }
  };

  const adminLivePages=new Set([
    'admin-dashboard.html','evacuees.html','shelter-room.html',
    'barcode-scanner.html','reports.html','messages.html','user-management.html','settings.html'
  ]);

  function adminSetDataStatus(){
    const box=document.getElementById('adminDataStatus');
    if(!box) return;
    const failed=!!adminLiveCache.error;
    const message=failed
      ? (adminLiveCache.loaded?'Refresh failed. Showing the last loaded records. ':'Could not load registrations. ')+adminLiveCache.error
      : adminLiveCache.loaded
        ? 'Live database - Updated '+new Date(adminLiveCache.updatedAt).toLocaleTimeString()+
          (adminLiveCache.warnings.length?' - '+adminLiveCache.warnings.join(' '):'')
        : 'Loading registrations from the database...';
    box.setAttribute('role',failed?'alert':'status');
    box.innerHTML='<span>'+adminLiveEsc(message)+'</span> <button type="button" class="btn out" onclick="ScanSafeAdminLive.refresh()">Refresh</button>';
  }

  function renderAdminPendingRequests(){
    const body=document.getElementById('pendingRequestsBody');
    if(!body) return;
    if(!adminLiveCache.loaded){
      body.innerHTML='<tr><td colspan="7" style="text-align:center;padding:24px">'+
        (adminLiveCache.error?'Registrations could not be loaded. Use Refresh to try again.':'Loading registrations...')+'</td></tr>';
      return;
    }
    const pending=adminLiveCache.evacuees.map(adminLiveRequest).filter(r=>r.status==='Pending Approval');
    body.innerHTML=pending.length?pending.map(r=>
      '<tr><td><div class="ops-person"><div class="ops-initial">'+adminLiveEsc(initials(r.name))+
      '</div><div><b>'+adminLiveEsc(r.name)+'</b><small>'+adminLiveEsc(r.id)+'</small></div></div></td><td>'+r.group+
      '</td><td>'+adminLiveEsc(r.needs)+'</td><td>'+adminLiveEsc([r.barangay,r.city].filter(Boolean).join(', ')||'Not provided')+
      '</td><td>'+adminLiveEsc(r.submitted)+'</td><td>'+statusPill(r.status)+
      '</td><td><button class="btn red review-btn" data-review-request="'+adminLiveEsc(r.id)+'">Review</button></td></tr>'
    ).join(''):'<tr><td colspan="7" style="text-align:center;padding:24px">No pending registrations.</td></tr>';
    body.querySelectorAll('[data-review-request]').forEach(button=>{
      button.addEventListener('click',()=>window.reviewRegistration(button.dataset.reviewRequest));
    });
  }

  function renderAdminLiveDashboard(){
    const state=window.currentState?.();
    const stats=adminLiveCache.stats||{};
    if(state){
      state.requests=adminLiveCache.evacuees.map(adminLiveRequest);
      state.activity=adminLiveCache.activity.map(a=>({
        title:a.title||a.event_type||'Database activity',
        desc:a.description||'',time:adminLiveRelativeTime(a.created_at),icon:a.icon||'+'
      }));
      state.demoGroups=[];
      state.demoAssignments={};
      window.saveScanSafeState?.(state);
    }
    const value=key=>adminLiveCache.loaded && stats[key]!=null?stats[key]:'--';
    const set=(selector,text)=>document.querySelectorAll(selector).forEach(el=>el.textContent=String(text));
    set('[data-pending-count],[data-kpi-pending]',value('pending_registrations'));
    set('[data-kpi-total]',adminLiveCache.loaded?adminLiveCache.evacuees.length:'--');
    const families=adminLiveCache.evacuees.filter(row=>Number(row.group_size)>1);
    set('[data-kpi-groups]',adminLiveCache.loaded?families.length:'--');
    set('[data-kpi-group-average]',adminLiveCache.loaded?'Average size: '+(families.length?(families.reduce((n,row)=>n+Number(row.group_size),0)/families.length).toFixed(1):'0'):'Loading family registrations...');
    set('[data-kpi-approved]',value('approved_evacuees'));
    set('[data-kpi-spaces]',value('available_spaces'));
    const percent=value('occupancy_percent');
    const occupancy=percent==='--'?percent:percent+'%';
    set('[data-kpi-occupancy]',occupancy);
    set('[data-kpi-capacity]',value('current_occupancy')+' / '+value('total_capacity')+' capacity');
    adminSetKpi('Current Occupancy',occupancy,value('current_occupancy')+' / '+value('total_capacity')+' capacity');
    adminSetKpi('Approved Evacuees',value('approved_evacuees'),'Admin approved');
    adminSetKpi('Pending Registrations',value('pending_registrations'),'Needs admin review');
    adminSetKpi('Available Spaces',value('available_spaces'),'Primary accommodation spaces');
    renderAdminPendingRequests();
    if(typeof window.renderRecentActivity==='function') window.renderRecentActivity();

    const primary=adminLiveCache.spaces.filter(row=>row.is_primary && row.status!=='inactive');
    const overview=document.getElementById('dashboardSpaceOverview');
    if(overview){
      overview.innerHTML=primary.length
        ? '<div class="space-overview">'+primary.map(row=>{
            const cap=Number(row.capacity||0),occ=Number(row.current_occupancy||0);
            const pct=cap>0?Math.round(occ/cap*100):0;
            return '<div class="space-overview-row"><div><b>'+adminLiveEsc(row.space_name||row.space_code)+
              '</b><small>'+occ+' / '+cap+' occupied</small></div>'+statusPill(normalizeDbSpaceStatus(row))+
              '<div class="occupancy-line"><i style="width:'+Math.min(100,pct)+'%"></i></div></div>';
          }).join('')+'</div>'
        : '<div class="space-placeholder">'+(adminLiveCache.loaded?'No accommodation data available.':'Loading accommodation data...')+'</div>';
    }
    const alerts=[];
    if(stats.pending_registrations>0) alerts.push({title:stats.pending_registrations+' pending registration'+(stats.pending_registrations===1?'':'s'),text:'Review identity and coverage before approval.'});
    primary.filter(row=>Number(row.capacity)>0 && Number(row.current_occupancy)/Number(row.capacity)>.70).forEach(row=>{
      alerts.push({title:(row.space_name||row.space_code)+' '+(Number(row.current_occupancy)>=Number(row.capacity)?'is full':'is near capacity'),text:Math.max(0,Number(row.capacity)-Number(row.current_occupancy))+' slots available.'});
    });
    set('#adminAlertsCount',adminLiveCache.loaded?alerts.length+' active':'--');
    const alertBox=document.getElementById('adminAlerts');
    if(alertBox) alertBox.innerHTML=alerts.length?alerts.map(a=>'<div class="attention-item"><b>'+adminLiveEsc(a.title)+'</b><span>'+adminLiveEsc(a.text)+'</span></div>').join(''):'<div class="space-placeholder">'+(adminLiveCache.loaded?'No current alerts.':'Loading alerts...')+'</div>';
    document.querySelectorAll('.prototype-note').forEach(el=>{
      el.textContent='Approval updates the registration in the database and issues the evacuee barcode.';
    });
    adminSetDataStatus();
    renderAdminLiveEvacuees();
  }

  function clearAdminMockState(){
    const state=window.currentState?.();
    if(state){
      state.requests=[];
      state.activity=[];
      state.demoGroups=[];
      state.demoAssignments={};
      window.saveScanSafeState?.(state);
    }
    try{ localStorage.removeItem('scansafePrototypeStateV4'); }catch(_){}
    renderAdminLiveDashboard();
  }

  // Use existing RLS-protected tables when the optional snapshot RPC has not
  // been installed. Page through every record so counts are never capped at 1000.
  async function adminReadAll(sb,table,columns,orderColumn){
    const rows=[];
    for(let offset=0;;offset+=1000){
      const {data,error}=await sb.from(table).select(columns).order(orderColumn,{ascending:false}).range(offset,offset+999);
      if(error) throw error;
      rows.push(...(data||[]));
      if(!data || data.length<1000) return rows;
    }
  }

  async function adminSnapshotFromTables(sb){
    const results=await Promise.allSettled([
      adminReadAll(sb,'evacuees','*','evacuee_id'),
      adminReadAll(sb,'accommodation_spaces','space_id,space_code,space_name,capacity,current_occupancy,is_primary,status','space_id'),
      adminReadAll(sb,'barcodes','evacuee_id,barcode_value,status','evacuee_id'),
      adminReadAll(sb,'accommodation_assignments','group_id,space_id,assignment_status','group_id')
    ]);
    if(results[0].status==='rejected') throw results[0].reason;
    const warnings=[];
    const optional=(index,label)=>{
      const result=results[index];
      if(result.status==='fulfilled') return result.value;
      console.warn('ScanSafe admin '+label+':',result.reason);
      warnings.push(label+' could not be loaded.');
      return [];
    };
    const spaces=optional(1,'Accommodation spaces').filter(row=>row.status!=='inactive');
    const barcodes=optional(2,'Barcodes');
    const assignments=optional(3,'Assignments');
    const spaceById=new Map(spaces.map(row=>[String(row.space_id),row]));
    const barcodeByEvacuee=new Map(barcodes.filter(row=>row.status==='active').map(row=>[String(row.evacuee_id),row]));
    const assignmentByGroup=new Map(assignments.filter(row=>row.assignment_status==='active').map(row=>[String(row.group_id),row]));
    const evacuees=results[0].value.map(row=>{
      const barcode=barcodeByEvacuee.get(String(row.evacuee_id));
      const assignment=assignmentByGroup.get(String(row.group_id));
      const space=spaceById.get(String(assignment?.space_id));
      return {...row,barcode_value:row.approval_status==='approved'?barcode?.barcode_value||null:null,
        assigned_space_code:space?.space_code||null,
        assigned_space_name:space?.space_name||null};
    });
    const hasSpaces=results[1].status==='fulfilled';
    const capacity=spaces.reduce((n,row)=>n+Number(row.capacity||0),0);
    const occupied=spaces.reduce((n,row)=>n+Number(row.current_occupancy||0),0);
    const activity=evacuees.filter(row=>row.registered_at).map(row=>({
      title:'Registration submitted',description:row.full_name+' - '+(row.registration_code||''),created_at:row.registered_at,icon:'+'
    })).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,5);
    return {evacuees,spaces,activity,warnings,stats:{
      pending_registrations:evacuees.filter(row=>row.approval_status==='pending').length,
      approved_evacuees:evacuees.filter(row=>row.approval_status==='approved').length,
      current_occupancy:hasSpaces?occupied:null,total_capacity:hasSpaces?capacity:null,
      occupancy_percent:hasSpaces?(capacity?Math.round(occupied/capacity*100):0):null,
      available_spaces:hasSpaces?spaces.filter(row=>row.is_primary && Number(row.current_occupancy)<Number(row.capacity)).length:null
    }};
  }

  function renderAdminSystemUsers(){
    const body=document.getElementById('systemUserBody');
    if(!body) return;
    const profiles=adminLiveCache.profiles;
    if(!profiles){
      body.innerHTML='<tr><td colspan="7">Personnel accounts have not been loaded. Use Refresh to retry.</td></tr>';
      return;
    }
    const personnel=profiles.filter(row=>['admin','staff'].includes(row.role));
    const set=(selector,value)=>document.querySelectorAll(selector).forEach(el=>el.textContent=String(value));
    set('[data-um-total]',personnel.length);
    set('[data-um-admins]',personnel.filter(row=>row.role==='admin').length);
    set('[data-um-roles]',new Set(personnel.map(row=>row.role)).size);
    set('[data-um-evacuees]',profiles.filter(row=>row.role==='evacuee').length);
    const term=(document.getElementById('systemUserSearch')?.value||'').trim().toLowerCase();
    const role=document.getElementById('systemUserRoleFilter')?.value||'all';
    const rows=personnel.filter(row=>(role==='all'||row.role===role) && (!term||[row.full_name,row.id,row.role].join(' ').toLowerCase().includes(term)));
    body.innerHTML=rows.length?rows.map(row=>'<tr><td><b>'+adminLiveEsc(row.full_name||'Unnamed account')+'</b></td><td>'+adminLiveEsc(row.id)+
      '</td><td>'+adminLiveEsc(row.role==='admin'?'Administrator':'Shelter Staff')+'</td><td>Personnel</td><td>Registered</td><td>Admin portal</td><td>--</td></tr>').join(''):
      '<tr><td colspan="7">No matching personnel accounts.</td></tr>';
  }

  async function performAdminLiveRefresh(){
    const sb=readyClient();
    try{
      if(!sb) throw new Error('The database connection is unavailable. Reload and try again.');
      if(!window.ScanSafeDB.session?.user) await bootstrapSession();
      if(!window.ScanSafeDB.session?.user) throw new Error('Sign in with an administrator or staff account.');
      if(!['admin','staff'].includes(window.ScanSafeDB.profile?.role)) throw new Error('Administrator or staff access is required.');
      let snapshot;
      if(!adminSnapshotRpcUnavailable){
        const {data,error}=await sb.rpc('scansafe_admin_dashboard_snapshot');
        if(error){
          const missing=error.code==='PGRST202' || error.code==='42883' || /could not find.*function|function.*does not exist/i.test(error.message||'');
          if(!missing) throw error;
          adminSnapshotRpcUnavailable=true;
        }else{
          if(!data || !Array.isArray(data.evacuees) || !Array.isArray(data.spaces)) throw new Error('Invalid admin dashboard response.');
          snapshot=data;
        }
      }
      if(!snapshot) snapshot=await adminSnapshotFromTables(sb);
      adminLiveCache.loaded=true;
      adminLiveCache.error=null;
      adminLiveCache.stats=snapshot.stats||{};
      adminLiveCache.evacuees=snapshot.evacuees;
      adminLiveCache.spaces=snapshot.spaces;
      adminLiveCache.activity=Array.isArray(snapshot.activity)?snapshot.activity:[];
      adminLiveCache.warnings=snapshot.warnings||[];
      adminLiveCache.updatedAt=new Date().toISOString();
      if(adminLivePage()==='user-management.html'){
        try{ adminLiveCache.profiles=await adminReadAll(sb,'profiles','id,full_name,role','id'); }
        catch(error){ adminLiveCache.warnings.push('Personnel accounts could not be loaded.'); console.warn('ScanSafe personnel:',error); }
        renderAdminSystemUsers();
      }
      mapDbCache.spaces.clear();
      for(const row of adminLiveCache.spaces){
        mapDbCache.spaces.set(row.space_code,row);
      }
      mapDbCache.ready=true;
      window.getDynamicOccupancy=id=>Number(mapDbCache.spaces.get(id)?.current_occupancy||0);
      window.getSpaceStatus=id=>{
        const row=mapDbCache.spaces.get(id);
        return row?normalizeDbSpaceStatus(row):'full';
      };
      window.getAvailableSlots=id=>{
        const row=mapDbCache.spaces.get(id);
        return row?Math.max(0,Number(row.capacity||0)-Number(row.current_occupancy||0)):0;
      };
      for(const row of adminLiveCache.spaces){
        syncSpaceIntoExistingMap(row);
        if(typeof ROOMS!=='undefined' && ROOMS[row.space_code]){
          Object.assign(ROOMS[row.space_code],{name:row.space_name,cap:Number(row.capacity||0),occ:Number(row.current_occupancy||0),status:normalizeDbSpaceStatus(row)});
        }
      }
      renderAdminLiveDashboard();
      if(typeof window.renderSpaces==='function') window.renderSpaces();
      if(typeof window.renderRooms==='function') window.renderRooms();
      const selectedSpace=document.querySelector('[data-space].selected')?.dataset.space;
      if(selectedSpace && typeof window.selectSpace==='function') window.selectSpace(selectedSpace);
      const selectedRoom=document.querySelector('[data-room].selected')?.dataset.room;
      if(selectedRoom && typeof window.selectRoom==='function') window.selectRoom(selectedRoom);
      return snapshot;
    }catch(error){
      console.error('ScanSafe admin live data:',error);
      adminLiveCache.error=error.message||'Check your connection and access permissions.';
      renderAdminLiveDashboard();
      return null;
    }
  }

  function loadAdminLiveSnapshot(){
    if(!adminLivePages.has(adminLivePage())) return Promise.resolve(null);
    if(!adminLiveRefreshPromise){
      adminLiveRefreshPromise=performAdminLiveRefresh().finally(()=>{adminLiveRefreshPromise=null;});
    }
    return adminLiveRefreshPromise;
  }

  window.ScanSafeMapDebug={
    inspect:()=>({
      page:mapPage(),
      spaces:[...mapDbCache.spaces.values()],
      occupants:[...mapDbCache.occupants.entries()].map(([space,rows])=>({space,rows})),
      occupantDebug:mapDbCache.occupantDebug||null,
      adminAssignments:(adminLiveCache.evacuees||[])
        .filter(row=>row.assigned_space_code)
        .map(row=>({
          name:row.full_name,
          group_id:row.group_id,
          space_code:row.assigned_space_code,
          status:row.current_status,
          approval_status:row.approval_status
        }))
    }),
    refresh:async()=>{
      await loadAdminLiveSnapshot();
      await loadAccommodationState();
      return window.ScanSafeMapDebug.inspect();
    }
  };

  window.ScanSafeAdminLive={
    refresh:loadAdminLiveSnapshot,
    renderSystemUsers:renderAdminSystemUsers,
    inspect:()=>({
      stats:adminLiveCache.stats,
      evacuees:adminLiveCache.evacuees,
      spaces:adminLiveCache.spaces,
      activity:adminLiveCache.activity,
      loaded:adminLiveCache.loaded,error:adminLiveCache.error,
      warnings:adminLiveCache.warnings,updatedAt:adminLiveCache.updatedAt
    })
  };

  async function loadPendingIntoPrototype(){
    return loadAdminLiveSnapshot();
  }

  async function approveByRequestId(requestId){
    const sb=readyClient();
    if(!sb){
      if(typeof toast==='function') toast('Backend unavailable. Approval was not changed.');
      return;
    }
    const s=typeof window.currentState==='function'?window.currentState():null;
    const req=s?.requests?.find(r=>r.id===requestId);
    if(!req?.dbId){ if(typeof toast==='function') toast('Database record not found for this request.'); return; }

    const {data,error}=await sb.rpc('approve_evacuee_registration',{p_evacuee_id:req.dbId});
    if(error){ if(typeof toast==='function') toast('Approval failed: '+error.message); return; }
    if(typeof window.closeReviewModal==='function') window.closeReviewModal();
    if(typeof toast==='function'){
      toast(data?'Approved. Barcode generated: '+String(data):'Approval saved, but the barcode is unavailable. Refresh or contact system support.');
    }
    await loadPendingIntoPrototype();
  }

  async function rejectByRequestId(requestId){
    const sb=readyClient();
    if(!sb){
      if(typeof toast==='function') toast('Backend unavailable. Rejection was not changed.');
      return;
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
  const mapDbCache={ spaces:new Map(), groups:new Map(), occupants:new Map(), ready:false,ownerId:null,availabilityState:'unavailable',error:null,revision:0 };

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

  function mapOccupantInitials(name=''){
    return String(name||'Evacuee').trim().split(/\s+/).filter(Boolean).slice(0,2).map(part=>part.charAt(0)).join('').toUpperCase()||'EV';
  }

  function adminMapFallbackOccupants(){
    const rows=[];
    for(const row of adminLiveCache.evacuees||[]){
      const spaceCode=String(row.assigned_space_code||'').trim();
      if(!spaceCode) continue;
      if(String(row.current_status||'').toLowerCase()==='released') continue;
      if(String(row.approval_status||'').toLowerCase()!=='approved') continue;
      rows.push({
        space_code:spaceCode,
        space_name:row.assigned_space_name||spaceCode,
        group_id:row.group_id,
        evacuee_id:row.evacuee_id,
        full_name:row.full_name||'Evacuee',
        group_size:Number(row.group_size||1),
        arrival_time:row.arrival_time||null,
        current_status:row.current_status||'',
        map_status:row.arrival_time?'checked_in':'assigned',
        source:'admin_live_fallback'
      });
    }
    return rows;
  }

  async function adminMapDirectAssignmentOccupants(sb){
    try{
      const [assignmentRes,evacueeRes,groupRes]=await Promise.all([
        sb.from('accommodation_assignments')
          .select('assignment_id,group_id,space_id,occupant_count,assignment_status')
          .eq('assignment_status','active'),
        sb.from('evacuees')
          .select('evacuee_id,group_id,full_name,current_status,approval_status')
          .eq('approval_status','approved'),
        sb.from('evacuee_groups')
          .select('group_id,group_size')
      ]);
      if(assignmentRes.error) throw assignmentRes.error;
      if(evacueeRes.error) throw evacueeRes.error;
      if(groupRes.error) throw groupRes.error;

      const evacByGroup=new Map();
      for(const row of evacueeRes.data||[]){
        if(String(row.current_status||'').toLowerCase()==='released') continue;
        const key=String(row.group_id);
        if(!evacByGroup.has(key)) evacByGroup.set(key,row);
      }
      const groupById=new Map((groupRes.data||[]).map(row=>[String(row.group_id),row]));
      const spaceById=new Map(
        [...mapDbCache.spaces.values()].map(row=>[String(row.space_id),row])
      );

      return (assignmentRes.data||[]).map(asg=>{
        const ev=evacByGroup.get(String(asg.group_id));
        const space=spaceById.get(String(asg.space_id));
        if(!ev || !space?.space_code) return null;
        return {
          space_code:String(space.space_code),
          space_name:space.space_name||space.space_code,
          group_id:asg.group_id,
          evacuee_id:ev.evacuee_id,
          full_name:ev.full_name||'Evacuee',
          group_size:Number(groupById.get(String(asg.group_id))?.group_size||asg.occupant_count||1),
          arrival_time:null,
          current_status:ev.current_status||'',
          map_status:'assigned',
          source:'direct_assignment_fallback'
        };
      }).filter(Boolean);
    }catch(error){
      console.warn('ScanSafe direct map assignment fallback:',error?.message||error);
      return [];
    }
  }

  function mergeAdminMapOccupants(primary,fallback){
    const merged=new Map();
    for(const row of fallback||[]){
      const key=[row.space_code,row.group_id||row.evacuee_id].join(':');
      merged.set(key,{...row});
    }
    for(const row of primary||[]){
      const key=[row.space_code,row.group_id||row.evacuee_id].join(':');
      merged.set(key,{...(merged.get(key)||{}),...row,source:'occupant_rpc'});
    }
    return [...merged.values()];
  }

  async function loadAdminMapOccupants(){
    if(mapPage()!=='shelter-room.html') return [];
    const sb=readyClient();
    if(!sb || !['admin','staff'].includes(window.ScanSafeDB.profile?.role)) return [];

    const fallback=adminMapFallbackOccupants();
    const directRows=await adminMapDirectAssignmentOccupants(sb);
    let rpcRows=[];
    let rpcError=null;

    try{
      const {data,error}=await sb.rpc('get_scansafe_space_occupants');
      if(error) throw error;
      rpcRows=Array.isArray(data)?data:[];
    }catch(error){
      rpcError=error;
      console.warn('ScanSafe map occupants RPC:',error?.message||error);
    }

    // The map must still show assigned occupants even if the optional
    // occupant-detail RPC is unavailable or returns no row for older data.
    const rows=mergeAdminMapOccupants(
      rpcRows,
      mergeAdminMapOccupants(directRows,fallback)
    );

    await Promise.all(rows.map(async row=>{
      if(!row?.evacuee_id || !sb.storage?.from) return;
      try{
        const detail=await sb.rpc('get_scansafe_registration_details',{
          p_evacuee_id:Number(row.evacuee_id)
        });
        const path=detail?.data?.profile_photo?.path;
        if(!path) return;
        const signed=await sb.storage.from('scansafe-account-media').createSignedUrl(path,300);
        const url=signed?.data?.signedUrl;
        if(/^https?:\/\//i.test(String(url||''))) row.profile_url=url;
      }catch(_){ /* Initials remain the safe fallback. */ }
    }));

    mapDbCache.occupants.clear();
    for(const row of rows){
      const key=String(row.space_code||'').trim();
      if(!key) continue;
      if(!mapDbCache.occupants.has(key)) mapDbCache.occupants.set(key,[]);
      mapDbCache.occupants.get(key).push(row);
    }

    mapDbCache.occupantDebug={
      rpcCount:rpcRows.length,
      fallbackCount:fallback.length,
      directAssignmentCount:directRows.length,
      renderedCount:rows.length,
      rpcError:rpcError?.message||null
    };

    renderAdminMapOccupants();
    return rows;
  }

  function renderAdminMapOccupants(){
    if(mapPage()!=='shelter-room.html') return;
    const stage=document.querySelector('.floor-image-stage');
    if(!stage) return;

    stage.querySelectorAll('.map-occupant-stack').forEach(node=>node.remove());

    for(const [spaceCode,rows] of mapDbCache.occupants.entries()){
      if(!rows?.length) continue;

      const hotspot=stage.querySelector(`.map-hotspot[data-space="${CSS.escape(spaceCode)}"]`);
      if(!hotspot) continue;

      // Anchor the bubble INSIDE the actual accommodation hotspot instead of
      // calculating coordinates against the whole floor image. This remains
      // correct during resize, horizontal scrolling and responsive scaling.
      const stack=document.createElement('span');
      stack.className='map-occupant-stack map-occupant-stack-anchored';
      stack.dataset.space=spaceCode;
      stack.setAttribute(
        'aria-label',
        (rows.length===1?rows[0].full_name:rows.length+' accommodated groups')+' in '+spaceCode
      );
      stack.title=rows
        .map(row=>`${row.full_name} • Group ${Number(row.group_size||1)} • ${row.arrival_time?'Checked In':'Assigned'}`)
        .join('\n');

      const visible=rows.slice(0,3);
      stack.innerHTML=
        visible.map(row=>
          `<span class="map-occupant-avatar${row.profile_url?' has-photo':''}" title="${gbeaaEscape(row.full_name||'Evacuee')}">`+
            (row.profile_url
              ? `<img src="${gbeaaEscape(row.profile_url)}" alt="">`
              : gbeaaEscape(mapOccupantInitials(row.full_name)))+
          `</span>`
        ).join('')+
        (rows.length>3?`<span class="map-occupant-more">+${rows.length-3}</span>`:'');

      hotspot.appendChild(stack);
      hotspot.classList.add('has-map-occupants');
    }

    stage.querySelectorAll('.map-hotspot').forEach(hotspot=>{
      if(!hotspot.querySelector('.map-occupant-stack')){
        hotspot.classList.remove('has-map-occupants');
      }
    });
  }

  function renderAdminMapSpaceDetail(spaceCode){
    if(mapPage()!=='shelter-room.html') return;
    const box=document.getElementById('spaceDetail');
    const row=mapDbCache.spaces.get(String(spaceCode));
    if(!box || !row) return;
    const occupants=mapDbCache.occupants.get(String(spaceCode))||[];
    const cap=Number(row.capacity||0),occ=Number(row.current_occupancy||0),available=Math.max(0,cap-occ);
    const list=occupants.length
      ? occupants.map(person=>`<div class="map-occupant-row"><span class="map-occupant-avatar${person.profile_url?' has-photo':''}">${person.profile_url?`<img src="${gbeaaEscape(person.profile_url)}" alt="">`:gbeaaEscape(mapOccupantInitials(person.full_name))}</span><span><b>${gbeaaEscape(person.full_name||'Evacuee')}</b><small>Group of ${Number(person.group_size||1)} • ${person.arrival_time?'Arrived '+new Date(person.arrival_time).toLocaleString():'Assigned — waiting for check-in'}</small></span><em>${person.arrival_time?'Checked In':'Assigned'}</em></div>`).join('')
      : '<div class="space-placeholder compact">No evacuees are currently assigned to this space.</div>';
    box.innerHTML=`
      <div class="room-banner"><svg class="icon xl bigicon"><use href="assets/icons.svg#home"></use></svg><div><h2>${gbeaaEscape(row.space_name||spaceCode)}</h2><div style="margin-top:5px">${statusPill(normalizeDbSpaceStatus(row))}</div></div></div>
      <div class="detail-list"><div class="detail-line"><b>Space Type</b><span>${gbeaaEscape(row.space_type||'Accommodation')}</span></div><div class="detail-line"><b>Capacity</b><span>${cap}</span></div><div class="detail-line"><b>Occupied</b><span>${occ}</span></div><div class="detail-line"><b>Available</b><span>${available}</span></div></div>
      <div class="map-monitor-note"><b>Automatic Assignment</b><span>Accommodation is assigned during barcode check-in using current shelter capacity and evacuee requirements.</span></div>
      <div class="map-occupants-panel"><div class="panel-head"><h3>Current Occupants</h3><span>${occupants.length} group${occupants.length===1?'':'s'}</span></div>${list}</div>`;
  }

  function installAdminMapMonitoring(){
    if(mapPage()!=='shelter-room.html' || window.__scanSafeMapMonitoringInstalled) return;
    window.__scanSafeMapMonitoringInstalled=true;
    const original=window.selectSpace;
    window.selectSpace=function(spaceCode){
      if(typeof original==='function') original(spaceCode);
      renderAdminMapSpaceDetail(spaceCode);
    };
  }

  async function loadAccommodationState(){
    const sb=readyClient();
    if(!sb) return false;
    const page=mapPage();
    if(!['shelter-room.html','user-room.html','admin-dashboard.html','evacuees.html'].includes(page)) return false;
    const isEvacuee=page==='user-room.html';
    const ownerId=window.ScanSafeDB.session?.user?.id||null;
    const revision=++mapDbCache.revision;
    const current=()=>revision===mapDbCache.revision && (!isEvacuee || (
      ownerId && window.ScanSafeDB.session?.user?.id===ownerId &&
      evacueeLiveCache.ownerId===ownerId && window.ScanSafeDB.profile?.id===ownerId &&
      window.ScanSafeDB.profile?.role==='evacuee'
    ));
    if(!current()) return false;
    let data,error;
    try{
      // The shared map contains room counts only. Evacuees never query staff
      // assignment/group joins or rely on staff-only table SELECT policies.
      const result=isEvacuee?await sb.rpc('get_scansafe_map_availability'):
        await sb.from('accommodation_spaces')
          .select('space_id,space_code,space_name,space_type,capacity,current_occupancy,accessible,is_primary,status,shelter_id')
          .neq('status','inactive')
          .order('is_primary',{ascending:false})
          .order('space_code',{ascending:true});
      ({data,error}=result);
      if(error) throw error;
      if(!Array.isArray(data)) throw new Error('The map availability response is incomplete.');
      if(data.some(row=>!row || !row.space_code || row.capacity==null || row.current_occupancy==null ||
        !Number.isFinite(Number(row.capacity)) || !Number.isFinite(Number(row.current_occupancy)))){
        throw new Error('The map availability response is incomplete.');
      }
    }catch(error){
      if(!current()) return false;
      const missing=error.code==='PGRST202' || error.code==='42883' || /could not find.*function|function.*does not exist/i.test(error.message||'');
      mapDbCache.error=isEvacuee && missing
        ? 'Map availability needs the latest system update. Your assigned space is still shown.'
        : 'Map availability could not be refreshed. Showing the last confirmed space data.';
      console.warn('ScanSafe map sync:',error.message);
      return false;
    }
    if(!current()) return false;

    mapDbCache.spaces.clear();
    for(const row of data.filter(row=>row.status!=='inactive')){
      mapDbCache.spaces.set(row.space_code,row);
      syncSpaceIntoExistingMap(row);
    }
    mapDbCache.ready=true;
    mapDbCache.ownerId=ownerId;
    mapDbCache.availabilityState=mapDbCache.spaces.size?'ready':'empty';
    mapDbCache.error=null;

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
      if(adminLivePages.has(page)||isEvacueeAppPage()) return 0;
      return window.__scanSafePrototypeGetDynamicOccupancy ? window.__scanSafePrototypeGetDynamicOccupancy(id) : 0;
    };
    window.getSpaceStatus=function(id){
      const row=mapDbCache.spaces.get(id);
      if(row) return normalizeDbSpaceStatus(row);
      if(adminLivePages.has(page)||isEvacueeAppPage()) return 'full';
      return window.__scanSafePrototypeGetSpaceStatus ? window.__scanSafePrototypeGetSpaceStatus(id) : 'full';
    };
    window.getAvailableSlots=function(id){
      const row=mapDbCache.spaces.get(id);
      if(row) return Math.max(0,Number(row.capacity||0)-Number(row.current_occupancy||0));
      if(adminLivePages.has(page)||isEvacueeAppPage()) return 0;
      return window.__scanSafePrototypeGetAvailableSlots ? window.__scanSafePrototypeGetAvailableSlots(id) : 0;
    };

    if(typeof window.renderSpaces==='function') window.renderSpaces();
    if(page==='shelter-room.html'){
      installAdminMapMonitoring();
      await loadAdminMapOccupants();
      const selected=document.querySelector('[data-space].selected')?.dataset.space;
      if(selected) renderAdminMapSpaceDetail(selected);
    }
    if(typeof window.renderDashboardPrototype==='function') window.renderDashboardPrototype();
    if(isEvacueeAppPage()){
      renderLiveEvacueeAccount();
      if(typeof window.CustomEvent==='function') document.dispatchEvent(new CustomEvent('scansafe:evacuee-updated'));
    }
    return true;
  }

  async function loadEligibleDbGroups(){
    const sb=readyClient();
    if(!sb) return [];

    const [evRes,asgRes]=await Promise.all([
      sb.from('evacuees')
        .select('evacuee_id,group_id,registration_code,full_name,group_size,needs_summary,approval_status,current_status,barcodes(barcode_value,status)')
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
      if(!row.group_id || assigned.has(String(row.group_id)) || !qr || qr.status!=='active' || String(row.current_status||'').trim().toLowerCase()==='released') continue;
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
    if(hint) hint.textContent=`${available} slot${available===1?'':'s'} available. Only approved evacuees with active barcodes and no current assignment can be assigned.`;
    if(list){
      list.innerHTML=groups.length?groups.map(g=>{
        const fits=Number(g.group)<=available;
        const safeName=typeof esc==='function'?esc(g.name):g.name;
        const safeNeeds=typeof esc==='function'?esc(g.needs||'No special needs'):(g.needs||'No special needs');
        return `<div class="eligible-group ${fits?'':'ineligible'}"><div><b>${safeName}</b><small>Group size: ${g.group} • ${safeNeeds}</small></div><button class="btn ${fits?'red':'soft'}" ${fits?'':'disabled'} onclick="confirmSpaceAssignment('${spaceCode}','${g.id}')">${fits?'Assign':'Insufficient Slots'}</button></div>`;
      }).join(''):`<div class="space-placeholder">No eligible groups right now. Approve a registration and issue its barcode first, or verify that the group has no active assignment.</div>`;
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


  function setScanSafeText(el,value){
    if(!el) return;
    el.textContent=String(value??'');
  }

  const evacueeLiveCache={
    loaded:false,ownerId:null,evacuee:null,barcode:null,assignment:null,stay:null,
    space:null,shelter:null,error:null,warnings:[],updatedAt:null,
    barcodeError:false,assignmentError:false
  };
  let evacueeRefreshPromise=null;
  let evacueeSnapshotRpcUnavailable=false;
  let evacueeLiveTimer=null;
  let evacueeCooldownTimer=null;
  let evacueeLiveChannel=null;
  let evacueeLiveChannelOwner=null;

  function evacueeDate(value){
    if(!value) return 'Not recorded';
    const date=new Date(value);
    return Number.isNaN(date.getTime())?'Not recorded':date.toLocaleString();
  }

  function scheduleReadmissionReadyRefresh(stay){
    if(evacueeCooldownTimer){ clearTimeout(evacueeCooldownTimer); evacueeCooldownTimer=null; }
    const remaining=Math.max(0,Number(stay?.cooldown_remaining_seconds)||0);
    if(stay?.readmission_ready===true || remaining<=0) return;
    const delay=Math.min(2147483000,remaining*1000+1200);
    evacueeCooldownTimer=setTimeout(()=>{
      evacueeCooldownTimer=null;
      loadCurrentEvacueeIntoPrototype().catch(()=>{});
    },delay);
  }

  function resetEvacueeLiveAccount(ownerId=null){
    window.ScanSafeBarcodeViewer?.setAccount(null);
    if(evacueeCooldownTimer){ clearTimeout(evacueeCooldownTimer); evacueeCooldownTimer=null; }
    phase78NotifCache=[];
    localStorage.removeItem('scansafePrototypeStateV4');
    sessionStorage.removeItem('scansafePrototypeStateV4');
    Object.assign(evacueeLiveCache,{
      loaded:false,ownerId,evacuee:null,barcode:null,assignment:null,stay:null,
      space:null,shelter:null,error:null,warnings:[],updatedAt:null,
      barcodeError:false,assignmentError:false
    });
    if(typeof window.currentState==='function'){
      const state=window.currentState();
      state.user={requestId:null,id:null,authUserId:ownerId,name:'Evacuee',email:'',age:null,gender:'',group:null,needs:'',registrationStatus:'Loading',qrIssued:false,qrCode:null,assignment:null,checkedIn:false,submitted:''};
      state.requests=[];
      state.activity=[];
      state.demoGroups=[];
      state.demoAssignments={};
      window.saveScanSafeState(state);
    }
    mapDbCache.spaces.clear();
    mapDbCache.occupants.clear();
    mapDbCache.ready=false;
    mapDbCache.ownerId=ownerId;
    mapDbCache.availabilityState='unavailable';
    mapDbCache.error=null;
    mapDbCache.revision++;
    const spaceDetail=document.getElementById('spaceDetail');
    if(spaceDetail) spaceDetail.innerHTML='<div class="space-placeholder">Loading accommodation details...</div>';
    if(typeof window.closeUserMapViewer==='function') window.closeUserMapViewer();
    const thread=document.getElementById('thread');
    if(thread) thread.innerHTML='<div class="space-placeholder">Loading your messages...</div>';
    const input=document.getElementById('messageInput');
    if(input) input.value='';
    document.querySelectorAll('.msg-col .folder .muted').forEach(el=>setScanSafeText(el,'Loading your conversation...'));
    document.querySelectorAll('.notify-grid .tab').forEach((el,index)=>setScanSafeText(el,['All (--)', 'Unread (--)', 'Emergency (--)'][index]||'--'));
    document.querySelectorAll('.notif-item,.p78-empty-notif').forEach(el=>el.remove());
    const notification=document.getElementById('notifDetail');
    if(notification) notification.innerHTML='<div class="space-placeholder">Loading your notifications...</div>';
    const announcements=document.querySelector('.announcement-grid');
    if(announcements) announcements.innerHTML='<div class="space-placeholder">Loading announcements...</div>';
    document.querySelectorAll('.user-top .notif').forEach(el=>el.removeAttribute('data-unread-count'));
  }

  function renderShelterStayLifecycle(){
    const boxes=document.querySelectorAll('[data-user-stay-card]');
    if(!boxes.length) return;
    const cache=evacueeLiveCache,ev=cache.evacuee,stay=cache.stay||{};
    const loaded=cache.loaded,approved=loaded&&ev?.approval_status==='approved';
    const ready=loaded&&stay?.readmission_ready===true;
    const releasedRaw=loaded&&String(ev?.current_status||'').toLowerCase()==='released';
    const cooldown=loaded&&releasedRaw&&!ready;
    const active=loaded&&!releasedRaw&&!!stay?.arrival_time;
    const previous=stay?.previous_stay||(releasedRaw&&stay?.departure_time?{
      arrival_time:stay.arrival_time,departure_time:stay.departure_time,
      stay_duration_seconds:stay.stay_duration_seconds,space_name:stay.space_name
    }:null);

    let label='Loading shelter stay',copy='Retrieving your shelter-stay status.',badge='Loading',stateClass='is-waiting';
    let arrival='Not recorded',departure='Not recorded',duration='Not started',space='Not assigned';
    if(loaded){
      if(ready){
        label='Ready for Readmission';badge='Ready';stateClass='is-ready';
        copy='You have no active shelter stay. Your barcode remains available for staff-assisted readmission.';
        arrival='Not started';departure='--';duration='--';space='Not assigned';
      }else if(cooldown){
        label='Released / Cooldown';badge='Released';stateClass='is-released';
        const remaining=Math.max(0,Number(stay.cooldown_remaining_seconds||0));
        const hours=Math.floor(remaining/3600),minutes=Math.ceil((remaining%3600)/60);
        copy='Your shelter stay has ended. Readmission becomes available after the 12-hour cooldown'+(remaining?` (${hours?hours+'h ':''}${Math.max(1,minutes)}m remaining).`:'.');
        arrival=stay?.arrival_time?lifecycleDate(stay.arrival_time):'Not recorded';
        departure=stay?.departure_time?lifecycleDate(stay.departure_time):'Not recorded';
        duration=stay?.arrival_time?lifecycleDuration(stay.arrival_time,stay.departure_time,stay.stay_duration_seconds):'Not recorded';
        space=stay?.space_name||previous?.space_name||'Previous space recorded in history';
      }else if(active){
        label='Accommodated / Checked In';badge='Checked In';stateClass='is-active';
        copy='Your arrival is recorded and your current accommodation is active.';
        arrival=lifecycleDate(stay.arrival_time);departure='Not recorded';duration='In progress';
        space=stay?.space_name||cache.space?.space_name||cache.space?.space_code||'Assigned space';
      }else if(approved){
        label='Approved / Ready';badge='Approved';copy='Show your barcode to authorized staff when you arrive at the evacuation center.';
      }else if(ev?.approval_status==='rejected'){
        label='Registration Needs Correction';badge='Review';copy='Your shelter stay has not started.';
      }else{
        label='Pending Admin Approval';badge='Pending';copy='Check-in becomes available after approval and barcode issuance.';
      }
    }
    const previousMarkup=previous?`<div class="previous-stay-summary"><div class="previous-stay-head"><small>Previous Shelter Stay</small><span>Completed</span></div><div class="previous-stay-grid"><div><small>Arrival</small><b>${esc(previous.arrival_time?lifecycleDate(previous.arrival_time):'Not recorded')}</b></div><div><small>Departure</small><b>${esc(previous.departure_time?lifecycleDate(previous.departure_time):'Not recorded')}</b></div><div><small>Duration</small><b>${esc(previous.arrival_time?lifecycleDuration(previous.arrival_time,previous.departure_time,previous.stay_duration_seconds):'Not recorded')}</b></div><div><small>Previous Space</small><b>${esc(previous.space_name||'Not recorded')}</b></div></div></div>`:'';
    boxes.forEach(box=>{
      box.className='card card-pad stay-lifecycle-card '+stateClass;
      box.innerHTML=`<div class="stay-lifecycle-head"><div><small>Current Shelter Status</small><h3>${esc(label)}</h3><p>${esc(copy)}</p></div><span class="stay-lifecycle-badge">${esc(badge)}</span></div><div class="stay-lifecycle-grid"><div class="stay-lifecycle-metric"><small>Arrival Time</small><strong>${esc(arrival)}</strong></div><div class="stay-lifecycle-metric"><small>Departure Time</small><strong>${esc(departure)}</strong></div><div class="stay-lifecycle-metric"><small>Stay Duration</small><strong>${esc(duration)}</strong></div><div class="stay-lifecycle-metric"><small>Assigned Space</small><strong>${esc(space)}</strong></div></div>${previousMarkup}`;
    });
  }

  function renderLiveEvacueeAssignment(){
    const box=document.getElementById('userAssignmentSummary');
    if(!box) return;
    const {loaded,evacuee,assignment,space,shelter,assignmentError}=evacueeLiveCache;
    if(!loaded){
      box.innerHTML='<div class="space-placeholder">Loading accommodation...</div>';
    }else if(evacueeLiveCache.stay?.readmission_ready===true){
      box.innerHTML='<div class="space-placeholder"><b>No active accommodation</b><br>You are ready for staff-assisted readmission. A new space will be assigned after confirmation at the barcode scanner.</div>';
    }else if(String(evacuee?.current_status||'').trim().toLowerCase()==='released'){
      box.innerHTML='<div class="space-placeholder"><b>Shelter stay released</b><br>Your accommodation is closed and Request Needs is locked during the readmission cooldown.</div>';
    }else if(assignmentError && !assignment){
      box.innerHTML='<div class="space-placeholder">Accommodation could not be loaded. Use Refresh to try again.</div>';
    }else if(!assignment){
      box.innerHTML='<div class="space-placeholder"><b>No accommodation assignment yet</b><br>Authorized staff will assign a space after approval and barcode issuance.</div>';
    }else if(!space){
      box.innerHTML='<div class="space-placeholder">An accommodation has been assigned. Its details are currently unavailable.</div>';
    }else{
      const cap=Number(space.capacity||0),occ=Number(space.current_occupancy||0);
      box.innerHTML='<div class="assignment-state-grid"><div class="assignment-state-cell"><small>Your Assigned Space</small><strong>'+esc(space.space_name||space.space_code)+'</strong><span>'+esc(shelter?.shelter_name||'Assigned shelter')+'</span></div>'+[['Capacity',cap],['Occupied',occ],['Available',Math.max(0,cap-occ)]].map(([label,value])=>'<div class="assignment-state-cell"><small>'+label+'</small><strong>'+value+'</strong></div>').join('')+'</div>';
    }
  }

  function renderLiveEvacueeSpaces(){
    const box=document.getElementById('userSpaceList');
    if(!box) return;
    const rows=[...mapDbCache.spaces.values()].filter(row=>row.status!=='inactive');
    box.innerHTML=rows.length?rows.map(row=>'<div class="mobile-space-row"><div><b>'+esc(row.space_name||row.space_code)+'</b><small>'+Number(row.current_occupancy||0)+' / '+Number(row.capacity||0)+' occupied</small></div>'+statusPill(normalizeDbSpaceStatus(row))+'</div>').join(''):'<div class="space-placeholder">'+(mapDbCache.availabilityState==='empty'?'No active accommodation spaces are configured.':'Accommodation space data is unavailable. Use Refresh to try again.')+'</div>';
  }

  function selectLiveEvacueeSpace(id){
    const box=document.getElementById('spaceDetail');
    if(!box) return;
    document.querySelectorAll('[data-space]').forEach(el=>el.classList.toggle('selected',el.dataset.space===id));
    const row=mapDbCache.spaces.get(id);
    if(!evacueeLiveCache.loaded || !row){
      box.innerHTML='<div class="space-placeholder">'+(!evacueeLiveCache.loaded?'Loading accommodation details...':'This space has no available database record.')+'</div>';
      return;
    }
    const cap=Number(row.capacity||0),occ=Number(row.current_occupancy||0);
    box.innerHTML='<div class="room-banner"><div><h2>'+esc(row.space_name||row.space_code)+'</h2>'+statusPill(normalizeDbSpaceStatus(row))+'</div></div><div class="detail-list">'+[
      ['Space Type',row.space_type||'Accommodation'],['Capacity',cap],['Occupied',occ],['Available',Math.max(0,cap-occ)]
    ].map(([label,value])=>'<div class="detail-line"><b>'+label+'</b><span>'+esc(value)+'</span></div>').join('')+'</div>';
  }

  function selectLiveEvacueeViewerSpace(id,center=false){
    const row=evacueeLiveCache.loaded?mapDbCache.spaces.get(id):null;
    document.getElementById('userMapViewerCanvas')?.querySelectorAll('[data-space]').forEach(spot=>{
      spot.classList.toggle('viewer-selected-space',spot.dataset.space===id);
    });
    const mine=evacueeLiveCache.assignment && String(evacueeLiveCache.space?.space_code)===String(id);
    const status=row?normalizeDbSpaceStatus(row):'unavailable';
    const title=document.getElementById('viewerSpaceTitle');
    const meta=document.getElementById('viewerSpaceMeta');
    const badge=document.getElementById('viewerSpaceStatus');
    const eyebrow=document.getElementById('viewerSpaceEyebrow');
    if(eyebrow) eyebrow.textContent=mine?'Your Assigned Space':'Designated Accommodation Space';
    if(title) title.textContent=row?.space_name||row?.space_code||id;
    if(meta) meta.textContent=row?
      Number(row.current_occupancy)+' / '+Number(row.capacity)+' occupied / '+Math.max(0,Number(row.capacity)-Number(row.current_occupancy))+' available':
      (evacueeLiveCache.loaded?'Live availability is unavailable for this space. Use Refresh to try again.':'Loading accommodation details...');
    if(badge){
      badge.className='viewer-space-status '+status;
      badge.textContent=status==='available'?'Available':status==='near'?'Near Full':status==='full'?'Full':'Unavailable';
    }
    if(center && typeof window.centerUserMapOnSpace==='function') window.centerUserMapOnSpace(id);
  }

  function renderMissingRegistrationState(){
    const name=window.ScanSafeDB.profile?.full_name||window.ScanSafeDB.session?.user?.user_metadata?.full_name||window.ScanSafeDB.session?.user?.email||'Evacuee';
    const email=window.ScanSafeDB.session?.user?.email||'--',initial=String(name).trim().charAt(0).toUpperCase()||'E';
    const values={name,email,age:'--',gender:'--',group:'--',needs:'--',contact:'--',address:'--','emergency-contact':'--',status:'Incomplete','current-status':'--','registration-code':'--',id:'--',initial,shelter:'--',space:'--',capacity:'--',occupied:'--',available:'--',submitted:'--','approved-at':'--'};
    for(const [key,value] of Object.entries(values)) document.querySelectorAll('[data-user-'+key+']').forEach(el=>setScanSafeText(el,value));
    setScanSafeText(document.querySelector('.user-top .identity strong'),name);
    document.querySelectorAll('.user-top .avatar,.mobile-avatar,.profile-avatar,.avatar-circle,.identity-avatar').forEach(el=>{if(el.children.length===0)setScanSafeText(el,initial);});
    const action='<button type="button" class="btn red" onclick="ScanSafeCompleteRegistration()">Complete Registration</button>';
    const hero=document.getElementById('userStatusHero'); if(hero) hero.innerHTML='<section class="status-hero pending"><div><small>Registration Status</small><h2>Complete your registration</h2><p>Your login account is active, but no linked evacuee registration was found. Complete the registration so the admin can review it.</p></div><div class="hero-status-mark">!</div></section>';
    const barcode='<div class="space-placeholder"><b>Barcode not available yet</b><br>Complete registration first. Barcode issuance still requires admin approval.</div>';
    const qr=document.getElementById('userQrCard'); if(qr) qr.innerHTML='<div class="app-status-icon">&#9638;</div><h3>My Barcode</h3>'+barcode;
    const barcodeCard=document.querySelector('.barcode-card'); if(barcodeCard) barcodeCard.innerHTML='<h3 class="section-h">'+ico('barcode')+' Evacuee Barcode</h3>'+barcode;
    const acc=document.getElementById('userAccommodationCard'); if(acc) acc.innerHTML='<div class="app-status-icon">'+ico('bed')+'</div><h3>Accommodation</h3><div class="app-value">Not assigned</div><p>Complete registration and wait for admin approval before accommodation assignment.</p>';
    const latest=document.getElementById('userLatestCard'); if(latest) latest.innerHTML='<div class="app-status-icon">&#9679;</div><h3>Latest Update</h3><div class="app-value">Registration incomplete</div><p>Your authenticated account needs a linked evacuee registration.</p>';
    const progress=document.getElementById('userProgressSteps'); if(progress) progress.innerHTML=[['Submitted','Pending'],['Approved','Pending'],['Accommodated','Pending'],['Released','Pending']].map(([label,state],i)=>'<div class="progress-step '+(i===0?'active':'')+'"><i>'+(i+1)+'</i><b>'+label+'</b><small>'+state+'</small></div>').join('');
    const members=document.getElementById('userGroupMembersBody'); if(members) members.innerHTML='<tr><td colspan="7">Complete registration to load group information.</td></tr>';
    const timeline=document.getElementById('userRegistrationTimeline'); if(timeline) timeline.innerHTML='<div class="muted">No registration history yet.</div>';
    const dataStatus=document.getElementById('evacueeDataStatus'); if(dataStatus){dataStatus.setAttribute('role','alert');dataStatus.innerHTML='<span>Your account is signed in, but the evacuee registration is incomplete.</span> '+action;}
    const assignment=document.getElementById('userAssignmentState'); if(assignment) assignment.innerHTML='<div class="space-placeholder"><b>No registration yet</b><br>Complete your registration before accommodation can be assigned.</div>';
    const detail=document.getElementById('spaceDetail'); if(detail) detail.innerHTML='<div class="space-placeholder">Complete registration to view your accommodation details.</div>';
  }

  function renderLiveEvacueeAccount(){
    if(!isEvacueeAppPage()) return;
    const cache=evacueeLiveCache,ev=cache.evacuee;
    if(cache.loaded&&!ev){ renderMissingRegistrationState(); return; }
    const user=window.currentState?.().user||{};
    const loaded=cache.loaded,approved=loaded && ev?.approval_status==='approved';
    const rejected=loaded && ev?.approval_status==='rejected';
    const releasedRaw=loaded && String(ev?.current_status||'').trim().toLowerCase()==='released';
    const readyForReadmission=loaded && cache.stay?.readmission_ready===true;
    const released=loaded && releasedRaw && !readyForReadmission;
    if(loaded && releasedRaw) scheduleReadmissionReadyRefresh(cache.stay);
    const hasBarcode=approved && !!cache.barcode?.barcode_value;
    window.ScanSafeBarcodeViewer?.setAccount(hasBarcode?{
      ownerId:cache.ownerId,value:cache.barcode.barcode_value
    }:null);
    const accommodated=loaded && !releasedRaw && !!cache.stay?.arrival_time;
    const status=loaded?(readyForReadmission?'Ready for Readmission':released?'Released / Cooldown':accommodated?'Accommodated / Checked In':approved?'Approved / Ready':rejected?'Rejected':'Pending Approval'):(cache.error?'Unavailable':'Loading');
    const name=loaded?ev.full_name||'Evacuee':window.ScanSafeDB.profile?.full_name||'Evacuee';
    const display=(value,fallback='Not provided')=>value==null||value===''?fallback:value;
    const assigned=loaded && !releasedRaw && !!cache.assignment;
    const fields={
      name,email:loaded?display(ev.email||window.ScanSafeDB.session?.user?.email):'--',
      age:loaded?display(ev.age):'--',gender:loaded?display(ev.gender):'--',
      group:loaded?display(ev.group_size):'--',needs:loaded?display(ev.needs_summary,'None'):'--',
      contact:loaded?display(ev.contact_number):'--',address:loaded?display(ev.address):'--',
      'emergency-contact':loaded?display(ev.emergency_contact):'--',
      status,'current-status':loaded?status:'--',
      'registration-code':loaded?display(ev.registration_code):'--',id:loaded?user.id||'--':'--',
      initial:name.trim().charAt(0).toUpperCase()||'E',
      shelter:!loaded?'--':readyForReadmission?'No active shelter stay':released?'Shelter stay ended':cache.assignmentError&&!assigned?'Unavailable':assigned?cache.shelter?.shelter_name||'Assigned shelter details unavailable':'Waiting for assignment',
      space:!loaded?'--':readyForReadmission?'Not assigned':released?'Accommodation released':cache.assignmentError&&!assigned?'Unavailable':assigned?cache.space?.space_name||cache.space?.space_code||'Assigned space details unavailable':'Not assigned yet',
      capacity:assigned&&cache.space?Number(cache.space.capacity||0):'--',
      occupied:assigned&&cache.space?Number(cache.space.current_occupancy||0):'--',
      available:assigned&&cache.space?Math.max(0,Number(cache.space.capacity||0)-Number(cache.space.current_occupancy||0)):'--',
      submitted:loaded?evacueeDate(ev.registered_at):'--',
      'approved-at':loaded?evacueeDate(ev.approved_at):'--'
    };
    for(const [key,value] of Object.entries(fields)){
      document.querySelectorAll('[data-user-'+key+']').forEach(el=>setScanSafeText(el,value));
    }
    setScanSafeText(document.querySelector('.user-top .identity strong'),name);
    document.querySelectorAll('.user-top .avatar,.mobile-avatar,.profile-avatar,.avatar-circle,.identity-avatar').forEach(el=>{
      if(el.children.length===0) setScanSafeText(el,fields.initial);
    });
    const hero=document.getElementById('userStatusHero');
    if(hero){
      const title=!loaded?(cache.error?'Registration unavailable':'Loading registration...'):readyForReadmission?'Ready for Readmission':released?'Shelter Stay Released':accommodated?'Accommodated / Checked In':approved?'Approved / Ready':rejected?'Registration Needs Correction':'Pending Admin Approval';
      const text=!loaded?'Your registration status is being retrieved from the database.':readyForReadmission?'Your previous stay is complete. You have no active accommodation. Show your barcode to staff if you need a new shelter stay.':released?'Your departure has been recorded. Request Needs and accommodation access remain inactive during the 12-hour cooldown.':accommodated?'Your arrival has been recorded. Your assigned accommodation is active for the current shelter stay.':hasBarcode?'Your barcode is ready. Staff will scan it when you arrive at the evacuation center.':approved?(cache.barcodeError?'Your registration is approved. The barcode could not be loaded. Use Refresh to try again.':'Your registration is approved, but no active barcode has been issued. Refresh first, then report the issue through Messages if needed.'):rejected?'Use Messages to report a registration correction.':'Your registration is waiting for administrator review.';
      hero.innerHTML='<section class="status-hero '+(approved?'approved':rejected?'rejected':'pending')+'"><div><small>'+(released?'Shelter Status':'Registration Status')+'</small><h2>'+esc(title)+'</h2><p>'+esc(text)+'</p></div><div class="hero-status-mark">'+(approved?'&#10003;':rejected?'!':'...')+'</div></section>';
    }
    const barcodeBody=hasBarcode?'<p>'+(readyForReadmission?'Your barcode is active and ready for staff-assisted readmission.':released?'Your barcode remains linked to your account during the cooldown.':'Your issued barcode is ready for scanning or printing.')+'</p><button type="button" class="btn red full" data-show-barcode onclick="ScanSafeBarcodeViewer.open()">Show Barcode</button>':'<div class="space-placeholder"><b>'+(!loaded?'Loading barcode...':cache.barcodeError?'Barcode temporarily unavailable':approved?'Barcode not issued yet':rejected?'No active barcode':'Awaiting admin approval')+'</b><br>'+(!loaded?'Retrieving your account record.':cache.barcodeError?'Use Refresh to try again.':approved?'Use Refresh; if it remains unavailable, report the issue through Messages.':'A barcode is issued after your registration is approved.')+'</div>';
    const qr=document.getElementById('userQrCard');
    if(qr) qr.innerHTML='<div class="app-status-icon">&#9638;</div><h3>My Barcode</h3>'+barcodeBody;
    const barcodeCard=document.querySelector('.barcode-card');
    if(barcodeCard) barcodeCard.innerHTML='<h3 class="section-h">'+ico('barcode')+' Evacuee Barcode</h3>'+barcodeBody;
    const acc=document.getElementById('userAccommodationCard');
    if(acc) acc.innerHTML='<div class="app-status-icon">'+ico('bed')+'</div><h3>Accommodation</h3><div class="app-value">'+esc(fields.space)+'</div><p>'+esc(readyForReadmission?'No active accommodation. Staff can start a new shelter stay after scanning your barcode.':released?'Your previous shelter stay has ended. Accommodation remains inactive during cooldown.':assigned?fields.shelter:'Accommodation will be assigned automatically during staff check-in.')+'</p>';
    const latest=document.getElementById('userLatestCard');
    if(latest){
      const title=!loaded?'Loading updates...':readyForReadmission?'Ready for readmission':released?'Shelter stay released':user.checkedIn?'Check-in confirmed':assigned?'Accommodation assigned':hasBarcode?'Barcode issued':approved?'Registration approved':rejected?'Registration needs correction':'Registration submitted';
      latest.innerHTML='<div class="app-status-icon">&#9679;</div><h3>Latest Update</h3><div class="app-value">'+esc(title)+'</div><p>'+esc(cache.error?'Refresh failed. Showing the last confirmed account data.':readyForReadmission?'Your previous stay is in history. You currently have no active accommodation.':released?'Your previous accommodation is closed and the readmission cooldown is active.':loaded?evacueeDate(ev.approved_at||ev.registered_at):'Retrieving your registration.')+'</p>';
    }
    const progress=document.getElementById('userProgressSteps');
    if(progress){
      const steps=[
        ['Submitted',loaded,'Registration received'],
        ['Approved',approved,'Admin approval'],
        ['Accommodated',accommodated||released,'Checked in'],
        ['Released',released,'Stay ended']
      ];
      let firstPending=false;
      progress.innerHTML=steps.map(([label,done,caption],index)=>{
        const active=loaded&&!done&&!firstPending; if(active) firstPending=true;
        return '<div class="progress-step '+(done?'done':active?'active':'')+'"><i>'+(done?'&#10003;':index+1)+'</i><b>'+label+'</b><small>'+(!loaded?'Loading':done?caption:rejected?'Not completed':'Pending')+'</small></div>';
      }).join('');
    }
    const members=document.getElementById('userGroupMembersBody');
    if(members) members.innerHTML=loaded?'<tr><td>1</td><td>'+esc(name)+'</td><td>'+esc(fields.age)+'</td><td>'+esc(fields.gender)+'</td><td>Registrant</td><td>'+esc(status)+'</td><td>--</td></tr>'+(Number(ev.group_size)>1?'<tr><td colspan="7">Individual details for the other group members have not been recorded.</td></tr>':''):'<tr><td colspan="7">Loading registration details...</td></tr>';
    const timeline=document.getElementById('userRegistrationTimeline');
    if(timeline){
      const events=loaded?[
        ['Information Submitted',ev.registered_at],
        ['Registration Approved',approved?ev.approved_at:null],
        ['Arrival / Check-In',cache.stay?.arrival_time||cache.stay?.previous_stay?.arrival_time||null],
        ['Released / Departure',cache.stay?.departure_time||cache.stay?.previous_stay?.departure_time||null]
      ]:[];
      const recorded=events.filter(([,date])=>date);
      timeline.innerHTML=recorded.length?recorded.map(([label,date])=>'<div class="timeline-row"><span class="timeline-dot">&#10003;</span><div><b>'+esc(label)+'</b><div class="muted">'+esc(evacueeDate(date))+'</div></div></div>').join(''):'<div class="muted">'+(loaded?'No dated registration events have been recorded.':'Loading registration history...')+'</div>';
    }
    renderShelterStayLifecycle();
    renderLiveEvacueeAssignment();
    renderLiveEvacueeSpaces();
    const selectedSpace=document.querySelector('[data-space].selected')?.dataset.space;
    if(selectedSpace) selectLiveEvacueeSpace(selectedSpace);
    const dataStatus=document.getElementById('evacueeDataStatus');
    if(dataStatus){
      const message=cache.error?(loaded?'Refresh failed. Showing the last confirmed data. ':'Could not load your registration. ')+cache.error:loaded?'Live database - Updated '+new Date(cache.updatedAt).toLocaleTimeString()+(cache.warnings.length?' - '+cache.warnings.join(' '):''):'Loading your account from the database...';
      dataStatus.setAttribute('role',cache.error?'alert':'status');
      dataStatus.innerHTML='<span>'+esc(message)+'</span> <button class="btn out" type="button" onclick="ScanSafeRealUser.refresh()">Refresh</button>';
    }
  }

  async function openLiveEvacueeBarcode(){
    if(!evacueeLiveCache.loaded) await loadCurrentEvacueeIntoPrototype();
    if(!evacueeLiveCache.loaded){
      if(typeof toast==='function') toast('Your barcode could not be loaded. Use Refresh to try again.');
      return false;
    }
    return window.ScanSafeBarcodeViewer?window.ScanSafeBarcodeViewer.open():false;
  }

  async function readOwnEvacueeSnapshot(sb,ownerId){
    if(!evacueeSnapshotRpcUnavailable){
      const {data,error}=await sb.rpc('get_my_scansafe_account');
      if(error){
        if(error.code==='PGRST202'||error.code==='42883'||/could not find.*function|function.*does not exist/i.test(error.message||'')) evacueeSnapshotRpcUnavailable=true;
        else throw error;
      }else{
        if(!data || !Object.prototype.hasOwnProperty.call(data,'evacuee')) throw new Error('Invalid account response.');
        let stay=data.stay||null;
        const warnings=[];
        if(!stay){
          try{
            const stayResult=await sb.rpc('get_my_scansafe_stay');
            if(stayResult.error){
              const missing=stayResult.error.code==='PGRST202'||stayResult.error.code==='42883'||/could not find.*get_my_scansafe_stay|function.*does not exist/i.test(stayResult.error.message||'');
              if(!missing) warnings.push('Shelter-stay history could not be loaded.');
            }else stay=stayResult.data||null;
          }catch(error){
            console.warn('ScanSafe shelter-stay snapshot:',error?.message||error);
          }
        }
        return {...data,stay,warnings,barcodeError:false,assignmentError:false};
      }
    }
    const {data:ev,error}=await sb.from('evacuees').select('*').eq('auth_user_id',ownerId).maybeSingle();
    if(error) throw error;
    if(!ev) return {evacuee:null};
    const warnings=[];
    const [barcodeResult,assignmentResult]=await Promise.allSettled([
      ev.approval_status==='approved'?sb.from('barcodes').select('barcode_value,status,evacuee_id').eq('evacuee_id',ev.evacuee_id).eq('status','active').limit(1).maybeSingle():Promise.resolve({data:null,error:null}),
      ev.group_id?sb.from('accommodation_assignments').select('space_id,assigned_at,group_id,assignment_status').eq('group_id',ev.group_id).eq('assignment_status','active').order('assigned_at',{ascending:false}).limit(1).maybeSingle():Promise.resolve({data:null,error:null})
    ]);
    const unwrap=(result,label)=>{
      if(result.status==='rejected'||result.value.error){
        warnings.push(label+' could not be loaded.');
        return {data:null,error:true};
      }
      return {data:result.value.data,error:false};
    };
    const barcode=unwrap(barcodeResult,'Barcode'),assignment=unwrap(assignmentResult,'Accommodation');
    let space=null,shelter=null;
    if(assignment.data?.space_id){
      try{
        const result=await sb.from('accommodation_spaces').select('*').eq('space_id',assignment.data.space_id).maybeSingle();
        if(result.error) throw result.error;
        space=result.data;
      }catch(error){ warnings.push('Assigned space details could not be loaded.'); }
      if(space?.shelter_id){
        try{
          const result=await sb.from('shelters').select('*').eq('shelter_id',space.shelter_id).maybeSingle();
          if(result.error) throw result.error;
          shelter=result.data;
        }catch(error){ warnings.push('Assigned shelter details could not be loaded.'); }
      }
    }
    let stay=null;
    try{
      const stayResult=await sb.rpc('get_my_scansafe_stay');
      if(stayResult.error){
        const missing=stayResult.error.code==='PGRST202'||stayResult.error.code==='42883'||/could not find.*get_my_scansafe_stay|function.*does not exist/i.test(stayResult.error.message||'');
        if(!missing) warnings.push('Shelter-stay history could not be loaded.');
      }else stay=stayResult.data||null;
    }catch(_){ warnings.push('Shelter-stay history could not be loaded.'); }
    return {evacuee:ev,barcode:barcode.data,assignment:assignment.data,stay,space,shelter,warnings,barcodeError:barcode.error,assignmentError:assignment.error};
  }

  async function performEvacueeLiveRefresh(){
    const sb=readyClient();
    let ownerId=evacueeLiveCache.ownerId;
    try{
      if(!sb) throw new Error('The database connection is unavailable. Reload and try again.');
      const {data,error}=await sb.auth.getSession();
      if(error) throw error;
      const session=data?.session;
      ownerId=session?.user?.id||null;
      if(evacueeLiveCache.ownerId!==ownerId){
        if(window.ScanSafeDB.profile?.id!==ownerId) window.ScanSafeDB.profile=null;
        resetEvacueeLiveAccount(ownerId);
        renderLiveEvacueeAccount();
      }
      window.ScanSafeDB.session=session||null;
      if(!ownerId) throw new Error('Sign in to view your evacuee registration.');
      const profile=window.ScanSafeDB.profile?.id===ownerId?window.ScanSafeDB.profile:await getProfile(ownerId);
      if(profile?.role!=='evacuee') throw new Error('An evacuee account is required.');
      let snapshot=await readOwnEvacueeSnapshot(sb,ownerId);
      if(window.ScanSafeDB.session?.user?.id!==ownerId || evacueeLiveCache.ownerId!==ownerId) return null;
      let ev=snapshot.evacuee;
      if(!ev){ const recovery=await repairMyRegistrationLink(sb); if(recovery?.status==='repaired'||recovery?.status==='linked'){ snapshot=await readOwnEvacueeSnapshot(sb,ownerId); ev=snapshot.evacuee; } }
      if(!ev){
        resetEvacueeLiveAccount(ownerId);
        Object.assign(evacueeLiveCache,{loaded:true,ownerId,evacuee:null,barcode:null,assignment:null,stay:null,space:null,shelter:null,error:null,warnings:[],updatedAt:new Date().toISOString()});
        const missingState=window.currentState();
        missingState.user={...missingState.user,authUserId:ownerId,name:profile.full_name||session.user.user_metadata?.full_name||'Evacuee',email:session.user.email||'',registrationStatus:'Incomplete',qrIssued:false,qrCode:null,assignment:null,checkedIn:false};
        window.saveScanSafeState(missingState);
        rememberRegistrationCompletion(session.user,profile); renderLiveEvacueeAccount(); return null;
      }
      if(ev.auth_user_id!==ownerId){
        resetEvacueeLiveAccount(ownerId);
        throw new Error('The registration does not belong to the signed-in account.');
      }
      const approved=ev.approval_status==='approved';
      const barcode=approved && snapshot.barcode?.status==='active' &&
        (snapshot.barcode.evacuee_id==null || String(snapshot.barcode.evacuee_id)===String(ev.evacuee_id))?snapshot.barcode:null;
      Object.assign(evacueeLiveCache,{...snapshot,barcode,loaded:true,ownerId,error:null,updatedAt:new Date().toISOString()});
      const state=window.currentState();
      state.user={
        authUserId:ownerId,requestId:ev.registration_code||null,id:'EV-'+String(ev.evacuee_id).padStart(3,'0'),dbId:ev.evacuee_id,dbGroupId:ev.group_id,
        name:ev.full_name||profile.full_name||'Evacuee',email:ev.email||session.user.email||'',age:ev.age??null,gender:ev.gender||'',group:Number(ev.group_size||1),needs:ev.needs_summary||'None',
        registrationStatus:approved?'Approved':ev.approval_status==='rejected'?'Rejected':'Pending Approval',qrIssued:!!barcode?.barcode_value,qrCode:barcode?.barcode_value||null,
        assignment:ev.current_status==='released'?null:snapshot.space?.space_code||null,checkedIn:String(ev.current_status||'').toLowerCase()!=='released' && (!!snapshot.stay?.arrival_time || String(ev.current_status||'').toLowerCase()==='checked_in'),currentStatus:ev.current_status||'',submitted:ev.registered_at||''
      };
      state.requests=[];state.activity=[];state.demoGroups=[];state.demoAssignments={};
      window.saveScanSafeState(state);
      if(snapshot.space?.space_code){mapDbCache.spaces.set(snapshot.space.space_code,snapshot.space);syncSpaceIntoExistingMap(snapshot.space);mapDbCache.ready=true;mapDbCache.ownerId=ownerId;}
      renderLiveEvacueeAccount();
      setupEvacueeLiveChannel(sb,ev);
      if(typeof window.CustomEvent==='function') document.dispatchEvent(new CustomEvent('scansafe:evacuee-updated'));
      return state.user;
    }catch(error){
      console.warn('ScanSafe evacuee account:',error);
      if(evacueeLiveCache.ownerId===ownerId){
        evacueeLiveCache.error=error.message||'Check your connection and account permissions.';
        renderLiveEvacueeAccount();
      }
      return null;
    }
  }

  function loadCurrentEvacueeIntoPrototype(){
    if(!isEvacueeAppPage()) return Promise.resolve(null);
    if(!evacueeRefreshPromise){
      evacueeRefreshPromise=(async()=>{
        const result=await performEvacueeLiveRefresh();
        if(result && mapPage()==='user-room.html'){
          const ownerId=evacueeLiveCache.ownerId;
          try{
            if(!(await loadAccommodationState())) throw new Error('Map refresh failed');
          }catch(error){
            if(ownerId && evacueeLiveCache.ownerId===ownerId && window.ScanSafeDB.session?.user?.id===ownerId){
              const warning=mapDbCache.error||'Map availability could not be refreshed. Showing the last confirmed space data.';
              if(!evacueeLiveCache.warnings.includes(warning)) evacueeLiveCache.warnings.push(warning);
              renderLiveEvacueeAccount();
            }
          }
        }
        return result;
      })().finally(()=>{evacueeRefreshPromise=null;});
    }
    return evacueeRefreshPromise;
  }

  function setupEvacueeLiveChannel(sb,ev){
    if(typeof sb.channel!=='function'||evacueeLiveChannelOwner===ev.auth_user_id) return;
    if(evacueeLiveChannel && typeof sb.removeChannel==='function') sb.removeChannel(evacueeLiveChannel);
    evacueeLiveChannelOwner=ev.auth_user_id;
    evacueeLiveChannel=sb.channel('scansafe-own-account-'+ev.auth_user_id)
      .on('postgres_changes',{event:'*',schema:'public',table:'evacuees',filter:'auth_user_id=eq.'+ev.auth_user_id},()=>loadCurrentEvacueeIntoPrototype())
      .on('postgres_changes',{event:'*',schema:'public',table:'barcodes',filter:'evacuee_id=eq.'+ev.evacuee_id},()=>loadCurrentEvacueeIntoPrototype());
    if(ev.group_id){
      evacueeLiveChannel
        .on('postgres_changes',{event:'*',schema:'public',table:'accommodation_assignments',filter:'group_id=eq.'+ev.group_id},()=>loadCurrentEvacueeIntoPrototype())
        .on('postgres_changes',{event:'*',schema:'public',table:'scansafe_operation_stays',filter:'group_id=eq.'+ev.group_id},()=>loadCurrentEvacueeIntoPrototype());
    }
    evacueeLiveChannel.subscribe();
  }


  async function reviewRegistrationWithMedia(requestId){
    const original=window.__scanSafePrototypeReview;
    if(typeof original==='function') original(requestId);

    const state=typeof window.currentState==='function'?window.currentState():null;
    const req=state?.requests?.find(row=>String(row.id)===String(requestId));
    const target=document.getElementById('reviewDetails');
    if(!req?.dbId || !target) return;

    if(!window.ScanSafeMedia?.showRegistrationReview){
      const note=document.createElement('div');
      note.className='space-placeholder';
      note.textContent='Registration image review is not loaded. Refresh this page and try again.';
      target.appendChild(note);
      return;
    }

    await window.ScanSafeMedia.showRegistrationReview({
      evacueeId:req.dbId,
      container:target
    });
  }

  document.addEventListener('DOMContentLoaded', async function(){
    // Capture the current prototype functions first, then override only behavior.
    window.__scanSafePrototypeLogin = window.loginDemo;
    window.__scanSafePrototypeRegister = window.registerPublicEvacuee;
    window.__scanSafePrototypeApprove = window.approveRegistration;
    window.__scanSafePrototypeReject = window.rejectRegistration;
    window.__scanSafePrototypeReview = window.reviewRegistration;
    window.__scanSafePrototypeAssignSpace = window.assignSpace;
    window.__scanSafePrototypeConfirmSpaceAssignment = window.confirmSpaceAssignment;

    window.loginDemo = supabaseLogin;
    window.registerPublicEvacuee = submitPublicRegistration;
    window.logout = supabaseLogout;
    window.approveRegistration = approveByRequestId;
    window.rejectRegistration = rejectByRequestId;
    window.reviewRegistration = reviewRegistrationWithMedia;
    window.assignSpace = assignSpaceFromDatabase;
    window.confirmSpaceAssignment = confirmSpaceAssignmentDatabase;

    await bootstrapSession();
    if(await configureRegistrationCompletionMode()) return;
    if(!(await phase9AccessGuard())) return;

    if(mapPage()==='profile.html'){
      try{history.scrollRestoration='manual';}catch(_){}
      requestAnimationFrame(()=>window.scrollTo({top:0,left:0,behavior:'auto'}));
    }

    const operationsOwner=window.ScanSafeDB.session?.user?.id;
    document.querySelectorAll('[data-operations-link]').forEach(link=>{
      link.hidden=!(operationsOwner && window.ScanSafeDB.profile?.id===operationsOwner && window.ScanSafeDB.profile.role==='admin');
    });
    if(window.ScanSafeOperations){
      Promise.resolve(window.ScanSafeOperations.init({
        getClient:readyClient,
        getContext:()=>({userId:window.ScanSafeDB.session?.user?.id,role:window.ScanSafeDB.profile?.role,profile:window.ScanSafeDB.profile}),
        refresh:()=>Promise.allSettled([loadAccommodationState(),loadAdminLiveSnapshot(),window.ScanSafeNeeds?.refresh()])
      })).catch(error=>console.warn('ScanSafe operations:',error.message));
    }
    if(window.ScanSafeNeeds){
      Promise.resolve(window.ScanSafeNeeds.init({
        getClient:readyClient,
        getContext:()=>({userId:window.ScanSafeDB.session?.user?.id,role:window.ScanSafeDB.profile?.role,profile:window.ScanSafeDB.profile})
      })).catch(error=>console.warn('ScanSafe needs requests:',error.message));
    }
    const liveModuleContext=()=>({
      userId:window.ScanSafeDB.session?.user?.id||null,
      role:window.ScanSafeDB.profile?.role||null,
      profile:window.ScanSafeDB.profile||null
    });
    if(window.ScanSafeMedia){
      Promise.resolve(window.ScanSafeMedia.init({
        getClient:readyClient,
        getContext:liveModuleContext
      })).catch(error=>console.warn('ScanSafe account media:',error.message));
    }
    if(window.ScanSafeNotifications){
      Promise.resolve(window.ScanSafeNotifications.init({
        getClient:readyClient,
        getContext:liveModuleContext
      })).catch(error=>console.warn('ScanSafe notifications:',error.message));
    }
    await loadPendingIntoPrototype();
    await loadCurrentEvacueeIntoPrototype();
    if(!isEvacueeAppPage()) await loadAccommodationState();
    if(isEvacueeAppPage()) renderLiveEvacueeAccount();
    if(mapPage()==='user-portal.html' && window.ScanSafeAppPromo){
      window.ScanSafeAppPromo.init({
        getContext:()=>{
          const ownerId=window.ScanSafeDB.session?.user?.id;
          const profile=window.ScanSafeDB.profile;
          return {ownerId,role:ownerId && profile?.id===ownerId?profile.role:null};
        }
      });
    }
  });

  // Scanner verification and GBEAA allocation use one staff-only server RPC.
  function scannerPageActive(){return mapPage()==='barcode-scanner.html';}
  function scanEsc(value){return adminLiveEsc(value);}
  async function loadRecentScanHistory(){
    const sb=readyClient();
    const table=document.querySelector('#scannerHistory');
    if(!sb || !scannerPageActive() || !table) return;
    const ownerId=window.ScanSafeDB.session?.user?.id,role=window.ScanSafeDB.profile?.role;
    const revision=window.ScanSafeScanner?.inspect().revision;
    const current=()=>window.ScanSafeDB.session?.user?.id===ownerId && window.ScanSafeDB.profile?.role===role && window.ScanSafeScanner?.inspect().revision===revision;
    if(!ownerId || !['admin','staff'].includes(role)) return;
    const head='<tr><th>#</th><th>Name</th><th>Barcode</th><th>Space</th><th>Time</th><th>Verification</th></tr>';
    try{
      const {data,error}=await sb.rpc('get_recent_scan_history',{p_limit:10});
      if(!current()) return;
      if(error) throw error;
      table.innerHTML=head+((data||[]).map((r,i)=>'<tr><td>'+(i+1)+'</td><td>'+scanEsc(r.full_name||'Unknown')+'</td><td>'+scanEsc(r.qr_value||'')+'</td><td>'+scanEsc(r.space_code||'Not assigned')+'</td><td>'+scanEsc(r.scanned_at?new Date(r.scanned_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'')+'</td><td>'+scanEsc(r.scan_result||'')+'</td></tr>').join('')||'<tr><td colspan="6">No scans yet.</td></tr>');
    }catch(error){if(current()) table.innerHTML=head+'<tr><td colspan="6">Scan history is unavailable. '+scanEsc(error.message||'Try again.')+'</td></tr>';}
  }
  function initScanSafeScanner(){
    if(!window.ScanSafeScanner) return;
    window.ScanSafeScanner.init({
      getClient:readyClient,
      getContext:()=>({userId:window.ScanSafeDB.session?.user?.id,role:window.ScanSafeDB.profile?.role}),
      refresh:()=>Promise.allSettled([loadRecentScanHistory(),loadAccommodationState(),loadAdminLiveSnapshot()])
    });
    window.scanNow=()=>window.ScanSafeScanner.toggle();
    window.manualScan=()=>window.ScanSafeScanner.manual();
  }

  // =========================================================
  // Phase 6: Installable Evacuee PWA
  // Uses the existing user portal/pages and does not redesign them.
  // =========================================================
  function isEvacueeAppPage(){
    return [
      'user-portal.html','my-information.html','user-room.html',
      'user-notifications.html','user-messages.html','profile.html','user-needs.html'
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
      await bootstrapSession();
      initScanSafeScanner();
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

    const ownerId=window.ScanSafeDB.session?.user?.id;
    const {data,error}=await sb.rpc('get_my_scansafe_notifications');
    if(window.ScanSafeDB.session?.user?.id!==ownerId) return;
    if(error){ console.warn('Notifications:',error.message); return; }

    phase78NotifCache=Array.isArray(data)?data:[];
    const list=document.querySelector('.notify-grid > section:first-child');
    if(!list) return;

    list.querySelectorAll('.notif-item,.p78-empty-notif').forEach(el=>el.remove());

    const unread=phase78NotifCache.filter(n=>!n.is_read).length;
    document.querySelectorAll('.user-top .notif').forEach(el=>el.setAttribute('data-unread-count',String(unread)));
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
    const ownerId=window.ScanSafeDB.session?.user?.id;
    const {data,error}=await sb.rpc('get_my_admin_thread');
    if(window.ScanSafeDB.session?.user?.id!==ownerId) return;
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
    'messages.html','reports.html','user-management.html','settings.html','needs-requests.html'
  ]);
  const phase9EvacueePages=new Set([
    'user-portal.html','my-information.html','user-room.html',
    'user-notifications.html','user-messages.html','profile.html','user-needs.html'
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
    sb.auth.onAuthStateChange((event,session)=>{
      window.ScanSafeDB.session=session||null;
      if(event==='SIGNED_OUT'){
        window.ScanSafeOperations?.reset();
        document.querySelectorAll('[data-operations-link]').forEach(link=>{link.hidden=true;});
        window.ScanSafeAppPromo?.reset();
        window.ScanSafeDB.profile=null;
        localStorage.removeItem('scanSafeLoginRole');
        localStorage.removeItem('scansafePrototypeStateV4');
        localStorage.removeItem('scansafeLiveStateV1');
        if(isEvacueeAppPage()){
          resetEvacueeLiveAccount();
          renderLiveEvacueeAccount();
        }
        sessionStorage.removeItem('scansafePrototypeStateV4');
        const page=mapPage();
        if(phase9StaffPages.has(page)||phase9EvacueePages.has(page)) location.replace('index.html');
      }else if(session?.user){
        if(isEvacueeAppPage() && evacueeLiveCache.ownerId!==session.user.id){
          window.ScanSafeDB.profile=null;
          resetEvacueeLiveAccount(session.user.id);
          renderLiveEvacueeAccount();
        }
        // Auth callbacks must finish before another Supabase request starts.
        setTimeout(async()=>{
          await getProfile(session.user.id);
          document.querySelectorAll('[data-operations-link]').forEach(link=>{
            link.hidden=!(window.ScanSafeDB.profile?.id===window.ScanSafeDB.session?.user?.id && window.ScanSafeDB.profile?.role==='admin');
          });
          window.ScanSafeNeeds?.refresh();
          window.ScanSafeOperations?.refresh();
          if(scannerPageActive() && !['admin','staff'].includes(window.ScanSafeDB.profile?.role)) window.ScanSafeScanner?.reset();
          if(isEvacueeAppPage()){
            if(evacueeRefreshPromise) await evacueeRefreshPromise;
            loadCurrentEvacueeIntoPrototype();
            p78LoadUserNotifications();
            p78LoadUserMessages();
          }
        },0);
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
    if(!rec) return 'Automatic recommendation unavailable.';
    if(!rec.recommended) return `Automatic assignment: ${rec.reason || 'No valid accommodation found.'}`;

    const tier=rec.overflow_used?'Overflow fallback':'Primary';
    const access=rec.requires_accessibility?' • accessibility required':'';
    return `Automatic recommendation: ${rec.space_name} • ${tier} • ${rec.remaining_after} slot${Number(rec.remaining_after)===1?'':'s'} remain after assignment${access}`;
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

    if(title) title.textContent='Automatic Accommodation Assignment';

    if(hint){
      hint.textContent=
        `Selected map space: ${selected.space_name||spaceCode} (${available} slots available). `+
        `The system evaluates live capacity, group size, accessibility requirements, primary accommodation priority, and best fit.`;
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
                    ${hasRec?'Use Automatic Assignment':'No Valid Automatic Space'}
                  </button>
                </div>
              </div>`;
          }).join('')
        : `<div class="space-placeholder">
             No eligible groups right now. Approve a registration, issue its barcode,
             and confirm that the group has no active assignment.
           </div>`;
    }

    modal.classList.remove('hidden');
  }

  async function confirmGbeaaAssignmentDatabase(groupToken){
    const sb=readyClient();
    if(!sb){
      if(typeof toast==='function') toast('Backend unavailable. Automatic assignment was not saved.');
      return;
    }

    if(!String(groupToken||'').startsWith('DB:')){
      if(typeof toast==='function') toast('Automatic assignment requires a database-backed evacuee group.');
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
      if(typeof toast==='function') toast('Automatic assignment failed: '+error.message);
      return;
    }

    gbeaaRecommendationCache.clear();

    if(typeof window.closeAssignmentModal==='function'){
      window.closeAssignmentModal();
    }

    const overflow=data?.overflow_used?' (overflow fallback)':'';
    if(typeof toast==='function'){
      toast(
        `Automatic assignment placed ${group.name} to ${data?.space_name||data?.space_code}`+
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


  // =========================================================
  // ScanSafe Barcode Mode
  // Real 1D CODE128 rendering. Existing database field/table
  // names are preserved for backward compatibility.
  // =========================================================
  let scanSafeJsBarcodePromise=null;

  async function ensureScanSafeBarcodeLibrary(){
    if(window.JsBarcode) return true;
    if(scanSafeJsBarcodePromise) return scanSafeJsBarcodePromise;

    scanSafeJsBarcodePromise=new Promise((resolve)=>{
      const existing=document.querySelector('script[data-scansafe-jsbarcode]');
      if(existing){
        existing.addEventListener('load',()=>resolve(!!window.JsBarcode),{once:true});
        existing.addEventListener('error',()=>resolve(false),{once:true});
        return;
      }

      const s=document.createElement('script');
      s.src='assets/vendor/JsBarcode.all.min.js';
      s.async=true;
      s.dataset.scansafeJsbarcode='1';
      s.onload=()=>resolve(!!window.JsBarcode);
      s.onerror=()=>{s.remove();scanSafeJsBarcodePromise=null;resolve(false);};
      document.head.appendChild(s);
    });

    return scanSafeJsBarcodePromise;
  }

  async function renderScanSafeBarcodes(root=document){
    const nodes=[...root.querySelectorAll?.('.scansafe-barcode[data-barcode-value]')||[]];
    if(!nodes.length) return;

    if(!(await ensureScanSafeBarcodeLibrary())) return;

    nodes.forEach((svg)=>{
      const value=svg.getAttribute('data-barcode-value')||'';
      if(!value || svg.dataset.barcodeRendered===value) return;

      try{
        window.JsBarcode(svg,value,{
          format:'CODE128',
          displayValue:false,
          lineColor:'#111111',
          background:'#ffffff',
          height:72,
          width:1.65,
          margin:4
        });
        svg.dataset.barcodeRendered=value;
      }catch(err){
        console.warn('ScanSafe barcode render:',err);
      }
    });
  }

  function replaceBarcodeTerminologyText(value){
    let text=String(value??'');
    text=text
      .replace(/QR\s*\/\s*Barcode Scanner/gi,'Barcode Scanner')
      .replace(/QR-assisted/gi,'Barcode-assisted')
      .replace(/QR\s*\/\s*barcode/gi,'Barcode')
      .replace(/QR codes/gi,'barcodes')
      .replace(/QR code/gi,'barcode')
      .replace(/\bQR\b/g,'Barcode')
      .replace(/Barcode code/gi,'Barcode')
      .replace(/Barcode \/ Barcode Scanner/gi,'Barcode Scanner');
    return text;
  }

  function applyBarcodeTerminology(root=document.body){
    if(!root) return;

    const walker=document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node){
          const tag=node.parentElement?.tagName;
          if(['SCRIPT','STYLE','NOSCRIPT','TEXTAREA'].includes(tag)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const changes=[];
    while(walker.nextNode()){
      const node=walker.currentNode;
      const next=replaceBarcodeTerminologyText(node.nodeValue);
      if(next!==node.nodeValue) changes.push([node,next]);
    }
    changes.forEach(([node,next])=>{ node.nodeValue=next; });

    root.querySelectorAll?.('[placeholder],[title],[aria-label]').forEach(el=>{
      ['placeholder','title','aria-label'].forEach(attr=>{
        if(!el.hasAttribute(attr)) return;
        const old=el.getAttribute(attr);
        const next=replaceBarcodeTerminologyText(old);
        if(next!==old) el.setAttribute(attr,next);
      });
    });
  }

  function setupBarcodeMode(){
    applyBarcodeTerminology(document.body);
    renderScanSafeBarcodes(document);

    let queued=false;
    const observer=new MutationObserver((mutations)=>{
      if(queued) return;
      queued=true;
      queueMicrotask(()=>{
        queued=false;
        for(const mutation of mutations){
          mutation.addedNodes.forEach(node=>{
            if(node.nodeType===Node.ELEMENT_NODE){
              applyBarcodeTerminology(node);
              renderScanSafeBarcodes(node);
            }else if(node.nodeType===Node.TEXT_NODE && node.parentElement){
              const next=replaceBarcodeTerminologyText(node.nodeValue);
              if(next!==node.nodeValue) node.nodeValue=next;
            }
          });
        }
        renderScanSafeBarcodes(document);
      });
    });

    observer.observe(document.body,{childList:true,subtree:true});
  }

  window.ScanSafeBarcode={
    render:()=>renderScanSafeBarcodes(document),
    ensureLibrary:ensureScanSafeBarcodeLibrary,
    value:()=>window.currentState?.().user?.qrCode||null
  };

  document.addEventListener('DOMContentLoaded',()=>{
    setupBarcodeMode();
    setTimeout(()=>renderScanSafeBarcodes(document),150);
  });


  window.ScanSafeRealUser={
    refresh:loadCurrentEvacueeIntoPrototype,
    inspect:async function(){
      return {configured,authenticated:!!window.ScanSafeDB.session?.user,
        authUserId:window.ScanSafeDB.session?.user?.id||null,
        ...evacueeLiveCache,localUser:window.currentState?.().user||null};
    }
  };
  window.ScanSafeEvacueeLive={
    get loaded(){return evacueeLiveCache.loaded;},
    inspect:()=>({...evacueeLiveCache}),
    spaces:()=>[...mapDbCache.spaces.values()].filter(row=>row.status!=='inactive')
  };

  if(isEvacueeAppPage()){
    window.scrollToUserQR=openLiveEvacueeBarcode;
    window.renderUserPrototype=renderLiveEvacueeAccount;
    window.selectSpace=selectLiveEvacueeSpace;
    window.showUserMapViewerSpace=selectLiveEvacueeViewerSpace;
    window.renderUserAssignmentSummary=renderLiveEvacueeAssignment;
    window.renderUserSpaceList=renderLiveEvacueeSpaces;
    window.sendMessage=p78SendMessage;
    window.getDynamicOccupancy=id=>Number(mapDbCache.spaces.get(id)?.current_occupancy||0);
    window.getSpaceStatus=id=>{
      const row=mapDbCache.spaces.get(id);
      return row?normalizeDbSpaceStatus(row):'full';
    };
    window.getAvailableSlots=id=>{
      const row=mapDbCache.spaces.get(id);
      return row?Math.max(0,Number(row.capacity||0)-Number(row.current_occupancy||0)):0;
    };
    resetEvacueeLiveAccount();
    renderLiveEvacueeAccount();
    document.addEventListener('DOMContentLoaded',()=>{
      document.addEventListener('click',event=>{
        const link=event.target.closest?.('.mobile-bottom-nav a');
        if(link && link.getAttribute('href')?.endsWith('#qr')){
          event.preventDefault();openLiveEvacueeBarcode();
        }
      });
      window.addEventListener('hashchange',()=>{
        if(location.hash==='#qr') openLiveEvacueeBarcode();
      });
      const refresh=()=>{if(document.visibilityState==='visible') loadCurrentEvacueeIntoPrototype();};
      const startTimer=()=>{if(!evacueeLiveTimer) evacueeLiveTimer=setInterval(refresh,10000);};
      startTimer();
      window.addEventListener('focus',refresh);
      document.addEventListener('visibilitychange',refresh);
      window.addEventListener('pageshow',()=>{startTimer();refresh();});
      window.addEventListener('pagehide',()=>{
        clearInterval(evacueeLiveTimer);evacueeLiveTimer=null;
        const sb=readyClient();
        if(evacueeLiveChannel && sb?.removeChannel) sb.removeChannel(evacueeLiveChannel);
        evacueeLiveChannel=null;evacueeLiveChannelOwner=null;
      });
    });
  }


  if(adminLivePages.has(adminLivePage())){
    window.sendMessage=p78SendMessage;
    window.sendAnnouncement=p78SendAnnouncement;
    window.exportCSV=p78ExportCsv;
    window.generatePDF=p78GeneratePdf;
    window.renderEvacs=renderAdminLiveEvacuees;
    window.showEvac=showAdminLiveEvacuee;
    window.renderDashboardPrototype=renderAdminLiveDashboard;
    window.updatePrototypeCounts=renderAdminLiveDashboard;
    window.renderDashboardSpaceOverview=renderAdminLiveDashboard;
    window.renderPendingRequests=renderAdminPendingRequests;
    window.registerEvac=function(event){
      event.preventDefault();
      if(typeof toast==='function') toast('Create evacuee accounts using the registration form on the sign-in page.');
    };
    clearAdminMockState();
    document.addEventListener('DOMContentLoaded',()=>{
      const refresh=()=>{
        if(document.visibilityState==='visible') loadAdminLiveSnapshot();
      };
      window.__scanSafeAdminLiveTimer=setInterval(refresh,15000);
      window.addEventListener('focus',refresh);
      document.addEventListener('visibilitychange',refresh);
      window.addEventListener('pagehide',()=>clearInterval(window.__scanSafeAdminLiveTimer),{once:true});
    });
  }

})();
