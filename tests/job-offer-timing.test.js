/*
 * Characterization tests for the OFFER COUNTDOWN fields (2026-07-29):
 * job.service.listOfferedForTech now projects `offered_at` and derives
 * `expires_at` onto each preview row, so the technician app can render "expires
 * in N min" without knowing the TTL.
 *
 * Pinned here because both are a cross-repo contract: snake_case names, derived
 * server-side off OFFER_TTL_MINUTES (one source of truth), and sent ADDITIVELY —
 * regardless of any loud-alert flag. Also pins that the extra projection did not
 * cost an extra round trip.
 *
 * Non-destructive: fake pool, no real DB. Runner: `node --test`.
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

// Two open offers for the tech, newest first (the order the service preserves).
const OFFER_ROWS = () => ([
  { job_id: 101, offered_at: '2026-07-29 15:40:00', expires_at: '2026-07-29 16:10:00' },
  { job_id: 100, offered_at: '2026-07-29 15:20:00', expires_at: '2026-07-29 15:50:00' },
]);
// list() returns them job_id DESC; listOfferedForTech re-sorts to offer order.
const JOB_ROWS = () => ([
  { job_id: 101, job_status: 0, customer_name: 'B' },
  { job_id: 100, job_status: 0, customer_name: 'A' },
]);

const fake = installFakePool([
  [/INFORMATION_SCHEMA/i, [{ n: 0 }]],
  [/SHOW COLUMNS/i, []],
  // The offer read under test — must come before the generic tbl_job_offer probe.
  [/SELECT jo\.job_id, jo\.offered_at/i, () => OFFER_ROWS()],
  [/SELECT COUNT\(\*\) AS total/i, [{ total: 2 }]],
  // list()'s data query is the only one ending in LIMIT ? OFFSET ?.
  [/LIMIT \? OFFSET \?/i, () => JOB_ROWS()],
]);

const jobService = require('../services/job.service');

after(() => fake.restore());
beforeEach(() => fake.reset());

test('the offer read projects offered_at and derives expires_at from OFFER_TTL_MINUTES', async () => {
  await jobService.listOfferedForTech(42);
  const sel = fake.calls.find((c) => /SELECT jo\.job_id, jo\.offered_at/i.test(c.sql));
  assert.ok(sel, 'the open-offer SELECT must run');
  assert.match(sel.sql, /offered_at/, 'offered_at must be projected, not just ordered by');
  // The TTL is interpolated from the ONE constant — a literal 30 here would be
  // the drift this assertion exists to catch.
  assert.match(
    sel.sql,
    new RegExp(`DATE_ADD\\(jo\\.offered_at, INTERVAL ${jobService.OFFER_TTL_MINUTES} MINUTE\\) AS expires_at`),
    'expires_at must be derived in SQL from OFFER_TTL_MINUTES',
  );
  assert.match(sel.sql, /offer_status = 0/, 'only OPEN offers are listed');
});

test('each preview row carries snake_case offered_at + expires_at for its OWN offer', async () => {
  const { items } = await jobService.listOfferedForTech(42);
  assert.equal(items.length, 2);

  // Newest offer first, and the timing must be matched BY job_id — a positional
  // zip would silently pair the wrong countdown with the wrong job.
  assert.equal(items[0].job_id, 101);
  assert.equal(items[0].offered_at, '2026-07-29 15:40:00');
  assert.equal(items[0].expires_at, '2026-07-29 16:10:00');
  assert.equal(items[1].job_id, 100);
  assert.equal(items[1].offered_at, '2026-07-29 15:20:00');
  assert.equal(items[1].expires_at, '2026-07-29 15:50:00');
});

test('the countdown costs no extra round trip (still one offer read)', async () => {
  await jobService.listOfferedForTech(42);
  const offerReads = fake.calls.filter((c) => /SELECT jo\.job_id, jo\.offered_at/i.test(c.sql));
  assert.equal(offerReads.length, 1, 'offered_at/expires_at ride along on the read that already happened');
});
