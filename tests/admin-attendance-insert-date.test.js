/*
 * POST /api/admin/aux/attendance writes tbl_easyfixer_attendance twice in one
 * INSERT: `created_on` (DATE) and `insert_date` (DATETIME) — both from the
 * SAME bound Date, never NOW(): the pool is `timezone: '+05:30'`, so a JS
 * Date serialises to the IST wall clock the columns expect, whereas NOW()
 * resolves in the DB session zone. `created_on` wraps its bind in DATE(?):
 * a bare `?` into a DATE column is a truncation note (and a hard error under
 * a strict sql_mode Production has not been verified against), where DATE()
 * takes the IST calendar day explicitly.
 *
 * Runner: `node --test` (see npm test).
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([
  [/^\s*INSERT INTO tbl_easyfixer_attendance/i, () => ({ insertId: 1 })],
]);
const router = require('../routes/admin/auxiliary');

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
  const req = { user: { user_id: 1 }, query: {}, params: {}, body,
    method: method.toUpperCase(), originalUrl: `/api/admin/aux${path}`, path };
  for (const layer of stackFor(path, method)) {
    let nexted = false;
    await layer.handle(req, r, (e) => { if (e) throw e; nexted = true; });
    if (!nexted) break;
  }
  return r;
}

test('marking attendance binds created_on and insert_date as the SAME Date, not NOW()', async () => {
  const r = await call('/attendance', 'post', { easyfixerId: 9, isLeaveMarked: 0 });
  assert.equal(r.statusCode, 201);
  const ins = fake.calls.find((c) => /INSERT INTO tbl_easyfixer_attendance/i.test(c.sql));
  assert.ok(ins, 'the attendance row must be inserted');
  assert.doesNotMatch(ins.sql, /NOW\(\)/, 'neither created_on nor insert_date may be SQL NOW()');
  assert.match(ins.sql, /VALUES \(\?, \?, \?, \?, DATE\(\?\), \?\)/,
    'created_on is DATE(?) — a bare ? into a DATE column truncates/errors under strict sql_mode');
  assert.ok(ins.params.at(-2) instanceof Date, 'created_on must be a bound Date');
  assert.ok(ins.params.at(-1) instanceof Date, 'insert_date must be a bound Date');
  assert.equal(ins.params.at(-2).getTime(), ins.params.at(-1).getTime(),
    'created_on and insert_date must stamp identically — the SAME now, reused');
});
