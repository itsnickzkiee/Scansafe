'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const root = path.resolve(__dirname, '..');
const run = promisify(execFile);
const fixture = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/assets/style.css"></head><body>
<button id="launcher">Show Barcode</button><p id="privateIdentity">PRIVATE_USER_NAME PRIVATE_ADDRESS</p>
<script>
const pdfBlobs=[];const downloads=[];const printCalls=[];
URL.createObjectURL=blob=>{pdfBlobs.push(blob);return 'blob:test-'+pdfBlobs.length;};URL.revokeObjectURL=()=>{};
HTMLAnchorElement.prototype.click=function(){downloads.push({href:this.href,download:this.download});};
let fullscreenElement=null;Object.defineProperty(document,'fullscreenElement',{get:()=>fullscreenElement,configurable:true});
Element.prototype.requestFullscreen=async function(){fullscreenElement=this;document.dispatchEvent(new Event('fullscreenchange'));};
document.exitFullscreen=async()=>{fullscreenElement=null;document.dispatchEvent(new Event('fullscreenchange'));};
window.print=()=>printCalls.push({printing:document.body.classList.contains('barcode-printing'),paper:document.getElementById('evacueeBarcodePaper').textContent});
window.JsBarcode=(svg,value)=>{
 svg.setAttribute('data-rendered-code',value);svg.setAttribute('width','240');svg.setAttribute('height','80');svg.setAttribute('viewBox','0 0 240 80');svg.replaceChildren();
 for(let x=12;x<228;x+=6){const bar=document.createElementNS('http://www.w3.org/2000/svg','rect');bar.setAttribute('x',x);bar.setAttribute('y','4');bar.setAttribute('width','2');bar.setAttribute('height','72');bar.setAttribute('fill','#111');svg.append(bar);}
};
window.ScanSafeBarcode={ensureLibrary:async()=>true,render:async()=>document.querySelectorAll('.scansafe-barcode[data-barcode-value]').forEach(svg=>JsBarcode(svg,svg.getAttribute('data-barcode-value')))};
window.addEventListener('error',event=>document.documentElement.dataset.runtimeError=event.message);
window.addEventListener('unhandledrejection',event=>document.documentElement.dataset.runtimeError=String(event.reason));
</script><script src="/assets/barcode-viewer.js"></script><script>
(async()=>{
 const results=[];const viewer=window.ScanSafeBarcodeViewer;const code='REAL-50-()'+String.fromCharCode(92)+'A';
 function check(value,message){if(!value)throw new Error(message);}
 async function scenario(name,run){try{await run();results.push({name,ok:true});}catch(error){results.push({name,ok:false,error:error.stack||String(error)});}}
 const get=id=>document.getElementById(id);
 await scenario('no issued barcode cannot open',async()=>{check(viewer,'viewer API missing');viewer.setAccount({ownerId:'nick-id',value:null});check(await viewer.open()===false,'empty account opened');check(!document.body.classList.contains('barcode-viewer-open'),'empty account locks page');});
 await scenario('actual code renders in focused accessible modal',async()=>{
  get('launcher').focus();viewer.setAccount({ownerId:'nick-id',value:code});check(await viewer.open()===true,'issued account did not open');
  const modal=get('evacueeBarcodeViewer');check(modal&&!modal.hidden,'dialog hidden');check(document.body.classList.contains('barcode-viewer-open'),'page was not locked');
  check(get('evacueeBarcodeValue').textContent===code,'code text changed');check(get('evacueeBarcodeSvg').getAttribute('data-barcode-value')===code,'SVG bound to a different code');check(get('evacueeBarcodeSvg').querySelectorAll('rect').length>0,'barcode bars absent');
  check(get('evacueeBarcodePaper').textContent.trim()===code,'paper includes more than barcode and code');check(modal.contains(document.activeElement),'focus was not moved into dialog');
 });
 await scenario('same account polling preserves an open viewer',async()=>{viewer.setAccount({ownerId:'nick-id',value:code});check(!get('evacueeBarcodeViewer').hidden,'same account update closed viewer');check(get('evacueeBarcodeValue').textContent===code,'poll changed code');});
 await scenario('print isolates barcode paper until afterprint',async()=>{check(await viewer.print()===true,'print rejected real barcode');check(printCalls.length===1,'native print was not called');check(printCalls[0].printing,'print called without isolation class');check(printCalls[0].paper.trim()===code,'print paper includes personal details');window.dispatchEvent(new Event('afterprint'));check(!document.body.classList.contains('barcode-printing'),'print class survived afterprint');});
 await scenario('PDF preserves actual code and exports SVG bar geometry only',async()=>{
  check(await viewer.downloadPdf()===true,'PDF download rejected valid barcode');check(pdfBlobs.length===1,'PDF Blob not created');check(downloads.length===1&&/\\.pdf$/i.test(downloads[0].download),'PDF download missing');
  const pdf=await pdfBlobs[0].text();check(pdf.startsWith('%PDF-'),'download is not a PDF');check(/\\/MediaBox\\s*\\[\\s*0\\s+0\\s+419(?:\\.\\d+)?\\s+297(?:\\.\\d+)?\\s*\\]/.test(pdf),'PDF is not A6 landscape');check(/\\bre\\s+f\\b/.test(pdf)||/\\bm\\s+[\\s\\S]*?\\bl\\s+[\\s\\S]*?\\bh\\s+f\\b/.test(pdf),'PDF does not include barcode bar geometry');
  check(pdf.includes(code.replace(/([\\\\()])/g,'\\\\$1')),'PDF lost or changed the actual barcode value');check(!pdf.includes('PRIVATE_USER_NAME')&&!pdf.includes('PRIVATE_ADDRESS'),'PDF exposed personal details');check(/xref/.test(pdf)&&/%%EOF/.test(pdf),'PDF structure incomplete');
 });
 await scenario('fullscreen uses and exits the browser fullscreen API',async()=>{check(await viewer.toggleFullscreen()===true,'fullscreen rejected');check(document.fullscreenElement,'fullscreen not entered');await viewer.toggleFullscreen();check(!document.fullscreenElement,'fullscreen not exited');});
 await scenario('keyboard Tab stays within dialog controls',async()=>{const buttons=[...get('evacueeBarcodeViewer').querySelectorAll('button:not([disabled])')];const first=buttons[0],last=buttons[buttons.length-1];last.focus();document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));check(document.activeElement===first,'Tab escaped final dialog control');document.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));check(document.activeElement===last,'Shift Tab escaped first dialog control');});
 await scenario('Escape closes and returns focus to Show Barcode',async()=>{document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));check(get('evacueeBarcodeViewer').hidden,'Escape did not hide dialog');check(!document.body.classList.contains('barcode-viewer-open'),'Escape left page locked');check(document.activeElement===get('launcher'),'focus did not return to launcher');});
 await scenario('changed barcode and revoked code close and clear existing dialog',async()=>{
  get('launcher').focus();await viewer.open();viewer.setAccount({ownerId:'nick-id',value:'CHANGED-51'});check(get('evacueeBarcodeViewer').hidden,'new code left old modal open');check(!get('evacueeBarcodeValue').textContent.includes(code),'old code text retained');
  await viewer.open();viewer.setAccount({ownerId:'nick-id',value:null});check(get('evacueeBarcodeViewer').hidden,'revocation left modal open');check(!get('evacueeBarcodeSvg').getAttribute('data-barcode-value'),'revoked SVG value retained');check(await viewer.open()===false,'revoked account could reopen');check(await viewer.downloadPdf()===false,'revoked barcode exported');
 });
 await scenario('account switch clears barcode even when new code matches',async()=>{viewer.setAccount({ownerId:'nick-id',value:code});await viewer.open();viewer.setAccount({ownerId:'other-id',value:code});check(get('evacueeBarcodeViewer').hidden,'owner switch left modal open');check(get('evacueeBarcodeValue').textContent==='','owner switch left code visible');check(!document.body.classList.contains('barcode-viewer-open'),'owner switch left page locked');});
 await scenario('blocked native fullscreen still expands the barcode viewer',async()=>{const original=Element.prototype.requestFullscreen;Element.prototype.requestFullscreen=async()=>{throw new Error('Fullscreen denied');};try{await viewer.open();check(await viewer.toggleFullscreen()===true,'fullscreen fallback failed');check(get('evacueeBarcodeViewer').classList.contains('is-expanded'),'fallback did not expand dialog');await viewer.toggleFullscreen();check(!get('evacueeBarcodeViewer').classList.contains('is-expanded'),'fallback did not collapse dialog');}finally{Element.prototype.requestFullscreen=original;}});
 await scenario('failed native print clears the print isolation class',async()=>{const original=window.print;window.print=()=>{throw new Error('Printer unavailable');};try{check(await viewer.print()===false,'failed native print reported success');check(!document.body.classList.contains('barcode-printing'),'failed print left isolation active');check(!get('barcodeViewerPrint').disabled,'failed print left controls disabled');}finally{window.print=original;}});
 await scenario('account change cancels a pending barcode-library load',async()=>{const renderer=window.JsBarcode;const ensureLibrary=window.ScanSafeBarcode.ensureLibrary;let release;const gate=new Promise(resolve=>release=resolve);viewer.close();viewer.setAccount({ownerId:'other-id',value:'WAITING-CODE'});delete window.JsBarcode;window.ScanSafeBarcode.ensureLibrary=()=>gate;const pending=viewer.open();viewer.setAccount({ownerId:'third-id',value:'THIRD-ACCOUNT-CODE'});window.JsBarcode=renderer;release(true);check(await pending===false,'stale pending open reported success');check(get('evacueeBarcodeViewer').hidden,'pending old account reopened dialog');check(get('evacueeBarcodeValue').textContent==='','pending old account exposed its code');window.ScanSafeBarcode.ensureLibrary=ensureLibrary;});
 const output=document.createElement('pre');output.id='barcodeViewerTestResults';output.textContent=JSON.stringify(results);document.body.append(output);
})();
</script></body></html>`;

test('barcode popup lifecycle, account isolation, print and downloadable PDF in a real browser', { timeout: 60000 }, async t => {
  const chrome = process.env.SCANSafe_CHROME || path.join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe');
  if (!fs.existsSync(chrome)) return t.skip('Chrome is required for the popup browser regression check');
  assert.ok(fs.existsSync(path.join(root, 'assets/barcode-viewer.js')), 'barcode viewer implementation missing');
  const server = http.createServer((request, response) => {
    const filename = new URL(request.url, 'http://127.0.0.1').pathname;
    if (filename === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(fixture); }
    const allowed = ['/assets/barcode-viewer.js', '/assets/styles.css', '/assets/style.css'];
    if (!allowed.includes(filename)) { response.writeHead(404); return response.end(); }
    const target = path.join(root, filename.slice(1));
    if (!fs.existsSync(target)) { response.writeHead(404); return response.end(); }
    response.setHeader('Content-Type', filename.endsWith('.js') ? 'application/javascript' : 'text/css');
    fs.createReadStream(target).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const tempRoot = path.resolve(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(tempRoot, 'scansafe-barcode-popup-test-'));
  try {
    const { stdout, stderr } = await run(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--user-data-dir=' + profile, '--virtual-time-budget=5000', '--dump-dom', 'http://127.0.0.1:' + server.address().port + '/'], { timeout: 45000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    const runtimeError = stdout.match(/data-runtime-error="([^"]+)"/);
    assert.equal(runtimeError, null, runtimeError?.[1]);
    const output = stdout.match(/<pre id="barcodeViewerTestResults">([\s\S]*?)<\/pre>/);
    assert.ok(output, 'browser scenarios did not finish: ' + stderr.slice(-800));
    const results = JSON.parse(output[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
    assert.equal(results.length, 13);
    for (const result of results) await t.test(result.name, () => assert.equal(result.ok, true, result.error));
  } finally {
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(profile)), tempRoot, 'temporary browser profile must stay inside the OS temp directory');
    assert.ok(path.basename(profile).startsWith('scansafe-barcode-popup-test-'));
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
