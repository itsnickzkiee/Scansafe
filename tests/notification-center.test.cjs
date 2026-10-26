'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'assets', 'notification-center.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

// A tiny, text-only DOM fixture. The actual production controller is evaluated
// unchanged; no Supabase account, production data or network connection is used.
class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.children = [];
    this.parentElement = null; this.attributes = {}; this.dataset = {}; this.listeners = new Map(); this._text = ''; this.hidden = false;
    this.classList = { add: value => { this.className = [this.className, value].filter(Boolean).join(' '); }, contains: value => this.className.split(/\s+/).includes(value) };
  }
  get id() { return this.attributes.id || ''; } set id(value) { this.attributes.id = String(value); }
  get className() { return this.attributes.class || ''; } set className(value) { this.attributes.class = String(value); }
  get textContent() { return this._text + this.children.map(item => item.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  removeAttribute(key) { delete this.attributes[key]; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  replaceChildren(...children) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this._text = ''; this.append(...children); }
  contains(node) { for (; node; node = node.parentElement) if (node === this) return true; return false; }
  matches(selector) {
    return selector.split(',').some(part => {
      const tokens = part.trim().split(/\s+/); const token = tokens.pop();
      const match = token.startsWith('.') ? this.classList.contains(token.slice(1)) : token.startsWith('#') ? this.id === token.slice(1) : token.startsWith('[') ? (token.slice(1, -1) === 'data-notification-action' ? !!this.dataset.notificationAction : false) : this.tagName.toLowerCase() === token;
      if (!match) return false;
      let ancestor = this.parentElement;
      while (tokens.length) { const parentToken = tokens.pop(); while (ancestor && !ancestor.matches(parentToken)) ancestor = ancestor.parentElement; if (!ancestor) return false; ancestor = ancestor.parentElement; }
      return true;
    });
  }
  closest(selector) { for (let current = this; current; current = current.parentElement) if (current.matches(selector)) return current; return null; }
  querySelectorAll(selector) { const all = []; const visit = parent => parent.children.forEach(child => { if (child.matches(selector)) all.push(child); visit(child); }); visit(this); return all; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
  removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== listener)); }
  dispatchEvent(event) { for (const listener of this.listeners.get(event.type) || []) listener(event); }
  async fire(type, extra = {}) {
    const event = { type, target: this, key: '', preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra };
    const route = []; for (let current = this; current; current = current.parentElement) route.push(current);
    for (const current of route) { for (const listener of current.listeners.get(type) || []) listener(event); if (event.stopped) break; }
    await settle(); return event;
  }
  focus() { this.ownerDocument.activeElement = this; }
}

function fixture(config = {}) {
  const document = new Element('document', null); document.ownerDocument = document; document.hidden = false; document.activeElement = null;
  document.body = document.appendChild(new Element('body', document));
  document.createElement = tag => new Element(tag, document); document.getElementById = id => document.querySelector('#' + id);
  const header = document.body.appendChild(new Element('header', document)); header.className = config.role === 'admin' ? 'admin-top' : 'user-top';
  const bell = header.appendChild(new Element('div', document)); bell.className = 'notif'; bell.setAttribute('data-unread-count', '3');
  const other = document.body.appendChild(new Element('button', document));
  let identity = { userId: 'nick-id', role: config.role || 'evacuee' };
  let snapshot = { owner_id: 'nick-id', mode: config.role === 'admin' ? 'staff' : 'evacuee', unread_count: 2, total_count: 2, has_more: false,
    items: [{ notification_id: 1, title: 'Assigned room', message: 'Your group is assigned to Hallway A1.', is_read: false, created_at: '2026-10-26T10:00:00Z' },
      { notification_id: 2, title: 'Needs request', message: 'Your supplies are ready.', is_read: false, created_at: '2026-10-26T09:00:00Z' }] };
  const calls = [], intervals = [], channels = [], removedChannels = []; let responder;
  const client = {
    rpc: async (name, args) => {
      calls.push({ name, args: args ? clone(args) : undefined });
      if (responder) { const response = await responder(name, args); if (response !== undefined) return response; }
      if (name === 'get_scansafe_notification_center') return { data: clone(snapshot), error: null };
      if (name === 'mark_scansafe_center_notification_read') { const item = snapshot.items.find(value => value.notification_id === args.p_notification_id); if (item && !item.is_read) { item.is_read = true; snapshot.unread_count--; } return { data: null, error: null }; }
      throw new Error('Unexpected RPC ' + name);
    },
    channel: () => { const channel = { listeners: [], on(type, filter, callback) { this.listeners.push({ type, filter, callback }); return this; }, subscribe() { return this; } }; channels.push(channel); return channel; },
    removeChannel: channel => { removedChannels.push(channel); }
  };
  const window = { addEventListener() {}, removeEventListener() {}, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } } };
  vm.runInNewContext(source, { window, document, console, Date, Promise, CustomEvent: window.CustomEvent,
    setInterval: callback => { intervals.push(callback); return intervals.length; }, clearInterval() {} });
  const api = window.ScanSafeNotifications;
  return { api, document, bell, other, calls, intervals, channels, removedChannels,
    init: () => api.init({ getClient: () => client, getContext: () => identity }),
    identity: value => { identity = value; }, snapshot: value => { snapshot = value; },
    respond: value => { responder = value; }, getSnapshot: () => snapshot,
    click: id => document.getElementById(id).fire('click'), panel: () => document.getElementById('scansafeNotificationCenter') };
}

