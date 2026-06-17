-- 2026-06-11 — Enforce city-name uniqueness at the DB level.
--
-- Functional UNIQUE INDEX on the case-insensitive trimmed city_name. Once
-- this lands, no future INSERT can accidentally create a duplicate even
-- if seeder logic (theirs OR ours) is buggy. The seeder's name-only
-- fallback (services/india-locations.service.js) becomes a defence-in-
-- depth safety net rather than the sole guard.
--
-- ⚠️ PREREQUISITES (run BEFORE this migration):
--   1. MySQL 8.0+ (functional indexes are 8.0+ only). Probe with:
--        SELECT VERSION();
--      If you're on 5.7, ABORT — apply the dedup migration only and run
--      this one after the upgrade.
--   2. Run migrations/2026-06-11-dedup-tbl-city.sql first. If duplicates
--      exist, this ALTER fails with `Duplicate entry '<name>' for key`.
--
-- Run the dedup script first, verify zero name collisions, then apply
-- this index.

ALTER TABLE tbl_city
  ADD UNIQUE INDEX uk_city_norm_name ((LOWER(TRIM(city_name))));

-- Post-check — should return ZERO rows. Operator runs this manually.
--   SELECT LOWER(TRIM(city_name)) AS norm, COUNT(*) AS n
--     FROM tbl_city
--    GROUP BY norm
--   HAVING COUNT(*) > 1;
