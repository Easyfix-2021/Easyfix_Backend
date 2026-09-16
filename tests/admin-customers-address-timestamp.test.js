/*
 * PATCH /api/admin/customers/:id/addresses/:addrId writes tbl_address's
 * update_date (TIMESTAMP). Bound as a Date, never NOW(): the pool is
 * `timezone: '+05:30'`, so a JS Date serialises to the IST wall clock the
 * column expects, whereas NOW() resolves in the DB session zone.
 *
 * Runner: `node --test` (see npm test).
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([
  [/^\s*SELECT address_id FROM tbl_address/i, () => [{ address_id: 9 }]],
  [/^\s*UPDATE tbl_address/i, () => ({ affectedRows: 1 })],
]);
const router = require('../routes/admin/customers');

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
async function call(path, method, body, params = {}) {
  const r = mkRes();
  const req = { user: { user_id: 1 }, query: {}, params, body,
    method: method.toUpperCase(), originalUrl: `/api/admin/customers${path}`, path };
  for (const layer of stackFor(path, method)) {
    let nexted = false;
    await layer.handle(req, r, (e) => { if (e) throw e; nexted = true; });
    if (!nexted) break;
  }
  return r;
}

test('updating a customer address binds update_date as a Date, not NOW()', async () => {
  const r = await call('/:id/addresses/:addrId', 'patch', {
    address: '221B Baker St', city_id: 4, pin_code: '110001',
  }, { id: '7', addrId: '9' });
  assert.equal(r.statusCode, 200);
  const upd = fake.calls.find((c) => /^\s*UPDATE tbl_address/i.test(c.sql));
  assert.ok(upd, 'the tbl_address UPDATE must run');
  assert.doesNotMatch(upd.sql, /update_date = NOW\(\)/i);
  assert.match(upd.sql, /update_date = \?/i);
  // update_date is bound right before the WHERE params (addrId, customerId).
  assert.ok(upd.params[upd.params.length - 3] instanceof Date, 'update_date must be a bound Date');
});
