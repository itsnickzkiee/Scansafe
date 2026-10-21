ScanSafe Phase 9 — Security + Full End-to-End Testing
=======================================================

PATCH ONLY. NO DESIGN CHANGES.
Run after Phases 1–8.

COPY / OVERWRITE
----------------
1. assets/supabase-bridge.js
2. service-worker.js
3. vercel.json  (new file; if you already created your own vercel.json, merge the headers instead of overwriting it)

DATABASE
--------
Run SUPABASE_PHASE9_SECURITY_TESTING.sql in Supabase SQL Editor.

WHAT PHASE 9 HARDENS
--------------------
- Public registration must create/link a Supabase Auth evacuee account.
- Old anonymous registration-without-account RPC is disabled.
- Case-insensitive duplicate email protection.
- Admin-only Approve / Reject.
- Staff cannot directly bypass accommodation capacity by inserting assignments.
- Staff uses transactional assignment RPCs.
- QR verification remains staff/admin only.
- Direct scan-log writes are blocked; QR verification creates scan logs.
- Direct message inserts are blocked; controlled message RPCs are used.
- Profile role changes and shelter/space configuration are admin-only.
- Sensitive RPC EXECUTE permissions are removed from anon/PUBLIC.
- Protected pages now validate the real Supabase session + role.
- Staff cannot open Settings/User Management unless role=admin.
- Evacuees cannot open admin/staff pages.
- Backend outage no longer silently falls back to fake prototype writes when Supabase is configured.
- Logout clears synced prototype cache from the browser.
- Vercel security headers added.
- Audit events added for approvals, rejections, assignments, transfers, releases, QR status changes and occupancy repair.

NEW BACKEND FUNCTIONS
---------------------
reject_evacuee_registration(evacuee_id)
release_group_assignment(group_id)
transfer_group_assignment(group_id,new_space_code)
set_scansafe_qr_status(evacuee_id,status)
scansafe_security_health_check()
reconcile_scansafe_occupancy()

PHASE 9 TEST PLAN
-----------------
A. ACCOUNT / ROLE TESTS
1. Open an admin page while logged out -> must return to index.html.
2. Login as evacuee and manually open admin-dashboard.html -> must return to user-portal.html.
3. Login as staff and open settings.html or user-management.html -> must return to admin-dashboard.html.
4. Login as admin -> Settings/User Management remain accessible.

B. REGISTRATION / APPROVAL TESTS
5. Register a new evacuee account -> status must be Pending, no QR.
6. Try to assign the pending account -> must fail.
7. Login as staff and try Approve -> backend must reject with Administrator approval required.
8. Login as admin and Approve -> QR must be generated once.
9. Approve again -> must not generate a duplicate QR.
10. Reject a fresh pending request -> no QR should exist.

C. ACCOMMODATION TESTS
11. Assign an approved group with active QR to A1 -> occupancy increases by group size.
12. Attempt a second active assignment for the same group -> must fail.
13. Fill a space and try to overbook -> must fail.
14. Run ScanSafePhase9.healthCheck() in browser DevTools while logged in as admin.
15. occupancy_mismatches and over_capacity_spaces should be 0.
16. If occupancy_mismatches is non-zero, run await ScanSafePhase9.reconcileOccupancy(), then healthCheck again.

D. QR SCANNER TESTS
17. Scan valid approved active QR -> VERIFIED + scan_logs row.
18. Scan random QR -> INVALID.
19. Admin can revoke via RPC if needed; revoked QR -> REVOKED when scanned.

E. NOTIFICATIONS / MESSAGES
20. Admin/staff sends announcement -> evacuee receives it.
21. Evacuee sends message -> admin/staff conversation shows it.
22. Reply -> evacuee receives the reply.

F. REPORTS
23. Reports page counts should match Supabase tables.
24. CSV export should contain real evacuee records.
25. PDF Print -> Save as PDF should work.

G. PWA / DEPLOYMENT
26. Redeploy to Vercel.
27. Open evacuee app on Android Chrome using HTTPS.
28. Install/Add to Home Screen.
29. Close/reopen installed app and confirm login/session behavior.
30. QR camera scanner should request Camera permission only on the scanner page.

ADMIN HEALTH CHECK FROM BROWSER CONSOLE
---------------------------------------
await ScanSafePhase9.healthCheck()

Expected critical values:
over_capacity_spaces = 0
occupancy_mismatches = 0
approved_without_active_qr = 0
pending_with_qr = 0
multiple_active_assignments = 0
auth_evacuuees_without_profile = 0
evacuee_profiles_without_record = 0

IF OCCUPANCY IS OUT OF SYNC
---------------------------
await ScanSafePhase9.reconcileOccupancy()
await ScanSafePhase9.healthCheck()

IMPORTANT
---------
Keep only the Supabase publishable/anon key in frontend config.
Never place the service_role key in HTML/JavaScript/Vercel public files.
