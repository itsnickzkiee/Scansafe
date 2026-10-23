
const ROOMS={
'116':{name:'Room 116',type:'Classroom',cap:30,occ:0,status:'available',notes:'Standard classroom with chairs and tables. Suitable for families.'},
'115':{name:'Room 115',type:'Classroom',cap:30,occ:0,status:'available',notes:'Standard classroom available for evacuee groups.'},
'114':{name:'Room 114',type:'Classroom',cap:30,occ:0,status:'available',notes:'Accommodation availability is based on current registrations.'},
'113':{name:'Room 113',type:'Classroom',cap:30,occ:0,status:'available',notes:'Accommodation availability is based on current registrations.'},
'112':{name:'Room 112',type:'Classroom',cap:30,occ:0,status:'available',notes:'Available classroom with good remaining capacity.'},
'111':{name:'Room 111',type:'Classroom',cap:30,occ:0,status:'available',notes:'Available for family or individual evacuees.'},
'110':{name:'Room 110',type:'Classroom',cap:30,occ:0,status:'available',notes:'Accommodation availability is based on current registrations.'},
'109':{name:'Room 109',type:'Classroom',cap:30,occ:0,status:'available',notes:'Accommodation availability is based on current registrations.'},
'108':{name:'Room 108',type:'Classroom',cap:30,occ:0,status:'available',notes:'Available classroom.'},
'107':{name:'Room 107',type:'Classroom',cap:30,occ:0,status:'available',notes:'Available classroom.'},
'106':{name:'Room 106',type:'Classroom',cap:30,occ:0,status:'available',notes:'Accommodation availability is based on current registrations.'},
'105':{name:'Room 105',type:'Classroom',cap:30,occ:0,status:'available',notes:'Accommodation availability is based on current registrations.'},
'104':{name:'Room 104',type:'Classroom',cap:30,occ:0,status:'available',notes:'Available classroom.'},
'103':{name:'Room 103',type:'Classroom',cap:30,occ:0,status:'available',notes:'Accommodation availability is based on current registrations.'},
'102':{name:'Room 102',type:'Classroom',cap:30,occ:0,status:'available',notes:'Accommodation availability is based on current registrations.'},
'atrium':{name:'Atrium',type:'Common Area',cap:80,occ:0,status:'available',notes:'Central common area; use only when authorized by shelter staff.'},
'fitness':{name:'Physical Fitness Room',type:'Activity Room',cap:40,occ:0,status:'available',notes:'Overflow accommodation area.'},
'lobby':{name:'Main Lobby',type:'Designated Evacuees Area',cap:100,occ:0,status:'available',notes:'Primary designated evacuees area on the ground floor.'}
};


// Designated hallway/corridor accommodation spaces.
// Classrooms remain visible on the floor plan but are not map-selectable;
// they may be used only as overflow when designated hallway spaces are full.
const HALLWAY_SPACES={
'A1':{name:'Hallway A1',type:'Designated Corridor Space',side:'Left Hallway - North',cap:6,occ:0,status:'available',notes:'Primary hallway accommodation zone. Suitable for a group of up to 6 persons.'},
'A2':{name:'Hallway A2',type:'Designated Corridor Space',side:'Left Hallway - Center',cap:6,occ:0,status:'available',notes:'Accommodation availability is based on current registrations.'},
'A3':{name:'Hallway A3',type:'Designated Corridor Space',side:'Left Hallway - South',cap:6,occ:0,status:'available',notes:'Available designated hallway accommodation zone.'},
'A4':{name:'Hallway A4',type:'Designated Corridor Space',side:'Right Hallway - North',cap:6,occ:0,status:'available',notes:'Accommodation availability is based on current registrations.'},
'A5':{name:'Hallway A5',type:'Designated Corridor Space',side:'Right Hallway - Center',cap:6,occ:0,status:'available',notes:'Available designated hallway accommodation zone.'},
'A6':{name:'Hallway A6',type:'Designated Corridor Space',side:'Right Hallway - South',cap:6,occ:0,status:'available',notes:'Available designated hallway accommodation zone.'}
};
const EVACS=[];
function q(s){return document.querySelector(s)}function qa(s){return [...document.querySelectorAll(s)]}
function ico(id,cls=''){return `<svg class="icon ${cls}"><use href="assets/icons.svg#${id}"></use></svg>`}
function go(p){location.href=p}function logout(){location.href='index.html'}
function toast(t){let x=q('.toast');if(x)x.remove();x=document.createElement('div');x.className='toast';x.style='position:fixed;right:20px;bottom:20px;background:#101828;color:white;padding:11px 16px;border-radius:7px;font-size:11px;z-index:1000;box-shadow:0 8px 25px #0003';x.textContent=t;document.body.appendChild(x);setTimeout(()=>x.remove(),2200)}
function loginDemo(e){e.preventDefault();location.href=q('#role').value==='admin'?'admin-dashboard.html':'user-portal.html'}
function setNow(){
  const now=new Date();
  const text=now.toLocaleString([],{
    year:'numeric',month:'short',day:'numeric',
    hour:'numeric',minute:'2-digit'
  });
  qa('[data-now]').forEach(x=>x.textContent=text);
}
function statusPill(s){let c=s==='Verified'||s==='available'?'green':s==='Pending'||s==='near'?'yellow':'red';let t=s==='available'?'Available':s==='near'?'Near Full':s==='full'?'Full':s;return `<span class="pill ${c}">${t}</span>`}
function selectRoom(id){const d=ROOMS[id];if(!d)return;qa('[data-room]').forEach(x=>x.classList.remove('selected'));let r=q(`[data-room="${id}"]`);if(r)r.classList.add('selected');const av=d.cap-d.occ,p=Math.round(d.occ/d.cap*100),box=q('#roomDetail');if(box)box.innerHTML=`<div class="room-banner"><svg class="icon xl bigicon"><use href="assets/icons.svg#home"></use></svg><div><h2>${d.name}</h2><div style="margin-top:5px">${statusPill(d.status)}</div></div></div><div class="detail-list"><div class="detail-line"><b>Room Type</b><span>${d.type}</span></div><div class="detail-line"><b>Capacity</b><span>${d.cap}</span></div><div class="detail-line"><b>Occupied</b><span>${d.occ}</span></div><div class="detail-line"><b>Available</b><span>${av}</span></div><div class="detail-line"><b>Occupancy</b><span><div class="occupancy-line"><i style="width:${p}%"></i></div><b style="float:right;margin-top:-12px">${p}%</b></span></div><div class="detail-line"><b>Notes</b><span style="background:#f8fafc;border:1px solid #e3e8ee;border-radius:5px;padding:8px">${d.notes}</span></div></div>${d.status==='full'?'<button class="btn soft full" disabled>Room is Full</button>':`<button class="btn red full" onclick="assignRoom('${id}')">${ico('users','sm')} Assign Evacuee / Group</button>`}`}
function renderRooms(){const b=q('#roomRows');if(!b)return;b.innerHTML=Object.entries(ROOMS).filter(([id])=>!['atrium','fitness','lobby'].includes(id)).map(([id,d])=>`<tr data-row-room="${id}"><td>${id}</td><td>${d.type}</td><td>${d.cap}</td><td>${d.occ}</td><td>${d.cap-d.occ}</td><td>${statusPill(d.status)}</td><td><button class="icon-btn" onclick="selectRoom('${id}')">${ico('eye','sm')}</button></td></tr>`).join('')}
function filterRooms(){let term=(q('#roomSearch')?.value||'').toLowerCase(),st=q('#roomFilter')?.value||'all';qa('[data-row-room]').forEach(tr=>{let d=ROOMS[tr.dataset.rowRoom];tr.style.display=((!term||d.name.toLowerCase().includes(term)||tr.dataset.rowRoom.includes(term))&&(st==='all'||d.status===st))?'':'none'})}
function assignRoom(id){localStorage.setItem('selectedRoom',id);location.href='evacuees.html?assign='+id}

