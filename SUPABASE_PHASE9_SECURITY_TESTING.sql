-- =========================================================
-- ScanSafe PHASE 9 — Security Hardening + Integrity Testing
-- Run AFTER Phases 1 through 8.
-- No design changes. This hardens permissions and business rules.
-- =========================================================

-- ---------------------------------------------------------
-- 1) ADMIN ROLE HELPER
-- ---------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path=public
as $$
  select coalesce(
    exists(
      select 1 from public.profiles
      where id=auth.uid() and role='admin'
    ),false
  );
$$;

revoke all on function public.is_admin() from public;
revoke all on function public.is_admin() from anon;
grant execute on function public.is_admin() to authenticated;

-- ---------------------------------------------------------
-- 2) REMOVE LEGACY ANONYMOUS REGISTRATION WITHOUT AN ACCOUNT
-- The Phase 3 account registration function remains available.
-- ---------------------------------------------------------
revoke all on function public.submit_public_registration(
  text,text,integer,text,integer,text,text,text,text,text,text
) from public;
revoke all on function public.submit_public_registration(
  text,text,integer,text,integer,text,text,text,text,text,text
) from anon;
revoke all on function public.submit_public_registration(
  text,text,integer,text,integer,text,text,text,text,text,text
) from authenticated;

-- Prevent race-condition duplicates by email.
create unique index if not exists ux_evacuuees_email_ci
on public.evacuees(lower(email))
where email is not null;

-- Harden the current public account-registration RPC.
create or replace function public.submit_public_registration_account(
  p_auth_user_id uuid,
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
set search_path=public,auth
as $$
declare
  gid bigint;
  eid bigint;
  req text;
  auth_email text;
  auth_created_at timestamptz;
  auth_role text;
begin
  if p_auth_user_id is null then raise exception 'Auth user is required'; end if;
  if trim(coalesce(p_full_name,''))='' then raise exception 'Full name is required'; end if;
  if length(trim(p_full_name))>200 then raise exception 'Full name is too long'; end if;
  if trim(coalesce(p_email,''))='' then raise exception 'Email is required'; end if;
  if p_age is not null and (p_age<0 or p_age>120) then raise exception 'Age is invalid'; end if;
  if coalesce(p_group_size,0)<1 or p_group_size>50 then raise exception 'Group size must be between 1 and 50'; end if;
  if length(coalesce(p_address,''))>500 then raise exception 'Address is too long'; end if;
  if length(coalesce(p_needs,''))>1000 then raise exception 'Needs description is too long'; end if;
  if length(coalesce(p_valid_id_number,''))>120 then raise exception 'Valid ID number is too long'; end if;

  select lower(email),created_at,coalesce(raw_user_meta_data->>'role','')
    into auth_email,auth_created_at,auth_role
  from auth.users
  where id=p_auth_user_id;

  if auth_email is null then raise exception 'Auth account not found'; end if;
  if auth_email<>lower(trim(p_email)) then raise exception 'Auth email does not match registration email'; end if;
  if auth_created_at<now()-interval '15 minutes' then
    raise exception 'Registration link window expired. Sign in and contact the administrator.';
  end if;
  if auth_role<>'' and auth_role<>'evacuee' then
    raise exception 'Invalid account type for public registration';
  end if;

  -- Serialize concurrent attempts using the normalized email.
  perform pg_advisory_xact_lock(hashtext(lower(trim(p_email))));

  if exists(select 1 from public.evacuees where auth_user_id=p_auth_user_id) then
    raise exception 'This account already has an evacuee registration';
  end if;
  if exists(select 1 from public.evacuees where lower(email)=lower(trim(p_email))) then
    raise exception 'This email already has an evacuee registration';
  end if;

  insert into public.profiles(id,full_name,role)
  values(p_auth_user_id,trim(p_full_name),'evacuee')
  on conflict(id) do update
    set full_name=excluded.full_name,
        role='evacuee';

  req:='REQ-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));

  insert into public.evacuee_groups(group_name,group_size)
  values(trim(p_full_name)||' Group',p_group_size)
  returning group_id into gid;

  insert into public.evacuees(
    auth_user_id,group_id,registration_code,full_name,email,age,gender,
    group_size,needs_summary,address,barangay,city,
    valid_id_type,valid_id_number,approval_status,current_status
  ) values(
    p_auth_user_id,gid,req,trim(p_full_name),lower(trim(p_email)),p_age,p_gender,
    p_group_size,nullif(trim(coalesce(p_needs,'')),''),trim(coalesce(p_address,'')),
    trim(coalesce(p_barangay,'')),trim(coalesce(p_city,'')),
    trim(coalesce(p_valid_id_type,'')),trim(coalesce(p_valid_id_number,'')),
    'pending','registered'
  ) returning evacuee_id into eid;

  if nullif(trim(coalesce(p_needs,'')),'') is not null
     and lower(trim(p_needs))<>'none' then
    insert into public.evacuee_needs(evacuee_id,need_type,description,priority_level,status)
    values(eid,'Reported Need',trim(p_needs),'medium','pending');
  end if;

  return req;
end;
$$;

revoke all on function public.submit_public_registration_account(
  uuid,text,text,integer,text,integer,text,text,text,text,text,text
) from public;
revoke all on function public.submit_public_registration_account(
  uuid,text,text,integer,text,integer,text,text,text,text,text,text
) from anon;
revoke all on function public.submit_public_registration_account(
  uuid,text,text,integer,text,integer,text,text,text,text,text,text
) from authenticated;
grant execute on function public.submit_public_registration_account(
  uuid,text,text,integer,text,integer,text,text,text,text,text,text
) to anon,authenticated;

-- ---------------------------------------------------------
-- 3) LEAST-PRIVILEGE RLS
-- ---------------------------------------------------------

