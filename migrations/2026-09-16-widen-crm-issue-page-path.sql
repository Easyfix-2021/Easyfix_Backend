-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-16 — tbl_crm_issue.page_path VARCHAR(255) → VARCHAR(2048)
--
-- Since 2026-09-16 the issue reporter stores the page's QUERY STRING as well
-- as its path (owner: "capture the page URL"), because
-- /my-orders?tab=pending-start&action=reassign&jobId=509493 is the
-- reproduction. A filter URL carrying a CSV of ids can run well past 255,
-- and the validator was truncating it to fit — a broken repro link.
--
-- DEPLOY ORDER DOES NOT MATTER for this one, unlike the v2 image change on
-- this same table: the service catches ER_DATA_TOO_LONG on insert and retries
-- with the value cut to 255, so code on a 255 column degrades to the old
-- truncation rather than a 500, and SQL on old code changes nothing.
--
-- EasyFix-owned table, no legacy reader (the documented shared-DB carve-out).
-- MODIFY is idempotent in effect: re-running sets the same type.
--
-- Style: one statement per line, no variables.

ALTER TABLE tbl_crm_issue MODIFY page_path VARCHAR(2048) NULL DEFAULT NULL;


-- ── Verification ────────────────────────────────────────────────────
-- SELECT CHARACTER_MAXIMUM_LENGTH FROM INFORMATION_SCHEMA.COLUMNS
--  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_crm_issue' AND COLUMN_NAME = 'page_path';
-- Expect 2048.
