ScanSafe Final Live Messages + Profile + Reports Patch
====================================================

SCOPE
-----
This patch focuses only on:
- Messages UI / realtime
- Live profile-photo sync
- Reports & Analytics

It does NOT include:
- shelter-room.html
- map renderer
- accommodation map SQL
- scanner assignment logic

WHAT CHANGED
------------
MESSAGES
- removes exposed dark/black-maroon gaps under chat columns
- incoming messages update automatically
- Supabase Realtime is primary
- 4-second visible-page sync is a fallback if websocket reconnects
- unread/contact previews keep updating
- typing indicator remains realtime
- exact recipient lock remains active
- current profile photo appears in admin contact list/header/chat
- profile change refreshes without browser reload

PROFILE PHOTO
- scansafe_account_media is enabled for Realtime
- other open evacuee tabs call ScanSafeMedia.refresh()
- Admin Messages refreshes signed profile photos automatically

REPORTS & ANALYTICS
- real date-range filter
- real shelter filter
- report-type filter
- Generate Report refreshes live Supabase data
- CSV exports the filtered evacuee rows
- PDF uses the browser print/Save as PDF flow
- live filtered evacuee table
- currently accommodated count
- released stay count
- average stay duration
- active needs-request count
- verified barcode-scan count
- auto refresh every 15 seconds while visible

INSTALL
-------
1. Run in Supabase SQL Editor:
   SUPABASE_LIVE_MESSAGES_PROFILE_FIX.sql

2. Overwrite/add the files from this ZIP.

3. Deploy:
   git add .
   git commit -m "Finish live messaging profile sync and reports"
   git push origin main

4. After Vercel is Ready:
   Ctrl + Shift + R

TEST
----
Chat:
- Admin opens Erson/Nick.
- Send from evacuee in another device/tab.
- Incoming bubble should appear without browser refresh.
- Contact preview and unread count should update.
- Typing dots should still work.

Profile:
- Nick changes profile photo.
- Other open Nick pages and Admin Messages should refresh the photo automatically.

Reports:
- change date/shelter filters
- Generate Report
- Export CSV
- Export PDF
- verify live operational KPIs and filtered table
