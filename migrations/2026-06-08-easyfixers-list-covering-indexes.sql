-- 2026-06-08 — covering indexes for Manage Easyfixers list-page aggregations.
-- Without these, the LEFT JOIN subqueries on tbl_job + tbl_efr_deepskill_mapping
-- full-scan their respective tables on every page load (40+s on 1.3k easyfixers).
ALTER TABLE tbl_job ADD INDEX idx_job_fk_easyfixter_status (fk_easyfixter_id, job_status);
ALTER TABLE tbl_efr_deepskill_mapping ADD INDEX idx_efr_deepskill_mapping_easyfixer (easyfixer_id);
