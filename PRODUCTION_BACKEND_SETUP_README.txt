ScanSafe — Production Backend Deployment Patch
================================================

PURPOSE
-------
This keeps the ScanSafe website as a static Vercel deployment while Supabase
provides the real backend:

Vercel static HTML/CSS/JS
        |
        +--> Supabase Auth
        +--> Supabase PostgreSQL
        +--> Supabase RPC / GBEAA
        +--> Supabase Realtime
        +--> RLS / security policies

No Node/PHP application server is required for the current ScanSafe architecture.

NO DESIGN CHANGES
-----------------
This patch does NOT change ScanSafe HTML/CSS/map design.

FILES TO COPY / OVERWRITE
-------------------------
1. assets/supabase-bridge.js
2. service-worker.js
3. manifest.webmanifest
4. robots.txt
5. vercel.json

OPTIONAL / REFERENCE FILES
--------------------------
- assets/supabase-config.example.js
- SUPABASE_GBEAA_ALGORITHM.sql

IMPORTANT: DO NOT overwrite a working assets/supabase-config.js with the example.
Keep your real production Supabase config.

REAL SUPABASE CONFIG
--------------------
Your existing assets/supabase-config.js must look like:

window.SCANSafeSupabaseConfig = {
  url: 'https://YOUR_PROJECT_REF.supabase.co',
  anonKey: 'YOUR_PUBLISHABLE_OR_ANON_KEY'
};

Use the Supabase publishable key when available.
NEVER place service_role / secret keys in frontend files, GitHub, Vercel public
files, or the Android APK.

WHY THE SERVICE WORKER CHANGED
------------------------------
Older ScanSafe PWA builds cached assets/supabase-config.js.

This production patch:
- removes supabase-config.js from the PWA precache
- always requests supabase-config.js from the network
- also tells Vercel not to cache it

This prevents the installed PWA/browser from continuing to use an old backend
URL/key after a deployment.

SUPABASE DATABASE
-----------------
If you have NOT yet run the latest GBEAA SQL:
1. Open Supabase Dashboard
2. SQL Editor
3. Open SUPABASE_GBEAA_ALGORITHM.sql
4. Run it once

If it has already been successfully run, do not repeatedly run it just for every
Vercel deployment.

SUPABASE AUTH PRODUCTION URL
----------------------------
After your Vercel production URL is known:

Supabase Dashboard
Authentication
URL Configuration

Set:

Site URL
https://YOUR-SCANSafe-DOMAIN.vercel.app

Redirect URLs
https://YOUR-SCANSafe-DOMAIN.vercel.app/**

If you later use a custom domain, add that HTTPS domain too.

VERCEL SETTINGS
---------------
This project is intentionally a static frontend.

Recommended Vercel settings:
- Framework Preset: Other
- Root Directory: the folder containing index.html
- Build Command: leave empty
- Output Directory: leave empty

Then deploy/redeploy from the GitHub repository normally.

You do NOT need to deploy the Supabase database on Vercel.
You do NOT need to put the service_role key into Vercel environment variables.

The browser and Android app connect directly to Supabase using the public
publishable key. RLS/RPC permissions protect the database.

AFTER DEPLOYMENT
----------------
Open the HTTPS production site and login as Admin.

Browser DevTools -> Console:

await ScanSafeProduction.check()

Expected:
- secure_context: true
- supabase_configured: true
- backend_session_ok: true
- authenticated: true (after login)
- online: true

Then also run:

await ScanSafePhase9.healthCheck()

For GBEAA, while logged in as Admin/Staff:

await ScanSafeGBEAA.recommend(GROUP_ID)

END-TO-END PRODUCTION TEST
--------------------------
Test this exact flow:

Evacuee Register
-> Admin sees Pending
-> Admin Approves
-> QR is generated
-> Admin runs GBEAA accommodation assignment
-> occupancy updates
-> evacuee sees assignment
-> QR scan succeeds
-> notification/message works
-> reports load real Supabase data

ANDROID
-------
The Android APK is still a client of the same Supabase backend.

If you changed web files that are bundled into the Android app:
1. Update the main ScanSafe project first.
2. From android-app:
   npm.cmd run android:sync
3. Rebuild the signed release APK using the SAME scansafe-release.jks keystore.
4. Replace:
   downloads/ScanSafe-Evacuee.apk
5. Commit/push and redeploy Vercel.

WHAT STILL REQUIRES A MANUAL DASHBOARD STEP
-------------------------------------------
For security reasons this patch cannot know or invent:
- your Supabase Project URL
- your Supabase publishable key
- your final Vercel production URL

Those values must come from your own Supabase/Vercel dashboards.

Once those are set, your production setup is:
STATIC VERCEL FRONTEND + LIVE SUPABASE BACKEND.
