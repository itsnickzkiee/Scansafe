-- =========================================================
-- ScanSafe Supabase PHASE 7 + PHASE 8
-- Run AFTER Phases 1-6.
-- Notifications / Messages / Reports & Analytics
-- =========================================================

-- =========================================================
-- PHASE 7A: Notification fields and read tracking
-- =========================================================

alter table public.notifications
  add column if not exists audience text not null default 'all';

alter table public.notifications
  add column if not exists category text not null default 'announcement';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname='notifications_audience_check'
      and conrelid='public.notifications'::regclass
  ) then
    alter table public.notifications
      add constraint notifications_audience_check
      check (audience in ('all','evacuees','staff','specific'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname='notifications_category_check'
      and conrelid='public.notifications'::regclass
  ) then
    alter table public.notifications
      add constraint notifications_category_check
      check (category in ('announcement','emergency','accommodation','system'));
  end if;
end $$;

create table if not exists public.notification_reads (
  notification_id bigint not null
    references public.notifications(notification_id) on delete cascade,
  user_id uuid not null
    references auth.users(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (notification_id,user_id)
);

alter table public.notification_reads enable row level security;

drop policy if exists "users manage own notification reads" on public.notification_reads;
create policy "users manage own notification reads"
on public.notification_reads
for all
to authenticated
using (user_id=auth.uid() or public.is_staff())
with check (user_id=auth.uid() or public.is_staff());

-- Replace the older broad broadcast read rule with an audience-aware rule.
drop policy if exists "read own or broadcast notifications" on public.notifications;
drop policy if exists "phase7 audience notification read" on public.notifications;

create policy "phase7 audience notification read"
on public.notifications
for select
to authenticated
using (
  public.is_staff()
  or recipient_id=auth.uid()
  or (
    recipient_id is null
    and status='active'
    and (
      audience='all'
      or (audience='evacuees' and public.current_user_role()='evacuee')
      or (audience='staff' and public.current_user_role() in ('admin','staff'))
    )
  )
);

create or replace function public.send_scansafe_announcement(
  p_title text,
  p_message text,
  p_audience text default 'evacuees',
  p_level text default 'info',
  p_category text default 'announcement'
)
returns bigint
language plpgsql
security definer
set search_path=public
as $$
declare
  nid bigint;
begin
  if not public.is_staff() then
    raise exception 'Only authorized staff may send announcements';
  end if;

  if trim(coalesce(p_message,''))='' then
    raise exception 'Announcement message is required';
  end if;

  if p_audience not in ('all','evacuees','staff') then
    raise exception 'Invalid announcement audience';
  end if;

  if p_level not in ('info','warning','urgent') then
    p_level:='info';
  end if;

  if p_category not in ('announcement','emergency','accommodation','system') then
    p_category:='announcement';
  end if;

  insert into public.notifications(
    created_by,recipient_id,title,message,notification_level,
    created_at,status,audience,category
  )
  values(
    auth.uid(),null,
    coalesce(nullif(trim(p_title),''),'Shelter Announcement'),
    trim(p_message),p_level,
    now(),'active',p_audience,p_category
  )
  returning notification_id into nid;

  return nid;
end;
$$;

grant execute on function public.send_scansafe_announcement(text,text,text,text,text)
to authenticated;


create or replace function public.get_my_scansafe_notifications()
returns jsonb
language sql
stable
security definer
set search_path=public
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'notification_id',n.notification_id,
        'title',n.title,
        'message',n.message,
        'notification_level',n.notification_level,
        'audience',n.audience,
        'category',n.category,
        'created_at',n.created_at,
        'is_read',(nr.user_id is not null)
      )
      order by n.created_at desc
    ),
    '[]'::jsonb
  )
  from public.notifications n
  left join public.notification_reads nr
    on nr.notification_id=n.notification_id
   and nr.user_id=auth.uid()
  where n.status='active'
    and (
      public.is_staff()
      or n.recipient_id=auth.uid()
      or (
        n.recipient_id is null
        and (
          n.audience='all'
          or (n.audience='evacuees' and public.current_user_role()='evacuee')
          or (n.audience='staff' and public.current_user_role() in ('admin','staff'))
        )
      )
    );
