-- Track offer history per technician on the tbl_job_offer row:
--   offer_count = how many times this tech has been (re)offered this job
--   created_on  = FIRST offer time (never changes)
--   updated_on  = LAST offer time (bumped on every re-offer, NOT on accept/reject)
-- tbl_job_offer is EasyFix-owned (referenced by no legacy service), so adding
-- columns here is within the schema rules. Backfill existing rows from offered_at.
ALTER TABLE tbl_job_offer ADD COLUMN offer_count INT NOT NULL DEFAULT 1;
ALTER TABLE tbl_job_offer ADD COLUMN created_on DATETIME NULL;
ALTER TABLE tbl_job_offer ADD COLUMN updated_on DATETIME NULL;
UPDATE tbl_job_offer SET created_on = offered_at WHERE created_on IS NULL;
UPDATE tbl_job_offer SET updated_on = offered_at WHERE updated_on IS NULL;
