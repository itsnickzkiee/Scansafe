ScanSafe — Latest Integration Fix (based on the uploaded Scansafe.zip)
=======================================================================

This patch is intentionally based on the user's latest Codex-updated project.
It does NOT replace the newer GBEAA, needs-request, scanner, evacuation-operations,
barcode, or live-sync work.

WHAT THIS FIXES
---------------
1. NO EMAIL CONFIRMATION FLOW
   Intended ScanSafe flow:
   Register -> Login immediately -> Pending Admin Approval -> Admin Approves
   -> Barcode issued -> Eligible for accommodation.

   Supabase Dashboard requirement:
   Authentication -> Sign In / Providers -> Email -> Confirm Email = OFF.

   Email confirmation is NOT ScanSafe's verification/approval step.
   Admin approval controls barcode issuance and accommodation eligibility.

2. EVACUEE PROFILE PHOTO
   profile.html now exposes the existing secure Account Media module.
   Evacuees can upload/update:
   - Profile photo
   - Registration ID image
   JPG/PNG/WEBP, max 2 MB.

3. ADMIN REGISTRATION REVIEW
   Registration Review now uses the existing secure staff RPC and shows:
   - Full registration information
   - Profile photo (when uploaded)
   - Valid ID image
   Images use short-lived signed URLs.

4. REGISTRATION ID UPLOAD
   The existing registration form already required a valid-ID image, but the
   Account Media module was not loaded/initialized on index.html.
   This patch wires it correctly to the temporary signup session.

5. INTERACTIVE NOTIFICATIONS
   The existing notification-center module is now actually loaded and initialized.
   - Bell is clickable.
   - Unread count appears on the bell.
   - Evacuee Notifications navigation shows unread count.
   - Notification details are clickable and mark as read.
   - user-notifications.html now renders live All / Unread / Emergency filters.
   - Recent Announcements are populated from real notifications.

6. PROFILE CLEANUP
   Removed the redundant "Contact Staff" button from the Profile Account card.
   Report-an-issue / messaging workflow remains elsewhere in the evacuee system.

FILES IN THIS PATCH
-------------------
HTML pages are included because they now load:
- assets/account-media.css / .js
- assets/notification-center.css / .js

Core modified files:
- index.html
- profile.html
- assets/app.js
- assets/supabase-bridge.js
- assets/notification-center.js
- assets/style.css
- service-worker.js
- tests/latest-integration.test.cjs

DATABASE SETUP TO RUN
---------------------
If not yet run in the current Supabase project, run these EXISTING latest files
from your project in this order:

1. SUPABASE_ACCOUNT_MEDIA.sql
2. SUPABASE_NOTIFICATION_CENTER.sql

Do not run an old email-confirmation migration. Confirm Email must be OFF in the
Supabase Authentication dashboard.

DEPLOY
------
IMPORTANT: run Git commands from the INNER GitHub-connected project folder.

Check first:
  git rev-parse --show-toplevel
  git remote -v

Then:
  git add .
  git commit -m "Integrate profile media and interactive notifications"
  git push origin main

After Vercel is Ready:
- Logout
- Hard refresh: Ctrl + Shift + R
- Login again

TEST FLOW
---------
A. New evacuee:
   Register with valid ID image -> registration saves -> login immediately.
   Account remains Pending Approval until admin approves.
   No barcode until approval.

B. Profile:
   Open Profile -> upload profile photo -> photo appears in account avatar.

C. Admin:
   Open Registration Requests -> Review -> registration information and secure
   image previews appear.

D. Notifications:
   Create/send a real notification -> unread number appears on bell -> click bell
   -> click notification -> it is marked read and count decreases.

ANDROID
-------
After web testing succeeds:
  cd android-app
  npm.cmd run android:sync

Then rebuild the signed APK with the same release keystore.
