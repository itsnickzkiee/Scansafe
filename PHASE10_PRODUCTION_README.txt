ScanSafe Phase 10 — Final Production Deployment
================================================

PATCH ONLY. NO DESIGN CHANGES.
Apply after Phases 1–9.

COPY / OVERWRITE IN YOUR EXISTING SCANSAFE PROJECT
---------------------------------------------------
1. assets/supabase-bridge.js
2. service-worker.js
3. manifest.webmanifest
4. vercel.json
5. robots.txt

IMPORTANT
---------
- Keep your CURRENT assets/supabase-config.js. This patch intentionally does NOT
  replace it.
- Only the Supabase publishable/anon key belongs in frontend code.
- NEVER place the Supabase service_role key in the project, GitHub, Vercel public
  files, or Android bundle.
- If you already have a custom vercel.json, merge these headers instead of blindly
  overwriting your custom routes/redirects.

WHAT PHASE 10 DOES
------------------
- Final production security headers for Vercel.
- Prevents stale service-worker and Supabase config caching.
- Updates PWA production metadata.
- Prevents normal search-engine indexing with robots.txt.
- Bumps the PWA cache version so installed evacuee apps receive the new build.
- Adds a production diagnostic helper without changing the UI.
- Prevents service-worker registration inside the native Capacitor Android wrapper.

PRODUCTION DEPLOYMENT FLOW
--------------------------
1. Apply all Phase 1–9 files/SQL first.
2. Copy the Phase 10 files above.
3. Confirm assets/supabase-config.js contains the correct production:
     - Project URL
     - publishable/anon key
4. Commit and push to GitHub.
5. Let Vercel redeploy the repository.
6. Open the production HTTPS URL.
7. Login as Admin and run in browser DevTools:
     await ScanSafeProduction.check()
     await ScanSafePhase9.healthCheck()
8. Critical Phase 9 health values should be 0.
9. Test end-to-end:
     Register -> Admin Approve -> QR -> Assign Space -> Scan -> Notify -> Report.
10. Test the evacuee PWA on Android Chrome and reopen it after installation.

EXPECTED PRODUCTION CHECK
-------------------------
secure_context = true
supabase_configured = true
backend_session_ok = true (after login)
online = true during live testing

VERCEL NOTE
-----------
Camera scanning needs HTTPS. Vercel provides HTTPS, so the QR scanner can request
camera permission on supported browsers.

PHASE 10 HAS NO NEW SUPABASE SQL.
The database/security hardening was completed in Phase 9.
