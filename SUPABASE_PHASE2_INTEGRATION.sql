-- =========================================================
-- ScanSafe Supabase Phase 2 integration patch
-- Run AFTER scansafe_supabase_phase1.sql
-- =========================================================

alter table public.evacuees add column if not exists registration_code text unique;
alter table public.evacuees add column if not exists email text;
alter table public.evacuees add column if not exists group_size integer not null default 1 check (group_size > 0);
alter table public.evacuees add column if not exists needs_summary text;
alter table public.evacuees add column if not exists barangay text;
alter table public.evacuees add column if not exists city text;
alter table public.evacuees add column if not exists valid_id_type text;
alter table public.evacuees add column if not exists valid_id_number text;

-- Public submission RPC. It exposes only the fields needed for registration;
-- it does not allow anonymous users to read evacuee records.
create or replace function public.submit_public_registration(
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
set search_path = public
as $$
declare
  gid bigint;
  eid bigint;
  req text;
begin
  if trim(coalesce(p_full_name,'')) = '' then raise exception 'Full name is required'; end if;
  if trim(coalesce(p_email,'')) = '' then raise exception 'Email is required'; end if;
  if coalesce(p_group_size,0) < 1 then raise exception 'Group size must be at least 1'; end if;

  req := 'REQ-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));

  insert into public.evacuee_groups(group_name,group_size)
  values (p_full_name || ' Group', p_group_size)
  returning group_id into gid;

  insert into public.evacuees(
    group_id, registration_code, full_name, email, age, gender,
    group_size, needs_summary, address, barangay, city,
    valid_id_type, valid_id_number, approval_status, current_status
  ) values (
    gid, req, p_full_name, lower(trim(p_email)), p_age, p_gender,
    p_group_size, nullif(trim(coalesce(p_needs,'')),''), p_address, p_barangay, p_city,
    p_valid_id_type, p_valid_id_number, 'pending', 'registered'
  ) returning evacuee_id into eid;

  if nullif(trim(coalesce(p_needs,'')),'') is not null and lower(trim(p_needs)) <> 'none' then
    insert into public.evacuee_needs(evacuee_id,need_type,description,priority_level,status)
    values (eid,'Reported Need',p_needs,'medium','pending');
  end if;

  return req;
end;
$$;

grant execute on function public.submit_public_registration(text,text,integer,text,integer,text,text,text,text,text,text) to anon, authenticated;

-- Authenticated staff/admin approval RPC.
create or replace function public.approve_evacuee_registration(p_evacuee_id bigint)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  bc text;
begin
  if not public.is_staff() then raise exception 'Not authorized'; end if;

  update public.evacuees
  set approval_status='approved', approved_at=coalesce(approved_at,now()), approved_by=auth.uid()
  where evacuee_id=p_evacuee_id;

  if not found then raise exception 'Evacuee not found'; end if;

  select barcode_value into bc
  from public.barcodes
  where evacuee_id=p_evacuee_id;

  return bc;
end;
$$;

grant execute on function public.approve_evacuee_registration(bigint) to authenticated;

-- Optional helper: create/update the first admin profile after creating the
-- auth user in Supabase Authentication > Users.
-- Replace YOUR-AUTH-USER-UUID and name before running manually:
-- insert into public.profiles(id,full_name,role)
-- values ('YOUR-AUTH-USER-UUID','ScanSafe Administrator','admin')
-- on conflict (id) do update set full_name=excluded.full_name, role='admin';
