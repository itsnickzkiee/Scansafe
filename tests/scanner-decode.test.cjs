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
<div id="decodeReader" style="width:1400px;height:240px"></div><svg id="sourceBarcode"></svg>
<script src="/assets/vendor/JsBarcode.all.min.js"></script>
<script src="/assets/vendor/html5-qrcode.min.js"></script><script>
(async()=>{
 const results=[];const code='EVAC-0123456789abcdef0123456789abcdef';
 function check(value,message){if(!value)throw new Error(message);}
 async function scenario(name,body){try{await body();results.push({name,ok:true});}catch(error){results.push({name,ok:false,error:error.stack||String(error)});}}
 const svg=document.getElementById('sourceBarcode');
 JsBarcode(svg,code,{format:'CODE128',displayValue:false,lineColor:'#111111',background:'#ffffff',height:112,width:2,margin:24});
 const originalWidth=parseFloat(svg.getAttribute('width'));const originalHeight=parseFloat(svg.getAttribute('height'));
 check(code.length===37,'test must use the complete server-issued code length');check(originalWidth>0&&originalHeight>0,'renderer produced no barcode geometry');
 svg.setAttribute('xmlns','http://www.w3.org/2000/svg');svg.setAttribute('viewBox','0 0 '+originalWidth+' '+originalHeight);
 const sourceUrl=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)],{type:'image/svg+xml'}));
 const image=await new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('Could not rasterize the actual SVG barcode'));img.src=sourceUrl;});
 const reader=new Html5Qrcode('decodeReader',{formatsToSupport:[Html5QrcodeSupportedFormats.CODE_128],useBarCodeDetectorIfSupported:false,experimentalFeatures:{useBarCodeDetectorIfSupported:false},verbose:false});
 async function pngFile(width,blank=false){
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=Math.max(120,Math.round(originalHeight*width/originalWidth));const ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);if(!blank)ctx.drawImage(image,0,0,canvas.width,canvas.height);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));check(blob&&blob.size>0,'PNG rasterization failed');return new File([blob],blank?'blank.png':'actual-code-'+width+'.png',{type:'image/png'});
 }
 for(const width of [originalWidth,1280,960]){
  await scenario('actual CODE128 renderer decodes the complete 37-character value at '+width+' pixels',async()=>{
   const file=await pngFile(width);const result=await reader.scanFileV2(file,false);check(result.decodedText===code,'decoder returned a different or truncated value: '+result.decodedText);
   const format=result.result?.format?.formatName;if(format)check(/code.?128/i.test(format),'image was decoded as the wrong format: '+format);
  });
 }
 await scenario('a blank image is rejected rather than producing an evacuee code',async()=>{let rejected=false;try{await reader.scanFileV2(await pngFile(960,true),false);}catch(error){rejected=true;}check(rejected,'blank image unexpectedly decoded as a barcode');});
 reader.clear();URL.revokeObjectURL(sourceUrl);
 const output=document.createElement('pre');output.id='scannerDecodeTestResults';output.textContent=JSON.stringify(results);document.body.append(output);
})().catch(error=>{document.documentElement.dataset.runtimeError=error.stack||String(error);});
</script></body></html>`;

test('vendored CODE128 renderer and decoder round-trip real evacuee barcode images', { timeout: 60000 }, async t => {
  const chrome = process.env.SCANSafe_CHROME || path.join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe');
  if (!fs.existsSync(chrome)) return t.skip('Chrome is required for the real barcode image decode check');
  const allowed = ['/assets/vendor/JsBarcode.all.min.js', '/assets/vendor/html5-qrcode.min.js'];
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
    assert.equal(results.length, 4);
    for (const result of results) await t.test(result.name, () => assert.equal(result.ok, true, result.error));
  } finally {
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(profile)), tempRoot, 'temporary browser profile must stay inside the OS temp directory');
    assert.ok(path.basename(profile).startsWith('scansafe-scanner-decode-test-'));
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
