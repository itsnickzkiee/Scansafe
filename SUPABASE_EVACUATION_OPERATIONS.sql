-- ScanSafe: evacuation operation closure, occupancy reconciliation and repeat stays.
-- Run this ENTIRE file LAST, after LIVE_SYNC, SCANNER_GBEAA, SHORT_BARCODE and
-- NEEDS_REQUESTS. No accounts, barcodes, spaces or history are deleted.
-- Installing adopts real active assignments; it does NOT close an evacuation.
rollback;
begin;

do $preflight$
begin
  if to_regprocedure('public.scan_and_assign_evacuee(text)') is null
     or to_regprocedure('public.assign_group_gbeaa(bigint)') is null
     or to_regprocedure('public.assign_group_to_space(bigint,text)') is null
     or to_regprocedure('public.submit_scansafe_need_request(jsonb,text,text,uuid)') is null
     or to_regprocedure('public.update_scansafe_need_request(bigint,text,text,integer)') is null
     or to_regprocedure('public.log_scansafe_audit(text,text,text,jsonb)') is null then
    raise exception 'Run the existing ScanSafe setup, scanner and needs-request fixes before SUPABASE_EVACUATION_OPERATIONS.sql';
  end if;
end;
$preflight$;

create table if not exists public.scansafe_operations (
  operation_id bigint generated always as identity primary key,
  name text not null check(length(btrim(name)) between 1 and 120),
  status text not null default 'active' check(status in ('active','closed')),
  opened_at timestamptz not null default now(),
  opened_by uuid,
  start_token uuid unique,
  closed_at timestamptz,
  closed_by uuid,
  close_reason text,
  close_revision text,
  summary jsonb,
  check((status='closed') = (closed_at is not null and closed_by is not null))
);
create unique index if not exists scansafe_one_active_operation
  on public.scansafe_operations((true)) where status='active';

create table if not exists public.scansafe_operation_stays (
  stay_id bigint generated always as identity primary key,
  operation_id bigint not null references public.scansafe_operations,
  group_id bigint not null references public.evacuee_groups,
  group_size integer not null check(group_size>0),
  full_name text not null,
  members jsonb not null,
  status text not null check(status in ('admitted','assigned','released')),
  admitted_at timestamptz not null default now(),
  released_at timestamptz,
  unique(operation_id,group_id)
);

alter table public.accommodation_assignments
  add column if not exists operation_id bigint references public.scansafe_operations,
  add column if not exists occupant_count integer check(occupant_count>0),
  add column if not exists space_snapshot jsonb,
  add column if not exists completed_at timestamptz;
alter table public.need_requests
  add column if not exists operation_id bigint references public.scansafe_operations;
create index if not exists scansafe_assignments_operation on public.accommodation_assignments(operation_id,assignment_status);
create index if not exists scansafe_needs_operation on public.need_requests(operation_id,status);

-- Extend only the allowed-status check; retain provided-at/by invariants and
-- the requirement to explain unavailable requests.
do $status_check$
declare v_constraint text;
begin
  for v_constraint in select conname from pg_constraint
    where conrelid='public.need_requests'::regclass and contype='c'
      and pg_get_constraintdef(oid) like '%pending%'
      and pg_get_constraintdef(oid) like '%preparing%'
  loop
    execute format('alter table public.need_requests drop constraint %I',v_constraint);
  end loop;
end;
$status_check$;
alter table public.need_requests add constraint scansafe_need_request_status_check
  check(status in ('pending','preparing','ready_for_pickup','for_delivery','provided','unavailable','cancelled'));

alter table public.scansafe_operations enable row level security;
alter table public.scansafe_operation_stays enable row level security;
revoke all on public.scansafe_operations,public.scansafe_operation_stays from public,anon,authenticated;
grant select on public.scansafe_operations,public.scansafe_operation_stays to authenticated;
create or replace function public.scansafe_operations_is_admin()
returns boolean language sql stable security definer set search_path=pg_catalog,public
as $is_admin$
  select auth.uid() is not null and exists(select 1 from public.profiles p where p.id=auth.uid() and p.role='admin');
$is_admin$;
revoke all on function public.scansafe_operations_is_admin() from public,anon,authenticated;
grant execute on function public.scansafe_operations_is_admin() to authenticated;
drop policy if exists scansafe_admin_operations on public.scansafe_operations;
create policy scansafe_admin_operations on public.scansafe_operations for select to authenticated
  using(public.scansafe_operations_is_admin());
drop policy if exists scansafe_admin_stays on public.scansafe_operation_stays;
create policy scansafe_admin_stays on public.scansafe_operation_stays for select to authenticated
  using(public.scansafe_operations_is_admin());

create or replace function public.scansafe_operations_admin()
returns void language plpgsql security definer set search_path=pg_catalog,public
as $admin$
begin
  if auth.uid() is null or not exists(select 1 from public.profiles where id=auth.uid() and role='admin') then
    raise exception using errcode='42501',message='Administrator access is required to manage evacuation operations';
  end if;
