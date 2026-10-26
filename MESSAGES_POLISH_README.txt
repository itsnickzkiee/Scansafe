ScanSafe Messages Realtime + UI Polish
======================================

SCOPE
-----
MESSAGES ONLY.

This patch does NOT include or modify:
- accommodation map
- shelter-room.html
- map SQL
- supabase-bridge.js
- shared style.css
- service worker
- scanner/accommodation logic

FEATURES
--------
- Optimistic smooth send: Sending... -> Sent / Failed
- No page refresh after send
- Enter sends; Shift+Enter creates a new line
- Duplicate/double-send protection
- Smooth scroll to latest message
- Real Supabase Realtime typing indicator with animated 3 dots
- Typing indicator in the active conversation and contact preview
- Live new-message refresh
- Unread badges and latest-message previews
- Search/filter recent conversations
- Functional Compose Message modal with evacuee search
- Quick Announcement: All Evacuees / All Shelter Staff / Everyone
- Announcement send feedback
- Functional message templates
- Template inserts into the last active chat/announcement box, never auto-sends
- Desktop/mobile chat polish
- Debug helper: ScanSafeMessagesDebug.inspect() / refresh()

INSTALL
-------
1. Run:
   SUPABASE_MESSAGES_ENHANCEMENT.sql

2. Overwrite/add ONLY:
   messages.html
   user-messages.html
   assets/messages-enhanced.js
   assets/messages-enhanced.css

3. Do NOT overwrite Codex map files.

4. Deploy:
   git add .
   git commit -m "Polish realtime ScanSafe messaging"
   git push origin main

5. After Vercel Ready:
   Ctrl + Shift + R

TEST
----
A. Admin Messages:
- open Nick
- type but do not send
- Nick should see "Shelter staff is typing" with animated dots
- Send -> bubble appears immediately with Sending... then Sent

B. Evacuee:
- type -> Admin active Nick conversation shows typing dots
- Send -> admin thread/list updates live

C. Compose Message:
- search/select evacuee
- type/send
- modal closes and conversation opens

D. Templates:
- click chat box or announcement box
- click template
- text is inserted for review, NOT automatically sent

E. Quick Announcement:
- select All Evacuees / All Shelter Staff / Everyone
- send
- recipients receive it through the existing notifications system
