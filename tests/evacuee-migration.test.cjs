'use strict';

// Optional SQL runtime: npm install @electric-sql/pglite outside the app, then
// set SCANSAFE_PGLITE_MODULE to that installed package's absolute path.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let PGlite;
try { ({ PGlite } = require(process.env.SCANSAFE_PGLITE_MODULE || '@electric-sql/pglite')); }
catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

if (!PGlite) {
  test('PostgreSQL migration checks require the optional PGlite runtime', { skip: true }, () => {});
} else {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'SUPABASE_EVACUEE_LIVE_SYNC_FIX.sql'), 'utf8');
  const admin = '11111111-1111-1111-1111-111111111111';
  const nick = '22222222-2222-2222-2222-222222222222';
  const other = '33333333-3333-3333-3333-333333333333';
  const revoked = '44444444-4444-4444-4444-444444444444';
  const schema = `
    create role anon;
    create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $uid$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $uid$;
    grant usage on schema auth, public to anon, authenticated;
    create table public.profiles(id uuid primary key, full_name text, role text);
    create table public.evacuees(
      evacuee_id bigint primary key, auth_user_id uuid references public.profiles(id),
      group_id bigint, full_name text, approval_status text, registered_at timestamptz default now(),
      approved_at timestamptz, approved_by uuid references public.profiles(id)
    );
    create table public.barcodes(
      barcode_id bigint generated always as identity primary key,
      evacuee_id bigint references public.evacuees(evacuee_id),
      barcode_value text not null unique, status text not null, issued_at timestamptz default now()
    );
    create table public.shelters(shelter_id bigint primary key, shelter_name text);
    create table public.accommodation_spaces(
      space_id bigint primary key, shelter_id bigint references public.shelters(shelter_id),
      space_code text, capacity integer, current_occupancy integer
    );
    create table public.accommodation_assignments(
      assignment_id bigint generated always as identity primary key, group_id bigint,
      space_id bigint references public.accommodation_spaces(space_id),
      assignment_status text, assigned_at timestamptz default now()
    );
    grant select on public.profiles to authenticated;
    create policy fixture_admin_barcodes on public.barcodes for select to authenticated
      using (exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='admin'));
    insert into public.profiles values
      ('${admin}', 'Admin', 'admin'), ('${nick}', 'Nick', 'evacuee'),
      ('${other}', 'Other', 'evacuee'), ('${revoked}', 'Revoked', 'evacuee');
    insert into public.evacuees(evacuee_id, auth_user_id, group_id, full_name, approval_status) values
      (10, '${nick}', 10, 'Nick', 'approved'),
      (20, '${other}', 20, 'Other', 'pending'),
      (30, '${revoked}', 30, 'Revoked', 'approved');
    insert into public.barcodes(evacuee_id, barcode_value, status) values (30, 'REVOKED-ORIGINAL', 'revoked');
  `;
  async function fixture(t) {
    const db = new PGlite();
    t.after(() => db.close());
    await db.exec(schema);
    return db;
  }
  async function scalar(db, sql) { return Object.values((await db.query(sql)).rows[0])[0]; }

  test('migration runs without Phase 9 and backfills only approved records with no barcode', async t => {
    const db = await fixture(t);
    await db.exec(migration);
    assert.ok(await scalar(db, "select to_regprocedure('public.log_scansafe_audit(text,text,text,jsonb)')::text"));
    const rows = (await db.query('select evacuee_id, barcode_value, status from public.barcodes order by evacuee_id')).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].evacuee_id, 10);
    assert.match(rows[0].barcode_value, /^EVAC-[a-f0-9]{32}$/);
    assert.equal(rows[0].status, 'active');
    assert.equal(rows[1].barcode_value, 'REVOKED-ORIGINAL');
    assert.equal(rows[1].status, 'revoked');
  });

  test('rerunning preserves an existing audit helper, records, and barcode values', async t => {
    const db = await fixture(t);
    await db.exec(migration);
    const barcode = await scalar(db, 'select barcode_value from public.barcodes where evacuee_id=10');
    await db.exec(`
      create or replace function public.log_scansafe_audit(
        p_event_type text,p_target_type text,p_target_id text,p_details jsonb default '{}'::jsonb
      )
      returns void language plpgsql security definer set search_path=pg_catalog,public as $custom$
      begin
        insert into public.audit_events(event_type,target_type,target_id,details)
        values ($1,$2,$3,coalesce($4,'{}'::jsonb)||'{"custom":true}'::jsonb);
      end;
      $custom$;
      insert into public.audit_events(event_type) values ('existing_event');
    `);
    const before = await scalar(db, "select pg_get_functiondef('public.log_scansafe_audit(text,text,text,jsonb)'::regprocedure)");
    await db.exec(migration);
    assert.equal(await scalar(db, "select pg_get_functiondef('public.log_scansafe_audit(text,text,text,jsonb)'::regprocedure)"), before);
    assert.equal(await scalar(db, "select count(*)::integer from public.audit_events where event_type='existing_event'"), 1);
    assert.equal(await scalar(db, 'select barcode_value from public.barcodes where evacuee_id=10'), barcode);
    assert.equal(await scalar(db, 'select count(*)::integer from public.barcodes where evacuee_id=10'), 1);
  });

  test('owner reads stay isolated and audit writers stay private', async t => {
    const db = await fixture(t);
    await db.exec(migration);
    assert.equal(await scalar(db, "select has_function_privilege('anon','public.get_my_scansafe_account()','execute')"), false);
    assert.equal(await scalar(db, "select has_function_privilege('authenticated','public.log_scansafe_audit(text,text,text,jsonb)','execute')"), false);
    assert.equal(await scalar(db, "select has_function_privilege('authenticated','public.scansafe_ensure_approved_barcode(bigint)','execute')"), false);
    await db.exec(`set role authenticated; set request.jwt.claim.sub='${nick}';`);
    let snapshot = await scalar(db, 'select public.get_my_scansafe_account()');
    assert.equal(snapshot.evacuee.full_name, 'Nick');
    assert.equal(snapshot.barcode.evacuee_id, 10);
    assert.equal(await scalar(db, 'select count(*)::integer from public.barcodes'), 1);
    assert.equal(await scalar(db, 'select count(*)::integer from public.audit_events'), 0);
    await db.exec(`set request.jwt.claim.sub='${other}';`);
    snapshot = await scalar(db, 'select public.get_my_scansafe_account()');
    assert.equal(snapshot.evacuee.full_name, 'Other');
    assert.equal(snapshot.barcode, null);
    assert.equal(await scalar(db, 'select count(*)::integer from public.barcodes'), 0);
    await db.exec("set request.jwt.claim.sub='';");
    await assert.rejects(db.query('select public.get_my_scansafe_account()'), { code: '42501' });
  });

  test('admin approval creates one real barcode and logs approval while refusing revoked codes', async t => {
    const db = await fixture(t);
    await db.exec(migration);
    await db.exec(`set role authenticated; set request.jwt.claim.sub='${admin}';`);
    const barcode = await scalar(db, 'select public.approve_evacuee_registration(20)');
    assert.match(barcode, /^EVAC-[a-f0-9]{32}$/);
    assert.equal(await scalar(db, 'select public.approve_evacuee_registration(20)'), barcode);
    assert.equal(await scalar(db, 'select count(*)::integer from public.barcodes where evacuee_id=20'), 1);
    assert.equal(await scalar(db, "select count(*)::integer from public.audit_events where event_type='evacuee_approved'"), 2);
    await assert.rejects(db.query('select public.approve_evacuee_registration(30)'), /not active/);
    await db.exec(`set request.jwt.claim.sub='${nick}';`);
    await assert.rejects(db.query('select public.approve_evacuee_registration(20)'), { code: '42501' });
    await db.exec('reset role;');
    assert.equal(await scalar(db, 'select barcode_value from public.barcodes where evacuee_id=30'), 'REVOKED-ORIGINAL');
  });

  test('deferred issuance respects an existing immediate barcode trigger', async t => {
    const db = await fixture(t);
    await db.exec(migration);
    await db.exec(`
      create function public.legacy_issue() returns trigger language plpgsql as $legacy$
      begin
        if new.approval_status='approved' and old.approval_status<>'approved' then
          insert into public.barcodes(evacuee_id,barcode_value,status) values(new.evacuee_id,'LEGACY-20','active');
        end if;
        return new;
      end;
      $legacy$;
      create trigger legacy_issue after update on public.evacuees for each row execute function public.legacy_issue();
      begin;
      update public.evacuees set approval_status='approved' where evacuee_id=20;
      commit;
    `);
    assert.equal(await scalar(db, 'select count(*)::integer from public.barcodes where evacuee_id=20'), 1);
    assert.equal(await scalar(db, 'select barcode_value from public.barcodes where evacuee_id=20'), 'LEGACY-20');
  });

  test('migration recovers the aborted SQL Editor transaction from an earlier attempt', async t => {
    const db = await fixture(t);
    await assert.rejects(db.exec("begin; do $old$ begin raise exception 'missing Phase 9'; end; $old$;"), /missing Phase 9/);
    await db.exec(migration);
    assert.equal(await scalar(db, 'select count(*)::integer from public.barcodes where evacuee_id=10'), 1);
  });
}