end;
$admin$;
revoke all on function public.scansafe_operations_admin() from public,anon,authenticated;

-- Ordinary workflows share this lock. Start/close/reconcile take the exclusive
-- version BEFORE any group, evacuee, assignment or space row is locked.
create or replace function public.scansafe_operations_current()
returns bigint language plpgsql security definer set search_path=pg_catalog,public
as $current$
declare v_id bigint;
begin
  perform pg_advisory_xact_lock_shared(1363433499::bigint);
  select operation_id into v_id from public.scansafe_operations where status='active';
  if v_id is null then
    raise exception using errcode='P5503',message='No active evacuation operation. An administrator must start an operation before assigning accommodation.';
  end if;
  return v_id;
end;
$current$;
revoke all on function public.scansafe_operations_current() from public,anon,authenticated;

create or replace function public.scansafe_operations_members(p_group_id bigint)
returns jsonb language sql stable security definer set search_path=pg_catalog,public
as $members$
  select coalesce(jsonb_agg(jsonb_build_object('evacuee_id',e.evacuee_id,
    'full_name',e.full_name,'auth_user_id',e.auth_user_id,'approval_status',e.approval_status,
    'current_status',e.current_status) order by e.evacuee_id),'[]'::jsonb)
  from public.evacuees e where e.group_id=p_group_id;
$members$;
revoke all on function public.scansafe_operations_members(bigint) from public,anon,authenticated;

create or replace function public.scansafe_operations_group(p_group_id bigint)
returns bigint language plpgsql security definer set search_path=pg_catalog,public
as $group$
declare v_operation bigint:=public.scansafe_operations_current();
begin
  if exists(select 1 from public.scansafe_operation_stays
    where operation_id=v_operation and group_id=p_group_id and status='released')
    or exists(select 1 from public.evacuees where group_id=p_group_id
      and approval_status='approved' and lower(replace(coalesce(current_status,''),'-','_'))='released') then
    raise exception 'This group has been released. Use Readmit Group for a new operation before assigning again.';
  end if;
  if not exists(select 1 from public.evacuees e join public.barcodes b on b.evacuee_id=e.evacuee_id
    where e.group_id=p_group_id and e.approval_status='approved' and b.status='active') then
    raise exception 'An approved registration and active barcode are required for assignment';
  end if;
  return v_operation;
end;
$group$;
revoke all on function public.scansafe_operations_group(bigint) from public,anon,authenticated;

-- Adopt existing real occupants once. Earlier completed/transferred records
-- stay unlabelled legacy history rather than being guessed into an operation.
do $adopt$
declare v_operation bigint;
begin
  perform pg_advisory_xact_lock(1363433499::bigint);
  select operation_id into v_operation from public.scansafe_operations where status='active';
  if v_operation is null and (exists(select 1 from public.accommodation_assignments where assignment_status='active')
    or exists(select 1 from public.need_requests where status in ('pending','preparing','ready_for_pickup','for_delivery'))) then
    insert into public.scansafe_operations(name) values('Current evacuation') returning operation_id into v_operation;
  end if;
  if v_operation is not null then
    update public.accommodation_assignments a set operation_id=v_operation,
      occupant_count=coalesce(a.occupant_count,g.group_size),
      space_snapshot=(select jsonb_build_object('space_code',s.space_code,'space_name',coalesce(s.space_name,s.space_code),
        'shelter_name',sh.shelter_name) from public.accommodation_spaces s left join public.shelters sh on sh.shelter_id=s.shelter_id where s.space_id=a.space_id)
    from public.evacuee_groups g where g.group_id=a.group_id and a.assignment_status='active' and a.operation_id is null;
    if exists(select 1 from public.accommodation_assignments where assignment_status='active'
      and (occupant_count is null or occupant_count<1)) then
      raise exception 'Repair active assignment group sizes before installing evacuation operations';
    end if;
    insert into public.scansafe_operation_stays(operation_id,group_id,group_size,full_name,members,status,admitted_at)
    select v_operation,a.group_id,a.occupant_count,
      coalesce((select e.full_name from public.evacuees e where e.group_id=a.group_id order by e.evacuee_id limit 1),'Evacuee group'),
      public.scansafe_operations_members(a.group_id),'assigned',coalesce(a.assigned_at,now())
    from public.accommodation_assignments a where a.operation_id=v_operation and a.assignment_status='active'
    on conflict(operation_id,group_id) do nothing;
    update public.need_requests set operation_id=v_operation
    where operation_id is null and status in ('pending','preparing','ready_for_pickup','for_delivery');
  end if;
end;
$adopt$;

-- Direct client mutations cannot skip the public RPC's lifecycle lock order.
revoke insert,update,delete on public.accommodation_assignments from public,authenticated,anon;