-- Profiles: staff may read profiles; only admins may directly manage roles.
drop policy if exists "profiles staff manage" on public.profiles;
drop policy if exists "admin manage profiles" on public.profiles;
create policy "admin manage profiles"
on public.profiles for all
to authenticated
using(public.is_admin())
with check(public.is_admin());

-- Shelter configuration is admin-only; authenticated users retain read access.
drop policy if exists "staff manage shelters" on public.shelters;
drop policy if exists "admin manage shelters" on public.shelters;
create policy "admin manage shelters"
on public.shelters for all
to authenticated
using(public.is_admin())
with check(public.is_admin());

-- Accommodation configuration is admin-only. Operational staff use RPCs.
drop policy if exists "staff manage spaces" on public.accommodation_spaces;
drop policy if exists "admin manage spaces" on public.accommodation_spaces;
create policy "admin manage spaces"
on public.accommodation_spaces for all
to authenticated
using(public.is_admin())
with check(public.is_admin());

-- Group records are readable by staff but direct mutation is admin-only.
drop policy if exists "staff manage evacuee groups" on public.evacuee_groups;
drop policy if exists "staff read evacuee groups" on public.evacuee_groups;
drop policy if exists "admin manage evacuee groups" on public.evacuee_groups;
create policy "staff read evacuee groups"
on public.evacuee_groups for select
to authenticated
using(public.is_staff());
create policy "admin manage evacuee groups"
on public.evacuee_groups for all
to authenticated
using(public.is_admin())
with check(public.is_admin());

-- Direct evacuee record writes are admin-only.
-- Registration, scanning and workflow state changes use SECURITY DEFINER RPCs.
drop policy if exists "staff insert evacuees" on public.evacuees;
drop policy if exists "staff update evacuees" on public.evacuees;
drop policy if exists "staff delete evacuees" on public.evacuees;
drop policy if exists "admin manage evacuees" on public.evacuees;
create policy "admin manage evacuees"
on public.evacuees for all
to authenticated
using(public.is_admin())
with check(public.is_admin());

-- Assignment writes must go through transactional RPCs so capacity cannot be bypassed.
drop policy if exists "staff manage assignments" on public.accommodation_assignments;

-- QR status changes are admin-only; reads keep the previous staff/owner policies.
drop policy if exists "staff update barcodes" on public.barcodes;
drop policy if exists "admin update qr status" on public.barcodes;
create policy "admin update qr status"
on public.barcodes for update
to authenticated
using(public.is_admin())
with check(public.is_admin());

-- Scan logs are append-only through verify_qr_code(); staff may only read directly.
drop policy if exists "staff manage scan logs" on public.scan_logs;
drop policy if exists "staff read scan logs" on public.scan_logs;
create policy "staff read scan logs"
on public.scan_logs for select
to authenticated
using(public.is_staff());

-- Notifications are created through the announcement/automatic workflow RPCs.
drop policy if exists "staff manage notifications" on public.notifications;

