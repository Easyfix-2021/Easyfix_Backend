const test = require('node:test');
const assert = require('node:assert/strict');

const withdrawal = require('../services/withdrawal.service');

function fakePool({ openRequest = null } = {}) {
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
      if (/SELECT current_balance/.test(sql)) return [[{ current_balance: 500 }]];
      if (/SELECT efr_bank_id/.test(sql)) return [[{ efr_bank_id: 12 }]];
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
