-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-16 — screenshots on issue COMMENTS (owner: "users should be able
-- to add images in comments as well").
--
-- ONE TABLE, NOT TWO. tbl_crm_issue_image already holds an issue's
-- screenshots; a comment's are the same thing attached one level deeper, so
-- this adds a NULLABLE comment_id rather than a parallel
-- tbl_crm_issue_comment_image. Three things fall out of that for free:
--   · every existing row keeps meaning exactly what it meant — comment_id
--     NULL IS "the report's own screenshots", no backfill;
--   · one S3 prefix, one key builder, one presign path;
--   · the closed_on + 1 month cleanup cron sweeps by issue_id and therefore
--     collects a comment's images too, with no second code path to forget.
--
-- READERS MUST NOW SAY WHICH SET THEY WANT. Anything that meant "the issue's
-- screenshots" has to add `AND comment_id IS NULL`, or a reply's attachments
-- silently join the report's gallery and inflate screenshot_count. That is
-- done in services/issue.service.js in the same commit as this file
-- (imageKeysByIssue + the list's screenshot_count subquery).
--
-- The FK cascades from the COMMENT, and the existing one still cascades from
-- the issue — deleting either parent removes the row, and a comment cannot
-- outlive its issue anyway.
--
-- EasyFix-owned table, no legacy reader (the documented shared-DB carve-out).
-- Style: one statement per line, no variables.

ALTER TABLE tbl_crm_issue_image ADD COLUMN comment_id INT NULL DEFAULT NULL;

ALTER TABLE tbl_crm_issue_image ADD KEY idx_crm_issue_image_comment (comment_id);

ALTER TABLE tbl_crm_issue_image ADD CONSTRAINT fk_crm_issue_image_comment FOREIGN KEY (comment_id) REFERENCES tbl_crm_issue_comment (id) ON DELETE CASCADE;


-- ── Verification ────────────────────────────────────────────────────
-- SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS
--  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_crm_issue_image' AND COLUMN_NAME = 'comment_id';
-- Expect one row: comment_id / int / YES.
-- SELECT COUNT(*) AS report_images FROM tbl_crm_issue_image WHERE comment_id IS NULL;
-- Every pre-existing row must still be counted here.
