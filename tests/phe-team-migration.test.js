const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(
  __dirname,
  '..',
  'migrations',
  '2026-08-17-phe-team-read-indexes.sql',
), 'utf8');

test('PHE/team index migration is guarded and additive only', () => {
  assert.match(migration, /information_schema\.statistics/i);
  assert.match(migration, /idx_efr_manager_active/);
  assert.match(migration, /idx_efr_tx_credit_window/);
  assert.match(migration, /idx_efr_tx_job_credit/);
  assert.match(migration, /idx_job_tx_job/);
  assert.match(migration, /idx_job_offer_efr_response/);
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
  assert.equal(addCount, 7);
  assert.equal(prepareCount, addCount);
  assert.equal(deallocateCount, addCount);
});
