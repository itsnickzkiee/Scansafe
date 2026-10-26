'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let PGlite;
try { ({ PGlite } = require(process.env.SCANSAFE_PGLITE_MODULE || '@electric-sql/pglite')); }
catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
if (!PGlite) test('Account media SQL checks need the optional PGlite runtime', { skip: true }, () => {});
else {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'SUPABASE_ACCOUNT_MEDIA.sql'), 'utf8');
  const admin = '11111111-1111-1111-1111-111111111111', owner = '22222222-2222-2222-2222-222222222222', other = '33333333-3333-3333-3333-333333333333';
  const object = (uid = owner, kind = 'profile', n = 1, ext = 'jpg') => `${uid}/${kind}/aaaaaaaa-aaaa-aaaa-aaaa-${String(n).padStart(12, '0')}.${ext}`;
  const schema = `
    create role anon;create role authenticated;create schema auth;create schema storage;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth,public,storage to anon,authenticated;
    create table public.profiles(id uuid primary key,full_name text,role text);
    insert into public.profiles values('${admin}','Admin','admin'),('${owner}','Actual owner','evacuee'),('${other}','Other owner','evacuee');
    create function public.is_staff() returns boolean language sql stable security definer as $$select exists(select 1 from public.profiles where id=auth.uid() and role in ('admin','staff'))$$;
    create table public.evacuee_groups(group_id bigint primary key,group_size integer);
    create table public.evacuees(evacuee_id bigint primary key,auth_user_id uuid,group_id bigint,full_name text,approval_status text,valid_id_number text);
    insert into public.evacuee_groups values(1,2),(2,1);
    insert into public.evacuees values(1,'${owner}',1,'Actual owner','pending','OWNER-PRIVATE-ID'),(2,'${other}',2,'Other owner','approved','OTHER-PRIVATE-ID');
    create table public.evacuee_needs(evacuee_id bigint,description text);
    insert into public.evacuee_needs values(1,'Actual registered need');
    create table public.audit_events(event_type text,target_type text,target_id text,details jsonb);
    create function public.log_scansafe_audit(text,text,text,jsonb) returns void language sql as $$insert into public.audit_events values($1,$2,$3,$4)$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id bigint generated always as identity primary key,bucket_id text,name text,metadata jsonb,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant select,insert,delete on storage.objects to authenticated;
    grant usage,select on sequence storage.objects_id_seq to authenticated;
  `;
  async function as(db, uid, role = 'authenticated') { await db.exec(`reset role;set request.jwt.claim.sub='${uid || ''}';set role ${role};`); }
  async function fixture(t) { const db = new PGlite(); t.after(() => db.close()); await db.exec(schema); await db.exec(migration); await as(db, owner); return db; }
  async function value(db, sql, params) { return Object.values((await db.query(sql, params)).rows[0])[0]; }
  const save = (db, kind = 'profile', p = object()) => value(db, 'select public.save_scansafe_account_media($1,$2)', [kind, p]);
  const mine = db => value(db, 'select public.get_my_scansafe_media()');
  async function seed(db, p = object(), mime = 'image/jpeg', size = 200) {
    await db.exec('reset role;');
    await db.query('insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3)', ['scansafe-account-media', p, JSON.stringify({ mimetype: mime, size })]);
    await as(db, owner);
  }
  test('migration is repeatable, private and adds no sample media or people', async t => {
    const db = await fixture(t); await db.exec('reset role;'); await db.exec(migration);
    assert.equal(await value(db, 'select count(*)::integer from public.scansafe_account_media'), 0);
    assert.equal(await value(db, 'select count(*)::integer from public.evacuees'), 2);
    const b = (await db.query('select * from storage.buckets')).rows[0];
    assert.equal(b.public, false); assert.equal(b.file_size_limit, 2097152);
    assert.deepEqual(b.allowed_mime_types, ['image/jpeg', 'image/png', 'image/webp']);
  });
  test('pending owner can finalize a real uploaded file, preserving approval and audit', async t => {
    const db = await fixture(t); await seed(db);
    const saved = await save(db);
    assert.equal(saved.owner_id, owner); assert.equal(saved.profile_photo.path, object());
    assert.equal(saved.valid_id, null);
    await db.exec('reset role;');
    assert.equal(await value(db, 'select approval_status from public.evacuees where evacuee_id=1'), 'pending');
    assert.equal(await value(db, 'select count(*)::integer from public.audit_events'), 1);
  });
  test('anonymous and other owners cannot read metadata or finalize a foreign object', async t => {
    const db = await fixture(t); await seed(db); await save(db);
    await as(db, other);
    assert.equal((await mine(db)).profile_photo, null);
    await assert.rejects(save(db), /does not belong/);
    await assert.rejects(db.query('select * from public.scansafe_account_media'), /permission denied/);
    await assert.rejects(value(db, 'select public.get_scansafe_registration_details(1)'), /Staff access/);
    await as(db, null, 'anon');
    await assert.rejects(mine(db), /permission denied/);
    await assert.rejects(save(db), /permission denied/);
  });
  test('finalize checks object presence, exact kind, MIME, extension, and file size server-side', async t => {
    const db = await fixture(t);
    await assert.rejects(save(db), /not finished uploading/);
    await assert.rejects(save(db, 'valid-id', object()), /does not belong/);
    await assert.rejects(save(db, null), /does not belong/);
    await seed(db, object(owner, 'profile', 2), 'application/pdf');
    await assert.rejects(save(db, 'profile', object(owner, 'profile', 2)), /JPG, PNG or WebP/);
    await seed(db, object(owner, 'profile', 3), 'image/jpeg', 2097153);
    await assert.rejects(save(db, 'profile', object(owner, 'profile', 3)), /JPG, PNG or WebP/);
    await seed(db, object(owner, 'profile', 4, 'png'), 'image/jpeg', 200);
    await assert.rejects(save(db, 'profile', object(owner, 'profile', 4, 'png')), /JPG, PNG or WebP/);
  });
  test('staff can read finalized ID via Storage and full registration; orphan uploads remain private', async t => {
    const db = await fixture(t); const p = object(owner, 'valid-id');
    await seed(db, p); await save(db, 'valid-id', p); await seed(db, object(owner, 'profile', 5));
    await as(db, admin);
    const review = await value(db, 'select public.get_scansafe_registration_details(1)');
    assert.equal(review.evacuee.valid_id_number, 'OWNER-PRIVATE-ID');
    assert.equal(review.group.group_size, 2); assert.equal(review.needs[0].description, 'Actual registered need');
    assert.equal(review.valid_id.path, p);
    assert.deepEqual((await db.query('select name from storage.objects')).rows.map(r => r.name), [p]);
    await assert.rejects(db.query('insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3)', ['scansafe-account-media', object(admin), '{}']), /row-level security/);
  });
  test('replacement exposes only current image and allows owner cleanup of unlinked objects', async t => {
    const db = await fixture(t); await seed(db); await save(db);
    await seed(db, object(owner, 'profile', 2)); const result = await save(db, 'profile', object(owner, 'profile', 2));
    assert.equal(result.previous_path, object()); assert.equal(result.profile_photo.path, object(owner, 'profile', 2));
    assert.equal((await db.query('delete from storage.objects where name=$1 returning name', [object(owner, 'profile', 2)])).rows.length, 0);
    assert.equal((await db.query('delete from storage.objects where name=$1 returning name', [object()])).rows.length, 1);
    await as(db, other); assert.equal((await db.query('select name from storage.objects')).rows.length, 0);
  });
  test('a missing registration cannot upload or forge media metadata', async t => {
    const db = await fixture(t); await db.exec(`reset role;delete from public.evacuees where auth_user_id='${other}';`); await as(db, other);
    assert.equal(await value(db, 'select public.scansafe_can_access_account_media($1,$2)', [object(other), 'insert']), false);
    await assert.rejects(save(db, 'profile', object(other)), /Complete your registration/);
  });
  test('private bucket guards resist broad legacy Storage policies', async t => {
    const db = await fixture(t); await seed(db); await save(db);
    await db.exec('reset role;grant select,insert,update,delete on storage.objects to anon,authenticated;create policy legacy_all on storage.objects for all to anon,authenticated using(true) with check(true);');
    await as(db, other);
    assert.equal((await db.query('select name from storage.objects')).rows.length, 0);
    await assert.rejects(db.query('insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3)', ['scansafe-account-media', object(owner, 'profile', 9), '{}']), /row-level security/);
    await as(db, owner);
    assert.equal((await db.query('update storage.objects set metadata=$1 returning name', ['{}'])).rows.length, 0);
    await as(db, null, 'anon');
    assert.equal((await db.query('select name from storage.objects')).rows.length, 0);
  });
}