test('authenticated bells show exact unread counts beyond the 50-row list, with no automatic read', async () => {
  const f = fixture(); const snapshot = f.getSnapshot(); snapshot.unread_count = 128; snapshot.total_count = 170; snapshot.has_more = true;
  await f.init();
  assert.equal(f.bell.getAttribute('data-unread-count'), '128');
  assert.equal(f.bell.getAttribute('aria-label'), 'Notifications, 128 unread');
  assert.equal(f.calls.filter(call => call.name.startsWith('mark_')).length, 0);
  await f.bell.fire('click');
  assert.equal(f.panel().hidden, false); assert.match(f.panel().textContent, /128 unread/);
  assert.equal(f.calls.filter(call => call.name.startsWith('mark_')).length, 0);
});

test('click opens complete real message and marks only that selected item after the server confirms', async () => {
  const f = fixture(); await f.init(); await f.bell.fire('click');
  const reply = deferred(); f.respond(name => name.startsWith('mark_') ? reply.promise : undefined);
  await f.click('scansafeNotificationItem-1');
  assert.match(f.panel().textContent, /Your group is assigned to Hallway A1\./);
  assert.equal(f.bell.getAttribute('data-unread-count'), '2');
  assert.deepEqual(f.calls.find(call => call.name.startsWith('mark_')).args, { p_notification_id: 1 });
  f.getSnapshot().items[0].is_read = true; f.getSnapshot().unread_count = 1;
  reply.resolve({ data: null, error: null }); await settle();
  assert.equal(f.bell.getAttribute('data-unread-count'), '1'); assert.match(f.panel().textContent, /Read/);
});

test('failed mark RPC keeps the badge unread and offers a retry', async () => {
  const f = fixture(); await f.init(); f.api.open();
  f.respond(name => name.startsWith('mark_') ? { data: null, error: { message: 'offline' } } : undefined);
  await f.click('scansafeNotificationItem-1');
  assert.equal(f.bell.getAttribute('data-unread-count'), '2');
  assert.ok(f.document.getElementById('scansafeNotificationRetryRead'));
  f.respond(null); await f.click('scansafeNotificationRetryRead');
  assert.equal(f.bell.getAttribute('data-unread-count'), '1');
});

test('read acknowledgement wins over an older in-flight unread snapshot', async () => {
  const f = fixture(); await f.init(); f.api.open(); await settle();
  const stale = deferred(); let loads = 0;
  const old = clone(f.getSnapshot());
  f.respond(name => name === 'get_scansafe_notification_center' && ++loads === 1 ? stale.promise : undefined);
  const refresh = f.api.refresh(); await f.click('scansafeNotificationItem-1');
  stale.resolve({ data: old, error: null }); await refresh; await settle();
  assert.equal(f.bell.getAttribute('data-unread-count'), '1');
});

test('opened notification stays readable when the unread-first list rotates after a read', async () => {
  const f = fixture(); await f.init(); f.api.open(); await settle();
  f.respond(name => {
    if (name !== 'mark_scansafe_center_notification_read') return undefined;
    f.getSnapshot().items = f.getSnapshot().items.filter(item => item.notification_id !== 1);
    f.getSnapshot().unread_count = 1; return { data: null, error: null };
  });
  await f.click('scansafeNotificationItem-1'); await settle();
  assert.match(f.panel().textContent, /Your group is assigned to Hallway A1\./);
  assert.equal(f.api.inspect().selectedId, '1');
  assert.match(f.panel().textContent, /Read/);
});

