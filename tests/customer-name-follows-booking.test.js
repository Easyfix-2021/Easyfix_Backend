/*
 * The name typed on a booking becomes the CUSTOMER-MASTER name (2026-09-24).
 *
 * Book New Call and Confirm & Schedule show tbl_customer.customer_name and save
 * what the operator leaves there to tbl_job.job_customer_name. Until now the
 * master kept its old value, so Manage Customers, the customer lookup and every
 * other job on that mobile still read the stale name. Both screens now write it
 * through, via one guard: blank never wipes, an unchanged name writes nothing.
 *
 * The guard is asserted directly (it is exported for exactly that), and the two
 * call sites are asserted on the source — driving them through create()/update()
 * would stub half the job schema to observe three lines.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'services/job.service.js'), 'utf8');

function load() {
  const db = require(path.join(ROOT, 'db'));
  const calls = [];
  const answer = async (sql, params) => { calls.push({ sql: String(sql), params }); return [{ affectedRows: 1 }, []]; };
  db.pool.query = answer;
  delete require.cache[require.resolve(path.join(ROOT, 'services/job.service'))];
  return { calls, conn: { query: answer }, job: require(path.join(ROOT, 'services/job.service')) };
}

test('a changed name is written to tbl_customer, with who changed it', async () => {
  const { calls, conn, job } = load();
  await job.syncCustomerName(conn, { customer_id: 77, customer_name: 'Old Name' }, 'My New Name', { user_id: 42 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /UPDATE tbl_customer SET customer_name = \?, update_date = \?, updated_by = \? WHERE customer_id = \?/);
  assert.equal(calls[0].params[0], 'My New Name');
  assert.ok(calls[0].params[1] instanceof Date, 'update_date is a bound Date, never SQL NOW()');
  assert.equal(calls[0].params[2], 42);
  assert.equal(calls[0].params[3], 77);
});

test('the same name — including only spacing or case — writes nothing', async () => {
  for (const typed of ['Old Name', '  Old Name  ']) {
    const { calls, conn, job } = load();
    await job.syncCustomerName(conn, { customer_id: 77, customer_name: 'Old Name' }, typed, {});
    assert.equal(calls.length, 0, `${JSON.stringify(typed)} must not write`);
  }
  // A case-only difference IS a correction an operator may intend ("ashok" →
  // "Ashok"), so it writes — but only once, not on every save.
  const { calls, conn, job } = load();
  await job.syncCustomerName(conn, { customer_id: 77, customer_name: 'old name' }, 'Old Name', {});
  assert.equal(calls.length, 1, 'fixing the capitalisation is a real change');
});

test('a blank, whitespace or missing name never wipes the master', async () => {
  for (const typed of ['', '   ', null, undefined]) {
    const { calls, conn, job } = load();
    await job.syncCustomerName(conn, { customer_id: 77, customer_name: 'Old Name' }, typed, {});
    assert.equal(calls.length, 0, `${JSON.stringify(typed)} must not reach tbl_customer`);
  }
});

test('both booking paths call it — Book New Call (upsertCustomer) and Confirm & Schedule (update)', () => {
  const upsert = SRC.slice(SRC.indexOf('async function upsertCustomer('), SRC.indexOf('async function create('));
  assert.equal((upsert.match(/syncCustomerName\(/g) || []).length, 2,
    'both the customer_id branch and the by-mobile branch must sync the name');
  assert.match(SRC, /if \(custRow\) await syncCustomerName\(conn, custRow, input\.job_customer_name, actor\);/,
    'Confirm & Schedule must sync the job name to the master');
});
