-- ScanSafe: compact, camera-friendly numeric CODE128 barcodes.
-- Run this ENTIRE file after SUPABASE_EVACUEE_LIVE_SYNC_FIX.sql and
-- SUPABASE_SCANNER_GBEAA_FIX.sql. It inserts no people, rooms, or sample data.
-- Existing approved active barcode values become 12 random digits. Barcode IDs,
-- ownership, statuses, assignments, and scan history stay attached to the same
-- records. Private aliases keep already printed old codes usable by staff.
-- Re-running is safe. Revoked/inactive values are never shortened/reactivated.

rollback;
begin;

do $preflight$
begin
  if to_regprocedure('public.scansafe_ensure_approved_barcode(bigint)') is null
     or to_regprocedure('public.get_my_scansafe_account()') is null then
    raise exception 'Run SUPABASE_EVACUEE_LIVE_SYNC_FIX.sql before this short barcode fix';
  end if;
  if to_regprocedure('public.scan_and_assign_evacuee(text)') is null
     or to_regprocedure('public.is_staff()') is null then
    raise exception 'Run SUPABASE_SCANNER_GBEAA_FIX.sql before this short barcode fix';
  end if;
end;
$preflight$;

create table if not exists public.scansafe_barcode_aliases (
  barcode_value text primary key,
  barcode_id bigint not null references public.barcodes(barcode_id)
    deferrable initially deferred,
  created_at timestamptz not null default now()
);
alter table public.scansafe_barcode_aliases enable row level security;
revoke all on table public.scansafe_barcode_aliases from public, anon, authenticated;

-- Twelve digits encode as six CODE128C digit pairs, rather than the many
-- individual symbols in an EVAC-UUID. These are opaque IDs, not login secrets.
create or replace function public.scansafe_random_barcode_candidate()
returns text
language sql volatile
set search_path = pg_catalog, public
as $candidate$
  select lpad(((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
    ::bit(48)::bigint) % 1000000000000)::text, 12, '0');
$candidate$;
revoke all on function public.scansafe_random_barcode_candidate() from public, anon, authenticated;

-- A transaction lock serializes the canonical/alias namespace together. Table
-- unique constraints remain the final safeguard; no substring is used as an ID.
create or replace function public.scansafe_new_short_barcode()
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $new_code$
declare
  v_value text;
begin
  perform pg_advisory_xact_lock(1363433432);
  for v_attempt in 1..128 loop
    v_value := public.scansafe_random_barcode_candidate();
    if v_value ~ '^[0-9]{12}$'
       and not exists (select 1 from public.barcodes b where b.barcode_value = v_value)
       and not exists (select 1 from public.scansafe_barcode_aliases a where a.barcode_value = v_value) then
      return v_value;
    end if;
  end loop;
  raise exception 'Could not reserve a unique short barcode. Retry approval.';
end;
$new_code$;
revoke all on function public.scansafe_new_short_barcode() from public, anon, authenticated;

-- BEFORE INSERT also handles legacy issuance triggers. Its deferred alias FK
-- permits saving the original printed code before the barcode row is inserted.
create or replace function public.scansafe_compact_active_barcode()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $compact$
declare
  v_original text := new.barcode_value;
  v_alias_owner bigint;
begin
  perform pg_advisory_xact_lock(1363433432);
  select a.barcode_id into v_alias_owner
  from public.scansafe_barcode_aliases a where a.barcode_value = new.barcode_value;
  if found and v_alias_owner is distinct from new.barcode_id then
    raise exception 'This barcode value is already reserved by another registration';
  end if;

  if new.status = 'active'
     and nullif(btrim(new.barcode_value), '') is not null
     and new.barcode_value !~ '^[0-9]{12}$'
     and exists (select 1 from public.evacuees e
       where e.evacuee_id = new.evacuee_id and e.approval_status = 'approved') then
    if exists (select 1 from public.barcodes b
      where b.barcode_value = v_original and b.barcode_id is distinct from new.barcode_id) then
      raise exception 'This barcode value already belongs to another registration';
    end if;
    new.barcode_value := public.scansafe_new_short_barcode();
    insert into public.scansafe_barcode_aliases(barcode_value, barcode_id)
    values (v_original, new.barcode_id)
    on conflict (barcode_value) do nothing;
  end if;
  return new;
