/*
 * Characterization tests for CANCEL → EXPIRE OPEN OFFERS (2026-07-29).
 *
 * job.service.setStatus(), on a transition INTO CANCELLED (6), now closes every
 * still-open tbl_job_offer row for that job (OFFERED → EXPIRED, responded_at
 * stamped). Before this, those rows survived until the 30-min TTL sweep, so the
 * CRM list projection (offerColumns(): is_offered / offered_count) kept
 * reporting a LIVE offer on a cancelled job and the technician could still act
 * on it.
 *
 * What is pinned here:
 *   • the INTO-cancelled transition issues the expire UPDATE, parameterised on
 *     job_id and scoped to open rows only;
 *   • the status codes come from services/offer-status.js, not bare 0/3 —
 *     asserted against the constants themselves so a hardcoded literal that
 *     later drifts from the enum fails;
 *   • a cancelled → cancelled no-op does NOT re-run it (responded_at must not
 *     be re-stamped on rows a previous cancel already closed);
 *   • no OTHER status transition touches tbl_job_offer (SCOPE: cancel only —
 *     assign/reassign behaviour is unchanged);
 *   • the write is non-fatal: a missing table (ER_NO_SUCH_TABLE from a stale
 *     existence probe) degrades quietly and any other failure is swallowed, so
 *     a cancellation that already persisted can never surface as a 500.
 *
 * Non-destructive: fake pool, no real DB, no dummy prod rows. The fake STOPS at
 * getById()'s detail SELECT — the last thing setStatus does — so every write
 * under test has already been captured by then, without running the detail
 * fan-out. Runner: `node --test`.
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');
const { OFFER_STATUS } = require('../services/offer-status');

// Mutable scenario each test tweaks: the getJobMeta row (drives the PREVIOUS
// status) and an optional error thrown by the offer UPDATE.
const scenario = { jobMeta: null, offerUpdateError: null };

// Install the fake BEFORE requiring the service so the captured `pool` is ours.
const fake = installFakePool(
  [
    // Column-presence probes (hasOtpColumn / hasCallLaterColumn / …).
    [/INFORMATION_SCHEMA/i, () => [{ n: 3 }]],
    // The memoised jobOfferTableExists() probe. node runs each test file in its
    // own process, so the memo starts cold here and resolves to "present".
    [/SELECT 1 FROM tbl_job_offer LIMIT 1/i, () => [{ ok: 1 }]],
    // The statement under test.
    [/UPDATE\s+tbl_job_offer/i, () => {
      if (scenario.offerUpdateError) throw scenario.offerUpdateError;
      return { affectedRows: 2 };
    }],
    // getJobMeta's single-row existence + prev-status read.
    [/FROM\s+tbl_job\s+WHERE\s+job_id/i, () => (scenario.jobMeta ? [scenario.jobMeta] : [])],
  ],
  // getById()'s detail SELECT is the tail of setStatus — stop there.
  { stopOn: /SELECT\s+j\.\*/i },
);

const jobSvc = require('../services/job.service');

const META = {
  job_id: 42, job_status: 1, fk_easyfixter_id: 7, fk_customer_id: 3,
  fk_client_id: 5, requested_date_time: '2026-07-10 10:00:00',
  booking_cut_off_time_slot: null, otp: null,
};

const CANCELLED = 6;

// Run setStatus to completion, swallowing ONLY the fake's stop sentinel.
async function runStatus(status, prevStatus = 1) {
  scenario.jobMeta = { ...META, job_status: prevStatus };
  try {
    await jobSvc.setStatus(42, { status, reasonId: 12, comment: 'customer cancelled' }, { user_id: 1 });
  } catch (e) {
    if (!e.__stop) throw e;
  }
}

function offerUpdates() {
  return fake.calls.filter((c) => /UPDATE\s+tbl_job_offer/i.test(c.sql));
}

after(() => fake.restore());
beforeEach(() => { fake.reset(); scenario.jobMeta = { ...META }; scenario.offerUpdateError = null; });