function selectSpace(id){
  const d=HALLWAY_SPACES[id]; if(!d)return;
  qa('[data-space]').forEach(x=>x.classList.remove('selected'));
  const spot=q(`[data-space="${id}"]`); if(spot)spot.classList.add('selected');
  const av=d.cap-d.occ,p=Math.round(d.occ/d.cap*100),box=q('#spaceDetail');
  const isUser=document.body.classList.contains('user-shell');
  const action=isUser?'':(d.status==='full'?'<button class="btn soft full" disabled>Hallway Space is Full</button>':`<button class="btn red full" onclick="assignSpace('${id}')">${ico('users','sm')} Assign Evacuee / Group</button>`);
  if(box) box.innerHTML=`<div class="room-banner"><svg class="icon xl bigicon"><use href="assets/icons.svg#home"></use></svg><div><h2>${d.name}</h2><div style="margin-top:5px">${statusPill(d.status)}</div></div></div><div class="detail-list"><div class="detail-line"><b>Space Type</b><span>${d.type}</span></div><div class="detail-line"><b>Location</b><span>${d.side}</span></div><div class="detail-line"><b>Capacity</b><span>${d.cap}</span></div><div class="detail-line"><b>Occupied</b><span>${d.occ}</span></div><div class="detail-line"><b>Available</b><span>${av}</span></div><div class="detail-line"><b>Occupancy</b><span><div class="occupancy-line"><i style="width:${p}%"></i></div><b style="float:right;margin-top:-12px">${p}%</b></span></div><div class="detail-line"><b>Notes</b><span style="background:#f8fafc;border:1px solid #e3e8ee;border-radius:5px;padding:8px">${d.notes}</span></div></div>${action}`;
}
function renderSpaces(){
  const b=q('#spaceRows'); if(!b)return;
  b.innerHTML=Object.entries(HALLWAY_SPACES).map(([id,d])=>`<tr data-row-space="${id}"><td><b>${id}</b></td><td>${d.side}</td><td>${d.cap}</td><td>${d.occ}</td><td>${d.cap-d.occ}</td><td>${statusPill(d.status)}</td><td><button class="icon-btn" onclick="selectSpace('${id}')">${ico('eye','sm')}</button></td></tr>`).join('');
}
function filterSpaces(){
  const term=(q('#spaceSearch')?.value||'').toLowerCase(),st=q('#spaceFilter')?.value||'all';
  qa('[data-row-space]').forEach(tr=>{const d=HALLWAY_SPACES[tr.dataset.rowSpace];tr.style.display=((!term||d.name.toLowerCase().includes(term)||d.side.toLowerCase().includes(term)||tr.dataset.rowSpace.toLowerCase().includes(term))&&(st==='all'||d.status===st))?'':'none'});
}
function assignSpace(id){localStorage.setItem('selectedSpace',id);location.href='evacuees.html?assignSpace='+encodeURIComponent(id)}

function renderEvacs(){const b=q('#evacBody');if(!b)return;let term=(q('#evacSearch')?.value||'').toLowerCase(),status=q('#evacStatus')?.value||'all',shelter=q('#evacShelter')?.value||'all';const data=EVACS.filter(e=>(!term||e.name.toLowerCase().includes(term)||e.id.toLowerCase().includes(term))&&(status==='all'||e.status===status)&&(shelter==='all'||e.shelter===shelter));b.innerHTML=data.map((e,i)=>`<tr class="${i===0?'selected-row':''}" onclick="showEvac('${e.id}')"><td><input type="checkbox" ${i===0?'checked':''}></td><td>${e.id}</td><td><b>${e.name}</b></td><td>${e.age}</td><td>${e.gender}</td><td>${e.group}</td><td>${e.shelter}<br><span class="muted">${e.room}</span></td><td>${statusPill(e.status)}</td><td><span class="actions">${ico('eye','sm')}${ico('edit','sm')}${ico('trash','sm')}</span></td></tr>`).join('')}
function openRegister(){const m=q('#registerModal');if(m)m.classList.remove('hidden')}
function closeRegister(){q('#registerModal')?.classList.add('hidden')}
function registerEvac(e){e.preventDefault();const sid=q('#assignSpace')?.value,group=parseInt(q('#groupSize')?.value||'1',10);if(sid){const d=HALLWAY_SPACES[sid],available=d.cap-d.occ;if(group>available){toast(`Group size (${group}) exceeds ${sid} available slots (${available}). Choose another hallway space.`);return}}toast('Evacuee registered successfully.');closeRegister()}
function exportCSV(){toast('Connect to the database to export a live report.')}
function generatePDF(){toast('Opening print dialog — choose Save as PDF.');setTimeout(()=>window.print(),300)}
function sendMessage(){let inp=q('#messageInput');if(!inp||!inp.value.trim())return;let row=document.createElement('div');row.className='bubble-row mine';row.innerHTML=`<div class="bubble">${inp.value.replace(/</g,'&lt;')}</div><div class="avatar">A</div>`;q('#thread').appendChild(row);inp.value='';q('#thread').scrollTop=q('#thread').scrollHeight}
function sendAnnouncement(){let t=q('#announcement');if(!t?.value.trim()){toast('Type an announcement first.');return}toast('Announcement sent to '+q('#announceTo').value);t.value=''}
function toggleSetting(el){el.classList.toggle('on');localStorage.setItem('setting_'+el.dataset.key,el.classList.contains('on'))}
function saveSettings(){toast('Settings saved.')}
const NOTIFS={};
function selectNotif(id){qa('.notif-item').forEach(x=>x.classList.toggle('active',x.dataset.id===id));let d=NOTIFS[id],b=q('#notifDetail');if(!d||!b)return;b.innerHTML=`<div style="display:flex;align-items:center;gap:12px"><div class="notice-ico" style="background:${id==='weather'?'#ff9f1c':id==='system'?'#1774b8':'#d50000'}">${ico(id==='room'?'bed':id==='system'?'info':'alert')}</div><div><h2 style="margin:0;font-size:20px">${d.title}</h2><div class="muted" style="font-size:10px;margin-top:4px">Aug 6, 2026 • 10:24 AM • ${d.type}</div></div></div><div class="notif-preview-img" style="margin-top:14px"><span class="pill yellow" style="width:max-content">${d.title.toUpperCase()}</span><h2 style="font-size:25px;margin:10px 0 6px">${d.desc}</h2><p style="margin:0;font-size:12px">Keep safe and monitor further updates from local authorities.</p></div><p style="font-size:11px;line-height:1.6">${d.body}</p><div style="background:#fff0f0;border:1px solid #ffdede;border-radius:8px;padding:12px"><b style="color:#d60000;font-size:11px">Safety Reminders:</b><ul style="font-size:10px;line-height:1.8;margin-bottom:0"><li>Stay in the evacuation shelter and avoid unnecessary travel.</li><li>Keep your personal belongings secure and dry.</li><li>Monitor announcements for further updates.</li></ul></div>`}
function editInfo(){qa('[data-editable]').forEach(x=>{x.contentEditable='true';x.style.background='#fff7e6';x.style.outline='1px solid #ffd28a'});toast('Edit mode enabled. Click Save when done.');q('#saveInfo')?.classList.remove('hidden')}
function saveInfo(){qa('[data-editable]').forEach(x=>{x.contentEditable='false';x.style=''});q('#saveInfo')?.classList.add('hidden');toast('Information saved.')}
document.addEventListener('DOMContentLoaded',()=>{setNow();renderRooms();renderSpaces();renderEvacs();qa('.switch').forEach(s=>{if(localStorage.getItem('setting_'+s.dataset.key)==='true')s.classList.add('on')});let sel=localStorage.getItem('selectedSpace')||new URLSearchParams(location.search).get('assignSpace');if(sel&&q('#assignSpace'))q('#assignSpace').value=sel;});


// Final user-layout fix: collapsible sidebar for user pages only.
function initUserMenuToggle(){
  if(!document.body.classList.contains('user-shell') || window.innerWidth<=720) return;
  if(document.getElementById('userMenuToggle')) return;
  const btn=document.createElement('button');
  btn.type='button';
  btn.id='userMenuToggle';
  btn.className='user-menu-toggle';
  btn.title='Hide menu';
  btn.setAttribute('aria-label','Hide side menu');
  btn.innerHTML='&lsaquo;';
  btn.addEventListener('click',()=>{
    const collapsed=document.body.classList.toggle('sidebar-collapsed');
    btn.innerHTML=collapsed?'&rsaquo;':'&lsaquo;';
    btn.title=collapsed?'Show menu':'Hide menu';
    btn.setAttribute('aria-label',collapsed?'Show side menu':'Hide side menu');
  });
  document.body.appendChild(btn);
}
document.addEventListener('DOMContentLoaded',initUserMenuToggle);


