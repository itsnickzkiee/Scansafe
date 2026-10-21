-- =========================================================
-- ScanSafe Evacuee Auth Diagnostic
-- Run manually in Supabase SQL Editor when needed.
-- This DOES NOT expose or change passwords.
-- =========================================================

-- Replace the email below with the evacuee email you are testing.
select
  u.id as auth_user_id,
  u.email,
  u.email_confirmed_at,
  u.created_at as auth_created_at,
  p.id as profile_id,
  p.full_name,
  p.role,
  e.evacuee_id,
  e.registration_code,
  e.approval_status,
  e.current_status
from auth.users u
left join public.profiles p on p.id=u.id
left join public.evacuees e on e.auth_user_id=u.id
where lower(u.email)=lower('EVACUEE_EMAIL_HERE');

-- Interpretation:
-- email_confirmed_at IS NULL:
--   Confirm Email is enabled and the evacuee has not confirmed the email yet.
--
-- profile_id IS NULL:
--   Registration did not finish creating the ScanSafe profile.
--
-- role should be:
--   evacuee
--
-- approval_status may be pending:
--   this does NOT block normal login; it only blocks QR issuance/accommodation
--   eligibility until admin approval.