$$;

grant execute on function public.get_my_scansafe_notifications()
to authenticated;


create or replace function public.mark_scansafe_notification_read(p_notification_id bigint)
returns void
language plpgsql
security definer
set search_path=public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not exists (
    select 1
    from public.notifications n
    where n.notification_id=p_notification_id
      and n.status='active'
      and (
        public.is_staff()
        or n.recipient_id=auth.uid()
        or (
          n.recipient_id is null
          and (
            n.audience='all'
            or (n.audience='evacuees' and public.current_user_role()='evacuee')
            or (n.audience='staff' and public.current_user_role() in ('admin','staff'))
          )
        )
      )
  ) then
    raise exception 'Notification not found or not accessible';
  end if;

  insert into public.notification_reads(notification_id,user_id,read_at)
  values(p_notification_id,auth.uid(),now())
  on conflict(notification_id,user_id)
  do update set read_at=excluded.read_at;
end;
$$;

grant execute on function public.mark_scansafe_notification_read(bigint)
to authenticated;


-- Automatic notification after admin approval.
create or replace function public.notify_scansafe_approval()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
begin
  if new.approval_status='approved'
     and old.approval_status is distinct from 'approved'
     and new.auth_user_id is not null then

    insert into public.notifications(
      created_by,recipient_id,title,message,notification_level,
      status,audience,category
    )
    values(
      new.approved_by,new.auth_user_id,
      'Registration Approved',
      'Your ScanSafe registration has been approved. Your QR code is now available in your account.',
      'info','active','specific','system'
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_notify_scansafe_approval on public.evacuees;
create trigger trg_notify_scansafe_approval
after update of approval_status
on public.evacuees
for each row
execute function public.notify_scansafe_approval();


-- Automatic notification after accommodation assignment.
create or replace function public.notify_scansafe_assignment()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
declare
  sname text;
begin
  if new.assignment_status='active' then
    select coalesce(space_name,space_code)
      into sname
    from public.accommodation_spaces
    where space_id=new.space_id;

    insert into public.notifications(
      created_by,recipient_id,title,message,notification_level,
      status,audience,category
    )
    select
      new.assigned_by,e.auth_user_id,
      'Accommodation Assignment',
      'Your group has been assigned to ' || coalesce(sname,'an accommodation space') || '.',
      'info','active','specific','accommodation'
    from public.evacuees e
    where e.group_id=new.group_id
      and e.auth_user_id is not null;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_notify_scansafe_assignment on public.accommodation_assignments;
create trigger trg_notify_scansafe_assignment
after insert
on public.accommodation_assignments
for each row
execute function public.notify_scansafe_assignment();


-- =========================================================
-- PHASE 7B: Real two-way messages
-- =========================================================

create or replace function public.send_message_to_scansafe_admin(p_message text)
returns bigint
language plpgsql
security definer
set search_path=public
as $$
declare
  receiver uuid;
  mid bigint;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if trim(coalesce(p_message,''))='' then
    raise exception 'Message cannot be empty';
  end if;

  select id into receiver
  from public.profiles
  where role='admin'
  order by created_at asc
  limit 1;

  if receiver is null then
    select id into receiver
    from public.profiles
    where role='staff'
    order by created_at asc
    limit 1;
  end if;

  if receiver is null then
    raise exception 'No administrator account is available';
  end if;

  insert into public.messages(sender_id,receiver_id,message_text,sent_at)
  values(auth.uid(),receiver,trim(p_message),now())
  returning message_id into mid;

  return mid;
end;
$$;

grant execute on function public.send_message_to_scansafe_admin(text)
to authenticated;


create or replace function public.staff_send_scansafe_message(
  p_receiver uuid,
  p_message text
)
returns bigint
language plpgsql
security definer
set search_path=public
as $$
declare
  mid bigint;
begin
  if not public.is_staff() then
    raise exception 'Only authorized staff may send this message';
  end if;

  if trim(coalesce(p_message,''))='' then
    raise exception 'Message cannot be empty';
  end if;

  if not exists (
    select 1 from public.profiles
    where id=p_receiver and role='evacuee'
  ) then
    raise exception 'Evacuee account not found';
  end if;

  insert into public.messages(sender_id,receiver_id,message_text,sent_at)
  values(auth.uid(),p_receiver,trim(p_message),now())
  returning message_id into mid;

  return mid;
end;
$$;

grant execute on function public.staff_send_scansafe_message(uuid,text)
to authenticated;


create or replace function public.get_my_admin_thread()
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  update public.messages m
  set read_at=coalesce(m.read_at,now())
  where m.receiver_id=auth.uid()
    and exists(
      select 1 from public.profiles p
      where p.id=m.sender_id
        and p.role in ('admin','staff')
    );

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'message_id',q.message_id,
        'sender_id',q.sender_id,
        'receiver_id',q.receiver_id,
        'message_text',q.message_text,
        'sent_at',q.sent_at,
        'read_at',q.read_at,
        'sender_name',q.sender_name
      )
      order by q.sent_at
    ),
    '[]'::jsonb
  )
  into result
  from (
    select
      m.*,
      coalesce(p.full_name,'ScanSafe User') as sender_name
    from public.messages m
    left join public.profiles p on p.id=m.sender_id
    where (
      m.sender_id=auth.uid()
      and exists(
        select 1 from public.profiles op
        where op.id=m.receiver_id
          and op.role in ('admin','staff')
      )
    ) or (
      m.receiver_id=auth.uid()
      and exists(
        select 1 from public.profiles op
        where op.id=m.sender_id
          and op.role in ('admin','staff')
      )
    )
  ) q;

  return result;
