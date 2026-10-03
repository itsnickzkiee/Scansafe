
const ROOMS={
'116':{name:'Room 116',type:'Classroom',cap:30,occ:20,status:'available',notes:'Standard classroom with chairs and tables. Suitable for families.'},
'115':{name:'Room 115',type:'Classroom',cap:30,occ:22,status:'available',notes:'Standard classroom available for evacuee groups.'},
'114':{name:'Room 114',type:'Classroom',cap:30,occ:28,status:'near',notes:'Near capacity; assign small groups only.'},
'113':{name:'Room 113',type:'Classroom',cap:30,occ:27,status:'near',notes:'Near capacity; three slots remain.'},
'112':{name:'Room 112',type:'Classroom',cap:30,occ:12,status:'available',notes:'Available classroom with good remaining capacity.'},
'111':{name:'Room 111',type:'Classroom',cap:30,occ:15,status:'available',notes:'Available for family or individual evacuees.'},
'110':{name:'Room 110',type:'Classroom',cap:30,occ:30,status:'full',notes:'Full. No additional evacuees can be assigned.'},
'109':{name:'Room 109',type:'Classroom',cap:30,occ:30,status:'full',notes:'Full. No additional evacuees can be assigned.'},
'108':{name:'Room 108',type:'Classroom',cap:30,occ:18,status:'available',notes:'Available classroom.'},
'107':{name:'Room 107',type:'Classroom',cap:30,occ:16,status:'available',notes:'Available classroom.'},
'106':{name:'Room 106',type:'Classroom',cap:30,occ:25,status:'near',notes:'Near capacity.'},
'105':{name:'Room 105',type:'Classroom',cap:30,occ:24,status:'near',notes:'Near capacity.'},
'104':{name:'Room 104',type:'Classroom',cap:30,occ:10,status:'available',notes:'Available classroom.'},
'103':{name:'Room 103',type:'Classroom',cap:30,occ:30,status:'full',notes:'Full. No additional evacuees can be assigned.'},
'102':{name:'Room 102',type:'Classroom',cap:30,occ:30,status:'full',notes:'Full. No additional evacuees can be assigned.'},
'atrium':{name:'Atrium',type:'Common Area',cap:80,occ:24,status:'available',notes:'Central common area; use only when authorized by shelter staff.'},
'fitness':{name:'Physical Fitness Room',type:'Activity Room',cap:40,occ:18,status:'available',notes:'Overflow accommodation area.'},
'lobby':{name:'Main Lobby',type:'Designated Evacuees Area',cap:100,occ:72,status:'near',notes:'Primary designated evacuees area on the ground floor.'}
};
const EVACS=[
{id:'EV-001',name:'Juan Dela Cruz',age:25,gender:'Male',group:4,shelter:'Main School Building',room:'Room B-12',status:'Verified'},
{id:'EV-002',name:'Maria Santos',age:28,gender:'Female',group:1,shelter:'Main School Building',room:'Room A-4',status:'Verified'},
{id:'EV-003',name:'Pedro Reyes',age:41,gender:'Male',group:5,shelter:'Gymnasium',room:'Room G-01',status:'Unverified'},
{id:'EV-004',name:'Ana Cruz',age:19,gender:'Female',group:1,shelter:'Covered Court',room:'Room C-03',status:'Verified'},
{id:'EV-005',name:'Lisa Fernandez',age:28,gender:'Female',group:3,shelter:'H.S. Building',room:'Room H-10',status:'Verified'},
{id:'EV-006',name:'Jose Garcia',age:62,gender:'Male',group:2,shelter:'Main School Building',room:'Room B-08',status:'Verified'},
{id:'EV-007',name:'Carlos Mendoza',age:34,gender:'Male',group:1,shelter:'Gymnasium',room:'Room G-05',status:'Pending'},
{id:'EV-008',name:'Elena Torres',age:47,gender:'Female',group:4,shelter:'Covered Court',room:'Room C-01',status:'Verified'},
{id:'EV-009',name:'Ramon Villanueva',age:31,gender:'Male',group:1,shelter:'Main School Building',room:'Room A-7',status:'Unverified'},
{id:'EV-010',name:'Sofia Dela Cruz',age:8,gender:'Female',group:3,shelter:'H.S. Building',room:'Room H-02',status:'Verified'}];
function q(s){return document.querySelector(s)}function qa(s){return [...document.querySelectorAll(s)]}
function ico(id,cls=''){return `<svg class="icon ${cls}"><use href="assets/icons.svg#${id}"></use></svg>`}
function go(p){location.href=p}function logout(){location.href='index.html'}
function toast(t){let x=q('.toast');if(x)x.remove();x=document.createElement('div');x.className='toast';x.style='position:fixed;right:20px;bottom:20px;background:#101828;color:white;padding:11px 16px;border-radius:7px;font-size:11px;z-index:1000;box-shadow:0 8px 25px #0003';x.textContent=t;document.body.appendChild(x);setTimeout(()=>x.remove(),2200)}
function loginDemo(e){e.preventDefault();location.href=q('#role').value==='admin'?'admin-dashboard.html':'user-portal.html'}
function setNow(){qa('[data-now]').forEach(x=>x.textContent='August 6, 2026   10:24 AM')}
function statusPill(s){let c=s==='Verified'||s==='available'?'green':s==='Pending'||s==='near'?'yellow':'red';let t=s==='available'?'Available':s==='near'?'Near Full':s==='full'?'Full':s;return `<span class="pill ${c}">${t}</span>`}
function selectRoom(id){const d=ROOMS[id];if(!d)return;qa('[data-room]').forEach(x=>x.classList.remove('selected'));let r=q(`[data-room="${id}"]`);if(r)r.classList.add('selected');const av=d.cap-d.occ,p=Math.round(d.occ/d.cap*100),box=q('#roomDetail');if(box)box.innerHTML=`<div class="room-banner"><svg class="icon xl bigicon"><use href="assets/icons.svg#home"></use></svg><div><h2>${d.name}</h2><div style="margin-top:5px">${statusPill(d.status)}</div></div></div><div class="detail-list"><div class="detail-line"><b>Room Type</b><span>${d.type}</span></div><div class="detail-line"><b>Capacity</b><span>${d.cap}</span></div><div class="detail-line"><b>Occupied</b><span>${d.occ}</span></div><div class="detail-line"><b>Available</b><span>${av}</span></div><div class="detail-line"><b>Occupancy</b><span><div class="occupancy-line"><i style="width:${p}%"></i></div><b style="float:right;margin-top:-12px">${p}%</b></span></div><div class="detail-line"><b>Notes</b><span style="background:#f8fafc;border:1px solid #e3e8ee;border-radius:5px;padding:8px">${d.notes}</span></div></div>${d.status==='full'?'<button class="btn soft full" disabled>Room is Full</button>':`<button class="btn red full" onclick="assignRoom('${id}')">${ico('users','sm')} Assign Evacuee / Group</button>`}`}
function renderRooms(){const b=q('#roomRows');if(!b)return;b.innerHTML=Object.entries(ROOMS).filter(([id])=>!['atrium','fitness','lobby'].includes(id)).map(([id,d])=>`<tr data-row-room="${id}"><td>${id}</td><td>${d.type}</td><td>${d.cap}</td><td>${d.occ}</td><td>${d.cap-d.occ}</td><td>${statusPill(d.status)}</td><td><button class="icon-btn" onclick="selectRoom('${id}')">${ico('eye','sm')}</button></td></tr>`).join('')}
function filterRooms(){let term=(q('#roomSearch')?.value||'').toLowerCase(),st=q('#roomFilter')?.value||'all';qa('[data-row-room]').forEach(tr=>{let d=ROOMS[tr.dataset.rowRoom];tr.style.display=((!term||d.name.toLowerCase().includes(term)||tr.dataset.rowRoom.includes(term))&&(st==='all'||d.status===st))?'':'none'})}
function assignRoom(id){localStorage.setItem('selectedRoom',id);location.href='evacuees.html?assign='+id}
function renderEvacs(){const b=q('#evacBody');if(!b)return;let term=(q('#evacSearch')?.value||'').toLowerCase(),status=q('#evacStatus')?.value||'all',shelter=q('#evacShelter')?.value||'all';const data=EVACS.filter(e=>(!term||e.name.toLowerCase().includes(term)||e.id.toLowerCase().includes(term))&&(status==='all'||e.status===status)&&(shelter==='all'||e.shelter===shelter));b.innerHTML=data.map((e,i)=>`<tr class="${i===0?'selected-row':''}" onclick="showEvac('${e.id}')"><td><input type="checkbox" ${i===0?'checked':''}></td><td>${e.id}</td><td><b>${e.name}</b></td><td>${e.age}</td><td>${e.gender}</td><td>${e.group}</td><td>${e.shelter}<br><span class="muted">${e.room}</span></td><td>${statusPill(e.status)}</td><td><span class="actions">${ico('eye','sm')}${ico('edit','sm')}${ico('trash','sm')}</span></td></tr>`).join('')}
function showEvac(id){const e=EVACS.find(x=>x.id===id),box=q('#evacDetail');if(!e||!box)return;box.innerHTML=`<div style="display:flex;justify-content:space-between"><h3 class="section-h">${ico('user')} Evacuee Details</h3><button class="btn out">${ico('edit','sm')} Edit</button></div><div class="detail-top"><div class="person-round">${ico('user','xl')}</div><div><h2 style="font-size:16px;margin:0 0 4px">${e.name}</h2><div class="muted" style="font-size:10px">ID: ${e.id}</div><div style="margin-top:7px">${statusPill(e.status)}</div></div></div><div class="barcode" style="width:150px;margin:15px auto 5px"></div><div style="text-align:center;font-weight:700;font-size:10px">${e.id}</div><button class="btn out full" style="margin-top:7px" onclick="window.print()">Print ID</button><div class="detail-list"><div class="detail-line"><b>Age / Gender</b><span>${e.age} years old &nbsp;|&nbsp; ${e.gender}</span></div><div class="detail-line"><b>Group Size</b><span>${e.group} members</span></div><div class="detail-line"><b>Room Assignment</b><span>${e.shelter}<br>${e.room}</span></div><div class="detail-line"><b>Special Needs</b><span>None</span></div><div class="detail-line"><b>Emergency Contact</b><span>Maria Dela Cruz (Mother)<br>0917 123 4567</span></div><div class="detail-line"><b>Registration Time</b><span>Aug 6, 2026 &nbsp;10:12 AM</span></div><div class="detail-line"><b>Remarks</b><span>Family with young children.</span></div></div>`}
function openRegister(){const m=q('#registerModal');if(m)m.classList.remove('hidden')}
function closeRegister(){q('#registerModal')?.classList.add('hidden')}
function registerEvac(e){e.preventDefault();toast('Evacuee registered successfully.');closeRegister()}
function scanNow(){q('#scanResult')?.classList.remove('hidden');toast('Barcode verified: EV-001234')}
function manualScan(){let v=q('#manualBarcode')?.value.trim();if(!v){toast('Enter a barcode number.');return}scanNow()}
function exportCSV(name='scansafe-report.csv'){let data='Report,Value\\nTotal Evacuees,248\\nVerified,220\\nPending,28\\n';let a=document.createElement('a');a.href=URL.createObjectURL(new Blob([data],{type:'text/csv'}));a.download=name;a.click();URL.revokeObjectURL(a.href);toast('CSV generated.')}
function generatePDF(){toast('Opening print dialog — choose Save as PDF.');setTimeout(()=>window.print(),300)}
function sendMessage(){let inp=q('#messageInput');if(!inp||!inp.value.trim())return;let row=document.createElement('div');row.className='bubble-row mine';row.innerHTML=`<div class="bubble">${inp.value.replace(/</g,'&lt;')}</div><div class="avatar">A</div>`;q('#thread').appendChild(row);inp.value='';q('#thread').scrollTop=q('#thread').scrollHeight}
function sendAnnouncement(){let t=q('#announcement');if(!t?.value.trim()){toast('Type an announcement first.');return}toast('Announcement sent to '+q('#announceTo').value);t.value=''}
function toggleSetting(el){el.classList.toggle('on');localStorage.setItem('setting_'+el.dataset.key,el.classList.contains('on'))}
function saveSettings(){toast('Settings saved.')}
const NOTIFS={weather:{title:'Weather Advisory',type:'Advisory',desc:'Heavy rain expected in the next 6 hours.',body:'PAGASA reports that heavy rains are expected within the next 6 hours due to a tropical depression affecting the region. Residents in low-lying areas are advised to stay alert and follow the instructions of local authorities.'},room:{title:'Room Update',type:'Room',desc:'You are now assigned to Room A-4 (Main School Building).',body:'Your assigned room has been updated. Please proceed to Room A-4 and follow shelter staff instructions.'},system:{title:'System Message',type:'System',desc:'Your information has been verified.',body:'Your registration information has been reviewed and verified by shelter staff.'},evac:{title:'Evacuation Notice',type:'Emergency',desc:'Pre-emptive evacuation for low-lying areas has been ordered.',body:'Please remain inside the designated evacuation shelter until an official all-clear is issued.'}};
function selectNotif(id){qa('.notif-item').forEach(x=>x.classList.toggle('active',x.dataset.id===id));let d=NOTIFS[id],b=q('#notifDetail');if(!d||!b)return;b.innerHTML=`<div style="display:flex;align-items:center;gap:12px"><div class="notice-ico" style="background:${id==='weather'?'#ff9f1c':id==='system'?'#1774b8':'#d50000'}">${ico(id==='room'?'bed':id==='system'?'info':'alert')}</div><div><h2 style="margin:0;font-size:20px">${d.title}</h2><div class="muted" style="font-size:10px;margin-top:4px">Aug 6, 2026 • 10:24 AM • ${d.type}</div></div></div><div class="notif-preview-img" style="margin-top:14px"><span class="pill yellow" style="width:max-content">${d.title.toUpperCase()}</span><h2 style="font-size:25px;margin:10px 0 6px">${d.desc}</h2><p style="margin:0;font-size:12px">Keep safe and monitor further updates from local authorities.</p></div><p style="font-size:11px;line-height:1.6">${d.body}</p><div style="background:#fff0f0;border:1px solid #ffdede;border-radius:8px;padding:12px"><b style="color:#d60000;font-size:11px">Safety Reminders:</b><ul style="font-size:10px;line-height:1.8;margin-bottom:0"><li>Stay in the evacuation shelter and avoid unnecessary travel.</li><li>Keep your personal belongings secure and dry.</li><li>Monitor announcements for further updates.</li></ul></div>`}
function editInfo(){qa('[data-editable]').forEach(x=>{x.contentEditable='true';x.style.background='#fff7e6';x.style.outline='1px solid #ffd28a'});toast('Edit mode enabled. Click Save when done.');q('#saveInfo')?.classList.remove('hidden')}
function saveInfo(){qa('[data-editable]').forEach(x=>{x.contentEditable='false';x.style=''});q('#saveInfo')?.classList.add('hidden');toast('Information saved.')}
document.addEventListener('DOMContentLoaded',()=>{setNow();renderRooms();renderEvacs();showEvac('EV-001');if(q('.selected-user')) selectRoom('109'); else selectRoom('116');selectNotif('weather');qa('.switch').forEach(s=>{if(localStorage.getItem('setting_'+s.dataset.key)==='true')s.classList.add('on')});let sel=localStorage.getItem('selectedRoom');if(sel&&q('#assignRoom'))q('#assignRoom').value=sel;});


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
