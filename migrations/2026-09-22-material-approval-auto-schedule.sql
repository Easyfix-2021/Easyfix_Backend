-- =============================================================================
-- 2026-09-22 — Material Approval Auto-Schedule. See
-- docs/superpowers/specs/2026-09-21-material-request-flow-v2-design.md, the
-- 2026-09-22 amendment, "Auto-reschedule after ANY client approval".
--
-- WHAT:
--   1. NEW side table tbl_job_auto_schedule — one row per job that needed
--      auto-rescheduling after a client (portal / public link / admin
--      on-behalf) material approval but had no open technician slot in the
--      next 7 days. tbl_job is at the InnoDB row-size ceiling (see
--      migrations/2026-09-21-material-request-flow-v2.sql's header) — nothing
--      further is ever ADDed there for this feature, hence a side table,
--      exactly like tbl_job_material_review.
--   2. A seeded action_taken_reason row (action_type = 8, the same
--      "Reschedule" bucket services/lookup.service.js#rescheduleReasons()
--      reads and GET /admin/jobs/reschedule-reasons serves) so the
--      auto-reschedule audit trail (scheduling_history.reason_id,
--      tbl_job.reschedule_reason_id) resolves to a readable label instead of
--      an orphan id. Same idempotent SELECT..WHERE NOT EXISTS shape as
--      migrations/executed/2026-07-10-seed-reschedule-reasons-action-type-8.sql.
--
-- tbl_job_auto_schedule columns:
--   job_id      INT PK — one row per job (a later successful reschedule()
--               CLEARS it via cleared_at rather than deleting the row, so the
--               history of "this job once needed manual scheduling" survives
--               — see services/job.service.js#reschedule()'s own hook).
--   status      VARCHAR — 'needs_scheduling' today; free-text so a future
--               state doesn't need a schema change.
--   reason      VARCHAR — human-readable ("No available slot in the next 7
--               days", "No technician assigned", or a caught error message).
--   created_at  DATETIME — when the flag was raised. new Date() app-side,
--               never SQL NOW() (pool session timezone '+05:30' stores it as
--               IST verbatim — same rule as every other DATETIME write in
--               this codebase; see db.js).
--   cleared_at  DATETIME NULL — set by services/job.service.js#reschedule()
--               the next time ANYONE successfully reschedules this job.
--
-- IDEMPOTENCY: one statement per line, plain CREATE TABLE IF NOT EXISTS /
-- INSERT..SELECT..WHERE NOT EXISTS, no `SET @var`/PREPARE (banned in this
-- repo) and no MariaDB-only syntax.
--
-- NOT RUN AGAINST ANY DATABASE by this change — the lead runs it.
-- =============================================================================

-- ─── 1. Preflight (read-only) — does the table already exist? ─────────────

SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_job_auto_schedule';

-- ─── 2. The table ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tbl_job_auto_schedule (job_id INT NOT NULL, status VARCHAR(32) NOT NULL, reason VARCHAR(255) NULL, created_at DATETIME NOT NULL, cleared_at DATETIME NULL, PRIMARY KEY (job_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── 3. The seeded reason row ───────────────────────────────────────────────

INSERT INTO action_taken_reason (action_type, action_desc, user_type, status)
SELECT 8, 'Material Approved — Auto Reschedule', 1, 1
 WHERE NOT EXISTS (SELECT 1 FROM action_taken_reason WHERE action_type = 8 AND action_desc = 'Material Approved — Auto Reschedule');

-- ─── 4. Verify (read-only) ───────────────────────────────────────────────────

SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_job_auto_schedule';

SELECT id, action_desc, user_type, status FROM action_taken_reason
 WHERE action_type = 8 AND action_desc = 'Material Approved — Auto Reschedule';