end;
$$;

grant execute on function public.get_my_admin_thread()
to authenticated;


create or replace function public.get_staff_message_contacts()
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  result jsonb;
begin
  if not public.is_staff() then
    raise exception 'Only authorized staff may access conversations';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'user_id',q.user_id,
        'full_name',q.full_name,
        'last_message',q.last_message,
        'last_at',q.last_at,
        'unread_count',q.unread_count
      )
      order by q.last_at desc nulls last, q.full_name
    ),
    '[]'::jsonb
  )
  into result
  from (
    select
      p.id as user_id,
      p.full_name,
      lm.message_text as last_message,
      lm.sent_at as last_at,
      (
        select count(*)
        from public.messages um
        where um.sender_id=p.id
          and um.receiver_id=auth.uid()
          and um.read_at is null
      ) as unread_count
    from public.profiles p
    left join lateral (
      select m.message_text,m.sent_at
      from public.messages m
      where (
        m.sender_id=auth.uid() and m.receiver_id=p.id
      ) or (
        m.sender_id=p.id and m.receiver_id=auth.uid()
      )
      order by m.sent_at desc
      limit 1
    ) lm on true
    where p.role='evacuee'
    limit 100
  ) q;

  return result;
end;
$$;

grant execute on function public.get_staff_message_contacts()
to authenticated;


create or replace function public.get_staff_thread(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  result jsonb;
begin
  if not public.is_staff() then
    raise exception 'Only authorized staff may access conversations';
  end if;

  update public.messages
  set read_at=coalesce(read_at,now())
  where sender_id=p_user_id
    and receiver_id=auth.uid();

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'message_id',q.message_id,
        'sender_id',q.sender_id,
        'receiver_id',q.receiver_id,
        'message_text',q.message_text,
        'sent_at',q.sent_at,
        'read_at',q.read_at,
        'sender_name',q.sender_name
      )
      order by q.sent_at
    ),
    '[]'::jsonb
  )
  into result
  from (
    select m.*,coalesce(p.full_name,'ScanSafe User') as sender_name
    from public.messages m
    left join public.profiles p on p.id=m.sender_id
    where (
      m.sender_id=auth.uid() and m.receiver_id=p_user_id
    ) or (
      m.sender_id=p_user_id and m.receiver_id=auth.uid()
    )
  ) q;

  return result;
end;
$$;

grant execute on function public.get_staff_thread(uuid)
to authenticated;


