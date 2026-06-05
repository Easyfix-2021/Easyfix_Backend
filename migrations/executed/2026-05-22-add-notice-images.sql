-- =============================================================================
-- Notice Board — add image attachments support.
--
-- Adds a single nullable JSON column to tbl_notice that stores the
-- public URLs of attached images (max 5 per the FE upload UI; not
-- enforced at the DB layer since JSON arrays are length-agnostic and
-- the BE validator already caps it).
--
-- Format: ["url1", "url2", ...]  — relative URLs returned by the
-- existing /api/shared/upload endpoint (e.g. "/easydoc/1716_abcd.png").
--
-- Idempotent: re-runs are a no-op via INFORMATION_SCHEMA check.
-- =============================================================================

SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'tbl_notice'
     AND COLUMN_NAME  = 'images'
);

SET @ddl := IF(
  @col_exists = 0,
  'ALTER TABLE tbl_notice ADD COLUMN images JSON NULL AFTER action_url',
  'SELECT ''images column already exists — skipping'' AS note'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verify
SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME   = 'tbl_notice'
   AND COLUMN_NAME  = 'images';
