/*
 * Unit tests for the `verticalId` LIST filter on GET /admin/jobs — the fifth
 * control on the shared Pending-for-Scheduling filter bar
 * (Easyfix_CRM_UI/src/components/job/PendingSchedulingFilters.tsx), and the
 * "Vertical" field on the /jobs "Filter Job" panel, which drive the SAME param.
 *
 * WHAT A VERTICAL IS HERE. `tbl_vertical` is the master (vertical_id,
 * vertical_name, …). A JOB reaches a vertical through its CLIENT, and the
 * schema offers two different edges for that:
 *
 *   tbl_client.vertical_id            — the client's OWN vertical. 1:1, and
 *                                       what the QuickSight reports + the RBAC
 *                                       `scope.verticals` filter read.
 *   tbl_vertical_mapping(client_id,
 *     vertical_id, user_id, …)        — per-client (vertical × user) SPOC
 *                                       assignments. MANY-TO-MANY: one client
 *                                       may carry rows for several verticals.
 *
 * The list filter deliberately uses the MANY-TO-MANY edge, with ANY-match
 * semantics: a job is kept when AT LEAST ONE of its client's mapped verticals
 * is the selected one.
 *
 * THE SHAPE: RESOLVE THE CLIENTS FIRST, THEN `j.fk_client_id IN (…)`. Until
 * 2026-09-30 this was a correlated `EXISTS` on tbl_vertical_mapping, and MySQL
 * 8 rewrites that EXISTS into a SEMIJOIN driven FROM the mapping table. Under
 * the Manage Jobs projection that made it materialise EVERY matching job (205k
 * for vertical 1), evaluate ~30 correlated scalar subqueries per row, and only
 * then filesort down to the 10-row page: 22-45 s on Production (3 of 3 calls),
 * 40.5 s on QA, against 84-309 ms for the IN-list. The PM filter had the same
 * shape and cost (17.5 s → 0.2 s for the busiest PM). A literal IN-list lets
 * the optimiser walk the job PK backwards and stop at the page, and keeps the
 * COUNT on the FK index (180 → 100 ms). A NO_SEMIJOIN hint fixed the page but
 * forced COUNT to a full scan (180 ms → 2.1 s), so it was rejected.
 *
 * IN-membership is still ANY-match and still cannot multiply a job's row when
 * its client maps to several verticals — the resolver is DISTINCT.
 *
 * THE COUNT-QUERY CONTRACT. The list is server-paginated, so the total comes
 * from a SEPARATE `SELECT COUNT(*)` whose joins are derived by sniffing the
 * WHERE for the cu./ad./cl./ci./ef./ow. aliases. The clause names only the
 * always-present `j`, so the COUNT query stays a single-table scan.
 *
 * Non-destructive: fake pool, no real DB, zero writes. Runner: `node --test`.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([
  [/SHOW COLUMNS/i, []],
  [/FROM easyfix_properties/i, []],
  [/FROM tbl_job_customer_request LIMIT 1/i, []],
  [/SELECT 1 FROM tbl_job_offer LIMIT 1/i, [{ 1: 1 }]],
  [/SELECT magic_link_delivery_status FROM tbl_job LIMIT 1/i, [{ magic_link_delivery_status: null }]],
  [/^SELECT COUNT\(\*\) AS total/i, [{ total: 0 }]],
  // The client resolver. vertical 3 / PM 55 → clients 11 + 12; anything else → none.
  [/^SELECT DISTINCT client_id FROM tbl_vertical_mapping/i,
    (sql, params) => (params.includes(3) || params.includes(55) ? [{ client_id: 11 }, { client_id: 12 }] : [])],
]);

const jobSvc = require('../services/job.service');
const { listQuery } = require('../validators/job.validator');

beforeEach(() => { fake.reset(); });

const dataQuery  = () => fake.calls.find((c) => /LIMIT \? OFFSET \?/.test(c.sql));
const countQuery = () => fake.calls.find((c) => /^SELECT COUNT\(\*\) AS total/i.test(c.sql));
/*
 * The COUNT query is `SELECT COUNT(*) … <joins> <where>` with no projection
 * subqueries, so its FIRST 'WHERE' is the top-level one — unlike the data
 * query, whose projection is full of correlated subqueries. Read the canonical
 * WHERE off COUNT, then assert the data query CONTAINS that exact text.
 */
const topLevelWhere = () => countQuery().sql.slice(countQuery().sql.indexOf('WHERE')).trim();

/* ── The validator side: what shape the FE is allowed to send ────────────── */

