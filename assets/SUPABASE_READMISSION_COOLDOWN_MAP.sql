-- ============================================================
-- ScanSafe Readmission Cooldown + Stay History + Map Occupants
-- Run AFTER:
--   1. SUPABASE_EVACUATION_OPERATIONS.sql
--   2. SUPABASE_CHECKIN_RELEASE_LIFECYCLE.sql
--
-- User-facing lifecycle:
-- Approved / Ready -> Accommodated / Checked In -> Released / Cooldown
-- -> Ready for Readmission (after 12 hours)
--
-- Previous shelter stays are preserved. No account, barcode, assignment,
-- scan log, notification, or registration history is deleted.
-- ============================================================

rollback;
begin;

do $preflight$
begin
  if to_regclass('public.scansafe_operation_stays') is null
     or to_regprocedure('public.scan_and_assign_evacuee(text)') is null
     or to_regprocedure('public.release_scansafe_group(bigint,text)') is null
     or to_regprocedure('public.get_my_scansafe_stay()') is null
     or to_regprocedure('public.get_scansafe_staff_group_stay(bigint)') is null
     or to_regprocedure('public.readmit_scansafe_group(bigint,text)') is null then
    raise exception 'Run SUPABASE_EVACUATION_OPERATIONS.sql and SUPABASE_CHECKIN_RELEASE_LIFECYCLE.sql before this patch.';
  end if;
  if not exists(
    select 1 from information_schema.columns
    where table_schema='public' and table_name='scansafe_operation_stays' and column_name='checked_in_at'
  ) then
    raise exception 'The check-in lifecycle patch is incomplete: scansafe_operation_stays.checked_in_at is missing.';
  end if;
end;
$preflight$;

-- Completed stays are archived here before the reusable current-stay row is
-- reset for another admission in the same evacuation operation.
create table if not exists public.scansafe_stay_history (
  history_id bigint generated always as identity primary key,
  source_stay_id bigint not null,
  operation_id bigint not null references public.scansafe_operations(operation_id),
  group_id bigint not null references public.evacuee_groups(group_id),
  group_size integer not null check(group_size>0),
  full_name text not null,
  members jsonb not null,
  arrival_time timestamptz,
  departure_time timestamptz not null,
  duration_seconds bigint,
  space_code text,
  space_name text,
  shelter_name text,
  release_reason text,
  archived_at timestamptz not null default now(),
  unique(source_stay_id,departure_time)
);
create index if not exists scansafe_stay_history_group_departure
  on public.scansafe_stay_history(group_id,departure_time desc);

alter table public.scansafe_stay_history enable row level security;
revoke all on public.scansafe_stay_history from public,anon,authenticated;
grant select on public.scansafe_stay_history to authenticated;

drop policy if exists scansafe_staff_stay_history_read on public.scansafe_stay_history;
create policy scansafe_staff_stay_history_read
on public.scansafe_stay_history for select to authenticated
using(coalesce(public.is_staff(),false));

drop policy if exists scansafe_owner_stay_history_read on public.scansafe_stay_history;
create policy scansafe_owner_stay_history_read
on public.scansafe_stay_history for select to authenticated
using(exists(
  select 1 from public.evacuees e
  where e.group_id=scansafe_stay_history.group_id
    and e.auth_user_id=auth.uid()
));

-- Preserve already-released stays from earlier testing/installations.
insert into public.scansafe_stay_history(
  source_stay_id,operation_id,group_id,group_size,full_name,members,
  arrival_time,departure_time,duration_seconds,space_code,space_name,shelter_name,
  release_reason
)
select
  st.stay_id,st.operation_id,st.group_id,st.group_size,st.full_name,st.members,
  st.checked_in_at,st.released_at,
  case when st.checked_in_at is null then null
       else greatest(0,extract(epoch from (st.released_at-st.checked_in_at))::bigint) end,
  assignment.space_code,assignment.space_name,assignment.shelter_name,
  'Completed shelter stay'
from public.scansafe_operation_stays st
left join lateral(
  select
    coalesce(a.space_snapshot->>'space_code',s.space_code) as space_code,
    coalesce(a.space_snapshot->>'space_name',s.space_name,s.space_code) as space_name,
    coalesce(a.space_snapshot->>'shelter_name',sh.shelter_name) as shelter_name
  from public.accommodation_assignments a
  join public.accommodation_spaces s on s.space_id=a.space_id
  left join public.shelters sh on sh.shelter_id=s.shelter_id
  where a.operation_id=st.operation_id and a.group_id=st.group_id
  order by coalesce(a.completed_at,a.assigned_at) desc,a.assignment_id desc
  limit 1
) assignment on true
where st.status='released' and st.released_at is not null
on conflict(source_stay_id,departure_time) do nothing;

