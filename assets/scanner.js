/* Staff barcode verification and automatic accommodation assignment. */
(function(){
  'use strict';
  let options={},initialized=false,revision=0,pending=null,busy=false,hasResult=false,cameraState='idle',authenticatedOwner=null,detectionState='searching',decodedValue='';
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
    const assigned=['assigned','already_assigned'].includes(data.assignment_state)&&!!space;
    const assignmentText=assigned?space:'Waiting for assignment';
    const allocationMessage=data.assignment_message||(assigned?(data.assignment_state==='already_assigned'?'Existing accommodation assignment retained.':'GBEAA assigned an available accommodation space.'):'No accommodation assignment was saved.');
    const shelter=data.shelter_name||assignment.shelter_name||'Not provided';
    box.innerHTML='<div class="scanner-result-badge">VERIFIED</div><h2 class="scanner-result-title">'+esc(assigned?'Assigned':'Verified \u2014 Waiting for assignment')+'</h2><p>'+esc(allocationMessage)+'</p><div class="detail-list">'+row('Barcode',data.qr_value||value)+row('Accommodation',assignmentText)+row('Shelter',shelter)+row('Assignment',assigned?(data.assignment_state==='already_assigned'?'Already assigned':'Assigned via GBEAA'):'Waiting for assignment')+row('Scanned by',window.ScanSafeDB?.profile?.full_name||'Authorized staff')+(data.scanned_at?row('Scanned at',new Date(data.scanned_at).toLocaleString()):'')+'</div>';
    const last=el('lastScannedEvacuee');
    if(last) last.innerHTML='<h3 class="section-h">Last Scanned Evacuee</h3><h2 class="scanner-evacuee-name">'+esc(data.full_name||'Evacuee')+'</h2><span class="pill green">Verified</span><div class="detail-list">'+row('Evacuee ID',data.evacuee_id)+row('Age / Gender',[data.age??'Not provided',data.gender||'Not provided'].join(' / '))+row('Group size',data.group_size)+row('Special needs',data.needs_summary||'None recorded')+row('Address',data.address||'Not provided')+row('Contact number',data.contact_number||'Not provided')+row('Approval',data.approval_status||'approved')+row('Accommodation',assignmentText)+'</div>';
    status(assigned?'Verified. '+(data.assignment_state==='already_assigned'?'Existing assignment: ':'Assigned to ')+space+'.':'Verified. '+allocationMessage,assigned?'success':'warning');
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
    busy=true;controls();clearLast('Verifying the barcode and finding an accommodation...');
    const box=el('scanResult');if(box){box.classList.remove('hidden');box.innerHTML='<p>Verifying barcode and running GBEAA...</p>';}
    status('Barcode detected. Verifying and assigning an available space...','busy');
    const promise=(async()=>{
      try{
        await camera()?.stop?.();
        if(!current()){if(token===revision) reset();return null;}
        const {data,error}=await sb.rpc('scan_and_assign_evacuee',{p_barcode_value:value});
        if(!current()){if(token===revision) reset();return null;}
        if(error){
          const missing=error.code==='PGRST202'||error.code==='42883'||/could not find.*scan_and_assign_evacuee|scan_and_assign_evacuee.*does not exist/i.test(error.message||'');
          unavailable(missing?'Scanner setup is incomplete. Run SUPABASE_SCANNER_GBEAA_FIX.sql in Supabase SQL Editor, then retry.':error.message||'The server could not verify this barcode. Try again.',value);
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
