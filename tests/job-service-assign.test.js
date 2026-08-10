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

/*
 * assignBody / offerBody both accept a DATE-ONLY requestedDateTime
 * (validators/job.validator.js: /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}...)?$/).
 * That becomes '<date> 00:00:00' — the midnight sentinel — and
 * resolveTimeSlot(null, '<date> 00:00:00') returns 'After Hours'. Writing that
 * would replace a perfectly good stored '9AM to 12PM' with 'After Hours' as a
 * side effect of a date-only schedule edit. reschedule() never had the bug
 * (it passes the job's existing slot as the fallback); assign/offer now simply
 * write nothing when there is no hour and no caller-supplied label.
 *
 * Not reachable from the current CRM UI, but reachable from any direct API caller.
 */
test('a DATE-ONLY schedule edit never stamps "After Hours" over a stored band', async () => {
  await assert.rejects(
    () => jobSvc.assign(100, { easyfixerId: 42, requestedDateTime: '2026-08-05' }, { user_id: 9 }),
  );
  const upd = fake.calls.find((c) => /UPDATE tbl_job SET fk_easyfixter_id/.test(c.sql));
  assert.ok(upd);
  assert.doesNotMatch(upd.sql, /time_slot\s*=\s*\?/, 'time_slot is left untouched — nothing to derive a band from');
  assert.ok(!upd.params.includes('After Hours'), 'the midnight sentinel must not masquerade as a real appointment time');
  // requested_time carries the same guard, and always did.
  assert.doesNotMatch(upd.sql, /requested_time\s*=\s*\?/, 'a date-only edit must not blank a good requested_time');
});

test('a date-only edit that DOES carry a slot label still stores the label, canonicalised', async () => {
  await assert.rejects(
    () => jobSvc.assign(100, { easyfixerId: 42, requestedDateTime: '2026-08-05', timeSlot: '9AM to 12PM' }, { user_id: 9 }),
  );
  const upd = fake.calls.find((c) => /UPDATE tbl_job SET fk_easyfixter_id/.test(c.sql));
  assert.ok(upd);
  assert.match(upd.sql, /time_slot\s*=\s*\?/);
  assert.ok(upd.params.includes('9AM to 12PM'), 'the caller supplied the only evidence of a window, so it is kept');
});

test('a schedule edit WITH a real time-of-day derives the band from the appointment, not the label', async () => {
  await assert.rejects(
    () => jobSvc.assign(100, { easyfixerId: 42, requestedDateTime: '2026-08-05T16:00', timeSlot: '9AM to 12PM' }, { user_id: 9 }),
  );
  const upd = fake.calls.find((c) => /UPDATE tbl_job SET fk_easyfixter_id/.test(c.sql));
  assert.ok(upd);
  assert.ok(upd.params.includes('3PM to 7PM'), 'the appointment instant wins over a contradicting label');
  assert.ok(upd.params.includes('16:00'), 'requested_time = the 1-hour frame START');
});
