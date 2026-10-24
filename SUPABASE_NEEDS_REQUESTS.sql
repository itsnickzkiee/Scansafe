-- ScanSafe: real necessity requests for evacuees with an active map assignment.
-- Run this ENTIRE file after the existing Phase 7 notifications setup and
-- SUPABASE_EVACUEE_LIVE_SYNC_FIX.sql. No people, spaces, or sample requests are added.
-- Assignment, ownership, duplicate checks and status transitions are server-side.
rollback;
begin;

do $preflight$
declare
  v_column text;
begin
  if to_regprocedure('public.is_staff()') is null
     or to_regprocedure('public.get_my_scansafe_account()') is null
     or to_regprocedure('public.log_scansafe_audit(text,text,text,jsonb)') is null then
    raise exception 'Run the existing ScanSafe setup and SUPABASE_EVACUEE_LIVE_SYNC_FIX.sql before needs requests';
  end if;
  if to_regclass('public.notifications') is null then
    raise exception 'Run SUPABASE_PHASE7_8.sql before needs requests (notifications are required)';
  end if;
  foreach v_column in array array['created_by','recipient_id','title','message','notification_level','status','audience','category'] loop
    if not exists (select 1 from pg_attribute
      where attrelid='public.notifications'::regclass and attname=v_column and not attisdropped) then
      raise exception 'Run SUPABASE_PHASE7_8.sql before needs requests (missing notifications.%)', v_column;
    end if;
  end loop;
end;
$preflight$;

create table if not exists public.need_requests (
  request_id bigint generated always as identity primary key,
  owner_id uuid not null,
  evacuee_id bigint not null references public.evacuees(evacuee_id),
  group_id bigint not null references public.evacuee_groups(group_id),
  assignment_id bigint not null references public.accommodation_assignments(assignment_id),
  space_id bigint not null references public.accommodation_spaces(space_id),
  full_name text not null,
  group_size integer not null check (group_size > 0),
  space_code text not null,
  space_name text not null,
  shelter_name text,
  notes text not null default '' check (length(notes) <= 1000),
  priority text not null check (priority in ('normal','urgent')),
  status text not null default 'pending'
    check (status in ('pending','preparing','ready_for_pickup','for_delivery','provided','unavailable')),
  response text not null default '' check (length(response) <= 1000),
  version integer not null default 1 check (version > 0),
  client_token uuid not null,
  submit_payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  provided_at timestamptz,
  provided_by uuid,
  unique(owner_id, client_token),
  check ((status='provided') = (provided_at is not null and provided_by is not null)),
  check (status <> 'unavailable' or length(btrim(response)) > 0)
);
create index if not exists scansafe_need_requests_owner_created
  on public.need_requests(owner_id, created_at desc, request_id desc);
create index if not exists scansafe_need_requests_group_active
  on public.need_requests(group_id) where status in ('pending','preparing','ready_for_pickup','for_delivery');
create index if not exists scansafe_need_requests_queue
  on public.need_requests(status, priority, created_at);

create table if not exists public.need_request_items (
  item_id bigint generated always as identity primary key,
  request_id bigint not null references public.need_requests(request_id) on delete cascade,
  category text not null check (category in ('food','water','hygiene','bedding','baby','medical','other')),
  item_name text not null check (length(item_name) between 1 and 100),
  normalized_item text not null,
  quantity numeric(8,2) not null check (quantity > 0 and quantity <= 10000),
  unit text not null check (length(unit) between 1 and 30),
  unique(request_id, category, normalized_item)
);
create table if not exists public.need_request_events (
  event_id bigint generated always as identity primary key,
  request_id bigint not null references public.need_requests(request_id) on delete cascade,
  from_status text,
  to_status text not null,
  response text not null default '',
  actor_id uuid not null,
  actor_name text not null,
  created_at timestamptz not null default now()
);
create index if not exists scansafe_need_request_events_request
  on public.need_request_events(request_id, event_id);

alter table public.need_requests enable row level security;
alter table public.need_request_items enable row level security;
alter table public.need_request_events enable row level security;
revoke all on public.need_requests, public.need_request_items, public.need_request_events from public, anon, authenticated;
grant select on public.need_requests, public.need_request_items, public.need_request_events to authenticated;
drop policy if exists scansafe_read_need_requests on public.need_requests;
create policy scansafe_read_need_requests on public.need_requests for select to authenticated
  using (owner_id=auth.uid() or public.is_staff());
