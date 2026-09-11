/*
 * The cash-on-delivery (COD) gate: when the customer pays the technician on
 * site, the technician must hold at least the balance floor.
 *
 * Product decision 2026-09-11: EITHER signal makes a job COD —
 *   tbl_job.paid_by = 2 (Customer)  OR  tbl_job.collected_by = 1 ("Paid By Customer").
 * The gate used to read paid_by alone; on QA only 3,449 of the 82,371
 * collected_by = 1 jobs also carry paid_by = 2, so it almost never ran.
 *
 * Both gate sites are driven at RUNTIME through the real pipeline:
 *   - the Top-10 hard filter (rankCandidatesForJob, enforceCodBalance: true)
 *   - the auto-assign pick (pickAutoAssignCandidate, called exactly the way
 *     services/auto-assign.service.js calls it — paidBy only)
 * and both share ONE floor boundary: balance >= floor passes.
 * Fake pool, no DB.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const HIGH = {
  efr_id: 11,
  efr_name: 'Cash Tech',
  efr_no: '9000000011',
  efr_email: 'cash@example.test',
  efr_cityId: 5,
  city_name: 'Gurugram',
  current_balance: 1000,
  efr_status: 1,
  is_technician_verified: 1,
  efr_manager_id: null,
  lifecycle_status: 'ACTIVE',
  lifecycle_reason_code: null,
  lifecycle_reason: null,
  lifecycle_version: 3,
};
// Listed FIRST so it is the top rank — balance is never a sort input — which
// is what makes the auto-assign pick's walk down the list observable.
const LOW = { ...HIGH, efr_id: 12, efr_name: 'Broke Tech', efr_no: '9000000012', current_balance: 100 };

// The eligible set a test ranks over; the floor tests swap it and restore it.
let techs = [LOW, HIGH];
const fake = installFakePool([
  [/FROM information_schema\.columns/i, [{ column_count: 6, history_count: 1 }]],
  [/FROM tbl_easyfixer e[\s\S]*scheduling_history sh/, () => techs],
  // diagnoseEmptyPool's city headcount — without it an emptied list reads as
  // "no technician in this city" and never reaches the per-reason grouping.
  [/COUNT\(\*\) AS cityPool/, [{ cityPool: 2, withSkill: 2, openOffer: 0, declined: 0, removedEarlier: 0 }]],
]);

const ranking = require('../services/candidate-ranking.service');

const { customerPays } = ranking._internals;

const job = (overrides) => ({
  job_id: 700,
  fk_client_id: 30,
  fk_easyfixter_id: null,
  requested_date_time: null,
  time_slot: null,
  city_id: 5,
  pin_code: null,
  ...overrides,
});

beforeEach(() => { fake.reset(); });

/*
 * Every payment shape, with the answer customerPays must give. The gate tests
 * below drive EACH of these through both gate sites and require the gate to
 * agree with customerPays — so a second, hand-rolled rule in either site fails
 * wherever it disagrees, however it is spelled. (That replaced a source-text
 * regex over the two function bodies, which `Number(job.collected_by) === 1`
 * or an alias slipped straight past.)
 */
const PAY_CASES = [
  [{ paid_by: 2, collected_by: 2 }, true, 'paid_by = 2 alone'],
  [{ paid_by: 0, collected_by: 1 }, true, 'collected_by = 1 alone'],
  [{ paid_by: 2, collected_by: 1 }, true, 'both'],
  // The signals CONFLICT (paid_by says Client, collected_by says the customer
  // pays) — decided 2026-09-11: either signal is enough, so this is COD.
  [{ paid_by: 1, collected_by: 1 }, true, 'conflicting: paid_by = 1 (Client) + collected_by = 1'],
  [{ paid_by: 1, collected_by: 2 }, false, 'neither (client pays, free for customer)'],
  [{ paid_by: 0, collected_by: 0 }, false, 'neither (unset)'],
  [{ paid_by: 0, collected_by: 3 }, false, 'client collects'],
  [{ paid_by: null, collected_by: null }, false, 'both null'],
  [{ paid_by: null, collected_by: 1 }, true, 'paid_by null, collected_by 1'],
  [{}, false, 'both absent'],
  [null, false, 'no job'],
  [undefined, false, 'undefined job'],
  [{ paid_by: '0', collected_by: '1' }, true, "collected_by string '1'"],
  [{ paid_by: '2', collected_by: '0' }, true, "paid_by string '2'"],
  [{ paid_by: 0, collected_by: '' }, false, 'collected_by empty string'],
  [{ paid_by: 'Customer', collected_by: null }, true, 'legacy paid_by label'],
];

