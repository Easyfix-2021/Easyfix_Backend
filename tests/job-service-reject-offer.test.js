/*
 * Transactional rejectOffer regressions.
 *
 * These tests use a fake mysql2 pool and assert the observable lock/write
 * contract. No production DB, webhook, or notification provider is touched.
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');
const { OFFER_STATUS } = require('../services/offer-status');

const scenario = {
  lockedJob: null,
  latestOffer: null,
  rejectAffectedRows: 1,
  unassignAffectedRows: 1,
  offerFlowEnabled: true,
  techRow: null,
};

const fake = installFakePool([
  [/SELECT property_key, property_value FROM easyfix_properties/i, () => (
    scenario.offerFlowEnabled
      ? []
      : [{ property_key: 'job.offer.flow.enabled', property_value: 'false' }]
  )],
  [/SELECT 1 FROM tbl_job_offer LIMIT 1/i, [{ ok: 1 }]],
  [/FROM tbl_easyfixer e[\s\S]*WHERE e\.efr_id = \?[\s\S]*FOR UPDATE/i,
    () => (scenario.techRow ? [scenario.techRow] : [])],
  [/SELECT job_id, job_status, fk_easyfixter_id[\s\S]*FROM tbl_job[\s\S]*FOR UPDATE/i,
    () => (scenario.lockedJob ? [scenario.lockedJob] : [])],
  [/SELECT job_offer_id, offer_status[\s\S]*FROM tbl_job_offer[\s\S]*ORDER BY job_offer_id DESC[\s\S]*FOR UPDATE/i,
    () => (scenario.latestOffer ? [scenario.latestOffer] : [])],
  [/UPDATE tbl_job_offer[\s\S]*WHERE job_offer_id = \?[\s\S]*offer_status = 0/i,
    () => ({ affectedRows: scenario.rejectAffectedRows })],
  [/UPDATE tbl_job[\s\S]*SET fk_easyfixter_id = NULL/i,
    () => ({ affectedRows: scenario.unassignAffectedRows })],
  [/INSERT INTO scheduling_history/i, { affectedRows: 1 }],
  [/UPDATE tbl_job_offer[\s\S]*SELECT MAX\(job_offer_id\)/i, { affectedRows: 0 }],
], { stopOn: /SELECT\s+j\.\*/i });

const jobService = require('../services/job.service');
const propertiesService = require('../services/properties.service');

after(() => fake.restore());
beforeEach(async () => {
  fake.reset();
  scenario.lockedJob = { job_id: 100, job_status: 0, fk_easyfixter_id: null };
  scenario.latestOffer = {
    job_offer_id: 901,
    offer_status: OFFER_STATUS.OFFERED,
  };
  scenario.rejectAffectedRows = 1;
  scenario.unassignAffectedRows = 1;
  scenario.offerFlowEnabled = true;
  scenario.techRow = {
    efr_id: 42,
    efr_status: 1,
    is_technician_verified: 1,
    efr_manager_id: null,
    scheduled_reactivation_date: null,
  };
  await propertiesService.flushCache();
  fake.reset();
});

async function rejectToCompletion() {
  return jobService.rejectOffer(100, 42, { reason: 'Already booked', reasonId: 7 });
}

function callIndex(pattern) {
  return fake.calls.findIndex((call) => pattern.test(call.sql));
}

