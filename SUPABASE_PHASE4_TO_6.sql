-- =========================================================
-- ScanSafe Supabase Phase 4
-- Real Accommodation Map + Transactional Assignment
-- Run AFTER Phase 1, Phase 2, and Phase 3.
-- =========================================================

-- Main Lobby is part of the current ScanSafe map. Add it only if missing.
do $$
declare
  sid bigint;
begin
  select shelter_id into sid
  from public.shelters
  where shelter_name = 'Main School Building'
  order by shelter_id
  limit 1;

  if sid is not null then
    insert into public.accommodation_spaces
      (shelter_id, space_code, space_name, space_type, capacity,
       current_occupancy, accessible, is_primary, status)
    values
      (sid, 'ML', 'Main Lobby', 'other', 30, 0, true, true, 'available')
    on conflict (shelter_id, space_code) do nothing;
  end if;
end $$;

-- A group may have only one ACTIVE accommodation assignment at a time.
create unique index if not exists ux_one_active_assignment_per_group
on public.accommodation_assignments(group_id)
where assignment_status = 'active';

-- Transactional assignment RPC.
-- It locks the group and accommodation space so two staff members cannot
-- accidentally overbook the same space at the same time.
create or replace function public.assign_group_to_space(
  p_group_id bigint,
  p_space_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group_size integer;
  v_space_id bigint;
  v_space_name text;
  v_capacity integer;
  v_occupancy integer;
  v_assignment_id bigint;
  v_new_occupancy integer;
begin
  if not public.is_staff() then
    raise exception 'Not authorized';
  end if;

  select group_size
    into v_group_size
  from public.evacuee_groups
  where group_id = p_group_id
  for update;

  if not found then
    raise exception 'Evacuee group not found';
  end if;

  if exists (
    select 1
    from public.accommodation_assignments
    where group_id = p_group_id
      and assignment_status = 'active'
  ) then
    raise exception 'This group already has an active accommodation assignment';
  end if;

  select space_id, space_name, capacity, current_occupancy
    into v_space_id, v_space_name, v_capacity, v_occupancy
  from public.accommodation_spaces
  where upper(space_code) = upper(trim(p_space_code))
    and is_primary = true
    and status <> 'inactive'
  order by space_id
  limit 1
  for update;

  if not found then
    raise exception 'Accommodation space not found or inactive';
  end if;

  if coalesce(v_occupancy,0) + v_group_size > v_capacity then
    raise exception 'Insufficient slots. Available: %, group size: %',
      greatest(0, v_capacity - coalesce(v_occupancy,0)), v_group_size;
  end if;

  insert into public.accommodation_assignments(
    group_id, space_id, assigned_by, assignment_status, override_flag
  ) values (
    p_group_id, v_space_id, auth.uid(), 'active', false
  )
  returning assignment_id into v_assignment_id;

  v_new_occupancy := coalesce(v_occupancy,0) + v_group_size;

  update public.accommodation_spaces
  set current_occupancy = v_new_occupancy
  where space_id = v_space_id;

  return jsonb_build_object(
    'assignment_id', v_assignment_id,
    'group_id', p_group_id,
    'group_size', v_group_size,
    'space_id', v_space_id,
    'space_code', upper(trim(p_space_code)),
    'space_name', v_space_name,
    'capacity', v_capacity,
    'current_occupancy', v_new_occupancy,
    'available', v_capacity - v_new_occupancy
  );
end;
$$;

grant execute on function public.assign_group_to_space(bigint,text) to authenticated;

-- =========================================================
-- END PHASE 4
-- =========================================================


-- =========================================================
-- PHASE 5: Real QR Verification + Scan Logs
-- =========================================================

create or replace function public.verify_qr_code(p_qr_value text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_barcode_id bigint;
  v_evacuee_id bigint;
  v_qr_status text;
  v_full_name text;
  v_age integer;
  v_gender text;
  v_group_id bigint;
  v_group_size integer;
  v_approval_status text;
  v_current_status text;
  v_space_code text;
  v_space_name text;
  v_shelter_name text;
  v_result text;
  v_scan_id bigint;
  v_scanned_at timestamptz;
begin
  if not public.is_staff() then
    raise exception 'Not authorized';
  end if;

  if trim(coalesce(p_qr_value,'')) = '' then
    return jsonb_build_object(
      'valid', false,
      'result', 'invalid',
      'qr_value', coalesce(p_qr_value,''),
      'message', 'QR value is empty'
    );
  end if;

  select
    b.barcode_id,
    b.evacuee_id,
    b.status,
    e.full_name,
    e.age,
    e.gender,
    e.group_id,
    e.group_size,
    e.approval_status,
    e.current_status
  into
    v_barcode_id,
    v_evacuee_id,
    v_qr_status,
    v_full_name,
    v_age,
    v_gender,
    v_group_id,
    v_group_size,
    v_approval_status,
    v_current_status
  from public.barcodes b
  join public.evacuees e on e.evacuee_id = b.evacuee_id
  where b.barcode_value = trim(p_qr_value)
  limit 1;

  if not found then
    return jsonb_build_object(
      'valid', false,
      'result', 'invalid',
      'qr_value', trim(p_qr_value),
      'message', 'QR code was not found in ScanSafe'
    );
  end if;

  select
    s.space_code,
    coalesce(s.space_name, s.space_code),
    sh.shelter_name
  into
    v_space_code,
    v_space_name,
    v_shelter_name
  from public.accommodation_assignments a
  join public.accommodation_spaces s on s.space_id = a.space_id
  join public.shelters sh on sh.shelter_id = s.shelter_id
  where a.group_id = v_group_id
    and a.assignment_status = 'active'
  order by a.assigned_at desc
  limit 1;

  if v_qr_status = 'revoked' then
    v_result := 'revoked';
  elsif v_qr_status <> 'active' then
    v_result := 'inactive';
  elsif v_approval_status <> 'approved' then
    v_result := 'invalid';
  else
    v_result := 'verified';
  end if;

  insert into public.scan_logs(barcode_id, scanned_by, scan_result)
  values (v_barcode_id, auth.uid(), v_result)
  returning scan_id, scanned_at into v_scan_id, v_scanned_at;

  if v_result = 'verified' and v_current_status = 'registered' then
    update public.evacuees
    set current_status = 'verified'
    where evacuee_id = v_evacuee_id;
    v_current_status := 'verified';
  end if;

  return jsonb_build_object(
    'valid', v_result = 'verified',
    'result', v_result,
    'message',
      case
        when v_result = 'verified' then 'QR code verified successfully'
        when v_result = 'revoked' then 'This QR code has been revoked'
        when v_result = 'inactive' then 'This QR code is inactive'
        else 'Evacuee registration is not approved'
      end,
    'scan_id', v_scan_id,
    'scanned_at', v_scanned_at,
    'qr_value', trim(p_qr_value),
    'evacuee_id', v_evacuee_id,
    'full_name', v_full_name,
    'age', v_age,
    'gender', v_gender,
    'group_size', coalesce(v_group_size,1),
    'approval_status', v_approval_status,
    'current_status', v_current_status,
    'space_code', v_space_code,
    'space_name', v_space_name,
    'shelter_name', v_shelter_name
  );
end;
$$;

grant execute on function public.verify_qr_code(text) to authenticated;


create or replace function public.get_recent_scan_history(p_limit integer default 10)
returns table(
  scan_id bigint,
  scanned_at timestamptz,
  scan_result text,
  qr_value text,
  full_name text,
  space_code text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_staff() then
    raise exception 'Not authorized';
  end if;

  return query
  select
    sl.scan_id,
    sl.scanned_at,
    sl.scan_result,
    b.barcode_value,
    e.full_name,
    sp.space_code
  from public.scan_logs sl
  join public.barcodes b on b.barcode_id = sl.barcode_id
  join public.evacuees e on e.evacuee_id = b.evacuee_id
  left join lateral (
    select s.space_code
    from public.accommodation_assignments a
    join public.accommodation_spaces s on s.space_id = a.space_id
    where a.group_id = e.group_id
      and a.assignment_status = 'active'
    order by a.assigned_at desc
    limit 1
  ) sp on true
  order by sl.scanned_at desc
  limit greatest(1,least(coalesce(p_limit,10),50));
end;
$$;

grant execute on function public.get_recent_scan_history(integer) to authenticated;

-- =========================================================
-- PHASE 6 requires no extra database tables.
-- Existing Supabase Auth + user profile/evacuee/QR/assignment data
-- are reused by the installable PWA.
-- =========================================================
