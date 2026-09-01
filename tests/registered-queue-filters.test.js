const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * Two defects in the Registered Easyfixers queue, both found by comparing it
 * against the roster rather than by reading either one alone.
 *
 * 1. IT SHOWED ADMIN-DELETED TECHNICIANS. The roster excludes the tombstone
 *    sentinel on every query (`NOT (e.efr_status <=> 3)`); this queue had no
 *    efr_status clause at all. So a technician deleted through
 *    /api/admin/entity-deletion — whose PII the delete deliberately SCRUBS —
 *    disappeared from the roster and went on appearing here by name and masked
 *    mobile. Verified on QA before the fix: 1 tombstoned row, 1 of them visible.
 *
 * 2. IT COULD NOT SEARCH AN ID ABOVE 9999. The term was matched with
 *    /^\d{1,4}$/, and efr_id passed that ceiling some time ago — max 10,795,
 *    with 796 rows above it. A five-digit id fell through to the name/mobile
 *    LIKE and matched nothing, silently.
 */

/*
 * The COUNT is routed explicitly: listRegistered destructures `[[{ total }]]`,
 * so a bare [] would throw before any assertion could run.
 */
const fake = installFakePool([
  [/SELECT COUNT\(\*\)/i, [{ total: 0 }]],
  [/./, []],
]);
const svc = require('../services/easyfixer.service');
after(() => fake.restore());

// scope is the SECOND argument, not a key on the filter object.
const SCOPE = { cities: { mode: 'all', ids: [] } };

const sqlFor = async (args = {}) => {
  fake.reset();
  await svc.listRegistered(args, SCOPE);
  return fake.calls.map((c) => c.sql).filter((s) => /FROM tbl_easyfixer/i.test(s)).join('\n');
};

test('the queue excludes admin-deleted tombstones', async () => {
  const sql = await sqlFor({});
  assert.match(sql, /NOT \(e\.efr_status <=> 3\)/,
    'a deleted technician must not reappear in the registration queue — the '
    + 'delete scrubs their PII precisely so they stop being displayed');
});

test('the tombstone guard is NULL-safe', async () => {
  const sql = await sqlFor({});
  assert.doesNotMatch(sql, /e\.efr_status <> 3|e\.efr_status != 3/,
    'plain <> drops NULL rows, and NULL is most of this queue — a technician '
    + 'mid-registration has no efr_status yet');
});

// ─── id search ───────────────────────────────────────────────────────

const idParams = async (q) => {
  fake.reset();
  await svc.listRegistered({ q }, SCOPE);
  const call = fake.calls.find((c) => /FROM tbl_easyfixer/i.test(c.sql));
  return { sql: call.sql, params: call.params };
};

test('a five-digit id is recognised, not dropped into a name search', async () => {
  const { sql, params } = await idParams('10795');
  assert.match(sql, /e\.efr_id = \?/, 'ids passed 9,999 — the old /^\\d{1,4}$/ stopped seeing them');
  assert.ok(params.includes(10795));
});

test('four-digit ids still work', async () => {
  const { sql, params } = await idParams('9501');
  assert.match(sql, /e\.efr_id = \?/);
  assert.ok(params.includes(9501));
});

test('a six-digit term is still a PINCODE, not an id', async () => {
  /*
   * The one collision left, and it is deliberate: pincode search is used
   * constantly and id search is exact, so the ambiguous length goes to the
   * common case. efr_id 100000+ will need its own field.
   */
  const { sql } = await idParams('422008');
  assert.match(sql, /U\.pin_code LIKE \?/);
  assert.doesNotMatch(sql, /e\.efr_id = \?/);
});

test('a ten-digit term is still a MOBILE', async () => {
  const { sql } = await idParams('7498229813');
  assert.match(sql, /e\.efr_no LIKE \?/);
  assert.doesNotMatch(sql, /e\.efr_id = \?/);
});

test('a 7-digit term now resolves to an id instead of matching nothing', async () => {
  const { sql, params } = await idParams('1234567');
  assert.match(sql, /e\.efr_id = \?/, 'previously fell through to the name LIKE');
  assert.ok(params.includes(1234567));
});

test('free text still searches name and mobile', async () => {
  const { sql } = await idParams('Krishna');
  assert.match(sql, /U\.user_name LIKE \?/);
  assert.doesNotMatch(sql, /e\.efr_id = \?/);
});
