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

// `time_slot` is read by reschedule ONLY as the fallback for a date-only move
// (no hour to band) — see resolveTimeSlot in services/time-slot.js.
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
 * ─── time_slot IS ALWAYS A BAND ──────────────────────────────────────
 *
 * REVERSED 2026-07-31. For one day reschedule() PRESERVED a 1-hour frame label
 * ('3 PM–4 PM') in tbl_job.time_slot; that decision is undone. time_slot now
 * carries only the four broad bands, and the 1-hour granularity the operator
 * picked lives in requested_date_time / requested_time.
 *
 * 14:30 is used throughout because it sits in the 12PM-to-3PM band while being
 * a time no band label spells out — so a test passing by coincidence is
 * unlikely.
 */
async function rescheduleTo(dt) {
  await assert.rejects(
    () => jobSvc.reschedule(42, { requestedDateTime: dt, reasonId: 3 }, { user_id: 9 }),
  );
  const upd = fake.calls.find((c) => /UPDATE tbl_job\b/.test(c.sql));
  assert.ok(upd, 'the schedule UPDATE must be issued');
  // Param order mirrors the SET list: requested_date_time, requested_time, time_slot, …
  return { requestedDateTime: upd.params[0], requestedTime: upd.params[1], timeSlot: upd.params[2] };
}

const BANDS = ['9AM to 12PM', '12PM to 3PM', '3PM to 7PM', 'After Hours'];

test('a job holding a 1-hour frame is re-derived to the BAND, never another frame', async () => {
  scenario.existing.time_slot = '3 PM–4 PM';
  assert.equal((await rescheduleTo('2026-07-20 14:30')).timeSlot, '12PM to 3PM');
});

test('a job holding a LEGACY band is re-derived onto the canonical vocabulary', async () => {
  // Deliberately NOT a data migration: only the row being rescheduled moves,
  // and it moves because the appointment time changed, not because of its label.
  scenario.existing.time_slot = 'Morning 9 to 2';
  assert.equal((await rescheduleTo('2026-07-20 14:30')).timeSlot, '12PM to 3PM');
});

test('an absent slot is derived from the new appointment time', async () => {
  scenario.existing.time_slot = null;
  assert.equal((await rescheduleTo('2026-07-20 09:15')).timeSlot, '9AM to 12PM');
});

test('out-of-window hours land on After Hours', async () => {
  scenario.existing.time_slot = '3 PM–4 PM';
  assert.equal((await rescheduleTo('2026-07-20 21:00')).timeSlot, 'After Hours');
});

test('reschedule NEVER writes a 1-hour label, at any hour of the day', async () => {
  for (let h = 0; h < 24; h += 1) {
    fake.reset();
    scenario.existing.time_slot = '3 PM–4 PM';
    const hh = String(h).padStart(2, '0');
    const { timeSlot } = await rescheduleTo(`2026-07-20 ${hh}:30`);
    assert.ok(BANDS.includes(timeSlot), `${hh}:30 stored time_slot=${timeSlot}`);
  }
});

/*
 * A DATE-ONLY reschedule carries no hour, so the midnight sentinel must not be
 * mistaken for a real 00:00 appointment and clobber the slot with 'After
 * Hours'. The job's own label is canonicalised and kept instead.
 */
test('a date-only reschedule keeps the job’s own slot instead of banding midnight', async () => {
  scenario.existing.time_slot = '3 PM–4 PM';
  assert.equal((await rescheduleTo('2026-07-20')).timeSlot, '3PM to 7PM');
});

/*
 * requested_time is the 1-HOUR START and must be the wall clock verbatim.
 * It used to go through formatTimeIST(), which re-parses an already-IST string
 * as a real instant and adds +05:30 again — on a UTC container an IST 14:30
 * appointment was stored as requested_time '20:00' (see prod job 482474).
 * Asserted under a forced UTC timezone so the regression cannot hide on an
 * IST developer laptop.
 */
test('requested_time is the IST wall clock, not double-shifted by +05:30', async () => {
  const savedTz = process.env.TZ;
  process.env.TZ = 'UTC';
  try {
    const { requestedDateTime, requestedTime } = await rescheduleTo('2026-07-20 14:30');
    assert.ok(String(requestedDateTime).startsWith('2026-07-20 14:30'));
    assert.equal(requestedTime, '14:30');
  } finally {
    if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz;
  }
});
