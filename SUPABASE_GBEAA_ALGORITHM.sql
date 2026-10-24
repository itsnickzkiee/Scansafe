-- =========================================================
-- ScanSafe GBEAA Algorithm Patch
-- Greedy-Based Evacuee Accommodation Algorithm
-- Run AFTER ScanSafe Phases 1-9.
-- =========================================================

-- ---------------------------------------------------------
-- 1) REGISTER APPROVED OVERFLOW CLASSROOMS
-- They are NEVER primary. GBEAA considers them only when no
-- primary hallway/corridor/Main Lobby space can fit the group.
-- Existing rows are preserved.
-- ---------------------------------------------------------
do $$
declare
  sid bigint;
begin
  select shelter_id into sid
  from public.shelters
  where shelter_name='Main School Building'
  order by shelter_id
  limit 1;

  if sid is not null then
    insert into public.accommodation_spaces(
      shelter_id,space_code,space_name,space_type,capacity,
      current_occupancy,accessible,is_primary,status
    )
    values
      (sid,'102','Room 102','overflow_room',30,0,false,false,'available'),
      (sid,'103','Room 103','overflow_room',30,0,false,false,'available'),
      (sid,'104','Room 104','overflow_room',30,0,false,false,'available'),
      (sid,'105','Room 105','overflow_room',30,0,false,false,'available'),
      (sid,'106','Room 106','overflow_room',30,0,false,false,'available'),
      (sid,'107','Room 107','overflow_room',30,0,false,false,'available'),
      (sid,'108','Room 108','overflow_room',30,0,false,false,'available'),
      (sid,'109','Room 109','overflow_room',30,0,false,false,'available'),
      (sid,'110','Room 110','overflow_room',30,0,false,false,'available'),
      (sid,'111','Room 111','overflow_room',30,0,false,false,'available'),
      (sid,'112','Room 112','overflow_room',30,0,false,false,'available'),
      (sid,'113','Room 113','overflow_room',30,0,false,false,'available'),
      (sid,'114','Room 114','overflow_room',30,0,false,false,'available'),
      (sid,'115','Room 115','overflow_room',30,0,false,false,'available'),
      (sid,'116','Room 116','overflow_room',30,0,false,false,'available')
    on conflict(shelter_id,space_code) do nothing;
  end if;
end $$;


