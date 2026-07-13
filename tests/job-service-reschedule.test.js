/*
 * Characterization tests for job.service.reschedule — the CRM "Schedule & Assign
 * → Reschedule" path (appointment-only; never touches the technician). Pins the
 * 404/400 guards and that the write moves ONLY the schedule columns — NOT the
 * mobile extras columns (reschedule_reason_id / is_rescheduled_by_app), which
 * belong to the setStatus-extras path, not this one.
 *
 * Non-destructive: fake pool, STOP-sentinel at the first write, no real DB.
 * Runner: `node --test`.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const DEFAULTS = () => ({ existing: { job_id: 42, fk_easyfixter_id: null } });
const scenario = DEFAULTS();

const fake = installFakePool(
  [
    [/INFORMATION_SCHEMA/i, [{ n: 0 }]],
    [/SHOW COLUMNS/i, []],
    [/SELECT job_id, fk_easyfixter_id FROM tbl_job/, () => (scenario.existing ? [scenario.existing] : [])],
  ],
  { stopOn: /UPDATE tbl_job\b/ }, // \b excludes UPDATE tbl_job_offer
);

const jobSvc = require('../services/job.service');

beforeEach(() => { fake.reset(); Object.assign(scenario, DEFAULTS()); });

test('reschedule of a missing job is rejected 404', async () => {
  scenario.existing = null;
  await assert.rejects(
    () => jobSvc.reschedule(42, { requestedDateTime: '2026-07-20 14:30', reasonId: 3 }, { user_id: 9 }),
    (e) => e.status === 404,
  );
});

test('reschedule with a malformed date is rejected 400 before any write', async () => {
  await assert.rejects(
    () => jobSvc.reschedule(42, { requestedDateTime: 'not-a-date', reasonId: 3 }, { user_id: 9 }),
    (e) => e.status === 400,
  );
  assert.ok(!fake.calls.some((c) => /UPDATE|INSERT/i.test(c.sql)), 'a bad date must not reach a write');
});

test('reschedule moves ONLY the schedule columns, not the mobile extras columns', async () => {
  await assert.rejects(
    () => jobSvc.reschedule(42, { requestedDateTime: '2026-07-20 14:30', reasonId: 3, rescheduleReason: 'Customer busy', remarks: 'moved' }, { user_id: 9 }),
  );
  const upd = fake.calls.find((c) => /UPDATE tbl_job\b/.test(c.sql));
  assert.ok(upd, 'the schedule UPDATE must be issued');
  assert.match(upd.sql, /requested_date_time\s*=\s*\?/);
  assert.match(upd.sql, /time_slot\s*=\s*COALESCE/);
  assert.ok(upd.params.some((p) => String(p).startsWith('2026-07-20 14:30')), 'stamps the requested wall-clock time');
  // Negative characterization: this path is NOT the setStatus-extras reschedule.
  assert.doesNotMatch(upd.sql, /reschedule_reason_id/);
  assert.doesNotMatch(upd.sql, /is_rescheduled_by_app/);
});
