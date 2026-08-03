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

/*
 * ─── time_slot IS ALWAYS A BAND ──────────────────────────────────────
 *
 * The whole point of the 2026-07-31 rework: whatever slot vocabulary a caller
 * arrives with, tbl_job.time_slot receives one of exactly four broad bands, and
 * the 1-hour frame the operator/customer picked survives as the appointment
 * time-of-day (requested_date_time + requested_time). See services/time-slot.js.
 *
 * The INSERT's positional params are asserted by VALUE rather than index — the
 * shared column list is long and an index would be brittle — so these read the
 * band out of the captured params and assert on the SET as a whole.
 */
const BANDS = ['9AM to 12PM', '12PM to 3PM', '3PM to 7PM', 'After Hours'];

async function createWith(extra) {
  fake.reset();
  await assert.rejects(() => jobSvc.create({ ...VALID_INPUT(), ...extra }, { user_id: 1 }));
  const ins = fake.calls.find((c) => /INSERT INTO tbl_job\b/.test(c.sql));
  assert.ok(ins, 'the job row must be inserted');
  return ins.params;
}

test('create stores a BAND in time_slot even when the caller sends a 1-hour frame', async () => {
  // The Book-New-Call shape: a date-only UTC ISO plus the IST wall-clock time
  // in requested_time, which combineDateTime() splices into the DATETIME.
  const params = await createWith({
    requested_date_time: '2026-08-05T00:00:00.000Z',
    requested_time: '15:00',
    time_slot: '3 PM–4 PM',
  });
  assert.ok(params.includes('3PM to 7PM'), 'the containing band is stored');
  assert.ok(!params.includes('3 PM–4 PM'), 'the 1-hour frame label must never reach tbl_job.time_slot');
});

test('create derives the band from the appointment time when no slot is sent', async () => {
  const params = await createWith({
    requested_date_time: '2026-08-05T00:00:00.000Z',
    requested_time: '10:30',
  });
  assert.ok(params.includes('9AM to 12PM'));
});

test('create never writes any of the retired backend band labels', async () => {
  for (const hour of ['09:30', '11:30', '12:30', '14:30', '15:30', '18:30', '21:00', '03:00']) {
    const params = await createWith({
      requested_date_time: '2026-08-05T00:00:00.000Z',
      requested_time: hour,
      time_slot: 'Morning 9 to 2',   // a caller still speaking the legacy vocabulary
    });
    for (const retired of ['Morning 9 to 2', 'Evening 2 to 7', 'Afternoon 12 to 5']) {
      assert.ok(!params.includes(retired), `${hour} wrote the retired label ${retired}`);
    }
    assert.ok(params.some((p) => BANDS.includes(p)), `${hour} wrote no canonical band`);
  }
});
