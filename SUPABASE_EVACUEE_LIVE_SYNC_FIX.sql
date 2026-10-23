-- ScanSafe: authenticated evacuee account synchronization and real barcodes.
-- Run this entire file in Supabase SQL Editor after the existing Phase 9 setup.
-- This file does not sign in users, guess account links, or match by email.
-- All statements, including backfill, roll back together if a schema constraint
-- fails. The original Phase 1 table definitions are not included in this repo.

begin;

-- Keep the existing approval audit behavior. Fail before changing anything when
-- the expected Phase 9 audit helper has not been installed.
do $preflight$
begin
  if to_regprocedure('public.log_scansafe_audit(text,text,text,jsonb)') is null then
    raise exception 'Apply the ScanSafe Phase 9 security/audit setup before this migration';
  end if;
end;
$preflight$;

-- The account RPC is read-only and derives ownership exclusively from auth.uid().
-- to_jsonb(table_row) tolerates optional fields such as birth_date being absent.
create or replace function public.get_my_scansafe_account()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $account$
declare
  v_uid uuid := auth.uid();
  v_evacuee public.evacuees%rowtype;
  v_barcode public.barcodes%rowtype;
  v_assignment public.accommodation_assignments%rowtype;
  v_space public.accommodation_spaces%rowtype;
  v_shelter public.shelters%rowtype;
  v_barcode_json jsonb := null;
  v_assignment_json jsonb := null;
  v_space_json jsonb := null;
  v_shelter_json jsonb := null;
begin
  if v_uid is null then
    raise exception using errcode = '42501', message = 'Sign in to view your ScanSafe account';
  end if;

  select e.* into v_evacuee
  from public.evacuees e
  where e.auth_user_id = v_uid
  order by e.evacuee_id desc
  limit 1;

  if not found then
    return jsonb_build_object(
      'evacuee', null, 'barcode', null, 'assignment', null,
      'space', null, 'shelter', null
    );
  end if;

  if v_evacuee.approval_status = 'approved' then
    select b.* into v_barcode
    from public.barcodes b
    where b.evacuee_id = v_evacuee.evacuee_id
      and b.status = 'active'
    limit 1;
    if found then v_barcode_json := to_jsonb(v_barcode); end if;
  end if;

  if v_evacuee.group_id is not null then
    select a.* into v_assignment
    from public.accommodation_assignments a
    where a.group_id = v_evacuee.group_id
      and a.assignment_status = 'active'
    order by a.assigned_at desc nulls last
    limit 1;

    if found then
      v_assignment_json := to_jsonb(v_assignment);
      select sp.* into v_space
      from public.accommodation_spaces sp
      where sp.space_id = v_assignment.space_id;
      if found then
        v_space_json := to_jsonb(v_space);
        select sh.* into v_shelter
        from public.shelters sh
        where sh.shelter_id = v_space.shelter_id;
        if found then v_shelter_json := to_jsonb(v_shelter); end if;
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'evacuee', to_jsonb(v_evacuee), 'barcode', v_barcode_json,
    'assignment', v_assignment_json, 'space', v_space_json,
    'shelter', v_shelter_json
  );
end;
$account$;

revoke all on function public.get_my_scansafe_account() from public, anon, authenticated;
grant execute on function public.get_my_scansafe_account() to authenticated;

-- Compatibility for authenticated clients that still read these tables.
-- Policies add only owned SELECT access and preserve existing staff/admin rules.
-- The ownership checks do not join evacuee_groups or form recursive policies.
alter table public.evacuees enable row level security;
alter table public.barcodes enable row level security;
alter table public.accommodation_assignments enable row level security;

drop policy if exists scansafe_evacuee_read_own_account on public.evacuees;
create policy scansafe_evacuee_read_own_account
on public.evacuees for select to authenticated
using (auth_user_id = auth.uid());

drop policy if exists scansafe_evacuee_read_own_active_barcode on public.barcodes;
create policy scansafe_evacuee_read_own_active_barcode
on public.barcodes for select to authenticated
using (
  status = 'active'
  and exists (
    select 1 from public.evacuees e
    where e.evacuee_id = barcodes.evacuee_id
      and e.auth_user_id = auth.uid()
      and e.approval_status = 'approved'
  )
);

drop policy if exists scansafe_evacuee_read_own_assignment on public.accommodation_assignments;
create policy scansafe_evacuee_read_own_assignment
on public.accommodation_assignments for select to authenticated
using (
  assignment_status = 'active'
  and exists (
    select 1 from public.evacuees e
    where e.group_id = accommodation_assignments.group_id
      and e.auth_user_id = auth.uid()
  )
);

grant select on public.evacuees, public.barcodes, public.accommodation_assignments to authenticated;

-- Private helper: a row lock serializes concurrent approval/retry/backfill.
-- Only registrations with no barcode row at all receive a new server value.
-- Existing revoked/inactive rows are intentionally never reactivated/replaced.
create or replace function public.scansafe_ensure_approved_barcode(p_evacuee_id bigint)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $ensure_barcode$
declare
  v_approval text;
  v_barcode text;
