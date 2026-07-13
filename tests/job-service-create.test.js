/*
 * Characterization tests for job.service.create — the Book-New-Call write path.
 * Pins the "customer_id supplied but not found" 400 guard and that a valid input
 * reaches the tbl_job INSERT carrying the given customer + address FKs.
 *
 * To make the tbl_job INSERT the first write, we pass a pre-existing customer_id
 * + address_id + job_client_owner + branch_details so the sub-inserts / SPOC
 * lookup / branch-mandatory check are all skipped.
 *
 * Non-destructive: fake pool, STOP-sentinel at the first write, no real DB.
 * Runner: `node --test`.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const DEFAULTS = () => ({ customerRows: [{ customer_id: 7 }] });
const scenario = DEFAULTS();

const VALID_INPUT = () => ({
  customer: { customer_id: 7 },
  address: { address_id: 55 },
  job_client_owner: 9,   // skip the SPOC lookup
  branch_details: 'B1',  // skip the branch-mandatory client.service call
  fk_client_id: 30,
});

const fake = installFakePool(
  [
    [/INFORMATION_SCHEMA/i, [{ n: 0 }]],
    [/SHOW COLUMNS/i, []],
    [/SELECT customer_id FROM tbl_customer WHERE customer_id/, () => scenario.customerRows],
  ],
  { stopOn: /INSERT INTO tbl_job\b/ }, // \b excludes tbl_job_services / tbl_job_image
);

const jobSvc = require('../services/job.service');

beforeEach(() => { fake.reset(); Object.assign(scenario, DEFAULTS()); });

test('create with a customer_id that does not exist is rejected 400', async () => {
  scenario.customerRows = []; // upsertCustomer can't find the supplied id
  await assert.rejects(
    () => jobSvc.create(VALID_INPUT(), { user_id: 1 }),
    (e) => e.status === 400,
  );
  assert.ok(!fake.calls.some((c) => /INSERT INTO tbl_job\b/.test(c.sql)), 'no job row on a bad customer id');
});

test('valid create reaches the tbl_job INSERT with the given customer + address FKs', async () => {
  await assert.rejects(() => jobSvc.create(VALID_INPUT(), { user_id: 1 }));
  const ins = fake.calls.find((c) => /INSERT INTO tbl_job\b/.test(c.sql));
  assert.ok(ins, 'the job row must be inserted');
  assert.equal(ins.params[1], 7, 'fk_customer_id is the resolved customer');
  assert.equal(ins.params[2], 55, 'fk_address_id is the supplied address');
});