-- Messages are created through controlled send-message RPCs only.
drop policy if exists "users send messages" on public.messages;
drop policy if exists "users read own messages" on public.messages;
create policy "users read own messages"
on public.messages for select
to authenticated
using(sender_id=auth.uid() or receiver_id=auth.uid());

-- Report export logs are created through the reporting RPC.
drop policy if exists "staff insert report exports" on public.report_exports;

-- ---------------------------------------------------------
-- 4) ADMIN-ONLY APPROVAL / REJECTION
-- ---------------------------------------------------------
create table if not exists public.audit_events(
  audit_id bigint generated always as identity primary key,
  event_type text not null,
  actor_id uuid references public.profiles(id) on delete set null,
  target_type text,
  target_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.audit_events enable row level security;
drop policy if exists "admin read audit events" on public.audit_events;
create policy "admin read audit events"
on public.audit_events for select
to authenticated
using(public.is_admin());

create or replace function public.log_scansafe_audit(
  p_event_type text,
  p_target_type text,
  p_target_id text,
  p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path=public
as $$
begin
  insert into public.audit_events(event_type,actor_id,target_type,target_id,details)
  values(p_event_type,auth.uid(),p_target_type,p_target_id,coalesce(p_details,'{}'::jsonb));
end;
$$;
revoke all on function public.log_scansafe_audit(text,text,text,jsonb) from public;
revoke all on function public.log_scansafe_audit(text,text,text,jsonb) from anon;
revoke all on function public.log_scansafe_audit(text,text,text,jsonb) from authenticated;

create or replace function public.approve_evacuee_registration(p_evacuee_id bigint)
returns text
language plpgsql
security definer
set search_path=public
as $$
declare
  qr text;
  current_approval text;
begin
  if not public.is_admin() then raise exception 'Administrator approval is required'; end if;

  select approval_status into current_approval
  from public.evacuees
  where evacuee_id=p_evacuee_id
  for update;

  if not found then raise exception 'Evacuee not found'; end if;
  if current_approval='rejected' then raise exception 'Rejected registration must be corrected before approval'; end if;

  if current_approval<>'approved' then
    update public.evacuees
    set approval_status='approved',approved_at=coalesce(approved_at,now()),approved_by=auth.uid()
    where evacuee_id=p_evacuee_id;
  end if;

  select barcode_value into qr
  from public.barcodes
  where evacuee_id=p_evacuee_id and status='active'
  limit 1;

  perform public.log_scansafe_audit(
    'evacuee_approved','evacuee',p_evacuee_id::text,
    jsonb_build_object('qr_issued',qr is not null)
  );
  return qr;
end;
$$;

revoke all on function public.approve_evacuee_registration(bigint) from public;
revoke all on function public.approve_evacuee_registration(bigint) from anon;
revoke all on function public.approve_evacuee_registration(bigint) from authenticated;
grant execute on function public.approve_evacuee_registration(bigint) to authenticated;

create or replace function public.reject_evacuee_registration(p_evacuee_id bigint)
returns void
language plpgsql
security definer
set search_path=public
as $$
declare
  current_approval text;
begin
  if not public.is_admin() then raise exception 'Administrator approval is required'; end if;

  select approval_status into current_approval
  from public.evacuees
  where evacuee_id=p_evacuee_id
  for update;

  if not found then raise exception 'Evacuee not found'; end if;
  if current_approval='approved' then raise exception 'An approved registration cannot be rejected directly'; end if;

  update public.evacuees
  set approval_status='rejected',approved_at=null,approved_by=null
  where evacuee_id=p_evacuee_id;

  perform public.log_scansafe_audit('evacuee_rejected','evacuee',p_evacuee_id::text,'{}'::jsonb);
end;
$$;

revoke all on function public.reject_evacuee_registration(bigint) from public;
revoke all on function public.reject_evacuee_registration(bigint) from anon;
revoke all on function public.reject_evacuee_registration(bigint) from authenticated;
grant execute on function public.reject_evacuee_registration(bigint) to authenticated;

-- ---------------------------------------------------------
-- 5) SECURE TRANSACTIONAL ACCOMMODATION OPERATIONS
-- ---------------------------------------------------------
create or replace function public.assign_group_to_space(
  p_group_id bigint,
  p_space_code text
)
returns jsonb
language plpgsql
security definer
set search_path=public
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
  if not public.is_staff() then raise exception 'Not authorized'; end if;

  select group_size into v_group_size
  from public.evacuee_groups
  where group_id=p_group_id
  for update;
  if not found then raise exception 'Evacuee group not found'; end if;

  if not exists(
    select 1
    from public.evacuees e
    join public.barcodes b on b.evacuee_id=e.evacuee_id and b.status='active'
    where e.group_id=p_group_id and e.approval_status='approved'
  ) then
    raise exception 'Group is not eligible: admin approval and an active QR are required';
  end if;

  if exists(
    select 1 from public.accommodation_assignments
    where group_id=p_group_id and assignment_status='active'
  ) then
    raise exception 'This group already has an active accommodation assignment';
  end if;

  select space_id,space_name,capacity,current_occupancy
    into v_space_id,v_space_name,v_capacity,v_occupancy
  from public.accommodation_spaces
  where upper(space_code)=upper(trim(p_space_code))
    and is_primary=true
    and status<>'inactive'
  order by space_id
  limit 1
  for update;

  if not found then raise exception 'Accommodation space not found or inactive'; end if;
  if coalesce(v_occupancy,0)+v_group_size>v_capacity then
    raise exception 'Insufficient slots. Available: %, group size: %',
      greatest(0,v_capacity-coalesce(v_occupancy,0)),v_group_size;
  end if;

  insert into public.accommodation_assignments(
    group_id,space_id,assigned_by,assignment_status,override_flag
  ) values(p_group_id,v_space_id,auth.uid(),'active',false)
  returning assignment_id into v_assignment_id;

  v_new_occupancy:=coalesce(v_occupancy,0)+v_group_size;
  update public.accommodation_spaces
  set current_occupancy=v_new_occupancy
  where space_id=v_space_id;

  perform public.log_scansafe_audit(
    'accommodation_assigned','group',p_group_id::text,
    jsonb_build_object('space_code',upper(trim(p_space_code)),'group_size',v_group_size)
  );

  return jsonb_build_object(
    'assignment_id',v_assignment_id,'group_id',p_group_id,'group_size',v_group_size,
    'space_id',v_space_id,'space_code',upper(trim(p_space_code)),'space_name',v_space_name,
    'capacity',v_capacity,'current_occupancy',v_new_occupancy,'available',v_capacity-v_new_occupancy
  );
end;
$$;

revoke all on function public.assign_group_to_space(bigint,text) from public;
revoke all on function public.assign_group_to_space(bigint,text) from anon;
revoke all on function public.assign_group_to_space(bigint,text) from authenticated;
grant execute on function public.assign_group_to_space(bigint,text) to authenticated;

create or replace function public.release_group_assignment(p_group_id bigint)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  aid bigint;
  sid bigint;
  gsize integer;
  occ integer;
begin
  if not public.is_staff() then raise exception 'Not authorized'; end if;

  select a.assignment_id,a.space_id,g.group_size
    into aid,sid,gsize
  from public.accommodation_assignments a
  join public.evacuee_groups g on g.group_id=a.group_id
  where a.group_id=p_group_id and a.assignment_status='active'
  for update of a;

  if not found then raise exception 'Active assignment not found'; end if;

  select current_occupancy into occ
  from public.accommodation_spaces
  where space_id=sid
  for update;

  update public.accommodation_assignments
  set assignment_status='completed'
  where assignment_id=aid;

  update public.accommodation_spaces
  set current_occupancy=greatest(0,coalesce(occ,0)-gsize)
  where space_id=sid;

  perform public.log_scansafe_audit(
    'accommodation_released','group',p_group_id::text,
    jsonb_build_object('assignment_id',aid,'space_id',sid,'group_size',gsize)
  );

  return jsonb_build_object('released',true,'group_id',p_group_id,'assignment_id',aid);
end;
$$;

revoke all on function public.release_group_assignment(bigint) from public;
revoke all on function public.release_group_assignment(bigint) from anon;
revoke all on function public.release_group_assignment(bigint) from authenticated;
grant execute on function public.release_group_assignment(bigint) to authenticated;

create or replace function public.transfer_group_assignment(p_group_id bigint,p_new_space_code text)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  old_aid bigint;
  old_sid bigint;
  old_occ integer;
  new_sid bigint;
  new_name text;
  new_cap integer;
  new_occ integer;
  gsize integer;
  new_aid bigint;
begin
  if not public.is_staff() then raise exception 'Not authorized'; end if;

  select a.assignment_id,a.space_id,g.group_size
    into old_aid,old_sid,gsize
  from public.accommodation_assignments a
  join public.evacuee_groups g on g.group_id=a.group_id
  where a.group_id=p_group_id and a.assignment_status='active'
  for update of a;
  if not found then raise exception 'Active assignment not found'; end if;

  select current_occupancy into old_occ
  from public.accommodation_spaces
  where space_id=old_sid
  for update;

  select space_id,space_name,capacity,current_occupancy
    into new_sid,new_name,new_cap,new_occ
  from public.accommodation_spaces
  where upper(space_code)=upper(trim(p_new_space_code))
    and is_primary=true and status<>'inactive'
  order by space_id limit 1
  for update;

  if not found then raise exception 'Destination space not found or inactive'; end if;
  if new_sid=old_sid then raise exception 'Group is already assigned to this space'; end if;
  if coalesce(new_occ,0)+gsize>new_cap then
    raise exception 'Insufficient destination slots. Available: %, group size: %',
      greatest(0,new_cap-coalesce(new_occ,0)),gsize;
  end if;

  update public.accommodation_assignments
  set assignment_status='transferred'
  where assignment_id=old_aid;

  update public.accommodation_spaces
  set current_occupancy=greatest(0,coalesce(old_occ,0)-gsize)
  where space_id=old_sid;

  insert into public.accommodation_assignments(
    group_id,space_id,assigned_by,assignment_status,override_flag
  ) values(p_group_id,new_sid,auth.uid(),'active',false)
  returning assignment_id into new_aid;

  update public.accommodation_spaces
  set current_occupancy=coalesce(new_occ,0)+gsize
  where space_id=new_sid;

  perform public.log_scansafe_audit(
    'accommodation_transferred','group',p_group_id::text,
    jsonb_build_object('from_space_id',old_sid,'to_space_id',new_sid,'to_space_code',upper(trim(p_new_space_code)))
  );

  return jsonb_build_object(
    'transferred',true,'group_id',p_group_id,'assignment_id',new_aid,
    'space_code',upper(trim(p_new_space_code)),'space_name',new_name
  );
end;
$$;

revoke all on function public.transfer_group_assignment(bigint,text) from public;
revoke all on function public.transfer_group_assignment(bigint,text) from anon;
revoke all on function public.transfer_group_assignment(bigint,text) from authenticated;
grant execute on function public.transfer_group_assignment(bigint,text) to authenticated;

-- ---------------------------------------------------------
-- 6) ADMIN QR REVOCATION / REACTIVATION
-- ---------------------------------------------------------
create or replace function public.set_scansafe_qr_status(p_evacuee_id bigint,p_status text)
returns text
language plpgsql
security definer
set search_path=public
as $$
declare
  qr text;
