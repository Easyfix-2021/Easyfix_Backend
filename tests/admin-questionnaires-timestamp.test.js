/*
 * POST /api/admin/questionnaires writes tbl_questionaire.insert_date
 * (TIMESTAMP). Bound as a Date, never NOW(): the pool is
 * `timezone: '+05:30'`, so a JS Date serialises to the IST wall clock the
 * column expects, whereas NOW() resolves in the DB session zone.
 *
 * Runner: `node --test` (see npm test).
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([
  [/^\s*INSERT INTO tbl_questionaire\b/i, () => ({ insertId: 12 })],
]);
const router = require('../routes/admin/questionnaires');

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
    method: method.toUpperCase(), originalUrl: `/api/admin/questionnaires${path}`, path };
  for (const layer of stackFor(path, method)) {
    let nexted = false;
    await layer.handle(req, r, (e) => { if (e) throw e; nexted = true; });
    if (!nexted) break;
  }
  return r;
}

test('creating a questionnaire binds insert_date as a Date, not NOW()', async () => {
  const r = await call('/', 'post', { client_id: 5, c_questionaire_name: 'Onboarding' });
  assert.equal(r.statusCode, 201);
  const ins = fake.calls.find((c) => /^\s*INSERT INTO tbl_questionaire\b/i.test(c.sql));
  assert.ok(ins, 'the tbl_questionaire INSERT must run');
  assert.doesNotMatch(ins.sql, /NOW\(\)/, 'insert_date must be a bound Date, not NOW()');
  assert.ok(ins.params.at(-1) instanceof Date, 'insert_date must be the last bound param, a Date');
});
