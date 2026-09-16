/*
 * routes/admin/quotations.js GET /expired (2026-09-16).
 *
 * approval_sent_on_date_time's age is measured with TIMESTAMPDIFF(HOUR, …,
 * NOW()) twice — once in the SELECT projection, once in the WHERE filter
 * clause pushed into `clauses`. Both must compare against the same bound
 * Date rather than SQL NOW(), and the WHERE-clause `?` is the first entry a
 * conditionally-pushed RBAC-scope `?` would otherwise have claimed — so the
 * params array order is worth pinning down directly, not just "some Date
 * somewhere in the list".
 *
 * Runner: `node --test` (see npm test).
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([
  [/^\s*SELECT j\.job_id, j\.job_reference_id/i, () => []],
]);

let server;
let base;
before(async () => {
  const app = express();
  // No RBAC scope narrowing — buildRequestScope(req) returns exactly what's
  // on req.scope (see lib/scope.js hasOwnProperty check), so this keeps the
  // query to just the 2 TIMESTAMPDIFF binds with no extra `?`s to count.
  app.use((req, _res, next) => { req.scope = undefined; next(); });
  app.use('/api/admin/quotations', require('../routes/admin/quotations'));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/admin/quotations`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); fake.restore(); });
beforeEach(() => { fake.calls.length = 0; });

test('expired pending estimates compare approval_sent_on_date_time against a bound Date, never NOW()', async () => {
  const r = await fetch(`${base}/expired`);
  assert.equal(r.status, 200, JSON.stringify(await r.json()));

  const sel = fake.calls.find((c) => /SELECT j\.job_id, j\.job_reference_id/i.test(c.sql));
  assert.ok(sel, 'the expired-estimates SELECT ran');
  assert.doesNotMatch(sel.sql, /NOW\(\)/i, 'approval_sent_on_date_time must never be compared to SQL NOW()');
  assert.match(sel.sql, /TIMESTAMPDIFF\(HOUR, j\.approval_sent_on_date_time, \?\) AS hours_elapsed/i);
  assert.match(sel.sql, /TIMESTAMPDIFF\(HOUR, j\.approval_sent_on_date_time, \?\) > 48/i);

  const qMarkCount = (sel.sql.match(/\?/g) || []).length;
  assert.equal(qMarkCount, sel.params.length, 'placeholder count must match bound params');
  assert.equal(sel.params.length, 2, 'no RBAC scope narrowing in this request');
  assert.ok(sel.params[0] instanceof Date, 'the SELECT projection TIMESTAMPDIFF binds first (textually first)');
  assert.ok(sel.params[1] instanceof Date, 'the WHERE-clause TIMESTAMPDIFF filter binds second');
  assert.equal(sel.params[0].getTime(), sel.params[1].getTime(), 'both TIMESTAMPDIFF(...) share one clock read');
  assert.ok(Math.abs(Date.now() - sel.params[0].getTime()) < 60000);
});
