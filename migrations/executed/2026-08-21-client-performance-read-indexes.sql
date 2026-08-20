-- ============================================================================
-- 2026-08-21 — Read indexes for the client Performance book
--
-- Supports GET /api/client/performance, which is now the heaviest read in the
-- client portal. Three consumers, one access shape:
--
--   services/tat.service.js        forClientWindow()  — scores every completed
--                                  job in the window through the TAT engine
--   services/client-performance    closureStats(), firstTimeFix(), volume()
--   routes/client/index.js         /action-queue
--
-- Run on: easyfix_core (shared MySQL DB, port 3306)
--
-- ADDITIVE ONLY. These are indexes; no column, type or default changes. That
-- keeps the "never alter schema" rule intact in the way the repo has applied
-- it before — see migrations/executed/2026-06-08-easyfixers-list-covering-
-- indexes.sql, which added idx_job_fk_easyfixter_status to this same table.
--
-- NOT IDEMPOTENT, ON PURPOSE. MySQL has no CREATE INDEX IF NOT EXISTS, and the
-- only ways to fake it are a PREPARE dance or a stored procedure — both of
-- which this repo's migration style avoids. A re-run therefore fails with
-- ERROR 1061 "Duplicate key name", which is SAFE TO IGNORE: it means the index
-- is already there. Check with the verification block at the bottom first.
--
-- LOCKING. All three are ALGORITHM=INPLACE, LOCK=NONE, so tbl_job stays
-- writable while they build. On a large tbl_job expect minutes, not seconds —
-- run it in a low-traffic window anyway.
-- ============================================================================

-- ─── 1. Client + status + checkout ──────────────────────────────────
-- The driving predicate of the TAT engine's client window:
--   WHERE fk_client_id = ? AND job_status IN (3,5)
--     AND checkout_date_time >= ? AND checkout_date_time < ?
--   ORDER BY checkout_date_time DESC
--
-- Column order is deliberate: equality (fk_client_id) first, then the IN list
-- (job_status), then the range (checkout_date_time) last. A range column in
-- the middle would stop the optimiser using anything after it. With this order
-- the ORDER BY is also satisfied by the index, so the 5000-row LIMIT is a
-- cheap prefix read rather than a filesort over the client's whole history.
ALTER TABLE tbl_job ADD INDEX idx_job_client_status_checkout (fk_client_id, job_status, checkout_date_time), ALGORITHM=INPLACE, LOCK=NONE;

-- ─── 2. Client + status + cancel ────────────────────────────────────
-- The second branch of the window predicate in client-performance.service.js.
--
-- Two indexes rather than one because the query deliberately does NOT use
-- COALESCE(checkout_date_time, cancel_date_time): a column wrapped in a
-- function cannot use an index at all, so the window is written as two OR'd
-- branches on bare columns. This index serves the cancelled branch; index 1
-- serves the completed branch.
ALTER TABLE tbl_job ADD INDEX idx_job_client_status_cancel (fk_client_id, job_status, cancel_date_time), ALGORITHM=INPLACE, LOCK=NONE;

-- ─── 3. Job services by approval state ──────────────────────────────
-- GET /api/client/action-queue joins tbl_job_services on
--   js.job_id = J.job_id AND js.job_service_status = 1
-- to find estimates awaiting a client decision. Without this the join probes
-- by job_id alone and filters status per row.
ALTER TABLE tbl_job_services ADD INDEX idx_job_services_job_status (job_id, job_service_status), ALGORITHM=INPLACE, LOCK=NONE;

-- ─── Verification ───────────────────────────────────────────────────
-- RUN THIS FIRST if you are unsure whether the migration has already been
-- applied. Every `present` must be 1 afterwards. If a row already reads 1
-- before you start, skip that ALTER — re-running it is what raises 1061.
SELECT 'idx_job_client_status_checkout' AS what, COUNT(DISTINCT INDEX_NAME) AS present
  FROM INFORMATION_SCHEMA.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_job'
   AND INDEX_NAME = 'idx_job_client_status_checkout'
UNION ALL
SELECT 'idx_job_client_status_cancel', COUNT(DISTINCT INDEX_NAME)
  FROM INFORMATION_SCHEMA.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_job'
   AND INDEX_NAME = 'idx_job_client_status_cancel'
UNION ALL
SELECT 'idx_job_services_job_status', COUNT(DISTINCT INDEX_NAME)
  FROM INFORMATION_SCHEMA.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_job_services'
   AND INDEX_NAME = 'idx_job_services_job_status';

-- Sanity check the optimiser actually picks index 1. Substitute a real
-- client_id. `key` should read idx_job_client_status_checkout and Extra should
-- NOT say "Using filesort".
--
--   EXPLAIN SELECT job_id FROM tbl_job
--    WHERE fk_client_id = 123 AND job_status IN (3,5)
--      AND checkout_date_time >= '2026-08-01'
--      AND checkout_date_time <  '2026-09-01'
--    ORDER BY checkout_date_time DESC LIMIT 5000;
