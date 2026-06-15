/*
 * Manage Zones — align legacy schema to spec:
 *   - Zone belongs to ONE city (city_id on tbl_zone_master).
 *   - Pincode belongs to ONE zone (zone_id on tbl_pincode, NULL = unzoned).
 *
 * Why this changes the legacy `tbl_zone_master`:
 *   The legacy zone model was M:N zone↔city via tbl_zone_city_mapping
 *   ("zones as multi-city service territories"). New spec re-frames zone as
 *   a sub-city subdivision (1 city has many zones; 1 zone = 1 city).
 *
 *   Adding `city_id` to tbl_zone_master is structurally lower-risk than
 *   dropping tbl_zone_city_mapping outright — legacy services + auto-assign
 *   still join through tbl_zone_city_mapping today, so we keep that table
 *   as a transitional bridge. New code reads `tbl_zone_master.city_id`
 *   directly. tbl_zone_city_mapping rows become app-layer-maintained
 *   shadows of (zone_id, zone.city_id) — one row per zone — for backward
 *   compatibility with `tbl_easyfixer.efr_zone_city_id`.
 *
 * Adding `zone_id` to tbl_pincode is unambiguous — that's our own table.
 *
 * Idempotent: column-existence guarded; safe to re-run.
 */

-- ─── 1. tbl_zone_master.city_id ──────────────────────────────────────
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'tbl_zone_master'
     AND COLUMN_NAME  = 'city_id'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE tbl_zone_master ADD COLUMN city_id INT NULL AFTER zone_name, ADD INDEX idx_zone_city (city_id)',
  'SELECT "tbl_zone_master.city_id already present — skipped" AS note'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ─── 2. tbl_pincode.zone_id ──────────────────────────────────────────
SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'tbl_pincode'
     AND COLUMN_NAME  = 'zone_id'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE tbl_pincode ADD COLUMN zone_id INT NULL AFTER city_id, ADD INDEX idx_pincode_zone (zone_id)',
  'SELECT "tbl_pincode.zone_id already present — skipped" AS note'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ─── 3. Verify ───────────────────────────────────────────────────────
SELECT
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_zone_master' AND COLUMN_NAME = 'city_id') AS zone_master_city_id_present,
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_pincode'    AND COLUMN_NAME = 'zone_id') AS pincode_zone_id_present;