test('customerPays: paid_by = 2 OR collected_by = 1, null-safe', () => {
  for (const [input, expected, label] of PAY_CASES) {
    assert.equal(customerPays(input), expected, label);
  }
});

test('Top-10 COD filter drops the low-balance technician exactly when customerPays', async () => {
  for (const [pay, cod, label] of PAY_CASES) {
    // Same COD flag as the Schedule & Assign Top-10 route (routes/admin/jobs.js).
    const result = await ranking.rankCandidatesForJob(700, {
      preloadedJob: job(pay), limit: 10, enforceMaxConcurrent: false, enforceCodBalance: true, softAttendance: true,
    });
    assert.deepEqual(result.candidates.map((c) => c.efr_id), cod ? [11] : [12, 11], label);
    const codDrops = result.rejected.filter((r) => /^COD job/.test(r.reason)).map((r) => r.efr_id);
    assert.deepEqual(codDrops, cod ? [12] : [], label + ' (rejected reason)');
  }
});

test('auto-assign pick: the auto-assign call shape skips to balance exactly when customerPays', async () => {
  for (const [pay, cod, label] of PAY_CASES) {
    // Exactly services/auto-assign.service.js: rank with defaults, then pass paidBy only.
    const result = await ranking.rankCandidatesForJob(700, { preloadedJob: job(pay), limit: 50 });
    assert.equal(result.candidates[0].efr_id, 12, label + ': the low-balance tech is the top rank');
    const pick = ranking.pickAutoAssignCandidate(result, { paidBy: result.job.paid_by });
    assert.equal(pick.candidate.efr_id, cod ? 11 : 12, label);
    assert.equal(pick.reason, cod ? 'top_rank_with_balance' : 'top_rank', label);
  }
});

/*
 * The floor is "₹500+" (the Schedule & Assign tooltip): balance >= floor passes
 * BOTH gates. The Top-10 used to reject AT the floor while auto-assign accepted
 * it, so a ₹500.00 tech was hidden from ops but auto-assignable. DECIMAL(25,2)
 * arrives from mysql2 as a string, hence '500.00'.
 */
test('the floor itself passes both gates; a paisa under it passes neither', async () => {
  const AT = { ...LOW, efr_id: 13, efr_name: 'Floor Tech', efr_no: '9000000013', current_balance: '500.00' };
  const UNDER = { ...LOW, efr_id: 14, efr_name: 'Short Tech', efr_no: '9000000014', current_balance: '499.99' };
  const cod = job({ paid_by: 2, collected_by: 2 });
  techs = [UNDER, AT]; // UNDER listed first → the top rank, so the pick has to walk past it
  try {
    const top10 = await ranking.rankCandidatesForJob(700, {
      preloadedJob: cod, limit: 10, enforceMaxConcurrent: false, enforceCodBalance: true, softAttendance: true,
    });
    assert.deepEqual(top10.candidates.map((c) => c.efr_id), [13], 'the tech AT the floor stays in the Top-10');
    assert.deepEqual(top10.rejected.filter((r) => /^COD job/.test(r.reason)).map((r) => [r.efr_id, r.reason]),
      [[14, 'COD job: balance below floor (499.99 < 500)']]);

    const ranked = await ranking.rankCandidatesForJob(700, { preloadedJob: cod, limit: 50 });
    const pick = ranking.pickAutoAssignCandidate(ranked, { paidBy: ranked.job.paid_by });
    assert.equal(pick.candidate.efr_id, 13, 'auto-assign picks the tech AT the floor');
    assert.equal(pick.reason, 'top_rank_with_balance');
  } finally { techs = [LOW, HIGH]; }
});

test('an emptied COD Top-10 explains itself in ONE line, not one per balance', async () => {
  techs = [LOW, { ...LOW, efr_id: 15, efr_name: 'Other Broke Tech', efr_no: '9000000015', current_balance: '250.00' }];
  try {
    const result = await ranking.rankCandidatesForJob(700, {
      preloadedJob: job({ paid_by: 0, collected_by: 1 }), limit: 10, enforceMaxConcurrent: false, enforceCodBalance: true, softAttendance: true,
    });
    assert.deepEqual(result.candidates, []);
    assert.equal(result.emptyReason.code, 'filtered_out');
    assert.equal(result.emptyReason.message, '2 technicians matched this job but were excluded: 2 COD job: balance below floor.');
  } finally { techs = [LOW, HIGH]; }
});
