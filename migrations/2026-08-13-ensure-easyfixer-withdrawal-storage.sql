-- Ensure the EasyFix-owned technician withdrawal queue exists and records the
-- immutable payout destination used for each request.
--
-- Why this is pending even though a 2026-07-09 CREATE file is under
-- migrations/executed/: the configured database does not contain the table.
-- This reconciliation is idempotent for both cases: a fresh environment and
-- an environment with the earlier, smaller table.

CREATE TABLE IF NOT EXISTS tbl_easyfixer_withdrawal_request (
  request_id INT AUTO_INCREMENT PRIMARY KEY,
  fk_easyfixer_id INT NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'requested',
  requested_on DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_on DATETIME NULL DEFAULT NULL,
  processed_by INT NULL DEFAULT NULL,
  remarks VARCHAR(255) NULL DEFAULT NULL,
  bank_details_id INT NULL DEFAULT NULL,
  bank_account_number VARCHAR(32) NULL DEFAULT NULL,
  bank_ifsc VARCHAR(20) NULL DEFAULT NULL,
  bank_account_holder_name VARCHAR(255) NULL DEFAULT NULL,
  bank_id INT NULL DEFAULT NULL,
  bank_name VARCHAR(255) NULL DEFAULT NULL,
  INDEX idx_efr_status (fk_easyfixer_id, status),
  INDEX idx_status (status)
) ENGINE=InnoDB;

DELIMITER $$

DROP PROCEDURE IF EXISTS _ensure_easyfix_withdrawal_storage$$
CREATE PROCEDURE _ensure_easyfix_withdrawal_storage()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'tbl_easyfixer_withdrawal_request'
       AND column_name = 'processed_by'
  ) THEN
    ALTER TABLE tbl_easyfixer_withdrawal_request
      ADD COLUMN processed_by INT NULL DEFAULT NULL AFTER processed_on;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'tbl_easyfixer_withdrawal_request'
       AND column_name = 'bank_details_id'
  ) THEN
    ALTER TABLE tbl_easyfixer_withdrawal_request
      ADD COLUMN bank_details_id INT NULL DEFAULT NULL AFTER remarks;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'tbl_easyfixer_withdrawal_request'
       AND column_name = 'bank_account_number'
  ) THEN
    ALTER TABLE tbl_easyfixer_withdrawal_request
      ADD COLUMN bank_account_number VARCHAR(32) NULL DEFAULT NULL AFTER bank_details_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'tbl_easyfixer_withdrawal_request'
       AND column_name = 'bank_ifsc'
  ) THEN
    ALTER TABLE tbl_easyfixer_withdrawal_request
      ADD COLUMN bank_ifsc VARCHAR(20) NULL DEFAULT NULL AFTER bank_account_number;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'tbl_easyfixer_withdrawal_request'
       AND column_name = 'bank_account_holder_name'
  ) THEN
    ALTER TABLE tbl_easyfixer_withdrawal_request
      ADD COLUMN bank_account_holder_name VARCHAR(255) NULL DEFAULT NULL AFTER bank_ifsc;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'tbl_easyfixer_withdrawal_request'
       AND column_name = 'bank_id'
  ) THEN
    ALTER TABLE tbl_easyfixer_withdrawal_request
      ADD COLUMN bank_id INT NULL DEFAULT NULL AFTER bank_account_holder_name;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'tbl_easyfixer_withdrawal_request'
       AND column_name = 'bank_name'
  ) THEN
    ALTER TABLE tbl_easyfixer_withdrawal_request
      ADD COLUMN bank_name VARCHAR(255) NULL DEFAULT NULL AFTER bank_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name = 'tbl_easyfixer_withdrawal_request'
       AND index_name = 'idx_efr_status'
  ) THEN
    ALTER TABLE tbl_easyfixer_withdrawal_request
      ADD INDEX idx_efr_status (fk_easyfixer_id, status);
  END IF;
END$$

DELIMITER ;

CALL _ensure_easyfix_withdrawal_storage();
DROP PROCEDURE _ensure_easyfix_withdrawal_storage;

-- Read-only post-apply verification.
SELECT column_name
  FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND table_name = 'tbl_easyfixer_withdrawal_request'
 ORDER BY ordinal_position;