// Final admin-layout fix: same collapsible sidebar behavior as the user pages.
function initAdminMenuToggle(){
  if(!document.querySelector('.admin-app') || window.innerWidth<=720) return;
  if(document.getElementById('adminMenuToggle')) return;

  const btn=document.createElement('button');
  btn.type='button';
  btn.id='adminMenuToggle';
  btn.className='admin-menu-toggle';
  btn.title='Hide menu';
  btn.setAttribute('aria-label','Hide admin side menu');
  btn.innerHTML='&lsaquo;';

  btn.addEventListener('click',()=>{
    const collapsed=document.body.classList.toggle('admin-sidebar-collapsed');
    btn.innerHTML=collapsed?'&rsaquo;':'&lsaquo;';
    btn.title=collapsed?'Show menu':'Hide menu';
    btn.setAttribute(
      'aria-label',
      collapsed?'Show admin side menu':'Hide admin side menu'
    );
  });

  document.body.appendChild(btn);
}
document.addEventListener('DOMContentLoaded',initAdminMenuToggle);


/* =========================================================
   MOBILE NAVIGATION PATCH
   Injects one hamburger button + overlay for both Admin/User.
   Desktop arrows remain unchanged.
   ========================================================= */
function initMobileNavigation(){
  if(window.innerWidth > 720) return;
  if(document.getElementById('mobileMenuButton')) return;

  const hasAdmin = !!document.querySelector('.admin-app');
  const hasUser = document.body.classList.contains('user-shell');
  if(!hasAdmin && !hasUser) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'mobileMenuButton';
  button.className = 'mobile-menu-btn';
  button.setAttribute('aria-label','Open navigation menu');
  button.setAttribute('aria-expanded','false');
  button.innerHTML = '&#9776;';

  const overlay = document.createElement('div');
  overlay.className = 'mobile-nav-overlay';

  const closeNav = () => {
    document.body.classList.remove('mobile-nav-open');
    button.setAttribute('aria-expanded','false');
    button.innerHTML = '&#9776;';
  };

  const toggleNav = () => {
    const open = document.body.classList.toggle('mobile-nav-open');
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    button.innerHTML = open ? '&times;' : '&#9776;';
  };

  button.addEventListener('click', toggleNav);
  overlay.addEventListener('click', closeNav);

  document.querySelectorAll('.admin-side .nav-item, .user-side .nav-item').forEach(link=>{
    link.addEventListener('click', closeNav);
  });

  document.body.appendChild(button);
  document.body.appendChild(overlay);
}

document.addEventListener('DOMContentLoaded', initMobileNavigation);

/* =========================================================
   SCANSAFE INTERACTIVE PROTOTYPE REVISION
   Registration -> Admin approval -> barcode issuance -> Assignment -> Check-in
   ========================================================= */
HALLWAY_SPACES.ML={name:'Main Lobby',type:'Designated Main Lobby Area',side:'Main Lobby - Ground Floor',cap:30,occ:0,status:'available',notes:'Primary designated evacuees area. The whole Main Lobby may be selected for accommodation.'};

const SCANSAFE_STATE_KEY='scansafeLiveStateV1';
const DEFAULT_SCANSAFE_STATE={
  user:{
    requestId:null,
    id:null,
    name:'Evacuee',
    email:'',
    age:null,
    gender:'',
    group:1,
    needs:'None',
    registrationStatus:'Pending Approval',
    qrIssued:false,
    qrCode:null,
    emailSent:false,
    assignment:null,
    checkedIn:false,
    submitted:''
  },
  requests:[],
  activity:[],
  demoGroups:[],
  demoAssignments:{}
};
function cloneDefaultState(){return JSON.parse(JSON.stringify(DEFAULT_SCANSAFE_STATE))}
function loadScanSafeState(){
  try{
    const raw=localStorage.getItem(SCANSAFE_STATE_KEY);
    if(!raw)return cloneDefaultState();
    const s=JSON.parse(raw);
    return Object.assign(cloneDefaultState(),s,{user:Object.assign(cloneDefaultState().user,s.user||{})});
  }catch(e){return cloneDefaultState()}
}
function saveScanSafeState(s){localStorage.setItem(SCANSAFE_STATE_KEY,JSON.stringify(s));return s}
function currentState(){return loadScanSafeState()}
function resetScanSafePrototype(){localStorage.removeItem(SCANSAFE_STATE_KEY);location.reload()}
function esc(v=''){return String(v).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]))}
function initials(name=''){return name.split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join('').toUpperCase()||'EV'}
function getRequest(id){return currentState().requests.find(r=>r.id===id)}
function getSpaceBase(id){return HALLWAY_SPACES[id]}
function getDynamicOccupancy(id){
  const s=currentState(); const d=getSpaceBase(id); if(!d)return 0;
  let occ=d.occ;
  if(s.user.assignment===id)occ+=Number(s.user.group||0);
  for(const g of s.demoGroups||[]){if(g.assignment===id)occ+=Number(g.group||0)}
  return Math.min(occ,d.cap);
}
function getSpaceStatus(id){const d=getSpaceBase(id);if(!d)return 'full';const occ=getDynamicOccupancy(id),p=d.cap?occ/d.cap:1;return p>=1?'full':p>.70?'near':'available'}
function getAvailableSlots(id){const d=getSpaceBase(id);return d?Math.max(0,d.cap-getDynamicOccupancy(id)):0}
function formatSpaceName(id){return id==='ML'?'Main Lobby':`Hallway ${id}`}
function statusPill(s){
  const norm=String(s||'');
  const good=['Verified','Approved','Barcode Issued','Checked-In','available','Active'].includes(norm);
  const warn=['Pending','Pending Approval','near','Waiting for Assignment'].includes(norm);
  const c=good?'green':warn?'yellow':'red';
  const labels={available:'Available',near:'Near Full',full:'Full'};
  return `<span class="pill ${c}">${labels[norm]||esc(norm)}</span>`
}
function setNow(){
  const now=new Date();
  const fmt=new Intl.DateTimeFormat('en-US',{month:'long',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});
  qa('[data-now]').forEach(x=>x.textContent=fmt.format(now));
}
function qrMarkup(value){
  const text=String(value||'SCANSAFE');
  return `<div class="scansafe-barcode-wrap" style="width:min(100%,380px);margin:0 auto;background:#fff;padding:10px 8px;border-radius:10px;overflow:hidden"><svg class="scansafe-barcode" data-barcode-value="${esc(text)}" aria-label="Evacuee barcode" style="width:100%;height:auto;display:block"></svg></div><div class="qr-code-label">${esc(text)}</div>`
}

