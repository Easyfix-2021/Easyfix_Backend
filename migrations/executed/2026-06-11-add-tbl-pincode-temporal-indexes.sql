-- 2026-06-11 — Index tbl_pincode on the temporal columns the modal's
-- list endpoint now filters/sorts by.
--
-- WHY:
--   The remark computation in services/india-locations.service.js
--   compares each row's `created_date` and `updated_date` against the
--   viewBaselineAt timestamp. The new sort feature lets operators sort
--   by 'remark' (which is computed via a CASE expression over those
--   same columns). Without indexes, every list query falls back to a
--   full scan of ~155k rows — fine while the table is small, slow once
--   the catalogue grows.
--
--   Index covers BOTH columns because:
--     - `created_date` → drives the 'Added' branch.
--     - `updated_date` → drives the 'Updated' branch.
--   Two single-column indexes lets the planner pick whichever predicate
--   is more selective for a given query.
--
-- Idempotent — uses information_schema check so re-runs are safe.

DELIMITER $$

DROP PROCEDURE IF EXISTS _add_tbl_pincode_created_date_index$$
CREATE PROCEDURE _add_tbl_pincode_created_date_index()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'tbl_pincode'
      AND index_name = 'idx_pincode_created_date'
  ) THEN
    ALTER TABLE tbl_pincode ADD INDEX idx_pincode_created_date (created_date);
  END IF;
END$$

DROP PROCEDURE IF EXISTS _add_tbl_pincode_updated_date_index$$
CREATE PROCEDURE _add_tbl_pincode_updated_date_index()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'tbl_pincode'
      AND index_name = 'idx_pincode_updated_date'
  ) THEN
    ALTER TABLE tbl_pincode ADD INDEX idx_pincode_updated_date (updated_date);
  END IF;
END$$

DELIMITER ;

CALL _add_tbl_pincode_created_date_index();
CALL _add_tbl_pincode_updated_date_index();

DROP PROCEDURE _add_tbl_pincode_created_date_index;
DROP PROCEDURE _add_tbl_pincode_updated_date_index;
