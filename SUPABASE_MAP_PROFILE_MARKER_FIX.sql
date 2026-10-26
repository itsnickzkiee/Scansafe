-- ScanSafe Map Profile Marker Fix
-- Active assigned groups appear on the accommodation map even before barcode check-in.
-- After first scan, the same marker changes from Assigned -> Checked In.
-- Released groups disappear because their assignment is no longer active.

rollback;
begin;

create or replace function public.get_scansafe_space_occupants()
returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog,public
as $occupants$
declare
  v_result jsonb;
begin
  if auth.uid() is null or not coalesce(public.is_staff(),false) then
    raise exception using errcode='42501',message='Staff access is required';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'space_code',q.space_code,
        'space_name',q.space_name,
        'group_id',q.group_id,
        'evacuee_id',q.evacuee_id,
        'full_name',q.full_name,
        'group_size',q.group_size,
        'arrival_time',q.arrival_time,
        'current_status',q.current_status,
        'map_status',case when q.arrival_time is not null then 'checked_in' else 'assigned' end
      )
      order by q.space_code,q.full_name,q.group_id
    ),
    '[]'::jsonb
  )
  into v_result
  from (
    select
      s.space_code,
      coalesce(s.space_name,s.space_code) as space_name,
      a.group_id,
      e.evacuee_id,
      e.full_name,
      coalesce(g.group_size,a.occupant_count,1) as group_size,
      st.checked_in_at as arrival_time,
      e.current_status
    from public.accommodation_assignments a
    join public.accommodation_spaces s
      on s.space_id=a.space_id
    join public.evacuee_groups g
      on g.group_id=a.group_id
    join lateral(
      select ev.*
      from public.evacuees ev
      where ev.group_id=a.group_id
      order by ev.evacuee_id
      limit 1
    ) e on true
    left join lateral(
      select x.checked_in_at
      from public.scansafe_operation_stays x
      where x.group_id=a.group_id
        and x.status='assigned'
      order by coalesce(x.checked_in_at,x.admitted_at) desc,x.stay_id desc
      limit 1
    ) st on true
    where a.assignment_status='active'
  ) q;

  return v_result;
end;
$occupants$;

revoke all on function public.get_scansafe_space_occupants()
from public,anon,authenticated;

grant execute on function public.get_scansafe_space_occupants()
to authenticated;

notify pgrst,'reload schema';
commit;