test('Enter and Space open the bell; Escape restores focus and outside click closes it', async () => {
  const f = fixture(); await f.init();
  assert.equal(f.bell.getAttribute('role'), 'button'); assert.equal(f.bell.getAttribute('tabindex'), '0');
  await f.bell.fire('keydown', { key: 'Enter' }); assert.equal(f.panel().hidden, false);
  await f.document.fire('keydown', { key: 'Escape' }); assert.equal(f.panel().hidden, true); assert.equal(f.document.activeElement, f.bell);
  await f.bell.fire('keydown', { key: ' ' }); assert.equal(f.panel().hidden, false);
  await f.other.fire('click'); assert.equal(f.panel().hidden, true);
});

test('zero unread hides the badge; private text is rendered as text only', async () => {
  const f = fixture(); const snapshot = f.getSnapshot(); snapshot.unread_count = 0; snapshot.items.forEach(item => { item.is_read = true; });
  snapshot.items[0].title = '<img src=x onerror=alert(1)>'; snapshot.items[0].message = '<script>bad()</script>';
  await f.init(); f.api.open();
  assert.equal(f.bell.getAttribute('data-unread-count'), null);
  assert.match(f.panel().textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(f.panel().querySelectorAll('script').length, 0); assert.equal(f.panel().querySelectorAll('img').length, 0);
});

test('signout removes private content and stale in-flight response cannot restore it', async () => {
  const f = fixture(); await f.init(); f.api.open(); await settle(); const pending = deferred();
  f.respond(() => pending.promise); const refresh = f.api.refresh();
  f.identity(null); f.api.reset();
  pending.resolve({ data: clone(f.getSnapshot()), error: null }); await refresh;
  assert.equal(f.api.inspect().ownerId, null); assert.equal(f.api.inspect().unread, 0);
  assert.equal(f.panel().hidden, true); assert.equal(f.panel().textContent, '');
  assert.equal(f.bell.getAttribute('data-unread-count'), null); assert.equal(f.removedChannels.length, 1);
});

test('account change rejects old owner data and wrong-owner server snapshots', async () => {
  const f = fixture(); await f.init();
  f.identity({ userId: 'different-id', role: 'evacuee' }); await f.api.refresh();
  assert.equal(f.api.inspect().ownerId, 'different-id'); assert.equal(f.api.inspect().loaded, false);
  assert.equal(f.bell.getAttribute('data-unread-count'), null);
  f.api.open(); assert.match(f.panel().textContent, /Could not refresh/);
});

test('admin bell supports its own detail view and no misleading evacuee-only link', async () => {
  const f = fixture({ role: 'admin' }); await f.init(); f.api.open();
  assert.equal(f.panel().querySelectorAll('a').length, 0);
  await f.click('scansafeNotificationItem-2'); assert.match(f.panel().textContent, /Your supplies are ready/);
  assert.equal(f.bell.getAttribute('data-unread-count'), '1');
});

test('missing migration reports a retryable update message and never uses a mock count', async () => {
  const f = fixture(); f.respond(() => ({ error: { code: 'PGRST202' } })); await f.init(); f.api.open();
  assert.equal(f.bell.getAttribute('data-unread-count'), null);
  assert.match(f.panel().textContent, /Notifications need a system update/);
});

test('reinitialization keeps one click handler and realtime refresh uses actual server data', async () => {
  const f = fixture(); await f.init(); await f.init();
  assert.equal(f.bell.listeners.get('click').length, 1);
  await f.bell.fire('click'); assert.equal(f.panel().hidden, false);
  await settle(); f.getSnapshot().unread_count = 0; f.getSnapshot().items.forEach(item => { item.is_read = true; });
  f.channels.at(-1).listeners[0].callback(); await settle();
  assert.equal(f.bell.getAttribute('data-unread-count'), null);
});

let PGlite;
try { ({ PGlite } = require(process.env.SCANSAFE_PGLITE_MODULE || '@electric-sql/pglite')); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

if (!PGlite) test('notification SQL checks require optional PGlite', { skip: true }, () => {});
else {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'SUPABASE_NOTIFICATION_CENTER.sql'), 'utf8');
  const owner = '11111111-1111-1111-1111-111111111111', admin = '22222222-2222-2222-2222-222222222222', other = '33333333-3333-3333-3333-333333333333';
  const schema = `create role anon;create role authenticated;create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth,public to anon,authenticated;
    create table public.profiles(id uuid primary key,role text);
    insert into public.profiles values('${owner}','evacuee'),('${other}','evacuee'),('${admin}','admin');
    create table public.evacuees(evacuee_id bigint generated always as identity primary key,full_name text,registration_code text,approval_status text);
    create table public.notifications(notification_id bigint generated always as identity primary key,created_by uuid,title text,message text,notification_level text,category text,audience text,recipient_id uuid,status text,created_at timestamptz default now());
    create table public.notification_reads(notification_id bigint references public.notifications,user_id uuid,read_at timestamptz default now(),primary key(notification_id,user_id));
    insert into public.notifications(title,message,notification_level,category,audience,recipient_id,status) values
      ('Everyone','All','info','announcement','all',null,'active'),
      ('Evacuees','Evacuee broadcast','info','announcement','evacuees',null,'active'),
      ('Staff','Staff broadcast','info','system','staff',null,'active'),
      ('Private owner','Owner private','info','system','specific','${owner}','active'),
      ('Private other','Other private','info','system','specific','${other}','active'),
      ('Withdrawn','Inactive','info','system','all',null,'inactive');`;
  async function identity(db, id, role = 'authenticated') { await db.exec(`reset role;set request.jwt.claim.sub='${id || ''}';set role ${role};`); }
  async function fixtureDb(t) { const db = new PGlite(); t.after(() => db.close()); await db.exec(schema); await db.exec(migration); await identity(db, owner); return db; }
  async function center(db) { return (await db.query('select public.get_scansafe_notification_center() as value')).rows[0].value; }

  test('SQL bell visibility is audience-owned for evacuees and staff, even when staff have broad table access', async t => {
    const db = await fixtureDb(t); const evacuee = await center(db);
    assert.equal(evacuee.owner_id, owner); assert.equal(evacuee.unread_count, 3);
    assert.deepEqual(evacuee.items.map(item => item.title).sort(), ['Evacuees', 'Everyone', 'Private owner']);
    await identity(db, admin); const staff = await center(db);
    assert.equal(staff.unread_count, 2); assert.equal(staff.mode, 'staff');
    assert.deepEqual(staff.items.map(item => item.title).sort(), ['Everyone', 'Staff']);
    await assert.rejects(db.query('select public.mark_scansafe_center_notification_read(4)'), /no longer available/);
    await identity(db, owner); await assert.rejects(db.query('select public.mark_scansafe_center_notification_read(5)'), /no longer available/);
    await assert.rejects(db.query('select public.mark_scansafe_center_notification_read(6)'), /no longer available/);
  });
  test('SQL counts include all rows beyond 50, marking is idempotent and reads belong only to the caller', async t => {
    const db = await fixtureDb(t); await db.exec('reset role;');
    await db.exec("insert into public.notifications(title,message,audience,status) select 'Update '||x,'Real update','all','active' from generate_series(1,70) x;");
    await identity(db, owner); const before = await center(db);
    assert.equal(before.items.length, 50); assert.equal(before.total_count, 73); assert.equal(before.unread_count, 73); assert.equal(before.has_more, true);
    await db.query('select public.mark_scansafe_center_notification_read(1)'); await db.query('select public.mark_scansafe_center_notification_read(1)');
    assert.equal((await center(db)).unread_count, 72);
    await identity(db, other); assert.equal((await center(db)).unread_count, 73);
    await db.exec('reset role;'); assert.equal((await db.query('select count(*)::integer as value from public.notification_reads')).rows[0].value, 1);
  });
  test('SQL migration is repeatable and anonymous or unrecognized accounts cannot call it', async t => {
    const db = await fixtureDb(t); await db.exec('reset role;'); await db.exec(migration);
    await identity(db, null, 'anon'); await assert.rejects(center(db), /permission denied/);
    await identity(db, null); await assert.rejects(center(db), /Sign in/);
    await identity(db, '44444444-4444-4444-4444-444444444444'); await assert.rejects(center(db), /ScanSafe account/);
    await assert.rejects(db.query('select public.mark_scansafe_center_notification_read(1)'), /ScanSafe account/);
  });
  test('new pending registrations notify staff once with real details and no old-row backfill', async t => {
    const db = await fixtureDb(t); await db.exec('reset role;');
    await db.exec("insert into public.evacuees(full_name,registration_code,approval_status) values('Actual Registrant','REQ-ACTUAL','pending'),('Approved person','REQ-OLD','approved');");
    await db.exec(migration);
    await db.exec("update public.evacuees set full_name='Updated Registrant' where registration_code='REQ-ACTUAL';");
    const alerts = (await db.query("select * from public.notifications where title='New Evacuee Registration'")).rows;
    assert.equal(alerts.length, 1); assert.equal(alerts[0].audience, 'staff'); assert.equal(alerts[0].category, 'system');
    assert.equal(alerts[0].recipient_id, null); assert.match(alerts[0].message, /Actual Registrant.*REQ-ACTUAL/);
    await identity(db, owner); assert.equal((await center(db)).items.some(item => item.title === 'New Evacuee Registration'), false);
    await identity(db, admin); assert.equal((await center(db)).items.some(item => item.title === 'New Evacuee Registration'), true);
  });
}
