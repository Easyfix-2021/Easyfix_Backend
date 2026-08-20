-- Bounded technician PHE Under Audit reads.
--
-- The equality columns mirror the full legacy Waiting Audit predicate before
-- the review timestamp range/order. No existing index or column is changed.

SET @has_phe_under_audit = (
  SELECT COUNT(*) FROM (
    SELECT index_name FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'tbl_job'
     GROUP BY index_name
    HAVING GROUP_CONCAT(column_name ORDER BY seq_in_index)
             = 'fk_easyfixter_id,job_status,no_of_req_approval,no_of_req_foh,revisit_reason_id,app_checkout_date_time,job_id'
        OR GROUP_CONCAT(column_name ORDER BY seq_in_index)
             LIKE 'fk_easyfixter_id,job_status,no_of_req_approval,no_of_req_foh,revisit_reason_id,app_checkout_date_time,job_id,%'
  ) equivalent_index
);

SET @ddl_phe_under_audit = IF(
  @has_phe_under_audit = 0,
  'ALTER TABLE tbl_job ADD INDEX idx_job_efr_under_audit (fk_easyfixter_id, job_status, no_of_req_approval, no_of_req_foh, revisit_reason_id, app_checkout_date_time, job_id), ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);
PREPARE stmt_phe_under_audit FROM @ddl_phe_under_audit;
EXECUTE stmt_phe_under_audit;
DEALLOCATE PREPARE stmt_phe_under_audit;
