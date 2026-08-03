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
 * is the selected one. `EXISTS` expresses exactly that and — unlike a JOIN —
 * cannot multiply a job's row when its client maps to several verticals.
 *
 * THE COUNT-QUERY CONTRACT (the reason this file exists). The list is
 * server-paginated, so the total comes from a SEPARATE `SELECT COUNT(*)`
 * statement whose joins are derived by sniffing the WHERE clause for the
 * cu./ad./cl./ci./ef./ow. aliases. A filter that referenced one of those
 * aliases without the matching COUNT join is the recorded "COUNT query 500".
 * The vertical filter's subquery is self-contained — it names only its own
 * `vm` alias and the always-present `j` — so it adds NO outer alias and the
 * COUNT query stays a single-table scan. That is asserted below rather than
 * asserted about, on both statements.
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
// `vm` is used ONLY by the vertical / project-manager filters, and the PM one
// additionally names user_type — so this is an exact probe for "vertical fired".
const VERTICAL_CLAUSE =
  'EXISTS (SELECT 1 FROM tbl_vertical_mapping vm WHERE vm.client_id = j.fk_client_id AND vm.vertical_id = ?)';

/* ── The validator side: what shape the FE is allowed to send ────────────── */

test('the validator accepts a single positive integer verticalId', () => {
  for (const v of [3, '3', '17']) {
    const { error, value } = listQuery.validate({ verticalId: v });
    assert.equal(error, undefined, `${JSON.stringify(v)} must validate`);
    assert.equal(value.verticalId, Number(v), 'and must arrive at the service as a number');
  }
});

