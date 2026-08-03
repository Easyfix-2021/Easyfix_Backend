-- Audit of technician "share job" links: WHO shared WHICH job, WHEN, and the
-- short_code the message used. EasyFix-owned; no legacy service references it
-- (allowed under the never-add-tables exception).
--
-- Why a dedicated table (not tbl_url_shortener.fk_created_by): that column is a
-- tbl_user FK, but technicians live in tbl_easyfixer (efr_id) — storing an
-- efr_id there would be a wrong/dangling FK. The shortener still mints the code;
-- this table records the sharer identity separately.

CREATE TABLE tbl_job_share_link (
  share_id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  job_id INT NOT NULL,
  fk_easyfixer_id INT NOT NULL,
  short_code VARCHAR(16) DEFAULT NULL,
  created_on DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_share_job (job_id),
  KEY idx_share_efr (fk_easyfixer_id)
);
