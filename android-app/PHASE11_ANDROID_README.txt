ScanSafe Phase 11 — Android APK Wrapper (Evacuee App)
========================================================

This folder is a BUILD-READY Capacitor Android wrapper for the existing ScanSafe
evacuee interface. It does NOT redesign the web UI.

APP ID
------
com.scansafe.evacuee

APP NAME
--------
ScanSafe Evacuee

WHAT THE ANDROID APP CONTAINS
-----------------------------
- Login / public registration
- User Portal
- My Information
- Accommodation
- Notifications
- Messages
- Profile
- Existing QR display and Supabase integration

The Android bundle intentionally excludes the admin dashboard/scanner/reports pages.
If an admin/staff account tries to sign in inside the Android build, the native
bundle rejects that role and tells them to use the web admin portal.

REQUIREMENTS
------------
1. Node.js 22 or newer
2. Android Studio
3. Android SDK
4. Your main ScanSafe project must already contain the final Phase 10 files and
   your working assets/supabase-config.js.

PLACE THIS FOLDER
-----------------
Keep android-app/ directly inside the root of the ScanSafe project, for example:

ScanSafe/
  index.html
  user-portal.html
  assets/
  android-app/
    package.json
    capacitor.config.json
    ...

FIRST-TIME SETUP
----------------
Open a terminal:

cd android-app
npm install
npm run android:init
npm run android:assets
npm run android:open

Android Studio will open the generated android/ project.

WHEN THE WEB APP CHANGES
------------------------
cd android-app
npm run android:sync

This copies the CURRENT evacuee pages/assets from the parent ScanSafe project into
the native Android project.

BUILD A DEBUG APK
-----------------
After Android Studio/SDK is correctly installed:

cd android-app
npm run android:apk

Expected APK:
android-app/dist/ScanSafe-Evacuee-debug.apk

You can also open Android Studio:
npm run android:open

Then use:
Build -> Build App Bundle(s) / APK(s) -> Build APK(s)

TEST ON PHONE
-------------
- Install the debug APK on an Android test device.
- Login with an evacuee account.
- Pending account: no QR.
- Approved account: QR becomes available.
- Confirm Accommodation, Notifications, Messages and Profile.
- Logout and login again.
- Confirm Supabase data updates after reopening the app.

IMPORTANT SECURITY
------------------
The publishable/anon Supabase key is designed for client apps when RLS is enabled.
Never include the service_role key in the Android app.

The Android app still needs internet for Supabase synchronization. The web UI is
bundled locally, but live evacuee records, QR status, assignments, messages and
notifications come from Supabase.

APK BUILD NOTE
--------------
An APK can only be compiled on a machine with Android Studio/Android SDK installed.
This package contains the native wrapper/build automation; the actual APK is created
by running npm run android:apk or by building inside Android Studio.
