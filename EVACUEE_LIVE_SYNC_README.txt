ScanSafe evacuee account and approval synchronization
===================================================

Prepared files are local only. This migration has NOT been applied to Supabase.

Apply SUPABASE_EVACUEE_LIVE_SYNC_FIX.sql as one complete script in the connected
project's Supabase SQL Editor. The full Phase 9 migration is not required.
The script installs its audit table and private logger when missing, preserving
any existing logger and audit records. Its leading ROLLBACK clears a previous
failed SQL Editor transaction before starting the migration's own transaction.
Deploy the accompanying frontend changes and refresh the evacuee page.

If an earlier copy failed with "Apply the ScanSafe Phase 9 security/audit setup
before this migration", replace all text in SQL Editor with this updated file
and run the entire script again; do not rerun the old pasted copy.

The migration adds get_my_scansafe_account(), callable only by authenticated
users. It uses auth.uid() and the existing auth_user_id link, never an email or
another account. Its JSON result contains evacuee, barcode, assignment, space,
and shelter. Optional/missing rows are null; no linked registration returns all
five keys as null. A barcode is returned only for an approved registration with
an active barcode. Table rows use to_jsonb so optional columns need not exist.

Approval now checks the admin role, locks the registration, returns an existing
active barcode or creates a new real barcode on the server, and retains the
Phase 9 audit call. Rejected registrations and existing inactive/revoked codes
cannot be bypassed by reapproving. A deferred trigger also covers direct
pending-to-approved updates after any existing immediate issuance trigger.
Already-approved registrations without ANY barcode row are backfilled. Existing
codes, statuses, and account links are retained. Re-running is safe.

Owner SELECT policies support older clients for their own registration, approved
active barcode, and active group assignment. Existing staff/admin policies stay
in place. No client receives permission to create or reactivate barcodes.

The repo does not contain the original Phase 1 schema. Barcode inserts use only
the known evacuee_id, barcode_value, and status columns, relying on table defaults
for the rest. If the real table has extra required fields, custom code-format
constraints, or incompatible legacy triggers, the SQL may fail. The surrounding
transaction rolls back every change; inspect the reported schema error before
adapting the migration. The migration was tested locally against PostgreSQL
fixtures, including a database without Phase 9, existing audit helpers, owner
access, repeated runs, legacy triggers, and recovery after a failed transaction.
It has not been executed or verified against the live Supabase database.

Verification after application: approve a test pending registration as an admin;
then log in as that same evacuee. get_my_scansafe_account() should return the
approved row and its active barcode. Another evacuee must receive only their own
row; an unsigned caller must not execute the RPC. An already-approved account
with a revoked/inactive code needs an administrator's explicit barcode review.
