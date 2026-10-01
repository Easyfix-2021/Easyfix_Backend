/*
 * Characterization tests for job.service.setStatus — the central status-transition
 * writer every consumer (CRM, mobile, integration) funnels through. Uses the
 * fake-pool seam (no real DB, no dummy prod writes): the fake answers the column
 * probes + the getJobMeta read, then STOPS at the UPDATE so we can assert on the
 * exact statement without running the fire-and-forget webhook/notification tail.
 *
 * These pin: the 400 guard on an invalid status, the 404 on a missing job, the
 * cancel_* stamp set, and — most importantly — that the extras allowlist is the
 * SQL-injection guard (a non-allowlisted column never reaches the UPDATE).
 *
 * Runner: `node --test`. See `npm run test:job`.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

// Mutable scenario the routes read so each test can vary the getJobMeta result.
const scenario = { jobMeta: null };

// Install the fake BEFORE requiring the service so the captured `pool` is ours.
const fake = installFakePool(
  [
    // Column-presence probes (hasOtpColumn / hasCallLaterColumn / hasEnquiryColumns):
    // any INFORMATION_SCHEMA hit returns a "present" shape (rows.length=1, n=3).
    [/INFORMATION_SCHEMA/i, () => [{ n: 3 }]],
    // getJobMeta's single-row existence + prev-status read.
    [/FROM\s+tbl_job\s+WHERE\s+job_id/i, () => (scenario.jobMeta ? [scenario.jobMeta] : [])],
    // The after-work-photo gate on a close (10 → 3): one proof photo present.
    [/FROM\s+tbl_job_image/i, () => [{ 1: 1 }]],
  ],
  { stopOn: /UPDATE\s+tbl_job\s+SET/i },
);

const jobSvc = require('../services/job.service');

const META = {
  job_id: 42, job_status: 1, fk_easyfixter_id: 7, fk_customer_id: 3,
  fk_client_id: 5, requested_date_time: '2026-07-10 10:00:00',
  booking_cut_off_time_slot: null, otp: null,
};

function lastUpdate() {
  return fake.calls.find((c) => /UPDATE\s+tbl_job\s+SET/i.test(c.sql)) || null;
}

beforeEach(() => { fake.calls.length = 0; scenario.jobMeta = { ...META }; });

test('invalid status is rejected 400 before ANY DB call', async () => {
  await assert.rejects(
    () => jobSvc.setStatus(42, { status: 999 }, { user_id: 1 }),
    (e) => e.status === 400,
  );
  assert.equal(fake.calls.length, 0, 'no query should run for an invalid status');
});

test('missing job is rejected 404', async () => {
  scenario.jobMeta = null; // getJobMeta returns null
  await assert.rejects(
    () => jobSvc.setStatus(42, { status: 2 }, { user_id: 1 }),
    (e) => e.status === 404,
  );
});

test('CANCELLED transition stamps the cancel_* columns in the UPDATE', async () => {
  try {
    await jobSvc.setStatus(42, { status: 6, reasonId: 12, comment: 'x' }, { user_id: 1 });
  } catch (e) { if (!e.__stop) throw e; }
  const upd = lastUpdate();
  assert.ok(upd, 'an UPDATE tbl_job should have been issued');
  for (const col of ['job_status', 'cancel_date_time', 'cancel_reason_id', 'cancel_comment', 'cancel_by']) {
    assert.match(upd.sql, new RegExp(col), `UPDATE should set ${col}`);
  }
});

test('extras allowlist is the SQL-injection guard — unknown columns are dropped', async () => {
  try {
    await jobSvc.setStatus(
      42,
      { status: 2, extras: { checkin_gps_location: '12.9,77.5', not_a_real_column: 'x' } },
      { user_id: 1 },
    );
  } catch (e) { if (!e.__stop) throw e; }
  const upd = lastUpdate();
  assert.ok(upd);
  assert.match(upd.sql, /checkin_gps_location/, 'allowlisted extra must be applied');
  assert.doesNotMatch(upd.sql, /not_a_real_column/, 'non-allowlisted extra must be dropped');
});

/*
 * Non-destructive extras (2026-08-19). The mobile check-in path used to build
 * `checkin_gps_location: req.body.gps || null`, so a request without GPS wrote
 * an explicit NULL and erased the previous visit's reading. The route now omits
 * absent stamps; these pin the service half of that contract so a future caller
 * can't reintroduce it: `undefined` = "nothing to say", explicit `null` = "clear
 * it for this event" (reschedule_remarks relies on the latter).
 */
test('extras: an undefined value is skipped, not written as NULL', async () => {
  try {
    await jobSvc.setStatus(
      42,
      { status: 2, extras: { checkin_gps_location: undefined, fk_checkin_by: 7 } },
      { user_id: 1 },
    );
  } catch (e) { if (!e.__stop) throw e; }
  const upd = lastUpdate();
  assert.ok(upd);
  assert.doesNotMatch(upd.sql, /checkin_gps_location/, 'undefined extra must not reach the UPDATE');
  assert.match(upd.sql, /fk_checkin_by/, 'a supplied extra alongside it still applies');
  assert.ok(!upd.params.includes(undefined), 'no undefined may be bound (mysql2 rejects it)');
});