-- ------------------------------------------------------------------
-- Keep the one-time check-in lifecycle as a private base, then add the
-- 12-hour readmission state around it.
-- ------------------------------------------------------------------
do $scan_base$
begin
  if to_regprocedure('public.scansafe_readmission_scan_base(text)') is null then
    alter function public.scan_and_assign_evacuee(text)
      rename to scansafe_readmission_scan_base;
  end if;
end;
$scan_base$;
revoke all on function public.scansafe_readmission_scan_base(text)
from public,anon,authenticated;

create or replace function public.scan_and_assign_evacuee(p_barcode_value text)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $scan$
declare
  v_input text:=btrim(coalesce(p_barcode_value,''));
  v_canonical text;
  v_barcode_id bigint;
  v_evacuee public.evacuees%rowtype;
  v_barcode public.barcodes%rowtype;
  v_stay public.scansafe_operation_stays%rowtype;
  v_history public.scansafe_stay_history%rowtype;
  v_remaining bigint;
  v_duration bigint;
  v_result jsonb;
begin
  if auth.uid() is null or not coalesce(public.is_staff(),false) then
    raise exception using errcode='42501',message='Staff access is required';
  end if;
  if v_input='' then raise exception 'A barcode value is required'; end if;

  select b.barcode_id
    into v_barcode_id
  from public.barcodes b
  join public.evacuees e on e.evacuee_id=b.evacuee_id
  where b.barcode_value=v_input
    and b.status='active'
    and e.approval_status='approved'
  limit 1;

  if v_barcode_id is null
     and to_regclass('public.scansafe_barcode_aliases') is not null then
    execute
      'select b.barcode_id
         from public.scansafe_barcode_aliases a
         join public.barcodes b on b.barcode_id=a.barcode_id
         join public.evacuees e on e.evacuee_id=b.evacuee_id
        where a.barcode_value=$1
          and b.status=''active''
          and e.approval_status=''approved''
        limit 1'
      into v_barcode_id
      using v_input;
  end if;

  if v_barcode_id is not null then
    select * into v_barcode
    from public.barcodes
    where barcode_id=v_barcode_id;

    select * into v_evacuee
    from public.evacuees
    where evacuee_id=v_barcode.evacuee_id;
  end if;

  if found and lower(coalesce(v_evacuee.current_status,''))='released' then
    select * into v_stay
    from public.scansafe_operation_stays
    where group_id=v_evacuee.group_id and status='released' and released_at is not null
    order by released_at desc,stay_id desc
    limit 1;

    if found then
      v_remaining:=greatest(0,43200-extract(epoch from (now()-v_stay.released_at))::bigint);
      v_duration:=case when v_stay.checked_in_at is null then null
        else greatest(0,extract(epoch from (v_stay.released_at-v_stay.checked_in_at))::bigint) end;

      select * into v_history
      from public.scansafe_stay_history
      where group_id=v_evacuee.group_id
      order by departure_time desc,history_id desc
      limit 1;

      perform public.log_scansafe_audit(
        case when v_remaining=0 then 'readmission_ready_scan' else 'released_cooldown_scan' end,
        'group',v_evacuee.group_id::text,
        jsonb_build_object('evacuee_id',v_evacuee.evacuee_id,'barcode_input',v_input,
          'departure_time',v_stay.released_at,'cooldown_remaining_seconds',v_remaining)
      );

      return jsonb_build_object(
        'valid',true,
        'result',case when v_remaining=0 then 'ready_for_readmission' else 'recently_released' end,
        'duplicate_scan',true,
        'scan_state',case when v_remaining=0 then 'ready_for_readmission' else 'recently_released' end,
        'message',case when v_remaining=0
          then 'Previous shelter stay completed. Staff may confirm a new shelter stay.'
          else 'Previous shelter stay was released recently. Readmission becomes available after the 12-hour cooldown.' end,
        'evacuee_id',v_evacuee.evacuee_id,
        'group_id',v_evacuee.group_id,
        'full_name',v_evacuee.full_name,
        'age',v_evacuee.age,
        'gender',v_evacuee.gender,
        'group_size',coalesce(v_evacuee.group_size,1),
        'approval_status',v_evacuee.approval_status,
        'current_status',case when v_remaining=0 then 'ready_for_readmission' else 'released' end,
        'needs_summary',to_jsonb(v_evacuee)->>'needs_summary',
        'address',v_evacuee.address,
        'contact_number',v_evacuee.contact_number,
        'qr_value',v_barcode.barcode_value,
        'scanned_barcode_value',v_input,
        'assignment_state','released',
        'assignment',null,
        'arrival_time',v_stay.checked_in_at,
        'departure_time',v_stay.released_at,
        'stay_duration_seconds',v_duration,
        'stay_status','released',
        'readmission_ready',(v_remaining=0),
        'cooldown_hours',12,
        'cooldown_remaining_seconds',v_remaining,
        'cooldown_until',v_stay.released_at+interval '12 hours',
        'previous_space',coalesce(v_history.space_name,v_history.space_code),
        'operation_id',v_stay.operation_id
      );
    end if;
  end if;

  v_result:=public.scansafe_readmission_scan_base(v_input);
  if v_result ? 'assignment_message' then
    v_result:=jsonb_set(v_result,'{assignment_message}',
      to_jsonb(replace(coalesce(v_result->>'assignment_message',''),'GBEAA','Automatic accommodation assignment')),
      true);
  end if;
  return v_result;
