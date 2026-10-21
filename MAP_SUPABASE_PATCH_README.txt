ScanSafe - Supabase Map Assignment Patch (Phase 4)
===================================================

THIS PATCH DOES NOT CHANGE THE DESIGN.
Only the Supabase map/assignment behavior is updated.

FILES IN THIS PATCH
1) assets/supabase-bridge.js
   - Reads A1-A6 + Main Lobby capacity/occupancy from Supabase.
   - Shows only approved evacuee groups with an active QR and no active assignment.
   - Saves accommodation assignment to Supabase.
   - Updates current_occupancy transactionally after assignment.
   - Syncs the logged-in evacuee's real QR + assigned space into the existing user portal/map.

2) SUPABASE_PHASE4_MAP_ASSIGNMENT.sql
   - Adds Main Lobby if missing.
   - Prevents more than one active assignment per group.
   - Adds assign_group_to_space() RPC with capacity checks and row locking.

SETUP ORDER
1. Open Supabase > SQL Editor.
2. Run SUPABASE_PHASE4_MAP_ASSIGNMENT.sql once.
3. Copy/replace assets/supabase-bridge.js in your current ScanSafe project.
4. Keep your existing assets/supabase-config.js credentials.
5. Refresh the site / redeploy Vercel.

TEST
1. Register an evacuee.
2. Admin approves the registration -> QR is generated.
3. Open Accommodation Map.
4. Click A1-A6 or Main Lobby.
5. Click Assign Approved Group.
6. Select the approved group.
7. Supabase accommodation_assignments should receive the row.
8. accommodation_spaces.current_occupancy should increase.
9. Log in as the evacuee; the existing app should show the assigned space.

No HTML/CSS/map image files are included because the current design is intentionally unchanged.
