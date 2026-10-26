-- ScanSafe Final Registration Review / Correction Flow
-- Adds admin rejection reasons, private evacuee notices, correction/resubmit,
-- and registration review history/audit. Does not touch accommodation/map logic.

rollback;
begin;

do $preflight$
begin
  if to_regclass('public.evacuees') is null
     or to_regclass('public.notifications') is null
     or to_regclass('public.audit_events') is null
     or to_regclass('public.scansafe_account_media') is null
     or to_regprocedure('public.is_staff()') is null
     or to_regprocedure('public.log_scansafe_audit(text,text,text,jsonb)') is null then
    raise exception 'Run the existing ScanSafe registration, notification, security and account-media setup first';
  end if;
end;
$preflight$;

alter table public.evacuees
  add column if not exists contact_number text,
  add column if not exists emergency_contact text,
  add column if not exists review_issues text[] not null default '{}'::text[],
  add column if not exists review_note text,
  add column if not exists rejected_at timestamptz,
  add column if not exists rejected_by uuid references public.profiles(id) on delete set null,
  add column if not exists resubmitted_at timestamptz,
  add column if not exists registration_revision integer not null default 1;

create table if not exists public.scansafe_registration_review_history(
  review_id bigint generated always as identity primary key,
  evacuee_id bigint not null references public.evacuees(evacuee_id) on delete cascade,
  action text not null check(action in ('submitted','rejected','resubmitted','approved')),
  actor_id uuid references public.profiles(id) on delete set null,
  issues text[] not null default '{}'::text[],
  note text,
  revision integer not null default 1,
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.scansafe_registration_review_history enable row level security;
revoke all on public.scansafe_registration_review_history from public,anon,authenticated;

drop policy if exists scansafe_staff_read_registration_review_history
on public.scansafe_registration_review_history;
create policy scansafe_staff_read_registration_review_history
on public.scansafe_registration_review_history for select
to authenticated
using(public.is_staff());

grant select on public.scansafe_registration_review_history to authenticated;

create or replace function public.scansafe_registration_snapshot(p_evacuee_id bigint)
returns jsonb
language sql
stable
security definer
set search_path=pg_catalog,public
as $snapshot$
  select coalesce(
    (
      select jsonb_build_object(
        'registration_code',e.registration_code,
        'full_name',e.full_name,
        'email',e.email,
        'age',e.age,
        'gender',e.gender,
        'group_size',e.group_size,
        'needs',coalesce(e.needs_summary,'None'),
        'contact_number',e.contact_number,
        'emergency_contact',e.emergency_contact,
        'address',e.address,
        'barangay',e.barangay,
        'city',e.city,
        'valid_id_type',e.valid_id_type,
        'valid_id_number',e.valid_id_number,
        'approval_status',e.approval_status,
        'current_status',e.current_status
      )
      from public.evacuees e
      where e.evacuee_id=p_evacuee_id
    ),
    '{}'::jsonb
  );
$snapshot$;

revoke all on function public.scansafe_registration_snapshot(bigint)
from public,anon,authenticated;

create or replace function public.scansafe_registration_audit_details(p_evacuee_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog,public
as $audit$
declare
  v jsonb:=public.scansafe_registration_snapshot(p_evacuee_id);
  v_id text:=coalesce(v->>'valid_id_number','');
begin
  if v_id<>'' then
    v:=v||jsonb_build_object(
      'valid_id_number',
      case when length(v_id)<=4 then repeat('*',length(v_id))
           else repeat('*',greatest(0,length(v_id)-4))||right(v_id,4) end
    );
  end if;
  return v;
end;
$audit$;

revoke all on function public.scansafe_registration_audit_details(bigint)
from public,anon,authenticated;

-- Record the initial registration snapshot for all future registrations.
create or replace function public.scansafe_record_registration_submission()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public
as $trg$
declare
  v_snapshot jsonb;
begin
  v_snapshot:=public.scansafe_registration_snapshot(new.evacuee_id);

  insert into public.scansafe_registration_review_history(
    evacuee_id,action,actor_id,revision,snapshot,created_at
  )
  values(
    new.evacuee_id,'submitted',new.auth_user_id,
    coalesce(new.registration_revision,1),v_snapshot,
    coalesce(new.registered_at,now())
  );

  insert into public.audit_events(
    event_type,actor_id,target_type,target_id,details,created_at
  )
  values(
    'registration_submitted',
    new.auth_user_id,
    'evacuee',
    new.evacuee_id::text,
    public.scansafe_registration_audit_details(new.evacuee_id),
    coalesce(new.registered_at,now())
  );

  return new;
end;
$trg$;

drop trigger if exists scansafe_record_registration_submission on public.evacuees;
create trigger scansafe_record_registration_submission
after insert on public.evacuees
for each row execute function public.scansafe_record_registration_submission();

-- Backfill current registrations as snapshots without pretending they are a new action.
insert into public.scansafe_registration_review_history(
  evacuee_id,action,actor_id,revision,snapshot,created_at
)
select
  e.evacuee_id,
  'submitted',
  e.auth_user_id,
  coalesce(e.registration_revision,1),
  public.scansafe_registration_snapshot(e.evacuee_id),
  coalesce(e.registered_at,now())
from public.evacuees e
where not exists(
  select 1
  from public.scansafe_registration_review_history h
  where h.evacuee_id=e.evacuee_id and h.action='submitted'
);

insert into public.audit_events(event_type,actor_id,target_type,target_id,details,created_at)
select
  'registration_submitted_snapshot',
  e.auth_user_id,
  'evacuee',
  e.evacuee_id::text,
  public.scansafe_registration_audit_details(e.evacuee_id)
    || jsonb_build_object('snapshot_source','existing_record'),
  coalesce(e.registered_at,now())
from public.evacuees e
where not exists(
  select 1 from public.audit_events a
  where a.event_type in ('registration_submitted','registration_submitted_snapshot')
    and a.target_type='evacuee'
    and a.target_id=e.evacuee_id::text
);

create or replace function public.reject_evacuee_registration_v2(
  p_evacuee_id bigint,
  p_issues text[],
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $reject$
declare
  v_uid uuid;
  v_name text;
  v_status text;
  v_issues text[];
  v_note text:=nullif(btrim(coalesce(p_note,'')),'');
  v_snapshot jsonb;
  v_message text;
begin
  if auth.uid() is null or not exists(
    select 1 from public.profiles p where p.id=auth.uid() and p.role='admin'
  ) then
    raise exception using errcode='42501',message='Administrator approval is required';
  end if;

  v_issues:=array(
    select distinct x
    from unnest(coalesce(p_issues,'{}'::text[])) x
    where x in ('invalid_id','id_unreadable','id_mismatch','missing_information','address_verification','other')
  );

  if coalesce(array_length(v_issues,1),0)=0 then
    raise exception 'Select at least one review issue before rejecting the registration';
  end if;

  select e.auth_user_id,e.full_name,e.approval_status
    into v_uid,v_name,v_status
  from public.evacuees e
  where e.evacuee_id=p_evacuee_id
  for update;

  if not found then raise exception 'Evacuee not found'; end if;
  if v_status='approved' then raise exception 'An approved registration cannot be rejected directly'; end if;
  if v_uid is null then raise exception 'This registration is not linked to an evacuee account'; end if;

  update public.evacuees
  set approval_status='rejected',
      approved_at=null,
      approved_by=null,
      review_issues=v_issues,
      review_note=v_note,
      rejected_at=now(),
      rejected_by=auth.uid(),
      resubmitted_at=null
  where evacuee_id=p_evacuee_id;

  v_snapshot:=public.scansafe_registration_snapshot(p_evacuee_id);

  insert into public.scansafe_registration_review_history(
    evacuee_id,action,actor_id,issues,note,revision,snapshot
  )
  select e.evacuee_id,'rejected',auth.uid(),v_issues,v_note,e.registration_revision,v_snapshot
  from public.evacuees e where e.evacuee_id=p_evacuee_id;

  v_message:='Your registration needs correction before it can be approved. Open Profile to review the requested changes and resubmit.';
  if v_note is not null then v_message:=v_message||' Admin note: '||v_note; end if;

  insert into public.notifications(
    created_by,recipient_id,title,message,notification_level,status,audience,category
  )
  values(
    auth.uid(),v_uid,
    'Registration Needs Correction',
    v_message,
    'warning','active','specific','system'
  );

  perform public.log_scansafe_audit(
    'registration_rejected','evacuee',p_evacuee_id::text,
    public.scansafe_registration_audit_details(p_evacuee_id)
      || jsonb_build_object('issues',to_jsonb(v_issues),'note',v_note)
  );

  return jsonb_build_object(
    'rejected',true,
    'evacuee_id',p_evacuee_id,
    'full_name',v_name,
    'issues',to_jsonb(v_issues),
    'note',v_note
  );
end;
$reject$;

revoke all on function public.reject_evacuee_registration_v2(bigint,text[],text)
from public,anon,authenticated;
grant execute on function public.reject_evacuee_registration_v2(bigint,text[],text)
to authenticated;

-- Keep old clients safe: a legacy reject is still recorded with a generic issue.
create or replace function public.reject_evacuee_registration(p_evacuee_id bigint)
returns void
language plpgsql
security definer
set search_path=pg_catalog,public
as $legacy$
begin
  perform public.reject_evacuee_registration_v2(
    p_evacuee_id,array['other']::text[],'Registration requires correction.'
  );
end;
$legacy$;

revoke all on function public.reject_evacuee_registration(bigint)
from public,anon,authenticated;
grant execute on function public.reject_evacuee_registration(bigint)
to authenticated;

create or replace function public.get_my_registration_correction()
returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog,public
as $mine$
declare
  v_uid uuid:=auth.uid();
  v_e public.evacuees%rowtype;
  v_requires_id boolean:=false;
begin
  if v_uid is null then
    raise exception using errcode='42501',message='Sign in to view your registration review';
  end if;

  select e.* into v_e
  from public.evacuees e
  where e.auth_user_id=v_uid
  order by e.evacuee_id desc
  limit 1;

  if not found then return jsonb_build_object('registration',null); end if;

  v_requires_id:=coalesce(v_e.review_issues,'{}'::text[])
    && array['invalid_id','id_unreadable','id_mismatch']::text[];

  return jsonb_build_object(
    'registration',public.scansafe_registration_snapshot(v_e.evacuee_id),
    'evacuee_id',v_e.evacuee_id,
    'approval_status',v_e.approval_status,
    'issues',to_jsonb(coalesce(v_e.review_issues,'{}'::text[])),
    'note',v_e.review_note,
    'rejected_at',v_e.rejected_at,
    'revision',v_e.registration_revision,
    'requires_new_id',v_requires_id,
    'valid_id_uploaded_at',(
      select m.uploaded_at
      from public.scansafe_account_media m
      where m.owner_id=v_uid and m.evacuee_id=v_e.evacuee_id and m.kind='valid-id'
    )
  );
end;
$mine$;

revoke all on function public.get_my_registration_correction()
from public,anon,authenticated;
grant execute on function public.get_my_registration_correction()
to authenticated;

create or replace function public.resubmit_my_registration_correction(
  p_full_name text,
  p_age integer,
  p_gender text,
  p_group_size integer,
  p_needs text,
  p_contact_number text,
  p_emergency_contact text,
  p_address text,
  p_barangay text,
  p_city text,
  p_valid_id_type text,
  p_valid_id_number text
)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public
as $resubmit$
declare
  v_uid uuid:=auth.uid();
  v_e public.evacuees%rowtype;
  v_requires_id boolean:=false;
  v_id_uploaded_at timestamptz;
  v_snapshot jsonb;
begin
  if v_uid is null then
    raise exception using errcode='42501',message='Sign in before resubmitting your registration';
  end if;

  select e.* into v_e
  from public.evacuees e
  where e.auth_user_id=v_uid
  order by e.evacuee_id desc
  limit 1
  for update;

  if not found then raise exception 'Registration not found'; end if;
  if v_e.approval_status<>'rejected' then
    raise exception 'Corrections are available only when the registration was rejected for review';
  end if;

  if btrim(coalesce(p_full_name,''))='' then raise exception 'Full name is required'; end if;
  if p_age is null or p_age<1 or p_age>120 then raise exception 'Enter a valid age'; end if;
  if coalesce(p_group_size,0)<1 or p_group_size>50 then raise exception 'Group size must be between 1 and 50'; end if;
  if btrim(coalesce(p_address,''))='' or btrim(coalesce(p_barangay,''))='' or btrim(coalesce(p_city,''))='' then
    raise exception 'Complete address, barangay and city are required';
  end if;
  if btrim(coalesce(p_valid_id_type,''))='' or btrim(coalesce(p_valid_id_number,''))='' then
    raise exception 'Valid ID type and ID number are required';
  end if;

  v_requires_id:=coalesce(v_e.review_issues,'{}'::text[])
    && array['invalid_id','id_unreadable','id_mismatch']::text[];

  if v_requires_id then
    select m.uploaded_at into v_id_uploaded_at
    from public.scansafe_account_media m
    where m.owner_id=v_uid and m.evacuee_id=v_e.evacuee_id and m.kind='valid-id';

    if v_id_uploaded_at is null
       or v_e.rejected_at is null
       or v_id_uploaded_at<=v_e.rejected_at then
      raise exception 'Upload a new valid ID image before resubmitting this registration';
    end if;
  end if;

  update public.evacuees
  set full_name=btrim(p_full_name),
      age=p_age,
      gender=nullif(btrim(coalesce(p_gender,'')),''),
      group_size=p_group_size,
      needs_summary=coalesce(nullif(btrim(coalesce(p_needs,'')),''),'None'),
      contact_number=nullif(btrim(coalesce(p_contact_number,'')),''),
      emergency_contact=nullif(btrim(coalesce(p_emergency_contact,'')),''),
      address=btrim(p_address),
      barangay=btrim(p_barangay),
      city=btrim(p_city),
      valid_id_type=btrim(p_valid_id_type),
      valid_id_number=btrim(p_valid_id_number),
      approval_status='pending',
      approved_at=null,
      approved_by=null,
      resubmitted_at=now(),
      registration_revision=coalesce(registration_revision,1)+1,
      review_issues='{}'::text[],
      review_note=null,
      rejected_at=null,
      rejected_by=null
  where evacuee_id=v_e.evacuee_id;

  update public.profiles
  set full_name=btrim(p_full_name)
  where id=v_uid and role='evacuee';

  update public.evacuee_groups
  set group_name=btrim(p_full_name)||' Group',
      group_size=p_group_size
  where group_id=v_e.group_id;

  v_snapshot:=public.scansafe_registration_snapshot(v_e.evacuee_id);

  insert into public.scansafe_registration_review_history(
    evacuee_id,action,actor_id,revision,snapshot
  )
  select e.evacuee_id,'resubmitted',v_uid,e.registration_revision,v_snapshot
  from public.evacuees e where e.evacuee_id=v_e.evacuee_id;

  insert into public.notifications(
    created_by,recipient_id,title,message,notification_level,status,audience,category
  )
  values(
    v_uid,null,
    'Registration Resubmitted',
    btrim(p_full_name)||' corrected and resubmitted registration '
      ||coalesce(v_e.registration_code,'')||'. Open Registration Requests to review the updated information.',
    'info','active','staff','system'
  );

  perform public.log_scansafe_audit(
    'registration_resubmitted','evacuee',v_e.evacuee_id::text,
    public.scansafe_registration_audit_details(v_e.evacuee_id)
  );

  return jsonb_build_object(
    'resubmitted',true,
    'evacuee_id',v_e.evacuee_id,
    'approval_status','pending',
    'revision',(select e.registration_revision from public.evacuees e where e.evacuee_id=v_e.evacuee_id)
  );
end;
$resubmit$;

revoke all on function public.resubmit_my_registration_correction(
  text,integer,text,integer,text,text,text,text,text,text,text,text
) from public,anon,authenticated;
grant execute on function public.resubmit_my_registration_correction(
  text,integer,text,integer,text,text,text,text,text,text,text,text
) to authenticated;

create or replace function public.get_scansafe_registration_review_history(p_evacuee_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog,public
as $history$
declare
  v_result jsonb;
begin
  if auth.uid() is null or not coalesce(public.is_staff(),false) then
    raise exception using errcode='42501',message='Staff access is required';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'review_id',h.review_id,
        'action',h.action,
        'actor_name',coalesce(p.full_name,case when h.actor_id is null then 'System' else 'Evacuee' end),
        'issues',to_jsonb(h.issues),
        'note',h.note,
        'revision',h.revision,
        'snapshot',h.snapshot,
        'created_at',h.created_at
      )
      order by h.created_at desc,h.review_id desc
    ),
    '[]'::jsonb
  )
  into v_result
  from public.scansafe_registration_review_history h
  left join public.profiles p on p.id=h.actor_id
  where h.evacuee_id=p_evacuee_id;

  return v_result;
end;
$history$;

revoke all on function public.get_scansafe_registration_review_history(bigint)
from public,anon,authenticated;
grant execute on function public.get_scansafe_registration_review_history(bigint)
to authenticated;

-- Record successful approval in review history without replacing the existing approval logic.
create or replace function public.scansafe_record_registration_approval()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public
as $approved$
begin
  if new.approval_status='approved'
     and old.approval_status is distinct from 'approved' then
    insert into public.scansafe_registration_review_history(
      evacuee_id,action,actor_id,revision,snapshot
    )
    values(
      new.evacuee_id,'approved',new.approved_by,
      coalesce(new.registration_revision,1),
      public.scansafe_registration_snapshot(new.evacuee_id)
    );
  end if;
  return new;
end;
$approved$;

drop trigger if exists scansafe_record_registration_approval on public.evacuees;
create trigger scansafe_record_registration_approval
after update of approval_status on public.evacuees
for each row execute function public.scansafe_record_registration_approval();

do $realtime$
begin
  begin alter publication supabase_realtime add table public.scansafe_registration_review_history;
  exception when duplicate_object or undefined_object then null; end;
end;
$realtime$;

notify pgrst,'reload schema';
commit;
