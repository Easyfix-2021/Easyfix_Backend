const test = require('node:test');
const assert = require('node:assert/strict');

const { withMysqlNamedLock } = require('../services/mysql-named-lock.service');

function fakePool(acquired) {
  const calls = [];
  let releasedConnection = false;
  const conn = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (/GET_LOCK/i.test(sql)) return [[{ acquired: acquired ? 1 : 0 }]];
      if (/RELEASE_LOCK/i.test(sql)) return [[{ released: 1 }]];
      throw new Error('unexpected query');
    },
    release() { releasedConnection = true; },
  };
  return {
    async getConnection() { return conn; },
    calls,
    releasedConnection: () => releasedConnection,
  };
}

test('named lock skips immediately when another replica owns it', async () => {
  const db = fakePool(false);
  let ran = false;
  const result = await withMysqlNamedLock('easyfix:test', async () => {
    ran = true;
  }, db);
  assert.deepEqual(result, { acquired: false, result: null });
  assert.equal(ran, false);
  assert.equal(db.calls.filter((call) => /GET_LOCK/i.test(call.sql)).length, 1);
  assert.equal(db.calls.some((call) => /RELEASE_LOCK/i.test(call.sql)), false);
  assert.equal(db.releasedConnection(), true);
});

test('named lock releases on success', async () => {
  const db = fakePool(true);
  const result = await withMysqlNamedLock(
    'easyfix:test',
    async () => ({ transitioned: 2 }),
    db,
  );
  assert.deepEqual(result, { acquired: true, result: { transitioned: 2 } });
  assert.equal(db.calls.filter((call) => /RELEASE_LOCK/i.test(call.sql)).length, 1);
  assert.equal(db.releasedConnection(), true);
});

test('named lock releases when the cron body throws', async () => {
  const db = fakePool(true);
  await assert.rejects(
    withMysqlNamedLock('easyfix:test', async () => {
      throw new Error('boom');
    }, db),
    /boom/,
  );
  assert.equal(db.calls.filter((call) => /RELEASE_LOCK/i.test(call.sql)).length, 1);
  assert.equal(db.releasedConnection(), true);
});
