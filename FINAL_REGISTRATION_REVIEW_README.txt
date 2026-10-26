ScanSafe Final Login + Registration Review Patch
================================================

WHAT'S ADDED
------------
LOGIN
- Password eye on the main login password field.

ADMIN REGISTRATION REVIEW
- Existing submitted registration fields + uploaded ID remain visible.
- Review History shows submitted/resubmitted/rejected/approved versions.
- Reject now requires one or more exact issues:
  * Invalid ID
  * ID image unreadable
  * ID mismatch
  * Missing information
  * Address needs verification
  * Other
- Optional admin note.
- Rejection sends a PRIVATE notification to that evacuee.
- Rejection + submitted information are retained in audit/history.

EVACUEE
- Account can still be used after rejection.
- Home shows an Action Required card.
- Profile / My Information shows a correction form ONLY when rejected.
- Can add/correct missing registration information.
- If rejection is ID-related, a NEW ID image is required.
- Resubmit returns status to Pending Approval only.
- Admin still must approve before barcode issuance.

AUDIT
- Future registration submissions are audited.
- Current existing registrations receive a clearly labeled existing-record snapshot.
- Audit displays submitted registration fields with ID number masked in the general audit.
- Full review snapshots stay in the staff-only registration review history.

INSTALL
-------
1. Run in Supabase SQL Editor:
   SUPABASE_FINAL_REGISTRATION_REVIEW.sql

2. Overwrite/add the files in this ZIP.

3. Deploy:
   git add .
   git commit -m "Add registration correction review and rejection notices"
   git push origin main

4. After Vercel Ready:
   Ctrl + Shift + R

IMPORTANT
---------
No map, accommodation assignment, scanner, barcode lifecycle, or messaging logic
is modified by this patch.
