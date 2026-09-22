-- =============================================================================
-- 2026-09-21 — Material Request Flow v2. See
-- docs/superpowers/specs/2026-09-21-material-request-flow-v2-design.md.
-- Supersedes the sub-status-1 ("Quotation Pending") parts of
-- migrations/2026-09-18-pending-for-material.sql — material_sub_status = 1 is
-- no longer WRITTEN by this codebase after this ships (the column and any
-- existing rows carrying it stay; older app builds still read it).
--
-- WHAT: 2 new quotation_details columns (client_status, client_action_on) —
-- the CLIENT's own per-line approve/reject decision, distinct from the
-- EXISTING status/action_on pair (the CRM/PM's decision) — plus 1 new
-- tbl_job_material_review column (pre_material_status).
--
-- quotation_details IS SHARED (legacy ACD_APIs QuotationDetails.java). These
-- are additive, nullable columns at the end of the row — not a rename/retype
-- of anything existing — so no existing SELECT * / positional-access consumer
-- breaks (same reasoning as migrations/2026-09-18-pending-for-material.sql's
-- tbl_job ADD COLUMNs).
--
-- client_status mirrors the existing `status` column's shape: TINYINT, NULL
-- until the client acts, 1 = approved, 0 = rejected. Like `status`, every
-- SELECT of it must CAST(... AS SIGNED) — db.js's mysql2 typeCast coerces a
-- bare TINYINT to a boolean in this codebase's driver config (same note as
-- migrations/2026-09-18-pending-for-material.sql). client_action_on is the
-- CLIENT's own action timestamp, independent of the existing `action_on`
-- (a line can be CRM-approved and still awaiting the client's decision).
--
-- pre_material_status is TINYINT NULL on tbl_job_material_review — already a
-- side table for exactly this reason (see that migration's header: tbl_job is
-- at the InnoDB row-size ceiling, so nothing further is ever ADDed there for
-- this feature). tbl_job_material_review.job_id is already PRIMARY KEY, so
-- this is one row per job; services/material-review-store.js writes it via an
-- INSERT .. ON DUPLICATE KEY UPDATE that names ONLY this column, so it never
-- disturbs reject_reason/reviewed_by/reviewed_at written by the sub-project D
-- flow (or vice versa).
--
-- IDEMPOTENCY: one statement per line, plain ALTER, no `SET @var`/PREPARE
-- (banned in this repo — see migrations/executed/2026-08-18-branding-render-
-- mode.sql's header). MySQL has no `ADD COLUMN IF NOT EXISTS` (MariaDB-only)
-- — every ADD COLUMN in this repo's migrations/ is plain and NOT idempotent.
-- Section 1 below is the read-only preflight; run section 2's ALTERs only for
-- the columns section 1 didn't already list. Re-running an already-applied
-- ALTER errors ER_DUP_FIELDNAME (1060) — expected and harmless.
--
-- NOT RUN AGAINST ANY DATABASE by this change — the lead runs it.
-- =============================================================================

-- ─── 1. Preflight (read-only) — do the columns already exist? ─────────────

SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME   = 'quotation_details'
   AND COLUMN_NAME IN ('client_status', 'client_action_on');

SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME   = 'tbl_job_material_review'
   AND COLUMN_NAME  = 'pre_material_status';

-- ─── 2. The columns — run only the ones section 1 didn't already list ─────

ALTER TABLE quotation_details ADD COLUMN client_status TINYINT NULL;

ALTER TABLE quotation_details ADD COLUMN client_action_on DATETIME NULL;

ALTER TABLE tbl_job_material_review ADD COLUMN pre_material_status TINYINT NULL;

-- ─── 3. Verify (read-only) ─────────────────────────────────────────────────

SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME   = 'quotation_details'
   AND COLUMN_NAME IN ('client_status', 'client_action_on');

SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME   = 'tbl_job_material_review'
   AND COLUMN_NAME  = 'pre_material_status';
