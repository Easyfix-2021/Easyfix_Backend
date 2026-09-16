/*
 * processWithdrawal's PAY branch (2026-09-16).
 *
 * It wrote a real ledger row and debited the wallet, but outside the ledger
 * protocol: no named lock at all, the row's `balance` taken from the
 * current_balance CACHE after a relative `current_balance - ?`, and `source`
 * bound as the STRING 'WITHDRAWAL' into a tinyint column that non-strict
 * sql_mode silently stored as 0.
 *
 * processWithdrawal takes its pool by INJECTION, so these tests hand it the
 * fake directly — no monkeypatch, and the injection contract is part of what is
 * asserted (the shared ledger helpers take the connection as a parameter).
 *
 * Runner: `node --test` (see npm test).
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { makeFakePool } = require('./helpers/fake-pool');
const { processWithdrawal } = require('../services/withdrawal.service');

const S = {
  request: { request_id: 3, fk_easyfixer_id: 7, amount: '100.00', status: 'requested',
    bank_account_number: '123456789', bank_ifsc: 'HDFC0000123', bank_account_holder_name: 'Asha R' },
  cache: [{ current_balance: '1000.00' }],
  tail: [{ balance: '900.00' }],
  tech: [{ efr_id: 7 }],
};

let fake;
let destroyed;
function pool() {
  fake = makeFakePool([
    [/@@SESSION\.innodb_lock_wait_timeout/i, () => [{ wait: 50 }]],
    [/GET_LOCK/i, () => [{ got: 1 }]],
    [/RELEASE_LOCK/i, () => [{ released: 1 }]],
    [/FROM tbl_easyfixer_withdrawal_request\s+WHERE request_id = \? FOR UPDATE/i, () => (S.request ? [S.request] : [])],
    [/SELECT current_balance FROM tbl_easyfixer WHERE efr_id = \? FOR UPDATE/i, () => S.cache],
    [/SELECT efr_id FROM tbl_easyfixer WHERE efr_id = \? FOR UPDATE/i, () => S.tech],
    [/FROM tbl_easyfixer_transaction WHERE easyfixer_id = \? ORDER BY/i, () => S.tail],
    [/^\s*INSERT INTO tbl_easyfixer_transaction/i, () => ({ insertId: 91 })],
    [/^\s*UPDATE tbl_easyfixer SET current_balance/i, () => ({ affectedRows: 1 })],
    [/^\s*UPDATE tbl_easyfixer_withdrawal_request/i, () => ({ affectedRows: 1 })],
    [/^\s*SELECT/i, () => [{ request_id: 3, status: 'paid' }]],
  ]);
  destroyed = 0;
  const inner = fake.pool.getConnection;
  // The service destroys a connection whose lock release failed; the fake's
  // connection has no destroy(), so add one and count it.
  fake.pool.getConnection = async () => Object.assign(await inner(), { destroy() { destroyed += 1; } });
  return fake.pool;
}

const find = (re) => fake.calls.find((c) => re.test(c.sql));
const idx = (re) => fake.calls.findIndex((c) => re.test(c.sql));

beforeEach(() => {
  S.request = { request_id: 3, fk_easyfixer_id: 7, amount: '100.00', status: 'requested',
    bank_account_number: '123456789', bank_ifsc: 'HDFC0000123', bank_account_holder_name: 'Asha R' };
  S.cache = [{ current_balance: '1000.00' }];
  S.tail = [{ balance: '900.00' }];
  S.tech = [{ efr_id: 7 }];
});

test('the payout row takes its balance from the LEDGER TAIL, and the cache follows it', async () => {
  await processWithdrawal(3, { action: 'pay' }, { user_id: 12 }, pool());
  const ins = find(/INSERT INTO tbl_easyfixer_transaction/i);
  assert.ok(ins, 'a ledger row must be written');
  // (easyfixer_id, source, description, transaction_type, transaction_date, amount, balance, created_date, created_by, job_id)
  assert.equal(ins.params[3], 1, 'DEBIT');
  assert.equal(ins.params[5], 100, 'amount is the magnitude');
  assert.equal(ins.params[6], 800, 'tail 900 − 100. It used to be 900 — the cache after a relative debit');
  const cache = find(/UPDATE tbl_easyfixer SET current_balance/i);
  assert.ok(cache, 'the cache must be re-pointed');
  assert.equal(cache.params[0], 800);
  assert.ok(!/current_balance = current_balance/i.test(cache.sql), 'absolute, not relative');
});

test('source is the integer 4, never the string that a tinyint silently stored as 0', async () => {
  await processWithdrawal(3, { action: 'pay' }, { user_id: 12 }, pool());
  const ins = find(/INSERT INTO tbl_easyfixer_transaction/i);
  assert.equal(ins.params[1], 4, "4 = PayOut, what sp_ef_approve_payout_by_finance itself stamps");
  assert.ok(!ins.params.some((p) => p === 'WITHDRAWAL'), 'no string may reach tbl_easyfixer_transaction.source');
  assert.ok(!/'WITHDRAWAL'/.test(ins.sql), 'nor as a SQL literal, which is how it used to be written');
});

test('lock order: the request row, then THE ledger lock, then the wallet row, then the tail', async () => {
  await processWithdrawal(3, { action: 'pay' }, { user_id: 12 }, pool());
  const order = [
    idx(/FROM tbl_easyfixer_withdrawal_request\s+WHERE request_id = \? FOR UPDATE/i),
    idx(/GET_LOCK/i),
    idx(/SELECT current_balance FROM tbl_easyfixer WHERE efr_id = \? FOR UPDATE/i),
    idx(/FROM tbl_easyfixer_transaction WHERE easyfixer_id = \? ORDER BY/i),
    idx(/INSERT INTO tbl_easyfixer_transaction/i),
  ];
  assert.ok(order.every((i) => i >= 0), `every step must run: ${order.join(',')}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), `wrong order: ${order.join(',')}`);
  assert.equal(find(/GET_LOCK/i).params[0], 'easyfix:completion-ledger', 'THE ledger lock, shared with completions');
  assert.ok(idx(/RELEASE_LOCK/i) > idx(/INSERT INTO tbl_easyfixer_transaction/i),
    'released after the write — a lock left held travels to the next borrower of this connection');
});

test('the tail read is locking — a plain read answers from a pre-lock snapshot', async () => {
  await processWithdrawal(3, { action: 'pay' }, { user_id: 12 }, pool());
  const tail = find(/FROM tbl_easyfixer_transaction WHERE easyfixer_id = \? ORDER BY/i);
  assert.ok(tail);
  assert.match(tail.sql, /FOR UPDATE\s*$/i);
});

test('a rejection moves no money and takes no money mutex', async () => {
  await processWithdrawal(3, { action: 'reject', remarks: 'bank details wrong' }, { user_id: 12 }, pool());
  assert.equal(find(/GET_LOCK/i), undefined, 'the reject branch must not serialise behind every completion');
  assert.equal(find(/INSERT INTO tbl_easyfixer_transaction/i), undefined);
  assert.equal(find(/UPDATE tbl_easyfixer SET current_balance/i), undefined);
  // The release is still safe to call on a lock that was never taken.
  assert.ok(find(/RELEASE_LOCK/i), 'release runs unconditionally, and is documented as safe either way');
  assert.equal(destroyed, 0, 'a healthy connection goes back to the pool');
});

test('insufficient funds refuse the payout before anything is written', async () => {
  S.cache = [{ current_balance: '50.00' }];
  await assert.rejects(
    () => processWithdrawal(3, { action: 'pay' }, { user_id: 12 }, pool()),
    (e) => e.status === 400 && /Insufficient balance/.test(e.message),
  );
  assert.equal(find(/INSERT INTO tbl_easyfixer_transaction/i), undefined);
  assert.ok(find(/RELEASE_LOCK/i), 'the lock taken before the funds check must still be released');
});

test('a technician row that vanishes between the two locks refuses the payout', async () => {
  S.tech = [];                       // the ledger helper finds no row to post against
  await assert.rejects(
    () => processWithdrawal(3, { action: 'pay' }, { user_id: 12 }, pool()),
    (e) => e.status === 404,
  );
  assert.equal(find(/INSERT INTO tbl_easyfixer_transaction/i), undefined);
});

test('an already-processed request is still refused (control — this guard predates the change)', async () => {
  S.request.status = 'paid';
  await assert.rejects(
    () => processWithdrawal(3, { action: 'pay' }, { user_id: 12 }, pool()),
    (e) => e.status === 409,
  );
  assert.equal(find(/GET_LOCK/i), undefined, 'refused before the ledger lock is taken');
});