begin
  if not public.is_admin() then raise exception 'Administrator access is required'; end if;
  if p_status not in ('active','inactive','revoked') then raise exception 'Invalid QR status'; end if;

  update public.barcodes
  set status=p_status
  where evacuee_id=p_evacuee_id
  returning barcode_value into qr;

  if qr is null then raise exception 'QR record not found'; end if;
  perform public.log_scansafe_audit(
    'qr_status_changed','evacuee',p_evacuee_id::text,
    jsonb_build_object('status',p_status)
  );
  return qr;
end;
$$;

revoke all on function public.set_scansafe_qr_status(bigint,text) from public;
revoke all on function public.set_scansafe_qr_status(bigint,text) from anon;
revoke all on function public.set_scansafe_qr_status(bigint,text) from authenticated;
grant execute on function public.set_scansafe_qr_status(bigint,text) to authenticated;

-- ---------------------------------------------------------
-- 7) HARDEN SENSITIVE RPC EXECUTE PERMISSIONS
-- ---------------------------------------------------------
-- Helper role functions are for authenticated users only.
revoke all on function public.current_user_role() from public;
revoke all on function public.current_user_role() from anon;
grant execute on function public.current_user_role() to authenticated;

revoke all on function public.is_staff() from public;
revoke all on function public.is_staff() from anon;
grant execute on function public.is_staff() to authenticated;