function renderPendingRequests(){
  const body=q('#pendingRequestsBody'); if(!body)return;
  const s=currentState(); const pending=s.requests.filter(r=>r.status==='Pending Approval');
  body.innerHTML=pending.length?pending.map(r=>`<tr><td><div class="ops-person"><div class="ops-initial">${initials(r.name)}</div><div><b>${esc(r.name)}</b><small>${esc(r.id)}</small></div></div></td><td>${r.group}</td><td>${esc(r.needs||'None')}</td><td>${esc(r.submitted)}</td><td>${statusPill(r.status)}</td><td><button class="btn red review-btn" onclick="reviewRegistration('${r.id}')">Review</button></td></tr>`).join(''):`<tr><td colspan="6" style="text-align:center;padding:24px;color:#7d8998">No pending registrations. All requests are reviewed.</td></tr>`;
}
function renderRecentActivity(){
  const box=q('#recentActivity');if(!box)return;
  const items=(currentState().activity||[]).slice(0,5);
  box.innerHTML=items.length
    ? items.map(a=>`<div class="activity-item"><div class="activity-ico">${esc(a.icon||'•')}</div><div><b>${esc(a.title)}</b><small>${esc(a.desc)}</small></div><span>${esc(a.time)}</span></div>`).join('')
    : '<div class="space-placeholder">No recent database activity.</div>';
}
function renderDashboardSpaceOverview(){
  const box=q('#dashboardSpaceOverview');if(!box)return;
  const ids=['A1','A4','ML']; box.innerHTML=`<div class="space-overview">${ids.map(id=>{const d=getSpaceBase(id),occ=getDynamicOccupancy(id),p=Math.round(occ/d.cap*100),status=getSpaceStatus(id);return `<div class="space-overview-row"><div><b>${formatSpaceName(id)}</b><small>${occ} / ${d.cap} occupied</small></div>${statusPill(status)}<div class="occupancy-line"><i style="width:${p}%;background:${status==='near'?'#f0a11f':status==='full'?'#e20707':'#35aa55'}"></i></div></div>`}).join('')}</div>`
}
function updatePrototypeCounts(){
  const s=currentState(),pending=s.requests.filter(r=>r.status==='Pending Approval').length,approvedExtra=s.requests.filter(r=>r.status==='Approved').length;
  qa('[data-pending-count],[data-kpi-pending]').forEach(x=>x.textContent=pending);
  qa('[data-kpi-approved]').forEach(x=>x.textContent=approvedExtra);
  const available=Object.keys(HALLWAY_SPACES).filter(id=>getSpaceStatus(id)!=='full').length;qa('[data-kpi-spaces]').forEach(x=>x.textContent=available);
}
function renderDashboardPrototype(){renderPendingRequests();renderRecentActivity();renderDashboardSpaceOverview();updatePrototypeCounts()}
function reviewRegistration(id){
  const r=getRequest(id),modal=q('#reviewModal');if(!r||!modal)return;
  q('#reviewName').textContent=r.name;
  q('#reviewDetails').innerHTML=`<div class="review-field"><b>Request ID</b><span>${esc(r.id)}</span></div><div class="review-field"><b>Email</b><span>${esc(r.email)}</span></div><div class="review-field"><b>Age / Gender</b><span>${r.age} / ${esc(r.gender)}</span></div><div class="review-field"><b>Group Size</b><span>${r.group} persons</span></div><div class="review-field"><b>Special / Medical Needs</b><span>${esc(r.needs||'None')}</span></div><div class="review-field"><b>Address / Coverage</b><span>${esc([r.address,r.barangay,r.city].filter(Boolean).join(', ')||'Not provided')}</span></div><div class="review-field"><b>Valid ID</b><span>${esc([r.validIdType,r.validIdNumber].filter(Boolean).join(' - ')||'Not provided')}</span></div><div class="review-field"><b>Current Status</b><span>${statusPill(r.status)}</span></div>`;
  q('#approveBtn').onclick=()=>approveRegistration(id);q('#rejectBtn').onclick=()=>rejectRegistration(id);modal.classList.remove('hidden');
}
function closeReviewModal(){q('#reviewModal')?.classList.add('hidden')}
function approveRegistration(id){
  const s=currentState(),r=s.requests.find(x=>x.id===id);if(!r)return;
  r.status='Approved';r.qrIssued=true;r.qrCode='EVAC-2026-'+r.id.replace(/\D/g,'');r.emailSent=true;
  if(s.user.requestId===id){s.user.registrationStatus='Approved';s.user.qrIssued=true;s.user.qrCode=r.qrCode;s.user.emailSent=true;}
  s.activity.unshift({title:`${r.name} approved`,desc:'Barcode generated and confirmation email simulated.',time:'Now',icon:'✓'});saveScanSafeState(s);closeReviewModal();toast(`Approved. Barcode generated and approval email simulated for ${r.name}.`);renderDashboardPrototype();renderEvacs();renderUserPrototype();
}
function rejectRegistration(id){
  const s=currentState(),r=s.requests.find(x=>x.id===id);if(!r)return;r.status='Rejected';
  if(s.user.requestId===id){s.user.registrationStatus='Rejected';s.user.qrIssued=false;s.user.qrCode=null;s.user.assignment=null;}
  s.activity.unshift({title:`${r.name} rejected`,desc:'Registration requires correction before approval.',time:'Now',icon:'!'});saveScanSafeState(s);closeReviewModal();toast('Registration rejected.');renderDashboardPrototype();renderEvacs();renderUserPrototype();
}

function openPublicRegistration(){q('#publicRegistrationModal')?.classList.remove('hidden')}
function closePublicRegistration(){q('#publicRegistrationModal')?.classList.add('hidden')}
function registerPublicEvacuee(e){
  e.preventDefault();const s=currentState();
  const u={requestId:'REQ-1042',id:'EV-001',name:q('#publicName').value.trim(),email:q('#publicEmail').value.trim(),age:Number(q('#publicAge').value||0),gender:q('#publicGender').value,group:Number(q('#publicGroup').value||1),needs:q('#publicNeeds').value.trim()||'None',registrationStatus:'Pending Approval',qrIssued:false,qrCode:null,emailSent:false,assignment:null,checkedIn:false,submitted:'Just now'};
  s.user=u; const idx=s.requests.findIndex(r=>r.id===u.requestId);const req={id:u.requestId,evacueeId:u.id,name:u.name,email:u.email,age:u.age,gender:u.gender,group:u.group,needs:u.needs,submitted:'Just now',status:'Pending Approval'};if(idx>=0)s.requests[idx]=req;else s.requests.unshift(req);
  s.activity.unshift({title:'New registration submitted',desc:`${u.name} is waiting for admin approval.`,time:'Now',icon:'+'});saveScanSafeState(s);closePublicRegistration();toast('Registration submitted. Wait for the admin approval email before your barcode becomes available.');
}
function registerEvac(e){
  e.preventDefault();const s=currentState();const id='REQ-'+String(1050+s.requests.length);const req={id,evacueeId:'EV-'+String(250+s.requests.length),name:q('#adminRegName')?.value.trim()||'New Evacuee',email:q('#adminRegEmail')?.value.trim()||'',age:Number(q('#adminRegAge')?.value||0),gender:q('#adminRegGender')?.value||'Male',group:Number(q('#groupSize')?.value||1),needs:q('#adminRegNeeds')?.value.trim()||'None',submitted:'Just now',status:'Pending Approval'};s.requests.unshift(req);s.activity.unshift({title:'Registration added',desc:`${req.name} is pending admin approval.`,time:'Now',icon:'+'});saveScanSafeState(s);closeRegister();toast('Registration submitted as Pending Approval. No barcode or accommodation assignment yet.');renderEvacs();renderDashboardPrototype();
}

