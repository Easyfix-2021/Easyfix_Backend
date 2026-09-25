-- ============================================================================
-- 2026-09-23 — tbl_job_logs(job_id, job_log_id): the index the feed needs
--
-- WHAT: one secondary index on tbl_job_logs (job_id, job_log_id).
--
-- WHY NOW: tbl_job_logs is the platform's job-history archive — ~1.7 million
-- rows, written since 2015 by the legacy Java stack and, since
-- services/job-log.service.js, by this backend too. Until today it was
-- WRITE-ONLY from the new stack's point of view: nothing read it. V3 plan 3.1
-- adds GET /api/admin/jobs/:id/activity, which reads it on every job open:
--
--     SELECT ... FROM tbl_job_logs
--      WHERE job_id = ?
--      ORDER BY change_date DESC, job_log_id DESC
--      LIMIT ?
--
-- Without an index leading on job_id that is a full scan of 1.7M rows per job
-- open, per operator. This is the same reasoning as
-- 2026-09-16-index-job-notes-job-id.sql, one order of magnitude up: that table
-- had 3,303 rows and still earned its index, because the cost is per OPEN and
-- not per row.
--
-- It matters more than a CRM-only feature normally would. This backend serves
-- the CRM, the technician app and the client dashboard from ONE MySQL. A scan
-- this size on an all-day screen does not slow the CRM down in isolation — it
-- spends buffer pool and IO that the app's job list and the client dashboard
-- are also using.
--
-- ─── WHY (job_id, job_log_id) AND NOT (job_id, change_date) ─────────────────
--
-- The read orders by (change_date DESC, job_log_id DESC). Indexing change_date
-- would let the sort be index-ordered — but a single job's rows are tens, and
-- MySQL sorts tens of rows in memory in microseconds. job_log_id is the PK and
-- therefore present in the index leaf whether or not it is named; naming it
-- costs no extra bytes and states the covering intent. Same trade, and the same
-- wording, as the job-notes index, deliberately: two indexes that solve the
-- same shape should not be reasoned about two different ways.
--
-- ─── ⚠ RUN THE DRY RUN FIRST. THIS TABLE IS OLDER THAN THIS REPO ────────────
--
-- Every other index this project has added was to a table it owns. tbl_job_logs
-- predates the new stack by a decade and no migration here created it, so its
-- current index list is NOT knowable from this repository — it has to be read
-- off the server. If the dry run shows any index whose FIRST column is job_id,
-- this migration is already satisfied: SKIP IT. Adding a second index on the
-- same leading column buys nothing and costs write throughput on a table that
-- takes a row on every job event across three products.
--
-- NOT IDEMPOTENT: MySQL has no CREATE INDEX IF NOT EXISTS, and this repo's
-- convention is plain statements (no @set / PREPARE / MariaDB-only syntax).
-- Re-running errors with "Duplicate key name", which is safe and loud.
--
-- ─── OPERATIONAL ────────────────────────────────────────────────────────────
--
-- CREATE INDEX is ALGORITHM=INPLACE on MySQL 8: the table stays readable and
-- writable, with a brief metadata lock at each end. On ~1.7M narrow rows expect
-- seconds to low minutes and a few tens of MB. Unlike the job-notes index this
-- one is big enough to deserve an off-peak window.
--
-- Additive only: no column added, dropped or altered, no row rewritten. Safe
-- either side of the application deploy — /activity works without it, just by
-- scanning, so land the index FIRST if the two are separated.
-- ============================================================================

-- Dry run (read-only) — RUN THIS FIRST. Skip the CREATE if any row comes back
-- with SEQ_IN_INDEX = 1 and COLUMN_NAME = 'job_id'.
SELECT INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, NON_UNIQUE
  FROM INFORMATION_SCHEMA.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'tbl_job_logs'
 ORDER BY INDEX_NAME, SEQ_IN_INDEX;

CREATE INDEX idx_job_logs_job_id ON tbl_job_logs (job_id, job_log_id);

-- Verify (read-only) — the new index, and the read it serves.
SHOW INDEX FROM tbl_job_logs;

EXPLAIN SELECT job_log_id, log_for, old_data, new_data, eta_status,
               change_date, changed_by, comments
          FROM tbl_job_logs
         WHERE job_id = 1
         ORDER BY change_date DESC, job_log_id DESC
         LIMIT 200;