end;
$scan$;
revoke all on function public.scan_and_assign_evacuee(text) from public,anon,authenticated;
grant execute on function public.scan_and_assign_evacuee(text) to authenticated;

-- Staff confirmation after the 12-hour cooldown. This keeps the prior stay in
-- history, resets only the reusable current-stay row, and then performs a new
-- automatic check-in/assignment using current shelter conditions.
create or replace function public.confirm_scansafe_readmission(p_barcode_value text)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $readmit$
declare
  v_input text:=btrim(coalesce(p_barcode_value,''));
  v_canonical text;
  v_barcode_id bigint;
  v_evacuee public.evacuees%rowtype;
  v_barcode public.barcodes%rowtype;
  v_stay public.scansafe_operation_stays%rowtype;
  v_assignment public.accommodation_assignments%rowtype;
  v_operation bigint;
  v_duration bigint;
  v_space_code text;
  v_space_name text;
  v_shelter text;
  v_result jsonb;
begin
  if auth.uid() is null or not coalesce(public.is_staff(),false) then
    raise exception using errcode='42501',message='Staff access is required';
  end if;
  if v_input='' then raise exception 'A barcode value is required'; end if;

  select b.barcode_id
    into v_barcode_id
  from public.barcodes b
  join public.evacuees e on e.evacuee_id=b.evacuee_id
  where b.barcode_value=v_input
    and b.status='active'
    and e.approval_status='approved'
  limit 1;

  if v_barcode_id is null
     and to_regclass('public.scansafe_barcode_aliases') is not null then
    execute
      'select b.barcode_id
         from public.scansafe_barcode_aliases a
         join public.barcodes b on b.barcode_id=a.barcode_id
         join public.evacuees e on e.evacuee_id=b.evacuee_id
        where a.barcode_value=$1
          and b.status=''active''
          and e.approval_status=''approved''
        limit 1'
      into v_barcode_id
      using v_input;
  end if;

  if v_barcode_id is null then
    raise exception 'Approved active barcode not found';
  end if;

  select * into v_barcode
  from public.barcodes
  where barcode_id=v_barcode_id;

  select * into v_evacuee
  from public.evacuees
  where evacuee_id=v_barcode.evacuee_id;

  perform 1 from public.evacuee_groups where group_id=v_evacuee.group_id for update;
  v_operation:=public.scansafe_operations_current();

  select * into v_stay
  from public.scansafe_operation_stays
  where group_id=v_evacuee.group_id and status='released' and released_at is not null
  order by released_at desc,stay_id desc
  limit 1
  for update;
  if not found then raise exception 'No released shelter stay was found for readmission'; end if;
  if now()<v_stay.released_at+interval '12 hours' then
    raise exception 'Readmission is not available until the 12-hour cooldown is complete';
  end if;
  if exists(select 1 from public.accommodation_assignments where group_id=v_evacuee.group_id and assignment_status='active') then
    raise exception 'This registration already has an active accommodation assignment';
  end if;

  select * into v_assignment
  from public.accommodation_assignments
  where operation_id=v_stay.operation_id and group_id=v_evacuee.group_id
  order by coalesce(completed_at,assigned_at) desc,assignment_id desc
  limit 1;
  if found then
    select s.space_code,coalesce(s.space_name,s.space_code),sh.shelter_name
      into v_space_code,v_space_name,v_shelter
    from public.accommodation_spaces s
    left join public.shelters sh on sh.shelter_id=s.shelter_id
    where s.space_id=v_assignment.space_id;
  end if;
  v_duration:=case when v_stay.checked_in_at is null then null
    else greatest(0,extract(epoch from (v_stay.released_at-v_stay.checked_in_at))::bigint) end;

  insert into public.scansafe_stay_history(
    source_stay_id,operation_id,group_id,group_size,full_name,members,
    arrival_time,departure_time,duration_seconds,space_code,space_name,shelter_name,
    release_reason
  ) values(
    v_stay.stay_id,v_stay.operation_id,v_stay.group_id,v_stay.group_size,v_stay.full_name,v_stay.members,
    v_stay.checked_in_at,v_stay.released_at,v_duration,v_space_code,v_space_name,v_shelter,
    'Completed before readmission'
  ) on conflict(source_stay_id,departure_time) do nothing;

  -- Same active evacuation: reuse the current operation row while preserving the
  -- completed stay in scansafe_stay_history. A different active evacuation uses
  -- the installed operation readmission function.
  if v_stay.operation_id=v_operation then
    update public.scansafe_operation_stays
    set status='admitted',admitted_at=now(),checked_in_at=null,released_at=null,
        group_size=coalesce((select group_size from public.evacuee_groups where group_id=v_evacuee.group_id),v_stay.group_size),
        full_name=coalesce((select full_name from public.evacuees where group_id=v_evacuee.group_id order by evacuee_id limit 1),v_stay.full_name),
        members=public.scansafe_operations_members(v_evacuee.group_id)
    where stay_id=v_stay.stay_id;
    update public.evacuees set current_status='registered'
      where group_id=v_evacuee.group_id and approval_status='approved';
  else
    perform public.readmit_scansafe_group(v_evacuee.group_id,'12-hour cooldown completed; readmission confirmed at barcode scanner.');
  end if;

  perform public.log_scansafe_audit('readmission_confirmed','group',v_evacuee.group_id::text,
    jsonb_build_object('previous_operation_id',v_stay.operation_id,'current_operation_id',v_operation,
      'previous_departure_time',v_stay.released_at,'barcode_input',v_input));

  v_canonical:=v_barcode.barcode_value;
  v_result:=public.scansafe_readmission_scan_base(v_canonical);
  return v_result || jsonb_build_object(
    'readmission_confirmed',true,
    'previous_departure_time',v_stay.released_at,
    'message','Readmission confirmed. A new shelter stay has started and accommodation was assigned automatically.'
  );
