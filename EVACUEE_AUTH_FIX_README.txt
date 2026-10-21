ScanSafe Evacuee Registration / Login Fix
==========================================

WHAT THIS FIXES
---------------
A registered evacuee could try the correct email/password and only see a vague
"invalid" login error.

The frontend now distinguishes:
- email_not_confirmed
- invalid_credentials
- email/password provider disabled
- too many attempts
- duplicate registration email

Registration also tells the evacuee when Supabase requires email confirmation.

IMPORTANT AUTH RULE
-------------------
Supabase has a "Confirm Email" setting.

If Confirm Email is ON:
- registration creates the Auth user
- session is NOT created immediately
- evacuee MUST open the confirmation email first
- login before confirmation returns email_not_confirmed

If Confirm Email is OFF:
- registration creates the Auth user and a session
- ScanSafe signs that temporary session out after registration
- evacuee can immediately log in using the same email/password

ADMIN APPROVAL IS DIFFERENT
---------------------------
ScanSafe admin approval controls:
- QR issuance
- accommodation eligibility

It should NOT be confused with Supabase email confirmation.

APPLY PATCH
-----------
Overwrite in the main ScanSafe project:
- assets/supabase-bridge.js
- service-worker.js

Then:
git add .
git commit -m "Fix evacuee registration and login auth messages"
git push origin main

After Vercel redeploy:
- hard refresh (Ctrl+Shift+R)
- test a NEW evacuee registration

CHECK SUPABASE SETTING
----------------------
Supabase Dashboard:
Authentication -> Sign In / Providers -> Email

If you want evacuees to log in immediately after registration:
DISABLE Confirm Email.

If you want verified email accounts:
KEEP Confirm Email enabled and make sure the evacuee confirms the email before login.

For a capstone/demo where immediate account access is preferred, disabling
Confirm Email is simpler. Admin approval still remains required before QR issuance.

DIAGNOSE AN EXISTING EVACUEE
----------------------------
Open SUPABASE_EVACUEE_AUTH_DIAGNOSTIC.sql.
Replace:
EVACUEE_EMAIL_HERE

Run it in SQL Editor.

Check:
- email_confirmed_at
- profile_id
- role
- evacuee_id
- approval_status

If email_confirmed_at is NULL, either:
1. confirm the email using the message Supabase sent, OR
2. disable Confirm Email for future registrations.

RESEND CONFIRMATION
-------------------
From browser console you can resend a signup confirmation email:

await ScanSafeEvacueeAuth.resendConfirmation('evacuee@example.com')

Do not use this repeatedly because Supabase email rate limits apply.

LOGIN DEBUG
-----------
After/around a login attempt:

await ScanSafeLoginDebug()

PROJECT CHECK
-------------
window.SCANSafeSupabaseConfig

The project URL must match the Supabase project where the evacuee was registered.

ANDROID
-------
If testing the installed APK, rebuild it after applying this frontend patch:

cd android-app
npm.cmd run android:sync

Then rebuild the signed release APK using the SAME keystore.
