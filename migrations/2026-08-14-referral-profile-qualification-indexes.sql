-- Referral qualification now converges when the referred technician completes
-- Skills, Identity and Work Area. These indexes keep the capped reconciliation,
-- CRM keyset list, and technician summary bounded as reward_referrals grows.
--
-- Apply after 2026-08-13-rewards-foundation.sql. Every ALTER is guarded by an
-- equivalent left-prefix check, so this migration is safe to re-run and does
-- not create a redundant differently-named index.

SET @has_referral_reconcile_index = (
  SELECT COUNT(*) FROM (
    SELECT index_name
      FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'reward_referrals'
     GROUP BY index_name
    HAVING GROUP_CONCAT(column_name ORDER BY seq_in_index)
             IN ('qualified_at,id,referred_efr_id,referrer_efr_id')
        OR GROUP_CONCAT(column_name ORDER BY seq_in_index)
             LIKE 'qualified_at,id,referred_efr_id,referrer_efr_id,%'
  ) equivalent_index
);
SET @ddl_referral_reconcile_index = IF(
  @has_referral_reconcile_index = 0,
  'ALTER TABLE reward_referrals ADD INDEX idx_referral_reconcile (qualified_at, id, referred_efr_id, referrer_efr_id), ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);
PREPARE stmt_referral_reconcile_index FROM @ddl_referral_reconcile_index;
EXECUTE stmt_referral_reconcile_index;
DEALLOCATE PREPARE stmt_referral_reconcile_index;

SET @has_referral_code_cursor_index = (
  SELECT COUNT(*) FROM (
    SELECT index_name
      FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'reward_referrals'
     GROUP BY index_name
    HAVING GROUP_CONCAT(column_name ORDER BY seq_in_index) IN ('code,id')
        OR GROUP_CONCAT(column_name ORDER BY seq_in_index) LIKE 'code,id,%'
  ) equivalent_index
);
SET @ddl_referral_code_cursor_index = IF(
  @has_referral_code_cursor_index = 0,
  'ALTER TABLE reward_referrals ADD INDEX idx_referral_code_cursor (code, id), ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);
PREPARE stmt_referral_code_cursor_index FROM @ddl_referral_code_cursor_index;
EXECUTE stmt_referral_code_cursor_index;
DEALLOCATE PREPARE stmt_referral_code_cursor_index;

SET @has_referrer_joined_index = (
  SELECT COUNT(*) FROM (
    SELECT index_name
      FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'reward_referrals'
     GROUP BY index_name
    HAVING GROUP_CONCAT(column_name ORDER BY seq_in_index)
             IN ('referrer_efr_id,joined_at,id')
        OR GROUP_CONCAT(column_name ORDER BY seq_in_index)
             LIKE 'referrer_efr_id,joined_at,id,%'
  ) equivalent_index
);
SET @ddl_referrer_joined_index = IF(
  @has_referrer_joined_index = 0,
  'ALTER TABLE reward_referrals ADD INDEX idx_referral_referrer_joined (referrer_efr_id, joined_at, id), ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);
PREPARE stmt_referrer_joined_index FROM @ddl_referrer_joined_index;
EXECUTE stmt_referrer_joined_index;
DEALLOCATE PREPARE stmt_referrer_joined_index;

-- A singleton cursor lets every capped run continue where the prior run
-- stopped. It is operational state, not an ops setting, so it deliberately
-- stays out of easyfix_properties and its one-hour configuration cache.
CREATE TABLE IF NOT EXISTS reward_reconciliation_state (
  task_name VARCHAR(64) NOT NULL,
  last_referral_id INT NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (task_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO reward_reconciliation_state (task_name, last_referral_id, updated_at)
SELECT 'profile_qualification', 0, NOW()
WHERE NOT EXISTS (
  SELECT 1
    FROM reward_reconciliation_state
   WHERE task_name = 'profile_qualification'
);

-- Read-only post-apply verification.
SELECT index_name,
       GROUP_CONCAT(column_name ORDER BY seq_in_index) AS indexed_columns
  FROM information_schema.statistics
 WHERE table_schema = DATABASE()
   AND table_name = 'reward_referrals'
 GROUP BY index_name
 ORDER BY index_name;

SELECT task_name, last_referral_id, updated_at
  FROM reward_reconciliation_state
 WHERE task_name = 'profile_qualification';
