rollback;
begin;

create or replace function public.staff_send_scansafe_message_v2(
  p_receiver uuid,
  p_message text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $fn$
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
$fn$;

revoke all on function public.staff_send_scansafe_message_v2(uuid,text)
from public,anon,authenticated;
grant execute on function public.staff_send_scansafe_message_v2(uuid,text)
to authenticated;

notify pgrst,'reload schema';
commit;
