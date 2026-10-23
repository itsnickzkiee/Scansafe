"""Exercise the real admin templates/scripts in headless Chrome using an isolated local backend fixture."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import os
import re
import shutil
import subprocess
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[1]
MOCK = r"""<script>
window.SCANSafeSupabaseConfig={url:'https://fixture.invalid',anonKey:'fixture'};
const fixture={
 evacuees:[{evacuee_id:42,group_id:42,registration_code:'REQ-NICK',full_name:'Nick',email:'nick@example.test',age:23,gender:'Male',group_size:2,needs_summary:'None',address:'Registered address',barangay:'Abangan Norte',city:'Marilao',approval_status:'pending',current_status:'registered',registered_at:'2026-10-23T14:00:00Z'}],
 accommodation_spaces:[{space_id:1,space_code:'A1',space_name:'Hallway A1',capacity:6,current_occupancy:0,is_primary:true,status:'available'}],barcodes:[],accommodation_assignments:[]
};
class Query{
 constructor(table){this.rows=fixture[table]||[];}
 select(){return this;} order(){return this;}
 neq(key,value){this.rows=this.rows.filter(row=>row[key]!==value);return this;}
 eq(key,value){this.rows=this.rows.filter(row=>row[key]===value);return this;}
 range(start,end){this.rows=this.rows.slice(start,end+1);return this;}
 limit(n){this.rows=this.rows.slice(0,n);return this;}
 maybeSingle(){return Promise.resolve({data:this.rows[0]||null,error:null});}
 then(resolve,reject){return Promise.resolve({data:this.rows,error:null}).then(resolve,reject);}
}
const session={user:{id:'fixture-admin',email:'admin@example.test'}};
const backend={
 auth:{getSession:async()=>({data:{session}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
 from:table=>new Query(table),
 rpc:async name=>name==='get_my_profile'?{data:{id:'fixture-admin',full_name:'Administrator',role:'admin'},error:null}:name==='scansafe_admin_dashboard_snapshot'?{data:null,error:{code:'PGRST202',message:'Missing optional snapshot function'}}:{data:[],error:null}
};
window.supabase={createClient:()=>backend};
</script>"""

class Handler(SimpleHTTPRequestHandler):
 def __init__(self,*args,**kwargs):
  super().__init__(*args,directory=str(ROOT),**kwargs)
 def log_message(self,*args):
  pass
 def do_GET(self):
  filename=self.path.split('?',1)[0].lstrip('/')
  if filename in ('admin-dashboard.html','evacuees.html'):
   source=(ROOT/filename).read_text(encoding='utf-8')
   source=re.sub(r'<script src="https://[^"]+"></script>','',source)
   source=source.replace('<script src="assets/supabase-config.js"></script>',MOCK)
   data=source.encode('utf-8')
   self.send_response(200)
   self.send_header('Content-Type','text/html; charset=utf-8')
   self.send_header('Content-Length',str(len(data)))
   self.end_headers()
   self.wfile.write(data)
  else:
   super().do_GET()

def main():
 chrome=shutil.which('google-chrome') or shutil.which('chromium') or str(Path(os.environ.get('PROGRAMFILES','C:/Program Files'))/'Google/Chrome/Application/chrome.exe')
 if not Path(chrome).is_file():
  raise SystemExit('Chrome is required for this browser smoke check.')
 server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
 threading.Thread(target=server.serve_forever,daemon=True).start()
 try:
  with tempfile.TemporaryDirectory(prefix='scansafe-browser-check-') as profile:
   for page in ('admin-dashboard.html','evacuees.html'):
    result=subprocess.run([chrome,'--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','--user-data-dir='+profile,'--virtual-time-budget=4000','--dump-dom',f'http://127.0.0.1:{server.server_port}/{page}'],capture_output=True,text=True,encoding='utf-8',timeout=45,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    assert result.returncode==0, result.stderr[-1000:]
    dom=result.stdout
    tbody_id='pendingRequestsBody' if page=='admin-dashboard.html' else 'evacBody'
    body=re.search(r'<tbody id="'+tbody_id+r'"[^>]*>(.*?)</tbody>',dom,re.S)
    assert body and 'Nick' in body.group(1), page+': Nick was not rendered'
    assert 'REQ-NICK' in body.group(1), page+': request code missing'
    assert 'Within Coverage' in body.group(1) or 'Abangan Norte' in body.group(1), page+': coverage missing'
    expected=7 if page=='admin-dashboard.html' else 11
    assert len(re.findall(r'<td(?:\s|>)',body.group(1)))==expected, page+': table columns do not match headings'
    assert 'Live database - Updated' in dom, page+': live load did not finish'
    assert '>236<' not in dom and '>78%<' not in dom, page+': fake statistics remain'
    assert 'Juan Dela Cruz' not in dom and 'Maria Santos' not in dom, page+': fake people remain'
    assert re.search(r'data-kpi-pending[^>]*>1<',dom), page+': pending count is incorrect'
    if page=='admin-dashboard.html':
     assert re.search(r'data-kpi-occupancy[^>]*>0%<',dom), 'Occupancy did not update'
     assert re.search(r'data-kpi-capacity[^>]*>0 / 6 capacity<',dom), 'Capacity did not update'
    else:
     assert re.search(r'data-kpi-total[^>]*>1<',dom), 'Total count did not update'
    print('PASS',page,'- live Nick registration, aligned columns, actual statistics, no mock records')
 finally:
  server.shutdown()

if __name__=='__main__':
 main()
