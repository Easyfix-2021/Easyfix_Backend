-- Bounded PHE + Team Profile read-path indexes.
--
-- Every ADD is guarded by an equivalent left-prefix check. The two legacy
-- transaction tables may use an engine that cannot guarantee LOCK=NONE, so
-- their DDL intentionally omits online-DDL clauses and should run in the normal
-- low-traffic migration window. No column or existing index is changed.

SET @has_team_members = (
  SELECT COUNT(*) FROM (
    SELECT index_name FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'tbl_easyfixer'
     GROUP BY index_name
    HAVING GROUP_CONCAT(column_name ORDER BY seq_in_index) IN ('efr_manager_id,efr_status', 'efr_manager_id,efr_status,efr_id')
        OR GROUP_CONCAT(column_name ORDER BY seq_in_index) LIKE 'efr_manager_id,efr_status,efr_id,%'
  ) equivalent_index
);
SET @ddl_team_members = IF(
  @has_team_members = 0,
  'ALTER TABLE tbl_easyfixer ADD INDEX idx_efr_manager_active (efr_manager_id, efr_status, efr_id), ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);
PREPARE stmt_team_members FROM @ddl_team_members;
EXECUTE stmt_team_members;
DEALLOCATE PREPARE stmt_team_members;

SET @has_wallet_window = (
  SELECT COUNT(*) FROM (
    SELECT index_name FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'tbl_easyfixer_transaction'
     GROUP BY index_name
    HAVING GROUP_CONCAT(column_name ORDER BY seq_in_index)
             IN ('easyfixer_id,transaction_type,transaction_date,transaction_id,job_id')
        OR GROUP_CONCAT(column_name ORDER BY seq_in_index)
             LIKE 'easyfixer_id,transaction_type,transaction_date,transaction_id,job_id,%'
  ) equivalent_index
);
SET @ddl_wallet_window = IF(
  @has_wallet_window = 0,
  'ALTER TABLE tbl_easyfixer_transaction ADD INDEX idx_efr_tx_credit_window (easyfixer_id, transaction_type, transaction_date, transaction_id, job_id)',
  'SELECT 1'
);
PREPARE stmt_wallet_window FROM @ddl_wallet_window;
EXECUTE stmt_wallet_window;
DEALLOCATE PREPARE stmt_wallet_window;

SET @has_wallet_job = (
  SELECT COUNT(*) FROM (
    SELECT index_name FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'tbl_easyfixer_transaction'
     GROUP BY index_name
    HAVING GROUP_CONCAT(column_name ORDER BY seq_in_index)
             IN ('easyfixer_id,job_id,transaction_type,transaction_date')
        OR GROUP_CONCAT(column_name ORDER BY seq_in_index)
             LIKE 'easyfixer_id,job_id,transaction_type,transaction_date,%'
  ) equivalent_index
);
SET @ddl_wallet_job = IF(
  @has_wallet_job = 0,
  'ALTER TABLE tbl_easyfixer_transaction ADD INDEX idx_efr_tx_job_credit (easyfixer_id, job_id, transaction_type, transaction_date)',
  'SELECT 1'
);
PREPARE stmt_wallet_job FROM @ddl_wallet_job;
EXECUTE stmt_wallet_job;
DEALLOCATE PREPARE stmt_wallet_job;

SET @has_job_tx_fk = (
  SELECT COUNT(*) FROM (
    SELECT index_name FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'tbl_job_transaction'
     GROUP BY index_name
    HAVING GROUP_CONCAT(column_name ORDER BY seq_in_index) = 'fk_job_id'
        OR GROUP_CONCAT(column_name ORDER BY seq_in_index) LIKE 'fk_job_id,%'
  ) equivalent_index
);
SET @ddl_job_tx_fk = IF(
  @has_job_tx_fk = 0,
  'ALTER TABLE tbl_job_transaction ADD INDEX idx_job_tx_job (fk_job_id)',
  'SELECT 1'
);
PREPARE stmt_job_tx_fk FROM @ddl_job_tx_fk;
EXECUTE stmt_job_tx_fk;
DEALLOCATE PREPARE stmt_job_tx_fk;

SET @has_offer_response_window = (
  SELECT COUNT(*) FROM (
    SELECT index_name FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'tbl_job_offer'
     GROUP BY index_name
    HAVING GROUP_CONCAT(column_name ORDER BY seq_in_index)
             IN ('fk_easyfixter_id,offer_status,responded_at,job_id,job_offer_id')
        OR GROUP_CONCAT(column_name ORDER BY seq_in_index)
             LIKE 'fk_easyfixter_id,offer_status,responded_at,job_id,job_offer_id,%'
  ) equivalent_index
);
SET @ddl_offer_response_window = IF(
  @has_offer_response_window = 0,
  'ALTER TABLE tbl_job_offer ADD INDEX idx_job_offer_efr_response (fk_easyfixter_id, offer_status, responded_at, job_id, job_offer_id), ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);
PREPARE stmt_offer_response_window FROM @ddl_offer_response_window;
EXECUTE stmt_offer_response_window;
DEALLOCATE PREPARE stmt_offer_response_window;

SET @has_job_efr_checkout = (
  SELECT COUNT(*) FROM (
    SELECT index_name FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'tbl_job'
     GROUP BY index_name
    HAVING GROUP_CONCAT(column_name ORDER BY seq_in_index)
             IN ('fk_easyfixter_id,job_status,checkout_date_time', 'fk_easyfixter_id,job_status,checkout_date_time,job_id')
        OR GROUP_CONCAT(column_name ORDER BY seq_in_index)
             LIKE 'fk_easyfixter_id,job_status,checkout_date_time,job_id,%'
  ) equivalent_index
);
SET @ddl_job_efr_checkout = IF(
  @has_job_efr_checkout = 0,
  'ALTER TABLE tbl_job ADD INDEX idx_job_efr_status_checkout (fk_easyfixter_id, job_status, checkout_date_time, job_id), ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);
PREPARE stmt_job_efr_checkout FROM @ddl_job_efr_checkout;
EXECUTE stmt_job_efr_checkout;
DEALLOCATE PREPARE stmt_job_efr_checkout;

SET @has_withdrawal_history = (
  SELECT COUNT(*) FROM (
    SELECT index_name FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'tbl_easyfixer_withdrawal_request'
     GROUP BY index_name
    HAVING GROUP_CONCAT(column_name ORDER BY seq_in_index)
             IN ('fk_easyfixer_id,request_id')
        OR GROUP_CONCAT(column_name ORDER BY seq_in_index)
             LIKE 'fk_easyfixer_id,request_id,%'
  ) equivalent_index
);
SET @ddl_withdrawal_history = IF(
  @has_withdrawal_history = 0,
  'ALTER TABLE tbl_easyfixer_withdrawal_request ADD INDEX idx_efr_withdrawal_history (fk_easyfixer_id, request_id), ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);
PREPARE stmt_withdrawal_history FROM @ddl_withdrawal_history;
EXECUTE stmt_withdrawal_history;
DEALLOCATE PREPARE stmt_withdrawal_history;
