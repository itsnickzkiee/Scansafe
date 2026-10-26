(function(){
'use strict';
if((location.pathname.split('/').pop()||'').toLowerCase()!=='reports.html') return;

const state={sb:null,stays:[],audit:[],tab:'analytics'};
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
  const [s,a]=await Promise.all([
    state.sb.rpc('get_scansafe_stay_history',{p_limit:1000}),
    state.sb.rpc('get_scansafe_admin_audit',{p_limit:1500})
  ]);
  if(!s.error) state.stays=Array.isArray(s.data)?s.data:[];
  if(!a.error) state.audit=Array.isArray(a.data)?a.data:[];
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
function auditEventLabel(event){
  const map={
    gbeaa_assignment:'Accommodation assigned',
    evacuee_checked_in:'Evacuee checked in',
    evacuee_released:'Evacuee released',
    duplicate_checkin_blocked:'Duplicate check-in blocked',
    account_image_uploaded:'Profile image uploaded',
    conversation_archived:'Conversation archived',
    conversation_unarchived:'Conversation restored',
    conversation_unarchived_new_message:'Conversation restored by new message',
    conversation_cleared:'Conversation deleted from Messages view'
  };
  return map[event]||String(event||'System activity').replaceAll('_',' ');
}
function detailLabel(key){
  const labels={
    evacuee_name:'Evacuee',reason:'Reason',arrival_time:'Time In',
    departure_time:'Departure',space_code:'Space',previous_space:'Previous Space',
    group_size:'Group Size',operation_id:'Operation',assignment_id:'Assignment',
    barcode_input:'Barcode',cleared_at:'Cleared At',retention:'Retention',
    message_id:'Message',previously_archived_at:'Previous Archive'
  };
  return labels[key]||String(key||'').replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());
}
function detailValue(key,value){
  if(value===null||value===undefined||value==='') return '—';
  if(/(_at|_time|departure|arrival)/i.test(key)){
    const d=new Date(value); if(!Number.isNaN(d.getTime())) return d.toLocaleString();
  }
  if(key==='duration_seconds') return dur(value);
  if(typeof value==='boolean') return value?'Yes':'No';
  if(typeof value==='object') return JSON.stringify(value);
  return String(value);
}
function auditDetails(details){
  const d=details&&typeof details==='object'?details:{};
  const hidden=new Set(['algorithm']);
  const entries=Object.entries(d).filter(([k])=>!hidden.has(k));
  if(!entries.length) return '<span class="records-detail-empty">No additional details</span>';
  return `<div class="records-detail-list">${entries.slice(0,8).map(([k,v])=>
    `<span><b>${esc(detailLabel(k))}:</b> ${esc(detailValue(k,v))}</span>`
  ).join('')}</div>`;
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
    <td><b>${esc(auditEventLabel(r.event_type))}</b></td>
    <td>${esc(String(r.target_type||'—').replaceAll('_',' '))}<br><small>${esc(r.target_id||'')}</small></td>
    <td>${auditDetails(r.details)}</td>
  </tr>`).join(''):'<tr><td colspan="5">No audit records match.</td></tr>';
}
function renderAll(){renderStays();renderAudit();}
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
  }
}
function bind(){
  $$('[data-records-tab]').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.recordsTab)));
  $$('[data-stay-search],[data-stay-status],[data-audit-search],[data-audit-event]').forEach(el=>el.addEventListener('input',renderAll));
  $$('[data-records-export]').forEach(b=>b.addEventListener('click',()=>exportType(b.dataset.recordsExport)));
}
document.addEventListener('DOMContentLoaded',()=>setTimeout(()=>{
  bind();
  const hash=location.hash.replace('#','');
  switchTab(['stays','audit'].includes(hash)?hash:'analytics');
},850));

window.ScanSafeRecordsDebug={refresh:refreshRecords,inspect:()=>({stays:state.stays.length,audit:state.audit.length,tab:state.tab})};
})();