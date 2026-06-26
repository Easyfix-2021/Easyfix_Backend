-- Formalise tbl_pincode.pincode_status as a Serviceable flag:
--   1 = Serviceable (default — what Seed India Locations, the Excel bulk
--       upload, and manual single-create all insert),
--   0 = Non-Serviceable (soft state: hidden from the default Manage Pincodes
--       list but preserves historical job -> pincode links).
-- Comment-only change: type/null/default are unchanged (TINYINT NOT NULL
-- DEFAULT 1) and no rows are touched (every existing row is already 1).
-- tbl_pincode is EasyFix-owned (no legacy service references it), so altering
-- it is within the allowed exception.
ALTER TABLE tbl_pincode
  MODIFY COLUMN pincode_status TINYINT NOT NULL DEFAULT 1
    COMMENT '0=Non-Serviceable, 1=Serviceable (default). Soft state: 0 hides from default lists but preserves historical job->pincode links.';
