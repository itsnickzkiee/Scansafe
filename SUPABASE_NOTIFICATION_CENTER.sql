-- ScanSafe: interactive notification bell with exact, account-owned unread counts.
-- Run the ENTIRE file after SUPABASE_PHASE7_8.sql. No sample data is inserted.
rollback;
begin;

do $preflight$
begin
  if to_regclass('public.notification_reads') is null
     or to_regclass('public.notifications') is null
     or to_regclass('public.profiles') is null
     or to_regclass('public.evacuees') is null then
    raise exception 'Run the ScanSafe Phase 7 notifications setup before this migration';
  end if;
end;
$preflight$;

create or replace function public.get_scansafe_notification_center()
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public
as $center$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_result jsonb;
begin
  if v_uid is null then
    raise exception using errcode='42501',message='Sign in to view your notifications';
  end if;
  select p.role into v_role from public.profiles p where p.id=v_uid;
  if v_role is null or v_role not in ('admin','staff','evacuee') then
    raise exception using errcode='42501',message='A ScanSafe account is required';
  end if;

  -- A staff bell shows notifications addressed to staff or that specific user.
  -- Administrative table access does not expose another user's private alerts.
  with visible as materialized (
    select n.notification_id,n.title,n.message,n.notification_level,n.category,
      n.audience,n.created_at,(r.user_id is not null) as is_read
    from public.notifications n
    left join public.notification_reads r
      on r.notification_id=n.notification_id and r.user_id=v_uid
    where n.status='active' and (
      n.recipient_id=v_uid
      or (n.recipient_id is null and (
        n.audience='all'
        or (n.audience='evacuees' and v_role='evacuee')
        or (n.audience='staff' and v_role in ('admin','staff'))
      ))
    )
  ), recent as (
    select * from visible order by is_read,created_at desc,notification_id desc limit 50
  )
  select jsonb_build_object(
    'owner_id',v_uid,'mode',case when v_role='evacuee' then 'evacuee' else 'staff' end,
    'unread_count',(select count(*) from visible where not is_read),
    'total_count',(select count(*) from visible),
    'has_more',(select count(*)>50 from visible),
    'items',coalesce((select jsonb_agg(to_jsonb(recent) order by is_read,created_at desc,notification_id desc) from recent),'[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$center$;
revoke all on function public.get_scansafe_notification_center() from public,anon,authenticated;
grant execute on function public.get_scansafe_notification_center() to authenticated;

create or replace function public.mark_scansafe_center_notification_read(p_notification_id bigint)
returns void
language plpgsql security definer
set search_path = pg_catalog, public
as $mark$
declare
  v_uid uuid := auth.uid();
  v_role text;
begin
  if v_uid is null then
    raise exception using errcode='42501',message='Sign in to read this notification';
  end if;
  select p.role into v_role from public.profiles p where p.id=v_uid;
  if v_role is null or v_role not in ('admin','staff','evacuee') then
    raise exception using errcode='42501',message='A ScanSafe account is required';
  end if;
  -- The same visibility rule is checked again when opening an item, so stale
  -- clients cannot mark a withdrawn alert or another account's private alert.
  perform n.notification_id from public.notifications n
  where n.notification_id=p_notification_id and n.status='active' and (
    n.recipient_id=v_uid
    or (n.recipient_id is null and (
      n.audience='all'
      or (n.audience='evacuees' and v_role='evacuee')
      or (n.audience='staff' and v_role in ('admin','staff'))
    ))
  ) for share;
  if not found then
    raise exception using errcode='42501',message='This notification is no longer available to your account';
  end if;
  insert into public.notification_reads(notification_id,user_id,read_at)
  values(p_notification_id,v_uid,now())
  on conflict(notification_id,user_id) do nothing;
end;
$mark$;
revoke all on function public.mark_scansafe_center_notification_read(bigint) from public,anon,authenticated;
grant execute on function public.mark_scansafe_center_notification_read(bigint) to authenticated;

-- New registrations notify the actual staff audience once, on insertion.
-- Installing or re-running this migration does not send alerts for old rows.
create or replace function public.scansafe_notify_new_registration()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $registration_alert$
declare
  v_record jsonb := to_jsonb(new);
  v_code text := nullif(v_record->>'registration_code','');
  v_name text := coalesce(nullif(btrim(v_record->>'full_name'),''),'An evacuee');
begin
  if new.approval_status is distinct from 'pending' then return new; end if;
  insert into public.notifications(created_by,recipient_id,title,message,
    notification_level,status,audience,category)
  values(null,null,'New Evacuee Registration',
    v_name || ' submitted a registration' || case when v_code is null then '' else ' (' || v_code || ')' end
      || '. Open Registration Requests to review their details and uploaded documents.',
    'info','active','staff','system');
  return new;
end;
$registration_alert$;
revoke all on function public.scansafe_notify_new_registration() from public,anon,authenticated;
drop trigger if exists scansafe_notify_new_registration on public.evacuees;
create trigger scansafe_notify_new_registration after insert on public.evacuees
for each row execute function public.scansafe_notify_new_registration();

notify pgrst,'reload schema';
commit;
