'use strict';

// Optional PostgreSQL runtime. Keep it outside the app and set
// SCANSAFE_PGLITE_MODULE to its @electric-sql/pglite package directory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let PGlite;
try { ({ PGlite } = require(process.env.SCANSAFE_PGLITE_MODULE || '@electric-sql/pglite')); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

if (!PGlite) {
  test('Operation lifecycle SQL checks require the optional PGlite runtime', { skip: true }, () => {});
} else {
  const root = path.join(__dirname, '..');
  const sql = name => fs.readFileSync(path.join(root, name), 'utf8');
  const migration = sql('SUPABASE_EVACUATION_OPERATIONS.sql');
  const admin = '11111111-1111-1111-1111-111111111111';
  const nick = '22222222-2222-2222-2222-222222222222';
  const other = '33333333-3333-3333-3333-333333333333';
  const member = '44444444-4444-4444-4444-444444444444';
  const staff = '55555555-5555-5555-5555-555555555555';
  const token = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const token2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const token3 = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const items = [{ category: 'water', item_name: 'Drinking water', quantity: 3, unit: 'bottles' }];
  const schema = `
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $uid$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $uid$;
    grant usage on schema public,auth to authenticated,anon;
    create table public.profiles(id uuid primary key,full_name text,role text);
    insert into public.profiles values ('${admin}','Actual Admin','admin'),
      ('${nick}','Nick','evacuee'),('${other}','Other owner','evacuee'),
      ('${member}','Same-group member','evacuee'),('${staff}','Actual Staff','staff');
    create function public.is_staff() returns boolean language sql stable security definer as $staff$
      select exists(select 1 from public.profiles where id=auth.uid() and role in ('admin','staff'));
    $staff$;
    create function public.is_admin() returns boolean language sql stable security definer as $admin$
      select exists(select 1 from public.profiles where id=auth.uid() and role='admin');
    $admin$;
    create table public.evacuee_groups(group_id bigint primary key,group_size integer not null);
    create table public.evacuees(
      evacuee_id bigint primary key,auth_user_id uuid references public.profiles,
      group_id bigint references public.evacuee_groups,full_name text,age integer,gender text,
      group_size integer,needs_summary text,address text,phone text,approval_status text,
      current_status text,accessibility_required boolean default false,
      approved_at timestamptz,approved_by uuid references public.profiles
    );
    create table public.barcodes(
      barcode_id bigint generated always as identity primary key,
      evacuee_id bigint references public.evacuees,barcode_value text not null unique,
      status text not null,issued_at timestamptz default now()
    );
    create table public.shelters(shelter_id bigint primary key,shelter_name text);
    create table public.accommodation_spaces(
      space_id bigint primary key,shelter_id bigint references public.shelters,
      space_code text,space_name text,space_type text,capacity integer,current_occupancy integer,
      accessible boolean,is_primary boolean,status text,
      check(current_occupancy>=0 and current_occupancy<=capacity)
    );
    create table public.accommodation_assignments(
      assignment_id bigint generated always as identity primary key,
      group_id bigint references public.evacuee_groups,space_id bigint references public.accommodation_spaces,
      assigned_by uuid,assignment_status text,override_flag boolean,assigned_at timestamptz default now()
    );
    create table public.evacuee_needs(evacuee_id bigint,need_type text,description text);
    create table public.scan_logs(
      scan_id bigint generated always as identity primary key,barcode_id bigint references public.barcodes,
      scanned_by uuid,scan_result text,scanned_at timestamptz default now()
    );
    create table public.notifications(notification_id bigint generated always as identity primary key,
      created_by uuid references public.profiles,recipient_id uuid references public.profiles,
      title text not null,message text not null,
      notification_level text not null check(notification_level in ('info','warning','urgent')),
      status text not null,audience text not null check(audience in ('all','evacuees','staff','specific')),
      category text not null check(category in ('announcement','emergency','accommodation','system')),
      created_at timestamptz default now());
    insert into public.shelters values(1,'Actual shelter');
    insert into public.evacuee_groups values(1,3),(2,2),(3,1);
    insert into public.evacuees(evacuee_id,auth_user_id,group_id,full_name,age,gender,group_size,
      needs_summary,address,approval_status,current_status) values
      (1,'${nick}',1,'Nick',25,'Male',3,'None','Actual address','approved','accommodated'),
      (2,'${other}',2,'Other owner',25,'Female',2,'None','Actual address','approved','registered'),
      (3,'${member}',1,'Same-group member',22,'Female',3,'None','Actual address','approved','accommodated'),
      (4,null,3,'Pending registration',30,'Male',1,'None','Actual address','pending','registered');
    insert into public.barcodes(evacuee_id,barcode_value,status) values
      (1,'000000000001','active'),(2,'000000000002','active'),(3,'000000000003','active');
    insert into public.accommodation_spaces values
      (1,1,'A1','Hallway A1','hallway',10,3,false,true,'available'),
      (2,1,'A2','Hallway A2','hallway',6,0,true,true,'available');
    insert into public.accommodation_assignments(group_id,space_id,assigned_by,assignment_status,override_flag)
      values(1,1,'${admin}','active',false),(2,2,'${admin}','completed',false);
  `;
  const legacy = sql('SUPABASE_PHASE4_TO_6.sql');
  const verification = legacy.slice(legacy.indexOf('create or replace function public.verify_qr_code('),
    legacy.indexOf('create or replace function public.get_recent_scan_history('));
  const phase4 = sql('SUPABASE_PHASE4_MAP_ASSIGNMENT.sql');
  const manualAssignment = phase4.slice(phase4.indexOf('create or replace function public.assign_group_to_space('),
    phase4.indexOf('-- =========================================================', phase4.indexOf('create or replace function public.assign_group_to_space(')));
  const phase9 = sql('SUPABASE_PHASE9_SECURITY_TESTING.sql');
  const releaseTransfer = phase9.slice(phase9.indexOf('create or replace function public.release_group_assignment('),
    phase9.indexOf('-- ---------------------------------------------------------', phase9.indexOf('create or replace function public.transfer_group_assignment(')));

  async function as(db, id, role = 'authenticated') {
    await db.exec(`reset role;set request.jwt.claim.sub='${id || ''}';set role ${role};`);
  }
  async function value(db, query, params) { return Object.values((await db.query(query, params)).rows[0])[0]; }
  async function fixture(t, { install = true, optionalHelpers = true, empty = false } = {}) {
    const db = new PGlite();
    t.after(() => db.close());
    await db.exec(schema + verification + manualAssignment);
    await db.exec(sql('SUPABASE_EVACUEE_LIVE_SYNC_FIX.sql'));
    await db.exec(sql('SUPABASE_SCANNER_GBEAA_FIX.sql'));
    await db.exec(sql('SUPABASE_SHORT_BARCODE_FIX.sql'));
    await db.exec(sql('SUPABASE_NEEDS_REQUESTS.sql'));
    if (optionalHelpers) await db.exec(releaseTransfer);
    if (empty) await db.exec("update public.accommodation_assignments set assignment_status='completed';update public.accommodation_spaces set current_occupancy=0;");
    if (install) await db.exec(migration);
    await as(db, admin);
    return db;
  }
  async function elevated(db, action) {
    await db.exec('reset role;');
    try { return await action(); } finally { await as(db, admin); }
  }
  async function operations(db) { return value(db, 'select public.get_scansafe_operations()'); }
  async function preview(db, id) { return value(db, 'select public.preview_close_scansafe_operation($1)', [id]); }
  async function start(db, name = 'Typhoon response', retryToken = token) {
    return value(db, 'select public.start_scansafe_operation($1,$2::uuid)', [name, retryToken]);
  }
  async function close(db, snapshot, { confirm = 'CLOSE', reason = 'All families have returned home.', cancel = false } = {}) {
    return value(db, 'select public.close_scansafe_operation($1,$2,$3,$4,$5)',
      [snapshot.operation_id, snapshot.revision, confirm, reason, cancel]);
  }
  async function readmit(db, groupId, reason = 'Returned for a new evacuation.') {
    return value(db, 'select public.readmit_scansafe_group($1,$2)', [groupId, reason]);
  }
  async function submit(db, requestItems = items, retryToken = token2) {
    return value(db, 'select public.submit_scansafe_need_request($1::jsonb,$2,$3,$4::uuid)',
      [JSON.stringify(requestItems), 'Please deliver', 'normal', retryToken]);
  }
  async function updateRequest(db, requestId, status, version) {
    return value(db, 'select public.update_scansafe_need_request($1,$2,$3,$4)',
      [requestId, status, 'Staff response', version]);
  }
  async function scan(db, barcode = '000000000002') {
    return value(db, 'select public.scan_and_assign_evacuee($1)', [barcode]);
  }
  async function reconcile(db) { return value(db, 'select public.reconcile_scansafe_occupancy()'); }
  async function currentPreview(db) { return preview(db, (await operations(db)).current_operation.operation_id); }

  test('migration adopts real active stays once and preserves accounts, barcodes, spaces and history', async t => {
    const db = await fixture(t, { install: false });
    const before = await elevated(db, () => value(db, `select jsonb_build_object(
      'profiles',(select jsonb_agg(to_jsonb(p) order by id) from public.profiles p),
      'barcodes',(select jsonb_agg(to_jsonb(b) order by barcode_id) from public.barcodes b),
      'spaces',(select jsonb_agg(to_jsonb(s) order by space_id) from public.accommodation_spaces s))`));
    await elevated(db, () => db.exec(migration));
    await elevated(db, () => db.exec(migration));
    const data = await operations(db);
    assert.equal(data.owner_id, admin);
    assert.equal(data.mode, 'admin');
    assert.equal(data.current_operation.status, 'active');
    assert.equal(data.history.filter(o => o.status === 'active').length <= 1, true);
    const counts = await elevated(db, () => value(db, `select jsonb_build_object(
      'operations',(select count(*) from public.scansafe_operations),
      'stays',(select count(*) from public.scansafe_operation_stays),
      'assignments',(select count(*) from public.accommodation_assignments),
      'requests',(select count(*) from public.need_requests),
      'profiles',(select jsonb_agg(to_jsonb(p) order by id) from public.profiles p),
      'barcodes',(select jsonb_agg(to_jsonb(b) order by barcode_id) from public.barcodes b),
      'spaces',(select jsonb_agg(to_jsonb(s) order by space_id) from public.accommodation_spaces s))`));
    assert.equal(counts.operations, 1);
    assert.equal(counts.stays, 1);
    assert.equal(counts.assignments, 2);
    assert.equal(counts.requests, 0);
    assert.deepEqual(counts.profiles, before.profiles);
    assert.deepEqual(counts.barcodes, before.barcodes);
    assert.deepEqual(counts.spaces, before.spaces);
    const assignment = await elevated(db, () => value(db, 'select to_jsonb(a) from public.accommodation_assignments a where assignment_id=1'));
    assert.equal(assignment.operation_id, data.current_operation.operation_id);
    assert.equal(assignment.occupant_count, 3);
    const snapshot = await currentPreview(db);
    assert.equal(snapshot.summary.groups, 1);
    assert.equal(snapshot.summary.people, 3);
    assert.equal(snapshot.summary.occupied, 3);
    assert.equal(snapshot.summary.capacity, 16);
  });

  test('an empty installation waits for an explicit operation and optional Phase 9 helpers are not required', async t => {
    const db = await fixture(t, { empty: true, optionalHelpers: false });
    assert.equal((await operations(db)).current_operation, null);
    await assert.rejects(scan(db), /operation/i);
    const operation = await start(db);
    assert.equal(operation.status, 'active');
    assert.ok(operation.operation_id);
    assert.equal((await scan(db)).assignment_state, 'assigned');
  });

  test('operation control is admin-only and private implementations cannot bypass lifecycle guards', async t => {
    const db = await fixture(t);
    const snapshot = await currentPreview(db);
    for (const user of [nick, other, staff, null]) {
      await as(db, user);
      for (const call of [() => operations(db), () => preview(db, snapshot.operation_id),
        () => start(db), () => close(db, snapshot), () => readmit(db, 1), () => reconcile(db)]) {
        await assert.rejects(call(), { code: '42501' });
      }
    }
    await as(db, null, 'anon');
    await assert.rejects(operations(db), { code: '42501' });
    await assert.rejects(start(db), { code: '42501' });
    await as(db, nick);
    await assert.rejects(db.exec("update public.scansafe_operations set status='closed'"), { code: '42501' });
    await assert.rejects(db.exec('delete from public.scansafe_operation_stays'), { code: '42501' });
  });

  test('closing requires the typed confirmation, reason and a current preview', async t => {
    const db = await fixture(t);
    const snapshot = await currentPreview(db);
    await assert.rejects(close(db, snapshot, { confirm: 'close' }), /CLOSE|confirm/i);
    await assert.rejects(close(db, snapshot, { reason: '   ' }), /reason/i);
    await assert.rejects(close(db, { ...snapshot, revision: null }), { code: '40001' });
    assert.equal((await operations(db)).current_operation.status, 'active');
    assert.equal((await currentPreview(db)).summary.people, 3);
  });

  test('a new needs request invalidates the preview and pending requests require explicit cancellation', async t => {
    const db = await fixture(t);
    const snapshot = await currentPreview(db);
    await as(db, nick);
    const request = await submit(db);
    assert.equal(request.operation_id, snapshot.operation_id);
    await as(db, admin);
    await assert.rejects(close(db, snapshot, { cancel: true }), { code: '40001' });
    const fresh = await currentPreview(db);
    assert.notEqual(fresh.revision, snapshot.revision);
    assert.equal(fresh.summary.pending_requests, 1);
    await assert.rejects(close(db, fresh), /pending|cancel/i);
    assert.equal((await currentPreview(db)).summary.people, 3);
  });

  test('closing atomically releases assignments, zeros the map and preserves request/history evidence', async t => {
    const db = await fixture(t);
    await as(db, nick);
    const pending = await submit(db);
    const delivered = await submit(db, [{ category: 'hygiene', item_name: 'Soap', quantity: 1, unit: 'bar' }], token3);
    await as(db, admin);
    let updated = await updateRequest(db, delivered.request_id, 'preparing', 1);
    updated = await updateRequest(db, delivered.request_id, 'for_delivery', updated.version);
    updated = await updateRequest(db, delivered.request_id, 'provided', updated.version);
    const snapshot = await currentPreview(db);
    const result = await close(db, snapshot, { cancel: true });
    assert.equal(result.operation_id, snapshot.operation_id);
    assert.equal(result.status, 'closed');
    assert.equal((await operations(db)).current_operation, null);
    const actual = await elevated(db, () => value(db, `select jsonb_build_object(
      'occupied',(select sum(current_occupancy) from public.accommodation_spaces),
      'active',(select count(*) from public.accommodation_assignments where assignment_status='active'),
      'completed',(select count(*) from public.accommodation_assignments where assignment_status='completed'),
      'released',(select count(*) from public.evacuees where group_id=1 and current_status='released'),
      'barcodes',(select count(*) from public.barcodes where status='active'),
      'capacity',(select sum(capacity) from public.accommodation_spaces),
      'pending',(select to_jsonb(r) from public.need_requests r where request_id=${pending.request_id}),
      'provided',(select to_jsonb(r) from public.need_requests r where request_id=${delivered.request_id}),
      'items',(select count(*) from public.need_request_items),
      'cancelled_events',(select count(*) from public.need_request_events where request_id=${pending.request_id} and to_status='cancelled'))`));
    assert.equal(actual.occupied, 0);
    assert.equal(actual.active, 0);
    assert.equal(actual.completed, 2);
    assert.equal(actual.released, 2);
    assert.equal(actual.barcodes, 3);
    assert.equal(actual.capacity, 16);
    assert.equal(actual.pending.status, 'cancelled');
    assert.equal(actual.pending.provided_at, null);
    assert.equal(actual.pending.provided_by, null);
    assert.ok(actual.pending.response.length > 0);
    assert.equal(actual.provided.status, 'provided');
    assert.equal(actual.provided.provided_by, admin);
    assert.equal(actual.provided.provided_at, updated.provided_at);
    assert.equal(actual.items, 2);
    assert.equal(actual.cancelled_events, 1);
    const retry = await close(db, snapshot, { cancel: true });
    assert.equal(retry.operation_id, result.operation_id);
    assert.equal(retry.status, 'closed');
    const count = await elevated(db, () => value(db, `select count(*) from public.need_request_events where request_id=${pending.request_id} and to_status='cancelled'`));
    assert.equal(Number(count), 1);
    await as(db, nick);
    assert.equal((await value(db, 'select public.get_scansafe_need_requests()')).requests.find(r => r.request_id === pending.request_id).status, 'cancelled');
    assert.equal((await value(db, 'select public.get_scansafe_need_request_counts()')).eligible, false);
    await assert.rejects(submit(db, [{ category: 'food', item_name: 'Rice', quantity: 1, unit: 'meal' }], token), /operation|stay has ended/i);
  });

  test('closed operations block scanner/manual/GBEAA and direct active assignment writes', async t => {
    const db = await fixture(t);
    await close(db, await currentPreview(db));
    await assert.rejects(scan(db), /operation/i);
    await assert.rejects(value(db, 'select public.assign_group_gbeaa(2)'), /operation/i);
    await assert.rejects(value(db, "select public.assign_group_to_space(2,'A2')"), /operation/i);
    await elevated(db, async () => {
      await assert.rejects(db.exec("insert into public.accommodation_assignments(group_id,space_id,assignment_status) values(2,2,'active')"), /operation/i);
    });
    assert.equal((await operations(db)).current_operation, null);
  });

  test('new operation start retries are idempotent and cannot silently create parallel operations', async t => {
    const db = await fixture(t);
    await close(db, await currentPreview(db));
    const started = await start(db, 'Second actual evacuation', token);
    const retry = await start(db, 'Second actual evacuation', token);
    assert.equal(started.operation_id, retry.operation_id);
    assert.equal(started.name, 'Second actual evacuation');
    await assert.rejects(start(db, 'Changed retry payload', token), /token|different|name/i);
    await assert.rejects(start(db, 'Parallel evacuation', token2), /active|operation/i);
    assert.equal((await operations(db)).current_operation.operation_id, started.operation_id);
    const active = await elevated(db, () => value(db, "select count(*) from public.scansafe_operations where status='active'"));
    assert.equal(Number(active), 1);
  });

  test('readmission requires a prior operation and leaves occupancy empty until a real assignment', async t => {
    const db = await fixture(t);
    const first = await currentPreview(db);
    await close(db, first);
    const second = await start(db, 'Next evacuation', token);
    await assert.rejects(readmit(db, 1, '   '), /reason/i);
    const admit = await readmit(db, 1);
    assert.equal(admit.readmitted, true);
    assert.equal(admit.group_id, 1);
    assert.equal(admit.operation_id, second.operation_id);
    const before = await currentPreview(db);
    assert.equal(before.summary.occupied, 0);
    await as(db, nick);
    assert.equal((await value(db, 'select public.get_scansafe_need_request_counts()')).eligible, false);
    await as(db, admin);
    const assigned = await scan(db, '000000000001');
    assert.equal(assigned.assignment_state, 'assigned');
    const active = await elevated(db, () => value(db, "select to_jsonb(a) from public.accommodation_assignments a where group_id=1 and assignment_status='active'"));
    assert.equal(active.operation_id, second.operation_id);
    assert.equal(active.occupant_count, 3);
    await as(db, nick);
    assert.equal((await value(db, 'select public.get_scansafe_need_request_counts()')).eligible, true);
    await as(db, admin);
    const released = await value(db, 'select public.release_group_assignment(1)');
    assert.equal(released.released, true);
    await assert.rejects(readmit(db, 1), /same|current|already|operation/i);
    const rescan = await scan(db, '000000000001');
    assert.notEqual(rescan.assignment_state, 'assigned');
    assert.equal((await currentPreview(db)).summary.occupied, 0);
  });

  test('recalculation uses assignment occupant snapshots instead of edited group size', async t => {
    const db = await fixture(t);
    await elevated(db, () => db.exec('update public.evacuee_groups set group_size=5 where group_id=1;update public.accommodation_spaces set current_occupancy=1 where space_id=1;'));
    const before = await currentPreview(db);
    assert.ok(before.summary.discrepancies > 0 || before.summary.discrepancies.length > 0);
    await reconcile(db);
    const after = await currentPreview(db);
    assert.equal(after.summary.occupied, 3);
    assert.equal(after.summary.people, 3);
    assert.equal(Array.isArray(after.summary.discrepancies) ? after.summary.discrepancies.length : after.summary.discrepancies, 0);
    assert.equal(await elevated(db, () => value(db, 'select group_size from public.evacuee_groups where group_id=1')), 5);
    const assignment = await elevated(db, () => value(db, 'select to_jsonb(a) from public.accommodation_assignments a where assignment_id=1'));
    assert.equal(assignment.occupant_count, 3);
  });

  test('scan, transfer and release wrappers keep operation stays and current occupancy in agreement', async t => {
    const db = await fixture(t);
    const scanResult = await scan(db);
    assert.equal(scanResult.assignment_state, 'assigned');
    assert.equal((await currentPreview(db)).summary.people, 5);
    const assigned = await elevated(db, () => value(db, "select to_jsonb(a) from public.accommodation_assignments a where group_id=2 and assignment_status='active'"));
    assert.equal(assigned.occupant_count, 2);
    const destination = assigned.space_id === 1 ? 'A2' : 'A1';
    assert.equal((await value(db, 'select public.transfer_group_assignment(2,$1)', [destination])).transferred, true);
    assert.equal((await currentPreview(db)).summary.people, 5);
    assert.equal((await value(db, 'select public.release_group_assignment(2)')).released, true);
    assert.equal((await currentPreview(db)).summary.people, 3);
    assert.equal((await currentPreview(db)).summary.occupied, 3);
    const released = await elevated(db, () => value(db, 'select current_status from public.evacuees where group_id=2'));
    assert.equal(released, 'released');
  });

  test('private lifecycle bases and operation tables cannot bypass administrator boundaries', async t => {
    const db = await fixture(t);
    await as(db, staff);
    for (const call of [
      "select public.scansafe_ops_manual_base(2,'A1')",
      'select public.scansafe_ops_gbeaa_base(2)',
      "select public.scansafe_ops_scan_base('000000000002')",
      "select public.scansafe_scan_and_assign_canonical('000000000002')",
      'select public.scansafe_ops_counts_base()',
      'select public.scansafe_operations_recalculate()',
      'select public.scansafe_operations_group(2)',
      'select public.scansafe_operations_members(1)'
    ]) await assert.rejects(db.query(call), { code: '42501' });
    assert.equal(await value(db, 'select count(*) from public.scansafe_operations'), 0);
    assert.equal(await value(db, 'select count(*) from public.scansafe_operation_stays'), 0);
    await as(db, admin);
    assert.equal(await value(db, 'select count(*) from public.scansafe_operations'), 1);
    assert.equal(await value(db, 'select count(*) from public.scansafe_operation_stays'), 1);
  });

  test('archived stays keep the original identity, space and population after later record edits', async t => {
    const db = await fixture(t);
    const snapshot = await currentPreview(db);
    await close(db, snapshot);
    await elevated(db, () => db.exec("update public.accommodation_spaces set space_code='RENAMED',space_name='Renamed hallway' where space_id=1;update public.evacuees set full_name='Updated name' where evacuee_id=1;update public.evacuee_groups set group_size=7 where group_id=1;"));
    const history = (await operations(db)).history[0];
    assert.equal(history.stays[0].full_name, 'Nick');
    assert.equal(history.stays[0].group_size, 3);
    assert.equal(history.stays[0].assignments[0].space_code, 'A1');
    assert.equal(history.stays[0].assignments[0].space_name, 'Hallway A1');
    assert.equal(history.stays[0].assignments[0].assignment_status, 'completed');
    assert.ok(history.stays[0].assignments[0].completed_at);
    assert.equal(history.summary.people, 3);
    await elevated(db, () => db.exec('update public.accommodation_spaces set current_occupancy=2 where space_id=1;'));
    await start(db);
    assert.equal((await operations(db)).summary.occupied, 0);
    assert.equal((await operations(db)).summary.discrepancies, 0);
  });

  test('audit failure rolls back close cancellation, releases, map values and operation status together', async t => {
    const db = await fixture(t);
    await as(db, nick);
    const request = await submit(db);
    await as(db, admin);
    const snapshot = await currentPreview(db);
    await elevated(db, () => db.exec(`create or replace function public.log_scansafe_audit(p_event_type text,p_target_type text,p_target_id text,p_details jsonb default '{}'::jsonb)
      returns void language plpgsql as $$begin raise exception 'Audit storage failed';end$$;`));
    await assert.rejects(close(db, snapshot, { cancel: true }), /Audit storage failed/);
    const after = await currentPreview(db);
    assert.equal(after.revision, snapshot.revision);
    assert.equal(after.summary.people, 3);
    assert.equal(after.summary.occupied, 3);
    assert.equal(after.summary.pending_requests, 1);
    assert.equal((await operations(db)).current_operation.status, 'active');
    const unchanged = await elevated(db, () => value(db, `select to_jsonb(r) from public.need_requests r where request_id=${request.request_id}`));
    assert.equal(unchanged.status, 'pending');
    assert.equal(unchanged.version, 1);
    const cancellationCount = await elevated(db, () => value(db, "select count(*) from public.need_request_events where to_status='cancelled'"));
    assert.equal(Number(cancellationCount), 0);
  });
}