end;
$readmit$;
revoke all on function public.confirm_scansafe_readmission(text) from public,anon,authenticated;
grant execute on function public.confirm_scansafe_readmission(text) to authenticated;

-- ------------------------------------------------------------------
-- Archive every controlled release and return cooldown metadata.
-- ------------------------------------------------------------------
do $release_base$
begin
  if to_regprocedure('public.scansafe_readmission_release_base(bigint,text)') is null then
    alter function public.release_scansafe_group(bigint,text)
      rename to scansafe_readmission_release_base;
  end if;
end;
$release_base$;
revoke all on function public.scansafe_readmission_release_base(bigint,text)
from public,anon,authenticated;

create or replace function public.release_scansafe_group(p_group_id bigint,p_reason text)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $release$
declare
  v_result jsonb;
  v_stay public.scansafe_operation_stays%rowtype;
  v_assignment public.accommodation_assignments%rowtype;
  v_duration bigint;
  v_space_code text;
  v_space_name text;
  v_shelter text;
begin
  v_result:=public.scansafe_readmission_release_base(p_group_id,p_reason);

  select * into v_stay from public.scansafe_operation_stays
  where group_id=p_group_id and status='released' and released_at is not null
  order by released_at desc,stay_id desc limit 1;
  if not found then return v_result; end if;

  select * into v_assignment from public.accommodation_assignments
  where operation_id=v_stay.operation_id and group_id=p_group_id
  order by coalesce(completed_at,assigned_at) desc,assignment_id desc limit 1;
  if found then
    select s.space_code,coalesce(s.space_name,s.space_code),sh.shelter_name
      into v_space_code,v_space_name,v_shelter
    from public.accommodation_spaces s left join public.shelters sh on sh.shelter_id=s.shelter_id
    where s.space_id=v_assignment.space_id;
  end if;
  v_duration:=case when v_stay.checked_in_at is null then null
    else greatest(0,extract(epoch from (v_stay.released_at-v_stay.checked_in_at))::bigint) end;

  insert into public.scansafe_stay_history(
    source_stay_id,operation_id,group_id,group_size,full_name,members,
    arrival_time,departure_time,duration_seconds,space_code,space_name,shelter_name,
    release_reason
  ) values(
    v_stay.stay_id,v_stay.operation_id,v_stay.group_id,v_stay.group_size,v_stay.full_name,v_stay.members,
    v_stay.checked_in_at,v_stay.released_at,v_duration,v_space_code,v_space_name,v_shelter,btrim(coalesce(p_reason,''))
  ) on conflict(source_stay_id,departure_time) do update
      set release_reason=excluded.release_reason,space_code=excluded.space_code,
          space_name=excluded.space_name,shelter_name=excluded.shelter_name,
          duration_seconds=excluded.duration_seconds;

  return coalesce(v_result,'{}'::jsonb) || jsonb_build_object(
    'cooldown_hours',12,
    'cooldown_until',v_stay.released_at+interval '12 hours',
    'readmission_ready',false,
    'cooldown_remaining_seconds',43200
  );
