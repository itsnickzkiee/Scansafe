-- ============================================================
-- ScanSafe Check-In / Release Lifecycle
-- RUN THIS AFTER SUPABASE_EVACUATION_OPERATIONS.sql
--
-- Final lifecycle:
-- Pending Approval -> Approved -> Accommodated / Checked In -> Released
--
-- First valid barcode scan in the active evacuation:
--   - verifies barcode
--   - runs GBEAA when needed
--   - records Arrival Time using scansafe_operation_stays.checked_in_at
--
-- Repeat scan in the same evacuation:
--   - blocked as Already Checked In
--   - no new assignment
--   - no extra occupancy
--
-- Release is a separate staff/admin action:
--   - closes assignment
--   - releases occupancy
--   - records Departure Time
--   - keeps history
-- ============================================================

rollback;
begin;

do $preflight$
begin
  if to_regclass('public.scansafe_operation_stays') is null
     or to_regprocedure('public.scansafe_operations_current()') is null
     or to_regprocedure('public.scansafe_ops_scan_base(text)') is null
     or to_regprocedure('public.release_group_assignment(bigint)') is null
     or to_regprocedure('public.log_scansafe_audit(text,text,text,jsonb)') is null then
    raise exception 'Run SUPABASE_EVACUATION_OPERATIONS.sql first, then run this lifecycle patch.';
  end if;
end;
$preflight$;

-- Assignment/admission and actual barcode check-in are separate events.
alter table public.scansafe_operation_stays
  add column if not exists checked_in_at timestamptz;

-- Staff need lifecycle visibility on the Evacuees page.
drop policy if exists scansafe_staff_stays_read on public.scansafe_operation_stays;
create policy scansafe_staff_stays_read
on public.scansafe_operation_stays
for select
to authenticated
using(coalesce(public.is_staff(),false));

-- Preserve real prior test scans when operations are installed after assignments.
-- This only backfills a stay when a verified barcode scan exists near/after admission.
update public.scansafe_operation_stays st
set checked_in_at=(
  select min(sl.scanned_at)
  from public.evacuees e
  join public.barcodes b on b.evacuee_id=e.evacuee_id
  join public.scan_logs sl on sl.barcode_id=b.barcode_id
  where e.group_id=st.group_id
    and sl.scan_result='verified'
    and sl.scanned_at >= st.admitted_at - interval '10 minutes'
)
where st.checked_in_at is null
  and st.status in ('assigned','released')
  and exists(
    select 1
    from public.evacuees e
    join public.barcodes b on b.evacuee_id=e.evacuee_id
    join public.scan_logs sl on sl.barcode_id=b.barcode_id
    where e.group_id=st.group_id
      and sl.scan_result='verified'
      and sl.scanned_at >= st.admitted_at - interval '10 minutes'
  );

