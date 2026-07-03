-- Record WHERE a job offer was made from (CRM Schedule & Assign):
--   'top10'  = picked from the ranked Top-10 candidate list
--   'search' = picked from a manual Search Result
--   'auto'   = auto-assignment engine
-- Reflects the LATEST offer's origin (updated on re-offer, alongside offer_count
-- / updated_on). tbl_job_offer is EasyFix-owned, so adding a column is allowed.
ALTER TABLE tbl_job_offer ADD COLUMN offer_source VARCHAR(20) NULL;