end;
$compact$;
revoke all on function public.scansafe_compact_active_barcode() from public, anon, authenticated;

drop trigger if exists scansafe_compact_active_barcode on public.barcodes;
create trigger scansafe_compact_active_barcode
before insert or update of barcode_value, status, evacuee_id on public.barcodes
for each row execute function public.scansafe_compact_active_barcode();

create or replace function public.scansafe_ensure_approved_barcode(p_evacuee_id bigint)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $ensure_barcode$
declare
  v_approval text;
  v_barcode text;
  v_barcode_id bigint;
begin
  select e.approval_status into v_approval from public.evacuees e
  where e.evacuee_id = p_evacuee_id for update;
  if not found then raise exception 'Evacuee not found'; end if;
  if v_approval is distinct from 'approved' then
    raise exception 'An approved registration is required before barcode issuance';
  end if;

  select b.barcode_id, b.barcode_value into v_barcode_id, v_barcode
  from public.barcodes b where b.evacuee_id = p_evacuee_id and b.status = 'active'
  order by b.barcode_id limit 1 for update;
  if found then
    if nullif(btrim(v_barcode), '') is null then
      raise exception 'The existing active barcode has no value; an administrator must repair it';
    end if;
    if v_barcode !~ '^[0-9]{12}$' then
      update public.barcodes set barcode_value = barcode_value
      where barcode_id = v_barcode_id returning barcode_value into v_barcode;
    end if;
    return v_barcode;
  end if;
  if exists (select 1 from public.barcodes b where b.evacuee_id = p_evacuee_id) then
    raise exception 'The existing barcode is not active; an administrator must review it before approval';
  end if;

  insert into public.barcodes(evacuee_id, barcode_value, status)
  values (p_evacuee_id, public.scansafe_new_short_barcode(), 'active')
  returning barcode_value into v_barcode;
  return v_barcode;
end;
$ensure_barcode$;
revoke all on function public.scansafe_ensure_approved_barcode(bigint) from public, anon, authenticated;

-- Rename the installed scanner once, retaining all of its locking, verification,
-- audit, capacity, and assignment behavior. Only the staff wrapper is callable.
do $scanner_private$
begin
  if to_regprocedure('public.scansafe_scan_and_assign_canonical(text)') is null then
    alter function public.scan_and_assign_evacuee(text)
      rename to scansafe_scan_and_assign_canonical;
  end if;
end;
$scanner_private$;
revoke all on function public.scansafe_scan_and_assign_canonical(text) from public, anon, authenticated;

create or replace function public.scan_and_assign_evacuee(p_barcode_value text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $scan_alias$
declare
  v_input text := btrim(coalesce(p_barcode_value, ''));
  v_canonical text;
begin
  if auth.uid() is null or not coalesce(public.is_staff(), false) then
    raise exception using errcode = '42501', message = 'Staff access is required';
  end if;
  select b.barcode_value into v_canonical from public.barcodes b
  where b.barcode_value = v_input limit 1;
  if not found then
    select b.barcode_value into v_canonical
    from public.scansafe_barcode_aliases a
    join public.barcodes b on b.barcode_id = a.barcode_id
    where a.barcode_value = v_input limit 1;
  end if;
  -- Resolve to the current row even after revocation so the original verifier
  -- records/rejects it normally. Aliases never bypass current approval/status.
  return public.scansafe_scan_and_assign_canonical(coalesce(v_canonical, v_input))
    || jsonb_build_object('scanned_barcode_value', v_input);
end;
$scan_alias$;
revoke all on function public.scan_and_assign_evacuee(text) from public, anon, authenticated;
grant execute on function public.scan_and_assign_evacuee(text) to authenticated;

-- No rows are deleted. Updating through the trigger preserves each original
-- long value as an alias while retaining the same barcode ID and status.
update public.barcodes b set barcode_value = b.barcode_value
where b.status = 'active' and nullif(btrim(b.barcode_value), '') is not null
  and b.barcode_value !~ '^[0-9]{12}$'
  and exists (select 1 from public.evacuees e
    where e.evacuee_id = b.evacuee_id and e.approval_status = 'approved');

notify pgrst, 'reload schema';
commit;