function renderEvacs(){
  const b=q('#evacBody');if(!b)return;const s=currentState();let term=(q('#evacSearch')?.value||'').toLowerCase(),status=q('#evacStatus')?.value||'all';
  const user=s.user; const reqUser=s.requests.find(r=>r.id===user.requestId); const rows=[{id:user.id,name:user.name,age:user.age,gender:user.gender,group:user.group,status:user.checkedIn?'Checked-In':user.registrationStatus,qr:user.qrIssued?'Issued':'Not Issued',assignment:user.assignment?formatSpaceName(user.assignment):'Waiting for assignment',shelter:'Main School Building',requestId:user.requestId},...s.requests.filter(r=>r.id!==user.requestId).map(r=>({id:r.evacueeId,name:r.name,age:r.age,gender:r.gender,group:r.group,status:r.status,qr:r.qrIssued?'Issued':'Not Issued',assignment:'Waiting for assignment',shelter:'Main School Building',requestId:r.id}))];
  const data=rows.filter(e=>(!term||e.name.toLowerCase().includes(term)||e.id.toLowerCase().includes(term)||e.requestId.toLowerCase().includes(term))&&(status==='all'||e.status===status));
  b.innerHTML=data.map((e,i)=>`<tr onclick="showEvac('${e.id}')"><td><input type="checkbox"></td><td>${esc(e.id)}</td><td><b>${esc(e.name)}</b><br><span class="muted">${esc(e.requestId)}</span></td><td>${e.age}</td><td>${esc(e.gender)}</td><td>${e.group}</td><td>${e.qr==='Issued'?'<span class="pill green">Issued</span>':'<span class="pill gray">Not Issued</span>'}</td><td>${esc(e.assignment)}</td><td>${statusPill(e.status)}</td><td><button class="icon-btn" onclick="event.stopPropagation();showEvac('${e.id}')">${ico('eye','sm')}</button></td></tr>`).join('');
}
function showEvac(id){
  const box=q('#evacDetail');if(!box)return;const s=currentState();let e;
  if(id===s.user.id)e={...s.user,status:s.user.checkedIn?'Checked-In':s.user.registrationStatus,requestId:s.user.requestId};else{const r=s.requests.find(x=>x.evacueeId===id);if(r)e={...r,id:r.evacueeId,status:r.status,qrIssued:!!r.qrIssued,qrCode:r.qrCode,assignment:null,requestId:r.id}}
  if(!e)return; const canReview=e.status==='Pending Approval';
  box.innerHTML=`<div style="display:flex;justify-content:space-between;gap:8px"><h3 class="section-h">${ico('user')} Evacuee Details</h3>${canReview?`<button class="btn red" onclick="reviewRegistration('${e.requestId}')">Review</button>`:'<button class="btn out">Edit</button>'}</div><div class="detail-top"><div class="person-round">${ico('user','xl')}</div><div><h2 style="font-size:16px;margin:0 0 4px">${esc(e.name)}</h2><div class="muted" style="font-size:10px">ID: ${esc(e.id)}</div><div style="margin-top:7px">${statusPill(e.status)}</div></div></div>${e.qrIssued?`<div class="prototype-qr-wrap">${qrMarkup(e.qrCode||e.id)}</div>`:`<div class="space-placeholder" style="margin-top:12px">QR is not available until the registration is approved.</div>`}<div class="detail-list"><div class="detail-line"><b>Age / Gender</b><span>${e.age} years old | ${esc(e.gender)}</span></div><div class="detail-line"><b>Group Size</b><span>${e.group} members</span></div><div class="detail-line"><b>QR Status</b><span>${e.qrIssued?'Issued':'Not Issued'}</span></div><div class="detail-line"><b>Accommodation</b><span>${e.assignment?formatSpaceName(e.assignment):'Not assigned yet'}</span></div><div class="detail-line"><b>Special Needs</b><span>${esc(e.needs||'None')}</span></div></div>`;
}

function selectSpace(id){
  const d=getSpaceBase(id);if(!d)return;qa('[data-space]').forEach(x=>x.classList.remove('selected'));q(`[data-space="${id}"]`)?.classList.add('selected');
  const occ=getDynamicOccupancy(id),av=Math.max(0,d.cap-occ),p=Math.round(occ/d.cap*100),status=getSpaceStatus(id),box=q('#spaceDetail'),isUser=document.body.classList.contains('user-shell');
  const action=isUser?'':(status==='full'?'<button class="btn soft full" disabled>Accommodation Space is Full</button>':`<button class="btn red full" onclick="assignSpace('${id}')">${ico('users','sm')} Assign Approved Group</button>`);
  if(box)box.innerHTML=`<div class="room-banner"><svg class="icon xl bigicon"><use href="assets/icons.svg#home"></use></svg><div><h2>${esc(d.name)}</h2><div style="margin-top:5px">${statusPill(status)}</div></div></div><div class="detail-list"><div class="detail-line"><b>Space Type</b><span>${esc(d.type)}</span></div><div class="detail-line"><b>Location</b><span>${esc(d.side)}</span></div><div class="detail-line"><b>Capacity</b><span>${d.cap}</span></div><div class="detail-line"><b>Occupied</b><span>${occ}</span></div><div class="detail-line"><b>Available</b><span>${av}</span></div><div class="detail-line"><b>Occupancy</b><span><div class="occupancy-line"><i style="width:${p}%;background:${status==='near'?'#f0a11f':status==='full'?'#e20707':'#35aa55'}"></i></div><b style="float:right;margin-top:-12px">${p}%</b></span></div><div class="detail-line"><b>Notes</b><span style="background:#f8fafc;border:1px solid #e3e8ee;border-radius:5px;padding:8px">${esc(d.notes)}</span></div></div>${action}`;
}
function renderSpaces(){
  const b=q('#spaceRows');if(!b)return;b.innerHTML=Object.entries(HALLWAY_SPACES).map(([id,d])=>{const occ=getDynamicOccupancy(id),st=getSpaceStatus(id);return `<tr data-row-space="${id}"><td><b>${id==='ML'?'Main Lobby':id}</b></td><td>${esc(d.side)}</td><td>${d.cap}</td><td>${occ}</td><td>${d.cap-occ}</td><td>${statusPill(st)}</td><td><button class="icon-btn" onclick="selectSpace('${id}')">${ico('eye','sm')}</button></td></tr>`}).join('')
}
function filterSpaces(){const term=(q('#spaceSearch')?.value||'').toLowerCase(),st=q('#spaceFilter')?.value||'all';qa('[data-row-space]').forEach(tr=>{const id=tr.dataset.rowSpace,d=getSpaceBase(id),status=getSpaceStatus(id);tr.style.display=((!term||d.name.toLowerCase().includes(term)||d.side.toLowerCase().includes(term)||id.toLowerCase().includes(term))&&(st==='all'||status===st))?'':'none'})}
function eligiblePrototypeGroups(){const s=currentState();const groups=[];if(s.user.registrationStatus==='Approved'&&s.user.qrIssued&&!s.user.assignment)groups.push({id:'USER',name:s.user.name,group:s.user.group,needs:s.user.needs||'None'});for(const g of s.demoGroups||[])if(g.status==='Approved'&&g.qrIssued&&!g.assignment)groups.push(g);return groups}
function assignSpace(id){
  const d=getSpaceBase(id),modal=q('#assignmentModal');if(!d){return}if(!modal){localStorage.setItem('selectedSpace',id);location.href='evacuees.html';return}
  const available=getAvailableSlots(id),groups=eligiblePrototypeGroups();q('#assignmentSpaceTitle').textContent=`Assign to ${d.name}`;q('#assignmentHint').textContent=`${available} slot${available===1?'':'s'} available. Only approved evacuees with issued barcodes can be assigned.`;
  const list=q('#eligibleGroupsList');list.innerHTML=groups.length?groups.map(g=>{const fits=Number(g.group)<=available;return `<div class="eligible-group ${fits?'':'ineligible'}"><div><b>${esc(g.name)}</b><small>Group size: ${g.group} • ${esc(g.needs||'No special needs')}</small></div><button class="btn ${fits?'red':'soft'}" ${fits?'':'disabled'} onclick="confirmSpaceAssignment('${id}','${g.id}')">${fits?'Assign':'Insufficient Slots'}</button></div>`}).join(''):`<div class="space-placeholder">No eligible groups right now. Approve a pending registration and issue its Barcode first.</div>`;modal.classList.remove('hidden')
}
function closeAssignmentModal(){q('#assignmentModal')?.classList.add('hidden')}
function confirmSpaceAssignment(spaceId,groupId){
  const s=currentState(),available=getAvailableSlots(spaceId);let group;
  if(groupId==='USER')group=s.user;else group=(s.demoGroups||[]).find(g=>g.id===groupId);if(!group)return;if(Number(group.group)>available){toast(`Insufficient slots. ${formatSpaceName(spaceId)} only has ${available} available.`);return}
  group.assignment=spaceId;if(groupId==='USER')s.user.assignment=spaceId;else{const idx=s.demoGroups.findIndex(g=>g.id===groupId);if(idx>=0)s.demoGroups[idx]=group}
  s.activity.unshift({title:`Group assigned to ${formatSpaceName(spaceId)}`,desc:`${group.name} • ${group.group} person${group.group===1?'':'s'}`,time:'Now',icon:spaceId==='ML'?'ML':spaceId});saveScanSafeState(s);closeAssignmentModal();toast(`${group.name} assigned to ${formatSpaceName(spaceId)}.`);renderSpaces();selectSpace(spaceId);renderDashboardPrototype();renderUserPrototype();
}