test('locks technician, then job, then latest offer and rejects exactly that row', async () => {
  const result = await rejectToCompletion();
  assert.deepEqual(result, { rejected: true, jobId: 100, legacyUnassigned: false });

  const techLock = callIndex(/FROM tbl_easyfixer e[\s\S]*FOR UPDATE/i);
  const jobLock = callIndex(/SELECT job_id, job_status, fk_easyfixter_id[\s\S]*FROM tbl_job[\s\S]*FOR UPDATE/i);
  const offerLock = callIndex(/SELECT job_offer_id, offer_status[\s\S]*ORDER BY job_offer_id DESC[\s\S]*FOR UPDATE/i);
  const rejectWrite = callIndex(/UPDATE tbl_job_offer[\s\S]*WHERE job_offer_id = \?/i);
  assert.ok(techLock >= 0 && jobLock > techLock && offerLock > jobLock && rejectWrite > offerLock,
    'global lock order must be technician -> job -> latest offer -> decision write');

  const latest = fake.calls[offerLock];
  assert.deepEqual(latest.params, [100, 42]);
  assert.match(latest.sql, /ORDER BY job_offer_id DESC\s+LIMIT 1\s+FOR UPDATE/i);

  const rejected = fake.calls[rejectWrite];
  assert.deepEqual(rejected.params, ['Already booked', 7, 901, 30]);
  assert.match(rejected.sql, /WHERE job_offer_id = \?/i);
  assert.match(rejected.sql, new RegExp(`offer_status = ${OFFER_STATUS.OFFERED}\\b`));
  assert.doesNotMatch(rejected.sql, /WHERE job_id = \?/i,
    'a decision must never reject every historical row for the job');
  assert.ok(!fake.calls.some((call) => /UPDATE tbl_job[\s\S]*fk_easyfixter_id = NULL/i.test(call.sql)),
    'pool-offer rejection leaves the job unassigned for other candidates');
});

for (const status of [OFFER_STATUS.REJECTED, OFFER_STATUS.EXPIRED]) {
  test(`latest ${status === OFFER_STATUS.REJECTED ? 'REJECTED' : 'EXPIRED'} offer returns 409`, async () => {
    scenario.latestOffer = { job_offer_id: 901, offer_status: status };
    // Mirrors the conditional UPDATE: a non-OFFERED latest row affects zero.
    scenario.rejectAffectedRows = 0;

    await assert.rejects(
      () => jobService.rejectOffer(100, 42, { reason: 'Too late', reasonId: 7 }),
      (error) => error.status === 409 && /no longer available/i.test(error.message),
    );
    assert.ok(!fake.calls.some((call) => /UPDATE tbl_job[\s\S]*fk_easyfixter_id = NULL/i.test(call.sql)));
    assert.ok(!fake.calls.some((call) => /INSERT INTO scheduling_history/i.test(call.sql)));
  });
}

test('concurrent accept winner returns 409 and never unassigns the accepted job', async () => {
  // The accept transaction committed before reject acquired the job lock.
  scenario.lockedJob = { job_id: 100, job_status: 1, fk_easyfixter_id: 77 };

  await assert.rejects(
    () => jobService.rejectOffer(100, 42, { reason: 'No longer wanted', reasonId: 7 }),
    (error) => error.status === 409 && /no longer available/i.test(error.message),
  );
  assert.ok(!fake.calls.some((call) => /^\s*UPDATE tbl_job\b/i.test(call.sql)),
    'reject must not clear or overwrite the concurrent accept winner');
  assert.ok(!fake.calls.some((call) => /UPDATE tbl_job_offer[\s\S]*WHERE job_offer_id = \?/i.test(call.sql)),
    'the already-lost offer receives no false rejection decision');
  assert.ok(!fake.calls.some((call) => /INSERT INTO scheduling_history/i.test(call.sql)));
});

test('legacy direct assignment without an offer row still unassigns transactionally', async () => {
  scenario.lockedJob = { job_id: 100, job_status: 1, fk_easyfixter_id: 42 };
  scenario.latestOffer = null;
  const result = await rejectToCompletion();
  assert.deepEqual(result, { rejected: true, jobId: 100, legacyUnassigned: true });

  const unassign = fake.calls.find((call) => /UPDATE tbl_job[\s\S]*SET fk_easyfixter_id = NULL/i.test(call.sql));
  assert.ok(unassign);
  assert.deepEqual(unassign.params.slice(1), [100, 42]);
  assert.match(unassign.sql, /WHERE job_id = \? AND fk_easyfixter_id = \?/i);

  const history = fake.calls.find((call) => /INSERT INTO scheduling_history/i.test(call.sql));
  assert.ok(history, 'legacy unassign keeps the existing scheduling audit');
  assert.equal(history.params[0], 100);
  assert.equal(history.params[1], 42);
  assert.equal(history.params[3], 'Already booked');
});

