"""Exercise the actual scanner template and bridge with a local backend fixture."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from importlib.util import module_from_spec, spec_from_file_location

ROOT = Path(__file__).resolve().parents[1]
spec = spec_from_file_location('admin_smoke', Path(__file__).with_name('admin-browser-smoke.py'))
admin = module_from_spec(spec)
sys.dont_write_bytecode = True
spec.loader.exec_module(admin)
SETUP = r"""<script>
const originalRpc=backend.rpc;const scanCalls=[];
backend.rpc=async(name,args)=>{
 if(name!=='scan_and_assign_evacuee')return originalRpc(name,args);
 scanCalls.push(args.p_barcode_value);
 if(args.p_barcode_value==='UNKNOWN')return {data:{valid:false,result:'invalid',message:'Barcode not found',assignment_state:'not_eligible'},error:null};
 return {data:{valid:true,result:'verified',qr_value:args.p_barcode_value,evacuee_id:42,group_id:42,full_name:'Nick',age:23,gender:'Male',group_size:2,needs_summary:'None',approval_status:'approved',current_status:'accommodated',assignment_state:'assigned',assignment_message:'GBEAA assigned an available space.',space_code:'A1',space_name:'Hallway A1',shelter_name:'Actual Shelter'},error:null};
};
window.addEventListener('error',event=>document.documentElement.setAttribute('data-test-error',event.message));
window.addEventListener('unhandledrejection',event=>document.documentElement.setAttribute('data-test-error',String(event.reason)));
</script>"""
CHECK = r"""<script>
setTimeout(async()=>{
 try{
  const check=(value,message)=>{if(!value)throw new Error(message);};
  check(!document.getElementById('manualScanButton').disabled,'Scanner did not initialize');
  document.getElementById('manualBarcode').value='ACTUAL-NICK-CODE';
  document.getElementById('manualScanButton').click();
  for(let i=0;i<100&&ScanSafeScanner.inspect().busy;i++)await new Promise(resolve=>setTimeout(resolve,10));
  const result=document.getElementById('scanResult');const identity=document.getElementById('lastScannedEvacuee');
  check(scanCalls.length===1&&scanCalls[0]==='ACTUAL-NICK-CODE','Real Search button did not call atomic RPC once');
  check(identity.textContent.includes('Nick'),'Real evacuee details are missing');
  check(result.textContent.includes('VERIFIED')&&result.textContent.includes('Hallway A1'),'Verification or assigned space missing');
  check(!/check-in confirmed|checked-in/i.test(result.textContent),'Scanner falsely claimed check-in');
  check(document.getElementById('scannerHistory').textContent.includes('No scans yet'),'History did not load through bridge');
  check(document.documentElement.scrollWidth<=innerWidth,'Scanner overflows viewport');
  const source=[...document.scripts].filter(script=>script.src).map(script=>script.src).join(' ');
  check(source.includes('scanner-camera.js')&&source.includes('/assets/scanner.js'),'Scanner scripts missing from real page');
  document.getElementById('manualBarcode').value='UNKNOWN';document.getElementById('manualScanButton').click();
  for(let i=0;i<100&&ScanSafeScanner.inspect().busy;i++)await new Promise(resolve=>setTimeout(resolve,10));
  check(result.textContent.includes('Barcode not found'),'Unknown barcode reason missing');
  check(!identity.textContent.includes('Nick'),'Unknown barcode retained prior evacuee');
  document.documentElement.setAttribute('data-scanner-smoke','pass');
 }catch(error){document.documentElement.setAttribute('data-test-error',error.stack||String(error));}
},1200);
</script>"""

class Handler(SimpleHTTPRequestHandler):
 def __init__(self,*args,**kwargs):
  super().__init__(*args,directory=str(ROOT),**kwargs)
 def log_message(self,*args):
  pass
 def do_GET(self):
  if self.path.split('?',1)[0]=='/barcode-scanner.html':
   source=(ROOT/'barcode-scanner.html').read_text(encoding='utf-8')
   source=re.sub(r'<script src="https://[^"]+"></script>','',source)
   source=source.replace('<script src="assets/supabase-config.js"></script>',admin.MOCK+SETUP)
   data=source.replace('</body>',CHECK+'</body>').encode('utf-8')
   self.send_response(200)
   self.send_header('Content-Type','text/html; charset=utf-8')
   self.send_header('Content-Length',str(len(data)))
   self.end_headers()
   self.wfile.write(data)
  else:
   super().do_GET()

def main():
 chrome=shutil.which('google-chrome') or shutil.which('chromium') or str(Path(os.environ.get('PROGRAMFILES','C:/Program Files'))/'Google/Chrome/Application/chrome.exe')
 server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
 threading.Thread(target=server.serve_forever,daemon=True).start()
 try:
  with tempfile.TemporaryDirectory(prefix='scansafe-scanner-page-') as profile:
   for width in (1366,390):
    result=subprocess.run([chrome,'--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','--user-data-dir='+profile,'--window-size='+str(width)+',900','--virtual-time-budget=4000','--dump-dom',f'http://127.0.0.1:{server.server_port}/barcode-scanner.html'],capture_output=True,text=True,encoding='utf-8',timeout=45,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    assert result.returncode==0,result.stderr[-1000:]
    error=re.search(r'data-test-error="([^"]+)"',result.stdout)
    assert not error,error.group(1) if error else ''
    assert 'data-scanner-smoke="pass"' in result.stdout,'Scanner page checks did not finish'
    print('PASS barcode-scanner.html',width,'px - real page actions, bridge, verified assignment, invalid reset')
 finally:
  server.shutdown()

if __name__=='__main__':
 main()