-- ------------------------------------------------------------
-- One-time barcode check-in wrapper
-- ------------------------------------------------------------
create or replace function public.scan_and_assign_evacuee(p_barcode_value text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $scan$
declare
  v_input text := btrim(coalesce(p_barcode_value,''));
  v_canonical text;
  v_operation bigint;
  v_barcode_id bigint;
  v_evacuee_id bigint;
  v_group_id bigint;
  v_stay public.scansafe_operation_stays%rowtype;
  v_result jsonb;
  v_assignment jsonb;
  v_evacuee public.evacuees%rowtype;
  v_barcode public.barcodes%rowtype;
  v_duration bigint;
begin
  if auth.uid() is null or not coalesce(public.is_staff(),false) then
    raise exception using errcode='42501', message='Staff access is required';
  end if;

  if v_input='' then
    raise exception 'A barcode value is required';
  end if;

  v_operation := public.scansafe_operations_current();

  -- Resolve direct/current barcode first.
  select b.barcode_value,b.barcode_id,e.evacuee_id,e.group_id
    into v_canonical,v_barcode_id,v_evacuee_id,v_group_id
  from public.barcodes b
  join public.evacuees e on e.evacuee_id=b.evacuee_id
  where b.barcode_value=v_input
    and b.status='active'
    and e.approval_status='approved'
  limit 1;

  -- Resolve short-barcode alias when installed.
  if not found and to_regclass('public.scansafe_barcode_aliases') is not null then
    execute
      'select b.barcode_value,b.barcode_id,e.evacuee_id,e.group_id
         from public.scansafe_barcode_aliases a
         join public.barcodes b on b.barcode_id=a.barcode_id
         join public.evacuees e on e.evacuee_id=b.evacuee_id
        where a.barcode_value=$1
          and b.status=''active''
          and e.approval_status=''approved''
        limit 1'
    into v_canonical,v_barcode_id,v_evacuee_id,v_group_id
    using v_input;
  end if;

  -- Unknown/invalid values continue through the installed verifier so its
  -- normal invalid-barcode response remains intact.
  if v_group_id is null then
    return public.scansafe_ops_scan_base(v_input)
      || jsonb_build_object(
        'duplicate_scan',false,
        'scan_state','not_checked_in',
        'arrival_time',null,
        'departure_time',null
      );
  end if;

  -- Serialize all scans for the same registration group.
  perform 1
  from public.evacuee_groups
  where group_id=v_group_id
  for update;

  select *
    into v_stay
  from public.scansafe_operation_stays
  where operation_id=v_operation
    and group_id=v_group_id
  for update;

  -- If already assigned in this operation, DO NOT call the legacy scan base.
  -- That prevents duplicate verification/assignment/occupancy.
  if found and v_stay.status='assigned' and v_stay.checked_in_at is not null then
    select e.* into v_evacuee
    from public.evacuees e
    where e.evacuee_id=v_evacuee_id;

    select b.* into v_barcode
    from public.barcodes b
    where b.barcode_id=v_barcode_id;

    select jsonb_build_object(
      'assignment_id',a.assignment_id,
      'group_id',a.group_id,
      'space_id',s.space_id,
      'space_code',s.space_code,
      'space_name',coalesce(s.space_name,s.space_code),
      'shelter_name',sh.shelter_name,
      'capacity',s.capacity,
      'current_occupancy',s.current_occupancy,
      'available',greatest(0,s.capacity-s.current_occupancy),
      'assigned_at',a.assigned_at
    )
    into v_assignment
    from public.accommodation_assignments a
    join public.accommodation_spaces s on s.space_id=a.space_id
    left join public.shelters sh on sh.shelter_id=s.shelter_id
    where a.group_id=v_group_id
      and a.assignment_status='active'
      and a.operation_id=v_operation
    order by a.assigned_at desc,a.assignment_id desc
    limit 1;

    perform public.log_scansafe_audit(
      'duplicate_checkin_blocked',
      'group',
      v_group_id::text,
      jsonb_build_object(
        'operation_id',v_operation,
        'evacuee_id',v_evacuee_id,
        'arrival_time',v_stay.checked_in_at,
        'barcode_input',v_input
      )
    );

    return jsonb_build_object(
      'valid',true,
      'result','duplicate',
      'duplicate_scan',true,
      'scan_state','already_checked_in',
      'message','Already checked in. Duplicate scan blocked; no new assignment or occupancy was created.',
      'evacuee_id',v_evacuee.evacuee_id,
      'group_id',v_group_id,
      'full_name',v_evacuee.full_name,
      'age',v_evacuee.age,
      'gender',v_evacuee.gender,
      'group_size',coalesce((select group_size from public.evacuee_groups where group_id=v_group_id),1),
      'approval_status',v_evacuee.approval_status,
      'current_status',v_evacuee.current_status,
      'needs_summary',to_jsonb(v_evacuee)->>'needs_summary',
      'address',v_evacuee.address,
      'contact_number',v_evacuee.contact_number,
      'qr_value',v_barcode.barcode_value,
      'scanned_barcode_value',v_input,
      'assignment_state','already_assigned',
      'assignment_message','Existing accommodation retained. This barcode is check-in only once per evacuation.',
      'assignment',v_assignment,
      'space_code',v_assignment->>'space_code',
      'space_name',v_assignment->>'space_name',
      'shelter_name',v_assignment->>'shelter_name',
      'arrival_time',v_stay.checked_in_at,
      'departure_time',null,
      'stay_status','assigned',
      'operation_id',v_operation
    );
  end if;

  if found and v_stay.status='released' then
    v_duration := case
      when v_stay.checked_in_at is null then null
      else greatest(0,extract(epoch from (coalesce(v_stay.released_at,now())-v_stay.checked_in_at))::bigint)
    end;

    select e.* into v_evacuee
    from public.evacuees e
    where e.evacuee_id=v_evacuee_id;

    perform public.log_scansafe_audit(
      'released_barcode_scan_blocked',
      'group',
      v_group_id::text,
      jsonb_build_object(
        'operation_id',v_operation,
        'arrival_time',v_stay.checked_in_at,
        'departure_time',v_stay.released_at,
        'barcode_input',v_input
      )
    );

    return jsonb_build_object(
      'valid',true,
      'result','released',
      'duplicate_scan',true,
      'scan_state','released',
      'message','This shelter stay has already been released. A released stay cannot be checked in again automatically.',
      'evacuee_id',v_evacuee.evacuee_id,
      'group_id',v_group_id,
      'full_name',v_evacuee.full_name,
      'age',v_evacuee.age,
      'gender',v_evacuee.gender,
      'approval_status',v_evacuee.approval_status,
      'current_status','released',
      'scanned_barcode_value',v_input,
      'assignment_state','released',
      'assignment',null,
      'arrival_time',v_stay.checked_in_at,
      'departure_time',v_stay.released_at,
      'stay_duration_seconds',v_duration,
      'stay_status','released',
      'operation_id',v_operation
    );
  end if;

  -- First scan: use the installed secure scanner + GBEAA logic.
  v_result := public.scansafe_ops_scan_base(v_input);

  -- Read the operation stay created by the assignment trigger.
  if coalesce((v_result->>'valid')::boolean,false)
     and (v_result->>'group_id') is not null then
    select *
      into v_stay
    from public.scansafe_operation_stays
    where operation_id=v_operation
      and group_id=(v_result->>'group_id')::bigint
    limit 1;

    if found and v_stay.status='assigned' then
      update public.scansafe_operation_stays
      set checked_in_at=coalesce(checked_in_at,now())
      where stay_id=v_stay.stay_id
      returning * into v_stay;

      update public.evacuees
      set current_status='accommodated'
      where group_id=v_stay.group_id
        and approval_status='approved'
        and current_status<>'released';

      perform public.log_scansafe_audit(
        'evacuee_checked_in',
        'group',
        v_stay.group_id::text,
        jsonb_build_object(
          'operation_id',v_operation,
          'arrival_time',v_stay.checked_in_at,
          'assignment_state',v_result->>'assignment_state'
        )
      );

      v_result := v_result || jsonb_build_object(
        'duplicate_scan',false,
        'scan_state','checked_in',
        'arrival_time',v_stay.checked_in_at,
        'departure_time',null,
        'stay_status','assigned',
        'operation_id',v_operation,
        'current_status','accommodated'
      );
    else
      v_result := v_result || jsonb_build_object(
        'duplicate_scan',false,
        'scan_state','verified',
        'arrival_time',null,
        'departure_time',null,
        'operation_id',v_operation
      );
    end if;
  end if;

  return v_result;
end;
$scan$;

revoke all on function public.scan_and_assign_evacuee(text)
from public,anon,authenticated;
grant execute on function public.scan_and_assign_evacuee(text)
to authenticated;


-- ------------------------------------------------------------
-- Preserve the installed release implementation as a private base.
-- ------------------------------------------------------------
do $release_base$
begin
  if to_regprocedure('public.scansafe_lifecycle_release_base(bigint)') is null then
    alter function public.release_group_assignment(bigint)
      rename to scansafe_lifecycle_release_base;
  end if;
end;
$release_base$;

revoke all on function public.scansafe_lifecycle_release_base(bigint)
from public,anon,authenticated;


-- Staff/admin release with reason + lifecycle summary.
create or replace function public.release_scansafe_group(
  p_group_id bigint,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $release$
declare
  v_reason text := btrim(coalesce(p_reason,''));
  v_result jsonb;
  v_stay public.scansafe_operation_stays%rowtype;
  v_assignment public.accommodation_assignments%rowtype;
  v_space text;
  v_shelter text;
  v_duration bigint;
  v_recipient uuid;
begin
  if auth.uid() is null or not coalesce(public.is_staff(),false) then
    raise exception using errcode='42501', message='Staff access is required';
  end if;

  if length(v_reason) not between 1 and 500 then
    raise exception 'A release reason is required (1-500 characters)';
  end if;

  perform 1
  from public.evacuee_groups
  where group_id=p_group_id
  for update;

  if not found then
    raise exception 'Evacuee group was not found';
  end if;

  select *
    into v_assignment
  from public.accommodation_assignments
  where group_id=p_group_id
    and assignment_status='active'
  order by assigned_at desc,assignment_id desc
  limit 1
  for update;

  if not found then
    raise exception 'This evacuee/group has no active accommodation to release';
  end if;

  -- Existing operation-safe release logic closes assignment and occupancy.
  v_result := public.scansafe_lifecycle_release_base(p_group_id);

  select *
    into v_stay
  from public.scansafe_operation_stays
  where operation_id=v_assignment.operation_id
    and group_id=p_group_id
  limit 1;

  select coalesce(s.space_name,s.space_code),sh.shelter_name
    into v_space,v_shelter
  from public.accommodation_spaces s
  left join public.shelters sh on sh.shelter_id=s.shelter_id
  where s.space_id=v_assignment.space_id;

  v_duration := case
    when v_stay.checked_in_at is null then null
    else greatest(0,extract(epoch from (coalesce(v_stay.released_at,now())-v_stay.checked_in_at))::bigint)
  end;

  for v_recipient in
    select distinct e.auth_user_id
    from public.evacuees e
    where e.group_id=p_group_id
      and e.auth_user_id is not null
  loop
    insert into public.notifications(
      created_by,recipient_id,title,message,
      notification_level,status,audience,category
    )
    values(
      auth.uid(),
      v_recipient,
      'Shelter stay released',
      'Your shelter stay has ended. Departure time: '||
        to_char(coalesce(v_stay.released_at,now()),'Mon DD, YYYY HH12:MI AM')||
        case when v_space is not null then '. Previous space: '||v_space else '' end||
        '. Your ScanSafe account and history remain available.',
      'info','active','specific','accommodation'
    );
  end loop;

  perform public.log_scansafe_audit(
    'evacuee_released',
    'group',
    p_group_id::text,
    jsonb_build_object(
      'operation_id',v_assignment.operation_id,
      'assignment_id',v_assignment.assignment_id,
      'reason',v_reason,
      'arrival_time',v_stay.checked_in_at,
      'departure_time',v_stay.released_at,
      'stay_duration_seconds',v_duration,
      'previous_space',v_space
    )
  );

  return coalesce(v_result,'{}'::jsonb) || jsonb_build_object(
    'released',true,
    'group_id',p_group_id,
    'operation_id',v_assignment.operation_id,
    'assignment_id',v_assignment.assignment_id,
    'reason',v_reason,
    'arrival_time',v_stay.checked_in_at,
    'departure_time',v_stay.released_at,
    'stay_duration_seconds',v_duration,
    'previous_space',v_space,
    'shelter_name',v_shelter,
    'status','released'
  );
end;
$release$;

revoke all on function public.release_scansafe_group(bigint,text)
from public,anon,authenticated;
grant execute on function public.release_scansafe_group(bigint,text)
to authenticated;

-- Keep compatibility for older UI/manual release calls.
create or replace function public.release_group_assignment(p_group_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $compat$
begin
  return public.release_scansafe_group(
    p_group_id,
    'Released by authorized shelter staff.'
  );
end;
$compat$;

revoke all on function public.release_group_assignment(bigint)
from public,anon,authenticated;
grant execute on function public.release_group_assignment(bigint)
to authenticated;


-- ------------------------------------------------------------
-- Staff/Admin on-demand shelter-stay detail
-- ------------------------------------------------------------
create or replace function public.get_scansafe_staff_group_stay(p_group_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $staff_stay$
declare
  v_row public.scansafe_operation_stays%rowtype;
  v_space text;
  v_shelter text;
  v_duration bigint;
begin
  if auth.uid() is null or not coalesce(public.is_staff(),false) then
    raise exception using errcode='42501',message='Staff access is required';
  end if;

  select st.*
    into v_row
  from public.scansafe_operation_stays st
  where st.group_id=p_group_id
  order by st.admitted_at desc,st.stay_id desc
  limit 1;

  if not found then
    return null;
  end if;

  select coalesce(s.space_name,s.space_code),sh.shelter_name
    into v_space,v_shelter
  from public.accommodation_assignments a
  join public.accommodation_spaces s on s.space_id=a.space_id
  left join public.shelters sh on sh.shelter_id=s.shelter_id
  where a.operation_id=v_row.operation_id
    and a.group_id=p_group_id
  order by a.assigned_at desc,a.assignment_id desc
  limit 1;

  v_duration := case
    when v_row.checked_in_at is null then null
    else greatest(
      0,
      extract(epoch from (coalesce(v_row.released_at,now())-v_row.checked_in_at))::bigint
    )
  end;

  return jsonb_build_object(
    'operation_id',v_row.operation_id,
    'group_id',p_group_id,
    'stay_status',v_row.status,
    'arrival_time',v_row.checked_in_at,
    'departure_time',v_row.released_at,
    'stay_duration_seconds',v_duration,
    'space_name',v_space,
    'shelter_name',v_shelter
  );
end;
$staff_stay$;

revoke all on function public.get_scansafe_staff_group_stay(bigint)
from public,anon,authenticated;
grant execute on function public.get_scansafe_staff_group_stay(bigint)
to authenticated;


-- ------------------------------------------------------------
-- Evacuee-owned shelter-stay snapshot
-- ------------------------------------------------------------
create or replace function public.get_my_scansafe_stay()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth
as $stay$
declare
  v_uid uuid := auth.uid();
  v_group_id bigint;
  v_status text;
  v_row public.scansafe_operation_stays%rowtype;
  v_operation_name text;
  v_space text;
  v_shelter text;
  v_assignment_status text;
  v_duration bigint;
begin
  if v_uid is null then
    raise exception using errcode='42501',message='Sign in to view your shelter stay';
  end if;

  select e.group_id,e.current_status
    into v_group_id,v_status
  from public.evacuees e
  where e.auth_user_id=v_uid
  order by e.evacuee_id desc
  limit 1;

  if v_group_id is null then
    return null;
  end if;

  select st.*
    into v_row
  from public.scansafe_operation_stays st
  where st.group_id=v_group_id
  order by st.admitted_at desc,st.stay_id desc
  limit 1;

  if not found then
    return null;
  end if;

  select o.name
    into v_operation_name
  from public.scansafe_operations o
  where o.operation_id=v_row.operation_id;

  select
    coalesce(s.space_name,s.space_code),
    sh.shelter_name,
    a.assignment_status
  into v_space,v_shelter,v_assignment_status
  from public.accommodation_assignments a
  join public.accommodation_spaces s on s.space_id=a.space_id
  left join public.shelters sh on sh.shelter_id=s.shelter_id
  where a.operation_id=v_row.operation_id
    and a.group_id=v_group_id
  order by a.assigned_at desc,a.assignment_id desc
  limit 1;

  v_duration := case
    when v_row.checked_in_at is null then null
    else greatest(
      0,
      extract(epoch from (coalesce(v_row.released_at,now())-v_row.checked_in_at))::bigint
    )
  end;

  return jsonb_build_object(
    'operation_id',v_row.operation_id,
    'operation_name',v_operation_name,
    'group_id',v_group_id,
    'stay_status',v_row.status,
    'account_status',v_status,
    'arrival_time',v_row.checked_in_at,
    'departure_time',v_row.released_at,
    'stay_duration_seconds',v_duration,
    'space_name',v_space,
    'shelter_name',v_shelter,
    'assignment_status',v_assignment_status
  );
end;
$stay$;

revoke all on function public.get_my_scansafe_stay()
from public,anon,authenticated;
grant execute on function public.get_my_scansafe_stay()
to authenticated;

notify pgrst,'reload schema';
commit;
