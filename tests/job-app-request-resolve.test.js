/*
 * Technician APP REQUESTS — the ops decision half.
 *
 * A technician raises a cancellation or reschedule ask from the mobile app,
 * which sets tbl_job.is_cancelled_by_app / is_rescheduled_by_app = 1 while the
 * job stays at status 1. Until 2026-09-15 NOTHING in this backend ever wrote
 * either column back to 0 — the only two writers both wrote 1 — so:
 *   · ops cancelled the job and the technician's app kept the ask open forever
 *     (buildAppRequest deliberately ignores job_status), and
 *   · there was no way to DECLINE an ask at all, because a decline by
 *     definition leaves the job at status 1 and the CRM's queue predicate is
 *     job_status = 1.
 *
 * What this file pins, in the two shapes the feature has:
 *   APPROVE — no endpoint of its own; the ordinary cancel and reschedule now
 *             clear the ask they answer, and clear ONLY that one.
 *   REJECT  — job.rejectAppRequest: one guarded flag write, 409 when the ask is
 *             not actually open, and nothing else on tbl_job touched.
 *
 * Non-destructive: fake pool, no real DB. Runner: `node --test`.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const DEFAULTS = () => ({
  // What the guarded UPDATE reports back. 1 = the ask was open and is now down.
  rejectAffected: 1,
  jobExists: true,
});
const scenario = DEFAULTS();

const fake = installFakePool([
  [/INFORMATION_SCHEMA/i, [{ n: 0 }]],
  [/SHOW COLUMNS/i, []],
  [/SELECT job_id FROM tbl_job/, () => (scenario.jobExists ? [{ job_id: 42 }] : [])],
  [/UPDATE tbl_job SET is_(cancelled|rescheduled)_by_app = 0 WHERE/, () => ({ affectedRows: scenario.rejectAffected })],
  // Everything reached AFTER the flag write is audit/readback we do not exercise
  // here; the default [] keeps them inert.
]);

const jobSvc = require('../services/job.service');

beforeEach(() => { fake.reset(); Object.assign(scenario, DEFAULTS()); });

const clears = () => fake.calls.filter((c) => /UPDATE tbl_job SET is_\w+_by_app = 0/.test(c.sql));

/* ─── REJECT ──────────────────────────────────────────────────────── */

test('reject clears exactly the named flag and leaves the other one alone', async () => {
  await jobSvc.rejectAppRequest(42, { kind: 'cancel', remarks: 'Customer still wants the visit' }, { user_id: 9 });
  const [upd, ...rest] = clears();
  assert.ok(upd, 'the flag write must be issued');
  assert.equal(rest.length, 0, 'exactly one flag write');
  assert.match(upd.sql, /is_cancelled_by_app = 0/);
  assert.doesNotMatch(upd.sql, /is_rescheduled_by_app/,
    'a cancellation row must never clear the reschedule ask — a job can carry both flags');
});

test('reject of a reschedule clears the reschedule flag, not the cancel one', async () => {
  await jobSvc.rejectAppRequest(42, { kind: 'reschedule', remarks: '' }, { user_id: 9 });
  const upd = clears()[0];
  assert.match(upd.sql, /is_rescheduled_by_app = 0/);
  assert.doesNotMatch(upd.sql, /is_cancelled_by_app/);
});

test('the flag write is GUARDED on the ask actually being open', async () => {
  await jobSvc.rejectAppRequest(42, { kind: 'cancel' }, { user_id: 9 });
  const upd = clears()[0];
  // The mobile writers have no "already asked" guard, so a technician can
  // re-raise at any moment; an unguarded UPDATE would let two operators both be
  // told "rejected" and would silently clear a BRAND NEW ask.
  assert.match(upd.sql, /WHERE job_id = \? AND COALESCE\(is_cancelled_by_app, 0\) = 1/);
});

test('reject answers 409 APP_REQUEST_NOT_PENDING when nothing was open', async () => {
  scenario.rejectAffected = 0;
  await assert.rejects(
    () => jobSvc.rejectAppRequest(42, { kind: 'cancel' }, { user_id: 9 }),
    (e) => e.status === 409 && e.code === 'APP_REQUEST_NOT_PENDING',
  );
});

test('reject of a missing job is 404 before any write', async () => {
  scenario.jobExists = false;
  await assert.rejects(
    () => jobSvc.rejectAppRequest(42, { kind: 'cancel' }, { user_id: 9 }),
    (e) => e.status === 404,
  );
  assert.equal(clears().length, 0, 'a 404 must not reach a write');
});