drop policy if exists scansafe_read_need_request_items on public.need_request_items;
create policy scansafe_read_need_request_items on public.need_request_items for select to authenticated
  using (exists (select 1 from public.need_requests r where r.request_id=need_request_items.request_id
    and (r.owner_id=auth.uid() or public.is_staff())));
drop policy if exists scansafe_read_need_request_events on public.need_request_events;
create policy scansafe_read_need_request_events on public.need_request_events for select to authenticated
  using (exists (select 1 from public.need_requests r where r.request_id=need_request_events.request_id
    and (r.owner_id=auth.uid() or public.is_staff())));

-- Private read helpers are only called after the public RPC authenticates.
create or replace function public.scansafe_need_account(p_owner uuid)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog, public
as $account$
declare
  v_account jsonb;
  v_approval text;
  v_status text;
  v_group_size integer;
  v_reason text;
begin
  select jsonb_build_object('evacuee_id',e.evacuee_id,'full_name',e.full_name,
    'group_id',e.group_id,'group_size',coalesce(g.group_size,e.group_size,1),
    'assignment_id',a.assignment_id,'space_id',s.space_id,
    'space_code',s.space_code,'space_name',coalesce(s.space_name,s.space_code),
    'shelter_name',sh.shelter_name),e.approval_status,e.current_status,g.group_size
    into v_account,v_approval,v_status,v_group_size
  from public.evacuees e
  left join public.evacuee_groups g on g.group_id=e.group_id
  left join lateral (
    select aa.* from public.accommodation_assignments aa
    where aa.group_id=e.group_id and aa.assignment_status='active'
    order by aa.assigned_at desc nulls last,aa.assignment_id desc limit 1
  ) a on true
  left join public.accommodation_spaces s on s.space_id=a.space_id and s.status<>'inactive'
  left join public.shelters sh on sh.shelter_id=s.shelter_id
  where e.auth_user_id=p_owner order by e.evacuee_id desc limit 1;

  if v_account is null then v_reason:='No registration is linked to your signed-in account.';
  elsif v_approval is distinct from 'approved' then v_reason:='Your registration must be approved before requesting needs.';
  elsif lower(replace(coalesce(v_status,''),'-','_'))='released' then v_reason:='Your shelter stay has ended. Staff must review your record before new requests.';
  elsif v_account->>'assignment_id' is null or v_account->>'space_id' is null
     or coalesce(v_group_size,0)<1 then
    v_reason:='Waiting for accommodation assignment.';
  end if;
  return jsonb_build_object('eligible',v_reason is null,'eligibility_reason',v_reason,'account',v_account);
end;
$account$;
revoke all on function public.scansafe_need_account(uuid) from public, anon, authenticated;

create or replace function public.scansafe_need_request_json(p_request_id bigint)
returns jsonb language sql stable security definer set search_path=pg_catalog, public
as $request_json$
  select (to_jsonb(r)-'client_token'-'submit_payload') || jsonb_build_object(
    'items',coalesce((select jsonb_agg(to_jsonb(i)-'request_id'-'normalized_item' order by i.item_id)
      from public.need_request_items i where i.request_id=r.request_id),'[]'::jsonb),
    'events',coalesce((select jsonb_agg(to_jsonb(ev)-'request_id' order by ev.event_id)
      from public.need_request_events ev where ev.request_id=r.request_id),'[]'::jsonb),
    'current_assignment',(select jsonb_build_object('assignment_id',a.assignment_id,'space_id',s.space_id,
      'space_code',s.space_code,'space_name',coalesce(s.space_name,s.space_code),'shelter_name',sh.shelter_name)
      from public.accommodation_assignments a
      join public.accommodation_spaces s on s.space_id=a.space_id
      left join public.shelters sh on sh.shelter_id=s.shelter_id
      where a.group_id=r.group_id and a.assignment_status='active'
      order by a.assigned_at desc nulls last,a.assignment_id desc limit 1))
  from public.need_requests r where r.request_id=p_request_id;
$request_json$;
revoke all on function public.scansafe_need_request_json(bigint) from public, anon, authenticated;

create or replace function public.get_scansafe_need_request_counts()
returns jsonb language plpgsql stable security definer set search_path=pg_catalog, public
as $counts$
declare
  v_staff boolean;
  v_gate jsonb;
  v_counts jsonb;
