-- 2026-06-06 — Add `deepskill_tag_words` column to tbl_deep_skill
--
-- New column captures the per-skill "tag words to show the technician
-- on the job" (max ~2 short tags, free-text). Sourced from Col B of
-- the bulk-upload xlsx files ops provided 2026-06-05 — a separate
-- semantic from the keyword search-tag string we already store in
-- `deepskill_description`.
--
-- Safe schema change: tbl_deep_skill is EasyFix-owned, no legacy
-- service references it. Column is nullable so existing rows stay
-- valid without backfill.
--
-- Style: plain one-statement-per-line per the user's migration-style
-- rule (no @set/PREPARE/EXECUTE).

ALTER TABLE tbl_deep_skill ADD COLUMN deepskill_tag_words VARCHAR(255) NULL DEFAULT NULL;

-- Verify
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_NAME = 'tbl_deep_skill'
   AND COLUMN_NAME = 'deepskill_tag_words';
