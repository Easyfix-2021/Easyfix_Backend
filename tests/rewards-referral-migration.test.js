const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/*
 * A migration lives in migrations/ while it is pending and moves to
 * migrations/executed/ once applied. Pinning either location alone makes the
 * test fail the day the migration ships — which is exactly backwards, since
 * an applied migration is the one whose contents matter most. Resolve from
 * both, and fail loudly if it has genuinely gone missing.
 */
function migrationPath(filename) {
  const candidates = [
    path.join(__dirname, '..', 'migrations', filename),
    path.join(__dirname, '..', 'migrations', 'executed', filename),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  assert.ok(found, `migration ${filename} not found in migrations/ or migrations/executed/`);
  return found;
}

const indexMigrationPath = migrationPath('2026-08-14-referral-profile-qualification-indexes.sql');
const menuMigrationPath = migrationPath('2026-08-14-reward-referrals-menu.sql');

test('referral migration adds one idempotent read-only CRM leaf and Admin grant', () => {
  const sql = fs.readFileSync(menuMigrationPath, 'utf8');
  assert.match(sql, /'Referral Qualifications'.*'rewardReferrals'/s);
  assert.match(sql, /NOT EXISTS\s*\([\s\S]*c\.url = 'rewardReferrals'/);
  assert.match(sql, /'isRewardReferralsView'/);
  assert.match(sql, /role_id = 2/);
  assert.match(sql, /FIND_IN_SET\(m\.menu_id, r\.menu_ids\)/);
  assert.match(sql, /Admin referral view grant/);
  assert.doesNotMatch(
    sql,
    /Manage Reward Referral|isRewardReferralsManage/,
    'the referral audit page must not gain a write permission',
  );
});

test('referral migration guards equivalent indexes instead of adding duplicates', () => {
  const sql = fs.readFileSync(indexMigrationPath, 'utf8');
  for (const columns of [
    'qualified_at,id,referred_efr_id,referrer_efr_id',
    'code,id',
    'referrer_efr_id,joined_at,id',
  ]) {
    assert.match(sql, new RegExp(columns));
  }
  assert.match(sql, /information_schema\.statistics/);
  assert.match(sql, /ALGORITHM=INPLACE, LOCK=NONE/g);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS reward_reconciliation_state/);
  assert.match(sql, /PRIMARY KEY \(task_name\)/);
  assert.match(sql, /'profile_qualification', 0, NOW\(\)/);
});