end;
$release$;
revoke all on function public.release_scansafe_group(bigint,text) from public,anon,authenticated;
grant execute on function public.release_scansafe_group(bigint,text) to authenticated;

-- ------------------------------------------------------------------
-- Evacuee and staff shelter-stay snapshots with cooldown/history.
-- ------------------------------------------------------------------
do $my_stay_base$
begin
  if to_regprocedure('public.scansafe_readmission_my_stay_base()') is null then
    alter function public.get_my_scansafe_stay()
      rename to scansafe_readmission_my_stay_base;
  end if;
end;
$my_stay_base$;
revoke all on function public.scansafe_readmission_my_stay_base()
from public,anon,authenticated;

create or replace function public.get_my_scansafe_stay()
returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog,public,auth
as $my$
declare
  v_uid uuid:=auth.uid();
  v_group bigint;
  v_current jsonb;
  v_previous jsonb;
  v_departure timestamptz;
  v_remaining bigint:=0;
  v_ready boolean:=false;
begin
  if v_uid is null then raise exception using errcode='42501',message='Sign in to view your shelter stay'; end if;
  select group_id into v_group from public.evacuees where auth_user_id=v_uid order by evacuee_id desc limit 1;
  if v_group is null then return null; end if;

  v_current:=public.scansafe_readmission_my_stay_base();
  select jsonb_build_object(
    'history_id',h.history_id,'operation_id',h.operation_id,'arrival_time',h.arrival_time,
    'departure_time',h.departure_time,'stay_duration_seconds',h.duration_seconds,
    'space_name',coalesce(h.space_name,h.space_code),'shelter_name',h.shelter_name,
    'release_reason',h.release_reason,'status','completed'
  ) into v_previous
  from public.scansafe_stay_history h
  where h.group_id=v_group
  order by h.departure_time desc,h.history_id desc limit 1;

  if v_current is not null and v_current->>'stay_status'='released' and v_current->>'departure_time' is not null then
    v_departure:=(v_current->>'departure_time')::timestamptz;
    v_remaining:=greatest(0,43200-extract(epoch from (now()-v_departure))::bigint);
    v_ready:=v_remaining=0;
  end if;

  return coalesce(v_current,'{}'::jsonb) || jsonb_build_object(
    'readmission_ready',v_ready,
    'cooldown_hours',12,
    'cooldown_remaining_seconds',v_remaining,
    'cooldown_until',case when v_departure is null then null else v_departure+interval '12 hours' end,
    'display_status',case
      when v_ready then 'ready_for_readmission'
      when v_current->>'stay_status'='released' then 'released_cooldown'
      when v_current->>'arrival_time' is not null then 'accommodated'
      else 'approved_ready' end,
    'previous_stay',v_previous
  );
end;
$my$;
revoke all on function public.get_my_scansafe_stay() from public,anon,authenticated;
grant execute on function public.get_my_scansafe_stay() to authenticated;