create or replace function public.scansafe_operations_assignment()
returns trigger language plpgsql security definer set search_path=pg_catalog,public
as $assignment$
declare v_operation bigint; v_size integer;
begin
  if tg_op='UPDATE' then
    if new.operation_id is distinct from old.operation_id or new.occupant_count is distinct from old.occupant_count
      or new.space_snapshot is distinct from old.space_snapshot
      or new.group_id is distinct from old.group_id or new.space_id is distinct from old.space_id then
      raise exception 'Assignment history is immutable. Use a new assignment for a transfer.';
    end if;
    if new.assignment_status='active' and old.assignment_status is distinct from 'active' then
      raise exception 'A completed assignment cannot be reactivated. Create a new stay.';
    end if;
    if old.assignment_status='active' and new.assignment_status is distinct from 'active' then
      new.completed_at:=coalesce(new.completed_at,now());
    end if;
    return new;
  end if;
  if new.assignment_status is distinct from 'active' then return new; end if;
  v_operation:=public.scansafe_operations_group(new.group_id);
  select group_size into v_size from public.evacuee_groups where group_id=new.group_id;
  if coalesce(v_size,0)<1 then raise exception 'A positive group size is required'; end if;
  if new.operation_id is not null and new.operation_id<>v_operation then raise exception 'The operation changed. Refresh before assigning.'; end if;
  new.operation_id:=v_operation; new.occupant_count:=v_size;
  select jsonb_build_object('space_code',s.space_code,'space_name',coalesce(s.space_name,s.space_code),
    'shelter_name',sh.shelter_name) into new.space_snapshot
  from public.accommodation_spaces s left join public.shelters sh on sh.shelter_id=s.shelter_id where s.space_id=new.space_id;
  insert into public.scansafe_operation_stays(operation_id,group_id,group_size,full_name,members,status)
  values(v_operation,new.group_id,v_size,
    coalesce((select full_name from public.evacuees where group_id=new.group_id order by evacuee_id limit 1),'Evacuee group'),
    public.scansafe_operations_members(new.group_id),'assigned')
  on conflict(operation_id,group_id) do update set status='assigned',
    group_size=case when scansafe_operation_stays.status='admitted' then excluded.group_size else scansafe_operation_stays.group_size end,
    members=case when scansafe_operation_stays.status='admitted' then excluded.members else scansafe_operation_stays.members end
    where public.scansafe_operation_stays.status<>'released';
  return new;
end;
$assignment$;
revoke all on function public.scansafe_operations_assignment() from public,anon,authenticated;
drop trigger if exists scansafe_operations_assignment on public.accommodation_assignments;
create trigger scansafe_operations_assignment before insert or update on public.accommodation_assignments
for each row execute function public.scansafe_operations_assignment();

create or replace function public.scansafe_operations_need()
returns trigger language plpgsql security definer set search_path=pg_catalog,public
as $need$
declare v_operation bigint:=public.scansafe_operations_current();
begin
  if not exists(select 1 from public.accommodation_assignments a where a.assignment_id=new.assignment_id
    and a.group_id=new.group_id and a.assignment_status='active' and a.operation_id=v_operation) then
    raise exception 'A current active accommodation assignment is required to request needs';
  end if;
  new.operation_id:=v_operation;
  return new;
end;
$need$;
revoke all on function public.scansafe_operations_need() from public,anon,authenticated;
drop trigger if exists scansafe_operations_need on public.need_requests;
create trigger scansafe_operations_need before insert on public.need_requests
for each row execute function public.scansafe_operations_need();

-- Keep installed GBEAA, alias resolution, verification and audit code intact.
-- Private bases are never executable by authenticated/anonymous clients.
do $bases$
declare v_spec text[]; v_signature text; v_base text;
begin
  foreach v_spec slice 1 in array array[
    array['assign_group_to_space(bigint,text)','scansafe_ops_manual_base'],
    array['assign_group_gbeaa(bigint)','scansafe_ops_gbeaa_base'],
    array['scan_and_assign_evacuee(text)','scansafe_ops_scan_base'],
    array['submit_scansafe_need_request(jsonb,text,text,uuid)','scansafe_ops_submit_base'],
    array['update_scansafe_need_request(bigint,text,text,integer)','scansafe_ops_update_need_base'],
    array['transfer_group_assignment(bigint,text)','scansafe_ops_transfer_base']
  ] loop
    v_signature:=v_spec[1];v_base:=v_spec[2];
    if to_regprocedure('public.'||v_signature) is not null
      and to_regprocedure('public.'||v_base||substring(v_signature from '\(.*$')) is null then
      execute format('alter function public.%s rename to %I',v_signature,v_base);
    end if;
    if to_regprocedure('public.'||v_base||substring(v_signature from '\(.*$')) is not null then
      execute format('revoke all on function public.%I%s from public,anon,authenticated',v_base,substring(v_signature from '\(.*$'));
    end if;
  end loop;
end;
$bases$;

