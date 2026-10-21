ScanSafe GBEAA Algorithm Patch
================================

PATCH ONLY. Existing ScanSafe visual design and floor-plan image are not changed.

COPY / OVERWRITE
----------------
1. assets/supabase-bridge.js
2. service-worker.js

DATABASE
--------
Run:
SUPABASE_GBEAA_ALGORITHM.sql

Run it AFTER the previous ScanSafe SQL phases.

WHAT GBEAA NOW DOES
-------------------
GBEAA = Greedy-Based Evacuee Accommodation Algorithm

For an approved group with an active QR:

1. Read the group's actual group size.
2. Detect accessibility requirement from:
   - evacuees.accessibility_required
   - accessibility/mobility/PWD-related needs text
   - evacuee_needs entries
3. Read LIVE capacity/current_occupancy from Supabase.
4. Remove spaces that cannot fit the WHOLE group.
5. If accessibility is required, remove non-accessible spaces.
6. PRIORITY TIER 1:
   Hallway / Corridor / Main Lobby primary accommodation spaces.
7. GREEDY BEST-FIT:
   Choose the valid space with the LOWEST remaining capacity after placing
   the whole group.
8. Only if NO primary space can fit the group:
   use approved overflow_room spaces.
9. Insert the accommodation assignment transactionally.
10. Update current_occupancy.
11. Change the evacuee workflow status to accommodated.
12. Write a GBEAA decision to Phase 9 audit_events.
13. The existing Phase 7 assignment notification trigger notifies the evacuee.

WHY THIS IS GREEDY
------------------
At each assignment, GBEAA takes the current live system state and immediately
chooses the valid accommodation that leaves the least unused capacity, while
respecting the higher-priority primary accommodation tier.

Example:
Group size = 4

A1 available = 5 -> remaining after = 1
A3 available = 4 -> remaining after = 0
ML available = 12 -> remaining after = 8

GBEAA chooses A3.

OVERFLOW
--------
Rooms 102–116 are registered as overflow_room, is_primary=false.
They are NOT made clickable on the floor map.
GBEAA considers them only if no primary Hallway/Main Lobby space can fit the group.

If your real evacuation plan uses different approved overflow classrooms,
edit/remove those rows in Supabase Table Editor.

ADMIN UI
--------
Open Accommodation Map and click any assignable map space.

The existing assignment modal now shows, for each eligible group:
- group size / needs
- GBEAA recommended space
- remaining slots after assignment
- whether the decision is Primary or Overflow fallback

Buttons:
- Manual Assign Here = preserves the previous manual assignment
- Assign via GBEAA = uses the server-side algorithm

SERVER-SIDE SAFETY
------------------
The GBEAA assignment is recalculated inside one database transaction.
The selected accommodation row is locked before occupancy is updated.
This prevents the UI from being the source of truth.

TEST CASES
----------
TEST 1 — Greedy best-fit
Set:
A1 capacity 6 / occupancy 1 = 5 available
A3 capacity 6 / occupancy 2 = 4 available
Group size = 4

Expected:
GBEAA -> A3
Remaining after -> 0

TEST 2 — Whole group must fit
Group size = 5
A3 available = 4

Expected:
A3 is excluded.

TEST 3 — Primary before overflow
A1 available = 5
Room 102 available = 30
Group size = 4

Expected:
A1 is preferred even if overflow exists.

TEST 4 — Overflow fallback
Fill all primary spaces so no primary space can fit a group.

Expected:
GBEAA -> Room 102/another approved overflow room using best-fit.

TEST 5 — Accessibility
Mark a group accessibility_required=true.

Expected:
Only accommodation_spaces.accessible=true are valid.
If none can fit the group, GBEAA returns no recommendation instead of ignoring
the accessibility requirement.

SQL DEFENSE CHECK
-----------------
While logged in as admin/staff, you can inspect current decisions:

select public.gbeaa_current_recommendations();

Or from browser DevTools:

await ScanSafeGBEAA.recommend(GROUP_ID)

ANDROID / PWA
-------------
The PWA cache version is updated.

If you want your already-built Android APK to include the new GBEAA-aware
accommodation naming/overflow handling:
1. Copy this patch into the MAIN ScanSafe web project.
2. In android-app:
   npm.cmd run android:sync
3. Rebuild your signed release APK using the SAME signing keystore.
4. Replace downloads/ScanSafe-Evacuee.apk with the new release APK.

IMPORTANT
---------
Do not delete or expose your Android signing keystore.
Do not put the Supabase service_role key in frontend code.
