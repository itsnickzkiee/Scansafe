-- =========================================================
-- ScanSafe Evacuee Login Permanent Fix
-- Run ONCE in Supabase SQL Editor.
--
-- Goals:
-- 1) Every new Auth signup automatically receives a ScanSafe profile.
-- 2) Public/self-signup is ALWAYS forced to role='evacuee'.
-- 3) Existing evacuee accounts with an evacuee row but missing profile
--    can repair themselves after successful Supabase Auth login.
-- 4) Admin/staff roles are NEVER granted from client metadata.
-- =========================================================

-- ---------------------------------------------------------
-- A. Ensure helper exists for reliable login profile lookup.
-- ---------------------------------------------------------
create or replace function public.get_my_profile()
returns table (
  id uuid,
  full_name text,
  role text
)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.full_name, p.role
  from public.profiles p
  where p.id = auth.uid()
  limit 1;
$$;

revoke all on function public.get_my_profile() from public;
revoke all on function public.get_my_profile() from anon;
revoke all on function public.get_my_profile() from authenticated;
grant execute on function public.get_my_profile() to authenticated;


-- ---------------------------------------------------------
-- B. Automatic profile creation for EVERY new Auth user.
--
-- SECURITY:
-- Never trust raw_user_meta_data.role from a browser/mobile signup.
-- New Auth users are always provisioned as 'evacuee'.
--
-- A manually-created admin may initially get an evacuee profile, then the
-- trusted admin bootstrap SQL can change the role to 'admin'.
-- ---------------------------------------------------------
create or replace function public.handle_new_scansafe_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_name text;
begin
  v_name := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'full_name'),''),
    nullif(split_part(coalesce(new.email,''),'@',1),''),
    'ScanSafe User'
  );

  insert into public.profiles(id, full_name, role)
  values(new.id, v_name, 'evacuee')
  on conflict(id) do nothing;

  return new;
end;
$$;

drop trigger if exists scansafe_auth_user_profile_trigger on auth.users;

create trigger scansafe_auth_user_profile_trigger
after insert on auth.users
for each row
execute function public.handle_new_scansafe_auth_user();


-- ---------------------------------------------------------
-- C. Repair existing evacuee accounts that authenticate correctly
-- but have no public.profiles row.
--
-- This function repairs ONLY when:
-- - auth.uid() exists
-- - a matching public.evacuees.auth_user_id exists
-- It cannot create admin/staff privileges.
-- ---------------------------------------------------------
create or replace function public.repair_my_evacuee_profile()
returns table (
  id uuid,
  full_name text,
  role text
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_name text;
begin
  if v_uid is null then
    return;
  end if;

  -- Existing profile: return it unchanged.
  if exists(select 1 from public.profiles p where p.id=v_uid) then
    return query
      select p.id,p.full_name,p.role
      from public.profiles p
      where p.id=v_uid
      limit 1;
    return;
  end if;

  -- Repair only a real linked evacuee registration.
  select e.full_name
    into v_name
  from public.evacuees e
  where e.auth_user_id=v_uid
  order by e.evacuee_id
  limit 1;

  if v_name is null then
    return;
  end if;

  insert into public.profiles(id,full_name,role)
  values(v_uid,v_name,'evacuee')
  on conflict(id) do nothing;

  return query
    select p.id,p.full_name,p.role
    from public.profiles p
    where p.id=v_uid
    limit 1;
end;
$$;

revoke all on function public.repair_my_evacuee_profile() from public;
revoke all on function public.repair_my_evacuee_profile() from anon;
revoke all on function public.repair_my_evacuee_profile() from authenticated;
grant execute on function public.repair_my_evacuee_profile() to authenticated;


-- ---------------------------------------------------------
-- D. Repair ALL currently-linked evacuee accounts that are missing
-- profiles. Safe because it only uses existing public.evacuees rows.
-- ---------------------------------------------------------
insert into public.profiles(id,full_name,role)
select
  e.auth_user_id,
  e.full_name,
  'evacuee'
from public.evacuees e
where e.auth_user_id is not null
  and not exists(
    select 1
    from public.profiles p
    where p.id=e.auth_user_id
  )
on conflict(id) do nothing;


-- ---------------------------------------------------------
-- E. Diagnostic view for SQL Editor testing.
-- Replace the email before running this SELECT if desired.
-- ---------------------------------------------------------
select
  u.id as auth_user_id,
  u.email,
  u.email_confirmed_at,
  p.id as profile_id,
  p.full_name,
  p.role,
  e.evacuee_id,
  e.registration_code,
  e.approval_status,
  e.current_status
from auth.users u
left join public.profiles p on p.id=u.id
left join public.evacuees e on e.auth_user_id=u.id
order by u.created_at desc;
