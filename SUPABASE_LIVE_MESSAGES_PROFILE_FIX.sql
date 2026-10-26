-- ScanSafe Live Messages + Profile Sync support
-- Safe scope: messages, profiles, account media, report reads only.
-- No accommodation/map rows are inserted, updated, deleted, or reassigned.

rollback;
begin;

do $preflight$
begin
  if to_regprocedure('public.is_staff()') is null then
    raise exception 'Run the existing ScanSafe authentication/security setup first';
  end if;
  if to_regclass('public.messages') is null then
    raise exception 'Run the existing ScanSafe messaging setup first';
  end if;
  if to_regclass('public.scansafe_account_media') is null then
    raise exception 'Run SUPABASE_ACCOUNT_MEDIA.sql first';
  end if;
end;
$preflight$;

-- Exact recipient function. Recreated here so this patch is self-contained.
create or replace function public.staff_send_scansafe_message_v2(
  p_receiver uuid,
  p_message text
)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $send$
declare
  v_message_id bigint;
  v_sent_at timestamptz;
  v_receiver_name text;
begin
  if auth.uid() is null or not coalesce(public.is_staff(),false) then
    raise exception using errcode='42501',message='Only authorized staff may send this message';
  end if;
  if p_receiver is null then raise exception 'Select an evacuee first'; end if;
  if btrim(coalesce(p_message,''))='' then raise exception 'Message cannot be empty'; end if;

  select p.full_name into v_receiver_name
  from public.profiles p
  where p.id=p_receiver and p.role='evacuee';

  if v_receiver_name is null then raise exception 'Evacuee account not found'; end if;

  insert into public.messages(sender_id,receiver_id,message_text,sent_at)
  values(auth.uid(),p_receiver,btrim(p_message),now())
  returning message_id,sent_at into v_message_id,v_sent_at;

  return jsonb_build_object(
    'message_id',v_message_id,
    'receiver_id',p_receiver,
    'receiver_name',v_receiver_name,
    'sent_at',v_sent_at
  );
end;
$send$;

revoke all on function public.staff_send_scansafe_message_v2(uuid,text)
from public,anon,authenticated;
grant execute on function public.staff_send_scansafe_message_v2(uuid,text)
to authenticated;

-- Staff message contacts with the current private profile-photo path.
create or replace function public.get_staff_message_contacts_v2()
returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog,public
as $contacts$
declare
  v_result jsonb;
begin
  if auth.uid() is null or not coalesce(public.is_staff(),false) then
    raise exception using errcode='42501',message='Only authorized staff may access conversations';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'user_id',q.user_id,
        'evacuee_id',q.evacuee_id,
        'full_name',q.full_name,
        'last_message',q.last_message,
        'last_at',q.last_at,
        'unread_count',q.unread_count,
        'profile_path',q.profile_path,
        'profile_uploaded_at',q.profile_uploaded_at
      )
      order by q.last_at desc nulls last,q.full_name
    ),
    '[]'::jsonb
  )
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
        where um.sender_id=p.id
          and um.receiver_id=auth.uid()
          and um.read_at is null
      ) as unread_count,
      media.object_path as profile_path,
      media.uploaded_at as profile_uploaded_at
    from public.profiles p
    left join lateral (
      select ev.evacuee_id
      from public.evacuees ev
      where ev.auth_user_id=p.id
      order by ev.evacuee_id desc
      limit 1
    ) e on true
    left join lateral (
      select m.message_text,m.sent_at
      from public.messages m
      where (m.sender_id=auth.uid() and m.receiver_id=p.id)
         or (m.sender_id=p.id and m.receiver_id=auth.uid())
      order by m.sent_at desc,m.message_id desc
      limit 1
    ) lm on true
    left join lateral (
      select am.object_path,am.uploaded_at
      from public.scansafe_account_media am
      where am.owner_id=p.id
        and am.kind='profile'
        and (e.evacuee_id is null or am.evacuee_id=e.evacuee_id)
      order by am.uploaded_at desc
      limit 1
    ) media on true
    where p.role='evacuee'
    order by lm.sent_at desc nulls last,p.full_name
    limit 100
  ) q;

  return v_result;
end;
$contacts$;

revoke all on function public.get_staff_message_contacts_v2()
from public,anon,authenticated;
grant execute on function public.get_staff_message_contacts_v2()
to authenticated;

-- Realtime publication. Duplicate additions are intentionally ignored.
do $realtime$
begin
  begin
    alter publication supabase_realtime add table public.messages;
  exception when duplicate_object or undefined_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.notifications;
  exception when duplicate_object or undefined_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.scansafe_account_media;
  exception when duplicate_object or undefined_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.profiles;
  exception when duplicate_object or undefined_object then null;
  end;
end;
$realtime$;

notify pgrst,'reload schema';
commit;