-- Enable realtime changes when available.
do $$
begin
  begin
    alter publication supabase_realtime add table public.notifications;
  exception when duplicate_object or undefined_object then null;
  end;

  begin
    alter publication supabase_realtime add table public.messages;
  exception when duplicate_object or undefined_object then null;
  end;
end $$;


-- =========================================================
-- PHASE 8: Real Reports & Analytics
-- =========================================================

create table if not exists public.report_exports (
  report_id bigint generated always as identity primary key,
  report_name text not null,
  report_type text not null,
  format text not null check(format in ('pdf','csv','screen')),
  date_start date,
  date_end date,
  generated_by uuid references public.profiles(id) on delete set null,
  generated_at timestamptz not null default now()
);

alter table public.report_exports enable row level security;

drop policy if exists "staff read report exports" on public.report_exports;
create policy "staff read report exports"
on public.report_exports
for select
to authenticated
using(public.is_staff());

drop policy if exists "staff insert report exports" on public.report_exports;
create policy "staff insert report exports"
on public.report_exports
for insert
to authenticated
with check(public.is_staff());


create or replace function public.log_scansafe_report_export(
  p_report_type text,
  p_format text
)
returns bigint
language plpgsql
security definer
set search_path=public
as $$
declare
  rid bigint;
  fmt text;
begin
  if not public.is_staff() then
    raise exception 'Only authorized staff may generate reports';
  end if;

  fmt:=lower(coalesce(p_format,'screen'));
  if fmt not in ('pdf','csv','screen') then
    fmt:='screen';
  end if;

  insert into public.report_exports(
    report_name,report_type,format,
    date_start,date_end,generated_by
  )
  values(
    coalesce(nullif(trim(p_report_type),''),'ScanSafe Report'),
    coalesce(nullif(trim(p_report_type),''),'Summary'),
    fmt,current_date-6,current_date,auth.uid()
  )
  returning report_id into rid;

  return rid;
end;
$$;

grant execute on function public.log_scansafe_report_export(text,text)
to authenticated;


create or replace function public.get_recent_report_exports(p_limit integer default 10)
returns jsonb
language plpgsql
stable
security definer
set search_path=public
as $$
declare
  result jsonb;
begin
  if not public.is_staff() then
    raise exception 'Only authorized staff may view report history';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'report_id',q.report_id,
        'report_name',q.report_name,
        'report_type',q.report_type,
        'format',q.format,
        'date_range',
          case
            when q.date_start is null then 'Current Data'
            else to_char(q.date_start,'Mon DD, YYYY') || ' – ' || to_char(q.date_end,'Mon DD, YYYY')
          end,
        'generated_at',q.generated_at,
        'generated_by_name',q.generated_by_name
      )
      order by q.generated_at desc
    ),
    '[]'::jsonb
  )
  into result
  from (
    select
      r.*,
      coalesce(p.full_name,'Administrator') as generated_by_name
    from public.report_exports r
    left join public.profiles p on p.id=r.generated_by
    order by r.generated_at desc
    limit greatest(1,least(coalesce(p_limit,10),50))
  ) q;

  return result;
end;
$$;

grant execute on function public.get_recent_report_exports(integer)
to authenticated;


create or replace function public.get_scansafe_report_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path=public
as $$
declare
  v_total bigint;
  v_approved bigint;
  v_pending bigint;
  v_active_shelters bigint;
  v_total_shelters bigint;
  v_total_spaces bigint;
  v_capacity bigint;
  v_occupied bigint;
  v_demographics jsonb;
  v_groups jsonb;
  v_shelters jsonb;
  v_trend jsonb;
