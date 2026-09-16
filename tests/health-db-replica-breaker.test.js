/*
 * GET /api/health/db — an unreachable replica must stop costing a connect
 * timeout per call.
 *
 * Production ran with the replica unreachable (ETIMEDOUT) and the endpoint
 * took ~5s. The breaker was in fact opening, but the response was snapshotted
 * BEFORE the probe, so the call that tripped it reported `breaker: "closed"`
 * beside its own timeout, and nothing showed the failure count feeding it. It
 * was diagnosed as a dead breaker twice. This pins both halves at the real
 * route: identify() timeouts open the breaker, the next call skips the probe,
 * and the response says so on the call that opened it.
 *
 * Its own file, not db-read-pool.test.js: that file drops db modules from
 * require.cache between tests, and routes/ captures the pools at require time.
 * Fake pools, a stubbed replica, no network.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, {
  DB_READ_HOST: '10.0.0.1', DB_READ_BREAKER_THRESHOLD: '3', DB_READ_BREAKER_COOLDOWN_MS: '600000',
});

const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([
  [/UNIX_TIMESTAMP\(\) AS epoch/, [{
    ok: 1, db: 'easyfix', ts: '2026-09-16 12:00:00', utc: '2026-09-16 06:30:00',
    epoch: 1789540200, offset_min: 330, session_tz: 'SYSTEM', system_tz: 'IST',
  }]],
]);

const express = require('express');
const dbRead = require('../db-read');
const router = require('../routes');

// Stands in for DB_READ_CONNECT_TIMEOUT: slow enough that a probe that runs is
// unmistakable next to one that is skipped.
const CONNECT_MS = 300;
let replicaAttempts = 0;
dbRead.readPool.query = async () => {
  replicaAttempts += 1;
  await new Promise((r) => { setTimeout(r, CONNECT_MS); });
  const e = new Error('connect ETIMEDOUT'); e.code = 'ETIMEDOUT';
  throw e;
};

let server;
let base;

before(async () => {
  const app = express();
  app.use('/api', router);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  fake.restore();
  server.close();
  await dbRead.closeReadPool(); // its idle reaper would hold the loop open
});

async function healthDb() {
  const t0 = Date.now();
  const res = await fetch(`${base}/api/health/db`);
  const body = await res.json();
  return { status: res.status, ms: Date.now() - t0, replica: (body.data ?? body).replica };
}

test('replica timeouts open the breaker, and /health/db then skips the probe', async () => {
  for (let i = 1; i <= 3; i += 1) {
    const { status, ms, replica } = await healthDb();
    assert.equal(status, 200, 'a replica failure never 503s /health/db');
    assert.ok(ms >= CONNECT_MS, `call ${i} actually probed`);
    assert.equal(replica.error, 'ETIMEDOUT');
    assert.equal(replica.consecutiveFailures, i, 'the probe failure fed the breaker');
    assert.equal(replica.lastProbeCode, 'ETIMEDOUT');
    assert.equal(replica.fallbacks, 0, 'probes are not read fallbacks');
    // Post-probe snapshot: the call that trips the threshold says so.
    assert.equal(replica.breaker, i < 3 ? 'closed' : 'open', `call ${i} breaker state`);
  }
  assert.equal(replicaAttempts, 3);

  const skipped = await healthDb();
  assert.equal(skipped.status, 200);
  assert.equal(replicaAttempts, 3, 'no connect attempt while the breaker is open');
  assert.ok(skipped.ms < CONNECT_MS, `skipped probe is fast (${skipped.ms}ms)`);
  assert.equal(skipped.replica.breaker, 'open');
  assert.equal(skipped.replica.reachable, false);
  assert.match(skipped.replica.probeSkipped, /breaker open/);
});
