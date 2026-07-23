-- Client app device id on the SPOC record (2026-07-23).
--
-- On login the client app reports a stable per-install device id; we store it
-- on the SPOC's tbl_client_contacts row so we know which device is logged in.
-- Additive + nullable — safe to run, no existing data touched.

ALTER TABLE tbl_client_contacts
  ADD COLUMN device_id VARCHAR(255) NULL AFTER session_id;
