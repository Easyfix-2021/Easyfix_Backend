-- Durable lease + bounded retention for the existing mobile idempotency ledger.
--
-- DEPLOY BEFORE the backend code that references these columns. The table is
-- EasyFix-owned, InnoDB, and tiny (13 rows in the 2026-08-11 baseline). Every
-- DDL branch is INFORMATION_SCHEMA-guarded so QA/prod retries are safe.
--
-- lease_token / lease_expires_at: identify one process as the current owner and
-- let one retry reclaim a crashed owner's row after five minutes.
-- expires_at: fourteen-day replay-cache retention. The app's pending intents do
-- not expire: state-replacement mutations remain naturally safe after ledger
-- expiry, training is monotonic, and keyed multipart uploads use a deterministic
-- actor+endpoint+key+digest object name so a late replay cannot orphan a second
-- object. A bounded hidden cron deletes expired ledger rows.

SET @has_lease_token = (
  SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'tbl_idempotency_key'
     AND COLUMN_NAME = 'lease_token'
);
SET @ddl_lease_token = IF(
  @has_lease_token = 0,
  'ALTER TABLE tbl_idempotency_key ADD COLUMN lease_token CHAR(36) NULL AFTER state, ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);
PREPARE stmt_lease_token FROM @ddl_lease_token;
EXECUTE stmt_lease_token;
DEALLOCATE PREPARE stmt_lease_token;

SET @has_lease_expiry = (
  SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'tbl_idempotency_key'
     AND COLUMN_NAME = 'lease_expires_at'
);
SET @ddl_lease_expiry = IF(
  @has_lease_expiry = 0,
  'ALTER TABLE tbl_idempotency_key ADD COLUMN lease_expires_at DATETIME NULL AFTER lease_token, ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);
PREPARE stmt_lease_expiry FROM @ddl_lease_expiry;
EXECUTE stmt_lease_expiry;
DEALLOCATE PREPARE stmt_lease_expiry;

SET @has_retention_expiry = (
  SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'tbl_idempotency_key'
     AND COLUMN_NAME = 'expires_at'
);
SET @ddl_retention_expiry = IF(
  @has_retention_expiry = 0,
  'ALTER TABLE tbl_idempotency_key ADD COLUMN expires_at DATETIME NULL AFTER completed_at, ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);
PREPARE stmt_retention_expiry FROM @ddl_retention_expiry;
EXECUTE stmt_retention_expiry;
DEALLOCATE PREPARE stmt_retention_expiry;

-- DEPLOYMENT SAFETY: drain/stop old backend instances before this backfill and
-- do not run old code after it. Old code cannot renew owner leases. The ten-
-- minute grace below also protects an already-running pre-deploy request from
-- immediate takeover if a drain check missed it; new code renews live leases
-- every minute. Completed rows remain replayable through the retention window.
UPDATE tbl_idempotency_key
   SET lease_token = NULL,
       lease_expires_at = CASE
         WHEN state = 'in_flight' THEN DATE_ADD(NOW(), INTERVAL 10 MINUTE)
         ELSE NULL
       END,
       expires_at = DATE_ADD(COALESCE(completed_at, created_at, NOW()), INTERVAL 14 DAY)
 WHERE expires_at IS NULL;

SET @has_expiry_index = (
  SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'tbl_idempotency_key'
     AND INDEX_NAME = 'idx_idempotency_expires_at'
);
SET @ddl_expiry_index = IF(
  @has_expiry_index = 0,
  'ALTER TABLE tbl_idempotency_key ADD INDEX idx_idempotency_expires_at (expires_at), ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);
PREPARE stmt_expiry_index FROM @ddl_expiry_index;
EXECUTE stmt_expiry_index;
DEALLOCATE PREPARE stmt_expiry_index;

-- Verification (read-only):
-- SHOW COLUMNS FROM tbl_idempotency_key LIKE '%expires%';
-- SHOW INDEX FROM tbl_idempotency_key WHERE Key_name = 'idx_idempotency_expires_at';