-- ---------------------------------------------------------
-- 2) GBEAA RECOMMENDATION
--
-- RULE ORDER
-- A. Group must be approved, have an active QR, and have no
--    active assignment.
-- B. Respect accessibility when the group requires it.
-- C. Primary spaces ALWAYS outrank overflow rooms.
-- D. Inside the active tier, GREEDY BEST-FIT chooses the
--    space with the fewest remaining slots AFTER placement.
-- E. For non-accessibility groups, accessible spaces are
--    preserved when an equally-good non-accessible option exists.
-- F. Stable tie-breakers make the recommendation deterministic.
-- ---------------------------------------------------------
create or replace function public.gbeaa_recommend_space(p_group_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path=public
as $$
declare
  v_group_size integer;
  v_needs_access boolean := false;
  v_space record;
  v_candidate_count integer := 0;
  v_primary_count integer := 0;
  v_overflow_count integer := 0;
  v_reason text;
begin
  if not public.is_staff() then
    raise exception 'Not authorized';
  end if;

  select g.group_size
    into v_group_size
  from public.evacuee_groups g
  where g.group_id=p_group_id;

  if not found then
    raise exception 'Evacuee group not found';
  end if;

  if exists(
    select 1
    from public.accommodation_assignments a
    where a.group_id=p_group_id
      and a.assignment_status='active'
  ) then
    return jsonb_build_object(
      'algorithm','GBEAA',
      'recommended',false,
      'group_id',p_group_id,
      'group_size',v_group_size,
      'reason','This group already has an active accommodation assignment.'
    );
  end if;

  if not exists(
    select 1
    from public.evacuees e
    join public.barcodes b
      on b.evacuee_id=e.evacuee_id
     and b.status='active'
    where e.group_id=p_group_id
      and e.approval_status='approved'
  ) then
    return jsonb_build_object(
      'algorithm','GBEAA',
      'recommended',false,
      'group_id',p_group_id,
      'group_size',v_group_size,
      'reason','Admin approval and an active QR are required before accommodation assignment.'
    );
  end if;

  select
    coalesce(bool_or(e.accessibility_required),false)
    or coalesce(bool_or(
      lower(coalesce(e.needs_summary,'')) ~
      '(wheelchair|mobility|accessible|accessibility|pwd|disab)'
    ),false)
    or exists(
      select 1
      from public.evacuee_needs n
      join public.evacuees en on en.evacuee_id=n.evacuee_id
      where en.group_id=p_group_id
        and (
          lower(coalesce(n.need_type,'')) ~
            '(wheelchair|mobility|accessible|accessibility|pwd|disab)'
          or lower(coalesce(n.description,'')) ~
            '(wheelchair|mobility|accessible|accessibility|pwd|disab)'
        )
    )
  into v_needs_access
  from public.evacuees e
  where e.group_id=p_group_id;

  with candidates as (
    select
      s.space_id,
      s.space_code,
      s.space_name,
      s.space_type,
      s.capacity,
      coalesce(s.current_occupancy,0) as current_occupancy,
      s.accessible,
      s.is_primary,
      greatest(0,s.capacity-coalesce(s.current_occupancy,0)) as available_before,
      greatest(0,s.capacity-coalesce(s.current_occupancy,0)-v_group_size) as remaining_after,
      case
        when s.is_primary=true
         and s.space_type in ('hallway','corridor','other') then 0
        when s.is_primary=false
         and s.space_type='overflow_room' then 1
        else 9
      end as tier
    from public.accommodation_spaces s
    where s.status<>'inactive'
      and s.capacity-coalesce(s.current_occupancy,0) >= v_group_size
      and (
        (s.is_primary=true and s.space_type in ('hallway','corridor','other'))
        or
        (s.is_primary=false and s.space_type='overflow_room')
      )
      and (not v_needs_access or s.accessible=true)
  )
  select
    count(*)::integer,
    count(*) filter(where tier=0)::integer,
    count(*) filter(where tier=1)::integer
  into v_candidate_count,v_primary_count,v_overflow_count
  from candidates;

  select *
  into v_space
  from (
    select
      s.space_id,
      s.space_code,
      s.space_name,
      s.space_type,
      s.capacity,
      coalesce(s.current_occupancy,0) as current_occupancy,
      s.accessible,
      s.is_primary,
      s.capacity-coalesce(s.current_occupancy,0) as available_before,
      s.capacity-coalesce(s.current_occupancy,0)-v_group_size as remaining_after,
      case
        when s.is_primary=true
         and s.space_type in ('hallway','corridor','other') then 0
        when s.is_primary=false
         and s.space_type='overflow_room' then 1
        else 9
      end as tier
    from public.accommodation_spaces s
    where s.status<>'inactive'
      and s.capacity-coalesce(s.current_occupancy,0) >= v_group_size
      and (
        (s.is_primary=true and s.space_type in ('hallway','corridor','other'))
        or
        (s.is_primary=false and s.space_type='overflow_room')
      )
      and (not v_needs_access or s.accessible=true)
  ) ranked
  where ranked.tier in (0,1)
  order by
    ranked.tier asc,
    ranked.remaining_after asc,
    case
      when v_needs_access then 0
      when ranked.accessible then 1
      else 0
    end asc,
    ranked.current_occupancy desc,
    ranked.space_code asc
  limit 1;

  if not found then
    v_reason :=
      case
        when v_needs_access then
          'No active accessible accommodation space currently has enough capacity for the group.'
        else
          'No active primary or approved overflow accommodation space currently has enough capacity for the group.'
      end;

    return jsonb_build_object(
      'algorithm','GBEAA',
      'recommended',false,
      'group_id',p_group_id,
      'group_size',v_group_size,
      'requires_accessibility',v_needs_access,
      'candidate_count',v_candidate_count,
      'primary_candidate_count',v_primary_count,
      'overflow_candidate_count',v_overflow_count,
      'reason',v_reason
    );
  end if;

  if v_space.tier=0 then
    v_reason :=
      'Primary accommodation selected first. Among valid primary spaces, GBEAA chose the greedy best-fit option with the least unused capacity after placing the whole group.';
  else
    v_reason :=
      'No primary hallway/corridor/Main Lobby space could fit the whole group. GBEAA used the approved overflow-room tier and selected the greedy best-fit option.';
  end if;

  return jsonb_build_object(
    'algorithm','GBEAA',
    'rule','Primary-first + accessibility constraint + greedy best-fit',
    'recommended',true,
    'group_id',p_group_id,
    'group_size',v_group_size,
    'requires_accessibility',v_needs_access,
    'candidate_count',v_candidate_count,
    'primary_candidate_count',v_primary_count,
    'overflow_candidate_count',v_overflow_count,
    'space_id',v_space.space_id,
    'space_code',v_space.space_code,
    'space_name',coalesce(v_space.space_name,v_space.space_code),
    'space_type',v_space.space_type,
    'is_primary',v_space.is_primary,
    'overflow_used',(v_space.tier=1),
    'accessible',v_space.accessible,
    'capacity',v_space.capacity,
    'current_occupancy',v_space.current_occupancy,
    'available_before',v_space.available_before,
    'remaining_after',v_space.remaining_after,
    'reason',v_reason
  );
end;
$$;

revoke all on function public.gbeaa_recommend_space(bigint) from public;
revoke all on function public.gbeaa_recommend_space(bigint) from anon;
revoke all on function public.gbeaa_recommend_space(bigint) from authenticated;
grant execute on function public.gbeaa_recommend_space(bigint) to authenticated;


-- ---------------------------------------------------------
-- 3) ATOMIC GBEAA ASSIGNMENT
-- The recommendation is recomputed inside the transaction and
-- the chosen space is locked before the assignment is written.
-- ---------------------------------------------------------
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

