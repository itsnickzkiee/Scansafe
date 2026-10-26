'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let PGlite;
try { ({ PGlite } = require(process.env.SCANSAFE_PGLITE_MODULE || '@electric-sql/pglite')); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

if (!PGlite) {
  test('Map migration checks require the optional PGlite runtime', { skip: true }, () => {});
} else {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'SUPABASE_EVACUEE_MAP_ACCESS.sql'), 'utf8');
  const owner = '11111111-1111-1111-1111-111111111111';
  const staff = '22222222-2222-2222-2222-222222222222';
  const admin = '33333333-3333-3333-3333-333333333333';
  const unexpected = '44444444-4444-4444-4444-444444444444';
  const schema = `
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $uid$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
    $uid$;
    grant usage on schema auth,public to anon,authenticated;
    create table public.profiles(id uuid primary key,role text);
    insert into public.profiles values ('${owner}','evacuee'),('${staff}','staff'),
      ('${admin}','admin'),('${unexpected}','unknown');
    create table public.accommodation_spaces(space_id bigint primary key,space_code text,
      space_name text,space_type text,capacity integer,current_occupancy integer,
      accessible boolean,is_primary boolean,status text,shelter_id bigint,staff_notes text);
    insert into public.accommodation_spaces values
      (1,'A1','Actual Hallway','hallway',10,4,true,true,'available',5,'PRIVATE STAFF NOTES'),
      (2,'102','Overflow','overflow_room',30,30,false,false,'full',5,'PRIVATE STAFF NOTES'),
      (3,'A2','Closed','hallway',10,0,true,true,'inactive',5,'PRIVATE STAFF NOTES');
    alter table public.accommodation_spaces enable row level security;
    revoke all on public.accommodation_spaces from public,anon,authenticated;
  `;
  async function fixture(t) {
    const db = new PGlite();
    t.after(() => db.close());
    await db.exec(schema);
    await db.exec(migration);
    return db;
  }
  async function as(db, id, role = 'authenticated') {
    await db.exec(`reset role;set request.jwt.claim.sub='${id || ''}';set role ${role};`);
  }
  async function rows(db) {
    return (await db.query('select public.get_scansafe_map_availability() as spaces')).rows[0].spaces;
  }

  test('evacuees can read real shared availability without staff table access or personal data', async t => {
    const db = await fixture(t);
    await as(db, owner);
    await assert.rejects(db.query('select * from public.accommodation_spaces'), /permission denied/);
    const spaces = await rows(db);
    assert.equal(spaces.length, 2);
    assert.equal(spaces[0].current_occupancy, 4);
    assert.equal(spaces[1].capacity, 30);
    assert.deepEqual(Object.keys(spaces[0]).sort(), ['space_id','space_code','space_name','space_type','capacity','current_occupancy','accessible','is_primary','status','shelter_id'].sort());
    assert.doesNotMatch(JSON.stringify(spaces), /PRIVATE|staff_notes|auth_user_id|full_name|group_id|barcode/);
  });

  test('only authenticated ScanSafe roles may call the room-count RPC', async t => {
    const db = await fixture(t);
    for (const id of [staff, admin]) {
      await as(db, id);
      assert.equal((await rows(db)).length, 2);
    }
    for (const id of [unexpected, null, '55555555-5555-5555-5555-555555555555']) {
      await as(db, id);
      await assert.rejects(rows(db), /signed-in ScanSafe/);
    }
    await as(db, owner, 'anon');
    await assert.rejects(rows(db), /permission denied/);
  });

  test('a successful empty map is an empty array and installation is repeatable and read-only', async t => {
    const db = await fixture(t);
    await db.exec(migration);
    assert.equal((await db.query('select sum(current_occupancy) as count from public.accommodation_spaces')).rows[0].count, 34);
    await db.exec("update public.accommodation_spaces set status='inactive'");
    await as(db, owner);
    assert.deepEqual(await rows(db), []);
  });
}
