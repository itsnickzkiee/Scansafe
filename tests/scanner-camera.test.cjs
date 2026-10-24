'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixture = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="scannerStatus" role="status"></div><button id="scannerStartButton">Start Scanning</button>
<select id="scannerCameraSelect"></select><div class="scan-frame" style="width:400px;height:230px"><div id="scanSafeQrReader" style="width:100%"></div><svg id="scannerDetectionOverlay"><polygon id="scannerDetectionBox"></polygon></svg><span id="scannerDetectionHint"></span></div>
<input id="manualBarcode"><button id="manualScanButton">Search</button><div id="lastScannedEvacuee"></div><div id="scanResult" class="hidden"></div>
<svg id="sourceBarcode"></svg>
<script src="/assets/vendor/JsBarcode.all.min.js"></script><script src="/assets/vendor/html5-qrcode.min.js"></script>
<script src="/assets/vendor/quagga2.min.js"></script>
<script src="/assets/scanner-camera.js"></script><script src="/assets/scanner.js"></script>
<script>
(async()=>{
 const params=new URL(location.href).searchParams,legacy=params.get('code')==='legacy',angle=Number(params.get('angle')||0);
 const results=[],rpcCalls=[],geometry=[],detections=[];const code=legacy?'EVAC-0123456789abcdef0123456789abcdef':'240100123456';
 function check(value,message){if(!value)throw new Error(message);}
 const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 async function until(test,message,timeout=12000){const start=performance.now();while(!test()){if(performance.now()-start>timeout){const v=document.querySelector('#scanSafeQrReader video'),c=document.querySelector('#scanSafeQrReader canvas');throw new Error(message+'; camera='+JSON.stringify(ScanSafeScannerCamera.inspect())+'; status='+document.getElementById('scannerStatus').textContent+'; video='+JSON.stringify(v&&[v.videoWidth,v.videoHeight,v.clientWidth,v.clientHeight,v.currentTime,v.paused])+'; canvas='+JSON.stringify(c&&[c.width,c.height]));}await wait(60);}}
 async function scenario(name,body){try{await body();results.push({name,ok:true});}catch(error){results.push({name,ok:false,error:error.stack||String(error)});throw error;}}
 const svg=document.getElementById('sourceBarcode');JsBarcode(svg,code,{format:'CODE128',displayValue:false,width:legacy?2:3,height:legacy?112:140,margin:legacy?24:32});
 const sw=parseFloat(svg.getAttribute('width')),sh=parseFloat(svg.getAttribute('height'));check(sw>0&&sh>0,'renderer produced no barcode geometry');svg.setAttribute('xmlns','http://www.w3.org/2000/svg');
 const sourceUrl=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)],{type:'image/svg+xml'}));
 const image=await new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=reject;img.src=sourceUrl;});
 const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;const ctx=canvas.getContext('2d');
 let showBarcode=false;
 function paint(){ctx.save();ctx.fillStyle='#ffffff';ctx.fillRect(0,0,1280,720);if(showBarcode){ctx.translate(640,360);ctx.rotate(angle*Math.PI/180);ctx.drawImage(image,-sw/2,-sh/2,sw,sh);}ctx.restore();}
 paint();const painter=setInterval(paint,40);const streams=[];
 Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async()=>{
  const reader=document.getElementById('scanSafeQrReader');geometry.push({width:reader.clientWidth,scale:reader.style.transform,visibleWidth:reader.getBoundingClientRect().width});
  const stream=canvas.captureStream(15);streams.push(stream);return stream;
 }});
 Object.defineProperty(navigator.mediaDevices,'enumerateDevices',{configurable:true,value:async()=>[{kind:'videoinput',deviceId:'synthetic-camera',label:'Synthetic barcode camera'}]});
 window.ScanSafeDB={session:{user:{id:'staff-test'}},profile:{role:'staff',full_name:'Test Staff'},client:{rpc:async(name,args)=>{
  rpcCalls.push({name,args});return{error:null,data:{valid:true,result:'valid',qr_value:code,evacuee_id:50,group_id:12,full_name:'Nick Reyes',group_size:3,approval_status:'approved',needs_summary:'Wheelchair access',assignment_state:rpcCalls.length===1?'assigned':'already_assigned',space_code:'A2',space_name:'Hallway A2',shelter_name:'Main School Building'}};
 }}};
 const cameraInit=ScanSafeScannerCamera.init;
 ScanSafeScannerCamera.init=function(configuration){const previous=configuration.onDetection;return cameraInit({...configuration,onDetection:event=>{if(previous)previous(event);if(event){const overlay=document.getElementById('scannerDetectionOverlay');detections.push({...event,drawnPoints:document.getElementById('scannerDetectionBox').getAttribute('points'),drawnViewBox:overlay.getAttribute('viewBox'),drawnState:overlay.closest('.scan-frame').dataset.detection});}}});};
 ScanSafeScanner.init();
 try{
  await scenario('blank camera frames never verify an identity or create an assignment',async()=>{
   await ScanSafeScanner.toggle();await wait(600);check(rpcCalls.length===0,'blank camera frames caused a verification or assignment');check(!/Nick Reyes|Verified/i.test(document.getElementById('lastScannedEvacuee').textContent),'blank camera fabricated a verified evacuee');
   showBarcode=true;paint();const pixels=ctx.getImageData(0,360,1280,1).data;let darkPixels=0;for(let x=0;x<1280;x++)if(pixels[x*4]<128)darkPixels++;check(darkPixels>70,'synthetic video source is blank rather than a real barcode');
  });
  await scenario('live video automatically reads a complete issued CODE128 and calls the atomic scanner RPC once',async()=>{
   check(code.length===(legacy?37:12),'test value is not the full issued length');
   await until(()=>rpcCalls.length===1&&!ScanSafeScanner.inspect().busy,'The live camera did not automatically decode and verify the barcode');
   check(rpcCalls[0].name==='scan_and_assign_evacuee','camera did not use the atomic verify-and-assign RPC');check(rpcCalls[0].args.p_barcode_value===code,'camera truncated or changed the actual issued code');
   check(document.getElementById('lastScannedEvacuee').textContent.includes('Nick Reyes'),'verified evacuee info did not appear');check(document.getElementById('lastScannedEvacuee').textContent.includes('Wheelchair access'),'special needs did not appear');
   check(document.getElementById('scanResult').textContent.includes('Hallway A2'),'saved accommodation did not appear');check(!document.getElementById('scanResult').textContent.includes('Checked-in'),'scan marked the evacuee checked-in');
  });
  await scenario('preview remains responsive while decoding at camera resolution',async()=>{
   check(geometry.length>0,'camera startup geometry was not captured');check(geometry[0].width===1280,'decoder was reduced to the narrow screen layout');check(Math.abs(geometry[0].visibleWidth-400)<2,'preview exceeded the visible 400px frame');check(geometry[0].scale==='scale(0.3125)','preview did not scale from the high-resolution decoder surface');
  });
  await scenario('repeat video frames cannot produce duplicate verification or assignments',async()=>{
   await wait(500);check(rpcCalls.length===1,'the same live frames made duplicate assignment calls');check(streams[0].getTracks().every(track=>track.readyState==='ended'),'camera track stayed live after capture');
  });
  await scenario('Scan Next restarts the camera and retains the server existing assignment',async()=>{
   await until(()=>!ScanSafeScannerCamera.inspect().processing,'previous captured barcode never finished processing');await ScanSafeScanner.toggle();
   await until(()=>rpcCalls.length===2&&!ScanSafeScanner.inspect().busy,'Scan Next did not restart camera decoding');
   check(document.getElementById('scanResult').textContent.includes('Already assigned'),'second scan did not display the existing assignment');check(rpcCalls[1].args.p_barcode_value===code,'second scan changed the barcode');
   await wait(350);check(rpcCalls.length===2,'second capture made duplicate RPC calls');
  });
  await scenario('camera detection geometry is meaningful and never substitutes for database verification',async()=>{
   const located=detections.filter(event=>Array.isArray(event.box)&&event.box.length>=4);
   if(angle)check(located.length>0,'tilted live barcode produced no actual detected polygon');
   for(const event of located){
    check(event.width===1280&&event.height===720,'detection did not preserve original source video dimensions');check(event.box.every(point=>point.length===2&&point.every(Number.isFinite)),'detection coordinates are invalid');
    const xs=event.box.map(point=>point[0]),ys=event.box.map(point=>point[1]);check(Math.max(...xs)-Math.min(...xs)>50,'detected box is too small to represent the barcode');check(Math.max(...ys)-Math.min(...ys)>5,'detected box has no height');
    check(Math.abs((Math.max(...xs)+Math.min(...xs))/2-640)<90&&Math.abs((Math.max(...ys)+Math.min(...ys))/2-360)<70,'sampled locator box was not scaled back to the actual centered barcode');
    check(event.drawnViewBox==='0 0 1280 720','tracking overlay uses the wrong source coordinate system');check(event.drawnPoints&&event.drawnPoints.split(' ').length===4,'tracking overlay omitted the actual detected polygon');check(event.drawnState===(event.decoded?'decoded':'located'),'tracking UI confused a located pattern with decoded data');
   }
   check(rpcCalls.length===2,'locator event bypassed the single capture/verification flow');
  });
 }finally{await ScanSafeScannerCamera.stop();clearInterval(painter);streams.forEach(stream=>stream.getTracks().forEach(track=>track.stop()));URL.revokeObjectURL(sourceUrl);window.scannerCameraTestResults=results;}
})().catch(error=>{window.scannerCameraTestFailure=error.stack||String(error);});
</script></body></html>`;

async function devtools(port, pageUrl) {
  const pages = await fetch('http://127.0.0.1:' + port + '/json/list').then(response => response.json());
  const page = pages.find(value => value.type === 'page');
  assert.ok(page, 'Chrome did not expose a browser page');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let nextId = 0; const requests = new Map();
  socket.addEventListener('message', event => {
    const value = JSON.parse(event.data);
    if (!value.id || !requests.has(value.id)) return;
    const pending = requests.get(value.id); requests.delete(value.id);
    value.error ? pending.reject(new Error(JSON.stringify(value.error))) : pending.resolve(value.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; requests.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  await call('Page.enable'); await call('Page.navigate', { url: pageUrl });
  return { call, close: () => socket.close() };
}

test('real camera controller automatically decodes short, legacy and tilted CODE128 video frames', { timeout: 120000 }, async t => {
  const chrome = process.env.SCANSafe_CHROME || path.join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe');
  if (!fs.existsSync(chrome)) return t.skip('Chrome is required for the live camera pipeline check');
  assert.equal(typeof WebSocket, 'function', 'Node with a built-in WebSocket client is required');
  const allowed = ['/assets/vendor/JsBarcode.all.min.js', '/assets/vendor/html5-qrcode.min.js', '/assets/vendor/quagga2.min.js', '/assets/scanner-camera.js', '/assets/scanner.js'];
  const server = http.createServer((request, response) => {
    const filename = new URL(request.url, 'http://127.0.0.1').pathname;
    if (filename === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(fixture); }
    if (!allowed.includes(filename)) { response.writeHead(404); return response.end(); }
    response.setHeader('Content-Type', 'application/javascript'); fs.createReadStream(path.join(root, filename.slice(1))).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const tempRoot = path.resolve(os.tmpdir()); const profile = fs.mkdtempSync(path.join(tempRoot, 'scansafe-scanner-camera-test-'));
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--autoplay-policy=no-user-gesture-required', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; browser.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
  let connection;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort'); const startup = Date.now();let port=0;
    while (!port) {
      assert.ok(Date.now() - startup < 12000, 'Chrome did not start: ' + stderr);
      try { port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]); } catch(error) { if(!['ENOENT','EBUSY','EPERM'].includes(error.code))throw error; }
      if(!port)await delay(50);
    }
    for (const sample of [{name:'short numeric',query:'code=short'},{name:'legacy full value',query:'code=legacy'},{name:'short rotated 90 degrees',query:'code=short&angle=90'}]) {
      if(connection)connection.close();connection = await devtools(port, 'http://127.0.0.1:' + server.address().port + '/?' + sample.query);
      let results, failure; const started = Date.now();
      while (!results && !failure) {
        const evaluation = await connection.call('Runtime.evaluate', { expression: 'JSON.stringify({results:window.scannerCameraTestResults,failure:window.scannerCameraTestFailure})', returnByValue: true });
        const value = JSON.parse(evaluation.result.value || '{}'); results = value.results; failure = value.failure;
        assert.ok(Date.now() - started < 35000, 'Live camera integration did not finish: ' + sample.name + '; ' + stderr); if (!results && !failure) await delay(100);
      }
      assert.ok(!failure, sample.name + ': ' + failure); assert.equal(results.length, 6);
      for (const result of results) await t.test(sample.name + ': ' + result.name, () => assert.equal(result.ok, true, result.error));
    }
  } finally {
    if (connection) {
      await Promise.race([connection.call('Browser.close').catch(() => {}), delay(1000)]);
      connection.close();
    }
    if(browser.exitCode===null)browser.kill();
    if(browser.exitCode===null)await Promise.race([new Promise(resolve => browser.once('exit', resolve)), delay(3000)]);
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(profile)), tempRoot); assert.ok(path.basename(profile).startsWith('scansafe-scanner-camera-test-'));
    await fs.promises.rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
});
