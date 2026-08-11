/* Legacy (no tbl_job_offer) accept fallback ownership + affected-row guard. */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const scenario = { affectedRows: 0 };
const fake = installFakePool([
  [/FROM information_schema\.columns/i, [{ column_count: 0, history_count: 0 }]],
  [/FROM tbl_job_offer LIMIT 1/, () => { throw new Error('offer table absent'); }],
  [/FROM tbl_easyfixer e\s+WHERE e\.efr_id IN/, [{
    efr_id: 42,
    efr_status: 1,
    is_technician_verified: 1,
    efr_manager_id: null,
  }]],
  [/UPDATE tbl_job[\s\S]*fk_easyfixter_id = \?/, () => ({ affectedRows: scenario.affectedRows })],
]);

const jobService = require('../services/job.service');

beforeEach(() => {
  fake.reset();
  scenario.affectedRows = 0;
});

test('legacy accept is scoped to the accepting owner and 409s when no row changes', async () => {
  await assert.rejects(
    () => jobService.acceptOffer(100, 42),
    (error) => error.status === 409 && /no longer available/i.test(error.message),
  );
  const claim = fake.calls.find((call) => /^\s*UPDATE tbl_job/.test(call.sql));
  assert.match(claim.sql, /fk_easyfixter_id = \?/);
  assert.deepEqual(claim.params, [100, 42]);
});

test('legacy accept returns a compact acknowledgement without post-commit hydration', async () => {
  scenario.affectedRows = 1;
  const result = await jobService.acceptOffer(100, 42);
  assert.deepEqual(result, { accepted: true, jobId: 100 });
  assert.ok(
    !fake.calls.some((call) => /SELECT[\s\S]*FROM tbl_job j[\s\S]*WHERE j\.job_id = \?/i.test(call.sql)),
    'a committed legacy accept must not issue full job-detail queries',
  );
});
