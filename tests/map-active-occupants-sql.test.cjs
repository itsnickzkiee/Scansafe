'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let PGlite;
try { ({ PGlite } = require(process.env.SCANSAFE_PGLITE_MODULE || '@electric-sql/pglite')); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

if (!PGlite) {
  test('Active-map SQL checks require the optional PGlite runtime', { skip: true }, () => {});
} else {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'SUPABASE_ACTIVE_MAP_OCCUPANTS_FIX.sql'), 'utf8');
  const staff = '11111111-1111-1111-1111-111111111111';
  const admin = '22222222-2222-2222-2222-222222222222';
  const evacuee = '33333333-3333-3333-3333-333333333333';
  const unknown = '44444444-4444-4444-4444-444444444444';
  const schema = `
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $uid$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
    $uid$;
    grant usage on schema auth,public to anon,authenticated;
    create table public.profiles(id uuid primary key,role text);
    insert into public.profiles values ('${staff}','staff'),('${admin}','admin'),('${evacuee}','evacuee');
    create function public.is_staff() returns boolean language sql stable security definer
    set search_path=pg_catalog,public as $staff$
      select exists(select 1 from public.profiles where id=auth.uid() and role in ('admin','staff'));
    $staff$;
    create table public.accommodation_spaces(space_id bigint primary key,space_code text,space_name text);
    create table public.evacuee_groups(group_id bigint primary key,group_size integer);
    create table public.evacuees(evacuee_id bigint primary key,group_id bigint,full_name text,current_status text);
    create table public.accommodation_assignments(assignment_id bigint primary key,space_id bigint,
      group_id bigint,occupant_count integer,assignment_status text);
    create table public.scansafe_operation_stays(stay_id bigint primary key,group_id bigint,
      status text,checked_in_at timestamptz,admitted_at timestamptz);
    alter table public.accommodation_assignments enable row level security;
    -- Simulate Phase 9 removing legacy staff ALL access, retaining an owner rule.
    create policy fixture_owner_read on public.accommodation_assignments for select to authenticated
      using(auth.uid()='${evacuee}'::uuid and group_id=99);
    -- An existing anon SELECT grant must not expose rows through the staff policy.
    grant select on public.accommodation_assignments to anon;
    insert into public.accommodation_spaces values(1,'  a1  ',null);
    insert into public.evacuee_groups values(20,1);
    insert into public.evacuees values(30,20,'Nick Reyes','accommodated');
    insert into public.accommodation_assignments values
      (10,1,20,1,'active'),(11,1,21,1,'completed');
  `;
  async function fixture(t) {
    const db = new PGlite();
    t.after(() => db.close());
    await db.exec(schema);
    await db.exec(migration);
    return db;
  }
  async function as(db, id, role = 'authenticated') {
    assert.ok(['authenticated','anon'].includes(role));
    await db.exec(`reset role;set request.jwt.claim.sub='${id || ''}';set role ${role};`);
  }
  async function rows(db) {
    return (await db.query('select * from public.accommodation_assignments order by assignment_id')).rows;
  }
  async function occupants(db) {
    return (await db.query('select public.get_scansafe_active_map_occupants() as occupants')).rows[0].occupants;
  }

  test('staff and admin SELECT exactly the real active A1 assignment after the old ALL policy is removed', async t => {
    const db = await fixture(t);
    for (const id of [staff, admin]) {
      await as(db, id);
      const active = await rows(db);
      assert.equal(active.length, 1);
      assert.equal(active[0].assignment_id, 10);
      assert.equal(active[0].assignment_status, 'active');
      const map = await occupants(db);
      assert.equal(map.length, 1);
      assert.equal(map[0].space_code, 'A1');
      assert.equal(map[0].full_name, 'Nick Reyes');
      assert.equal(map[0].arrival_time, null);
      assert.equal(map[0].map_status, 'assigned');
    }
  });

  test('evacuees, unknown accounts, missing claims and anon cannot obtain staff assignment rows', async t => {
    const db = await fixture(t);
    for (const id of [evacuee, unknown, null]) {
      await as(db, id);
      assert.deepEqual(await rows(db), []);
      await assert.rejects(occupants(db), { code: '42501' });
    }
    await as(db, staff, 'anon');
    assert.deepEqual(await rows(db), [], 'anon must not match the authenticated staff policy even with a staff claim');
    await assert.rejects(occupants(db), { code: '42501' });
  });

  test('an active assignment without linked group/member metadata remains in the RPC with an initials label', async t => {
    const db = await fixture(t);
    await db.exec('delete from public.evacuees;delete from public.evacuee_groups;');
    await as(db, staff);
    const map = await occupants(db);
    assert.equal(map.length, 1);
    assert.equal(map[0].assignment_id, 10);
    assert.equal(map[0].space_code, 'A1');
    assert.equal(map[0].space_name, 'A1');
    assert.equal(map[0].evacuee_id, null);
    assert.equal(map[0].full_name, 'Evacuee');
    assert.equal(map[0].group_size, 1);
    assert.equal(map[0].map_status, 'assigned');
  });

  test('check-in enriches the same active assignment and release removes it from both direct SELECT and RPC', async t => {
    const db = await fixture(t);
    await db.exec("insert into public.scansafe_operation_stays values(50,20,'assigned','2026-10-27T03:00:00Z','2026-10-27T02:00:00Z');");
    await as(db, staff);
    let map = await occupants(db);
    assert.equal(map.length, 1);
    assert.equal(map[0].assignment_id, 10);
    assert.equal(map[0].map_status, 'checked_in');
    assert.equal(new Date(map[0].arrival_time).toISOString(), '2026-10-27T03:00:00.000Z');
    await db.exec("reset role;update public.accommodation_assignments set assignment_status='completed' where assignment_id=10;");
    await as(db, staff);
    assert.deepEqual(await rows(db), []);
    assert.deepEqual(await occupants(db), []);
  });

  test('installation is repeatable, preserves existing owner policies and does not grant assignment writes', async t => {
    const db = await fixture(t);
    const before = (await db.query('select jsonb_agg(to_jsonb(a) order by assignment_id) as rows from public.accommodation_assignments a')).rows[0].rows;
    await db.exec(migration);
    const after = (await db.query('select jsonb_agg(to_jsonb(a) order by assignment_id) as rows from public.accommodation_assignments a')).rows[0].rows;
    assert.deepEqual(after, before, 'installation must not insert sample assignments or change assignment data');
    const policies = (await db.query("select policyname from pg_policies where tablename='accommodation_assignments'")).rows.map(row => row.policyname);
    assert.ok(policies.includes('fixture_owner_read'));
    assert.equal(policies.filter(name => name === 'scansafe_staff_read_active_map_assignments').length, 1);
    for (const privilege of ['INSERT','UPDATE','DELETE','TRUNCATE']) {
      const allowed = (await db.query(`select has_table_privilege('authenticated','public.accommodation_assignments','${privilege}') as allowed`)).rows[0].allowed;
      assert.equal(allowed, false, 'migration must grant SELECT only');
    }
    await db.exec("insert into public.accommodation_assignments values(99,1,99,1,'completed');");
    await as(db, evacuee);
    assert.deepEqual((await rows(db)).map(row => row.assignment_id), [99], 'existing owner access must remain intact');
  });
}
