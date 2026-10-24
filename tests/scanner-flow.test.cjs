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
<div id="scannerStatus" role="status"></div>
<button id="scannerStartButton">Start Scanning</button><select id="scannerCameraSelect"></select><div id="scanSafeQrReader"></div>
<input id="manualBarcode"><button id="manualScanButton">Search</button>
<div id="lastScannedEvacuee"></div><div id="scanResult" class="hidden"></div>
<script>
const rpcCalls=[];const localWrites=[];let rpcResponse={data:null,error:null};let rpcGate=null;
const sessionFor=id=>({user:{id}});
const camera={start:async()=>true,stop:async()=>true,dispose:async()=>true,inspect:()=>({running:false})};
window.ScanSafeScannerCamera=camera;
window.ScanSafeDB={configured:true,session:sessionFor('admin-one'),profile:{id:'admin-one',role:'admin'},client:{
 auth:{onAuthStateChange:callback=>{window.scannerAuthCallback=callback;return{data:{subscription:{unsubscribe(){}}}};}},
 rpc:async(name,args)=>{rpcCalls.push({name,args});const response=rpcResponse;const gate=rpcGate;if(gate)await gate;return response;}
}};
window.toast=()=>{};
window.addEventListener('error',event=>document.documentElement.dataset.runtimeError=event.message);
window.addEventListener('unhandledrejection',event=>document.documentElement.dataset.runtimeError=String(event.reason));
</script><script src="/assets/scanner.js"></script><script>
(async()=>{
 const results=[];const scanner=window.ScanSafeScanner;const get=id=>document.getElementById(id);
 const good={valid:true,result:'valid',message:'Approved active barcode verified.',qr_value:'EVAC-NICK-REAL',evacuee_id:50,group_id:12,full_name:'Nick Reyes',age:26,gender:'Male',group_size:3,current_status:'registered',approval_status:'approved',needs_summary:'None',address:'Marilao',contact_number:'09123456789',assignment_state:'assigned',assignment_message:'GBEAA assigned your group to Hallway A2.',assignment:{space_id:2,space_code:'A2',space_name:'Hallway A2',shelter_name:'Main School Building'},space_code:'A2',space_name:'Hallway A2',shelter_name:'Main School Building'};
 function check(value,message){if(!value)throw new Error(message);}
 const content=()=>get('scanResult').textContent+' '+get('lastScannedEvacuee').textContent;
 const reply=data=>rpcResponse={data,error:null};
 function user(id){window.ScanSafeDB.session=sessionFor(id);window.ScanSafeDB.profile={id,role:'admin'};}
 async function scenario(name,body){try{user('admin-one');rpcGate=null;rpcCalls.length=0;if(scanner)scanner.reset();await body();results.push({name,ok:true});}catch(error){results.push({name,ok:false,error:error.stack||String(error)});}finally{rpcGate=null;}}
 check(scanner&&typeof scanner.verify==='function','scanner API missing');await scanner.init();
 await scenario('active barcode displays database identity and its new GBEAA assignment',async()=>{
  reply({...good});await scanner.verify('EVAC-NICK-REAL');
  check(rpcCalls.length===1&&rpcCalls[0].name==='scan_and_assign_evacuee','scanner did not use the atomic scan RPC');check(rpcCalls[0].args.p_barcode_value==='EVAC-NICK-REAL','scanner changed barcode input');
  check(!get('scanResult').classList.contains('hidden'),'result remains hidden');check(/verified/i.test(get('scanResult').textContent),'valid code was not verified');check(content().includes('Nick Reyes')&&content().includes('Hallway A2'),'real identity or recommended space missing');
  check(!/check-in confirmed|status\\s*:?\\s*checked[ -]?in/i.test(content()),'scan falsely claimed check-in');check(rpcCalls.every(call=>call.name==='scan_and_assign_evacuee'),'scan called a legacy verification/check-in mutation');
 });
 await scenario('existing assignment is shown without claiming a fresh assignment',async()=>{
  reply({...good,assignment_state:'already_assigned',assignment_message:'This group is already assigned to Hallway A2.'});await scanner.verify('EXISTING-CODE');
  check(/verified/i.test(get('scanResult').textContent),'existing assignment lost verification');check(/already assigned/i.test(content()),'existing assignment was not identified');check(content().includes('Hallway A2'),'existing assigned space missing');
 });
 await scenario('valid code remains verified when no suitable accommodation exists',async()=>{
  reply({...good,assignment_state:'unavailable',assignment_message:'No suitable accommodation currently has capacity.',assignment:null,space_code:null,space_name:null,shelter_name:null});await scanner.verify('WAITING-CODE');
  check(/verified/i.test(get('scanResult').textContent),'capacity failure marked valid barcode invalid');check(/waiting for assignment|no suitable accommodation/i.test(content()),'unavailable space did not explain waiting');check(!content().includes('Hallway A2'),'unavailable assignment retained an old space');check(content().includes('Nick Reyes'),'valid evacuee information missing when unassigned');
 });
 await scenario('invalid and revoked barcodes never expose or assign an evacuee',async()=>{
  for(const [code,reason] of [['UNKNOWN-CODE','Barcode not found'],['REVOKED-CODE','Barcode is revoked']]){
   reply({valid:false,result:'invalid',message:reason,qr_value:code,assignment_state:'not_eligible',assignment:null});await scanner.verify(code);
   check(!get('scanResult').classList.contains('hidden'),'invalid result hidden');check(new RegExp(reason,'i').test(content()),'invalid reason missing');check(!content().includes('Nick Reyes')&&!content().includes('Hallway A2'),'invalid barcode exposed previous evacuee or assignment');check(!/^\\s*VERIFIED\\b/i.test(get('scanResult').textContent),'invalid barcode reported verified');
  }
 });
 await scenario('backend error is visibly unavailable instead of a false invalid barcode',async()=>{
  rpcResponse={data:null,error:{code:'42501',message:'Only authorized staff can use this scanner'}};await scanner.verify('BACKEND-ERROR-CODE');
  check(/verification unavailable/i.test(content()),'backend failure was not shown as unavailable');check(!/invalid barcode|barcode not found/i.test(content()),'backend error was mislabeled as invalid barcode');check(!content().includes('Nick Reyes'),'backend failure exposed old identity');
 });
 await scenario('missing atomic RPC explains SQL setup and never falls back to simulated success',async()=>{
  rpcResponse={data:null,error:{code:'PGRST202',message:'Could not find the function public.scan_and_assign_evacuee in the schema cache'}};await scanner.verify('MISSING-RPC-CODE');
  check(content().includes('SUPABASE_SCANNER_GBEAA_FIX.sql'),'missing RPC did not identify the required migration');check(rpcCalls.length===1&&rpcCalls[0].name==='scan_and_assign_evacuee','missing RPC invoked a legacy fallback');check(!content().includes('Nick Reyes'),'missing RPC fabricated a record');
 });
 await scenario('duplicate camera decodes and different input while busy make only one RPC',async()=>{
  let release;rpcGate=new Promise(resolve=>release=resolve);reply({...good});const first=scanner.verify('ONE-IN-FLIGHT');const repeated=scanner.verify('ONE-IN-FLIGHT');const other=scanner.verify('OTHER-IN-FLIGHT');
  await Promise.resolve();check(rpcCalls.length===1,'busy scanner sent duplicate or overlapping RPCs');check(get('manualScanButton').disabled,'manual control remained active while verifying');
  release();await Promise.all([first,repeated,other]);check(rpcCalls.length===1,'busy scanner queued an unintended second scan');check(!get('manualScanButton').disabled,'manual control remained disabled after result');
 });
 await scenario('account reset discards an in-flight identity and clears prior information',async()=>{
  reply({...good});await scanner.verify('BEFORE-ACCOUNT-SWITCH');check(content().includes('Nick Reyes'),'precondition: previous result missing');
  let release;rpcGate=new Promise(resolve=>release=resolve);const pending=scanner.verify('PENDING-OLD-ACCOUNT');user('admin-two');scanner.reset();check(!content().includes('Nick Reyes'),'account reset retained evacuee information');release();await pending;check(!content().includes('Nick Reyes')&&!content().includes('Hallway A2'),'stale account response repopulated evacuee information');
 });
 await scenario('context change without explicit reset still rejects a stale response',async()=>{
  let release;rpcGate=new Promise(resolve=>release=resolve);reply({...good});const pending=scanner.verify('STALE-CONTEXT');user('admin-three');release();await pending;
  check(!content().includes('Nick Reyes')&&!content().includes('Hallway A2'),'response crossed authenticated scanner contexts');
 });
 await scenario('database text is escaped instead of becoming executable HTML',async()=>{
  const marker='<img data-scanner-injected="yes" src="bad" onerror="window.scannerInjected=true">';reply({...good,full_name:marker,needs_summary:marker,address:marker,contact_number:marker,qr_value:marker,space_name:marker,assignment_message:marker,assignment:{...good.assignment,space_name:marker}});await scanner.verify('HTML-ESCAPING-CODE');
  check(content().includes(marker),'database text was changed or omitted');check(!document.querySelector('[data-scanner-injected]'),'database text created injected HTML');check(!window.scannerInjected,'database text executed script');
 });
 await scenario('manual lookup uses the entered value and empty input sends no request',async()=>{
  reply({...good});get('manualBarcode').value='MANUAL-ACTUAL-CODE';await scanner.manual();check(rpcCalls.length===1&&rpcCalls[0].args.p_barcode_value==='MANUAL-ACTUAL-CODE','manual lookup ignored entered code');get('manualBarcode').value='  ';await scanner.manual();check(rpcCalls.length===1,'blank input sent a request');
 });
 await scenario('auth account change clears displayed information immediately',async()=>{
  reply({...good});await scanner.verify('PREVIOUS-STAFF-CODE');check(content().includes('Nick Reyes'),'previous verified info missing');
  user('new-admin');window.scannerAuthCallback('SIGNED_IN',sessionFor('new-admin'));
  check(!content().includes('Nick Reyes')&&!content().includes('Hallway A2'),'auth switch retained previous scanned identity');
 });
 await scenario('loss of staff access cancels a pending result and blocks further scans',async()=>{
  let release;rpcGate=new Promise(resolve=>release=resolve);reply({...good});const pending=scanner.verify('STAFF-ONLY-CODE');
  window.ScanSafeDB.profile.role='evacuee';release();await pending;check(!content().includes('Nick Reyes'),'stale result survived loss of staff role');
  rpcCalls.length=0;await scanner.verify('BLOCKED-CODE');check(rpcCalls.length===0,'nonstaff scanner called database');check(/administrator or staff/i.test(content()),'staff requirement missing');
 });
 const output=document.createElement('pre');output.id='scannerFlowTestResults';output.textContent=JSON.stringify(results);document.body.append(output);
})().catch(error=>{document.documentElement.dataset.runtimeError=error.stack||String(error);});
</script></body></html>`;

test('scanner verifies actual barcodes, renders GBEAA outcomes and isolates concurrent accounts', { timeout: 60000 }, async t => {
  const chrome = process.env.SCANSafe_CHROME || path.join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe');
  if (!fs.existsSync(chrome)) return t.skip('Chrome is required for the scanner browser regression check');
  assert.ok(fs.existsSync(path.join(root, 'assets/scanner.js')), 'scanner implementation missing');
  const server = http.createServer((request, response) => {
    const filename = new URL(request.url, 'http://127.0.0.1').pathname;
    if (filename === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); return response.end(fixture); }
    if (filename !== '/assets/scanner.js') { response.writeHead(404); return response.end(); }
    response.setHeader('Content-Type', 'application/javascript');fs.createReadStream(path.join(root, 'assets/scanner.js')).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const tempRoot = path.resolve(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(tempRoot, 'scansafe-scanner-flow-test-'));
  try {
    const { stdout, stderr } = await run(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--user-data-dir=' + profile, '--virtual-time-budget=5000', '--dump-dom', 'http://127.0.0.1:' + server.address().port + '/'], { timeout: 45000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    const runtimeError = stdout.match(/data-runtime-error="([^"]+)"/);
    assert.equal(runtimeError, null, runtimeError?.[1]);
    const output = stdout.match(/<pre id="scannerFlowTestResults">([\s\S]*?)<\/pre>/);
    assert.ok(output, 'browser scenarios did not finish: ' + stderr.slice(-800));
    const results = JSON.parse(output[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
    assert.equal(results.length, 13);
    for (const result of results) await t.test(result.name, () => assert.equal(result.ok, true, result.error));
  } finally {
    await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(profile)), tempRoot, 'temporary browser profile must stay inside the OS temp directory');
    assert.ok(path.basename(profile).startsWith('scansafe-scanner-flow-test-'));
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
