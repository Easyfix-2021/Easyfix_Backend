/*
 * GET /api/health/db — the dbTime block.
 *
 * Mounts the REAL router on a fake pool and asserts the clock fields are mapped
 * from the one health query, so a column renamed in the SQL but not in the
 * mapper shows up here as undefined rather than as a silent null in production.
 *
 * Non-destructive: fake pool, no network, no DB. Runner: `node --test`.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const EPOCH = 1789540200; // 2026-09-16 06:30:00 UTC
const fake = installFakePool([
  [/UNIX_TIMESTAMP\(\) AS epoch/, [{
    ok: 1, db: 'easyfix', ts: '2026-09-16 12:00:00', utc: '2026-09-16 06:30:00',
    epoch: EPOCH, offset_min: 330, session_tz: 'SYSTEM', system_tz: 'IST',
  }]],
]);

const express = require('express');
const router = require('../routes');

let server;
let base;
const realNow = Date.now;

before(async () => {
  const app = express();
  app.use('/api', router);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  Date.now = realNow;
  fake.restore();
  server.close();
});

test('dbTime reports the DB clock, zone and app skew from the single health query', async () => {
  // Pin the app clock 7s ahead of the DB for the duration of the request.
  Date.now = () => (EPOCH + 7) * 1000;
  let res;
  try { res = await fetch(`${base}/api/health/db`); } finally { Date.now = realNow; }
  assert.equal(res.status, 200);
  const body = await res.json();
  const data = body.data ?? body;

  assert.equal(data.ts, '2026-09-16 12:00:00', 'ts kept for existing consumers');
  assert.deepEqual(data.dbTime, {
    now: '2026-09-16 12:00:00',
    utc: '2026-09-16 06:30:00',
    offsetMinutes: 330,
    sessionTimeZone: 'SYSTEM',
    systemTimeZone: 'IST',
    appSkewSeconds: 7,
  });
  assert.equal(fake.calls.filter((c) => /UNIX_TIMESTAMP/.test(c.sql)).length, 1, 'one round-trip');
});
