-- =============================================================================
-- Candidate-ranking pipeline supports — indexes + new default-score settings.
--
-- 1. Indexes that make the parallel batch in candidate-ranking.service.js
--    fast on prod-shaped data (tbl_job ~384 k rows, tbl_easyfixer ~5 k).
--    All ALTERs are guarded with information_schema lookups so re-runs
--    are no-ops.
--
-- 2. Two new auto-allocation settings:
--    - default_tat_score   (double, 0–1, default 0.5)
--    - default_sda_score   (double, 0–1, default 0.5)
--    Used as the score for technicians with NO completed-job history in
--    the lookback window. Without them new joiners are pegged at 0 and
--    unfairly outranked by anyone with mediocre real numbers.
--
-- Run on easyfix_core (QA first, then prod). Idempotent.
-- =============================================================================

-- ─── INDEXES ─────────────────────────────────────────────────────────
-- The per-candidate batch issues ~7 queries with these access patterns:
--
--   tbl_job:
--     A. WHERE fk_easyfixter_id IN (?) AND job_status IN (0,1,2)
--     B. WHERE fk_easyfixter_id IN (?) AND DATE(requested_date_time)=? AND time_slot=? AND job_status IN (0,1,2)
--     C. WHERE fk_easyfixter_id IN (?) AND job_status IN (3,5) AND scheduled_date_time IS NOT NULL …
--     D. WHERE fk_easyfixter_id IN (?) AND job_status IN (2,3,5) AND created_date_time >= …
--     E. WHERE fk_easyfixter_id IN (?) AND fk_client_id = ? AND job_status IN (3,5)
--     F. WHERE fk_easyfixter_id IN (?) AND fk_service_catg_id = ? AND job_status IN (3,5)
--
-- The legacy schema already has an index on tbl_job.fk_easyfixter_id alone,
-- which covers A and the IN-prefix of B-F. The DATE(requested_date_time)
-- predicate in B can't use an index on requested_date_time (function on
-- column), so we add a generated-virtual or accept the small scan; for
-- now we lean on the IN+status filter to keep the row-set small.
--
-- One missing index that meaningfully helps is the (easyfixer_id,
-- insert_date_time) composite on tbl_easyfixer_rating_by_customer — the
-- 90d window scans a lot of rows otherwise.

SET @ix_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'tbl_easyfixer_rating_by_customer'
     AND INDEX_NAME   = 'idx_efr_rating_efr_date'
);
SET @sql := IF(@ix_exists = 0,
  'ALTER TABLE tbl_easyfixer_rating_by_customer
     ADD INDEX idx_efr_rating_efr_date (easyfixer_id, insert_date_time)',
  'SELECT "idx_efr_rating_efr_date already present — skipped" AS note'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Optional composite for (fk_easyfixter_id, job_status, created_date_time)
-- on tbl_job — covers queries C/D/E/F. Skipped here because tbl_job already
-- carries a thick set of single-column indexes from legacy and adding
-- another wide one materially slows down INSERTs (job creation is on the
-- hot path). Re-evaluate if EXPLAIN shows full scans in prod.

-- ─── NEW SETTINGS ────────────────────────────────────────────────────
INSERT INTO tbl_autoallocation_setting (`key`, default_value, description, data_type)
SELECT 'default_tat_score',
       '0.5',
       'TAT sub-score (0.0–1.0) used in the performance score when a technician has NO completed-job history in the scoring window. Default 0.5 = neutral.',
       'double'
 WHERE NOT EXISTS (SELECT 1 FROM tbl_autoallocation_setting WHERE `key` = 'default_tat_score');

INSERT INTO tbl_autoallocation_setting (`key`, default_value, description, data_type)
SELECT 'default_sda_score',
       '0.5',
       'SDA sub-score (0.0–1.0) used in the performance score when a technician has no same-day-attempt history in the scoring window. Default 0.5 = neutral.',
       'double'
 WHERE NOT EXISTS (SELECT 1 FROM tbl_autoallocation_setting WHERE `key` = 'default_sda_score');

-- ─── Verify ──────────────────────────────────────────────────────────
SELECT TABLE_NAME, INDEX_NAME
  FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE()
   AND INDEX_NAME = 'idx_efr_rating_efr_date';

SELECT `key`, default_value, data_type
  FROM tbl_autoallocation_setting
 WHERE `key` IN ('default_tat_score', 'default_sda_score')
 ORDER BY `key`;
