-- 2026-06-27 — Job-offer ledger for the technician offer/accept flow (EasyFix-owned).
--
-- Backs THE OFFER MODEL (pool offers): when the offer flow is enabled, a CRM/auto
-- assign no longer hard-schedules the job. Instead the job stays BOOKED (status 0)
-- and tbl_job.fk_easyfixter_id stays NULL (no single owner yet) while one OFFERED
-- row per offered technician is written here, each with an FCM data-push
-- (type='job_offer'). A job may be offered to MANY technicians at once. The first
-- to ACCEPT wins a race-safe claim (offer_status 0->1, job 0->1 SCHEDULED, fk set
-- to the winner, all sibling open offers -> EXPIRED 3); late accepters get a 409
-- "already accepted". REJECT marks only that tech's offer 0->2 with a reason.
--
-- tbl_job_offer is EasyFix-owned and referenced by NO legacy service, so a new
-- owned table is the sanctioned route under the CLAUDE.md shared-DB carve-out
-- (same precedent as tbl_idempotency_key / tbl_pincode / tbl_job_location_track).
-- No existing table is altered. job_id / fk_easyfixter_id are LOGICAL references
-- to tbl_job.job_id / tbl_easyfixer.efr_id with NO foreign-key constraint —
-- legacy-DB convention keeps owned tables decoupled from the shared schema's
-- locking/cascade behaviour.
--
-- Columns:
--   job_offer_id      surrogate PK.
--   job_id            the offered job (tbl_job.job_id).
--   fk_easyfixter_id  the technician the job is offered to (tbl_easyfixer.efr_id;
--                     spelling matches the legacy tbl_job typo on purpose).
--   offer_status      0 OFFERED · 1 ACCEPTED · 2 REJECTED · 3 EXPIRED.
--   offered_at        when the offer was created.
--   responded_at      when the tech accepted/rejected (NULL while open).
--   reject_reason_id  optional FK-ish reason code on a REJECT.
--   reject_reason     optional free-text reason on a REJECT.
--   created_at        audit anchor.

CREATE TABLE tbl_job_offer (
  job_offer_id INT NOT NULL AUTO_INCREMENT,
  job_id INT NOT NULL,
  fk_easyfixter_id INT NOT NULL,
  offer_status TINYINT NOT NULL DEFAULT 0,
  offered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  responded_at DATETIME NULL,
  reject_reason_id INT NULL,
  reject_reason VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (job_offer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_job_offer_job ON tbl_job_offer (job_id);
CREATE INDEX idx_job_offer_efr_status ON tbl_job_offer (fk_easyfixter_id, offer_status);