create or replace function public.assign_group_to_space(p_group_id bigint,p_space_code text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $manual$
begin
  if auth.uid() is null or not coalesce(public.is_staff(),false) then raise exception using errcode='42501',message='Staff access is required'; end if;
  perform public.scansafe_operations_group(p_group_id);
  return public.scansafe_ops_manual_base(p_group_id,p_space_code);
end;
$manual$;
create or replace function public.assign_group_gbeaa(p_group_id bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $gbeaa$
begin
  if auth.uid() is null or not coalesce(public.is_staff(),false) then raise exception using errcode='42501',message='Staff access is required'; end if;
  perform public.scansafe_operations_group(p_group_id);
  return public.scansafe_ops_gbeaa_base(p_group_id);
end;
$gbeaa$;
create or replace function public.scan_and_assign_evacuee(p_barcode_value text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $scan$
begin
  if auth.uid() is null or not coalesce(public.is_staff(),false) then raise exception using errcode='42501',message='Staff access is required'; end if;
  perform public.scansafe_operations_current();
  return public.scansafe_ops_scan_base(p_barcode_value);
end;
$scan$;
create or replace function public.submit_scansafe_need_request(p_items jsonb,p_notes text,p_priority text,p_client_token uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $submit$
begin
  perform pg_advisory_xact_lock_shared(1363433499::bigint);
  return public.scansafe_ops_submit_base(p_items,p_notes,p_priority,p_client_token);
end;
$submit$;
create or replace function public.update_scansafe_need_request(p_request_id bigint,p_status text,p_response text,p_expected_version integer)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $update_need$
begin
  perform pg_advisory_xact_lock_shared(1363433499::bigint);
  return public.scansafe_ops_update_need_base(p_request_id,p_status,p_response,p_expected_version);
end;
$update_need$;

create or replace function public.scansafe_operations_recalculate()
returns integer language plpgsql security definer set search_path=pg_catalog,public
as $calculate$
declare v_changed integer;
begin
  if exists(select 1 from public.accommodation_assignments where assignment_status='active'
    and (occupant_count is null or occupant_count<1)) then
    raise exception 'An active assignment has an invalid occupancy snapshot. Staff must repair it.';
  end if;
  with expected as (
    select s.space_id,coalesce(sum(a.occupant_count) filter(where a.assignment_status='active'),0)::integer as occupied
    from public.accommodation_spaces s left join public.accommodation_assignments a on a.space_id=s.space_id
    group by s.space_id
  ), changed as (
    update public.accommodation_spaces s set current_occupancy=e.occupied from expected e
    where s.space_id=e.space_id and s.current_occupancy is distinct from e.occupied returning s.space_id
  ) select count(*) into v_changed from changed;
  return v_changed;
end;
$calculate$;
revoke all on function public.scansafe_operations_recalculate() from public,anon,authenticated;

create or replace function public.reconcile_scansafe_occupancy()
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $reconcile$
declare v_changed integer;
begin
  perform public.scansafe_operations_admin();
  perform pg_advisory_xact_lock(1363433499::bigint);
  v_changed:=public.scansafe_operations_recalculate();
  perform public.log_scansafe_audit('occupancy_reconciled','system','accommodation_spaces',jsonb_build_object('spaces_updated',v_changed));
  return jsonb_build_object('reconciled',true,'spaces_updated',v_changed,'reconciled_at',now());
end;
$reconcile$;

-- Also fix individual releases, using the immutable assignment population.
create or replace function public.release_group_assignment(p_group_id bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $release$
declare v_assignment public.accommodation_assignments%rowtype;
begin
  if auth.uid() is null or not coalesce(public.is_staff(),false) then raise exception using errcode='42501',message='Staff access is required'; end if;
  perform public.scansafe_operations_current();
  perform 1 from public.evacuee_groups where group_id=p_group_id for update;
  select * into v_assignment from public.accommodation_assignments where group_id=p_group_id and assignment_status='active' for update;
  if not found then raise exception 'Active assignment not found'; end if;
  update public.accommodation_assignments set assignment_status='completed',completed_at=now() where assignment_id=v_assignment.assignment_id;
  update public.evacuees set current_status='released' where group_id=p_group_id;
  update public.scansafe_operation_stays set status='released',released_at=now()
    where operation_id=v_assignment.operation_id and group_id=p_group_id;
  -- Limit recalculation to this locked space so unrelated normal assignments
  -- remain concurrent and cannot be overwritten by an old aggregate snapshot.
  perform 1 from public.accommodation_spaces where space_id=v_assignment.space_id for update;
  update public.accommodation_spaces s set current_occupancy=coalesce((select sum(a.occupant_count)
    from public.accommodation_assignments a where a.space_id=s.space_id and a.assignment_status='active'),0)
  where s.space_id=v_assignment.space_id;
  perform public.log_scansafe_audit('accommodation_released','group',p_group_id::text,
    jsonb_build_object('assignment_id',v_assignment.assignment_id,'operation_id',v_assignment.operation_id,'group_size',v_assignment.occupant_count));
  return jsonb_build_object('released',true,'group_id',p_group_id,'assignment_id',v_assignment.assignment_id);
end;
$release$;

-- Optional Phase 9 transfers keep their installed behavior, under the same
-- operation boundary. Missing Phase 9 transfers do not prevent installation.
do $transfer$
begin
  if to_regprocedure('public.scansafe_ops_transfer_base(bigint,text)') is not null then
    execute $definition$
      create or replace function public.transfer_group_assignment(p_group_id bigint,p_new_space_code text)
      returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $body$
      begin
        if auth.uid() is null or not coalesce(public.is_staff(),false) then raise exception using errcode='42501',message='Staff access is required'; end if;
        perform public.scansafe_operations_group(p_group_id);
        perform 1 from public.evacuee_groups where group_id=p_group_id for update;
        perform 1 from public.accommodation_assignments where group_id=p_group_id and assignment_status='active' for update;
        perform 1 from public.accommodation_spaces s where s.space_id in
          (select a.space_id from public.accommodation_assignments a where a.group_id=p_group_id and a.assignment_status='active')
          or (upper(s.space_code)=upper(btrim(p_new_space_code)) and s.is_primary=true and s.status<>'inactive')
          order by s.space_id for update;
        if exists(select 1 from public.accommodation_assignments a join public.evacuee_groups g on g.group_id=a.group_id
          where a.group_id=p_group_id and a.assignment_status='active' and a.occupant_count is distinct from g.group_size) then
          raise exception 'Group size changed during this stay. Staff must review the group before transfer.';
        end if;
        return public.scansafe_ops_transfer_base(p_group_id,p_new_space_code);
      end;
      $body$;
    $definition$;
    revoke all on function public.transfer_group_assignment(bigint,text) from public,anon,authenticated;
    grant execute on function public.transfer_group_assignment(bigint,text) to authenticated;
  end if;
end;
$transfer$;

create or replace function public.scansafe_operations_summary(p_operation_id bigint)
returns jsonb language sql stable security definer set search_path=pg_catalog,public
as $summary$
  select jsonb_build_object(
    'groups',(select count(*) from public.accommodation_assignments where operation_id=p_operation_id and assignment_status='active'),
    'people',(select coalesce(sum(occupant_count),0) from public.accommodation_assignments where operation_id=p_operation_id and assignment_status='active'),
    'evacuees',(select count(*) from public.evacuees e where exists(select 1 from public.scansafe_operation_stays st
      where st.operation_id=p_operation_id and st.group_id=e.group_id and st.status in ('admitted','assigned'))),
    'pending_requests',(select count(*) from public.need_requests where operation_id=p_operation_id and status in ('pending','preparing','ready_for_pickup','for_delivery')),
    'occupied',(select coalesce(sum(current_occupancy),0) from public.accommodation_spaces),
    'capacity',(select coalesce(sum(capacity),0) from public.accommodation_spaces where status<>'inactive'),
    'spaces',(select count(*) from public.accommodation_spaces),
    'discrepancies',(select count(*) from public.accommodation_spaces s where s.current_occupancy is distinct from
      (select coalesce(sum(a.occupant_count),0)::integer from public.accommodation_assignments a where a.space_id=s.space_id and a.assignment_status='active'))
  );
$summary$;
revoke all on function public.scansafe_operations_summary(bigint) from public,anon,authenticated;

create or replace function public.scansafe_operations_revision(p_operation_id bigint)
returns text language sql stable security definer set search_path=pg_catalog,public
as $revision$
  select md5(jsonb_build_object('operation',(select to_jsonb(o) from public.scansafe_operations o where operation_id=p_operation_id),
    'assignments',(select jsonb_agg(to_jsonb(a) order by a.assignment_id) from public.accommodation_assignments a where operation_id=p_operation_id),
    'stays',(select jsonb_agg(to_jsonb(st) order by st.stay_id) from public.scansafe_operation_stays st where operation_id=p_operation_id),
    'requests',(select jsonb_agg(jsonb_build_array(r.request_id,r.status,r.version,r.updated_at) order by r.request_id) from public.need_requests r where operation_id=p_operation_id),
    'members',(select jsonb_agg(jsonb_build_array(e.evacuee_id,e.group_id,e.current_status,e.approval_status) order by e.evacuee_id)
      from public.evacuees e where exists(select 1 from public.scansafe_operation_stays st where st.operation_id=p_operation_id and st.group_id=e.group_id)),
    'occupancy',(select jsonb_agg(jsonb_build_array(s.space_id,s.capacity,s.current_occupancy,s.status) order by s.space_id) from public.accommodation_spaces s))::text);
$revision$;
revoke all on function public.scansafe_operations_revision(bigint) from public,anon,authenticated;

create or replace function public.get_scansafe_operations()
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $get$
declare v_operation public.scansafe_operations%rowtype; v_history jsonb; v_groups jsonb;
begin
  perform public.scansafe_operations_admin();
  perform pg_advisory_xact_lock_shared(1363433499::bigint);
  select * into v_operation from public.scansafe_operations where status='active';
  select coalesce(jsonb_agg((to_jsonb(o)-'start_token'-'close_revision')||jsonb_build_object('stays',
    (select coalesce(jsonb_agg(jsonb_build_object('group_id',st.group_id,'full_name',st.full_name,
      'group_size',st.group_size,'admitted_at',st.admitted_at,'released_at',st.released_at,'status',st.status,
      'assignments',(select coalesce(jsonb_agg(jsonb_build_object('assignment_id',a.assignment_id,
        'space_code',coalesce(a.space_snapshot->>'space_code',sp.space_code),
        'space_name',coalesce(a.space_snapshot->>'space_name',sp.space_name,sp.space_code),'assigned_at',a.assigned_at,
        'completed_at',a.completed_at,'assignment_status',a.assignment_status) order by a.assignment_id),'[]'::jsonb)
        from public.accommodation_assignments a join public.accommodation_spaces sp on sp.space_id=a.space_id
        where a.operation_id=o.operation_id and a.group_id=st.group_id),
      'requests',(select coalesce(jsonb_agg(jsonb_build_object('request_id',r.request_id,'status',r.status) order by r.request_id),'[]'::jsonb)
        from public.need_requests r where r.operation_id=o.operation_id and r.group_id=st.group_id)) order by st.stay_id),'[]'::jsonb)
     from public.scansafe_operation_stays st where st.operation_id=o.operation_id)) order by o.closed_at desc,o.operation_id desc),'[]'::jsonb)
    into v_history from public.scansafe_operations o where o.status='closed';
  select coalesce(jsonb_agg(jsonb_build_object('group_id',g.group_id,'group_name',st.full_name,
    'full_name',st.full_name,'group_size',g.group_size,'last_operation_name',o.name) order by st.full_name,g.group_id),'[]'::jsonb)
    into v_groups from public.evacuee_groups g
    join lateral(select s.* from public.scansafe_operation_stays s join public.scansafe_operations op on op.operation_id=s.operation_id
      where s.group_id=g.group_id and op.status='closed' order by op.closed_at desc,s.stay_id desc limit 1) st on true
    join public.scansafe_operations o on o.operation_id=st.operation_id
    where v_operation.operation_id is not null
      and not exists(select 1 from public.scansafe_operation_stays s where s.operation_id=v_operation.operation_id and s.group_id=g.group_id)
      and exists(select 1 from public.evacuees e join public.barcodes b on b.evacuee_id=e.evacuee_id
        where e.group_id=g.group_id and e.current_status='released' and e.approval_status='approved' and b.status='active');
  return jsonb_build_object('owner_id',auth.uid(),'mode','admin',
    'current_operation',case when v_operation.operation_id is null then null else to_jsonb(v_operation)-'start_token'-'close_revision' end,
    'history',v_history,'summary',public.scansafe_operations_summary(v_operation.operation_id),'readmission_groups',v_groups);
end;
$get$;

create or replace function public.start_scansafe_operation(p_name text,p_client_token uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $start$
declare v_operation public.scansafe_operations%rowtype; v_name text:=btrim(coalesce(p_name,'')); v_reconciled integer;
begin
  perform public.scansafe_operations_admin();
  if length(v_name) not between 1 and 120 or p_client_token is null then raise exception 'An operation name (1-120 characters) and retry token are required'; end if;
  perform pg_advisory_xact_lock(1363433499::bigint);
  select * into v_operation from public.scansafe_operations where start_token=p_client_token;
  if found then
    if v_operation.opened_by is distinct from auth.uid() or v_operation.name<>v_name then raise exception 'This retry token belongs to another operation'; end if;
    return to_jsonb(v_operation)-'start_token'-'close_revision';
  end if;
  if exists(select 1 from public.scansafe_operations where status='active') then raise exception 'Close the current evacuation operation before starting another'; end if;
  if exists(select 1 from public.accommodation_assignments where assignment_status='active') then raise exception 'There are unclosed active assignments. Review the existing operation first'; end if;
  v_reconciled:=public.scansafe_operations_recalculate();
  insert into public.scansafe_operations(name,opened_by,start_token) values(v_name,auth.uid(),p_client_token) returning * into v_operation;
  perform public.log_scansafe_audit('evacuation_started','operation',v_operation.operation_id::text,jsonb_build_object('name',v_name,'spaces_reconciled',v_reconciled));
  return to_jsonb(v_operation)-'start_token'-'close_revision';
end;
$start$;

create or replace function public.preview_close_scansafe_operation(p_operation_id bigint)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $preview$
declare v_operation public.scansafe_operations%rowtype;
begin
  perform public.scansafe_operations_admin();
  perform pg_advisory_xact_lock(1363433499::bigint);
  select * into v_operation from public.scansafe_operations where operation_id=p_operation_id and status='active';
  if not found then raise exception 'The active evacuation operation could not be found'; end if;
  return jsonb_build_object('operation_id',p_operation_id,'name',v_operation.name,
    'revision',public.scansafe_operations_revision(p_operation_id),'summary',public.scansafe_operations_summary(p_operation_id));
end;
$preview$;

create or replace function public.close_scansafe_operation(p_operation_id bigint,p_expected_revision text,
  p_confirm_text text,p_reason text,p_cancel_pending boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $close$
declare
  v_operation public.scansafe_operations%rowtype;
  v_before jsonb; v_summary jsonb; v_request public.need_requests%rowtype;
  v_cancelled integer:=0; v_recipient uuid; v_actor text;
  v_reason text:=btrim(coalesce(p_reason,''));
begin
  perform public.scansafe_operations_admin();
  if btrim(coalesce(p_confirm_text,''))<>'CLOSE' then raise exception 'Type CLOSE to confirm that all assigned people have departed'; end if;
  if length(v_reason) not between 1 and 1000 then raise exception 'A closure reason (1-1000 characters) is required'; end if;
  perform pg_advisory_xact_lock(1363433499::bigint);
  select * into v_operation from public.scansafe_operations where operation_id=p_operation_id for update;
  if not found then raise exception 'Evacuation operation not found'; end if;
  if v_operation.status='closed' then
    if v_operation.close_revision=p_expected_revision then
      return to_jsonb(v_operation)-'start_token'-'close_revision';
    end if;
    raise exception using errcode='40001',message='This operation was already closed. Refresh its history.';
  end if;
  if p_expected_revision is null or p_expected_revision<>public.scansafe_operations_revision(p_operation_id) then
    raise exception using errcode='40001',message='Assignments, requests or occupancy changed. Review a new close summary before confirming.';
  end if;
  v_before:=public.scansafe_operations_summary(p_operation_id);
  if (v_before->>'pending_requests')::bigint>0 and not coalesce(p_cancel_pending,false) then
    raise exception 'Resolve pending needs first, or explicitly confirm cancellation with the closure reason';
  end if;
  select coalesce(nullif(full_name,''),'Administrator') into v_actor from public.profiles where id=auth.uid();
  for v_request in select r.* from public.need_requests r where r.operation_id=p_operation_id
    and r.status in ('pending','preparing','ready_for_pickup','for_delivery') order by r.request_id for update
  loop
    update public.need_requests set status='cancelled',response=v_reason,version=version+1,updated_at=now()
      where request_id=v_request.request_id;
    insert into public.need_request_events(request_id,from_status,to_status,response,actor_id,actor_name)
      values(v_request.request_id,v_request.status,'cancelled',v_reason,auth.uid(),coalesce(v_actor,'Administrator'));
    insert into public.notifications(created_by,recipient_id,title,message,notification_level,status,audience,category)
      values(auth.uid(),v_request.owner_id,'Needs Request #'||v_request.request_id||' Cancelled',
        'The evacuation operation has closed. Your unresolved request was cancelled: '||v_reason,'info','active','specific','system');
    perform public.log_scansafe_audit('need_request_cancelled','need_request',v_request.request_id::text,
      jsonb_build_object('operation_id',p_operation_id,'reason',v_reason,'from_status',v_request.status));
    v_cancelled:=v_cancelled+1;
  end loop;
  update public.accommodation_assignments set assignment_status='completed',completed_at=now()
    where operation_id=p_operation_id and assignment_status='active';
  update public.evacuees e set current_status='released'
    where exists(select 1 from public.scansafe_operation_stays st
      where st.operation_id=p_operation_id and st.group_id=e.group_id and st.status in ('admitted','assigned'));
  update public.scansafe_operation_stays set status='released',released_at=coalesce(released_at,now()) where operation_id=p_operation_id;
  perform public.scansafe_operations_recalculate();
  select jsonb_build_object('groups',count(*),'people',coalesce(sum(group_size),0),
    'evacuees',coalesce(sum(jsonb_array_length(members)),0),'cancelled_requests',v_cancelled,
    'released_groups',(v_before->>'groups')::bigint,'released_people',(v_before->>'people')::bigint,
    'occupied_after',(select coalesce(sum(current_occupancy),0) from public.accommodation_spaces))
    into v_summary from public.scansafe_operation_stays where operation_id=p_operation_id;
  update public.scansafe_operations set status='closed',closed_at=now(),closed_by=auth.uid(),
    close_reason=v_reason,close_revision=p_expected_revision,summary=v_summary
    where operation_id=p_operation_id returning * into v_operation;
  for v_recipient in select distinct e.auth_user_id from public.evacuees e join public.profiles p on p.id=e.auth_user_id
    where exists(select 1 from public.scansafe_operation_stays st where st.operation_id=p_operation_id and st.group_id=e.group_id)
  loop
    insert into public.notifications(created_by,recipient_id,title,message,notification_level,status,audience,category)
      values(auth.uid(),v_recipient,'Evacuation stay ended',
        v_operation.name||' has closed. Your accommodation assignment has ended. Your account and records have been kept.',
        'info','active','specific','accommodation');
  end loop;
  perform public.log_scansafe_audit('evacuation_closed','operation',p_operation_id::text,v_summary||jsonb_build_object('reason',v_reason));
  return to_jsonb(v_operation)-'start_token'-'close_revision';
end;
$close$;

create or replace function public.readmit_scansafe_group(p_group_id bigint,p_reason text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $readmit$
declare v_operation bigint; v_size integer; v_reason text:=btrim(coalesce(p_reason,''));
begin
  perform public.scansafe_operations_admin();
  if length(v_reason) not between 1 and 1000 then raise exception 'A readmission reason is required (1-1000 characters)'; end if;
  v_operation:=public.scansafe_operations_current();
  select group_size into v_size from public.evacuee_groups where group_id=p_group_id for update;
  if not found or coalesce(v_size,0)<1 then raise exception 'A valid group is required'; end if;
  if exists(select 1 from public.scansafe_operation_stays where operation_id=v_operation and group_id=p_group_id) then
    raise exception 'This group has already been admitted or released in this operation';
  end if;
  if not exists(select 1 from public.scansafe_operation_stays st join public.scansafe_operations o on o.operation_id=st.operation_id
    where st.group_id=p_group_id and o.status='closed') then raise exception 'This group has no previous closed evacuation stay'; end if;
  if not exists(select 1 from public.evacuees e join public.barcodes b on b.evacuee_id=e.evacuee_id
    where e.group_id=p_group_id and e.approval_status='approved' and e.current_status='released' and b.status='active') then
    raise exception 'A released approved registration with an active barcode is required';
  end if;
  if exists(select 1 from public.accommodation_assignments where group_id=p_group_id and assignment_status='active') then
    raise exception 'This group already has an active assignment';
  end if;
  insert into public.scansafe_operation_stays(operation_id,group_id,group_size,full_name,members,status)
    values(v_operation,p_group_id,v_size,
      coalesce((select full_name from public.evacuees where group_id=p_group_id order by evacuee_id limit 1),'Evacuee group'),
      public.scansafe_operations_members(p_group_id),'admitted');
  update public.evacuees set current_status='registered' where group_id=p_group_id and approval_status='approved' and current_status='released';
  perform public.log_scansafe_audit('evacuation_group_readmitted','group',p_group_id::text,
    jsonb_build_object('operation_id',v_operation,'reason',v_reason,'group_size',v_size));
  return jsonb_build_object('readmitted',true,'group_id',p_group_id,'operation_id',v_operation);
end;
$readmit$;

-- Count cancellation separately, never as provided/unavailable or active.
do $count_base$
begin
  if to_regprocedure('public.scansafe_ops_counts_base()') is null then
    alter function public.get_scansafe_need_request_counts() rename to scansafe_ops_counts_base;
  end if;
end;
$count_base$;
revoke all on function public.scansafe_ops_counts_base() from public,anon,authenticated;
create or replace function public.get_scansafe_need_request_counts()
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public
as $counts$
declare v_counts jsonb:=public.scansafe_ops_counts_base(); v_cancelled bigint;
begin
  select count(*) into v_cancelled from public.need_requests
    where status='cancelled' and (v_counts->>'mode'='staff' or owner_id=auth.uid());
  return v_counts||jsonb_build_object('cancelled',v_cancelled);
end;
$counts$;

revoke all on function public.assign_group_to_space(bigint,text),public.assign_group_gbeaa(bigint),
  public.scan_and_assign_evacuee(text),public.submit_scansafe_need_request(jsonb,text,text,uuid),
  public.update_scansafe_need_request(bigint,text,text,integer),public.release_group_assignment(bigint),
  public.reconcile_scansafe_occupancy(),public.get_scansafe_operations(),
  public.start_scansafe_operation(text,uuid),public.preview_close_scansafe_operation(bigint),
  public.close_scansafe_operation(bigint,text,text,text,boolean),public.readmit_scansafe_group(bigint,text),
  public.get_scansafe_need_request_counts() from public,anon,authenticated;
grant execute on function public.assign_group_to_space(bigint,text),public.assign_group_gbeaa(bigint),
  public.scan_and_assign_evacuee(text),public.submit_scansafe_need_request(jsonb,text,text,uuid),
  public.update_scansafe_need_request(bigint,text,text,integer),public.release_group_assignment(bigint),
  public.reconcile_scansafe_occupancy(),public.get_scansafe_operations(),
  public.start_scansafe_operation(text,uuid),public.preview_close_scansafe_operation(bigint),
  public.close_scansafe_operation(bigint,text,text,text,boolean),public.readmit_scansafe_group(bigint,text),
  public.get_scansafe_need_request_counts() to authenticated;

notify pgrst,'reload schema';
commit;