-- Trigger functions are never client RPC endpoints.
revoke all on function public.generate_barcode_after_approval() from public;
revoke all on function public.generate_barcode_after_approval() from anon;
revoke all on function public.generate_barcode_after_approval() from authenticated;
revoke all on function public.sync_space_status() from public;
revoke all on function public.sync_space_status() from anon;
revoke all on function public.sync_space_status() from authenticated;
revoke all on function public.notify_scansafe_approval() from public;
revoke all on function public.notify_scansafe_approval() from anon;
revoke all on function public.notify_scansafe_approval() from authenticated;
revoke all on function public.notify_scansafe_assignment() from public;
revoke all on function public.notify_scansafe_assignment() from anon;
revoke all on function public.notify_scansafe_assignment() from authenticated;

-- Authenticated-only operational RPCs.
do $$
begin
  -- No-op block used only to group the permission statements below.
end $$;

revoke all on function public.verify_qr_code(text) from public;
revoke all on function public.verify_qr_code(text) from anon;
revoke all on function public.verify_qr_code(text) from authenticated;
grant execute on function public.verify_qr_code(text) to authenticated;

revoke all on function public.get_recent_scan_history(integer) from public;
revoke all on function public.get_recent_scan_history(integer) from anon;
revoke all on function public.get_recent_scan_history(integer) from authenticated;
grant execute on function public.get_recent_scan_history(integer) to authenticated;

