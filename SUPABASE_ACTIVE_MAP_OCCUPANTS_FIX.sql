-- ScanSafe deterministic accommodation-map occupants
-- Source of truth: ACTIVE accommodation_assignments.
-- This intentionally does not depend on check-in history.

rollback;
begin;

-- Phase 9 removes the old staff ALL policy to prevent direct assignment writes.
-- Restore only the SELECT access used by the map's active-assignment loader.
-- Keep existing owner/staff policies and all mutation permissions unchanged.
alter table public.accommodation_assignments enable row level security;
grant select on public.accommodation_assignments to authenticated;
drop policy if exists scansafe_staff_read_active_map_assignments
on public.accommodation_assignments;
create policy scansafe_staff_read_active_map_assignments
on public.accommodation_assignments for select to authenticated
using (
  auth.uid() is not null
  and coalesce(public.is_staff(),false)
  and assignment_status='active'
);

create or replace function public.get_scansafe_active_map_occupants()
returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog,public
as $fn$
declare
  v_result jsonb;
begin
  if auth.uid() is null or not coalesce(public.is_staff(),false) then
    raise exception using errcode='42501',message='Staff access is required';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'assignment_id',x.assignment_id,
        'space_id',x.space_id,
        'space_code',x.space_code,
        'space_name',x.space_name,
        'group_id',x.group_id,
        'evacuee_id',x.evacuee_id,
        'full_name',x.full_name,
        'group_size',x.group_size,
        'current_status',x.current_status,
        'arrival_time',x.checked_in_at,
        'map_status',case when x.checked_in_at is not null then 'checked_in' else 'assigned' end
      )
      order by x.space_code,x.assignment_id
    ),
    '[]'::jsonb
  )
  into v_result
  from (
    select
      a.assignment_id,
      a.space_id,
      upper(btrim(s.space_code)) as space_code,
      coalesce(s.space_name,upper(btrim(s.space_code))) as space_name,
      a.group_id,
      e.evacuee_id,
      coalesce(nullif(btrim(e.full_name),''),'Evacuee') as full_name,
      coalesce(g.group_size,a.occupant_count,1) as group_size,
      e.current_status,
      st.checked_in_at
    from public.accommodation_assignments a
    join public.accommodation_spaces s
      on s.space_id=a.space_id
    left join public.evacuee_groups g
      on g.group_id=a.group_id
    left join lateral (
      select ev.evacuee_id,ev.full_name,ev.current_status
      from public.evacuees ev
      where ev.group_id=a.group_id
      order by ev.evacuee_id
      limit 1
    ) e on true
    left join lateral (
      select os.checked_in_at
      from public.scansafe_operation_stays os
      where os.group_id=a.group_id
        and os.status='assigned'
      order by coalesce(os.checked_in_at,os.admitted_at) desc,os.stay_id desc
      limit 1
    ) st on true
    where a.assignment_status='active'
  ) x;

  return v_result;
end;
$fn$;

revoke all on function public.get_scansafe_active_map_occupants()
from public,anon,authenticated;

grant execute on function public.get_scansafe_active_map_occupants()
to authenticated;

notify pgrst,'reload schema';
commit;
