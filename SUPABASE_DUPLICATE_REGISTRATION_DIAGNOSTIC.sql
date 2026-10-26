-- ScanSafe duplicate/orphan registration diagnostic
-- SAFE: read-only. This file does NOT delete or update anything.
--
-- Replace the email/name filters if needed, then run in Supabase SQL Editor.

select
  e.evacuee_id,
  e.registration_code,
  e.full_name,
  e.email,
  e.auth_user_id,
  u.email as auth_email,
  e.approval_status,
  e.current_status,
  e.group_id,
  coalesce(g.group_size,e.group_size) as group_size,
  e.registered_at,
  e.approved_at,
  (
    select b.barcode_value
    from public.barcodes b
    where b.evacuee_id=e.evacuee_id
      and b.status='active'
    order by b.generated_at desc
    limit 1
  ) as active_barcode,
  (
    select s.space_code
    from public.accommodation_assignments a
    join public.accommodation_spaces s on s.space_id=a.space_id
    where a.group_id=e.group_id
      and a.assignment_status='active'
    order by a.assigned_at desc
    limit 1
  ) as active_assignment,
  case
    when e.auth_user_id is null then 'ORPHAN: no Auth user linked'
    when u.id is null then 'ORPHAN: linked Auth user no longer exists'
    else 'LINKED'
  end as link_state
from public.evacuees e
left join auth.users u on u.id=e.auth_user_id
left join public.evacuee_groups g on g.group_id=e.group_id
where lower(coalesce(e.full_name,'')) like '%erson%'
   or lower(coalesce(e.email,'')) like '%erson%'
order by e.evacuee_id desc;

-- What to look for:
-- LINKED = current registration connected to an existing auth.users row.
-- ORPHAN = old application record left behind after an Auth test account
--          was deleted or after an earlier failed registration flow.
--
-- Do NOT delete rows yet if they have an active barcode, active assignment,
-- scan history, or other test data you still need. Identify the current LINKED
-- row first, then clean old test rows separately.
