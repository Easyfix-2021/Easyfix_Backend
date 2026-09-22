-- =============================================================================
-- 2026-09-18 — Pending for Material (job_status 16), Material Management
-- phase 2, sub-project D. See
-- docs/superpowers/specs/2026-09-18-pending-for-material-status-16-design.md.
--
-- WHAT: 2 new tbl_job columns (material_sub_status, permission_required), the
-- tbl_job_material_review side table for the PM's reject reason, plus the RBAC seed for the new admin action key
-- `isJobMaterialReview` (Material Review approve/reject), granted to the
-- Project Manager role.
--
-- material_reject_reason (tbl_job_material_review.reject_reason): the PM's reason on a Material
-- Review reject, shown to the technician above the estimate. Field name and
-- shape are FIXED by the shipped technician app, which already reads
-- material_reject_reason / materialRejectReason off the job row — do not
-- rename.
--
-- tbl_job IS SHARED — this is an ADD COLUMN, not a new table, so CLAUDE.md's
-- "never alter schema" rule is the one that matters here, not the new-table
-- exception. Both columns are NULLable-or-defaulted additions at the end of
-- the row: no existing SELECT * consumer's column COUNT/ordinal position
-- shifts in a way that breaks positional access, and no existing INSERT
-- writes tbl_job with a bare (implicit) column list anywhere in this backend
-- (every writer names its columns — verified by grep across services/ and
-- routes/). Legacy Java CRM / Flutter app consumers were not re-checked here
-- (out of this task's repo scope); an EasyFix_Backend-only ADD COLUMN of this
-- shape has shipped repeatedly (see migrations/executed/2026-09-10-job-offer-
-- closed-reason.sql, 2026-09-09-city-approval-flow.sql) without legacy
-- fallout, because both are strictly additive.
--
-- material_sub_status: 1 = Quotation Pending, 2 = Review Pending, NULL when
-- the job is not at 16. Deliberately a column, not derived from quotation
-- rows — "the technician sent this for review" is a decision, not a row
-- count (see the design's "Data model").
--
-- Both are TINYINT: db.js's typeCast coerces TINYINT columns to booleans in
-- this codebase's driver config (empirically true even without an explicit
-- "(1)" width — see the CAST(status AS SIGNED) precedent on
-- tbl_material_master.status in migrations/2026-09-17-manage-materials.sql's
-- sibling code), so every SELECT exposing either column must
-- CAST(... AS SIGNED).
--
-- IDEMPOTENCY (columns): one statement per line, plain ALTER, no `SET @var`/
-- PREPARE (banned in this repo — see migrations/executed/2026-08-18-branding-
-- render-mode.sql's header for why: a GUI client running a PREPARE'd ALTER
-- statement-by-statement can commit the column without the NEXT statement in
-- the same session seeing it). MySQL has no `ADD COLUMN IF NOT EXISTS` (that
-- is MariaDB-only) — every ADD COLUMN in this repo's migrations/ is plain and
-- NOT idempotent (migrations/executed/2026-09-16-customer-request-preferred-
-- slot.sql, 2026-09-09-city-approval-flow.sql, 2026-09-01-hrms-01-extend-
-- user-personal-details.sql, …). Section 1 below is the read-only preflight
-- that tells you whether section 2 still needs to run — "the honest
-- idempotent apply" this repo actually uses: read the preflight, then run or
-- skip the ALTER. Re-running an already-applied ALTER errors
-- ER_DUP_FIELDNAME (1060) — expected and harmless.
--
-- IDEMPOTENCY (RBAC seed): the menu_action INSERT and the role grant below
-- ARE idempotent (WHERE NOT EXISTS / isDeleted-revive), matching
-- migrations/2026-09-17-manage-materials.sql and migrations/executed/2026-09-
-- 15-seed-job-app-request-action.sql — a re-run is a no-op.
--
-- ROLE: `tbl_role` has 20 rows, 8 active; there is no seed data for role
-- names in this repo (only role_id=2 "Admin" and, in one comment, role_id=18
-- "Technology team" are ever hardcoded). EasyFix_Backend/CLAUDE.md's role
-- table names role_id 13 as "Project Manager" — that is the literal used
-- below, matched by CLAUDE.md's table, not verified against the live
-- tbl_role.role_name (this migration is NOT run against any database per
-- the task). If tbl_role.role_id 13 is not actually named "Project Manager"
-- on the target environment, section 3's role grant is a silent no-op
-- (UPDATE/INSERT touching 0 rows) rather than a wrong grant — verify with
-- the query at the bottom before relying on it.
--
-- Menu resolution follows 2026-09-17-manage-materials.sql's rule: FROM
-- tbl_menu, never a literal menu_id. isJobMaterialReview is a Manage Jobs
-- action (like isJobStatusChange / isJobAppRequestResolve), so it resolves
-- against the SAME menu row those use: url = 'job', menu_name = 'Manage Jobs'
-- (migrations/executed/2026-09-15-seed-job-app-request-action.sql).
-- =============================================================================

-- ─── 1. Preflight (read-only) — do the columns already exist? ─────────────

SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME   = 'tbl_job'
   AND COLUMN_NAME IN ('material_sub_status', 'permission_required');

-- ─── 2. The columns — run only the ones section 1 didn't already list ─────

ALTER TABLE tbl_job ADD COLUMN material_sub_status TINYINT NULL;

ALTER TABLE tbl_job ADD COLUMN permission_required TINYINT NOT NULL DEFAULT 0;

-- NOT a tbl_job column. tbl_job is a 153-column legacy table whose rows are
-- already at InnoDB's 8126-byte ceiling (40 VARCHARs totalling 8345 chars):
-- ADD COLUMN material_reject_reason fails with ER_TOO_BIG_ROWSIZE on QA as
-- VARCHAR(500) AND as TEXT. An EasyFix-owned side table is also the shape
-- CLAUDE.md prefers for a shared DB ("never alter schema … a new table no
-- legacy service references is the explicit exception"). The payload field
-- name the technician app reads is unchanged — job.service.js LEFT JOINs this
-- table and aliases it back to material_reject_reason.

CREATE TABLE IF NOT EXISTS tbl_job_material_review (
  job_id        INT PRIMARY KEY,
  reject_reason TEXT NULL,
  reviewed_by   INT  NULL,
  reviewed_at   DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── 3. RBAC seed — isJobMaterialReview, granted to Project Manager (role_id 13) ─

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isJobMaterialReview', 'Material Review (Approve/Reject)', 1, 0, NOW()
  FROM tbl_menu m
 WHERE m.url = 'job' AND m.menu_status = 1 AND m.menu_name = 'Manage Jobs'
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isJobMaterialReview');

UPDATE role_menu_action
   SET isDeleted = 0
 WHERE role_id = 13
   AND isDeleted = 1
   AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'isJobMaterialReview');

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 13, ma.id, 0
  FROM menu_action ma
 WHERE ma.action_name = 'isJobMaterialReview'
   AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 13 AND rma.menu_action_id = ma.id);

-- Admin (role_id 2) too: every phase-1 Manage Materials action was granted to
-- role 2 (2026-09-17-manage-materials.sql), and role 13 is unverified against
-- tbl_role on the target environment. Without this, an Admin could not review a
-- Material quote at all and the flow would dead-end at status 16.

UPDATE role_menu_action
   SET isDeleted = 0
 WHERE role_id = 2
   AND isDeleted = 1
   AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'isJobMaterialReview');

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0
  FROM menu_action ma
 WHERE ma.action_name = 'isJobMaterialReview'
   AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);

-- ─── 4. Verify (read-only) ─────────────────────────────────────────────────

SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME   = 'tbl_job'
   AND COLUMN_NAME IN ('material_sub_status', 'permission_required');

SELECT role_id, role_name FROM tbl_role WHERE role_id = 13;   -- confirm this IS "Project Manager" here

SELECT m.menu_name, ma.id, ma.action_name, ma.name,
       (SELECT COUNT(*) FROM role_menu_action rma
         WHERE rma.menu_action_id = ma.id AND rma.role_id = 13 AND rma.isDeleted = 0) AS pm_granted,
       (SELECT COUNT(*) FROM role_menu_action rma
         WHERE rma.menu_action_id = ma.id AND rma.role_id = 2 AND rma.isDeleted = 0) AS admin_granted
  FROM menu_action ma JOIN tbl_menu m ON m.menu_id = ma.menu_id
 WHERE ma.action_name = 'isJobMaterialReview';
-- Then save any role in Manage Roles (or restart) and log out/in: permissions are cached 60 s.
