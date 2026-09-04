/*
 * Transactional lifecycle/job-state guards for offer and assignment writes.
 * Fake pool only; no real DB or notifications.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const active = (id) => ({
  efr_id: id,
  efr_status: 1,
  is_technician_verified: 1,
  efr_manager_id: null,
  lifecycle_status: 'ACTIVE',
  lifecycle_reason_code: null,
  lifecycle_reason: null,
  lifecycle_version: 1,
});

const defaults = () => ({
  techRows: [active(42)],
  preloadedJob: { job_id: 100, job_status: 0, fk_easyfixter_id: null },
  lockedJob: { job_id: 100, job_status: 0, fk_easyfixter_id: null },
});
const scenario = defaults();

const fake = installFakePool([
  [/FROM information_schema\.columns/i, [{ column_count: 6, history_count: 1 }]],
  [/FROM tbl_easyfixer e\s+WHERE e\.efr_id IN/, () => scenario.techRows],
  [/SELECT job_id, job_status, fk_easyfixter_id/, (sql) => [
    /FOR UPDATE/i.test(sql) ? scenario.lockedJob : scenario.preloadedJob,
  ]],
  // applyUnassignLocked treats affectedRows !== 1 as lost-race drift, so the
  // release has to report a hit or the reassign test never reaches its guard.
  [/UPDATE tbl_job\s+SET fk_easyfixter_id = NULL/, { affectedRows: 1 }],
], { stopOn: /INSERT INTO (?:tbl_job_offer|scheduling_history)/ });

const jobService = require('../services/job.service');

beforeEach(() => {
  fake.reset();
  Object.assign(scenario, defaults());
});

const wrote = () => fake.calls.some((call) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(call.sql));

test('PAUSED technician is rejected with lifecycle reason before any job/offer write', async () => {
  scenario.techRows = [{
    ...active(42),
    efr_status: 0,
    lifecycle_status: 'PAUSED',
    lifecycle_reason_code: 'GRADE_BELOW_THRESHOLD',
    lifecycle_reason: 'Complete remediation before receiving jobs',
  }];

  await assert.rejects(
    () => jobService.offerToTechnicians(100, [42], { user_id: 9 }),
    (error) => error.status === 400
      && error.code === 'TECH_CANNOT_RECEIVE_JOBS'
      && error.details.technicians[0].status === 'PAUSED'
      && /Complete remediation/.test(error.message),
  );
  assert.equal(wrote(), false);
});

test('multi-tech offer locks sorted technicians then locks BOOKED/unowned job', async () => {
  scenario.techRows = [active(3), active(9)];
  await assert.rejects(
    () => jobService.offerToTechnicians(100, [9, 3, 9], { user_id: 9 }),
    (error) => error.__stop === true,
  );

  const techLock = fake.calls.find((call) => /FROM tbl_easyfixer e/.test(call.sql));
  assert.deepEqual(techLock.params[0], [3, 9]);
  assert.match(techLock.sql, /ORDER BY e\.efr_id ASC\s+FOR UPDATE/);

  const jobLock = fake.calls.find((call) => /FROM tbl_job\s+WHERE job_id = \?\s+FOR UPDATE/.test(call.sql));
  assert.ok(jobLock, 'job state must be revalidated under lock after technician locks');
});

test('assigned-job reassign releases the outgoing claim under lock before any re-offer', async () => {
  // A reassign is now an OFFER to the incoming technician (see
  // tests/job-reassign-reoffer.test.js), which offerToTechnicians will only
  // issue against a BOOKED, ownerless job. This file's stop-sentinel fires at
  // the release's own scheduling_history INSERT, so what it still pins is the
  // guard that matters here: the outgoing technician is removed while the job
  // row lock is held, and the job is never hard-assigned to the incoming one.
  scenario.preloadedJob = { job_id: 100, job_status: 1, fk_easyfixter_id: 99 };
  scenario.lockedJob = { ...scenario.preloadedJob };
  await assert.rejects(
    () => jobService.assign(100, {
      easyfixerId: 42,
      reasonId: 8,
      rescheduleReason: 'Ops reassignment',
    }, { user_id: 9 }),
    (error) => error.__stop === true,
  );

  const jobLock = fake.calls.find((call) => /FROM tbl_job\s+WHERE job_id = \?\s+FOR UPDATE/.test(call.sql));
  assert.ok(jobLock, 'the release must revalidate job state under lock');
  const release = fake.calls.find((call) => /UPDATE tbl_job\s+SET fk_easyfixter_id = NULL/.test(call.sql));
  assert.ok(release, 'the outgoing technician is released back to the pool');
  assert.match(release.sql, /job_status = 0/);
  assert.ok(
    !fake.calls.some((call) => /^\s*UPDATE tbl_job SET fk_easyfixter_id = \?/.test(call.sql)),
    'the incoming technician must not be hard-assigned — their accept schedules the job',
  );
});

test('direct assign rejects completed or cancelled jobs before assignment writes', async () => {
  scenario.preloadedJob = { job_id: 100, job_status: 6, fk_easyfixter_id: 99 };
  scenario.lockedJob = { ...scenario.preloadedJob };

  await assert.rejects(
    () => jobService.assign(100, { easyfixerId: 42 }, { user_id: 9 }),
    (error) => error.status === 409 && error.code === 'JOB_NOT_ASSIGNABLE',
  );
  assert.equal(wrote(), false);
});

test('direct assign rejects job state or ownership drift observed under lock', async () => {
  scenario.preloadedJob = { job_id: 100, job_status: 1, fk_easyfixter_id: 99 };
  scenario.lockedJob = { job_id: 100, job_status: 0, fk_easyfixter_id: null };

  await assert.rejects(
    () => jobService.assign(100, { easyfixerId: 42 }, { user_id: 9 }),
    (error) => error.status === 409 && error.code === 'JOB_ASSIGNMENT_CHANGED',
  );
  assert.equal(wrote(), false);
});

test('service enforces the same 50-recipient cap as the HTTP validator', async () => {
  const ids = Array.from({ length: 51 }, (_, index) => index + 1);
  await assert.rejects(
    () => jobService.offerToTechnicians(100, ids, { user_id: 9 }),
    (error) => error.status === 400 && error.code === 'TOO_MANY_OFFER_RECIPIENTS',
  );
  assert.equal(fake.calls.length, 0);
});

test('mobile open-offer reads fail closed on lifecycle, job state, latest row and TTL', async () => {
  assert.equal(await jobService.techHasOpenOffer(100, 42), false);
  const membership = fake.calls.find((call) => /SELECT 1 AS ok/.test(call.sql));
  assert.match(membership.sql, /lifecycle_status IN \('ACTIVE', 'UNDER_MASTER'\)/);
  assert.match(membership.sql, /MAX\(latest\.job_offer_id\)/);
  assert.match(membership.sql, /j\.job_status = 0/);
  assert.match(membership.sql, /j\.fk_easyfixter_id IS NULL/);
  assert.match(membership.sql, /offered_at >= NOW\(\) - INTERVAL 30 MINUTE/);

  fake.reset();
  assert.deepEqual(await jobService.listOfferedForTech(42), { items: [] });
  const list = fake.calls.find((call) => /FROM tbl_job_offer newer/.test(call.sql));
  assert.ok(list);
  assert.match(list.sql, /lifecycle_status IN \('ACTIVE', 'UNDER_MASTER'\)/);
  assert.match(list.sql, /j\.job_status = 0/);
  assert.match(list.sql, /newer\.job_offer_id > jo\.job_offer_id/);
  assert.doesNotMatch(list.sql, /GROUP BY job_id/, 'the capped read must not aggregate lifetime history');
  assert.match(list.sql, /offered_at >= NOW\(\) - INTERVAL 30 MINUTE/);
  assert.ok(!fake.calls.some((call) => /FROM tbl_job j[\s\S]*jobIds/.test(call.sql)),
    'ineligible/no-offer reads must not hydrate job previews');
});