test('the validator accepts a single positive integer verticalId', () => {
  for (const v of [3, '3', '17']) {
    const { error, value } = listQuery.validate({ verticalId: v });
    assert.equal(error, undefined, `${JSON.stringify(v)} must validate`);
    assert.equal(value.verticalId, Number(v), 'and must arrive at the service as a number');
  }
});

/*
 * ── THE PIN, WIDENED (2026-09-23) ──────────────────────────────────────────
 *
 * This was THE SINGLE-SELECT PIN: verticalId was a bare `intId`, a CSV was a
 * hard 400, and this test existed so that "whoever widens it is pointed
 * straight at the control that has to change with it". That is exactly what
 * happened — the dashboard filter bar swapped Project Manager for Verticals and
 * ops asked for multi-select, so verticalId became `csvIds`, the same shape
 * clientId and cityId already had, and the predicate became IN (...).
 *
 * The tripwire is kept, pointing the other way. What it now pins:
 *   1. a CSV is ACCEPTED, so a multi-select control is legitimate;
 *   2. a LONE ID is still accepted and still arrives as a number, so every
 *      caller written against the old contract — Manage Jobs' Filter Job card,
 *      the QuickSight report bodies, the jobs export — keeps working untouched
 *      and may stay a SearchSelect;
 *   3. junk is still refused, so widening bought range, not permissiveness.
 *
 * If verticalId is ever narrowed back, this fails and points at the two
 * SearchMultiSelects (Manage Jobs and the dashboard bar) that must change with
 * it. Same guard, same purpose, opposite direction.
 */
test('THE PIN, WIDENED: a CSV verticalId is ACCEPTED — multi-select is legitimate', () => {
  for (const ok of ['3,4', '1,2,3', '17']) {
    const { error, value } = listQuery.validate({ verticalId: ok });
    assert.equal(error, undefined, `${JSON.stringify(ok)} must validate`);
    assert.ok(value.verticalId != null);
  }
});

test('THE PIN, WIDENED: a lone id still works, so single-select callers are untouched', () => {
  for (const v of [3, '3', '17']) {
    const { error, value } = listQuery.validate({ verticalId: v });
    assert.equal(error, undefined, `${JSON.stringify(v)} must still validate`);
    assert.equal(value.verticalId, Number(v), 'and must still arrive as a number');
  }
});

test('THE PIN, WIDENED: malformed lists are still refused, not silently truncated', () => {
  for (const bad of ['3,', ',3', '3,,4', '3,abc', '3 ,4']) {
    const { error } = listQuery.validate({ verticalId: bad });
    assert.ok(error, `${JSON.stringify(bad)} must be rejected, not silently truncated`);
  }
});

test('the validator rejects non-positive / non-integer verticalId', () => {
  for (const bad of [0, -1, 1.5, 'abc', '']) {
    const { error } = listQuery.validate({ verticalId: bad });
    assert.ok(error, `${JSON.stringify(bad)} must be rejected`);
  }
});

/* ── The query builder: main + COUNT, together ───────────────────────────── */

const resolverCalls = () => fake.calls.filter((c) => /^SELECT DISTINCT client_id FROM tbl_vertical_mapping/i.test(c.sql));
const CLIENT_IN = 'j.fk_client_id IN (?,?)';

test('verticalId resolves the mapped clients ONCE, then filters by j.fk_client_id IN (…)', async () => {
  await jobSvc.list({ status: 0, assigned: false, verticalId: 3, limit: 10, offset: 0 });
  const r = resolverCalls();
  assert.equal(r.length, 1, 'one resolver round trip per request');
  assert.match(r[0].sql, /WHERE vertical_id IN \(\?\)$/, 'a lone id is a one-item IN');
  assert.deepEqual(r[0].params, [3], 'the vertical id is bound, never inlined');
  assert.ok(topLevelWhere().includes(CLIENT_IN), `client IN-list missing from: ${topLevelWhere()}`);
  assert.deepEqual(countQuery().params, [0, 11, 12]);
});