revoke all on function public.assign_group_gbeaa(bigint) from public;
revoke all on function public.assign_group_gbeaa(bigint) from anon;
revoke all on function public.assign_group_gbeaa(bigint) from authenticated;
grant execute on function public.assign_group_gbeaa(bigint) to authenticated;


-- ---------------------------------------------------------
-- 4) OPTIONAL DEFENSE / TEST HELPER
-- Returns all eligible groups with their current GBEAA decision.
-- Staff/admin only.
-- ---------------------------------------------------------
create or replace function public.gbeaa_current_recommendations()
returns jsonb
language plpgsql
stable
security definer
set search_path=public
as $$
declare
  result jsonb;
begin
  if not public.is_staff() then
    raise exception 'Not authorized';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'group_id',q.group_id,
        'group_name',q.group_name,
        'group_size',q.group_size,
        'recommendation',public.gbeaa_recommend_space(q.group_id)
      )
      order by q.group_id
    ),
    '[]'::jsonb
  )
  into result
  from (
    select distinct g.group_id,g.group_name,g.group_size
    from public.evacuee_groups g
    join public.evacuees e on e.group_id=g.group_id
    join public.barcodes b
      on b.evacuee_id=e.evacuee_id
     and b.status='active'
    where e.approval_status='approved'
      and not exists(
        select 1
        from public.accommodation_assignments a
        where a.group_id=g.group_id
          and a.assignment_status='active'
      )
  ) q;

  return result;
end;
$$;

revoke all on function public.gbeaa_current_recommendations() from public;
revoke all on function public.gbeaa_current_recommendations() from anon;
revoke all on function public.gbeaa_current_recommendations() from authenticated;
grant execute on function public.gbeaa_current_recommendations() to authenticated;

-- =========================================================
-- END GBEAA PATCH
-- =========================================================
