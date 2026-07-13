/*
 * Characterization tests for job.service.acceptOffer — the offer-pool ACCEPT
 * path (offer → SCHEDULED). Pins: the verified gate, the atomic first-wins claim
 * that moves a still-BOOKED, ownerless job to SCHEDULED only while the tech's own
 * offer is still fresh, and the 409 lost-race rejection.
 *
 * The claim UPDATE's route is scenario-controlled so one file can exercise both
 * the win (stop at the claim to inspect it) and the loss (affectedRows=0 → 409)
 * without a fixed global stopOn.
 *
 * Non-destructive: fake pool, no real DB. Runner: `node --test`.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const DEFAULTS = () => ({ verifyRows: [{ efr_id: 42 }], claimStop: false, claimAffected: 1 });
const scenario = DEFAULTS();

const fake = installFakePool([
  [/INFORMATION_SCHEMA/i, [{ n: 0 }]],
  [/SHOW COLUMNS/i, []],
  [/is_technician_verified = 1/, () => scenario.verifyRows],
  // The atomic claim UPDATE. Either stop here (to inspect the statement) or
  // return a controlled affectedRows to drive the win/lose branch.
  [/UPDATE tbl_job\s+SET job_status\s*=\s*1,\s*fk_easyfixter_id/, () => {
    if (scenario.claimStop) { const e = new Error('__CLAIM_STOP__'); e.__stop = true; throw e; }
    return { affectedRows: scenario.claimAffected };
  }],
  // ACCEPTED + sibling-EXPIRE offer updates on the win path resolve harmlessly ([]).
], {});

const jobSvc = require('../services/job.service');

beforeEach(() => { fake.reset(); Object.assign(scenario, DEFAULTS()); });

test('acceptOffer by an unverified tech is rejected before any write', async () => {
  scenario.verifyRows = [];
  await assert.rejects(
    () => jobSvc.acceptOffer(100, 42),
    (e) => e.status === 400 && e.code === 'TECH_NOT_VERIFIED',
  );
  assert.ok(!fake.calls.some((c) => /\b(UPDATE|INSERT)\b/i.test(c.sql)), 'no write for an unverified claimant');
});

test('acceptOffer issues the atomic first-wins claim moving BOOKED → SCHEDULED', async () => {
  scenario.claimStop = true; // stop right at the claim to characterize it
  await assert.rejects(() => jobSvc.acceptOffer(100, 42));
  const claim = fake.calls.find((c) => /UPDATE tbl_job\s+SET job_status/.test(c.sql));
  assert.ok(claim, 'the claim UPDATE must be issued');
  assert.match(claim.sql, /job_status\s*=\s*1/, 'moves the job to SCHEDULED');
  assert.match(claim.sql, /fk_easyfixter_id\s*=\s*\?/, 'stamps the winning technician');
  assert.match(claim.sql, /job_status\s*=\s*0\b/, 'first-wins gate: only while still BOOKED');
  assert.match(claim.sql, /fk_easyfixter_id IS NULL/, 'only while still ownerless');
  assert.match(claim.sql, /EXISTS/, 'freshness gate: the tech must still hold an open, unexpired offer');
  assert.equal(claim.params[0], 42, 'claims for the accepting technician');
});

test('acceptOffer that loses the race is rejected 409 (offer no longer available)', async () => {
  scenario.claimAffected = 0; // the atomic claim matched no row → lost
  await assert.rejects(
    () => jobSvc.acceptOffer(100, 42),
    (e) => e.status === 409,
  );
});
