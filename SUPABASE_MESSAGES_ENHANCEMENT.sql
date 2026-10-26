-- ScanSafe Messages Realtime / Typing support
-- Messaging-only patch. No map/accommodation objects are changed.

rollback;
begin;

create or replace function public.get_my_scansafe_message_contact()
returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog,public,auth
as $fn$
declare
  v_uid uuid:=auth.uid();
  v_id uuid;
  v_name text;
begin
  if v_uid is null then
    raise exception using errcode='42501',message='Authentication required';
  end if;

  -- Prefer the staff/admin account from the most recent existing conversation.
  select p.id,p.full_name
    into v_id,v_name
  from public.messages m
  join public.profiles p
    on p.id=case when m.sender_id=v_uid then m.receiver_id else m.sender_id end
  where (m.sender_id=v_uid or m.receiver_id=v_uid)
    and p.role in ('admin','staff')
  order by m.sent_at desc,m.message_id desc
  limit 1;

  -- No previous conversation: use the primary administrator, then staff.
  if v_id is null then
    select p.id,p.full_name
      into v_id,v_name
    from public.profiles p
    where p.role='admin'
    order by p.created_at asc,p.id
    limit 1;
  end if;

  if v_id is null then
    select p.id,p.full_name
      into v_id,v_name
    from public.profiles p
    where p.role='staff'
    order by p.created_at asc,p.id
    limit 1;
  end if;

  if v_id is null then
    return null;
  end if;

  return jsonb_build_object(
    'user_id',v_id,
    'full_name',coalesce(nullif(trim(v_name),''),'ScanSafe Staff')
  );
end;
$fn$;

revoke all on function public.get_my_scansafe_message_contact()
from public,anon,authenticated;

grant execute on function public.get_my_scansafe_message_contact()
to authenticated;

notify pgrst,'reload schema';
commit;
