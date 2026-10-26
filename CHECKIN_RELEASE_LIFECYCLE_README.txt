ScanSafe — One-Time Check-In + Controlled Release Lifecycle
================================================================

FINAL STATUS FLOW
Pending Approval → Approved → Accommodated / Checked In → Released

FIRST VALID BARCODE SCAN
- approved + active barcode is verified
- existing prepared assignment is retained, or the existing GBEAA runs when needed
- checked_in_at is recorded as the official Arrival Time
- the stay becomes Accommodated / Checked In

REPEAT BARCODE SCAN
- displays ALREADY CHECKED IN
- duplicate scan is blocked
- Arrival Time and Assigned Space stay unchanged
- no duplicate GBEAA assignment
- no extra occupancy

RELEASE / CHECK-OUT
Release is a separate Admin/Staff action — NOT a second barcode scan.

Admin/Staff:
Evacuees → View Details → Release Evacuee / Release Evacuee Group

A release reason is required. Confirming release:
- completes the active assignment
- frees the occupied capacity
- records Departure Time
- calculates Stay Duration
- changes status to Released
- sends a notification to the evacuee
- Request Needs locks again because the active assignment is closed
- keeps the account, barcode and shelter-stay history

EVACUEE UI
Home, My Information and Profile include a polished Shelter Stay card:
- Arrival Time
- Departure Time
- Stay Duration
- Assigned Space / Previous Space

Progress:
Submitted → Approved → Accommodated → Released

IMPORTANT SQL ORDER
Your live database previously showed:
relation "public.scansafe_operation_stays" does not exist

Run these in Supabase SQL Editor IN THIS ORDER:
1. SUPABASE_EVACUATION_OPERATIONS.sql
2. SUPABASE_CHECKIN_RELEASE_LIFECYCLE.sql

Run #2 LAST.

Existing active assignments are adopted by the operations setup.
The lifecycle patch backfills Arrival Time only when a real prior verified
barcode scan can be found. Otherwise, the next valid barcode scan becomes the
official first Check-In.

REQUEST NEEDS
The existing eligibility rule remains:
approved + active accommodation assignment.
The included latest needs UI keeps Request Needs visibly locked when ineligible,
and it locks again automatically after release.

DEPLOY
Copy/overwrite the patch files into the latest INNER GitHub-connected project.

git rev-parse --show-toplevel
git remote -v

git add .
git commit -m "Add one-time check-in and controlled release lifecycle"
git push origin main

After Vercel is Ready:
Ctrl + Shift + R

TEST
1. First valid scan:
   CHECKED IN + Arrival Time + accommodation.

2. Scan the same barcode again:
   ALREADY CHECKED IN; occupancy unchanged.

3. Admin → Evacuees → View:
   Shelter Stay card + Release button.

4. Release with reason:
   Departure Time + Stay Duration + occupancy freed.

5. Evacuee portal:
   Released status + shelter-stay history.
