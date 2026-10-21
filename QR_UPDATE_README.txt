ScanSafe QR Code Update

- User-facing identification is QR Code (not linear barcode).
- QR is generated/displayed only after admin approval.
- The QR uses high error correction and overlays the EXISTING project asset:
  assets/barangay-abangan-norte-seal.png
- The uploaded chat image was NOT copied into the project.
- Existing visual design/layout was not redesigned.
- Internal Supabase table name `barcodes` is retained for backward compatibility with the SQL already run. It stores the QR token/value used to create the QR image.
- QRCode.js is loaded from jsDelivr by the frontend.

Admin button text: Approve & Generate QR
Scanner label: QR Scanner
Pending evacuee: no QR code until approval.
