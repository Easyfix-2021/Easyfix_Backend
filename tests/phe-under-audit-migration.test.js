const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '2026-08-20-phe-under-audit-read-index.sql'),
  'utf8',
);

test('Under Audit migration owns the full equality prefix before review-time ordering', () => {
  assert.match(
    migration,
    /\(fk_easyfixter_id, job_status, no_of_req_approval, no_of_req_foh, revisit_reason_id, app_checkout_date_time, job_id\)/,
  );
  assert.match(migration, /ALGORITHM=INPLACE, LOCK=NONE/);
  assert.match(migration, /information_schema\.statistics/i);
});
