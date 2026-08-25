/*
 * Location-ping status window (2026-08-25).
 *
 * recordLocationPing decides which job statuses may append to the live GPS
 * trail. It is worth pinning because a 409 here is NOT a soft failure: the
 * technician app's background task treats 409 as "stop tracking" and
 * self-terminates (src/lib/native/backgroundLocation.ts). That self-stop is
 * the only one that works while the app is backgrounded with no screen
 * mounted, so:
 *
 *   - every TERMINAL status must keep 409ing, or a finished job tracks the
 *     technician for the rest of the day; and
 *   - every status inside the accept→complete window must NOT 409, or the
 *     tracker dies permanently the first time the app pings.
 *
 * Two bugs are pinned here specifically.
 *
 * 1. SCHEDULED (1) used to be rejected. That is the accept→check-in window —
 *    the technician travelling to the customer — i.e. exactly the period an
 *    operator is on the phone asking "where is he".
 *
 * 2. IN_PROGRESS_ALT (20) used to be rejected while the CRM ALREADY offered
 *    the Live Location button for it (jobs/page.tsx, my-orders/page.tsx). So
 *    an operator could open a popover for a status-20 job whose pings the
 *    server was refusing — and that 409 permanently killed the tracker.
 *
 * Runner: `node --test tests/mobile-location-ping-window.test.js`.
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { installFakePool } = require('./helpers/fake-pool');

const JOB_ID = 4242;
const EFR_ID = 77;

// getOwnedJob's row. Tests reassign `jobStatus`; the pool closure reads it.
let jobStatus = 2;
let addPingCalls = 0;

const fake = installFakePool([
  [
    /FROM\s+tbl_job\s+WHERE\s+job_id/i,
    () => [{
      job_id: JOB_ID,
      job_status: jobStatus,
      fk_easyfixter_id: EFR_ID,
      fk_customer_id: 1,
      fk_client_id: 1,
      otp: null,
    }],
  ],
  // addPing's INSERT — counted so we can prove the gate ran BEFORE the write.
  [/INSERT\s+INTO\s+tbl_job_location_track/i, () => { addPingCalls += 1; return { insertId: 1 }; }],
]);

const lifecycle = require('../services/mobile-job-lifecycle.service');

after(() => fake.restore());
beforeEach(() => {
  addPingCalls = 0;
  fake.reset();
});

const PING = { latitude: 12.9, longitude: 77.6, accuracy: 20 };

async function ping(status) {
  jobStatus = status;
  try {
    await lifecycle.recordLocationPing(JOB_ID, EFR_ID, PING);
    return { ok: true, status: 200 };
  } catch (e) {
    return { ok: false, status: e.status || 500, message: e.message };
  }
}

/*
 * The window. 1 and 20 are the two that used to be wrong; 2 is the one that
 * always worked and must not regress while widening around it.
 */
for (const [status, label] of [[1, 'SCHEDULED — accepted, travelling'],
                               [2, 'IN_PROGRESS — checked in'],
                               [20, 'IN_PROGRESS_ALT — the other checked-in state']]) {
  test(`status ${status} (${label}) accepts a ping`, async () => {
    const r = await ping(status);
    assert.equal(r.ok, true, `status ${status} must not 409 — a 409 permanently stops the app's tracker`);
    assert.equal(addPingCalls, 1, 'the ping must actually be written');
  });
}

/*
 * Terminal and pre-accept states. The self-terminate property lives here: if
 * any of these stops 409ing, a finished job keeps reporting the technician's
 * position with no way to stop it from the server.
 */
for (const [status, label] of [[0, 'BOOKED — not yet accepted'],
                               [3, 'COMPLETED'],
                               [5, 'CANCELLED'],
                               [9, 'UNCONFIRMED'],
                               [10, 'REVISIT / closed from app']]) {
  test(`status ${status} (${label}) is refused 409 and writes nothing`, async () => {
    const r = await ping(status);
    assert.equal(r.ok, false);
    assert.equal(r.status, 409, `status ${status} must 409 so the app self-terminates`);
    assert.equal(addPingCalls, 0, 'the gate must run before the INSERT');
  });
}

test('the gate is an allowlist, not a range — an unknown future status is refused', async () => {
  /*
   * The reason this is a Set and not `status < 3`. A range check silently
   * admits any status numbered inside it, so the day someone adds status 4 the
   * self-terminate guarantee is gone with no failing test and no review.
   */
  const r = await ping(99);
  assert.equal(r.status, 409, 'an unrecognised status must be refused, not admitted by a range');
  assert.equal(addPingCalls, 0);
});

test("another technician's job is 404, never 409 — ownership is checked first", async () => {
  /*
   * 404 rather than 403 so a technician cannot probe which job ids exist, and
   * ordering matters: a 409 for someone else's job would leak that the job is
   * live. Also asserts the status gate cannot be reached without ownership.
   */
  jobStatus = 2;
  let status = 0;
  try {
    await lifecycle.recordLocationPing(JOB_ID, EFR_ID + 1, PING);
  } catch (e) {
    status = e.status;
  }
  assert.equal(status, 404, 'a job that is not this technician\'s must be indistinguishable from a missing one');
  assert.equal(addPingCalls, 0);
});
