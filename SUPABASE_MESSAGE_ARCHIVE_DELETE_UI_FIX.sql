-- ScanSafe Messages Archive/Delete UI follow-up
-- "Delete conversation" is implemented as a safe clear-from-view cutoff.
-- Original message rows remain in the database/audit history.

rollback;
begin;

create table if not exists public.scansafe_conversation_clears(
  evacuee_user_id uuid primary key references public.profiles(id) on delete cascade,
  cleared_by uuid references public.profiles(id) on delete set null,
  cleared_at timestamptz not null default now()
);

alter table public.scansafe_conversation_clears enable row level security;
revoke all on public.scansafe_conversation_clears from public,anon,authenticated;

drop policy if exists scansafe_staff_read_conversation_clears on public.scansafe_conversation_clears;
create policy scansafe_staff_read_conversation_clears
on public.scansafe_conversation_clears for select
to authenticated
using(public.is_staff());

grant select on public.scansafe_conversation_clears to authenticated;

create or replace function public.clear_scansafe_conversation(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $fn$
declare
  v_name text;
  v_now timestamptz:=now();
begin
  if auth.uid() is null or not coalesce(public.is_staff(),false) then
    raise exception using errcode='42501',message='Staff access is required';
  end if;

  select full_name into v_name
  from public.profiles
  where id=p_user_id and role='evacuee';

  if v_name is null then raise exception 'Evacuee account not found'; end if;

  insert into public.scansafe_conversation_clears(evacuee_user_id,cleared_by,cleared_at)
  values(p_user_id,auth.uid(),v_now)
  on conflict(evacuee_user_id) do update
    set cleared_by=excluded.cleared_by,
        cleared_at=excluded.cleared_at;

  perform public.log_scansafe_audit(
    'conversation_cleared','evacuee_account',p_user_id::text,
    jsonb_build_object(
      'evacuee_name',v_name,
      'cleared_at',v_now,
      'retention','message records retained'
    )
  );

  return jsonb_build_object(
    'cleared',true,
    'user_id',p_user_id,
    'full_name',v_name,
    'cleared_at',v_now
  );
end;
$fn$;

create or replace function public.get_scansafe_conversation_state(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog,public
as $fn$
declare
  v_archived_at timestamptz;
  v_cleared_at timestamptz;
begin
  if auth.uid() is null or not coalesce(public.is_staff(),false) then
    raise exception using errcode='42501',message='Staff access is required';
  end if;

  select archived_at into v_archived_at
  from public.scansafe_conversation_archives
  where evacuee_user_id=p_user_id;

  select cleared_at into v_cleared_at
  from public.scansafe_conversation_clears
  where evacuee_user_id=p_user_id;

  return jsonb_build_object(
    'user_id',p_user_id,
    'archived_at',v_archived_at,
    'cleared_at',v_cleared_at
  );
end;
$fn$;

revoke all on function public.clear_scansafe_conversation(uuid) from public,anon,authenticated;
revoke all on function public.get_scansafe_conversation_state(uuid) from public,anon,authenticated;
grant execute on function public.clear_scansafe_conversation(uuid) to authenticated;
grant execute on function public.get_scansafe_conversation_state(uuid) to authenticated;

-- Active message contacts:
-- 1) excludes archived conversations
-- 2) last-message preview ignores messages before the staff's clear cutoff
create or replace function public.get_staff_message_contacts_v4()
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
        where um.sender_id=p.id
          and um.receiver_id=auth.uid()
          and um.read_at is null
          and (clr.cleared_at is null or um.sent_at>clr.cleared_at)
      ) as unread_count,
      media.object_path as profile_path,
      media.uploaded_at as profile_uploaded_at,
      clr.cleared_at
    from public.profiles p
    left join lateral (
      select ev.evacuee_id
      from public.evacuees ev
      where ev.auth_user_id=p.id
      order by ev.evacuee_id desc limit 1
    ) e on true
    left join public.scansafe_conversation_clears clr
      on clr.evacuee_user_id=p.id
    left join lateral (
      select m.message_text,m.sent_at
      from public.messages m
      where ((m.sender_id=auth.uid() and m.receiver_id=p.id)
          or (m.sender_id=p.id and m.receiver_id=auth.uid()))
        and (clr.cleared_at is null or m.sent_at>clr.cleared_at)
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
        select 1
        from public.scansafe_conversation_archives a
        where a.evacuee_user_id=p.id
      )
    limit 100
  ) q;

  return v_result;
end;
$contacts$;

revoke all on function public.get_staff_message_contacts_v4() from public,anon,authenticated;
grant execute on function public.get_staff_message_contacts_v4() to authenticated;

do $realtime$
begin
  begin alter publication supabase_realtime add table public.scansafe_conversation_clears;
  exception when duplicate_object or undefined_object then null; end;
end;
$realtime$;

notify pgrst,'reload schema';
commit;
