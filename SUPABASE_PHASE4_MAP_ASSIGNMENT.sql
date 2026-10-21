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
