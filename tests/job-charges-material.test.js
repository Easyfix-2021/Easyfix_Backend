'use strict';
/*
 * Material lines at audit (2026-09-30) — legacy appCheckoutJobDetail →
 * addAndUpdateMaterial, ported to the Billing & Charges tab. Pins the three
 * things that decide what the completion ledger later pays:
 *   - the charges are units x unit price, derived server-side;
 *   - Tx above Cx is refused (a negative margin is an operator error);
 *   - an edit re-derives both charges from the edited units.
 *
 * Runner: `node --test --test-force-exit tests/job-charges-material.test.js`
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([
  [/INSERT INTO job_material/i, () => ({ insertId: 91 })],
  // editCharge's row lookup: the row is a Material line on this job.
  [/SELECT id, type, is_client_approval_needed FROM job_material/i, () => [{ id: 91, type: 'Material', is_client_approval_needed: false }]],
  [/UPDATE job_material/i, () => ({ affectedRows: 1 })],
]);
const charges = require('../services/job-charges.service');

const sqlOf = (re) => fake.calls.find((c) => re.test(c.sql));
beforeEach(() => { fake.calls.length = 0; });

test('Material is a charge type, so list / edit / approval / delete all reach its rows', () => {
  assert.ok(charges.CHARGE_TYPES.includes('Material'));
});

test('create derives tx / client charge as units x unit price', async () => {
  const out = await charges.createMaterial(7, { name: 'Pipe', unit: 3, uom: 'm', txUnit: 100, clientUnit: 150 }, 11);
  assert.deepEqual(out, { id: 91, type: 'Material' });
  const ins = sqlOf(/INSERT INTO job_material/i);
  assert.ok(ins, 'an INSERT was issued');
  assert.match(ins.sql, /'Material'/);
  // [jobId, name, description, unit, uom, txUnit, clientUnit, txCharge, clientCharge, ...]
  assert.deepEqual(ins.params.slice(0, 9), [7, 'Pipe', null, 3, 'm', 100, 150, 300, 450]);
});

test('a Tx unit price above the Cx one is refused before any write', async () => {
  await assert.rejects(
    () => charges.createMaterial(7, { name: 'Pipe', unit: 2, txUnit: 200, clientUnit: 150 }, 11),
    (e) => e.status === 400,
  );
  assert.equal(sqlOf(/INSERT INTO job_material/i), undefined, 'nothing written');
});

test('an edit re-derives both charges from the edited units', async () => {
  await charges.editCharge(7, 91, { name: 'Pipe', unit: 4, txUnit: 100, clientUnit: 150 }, 11);
  const upd = sqlOf(/UPDATE job_material/i);
  assert.ok(upd, 'an UPDATE was issued');
  assert.match(upd.sql, /tx_charge = \?, client_charge = \?/);
  assert.ok(upd.params.includes(400) && upd.params.includes(600), 'charges are 4 x 100 and 4 x 150');
});
