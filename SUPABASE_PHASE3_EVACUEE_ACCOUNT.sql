-- =========================================================
-- ScanSafe Supabase Phase 3
-- Evacuee account creation + pending registration linkage
-- Run AFTER Phase 1 and Phase 2.
-- =========================================================

create or replace function public.submit_public_registration_account(
  p_auth_user_id uuid,
  p_full_name text,
  p_email text,
  p_age integer,
  p_gender text,
  p_group_size integer,
  p_needs text,
  p_address text,
  p_barangay text,
  p_city text,
  p_valid_id_type text,
  p_valid_id_number text
)
returns text
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  gid bigint;
  eid bigint;
  req text;
  auth_email text;
  auth_created_at timestamptz;
begin
  if p_auth_user_id is null then raise exception 'Auth user is required'; end if;
  if trim(coalesce(p_full_name,'')) = '' then raise exception 'Full name is required'; end if;
  if trim(coalesce(p_email,'')) = '' then raise exception 'Email is required'; end if;
  if coalesce(p_group_size,0) < 1 then raise exception 'Group size must be at least 1'; end if;

  select lower(email), created_at
    into auth_email, auth_created_at
  from auth.users
  where id = p_auth_user_id;

  if auth_email is null then raise exception 'Auth account not found'; end if;
  if auth_email <> lower(trim(p_email)) then raise exception 'Auth email does not match registration email'; end if;

  -- Public registration may link only a newly created account. This limits
  -- anonymous callers from attaching registrations to older accounts.
  if auth_created_at < now() - interval '15 minutes' then
    raise exception 'Registration link window expired. Please sign in and contact the administrator.';
  end if;

  if exists(select 1 from public.evacuees where auth_user_id=p_auth_user_id) then
    raise exception 'This account already has an evacuee registration';
  end if;

  if exists(select 1 from public.evacuees where lower(email)=lower(trim(p_email))) then
    raise exception 'This email already has an evacuee registration';
  end if;

  insert into public.profiles(id, full_name, role)
  values (p_auth_user_id, p_full_name, 'evacuee')
  on conflict (id) do update
     set full_name=excluded.full_name,
         role='evacuee';

  req := 'REQ-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));

  insert into public.evacuee_groups(group_name,group_size)
  values (p_full_name || ' Group', p_group_size)
  returning group_id into gid;

  insert into public.evacuees(
    auth_user_id, group_id, registration_code, full_name, email, age, gender,
    group_size, needs_summary, address, barangay, city,
    valid_id_type, valid_id_number, approval_status, current_status
  ) values (
    p_auth_user_id, gid, req, p_full_name, lower(trim(p_email)), p_age, p_gender,
    p_group_size, nullif(trim(coalesce(p_needs,'')),''), p_address, p_barangay, p_city,
    p_valid_id_type, p_valid_id_number, 'pending', 'registered'
  ) returning evacuee_id into eid;

  if nullif(trim(coalesce(p_needs,'')),'') is not null
     and lower(trim(p_needs)) <> 'none' then
    insert into public.evacuee_needs(evacuee_id,need_type,description,priority_level,status)
    values (eid,'Reported Need',p_needs,'medium','pending');
  end if;

  -- IMPORTANT: no barcode is inserted here.
  -- The existing approval trigger/RPC creates it only when approval_status
  -- changes from pending to approved.
  return req;
end;
$$;

grant execute on function public.submit_public_registration_account(
  uuid,text,text,integer,text,integer,text,text,text,text,text,text
) to anon, authenticated;

-- Ensure evacuee users cannot see a barcode before approval. Existing
-- barcode rows are created only by admin/staff approval.
-- =========================================================
-- END PHASE 3
-- =========================================================
