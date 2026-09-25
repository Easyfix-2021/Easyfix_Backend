/*
 * tests/v3p3-settle-payout.test.js — the technician is PAID for additional work
 * the client approves (V3 3.3), and the client is not billed twice for it.
 *
 * The gap this closes: the desk prices additional work into a quotation_details
 * line (so the client's existing estimate-approve flow can act on it), but the
 * completion ledger reads service lines and job_material only — so the
 * technician's tx_charge never reached his wallet. settleAdditionalWork now
 * writes a system job_material row on approval: tx_charge = his share,
 * client_charge = 0, because finance.js already invoices the approved
 * quotation line to the client.
 *
 * Runner: npx node --test --test-force-exit tests/v3p3-settle-payout.test.js
 */
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const scenario = { priced: null, updateRows: 1, insertRows: 1 };

const fake = installFakePool([
  [/SELECT id, tx_amount FROM tbl_job_tx_report/i, () => (scenario.priced ? [scenario.priced] : [])],
  [/UPDATE tbl_job_tx_report SET status/i, () => ({ affectedRows: scenario.updateRows })],
  [/INSERT INTO job_material/i, () => ({ affectedRows: scenario.insertRows })],
  [/INSERT\s+INTO\s+tbl_job_logs/i, () => ({ insertId: 1 })],
]);

const opsDesk = require('../services/ops-desk.service');
const incentives = require('../services/job-incentive.service');

after(() => fake.restore());
beforeEach(() => {
  fake.calls.length = 0;
  scenario.priced = { id: 71, tx_amount: 1000 };
  scenario.updateRows = 1;
  scenario.insertRows = 1;
});

const payouts = () => fake.calls.filter((c) => /INSERT INTO job_material/i.test(c.sql));

test('approval pays his share into job_material, and bills the client nothing there', async () => {
  assert.equal(await opsDesk.settleAdditionalWork(42, true, { user_id: 9 }), true);
  const p = payouts();
  assert.equal(p.length, 1, 'exactly one pay-out row');
  const [jobId, reason, tx, client] = p[0].params;
  assert.equal(jobId, 42);
  assert.equal(tx, 1000, "the technician's share");
  assert.equal(client, 0, 'client billed by the invoice from the quotation line, never twice');
  assert.match(reason, /Additional work approved \(system\) · report 71/);
});

test('a rejection closes the claim and pays nothing', async () => {
  assert.equal(await opsDesk.settleAdditionalWork(42, false, { user_id: 9 }), true);
  assert.equal(payouts().length, 0);
});

test('no priced claim on the job: nothing settles, nothing is paid', async () => {
  scenario.priced = null;
  assert.equal(await opsDesk.settleAdditionalWork(42, true, { user_id: 9 }), false);
  assert.equal(payouts().length, 0);
  assert.equal(fake.calls.filter((c) => /UPDATE tbl_job_tx_report/i.test(c.sql)).length, 0);
});

test('the approve path that loses the race to another settles nothing and pays nothing', async () => {
  // Portal + magic link + CRM on-behalf can all fire; the guarded UPDATE
  // (status = 'priced') lets exactly one through.
  scenario.updateRows = 0;
  assert.equal(await opsDesk.settleAdditionalWork(42, true, { user_id: 9 }), false);
  assert.equal(payouts().length, 0);
});

test('the pay-out is keyed on the report, so a retry cannot pay twice', async () => {
  await incentives.awardAdditionalWork(42, { reportId: 71, txCharge: 1000, actorId: 9 });
  const sql = payouts()[0].sql;
  assert.match(sql, /WHERE NOT EXISTS/i, 'single-statement insert-if-absent, like the ₹250');
  assert.equal(payouts()[0].params.at(-1), 'Additional work approved (system) · report 71');
});

test('an unpriced or zero share writes no row', async () => {
  for (const tx of [0, null, -5, 'abc']) {
    fake.calls.length = 0;
    const r = await incentives.awardAdditionalWork(42, { reportId: 71, txCharge: tx, actorId: 9 });
    assert.equal(r.awarded, false, 'tx=' + tx);
    assert.equal(payouts().length, 0);
  }
});
