-- =========================================================
-- ScanSafe: Auth <-> Evacuee Registration Link Recovery
-- Run the ENTIRE file in Supabase SQL Editor.
-- =========================================================
rollback;
begin;

create or replace function public.scansafe_repair_my_registration_link()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_name text;
  v_role text;
  v_eid bigint;
  v_code text;
  v_has_id boolean := true;
  v_status text := 'linked';
begin
  if v_uid is null then raise exception using errcode='42501', message='Sign in to repair your ScanSafe registration'; end if;
  select lower(trim(u.email)), nullif(trim(coalesce(u.raw_user_meta_data->>'full_name','')),'')
    into v_email,v_name from auth.users u where u.id=v_uid;
  if v_email is null then raise exception 'Authenticated account email was not found'; end if;

  select p.role into v_role from public.profiles p where p.id=v_uid;
  if v_role is not null and v_role<>'evacuee' then
    raise exception using errcode='42501', message='Only evacuee accounts can repair an evacuee registration';
  end if;

  insert into public.profiles(id,full_name,role)
  values(v_uid,coalesce(v_name,split_part(v_email,'@',1)),'evacuee')
  on conflict(id) do update set full_name=case
    when public.profiles.role='evacuee' then coalesce(nullif(excluded.full_name,''),public.profiles.full_name)
    else public.profiles.full_name end;

  select e.evacuee_id,e.registration_code into v_eid,v_code
  from public.evacuees e where e.auth_user_id=v_uid
  order by e.evacuee_id desc limit 1;

  if not found then
    select e.evacuee_id,e.registration_code into v_eid,v_code
    from public.evacuees e
    where e.auth_user_id is null
      and lower(trim(coalesce(e.email,'')))=v_email
      and v_name is not null
      and lower(trim(coalesce(e.full_name,'')))=lower(v_name)
    order by e.evacuee_id desc limit 1 for update;

    if found then
      update public.evacuees set auth_user_id=v_uid
      where evacuee_id=v_eid and auth_user_id is null;
      v_status:='repaired';
    else
      if exists(select 1 from public.evacuees e
        where lower(trim(coalesce(e.email,'')))=v_email
          and e.auth_user_id is not null and e.auth_user_id<>v_uid) then
        raise exception using errcode='23505', message='This registration email is already linked to another ScanSafe account';
      end if;
      return jsonb_build_object('status','completion_required','evacuee_id',null,'registration_code',null,'needs_registration_id',true);
    end if;
  end if;

  if to_regclass('public.scansafe_account_media') is not null then
    execute 'select exists(select 1 from public.scansafe_account_media where owner_id=$1 and evacuee_id=$2 and kind=''valid-id'')'
      into v_has_id using v_uid,v_eid;
  end if;

  return jsonb_build_object('status',v_status,'evacuee_id',v_eid,'registration_code',v_code,'needs_registration_id',not coalesce(v_has_id,false));
end;
$$;
revoke all on function public.scansafe_repair_my_registration_link() from public,anon,authenticated;
grant execute on function public.scansafe_repair_my_registration_link() to authenticated;

