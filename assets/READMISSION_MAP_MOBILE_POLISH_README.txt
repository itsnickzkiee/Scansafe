ScanSafe — Readmission + Live Map + Mobile Polish Patch
=======================================================

WHAT THIS PATCH ADDS
--------------------
1. 12-hour readmission cooldown
   Released -> 12-hour cooldown -> Ready for Readmission.

2. Current stay resets after cooldown
   After the cooldown expires:
   - Accommodated check is no longer active
   - Released check is no longer active
   - no active accommodation is shown
   - Request Needs remains locked
   - Barcode/account remain available
   - previous stay remains under Previous Shelter Stay history

   The evacuee UI schedules an automatic refresh at the cooldown boundary.

3. Barcode scanner readmission states
   Active stay + repeat scan:
     ALREADY CHECKED IN

   Released < 12 hours:
     RECENTLY RELEASED / cooldown

   Released >= 12 hours:
     READY FOR READMISSION
     -> staff clicks Confirm Readmission
     -> new shelter stay starts
     -> new Arrival Time
     -> automatic accommodation assignment using current shelter conditions

4. Accommodation Map = monitoring-first
   - removed the normal Assign Approved Group button
   - normal assignment happens during staff barcode check-in
   - current checked-in occupants appear as circular profile markers
   - uploaded profile photo is used when available; initials are fallback
   - clicking a marker/space shows current occupants, arrival time and group size
   - release removes the active marker because the assignment is closed

5. No algorithm name in normal UI
   User/admin-facing wording uses:
   - Automatic Assignment
   - Automatic Accommodation Assignment
   - Assigned Space
   Backend/internal function names are unchanged for compatibility.

6. Mobile bottom navigation alignment
   - Home / My Barcode / My Space / Needs / Alerts / Profile use equal rows
   - lock and notification badges are absolute overlays
   - Needs/Alerts badges no longer push their icon/label upward

7. Request Needs
   Existing rule is preserved:
   approved + active accommodation assignment = enabled.
   Release closes the assignment, so Request Needs locks again automatically.

DATABASE
--------
NEW SQL TO RUN:
  SUPABASE_READMISSION_COOLDOWN_MAP.sql

This SQL expects the previous lifecycle setup to already exist:
  SUPABASE_EVACUATION_OPERATIONS.sql
  SUPABASE_CHECKIN_RELEASE_LIFECYCLE.sql

If those two were already run successfully, DO NOT rerun them now.
Just run SUPABASE_READMISSION_COOLDOWN_MAP.sql.

If the new SQL says the prerequisite lifecycle is missing, go back to the prior
Check-In / Release patch and run, in order:
  1. SUPABASE_EVACUATION_OPERATIONS.sql
  2. SUPABASE_CHECKIN_RELEASE_LIFECYCLE.sql
  3. SUPABASE_READMISSION_COOLDOWN_MAP.sql

DEPLOY
------
Copy/overwrite this patch into the latest INNER ScanSafe project, then:

git add .
git commit -m "Add readmission cooldown and live accommodation monitoring"
git push origin main

After Vercel is Ready:
- Ctrl + Shift + R
- logout/login if an old PWA screen is still cached

TEST FLOW
---------
A. Active evacuee
   First scan -> CHECKED IN
   Scan again -> ALREADY CHECKED IN

B. Release
   Admin -> Evacuees -> View -> Release
   Request Needs locks and map marker disappears.

C. Before 12 hours
   Scan -> RECENTLY RELEASED
   New stay is blocked.

D. After 12 hours
   Evacuee current progress shows only Submitted + Approved as completed.
   Current status -> Ready for Readmission.
   Accommodated/Released are no longer active current-stay checks.
   Previous stay remains visible in history.

E. Scan after cooldown
   Scanner -> READY FOR READMISSION
   Staff -> Confirm Readmission
   New Arrival Time + automatic assignment + active stay.

ANDROID NOTE
------------
These frontend changes affect the installed Android build too. After web testing,
run android sync and rebuild the signed APK if you want the native app to include
the same UI/logic.
