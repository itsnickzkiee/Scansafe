-- ScanSafe: camera/manual barcode verification followed by GBEAA assignment.
-- Run this ENTIRE file in Supabase SQL Editor after the existing ScanSafe setup
-- and SUPABASE_EVACUEE_LIVE_SYNC_FIX.sql. No sample rooms or people are inserted.
-- The legacy GBEAA patch is optional: its corrected allocator is included here.
-- Scanning assigns accommodation only; it never checks an evacuee in.

rollback;
begin;

do $preflight$
begin
  if to_regprocedure('public.is_staff()') is null
     or to_regprocedure('public.verify_qr_code(text)') is null then
    raise exception 'Apply the existing ScanSafe Phase 4-6 scanner setup before this fix';
  end if;
  if to_regprocedure('public.log_scansafe_audit(text,text,text,jsonb)') is null then
    raise exception 'Run SUPABASE_EVACUEE_LIVE_SYNC_FIX.sql before this scanner fix';
  end if;
end;
$preflight$;

-- Fail and roll back if old data contains duplicate active group assignments.
create unique index if not exists ux_one_active_assignment_per_group
on public.accommodation_assignments(group_id)
where assignment_status = 'active';

-- Lock the actual space row, not a computed/derived row containing a stale copy
-- of its occupancy. The conditional increment is a final capacity safeguard.
create or replace function public.assign_group_gbeaa(p_group_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $gbeaa$
declare
  v_group_size integer;
  v_needs_access boolean := false;
  v_space public.accommodation_spaces%rowtype;
  v_assignment_id bigint;
  v_new_occupancy integer;
  v_overflow boolean;
begin
  if auth.uid() is null or not coalesce(public.is_staff(), false) then
    raise exception using errcode = '42501', message = 'Staff access is required';
  end if;

  select g.group_size into v_group_size
  from public.evacuee_groups g where g.group_id = p_group_id
  for update;
  if not found then raise exception 'Evacuee group not found'; end if;
  if coalesce(v_group_size, 0) < 1 then raise exception 'The group size must be positive'; end if;

  if exists (
    select 1 from public.accommodation_assignments a
    where a.group_id = p_group_id and a.assignment_status = 'active'
  ) then
    raise exception 'This group already has an active accommodation assignment';
  end if;

  if not exists (
    select 1 from public.evacuees e
    join public.barcodes b on b.evacuee_id = e.evacuee_id and b.status = 'active'
    where e.group_id = p_group_id and e.approval_status = 'approved'
      and coalesce(e.current_status, '') <> 'released'
  ) then
    raise exception 'Group is not eligible: admin approval and an active barcode are required';
  end if;

  select coalesce(bool_or(e.accessibility_required), false)
    or coalesce(bool_or(lower(coalesce(e.needs_summary, '')) ~
      '(wheelchair|mobility|accessible|accessibility|pwd|disab)'), false)
    or exists (
      select 1 from public.evacuee_needs n
      join public.evacuees en on en.evacuee_id = n.evacuee_id
      where en.group_id = p_group_id and (
        lower(coalesce(n.need_type, '')) ~ '(wheelchair|mobility|accessible|accessibility|pwd|disab)'
        or lower(coalesce(n.description, '')) ~ '(wheelchair|mobility|accessible|accessibility|pwd|disab)'
      )
    ) into v_needs_access
  from public.evacuees e where e.group_id = p_group_id;

  select s.* into v_space
  from public.accommodation_spaces s
  where s.status <> 'inactive'
    and s.capacity - coalesce(s.current_occupancy, 0) >= v_group_size
    and (
      (s.is_primary = true and s.space_type in ('hallway', 'corridor', 'other'))
      or (s.is_primary = false and s.space_type = 'overflow_room')
    )
    and (not v_needs_access or s.accessible = true)
  order by
    case when s.is_primary then 0 else 1 end,
    s.capacity - coalesce(s.current_occupancy, 0) - v_group_size,
    case when v_needs_access or not s.accessible then 0 else 1 end,
    coalesce(s.current_occupancy, 0) desc,
    s.space_code, s.space_id
  limit 1
  for update of s;

  if not found then
    -- A dedicated code distinguishes no capacity from unexpected audit/schema
    -- failures, including helpers that happen to raise no_data_found.
    raise exception using errcode = 'P5501', message = case when v_needs_access then
      'No available accessible space can fit the whole group.' else
      'No available primary or approved overflow space can fit the whole group.' end;
  end if;

  update public.accommodation_spaces s
  set current_occupancy = coalesce(s.current_occupancy, 0) + v_group_size
  where s.space_id = v_space.space_id
    and s.status <> 'inactive'
    and s.capacity - coalesce(s.current_occupancy, 0) >= v_group_size
  returning s.current_occupancy into v_new_occupancy;
  if not found then
    raise exception using errcode = '40001', message = 'Space capacity changed. Scan again to retry GBEAA.';
  end if;

  insert into public.accommodation_assignments(
    group_id, space_id, assigned_by, assignment_status, override_flag
  ) values (p_group_id, v_space.space_id, auth.uid(), 'active', false)
  returning assignment_id into v_assignment_id;

  -- 'accommodated' is the existing database value for an assigned group.
  -- Preserve genuine check-in/release states; scanning never creates check-in.
  update public.evacuees set current_status = 'accommodated'
  where group_id = p_group_id
    and coalesce(lower(replace(current_status, '-', '_')), '')
      not in ('released', 'checked_in', 'checkedin');

  v_overflow := not v_space.is_primary;
  perform public.log_scansafe_audit('gbeaa_assignment', 'group', p_group_id::text,
    jsonb_build_object('algorithm', 'GBEAA', 'space_code', v_space.space_code,
      'space_type', v_space.space_type, 'overflow_used', v_overflow,
      'group_size', v_group_size, 'requires_accessibility', v_needs_access,
      'remaining_after', v_space.capacity - v_new_occupancy));

  return jsonb_build_object('algorithm', 'GBEAA', 'assigned', true,
    'assignment_id', v_assignment_id, 'group_id', p_group_id, 'group_size', v_group_size,
    'requires_accessibility', v_needs_access, 'space_id', v_space.space_id,
    'space_code', v_space.space_code, 'space_name', coalesce(v_space.space_name, v_space.space_code),
    'space_type', v_space.space_type, 'is_primary', v_space.is_primary,
    'overflow_used', v_overflow, 'accessible', v_space.accessible,
    'capacity', v_space.capacity, 'current_occupancy', v_new_occupancy,
    'remaining_after', v_space.capacity - v_new_occupancy,
    'reason', 'Primary-first, accessibility-aware greedy best-fit assignment.');
end;
$gbeaa$;

revoke all on function public.assign_group_gbeaa(bigint) from public, anon, authenticated;
grant execute on function public.assign_group_gbeaa(bigint) to authenticated;

create or replace function public.scan_and_assign_evacuee(p_barcode_value text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $scan$
declare
  v_value text := btrim(coalesce(p_barcode_value, ''));
  v_evacuee_id bigint;
  v_group_id bigint;
  v_barcode_id bigint;
  v_evacuee public.evacuees%rowtype;
  v_barcode public.barcodes%rowtype;
  v_verified jsonb;
  v_details jsonb;
  v_assignment jsonb := null;
  v_state text := 'not_eligible';
  v_message text;
  v_group_size integer;
  v_current_status text;
begin
  if auth.uid() is null or not coalesce(public.is_staff(), false) then
    raise exception using errcode = '42501', message = 'Staff access is required';
  end if;

  select e.evacuee_id, e.group_id, b.barcode_id
    into v_evacuee_id, v_group_id, v_barcode_id
  from public.barcodes b
  join public.evacuees e on e.evacuee_id = b.evacuee_id
  where b.barcode_value = v_value limit 1;

  -- Group -> evacuee -> barcode is the same order used by assignment/approval.
  -- A scan cannot allocate with an approval or barcode revoked midway through.
  if found then
    if v_group_id is not null then
      select g.group_size into v_group_size
      from public.evacuee_groups g where g.group_id = v_group_id for update;
    end if;
    select e.* into v_evacuee from public.evacuees e
    where e.evacuee_id = v_evacuee_id for update;
    select b.* into v_barcode from public.barcodes b
    where b.barcode_id = v_barcode_id for update;
    if v_evacuee.evacuee_id is null or v_barcode.barcode_id is null
       or v_evacuee.group_id is distinct from v_group_id
       or v_barcode.evacuee_id is distinct from v_evacuee_id
       or v_barcode.barcode_value is distinct from v_value then
      raise exception using errcode = '40001', message = 'The registration changed. Scan the barcode again.';
    end if;
  end if;

  -- Reuse the existing verification/logging rules; do not approve registrations.
  v_verified := public.verify_qr_code(v_value);
  if coalesce((v_verified ->> 'valid')::boolean, false) = false then
    return v_verified || jsonb_build_object('group_id', v_group_id,
      'assignment_state', 'not_eligible', 'assignment', null,
      'assignment_message', 'A valid, active, approved barcode is required before assignment.');
  end if;
  if v_evacuee.evacuee_id is null then
    raise exception 'The verified barcode has no linked evacuee record';
  end if;
  -- Do not trust a legacy verifier that treats a NULL status as approved/active.
  -- Raising rolls back its scan log/status update as well as blocking allocation.
  if v_barcode.status is distinct from 'active'
     or v_evacuee.approval_status is distinct from 'approved' then
    raise exception 'The barcode or registration status is incomplete. An administrator must review this record.';
  end if;

  v_details := to_jsonb(v_evacuee);
  v_verified := v_verified || jsonb_build_object(
    'group_id', v_group_id, 'group_size', coalesce(v_group_size, v_evacuee.group_size, 1),
    'needs_summary', v_details ->> 'needs_summary', 'address', v_details ->> 'address',
    'contact_number', coalesce(v_details ->> 'contact_number', v_details ->> 'phone'));

  if v_group_id is null or coalesce(v_group_size, 0) < 1 then
    v_message := 'This registration has no valid group. An administrator must repair its group details.';
  elsif v_evacuee.current_status = 'released' then
    v_message := 'This evacuee has been released. Staff must review the record before assigning again.';
  else
    -- Serialize repeat scans using the group lock. Lock an existing assignment
    -- too so a concurrent transfer/release cannot return an obsolete location.
    perform 1 from public.accommodation_assignments a
    where a.group_id = v_group_id and a.assignment_status = 'active'
    order by a.assigned_at desc nulls last, a.assignment_id desc
    limit 1 for update of a;
    if found then
      v_state := 'already_assigned';
      v_message := 'This group is already assigned. Its current space has been kept.';
    else
      begin
        perform public.assign_group_gbeaa(v_group_id);
        v_state := 'assigned';
        v_message := 'GBEAA assigned an available space. Check-in is still pending.';
      exception when sqlstate 'P5501' then
        v_state := 'unavailable';
        get stacked diagnostics v_message = message_text;
      end;
    end if;

    if v_state in ('assigned', 'already_assigned') then
      select jsonb_build_object(
        'assignment_id', a.assignment_id, 'group_id', a.group_id, 'group_size', v_group_size,
        'space_id', s.space_id, 'space_code', s.space_code,
        'space_name', coalesce(s.space_name, s.space_code), 'space_type', s.space_type,
        'shelter_name', sh.shelter_name, 'capacity', s.capacity,
        'current_occupancy', coalesce(s.current_occupancy, 0),
        'available', greatest(0, s.capacity - coalesce(s.current_occupancy, 0)),
        'assigned_at', a.assigned_at
      ) into v_assignment
      from public.accommodation_assignments a
      join public.accommodation_spaces s on s.space_id = a.space_id
      left join public.shelters sh on sh.shelter_id = s.shelter_id
      where a.group_id = v_group_id and a.assignment_status = 'active'
      order by a.assigned_at desc nulls last, a.assignment_id desc limit 1;
      if v_assignment is null then raise exception 'The accommodation assignment could not be read'; end if;
    end if;
  end if;

  select e.current_status into v_current_status
  from public.evacuees e where e.evacuee_id = v_evacuee_id;

  return v_verified || jsonb_build_object('assignment_state', v_state,
    'assignment_message', v_message, 'assignment', v_assignment,
    'space_code', v_assignment ->> 'space_code', 'space_name', v_assignment ->> 'space_name',
    'shelter_name', v_assignment ->> 'shelter_name', 'current_status', v_current_status);
end;
$scan$;

revoke all on function public.scan_and_assign_evacuee(text) from public, anon, authenticated;
grant execute on function public.scan_and_assign_evacuee(text) to authenticated;

notify pgrst, 'reload schema';
commit;