function renderUserPrototype(){
  const s=currentState(),u=s.user;qa('[data-user-name]').forEach(x=>x.textContent=u.name);qa('[data-user-email]').forEach(x=>x.textContent=u.email);qa('[data-user-needs]').forEach(x=>x.textContent=u.needs||'None');qa('[data-user-group]').forEach(x=>x.textContent=u.group);
  const hero=q('#userStatusHero');if(hero){const approved=u.registrationStatus==='Approved';const rejected=u.registrationStatus==='Rejected';hero.innerHTML=`<section class="status-hero ${approved?'approved':rejected?'rejected':'pending'}"><div><small>Registration Status</small><h2>${approved?'Registration Approved ✓':rejected?'Registration Needs Correction':'Pending Admin Approval'}</h2><p>${approved?'Your approval confirmation has been sent. Your barcode is ready.':rejected?'Please contact shelter staff or submit corrected information.':'Your registration has been submitted. Please wait for the admin approval email before barcode issuance.'}</p></div><div class="hero-status-mark">${approved?'✓':rejected?'!':'⌛'}</div></section>`}
  const qr=q('#userQrCard');if(qr){qr.innerHTML=u.qrIssued?`<div class="app-status-icon">▦</div><h3>My Barcode</h3><div class="prototype-qr-wrap">${qrMarkup(u.qrCode)}</div><p>Present this Barcode to authorized shelter staff for verification and check-in.</p>`:`<div class="app-status-icon">▦</div><h3>Barcode</h3><div class="app-value">Not available yet</div><p>Your barcode will be generated only after admin approval.</p>`}
  const acc=q('#userAccommodationCard');if(acc){acc.innerHTML=`<div class="app-status-icon">⌖</div><h3>Accommodation</h3><div class="app-value">${u.assignment?formatSpaceName(u.assignment):'Waiting for assignment'}</div><p>${u.assignment?'Main School Building • Ground Floor':'After barcode issuance, authorized staff will confirm your accommodation space.'}</p>${u.assignment?'<button class="btn out full" onclick="go(\'user-room.html\')">View Map & Details</button>':''}`}
  const latest=q('#userLatestCard');if(latest){let title='Registration submitted',desc='Waiting for admin review.';if(u.qrIssued){title='Barcode issued';desc='Approval email and barcode confirmation available.'}if(u.assignment){title='Accommodation assigned';desc=`Proceed to ${formatSpaceName(u.assignment)}.`}if(u.checkedIn){title='Check-in confirmed';desc='Your barcode was verified by shelter staff.'}latest.innerHTML=`<div class="app-status-icon">●</div><h3>Latest Update</h3><div class="app-value">${esc(title)}</div><p>${esc(desc)}</p>`}
  const prog=q('#userProgressSteps');if(prog){const steps=[['Submitted',true],['Admin Review',u.registrationStatus==='Approved'||u.registrationStatus==='Rejected'],['Barcode Issued',u.qrIssued],['Assigned',!!u.assignment],['Checked-In',!!u.checkedIn]];let activeFound=false;prog.innerHTML=steps.map(([label,done],i)=>{let cls=done?'done':'';if(!done&&!activeFound){cls='active';activeFound=true}return `<div class="progress-step ${cls}"><i>${done?'✓':i+1}</i><b>${label}</b><small>${done?'Completed':'Pending'}</small></div>`}).join('')}
  renderUserAssignmentSummary();renderUserSpaceList();syncLegacyUserPages();
}
function scrollToUserQR(){const el=q('#userQrCard');if(el)el.scrollIntoView({behavior:'smooth',block:'center'});else go('user-portal.html#qr')}
function renderUserAssignmentSummary(){const box=q('#userAssignmentSummary');if(!box)return;const u=currentState().user;if(!u.assignment){box.innerHTML=`<div class="space-placeholder"><b>${u.qrIssued?'Approved — waiting for accommodation assignment':'No accommodation assignment yet'}</b><br>${u.qrIssued?'Authorized staff will assign a suitable hallway or Main Lobby space.':'Your registration must be approved and your barcode must be issued first.'}</div>`;return}const d=getSpaceBase(u.assignment),occ=getDynamicOccupancy(u.assignment),avail=d.cap-occ;box.innerHTML=`<div class="assignment-state-grid"><div class="assignment-state-cell"><small>Your Assigned Space</small><strong>${formatSpaceName(u.assignment)}</strong><span style="font-size:9px;color:#d00">Main School Building • Ground Floor</span></div><div class="assignment-state-cell"><small>Capacity</small><strong>${d.cap}</strong></div><div class="assignment-state-cell"><small>Occupied</small><strong>${occ}</strong></div><div class="assignment-state-cell"><small>Available</small><strong>${avail}</strong></div></div>`;setTimeout(()=>selectSpace(u.assignment),0)}
function renderUserSpaceList(){const box=q('#userSpaceList');if(!box)return;box.innerHTML=Object.keys(HALLWAY_SPACES).map(id=>{const d=getSpaceBase(id),occ=getDynamicOccupancy(id);return `<div class="mobile-space-row"><div><b>${formatSpaceName(id)}</b><small>${occ} / ${d.cap} occupied</small></div>${statusPill(getSpaceStatus(id))}</div>`}).join('')}
function toggleUserMap(show){const panel=q('#userMapPanel');if(!panel)return;panel.classList.toggle('is-hidden',!show);localStorage.setItem('scanSafeUserMapVisible',show?'1':'0')}
function initUserMapToggle(){const toggle=q('#userMapToggle');if(!toggle)return;const saved=localStorage.getItem('scanSafeUserMapVisible');const show=saved!==null?saved==='1':window.innerWidth>720;toggle.checked=show;toggleUserMap(show)}

function scanNow(){
  const s=currentState(),u=s.user,box=q('#scanResult');if(!box)return;
  if(!u.qrIssued){box.classList.remove('hidden');box.innerHTML=`<div class="verified-mark" style="background:#fff4db;color:#b77700">!</div><h2 style="color:#b77700;text-align:center">PENDING APPROVAL</h2><p style="text-align:center;font-size:10px;color:#667085">No valid barcode has been issued for this registration yet.</p>`;toast('QR unavailable: registration is still pending approval.');return}
  s.user.checkedIn=true;s.activity.unshift({title:`${u.name} scanned`,desc:'QR verified at shelter check-in.',time:'Now',icon:'↘'});saveScanSafeState(s);box.classList.remove('hidden');box.innerHTML=`<div class="verified-mark">${ico('check','xl')}</div><h2 style="color:#0a9637;text-align:center;margin:10px 0 4px">VERIFIED</h2><p style="text-align:center;font-size:10px;color:#667085">Approved evacuee Barcode found in system.</p><div class="detail-list"><div class="detail-line"><b>Barcode Number</b><span>${esc(u.qrCode)}</span></div><div class="detail-line"><b>Name</b><span>${esc(u.name)}</span></div><div class="detail-line"><b>Group</b><span>${u.group}</span></div><div class="detail-line"><b>Accommodation</b><span>${u.assignment?formatSpaceName(u.assignment):'Waiting for assignment'}</span></div><div class="detail-line"><b>Status</b><span>${statusPill('Checked-In')}</span></div><div class="detail-line"><b>Scanned By</b><span>Admin</span></div></div>`;toast('QR verified and check-in confirmed.');renderUserPrototype();renderDashboardPrototype();
}
function manualScan(){let v=q('#manualBarcode')?.value.trim();if(!v){toast('Enter a Barcode number.');return}scanNow()}

function syncLegacyUserPages(){
  if(!document.body.classList.contains('user-shell'))return;const u=currentState().user;
  const identity=q('.user-top .identity strong');if(identity)identity.textContent=u.name;
  if(location.pathname.endsWith('profile.html')){qa('.info-line').forEach(row=>{const b=row.querySelector('b'),sp=row.querySelector('span');if(!b||!sp)return;if(b.textContent.includes('Assigned Shelter'))sp.textContent=u.assignment?'Main School Building':'Waiting for assignment';if(b.textContent.includes('Assigned Space'))sp.textContent=u.assignment?formatSpaceName(u.assignment):'Not assigned yet'});const m=q('.profile-layout .muted');if(m)m.textContent=`Evacuee • ${u.checkedIn?'Checked-In':u.registrationStatus}`}
  if(location.pathname.endsWith('my-information.html')){const bc=q('.barcode-card');if(bc&&!u.qrIssued)bc.innerHTML=`<h3 class="section-h">${ico('barcode')} Evacuee Barcode</h3><div class="space-placeholder"><b>QR not available yet.</b><br>Wait for admin approval and email confirmation.</div>`;else if(bc&&u.qrIssued)bc.innerHTML=`<h3 class="section-h">${ico('barcode')} Evacuee Barcode</h3><div class="prototype-qr-wrap">${qrMarkup(u.qrCode)}</div><p class="muted" style="font-size:9px">Present this Barcode to authorized shelter staff.</p>`}
}

