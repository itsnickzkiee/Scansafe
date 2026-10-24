/* ScanSafe issued barcode viewer. Account data is supplied by the live bridge. */
(function(){
  'use strict';
  let account=null, revision=0, opened=false, ready=false, printing=false;
  let modal=null, previousFocus=null, renderPromise=null, nativeFullscreen=false;
  const byId=id=>document.getElementById(id);
  const current=token=>!!account && token===revision && opened;

  function message(text){
    const box=byId('evacueeBarcodeMessage');
    if(box){box.textContent=text;box.hidden=!text;}
  }
  function controls(){
    for(const id of ['barcodeViewerPrint','barcodeViewerDownload']){
      const button=byId(id);if(button) button.disabled=!ready||printing;
    }
  }
  function finishPrint(){
    printing=false;
    document.body.classList.remove('barcode-printing');
    controls();
  }
  function exitNativeFullscreen(){
    if(document.fullscreenElement===modal && document.exitFullscreen){
      return Promise.resolve(document.exitFullscreen()).catch(()=>{});
    }
    return Promise.resolve();
  }
  function clearPaper(){
    const svg=byId('evacueeBarcodeSvg');
    if(svg){svg.replaceChildren();svg.removeAttribute('data-barcode-value');svg.removeAttribute('data-barcode-rendered');svg.removeAttribute('viewBox');}
    const label=byId('evacueeBarcodeValue');if(label) label.textContent='';
    ready=false;renderPromise=null;controls();
  }
  function close(){
    opened=false;
    if(modal){modal.hidden=true;modal.classList.remove('is-expanded');}
    const fullscreenButton=byId('barcodeViewerFullscreen');
    if(fullscreenButton) fullscreenButton.textContent='Full Screen';
    nativeFullscreen=false;
    document.body.classList.remove('barcode-viewer-open');
    finishPrint();
    exitNativeFullscreen();
    const target=previousFocus?.isConnected?previousFocus:document.querySelector('[data-show-barcode]');
    if(target?.focus) target.focus();
    return true;
  }
  function setAccount(next){
    const valid=next && typeof next.ownerId==='string' && next.ownerId && typeof next.value==='string' && next.value.trim();
    const value=valid?{ownerId:next.ownerId,value:next.value}:null;
    if(account?.ownerId===value?.ownerId && account?.value===value?.value) return false;
    account=value;revision++;
    if(opened) close();
    clearPaper();
    return true;
  }
  function ensureModal(){
    if(modal) return modal;
    modal=document.createElement('div');
    modal.id='evacueeBarcodeViewer';
    modal.className='barcode-viewer';
    modal.hidden=true;
    modal.setAttribute('role','dialog');
    modal.setAttribute('aria-modal','true');
    modal.setAttribute('aria-labelledby','evacueeBarcodeTitle');
    modal.innerHTML='<div class="barcode-viewer-backdrop" aria-hidden="true"></div><section class="barcode-viewer-dialog"><div class="barcode-viewer-header"><h2 id="evacueeBarcodeTitle">My Barcode</h2><button type="button" class="btn out" id="barcodeViewerClose">Close</button></div><p id="evacueeBarcodeMessage" role="status" aria-live="polite"></p><figure id="evacueeBarcodePaper"><svg id="evacueeBarcodeSvg" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Issued evacuee barcode"></svg><figcaption id="evacueeBarcodeValue"></figcaption></figure><div class="barcode-viewer-actions"><button type="button" class="btn red" id="barcodeViewerPrint" disabled>Print Barcode</button><button type="button" class="btn out" id="barcodeViewerDownload" disabled>Download PDF</button><button type="button" class="btn out" id="barcodeViewerFullscreen">Full Screen</button></div></section>';
    document.body.appendChild(modal);
    byId('barcodeViewerClose').addEventListener('click',close);
    byId('barcodeViewerPrint').addEventListener('click',print);
    byId('barcodeViewerDownload').addEventListener('click',downloadPdf);
    byId('barcodeViewerFullscreen').addEventListener('click',toggleFullscreen);
    modal.addEventListener('click',event=>{if(event.target===modal || event.target.classList.contains('barcode-viewer-backdrop')) close();});
    return modal;
  }
  async function renderPaper(token){
    ready=false;controls();message('Loading your barcode...');
    try{
      if(!window.JsBarcode){
        const loaded=await window.ScanSafeBarcode?.ensureLibrary?.();
        if(!current(token)) return false;
        if(!loaded || !window.JsBarcode) throw new Error('Barcode library unavailable');
      }
      if(!current(token)) return false;
      const svg=byId('evacueeBarcodeSvg'),value=account.value;
      svg.setAttribute('data-barcode-value',value);
      window.JsBarcode(svg,value,{format:'CODE128',displayValue:false,lineColor:'#111111',background:'#ffffff',height:112,width:2,margin:24});
      const width=Number.parseFloat(svg.getAttribute('width'));
      const height=Number.parseFloat(svg.getAttribute('height'));
      if(!width || !height || !svg.querySelector('rect')) throw new Error('No barcode image');
      svg.setAttribute('viewBox','0 0 '+width+' '+height);
      svg.setAttribute('preserveAspectRatio','xMidYMid meet');
      svg.setAttribute('data-barcode-rendered',value);
      byId('evacueeBarcodeValue').textContent=value;
      ready=true;message('');controls();
      return true;
    }catch(error){
      if(current(token)){clearPaper();message('Your barcode could not be loaded. Check your connection and try Show Barcode again.');}
      return false;
    }
  }
  async function open(){
    if(!account){if(typeof window.toast==='function') window.toast('An approved registration with an issued barcode is required.');return false;}
    ensureModal();
    if(!opened){previousFocus=document.activeElement;opened=true;modal.hidden=false;document.body.classList.add('barcode-viewer-open');byId('barcodeViewerClose').focus();}
    if(ready) return true;
    if(!renderPromise){
      const token=revision;
      const promise=renderPaper(token);
      renderPromise=promise;
      promise.finally(()=>{if(renderPromise===promise) renderPromise=null;});
    }
    return renderPromise;
  }
  async function prepared(){
    if(!opened && !(await open())) return null;
    const token=revision;
    if(!ready && !(await open())) return null;
    if(!current(token)||!ready) return null;
    return {token,value:account.value,svg:byId('evacueeBarcodeSvg')};
  }
  async function print(){
    if(printing) return false;
    const paper=await prepared();
    if(!paper) return false;
    await exitNativeFullscreen();
    if(!current(paper.token)||!ready) return false;
    printing=true;controls();document.body.classList.add('barcode-printing');
    try{window.print();return true;}
    catch(error){finishPrint();message('Printing could not start. Please try again.');return false;}
  }
  function pdfBytes(svg,value){
    if(!/^[\x20-\x7e]+$/.test(value)) throw new Error('Unsupported printable code');
    const width=Number.parseFloat(svg.getAttribute('width'));
    const height=Number.parseFloat(svg.getAttribute('height'));
    const rootMatrix=svg.getCTM();
    if(!width||!height||!rootMatrix) throw new Error('Barcode is not visible');
    const inverse=rootMatrix.inverse();
    const pageWidth=148/25.4*72,pageHeight=105/25.4*72;
    const scale=Math.min((pageWidth-48)/width,90/height);
    const left=(pageWidth-width*scale)/2,top=(pageHeight-height*scale-24)/2;
    const n=value=>Number(value.toFixed(4));
    const paths=[];
    svg.querySelectorAll('rect').forEach(rect=>{
      const fill=(window.getComputedStyle(rect).fill||rect.getAttribute('fill')||'black').replace(/\s/g,'').toLowerCase();
      if(['none','transparent','white','#fff','#ffffff','rgb(255,255,255)','rgba(0,0,0,0)'].includes(fill)) return;
      const x=Number(rect.getAttribute('x')||0),y=Number(rect.getAttribute('y')||0);
      const w=Number(rect.getAttribute('width')),h=Number(rect.getAttribute('height'));
      const ctm=rect.getCTM();if(!w||!h||!ctm) return;
      const matrix=inverse.multiply(ctm);
      const points=[[x,y],[x+w,y],[x+w,y+h],[x,y+h]].map(([px,py])=>{
        const ux=matrix.a*px+matrix.c*py+matrix.e,uy=matrix.b*px+matrix.d*py+matrix.f;
        return [n(left+ux*scale),n(pageHeight-top-uy*scale)];
      });
      paths.push(points.map(([px,py],i)=>px+' '+py+(i?' l':' m')).join(' ')+' h f');
    });
    if(!paths.length) throw new Error('No barcode bars');
    const fontSize=Math.min(12,(pageWidth-48)/(value.length*.6));
    const textX=(pageWidth-value.length*fontSize*.6)/2;
    const textY=pageHeight-top-height*scale-16;
    const literal=value.replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)');
    const stream='0 g\n'+paths.join('\n')+'\nBT /F1 '+n(fontSize)+' Tf '+n(textX)+' '+n(textY)+' Td ('+literal+') Tj ET\n';
    const encoder=new TextEncoder();
    const objects=[
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 '+n(pageWidth)+' '+n(pageHeight)+'] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
      '<< /Length '+encoder.encode(stream).byteLength+' >>\nstream\n'+stream+'endstream'
    ];
    let pdf='%PDF-1.4\n';const offsets=[0];
    objects.forEach((object,index)=>{offsets.push(encoder.encode(pdf).byteLength);pdf+=(index+1)+' 0 obj\n'+object+'\nendobj\n';});
    const xref=encoder.encode(pdf).byteLength;
    pdf+='xref\n0 '+(objects.length+1)+'\n0000000000 65535 f \n'+offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size '+(objects.length+1)+' /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n';
    return encoder.encode(pdf);
  }
  async function downloadPdf(){
    const paper=await prepared();
    if(!paper) return false;
    try{
      const bytes=pdfBytes(paper.svg,paper.value);
      if(!current(paper.token)||!ready) return false;
      const url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
      const link=document.createElement('a');link.href=url;
      link.download='ScanSafe-Barcode-'+paper.value.replace(/[^a-z0-9_-]/gi,'_').slice(0,80)+'.pdf';
      document.body.appendChild(link);link.click();link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),30000);
      return true;
    }catch(error){if(current(paper.token)) message('The PDF could not be prepared. Please try again.');return false;}
  }
  async function toggleFullscreen(){
    if(!opened || !account) return false;
    const token=revision,expanded=modal.classList.contains('is-expanded');
    if(expanded){modal.classList.remove('is-expanded');nativeFullscreen=false;await exitNativeFullscreen();}
    else{
      modal.classList.add('is-expanded');
      if(modal.requestFullscreen){
        try{await modal.requestFullscreen();nativeFullscreen=true;}catch(error){/* The expanded view also works without browser fullscreen. */}
      }
    }
    if(!current(token)){await exitNativeFullscreen();return false;}
    byId('barcodeViewerFullscreen').textContent=modal.classList.contains('is-expanded')?'Exit Full Screen':'Full Screen';
    return true;
  }
  document.addEventListener('keydown',event=>{
    if(!opened) return;
    if(event.key==='Escape'){event.preventDefault();close();return;}
    if(event.key!=='Tab') return;
    const buttons=[...modal.querySelectorAll('button:not([disabled])')];
    const first=buttons[0],last=buttons[buttons.length-1];
    if(event.shiftKey && (document.activeElement===first || !modal.contains(document.activeElement))){event.preventDefault();last?.focus();}
    else if(!event.shiftKey && (document.activeElement===last || !modal.contains(document.activeElement))){event.preventDefault();first?.focus();}
  });
  document.addEventListener('fullscreenchange',()=>{
    if(nativeFullscreen && document.fullscreenElement!==modal){
      nativeFullscreen=false;modal?.classList.remove('is-expanded');
      const button=byId('barcodeViewerFullscreen');if(button) button.textContent='Full Screen';
    }
  });
  window.addEventListener('afterprint',finishPrint);
  if(typeof window.matchMedia==='function'){
    const media=window.matchMedia('print');
    const onChange=event=>{if(!event.matches) finishPrint();};
    if(media.addEventListener) media.addEventListener('change',onChange);
    else if(media.addListener) media.addListener(onChange);
  }
  window.ScanSafeBarcodeViewer={
    setAccount,open,close,print,downloadPdf,toggleFullscreen,
    inspect:()=>({open:opened,ready,printing,ownerId:account?.ownerId||null,value:account?.value||null})
  };
})();