begin
  if not public.is_staff() then
    raise exception 'Only authorized staff may view reports';
  end if;

  select count(*) into v_total from public.evacuees;
  select count(*) into v_approved from public.evacuees where approval_status='approved';
  select count(*) into v_pending from public.evacuees where approval_status='pending';
  select count(*) into v_active_shelters from public.shelters where status='active';
  select count(*) into v_total_shelters from public.shelters;
  select count(*) into v_total_spaces from public.accommodation_spaces where status<>'inactive';

  select
    coalesce(sum(capacity),0),
    coalesce(sum(current_occupancy),0)
  into v_capacity,v_occupied
  from public.accommodation_spaces
  where status<>'inactive';

  select jsonb_build_object(
    'age_0_12',count(*) filter(where age between 0 and 12),
    'age_13_18',count(*) filter(where age between 13 and 18),
    'age_19_30',count(*) filter(where age between 19 and 30),
    'age_31_50',count(*) filter(where age between 31 and 50),
    'age_51_65',count(*) filter(where age between 51 and 65),
    'age_66_plus',count(*) filter(where age>=66)
  )
  into v_demographics
  from public.evacuees;

  select jsonb_build_object(
    'family_members',count(*) filter(where coalesce(group_size,1)>1),
    'individuals',count(*) filter(where coalesce(group_size,1)=1),
    'senior_citizens',count(*) filter(where age>=60)
  )
  into v_groups
  from public.evacuees;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'shelter_id',x.shelter_id,
        'shelter_name',x.shelter_name,
        'capacity',x.capacity,
        'occupied',x.occupied
      )
      order by x.shelter_name
    ),
    '[]'::jsonb
  )
  into v_shelters
  from (
    select
      sh.shelter_id,
      sh.shelter_name,
      coalesce(sum(sp.capacity) filter(where sp.status<>'inactive'),0) as capacity,
      coalesce(sum(sp.current_occupancy) filter(where sp.status<>'inactive'),0) as occupied
    from public.shelters sh
    left join public.accommodation_spaces sp on sp.shelter_id=sh.shelter_id
    group by sh.shelter_id,sh.shelter_name
  ) x;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'day',d.day::date,
        'label',to_char(d.day,'Mon DD'),
        'count',coalesce(a.cnt,0)
      )
      order by d.day
    ),
    '[]'::jsonb
  )
  into v_trend
  from generate_series(
    current_date-6,
    current_date,
    interval '1 day'
  ) d(day)
  left join (
    select approved_at::date as day,count(*) as cnt
    from public.evacuees
    where approved_at is not null
      and approved_at::date between current_date-6 and current_date
    group by approved_at::date
  ) a on a.day=d.day::date;

  return jsonb_build_object(
    'total_evacuees',v_total,
    'approved_evacuees',v_approved,
    'pending_evacuees',v_pending,
    'active_shelters',v_active_shelters,
    'total_shelters',v_total_shelters,
    'total_spaces',v_total_spaces,
    'total_capacity',v_capacity,
    'current_occupancy',v_occupied,
    'available_capacity',greatest(v_capacity-v_occupied,0),
    'occupancy_percent',
      case when v_capacity>0 then round((v_occupied::numeric/v_capacity::numeric)*100) else 0 end,
    'demographics',v_demographics,
    'group_stats',v_groups,
    'shelters',v_shelters,
    'verification_trend',v_trend
  );
end;
$$;

grant execute on function public.get_scansafe_report_summary()
to authenticated;


create or replace function public.get_scansafe_evacuee_report_rows()
returns table(
  evacuee_id bigint,
  registration_code text,
  full_name text,
  age integer,
  gender text,
  group_size integer,
  approval_status text,
  current_status text,
  space_code text,
  shelter_name text,
  registered_at timestamptz
)
language plpgsql
stable
security definer
set search_path=public
as $$
begin
  if not public.is_staff() then
    raise exception 'Only authorized staff may export evacuee reports';
  end if;

  return query
  select
    e.evacuee_id,
    e.registration_code,
    e.full_name,
    e.age,
    e.gender,
    e.group_size,
    e.approval_status,
    e.current_status,
    sp.space_code,
    sh.shelter_name,
    e.registered_at
  from public.evacuees e
  left join lateral (
    select a.space_id
    from public.accommodation_assignments a
    where a.group_id=e.group_id
      and a.assignment_status='active'
    order by a.assigned_at desc
    limit 1
  ) aa on true
  left join public.accommodation_spaces sp on sp.space_id=aa.space_id
  left join public.shelters sh on sh.shelter_id=sp.shelter_id
  order by e.registered_at desc;
end;
$$;

grant execute on function public.get_scansafe_evacuee_report_rows()
to authenticated;

-- =========================================================
-- END PHASE 7 + 8
-- =========================================================
