-- ScanSafe: authenticated room availability for the evacuee accommodation map.
-- Run this ENTIRE file in Supabase SQL Editor after the existing ScanSafe setup.
-- No registrations, assignments, rooms, capacities or occupancy values change.
-- Staff table policies stay intact. Only safe shared room counts are returned;
-- no evacuee names, group IDs, barcodes, assignments or uploaded files are exposed.
rollback;
begin;

create or replace function public.get_scansafe_map_availability()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $map_availability$
declare
  v_spaces jsonb;
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('evacuee','staff','admin')
  ) then
    raise exception using errcode = '42501',
      message = 'A signed-in ScanSafe evacuee or staff account is required to view the map';
  end if;

  -- Explicit fields keep future staff-only columns private. A successful empty
  -- array means no active spaces; denied/missing/network errors are not empty.
  select coalesce(jsonb_agg(jsonb_build_object(
    'space_id', s.space_id,
    'space_code', s.space_code,
    'space_name', s.space_name,
    'space_type', s.space_type,
    'capacity', s.capacity,
    'current_occupancy', coalesce(s.current_occupancy, 0),
    'accessible', s.accessible,
    'is_primary', s.is_primary,
    'status', s.status,
    'shelter_id', s.shelter_id
  ) order by s.is_primary desc, s.space_code, s.space_id), '[]'::jsonb)
    into v_spaces
  from public.accommodation_spaces s
  where s.status <> 'inactive';

  return v_spaces;
end;
$map_availability$;

revoke all on function public.get_scansafe_map_availability() from public, anon, authenticated;
grant execute on function public.get_scansafe_map_availability() to authenticated;

notify pgrst, 'reload schema';
commit;
