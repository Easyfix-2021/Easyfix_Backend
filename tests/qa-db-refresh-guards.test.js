/*
 * Guard tests for the QA database refresh (services/qa-db-refresh.service.js).
 *
 * These are the highest-value tests in this file set. The job DROPS a database,
 * and everything that stops it dropping the WRONG one lives in assertSafeToRun().
 * A regression there is not a bug report — it is a destroyed production database.
 * So each guard gets an explicit test proving it REFUSES, plus one proving the
 * happy path still passes (a guard that always throws protects nothing, and would
 * otherwise look identical to a working one).
 *
 * Pure env manipulation — no DB, no network, nothing is dumped or restored.
 * Runner: `node --test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { assertSafeToRun } = require('../services/qa-db-refresh.service');

// A fully-valid configuration: QA env, distinct source/target.
const GOOD = {
  ENVIRONMENT: 'qa',
  PROD_SLAVE_DB_HOST: '10.30.3.73',
  PROD_SLAVE_DB_PORT: '3306',
  PROD_SLAVE_DB_USER: 'easyfix_ro',
  PROD_SLAVE_DB_PASSWORD: 'x',
  PROD_SLAVE_DB_NAME: 'easyfix',
  DB_HOST: '10.30.2.30',
  DB_PORT: '3306',
  DB_USER: 'easyfix_qa',
  DB_PASSWORD: 'x',
  DB_NAME: 'easyfix',
  QA_DB_REFRESH_HOST: '',
};

// Apply `overrides` on top of GOOD for one call, then restore the environment.
function withEnv(overrides, fn) {
  const saved = {};
  const applied = { ...GOOD, ...overrides };
  for (const [k, v] of Object.entries(applied)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('a fully-valid QA configuration passes', () => {
  withEnv({}, () => assert.doesNotThrow(() => assertSafeToRun()));
});

/*
 * GUARD 1 — environment. The SAME image runs in production
 * (deploy/docker-compose.prod-backend.yml), and it now ships mysqldump/mysql.
 * This is the guard that stops a prod backend dropping its own database.
 */
test('GUARD: refuses to run when ENVIRONMENT is production', () => {
  withEnv({ ENVIRONMENT: 'production' }, () => {
    assert.throws(() => assertSafeToRun(), /ENVIRONMENT/i);
  });
});

test('GUARD: refuses to run when ENVIRONMENT is unset (fails closed)', () => {
  withEnv({ ENVIRONMENT: undefined }, () => {
    assert.throws(() => assertSafeToRun(), /ENVIRONMENT/i);
  });
});

/*
 * GUARD 2 — target identity. A config typo that pointed the restore at the
 * source would DROP PRODUCTION. Host+port are compared together so a
 * same-host/different-port topology is still distinguishable.
 */
test('GUARD: refuses when the restore target IS the dump source', () => {
  withEnv({ DB_HOST: '10.30.3.73' }, () => {
    assert.throws(() => assertSafeToRun(), /same server/i);
  });
});

test('GUARD: same host on a DIFFERENT port is allowed (not the same server)', () => {
  withEnv({ DB_HOST: '10.30.3.73', DB_PORT: '3307' }, () => {
    assert.doesNotThrow(() => assertSafeToRun());
  });
});

test('GUARD: refuses when the target does not match QA_DB_REFRESH_HOST', () => {
  withEnv({ QA_DB_REFRESH_HOST: '10.30.2.30', DB_HOST: '10.30.9.99' }, () => {
    assert.throws(() => assertSafeToRun(), /QA_DB_REFRESH_HOST/i);
  });
});

test('GUARD: a QA_DB_REFRESH_HOST that matches passes', () => {
  withEnv({ QA_DB_REFRESH_HOST: '10.30.2.30' }, () => {
    assert.doesNotThrow(() => assertSafeToRun());
  });
});

// Incomplete config must refuse rather than half-run and leave QA dropped.
test('GUARD: refuses when the replica connection is not fully configured', () => {
  withEnv({ PROD_SLAVE_DB_HOST: '' }, () => {
    assert.throws(() => assertSafeToRun(), /PROD_SLAVE_DB/i);
  });
});

test('GUARD: refuses when the QA target is not fully configured', () => {
  withEnv({ DB_NAME: '' }, () => {
    assert.throws(() => assertSafeToRun(), /QA target/i);
  });
});