begin
  if auth.uid() is null then raise exception using errcode='42501',message='Sign in to view needs requests'; end if;
  v_staff:=coalesce(public.is_staff(),false);
  if not v_staff and not exists (select 1 from public.profiles where id=auth.uid() and role='evacuee') then
    raise exception using errcode='42501',message='A ScanSafe evacuee or staff account is required';
  end if;
  if v_staff then v_gate:=jsonb_build_object('eligible',false,'eligibility_reason',null);
  else v_gate:=public.scansafe_need_account(auth.uid())-'account'; end if;
  select jsonb_build_object('pending',count(*) filter(where status='pending'),
    'preparing',count(*) filter(where status='preparing'),
    'ready_for_pickup',count(*) filter(where status='ready_for_pickup'),
    'for_delivery',count(*) filter(where status='for_delivery'),
    'provided',count(*) filter(where status='provided'),
    'unavailable',count(*) filter(where status='unavailable'),
    'active',count(*) filter(where status in ('pending','preparing','ready_for_pickup','for_delivery')),
    'total',count(*)) into v_counts
  from public.need_requests where v_staff or owner_id=auth.uid();
  return v_counts || v_gate || jsonb_build_object('owner_id',auth.uid(),'mode',case when v_staff then 'staff' else 'evacuee' end);
end;
$counts$;
revoke all on function public.get_scansafe_need_request_counts() from public, anon, authenticated;
grant execute on function public.get_scansafe_need_request_counts() to authenticated;

create or replace function public.get_scansafe_need_requests()
returns jsonb language plpgsql stable security definer set search_path=pg_catalog, public
as $get_requests$
declare
  v_counts jsonb:=public.get_scansafe_need_request_counts();
  v_staff boolean:=(v_counts->>'mode'='staff');
  v_requests jsonb;
  v_gate jsonb;
begin
  select coalesce(jsonb_agg(public.scansafe_need_request_json(r.request_id)
    order by r.created_at desc,r.request_id desc),'[]'::jsonb) into v_requests
  from public.need_requests r where v_staff or r.owner_id=auth.uid();
  v_gate:=case when v_staff then jsonb_build_object('eligible',false,'eligibility_reason',null,'account',null)
    else public.scansafe_need_account(auth.uid()) end;
  return v_gate || jsonb_build_object('owner_id',auth.uid(),'mode',v_counts->>'mode','requests',v_requests,
    'stats',v_counts-'mode'-'eligible'-'eligibility_reason');
end;
$get_requests$;
revoke all on function public.get_scansafe_need_requests() from public, anon, authenticated;
grant execute on function public.get_scansafe_need_requests() to authenticated;

create or replace function public.submit_scansafe_need_request(
  p_items jsonb,p_notes text,p_priority text,p_client_token uuid
)
returns jsonb language plpgsql security definer set search_path=pg_catalog, public
as $submit$
declare
  v_uid uuid:=auth.uid();
  v_evacuee public.evacuees%rowtype;
  v_assignment public.accommodation_assignments%rowtype;
  v_space public.accommodation_spaces%rowtype;
  v_group_id bigint;
  v_group_size integer;
  v_name text;
  v_shelter_name text;
  v_existing public.need_requests%rowtype;
  v_request_id bigint;
  v_items jsonb:='[]'::jsonb;
  v_item jsonb;
  v_category text;
  v_item_name text;
  v_unit text;
  v_quantity numeric;
  v_key text;
  v_keys text[]:=array[]::text[];
  v_notes text:=btrim(coalesce(p_notes,''));
  v_priority text:=lower(btrim(coalesce(p_priority,'')));
  v_payload jsonb;
