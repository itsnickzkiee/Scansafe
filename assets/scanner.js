/* Staff barcode verification and automatic accommodation assignment. */
(function(){
  'use strict';
  let options={},initialized=false,revision=0,pending=null,busy=false,hasResult=false,cameraState='idle',authenticatedOwner=null,detectionState='searching',decodedValue='',readmissionRequest=null;
  const el=id=>document.getElementById(id);
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  const context=()=>options.getContext?options.getContext():{userId:window.ScanSafeDB?.session?.user?.id,role:window.ScanSafeDB?.profile?.role};
  const client=()=>options.getClient?options.getClient():window.ScanSafeDB?.client;
  const camera=()=>options.camera||window.ScanSafeScannerCamera;
  const authorized=ctx=>!!ctx?.userId&&['admin','staff'].includes(ctx.role);
  function status(message,state='idle'){
    const box=el('scannerStatus');if(box){box.textContent=message;box.dataset.state=state;}
  }
  function detection(packet,force=false){
    const overlay=el('scannerDetectionOverlay'),polygon=el('scannerDetectionBox'),hint=el('scannerDetectionHint');
    const frame=overlay?.closest('.scan-frame');
    if(!frame) return;
    if(!packet){
      if(detectionState==='decoded'&&!force) return;
      detectionState='searching';decodedValue='';frame.dataset.detection='searching';
      polygon?.setAttribute('points','');
      if(hint) hint.textContent='Place the whole barcode inside the guide';
      return;
    }
    const width=Number(packet.width),height=Number(packet.height);
    const points=Array.isArray(packet.box)?packet.box:[];
    const tolerance=Math.max(width,height)*.02;
    const valid=Number.isFinite(width)&&Number.isFinite(height)&&width>0&&height>0&&points.length===4&&points.every(point=>Array.isArray(point)&&Number.isFinite(Number(point[0]))&&Number.isFinite(Number(point[1]))&&Number(point[0])>=-tolerance&&Number(point[0])<=width+tolerance&&Number(point[1])>=-tolerance&&Number(point[1])<=height+tolerance);
    const safePoints=valid?points.map(point=>[Math.max(0,Math.min(width,Number(point[0]))),Math.max(0,Math.min(height,Number(point[1])))]):[];
    const area=Math.abs(safePoints.reduce((sum,point,index)=>{const next=safePoints[(index+1)%4];return sum+point[0]*next[1]-next[0]*point[1];},0))/2;
    const located=valid&&area>8;
    if(!located&&!packet.decoded){detection(null);return;}
    detectionState=packet.decoded?'decoded':'located';decodedValue=packet.decoded?String(packet.value||''):'';frame.dataset.detection=detectionState;
    if(located){
      overlay.setAttribute('viewBox','0 0 '+width+' '+height);
      polygon?.setAttribute('points',safePoints.map(point=>point[0]+','+point[1]).join(' '));
    }else polygon?.setAttribute('points','');
    if(hint) hint.textContent=packet.decoded?'Barcode read':'Barcode pattern found — hold steady';
  }
  function controls(){
    const button=el('scannerStartButton');
    if(button){button.disabled=busy||['loading','starting','stopping','processing'].includes(cameraState);button.textContent=cameraState==='scanning'?'Stop Scanning':['loading','starting'].includes(cameraState)?'Starting Camera...':hasResult?'Scan Next Barcode':'Start Scanning';}
    const manual=el('manualScanButton');if(manual) manual.disabled=busy;
    const select=el('scannerCameraSelect');if(select) select.disabled=busy||['starting','scanning','stopping'].includes(cameraState);
  }
  function clearLast(message='Scan a barcode to view the evacuee\u2019s database record.'){
    const last=el('lastScannedEvacuee');if(last) last.innerHTML='<h3 class="section-h">Last Scanned Evacuee</h3><div class="space-placeholder">'+esc(message)+'</div>';
  }
  function reset(){
    revision++;pending=null;busy=false;hasResult=false;
    camera()?.stop?.();cameraState='idle';
    detection(null,true);
    const result=el('scanResult');if(result){result.replaceChildren();result.classList.add('hidden');}
    const input=el('manualBarcode');if(input) input.value='';
    const history=el('scannerHistory');
    if(history) history.innerHTML='<tr><th>#</th><th>Name</th><th>Barcode</th><th>Space</th><th>Time</th><th>Verification</th></tr><tr><td colspan="6">Scan history will refresh after verification.</td></tr>';
    clearLast();status('Start the camera and show the entire barcode, including its white edges.');controls();
  }
  function unavailable(message,value=''){
    const box=el('scanResult');
    if(box){box.classList.remove('hidden');box.innerHTML='<h2 class="scanner-result-title">Verification unavailable</h2><p>'+esc(message)+'</p>'+(value?'<div class="detail-line"><b>Barcode</b><span>'+esc(value)+'</span></div>':'');}
    clearLast('No verified record to display. Try scanning again.');status(message,'error');hasResult=true;
  }
  function row(label,value){return '<div class="detail-line"><b>'+esc(label)+'</b><span>'+esc(value??'Not provided')+'</span></div>';}
  function scanDate(value){
    if(!value) return 'Not recorded';
    const d=new Date(value);
    return Number.isNaN(d.getTime())?'Not recorded':d.toLocaleString();
  }
  function scanDuration(seconds){
    const total=Math.max(0,Number(seconds)||0);
    const hours=Math.floor(total/3600);
    const minutes=Math.floor((total%3600)/60);
    if(hours && minutes) return hours+'h '+minutes+'m';
    if(hours) return hours+'h';
    return minutes+'m';
  }
  function cooldownText(seconds){
    const total=Math.max(0,Math.ceil(Number(seconds)||0));
    const hours=Math.floor(total/3600);
    const minutes=Math.ceil((total%3600)/60);
    if(hours && minutes) return hours+'h '+minutes+'m';
    if(hours) return hours+'h';
    return Math.max(1,minutes)+'m';
  }
  function ensureReadmissionModal(){
    let modal=el('scannerReadmissionModal');
    if(modal) return modal;
    modal=document.createElement('div');
    modal.id='scannerReadmissionModal';
    modal.className='scanner-readmission-modal';
    modal.hidden=true;
    modal.innerHTML='<div class="scanner-readmission-backdrop" data-readmit-close></div><section class="scanner-readmission-dialog" role="dialog" aria-modal="true" aria-labelledby="scannerReadmissionTitle"><div class="scanner-readmission-icon">↻</div><h2 id="scannerReadmissionTitle">Confirm Readmission</h2><p id="scannerReadmissionCopy"></p><div id="scannerReadmissionPrevious" class="scanner-readmission-previous"></div><div class="scanner-readmission-note">A new shelter stay will start. Accommodation will be selected automatically using the current shelter capacity.</div><div class="scanner-readmission-actions"><button type="button" class="btn out" data-readmit-close>Cancel</button><button type="button" class="btn red" id="scannerReadmissionConfirm">Confirm Readmission</button></div><p id="scannerReadmissionFeedback" class="scanner-readmission-feedback" role="status" aria-live="polite"></p></section>';
    document.body.appendChild(modal);
    modal.querySelectorAll('[data-readmit-close]').forEach(button=>button.addEventListener('click',()=>closeReadmissionModal()));
    modal.querySelector('#scannerReadmissionConfirm')?.addEventListener('click',confirmReadmission);
    return modal;
  }
  function closeReadmissionModal(){
    if(busy) return;
    const modal=el('scannerReadmissionModal');
    if(modal) modal.hidden=true;
    document.body.classList.remove('scanner-readmission-open');
    readmissionRequest=null;
  }
  function openReadmissionModal(value,data){
    const modal=ensureReadmissionModal();
    readmissionRequest={value:String(value||data?.qr_value||''),data};
    const copy=modal.querySelector('#scannerReadmissionCopy');
    const previous=modal.querySelector('#scannerReadmissionPrevious');
    const feedback=modal.querySelector('#scannerReadmissionFeedback');
    if(copy) copy.textContent='Start a new shelter stay for '+(data?.full_name||'this evacuee')+'?';
    if(previous) previous.innerHTML=row('Previous Departure',scanDate(data?.departure_time))+row('Previous Stay Duration',scanDuration(data?.stay_duration_seconds))+row('Previous Space',data?.previous_space||'Not recorded');
    if(feedback) feedback.textContent='';
    modal.hidden=false;
    document.body.classList.add('scanner-readmission-open');
  }
  async function confirmReadmission(){
    const request=readmissionRequest;
    if(!request || busy) return;
    const sb=client();
    const modal=ensureReadmissionModal();
    const button=modal.querySelector('#scannerReadmissionConfirm');
    const feedback=modal.querySelector('#scannerReadmissionFeedback');
    if(!sb){if(feedback) feedback.textContent='Database connection unavailable.';return;}
    busy=true;controls();
    if(button){button.disabled=true;button.textContent='Starting New Stay...';}
    if(feedback) feedback.textContent='Confirming readmission and checking current accommodation availability...';
    try{
      const {data,error}=await sb.rpc('confirm_scansafe_readmission',{p_barcode_value:request.value});
      if(error) throw error;
      if(!data || data.valid!==true) throw new Error('The server did not confirm the new shelter stay.');
      modal.hidden=true;document.body.classList.remove('scanner-readmission-open');readmissionRequest=null;
      render(data,request.value);
      status('Readmission confirmed. A new shelter stay is active.','success');
      if(options.refresh) Promise.resolve().then(()=>options.refresh()).catch(()=>{});
    }catch(error){
      if(feedback) feedback.textContent=error?.message||'Readmission could not be confirmed.';
    }finally{
      busy=false;
      if(button){button.disabled=false;button.textContent='Confirm Readmission';}
      controls();
    }
  }
  function render(data,value){
    const box=el('scanResult');if(!box) return;
    box.classList.remove('hidden');hasResult=true;

    if(data?.valid!==true){
      const label=String(data?.result||'invalid').toUpperCase();
      const message=data?.message||'This barcode could not be verified.';
      box.innerHTML='<div class="scanner-result-badge scanner-result-error">'+esc(label)+'</div><h2 class="scanner-result-title">Barcode not verified</h2><p>'+esc(message)+'</p>'+row('Barcode',value);
      clearLast('No verified evacuee record for this scan.');status(message,'error');return;
    }

    const assignment=data.assignment||{};
    const space=data.space_name||assignment.space_name||data.space_code||assignment.space_code;
    const shelter=data.shelter_name||assignment.shelter_name||'Not provided';
    const arrival=scanDate(data.arrival_time||assignment.assigned_at||data.scanned_at);

    if(data.scan_state==='already_checked_in'){
      box.innerHTML=
        '<div class="scanner-result-badge scanner-result-duplicate">ALREADY CHECKED IN</div>'+
        '<h2 class="scanner-result-title">Duplicate scan blocked</h2>'+
        '<p>This barcode already completed check-in for the current evacuation. No new assignment or occupancy was created.</p>'+
        '<div class="detail-list">'+
          row('Evacuee',data.full_name||'Evacuee')+
          row('Arrival Time',arrival)+
          row('Assigned Space',space||'Current assignment retained')+
          row('Shelter',shelter)+
          row('Status','Accommodated / Checked In')+
        '</div>';

      const last=el('lastScannedEvacuee');
      if(last) last.innerHTML='<h3 class="section-h">Last Scanned Evacuee</h3><h2 class="scanner-evacuee-name">'+esc(data.full_name||'Evacuee')+'</h2><span class="pill amber">Already Checked In</span><div class="detail-list">'+row('Arrival Time',arrival)+row('Accommodation',space||'Current assignment retained')+row('Group size',data.group_size||'Not provided')+'</div>';

      status('Duplicate scan blocked. '+(data.full_name||'Evacuee')+' is already checked in.','warning');
      return;
    }

    if(data.scan_state==='recently_released'){
      const remaining=cooldownText(data.cooldown_remaining_seconds);
      box.innerHTML=
        '<div class="scanner-result-badge scanner-result-released">RECENTLY RELEASED</div>'+ 
        '<h2 class="scanner-result-title">Readmission cooldown active</h2>'+ 
        '<p>The previous shelter stay is complete. A new stay can be started after the 12-hour cooldown.</p>'+ 
        '<div class="detail-list">'+
          row('Evacuee',data.full_name||'Evacuee')+
          row('Previous Arrival',scanDate(data.arrival_time))+
          row('Previous Departure',scanDate(data.departure_time))+
          (data.stay_duration_seconds!=null?row('Previous Stay Duration',scanDuration(data.stay_duration_seconds)):'')+
          row('Readmission Available In',remaining)+
          row('Status','Released / Cooldown')+
        '</div>';
      clearLast((data.full_name||'Evacuee')+' is in the 12-hour readmission cooldown.');
      status('Previous stay released. Readmission available in '+remaining+'.','warning');
      return;
    }

    if(data.scan_state==='ready_for_readmission'){
      box.innerHTML=
        '<div class="scanner-result-badge scanner-result-ready">READY FOR READMISSION</div>'+ 
        '<h2 class="scanner-result-title">Eligible for a new shelter stay</h2>'+ 
        '<p>The previous stay is complete and the 12-hour cooldown has ended. Staff confirmation is required before starting a new stay.</p>'+ 
        '<div class="detail-list">'+
          row('Evacuee',data.full_name||'Evacuee')+
          row('Previous Departure',scanDate(data.departure_time))+
          (data.stay_duration_seconds!=null?row('Previous Stay Duration',scanDuration(data.stay_duration_seconds)):'')+
          row('Previous Space',data.previous_space||'Not recorded')+
          row('Status','Ready for Readmission')+
        '</div>'+ 
        '<button type="button" class="btn red full scanner-readmit-button" id="scannerReadmitButton">Confirm Readmission</button>';
      el('scannerReadmitButton')?.addEventListener('click',()=>openReadmissionModal(value,data));
      const last=el('lastScannedEvacuee');
      if(last) last.innerHTML='<h3 class="section-h">Last Scanned Evacuee</h3><h2 class="scanner-evacuee-name">'+esc(data.full_name||'Evacuee')+'</h2><span class="pill green">Ready for Readmission</span><div class="detail-list">'+row('Previous Departure',scanDate(data.departure_time))+row('Previous Space',data.previous_space||'Not recorded')+'</div>';
      status('Ready for readmission. Confirm before starting a new shelter stay.','success');
      return;
    }

    if(data.scan_state==='released'){
      box.innerHTML=
        '<div class="scanner-result-badge scanner-result-released">RELEASED</div>'+
        '<h2 class="scanner-result-title">Shelter stay already ended</h2>'+
        '<p>This barcode cannot automatically check in again for the same evacuation stay.</p>'+
        '<div class="detail-list">'+
          row('Evacuee',data.full_name||'Evacuee')+
          row('Arrival Time',scanDate(data.arrival_time))+
          row('Departure Time',scanDate(data.departure_time))+
          (data.stay_duration_seconds!=null?row('Stay Duration',scanDuration(data.stay_duration_seconds)):'')+
          row('Status','Released')+
        '</div>';
      clearLast((data.full_name||'Evacuee')+' has already been released.');
      status('Released stay. Staff must use the controlled readmission flow before a future check-in.','warning');
      return;
    }

    const assigned=['assigned','already_assigned'].includes(data.assignment_state)&&!!space;
    const checkedIn=data.scan_state==='checked_in' || assigned;
    const assignmentText=assigned?space:'Waiting for assignment';
    const allocationMessage=checkedIn
      ? 'Check-in completed. Accommodation was assigned automatically and occupancy was recorded once.'
      : data.assignment_message||'Barcode verified, but accommodation was not completed.';

    box.innerHTML=
      '<div class="scanner-result-badge">'+esc(checkedIn?'CHECKED IN':'VERIFIED')+'</div>'+
      '<h2 class="scanner-result-title">'+esc(checkedIn?'Accommodated / Checked In':'Verified — Waiting for assignment')+'</h2>'+
      '<p>'+esc(allocationMessage)+'</p>'+
      '<div class="detail-list">'+
        row('Barcode',data.qr_value||value)+
        row('Evacuee',data.full_name||'Evacuee')+
        row('Arrival Time',checkedIn?arrival:'Not recorded')+
        row('Accommodation',assignmentText)+
        row('Shelter',shelter)+
        row('Assignment',assigned?'Automatic Assignment':'Waiting for assignment')+
        row('Scanned by',window.ScanSafeDB?.profile?.full_name||'Authorized staff')+
      '</div>';

    const last=el('lastScannedEvacuee');
    if(last) last.innerHTML=
      '<h3 class="section-h">Last Scanned Evacuee</h3>'+
      '<h2 class="scanner-evacuee-name">'+esc(data.full_name||'Evacuee')+'</h2>'+
      '<span class="pill green">'+esc(checkedIn?'Checked In':'Verified')+'</span>'+
      '<div class="detail-list">'+
        row('Evacuee ID',data.evacuee_id)+
        row('Age / Gender',[data.age??'Not provided',data.gender||'Not provided'].join(' / '))+
        row('Group size',data.group_size)+
        row('Special needs',data.needs_summary||'None recorded')+
        row('Arrival Time',checkedIn?arrival:'Not recorded')+
        row('Accommodation',assignmentText)+
      '</div>';

    status(
      checkedIn
        ? 'Check-in completed. '+(data.full_name||'Evacuee')+' is assigned to '+space+'.'
        : 'Verified. '+allocationMessage,
      checkedIn?'success':'warning'
    );
  }
  function verify(rawValue){
    const value=String(rawValue??'').trim();
    if(!value){status('Enter or scan an evacuee barcode.','warning');return Promise.resolve(null);}
    if(pending) return pending.value===value?pending.promise:Promise.resolve(null);
    if(detectionState==='decoded'&&decodedValue!==value) detection(null,true);
    const ctx=context();
    if(!authorized(ctx)){unavailable('Sign in with an administrator or staff account to scan barcodes.');controls();return Promise.resolve(null);}
    const sb=client();
    if(!sb){unavailable('The database connection is unavailable. Reload and try again.');controls();return Promise.resolve(null);}
    const token=++revision;
    const current=()=>token===revision&&context()?.userId===ctx.userId&&context()?.role===ctx.role;
    busy=true;controls();clearLast('Verifying barcode and checking current shelter-stay status...');
    const box=el('scanResult');if(box){box.classList.remove('hidden');box.innerHTML='<p>Verifying barcode, checking shelter-stay status, and preparing automatic accommodation...</p>';}
    status('Barcode detected. Checking eligibility and one-time check-in status...','busy');
    const promise=(async()=>{
      try{
        await camera()?.stop?.();
        if(!current()){if(token===revision) reset();return null;}
        const {data,error}=await sb.rpc('scan_and_assign_evacuee',{p_barcode_value:value});
        if(!current()){if(token===revision) reset();return null;}
        if(error){
          const missing=error.code==='PGRST202'||error.code==='42883'||/could not find.*scan_and_assign_evacuee|scan_and_assign_evacuee.*does not exist/i.test(error.message||'');
          unavailable(missing?'Scanner setup is incomplete. Run the latest ScanSafe scanner and lifecycle SQL patches, then retry.':error.message||'The server could not verify this barcode. Try again.',value);
          return null;
        }
        if(!data||typeof data.valid!=='boolean'){unavailable('The server returned an incomplete verification result. Try again.',value);return null;}
        render(data,value);
        if(options.refresh) Promise.resolve().then(()=>options.refresh()).catch(()=>{});
        return data;
      }catch(error){
        if(current()) unavailable(error?.message||'Unable to reach the server. Check your connection and retry.',value);
        else if(token===revision) reset();
        return null;
      }finally{
        if(token===revision){busy=false;pending=null;controls();}
      }
    })();
    pending={value,promise};return promise;
  }
  async function toggle(){
    if(busy) return false;
    if(!authorized(context())){unavailable('Sign in with an administrator or staff account to use the scanner.');controls();return false;}
    const reader=camera();
    if(!reader){unavailable('The camera scanner could not load. Reload the page or enter the code manually.');return false;}
    if(!reader.inspect?.().active) detection(null,true);
    return reader.toggle();
  }
  function init(next={}){
    options={...options,...next};
    camera()?.init?.({elementId:'scanSafeQrReader',cameraSelectId:'scannerCameraSelect',onDecode:verify,onDetection:detection,onStatus:update=>{
      cameraState=update.state;controls();
      const frame=el('scannerDetectionOverlay')?.closest('.scan-frame');
      if(frame) frame.dataset.cameraState=update.state;
      if(!busy) status(update.message||'Camera ready.',update.error?'error':update.state);
    }});
    if(!initialized){
      initialized=true;
      el('scannerStartButton')?.addEventListener('click',toggle);
      el('manualScanButton')?.addEventListener('click',manual);
      el('manualBarcode')?.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();manual();}});
      window.addEventListener('pagehide',reset);
      authenticatedOwner=context()?.userId||null;
      client()?.auth?.onAuthStateChange?.((event,session)=>{
        const nextOwner=session?.user?.id||null;
        if(event==='SIGNED_OUT'||nextOwner!==authenticatedOwner){authenticatedOwner=nextOwner;reset();}
      });
    }
    detection(null,true);status('Start the camera and show the entire barcode, including its white edges.');controls();return window.ScanSafeScanner;
  }
  function manual(){if(!busy) detection(null,true);return verify(el('manualBarcode')?.value||'');}
  window.ScanSafeScanner={init,verify,manual,toggle,reset,inspect:()=>({busy,hasResult,cameraState,revision,pendingValue:pending?.value||null})};
})();
