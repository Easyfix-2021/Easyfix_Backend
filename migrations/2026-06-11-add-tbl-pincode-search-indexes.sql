-- 2026-06-11 — Indexes for the public pincode search (magic-link form).
--
-- WHY:
--   The new GET /api/public/easyfixer-profile-update/pincodes endpoint
--   does prefix-match searches against `tbl_pincode.location` and
--   `tbl_city.city_name` so technicians can type a place name and pick
--   their serviceable pincodes. Without indexes on those columns each
--   keystroke triggers a full scan of ~155k rows on tbl_pincode plus
--   a join scan of tbl_city.
--
--   The query was changed from mid-string fuzzy (`%foo%`) to prefix
--   (`foo%`) specifically to make BTREE indexes useful here — leading
--   wildcards kill index seek. The trade-off (users typing "delhi"
--   won't match "New Delhi" mid-string) is acceptable: operators
--   typically type from the start of the place name.
--
--   tbl_pincode already has indexes on `pincode` (UNIQUE) and `city_id`
--   from migrations/executed/2026-05-01-create-tbl-pincode.sql; this
--   migration adds the missing one on `location`.
--
--   tbl_city is a legacy table — operators check whether
--   `idx_city_name` already exists. If not, this migration adds it.
--
-- Idempotent — uses information_schema check inside stored procedures
-- so re-runs are safe.

DELIMITER $$

DROP PROCEDURE IF EXISTS _add_tbl_pincode_location_index$$
CREATE PROCEDURE _add_tbl_pincode_location_index()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'tbl_pincode'
      AND index_name = 'idx_pincode_location'
  ) THEN
    ALTER TABLE tbl_pincode ADD INDEX idx_pincode_location (location);
  END IF;
END$$

DROP PROCEDURE IF EXISTS _add_tbl_city_name_index$$
CREATE PROCEDURE _add_tbl_city_name_index()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'tbl_city'
      AND index_name = 'idx_city_name'
  ) THEN
    ALTER TABLE tbl_city ADD INDEX idx_city_name (city_name);
  END IF;
END$$

DELIMITER ;

CALL _add_tbl_pincode_location_index();
CALL _add_tbl_city_name_index();

DROP PROCEDURE _add_tbl_pincode_location_index;
DROP PROCEDURE _add_tbl_city_name_index;
