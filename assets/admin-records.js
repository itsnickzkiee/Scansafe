(function(){
'use strict';
if((location.pathname.split('/').pop()||'').toLowerCase()!=='reports.html') return;

const state={sb:null,stays:[],audit:[],archives:[],tab:'analytics'};
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=v=>{const d=new Date(v);return Number.isNaN(d.getTime())?'—':d.toLocaleString();};
const dur=s=>{s=Number(s||0);if(!s)return'—';const h=Math.floor(s/3600),m=Math.floor((s%3600)/60);return h>=24?`${Math.floor(h/24)}d ${h%24}h`:h?`${h}h ${m}m`:`${m}m`;};

function client(){return window.ScanSafeDB?.client||null;}
function analyticsNodes(){
  const page=document.querySelector('.page'); if(!page) return [];
  return [...page.children].filter(el=>
    !el.matches('.page-title,#adminDataStatus,.records-tabs,.records-panel')
  );
}
function switchTab(tab){
  state.tab=tab;
  $$('[data-records-tab]').forEach(b=>b.classList.toggle('active',b.dataset.recordsTab===tab));
  $$('[data-records-panel]').forEach(p=>p.hidden=p.dataset.recordsPanel!==tab);
  analyticsNodes().forEach(el=>el.hidden=tab!=='analytics');
  history.replaceState(null,'',tab==='analytics'?'reports.html':`reports.html#${tab}`);
  if(tab!=='analytics') refreshRecords();
}
async function refreshRecords(){
  state.sb=client(); if(!state.sb) return;
  const [s,a,c]=await Promise.all([
    state.sb.rpc('get_scansafe_stay_history',{p_limit:1000}),
    state.sb.rpc('get_scansafe_admin_audit',{p_limit:1500}),
    state.sb.rpc('get_scansafe_archived_conversations')
  ]);
  if(!s.error) state.stays=Array.isArray(s.data)?s.data:[];
  if(!a.error) state.audit=Array.isArray(a.data)?a.data:[];
  if(!c.error) state.archives=Array.isArray(c.data)?c.data:[];
  renderAll();
}
function stayFiltered(){
  const q=String($('[data-stay-search]')?.value||'').toLowerCase();
  const st=$('[data-stay-status]')?.value||'all';
  return state.stays.filter(r=>(st==='all'||r.status===st)&&(!q||[
    r.full_name,r.space_code,r.space_name,r.shelter_name,r.operation_name
  ].some(v=>String(v||'').toLowerCase().includes(q))));
}
function auditFiltered(){
  const q=String($('[data-audit-search]')?.value||'').toLowerCase();
  const ev=$('[data-audit-event]')?.value||'all';
  return state.audit.filter(r=>(ev==='all'||r.event_type===ev)&&(!q||[
    r.actor_name,r.event_type,r.target_type,r.target_id,JSON.stringify(r.details||{})
  ].some(v=>String(v||'').toLowerCase().includes(q))));
}
function archiveFiltered(){
  const q=String($('[data-archive-search]')?.value||'').toLowerCase();
  return state.archives.filter(r=>!q||String(r.full_name||'').toLowerCase().includes(q));
}
function renderStays(){
  const body=$('[data-stay-history]'); if(!body)return;
  const rows=stayFiltered();
  body.innerHTML=rows.length?rows.map(r=>`<tr>
    <td><b>${esc(r.full_name)}</b><br><small>Stay #${esc(r.stay_id)}</small></td>
    <td>${esc(r.group_size)}</td>
    <td>${esc(r.space_code||'—')}<br><small>${esc(r.shelter_name||'')}</small></td>
    <td>${esc(fmt(r.time_in))}</td>
    <td>${esc(r.departure_time?fmt(r.departure_time):'Present')}</td>
    <td>${esc(r.duration_seconds?dur(r.duration_seconds):'—')}</td>
    <td><span class="records-status ${r.status==='released'?'done':'active'}">${esc(r.status==='released'?'Completed':r.status)}</span></td>
  </tr>`).join(''):'<tr><td colspan="7">No stay records match.</td></tr>';
}
function renderAudit(){
  const body=$('[data-audit-history]'); if(!body)return;
  const select=$('[data-audit-event]');
  if(select && select.options.length===1){
    [...new Set(state.audit.map(r=>r.event_type).filter(Boolean))].sort().forEach(ev=>{
      const o=document.createElement('option');o.value=ev;o.textContent=ev.replaceAll('_',' ');select.appendChild(o);
    });
  }
  const rows=auditFiltered();
  body.innerHTML=rows.length?rows.map(r=>`<tr>
    <td>${esc(fmt(r.created_at))}</td>
    <td>${esc(r.actor_name||'System')}</td>
    <td><b>${esc(String(r.event_type||'').replaceAll('_',' '))}</b></td>
    <td>${esc(r.target_type||'—')}<br><small>${esc(r.target_id||'')}</small></td>
    <td><code>${esc(JSON.stringify(r.details||{}))}</code></td>
  </tr>`).join(''):'<tr><td colspan="5">No audit records match.</td></tr>';
}
function renderArchives(){
  const body=$('[data-archived-conversations]'); if(!body)return;
  const rows=archiveFiltered();
  body.innerHTML=rows.length?rows.map(r=>`<tr>
    <td><b>${esc(r.full_name)}</b></td>
    <td>${esc(r.last_message||'No messages')}<br><small>${esc(r.last_message_at?fmt(r.last_message_at):'')}</small></td>
    <td>${esc(fmt(r.archived_at))}</td>
    <td>${esc(r.archived_by_name||'Staff')}</td>
    <td><button class="btn out records-restore" data-restore-user="${esc(r.user_id)}">Restore</button></td>
  </tr>`).join(''):'<tr><td colspan="5">No archived conversations.</td></tr>';
  $$('[data-restore-user]').forEach(btn=>btn.addEventListener('click',()=>restore(btn.dataset.restoreUser)));
}
function renderAll(){renderStays();renderAudit();renderArchives();}
async function restore(id){
  if(!state.sb||!id)return;
  const {error}=await state.sb.rpc('unarchive_scansafe_conversation',{p_user_id:id});
  if(error){window.toast?.(error.message);return;}
  window.toast?.('Conversation restored.');
  await refreshRecords();
}
function csvCell(v){return `"${String(v??'').replaceAll('"','""')}"`;}
function download(name,headers,rows){
  const csv=[headers.map(csvCell).join(','),...rows.map(r=>r.map(csvCell).join(','))].join('\r\n');
  const blob=new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;
  document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),0);
}
function exportType(type){
  if(type==='stays'){
    download('scansafe-stay-history.csv',['Stay ID','Evacuee','Group Size','Space','Shelter','Time In','Departure','Duration Seconds','Status'],
      stayFiltered().map(r=>[r.stay_id,r.full_name,r.group_size,r.space_code,r.shelter_name,r.time_in,r.departure_time,r.duration_seconds,r.status]));
  }else if(type==='audit'){
    download('scansafe-audit-trail.csv',['Audit ID','Date','Actor','Event','Target Type','Target ID','Details'],
      auditFiltered().map(r=>[r.audit_id,r.created_at,r.actor_name,r.event_type,r.target_type,r.target_id,JSON.stringify(r.details||{})]));
  }else{
    download('scansafe-archived-conversations.csv',['Evacuee','Archived At','Archived By','Last Message','Last Message At'],
      archiveFiltered().map(r=>[r.full_name,r.archived_at,r.archived_by_name,r.last_message,r.last_message_at]));
  }
}
function bind(){
  $$('[data-records-tab]').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.recordsTab)));
  $$('[data-stay-search],[data-stay-status],[data-audit-search],[data-audit-event],[data-archive-search]').forEach(el=>el.addEventListener('input',renderAll));
  $$('[data-records-export]').forEach(b=>b.addEventListener('click',()=>exportType(b.dataset.recordsExport)));
}
document.addEventListener('DOMContentLoaded',()=>setTimeout(()=>{
  bind();
  const hash=location.hash.replace('#','');
  switchTab(['stays','audit','archives'].includes(hash)?hash:'analytics');
},850));

window.ScanSafeRecordsDebug={refresh:refreshRecords,inspect:()=>({stays:state.stays.length,audit:state.audit.length,archives:state.archives.length,tab:state.tab})};
})();