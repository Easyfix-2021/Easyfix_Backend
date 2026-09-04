'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

/*
 * GET /api/client/unreachable-jobs binds its parameters positionally.
 *
 * WHY THIS FILE EXISTS. That route had NO test at all, so the 2,715-test suite
 * went green while saying nothing whatsoever about it — a clean run that is not
 * evidence. Two client-request reason ids were then added as `?` placeholders
 * in the middle of an already-long query: after the CTE's parameters, before
 * the outer WHERE's. mysql2 binds by position, so a placeholder counted wrong
 * does not error. It shifts every later value by one, and the query still runs:
 * the client id lands in the LIMIT, the scope ids land in the wrong predicate,
 * and the page returns a plausible, wrong list.
 *
 * So this asserts the one property that catches that whole class — the number
 * of `?` in the SQL actually sent equals the number of parameters sent with it
 * — rather than re-deriving the expected order, which would just be the same
 * arithmetic a second time and would agree with the code when the code is wrong.
 */

test('every client query binds exactly as many params as it has placeholders', async () => {
  const { installFakePool } = require('./helpers/fake-pool');

  /*
   * Capture rather than answer. The route's shape is irrelevant here; only the
   * (sql, params) pairing is. Anything the router asks for gets an empty
   * result, which is a legitimate answer for every query in this file.
   */
  const seen = [];
  installFakePool([
    [/[\s\S]*/, (sql, params) => { seen.push({ sql, params: params || [] }); return []; }],
  ]);

  const router = require('../routes/client/index');

  // Find the route's handler on the express router without starting a server.
  const layer = router.stack.find(
    (l) => l.route && l.route.path === '/unreachable-jobs' && l.route.methods.get,
  );
  assert.ok(layer, 'the /unreachable-jobs route must exist — if it was renamed, rename it here too');

  const req = {
    query: {},
    spoc: { id: 1, client_id: 10, contact_name: 'Test SPOC' },
    access: { allStores: true },
    params: {},
  };
  const res = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json() { return this; },
  };

  await new Promise((resolve) => {
    const done = () => resolve();
    res.json = () => { done(); return res; };
    Promise.resolve(layer.route.stack[layer.route.stack.length - 1].handle(req, res, done))
      .then(done, done);
  });

  const queries = seen.filter((q) => /unreachable_days|tbl_job_comment/i.test(q.sql));
  assert.ok(queries.length, 'the handler must have issued at least one query — if it short-circuited, '
    + 'this test is asserting nothing and needs its fixture fixed, not deleting');

  for (const { sql, params } of queries) {
    /*
     * Count `?` in the SQL as SENT, with scopeSql already interpolated — the
     * template's literal count is not the number that matters, and counting it
     * would miss exactly the runtime-built predicates most likely to drift.
     * String literals in these queries carry no '?', so a plain count is safe.
     */
    const placeholders = (sql.match(/\?/g) || []).length;
    assert.equal(params.length, placeholders,
      `parameter/placeholder mismatch — mysql2 binds positionally, so this shifts every\n`
      + `later value and returns a plausible wrong answer rather than failing:\n`
      + `  placeholders: ${placeholders}\n  params:       ${params.length}\n`
      + `  sql: ${sql.replace(/\s+/g, ' ').slice(0, 220)}`);
  }
});
