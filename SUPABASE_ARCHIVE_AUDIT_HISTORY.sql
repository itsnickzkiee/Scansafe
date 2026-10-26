-- ScanSafe Archive / Stay History / Audit Trail
-- Does NOT delete conversations or stay history.
-- Does NOT modify accommodation-map rendering.

rollback;
begin;

do $preflight$
begin
  if to_regclass('public.messages') is null
     or to_regclass('public.audit_events') is null
     or to_regclass('public.scansafe_operation_stays') is null
     or to_regprocedure('public.is_staff()') is null
     or to_regprocedure('public.log_scansafe_audit(text,text,text,jsonb)') is null then
    raise exception 'Run the existing ScanSafe messaging, operations and security setup first';
  end if;
end;
$preflight$;

create table if not exists public.scansafe_conversation_archives(
  evacuee_user_id uuid primary key references public.profiles(id) on delete cascade,
  archived_by uuid references public.profiles(id) on delete set null,
  archived_at timestamptz not null default now(),
  reason text
);

alter table public.scansafe_conversation_archives enable row level security;
revoke all on public.scansafe_conversation_archives from public,anon,authenticated;

drop policy if exists scansafe_staff_read_conversation_archives on public.scansafe_conversation_archives;
create policy scansafe_staff_read_conversation_archives
on public.scansafe_conversation_archives for select
to authenticated
using(public.is_staff());

grant select on public.scansafe_conversation_archives to authenticated;