begin
  if v_uid is null or not exists (select 1 from public.profiles where id=v_uid and role='evacuee') then
    raise exception using errcode='42501',message='An authenticated evacuee account is required to request needs';
  end if;
  if p_client_token is null then raise exception 'A request retry token is required'; end if;
  if length(v_notes)>1000 then raise exception 'Notes must be at most 1000 characters'; end if;
  if v_priority not in ('normal','urgent') then raise exception 'Select a normal or urgent priority'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' then raise exception 'Request items must be a list'; end if;
  if jsonb_array_length(p_items) not between 1 and 20 then raise exception 'Include between 1 and 20 items'; end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) is distinct from 'object' then raise exception 'Each item must contain a category, item name, quantity and unit'; end if;
    v_category:=lower(btrim(coalesce(v_item->>'category','')));
    v_item_name:=regexp_replace(btrim(coalesce(v_item->>'item_name','')),'\s+',' ','g');
    v_unit:=regexp_replace(btrim(coalesce(v_item->>'unit','')),'\s+',' ','g');
    if v_category not in ('food','water','hygiene','bedding','baby','medical','other') then raise exception 'Invalid item category'; end if;
    if length(v_item_name) not between 1 and 100 or length(v_unit) not between 1 and 30 then raise exception 'Item name (1-100) and unit (1-30) are required'; end if;
    if jsonb_typeof(v_item->'quantity') is distinct from 'number' then raise exception 'Item quantity must be a number'; end if;
    v_quantity:=(v_item->>'quantity')::numeric;
    if v_quantity<=0 or v_quantity>10000 or v_quantity<>round(v_quantity,2) then raise exception 'Item quantity must be between 0.01 and 10000 with at most two decimals'; end if;
    v_key:=v_category||':'||lower(v_item_name);
    if v_key=any(v_keys) then raise exception using errcode='P5502',message='Combine duplicate items into one quantity before submitting'; end if;
    v_keys:=array_append(v_keys,v_key);
    v_items:=v_items||jsonb_build_array(jsonb_build_object('category',v_category,'item_name',v_item_name,'quantity',v_quantity,'unit',v_unit));
  end loop;
  -- Canonical payload permits identical retries without trusting a client owner,
  -- assignment ID, space code, name, group size, or status.
  v_payload:=jsonb_build_object('items',v_items,'notes',v_notes,'priority',v_priority);
  perform pg_advisory_xact_lock(hashtextextended('scansafe-needs-owner:'||v_uid::text,0));
  select r.* into v_existing from public.need_requests r
  where r.owner_id=v_uid and r.client_token=p_client_token;
  if found then
    if v_existing.submit_payload is distinct from v_payload then raise exception 'This retry token belongs to a different request'; end if;
    return public.scansafe_need_request_json(v_existing.request_id);
  end if;

  select e.group_id into v_group_id from public.evacuees e
  where e.auth_user_id=v_uid order by e.evacuee_id desc limit 1;
  if not found or v_group_id is null then raise exception 'Waiting for accommodation assignment.'; end if;
  -- Match the scanner's group -> evacuee -> assignment lock order. The group
  -- lock serializes submissions from different signed-in members of one group.
  select g.group_size into v_group_size from public.evacuee_groups g where g.group_id=v_group_id for update;
  select e.* into v_evacuee from public.evacuees e where e.auth_user_id=v_uid
    order by e.evacuee_id desc limit 1 for update;
  if v_evacuee.group_id is distinct from v_group_id then raise exception using errcode='40001',message='Your registration changed. Refresh and try again'; end if;
  if v_evacuee.approval_status is distinct from 'approved' then raise exception 'Your registration must be approved before requesting needs'; end if;
  if lower(replace(coalesce(v_evacuee.current_status,''),'-','_'))='released' then raise exception 'Your shelter stay has ended. Staff must review your record'; end if;
  if coalesce(v_group_size,0)<1 then raise exception 'Your group details must be reviewed by staff'; end if;
  select a.* into v_assignment from public.accommodation_assignments a
  where a.group_id=v_group_id and a.assignment_status='active'
    order by a.assigned_at desc nulls last,a.assignment_id desc limit 1 for update;
  if not found then raise exception 'Waiting for accommodation assignment.'; end if;
  select s.* into v_space from public.accommodation_spaces s
    where s.space_id=v_assignment.space_id and s.status<>'inactive' for share;
  if not found then raise exception 'Waiting for an active accommodation space.'; end if;

  if exists (select 1 from public.need_requests r join public.need_request_items i on i.request_id=r.request_id
    where r.group_id=v_group_id and r.status in ('pending','preparing','ready_for_pickup','for_delivery')
      and (i.category||':'||i.normalized_item)=any(v_keys)) then
    raise exception using errcode='P5502',message='Your group already has an active request for one or more of these items. Check request history before submitting again.';
  end if;
  select sh.shelter_name into v_shelter_name from public.shelters sh where sh.shelter_id=v_space.shelter_id;
  v_name:=coalesce(nullif(v_evacuee.full_name,''),'Evacuee');
  insert into public.need_requests(owner_id,evacuee_id,group_id,assignment_id,space_id,
    full_name,group_size,space_code,space_name,shelter_name,notes,priority,client_token,submit_payload)
  values(v_uid,v_evacuee.evacuee_id,v_group_id,v_assignment.assignment_id,v_space.space_id,
    v_name,v_group_size,v_space.space_code,coalesce(v_space.space_name,v_space.space_code),v_shelter_name,
    v_notes,v_priority,p_client_token,v_payload) returning request_id into v_request_id;
  insert into public.need_request_items(request_id,category,item_name,normalized_item,quantity,unit)
  select v_request_id,i->>'category',i->>'item_name',lower(i->>'item_name'),(i->>'quantity')::numeric,i->>'unit'
  from jsonb_array_elements(v_items) i;
  insert into public.need_request_events(request_id,from_status,to_status,response,actor_id,actor_name)
  values(v_request_id,null,'pending','Request submitted',v_uid,v_name);
  insert into public.notifications(created_by,recipient_id,title,message,notification_level,status,audience,category)
  values(v_uid,null,'New Needs Request #'||v_request_id,
    v_name||' at '||coalesce(v_space.space_name,v_space.space_code)||' submitted a '||v_priority||' needs request.',
    case when v_priority='urgent' then 'urgent' else 'info' end,'active','staff','system');
  perform public.log_scansafe_audit('need_request_submitted','need_request',v_request_id::text,
    jsonb_build_object('group_id',v_group_id,'space_code',v_space.space_code,'priority',v_priority,'item_count',jsonb_array_length(v_items)));
  return public.scansafe_need_request_json(v_request_id);
