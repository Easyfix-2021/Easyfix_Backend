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

// `time_slot` is read by reschedule so the slot re-derive can stay in the job's
// OWN vocabulary (1-hour frame vs. legacy band) — see rederiveTimeSlot.
const DEFAULTS = () => ({ existing: { job_id: 42, fk_easyfixter_id: null, time_slot: null } });
const scenario = DEFAULTS();

const fake = installFakePool(
  [
    [/INFORMATION_SCHEMA/i, [{ n: 0 }]],
    [/SHOW COLUMNS/i, []],
    [/SELECT job_id, fk_easyfixter_id, time_slot FROM tbl_job/, () => (scenario.existing ? [scenario.existing] : [])],
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

/*
 * The slot re-derive must stay in the job's OWN vocabulary.
 *
 * reschedule() used to re-derive time_slot with the legacy 4-band
 * deriveTimeSlot() unconditionally, and the write is `COALESCE(?, time_slot)`
 * — a guard that only fires when the derive returns null, i.e. never once the
 * date has parsed. So every reschedule OVERWROTE a customer-confirmed 1-hour
 * frame with a 5-hour band, breaking both the WhatsApp label round-trip
 * (slotByLabelOrStart) and candidate-ranking's `AND time_slot = ?` conflict
 * probe. 14:30 is deliberately inside BOTH vocabularies' afternoon range so the
 * two cases below differ only by the job's existing value.
 */
async function reschedTo(dt) {
  await assert.rejects(
    () => jobSvc.reschedule(42, { requestedDateTime: dt, reasonId: 3 }, { user_id: 9 }),
  );
  const upd = fake.calls.find((c) => /UPDATE tbl_job\b/.test(c.sql));
  assert.ok(upd, 'the schedule UPDATE must be issued');
  // Param order mirrors the SET list: requested_date_time, requested_time, time_slot, …
  return upd.params[2];
}

test('a 1-hour slot is re-derived as a 1-HOUR slot, never a legacy band', async () => {
  scenario.existing.time_slot = '3 PM–4 PM';
  assert.equal(await reschedTo('2026-07-20 14:30'), '2 PM–3 PM');
});

test('an absent slot re-derives into the CURRENT 1-hour vocabulary', async () => {
  scenario.existing.time_slot = null;
  assert.equal(await reschedTo('2026-07-20 14:30'), '2 PM–3 PM');
});

test('a job still holding a LEGACY band keeps the legacy vocabulary', async () => {
  scenario.existing.time_slot = 'Morning 9 to 2';
  assert.equal(await reschedTo('2026-07-20 14:30'), 'Evening 2 to 7');
});

test('out-of-window hours land on After Hours in the 1-hour vocabulary', async () => {
  scenario.existing.time_slot = '3 PM–4 PM';
  assert.equal(await reschedTo('2026-07-20 21:00'), 'After Hours');
});
