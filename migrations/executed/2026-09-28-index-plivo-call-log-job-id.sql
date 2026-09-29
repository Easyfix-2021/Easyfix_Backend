-- ============================================================================
-- 2026-09-28 — tbl_plivo_call_log(job_id): the attempt ledger's missing index
--
-- WHAT: one secondary index on tbl_plivo_call_log (job_id).
--
-- WHY: the Booking-queue attempt ledger (services/booking-queue.service.js,
-- attemptDatesSql / attemptColumns) reads this table as a correlated
-- `WHERE pcl.job_id = j.job_id` for EVERY open order — twice per order in the
-- tile counts, and again per row in the grid. The table's only indexes are
-- conference_id, initiated_on, job_caller_info_id, call_uuid and the PK, so each
-- of those lookups is a full scan. 34 rows on QA (2026-09-28) hides it; Plivo is
-- the live telephony provider, so on Prod the table grows with every call and
-- the scan grows with it, multiplied by the number of open orders.
--
-- The sibling ledger tables already have their job_id indexes:
--     tbl_job_comment       idx_jc_job_comment_on (job_id, comment_on, created_on)
--     tbl_job_caller_info   idx_jci_job_attempt   (job_id, call_type, inserted_time)
--
-- OPERATIONAL: CREATE INDEX is ALGORITHM=INPLACE on MySQL 8 — the table stays
-- readable and writable. Additive only; safe before or after the app deploy.
--
-- ⚠ NOT IDEMPOTENT (no CREATE INDEX IF NOT EXISTS; plain statements per repo
-- convention). A re-run fails with "Duplicate key name", safely. Verify with the
-- SHOW INDEX below.
-- ============================================================================

CREATE INDEX idx_plivo_log_job_id ON tbl_plivo_call_log (job_id);

-- Verify (read-only).
SHOW INDEX FROM tbl_plivo_call_log;