test('THE 45-SECOND PLAN: no correlated tbl_vertical_mapping subquery reaches either statement', async () => {
  /*
   * The EXISTS form is what MySQL turned into a semijoin that materialised
   * every matching job under the Manage Jobs projection before paginating. If
   * it comes back, in the WHERE of either the page or the COUNT, this fails.
   */
  await jobSvc.list({ view: 'manage', verticalId: 3, projectManagerId: '55', limit: 10, offset: 0 });
  for (const q of [countQuery(), dataQuery()]) {
    assert.doesNotMatch(q.sql, /EXISTS \(SELECT 1 FROM tbl_vertical_mapping/i);
  }
});

test('projectManagerId takes the same resolver, restricted to user_type = 1', async () => {
  await jobSvc.list({ status: 0, projectManagerId: '55', limit: 10, offset: 0 });
  const r = resolverCalls();
  assert.equal(r.length, 1);
  assert.match(r[0].sql, /WHERE user_type = 1 AND user_id IN \(\?\)$/);
  assert.deepEqual(r[0].params, [55]);
  assert.deepEqual(countQuery().params, [0, 11, 12]);
});

test('a vertical with NO mapped client yields an empty list (1=0), never an unfiltered one', async () => {
  await jobSvc.list({ status: 0, assigned: false, verticalId: 99, limit: 10, offset: 0 });
  assert.match(topLevelWhere(), /\b1=0\b/);
  assert.doesNotMatch(topLevelWhere(), /fk_client_id IN/);
  assert.deepEqual(countQuery().params, [0], 'no orphan params may be bound');
});

test('a CSV verticalId is ONE lookup with N placeholders, not N clauses', async () => {
  // Harkirpa's 2026-09-23 widening, carried onto the resolver shape: '3,4,5'
  // must stay ONE round trip, ANY-match across the three verticals.
  await jobSvc.list({ status: 0, assigned: false, verticalId: '3,4,5', limit: 10, offset: 0 });
  const r = resolverCalls();
  assert.equal(r.length, 1, 'one lookup, not three');
  assert.match(r[0].sql, /WHERE vertical_id IN \(\?,\?,\?\)$/);
  assert.deepEqual(r[0].params, [3, 4, 5]);
  assert.deepEqual(countQuery().params, [0, 11, 12]);
});

test('verticalId NARROWS the bucket — status=0 + assigned=false survive intact', async () => {
  await jobSvc.list({ status: 0, assigned: false, verticalId: 3, limit: 10, offset: 0 });
  assert.match(
    topLevelWhere(),
    /^WHERE j\.job_status = \? AND j\.fk_easyfixter_id IS NULL AND j\.fk_client_id IN \(\?,\?\)/,
  );
});

test('COUNT and data queries share the SAME where + params (COUNT-join parity)', async () => {
  await jobSvc.list({ status: 0, assigned: false, verticalId: 3, limit: 10, offset: 0 });
  const count = countQuery(); const data = dataQuery();
  assert.ok(count && data, 'both queries must have run');
  assert.ok(data.sql.includes(topLevelWhere()), 'COUNT and data must filter identically');
  assert.deepEqual(data.params.slice(0, count.params.length), count.params);
  assert.deepEqual(data.params.slice(count.params.length), [10, 0]);
});

test('THE RECORDED 500: verticalId adds NO outer alias, so COUNT needs no join', async () => {
  await jobSvc.list({ status: 0, assigned: false, verticalId: 3, limit: 10, offset: 0 });
  assert.doesNotMatch(countQuery().sql, /LEFT JOIN/i, 'COUNT must stay a single-table scan');
});

test('verticalId composes with the OTHER bar filters without disturbing their params', async () => {
  /*
   * cityId forces the `ad.` alias into the WHERE, so the COUNT query must ADD
   * the address join. Param order follows clause order in list(): status,
   * clientId, cityId, categoryId, then the vertical's resolved clients.
   */
  await jobSvc.list({
    status: 0, assigned: false,
    clientId: '11', cityId: '7,9', categoryId: 5, verticalId: 3,
    limit: 10, offset: 0,
  });
  const count = countQuery();
  assert.match(count.sql, /LEFT JOIN tbl_address/i, 'cityId must still pull in the address join');
  assert.deepEqual(count.params, [0, 11, 7, 9, 5, 11, 12], 'vertical clients bind last, in clause order');
  assert.ok(dataQuery().sql.includes(topLevelWhere()), 'and COUNT/data still agree');
});

test('no verticalId ⇒ the bucket is returned unfiltered (no clause, no resolver)', async () => {
  await jobSvc.list({ status: 0, assigned: false, limit: 10, offset: 0 });
  assert.doesNotMatch(topLevelWhere(), /fk_client_id IN/, 'absent verticalId must add no clause');
  assert.equal(resolverCalls().length, 0, 'and must not pay for the resolver');
  assert.deepEqual(countQuery().params, [0], 'no orphan params may be bound');
});

test('null / undefined verticalId adds no clause (defence in depth behind Joi)', async () => {
  for (const v of [undefined, null]) {
    fake.reset();
    await jobSvc.list({ status: 0, assigned: false, verticalId: v, limit: 10, offset: 0 });
    assert.equal(resolverCalls().length, 0, `${JSON.stringify(v)} must not filter`);
  }
});
