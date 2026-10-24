'use strict';

// Optional SQL runtime: set SCANSAFE_PGLITE_MODULE to an externally installed
// @electric-sql/pglite package. Nothing is added to the production dependencies.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let PGlite;
try { ({ PGlite } = require(process.env.SCANSAFE_PGLITE_MODULE || '@electric-sql/pglite')); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

if (!PGlite) {
  test('Short barcode SQL checks require the optional PGlite runtime', { skip: true }, () => {});
} else {
  const root = path.join(__dirname, '..');
  const sql = name => fs.readFileSync(path.join(root, name), 'utf8');
  const migration = sql('SUPABASE_SHORT_BARCODE_FIX.sql');
  const legacy = sql('SUPABASE_PHASE4_TO_6.sql');
  const verifySql = legacy.slice(legacy.indexOf('create or replace function public.verify_qr_code('),
    legacy.indexOf('create or replace function public.get_recent_scan_history('));
  const staff = '11111111-1111-1111-1111-111111111111';
  const nick = '22222222-2222-2222-2222-222222222222';
  const other = '33333333-3333-3333-3333-333333333333';
  const schema = `
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $uid$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $uid$;
    grant usage on schema public,auth to anon,authenticated;
    create table public.profiles(id uuid primary key,role text);
    insert into public.profiles values ('${staff}','admin'),('${nick}','evacuee'),('${other}','evacuee');
    create function public.is_staff() returns boolean language sql stable security definer as $staff$
      select exists(select 1 from public.profiles where id=auth.uid() and role in ('staff','admin'));
    $staff$;
    create table public.evacuee_groups(group_id bigint primary key,group_size integer not null);
    create table public.evacuees(
      evacuee_id bigint primary key, auth_user_id uuid references public.profiles,
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
    insert into public.shelters values (1,'Actual shelter');
    insert into public.accommodation_spaces values (1,1,'A1','Hallway A1','hallway',20,0,false,true,'available');
    insert into public.evacuee_groups values (1,3),(2,2),(3,1),(4,1),(5,1),(6,1);
    insert into public.evacuees(evacuee_id,auth_user_id,group_id,full_name,age,gender,group_size,
      needs_summary,address,approval_status,current_status) values
      (1,'${nick}',1,'Nick',25,'Male',3,'None','Actual address','approved','registered'),
      (2,'${other}',2,'Other',25,'Female',2,'None','Address','pending','registered'),
      (3,null,3,'Revoked',25,'Male',1,'None','Address','approved','registered'),
      (4,null,4,'Inactive',25,'Male',1,'None','Address','approved','registered'),
      (5,null,5,'Legacy pending',25,'Male',1,'None','Address','pending','registered'),
      (6,null,6,'Numeric existing',25,'Male',1,'None','Address','approved','registered');
    insert into public.barcodes(evacuee_id,barcode_value,status) values
      (1,'EVAC-0123456789abcdef0123456789abcdef','active'),
      (3,'REVOKED-ORIGINAL','revoked'),(4,'INACTIVE-ORIGINAL','inactive'),
      (5,'PENDING-ORIGINAL','active'),(6,'000000000123','active');
  `;
  async function scalar(db, query) { return Object.values((await db.query(query)).rows[0])[0]; }
  async function fixture(t, install = true) {
    const db = new PGlite();
    t.after(() => db.close());
    await db.exec(schema + verifySql);
    await db.exec(sql('SUPABASE_EVACUEE_LIVE_SYNC_FIX.sql'));
    await db.exec(sql('SUPABASE_SCANNER_GBEAA_FIX.sql'));
    if (install) await db.exec(migration);
    await db.exec(`set request.jwt.claim.sub='${staff}';`);
    return db;
  }
  async function scan(db, value) {
    return (await db.query('select public.scan_and_assign_evacuee($1) as data', [value])).rows[0].data;
  }
  const original = 'EVAC-0123456789abcdef0123456789abcdef';

  test('shortening keeps barcode identity, statuses, and original aliases across reruns', async t => {
    const db = await fixture(t, false);
    const before = (await db.query('select barcode_id,evacuee_id,status,issued_at from public.barcodes order by barcode_id')).rows;
    await db.exec(migration);
    const short = await scalar(db, 'select barcode_value from public.barcodes where evacuee_id=1');
    assert.match(short, /^\d{12}$/);
    assert.notEqual(short, original);
    assert.deepEqual((await db.query('select barcode_id,evacuee_id,status,issued_at from public.barcodes order by barcode_id')).rows, before);
    assert.equal(await scalar(db, "select barcode_value from public.barcodes where evacuee_id=3"), 'REVOKED-ORIGINAL');
    assert.equal(await scalar(db, "select barcode_value from public.barcodes where evacuee_id=4"), 'INACTIVE-ORIGINAL');
    assert.equal(await scalar(db, "select barcode_value from public.barcodes where evacuee_id=5"), 'PENDING-ORIGINAL');
    assert.equal(await scalar(db, "select barcode_value from public.barcodes where evacuee_id=6"), '000000000123');
    await db.exec(migration);
    assert.equal(await scalar(db, 'select barcode_value from public.barcodes where evacuee_id=1'), short);
    assert.deepEqual((await db.query('select barcode_value,barcode_id from public.scansafe_barcode_aliases')).rows,
      [{ barcode_value: original, barcode_id: 1 }]);
  });

  test('old printed and new short code verify the same person and one assignment without check-in', async t => {
    const db = await fixture(t);
    const short = await scalar(db, 'select barcode_value from public.barcodes where evacuee_id=1');
    await db.exec('set role authenticated');
    const first = await scan(db, original);
    const second = await scan(db, short);
    assert.equal(first.valid, true);
    assert.equal(first.full_name, 'Nick');
    assert.equal(first.qr_value, short);
    assert.equal(first.scanned_barcode_value, original);
    assert.equal(first.assignment_state, 'assigned');
    assert.equal(first.current_status, 'accommodated');
    assert.equal(second.assignment_state, 'already_assigned');
    assert.equal(second.assignment.assignment_id, first.assignment.assignment_id);
    await db.exec('reset role');
    assert.equal(await scalar(db, 'select count(*)::integer from public.accommodation_assignments'), 1);
    assert.equal(await scalar(db, 'select current_occupancy from public.accommodation_spaces'), 3);
    assert.equal(await scalar(db, 'select count(*)::integer from public.scan_logs'), 2);
  });

  test('owner account RPC returns the actual new short code and keeps owner isolation', async t => {
    const db = await fixture(t);
    const short = await scalar(db, 'select barcode_value from public.barcodes where evacuee_id=1');
    await db.exec(`set role authenticated; set request.jwt.claim.sub='${nick}'`);
    const mine = await scalar(db, 'select public.get_my_scansafe_account()');
    assert.equal(mine.barcode.barcode_value, short);
    assert.equal(mine.barcode.barcode_id, 1);
    await db.exec(`set request.jwt.claim.sub='${other}'`);
    assert.equal((await scalar(db, 'select public.get_my_scansafe_account()')).barcode, null);
  });

  test('private helpers, canonical scanner, and alias table are not available to clients', async t => {
    const db = await fixture(t);
    for (const signature of ['scansafe_random_barcode_candidate()', 'scansafe_new_short_barcode()',
      'scansafe_compact_active_barcode()', 'scansafe_ensure_approved_barcode(bigint)',
      'scansafe_scan_and_assign_canonical(text)']) {
      for (const role of ['anon', 'authenticated']) {
        assert.equal(await scalar(db, `select has_function_privilege('${role}','public.${signature}','execute')`), false);
      }
    }
    assert.equal(await scalar(db, "select has_table_privilege('authenticated','public.scansafe_barcode_aliases','select')"), false);
    await db.exec(`set role authenticated; set request.jwt.claim.sub='${nick}'`);
    await assert.rejects(scan(db, original), { code: '42501' });
    await assert.rejects(db.query('select * from public.scansafe_barcode_aliases'), { code: '42501' });
    await db.exec("set request.jwt.claim.sub='' ");
    await assert.rejects(scan(db, original), { code: '42501' });
  });

  test('aliases never bypass later barcode revocation or loss of approval', async t => {
    const db = await fixture(t);
    const short = await scalar(db, 'select barcode_value from public.barcodes where evacuee_id=1');
    await db.exec("update public.barcodes set status='revoked' where evacuee_id=1");
    for (const value of [original, short, 'REVOKED-ORIGINAL', 'INACTIVE-ORIGINAL', 'PENDING-ORIGINAL']) {
      assert.equal((await scan(db, value)).valid, false);
    }
    assert.equal(await scalar(db, 'select count(*)::integer from public.accommodation_assignments'), 0);
    await db.exec("update public.barcodes set status='active' where evacuee_id=1; update public.evacuees set approval_status='pending' where evacuee_id=1");
    assert.equal((await scan(db, original)).valid, false);
    assert.equal((await scan(db, short)).valid, false);
  });

  test('future approvals and legacy issuance triggers return compact actual stored codes', async t => {
    const db = await fixture(t);
    await db.exec(`
      create function public.legacy_issue() returns trigger language plpgsql as $legacy$
      begin
        if new.evacuee_id=2 and new.approval_status='approved' and old.approval_status<>'approved' then
          insert into public.barcodes(evacuee_id,barcode_value,status) values(new.evacuee_id,'LEGACY-LONG-20','active');
        end if;
        return new;
      end;
      $legacy$;
      create trigger legacy_issue after update on public.evacuees for each row execute function public.legacy_issue();
      set role authenticated;
    `);
    const short = await scalar(db, 'select public.approve_evacuee_registration(2)');
    assert.match(short, /^\d{12}$/);
    assert.equal(await scalar(db, 'select public.approve_evacuee_registration(2)'), short);
    assert.equal((await scan(db, 'LEGACY-LONG-20')).qr_value, short);
    const pendingShort = await scalar(db, 'select public.approve_evacuee_registration(5)');
    assert.match(pendingShort, /^\d{12}$/);
    assert.equal((await scan(db, 'PENDING-ORIGINAL')).qr_value, pendingShort);
    await assert.rejects(db.query('select public.approve_evacuee_registration(3)'), /not active/);
  });

  test('new issuance retries collisions in both canonical and historical alias namespaces', async t => {
    const db = await fixture(t);
    await db.exec(`
      insert into public.scansafe_barcode_aliases(barcode_value,barcode_id) values ('000000000124',1);
      create sequence public.test_candidates;
      create or replace function public.scansafe_random_barcode_candidate() returns text
      language sql volatile set search_path=pg_catalog,public as $candidate$
        select case nextval('public.test_candidates') when 1 then '000000000123'
          when 2 then '000000000124' else '000000000125' end;
      $candidate$;
      set role authenticated;
    `);
    assert.equal(await scalar(db, 'select public.approve_evacuee_registration(2)'), '000000000125');
    await db.exec('reset role');
    assert.equal(await scalar(db, 'select last_value from public.test_candidates'), 3);
    // Re-using somebody else's printed code must never redirect their alias.
    await assert.rejects(db.exec("update public.barcodes set barcode_value='000000000124' where evacuee_id=6"), /already reserved/);
    assert.equal(await scalar(db, "select barcode_id from public.scansafe_barcode_aliases where barcode_value='000000000124'"), 1);
    await db.exec(`create or replace function public.scansafe_random_barcode_candidate() returns text
      language sql volatile set search_path=pg_catalog,public as $candidate$ select '000000000123'::text $candidate$;`);
    await assert.rejects(db.query('select public.approve_evacuee_registration(5)'), /Retry approval/);
    assert.equal(await scalar(db, 'select approval_status from public.evacuees where evacuee_id=5'), 'pending');
    assert.equal(await scalar(db, 'select barcode_value from public.barcodes where evacuee_id=5'), 'PENDING-ORIGINAL');
  });

  test('missing prerequisite fails atomically without shortening or adding aliases', async t => {
    const db = await fixture(t, false);
    await db.exec('drop function public.scan_and_assign_evacuee(text)');
    await assert.rejects(db.exec(migration), /SUPABASE_SCANNER_GBEAA_FIX/);
    await db.exec('rollback');
    assert.equal(await scalar(db, 'select barcode_value from public.barcodes where evacuee_id=1'), original);
    assert.equal(await scalar(db, "select to_regclass('public.scansafe_barcode_aliases')::text"), null);
  });
}