test('extras: an explicit null IS written — callers can still clear a column', async () => {
  try {
    await jobSvc.setStatus(
      42,
      { status: 2, extras: { reschedule_remarks: null } },
      { user_id: 1 },
    );
  } catch (e) { if (!e.__stop) throw e; }
  const upd = lastUpdate();
  assert.ok(upd);
  assert.match(upd.sql, /reschedule_remarks/, 'explicit null must still set the column');
  assert.ok(upd.params.includes(null), 'null must be bound as the value');
});

test('extras: checkin_date_time is WRITE-ONCE — a revisit cannot move the TAT anchor', async () => {
  // Segment 1 measures ticket-created → FIRST check-in. A revisit re-checks-in
  // on the same row, and an app retry can fire the endpoint twice in seconds.
  // A plain `col = ?` would move the anchor forward and silently improve a
  // Visit TAT that was already breached.
  try {
    await jobSvc.setStatus(
      42,
      { status: 2, extras: { checkin_date_time: new Date(), checkin_pincode: '560001' } },
      { user_id: 1 },
    );
  } catch (e) { if (!e.__stop) throw e; }
  const upd = lastUpdate();
  assert.ok(upd);
  assert.match(upd.sql, /checkin_date_time = COALESCE\(checkin_date_time, \?\)/,
    'the anchor must keep its FIRST value');
  assert.match(upd.sql, /checkin_pincode = \?/,
    'ordinary extras still overwrite — only the anchor is write-once');
});

/*
 * Audit & Checkout / Feedback & Complete (2026-09-30) — the two CRM moves that
 * finish a job, matching legacy's checkout SP and sp_ef_job_update_job('Feedback').
 */
test('10 → 3 writes the confirmed collected_by with the checkout stamps, and no feedback stamps', async () => {
  scenario.jobMeta = { ...META, job_status: 10 };
  try {
    await jobSvc.setStatus(42, { status: 3, extras: { collected_by: 2 } }, { user_id: 1 });
  } catch (e) { if (!e.__stop) throw e; }
  const upd = lastUpdate();
  assert.ok(upd, 'an UPDATE tbl_job should have been issued');
  assert.match(upd.sql, /collected_by = \?/, 'Collected By rides the checkout UPDATE');
  assert.ok(upd.params.includes(2), 'the confirmed value is bound');
  assert.match(upd.sql, /checkout_date_time = COALESCE/);
  assert.doesNotMatch(upd.sql, /feedback_date_time/, 'a checkout is not the feedback');
});

test('3 → 5 stamps feedback_date_time and fk_feedback_by, write-once', async () => {
  scenario.jobMeta = { ...META, job_status: 3 };
  try {
    await jobSvc.setStatus(42, { status: 5 }, { user_id: 1 });
  } catch (e) { if (!e.__stop) throw e; }
  const upd = lastUpdate();
  assert.ok(upd, 'an UPDATE tbl_job should have been issued');
  assert.match(upd.sql, /feedback_date_time = COALESCE\(feedback_date_time, \?\)/);
  assert.match(upd.sql, /fk_feedback_by = COALESCE\(fk_feedback_by, \?\)/);
});

/*
 * Booking (→ 0) stamps fk_created_by with the booking operator, OVERWRITING any
 * value an integration (e.g. the Decathlon webhook) set on the Unconfirmed row.
 */
test('9 → 0 overwrites fk_created_by with the booking CRM user', async () => {
  scenario.jobMeta = { ...META, job_status: 9, fk_easyfixter_id: null, fk_created_by: 555 };
  try {
    await jobSvc.setStatus(42, { status: 0 }, { user_id: 17 });
  } catch (e) { if (!e.__stop) throw e; }
  const upd = lastUpdate();
  assert.ok(upd, 'an UPDATE tbl_job should have been issued');
  assert.match(upd.sql, /fk_created_by = \?/);
  assert.doesNotMatch(upd.sql, /COALESCE\(fk_created_by/, 'must overwrite, not keep the webhook user');
  assert.ok(upd.params.includes(17), 'the booking operator is bound');
});

test('0 → 0 re-submit and a technician actor leave fk_created_by alone', async () => {
  scenario.jobMeta = { ...META, job_status: 0, fk_easyfixter_id: null };
  try { await jobSvc.setStatus(42, { status: 0 }, { user_id: 17 }); } catch (e) { if (!e.__stop) throw e; }
  assert.doesNotMatch(lastUpdate().sql, /fk_created_by/, 'same-status is not a booking');

  fake.calls.length = 0;
  scenario.jobMeta = { ...META, job_status: 9, fk_easyfixter_id: null };
  try { await jobSvc.setStatus(42, { status: 0 }, { user_id: 'efr:88' }); } catch (e) { if (!e.__stop) throw e; }
  assert.doesNotMatch(lastUpdate().sql, /fk_created_by/, 'a tech has no tbl_user row');
});
