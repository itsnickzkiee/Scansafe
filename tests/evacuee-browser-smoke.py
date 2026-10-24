"""Browser regression checks for the real evacuee pages with an isolated account fixture."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import os
import re
import shutil
import subprocess
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[1]
PAGES = ('user-portal.html','my-information.html','profile.html','user-room.html','user-notifications.html','user-messages.html')
MOCK = r"""<script>
window.SCANSafeSupabaseConfig={url:'https://fixture.invalid',anonKey:'fixture'};
Object.defineProperty(navigator,'serviceWorker',{value:{register:async()=>({})},configurable:true});
window.JsBarcode=(svg,value)=>{
 svg.setAttribute('data-test-barcode-value',value);
 svg.setAttribute('width','240');svg.setAttribute('height','80');svg.setAttribute('viewBox','0 0 240 80');
 svg.replaceChildren();
 for(let x=12;x<228;x+=6){const bar=document.createElementNS('http://www.w3.org/2000/svg','rect');bar.setAttribute('x',x);bar.setAttribute('y','4');bar.setAttribute('width','2');bar.setAttribute('height','72');bar.setAttribute('fill','#111');svg.append(bar);}
};
const fixture={
 evacuees:[{evacuee_id:42,auth_user_id:'fixture-nick',group_id:42,registration_code:'REQ-NICK',full_name:'Nick',email:'nick@example.test',age:23,gender:'Male',group_size:2,needs_summary:'None',address:'Actual registered address',barangay:'Abangan Norte',city:'Marilao',approval_status:'approved',current_status:'accommodated',registered_at:'2026-10-23T14:00:00Z',approved_at:'2026-10-23T14:05:00Z'}],
 barcodes:[{evacuee_id:42,barcode_value:'NICK-LIVE-42',status:'active',issued_at:'2026-10-23T14:05:00Z'}],
 accommodation_assignments:[{group_id:42,space_id:7,assignment_status:'active',assigned_at:'2026-10-23T14:06:00Z'}],
 accommodation_spaces:[{space_id:1,shelter_id:1,space_code:'A1',space_name:'Hallway A1',space_type:'hallway',capacity:6,current_occupancy:1,is_primary:true,status:'available'},{space_id:7,shelter_id:1,space_code:'ML',space_name:'Main Lobby',space_type:'other',capacity:30,current_occupancy:2,is_primary:true,status:'available'}],
 shelters:[{shelter_id:1,shelter_name:'Actual Shelter'}]
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
const session={user:{id:'fixture-nick',email:'nick@example.test'}};
const backend={
 auth:{getSession:async()=>({data:{session}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
 from:table=>new Query(table),
 channel:()=>({on(){return this;},subscribe(){return this;}}),removeChannel(){},
 rpc:async name=>name==='get_my_profile'?{data:{id:'fixture-nick',full_name:'Nick',role:'evacuee'},error:null}:name==='get_my_scansafe_account'?(location.search.includes('legacy')?{data:null,error:{code:'PGRST202',message:'Missing optional snapshot function'}}:{data:{evacuee:fixture.evacuees[0],barcode:fixture.barcodes[0],assignment:fixture.accommodation_assignments[0],space:fixture.accommodation_spaces[1],shelter:fixture.shelters[0]},error:null}):{data:[],error:null}
};
window.supabase={createClient:()=>backend};
window.addEventListener('error',event=>document.documentElement.setAttribute('data-test-script-error',event.message));
window.addEventListener('unhandledrejection',event=>document.documentElement.setAttribute('data-test-script-error',String(event.reason)));
</script>"""
CHECK = r"""<script>
setTimeout(()=>{
 if(['user-portal.html','my-information.html'].some(page=>location.pathname.endsWith(page))){
  const card=document.querySelector(location.pathname.endsWith('my-information.html')?'.barcode-card':'#userQrCard');
  if(!card||card.querySelector('[data-barcode-value]')) document.documentElement.setAttribute('data-test-script-error','Barcode remains inline in its account card');
  const button=card?.querySelector('[data-show-barcode]');
  if(button) button.click();else document.documentElement.setAttribute('data-test-script-error','Show Barcode card action missing');
 }
 if(location.pathname.endsWith('user-room.html')){
  window.selectSpace('ML');
  window.openSingleUserMapViewer();
  window.showSingleMapSpace('ML');
 }
},1000);
</script>"""

class Handler(SimpleHTTPRequestHandler):
 def __init__(self,*args,**kwargs):
  super().__init__(*args,directory=str(ROOT),**kwargs)
 def log_message(self,*args):
  pass
 def do_GET(self):
  filename=self.path.split('?',1)[0].lstrip('/')
  if filename in PAGES:
   source=(ROOT/filename).read_text(encoding='utf-8')
   source=re.sub(r'<script src="https://[^"]+"></script>','',source)
   source=source.replace('<script src="assets/supabase-config.js"></script>',MOCK)
   source=source.replace('</body>',CHECK+'</body>')
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
  with tempfile.TemporaryDirectory(prefix='scansafe-evacuee-check-') as profile:
   cases=[(page,'') for page in PAGES]+[('user-portal.html','?legacy=1')]
   for page,query in cases:
    result=subprocess.run([chrome,'--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-extensions','--user-data-dir='+profile,'--virtual-time-budget=3500','--dump-dom',f'http://127.0.0.1:{server.server_port}/{page}{query}'],capture_output=True,text=True,encoding='utf-8',timeout=45,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    assert result.returncode==0, result.stderr[-1000:]
    dom=result.stdout
    # Ignore the injected fixture/check scripts when checking visible mock text.
    visible=re.sub(r'<script\b[^>]*>.*?</script>','',dom,flags=re.S)
    error=re.search(r'data-test-script-error="([^"]+)"',dom)
    assert not error, page+': browser script error '+(error.group(1) if error else '')
    assert re.search(r'data-user-name[^>]*>Nick<',visible), page+': live name did not bind'
    assert 'Live database - Updated' in visible, page+': account did not finish loading'
    assert 'Juan Dela Cruz' not in visible and 'Maria Santos' not in visible and 'Pedro Reyes' not in visible and 'Ana Cruz' not in visible, page+': mock people remain'
    if page in ('user-portal.html','my-information.html'):
     assert 'Show Barcode' in visible, page+': Show Barcode action missing'
     assert 'data-barcode-value="NICK-LIVE-42"' in visible, page+': popup actual barcode value missing'
     assert 'data-test-barcode-value="NICK-LIVE-42"' in visible, page+': barcode renderer did not receive actual value'
     assert 'Pending Admin Approval' not in visible, page+': approved account rendered pending'
     assert 'Check-in confirmed' not in visible, page+': assignment fabricated a check-in'
    if page=='my-information.html':
     assert re.search(r'<h2[^>]*data-user-name[^>]*>Nick</h2>',visible), 'Profile card still shows stale identity'
     body=re.search(r'<tbody id="userGroupMembersBody"[^>]*>(.*?)</tbody>',visible,re.S).group(1)
     assert 'Nick' in body and 'Individual details for the other group members have not been recorded.' in body, 'Group members were fabricated'
     assert 'Actual registered address' in visible, 'Registered address did not bind'
    if page=='user-room.html':
     detail=re.search(r'<div id="spaceDetail"[^>]*>(.*?)</section>',visible,re.S).group(1)
     assert 'Main Lobby' in detail and '>30<' in detail and '>2<' in detail and '>28<' in detail, 'Desktop accommodation metadata incorrect'
     assert '2/30' in visible and '28 available' in visible, 'Map viewer did not use real capacity'
    print('PASS',page+query,'- own live account, approved barcode/data binding, no mock records')
 finally:
  server.shutdown()

if __name__=='__main__':
 main()
