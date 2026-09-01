const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * Technicians with NO city, and who is allowed to see them.
 *
 * `e.efr_cityId IN (…)` is never true for NULL, so 2,427 technicians with no
 * city sat in no operator's RBAC scope and were invisible to every one of them
 * — including the people whose job is to give them a city. Nobody owning a row
 * is not a reason to hide it from everybody.
 *
 * THE RULE: a city-less technician appears only when City and State are both
 * All. Choosing either must still exclude them, and that falls out of the
 * filters themselves rather than needing its own branch — `e.efr_cityId = ?`
 * and `c.state_id = ?` (through a LEFT JOIN) match no NULL.
 *
 * FIVE call sites share the predicate: the roster, the counts strip, the lazy
 * aggregate fill, attendance, and the registered queue. They are asserted
 * together because the last time two of them disagreed about which rows exist,
 * the counts advertised 7,504 technicians the table refused to show.
 */

/*
 * Both aggregate shapes are routed explicitly. statusCounts destructures
 * `[[row]].total`, so a bare [] throws inside the service before any assertion
 * can run — a green-looking harness failure that says nothing about the SQL.
 */
const COUNTS_ROW = {
  active: 0, inactive: 0, idle: 0, not_eligible: 0,
  not_suitable: 0, reg_in_progress: 0, training_pending: 0, total: 0,
};
const fake = installFakePool([
  [/AS training_pending/i, [COUNTS_ROW]],
  [/SELECT COUNT\(\*\)/i, [{ total: 0 }]],
  [/./, []],
]);
const svc = require('../services/easyfixer.service');

/*
 * The predicate every scope site must emit, anchored.
 *
 * The anchor is not decoration. Most sites reach the technician through
 * `LEFT JOIN tbl_easyfixer e`, where a NULL city means EITHER "this technician
 * has no city" (must be visible) OR "no technician row matched at all" (must
 * not be). tbl_easyfixer_transaction and tbl_service_payout outlive the
 * technicians they reference, so the unanchored form would hand every
 * city-scoped operator the money rows of admin-deleted technicians.
 */
const SCOPED_PREDICATE =
  /\(e\.efr_cityId IN \(\?,\?\) OR \(e\.efr_id IS NOT NULL AND e\.efr_cityId IS NULL\)\)/;

after(() => fake.restore());

const SCOPED = { cities: { mode: 'allow', ids: [56, 77] } };
const sqlOf = (re) => fake.calls.map((c) => c.sql).filter((s) => re.test(s)).join('\n');

test('a scoped roster admits rows with no city', async () => {
  fake.reset();
  await svc.list({ status: 0, scope: SCOPED });
  const sql = sqlOf(/FROM tbl_easyfixer e/i);
  assert.match(sql, SCOPED_PREDICATE,
    'a technician belonging to no city belongs to no scope — and must not '
    + 'therefore belong to nobody');
});

test('choosing a City still excludes them — no extra branch needed', async () => {
  fake.reset();
  await svc.list({ status: 0, cityId: 56, scope: SCOPED });
  const sql = sqlOf(/FROM tbl_easyfixer e/i);
  assert.match(sql, /e\.efr_cityId = \?/, 'the explicit filter is an equality');
  // Equality never matches NULL, so the scope's OR cannot leak them back in.
  assert.match(sql, SCOPED_PREDICATE);
});

test('choosing a State still excludes them', async () => {
  fake.reset();
  await svc.list({ status: 0, stateId: 9, scope: SCOPED });
  const sql = sqlOf(/FROM tbl_easyfixer e/i);
  assert.match(sql, /c\.state_id = \?/,
    'state comes through a LEFT JOIN on city — a NULL city has no state, so the '
    + 'equality drops them without a special case');
});

test('mode=none still blocks everything, city or not', async () => {
  fake.reset();
  await svc.list({ status: 0, scope: { cities: { mode: 'none', ids: [] } } });
  const sql = sqlOf(/FROM tbl_easyfixer e/i);
  assert.match(sql, /1=0/);
  assert.doesNotMatch(sql, /efr_cityId IS NULL/,
    'a blocked scope is blocked — the NULL allowance must not reopen it');
});

test('an unscoped operator gets no city clause at all', async () => {
  fake.reset();
  await svc.list({ status: 0, scope: { cities: { mode: 'all', ids: [] } } });
  const sql = sqlOf(/FROM tbl_easyfixer e/i);
  assert.doesNotMatch(sql, /efr_cityId IN/, 'nothing to narrow');
});

test('the counts strip uses the SAME predicate as the list', async () => {
  fake.reset();
  await svc.statusCounts({ scope: SCOPED });
  const sql = sqlOf(/FROM tbl_easyfixer/i);
  assert.match(sql, SCOPED_PREDICATE,
    'counts that disagree with the list are how 7,504 unreachable technicians '
    + 'got advertised in the first place');
});

test('the registered queue uses it too', async () => {
  fake.reset();
  await svc.listRegistered({}, SCOPED);
  const sql = sqlOf(/FROM tbl_easyfixer e/i);
  assert.match(sql, SCOPED_PREDICATE);
});

test('the aggregate fill covers the rows the list now returns', async () => {
  fake.reset();
  await svc.aggregates([1, 2, 3], { scope: SCOPED });
  const sql = sqlOf(/FROM tbl_easyfixer/i);
  assert.match(sql, SCOPED_PREDICATE,
    'otherwise Job Count / Earnings come back blank for exactly the rows that '
    + 'just became visible');
});

test('attendance covers them as well', async () => {
  fake.reset();
  await svc.attendance([1, 2, 3], { scope: SCOPED });
  const sql = sqlOf(/tbl_easyfixer/i);
  assert.match(sql, SCOPED_PREDICATE);
});