revoke all on function public.send_scansafe_announcement(text,text,text,text,text) from public;
revoke all on function public.send_scansafe_announcement(text,text,text,text,text) from anon;
revoke all on function public.send_scansafe_announcement(text,text,text,text,text) from authenticated;
grant execute on function public.send_scansafe_announcement(text,text,text,text,text) to authenticated;

revoke all on function public.get_my_scansafe_notifications() from public;
revoke all on function public.get_my_scansafe_notifications() from anon;
revoke all on function public.get_my_scansafe_notifications() from authenticated;
grant execute on function public.get_my_scansafe_notifications() to authenticated;

revoke all on function public.mark_scansafe_notification_read(bigint) from public;
revoke all on function public.mark_scansafe_notification_read(bigint) from anon;
revoke all on function public.mark_scansafe_notification_read(bigint) from authenticated;
grant execute on function public.mark_scansafe_notification_read(bigint) to authenticated;

revoke all on function public.send_message_to_scansafe_admin(text) from public;
revoke all on function public.send_message_to_scansafe_admin(text) from anon;
revoke all on function public.send_message_to_scansafe_admin(text) from authenticated;
grant execute on function public.send_message_to_scansafe_admin(text) to authenticated;

revoke all on function public.staff_send_scansafe_message(uuid,text) from public;
revoke all on function public.staff_send_scansafe_message(uuid,text) from anon;
revoke all on function public.staff_send_scansafe_message(uuid,text) from authenticated;
grant execute on function public.staff_send_scansafe_message(uuid,text) to authenticated;

revoke all on function public.get_my_admin_thread() from public;
revoke all on function public.get_my_admin_thread() from anon;
revoke all on function public.get_my_admin_thread() from authenticated;
grant execute on function public.get_my_admin_thread() to authenticated;

revoke all on function public.get_staff_message_contacts() from public;
revoke all on function public.get_staff_message_contacts() from anon;
revoke all on function public.get_staff_message_contacts() from authenticated;
grant execute on function public.get_staff_message_contacts() to authenticated;

revoke all on function public.get_staff_thread(uuid) from public;
revoke all on function public.get_staff_thread(uuid) from anon;
revoke all on function public.get_staff_thread(uuid) from authenticated;
grant execute on function public.get_staff_thread(uuid) to authenticated;

revoke all on function public.get_scansafe_report_summary() from public;
revoke all on function public.get_scansafe_report_summary() from anon;
revoke all on function public.get_scansafe_report_summary() from authenticated;
grant execute on function public.get_scansafe_report_summary() to authenticated;

revoke all on function public.get_scansafe_evacuee_report_rows() from public;
revoke all on function public.get_scansafe_evacuee_report_rows() from anon;
revoke all on function public.get_scansafe_evacuee_report_rows() from authenticated;
grant execute on function public.get_scansafe_evacuee_report_rows() to authenticated;

revoke all on function public.log_scansafe_report_export(text,text) from public;
revoke all on function public.log_scansafe_report_export(text,text) from anon;
revoke all on function public.log_scansafe_report_export(text,text) from authenticated;
grant execute on function public.log_scansafe_report_export(text,text) to authenticated;

