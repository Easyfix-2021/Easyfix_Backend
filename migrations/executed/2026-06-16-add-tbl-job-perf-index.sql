-- Composite index to back the technician weekly-performance query
-- (services/mobile-performance.service.js → GET /api/mobile/performance/weekly)
-- and the rolling OTA/SDA computation in services/performance.service.js.
-- Both filter `fk_easyfixter_id` + `job_status IN (3,5)` and range/order on
-- `checkin_date_time`; without a composite index that is a per-technician
-- range scan over tbl_job.
--
-- ⚠️ SHARED-TABLE CAVEAT — READ BEFORE RUNNING:
--   tbl_job is the core SHARED table used by all five legacy services + CRM.
--   The standing rule is "never alter the shared schema"; this index is an
--   ADDITIVE, non-structural exception (no column/data change, only a read
--   optimisation) — but it is still an ALTER on a very large hot table and
--   MUST be applied by ops in a low-traffic window. It is NOT auto-applied.
--   InnoDB online DDL (ALGORITHM=INPLACE, LOCK=NONE) builds the index without
--   blocking reads/writes; on a huge table it still consumes I/O + time.
--   Before running, confirm it doesn't already exist:
--     SHOW INDEX FROM tbl_job WHERE Key_name = 'idx_job_efr_status_checkin';
--   ADD INDEX is NOT idempotent in MySQL (re-running errors "Duplicate key
--   name") — run exactly once.

ALTER TABLE tbl_job
  ADD INDEX idx_job_efr_status_checkin (fk_easyfixter_id, job_status, checkin_date_time),
  ALGORITHM=INPLACE, LOCK=NONE;