function initUserBottomNav(){
  if(!document.body.classList.contains('user-shell'))return;
  q('#mobileMenuButton')?.remove();q('.mobile-nav-overlay')?.remove();document.body.classList.remove('mobile-nav-open');
  if(q('.mobile-bottom-nav'))return;const path=location.pathname.split('/').pop();const nav=document.createElement('nav');nav.className='mobile-bottom-nav';const items=[['user-portal.html','home','Home'],['user-portal.html#qr','barcode','My Barcode'],['user-room.html','bed','My Space'],['user-notifications.html','bell','Alerts'],['profile.html','settings','Profile']];nav.innerHTML=items.map(([href,icon,label])=>`<a href="${href}" class="${(label==='Home'&&path==='user-portal.html')||(label==='My Space'&&path==='user-room.html')||(label==='Alerts'&&path==='user-notifications.html')||(label==='Profile'&&path==='profile.html')?'active':''}">${ico(icon)}<span>${label}</span></a>`).join('');document.body.appendChild(nav)
}
function enhanceAdminNavigation(){
  const side=q('.admin-side');if(!side)return;
  const hasReq=[...side.querySelectorAll('.nav-item span')].some(x=>x.textContent.trim()==='Registration Requests');if(!hasReq){const dash=side.querySelector('.nav-item');if(dash){const a=document.createElement('a');a.className='nav-item';a.href='admin-dashboard.html#registrationRequests';a.innerHTML=`${ico('alert')}<span>Registration Requests</span><b class="nav-badge" data-pending-count>0</b>`;dash.insertAdjacentElement('afterend',a)}}
  side.querySelectorAll('.nav-item span').forEach(x=>{if(x.textContent.trim()==='Shelter & Room')x.textContent='Accommodation Map';if(x.textContent.trim()==='Barcode Scanner')x.textContent='Barcode Scanner'});
}
function restoreSidebarState(){
  if(window.innerWidth<=720)return;const admin=q('#adminMenuToggle'),user=q('#userMenuToggle');
  if(localStorage.getItem('scanSafeAdminSidebar')==='collapsed'&&admin){document.body.classList.add('admin-sidebar-collapsed');admin.innerHTML='&rsaquo;'}
  if(localStorage.getItem('scanSafeUserSidebar')==='collapsed'&&user){document.body.classList.add('sidebar-collapsed');user.innerHTML='&rsaquo;'}
  admin?.addEventListener('click',()=>setTimeout(()=>localStorage.setItem('scanSafeAdminSidebar',document.body.classList.contains('admin-sidebar-collapsed')?'collapsed':'expanded'),0));
  user?.addEventListener('click',()=>setTimeout(()=>localStorage.setItem('scanSafeUserSidebar',document.body.classList.contains('sidebar-collapsed')?'collapsed':'expanded'),0));
}

document.addEventListener('DOMContentLoaded',()=>{
  enhanceAdminNavigation();setNow();renderDashboardPrototype();renderSpaces();renderEvacs();renderUserPrototype();initUserMapToggle();initUserBottomNav();restoreSidebarState();updatePrototypeCounts();
  const s=currentState();if(q('#spaceDetail')&&document.body.classList.contains('user-shell')&&s.user.assignment)selectSpace(s.user.assignment);
  if(location.hash==='#registrationRequests')setTimeout(()=>q('#registrationRequests')?.scrollIntoView({behavior:'smooth'}),150);
  if(location.hash==='#qr')setTimeout(scrollToUserQR,150);
});

/* Small integration fixes for pages that reuse the approval workflow. */
function ensureReviewModal(){
  let modal=q('#reviewModal');
  if(modal)return modal;
  modal=document.createElement('div');
  modal.id='reviewModal';modal.className='prototype-modal hidden';
  modal.innerHTML=`<div class="card prototype-dialog"><div class="dialog-head"><div><span class="eyebrow">Registration Review</span><h2 id="reviewName">Evacuee</h2></div><button class="btn out" onclick="closeReviewModal()">Close</button></div><div id="reviewDetails" class="review-details"></div><div class="review-actions"><button class="btn soft" id="rejectBtn">Reject</button><button class="btn red" id="approveBtn">Approve & Issue QR</button></div><p class="prototype-note">Approval updates the database registration and issues the evacuee barcode.</p></div>`;
  document.body.appendChild(modal);return modal;
}
function reviewRegistration(id){
  const r=getRequest(id),modal=ensureReviewModal();if(!r)return;
  q('#reviewName').textContent=r.name;
  q('#reviewDetails').innerHTML=`<div class="review-field"><b>Request ID</b><span>${esc(r.id)}</span></div><div class="review-field"><b>Email</b><span>${esc(r.email)}</span></div><div class="review-field"><b>Age / Gender</b><span>${r.age} / ${esc(r.gender)}</span></div><div class="review-field"><b>Group Size</b><span>${r.group} persons</span></div><div class="review-field"><b>Special / Medical Needs</b><span>${esc(r.needs||'None')}</span></div><div class="review-field"><b>Address / Coverage</b><span>${esc([r.address,r.barangay,r.city].filter(Boolean).join(', ')||'Not provided')}</span></div><div class="review-field"><b>Valid ID</b><span>${esc([r.validIdType,r.validIdNumber].filter(Boolean).join(' - ')||'Not provided')}</span></div><div class="review-field"><b>Current Status</b><span>${statusPill(r.status)}</span></div>`;
  q('#approveBtn').onclick=()=>approveRegistration(id);q('#rejectBtn').onclick=()=>rejectRegistration(id);modal.classList.remove('hidden');
}
document.addEventListener('DOMContentLoaded',()=>{
  if(location.pathname.endsWith('barcode-scanner.html'))q('#scanResult')?.classList.add('hidden');
});


/* =========================================================
   USER MOBILE FULLSCREEN MAP VIEWER
   Pan / pinch / zoom behavior for user-room.html only.
   Does not alter the original floor-plan image or admin map.
   ========================================================= */
const userMapViewerState = {
  scale: 1,
  x: 0,
  y: 0,
  minScale: .35,
  maxScale: 3,
  pointers: new Map(),
  panLast: null,
  pinchStartDistance: 0,
  pinchStartScale: 1,
  pinchWorldX: 0,
  pinchWorldY: 0
};

function getUserMapViewerParts() {
  return {
    viewer: q('#userMapViewer'),
    viewport: q('#userMapViewport'),
    canvas: q('#userMapViewerCanvas')
  };
}

function clampUserMapScale(value) {
  return Math.min(userMapViewerState.maxScale, Math.max(userMapViewerState.minScale, value));
}

function applyUserMapTransform() {
  const { canvas } = getUserMapViewerParts();
  if (!canvas) return;
  canvas.style.transform = `translate3d(${userMapViewerState.x}px,${userMapViewerState.y}px,0) scale(${userMapViewerState.scale})`;
}

function buildUserMapViewerCanvas() {
  const { canvas } = getUserMapViewerParts();
  const source = q('#userMapPanel .user-floor-stage');
  if (!canvas || !source) return false;

  canvas.innerHTML = '';
  const clone = source.cloneNode(true);
  clone.removeAttribute('id');

  clone.querySelectorAll('[data-space]').forEach(spot => {
    const id = spot.dataset.space;
    spot.removeAttribute('onclick');
    spot.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      showUserMapViewerSpace(id, false);
    });
  });

  canvas.appendChild(clone);
  return true;
}

