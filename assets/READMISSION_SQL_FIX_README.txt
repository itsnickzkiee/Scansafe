ScanSafe Readmission SQL Fix
=============================

Problem fixed:
ERROR 42601: record variable cannot be part of multiple-item INTO list

The invalid pattern:
  SELECT e,b INTO v_evacuee,v_barcode

was replaced with:
1. resolve barcode_id
2. load the barcode row into v_barcode
3. load the evacuee row into v_evacuee

Both affected functions were fixed:
- scan_and_assign_evacuee(text)
- confirm_scansafe_readmission(text)

WHAT TO DO
----------
Because the SQL file starts with ROLLBACK; BEGIN; and the previous run failed
before COMMIT, rerun the corrected ENTIRE file:

SUPABASE_READMISSION_COOLDOWN_MAP.sql

You do NOT need to rerun the frontend files just for this SQL syntax correction
if the previous web patch is already deployed.
