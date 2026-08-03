/*
 * fake-pool — a tiny in-memory stand-in for the mysql2 `pool` so service
 * choke points can be characterization-tested WITHOUT a real/prod DB.
 *
 * The owner's constraint: tests must never write dummy rows to prod — they
 * only prove the flows aren't hampered. This fake honours that by never
 * connecting: it dispatches each SQL string to a canned result by RegExp,
 * records every (sql, params) it saw, and can STOP execution at the first
 * write so a test stays scoped to the one statement it characterizes
 * (skipping the heavy downstream reads / fire-and-forget side effects).
 *
 * Seam: job.service.js captures the DB via `const { pool } = require('../db')`.
 * A test replaces the METHODS on that shared singleton BEFORE requiring the
 * service (`require('../db').pool.query = fake.pool.query`), so the service's
 * captured reference dispatches here. mysql2 createPool is lazy (no socket
 * until the first query), so requiring the modules never touches a DB.
 *
 * Services that already take an injected runner (e.g. job-magic-link's
 * acceptSubmission(jobId, payload, pool)) can be handed `fake.pool` directly
 * with no monkeypatch.
 *
 * A route is [RegExp, rows | (sql, params) => rows]. `rows` is the array a
 * `const [rows] = await pool.query(...)` destructure expects; the fake wraps
 * it as [rows, fields] like mysql2. Unmatched queries return [] (empty rows).
 */

function makeFakePool(routes = [], opts = {}) {
  const calls = [];
  const stopOn = opts.stopOn || null;

  async function query(sql, params) {
    const text = Array.isArray(sql) ? String(sql[0]) : String(sql);
    calls.push({ sql: text, params });
    // STOP-sentinel: throw a tagged error at the first write so the test can
    // assert on the captured statement without running everything after it.
    if (stopOn && stopOn.test(text)) {
      const e = new Error('__FAKE_POOL_STOP__');
      e.__stop = true;
      throw e;
    }
    for (const [re, resp] of routes) {
      if (re.test(text)) {
        const rows = typeof resp === 'function' ? await resp(text, params) : resp;
        return [rows, []];
      }
    }
    return [[], []];
  }

  // Transaction-capable fake connection for the txn flows (create/assign/…).
  function makeConn() {
    return {
      query,
      execute: query,
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {},
    };
  }

  const pool = { query, execute: query, getConnection: async () => makeConn() };
  return { pool, calls, reset: () => { calls.length = 0; } };
}

/*
 * Install a fake onto the shared db singleton and return { calls, restore }.
 * Call BEFORE requiring the service under test. `restore()` puts the real
 * pool methods back (use in an after() hook to keep test files isolated).
 */
function installFakePool(routes = [], opts = {}) {
  const db = require('../../db');
  const fake = makeFakePool(routes, opts);
  const original = { query: db.pool.query, execute: db.pool.execute, getConnection: db.pool.getConnection };
  db.pool.query = fake.pool.query;
  db.pool.execute = fake.pool.execute;
  db.pool.getConnection = fake.pool.getConnection;
  return {
    calls: fake.calls,
    reset: fake.reset,
    restore() {
      db.pool.query = original.query;
      db.pool.execute = original.execute;
      db.pool.getConnection = original.getConnection;
    },
  };
}

module.exports = { makeFakePool, installFakePool };
