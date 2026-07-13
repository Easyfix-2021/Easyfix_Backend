/*
 * Characterization tests for job.service.assign in the LEGACY (offer-flow-OFF)
 * world — the direct-assign path that issues its own UPDATE tbl_job. We force the
 * legacy branch by making the tbl_job_offer existence probe throw, so
 * jobOfferTableExists() caches false for this file's process.
 *
 * Pins: the direct-assign UPDATE stamps fk_easyfixter_id + the actor, and the
 * schedule-&-assign variant projects the wall-clock requested_date_time as a
 * verbatim IST string (never a Date).
 *
 * Non-destructive: fake pool, STOP-sentinel at the first write, no real DB.
 * Runner: `node --test`.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const DEFAULTS = () => ({
  verifyRows: [{ efr_id: 42 }],
  jobMeta: { job_id: 100, job_status: 0, fk_easyfixter_id: null },
  techRow: { efr_id: 42, efr_status: 1 },
});
const scenario = DEFAULTS();

const fake = installFakePool(
  [
    [/INFORMATION_SCHEMA/i, [{ n: 0 }]],
    [/SHOW COLUMNS/i, []],
    [/efr_status FROM tbl_easyfixer WHERE efr_id = \?/, () => (scenario.techRow ? [scenario.techRow] : [])],
    [/SELECT job_id, job_status, fk_easyfixter_id/, () => (scenario.jobMeta ? [scenario.jobMeta] : [])],
    [/is_technician_verified = 1/, () => scenario.verifyRows],
    // Force the legacy path: the offer-table existence probe throws → caught →
    // jobOfferTableExists() = false → assign() uses its own UPDATE tbl_job.
    [/FROM tbl_job_offer LIMIT 1/, () => { throw new Error('tbl_job_offer absent (test)'); }],
  ],
  { stopOn: /UPDATE tbl_job SET fk_easyfixter_id/ },
);

const jobSvc = require('../services/job.service');

beforeEach(() => { fake.reset(); Object.assign(scenario, DEFAULTS()); });

test('direct assign stamps fk_easyfixter_id + the scheduling actor on tbl_job', async () => {
  await assert.rejects(() => jobSvc.assign(100, { easyfixerId: 42 }, { user_id: 9 }));
  const upd = fake.calls.find((c) => /UPDATE tbl_job SET fk_easyfixter_id/.test(c.sql));
  assert.ok(upd, 'a direct UPDATE tbl_job must be issued on the legacy path');
  assert.equal(upd.params[0], 42, 'assigns the technician');
  assert.equal(upd.params[upd.params.length - 1], 100, 'scoped to the job in the WHERE');
  assert.ok(upd.params.includes(9), 'stamps the scheduling actor (fk_scheduled_by / first_scheduled_by)');
});

test('schedule-&-assign projects requested_date_time as a verbatim IST string', async () => {
  await assert.rejects(
    () => jobSvc.assign(100, { easyfixerId: 42, requestedDateTime: '2026-08-01T10:30', timeSlot: '10-11' }, { user_id: 9 }),
  );
  const upd = fake.calls.find((c) => /UPDATE tbl_job SET fk_easyfixter_id/.test(c.sql));
  assert.ok(upd);
  assert.match(upd.sql, /requested_date_time\s*=\s*\?/, 'the schedule variant sets requested_date_time');
  assert.ok(
    upd.params.includes('2026-08-01 10:30:00'),
    'wall-clock time is projected verbatim (space-joined + :00), never new Date()',
  );
});
