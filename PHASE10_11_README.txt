ScanSafe Phase 10 + 11 Combined Patch
=====================================

PHASE 10
- Final Vercel production configuration.
- Production PWA cache/version.
- Production diagnostic helper.
- No new Supabase SQL.
- No UI redesign.

PHASE 11
- Build-ready Android Capacitor wrapper for evacuees.
- Uses the current ScanSafe evacuee UI.
- Admin/staff stays on the web portal.
- Android source is generated on your computer using Capacitor/Android Studio.

ORDER
-----
1. Finish/run Phases 1–9.
2. Copy the Phase 10 root files into the ScanSafe project.
3. Redeploy and test Vercel.
4. Put android-app/ inside the ScanSafe project root.
5. Follow android-app/PHASE11_ANDROID_README.txt.

IMPORTANT
---------
Do not replace assets/supabase-config.js with a blank file.
Do not expose the Supabase service_role key.
