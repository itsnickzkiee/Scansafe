ScanSafe Messages v2 — Exact Recipient + Announcement Dashboard
================================================================

ROOT CAUSE
The old supabase-bridge message controller and the enhanced controller were both
active. The old controller could auto-select/repaint the first contact (Nick)
after you selected Erson.

FIX
- enhanced thread/header now use isolated selectors
- selected recipient is visibly locked: "Sending to Erson Quilala"
- async thread race is blocked
- backend send returns receiver_id/name and frontend verifies it
- Compose Message uses the same exact-recipient function

ANNOUNCEMENTS
- All Evacuees -> Notifications/Alerts + latest Home update
- All Shelter Staff -> staff notifications
- Everyone -> both
- announcements are NOT duplicated into private chat

INSTALL
1. Run SUPABASE_MESSAGES_RECIPIENT_FIX.sql
2. Overwrite:
   messages.html
   user-messages.html
   assets/messages-enhanced.js
   assets/messages-enhanced.css
   assets/notification-center.js
   assets/notification-center.css
3. No map/accommodation files are included.
4. Deploy + hard refresh.

TEST
Click Erson -> verify "Sending to Erson Quilala" -> send "hi Erson".
It must remain in Erson's thread.

Send Quick Announcement to All Evacuees -> evacuee should see:
notification badge + Notifications entry + Home Latest Update.
