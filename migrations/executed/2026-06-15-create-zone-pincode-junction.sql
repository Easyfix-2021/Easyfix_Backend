-- 2026-06-15 — Many-to-many zone <-> pincode mapping.
--
-- Supersedes the scalar `tbl_pincode.zone_id` (which enforced one-pincode->
-- one-zone by being a single column). A pincode may now belong to MULTIPLE
-- zones. This junction becomes the SOURCE OF TRUTH for zone coverage; all
-- zone reads/writes (zone.service.js, zone-upload.service.js,
-- candidate-ranking.service.js, pincode.service.js) use it.
--
-- `tbl_pincode.zone_id` is LEFT IN PLACE (vestigial) for back-compat /
-- rollback safety — it is no longer read by application code. tbl_pincode is
-- EasyFix-owned, so a new owned junction table is the sanctioned route under
-- the CLAUDE.md shared-DB carve-out.

CREATE TABLE IF NOT EXISTS tbl_zone_pincode_mapping (
  id INT NOT NULL AUTO_INCREMENT,
  zone_id INT NOT NULL,
  pincode_id INT NOT NULL,
  created_on DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_by INT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_zone_pincode (zone_id, pincode_id),
  KEY idx_zp_pincode (pincode_id),
  KEY idx_zp_zone (zone_id)
);

-- Backfill existing single-zone assignments into the junction (idempotent).
INSERT IGNORE INTO tbl_zone_pincode_mapping (zone_id, pincode_id)
SELECT zone_id, pincode_id FROM tbl_pincode WHERE zone_id IS NOT NULL;
