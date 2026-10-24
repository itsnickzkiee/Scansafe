'use strict';

// Optional SQL runtime: point SCANSAFE_PGLITE_MODULE at an externally installed
// @electric-sql/pglite package. No production package/dependency is added.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let PGlite;
try { ({ PGlite } = require(process.env.SCANSAFE_PGLITE_MODULE || '@electric-sql/pglite')); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

if (!PGlite) {
  test('Scanner SQL checks require the optional PGlite runtime', { skip: true }, () => {});
} else {
  const root = path.join(__dirname, '..');
  const migration = fs.readFileSync(path.join(root, 'SUPABASE_SCANNER_GBEAA_FIX.sql'), 'utf8');
  const legacySource = fs.readFileSync(path.join(root, 'SUPABASE_PHASE4_TO_6.sql'), 'utf8');
  const verifySql = legacySource.slice(legacySource.indexOf('create or replace function public.verify_qr_code('),
    legacySource.indexOf('create or replace function public.get_recent_scan_history('));
  const staff = '11111111-1111-1111-1111-111111111111';
  const evacuee = '22222222-2222-2222-2222-222222222222';
  const schema = `
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $uid$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $uid$;
    grant usage on schema public,auth to authenticated,anon;
    create table public.profiles(id uuid primary key,role text);
    insert into public.profiles values ('${staff}','admin'),('${evacuee}','evacuee');
    create function public.is_staff() returns boolean language sql stable security definer as $staff$
      select exists(select 1 from public.profiles where id=auth.uid() and role in ('staff','admin'));
    $staff$;
    create table public.evacuee_groups(group_id bigint primary key,group_size integer not null);
    create table public.evacuees(
      evacuee_id bigint primary key,group_id bigint references public.evacuee_groups,
      full_name text,age integer,gender text,group_size integer,needs_summary text,address text,
      phone text,approval_status text,current_status text,accessibility_required boolean default false
    );
    create table public.barcodes(
      barcode_id bigint generated always as identity primary key,
      evacuee_id bigint references public.evacuees,barcode_value text unique,status text
    );
    create table public.shelters(shelter_id bigint primary key,shelter_name text);
    create table public.accommodation_spaces(
      space_id bigint primary key,shelter_id bigint references public.shelters,
      space_code text,space_name text,space_type text,capacity integer,
      current_occupancy integer,accessible boolean,is_primary boolean,status text,
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
    create table public.audit_events(event_type text,details jsonb);
    create function public.log_scansafe_audit(text,text,text,jsonb) returns void
      language sql security definer as $audit$
      insert into public.audit_events values ($1,$4);
    $audit$;
    insert into public.shelters values (1,'Actual shelter');
    insert into public.evacuee_groups values(1,3),(2,4),(3,2),(4,1),(5,1),(6,1),(7,1);
    insert into public.evacuees(
      evacuee_id,group_id,full_name,age,gender,group_size,needs_summary,address,phone,
      approval_status,current_status,accessibility_required
    ) values
      (1,1,'Nick',25,'Male',3,'None','Actual address','09123456789','approved','registered',false),
      (2,2,'Next group',30,'Female',4,'None','Address',null,'approved','registered',false),
      (3,3,'Accessible group',45,'Female',2,'Wheelchair','Address',null,'approved','registered',false),
      (4,4,'Pending',25,'Male',1,'None','Address',null,'pending','registered',false),
      (5,5,'Revoked',25,'Male',1,'None','Address',null,'approved','registered',false),
      (6,6,'Released',25,'Male',1,'None','Address',null,'approved','released',false),
      (7,7,'Checked in',25,'Male',1,'None','Address',null,'approved','checked_in',false);
    insert into public.barcodes(evacuee_id,barcode_value,status) values
      (1,'EVAC-NICK','active'),(2,'EVAC-NEXT','active'),(3,'EVAC-ACCESS','active'),
      (4,'EVAC-PENDING','active'),(5,'EVAC-REVOKED','revoked'),
      (6,'EVAC-RELEASED','active'),(7,'EVAC-CHECKED','active');
  `;
  async function fixture(t, install = true) {
    const db = new PGlite();
    t.after(() => db.close());
    await db.exec(schema + verifySql);
    if (install) await db.exec(migration);
    await db.exec(`set request.jwt.claim.sub='${staff}';`);
    return db;
  }
  async function scalar(db, sql) { return Object.values((await db.query(sql)).rows[0])[0]; }
  async function scan(db, value) {
    return (await db.query('select public.scan_and_assign_evacuee($1) as data', [value])).rows[0].data;
  }
  async function spaces(db, rows = `
    (1,1,'A1','Hallway A1','hallway',6,0,false,true,'available'),
    (2,1,'A2','Hallway A2','hallway',4,0,false,true,'available'),
    (3,1,'ML','Main Lobby','other',10,0,true,true,'available'),
    (4,1,'102','Approved overflow','overflow_room',3,0,false,false,'available')
  `) { await db.exec('insert into public.accommodation_spaces values ' + rows); }

  test('scanner migration runs without old GBEAA seed patch and is safe to rerun', async t => {
    const db = await fixture(t);
    assert.equal(await scalar(db, 'select count(*)::integer from public.accommodation_spaces'), 0);
    await spaces(db);
    await scan(db, 'EVAC-NICK');
    await db.exec(migration);
    assert.equal(await scalar(db, 'select count(*)::integer from public.accommodation_spaces'), 4);
    assert.equal(await scalar(db, 'select count(*)::integer from public.accommodation_assignments'), 1);
  });

  test('missing dependencies fail before installing any scanner functions', async t => {
    const db = await fixture(t, false);
    await db.exec('drop function public.verify_qr_code(text)');
    await assert.rejects(db.exec(migration), /Phase 4-6 scanner setup/);
    await db.exec('rollback;');
    assert.equal(await scalar(db, "select to_regprocedure('public.scan_and_assign_evacuee(text)')::text"), null);
    assert.equal(await scalar(db, "select to_regprocedure('public.assign_group_gbeaa(bigint)')::text"), null);
    assert.equal(await scalar(db, 'select count(*)::integer from public.accommodation_spaces'), 0);
  });

  test('staff scan verifies actual record then primary best-fit assigns without checking in', async t => {
    const db = await fixture(t);
    await spaces(db);
    const data = await scan(db, '  EVAC-NICK  ');
    assert.equal(data.valid, true);
    assert.equal(data.full_name, 'Nick');
    assert.equal(data.address, 'Actual address');
    assert.equal(data.contact_number, '09123456789');
    assert.equal(data.assignment_state, 'assigned');
    assert.equal(data.group_id, 1);
    assert.equal(data.assignment.space_code, 'A2');
    assert.equal(data.assignment.shelter_name, 'Actual shelter');
    assert.equal(data.assignment.current_occupancy, 3);
    assert.equal(data.current_status, 'accommodated');
    assert.match(data.assignment_message, /Check-in is still pending/);
    assert.equal(await scalar(db, "select count(*)::integer from public.scan_logs where scan_result='verified'"), 1);
    assert.equal(await scalar(db, "select count(*)::integer from public.audit_events where event_type='gbeaa_assignment'"), 1);
  });

  test('repeat/concurrent API requests keep one assignment and count the group once', async t => {
    const db = await fixture(t);
    await spaces(db);
    const results = await Promise.all([scan(db, 'EVAC-NICK'), scan(db, 'EVAC-NICK'), scan(db, 'EVAC-NICK')]);
    assert.equal(results.filter(r => r.assignment_state === 'assigned').length, 1);
    assert.equal(results.filter(r => r.assignment_state === 'already_assigned').length, 2);
    assert.equal(await scalar(db, 'select count(*)::integer from public.accommodation_assignments'), 1);
    assert.equal(await scalar(db, 'select sum(current_occupancy)::integer from public.accommodation_spaces'), 3);
    assert.equal(await scalar(db, 'select count(*)::integer from public.audit_events'), 1);
  });

  test('capacity is updated between groups, with overflow used only after primary cannot fit', async t => {
    const db = await fixture(t);
    await spaces(db, `(1,1,'A1','Hallway A1','hallway',4,0,false,true,'available'),
      (2,1,'102','Approved overflow','overflow_room',4,0,false,false,'available')`);
    assert.equal((await scan(db, 'EVAC-NICK')).space_code, 'A1');
    assert.equal((await scan(db, 'EVAC-NEXT')).space_code, '102');
    assert.equal(await scalar(db, 'select sum(current_occupancy)::integer from public.accommodation_spaces'), 7);
    assert.equal(await scalar(db, 'select count(*)::integer from public.accommodation_spaces where current_occupancy>capacity'), 0);
  });

  test('accessibility needs exclude spaces that otherwise fit better', async t => {
    const db = await fixture(t);
    await spaces(db);
    const data = await scan(db, 'EVAC-ACCESS');
    assert.equal(data.assignment_state, 'assigned');
    assert.equal(data.space_code, 'ML');
    await db.exec("update public.accommodation_spaces set accessible=false where space_code='ML'");
    await db.exec("update public.evacuees set accessibility_required=true where evacuee_id=1");
    const unavailable = await scan(db, 'EVAC-NICK');
    assert.equal(unavailable.valid, true);
    assert.equal(unavailable.assignment_state, 'unavailable');
    assert.match(unavailable.assignment_message, /accessible space/);
  });

  test('no capacity preserves verified result and scan log with no assignment or check-in', async t => {
    const db = await fixture(t);
    const data = await scan(db, 'EVAC-NICK');
    assert.equal(data.valid, true);
    assert.equal(data.assignment_state, 'unavailable');
    assert.equal(data.assignment, null);
    assert.equal(data.current_status, 'verified');
    assert.equal(await scalar(db, 'select count(*)::integer from public.accommodation_assignments'), 0);
    assert.equal(await scalar(db, 'select count(*)::integer from public.scan_logs'), 1);
  });

  test('unknown, revoked, pending, and released registrations never allocate', async t => {
    const db = await fixture(t);
    await spaces(db);
    for (const code of ['NOT-FOUND', '', 'EVAC-REVOKED', 'EVAC-PENDING']) {
      const data = await scan(db, code);
      assert.equal(data.valid, false);
      assert.equal(data.assignment_state, 'not_eligible');
    }
    const released = await scan(db, 'EVAC-RELEASED');
    assert.equal(released.valid, true);
    assert.equal(released.assignment_state, 'not_eligible');
    assert.equal(released.current_status, 'released');
    assert.equal(await scalar(db, 'select count(*)::integer from public.accommodation_assignments'), 0);
  });

  test('existing real checked-in status is preserved', async t => {
    const db = await fixture(t);
    await spaces(db);
    assert.equal((await scan(db, 'EVAC-CHECKED')).current_status, 'checked_in');
  });

  test('incomplete statuses cannot exploit the older verifier NULL comparison rules', async t => {
    const db = await fixture(t);
    await spaces(db);
    await db.exec('update public.evacuees set approval_status=null where evacuee_id=1');
    await assert.rejects(scan(db, 'EVAC-NICK'), /status is incomplete/);
    assert.equal(await scalar(db, 'select count(*)::integer from public.accommodation_assignments'), 0);
    assert.equal(await scalar(db, 'select count(*)::integer from public.scan_logs'), 0);
    assert.equal(await scalar(db, 'select current_status from public.evacuees where evacuee_id=1'), 'registered');
  });

  test('evacuees and anonymous callers cannot scan or allocate', async t => {
    const db = await fixture(t);
    assert.equal(await scalar(db, "select has_function_privilege('anon','public.scan_and_assign_evacuee(text)','execute')"), false);
    await db.exec(`set role authenticated; set request.jwt.claim.sub='${evacuee}';`);
    await assert.rejects(scan(db, 'EVAC-NICK'), { code: '42501' });
    await assert.rejects(db.query('select public.assign_group_gbeaa(1)'), { code: '42501' });
    await db.exec("set request.jwt.claim.sub='';");
    await assert.rejects(scan(db, 'EVAC-NICK'), { code: '42501' });
  });

  test('unexpected assignment errors roll back scan, assignment, occupancy and status together', async t => {
    const db = await fixture(t);
    await spaces(db);
    await db.exec(`create or replace function public.log_scansafe_audit(text,text,text,jsonb)
      returns void language plpgsql as $broken$ begin
        raise exception using errcode='P0002',message='Audit storage failed';
      end; $broken$;`);
    await assert.rejects(scan(db, 'EVAC-NICK'), /Audit storage failed/);
    assert.equal(await scalar(db, 'select count(*)::integer from public.accommodation_assignments'), 0);
    assert.equal(await scalar(db, 'select count(*)::integer from public.scan_logs'), 0);
    assert.equal(await scalar(db, 'select sum(current_occupancy)::integer from public.accommodation_spaces'), 0);
    assert.equal(await scalar(db, 'select current_status from public.evacuees where evacuee_id=1'), 'registered');
  });
}
