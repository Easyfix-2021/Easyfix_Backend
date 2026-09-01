const test = require('node:test');
const assert = require('node:assert/strict');
const { readMigration } = require('./helpers/migration-file');

// Resolved from migrations/ or migrations/executed/ — see the helper for why.
const migration = readMigration('2026-08-17-phe-team-read-indexes.sql');

test('PHE/team index migration is guarded and additive only', () => {
  assert.match(migration, /information_schema\.statistics/i);
  assert.match(migration, /idx_efr_manager_active/);
  assert.match(migration, /idx_efr_tx_credit_window/);
  assert.match(migration, /idx_efr_tx_job_credit/);
  assert.match(migration, /idx_job_tx_job/);
  assert.match(migration, /idx_job_offer_efr_response/);
  assert.match(migration, /idx_job_offer_efr_offered/);
  assert.match(migration, /\(fk_easyfixter_id, offered_at, job_id, offer_status\)/,
    'PHE offer month reads need an equality-then-range index prefix');
  assert.match(migration, /LIKE 'fk_easyfixter_id,offered_at,%'/,
    'an existing equivalent left prefix must prevent a redundant index');
  assert.match(migration, /idx_job_efr_status_checkout/);
  assert.match(migration, /idx_efr_withdrawal_history/);
  assert.doesNotMatch(migration, /\bDROP\b/i);
  assert.doesNotMatch(migration, /\bDELETE\b/i);
  assert.doesNotMatch(migration, /\bUPDATE\b/i);
});

test('each additive index DDL is selected through an idempotent prepared guard', () => {
  const addCount = (migration.match(/ADD INDEX/g) || []).length;
  const prepareCount = (migration.match(/^PREPARE stmt_/gm) || []).length;
  const deallocateCount = (migration.match(/DEALLOCATE PREPARE/g) || []).length;
  assert.equal(addCount, 8);
  assert.equal(prepareCount, addCount);
  assert.equal(deallocateCount, addCount);
});
