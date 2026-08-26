-- Domain-level idempotency for reward claims.
--
-- The shared mobile idempotency ledger remains the first replay layer. This
-- key is also copied onto the business row so a retry cannot debit points or
-- stock twice if the claim transaction commits but response persistence in the
-- shared ledger is lost. Existing claims remain valid with a NULL key.

SET @has_claim_idempotency_key = (
  SELECT COUNT(*)
    FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'reward_claims'
     AND column_name = 'idempotency_key'
);
SET @ddl_claim_idempotency_key = IF(
  @has_claim_idempotency_key = 0,
  'ALTER TABLE reward_claims ADD COLUMN idempotency_key VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL AFTER points_spent, ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);
PREPARE stmt_claim_idempotency_key FROM @ddl_claim_idempotency_key;
EXECUTE stmt_claim_idempotency_key;
DEALLOCATE PREPARE stmt_claim_idempotency_key;

SET @has_claim_idempotency_unique = (
  SELECT COUNT(*) FROM (
    SELECT index_name
      FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name = 'reward_claims'
     GROUP BY index_name
    HAVING GROUP_CONCAT(column_name ORDER BY seq_in_index) = 'easyfixer_id,idempotency_key'
  ) equivalent_index
);
SET @ddl_claim_idempotency_unique = IF(
  @has_claim_idempotency_unique = 0,
  'ALTER TABLE reward_claims ADD UNIQUE INDEX uq_reward_claim_idempotency (easyfixer_id, idempotency_key), ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);
PREPARE stmt_claim_idempotency_unique FROM @ddl_claim_idempotency_unique;
EXECUTE stmt_claim_idempotency_unique;
DEALLOCATE PREPARE stmt_claim_idempotency_unique;

-- Read-only post-apply verification.
SELECT column_name, column_type, collation_name, is_nullable
  FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND table_name = 'reward_claims'
   AND column_name = 'idempotency_key';

SELECT index_name, non_unique,
       GROUP_CONCAT(column_name ORDER BY seq_in_index) AS indexed_columns
  FROM information_schema.statistics
 WHERE table_schema = DATABASE()
   AND table_name = 'reward_claims'
 GROUP BY index_name, non_unique
HAVING indexed_columns = 'easyfixer_id,idempotency_key';
