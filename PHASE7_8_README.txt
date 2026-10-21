ScanSafe Phase 7 + 8 Patch
============================

THIS IS A PATCH ONLY.
No HTML/CSS redesign is included.

COPY / OVERWRITE:
1. assets/supabase-bridge.js
2. service-worker.js

DATABASE:
Run SUPABASE_PHASE7_8.sql in Supabase SQL Editor AFTER Phases 1-6.

PHASE 7 — REAL NOTIFICATIONS & MESSAGES
- Admin Quick Announcement now inserts into Supabase.
- Evacuee Notifications page loads real notifications.
- Unread notifications are tracked.
- Approval automatically sends an account/QR notification.
- Accommodation assignment automatically sends an assignment notification.
- Evacuee Messages sends a real message to the ScanSafe administrator.
- Admin Messages page lists real evacuee accounts/conversations.
- Admin replies are stored in Supabase.
- read_at is updated for opened messages.
- Realtime refresh is enabled, with a 20-second fallback refresh.

IMPORTANT:
The existing "Volunteers" announcement choice currently uses the staff audience,
because the current ScanSafe roles are admin, staff, and evacuee.

PHASE 8 — REAL REPORTS & ANALYTICS
- Total evacuees from Supabase.
- Approved / Pending counts from Supabase.
- Active shelter count.
- Accommodation-space count.
- Capacity / occupied / available totals.
- Real occupancy percentage.
- Shelter utilization chart uses real values.
- Age demographics use real evacuee ages.
- Group/individual/senior statistics use real records.
- 7-day approval trend uses approved_at.
- Export CSV contains real evacuee + assignment records.
- Export PDF uses the browser Print -> Save as PDF workflow.
- Generated report actions are logged in report_exports.
- Recent Generated Reports shows real report history.

TEST ORDER:
1. Run SUPABASE_PHASE7_8.sql.
2. Copy assets/supabase-bridge.js and service-worker.js into your project.
3. Redeploy on Vercel.
4. Login as admin.
5. Messages -> send a Quick Announcement to Evacuees.
6. Login as an evacuee -> Notifications -> confirm it appears.
7. Evacuee Messages -> send a message.
8. Login as admin -> Messages -> open evacuee -> reply.
9. Reports & Analytics -> confirm live counts.
10. Export CSV and check the downloaded real records.
11. Export PDF -> choose Save as PDF.

PWA NOTE:
The service-worker cache version was changed so installed evacuee apps receive
the Phase 7/8 JavaScript update. If an installed app still shows old data,
close/reopen it after deployment or refresh once while online.
