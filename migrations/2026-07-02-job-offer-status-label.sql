-- Human-readable label for offer_status, WITHOUT changing the int codes (all app
-- logic keeps using 0/1/2/3). A VIRTUAL generated column: computed on read, no
-- storage, cannot drift out of sync, and every existing offer_status query keeps
-- working unchanged. Anyone browsing tbl_job_offer now sees OFFERED / ACCEPTED /
-- REJECTED / EXPIRED next to the code. Requires MySQL 5.7+.
ALTER TABLE tbl_job_offer ADD COLUMN offer_status_label VARCHAR(12) GENERATED ALWAYS AS (CASE offer_status WHEN 0 THEN 'OFFERED' WHEN 1 THEN 'ACCEPTED' WHEN 2 THEN 'REJECTED' WHEN 3 THEN 'EXPIRED' ELSE 'UNKNOWN' END) VIRTUAL;
