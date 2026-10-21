-- =========================================================
-- ScanSafe Login / Profile Reliability Fix
-- Run ONCE in Supabase SQL Editor.
-- Does not create passwords and does not expose secret keys.
-- =========================================================

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

-- Optional verification for the current bootstrapped admin account.
-- This SELECT is safe to run in SQL Editor.
select
  u.id as auth_user_id,
  u.email,
  p.id as profile_id,
  p.full_name,
  p.role
from auth.users u
left join public.profiles p on p.id = u.id
where lower(u.email) = lower('dutsrominick@gmail.com');