test('THE SINGLE-SELECT PIN: a CSV verticalId is REJECTED — the FE must use SearchSelect', () => {
  /*
   * clientId / cityId are `csvIds` (id OR "1,2,3") and so are backed by
   * SearchMultiSelect. verticalId is a bare `intId`. Sending a CSV here is a
   * hard 400, so the filter bar MUST render a single-select. If this param is
   * ever widened to csvIds, this test fails and whoever widens it is pointed
   * straight at the control that has to change with it.
   */
  for (const bad of ['3,4', '3,', ',3', '1,2,3']) {
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

test('verticalId emits ONE EXISTS clause against tbl_vertical_mapping, param bound', async () => {
  await jobSvc.list({ status: 0, assigned: false, verticalId: 3, limit: 10, offset: 0 });
  const where = topLevelWhere();
  assert.ok(where.includes(VERTICAL_CLAUSE), `vertical clause missing from: ${where}`);
  assert.deepEqual(countQuery().params, [0, 3]);
});

test('verticalId NARROWS the bucket — status=0 + assigned=false survive intact', async () => {
  // The Pending-for-Scheduling tab IS the bucket `job_status = 0 AND
  // fk_easyfixter_id IS NULL`. An AND-ed EXISTS can only ever remove rows, so
  // the filter cannot list a job that is not in the bucket.
  await jobSvc.list({ status: 0, assigned: false, verticalId: 3, limit: 10, offset: 0 });
  assert.match(
    topLevelWhere(),
    /^WHERE j\.job_status = \? AND j\.fk_easyfixter_id IS NULL AND EXISTS \(SELECT 1 FROM tbl_vertical_mapping vm /,
  );
});

test('COUNT and data queries share the SAME where + params (COUNT-join parity)', async () => {
  await jobSvc.list({ status: 0, assigned: false, verticalId: 3, limit: 10, offset: 0 });
  const count = countQuery(); const data = dataQuery();
  assert.ok(count && data, 'both queries must have run');
  assert.ok(data.sql.includes(topLevelWhere()), 'COUNT and data must filter identically');
  // The data query appends limit + offset; everything before must match.
  assert.deepEqual(data.params.slice(0, count.params.length), count.params);
  assert.deepEqual(data.params.slice(count.params.length), [10, 0]);
});

test('THE RECORDED 500: verticalId adds NO outer alias, so COUNT needs no join', async () => {
  await jobSvc.list({ status: 0, assigned: false, verticalId: 3, limit: 10, offset: 0 });
  const count = countQuery();
  assert.doesNotMatch(count.sql, /LEFT JOIN/i, 'COUNT must stay a single-table scan');
  // Belt and braces: the clause must not name any alias the COUNT join
  // detection keys off, or it would need a join the COUNT query lacks.
  for (const alias of ['cu', 'ad', 'cl', 'ci', 'ef', 'ow']) {
    assert.doesNotMatch(
      VERTICAL_CLAUSE, new RegExp(`\\b${alias}\\.`),
      `the vertical clause must not reference the ${alias} alias`,
    );
  }
});

test('MANY-TO-MANY, ANY-MATCH: EXISTS, not a JOIN — one job stays one row', async () => {
  /*
   * A client may map to several verticals in tbl_vertical_mapping. A JOIN would
   * emit the job once per matching mapping row, inflating BOTH the page and the
   * COUNT. EXISTS short-circuits on the first match, so "the client is mapped to
   * ANY of the selected vertical(s)" costs exactly one row per job.
   */
  await jobSvc.list({ status: 0, assigned: false, verticalId: 3, limit: 10, offset: 0 });
  const where = topLevelWhere();
  assert.doesNotMatch(where, /JOIN tbl_vertical_mapping/i, 'must be EXISTS-based, never a JOIN');
  assert.doesNotMatch(dataQuery().sql, /SELECT DISTINCT/i, 'no DISTINCT crutch should be needed');
  // Correlated on the job's client — that is the job → client → vertical hop.
  assert.ok(where.includes('vm.client_id = j.fk_client_id'));
});

test('the vertical id is a bound placeholder, never inlined', async () => {
  await jobSvc.list({ status: 0, assigned: false, verticalId: 3, limit: 10, offset: 0 });
  assert.doesNotMatch(topLevelWhere(), /vm\.vertical_id = \d/, 'must be compared against ?, never a literal');
});

test('verticalId composes with the OTHER bar filters without disturbing their params', async () => {
  /*
   * The whole Pending-for-Scheduling bar at once. cityId forces the `ad.` alias
   * into the WHERE, so the COUNT query must ADD the address join — proving the
   * vertical filter did not break alias detection for its neighbours. Param
   * order follows clause order in list(): status, cityId, categoryId, verticalId.
   */
  await jobSvc.list({
    status: 0, assigned: false,
    clientId: '11', cityId: '7,9', categoryId: 5, verticalId: 3,
    limit: 10, offset: 0,
  });
  const count = countQuery();
  assert.match(count.sql, /LEFT JOIN tbl_address/i, 'cityId must still pull in the address join');
  assert.deepEqual(count.params, [0, 11, 7, 9, 5, 3], 'vertical binds last, in clause order');
  assert.ok(count.sql.includes(VERTICAL_CLAUSE));
  assert.ok(dataQuery().sql.includes(topLevelWhere()), 'and COUNT/data still agree');
});

test('no verticalId ⇒ the bucket is returned unfiltered (no clause emitted)', async () => {
  await jobSvc.list({ status: 0, assigned: false, limit: 10, offset: 0 });
  const where = topLevelWhere();
  assert.doesNotMatch(where, /tbl_vertical_mapping/, 'absent verticalId must add no clause');
  assert.match(where, /j\.fk_easyfixter_id IS NULL/, 'the bucket itself must still be returned');
  assert.deepEqual(countQuery().params, [0], 'no orphan params may be bound');
});

test('null / undefined verticalId adds no clause (defence in depth behind Joi)', async () => {
  for (const v of [undefined, null]) {
    fake.reset();
    await jobSvc.list({ status: 0, assigned: false, verticalId: v, limit: 10, offset: 0 });
    assert.doesNotMatch(topLevelWhere(), /tbl_vertical_mapping/, `${JSON.stringify(v)} must not filter`);
  }
});
