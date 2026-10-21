ScanSafe Phase 4–6 Combined Patch
====================================

IMPORTANT:
- Patch only. Do NOT delete your existing project.
- No visual redesign is included.
- This assumes Phase 1, Phase 2, and Phase 3 SQL were already run.
- If you already ran the earlier Phase 4 patch, this combined SQL is safe to run again.

FILES TO COPY / OVERWRITE:
1. assets/supabase-bridge.js
2. assets/app-icon-192.png
3. assets/app-icon-512.png
4. manifest.webmanifest
5. service-worker.js

DATABASE:
Run SUPABASE_PHASE4_TO_6.sql in Supabase SQL Editor.

PHASE 4:
- A1-A6 + Main Lobby occupancy from Supabase
- real group-to-space assignment
- capacity validation
- transactional occupancy update

PHASE 5:
- Start Scanning uses the real device camera
- scans QR codes only
- QR is verified through Supabase
- only authorized admin/staff can verify
- successful/revoked/inactive scans are written to scan_logs
- recent scan history is loaded from Supabase
- manual QR search also works

CAMERA REQUIREMENT:
Camera access works on HTTPS deployments (such as Vercel) or localhost.
Browser permission for Camera must be allowed.

PHASE 6:
- Existing evacuee pages become an installable PWA
- no redesign of the user portal
- uses existing Supabase Auth session
- existing QR/profile/accommodation pages remain the UI
- Android/Chrome: open the deployed user portal, then choose Install App/Add to Home Screen

SUPABASE CONFIG:
Keep your existing assets/supabase-config.js.
Do not put the service_role key in frontend files. Use only the publishable/anon key.

TEST ORDER:
1. Admin/staff login.
2. Register evacuee.
3. Admin approves -> QR generated.
4. Assign approved group to A1/A2/etc.
5. Login as evacuee -> QR + assignment should appear.
6. Open QR Scanner as admin/staff.
7. Start Scanning -> allow camera -> scan evacuee QR.
8. Confirm VERIFIED result and scan_logs entry in Supabase.
9. Open user-portal.html on Android Chrome -> Install App/Add to Home Screen.