for (const status of [2, 3, 5, 6, 7, 9, 10, 15, 20, 21]) {
  test(`legacy fallback never rewinds non-pre-start job status ${status}`, async () => {
    scenario.lockedJob = { job_id: 100, job_status: status, fk_easyfixter_id: 42 };
    scenario.latestOffer = null;

    await assert.rejects(
      () => rejectToCompletion(),
      (error) => error.status === 409 && error.code === 'JOB_NOT_REJECTABLE',
    );
    assert.ok(!fake.calls.some((call) => /^\s*UPDATE tbl_job\b/i.test(call.sql)));
    assert.ok(!fake.calls.some((call) => /INSERT INTO scheduling_history/i.test(call.sql)));
  });
}

test('feature-off direct assignment ignores rejected historical offer rows', async () => {
  scenario.offerFlowEnabled = false;
  await propertiesService.flushCache();
  fake.reset();
  scenario.lockedJob = { job_id: 100, job_status: 1, fk_easyfixter_id: 42 };
  scenario.latestOffer = { job_offer_id: 800, offer_status: OFFER_STATUS.REJECTED };

  const result = await rejectToCompletion();
  assert.deepEqual(result, { rejected: true, jobId: 100, legacyUnassigned: true });
  assert.ok(fake.calls.some((call) => /UPDATE tbl_job[\s\S]*fk_easyfixter_id = NULL/i.test(call.sql)));
});

test('active offer mode direct assignment ignores expired historical rows', async () => {
  scenario.lockedJob = { job_id: 100, job_status: 1, fk_easyfixter_id: 42 };
  scenario.latestOffer = { job_offer_id: 800, offer_status: OFFER_STATUS.EXPIRED };

  const result = await rejectToCompletion();
  assert.deepEqual(result, { rejected: true, jobId: 100, legacyUnassigned: true });
  assert.ok(fake.calls.some((call) => /UPDATE tbl_job[\s\S]*fk_easyfixter_id = NULL/i.test(call.sql)));
});

test('feature-off direct assignment can close an old OPEN row while unassigning', async () => {
  scenario.offerFlowEnabled = false;
  await propertiesService.flushCache();
  fake.reset();
  scenario.lockedJob = { job_id: 100, job_status: 1, fk_easyfixter_id: 42 };
  scenario.latestOffer = { job_offer_id: 801, offer_status: OFFER_STATUS.OFFERED };

  const result = await rejectToCompletion();
  assert.deepEqual(result, { rejected: true, jobId: 100, legacyUnassigned: true });
  assert.ok(fake.calls.some((call) => /SELECT MAX\(job_offer_id\)/i.test(call.sql)));
});

test('feature-off propagation never overwrites a concurrent accepted offer', async () => {
  scenario.offerFlowEnabled = false;
  await propertiesService.flushCache();
  fake.reset();
  scenario.lockedJob = { job_id: 100, job_status: 1, fk_easyfixter_id: 42 };
  scenario.latestOffer = { job_offer_id: 901, offer_status: OFFER_STATUS.ACCEPTED };

  await assert.rejects(
    () => rejectToCompletion(),
    (error) => error.status === 409 && /no longer available/i.test(error.message),
  );
  assert.ok(!fake.calls.some((call) => /^\s*UPDATE tbl_job\b/i.test(call.sql)));
});

test('service revalidates lifecycle capability from the locked technician row', async () => {
  scenario.techRow = {
    efr_id: 42,
    efr_status: 0,
    is_technician_verified: 1,
    efr_manager_id: null,
    scheduled_reactivation_date: null,
  };

  await assert.rejects(
    () => rejectToCompletion(),
    (error) => error.status === 403
      && error.code === 'TECH_LIFECYCLE_CAPABILITY_REQUIRED'
      && /INACTIVE/.test(error.message),
  );
  assert.ok(!fake.calls.some((call) => /FROM tbl_job[\s\S]*FOR UPDATE/i.test(call.sql)));
  assert.ok(!fake.calls.some((call) => /^\s*UPDATE\b/i.test(call.sql)));
});
