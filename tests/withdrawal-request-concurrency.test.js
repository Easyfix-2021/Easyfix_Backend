const test = require('node:test');
const assert = require('node:assert/strict');

const withdrawal = require('../services/withdrawal.service');

function fakePool({
  openRequest = null,
  lifecycleStatus = 'ACTIVE',
  balance = 500,
} = {}) {
  const calls = [];
  const conn = {
    committed: false,
    rolledBack: false,
    released: false,
    async beginTransaction() { calls.push({ kind: 'begin' }); },
    async commit() { this.committed = true; calls.push({ kind: 'commit' }); },
    async rollback() { this.rolledBack = true; calls.push({ kind: 'rollback' }); },
    release() { this.released = true; calls.push({ kind: 'release' }); },
    async query(sql, params) {
      calls.push({ kind: 'query', sql, params });
      if (/SELECT current_balance/.test(sql)) {
        return [[{ current_balance: balance, lifecycle_status: lifecycleStatus }]];
      }
      if (/SELECT d\.efr_bank_id/.test(sql)) {
        return [[{
          efr_bank_id: 12,
          efr_bank_acc_num: '1234567890',
          efr_bank_acc_name: 'Test Technician',
          efr_bank_ifsc: 'HDFC0001234',
          bank_id: 3,
          bank_name: 'HDFC Bank',
        }]];
      }
      if (/SELECT request_id/.test(sql)) return [[openRequest]];
      if (/INSERT INTO tbl_easyfixer_withdrawal_request/.test(sql)) {
        return [{ insertId: 44, affectedRows: 1 }];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return {
    calls,
    conn,
    async getConnection() { return conn; },
  };
}

test('withdrawal creation serializes on technician without inverting finance lock order', async () => {
  const db = fakePool();
  const result = await withdrawal.requestWithdrawal(7, { amount: 100 }, db);
  assert.equal(result.requestId, 44);
  assert.equal(db.conn.committed, true);

  const queries = db.calls.filter((call) => call.kind === 'query');
  assert.match(queries[0].sql, /tbl_easyfixer[\s\S]*FOR UPDATE/);
  const pendingRead = queries.find((call) => /SELECT request_id/.test(call.sql));
  assert.ok(pendingRead);
  assert.doesNotMatch(pendingRead.sql, /FOR UPDATE/);
  assert.ok(
    queries.findIndex((call) => /SELECT current_balance/.test(call.sql))
      < queries.findIndex((call) => /SELECT request_id/.test(call.sql)),
  );
});

test('pending withdrawal rolls back and never inserts another open request', async () => {
  const db = fakePool({ openRequest: { request_id: 19 } });
  await assert.rejects(
    withdrawal.requestWithdrawal(7, { amount: 100 }, db),
    (error) => error.code === 'WITHDRAWAL_PENDING' && error.status === 409,
  );
  assert.equal(db.conn.rolledBack, true);
  assert.equal(
    db.calls.some((call) => call.kind === 'query'
      && /INSERT INTO tbl_easyfixer_withdrawal_request/.test(call.sql)),
    false,
  );
});

test('blacklisted withdrawal must settle the full locked wallet balance', async () => {
  const db = fakePool({ lifecycleStatus: 'BLACKLISTED', balance: 500 });
  await assert.rejects(
    withdrawal.requestWithdrawal(7, { amount: 100 }, db),
    (error) => error.code === 'FULL_BALANCE_REQUIRED' && error.status === 400,
  );
  assert.equal(db.conn.rolledBack, true);
  assert.equal(
    db.calls.some((call) => call.kind === 'query'
      && /INSERT INTO tbl_easyfixer_withdrawal_request/.test(call.sql)),
    false,
  );
});

test('blacklisted full-balance request snapshots its payout destination', async () => {
  const db = fakePool({ lifecycleStatus: 'BLACKLISTED', balance: 500 });
  const result = await withdrawal.requestWithdrawal(7, { amount: 500 }, db);
  assert.equal(result.amount, 500);
  const insert = db.calls.find((call) => call.kind === 'query'
    && /INSERT INTO tbl_easyfixer_withdrawal_request/.test(call.sql));
  assert.ok(insert);
  assert.match(insert.sql, /bank_account_number/);
  assert.deepEqual(insert.params, [
    7,
    500,
    12,
    '1234567890',
    'HDFC0001234',
    'Test Technician',
    3,
    'HDFC Bank',
  ]);
});

function fakeFinancePool({ destinationComplete = true } = {}) {
  const calls = [];
  const request = {
    request_id: 44,
    fk_easyfixer_id: 7,
    amount: 500,
    status: 'requested',
    bank_account_number: destinationComplete ? '1234567890' : null,
    bank_ifsc: destinationComplete ? 'HDFC0001234' : null,
    bank_account_holder_name: destinationComplete ? 'Test Technician' : null,
  };
  const conn = {
    rolledBack: false,
    released: false,
    async beginTransaction() { calls.push({ kind: 'begin' }); },
    async commit() { calls.push({ kind: 'commit' }); },
    async rollback() { this.rolledBack = true; calls.push({ kind: 'rollback' }); },
    release() { this.released = true; calls.push({ kind: 'release' }); },
    async query(sql, params) {
      calls.push({ kind: 'query', sql, params });
      if (/FROM tbl_easyfixer_withdrawal_request[\s\S]*FOR UPDATE/.test(sql)) {
        return [[request]];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return {
    calls,
    conn,
    async getConnection() { return conn; },
  };
}

test('finance request selection returns the immutable payout destination', async () => {
  const calls = [];
  const db = {
    async query(sql) {
      calls.push(sql);
      if (/COUNT\(\*\)/.test(sql)) return [[{ total: 0 }]];
      return [[]];
    },
  };

  await withdrawal.listWithdrawalRequests({}, db);
  const listSql = calls.find((sql) => /ORDER BY w\.request_id DESC/.test(sql));
  assert.ok(listSql);
  assert.match(listSql, /w\.bank_details_id/);
  assert.match(listSql, /w\.bank_account_number/);
  assert.match(listSql, /w\.bank_ifsc/);
  assert.match(listSql, /w\.bank_account_holder_name/);
  assert.match(listSql, /w\.bank_id/);
  assert.match(listSql, /w\.bank_name/);
});

test('finance cannot mark a request paid without a complete snapshotted destination', async () => {
  const db = fakeFinancePool({ destinationComplete: false });
  await assert.rejects(
    withdrawal.processWithdrawal(44, { action: 'pay' }, { user_id: 9 }, db),
    (error) => error.code === 'PAYOUT_DESTINATION_MISSING' && error.status === 409,
  );
  assert.equal(db.conn.rolledBack, true);
  assert.equal(
    db.calls.some((call) => call.kind === 'query'
      && /tbl_easyfixer_bank_details/.test(call.sql)),
    false,
  );
  assert.equal(
    db.calls.some((call) => call.kind === 'query'
      && /UPDATE tbl_easyfixer SET current_balance/.test(call.sql)),
    false,
  );
});