do $staff_stay_base$
begin
  if to_regprocedure('public.scansafe_readmission_staff_stay_base(bigint)') is null then
    alter function public.get_scansafe_staff_group_stay(bigint)
      rename to scansafe_readmission_staff_stay_base;
  end if;
end;
$staff_stay_base$;
revoke all on function public.scansafe_readmission_staff_stay_base(bigint)
from public,anon,authenticated;

create or replace function public.get_scansafe_staff_group_stay(p_group_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog,public
as $staff$
declare
  v_current jsonb;
  v_previous jsonb;
  v_departure timestamptz;
  v_remaining bigint:=0;
  v_ready boolean:=false;
begin
  if auth.uid() is null or not coalesce(public.is_staff(),false) then
    raise exception using errcode='42501',message='Staff access is required';
  end if;
  v_current:=public.scansafe_readmission_staff_stay_base(p_group_id);
  select jsonb_build_object(
    'history_id',h.history_id,'operation_id',h.operation_id,'arrival_time',h.arrival_time,
    'departure_time',h.departure_time,'stay_duration_seconds',h.duration_seconds,
    'space_name',coalesce(h.space_name,h.space_code),'shelter_name',h.shelter_name,
    'release_reason',h.release_reason,'status','completed'
  ) into v_previous from public.scansafe_stay_history h
  where h.group_id=p_group_id order by h.departure_time desc,h.history_id desc limit 1;
  if v_current is not null and v_current->>'stay_status'='released' and v_current->>'departure_time' is not null then
    v_departure:=(v_current->>'departure_time')::timestamptz;
    v_remaining:=greatest(0,43200-extract(epoch from (now()-v_departure))::bigint);
    v_ready:=v_remaining=0;
  end if;
  return coalesce(v_current,'{}'::jsonb) || jsonb_build_object(
    'readmission_ready',v_ready,'cooldown_hours',12,'cooldown_remaining_seconds',v_remaining,
    'cooldown_until',case when v_departure is null then null else v_departure+interval '12 hours' end,
    'display_status',case when v_ready then 'ready_for_readmission'
      when v_current->>'stay_status'='released' then 'released_cooldown'
      when v_current->>'arrival_time' is not null then 'accommodated' else 'approved_ready' end,
    'previous_stay',v_previous
  );
end;
$staff$;
revoke all on function public.get_scansafe_staff_group_stay(bigint) from public,anon,authenticated;
grant execute on function public.get_scansafe_staff_group_stay(bigint) to authenticated;

-- Live map occupants: one marker per checked-in registration group. Released
-- groups disappear automatically because their assignment is no longer active.
create or replace function public.get_scansafe_space_occupants()
returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog,public
as $occupants$
declare v_result jsonb;
begin
  if auth.uid() is null or not coalesce(public.is_staff(),false) then
    raise exception using errcode='42501',message='Staff access is required';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'space_code',q.space_code,
    'space_name',q.space_name,
    'group_id',q.group_id,
    'evacuee_id',q.evacuee_id,
    'full_name',q.full_name,
    'group_size',q.group_size,
    'arrival_time',q.arrival_time,
    'current_status',q.current_status
  ) order by q.space_code,q.full_name,q.group_id),'[]'::jsonb)
  into v_result
  from (
    select
      s.space_code,
      coalesce(s.space_name,s.space_code) as space_name,
      a.group_id,
      e.evacuee_id,
      e.full_name,
      coalesce(g.group_size,a.occupant_count,1) as group_size,
      st.checked_in_at as arrival_time,
      e.current_status
    from public.accommodation_assignments a
    join public.accommodation_spaces s on s.space_id=a.space_id
    join public.evacuee_groups g on g.group_id=a.group_id
    join lateral(
      select ev.* from public.evacuees ev
      where ev.group_id=a.group_id
      order by ev.evacuee_id limit 1
    ) e on true
    join lateral(
      select x.* from public.scansafe_operation_stays x
      where x.group_id=a.group_id and x.status='assigned' and x.checked_in_at is not null
      order by x.checked_in_at desc,x.stay_id desc limit 1
    ) st on true
    where a.assignment_status='active'
  ) q;
  return v_result;
end;
$occupants$;
revoke all on function public.get_scansafe_space_occupants() from public,anon,authenticated;
grant execute on function public.get_scansafe_space_occupants() to authenticated;

notify pgrst,'reload schema';
commit;
