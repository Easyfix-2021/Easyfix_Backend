/*
 * THE BACKWARD-COMPATIBILITY CONTRACT for tbl_job.time_slot, pinned at the one
 * place that can break it: job.service.update() — the PATCH the CRM's Edit and
 * Confirm & Schedule modals both go through.
 *
 * The contract, stated in two places already:
 *   src/lib/job-slots.ts  "A job holding 'Morning 9 to 2' must still DISPLAY
 *                          'Morning 9 to 2' when opened, and an untouched
 *                          open-and-save must persist it unchanged."
 *   JobModal.tsx          the load-time slot heal deliberately leaves a
 *                          non-empty slot alone "so an untouched open-and-save
 *                          is a no-op on time_slot".
 *
 * Why this needs a test: JobModal sends BOTH `requested_date_time` and
 * `time_slot` on EVERY non-outcome PATCH — `setIf` only skips empty values, and
 * on a real job neither is empty. So "the operator changed nothing" and "the
 * operator retyped the same values" are indistinguishable at the wire, and a
 * writer-side re-derive that fires on presence alone silently rewrites history:
 * 'Morning 9 to 2' at 10:00 came back as '9AM to 12PM', narrowing a 5-hour
 * promise to a 3-hour one with no operator action. update() therefore compares
 * against what is STORED and re-derives only on a real change.
 *
 * Non-destructive: fake pool, STOP-sentinel at the UPDATE, no real DB.
 * Runner: `node --test`.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

// The stored job. 'Morning 9 to 2' is the single most common live value
// (79,364 rows) and is NOT one of the four canonical bands — exactly the shape
// that must survive.
const STORED = () => ({
  job_id: 100,
  job_status: 9,
  time_slot: 'Morning 9 to 2',
  requested_date_time: '2026-08-05 10:00:00',
  fk_client_id: 30,
});
const scenario = { job: STORED() };

const fake = installFakePool(
  [
    [/INFORMATION_SCHEMA/i, [{ n: 0 }]],
    [/SHOW COLUMNS/i, []],
    [/SELECT j\.\*/, () => [scenario.job]],
  ],
  { stopOn: /UPDATE tbl_job SET/ },
);

const jobSvc = require('../services/job.service');

beforeEach(() => { fake.reset(); scenario.job = STORED(); });

/* The SET clause + its bound value for one column, or null when absent. */
function setFor(col) {
  const upd = fake.calls.find((c) => /UPDATE tbl_job SET/.test(c.sql));
  assert.ok(upd, 'an UPDATE tbl_job must be issued');
  const cols = upd.sql
    .replace(/^[\s\S]*?UPDATE tbl_job SET\s*/i, '')
    .replace(/\s*WHERE[\s\S]*$/i, '')
    .split(',')
    .map((s) => s.trim().split('=')[0].trim());
  const i = cols.indexOf(col);
  return i === -1 ? null : { index: i, value: upd.params[i] };
}

test('an UNTOUCHED open-and-save does not write time_slot at all', async () => {
  await assert.rejects(() => jobSvc.update(100, {
    // Exactly what JobModal sends on a no-op save: the stored appointment as an
    // ISO instant, and the stored slot echoed back.
    requested_date_time: '2026-08-05T10:00:00+05:30',
    time_slot: 'Morning 9 to 2',
    job_desc: 'unchanged text',
  }, { user_id: 9 }));
  assert.equal(setFor('time_slot'), null, 'the legacy slot survives an untouched save, unrewritten');
});

test('seconds stored on a legacy row do not read as "the operator moved the appointment"', async () => {
  scenario.job.requested_date_time = '2026-08-05 10:00:45';
  await assert.rejects(() => jobSvc.update(100, {
    requested_date_time: '2026-08-05T10:00:00+05:30',
    time_slot: 'Morning 9 to 2',
  }, { user_id: 9 }));
  assert.equal(setFor('time_slot'), null, 'comparison is minute-precision — no picker emits seconds');
});

test('MOVING the appointment re-derives the band from the new time', async () => {
  await assert.rejects(() => jobSvc.update(100, {
    requested_date_time: '2026-08-05T16:00:00+05:30',
    time_slot: 'Morning 9 to 2',          // the untouched echo, now contradicted
  }, { user_id: 9 }));
  const slot = setFor('time_slot');
  assert.ok(slot, 'the band must move with the appointment');
  assert.equal(slot.value, '3PM to 7PM', 'the appointment instant wins over the echoed label');
});

test('picking a DIFFERENT slot without moving the appointment honours the pick', async () => {
  await assert.rejects(() => jobSvc.update(100, {
    requested_date_time: '2026-08-05T10:00:00+05:30',   // unchanged
    time_slot: '3PM to 7PM',                            // deliberately re-picked
  }, { user_id: 9 }));
  const slot = setFor('time_slot');
  assert.ok(slot);
  assert.equal(slot.value, '3PM to 7PM',
    'deriving from the unchanged stored time would store neither the pick nor the original');
});

test('a 1-HOUR frame label can never reach the column', async () => {
  await assert.rejects(() => jobSvc.update(100, {
    requested_date_time: '2026-08-05T16:00:00+05:30',
    time_slot: '4 PM–5 PM',                        // a caller sending a frame label
  }, { user_id: 9 }));
  const slot = setFor('time_slot');
  assert.ok(slot);
  assert.equal(slot.value, '3PM to 7PM', 'time_slot only ever holds the containing BAND');
});
