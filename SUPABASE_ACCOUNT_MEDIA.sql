-- ScanSafe: private evacuee profile photos and registration ID images.
-- Run the ENTIRE file after SUPABASE_EVACUEE_LIVE_SYNC_FIX.sql.
-- No accounts are confirmed, linked, approved, or replaced by this migration.
rollback;
begin;

do $preflight$
begin
  if to_regprocedure('public.is_staff()') is null
     or to_regprocedure('public.log_scansafe_audit(text,text,text,jsonb)') is null then
    raise exception 'Run the existing ScanSafe security setup before account media';
  end if;
  if to_regclass('storage.objects') is null or to_regclass('storage.buckets') is null then
    raise exception 'Supabase Storage must be available before account media';
  end if;
end;
$preflight$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('scansafe-account-media','scansafe-account-media',false,2097152,
  array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=false,file_size_limit=2097152,
  allowed_mime_types=array['image/jpeg','image/png','image/webp'];

create table if not exists public.scansafe_account_media(
  owner_id uuid not null,
  kind text not null check(kind in ('profile','valid-id')),
  evacuee_id bigint not null references public.evacuees(evacuee_id),
  object_path text not null unique,
  content_type text not null check(content_type in ('image/jpeg','image/png','image/webp')),
  byte_size bigint not null check(byte_size between 1 and 2097152),
  uploaded_at timestamptz not null default now(),
  primary key(owner_id,kind)
);
alter table public.scansafe_account_media enable row level security;
revoke all on public.scansafe_account_media from public,anon,authenticated;

-- Called by Storage policies. The exact object must belong to this signed-in
-- account; staff may read only a finalized object linked to a registration.
create or replace function public.scansafe_can_access_account_media(p_path text,p_action text)
returns boolean language plpgsql stable security definer set search_path=pg_catalog,public
as $access$
declare v_uid uuid:=auth.uid(); v_own boolean;
begin
  if v_uid is null then return false; end if;
  v_own:=p_path ~ ('^'||v_uid::text||'/(profile|valid-id)/[0-9a-fA-F-]{36}\.(jpg|png|webp)$')
    and exists(select 1 from public.profiles p where p.id=v_uid and p.role='evacuee')
    and exists(select 1 from public.evacuees e where e.auth_user_id=v_uid);
  if p_action='insert' then return v_own; end if;
  if p_action='delete' then
    return v_own and not exists(select 1 from public.scansafe_account_media m where m.object_path=p_path);
  end if;
  if p_action='select' then
    return v_own or (coalesce(public.is_staff(),false)
      and exists(select 1 from public.scansafe_account_media m where m.object_path=p_path));
  end if;
  return false;
end;
$access$;
revoke all on function public.scansafe_can_access_account_media(text,text) from public,anon,authenticated;
grant execute on function public.scansafe_can_access_account_media(text,text) to authenticated;

drop policy if exists scansafe_account_media_insert on storage.objects;
create policy scansafe_account_media_insert on storage.objects for insert to authenticated
with check(bucket_id='scansafe-account-media' and public.scansafe_can_access_account_media(name,'insert'));
drop policy if exists scansafe_account_media_read on storage.objects;
create policy scansafe_account_media_read on storage.objects for select to authenticated
using(bucket_id='scansafe-account-media' and public.scansafe_can_access_account_media(name,'select'));
drop policy if exists scansafe_account_media_delete on storage.objects;
create policy scansafe_account_media_delete on storage.objects for delete to authenticated
using(bucket_id='scansafe-account-media' and public.scansafe_can_access_account_media(name,'delete'));

-- Bucket-specific restrictive guards also protect these IDs if an older project
-- has a broad permissive policy for other uploads. Other buckets keep their rules.
drop policy if exists scansafe_account_media_insert_guard on storage.objects;
create policy scansafe_account_media_insert_guard on storage.objects as restrictive for insert to authenticated
with check(bucket_id<>'scansafe-account-media' or public.scansafe_can_access_account_media(name,'insert'));
drop policy if exists scansafe_account_media_read_guard on storage.objects;
create policy scansafe_account_media_read_guard on storage.objects as restrictive for select to authenticated
using(bucket_id<>'scansafe-account-media' or public.scansafe_can_access_account_media(name,'select'));
drop policy if exists scansafe_account_media_delete_guard on storage.objects;
create policy scansafe_account_media_delete_guard on storage.objects as restrictive for delete to authenticated
using(bucket_id<>'scansafe-account-media' or public.scansafe_can_access_account_media(name,'delete'));
drop policy if exists scansafe_account_media_update_guard on storage.objects;
create policy scansafe_account_media_update_guard on storage.objects as restrictive for update to authenticated
using(bucket_id<>'scansafe-account-media') with check(bucket_id<>'scansafe-account-media');
drop policy if exists scansafe_account_media_anon_guard on storage.objects;
create policy scansafe_account_media_anon_guard on storage.objects as restrictive for all to anon
using(bucket_id<>'scansafe-account-media') with check(bucket_id<>'scansafe-account-media');

create or replace function public.get_my_scansafe_media()
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public
as $mine$
declare v_uid uuid:=auth.uid(); v_eid bigint;
begin
  if v_uid is null then raise exception using errcode='42501',message='Sign in to view your account images'; end if;
  select e.evacuee_id into v_eid from public.evacuees e
    where e.auth_user_id=v_uid order by e.evacuee_id desc limit 1;
  return jsonb_build_object('owner_id',v_uid,'evacuee_id',v_eid,
    'profile_photo',(select jsonb_build_object('path',m.object_path,'content_type',m.content_type,
      'byte_size',m.byte_size,'uploaded_at',m.uploaded_at) from public.scansafe_account_media m
      where m.owner_id=v_uid and m.evacuee_id=v_eid and m.kind='profile'),
    'valid_id',(select jsonb_build_object('path',m.object_path,'content_type',m.content_type,
      'byte_size',m.byte_size,'uploaded_at',m.uploaded_at) from public.scansafe_account_media m
      where m.owner_id=v_uid and m.evacuee_id=v_eid and m.kind='valid-id'));
end;
$mine$;
revoke all on function public.get_my_scansafe_media() from public,anon,authenticated;
grant execute on function public.get_my_scansafe_media() to authenticated;

create or replace function public.save_scansafe_account_media(p_kind text,p_path text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $save$
declare
  v_uid uuid:=auth.uid(); v_eid bigint; v_meta jsonb; v_type text; v_size bigint; v_previous text;
begin
  if v_uid is null or not exists(select 1 from public.profiles p where p.id=v_uid and p.role='evacuee') then
    raise exception using errcode='42501',message='An authenticated evacuee account is required to upload images';
  end if;
  if p_kind is null or p_kind not in ('profile','valid-id') or p_path is null
    or p_path !~ ('^'||v_uid::text||'/'||p_kind||'/[0-9a-fA-F-]{36}\.(jpg|png|webp)$') then
    raise exception using errcode='42501',message='The image path does not belong to your account';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('scansafe-media:'||v_uid::text||':'||p_kind,0));
  select e.evacuee_id into v_eid from public.evacuees e where e.auth_user_id=v_uid
    order by e.evacuee_id desc limit 1 for update;
  if not found then raise exception 'Complete your registration before uploading account images'; end if;
  select o.metadata into v_meta from storage.objects o
    where o.bucket_id='scansafe-account-media' and o.name=p_path for share;
  if not found then raise exception 'The image has not finished uploading. Try again'; end if;
  v_type:=lower(coalesce(v_meta->>'mimetype',''));
  if coalesce(v_meta->>'size','') !~ '^[0-9]+$' then raise exception 'The uploaded image size is invalid'; end if;
  v_size:=(v_meta->>'size')::bigint;
  if v_type not in ('image/jpeg','image/png','image/webp') or v_size not between 1 and 2097152
     or (v_type='image/jpeg' and p_path !~ '\.jpg$')
     or (v_type='image/png' and p_path !~ '\.png$')
     or (v_type='image/webp' and p_path !~ '\.webp$') then
    raise exception 'Upload a JPG, PNG or WebP image up to 2 MB';
  end if;
  select m.object_path into v_previous from public.scansafe_account_media m where m.owner_id=v_uid and m.kind=p_kind;
  insert into public.scansafe_account_media(owner_id,kind,evacuee_id,object_path,content_type,byte_size)
    values(v_uid,p_kind,v_eid,p_path,v_type,v_size)
  on conflict(owner_id,kind) do update set evacuee_id=excluded.evacuee_id,object_path=excluded.object_path,
    content_type=excluded.content_type,byte_size=excluded.byte_size,uploaded_at=now();
  perform public.log_scansafe_audit('account_image_uploaded','evacuee',v_eid::text,jsonb_build_object('kind',p_kind));
  return public.get_my_scansafe_media()||jsonb_build_object('previous_path',v_previous);
end;
$save$;
revoke all on function public.save_scansafe_account_media(text,text) from public,anon,authenticated;
grant execute on function public.save_scansafe_account_media(text,text) to authenticated;

create or replace function public.get_scansafe_registration_details(p_evacuee_id bigint)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public
as $review$
declare v_e public.evacuees%rowtype;
begin
  if auth.uid() is null or not coalesce(public.is_staff(),false) then
    raise exception using errcode='42501',message='Staff access is required to review registration images';
  end if;
  select e.* into v_e from public.evacuees e where e.evacuee_id=p_evacuee_id;
  if not found then raise exception 'Registration not found'; end if;
  return jsonb_build_object('evacuee',to_jsonb(v_e),
    'group',(select to_jsonb(g) from public.evacuee_groups g where g.group_id=v_e.group_id),
    'needs',coalesce((select jsonb_agg(to_jsonb(n)) from public.evacuee_needs n where n.evacuee_id=p_evacuee_id),'[]'::jsonb),
    'profile_photo',(select jsonb_build_object('path',m.object_path,'uploaded_at',m.uploaded_at)
      from public.scansafe_account_media m where m.evacuee_id=p_evacuee_id and m.owner_id=v_e.auth_user_id and m.kind='profile'),
    'valid_id',(select jsonb_build_object('path',m.object_path,'uploaded_at',m.uploaded_at)
      from public.scansafe_account_media m where m.evacuee_id=p_evacuee_id and m.owner_id=v_e.auth_user_id and m.kind='valid-id'));
end;
$review$;
revoke all on function public.get_scansafe_registration_details(bigint) from public,anon,authenticated;
grant execute on function public.get_scansafe_registration_details(bigint) to authenticated;

notify pgrst,'reload schema';
commit;
