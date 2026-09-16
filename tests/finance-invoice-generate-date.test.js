/*
 * POST /api/admin/finance/invoices/generate writes tbl_client_invoice's
 * invoice_date (DATE). Bound as DATE(?) over a JS Date, never NOW(): the pool
 * is `timezone: '+05:30'`, so a bound Date serialises to the IST wall clock,
 * whereas NOW() resolves in the DB session zone. DATE(?) (not a bare `?`)
 * takes the IST calendar day explicitly — a bare bind into a DATE column is
 * a truncation note, and a hard error under a strict sql_mode Production
 * has not been verified against.
 *
 * Runner: `node --test` (see npm test).
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([
  [/^\s*SELECT COALESCE\(SUM/i, () => [{ total: 5000, jobCount: 3 }]],
  [/^\s*INSERT INTO tbl_client_invoice/i, () => ({ insertId: 61 })],
]);
const router = require('../routes/admin/finance');

after(() => fake.restore());

function stackFor(path, method) {
  const layer = router.stack.find((e) => e.route && e.route.path === path && e.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
  return layer.route.stack;
}
const mkRes = () => ({
  statusCode: 200, body: null,
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
});
async function call(path, method, body) {
  const r = mkRes();
  // scope: undefined (explicit own-property) → assertEntityInScope's
  // buildRequestScope sees the property and short-circuits to "in scope".
  const req = { scope: undefined, user: { user_id: 12 }, query: {}, params: {}, body,
    method: method.toUpperCase(), originalUrl: `/api/admin/finance${path}`, path };
  for (const layer of stackFor(path, method)) {
    let nexted = false;
    await layer.handle(req, r, (e) => { if (e) throw e; nexted = true; });
    if (!nexted) break;
  }
  return r;
}

test('generating an invoice binds invoice_date as DATE(?) over a Date, not NOW()', async () => {
  const r = await call('/invoices/generate', 'post', {
    clientId: 5, from: '2026-09-01', to: '2026-09-15',
  });
  assert.equal(r.statusCode, 201);
  const ins = fake.calls.find((c) => /^\s*INSERT INTO tbl_client_invoice/i.test(c.sql));
  assert.ok(ins, 'the tbl_client_invoice INSERT must run');
  assert.doesNotMatch(ins.sql, /invoice_date\)\s*$|,\s*NOW\(\)\)/i);
  assert.doesNotMatch(ins.sql, /NOW\(\)/, 'invoice_date must not be SQL NOW()');
  assert.match(ins.sql, /DATE\(\?\)\)\s*$/, 'invoice_date must be DATE(?), not a bare bind');
  assert.ok(ins.params.at(-1) instanceof Date, 'invoice_date must be the last bound param, a Date');
});
