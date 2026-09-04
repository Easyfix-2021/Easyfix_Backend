/*
 * withdrawOffersForClosedJob — an offer must not outlive the job it advertises.
 *
 * THE REPORTED BUG: a technician was shown "Accept job / Reject" for work that
 * was already finished. Nothing closed an offer when its JOB ended —
 * expireStaleOffers closes on AGE, and job.offer_expiry.enabled is "false" in
 * production, so nothing closed them at all. 1,606 open offers were sitting on
 * completed or cancelled jobs, the youngest ~40 hours old.
 *
 * The three things that have to hold, each with a control:
 *   1. a terminal status closes the open offers,
 *   2. a LIVE status closes nothing (the expensive failure — cancelling every
 *      technician's real offer),
 *   3. it is NOT gated on job.offer_expiry.enabled, because that flag means
 *      "stop timing technicians out", not "keep advertising cancelled work".
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const calls = [];
const fake = installFakePool([
  // jobOfferTableExists() — the table is present on this host.
  [/information_schema|SHOW TABLES/i, [{ n: 1 }]],
  [/UPDATE tbl_job_offer/i, (sql, params) => {
    calls.push({ sql, params });
    return { affectedRows: 3 };
  }],
]);

const jobService = require('../services/job.service');
after(() => fake.restore());
beforeEach(() => { calls.length = 0; });

/* The statuses, named here so a change to the service's set is visible as a
   test failure rather than as silently narrower coverage. */
const TERMINAL = [3, 5, 6, 10];   // COMPLETED, COMPLETED_ALT, CANCELLED, CLOSED_FROM_APP
const LIVE     = [0, 1, 2, 9, 15, 20, 21];

test('every terminal status withdraws the open offers', async () => {
  for (const status of TERMINAL) {
    calls.length = 0;
    const r = await jobService.withdrawOffersForClosedJob(4242, status);
    assert.equal(r.skipped, undefined, `status ${status} must not be skipped`);
    assert.equal(calls.length, 1, `status ${status} should issue exactly one UPDATE`);
    assert.equal(r.withdrawn, 3);
  }
});

test('CONTROL — a live status withdraws NOTHING', async () => {
  // The expensive failure: a set that is too wide cancels every technician's
  // real, actionable offer. Without this test, a bug that withdrew on ALL
  // statuses would pass the test above perfectly.
  for (const status of LIVE) {
    calls.length = 0;
    const r = await jobService.withdrawOffersForClosedJob(4242, status);
    assert.equal(r.skipped, true, `status ${status} must be skipped`);
    assert.equal(calls.length, 0, `status ${status} must issue NO update`);
  }
});

test('it closes ONLY offers still open, and stamps responded_at', async () => {
  await jobService.withdrawOffersForClosedJob(4242, 6);
  const { sql, params } = calls[0];
  // offer_status 0 = OFFERED -> 3 = EXPIRED (services/offer-status.js)
  assert.match(sql, /offer_status\s*=\s*3/, 'must close as EXPIRED');
  assert.match(sql, /offer_status\s*=\s*0/, 'must match only offers still OPEN');
  assert.match(sql, /responded_at\s*=\s*NOW\(\)/,
    'a closed offer with a NULL responded_at is the exact shape being cleaned up');
  assert.match(sql, /job_id\s*=\s*\?/, 'scoped to one job');
  assert.deepEqual(params, [4242]);
  // It must NOT reach for accepted or rejected rows.
  assert.doesNotMatch(sql, /offer_status\s+IN/i,
    'an accepted or rejected offer is already answered and must be left alone');
});

test('it is NOT gated on job.offer_expiry.enabled — and its sibling still is', () => {
  /*
   * A STRUCTURAL assertion, because the runtime one is impossible: job.service
   * destructures getProperty at import time, so no amount of module patching
   * reaches the reference the function actually calls.
   *
   * The regression this guards would look like a tidy-up. Someone notices this
   * UPDATE resembles expireStaleOffers and adds the same offerExpiryEnabled()
   * guard for consistency. Production has that flag "false", so the fix would
   * silently stop working — while every other test in this file kept passing,
   * because none of them sets the flag either.
   *
   * The second half is the CONTROL: expireStaleOffers MUST still contain the
   * gate. Without it, this test would also pass if offerExpiryEnabled were
   * deleted from the codebase entirely, which is the opposite mistake.
   */
  const src = require('node:fs').readFileSync(
    require.resolve('../services/job.service'), 'utf8');

  const bodyOf = (name) => {
    const i = src.indexOf(`async function ${name}(`);
    assert.notEqual(i, -1, `${name} should exist — did it get renamed?`);
    const next = src.indexOf('\nasync function ', i + 1);
    return src.slice(i, next === -1 ? src.length : next);
  };

  assert.doesNotMatch(bodyOf('withdrawOffersForClosedJob'), /offerExpiryEnabled\s*\(/,
    'withdrawal must NOT be gated on the expiry flag — production has it "false"');
  assert.match(bodyOf('expireStaleOffers'), /offerExpiryEnabled\s*\(/,
    'CONTROL: the TTL sweep must still be gated, or this detector proves nothing');
});
