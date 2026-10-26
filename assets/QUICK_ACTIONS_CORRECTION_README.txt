ScanSafe — Quick Actions Correction Patch
==========================================

CORRECTION
----------
Quick Actions should remain.
Only Contact Staff is removed.

My Information
- Quick Actions: KEEP
- View Barcode: KEEP
- View Notifications: KEEP
- Contact Staff: REMOVE

Accommodation Assignment
- Quick Actions: KEEP
- Report an Issue: KEEP
- Contact Staff: REMOVE

The profile-photo + avatar changes from the previous patch remain unchanged.

FILES
-----
my-information.html
user-room.html
tests/ui-cleanup.test.cjs

DEPLOY
------
git add .
git commit -m "Restore quick actions without contact staff"
git push origin main

After Vercel is Ready:
Ctrl + Shift + R
