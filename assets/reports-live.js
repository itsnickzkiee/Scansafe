(function(){
  'use strict';
  const page=(location.pathname.split('/').pop()||'').toLowerCase();
  if(page!=='reports.html') return;

  const state={
    sb:null,rows:[],summary:null,needs:[],stays:[],scans:[],
    timer:null,loading:false,lastLoadedAt:null
  };

  const $=sel=>document.querySelector(sel);
  const $$=sel=>[...document.querySelectorAll(sel)];
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num=v=>Number(v||0);
  const date=v=>{const d=new Date(v);return Number.isNaN(d.getTime())?null:d;};
  const fmt=v=>{const d=date(v);return d?d.toLocaleString():'—';};

  function client(){
    if(window.ScanSafeDB?.client) return window.ScanSafeDB.client;
    const cfg=window.SCANSafeSupabaseConfig||{};
    if(window.supabase?.createClient&&cfg.url&&cfg.anonKey){
      window.ScanSafeDB=window.ScanSafeDB||{};
      window.ScanSafeDB.client=window.supabase.createClient(cfg.url,cfg.anonKey,{
        auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}
      });
      return window.ScanSafeDB.client;
    }
    return null;
  }

  function rangeDays(){
    const v=$('[data-report-range]')?.value||'7';
    return v==='all'?null:Number(v||7);
  }

  function cutoff(){
    const days=rangeDays();
    return days===null?null:new Date(Date.now()-days*86400000);
  }

  function inRange(value){
    const c=cutoff(); if(!c) return true;
    const d=date(value); return !!d&&d>=c;
  }

  function shelterFilter(){
    return $('[data-report-shelter]')?.value||'all';
  }

  function filteredRows(){
    const shelter=shelterFilter();
    return state.rows.filter(r=>
      inRange(r.registered_at) &&
      (shelter==='all'||String(r.shelter_name||'')===shelter)
    );
  }

  function duration(sec){
    sec=Math.max(0,Math.round(Number(sec||0)));
    if(!sec) return '—';
    const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60);
    if(h>=24){const d=Math.floor(h/24);return `${d}d ${h%24}h`;}
    return h?`${h}h ${m}m`:`${m}m`;
  }

  async function safeSelect(table,columns){
    try{
      const {data,error}=await state.sb.from(table).select(columns);
      if(error) throw error;
      return Array.isArray(data)?data:[];
    }catch(error){
      console.warn('Reports optional table '+table+':',error?.message||error);
      return [];
    }
  }

  async function load(){
    if(state.loading) return;
    state.loading=true;
    const status=$('#adminDataStatus');
    if(status) status.textContent='Refreshing live analytics…';
    try{
      state.sb=client();
      if(!state.sb) throw new Error('Supabase is not configured.');

      const [summaryRes,rowsRes,needs,stays,scans]=await Promise.all([
        state.sb.rpc('get_scansafe_report_summary'),
        state.sb.rpc('get_scansafe_evacuee_report_rows'),
        safeSelect('need_requests','request_id,status,priority,created_at,updated_at'),
        safeSelect('scansafe_operation_stays','stay_id,status,group_size,admitted_at,checked_in_at,released_at'),
        safeSelect('scan_logs','scan_id,scan_result,scanned_at')
      ]);
      if(summaryRes.error) throw summaryRes.error;
      if(rowsRes.error) throw rowsRes.error;

      state.summary=summaryRes.data||{};
      state.rows=Array.isArray(rowsRes.data)?rowsRes.data:[];
      state.needs=needs; state.stays=stays; state.scans=scans;
      state.lastLoadedAt=new Date();

      populateShelters();
      render();
      if(status) status.textContent='Live database • Updated '+state.lastLoadedAt.toLocaleTimeString();
    }catch(error){
      console.error('Reports live:',error);
      if(status) status.textContent='Could not load live reports: '+(error?.message||error);
    }finally{
      state.loading=false;
    }
  }

  function populateShelters(){
    const select=$('[data-report-shelter]');
    if(!select) return;
    const current=select.value||'all';
    const names=[...new Set(state.rows.map(r=>r.shelter_name).filter(Boolean))].sort();
    select.innerHTML='<option value="all">All Shelters</option>'+
      names.map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join('');
    if([...select.options].some(o=>o.value===current)) select.value=current;
  }

  function renderOperational(){
    const activeAssignments=state.rows.filter(r=>String(r.space_code||'').trim()).length;
    const released=state.stays.filter(s=>s.status==='released'&&inRange(s.released_at||s.admitted_at));
    const completedDurations=released.map(s=>{
      const a=date(s.checked_in_at||s.admitted_at),b=date(s.released_at);
      return a&&b?Math.max(0,(b-a)/1000):0;
    }).filter(Boolean);
    const avg=completedDurations.length?completedDurations.reduce((a,b)=>a+b,0)/completedDurations.length:0;
    const activeNeeds=state.needs.filter(n=>['pending','preparing','ready_for_pickup','for_delivery'].includes(n.status)&&inRange(n.created_at)).length;
    const verified=state.scans.filter(s=>String(s.scan_result||'').toLowerCase()==='verified'&&inRange(s.scanned_at)).length;

    const values={accommodated:activeAssignments,released:released.length,avgStay:duration(avg),needs:activeNeeds,scans:verified};
    Object.entries(values).forEach(([k,v])=>{
      const el=$(`[data-live-kpi="${k}"]`); if(el) el.textContent=String(v);
    });
  }

  function renderTable(){
    const rows=filteredRows();
    const tbody=$('[data-report-live-table] tbody');
    const count=$('[data-report-result-count]');
    if(count) count.textContent=`${rows.length} record${rows.length===1?'':'s'}`;
    if(!tbody) return;
    tbody.innerHTML=rows.length?rows.slice(0,250).map(r=>`<tr>
      <td>${esc(r.evacuee_id)}</td>
      <td><b>${esc(r.full_name||'Evacuee')}</b><br><small>${esc(r.registration_code||'')}</small></td>
      <td><span class="pill ${r.approval_status==='approved'?'green':r.approval_status==='pending'?'amber':'gray'}">${esc(r.approval_status||'—')}</span></td>
      <td>${esc(r.current_status||'—')}</td>
      <td>${esc(r.group_size||1)}</td>
      <td>${esc(r.space_code||'—')}</td>
      <td>${esc(r.shelter_name||'—')}</td>
      <td>${esc(fmt(r.registered_at))}</td>
    </tr>`).join(''):'<tr><td colspan="8" style="text-align:center">No records match the selected filters.</td></tr>';
  }

  function render(){
    renderOperational();
    renderTable();

    const type=$('[data-report-type]')?.value||'overview';
    const operations=$('[data-report-operations]');
    if(operations) operations.dataset.reportType=type;

    // Existing Phase 8 charts remain powered by the existing bridge.
    // This layer only adds filtering/operational analytics and exports.
  }

  function csvCell(v){return `"${String(v??'').replaceAll('"','""')}"`;}

  function exportCsv(){
    const rows=filteredRows();
    const headers=['Evacuee ID','Registration Code','Full Name','Age','Gender','Group Size','Approval','Current Status','Accommodation Space','Shelter','Registered At'];
    const lines=[headers.map(csvCell).join(',')];
    rows.forEach(r=>lines.push([
      r.evacuee_id,r.registration_code,r.full_name,r.age,r.gender,r.group_size,
      r.approval_status,r.current_status,r.space_code,r.shelter_name,
      r.registered_at?fmt(r.registered_at):''
    ].map(csvCell).join(',')));

    const blob=new Blob(['\ufeff'+lines.join('\r\n')],{type:'text/csv;charset=utf-8'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download='scansafe-live-report.csv';
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href),0);
    state.sb?.rpc('log_scansafe_report_export',{p_report_type:'Filtered Live Report',p_format:'csv'}).catch(()=>{});
  }

  function exportPdf(){
    state.sb?.rpc('log_scansafe_report_export',{p_report_type:'Filtered Live Report',p_format:'pdf'}).catch(()=>{});
    window.print();
  }

  function bind(){
    $('[data-report-refresh]')?.addEventListener('click',load);
    $('[data-report-csv]')?.addEventListener('click',exportCsv);
    $('[data-report-pdf]')?.addEventListener('click',exportPdf);
    $$('[data-report-range],[data-report-shelter],[data-report-type]').forEach(el=>el.addEventListener('change',render));

    // Replace legacy globals on this page only.
    window.exportCSV=exportCsv;
    window.generatePDF=exportPdf;

    clearInterval(state.timer);
    state.timer=setInterval(()=>{
      if(document.visibilityState==='visible') load();
    },15000);
    document.addEventListener('visibilitychange',()=>{
      if(document.visibilityState==='visible') load();
    });
  }

  document.addEventListener('DOMContentLoaded',()=>{
    setTimeout(async()=>{bind();await load();},750);
  });

  window.addEventListener('beforeunload',()=>clearInterval(state.timer));

  window.ScanSafeReportsDebug={
    inspect:()=>({
      rows:state.rows.length,
      filteredRows:filteredRows().length,
      needs:state.needs.length,
      stays:state.stays.length,
      scans:state.scans.length,
      updatedAt:state.lastLoadedAt
    }),
    refresh:async()=>{await load();return window.ScanSafeReportsDebug.inspect();}
  };
})();