revoke all on function public.get_recent_report_exports(integer) from public;
revoke all on function public.get_recent_report_exports(integer) from anon;
revoke all on function public.get_recent_report_exports(integer) from authenticated;
grant execute on function public.get_recent_report_exports(integer) to authenticated;

-- ---------------------------------------------------------
-- 8) INTEGRITY CHECK + OCCUPANCY RECONCILIATION
-- ---------------------------------------------------------
create or replace function public.scansafe_security_health_check()
returns jsonb
language plpgsql
stable
security definer
set search_path=public
as $$
declare
  result jsonb;
begin
  if not public.is_admin() and session_user not in ('postgres','supabase_admin') then
    raise exception 'Administrator access is required';
  end if;

  select jsonb_build_object(
    'over_capacity_spaces',(
      select count(*) from public.accommodation_spaces
      where current_occupancy>capacity
    ),
    'occupancy_mismatches',(
      select count(*)
      from public.accommodation_spaces s
      where s.current_occupancy<>(
        select coalesce(sum(g.group_size),0)
        from public.accommodation_assignments a
        join public.evacuee_groups g on g.group_id=a.group_id
        where a.space_id=s.space_id and a.assignment_status='active'
      )
    ),
    'approved_without_active_qr',(
      select count(*)
      from public.evacuees e
      where e.approval_status='approved'
        and not exists(
          select 1 from public.barcodes b
          where b.evacuee_id=e.evacuee_id and b.status='active'
        )
    ),
    'pending_with_qr',(
      select count(*)
      from public.evacuees e
      join public.barcodes b on b.evacuee_id=e.evacuee_id and b.status='active'
      where e.approval_status<>'approved'
    ),
    'multiple_active_assignments',(
      select count(*) from(
        select group_id
        from public.accommodation_assignments
        where assignment_status='active'
        group by group_id having count(*)>1
      ) x
    ),
    'auth_evacuuees_without_profile',(
      select count(*)
      from public.evacuees e
      where e.auth_user_id is not null
        and not exists(select 1 from public.profiles p where p.id=e.auth_user_id)
    ),
    'evacuee_profiles_without_record',(
      select count(*)
      from public.profiles p
      where p.role='evacuee'
        and not exists(select 1 from public.evacuees e where e.auth_user_id=p.id)
    ),
    'active_qr_count',(
      select count(*) from public.barcodes where status='active'
    ),
    'audit_event_count',(
      select count(*) from public.audit_events
    ),
    'checked_at',now()
  ) into result;

  return result;
end;
$$;

revoke all on function public.scansafe_security_health_check() from public;
revoke all on function public.scansafe_security_health_check() from anon;
revoke all on function public.scansafe_security_health_check() from authenticated;
grant execute on function public.scansafe_security_health_check() to authenticated;

create or replace function public.reconcile_scansafe_occupancy()
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  changed integer:=0;
begin
  if not public.is_admin() and session_user not in ('postgres','supabase_admin') then
    raise exception 'Administrator access is required';
  end if;

  with expected as(
    select
      s.space_id,
      coalesce(sum(g.group_size) filter(where a.assignment_status='active'),0)::integer as expected_occupancy
    from public.accommodation_spaces s
    left join public.accommodation_assignments a on a.space_id=s.space_id
    left join public.evacuee_groups g on g.group_id=a.group_id
    group by s.space_id
  ), updated as(
    update public.accommodation_spaces s
    set current_occupancy=e.expected_occupancy
    from expected e
    where s.space_id=e.space_id
      and s.current_occupancy<>e.expected_occupancy
    returning s.space_id
  )
  select count(*) into changed from updated;

  perform public.log_scansafe_audit(
    'occupancy_reconciled','system','accommodation_spaces',
    jsonb_build_object('spaces_updated',changed)
  );

  return jsonb_build_object('spaces_updated',changed,'reconciled_at',now());
end;
$$;

revoke all on function public.reconcile_scansafe_occupancy() from public;
revoke all on function public.reconcile_scansafe_occupancy() from anon;
revoke all on function public.reconcile_scansafe_occupancy() from authenticated;
grant execute on function public.reconcile_scansafe_occupancy() to authenticated;

-- =========================================================
-- END PHASE 9
-- =========================================================
