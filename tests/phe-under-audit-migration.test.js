const test = require('node:test');
const assert = require('node:assert/strict');
const { readMigration } = require('./helpers/migration-file');

const migration = readMigration('2026-08-20-phe-under-audit-read-index.sql');

test('Under Audit migration owns the full equality prefix before review-time ordering', () => {
  assert.match(
    migration,
    /\(fk_easyfixter_id, job_status, no_of_req_approval, no_of_req_foh, revisit_reason_id, app_checkout_date_time, job_id\)/,
  );
  assert.match(migration, /ALGORITHM=INPLACE, LOCK=NONE/);
  assert.match(migration, /information_schema\.statistics/i);
});
