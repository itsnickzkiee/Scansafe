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
const fixture = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="decodeReader" style="width:1400px;height:300px"></div><svg id="comparisonBarcode"></svg>
<script src="/assets/vendor/JsBarcode.all.min.js"></script>
<script src="/assets/vendor/html5-qrcode.min.js"></script><script src="/assets/vendor/quagga2.min.js"></script>
<script src="/assets/barcode-viewer.js"></script><script>
(async()=>{
 const results=[];const shortCode='240100123456',legacyCode='EVAC-0123456789abcdef0123456789abcdef';
 function check(value,message){if(!value)throw new Error(message);}
 async function scenario(name,body){try{await body();results.push({name,ok:true});}catch(error){results.push({name,ok:false,error:error.stack||String(error)});}}
 async function renderIssued(value){
  ScanSafeBarcodeViewer.setAccount({ownerId:'real-image-fixture',value});check(await ScanSafeBarcodeViewer.open(),'actual issued barcode viewer did not open');
  const svg=document.getElementById('evacueeBarcodeSvg'),width=parseFloat(svg.getAttribute('width')),height=parseFloat(svg.getAttribute('height'));
  check(width>0&&height>0,'viewer renderer produced no barcode geometry');check(document.getElementById('evacueeBarcodeValue').textContent===value,'viewer did not display the exact canonical code');
  const url=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)],{type:'image/svg+xml'}));
  const image=await new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('Could not rasterize the actual viewer SVG barcode'));img.src=url;});
  ScanSafeBarcodeViewer.close();return{value,width,height,image,url};
 }
 const short=await renderIssued(shortCode),legacy=await renderIssued(legacyCode);
 await scenario('new 12-digit issued code remains exact and produces fewer bars than a full legacy value',async()=>{
  check(/^[0-9]{12}$/.test(shortCode),'short test value must contain exactly 12 digits');check(legacyCode.length===37,'legacy test must preserve all 37 characters');
  const svg=document.getElementById('comparisonBarcode'),widths=[];
  for(const value of [shortCode,legacyCode]){JsBarcode(svg,value,{format:'CODE128',displayValue:false,width:3,height:140,margin:32});widths.push(parseFloat(svg.getAttribute('width')));}
  check(widths[0]<widths[1]*.5,'short code did not materially reduce barcode width at the same module width: '+widths);
  check(short.width<legacy.width,'actual viewer did not reduce the short barcode width');
 });
 const reader=new Html5Qrcode('decodeReader',{formatsToSupport:[Html5QrcodeSupportedFormats.CODE_128],useBarCodeDetectorIfSupported:false,experimentalFeatures:{useBarCodeDetectorIfSupported:false},verbose:false});
 async function pngFile(source,width,blank=false){
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=Math.max(120,Math.round(source.height*width/source.width));const ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);if(!blank)ctx.drawImage(source.image,0,0,canvas.width,canvas.height);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));check(blob&&blob.size>0,'PNG rasterization failed');return new File([blob],blank?'blank.png':'actual-code-'+width+'.png',{type:'image/png'});
 }
 for(const source of [short,legacy])for(const width of source===short?[short.width,400,360]:[legacy.width,1280,960]){
  await scenario('actual viewer CODE128 decodes the complete '+source.value.length+'-character value at '+width+' pixels',async()=>{
   const file=await pngFile(source,width);const result=await reader.scanFileV2(file,false);check(result.decodedText===source.value,'decoder returned a different or truncated value: '+result.decodedText);
   const format=result.result?.format?.formatName;if(format)check(/code.?128/i.test(format),'image was decoded as the wrong format: '+format);
  });
 }
 function locatedFrame(angle,blank=false){
  const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,1280,720);
  if(!blank){ctx.translate(640,360);ctx.rotate(angle*Math.PI/180);ctx.drawImage(short.image,-short.width/2,-short.height/2,short.width,short.height);}return canvas;
 }
 async function locate(canvas){return await new Promise(resolve=>Quagga.decodeSingle({src:canvas.toDataURL('image/jpeg',.94),inputStream:{size:800},locate:true,numOfWorkers:0,locator:{halfSample:false,patchSize:'medium'},decoder:{readers:['code_128_reader']}},resolve));}
 for(const angle of [-12,12])await scenario('real locator decodes a '+angle+' degree barcode and returns its detected polygon',async()=>{
  const frame=locatedFrame(angle),result=await locate(frame);check(result?.codeResult?.code===shortCode,'locator did not decode the rotated exact short value: '+JSON.stringify(result?.codeResult));
  check(Array.isArray(result.box)&&result.box.length>=4,'locator returned no actual bounding polygon');const xs=result.box.map(p=>p[0]),ys=result.box.map(p=>p[1]);
  check(result.box.every(p=>p.length===2&&p.every(Number.isFinite)),'locator polygon has invalid coordinates');
  check(Math.min(...xs)>=0&&Math.max(...xs)<=800&&Math.min(...ys)>=0&&Math.max(...ys)<=450,'locator polygon is outside its configured 800x450 processing dimensions');
  check(Math.max(...xs)-Math.min(...xs)>150&&Math.max(...xs)-Math.min(...xs)<800*.9,'locator returned a meaningless full-frame or tiny box');
 });
 await scenario('blank images cannot produce a decoded or verified evacuee value',async()=>{
  let rejected=false;try{await reader.scanFileV2(await pngFile(short,400,true),false);}catch(error){rejected=true;}check(rejected,'blank image unexpectedly decoded as a barcode');
  const result=await locate(locatedFrame(0,true));check(!result?.codeResult?.code,'locator fabricated a barcode on a blank frame');
 });
 reader.clear();for(const source of [short,legacy])URL.revokeObjectURL(source.url);
 const output=document.createElement('pre');output.id='scannerDecodeTestResults';output.textContent=JSON.stringify(results);document.body.append(output);
})().catch(error=>{document.documentElement.dataset.runtimeError=error.stack||String(error);});
</script></body></html>`;

test('vendored CODE128 renderer and decoder round-trip real evacuee barcode images', { timeout: 60000 }, async t => {
  const chrome = process.env.SCANSafe_CHROME || path.join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe');
  if (!fs.existsSync(chrome)) return t.skip('Chrome is required for the real barcode image decode check');
  const allowed = ['/assets/vendor/JsBarcode.all.min.js', '/assets/vendor/html5-qrcode.min.js', '/assets/vendor/quagga2.min.js', '/assets/barcode-viewer.js'];
  for (const filename of allowed) assert.ok(fs.existsSync(path.join(root, filename.slice(1))), 'vendored barcode library missing: ' + filename);
  const server = http.createServer((request, response) => {
    const filename = new URL(request.url, 'http://127.0.0.1').pathname;
    if (filename === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(fixture); }
    if (!allowed.includes(filename)) { response.writeHead(404); return response.end(); }
    response.setHeader('Content-Type', 'application/javascript');fs.createReadStream(path.join(root, filename.slice(1))).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const tempRoot = path.resolve(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(tempRoot, 'scansafe-scanner-decode-test-'));
  try {
    const { stdout, stderr } = await run(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--user-data-dir=' + profile, '--virtual-time-budget=10000', '--dump-dom', 'http://127.0.0.1:' + server.address().port + '/'], { timeout: 45000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    const runtimeError = stdout.match(/data-runtime-error="([^"]+)"/);
    assert.ok(!runtimeError, runtimeError?.[1]);
    const output = stdout.match(/<pre id="scannerDecodeTestResults">([\s\S]*?)<\/pre>/);
    assert.ok(output, 'real barcode decode scenarios did not finish: ' + stderr.slice(-800));
    const results = JSON.parse(output[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
    assert.equal(results.length, 10);
    for (const result of results) await t.test(result.name, () => assert.equal(result.ok, true, result.error));
  } finally {
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(profile)), tempRoot, 'temporary browser profile must stay inside the OS temp directory');
    assert.ok(path.basename(profile).startsWith('scansafe-scanner-decode-test-'));
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