begin
  select e.approval_status into v_approval
  from public.evacuees e
  where e.evacuee_id = p_evacuee_id
  for update;

  if not found then raise exception 'Evacuee not found'; end if;
  if v_approval is distinct from 'approved' then
    raise exception 'An approved registration is required before barcode issuance';
  end if;

  select b.barcode_value into v_barcode
  from public.barcodes b
  where b.evacuee_id = p_evacuee_id and b.status = 'active'
  limit 1;
  if found then
    if nullif(btrim(v_barcode), '') is null then
      raise exception 'The existing active barcode has no value; an administrator must repair it';
    end if;
    return v_barcode;
  end if;

  if exists (select 1 from public.barcodes b where b.evacuee_id = p_evacuee_id) then
    raise exception 'The existing barcode is not active; an administrator must review it before approval';
  end if;

  insert into public.barcodes(evacuee_id, barcode_value, status)
  values (p_evacuee_id, 'EVAC-' || replace(gen_random_uuid()::text, '-', ''), 'active')
  returning barcode_value into v_barcode;

  return v_barcode;
end;
$ensure_barcode$;

revoke all on function public.scansafe_ensure_approved_barcode(bigint) from public, anon, authenticated;

-- Admin approval returns a real active value, including for an already-approved
-- registration whose Phase 1 barcode trigger was previously missing.
create or replace function public.approve_evacuee_registration(p_evacuee_id bigint)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $approve$
declare
  v_approval text;
  v_barcode text;
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
  ) then
    raise exception using errcode = '42501', message = 'Administrator approval is required';
  end if;

  select e.approval_status into v_approval
  from public.evacuees e
  where e.evacuee_id = p_evacuee_id
  for update;
  if not found then raise exception 'Evacuee not found'; end if;
  if v_approval = 'rejected' then
    raise exception 'Rejected registration must be corrected before approval';
  end if;

  -- Check before updating so a legacy trigger cannot replace a revoked code.
  if not exists (
    select 1 from public.barcodes b where b.evacuee_id = p_evacuee_id and b.status = 'active'
  ) and exists (
    select 1 from public.barcodes b where b.evacuee_id = p_evacuee_id
  ) then
    raise exception 'The existing barcode is not active; an administrator must review it before approval';
  end if;

  if v_approval is distinct from 'approved' then
    update public.evacuees
    set approval_status = 'approved',
        approved_at = coalesce(approved_at, now()), approved_by = auth.uid()
    where evacuee_id = p_evacuee_id;
  end if;

  -- Existing immediate issuance triggers have finished before this statement.
  v_barcode := public.scansafe_ensure_approved_barcode(p_evacuee_id);
  perform public.log_scansafe_audit(
    'evacuee_approved', 'evacuee', p_evacuee_id::text,
    jsonb_build_object('qr_issued', true)
  );
  return v_barcode;
end;
$approve$;

revoke all on function public.approve_evacuee_registration(bigint) from public, anon, authenticated;
grant execute on function public.approve_evacuee_registration(bigint) to authenticated;

-- Deferred execution lets existing immediate Phase 1 issuance triggers run
-- first, regardless of their names. The helper then returns their existing code.
create or replace function public.scansafe_ensure_barcode_on_approval()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $approval_trigger$
begin
  if new.approval_status is distinct from 'approved' then return new; end if;
  if tg_op = 'UPDATE' then
    if old.approval_status is not distinct from 'approved' then return new; end if;
  end if;

  -- A later update in the same transaction may have changed the final status.
  perform 1 from public.evacuees e
  where e.evacuee_id = new.evacuee_id and e.approval_status = 'approved'
  for update;
  if found then
    perform public.scansafe_ensure_approved_barcode(new.evacuee_id);
  end if;
  return new;
end;
$approval_trigger$;

revoke all on function public.scansafe_ensure_barcode_on_approval() from public, anon, authenticated;

drop trigger if exists scansafe_ensure_barcode_after_approval on public.evacuees;
create constraint trigger scansafe_ensure_barcode_after_approval
after insert or update on public.evacuees
deferrable initially deferred
for each row execute function public.scansafe_ensure_barcode_on_approval();

-- Repair previously approved rows such as Nick's only when no barcode exists.
-- No records, existing codes, revoked statuses, or account links are deleted.
do $backfill$
declare
  v_evacuee_id bigint;
begin
  for v_evacuee_id in
    select e.evacuee_id from public.evacuees e
    where e.approval_status = 'approved'
      and not exists (select 1 from public.barcodes b where b.evacuee_id = e.evacuee_id)
    order by e.evacuee_id
  loop
    perform public.scansafe_ensure_approved_barcode(v_evacuee_id);
  end loop;
end;
$backfill$;

-- Refresh PostgREST so the new authenticated RPC becomes discoverable.
notify pgrst, 'reload schema';
commit;