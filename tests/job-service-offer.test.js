/*
 * Characterization tests for job.service.offerToTechnicians + assign's verified
 * gate, in the OFFER-FLOW-ON world (the default: offerFlowEnabled() is true and
 * the tbl_job_offer probe resolves, so assign() delegates to offerToTechnicians).
 *
 * Highest-value invariant pinned here: an UNVERIFIED technician is rejected
 * (TECH_NOT_VERIFIED) BEFORE any write — the security gate. Plus the empty-list
 * pre-DB guard and the fresh-offer INSERT shape.
 *
 * Non-destructive: fake pool, STOP-sentinel at the first write, no real DB.
 * Runner: `node --test`.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const DEFAULTS = () => ({
  verifyRows: [{ efr_id: 42 }],                                    // gate passes
  jobMeta: { job_id: 100, job_status: 0, fk_easyfixter_id: null }, // BOOKED, unowned
  techRow: { efr_id: 42, efr_status: 1 },                          // exists + active
});
const scenario = DEFAULTS();

const fake = installFakePool(
  [
    [/INFORMATION_SCHEMA/i, [{ n: 0 }]],
    [/SHOW COLUMNS/i, []],
    [/efr_status FROM tbl_easyfixer WHERE efr_id = \?/, () => (scenario.techRow ? [scenario.techRow] : [])],
    [/SELECT job_id, job_status, fk_easyfixter_id/, () => (scenario.jobMeta ? [scenario.jobMeta] : [])],
    [/is_technician_verified = 1/, () => scenario.verifyRows],
    // tbl_job_offer existence probe + per-tech latest-offer read: default [] →
    // table exists, no prior offer → fresh INSERT path.
  ],
  { stopOn: /INSERT INTO tbl_job_offer/ },
);

const jobSvc = require('../services/job.service');

const wrote = () => fake.calls.some((c) => /\b(INSERT|UPDATE)\b/i.test(c.sql));

beforeEach(() => { fake.reset(); Object.assign(scenario, DEFAULTS()); });

test('offer with an empty tech list is rejected 400 with ZERO DB calls', async () => {
  await assert.rejects(
    () => jobSvc.offerToTechnicians(100, [], { user_id: 1 }),
    (e) => e.status === 400,
  );
  assert.equal(fake.calls.length, 0, 'the empty-list guard must run before any query');
});

test('offer to an UNVERIFIED technician is rejected before any write (security gate)', async () => {
  scenario.verifyRows = []; // gate finds the tech is not verified
  await assert.rejects(
    () => jobSvc.offerToTechnicians(100, [42], { user_id: 1 }),
    (e) => e.status === 400 && e.code === 'TECH_NOT_VERIFIED',
  );
  assert.ok(!wrote(), 'no INSERT/UPDATE may run for an unverified tech');
});

test('offer to a VERIFIED technician issues an INSERT tbl_job_offer and leaves the job BOOKED', async () => {
  await assert.rejects(() => jobSvc.offerToTechnicians(100, [42], { user_id: 1 }));
  const ins = fake.calls.find((c) => /INSERT INTO tbl_job_offer/.test(c.sql));
  assert.ok(ins, 'an offer row must be inserted');
  assert.equal(ins.params[0], 100, 'offer is for the job');
  assert.equal(ins.params[1], 42, 'offer is to the tech');
  // The offer model must NOT assign/own the job or move its status.
  assert.ok(!fake.calls.some((c) => /UPDATE tbl_job SET .*fk_easyfixter_id/.test(c.sql)), 'job must stay unowned');
  assert.ok(!fake.calls.some((c) => /UPDATE tbl_job SET .*job_status/.test(c.sql)), 'job must stay BOOKED');
});

test('assign to an UNVERIFIED technician is rejected before any write (shared gate)', async () => {
  scenario.verifyRows = [];
  await assert.rejects(
    () => jobSvc.assign(100, { easyfixerId: 42 }, { user_id: 1 }),
    (e) => e.status === 400 && e.code === 'TECH_NOT_VERIFIED',
  );
  assert.ok(!wrote(), 'no write may run when assigning an unverified tech');
});

test('assign delegates to the offer model when the offer flow is on', async () => {
  // Verified tech + offer flow on → assign() routes through offerToTechnicians,
  // so the first write is an offer INSERT, not a direct UPDATE tbl_job.
  await assert.rejects(() => jobSvc.assign(100, { easyfixerId: 42 }, { user_id: 1 }));
  assert.ok(
    fake.calls.some((c) => /INSERT INTO tbl_job_offer/.test(c.sql)),
    'assign should delegate to the offer INSERT under the offer flow',
  );
});
