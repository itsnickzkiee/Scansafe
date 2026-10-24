'use strict';

// Optional PostgreSQL runtime, installed outside the app. Run with
// SCANSAFE_PGLITE_MODULE pointing to @electric-sql/pglite if not locally present.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let PGlite;
try { ({ PGlite } = require(process.env.SCANSAFE_PGLITE_MODULE || '@electric-sql/pglite')); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

if (!PGlite) {
  test('Needs migration checks require the optional PGlite runtime', { skip: true }, () => {});
} else {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'SUPABASE_NEEDS_REQUESTS.sql'), 'utf8');
  const admin = '11111111-1111-1111-1111-111111111111';
  const owner = '22222222-2222-2222-2222-222222222222';
  const other = '33333333-3333-3333-3333-333333333333';
  const member = '44444444-4444-4444-4444-444444444444';
  const staff = '55555555-5555-5555-5555-555555555555';
  const token = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const token2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const items = [{ category: 'water', item_name: 'Drinking water', quantity: 3, unit: 'bottles' }];
  const schema = `
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $uid$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
    $uid$;
    grant usage on schema auth,public to anon,authenticated;
    create table public.profiles(id uuid primary key,full_name text,role text);
    insert into public.profiles values ('${admin}','Actual Admin','admin'),
      ('${owner}','Nick','evacuee'),('${other}','Other owner','evacuee'),
      ('${member}','Same-group member','evacuee'),('${staff}','Actual Staff','staff');
    create function public.is_staff() returns boolean language sql stable security definer as $staff$
      select exists(select 1 from public.profiles where id=auth.uid() and role in ('admin','staff'));
    $staff$;
    create function public.get_my_scansafe_account() returns jsonb language sql as $$select '{}'::jsonb$$;
    create table public.evacuee_groups(group_id bigint primary key,group_size integer);
    create table public.evacuees(evacuee_id bigint primary key,auth_user_id uuid,group_id bigint references public.evacuee_groups,
      full_name text,group_size integer,approval_status text,current_status text);
    create table public.shelters(shelter_id bigint primary key,shelter_name text);
    create table public.accommodation_spaces(space_id bigint primary key,shelter_id bigint references public.shelters,
      space_code text,space_name text,status text);
    create table public.accommodation_assignments(assignment_id bigint generated always as identity primary key,
      group_id bigint references public.evacuee_groups,space_id bigint references public.accommodation_spaces,
      assignment_status text,assigned_at timestamptz default now());
    create table public.notifications(notification_id bigint generated always as identity primary key,
      created_by uuid references public.profiles,recipient_id uuid references public.profiles,
      title text not null,message text not null,notification_level text not null check(notification_level in ('info','warning','urgent')),
      status text not null,audience text not null check(audience in ('all','evacuees','staff','specific')),
      category text not null check(category in ('announcement','emergency','accommodation','system')),created_at timestamptz default now());
    create table public.audit_events(event_type text,target_type text,target_id text,details jsonb);
    create function public.log_scansafe_audit(text,text,text,jsonb) returns void language sql security definer as $audit$
      insert into public.audit_events values($1,$2,$3,$4);
    $audit$;
    insert into public.evacuee_groups values(1,3),(2,2);
    insert into public.evacuees values(1,'${owner}',1,'Nick',3,'approved','accommodated'),
      (2,'${other}',2,'Other owner',2,'approved','registered'),
      (3,'${member}',1,'Same-group member',3,'approved','accommodated');
    insert into public.shelters values(1,'Actual Shelter');
    insert into public.accommodation_spaces values(1,1,'A1','Hallway A1','available'),(2,1,'A2','Hallway A2','available');
    insert into public.accommodation_assignments(group_id,space_id,assignment_status) values(1,1,'active');
  `;
  async function as(db, id, role = 'authenticated') {
    await db.exec(`reset role;set request.jwt.claim.sub='${id || ''}';set role ${role};`);
  }
  async function fixture(t, install = true) {
    const db = new PGlite();
    t.after(() => db.close());
    await db.exec(schema);
    if (install) await db.exec(migration);
    await as(db, owner);
    return db;
  }
  async function value(db, sql, params) { return Object.values((await db.query(sql, params)).rows[0])[0]; }
  async function submit(db, requestItems = items, id = token, notes = 'Please deliver', priority = 'normal') {
    return value(db, 'select public.submit_scansafe_need_request($1::jsonb,$2,$3,$4::uuid)', [JSON.stringify(requestItems), notes, priority, id]);
  }
  async function update(db, id, status, response, version) {
    return value(db, 'select public.update_scansafe_need_request($1,$2,$3,$4)', [id, status, response, version]);
  }
  async function state(db) { return value(db, 'select public.get_scansafe_need_requests()'); }
  async function counts(db) { return value(db, 'select public.get_scansafe_need_request_counts()'); }
  async function setup(db, sql) { await db.exec('reset role;'); await db.exec(sql); await as(db, owner); }

  test('migration is repeatable, inserts no requests or spaces, and requires Phase 7 before changes', async t => {
    const db = await fixture(t, false);
    await db.exec('reset role;alter table public.notifications drop column audience;');
    await assert.rejects(db.exec(migration), /SUPABASE_PHASE7_8.sql/);
    await db.exec('rollback;');
    assert.equal(await value(db, "select to_regclass('public.need_requests')::text"), null);
    await db.exec("alter table public.notifications add column audience text not null default 'all';");
    await db.exec(migration);
    await db.exec(migration);
    assert.equal(await value(db, 'select count(*)::integer from public.need_requests'), 0);
    assert.equal(await value(db, 'select count(*)::integer from public.accommodation_spaces'), 2);
  });

  test('only an approved, nonreleased owner with a real active map assignment can submit', async t => {
    const db = await fixture(t);
    assert.equal((await counts(db)).eligible, true);
    assert.equal((await counts(db)).owner_id, owner);
    await as(db, other);
    assert.equal((await counts(db)).eligible, false);
    await assert.rejects(submit(db), /Waiting for accommodation assignment/);
    await setup(db, "update public.evacuees set current_status='released' where evacuee_id=1;");
    assert.equal((await counts(db)).eligible, false);
    await assert.rejects(submit(db), /shelter stay has ended/);
    await setup(db, "update public.evacuees set current_status='accommodated',approval_status='pending' where evacuee_id=1;");
    assert.equal((await counts(db)).eligible, false);
    await assert.rejects(submit(db), /must be approved/);
    await setup(db, "update public.evacuees set approval_status='approved' where evacuee_id=1;update public.accommodation_spaces set status='inactive' where space_id=1;");
    assert.equal((await counts(db)).eligible, false);
    await assert.rejects(submit(db), /active accommodation space/);
    await setup(db, "update public.accommodation_spaces set status='available';update public.evacuee_groups set group_size=null where group_id=1;");
    assert.equal((await counts(db)).eligible, false);
    await assert.rejects(submit(db), /group details must be reviewed/);
    await setup(db, 'update public.evacuee_groups set group_size=3 where group_id=1;');
    await setup(db, "update public.accommodation_spaces set status='available';update public.accommodation_assignments set assignment_status='released';");
    assert.equal((await counts(db)).eligible, false);
    await assert.rejects(submit(db), /Waiting for accommodation assignment/);
  });

  test('submission snapshots actual ownership/location, includes multiitems and notifies staff once', async t => {
    const db = await fixture(t);
    const request = await submit(db, [...items, { category: 'hygiene', item_name: 'Soap', quantity: 2, unit: 'bars' }], token, ' Actual notes ', 'urgent');
    assert.equal(request.owner_id, owner);
    assert.equal(request.evacuee_id, 1);
    assert.equal(request.group_id, 1);
    assert.equal(request.full_name, 'Nick');
    assert.equal(request.group_size, 3);
    assert.equal(request.space_code, 'A1');
    assert.equal(request.shelter_name, 'Actual Shelter');
    assert.equal(request.current_assignment.space_code, 'A1');
    assert.equal(request.notes, 'Actual notes');
    assert.equal(request.priority, 'urgent');
    assert.equal(request.status, 'pending');
    assert.equal(request.items.length, 2);
    assert.equal(request.items[0].quantity, 3);
    assert.equal(request.events[0].actor_id, owner);
    assert.equal(request.events[0].to_status, 'pending');
    assert.equal('client_token' in request, false);
    assert.equal('submit_payload' in request, false);
    const snapshot = await state(db);
    assert.equal(snapshot.owner_id, owner);
    assert.equal(snapshot.mode, 'evacuee');
    assert.equal(snapshot.account.assignment_id, request.assignment_id);
    assert.equal(snapshot.stats.pending, 1);
    await db.exec('reset role;');
    const notification = (await db.query('select * from public.notifications')).rows[0];
    assert.equal(notification.audience, 'staff');
    assert.equal(notification.recipient_id, null);
    assert.equal(notification.notification_level, 'urgent');
    assert.match(notification.message, /Nick at Hallway A1/);
    assert.equal(await value(db, "select count(*)::integer from public.audit_events where event_type='need_request_submitted'"), 1);
  });

  test('idempotent transport retries return one request even after the assignment ends', async t => {
    const db = await fixture(t);
    const requests = await Promise.all([submit(db), submit(db), submit(db)]);
    assert.equal(new Set(requests.map(r => r.request_id)).size, 1);
    await setup(db, "update public.accommodation_assignments set assignment_status='released';");
    assert.equal((await counts(db)).eligible, false);
    assert.equal((await submit(db)).request_id, requests[0].request_id);
    await assert.rejects(submit(db, items, token, 'Changed payload'), /retry token belongs/);
    await db.exec('reset role;');
    for (const table of ['need_requests', 'need_request_items', 'need_request_events', 'notifications', 'audit_events']) {
      assert.equal(await value(db, `select count(*)::integer from public.${table}`), 1, table);
    }
  });

  test('duplicate active items are rejected across the entire group and race retries', async t => {
    const db = await fixture(t);
    await submit(db);
    await assert.rejects(submit(db, [{ ...items[0], item_name: '  drinking    WATER  ' }], token2), { code: 'P5502' });
    await as(db, member);
    assert.equal((await state(db)).requests.length, 0);
    await assert.rejects(submit(db), { code: 'P5502' });
    assert.equal((await counts(db)).active, 0);
    await as(db, admin);
    const request = (await state(db)).requests[0];
    await update(db, request.request_id, 'unavailable', 'Supply is unavailable today', 1);
    await as(db, member);
    const replacement = await submit(db);
    assert.equal(replacement.owner_id, member);
    assert.equal(replacement.group_id, 1);
    await as(db, owner);
    assert.equal((await state(db)).requests.length, 1);
    assert.equal((await counts(db)).active, 0);
  });

  test('input validation blocks empty/invalid/duplicate items without records or notifications', async t => {
    const db = await fixture(t);
    for (const bad of [[], null, {}, [{ ...items[0], category: 'unknown' }], [{ ...items[0], item_name: '' }],
      [{ ...items[0], quantity: 0 }], [{ ...items[0], quantity: -2 }], [{ ...items[0], quantity: 10001 }],
      [{ ...items[0], quantity: 0.001 }], [{ ...items[0], quantity: '3' }], [{ ...items[0], unit: '' }],
      [items[0], { ...items[0], item_name: 'DRINKING WATER' }], Array(21).fill(items[0])]) {
      await assert.rejects(submit(db, bad));
    }
    await assert.rejects(submit(db, items, null), /retry token is required/);
    await assert.rejects(submit(db, items, token, 'x'.repeat(1001)), /1000 characters/);
    await assert.rejects(submit(db, items, token, '', 'bad'), /normal or urgent/);
    await db.exec('reset role;');
    assert.equal(await value(db, 'select count(*)::integer from public.need_requests'), 0);
    assert.equal(await value(db, 'select count(*)::integer from public.notifications'), 0);
  });

  test('staff transitions record responses/events/notices and provided actor/time with CAS conflicts', async t => {
    const db = await fixture(t);
    let request = await submit(db);
    await as(db, staff);
    assert.equal((await counts(db)).mode, 'staff');
    assert.equal((await counts(db)).eligible, false);
    assert.equal((await counts(db)).pending, 1);
    await assert.rejects(update(db, request.request_id, 'provided', '', 1), /transition/);
    await assert.rejects(update(db, request.request_id, 'unavailable', '', 1), /Explain why/);
    request = await update(db, request.request_id, 'preparing', 'Preparing your items', 1);
    assert.equal(request.version, 2);
    assert.equal(request.provided_at, null);
    await assert.rejects(update(db, request.request_id, 'for_delivery', 'Stale editor', 1), { code: '40001' });
    request = await update(db, request.request_id, 'for_delivery', 'On the way to Hallway A1', 2);
    request = await update(db, request.request_id, 'provided', 'Delivered to your group', 3);
    assert.equal(request.version, 4);
    assert.equal(request.provided_by, staff);
    assert.ok(request.provided_at);
    assert.equal(request.events.length, 4);
    assert.equal(request.events[3].actor_name, 'Actual Staff');
    await assert.rejects(update(db, request.request_id, 'pending', '', 4), /transition/);
    request = await update(db, request.request_id, 'provided', 'Delivered to your group', 4);
    assert.equal(request.version, 4);
    request = await update(db, request.request_id, 'provided', 'Receipt confirmed', 4);
    assert.equal(request.version, 5);
    assert.equal(request.provided_by, staff);
    await as(db, owner);
    const snapshot = await state(db);
    assert.equal(snapshot.requests[0].response, 'Receipt confirmed');
    assert.equal(snapshot.stats.provided, 1);
    assert.equal(snapshot.stats.active, 0);
    await db.exec('reset role;');
    assert.equal(await value(db, `select count(*)::integer from public.notifications where recipient_id='${owner}' and audience='specific'`), 4);
  });

  test('pickup and unavailable branches enforce terminal states and preserve earlier event responses', async t => {
    const db = await fixture(t);
    let request = await submit(db);
    await as(db, admin);
    request = await update(db, request.request_id, 'preparing', 'Working', 1);
    request = await update(db, request.request_id, 'ready_for_pickup', 'Collect at the front desk', 2);
    request = await update(db, request.request_id, 'unavailable', 'Stock was exhausted before collection', 3);
    assert.equal(request.response, 'Stock was exhausted before collection');
    assert.equal(request.events[2].response, 'Collect at the front desk');
    assert.equal(request.provided_by, null);
    await assert.rejects(update(db, request.request_id, 'provided', 'No', 4), /transition/);
    await as(db, owner);
    assert.ok((await submit(db, items, token2)).request_id > request.request_id);
  });

  test('RLS and RPC ownership prevent other evacuees, anonymous callers and direct mutations', async t => {
    const db = await fixture(t);
    const request = await submit(db);
    await assert.rejects(update(db, request.request_id, 'preparing', '', 1), { code: '42501' });
    await assert.rejects(db.exec("insert into public.need_requests(owner_id) values(null)"), { code: '42501' });
    await assert.rejects(db.exec("update public.need_requests set status='provided'"), { code: '42501' });
    await assert.rejects(db.query('select public.scansafe_need_request_json($1)', [request.request_id]), { code: '42501' });
    await as(db, other);
    assert.equal((await state(db)).requests.length, 0);
    assert.equal(await value(db, 'select count(*)::integer from public.need_requests'), 0);
    assert.equal(await value(db, 'select count(*)::integer from public.need_request_items'), 0);
    assert.equal(await value(db, 'select count(*)::integer from public.need_request_events'), 0);
    await assert.rejects(update(db, request.request_id, 'preparing', '', 1), { code: '42501' });
    await as(db, admin);
    assert.equal((await state(db)).requests.length, 1);
    await assert.rejects(submit(db), { code: '42501' });
    await as(db, null);
    await assert.rejects(state(db), { code: '42501' });
    await assert.rejects(counts(db), { code: '42501' });
    await as(db, null, 'anon');
    await assert.rejects(state(db), { code: '42501' });
    await assert.rejects(submit(db), { code: '42501' });
  });

  test('transfer preserves requested location while exposing the actual current assignment', async t => {
    const db = await fixture(t);
    const request = await submit(db);
    await setup(db, "update public.accommodation_assignments set assignment_status='released' where assignment_id=1;insert into public.accommodation_assignments(group_id,space_id,assignment_status) values(1,2,'active');");
    const data = await state(db);
    assert.equal(data.eligible, true);
    assert.equal(data.account.space_code, 'A2');
    assert.equal(data.requests[0].space_code, 'A1');
    assert.equal(data.requests[0].assignment_id, request.assignment_id);
    assert.equal(data.requests[0].current_assignment.space_code, 'A2');
    assert.notEqual(data.requests[0].current_assignment.assignment_id, request.assignment_id);
  });

  test('notification/audit failure rolls back request items, events and update status atomically', async t => {
    const db = await fixture(t);
    await setup(db, `create or replace function public.log_scansafe_audit(text,text,text,jsonb) returns void language plpgsql as $$begin raise exception 'Audit storage failed';end$$;`);
    await assert.rejects(submit(db), /Audit storage failed/);
    await db.exec('reset role;');
    for (const table of ['need_requests', 'need_request_items', 'need_request_events', 'notifications']) {
      assert.equal(await value(db, `select count(*)::integer from public.${table}`), 0, table);
    }
    await db.exec(`create or replace function public.log_scansafe_audit(text,text,text,jsonb) returns void language sql as $$insert into public.audit_events values($1,$2,$3,$4)$$;`);
    await as(db, owner);
    const request = await submit(db);
    await setup(db, `create or replace function public.log_scansafe_audit(text,text,text,jsonb) returns void language plpgsql as $$begin raise exception 'Audit storage failed';end$$;`);
    await as(db, admin);
    await assert.rejects(update(db, request.request_id, 'preparing', 'Preparing', 1), /Audit storage failed/);
    const unchanged = (await state(db)).requests[0];
    assert.equal(unchanged.status, 'pending');
    assert.equal(unchanged.version, 1);
    assert.equal(unchanged.events.length, 1);
  });
}
