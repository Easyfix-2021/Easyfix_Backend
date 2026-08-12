-- Authoritative Aadhaar uniqueness for non-deleted technicians.
--
-- READ-ONLY schema review confirmed MySQL 8.4 / tbl_easyfixer InnoDB /
-- adhaar_card_number VARCHAR(12), so an indexed generated column is supported.
-- Preserve the existing product
-- rule from aadhaarPanExists(): efr_status=3 is deleted and does not reserve an
-- Aadhaar number. Blank legacy values project to NULL, so MySQL permits
-- multiple incomplete rows. The API validates every new value as 12 digits;
-- retaining any nonblank historical value in the key avoids silently weakening
-- uniqueness for pre-existing data.
--
-- Apply BEFORE the backend that queries active_aadhaar_unique. If historical
-- active duplicates exist, the UNIQUE ALTER fails without deleting or choosing
-- a technician. The 2026-08-11 baseline has 8 such groups (6 canonical
-- 12-digit groups), several spanning verified accounts. Resolve them through an
-- audited Ops/CRM process and rerun; DO NOT auto-dedupe identity records.
-- Deploy the legacy Java backend's named-constraint redaction handler before
-- enabling this UNIQUE index; otherwise its catch-all response can expose the
-- rejected Aadhaar value embedded in MySQL's duplicate-key message.

SET @has_active_aadhaar_column = (
  SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'tbl_easyfixer'
     AND COLUMN_NAME = 'active_aadhaar_unique'
);
SET @ddl_active_aadhaar_column = IF(
  @has_active_aadhaar_column = 0,
  'ALTER TABLE tbl_easyfixer ADD COLUMN active_aadhaar_unique VARCHAR(12) GENERATED ALWAYS AS (CASE WHEN NOT (efr_status <=> 3) THEN NULLIF(TRIM(adhaar_card_number), '''') ELSE NULL END) VIRTUAL, ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);
PREPARE stmt_active_aadhaar_column FROM @ddl_active_aadhaar_column;
EXECUTE stmt_active_aadhaar_column;
DEALLOCATE PREPARE stmt_active_aadhaar_column;

-- Safe preflight output: a count only; no Aadhaar values are printed.
SELECT COUNT(*) AS duplicate_active_aadhaar_values
  FROM (
    SELECT active_aadhaar_unique
      FROM tbl_easyfixer
     WHERE active_aadhaar_unique IS NOT NULL
     GROUP BY active_aadhaar_unique
    HAVING COUNT(*) > 1
  ) duplicates;

SET @has_active_aadhaar_unique = (
  SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'tbl_easyfixer'
     AND INDEX_NAME = 'uq_easyfixer_active_aadhaar'
     AND NON_UNIQUE = 0
);
SET @ddl_active_aadhaar_unique = IF(
  @has_active_aadhaar_unique = 0,
  'ALTER TABLE tbl_easyfixer ADD UNIQUE INDEX uq_easyfixer_active_aadhaar (active_aadhaar_unique), ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);
PREPARE stmt_active_aadhaar_unique FROM @ddl_active_aadhaar_unique;
EXECUTE stmt_active_aadhaar_unique;
DEALLOCATE PREPARE stmt_active_aadhaar_unique;

-- Verification (read-only; does not reveal Aadhaar values):
-- SELECT COLUMN_NAME, EXTRA FROM INFORMATION_SCHEMA.COLUMNS
--  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tbl_easyfixer'
--    AND COLUMN_NAME='active_aadhaar_unique';
-- SHOW INDEX FROM tbl_easyfixer WHERE Key_name='uq_easyfixer_active_aadhaar';