create or replace function public.scansafe_complete_my_registration(
  p_full_name text,p_email text,p_age integer,p_gender text,p_group_size integer,
  p_needs text,p_address text,p_barangay text,p_city text,p_valid_id_type text,p_valid_id_number text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_uid uuid := auth.uid();
  v_auth_email text;
  v_profile_role text;
  v_eid bigint;
  v_gid bigint;
  v_code text;
  v_existing_uid uuid;
begin
  if v_uid is null then raise exception using errcode='42501', message='Sign in before completing your ScanSafe registration'; end if;
  if trim(coalesce(p_full_name,''))='' then raise exception 'Full name is required'; end if;
  if p_age is null or p_age<1 or p_age>120 then raise exception 'Age is invalid'; end if;
  if coalesce(p_group_size,0)<1 or p_group_size>50 then raise exception 'Group size must be between 1 and 50'; end if;
  if trim(coalesce(p_address,''))='' then raise exception 'Address is required'; end if;
  if trim(coalesce(p_valid_id_type,''))='' then raise exception 'Valid ID type is required'; end if;
  if trim(coalesce(p_valid_id_number,''))='' then raise exception 'Valid ID number is required'; end if;

  select lower(trim(u.email)) into v_auth_email from auth.users u where u.id=v_uid;
  if v_auth_email is null then raise exception 'Authenticated account email was not found'; end if;
  if v_auth_email<>lower(trim(coalesce(p_email,''))) then raise exception 'Registration email must match the signed-in account'; end if;

  select p.role into v_profile_role from public.profiles p where p.id=v_uid;
  if v_profile_role is not null and v_profile_role<>'evacuee' then
    raise exception using errcode='42501', message='Only evacuee accounts can complete this registration';
  end if;

  perform pg_advisory_xact_lock(hashtext(v_auth_email));
  insert into public.profiles(id,full_name,role) values(v_uid,trim(p_full_name),'evacuee')
  on conflict(id) do update set full_name=case when public.profiles.role='evacuee' then excluded.full_name else public.profiles.full_name end;

  select e.evacuee_id,e.group_id,e.registration_code into v_eid,v_gid,v_code
  from public.evacuees e where e.auth_user_id=v_uid order by e.evacuee_id desc limit 1 for update;
  if found then
    update public.evacuees set full_name=trim(p_full_name),email=v_auth_email,age=p_age,
      gender=nullif(trim(coalesce(p_gender,'')),''),group_size=p_group_size,
      needs_summary=coalesce(nullif(trim(coalesce(p_needs,'')),''),'None'),address=trim(p_address),
      barangay=trim(coalesce(p_barangay,'')),city=trim(coalesce(p_city,'')),
      valid_id_type=trim(p_valid_id_type),valid_id_number=trim(p_valid_id_number)
    where evacuee_id=v_eid;
    if v_gid is null then
      insert into public.evacuee_groups(group_name,group_size) values(trim(p_full_name)||' Group',p_group_size) returning group_id into v_gid;
      update public.evacuees set group_id=v_gid where evacuee_id=v_eid;
    else
      update public.evacuee_groups set group_name=trim(p_full_name)||' Group',group_size=p_group_size where group_id=v_gid;
    end if;
    return jsonb_build_object('status','completed','evacuee_id',v_eid,'registration_code',v_code);
  end if;

  select e.evacuee_id,e.group_id,e.registration_code,e.auth_user_id into v_eid,v_gid,v_code,v_existing_uid
  from public.evacuees e where lower(trim(coalesce(e.email,'')))=v_auth_email
    and lower(trim(coalesce(e.full_name,'')))=lower(trim(p_full_name))
  order by e.evacuee_id desc limit 1 for update;
  if found then
    if v_existing_uid is not null and v_existing_uid<>v_uid then
      raise exception using errcode='23505', message='This registration is already linked to another ScanSafe account';
    end if;
    update public.evacuees set auth_user_id=v_uid,full_name=trim(p_full_name),email=v_auth_email,age=p_age,
      gender=nullif(trim(coalesce(p_gender,'')),''),group_size=p_group_size,
      needs_summary=coalesce(nullif(trim(coalesce(p_needs,'')),''),'None'),address=trim(p_address),
      barangay=trim(coalesce(p_barangay,'')),city=trim(coalesce(p_city,'')),
      valid_id_type=trim(p_valid_id_type),valid_id_number=trim(p_valid_id_number)
    where evacuee_id=v_eid;
    if v_gid is null then
      insert into public.evacuee_groups(group_name,group_size) values(trim(p_full_name)||' Group',p_group_size) returning group_id into v_gid;
      update public.evacuees set group_id=v_gid where evacuee_id=v_eid;
    else
      update public.evacuee_groups set group_name=trim(p_full_name)||' Group',group_size=p_group_size where group_id=v_gid;
    end if;
    return jsonb_build_object('status','repaired','evacuee_id',v_eid,'registration_code',v_code);
  end if;

  if exists(select 1 from public.evacuees e where lower(trim(coalesce(e.email,'')))=v_auth_email and e.auth_user_id is not null and e.auth_user_id<>v_uid) then
    raise exception using errcode='23505', message='This email is already linked to another ScanSafe registration';
  end if;

  v_code:='REQ-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));
  insert into public.evacuee_groups(group_name,group_size) values(trim(p_full_name)||' Group',p_group_size) returning group_id into v_gid;
  insert into public.evacuees(auth_user_id,group_id,registration_code,full_name,email,age,gender,group_size,needs_summary,address,barangay,city,valid_id_type,valid_id_number,approval_status,current_status)
  values(v_uid,v_gid,v_code,trim(p_full_name),v_auth_email,p_age,nullif(trim(coalesce(p_gender,'')),''),p_group_size,
    coalesce(nullif(trim(coalesce(p_needs,'')),''),'None'),trim(p_address),trim(coalesce(p_barangay,'')),trim(coalesce(p_city,'')),
    trim(p_valid_id_type),trim(p_valid_id_number),'pending','registered') returning evacuee_id into v_eid;
  if nullif(trim(coalesce(p_needs,'')),'') is not null and lower(trim(p_needs))<>'none' then
    insert into public.evacuee_needs(evacuee_id,need_type,description,priority_level,status)
    values(v_eid,'Reported Need',trim(p_needs),'medium','pending');
  end if;
  return jsonb_build_object('status','created','evacuee_id',v_eid,'registration_code',v_code);
end;
$$;
revoke all on function public.scansafe_complete_my_registration(text,text,integer,text,integer,text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.scansafe_complete_my_registration(text,text,integer,text,integer,text,text,text,text,text,text) to authenticated;
notify pgrst,'reload schema';
commit;
