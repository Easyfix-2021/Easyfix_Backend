-- 2026-08-10 -- bound the technician mobile open-offer read by current offers.
--
-- listOfferedForTech starts from (fk_easyfixter_id, offer_status), orders by
-- offered_at and stops at a small LIMIT. Extending that existing prefix makes
-- the ordered read covering and avoids a filesort, even if offer expiry is
-- temporarily disabled and the OPEN set grows. It then checks whether the same
-- technician/job has a newer history row; the second index lets MySQL seek to
-- that exact pair and range on job_offer_id.
--
-- idx_job_offer_efr_status is a strict left-prefix of the new ordered/covering
-- index, so retaining both would duplicate storage and write amplification.
-- Replace it atomically; status-only expiry/cleanup lookups keep the same
-- leading columns and therefore keep the same access path.

-- One atomic ALTER: the old index stays live until commit and the swap is
-- indivisible, so no live query is ever left index-less mid-DDL. ALGORITHM=INPLACE,
-- LOCK=NONE is pinned so the rebuild stays ONLINE (offer reads+writes continue) and
-- FAILS FAST instead of silently COPY-rebuilding under a blocking shared lock.
-- DROP INDEX + ADD INDEX both support INPLACE/LOCK=NONE on MySQL 5.7 and 8.0.
ALTER TABLE tbl_job_offer
  DROP INDEX idx_job_offer_efr_status,
  ADD INDEX idx_job_offer_efr_status_open
    (fk_easyfixter_id, offer_status, offered_at, job_id, job_offer_id),
  ADD INDEX idx_job_offer_efr_job_latest
    (fk_easyfixter_id, job_id, job_offer_id),
  ALGORITHM=INPLACE, LOCK=NONE;
