/* The app invitation is scoped to the authenticated evacuee in this browser. */
(function(){
  'use strict';
  const preferencePrefix='scansafeAppPromoHiddenV1:';
  const sessionPrefix='scansafeAppPromoDismissedV1:';
  const dismissedOwners=new Set();
  let getContext=()=>null;
  let imageUrl='assets/scansafe-app-promo-portrait.png';
  let downloadUrl='downloads/ScanSafe-Evacuee.apk';
  let modal=null, opened=false, ownerId=null, previousFocus=null;
  let generation=0, pendingTimer=null, monitorTimer=null, imagePromise=null;
  let imageSource=null, imageReady=false, autoPending=false;

  function isNative(){
    try{
      const capacitor=window.Capacitor;
      return !!(capacitor && (capacitor.isNativePlatform?.() ||
        ['android','ios'].includes(capacitor.getPlatform?.())));
    }catch(error){return false;}
  }
  function contextOwner(){
    if(isNative() || location.pathname.split('/').pop()!=='user-portal.html') return null;
    try{
      const context=getContext();
      if(!context || context.signedIn===false) return null;
      const role=context.role || context.profile?.role;
      const id=context.ownerId || context.user?.id || context.authUser?.id || context.id;
      return role==='evacuee' && typeof id==='string' && id ? id : null;
    }catch(error){return null;}
  }
  function stored(storage,key){
    try{return window[storage].getItem(key)==='true';}catch(error){return false;}
  }
  function store(storage,key){
    try{window[storage].setItem(key,'true');}catch(error){/* Storage may be disabled. */}
  }
  function wasDismissed(id){
    return dismissedOwners.has(id) || stored('localStorage',preferencePrefix+id) ||
      stored('sessionStorage',sessionPrefix+id);
  }
  function otherDialogVisible(){
    return Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog[open],.prototype-modal,.modal')).some(node=>{
      if(node===modal || modal?.contains(node) || node.closest('[hidden],.hidden')) return false;
      const style=window.getComputedStyle(node);
      return style.display!=='none' && style.visibility!=='hidden' && node.getClientRects().length>0;
    });
  }
  function clearTimers(){
    if(pendingTimer!==null){clearTimeout(pendingTimer);pendingTimer=null;}
    if(monitorTimer!==null){clearTimeout(monitorTimer);monitorTimer=null;}
  }
  function ensureModal(){
    if(modal) return modal;
    modal=document.createElement('div');
    modal.id='scanSafeAppPromo';
    modal.className='app-promo';
    modal.hidden=true;
    modal.setAttribute('role','dialog');
    modal.setAttribute('aria-modal','true');
    modal.setAttribute('aria-labelledby','scanSafeAppPromoTitle');
    modal.innerHTML='<div class="app-promo-backdrop" aria-hidden="true"></div><section class="app-promo-dialog"><header class="app-promo-header"><h2 id="scanSafeAppPromoTitle">ScanSafe Mobile App</h2><button type="button" class="app-promo-close" id="scanSafeAppPromoClose" aria-label="Close app invitation">Close <span aria-hidden="true">&times;</span></button></header><div class="app-promo-poster"><img id="scanSafeAppPromoPoster" alt="Download the ScanSafe mobile app for your barcode, accommodation assignment, messages and notifications." decoding="async"></div><footer class="app-promo-footer"><label class="app-promo-preference"><input type="checkbox" id="scanSafeAppPromoRemember"><span>Do not show again</span></label><a class="app-promo-download" id="scanSafeAppPromoDownload" download="ScanSafe-Evacuee.apk">Download APK</a></footer></section>';
    document.body.appendChild(modal);
    document.getElementById('scanSafeAppPromoClose').addEventListener('click',close);
    modal.addEventListener('click',event=>{
      if(event.target===modal || event.target.classList.contains('app-promo-backdrop')) close();
    });
    document.addEventListener('keydown',event=>{
      if(!opened) return;
      if(event.key==='Escape'){
        event.preventDefault();event.stopPropagation();close();return;
      }
      if(event.key!=='Tab') return;
      const controls=Array.from(modal.querySelectorAll('button,a[href],input')).filter(node=>
        !node.disabled && !node.hidden && node.getClientRects().length>0);
      const first=controls[0],last=controls[controls.length-1];
      if(!first) return;
      if(event.shiftKey && (document.activeElement===first || !modal.contains(document.activeElement))){event.preventDefault();last.focus();}
      else if(!event.shiftKey && (document.activeElement===last || !modal.contains(document.activeElement))){event.preventDefault();first.focus();}
    });
    return modal;
  }
  function preloadImage(){
    if(imagePromise && imageSource===imageUrl) return imagePromise;
    imageSource=imageUrl;imageReady=false;
    const source=imageUrl;
    imagePromise=new Promise(resolve=>{
      const img=new Image();
      let done=false;
      const timer=setTimeout(()=>finish(false),15000);
      function finish(ok){
        if(done) return;
        done=true;clearTimeout(timer);img.onload=null;img.onerror=null;
        if(imageSource===source) imageReady=ok;
        resolve(ok);
      }
      img.onload=()=>finish(img.naturalWidth>0 && img.naturalHeight>0);
      img.onerror=()=>finish(false);
      img.src=source;
    });
    return imagePromise;
  }
  function closeInternal(savePreference,restoreFocus){
    const closingOwner=ownerId;
    const sameAccount=closingOwner && contextOwner()===closingOwner;
    if(savePreference && sameAccount){
      dismissedOwners.add(closingOwner);
      store('sessionStorage',sessionPrefix+closingOwner);
      if(document.getElementById('scanSafeAppPromoRemember')?.checked){
        store('localStorage',preferencePrefix+closingOwner);
      }
    }
    opened=false;ownerId=null;
    if(monitorTimer!==null){clearTimeout(monitorTimer);monitorTimer=null;}
    if(modal) modal.hidden=true;
    document.body?.classList.remove('app-promo-open');
    if(restoreFocus && sameAccount && previousFocus?.isConnected && !otherDialogVisible()) previousFocus.focus?.();
    previousFocus=null;
  }
  function close(){
    generation++;autoPending=false;clearTimers();
    closeInternal(true,true);
    return true;
  }
  function monitor(token){
    monitorTimer=setTimeout(()=>{
      monitorTimer=null;
      if(!opened || token!==generation) return;
      if(contextOwner()!==ownerId){closeInternal(false,false);return;}
      if(otherDialogVisible()){
        closeInternal(false,false);
        schedule(0,token,250);
        return;
      }
      monitor(token);
    },250);
  }
  async function show(token,force){
    const id=contextOwner();
    if(!id || (!force && wasDismissed(id)) || otherDialogVisible()) return false;
    if(!(await preloadImage()) || token!==generation || contextOwner()!==id ||
       (!force && wasDismissed(id)) || otherDialogVisible()) return false;
    if(opened && ownerId===id) return true;
    ensureModal();
    ownerId=id;previousFocus=document.activeElement;
    const poster=document.getElementById('scanSafeAppPromoPoster');
    poster.src=imageUrl;
    document.getElementById('scanSafeAppPromoRemember').checked=false;
    const download=document.getElementById('scanSafeAppPromoDownload');
    download.hidden=!downloadUrl || isNative();
    if(downloadUrl) download.href=downloadUrl;else download.removeAttribute('href');
    modal.hidden=false;opened=true;autoPending=false;
    document.body.classList.add('app-promo-open');
    document.getElementById('scanSafeAppPromoClose').focus();
    monitor(token);
    return true;
  }
  function schedule(attempt,token,delay){
    if(attempt>=80 || token!==generation || isNative()){
      if(token===generation) autoPending=false;
      return;
    }
    autoPending=true;
    pendingTimer=setTimeout(async()=>{
      pendingTimer=null;
      if(token!==generation) return;
      const id=contextOwner();
      if(id && wasDismissed(id)){autoPending=false;return;}
      if(!id || otherDialogVisible()){
        schedule(attempt+1,token,250);return;
      }
      const shown=await show(token,false);
      if(!shown && token===generation && imageReady) schedule(attempt+1,token,250);
      else autoPending=false;
    },delay);
  }
  function init(options){
    generation++;clearTimers();closeInternal(false,false);
    getContext=typeof options?.getContext==='function'?options.getContext:()=>null;
    if(typeof options?.imageUrl==='string' && options.imageUrl) imageUrl=options.imageUrl;
    if(options && Object.prototype.hasOwnProperty.call(options,'downloadUrl')) downloadUrl=options.downloadUrl || '';
    autoPending=false;
    if(!isNative()) schedule(0,generation,700);
    return !isNative();
  }
  async function open(){
    generation++;clearTimers();autoPending=false;
    if(opened) closeInternal(false,false);
    return show(generation,true);
  }
  function reset(){
    generation++;clearTimers();autoPending=false;closeInternal(false,false);
    getContext=()=>null;
  }
  window.ScanSafeAppPromo={init,open,close,reset,inspect:()=>({opened,ownerId,pending:autoPending,imageReady})};
})();
