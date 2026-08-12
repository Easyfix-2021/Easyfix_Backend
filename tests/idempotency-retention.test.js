const { test } = require('node:test');
const assert = require('node:assert/strict');

const retention = require('../services/idempotency-retention.service');

test('deletes one expiry-indexed bounded batch', async () => {
  const calls = [];
  const database = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      return [{ affectedRows: 73 }, []];
    },
  };

  const result = await retention.deleteExpired({ limit: 250, database });
  assert.deepEqual(result, { deleted: 73, limit: 250 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /WHERE expires_at <= NOW\(\)/i);
  assert.match(calls[0].sql, /ORDER BY expires_at ASC\s+LIMIT \?/i);
  assert.deepEqual(calls[0].params, [250]);
});

test('caps an excessive retention batch at the hard maximum', async () => {
  let params;
  const database = {
    async query(_sql, values) {
      params = values;
      return [{ affectedRows: 0 }, []];
    },
  };

  const result = await retention.deleteExpired({ limit: 999999, database });
  assert.equal(result.limit, retention.MAX_BATCH_SIZE);
  assert.deepEqual(params, [retention.MAX_BATCH_SIZE]);
});

test('scheduled cleanup is single-owner across backend replicas', async () => {
  const calls = [];
  const connection = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (/GET_LOCK/i.test(sql)) return [[{ acquired: 1 }], []];
      if (/^\s*DELETE FROM tbl_idempotency_key/i.test(sql)) return [{ affectedRows: 12 }, []];
      if (/RELEASE_LOCK/i.test(sql)) return [[{ released: 1 }], []];
      throw new Error(`unexpected SQL: ${sql}`);
    },
    release() { calls.push({ sql: 'RELEASE_CONNECTION' }); },
  };
  const database = { async getConnection() { return connection; } };

  const result = await retention.run({ limit: 25, database });
  assert.deepEqual(result, {
    deleted: 12,
    batches: 1,
    maxRows: retention.DEFAULT_MAX_ROWS_PER_RUN,
    maxDurationMs: retention.DEFAULT_MAX_DURATION_MS,
    skipped: false,
  });
  assert.match(calls[0].sql, /GET_LOCK/i);
  assert.match(calls.at(-2).sql, /RELEASE_LOCK/i);
  assert.equal(calls.at(-1).sql, 'RELEASE_CONNECTION');
});

test('drains full batches only up to the per-run row budget', async () => {
  let deletes = 0;
  const database = {
    async query(_sql, [limit]) {
      deletes += 1;
      return [{ affectedRows: limit }, []];
    },
  };

  const result = await retention.drainExpired({
    limit: 1000,
    maxRows: 2500,
    maxDurationMs: 2000,
    database,
    now: () => 0,
  });
  assert.deepEqual(result, { deleted: 2500, batches: 3, maxRows: 2500, maxDurationMs: 2000 });
  assert.equal(deletes, 3);
});
