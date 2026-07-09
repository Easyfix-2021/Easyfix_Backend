-- Technician payout/withdrawal requests. A technician asks to withdraw their
-- wallet balance (tbl_easyfixer.current_balance) to the bank on file; THIS row
-- is the auditable "please pay me" record. EasyFix-owned; no legacy service
-- references it (allowed under the never-add-tables exception).
--
-- MVP model (finance-in-the-loop): the mobile endpoint only RECORDS the request
-- (status='requested'). The actual payout + the wallet debit are a downstream
-- FINANCE/OPS step performed when the payout is settled — which is why there is
-- no debit trigger here and `processed_on` / `remarks` are filled by finance.

CREATE TABLE tbl_easyfixer_withdrawal_request (
  request_id INT AUTO_INCREMENT PRIMARY KEY,
  fk_easyfixer_id INT NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'requested',
  requested_on DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_on DATETIME NULL DEFAULT NULL,
  remarks VARCHAR(255) NULL DEFAULT NULL,
  INDEX idx_efr (fk_easyfixer_id),
  INDEX idx_status (status)
);
