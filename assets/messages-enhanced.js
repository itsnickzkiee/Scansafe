/* =========================================================
   ScanSafe Enhanced Messaging
   Isolated messaging UI/realtime layer.
   Does NOT modify accommodation/map behavior.
   ========================================================= */
(function(){
  'use strict';

  const page=(location.pathname.split('/').pop()||'').toLowerCase();
  if(!['messages.html','user-messages.html'].includes(page)) return;

  const isStaff=page==='messages.html';
  const state={
    sb:null,
    session:null,
    profile:null,
    contacts:[],
    currentId:null,
    currentName:'',
    contactId:null,
    contactName:'ScanSafe Staff',
    sending:false,
    announceSending:false,
    messageChannel:null,
    typingChannel:null,
    typingStopTimer:null,
    typingThrottleAt:0,
    remoteTypingTimer:null,
    lastComposer:isStaff?'announcement':'chat',
    search:'',
    initialized:false,
    refreshTimer:null,
    lastThreadIds:new Set()
  };

  const templates={
    'Weather Advisory':'Weather Advisory: Please remain alert and follow official shelter instructions. Staff will provide updates as conditions change.',
    'Accommodation Update':'Accommodation Update: Please check your assigned shelter space and follow staff instructions for any changes.',
    'Supply Request':'Supply Request: Please state the item, quantity, and urgency so shelter staff can assist you.',
    'Volunteer Notice':'Volunteer Notice: Volunteers are requested to coordinate with shelter staff before assisting in designated areas.',
    'System Announcement':'System Announcement: Please check ScanSafe for the latest official shelter updates and instructions.'
  };

  function esc(v){
    return String(v??'')
      .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
      .replaceAll('"','&quot;').replaceAll("'",'&#039;');
  }

  function initials(name){
    const p=String(name||'User').trim().split(/\s+/).filter(Boolean);
    return (p.slice(0,2).map(x=>x[0]).join('')||'U').toUpperCase();
  }

  function formatTime(value){
    if(!value) return '';
    const d=new Date(value);
    if(Number.isNaN(d.getTime())) return '';
    const today=new Date();
    const same=d.toDateString()===today.toDateString();
    return same
      ? d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})
      : d.toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  }

  function relative(value){
    if(!value) return '';
    const d=new Date(value), sec=Math.max(0,Math.floor((Date.now()-d.getTime())/1000));
    if(sec<45) return 'Now';
    if(sec<3600) return Math.floor(sec/60)+'m';
    if(sec<86400) return Math.floor(sec/3600)+'h';
    return Math.floor(sec/86400)+'d';
  }

  function client(){
    if(window.ScanSafeDB?.client) return window.ScanSafeDB.client;
    const cfg=window.SCANSafeSupabaseConfig||{};
    if(window.supabase?.createClient && cfg.url && cfg.anonKey){
      window.ScanSafeDB=window.ScanSafeDB||{};
      window.ScanSafeDB.client=window.supabase.createClient(cfg.url,cfg.anonKey,{
        auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}
      });
      return window.ScanSafeDB.client;
    }
    return null;
  }

  async function context(){
    state.sb=client();
    if(!state.sb) return false;
    let session=window.ScanSafeDB?.session||null;
    if(!session){
      const res=await state.sb.auth.getSession();
      session=res.data?.session||null;
      if(window.ScanSafeDB) window.ScanSafeDB.session=session;
    }
    state.session=session;
    state.profile=window.ScanSafeDB?.profile||null;
    return !!session?.user;
  }

  function thread(){
    return document.getElementById('thread');
  }

  function scrollBottom(smooth=true){
    const el=thread();
    if(!el) return;
    requestAnimationFrame(()=>{
      try{el.scrollTo({top:el.scrollHeight,behavior:smooth?'smooth':'auto'});}
      catch(_){el.scrollTop=el.scrollHeight;}
    });
  }

  function typingMarkup(name){
    return `<div class="ss-typing-row" data-typing-indicator>
      <span class="ss-typing-avatar">${esc(initials(name))}</span>
      <div class="ss-typing-bubble" aria-label="${esc(name)} is typing">
        <i></i><i></i><i></i>
      </div>
      <span class="ss-typing-label">${esc(name)} is typing</span>
    </div>`;
  }

  function showRemoteTyping(active,name){
    clearTimeout(state.remoteTypingTimer);
    const el=thread();
    if(el){
      el.querySelectorAll('[data-typing-indicator]').forEach(x=>x.remove());
      if(active){
        el.insertAdjacentHTML('beforeend',typingMarkup(name||state.currentName||state.contactName||'User'));
        scrollBottom(true);
      }
    }

    if(isStaff && state.currentId){
      const row=document.querySelector(`[data-contact-id="${CSS.escape(String(state.currentId))}"]`);
      if(row){
        const preview=row.querySelector('[data-contact-preview]');
        if(preview){
          if(active){
            preview.dataset.original=preview.dataset.original||preview.textContent||'';
            preview.innerHTML='<span class="ss-list-typing"><i></i><i></i><i></i></span> typing…';
          }else if(preview.dataset.original){
            preview.textContent=preview.dataset.original;
            delete preview.dataset.original;
          }
        }
      }
    }

    if(active){
      state.remoteTypingTimer=setTimeout(()=>showRemoteTyping(false,name),2600);
    }
  }

  function pairTopic(otherId){
    const me=state.session?.user?.id;
    if(!me||!otherId) return null;
    const pair=[String(me),String(otherId)].sort().join('-');
    return 'scansafe-typing-'+pair;
  }

  async function setupTypingChannel(otherId,otherName){
    if(!state.sb||!otherId) return;
    if(state.typingChannel){
      try{await state.sb.removeChannel(state.typingChannel);}catch(_){}
      state.typingChannel=null;
    }
    state.currentName=otherName||state.currentName;
    const topic=pairTopic(otherId);
    if(!topic) return;
    state.typingChannel=state.sb.channel(topic,{config:{broadcast:{self:false}}})
      .on('broadcast',{event:'typing'},({payload})=>{
        if(String(payload?.sender_id)!==String(otherId)) return;
        if(String(payload?.receiver_id)!==String(state.session?.user?.id)) return;
        showRemoteTyping(payload?.typing===true,payload?.name||otherName);
      })
      .subscribe();
  }

  function broadcastTyping(active){
    const otherId=isStaff?state.currentId:state.contactId;
    if(!state.typingChannel||!otherId) return;
    state.typingChannel.send({
      type:'broadcast',
      event:'typing',
      payload:{
        sender_id:state.session?.user?.id,
        receiver_id:otherId,
        name:state.profile?.full_name||state.session?.user?.user_metadata?.full_name||(isStaff?'Shelter Staff':'Evacuee'),
        typing:!!active,
        at:Date.now()
      }
    }).catch(()=>{});
  }

  function onTypingInput(){
    state.lastComposer='chat';
    const now=Date.now();
    const input=document.getElementById('messageInput');
    const active=!!String(input?.value||'').trim();
    if(active && now-state.typingThrottleAt>700){
      state.typingThrottleAt=now;
      broadcastTyping(true);
    }
    clearTimeout(state.typingStopTimer);
    state.typingStopTimer=setTimeout(()=>broadcastTyping(false),1200);
  }

  function messageRow(m,mineId,targetName,optimistic=false){
    const mine=String(m.sender_id)===String(mineId);
    const name=mine?(state.profile?.full_name||'You'):(m.sender_name||targetName||'User');
    const status=optimistic
      ? '<span class="ss-send-state" data-send-state>Sending…</span>'
      : mine
        ? `<span class="ss-send-state">${m.read_at?'Read':'Sent'}</span>`
        : '';
    return `<div class="bubble-row ${mine?'mine':''}" data-message-id="${esc(m.message_id||'')}">
      ${mine?'':`<span class="avatar">${esc(initials(name))}</span>`}
      <div class="bubble">
        ${mine?'':`<b class="ss-bubble-name">${esc(name)}</b>`}
        <div class="ss-message-text">${esc(m.message_text||'')}</div>
        <div class="ss-message-meta"><span>${esc(formatTime(m.sent_at||new Date()))}</span>${status}</div>
      </div>
      ${mine?`<span class="avatar">${esc(initials(name))}</span>`:''}
    </div>`;
  }

  function renderThread(rows,targetName){
    const el=thread();
    if(!el) return;
    const mineId=state.session?.user?.id;
    const arr=Array.isArray(rows)?rows:[];
    const seen=new Set();
    const unique=arr.filter(m=>{
      const key=String(m.message_id||`${m.sender_id}-${m.sent_at}-${m.message_text}`);
      if(seen.has(key)) return false;
      seen.add(key); return true;
    });
    state.lastThreadIds=seen;
    if(!unique.length){
      el.innerHTML='<div class="ss-empty-chat"><b>No messages yet</b><span>Send the first message below.</span></div>';
      return;
    }
    el.innerHTML=unique.map(m=>messageRow(m,mineId,targetName,false)).join('');
    scrollBottom(false);
  }

  function appendOptimistic(message){
    const el=thread();
    if(!el) return null;
    el.querySelector('.ss-empty-chat')?.remove();
    const temp='temp-'+Date.now()+'-'+Math.random().toString(36).slice(2,6);
    el.insertAdjacentHTML('beforeend',messageRow({
      message_id:temp,
      sender_id:state.session?.user?.id,
      message_text:message,
      sent_at:new Date().toISOString()
    },state.session?.user?.id,state.currentName||state.contactName,true));
    scrollBottom(true);
    return temp;
  }

  function updateOptimistic(temp,status,failed=false){
    const row=document.querySelector(`[data-message-id="${CSS.escape(String(temp))}"]`);
    if(!row) return;
    const stateEl=row.querySelector('[data-send-state]');
    if(stateEl){
      stateEl.textContent=status;
      stateEl.classList.toggle('is-failed',!!failed);
    }
  }

  async function loadUserContact(){
    const {data,error}=await state.sb.rpc('get_my_scansafe_message_contact');
    if(error){
      console.warn('Message contact:',error.message);
      return null;
    }
    if(data){
      state.contactId=data.user_id;
      state.contactName=data.full_name||'ScanSafe Staff';
      const name=document.querySelector('[data-message-admin-name]');
      if(name) name.textContent=state.contactName;
      await setupTypingChannel(state.contactId,'Shelter staff');
    }
    return data;
  }

  async function loadUserThread(){
    if(!state.sb) return;
    const {data,error}=await state.sb.rpc('get_my_admin_thread');
    if(error){console.warn('User messages:',error.message);return;}
    renderThread(data||[],'Shelter Staff');
    const last=Array.isArray(data)&&data.length?data[data.length-1]:null;
    const preview=document.querySelector('[data-user-conversation-preview]');
    if(preview) preview.textContent=last?.message_text||'Message ScanSafe Staff';
  }

  async function loadContacts(selectFirst=false){
    if(!state.sb||!isStaff) return;
    const {data,error}=await state.sb.rpc('get_staff_message_contacts');
    if(error){console.warn('Message contacts:',error.message);return;}
    state.contacts=Array.isArray(data)?data:[];
    renderContacts();

    if(selectFirst){
      const id=state.currentId||state.contacts[0]?.user_id;
      if(id) await selectContact(id);
    }
  }

  function filteredContacts(){
    const q=state.search.trim().toLowerCase();
    if(!q) return state.contacts;
    return state.contacts.filter(c=>
      String(c.full_name||'').toLowerCase().includes(q) ||
      String(c.last_message||'').toLowerCase().includes(q)
    );
  }

  function renderContacts(){
    if(!isStaff) return;
    const host=document.querySelector('[data-conversation-list]');
    if(!host) return;
    const list=filteredContacts();
    if(!list.length){
      host.innerHTML='<div class="ss-empty-list">No matching conversations.</div>';
    }else{
      host.innerHTML=list.map(c=>`
        <button type="button" class="ss-contact ${String(c.user_id)===String(state.currentId)?'active':''}" data-contact-id="${esc(c.user_id)}">
          <span class="avatar">${esc(initials(c.full_name))}</span>
          <span class="ss-contact-copy">
            <b>${esc(c.full_name||'Evacuee')}</b>
            <span data-contact-preview>${esc(c.last_message||'No messages yet')}</span>
          </span>
          <span class="ss-contact-meta">
            <small>${esc(relative(c.last_at))}</small>
            ${Number(c.unread_count||0)>0?`<em>${Number(c.unread_count)}</em>`:''}
          </span>
        </button>`).join('');
    }
    host.querySelectorAll('[data-contact-id]').forEach(btn=>{
      btn.addEventListener('click',()=>selectContact(btn.dataset.contactId));
    });
    const total=state.contacts.reduce((n,c)=>n+Number(c.unread_count||0),0);
    const count=document.querySelector('[data-all-message-count]');
    if(count){
      count.textContent=String(total);
      count.hidden=total<1;
    }
  }

  async function selectContact(id){
    if(!id||!state.sb) return;
    state.currentId=id;
    const c=state.contacts.find(x=>String(x.user_id)===String(id));
    state.currentName=c?.full_name||'Evacuee';
    renderContacts();

    const head=document.querySelector('.conversation .conv-head');
    if(head){
      head.innerHTML=`<div class="ss-conv-person">
        <span class="avatar">${esc(initials(state.currentName))}</span>
        <div><b>${esc(state.currentName)}</b><span>Evacuee • ScanSafe Account</span></div>
      </div>
      <span class="ss-conv-last">${esc(c?.last_at?relative(c.last_at):'')}</span>`;
    }
    await setupTypingChannel(id,state.currentName);
    const {data,error}=await state.sb.rpc('get_staff_thread',{p_user_id:id});
    if(error){console.warn('Staff thread:',error.message);return;}
    renderThread(data||[],state.currentName);
    // Marking thread read changes unread count; refresh list without changing selection.
    setTimeout(()=>loadContacts(false),120);
  }

  async function directSend(receiver,message){
    if(isStaff){
      return state.sb.rpc('staff_send_scansafe_message',{
        p_receiver:receiver,
        p_message:message
      });
    }
    return state.sb.rpc('send_message_to_scansafe_admin',{p_message:message});
  }

  async function sendMessage(){
    if(state.sending||!state.sb) return;
    const input=document.getElementById('messageInput');
    const message=String(input?.value||'').trim();
    if(!message) return;
    const receiver=isStaff?state.currentId:state.contactId;
    if(isStaff&&!receiver){
      window.toast?.('Select an evacuee first.');
      return;
    }

    state.sending=true;
    const btn=document.querySelector('[data-message-send]');
    if(btn) btn.disabled=true;
    input.value='';
    broadcastTyping(false);
    const temp=appendOptimistic(message);

    try{
      const result=await directSend(receiver,message);
      if(result.error) throw result.error;
      updateOptimistic(temp,'Sent');
      setTimeout(async()=>{
        if(isStaff){
          await Promise.all([selectContact(receiver),loadContacts(false)]);
        }else{
          await loadUserThread();
        }
      },240);
    }catch(error){
      updateOptimistic(temp,'Failed',true);
      input.value=message;
      window.toast?.(error?.message||'Message could not be sent.');
    }finally{
      state.sending=false;
      if(btn) btn.disabled=false;
      input.focus();
    }
  }

  function bindChatComposer(){
    const input=document.getElementById('messageInput');
    const btn=document.querySelector('[data-message-send]');
    if(!input||!btn) return;
    input.addEventListener('focus',()=>state.lastComposer='chat');
    input.addEventListener('input',onTypingInput);
    input.addEventListener('blur',()=>{
      clearTimeout(state.typingStopTimer);
      broadcastTyping(false);
    });
    input.addEventListener('keydown',e=>{
      if(e.key==='Enter'&&!e.shiftKey){
        e.preventDefault();
        sendMessage();
      }
    });
    btn.addEventListener('click',sendMessage);
    window.sendMessage=sendMessage;
  }

  function ensureComposeModal(){
    if(document.getElementById('ssComposeModal')) return;
    document.body.insertAdjacentHTML('beforeend',`
      <div class="ss-modal" id="ssComposeModal" hidden>
        <button class="ss-modal-backdrop" type="button" data-compose-close aria-label="Close"></button>
        <section class="ss-compose-dialog" role="dialog" aria-modal="true" aria-labelledby="ssComposeTitle">
          <header><div><small>Direct Message</small><h2 id="ssComposeTitle">Compose Message</h2></div><button type="button" class="ss-modal-x" data-compose-close>×</button></header>
          <label class="ss-compose-label">Evacuee</label>
          <div class="searchbar"><span>⌕</span><input id="ssComposeSearch" placeholder="Search evacuees..."></div>
          <div class="ss-compose-contacts" id="ssComposeContacts"></div>
          <label class="ss-compose-label" for="ssComposeText">Message</label>
          <textarea id="ssComposeText" rows="4" maxlength="2000" placeholder="Type your message..."></textarea>
          <div class="ss-compose-footer">
            <span id="ssComposeStatus" role="status"></span>
            <button type="button" class="btn red" id="ssComposeSend">Send Message</button>
          </div>
        </section>
      </div>`);
    const modal=document.getElementById('ssComposeModal');
    modal.querySelectorAll('[data-compose-close]').forEach(x=>x.addEventListener('click',()=>closeCompose()));
    document.getElementById('ssComposeSearch')?.addEventListener('input',renderComposeContacts);
    document.getElementById('ssComposeSend')?.addEventListener('click',sendCompose);
  }

  let composeSelected=null;
  function renderComposeContacts(){
    const host=document.getElementById('ssComposeContacts');
    if(!host) return;
    const q=String(document.getElementById('ssComposeSearch')?.value||'').trim().toLowerCase();
    const rows=state.contacts.filter(c=>!q||String(c.full_name||'').toLowerCase().includes(q));
    host.innerHTML=rows.length?rows.map(c=>`
      <button type="button" class="${String(c.user_id)===String(composeSelected)?'active':''}" data-compose-contact="${esc(c.user_id)}">
        <span class="avatar">${esc(initials(c.full_name))}</span>
        <span><b>${esc(c.full_name)}</b><small>${esc(c.last_message||'No previous messages')}</small></span>
      </button>`).join(''):'<div class="ss-empty-list">No evacuee found.</div>';
    host.querySelectorAll('[data-compose-contact]').forEach(btn=>btn.addEventListener('click',()=>{
      composeSelected=btn.dataset.composeContact;
      renderComposeContacts();
      document.getElementById('ssComposeText')?.focus();
    }));
  }

  function openCompose(){
    ensureComposeModal();
    composeSelected=state.currentId||null;
    document.getElementById('ssComposeSearch').value='';
    document.getElementById('ssComposeText').value='';
    document.getElementById('ssComposeStatus').textContent='';
    renderComposeContacts();
    const modal=document.getElementById('ssComposeModal');
    modal.hidden=false;
    document.body.classList.add('ss-modal-open');
  }

  function closeCompose(){
    const modal=document.getElementById('ssComposeModal');
    if(modal) modal.hidden=true;
    document.body.classList.remove('ss-modal-open');
  }

  async function sendCompose(){
    const text=String(document.getElementById('ssComposeText')?.value||'').trim();
    const status=document.getElementById('ssComposeStatus');
    const btn=document.getElementById('ssComposeSend');
    if(!composeSelected){status.textContent='Select an evacuee.';return;}
    if(!text){status.textContent='Type a message.';return;}
    btn.disabled=true; status.textContent='Sending…';
    try{
      const result=await state.sb.rpc('staff_send_scansafe_message',{
        p_receiver:composeSelected,p_message:text
      });
      if(result.error) throw result.error;
      status.textContent='Sent.';
      const id=composeSelected;
      await loadContacts(false);
      closeCompose();
      await selectContact(id);
    }catch(error){
      status.textContent=error?.message||'Could not send.';
    }finally{
      btn.disabled=false;
    }
  }

  function bindCompose(){
    if(!isStaff) return;
    ensureComposeModal();
    document.querySelector('.compose')?.addEventListener('click',openCompose);
  }

  function templateText(label){
    return templates[String(label||'').trim()]||'';
  }

  function useTemplate(label){
    const text=templateText(label);
    if(!text) return;
    let target;
    if(state.lastComposer==='chat'){
      target=document.getElementById('messageInput');
    }else{
      target=document.getElementById('announcement');
    }
    if(!target) target=document.getElementById('announcement')||document.getElementById('messageInput');
    target.value=text;
    target.dispatchEvent(new Event('input',{bubbles:true}));
    target.focus();
    window.toast?.('Template inserted. Review before sending.');
  }

  function bindTemplates(){
    if(!isStaff) return;
    document.querySelectorAll('.template').forEach(el=>{
      el.tabIndex=0;
      el.setAttribute('role','button');
      el.setAttribute('title','Insert template into the last active message box');
      el.addEventListener('click',()=>useTemplate(el.textContent));
      el.addEventListener('keydown',e=>{
        if(e.key==='Enter'||e.key===' '){e.preventDefault();useTemplate(el.textContent);}
      });
    });
    document.getElementById('announcement')?.addEventListener('focus',()=>state.lastComposer='announcement');
    const hint=document.querySelector('[data-template-hint]');
    if(hint) hint.textContent='Click a chat or announcement box, then choose a template.';
  }

  async function sendAnnouncement(){
    if(state.announceSending||!state.sb) return;
    const box=document.getElementById('announcement');
    const text=String(box?.value||'').trim();
    if(!text){window.toast?.('Type an announcement first.');return;}
    const select=document.getElementById('announceTo');
    const audience=select?.value||'evacuees';
    const label=select?.selectedOptions?.[0]?.textContent||'recipients';
    const btn=document.querySelector('[data-announcement-send]');
    const feedback=document.querySelector('[data-announcement-status]');
    state.announceSending=true;
    if(btn){btn.disabled=true;btn.textContent='Sending…';}
    if(feedback) feedback.textContent='Sending announcement…';

    let level='info',category='announcement',title='Shelter Announcement';
    const low=text.toLowerCase();
    if(/emergency|warning|evacuat/.test(low)){level='urgent';category='emergency';title='Emergency Announcement';}
    else if(/weather|storm|rain|typhoon/.test(low)){level='warning';title='Weather Advisory';}
    else if(/accommodation|assigned|shelter space/.test(low)){category='accommodation';title='Accommodation Update';}

    try{
      const {error}=await state.sb.rpc('send_scansafe_announcement',{
        p_title:title,p_message:text,p_audience:audience,p_level:level,p_category:category
      });
      if(error) throw error;
      box.value='';
      if(feedback) feedback.textContent='Sent successfully to '+label+'.';
      window.toast?.('Announcement sent to '+label+'.');
    }catch(error){
      if(feedback) feedback.textContent=error?.message||'Announcement could not be sent.';
      window.toast?.(error?.message||'Announcement could not be sent.');
    }finally{
      state.announceSending=false;
      if(btn){btn.disabled=false;btn.textContent='Send Announcement';}
    }
  }

  function bindAnnouncement(){
    if(!isStaff) return;
    window.sendAnnouncement=sendAnnouncement;
    document.querySelector('[data-announcement-send]')?.addEventListener('click',sendAnnouncement);
  }

  function bindSearch(){
    if(!isStaff) return;
    const input=document.querySelector('[data-message-search]');
    input?.addEventListener('input',()=>{
      state.search=input.value||'';
      renderContacts();
    });
  }

  function refreshCurrent(){
    clearTimeout(state.refreshTimer);
    state.refreshTimer=setTimeout(async()=>{
      if(isStaff){
        await loadContacts(false);
        if(state.currentId) await selectContact(state.currentId);
      }else{
        await loadUserThread();
      }
    },120);
  }

  function setupMessageRealtime(){
    if(!state.sb||state.messageChannel) return;
    const me=state.session?.user?.id;
    if(!me) return;
    state.messageChannel=state.sb.channel('scansafe-message-ui-'+me+'-'+Math.random().toString(36).slice(2))
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'messages',filter:'receiver_id=eq.'+me},refreshCurrent)
      .on('postgres_changes',{event:'INSERT',schema:'public',table:'messages',filter:'sender_id=eq.'+me},refreshCurrent)
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'messages',filter:'sender_id=eq.'+me},refreshCurrent)
      .subscribe();
  }

  async function init(){
    if(state.initialized) return;
    if(!await context()) return;
    state.initialized=true;

    bindChatComposer();

    if(isStaff){
      bindSearch();
      bindCompose();
      bindTemplates();
      bindAnnouncement();
      await loadContacts(true);
    }else{
      await loadUserContact();
      await loadUserThread();
    }

    setupMessageRealtime();
  }

  // The existing bridge initializes first. This isolated layer intentionally
  // starts after it and then owns only the messaging controls on these pages.
  document.addEventListener('DOMContentLoaded',()=>{
    setTimeout(()=>init().catch(err=>console.error('ScanSafe Messages:',err)),650);
  });

  window.ScanSafeMessagesDebug={
    inspect:()=>({
      page,
      initialized:state.initialized,
      userId:state.session?.user?.id||null,
      currentContact:isStaff?state.currentId:state.contactId,
      contacts:state.contacts.length,
      typingChannel:!!state.typingChannel,
      realtime:!!state.messageChannel,
      sending:state.sending
    }),
    refresh:async()=>{
      if(isStaff){await loadContacts(false);if(state.currentId) await selectContact(state.currentId);}
      else await loadUserThread();
      return window.ScanSafeMessagesDebug.inspect();
    }
  };
})();