end;
$submit$;
revoke all on function public.submit_scansafe_need_request(jsonb,text,text,uuid) from public, anon, authenticated;
grant execute on function public.submit_scansafe_need_request(jsonb,text,text,uuid) to authenticated;

create or replace function public.update_scansafe_need_request(
  p_request_id bigint,p_status text,p_response text,p_expected_version integer
)
returns jsonb language plpgsql security definer set search_path=pg_catalog, public
as $update_request$
declare
  v_request public.need_requests%rowtype;
  v_status text:=lower(btrim(coalesce(p_status,'')));
  v_response text:=btrim(coalesce(p_response,''));
  v_actor text;
begin
  if auth.uid() is null or not coalesce(public.is_staff(),false) then
    raise exception using errcode='42501',message='Only authorized staff may process needs requests';
  end if;
  select r.* into v_request from public.need_requests r where r.request_id=p_request_id for update;
  if not found then raise exception 'Needs request not found'; end if;
  if p_expected_version is null or p_expected_version<>v_request.version then
    raise exception using errcode='40001',message='This request was updated by another staff member. Refresh before saving';
  end if;
  if length(v_response)>1000 then raise exception 'Response must be at most 1000 characters'; end if;
  if v_status not in ('pending','preparing','ready_for_pickup','for_delivery','provided','unavailable') then raise exception 'Invalid needs request status'; end if;
  if v_status='unavailable' and v_response='' then raise exception 'Explain why the request is unavailable'; end if;
  if v_status<>v_request.status and not (
    (v_request.status='pending' and v_status in ('preparing','unavailable'))
    or (v_request.status='preparing' and v_status in ('ready_for_pickup','for_delivery','unavailable'))
    or (v_request.status in ('ready_for_pickup','for_delivery') and v_status in ('provided','unavailable'))
  ) then raise exception 'This status transition is not allowed'; end if;
  if v_status=v_request.status and v_response=v_request.response then
    return public.scansafe_need_request_json(v_request.request_id);
  end if;
  select coalesce(nullif(full_name,''),'Shelter staff') into v_actor from public.profiles where id=auth.uid();
  update public.need_requests set status=v_status,response=v_response,version=version+1,updated_at=now(),
    provided_at=case when v_status='provided' then coalesce(provided_at,now()) else null end,
    provided_by=case when v_status='provided' then coalesce(provided_by,auth.uid()) else null end
  where request_id=p_request_id;
  insert into public.need_request_events(request_id,from_status,to_status,response,actor_id,actor_name)
  values(p_request_id,v_request.status,v_status,v_response,auth.uid(),coalesce(v_actor,'Shelter staff'));
  insert into public.notifications(created_by,recipient_id,title,message,notification_level,status,audience,category)
  values(auth.uid(),v_request.owner_id,'Needs Request #'||p_request_id||' Updated',
    'Your needs request is now '||replace(v_status,'_',' ')||case when v_response='' then '.' else '. '||v_response end,
    'info','active','specific','system');
  perform public.log_scansafe_audit('need_request_updated','need_request',p_request_id::text,
    jsonb_build_object('from_status',v_request.status,'to_status',v_status,'version',v_request.version+1));
  return public.scansafe_need_request_json(p_request_id);
end;
$update_request$;
revoke all on function public.update_scansafe_need_request(bigint,text,text,integer) from public, anon, authenticated;
grant execute on function public.update_scansafe_need_request(bigint,text,text,integer) to authenticated;

notify pgrst,'reload schema';
commit;
