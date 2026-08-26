const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/*
 * A migration lives in migrations/ while it is pending and moves to
 * migrations/executed/ once applied. This file pinned the PENDING path alone,
 * so it failed the day the migration shipped (commit "Moved Executed Files",
 * 2026-08-26) — exactly backwards, since an applied migration is the one whose
 * contents matter most. Resolved from both, matching
 * tests/rewards-referral-migration.test.js.
 */
const migrationPath = [
  path.join(__dirname, '..', 'migrations', '2026-08-17-phe-team-read-indexes.sql'),
  path.join(__dirname, '..', 'migrations', 'executed', '2026-08-17-phe-team-read-indexes.sql'),
].find((p) => fs.existsSync(p));
assert.ok(migrationPath, '2026-08-17-phe-team-read-indexes.sql not found in migrations/ or migrations/executed/');
const migration = fs.readFileSync(migrationPath, 'utf8');

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
