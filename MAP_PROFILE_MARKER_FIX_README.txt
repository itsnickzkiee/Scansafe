ScanSafe Map Profile Marker Fix
===============================

WHY THE PROFILE BUBBLE WAS MISSING
----------------------------------
The previous map occupant query returned only groups with checked_in_at.
So a space could show Occupied > 0 while the profile bubble stayed hidden.

NEW BEHAVIOR
------------
Active assignment, not yet scanned:
- profile/initial bubble appears
- status = Assigned
- detail = Assigned — waiting for check-in

After first valid barcode scan:
- same bubble remains
- status changes to Checked In
- Arrival Time appears

After Release:
- active assignment closes
- bubble disappears automatically

INSTALL
-------
1. Run SUPABASE_MAP_PROFILE_MARKER_FIX.sql in Supabase SQL Editor.
2. Overwrite:
   assets/supabase-bridge.js
   assets/style.css
   service-worker.js
3. Deploy to Vercel.
4. Ctrl + Shift + R.

No map image/design was changed.