create or replace function public.archive_scansafe_conversation(
  p_user_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $fn$
declare
  v_name text;
begin
  if auth.uid() is null or not coalesce(public.is_staff(),false) then
    raise exception using errcode='42501',message='Staff access is required';
  end if;

  select full_name into v_name
  from public.profiles
  where id=p_user_id and role='evacuee';

  if v_name is null then raise exception 'Evacuee account not found'; end if;

  insert into public.scansafe_conversation_archives(evacuee_user_id,archived_by,archived_at,reason)
  values(p_user_id,auth.uid(),now(),nullif(btrim(coalesce(p_reason,'')),''))
  on conflict(evacuee_user_id) do update
    set archived_by=excluded.archived_by,
        archived_at=excluded.archived_at,
        reason=excluded.reason;

  perform public.log_scansafe_audit(
    'conversation_archived','evacuee_account',p_user_id::text,
    jsonb_build_object('evacuee_name',v_name,'reason',nullif(btrim(coalesce(p_reason,'')),''))
  );

  return jsonb_build_object('archived',true,'user_id',p_user_id,'full_name',v_name,'archived_at',now());
end;
$fn$;

create or replace function public.unarchive_scansafe_conversation(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $fn$
declare
  v_name text;
  v_deleted boolean:=false;
begin
  if auth.uid() is null or not coalesce(public.is_staff(),false) then
    raise exception using errcode='42501',message='Staff access is required';
  end if;

  select full_name into v_name from public.profiles where id=p_user_id;

  delete from public.scansafe_conversation_archives
  where evacuee_user_id=p_user_id;
  v_deleted:=found;

  if v_deleted then
    perform public.log_scansafe_audit(
      'conversation_unarchived','evacuee_account',p_user_id::text,
      jsonb_build_object('evacuee_name',coalesce(v_name,'Evacuee'))
    );
  end if;

  return jsonb_build_object('unarchived',v_deleted,'user_id',p_user_id);
end;
$fn$;

revoke all on function public.archive_scansafe_conversation(uuid,text) from public,anon,authenticated;
revoke all on function public.unarchive_scansafe_conversation(uuid) from public,anon,authenticated;
grant execute on function public.archive_scansafe_conversation(uuid,text) to authenticated;
grant execute on function public.unarchive_scansafe_conversation(uuid) to authenticated;

-- New message automatically returns the conversation to active.
create or replace function public.scansafe_auto_unarchive_conversation()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public
as $trg$
declare
  v_evacuee uuid;
  v_archived_at timestamptz;
begin
  select p.id into v_evacuee
  from public.profiles p
  where p.id in (new.sender_id,new.receiver_id)
    and p.role='evacuee'
  limit 1;

  if v_evacuee is null then return new; end if;

  delete from public.scansafe_conversation_archives
  where evacuee_user_id=v_evacuee
  returning archived_at into v_archived_at;

  if v_archived_at is not null then
    insert into public.audit_events(event_type,actor_id,target_type,target_id,details,created_at)
    values(
      'conversation_unarchived_new_message',
      new.sender_id,
      'evacuee_account',
      v_evacuee::text,
      jsonb_build_object('message_id',new.message_id,'previously_archived_at',v_archived_at),
      now()
    );
  end if;

  return new;
end;
$trg$;

drop trigger if exists scansafe_messages_auto_unarchive on public.messages;
create trigger scansafe_messages_auto_unarchive
after insert on public.messages
for each row execute function public.scansafe_auto_unarchive_conversation();

-- Active contacts: same live messaging data, excluding archived conversations.
create or replace function public.get_staff_message_contacts_v3()
returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog,public
as $contacts$
declare v_result jsonb;
begin
  if auth.uid() is null or not coalesce(public.is_staff(),false) then
    raise exception using errcode='42501',message='Only authorized staff may access conversations';
  end if;

  select coalesce(jsonb_agg(to_jsonb(q) order by q.last_at desc nulls last,q.full_name),'[]'::jsonb)
  into v_result
  from (
    select
      p.id as user_id,
      e.evacuee_id,
      p.full_name,
      lm.message_text as last_message,
      lm.sent_at as last_at,
      (
        select count(*)
        from public.messages um
        where um.sender_id=p.id and um.receiver_id=auth.uid() and um.read_at is null
      ) as unread_count,
      media.object_path as profile_path,
      media.uploaded_at as profile_uploaded_at
    from public.profiles p
    left join lateral (
      select ev.evacuee_id
      from public.evacuees ev
      where ev.auth_user_id=p.id
      order by ev.evacuee_id desc limit 1
    ) e on true
    left join lateral (
      select m.message_text,m.sent_at
      from public.messages m
      where (m.sender_id=auth.uid() and m.receiver_id=p.id)
         or (m.sender_id=p.id and m.receiver_id=auth.uid())
      order by m.sent_at desc,m.message_id desc limit 1
    ) lm on true
    left join lateral (
      select am.object_path,am.uploaded_at
      from public.scansafe_account_media am
      where am.owner_id=p.id and am.kind='profile'
      order by am.uploaded_at desc limit 1
    ) media on true
    where p.role='evacuee'
      and not exists (
        select 1 from public.scansafe_conversation_archives a
        where a.evacuee_user_id=p.id
      )
    limit 100
  ) q;

  return v_result;
end;
$contacts$;

revoke all on function public.get_staff_message_contacts_v3() from public,anon,authenticated;
grant execute on function public.get_staff_message_contacts_v3() to authenticated;

create or replace function public.get_scansafe_archived_conversations()
returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog,public
as $fn$
declare v_result jsonb;
begin
  if auth.uid() is null or not coalesce(public.is_staff(),false) then
    raise exception using errcode='42501',message='Staff access is required';
  end if;

  select coalesce(jsonb_agg(to_jsonb(q) order by q.archived_at desc),'[]'::jsonb)
  into v_result
  from (
    select
      a.evacuee_user_id as user_id,
      p.full_name,
      a.archived_at,
      a.reason,
      actor.full_name as archived_by_name,
      lm.message_text as last_message,
      lm.sent_at as last_message_at
    from public.scansafe_conversation_archives a
    join public.profiles p on p.id=a.evacuee_user_id
    left join public.profiles actor on actor.id=a.archived_by
    left join lateral (
      select m.message_text,m.sent_at
      from public.messages m
      where (m.sender_id=auth.uid() and m.receiver_id=a.evacuee_user_id)
         or (m.sender_id=a.evacuee_user_id and m.receiver_id=auth.uid())
      order by m.sent_at desc,m.message_id desc limit 1
    ) lm on true
  ) q;

  return v_result;
end;
$fn$;

create or replace function public.get_scansafe_stay_history(p_limit integer default 500)
returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog,public
as $fn$
declare v_result jsonb;
begin
  if auth.uid() is null or not coalesce(public.is_staff(),false) then
    raise exception using errcode='42501',message='Staff access is required';
  end if;

  select coalesce(jsonb_agg(to_jsonb(q) order by q.admitted_at desc),'[]'::jsonb)
  into v_result
  from (
    select
      st.stay_id,
      st.operation_id,
      op.name as operation_name,
      st.group_id,
      st.full_name,
      st.group_size,
      st.status,
      st.admitted_at as time_in,
      st.released_at as departure_time,
      case when st.released_at is not null
        then extract(epoch from (st.released_at-st.admitted_at))::bigint
        else null end as duration_seconds,
      coalesce(a.space_snapshot->>'space_code',s.space_code) as space_code,
      coalesce(a.space_snapshot->>'space_name',s.space_name) as space_name,
      coalesce(a.space_snapshot->>'shelter_name',sh.shelter_name) as shelter_name,
      a.assignment_id,
      a.assigned_at,
      a.completed_at
    from public.scansafe_operation_stays st
    left join public.scansafe_operations op on op.operation_id=st.operation_id
    left join lateral (
      select aa.*
      from public.accommodation_assignments aa
      where aa.operation_id=st.operation_id and aa.group_id=st.group_id
      order by aa.assignment_id desc limit 1
    ) a on true
    left join public.accommodation_spaces s on s.space_id=a.space_id
    left join public.shelters sh on sh.shelter_id=s.shelter_id
    order by st.admitted_at desc
    limit greatest(1,least(coalesce(p_limit,500),2000))
  ) q;

  return v_result;
end;
$fn$;

create or replace function public.get_scansafe_admin_audit(p_limit integer default 1000)
returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog,public
as $fn$
declare v_result jsonb;
begin
  if auth.uid() is null or not exists(
    select 1 from public.profiles where id=auth.uid() and role='admin'
  ) then
    raise exception using errcode='42501',message='Administrator access is required';
  end if;

  select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc),'[]'::jsonb)
  into v_result
  from (
    select
      ae.audit_id,
      ae.event_type,
      ae.actor_id,
      coalesce(p.full_name,'System') as actor_name,
      ae.target_type,
      ae.target_id,
      ae.details,
      ae.created_at
    from public.audit_events ae
    left join public.profiles p on p.id=ae.actor_id
    order by ae.created_at desc
    limit greatest(1,least(coalesce(p_limit,1000),5000))
  ) q;

  return v_result;
end;
$fn$;

revoke all on function public.get_scansafe_archived_conversations() from public,anon,authenticated;
revoke all on function public.get_scansafe_stay_history(integer) from public,anon,authenticated;
revoke all on function public.get_scansafe_admin_audit(integer) from public,anon,authenticated;
grant execute on function public.get_scansafe_archived_conversations() to authenticated;
grant execute on function public.get_scansafe_stay_history(integer) to authenticated;
grant execute on function public.get_scansafe_admin_audit(integer) to authenticated;

do $realtime$
begin
  begin alter publication supabase_realtime add table public.scansafe_conversation_archives;
  exception when duplicate_object or undefined_object then null; end;
end;
$realtime$;

notify pgrst,'reload schema';
commit;