test('reject rejects an unknown kind 400 before touching the DB', async () => {
  await assert.rejects(
    () => jobSvc.rejectAppRequest(42, { kind: 'delete' }, { user_id: 9 }),
    (e) => e.status === 400,
  );
  assert.equal(fake.calls.length, 0, 'an unknown kind must not reach the DB at all');
});

test('reject writes NO other tbl_job column — the ask stays on the record', async () => {
  await jobSvc.rejectAppRequest(42, { kind: 'reschedule', remarks: 'declined' }, { user_id: 9 });
  const writes = fake.calls.filter((c) => /UPDATE tbl_job\b/.test(c.sql));
  // resch_job_count is a lifetime counter of ASKS, not of moves; cancel_date_time /
  // reschedule_date_time_app record that the technician asked and what for. A
  // rejected ask still happened, so none of that is rolled back.
  for (const w of writes) {
    assert.doesNotMatch(w.sql, /resch_job_count|cancel_date_time|reschedule_date_time_app|job_status/);
  }
});

/* ─── APPROVE, via resolveAppRequests ─────────────────────────────── */

test('resolveAppRequests clears both flags in ONE statement when asked for both', async () => {
  await jobSvc.resolveAppRequests(42, ['cancel', 'reschedule']);
  const upd = fake.calls.find((c) => /UPDATE tbl_job SET is_/.test(c.sql));
  assert.match(upd.sql, /is_cancelled_by_app = 0, is_rescheduled_by_app = 0/);
  assert.match(upd.sql, /COALESCE\(is_cancelled_by_app, 0\) = 1 OR COALESCE\(is_rescheduled_by_app, 0\) = 1/);
});

test('resolveAppRequests with no known kind issues no query at all', async () => {
  const n = await jobSvc.resolveAppRequests(42, ['nonsense']);
  assert.equal(n, 0);
  assert.equal(fake.calls.length, 0);
});

test('resolveAppRequests swallows a DB failure — an audit flag must not fail the ops action', async () => {
  const boom = { query: async () => { throw new Error('table is gone'); } };
  assert.equal(await jobSvc.resolveAppRequests(42, ['cancel'], boom), 0);
});

/* ─── Source characterization: WHICH ops action answers WHICH ask ──
 *
 * The call sites are inside setStatus / assign / reschedule, all of which are
 * hundreds of lines of unrelated machinery behind a fake pool. Reading the
 * source is the honest way to pin the rule; each assertion carries its own
 * positive control so a passing test cannot be a matcher that never fires.
 */

const fs = require('node:fs');
const SRC = fs.readFileSync(require.resolve('../services/job.service.js'), 'utf8');

test('cancel grants a cancellation ask AND moots a reschedule ask', () => {
  const re = /if \(Number\(status\) === STATUS\.CANCELLED\) await resolveAppRequests\(jobId, \['cancel', 'reschedule'\]\);/;
  assert.match(SRC, re);
  // Positive control: the same matcher must FAIL on text with the guard removed,
  // proving it is pinning the CANCELLED condition and not just the call.
  assert.doesNotMatch(SRC.replace(re, "await resolveAppRequests(jobId, ['cancel', 'reschedule']);"), re);
});

test('reschedule answers the appointment ask AND the cancellation ask', () => {
  // Was ONLY the appointment ask until 2026-09-25; the cancel flag now clears
  // here too, so a rescheduled job never hands the incoming technician the
  // outgoing one's banner. reschedule() ends with its own resolve call — find
  // it by the comment that explains the change, so this cannot accidentally
  // match the setStatus or assign site, which pass the same two kinds.
  const re = /The CANCELLATION ask is cleared here TOO[\s\S]{0,1600}?resolveAppRequests\(jobId, \['cancel', 'reschedule'\]\)/;
  assert.match(SRC, re);
  // Positive control: neutralise THAT call and the matcher must stop firing,
  // proving it pins the reschedule site's arguments and not just the comment.
  assert.doesNotMatch(
    SRC.replace(/comment_on = 9\) stays as the record\.\n  await resolveAppRequests\(jobId, \['cancel', 'reschedule'\]\);/, 'noop();'),
    re,
  );
});

test('assign/reassign clears both — the ask belonged to the outgoing technician', () => {
  const re = /show the INCOMING technician a banner[\s\S]{0,200}?resolveAppRequests\(jobId, \['cancel', 'reschedule'\]\)/;
  assert.match(SRC, re);
});

test('no OTHER status transition clears an app request', () => {
  // Denominator, not a spot check: every resolveAppRequests call site in the
  // file, counted. Three plus the definition, the export, and this reject path.
  const sites = SRC.match(/await resolveAppRequests\(/g) || [];
  assert.equal(sites.length, 3, 'exactly three ops actions answer an ask: cancel, reschedule, assign');
});