test('cancelling a job expires its OPEN offers — scoped to this job, parameterised', async () => {
  await runStatus(CANCELLED, 1);
  const upds = offerUpdates();
  assert.equal(upds.length, 1, 'exactly one expire statement per cancellation');
  const [upd] = upds;

  // job_id is BOUND, never concatenated (CLAUDE.md: parameterised SQL only).
  assert.deepEqual(upd.params, [42]);
  assert.match(upd.sql, /WHERE job_id = \?/, 'the job id must be a bind parameter');
  assert.doesNotMatch(upd.sql, /job_id = 42/, 'the job id must never be interpolated');
  // responded_at is stamped, matching acceptOffer()/reschedule()'s expire shape.
  assert.match(upd.sql, /responded_at = NOW\(\)/);
});

test('the expire uses the OFFER_STATUS constants, not bare 0/3 literals', async () => {
  await runStatus(CANCELLED, 1);
  const [upd] = offerUpdates();
  // Built from the enum, so renumbering offer-status.js moves this assertion
  // with the code — a hardcoded 3 that later drifts from EXPIRED fails here.
  assert.match(upd.sql, new RegExp(`SET offer_status = ${OFFER_STATUS.EXPIRED}\\b`));
  assert.match(upd.sql, new RegExp(`offer_status = ${OFFER_STATUS.OFFERED}\\b\\s*$`, 'm'),
    'only OPEN offers are expired — ACCEPTED/REJECTED/EXPIRED rows are left alone');
});

test('a cancelled → cancelled no-op does NOT re-expire (responded_at is not re-stamped)', async () => {
  await runStatus(CANCELLED, CANCELLED);
  assert.equal(offerUpdates().length, 0, 'only the transition INTO cancelled expires offers');
});

test('SCOPE: no other status transition touches tbl_job_offer', async () => {
  for (const status of [0, 1, 2, 3, 7, 9, 10]) {
    fake.reset();
    await runStatus(status, 1);
    assert.equal(offerUpdates().length, 0, `status ${status} must not touch tbl_job_offer`);
  }
});

test('the expire runs AFTER the job UPDATE — the cancellation is persisted first', async () => {
  await runStatus(CANCELLED, 1);
  const jobUpd = fake.calls.findIndex((c) => /UPDATE\s+tbl_job\s+SET/i.test(c.sql));
  const offerUpd = fake.calls.findIndex((c) => /UPDATE\s+tbl_job_offer/i.test(c.sql));
  assert.ok(jobUpd >= 0 && offerUpd > jobUpd, 'the offer expire must not precede the cancellation itself');
});

test('a missing tbl_job_offer (ER_NO_SUCH_TABLE) degrades quietly — the cancel still completes', async () => {
  const e = new Error('Table \'easyfix_core.tbl_job_offer\' doesn\'t exist');
  e.code = 'ER_NO_SUCH_TABLE';
  scenario.offerUpdateError = e;

  // Reaching the stop sentinel proves setStatus ran past the offer block to its
  // getById() tail rather than rejecting with the DB error.
  scenario.jobMeta = { ...META, job_status: 1 };
  await assert.rejects(
    () => jobSvc.setStatus(42, { status: CANCELLED, reasonId: 12 }, { user_id: 1 }),
    (err) => err.__stop === true,
  );
  assert.equal(offerUpdates().length, 1, 'it did attempt the expire');
});

test('any other offer-expire failure is swallowed — a persisted cancellation never 500s', async () => {
  scenario.offerUpdateError = Object.assign(new Error('Deadlock found'), { code: 'ER_LOCK_DEADLOCK' });
  scenario.jobMeta = { ...META, job_status: 1 };
  await assert.rejects(
    () => jobSvc.setStatus(42, { status: CANCELLED, reasonId: 12 }, { user_id: 1 }),
    (err) => err.__stop === true,
  );
  // And the tbl_job cancellation itself still went through.
  assert.ok(fake.calls.some((c) => /UPDATE\s+tbl_job\s+SET/i.test(c.sql) && /cancel_date_time/.test(c.sql)));
});
