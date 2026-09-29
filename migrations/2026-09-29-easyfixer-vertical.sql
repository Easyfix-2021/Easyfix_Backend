-- 2026-09-29 — tbl_easyfixer.efr_vertical_id: the vertical a technician is
-- ONBOARDED for.
--
-- WHY. The New Registration 2 onboarding review has to record which vertical a
-- technician is being taken on for, and nothing in the schema could hold it:
-- tbl_easyfixer had no vertical column at all, and tbl_vertical_mapping is a
-- CLIENT/SPOC mapping (client_id + vertical_id + user_type), not a technician
-- one. Confirmed on QA 2026-09-29:
--     SHOW COLUMNS FROM tbl_easyfixer LIKE '%vertical%'   -> empty
--
-- IT IS A LABEL, NOT A FENCE. Priyanka's rule: a technician is onboarded FOR
-- one vertical, but is not restricted to it — he can still work jobs in any
-- vertical. So nothing reads this column to gate allocation, and no allocation
-- or ranking query is changed by this migration. It exists to answer "which
-- vertical did we take him on for", and to group technicians by it later.
--
-- ONE VERTICAL, SO A COLUMN — NOT A MAPPING TABLE. A single-valued attribute of
-- the technician belongs on the technician row. A join table would be the
-- answer if he could carry several; he cannot.
--
-- SAFE FOR THE LEGACY CONSUMERS — this ADDS a nullable column and changes no
-- existing one. Legacy readers name their columns or map a result set onto a
-- Java bean by name, so a column they have never heard of is invisible to
-- them; nothing they write can violate a NULL-able column with no default
-- constraint. Every existing row reads NULL, meaning "onboarded before we
-- started recording this" — which is exactly true.
--
-- FK DELIBERATELY OMITTED, matching this schema's house style: tbl_easyfixer
-- carries efr_cityId and efr_manager_id as plain INTs with no foreign key
-- either. The CRM validates vertical_id against the tbl_vertical lookup before
-- it writes.
--
-- INDEX. Added because the intended reads are "all technicians onboarded for
-- vertical X" (a roster filter and a report); without it those scan the table.
--
-- IDEMPOTENT — re-runnable. Both statements are guarded against
-- INFORMATION_SCHEMA, so a second run is a no-op rather than an error.

SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'tbl_easyfixer'
     AND COLUMN_NAME  = 'efr_vertical_id'
);
SET @sql := IF(@col_exists = 0,
  'ALTER TABLE tbl_easyfixer ADD COLUMN efr_vertical_id INT NULL COMMENT ''tbl_vertical.vertical_id this technician was onboarded for; a label, not a work restriction''',
  'SELECT ''efr_vertical_id already present — skipped'' AS note'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'tbl_easyfixer'
     AND INDEX_NAME   = 'idx_easyfixer_vertical'
);
SET @sql := IF(@idx_exists = 0,
  'CREATE INDEX idx_easyfixer_vertical ON tbl_easyfixer (efr_vertical_id)',
  'SELECT ''idx_easyfixer_vertical already present — skipped'' AS note'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Verification (read-only):
-- SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS
--  WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='tbl_easyfixer'
--    AND COLUMN_NAME='efr_vertical_id';        -- expect int, YES
-- SELECT v.vertical_name, COUNT(*) FROM tbl_easyfixer e
--   JOIN tbl_vertical v ON v.vertical_id = e.efr_vertical_id GROUP BY 1;