function showUserMapViewerSpace(id, center = false) {
  const d = getSpaceBase(id);
  if (!d) return;

  const { canvas } = getUserMapViewerParts();
  canvas?.querySelectorAll('[data-space]').forEach(spot => {
    spot.classList.toggle('viewer-selected-space', spot.dataset.space === id);
  });

  const occ = getDynamicOccupancy(id);
  const available = Math.max(0, d.cap - occ);
  const status = getSpaceStatus(id);
  const u = currentState().user;
  const mine = u.assignment === id;

  const eyebrow = q('#viewerSpaceEyebrow');
  const title = q('#viewerSpaceTitle');
  const meta = q('#viewerSpaceMeta');
  const badge = q('#viewerSpaceStatus');

  if (eyebrow) eyebrow.textContent = mine ? 'Your Assigned Space' : 'Designated Accommodation Space';
  if (title) title.textContent = formatSpaceName(id);
  if (meta) meta.textContent = `${d.side} • ${occ}/${d.cap} occupied • ${available} available`;
  if (badge) {
    badge.className = `viewer-space-status ${status}`;
    badge.textContent = status === 'available' ? 'Available' : status === 'near' ? 'Near Full' : 'Full';
  }

  if (center) centerUserMapOnSpace(id);
}

function resetUserMapViewer() {
  const { viewport, canvas } = getUserMapViewerParts();
  const stage = canvas?.querySelector('.user-floor-stage');
  if (!viewport || !stage) return;

  const sw = stage.offsetWidth || 820;
  const sh = stage.offsetHeight || 620;
  const vw = viewport.clientWidth;
  const vh = viewport.clientHeight;

  const fit = Math.min((vw - 22) / sw, (vh - 22) / sh);
  userMapViewerState.minScale = Math.max(.28, Math.min(.9, fit));
  userMapViewerState.scale = userMapViewerState.minScale;
  userMapViewerState.x = (vw - sw * userMapViewerState.scale) / 2;
  userMapViewerState.y = (vh - sh * userMapViewerState.scale) / 2;
  applyUserMapTransform();
}

function userMapZoom(direction) {
  const { viewport } = getUserMapViewerParts();
  if (!viewport) return;

  const oldScale = userMapViewerState.scale;
  const factor = direction > 0 ? 1.25 : .8;
  const newScale = clampUserMapScale(oldScale * factor);
  const cx = viewport.clientWidth / 2;
  const cy = viewport.clientHeight / 2;
  const worldX = (cx - userMapViewerState.x) / oldScale;
  const worldY = (cy - userMapViewerState.y) / oldScale;

  userMapViewerState.scale = newScale;
  userMapViewerState.x = cx - worldX * newScale;
  userMapViewerState.y = cy - worldY * newScale;
  applyUserMapTransform();
}

function centerUserMapOnSpace(id) {
  const { viewport, canvas } = getUserMapViewerParts();
  const stage = canvas?.querySelector('.user-floor-stage');
  const spot = canvas?.querySelector(`[data-space="${id}"]`);
  if (!viewport || !stage || !spot) return;

  const targetScale = clampUserMapScale(Math.max(userMapViewerState.minScale * 1.85, .92));
  const cx = spot.offsetLeft + spot.offsetWidth / 2;
  const cy = spot.offsetTop + spot.offsetHeight / 2;

  userMapViewerState.scale = targetScale;
  userMapViewerState.x = viewport.clientWidth / 2 - cx * targetScale;
  userMapViewerState.y = viewport.clientHeight / 2 - cy * targetScale;
  applyUserMapTransform();
}

function centerUserMapOnAssignment() {
  const id = currentState().user.assignment;
  if (!id) {
    toast('No accommodation assignment yet.');
    resetUserMapViewer();
    return;
  }
  showUserMapViewerSpace(id, true);
}

function openUserMapViewer() {
  const { viewer } = getUserMapViewerParts();
  if (!viewer) return;

  if (!buildUserMapViewerCanvas()) {
    toast('Floor map is not available on this page.');
    return;
  }

  viewer.classList.add('is-open');
  viewer.setAttribute('aria-hidden', 'false');
  document.body.classList.add('user-map-viewer-open');

  requestAnimationFrame(() => {
    resetUserMapViewer();
    const assignment = currentState().user.assignment;
    if (assignment) {
      showUserMapViewerSpace(assignment, true);
    } else {
      const badge = q('#viewerSpaceStatus');
      if (q('#viewerSpaceEyebrow')) q('#viewerSpaceEyebrow').textContent = 'Accommodation Map';
      if (q('#viewerSpaceTitle')) q('#viewerSpaceTitle').textContent = 'Explore the ground floor';
      if (q('#viewerSpaceMeta')) q('#viewerSpaceMeta').textContent = 'Tap a designated hallway or Main Lobby area to view capacity.';
      if (badge) {
        badge.className = 'viewer-space-status';
        badge.textContent = 'Map';
      }
    }
  });
}

function closeUserMapViewer() {
  const { viewer } = getUserMapViewerParts();
  if (!viewer) return;
  viewer.classList.remove('is-open');
  viewer.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('user-map-viewer-open');
  userMapViewerState.pointers.clear();
  userMapViewerState.panLast = null;
}

function initUserMapViewerGestures() {
  const { viewport } = getUserMapViewerParts();
  if (!viewport || viewport.dataset.viewerGestures === '1') return;
  viewport.dataset.viewerGestures = '1';

  const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  viewport.addEventListener('pointerdown', event => {
    if (!q('#userMapViewer')?.classList.contains('is-open')) return;
    userMapViewerState.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    viewport.setPointerCapture?.(event.pointerId);

    if (userMapViewerState.pointers.size === 1) {
      userMapViewerState.panLast = { x: event.clientX, y: event.clientY };
    } else if (userMapViewerState.pointers.size === 2) {
      const [a, b] = [...userMapViewerState.pointers.values()];
      const mid = midpoint(a, b);
      userMapViewerState.pinchStartDistance = distance(a, b);
      userMapViewerState.pinchStartScale = userMapViewerState.scale;
      userMapViewerState.pinchWorldX = (mid.x - viewport.getBoundingClientRect().left - userMapViewerState.x) / userMapViewerState.scale;
      userMapViewerState.pinchWorldY = (mid.y - viewport.getBoundingClientRect().top - userMapViewerState.y) / userMapViewerState.scale;
      userMapViewerState.panLast = null;
    }
  });

  viewport.addEventListener('pointermove', event => {
    if (!userMapViewerState.pointers.has(event.pointerId)) return;
    userMapViewerState.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (userMapViewerState.pointers.size >= 2) {
      const [a, b] = [...userMapViewerState.pointers.values()];
      const currentDistance = distance(a, b);
      if (!userMapViewerState.pinchStartDistance) return;

      const newScale = clampUserMapScale(
        userMapViewerState.pinchStartScale * (currentDistance / userMapViewerState.pinchStartDistance)
      );
      const mid = midpoint(a, b);
      const rect = viewport.getBoundingClientRect();
      const mx = mid.x - rect.left;
      const my = mid.y - rect.top;

      userMapViewerState.scale = newScale;
      userMapViewerState.x = mx - userMapViewerState.pinchWorldX * newScale;
      userMapViewerState.y = my - userMapViewerState.pinchWorldY * newScale;
      applyUserMapTransform();
      return;
    }

    if (userMapViewerState.panLast) {
      const dx = event.clientX - userMapViewerState.panLast.x;
      const dy = event.clientY - userMapViewerState.panLast.y;
      if (Math.abs(dx) + Math.abs(dy) > 1) viewport.classList.add('is-dragging');
      userMapViewerState.x += dx;
      userMapViewerState.y += dy;
      userMapViewerState.panLast = { x: event.clientX, y: event.clientY };
      applyUserMapTransform();
    }
  });

  const endPointer = event => {
    userMapViewerState.pointers.delete(event.pointerId);
    viewport.classList.remove('is-dragging');

    if (userMapViewerState.pointers.size === 1) {
      const p = [...userMapViewerState.pointers.values()][0];
      userMapViewerState.panLast = { x: p.x, y: p.y };
    } else {
      userMapViewerState.panLast = null;
    }

    userMapViewerState.pinchStartDistance = 0;
  };

  viewport.addEventListener('pointerup', endPointer);
  viewport.addEventListener('pointercancel', endPointer);

  viewport.addEventListener('wheel', event => {
    if (!q('#userMapViewer')?.classList.contains('is-open')) return;
    event.preventDefault();
    userMapZoom(event.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  q('#userMapViewer')?.addEventListener('click', event => {
    if (event.target.id === 'userMapViewer') closeUserMapViewer();
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && q('#userMapViewer')?.classList.contains('is-open')) closeUserMapViewer();
  });
}

document.addEventListener('DOMContentLoaded', initUserMapViewerGestures);
