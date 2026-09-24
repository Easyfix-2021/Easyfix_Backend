/*
 * THE DASHBOARD FILTER BAR — Client / City / Vertical / Zonal Manager
 * on GET /api/admin/jobs/counts and GET /api/admin/jobs/attention-summary.
 *
 * WHAT IS ACTUALLY AT RISK
 *   The dashboard's eight funnel cards and six attention tiles are numbers an
 *   operator acts on without opening anything. Filtering them introduces the
 *   same failure this repo has already paid for twice (the client portal's
 *   Order History badge, the Pending-for-Scheduling strip): a count produced by
 *   a SECOND copy of the list's predicates drifts the first time either side is
 *   edited, and it drifts SILENTLY — a wrong number looks exactly like a right
 *   one.
 *
 *   So what is pinned here is not arithmetic. It is:
 *
 *    1. NO FILTERS = NO CHANGE. The Navbar calls /counts unfiltered and shares
 *       a cache entry with the dashboard; an unfiltered call must emit exactly
 *       the SQL it emitted before the bar existed — no stray join, no 1=1.
 *    2. Each filter's PREDICATE IS THE LIST'S, compared as text against what
 *       list() builds for the identically-named param (modulo the tbl_city
 *       alias, `ci` there and `ct` here). A new predicate on either side has to
 *       be on both.
 *    3. JOINS FOLLOW THE FILTERS. City reads ad.city_id, Zonal Manager reads
 *       ct.state_user THROUGH it — so a ZM filter must add BOTH joins. Client
 *       and Project Manager must add NEITHER: the point of the EXISTS form is
 *       that it costs no join and cannot multiply a row.
 *    4. PLACEHOLDERS AND PARAMS AGREE, in both of the two queries /counts runs
 *       — they share one `params` array, so a clause pushed without its params
 *       (or vice versa) silently shifts every later binding.
 *    5. THE FILTERS NARROW, NEVER WIDEN. A scoped caller keeps every scope
 *       clause; the filter is AND-ed on top, so picking a client outside your
 *       RBAC scope yields 0 rather than a peek over the fence.
 *    6. EVERY attention tile carries the filter, not just some. A bar that
 *       filtered the cards while the tiles stayed org-wide would mislead on
 *       exactly the row operators act on.
 *
 * Non-destructive: fake pool, no real DB, zero writes. Runner: `node --test`.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

process.env.WEBHOOK_OUTBOUND_ENABLED = 'false';

const fake = installFakePool([
  [/SHOW COLUMNS/i, []],
  [/FROM easyfix_properties/i, []],
  [/FROM tbl_job_customer_request LIMIT 1/i, []],
  [/SELECT 1 FROM tbl_job_offer LIMIT 1/i, [{ 1: 1 }]],
  [/SELECT magic_link_delivery_status FROM tbl_job LIMIT 1/i, [{ magic_link_delivery_status: null }]],
  // list(countOnly) destructures [[{ total }]] — it needs a row, not [].
  [/COUNT\(\*\) AS total/i, [{ total: 0 }]],
]);

const jobSvc = require('../services/job.service');
const { listQuery, dashboardCountsQuery, dashboardAttentionQuery, DASHBOARD_FILTERS } = require('../validators/job.validator');

// The four filters, all at once, in both shapes the bar can send: a lone id and
// a CSV (SearchMultiSelect serialises one selection as the bare id).
const FILTERS = { clientId: '3', cityId: '7,9', verticalId: '12', zonalManagerId: '11,12' };

const statusQuery = () => fake.calls.find((c) => /GROUP BY j\.job_status/.test(c.sql));
const bookedQuery = () => fake.calls.find((c) => /GROUP BY unassigned/.test(c.sql));
const countCalls  = () => fake.calls.filter((c) => /COUNT\(\*\) AS c|COUNT\(DISTINCT qd\.job_id\) AS c/.test(c.sql));

const placeholders = (sql) => (sql.match(/\?/g) || []).length;
// list() joins tbl_city as `ci`; the two aggregates join it as `ct`. Rewrite
// the DECLARATION and the references alike — the predicate is the thing under
// test, not the letter. (Matching only `ci.` leaves `LEFT JOIN tbl_city ci`
// behind and the comparison fails on the one character that does not matter.)
const sameAlias = (sql) => sql.replace(/\bci\b/g, 'ct');
const squash = (s) => s.replace(/\s+/g, ' ').trim();

beforeEach(() => fake.reset());

test('no filters: the unfiltered call is unchanged — no extra join, no extra clause', async () => {
  await jobSvc.getStatusCounts({});
  const sql = statusQuery().sql;
  assert.ok(!/tbl_address/.test(sql), 'unfiltered counts must not join tbl_address: ' + sql);
  assert.ok(!/tbl_city/.test(sql), 'unfiltered counts must not join tbl_city: ' + sql);
  assert.ok(!/WHERE/.test(sql), 'unfiltered counts must emit no WHERE at all: ' + sql);
  assert.equal(placeholders(sql), 0);
});

test('an empty filter object is the same as no filters', async () => {
  await jobSvc.getStatusCounts({ filters: {} });
  assert.ok(!/WHERE/.test(statusQuery().sql));
});

test('client filter: fk_client_id IN, and NO join', async () => {
  await jobSvc.getStatusCounts({ filters: { clientId: '3,4' } });
  const { sql, params } = statusQuery();
  assert.match(sql, /j\.fk_client_id IN \(\?,\?\)/);
  assert.ok(!/tbl_address|tbl_city/.test(sql), 'a client filter needs no join: ' + sql);
  assert.deepEqual(params, [3, 4]);
});

test('city filter: ad.city_id IN, and joins tbl_address only', async () => {
  await jobSvc.getStatusCounts({ filters: { cityId: '7,9' } });
  const { sql, params } = statusQuery();
  assert.match(sql, /ad\.city_id IN \(\?,\?\)/);
  assert.match(sql, /LEFT JOIN tbl_address ad ON ad\.address_id = j\.fk_address_id/);
  assert.ok(!/tbl_city/.test(sql), 'a city filter does not need tbl_city: ' + sql);
  assert.deepEqual(params, [7, 9]);
});

test('vertical filter: a self-contained EXISTS on vertical_id, and NO join', async () => {
  await jobSvc.getStatusCounts({ filters: { verticalId: '12,13' } });
  const { sql, params } = statusQuery();
  assert.match(squash(sql), /EXISTS \(SELECT 1 FROM tbl_vertical_mapping vm WHERE vm\.client_id = j\.fk_client_id AND vm\.vertical_id IN \(\?,\?\)\)/);
  assert.ok(!/tbl_address|LEFT JOIN tbl_client/.test(sql), 'the EXISTS form must cost no join: ' + sql);
  assert.deepEqual(params, [12, 13]);
});

/*
 * The Vertical predicate must NOT pin user_type. A client is in a vertical
 * regardless of who its SPOC is; pinning user_type = 1 here would silently turn
 * "this vertical" into "this vertical, and only where a primary SPOC exists" —
 * which is the Project Manager filter, a different question.
 */
test('vertical filter does not pin user_type — that is the PM filter, not this one', async () => {
  await jobSvc.getStatusCounts({ filters: { verticalId: '12' } });
  assert.ok(!/user_type/.test(statusQuery().sql), 'vertical filter must not constrain user_type');
});

/*
 * Project Manager stays supported on the endpoint even though the bar no longer
 * shows it (2026-09-23 swap) — the predicate is still list()'s, so putting the
 * control back is a one-line FE change rather than a backend round trip.
 */
test('project manager predicate is still available, and still pins user_type 1', async () => {
  await jobSvc.getStatusCounts({ filters: { projectManagerId: '12' } });
  const { sql, params } = statusQuery();
  assert.match(squash(sql), /EXISTS \(SELECT 1 FROM tbl_vertical_mapping vm WHERE vm\.client_id = j\.fk_client_id AND vm\.user_type = 1 AND vm\.user_id IN \(\?\)\)/);
  assert.deepEqual(params, [12]);
});

test('zonal manager filter: ct.state_user IN, and joins BOTH tbl_address and tbl_city', async () => {
  await jobSvc.getStatusCounts({ filters: { zonalManagerId: '11,12' } });
  const { sql, params } = statusQuery();
  assert.match(sql, /ct\.state_user IN \(\?,\?\)/);
  // tbl_city is reached THROUGH the address — forgetting either join leaves an
  // unresolved alias, which is a 500 on the dashboard's first paint.
  assert.match(sql, /LEFT JOIN tbl_address ad ON ad\.address_id = j\.fk_address_id/);
  assert.match(sql, /LEFT JOIN tbl_city\s+ct ON ct\.city_id\s+= ad\.city_id/);
  assert.deepEqual(params, [11, 12]);
});

test('both of /counts\' queries carry the filters, with placeholders and params in step', async () => {
  await jobSvc.getStatusCounts({ filters: FILTERS });
  const status = statusQuery();
  const booked = bookedQuery();
  for (const [label, call] of [['status', status], ['booked-split', booked]]) {
    assert.match(call.sql, /j\.fk_client_id IN/, label);
    assert.match(call.sql, /ad\.city_id IN/, label);
    assert.match(call.sql, /vm\.vertical_id IN/, label);
    assert.match(call.sql, /ct\.state_user IN/, label);
    // The two queries share ONE params array; a clause pushed without its
    // params shifts every binding after it, which binds silently and wrongly.
    assert.equal(placeholders(call.sql), call.params.length,
      `${label}: ${placeholders(call.sql)} placeholders vs ${call.params.length} params`);
  }
  assert.deepEqual(status.params, [3, 7, 9, 12, 11, 12]);  // client, city x2, vertical, zm x2
  assert.deepEqual(booked.params, status.params, 'both queries bind the same values');
});

/*
 * THE DRIFT GUARD. Not "the dashboard contains these four predicates" — that
 * passes just as well for a second, subtly different copy of them. What is
 * compared is the whole filter half (joins + WHERE) of the dashboard's query
 * against the whole filter half of list()'s own COUNT for the SAME four
 * filters, as text, plus the bound values. If either side gains, loses or
 * reshapes a predicate, this fails — which is the only way the two stay one
 * population when someone edits list() a year from now.
 */
test('the WHERE is the LIST\'s own — whole clause + params, so neither side can drift alone', async () => {
  fake.reset();
  await jobSvc.getStatusCounts({ filters: FILTERS });
  const dashCall = statusQuery();
  // Both statements are `SELECT <projection> <joins> <where>`; this is the
  // comparable half. The dashboard's GROUP BY is its own, not a filter.
  const dash = squash(dashCall.sql.slice(dashCall.sql.indexOf('FROM tbl_job j')))
    .replace(/GROUP BY j\.job_status$/, '').trim();

  fake.reset();
  await jobSvc.list({ ...FILTERS, countOnly: true });
  const listCall = fake.calls.find((c) => /^SELECT COUNT\(\*\) AS total/i.test(squash(c.sql)));
  assert.ok(listCall, 'list(countOnly) produced no COUNT query');
  const list = squash(sameAlias(listCall.sql.slice(listCall.sql.indexOf('FROM tbl_job j'))));

  assert.equal(dash, list, 'the dashboard and the grid no longer build the same filter clause');
  assert.deepEqual(dashCall.params, listCall.params, 'same clause, different bindings');

  // And it is the clause we think it is — a guard that only compared the two
  // to each other would pass if BOTH lost a predicate.
  assert.match(dash, /j\.fk_client_id IN \(\?\)/);
  assert.match(dash, /ad\.city_id IN \(\?,\?\)/);
  assert.match(dash, /EXISTS \(SELECT 1 FROM tbl_vertical_mapping vm WHERE vm\.client_id = j\.fk_client_id AND vm\.vertical_id IN \(\?\)\)/);
  assert.match(dash, /ct\.state_user IN \(\?,\?\)/);
  assert.deepEqual(dashCall.params, [3, 7, 9, 12, 11, 12]);
});

test('filters NARROW an RBAC scope, they never replace it', async () => {
  const scope = {
    clients:   { mode: 'allow', ids: [5, 6] },
    cities:    { mode: 'all',   ids: [] },
    states:    { mode: 'all',   ids: [] },
    verticals: { mode: 'all',   ids: [] },
  };
  await jobSvc.getStatusCounts({ scope, filters: { clientId: '3' } });
  const { sql, params } = statusQuery();
  // Both clauses survive, AND-ed. Client 3 is not in the scope, so the result
  // is empty — which is the honest answer, not a widened one.
  assert.match(sql, /j\.fk_client_id IN \(\?,\?\) AND j\.fk_client_id IN \(\?\)/);
  assert.deepEqual(params, [5, 6, 3], 'scope binds first, the filter after');
  assert.equal(placeholders(sql), params.length);
});

test('a scope that already joins tbl_address is not joined twice by a city filter', async () => {
  const scope = {
    clients:   { mode: 'all',   ids: [] },
    cities:    { mode: 'allow', ids: [2] },
    states:    { mode: 'all',   ids: [] },
    verticals: { mode: 'all',   ids: [] },
  };
  await jobSvc.getStatusCounts({ scope, filters: { cityId: '7' } });
  const { sql } = statusQuery();
  assert.equal((sql.match(/LEFT JOIN tbl_address/g) || []).length, 1, 'tbl_address joined twice: ' + sql);
});

test('every attention tile narrows with the bar — all six, not some', async () => {
  await jobSvc.getAttentionSummary({ filters: FILTERS });
  const calls = countCalls();
  assert.equal(calls.length, 6, 'expected 6 tile sub-queries, saw ' + calls.length);
  for (const c of calls) {
    assert.match(c.sql, /j\.fk_client_id IN/, c.sql.slice(0, 120));
    assert.match(c.sql, /ad\.city_id IN/, c.sql.slice(0, 120));
    assert.match(c.sql, /vm\.vertical_id IN/, c.sql.slice(0, 120));
    assert.match(c.sql, /ct\.state_user IN/, c.sql.slice(0, 120));
    assert.equal(placeholders(c.sql), c.params.length,
      'tile placeholders/params out of step: ' + c.sql.slice(0, 200));
  }
});

test('unfiltered attention summary is unchanged', async () => {
  await jobSvc.getAttentionSummary({});
  for (const c of countCalls()) {
    assert.ok(!/tbl_address|tbl_city/.test(c.sql), 'unfiltered tile grew a join: ' + c.sql);
  }
});

test('the validator accepts what the bar sends and strips what it does not own', () => {
  const opts = { abortEarly: false, stripUnknown: true, convert: true };

  const bare = dashboardCountsQuery.validate({}, opts);
  assert.equal(bare.error, undefined, 'the Navbar\'s unfiltered call must stay valid');
  assert.deepEqual(bare.value, {});

  /*
   * Both shapes survive, and they survive DIFFERENTLY: csvIds is an
   * alternatives(intId, csv-string), so a lone id converts to a number while a
   * CSV stays a string. That asymmetry is the existing contract every other
   * caller of these keys already lives with — toIdArray normalises both ends to
   * number[] in the service, which the params assertions above prove.
   */
  const full = dashboardCountsQuery.validate({ ...FILTERS, ownerId: '55' }, opts);
  assert.equal(full.error, undefined, full.error && full.error.message);
  assert.deepEqual(full.value, {
    clientId: 3, cityId: '7,9', verticalId: 12, zonalManagerId: '11,12', ownerId: 55,
  });

  // A key the bar does not own is dropped, not 400'd — the FE may reuse the
  // grid's query string, and a stray param should not blank the dashboard.
  const extra = dashboardCountsQuery.validate({ clientId: '3', dateType: 'created', bogus: 'x' }, opts);
  assert.equal(extra.error, undefined);
  assert.deepEqual(extra.value, { clientId: 3 });

  // Junk is still rejected.
  assert.ok(dashboardCountsQuery.validate({ clientId: 'abc' }, opts).error, 'non-numeric id must 400');
  assert.ok(dashboardCountsQuery.validate({ cityId: '-4' }, opts).error, 'negative id must 400');

  // attention-summary has never taken ownerId and must not start.
  const att = dashboardAttentionQuery.validate({ ownerId: '55', clientId: '3' }, opts);
  assert.equal(att.error, undefined);
  assert.deepEqual(att.value, { clientId: 3 });
});

test('each dashboard key is EXTRACTED from listQuery, not re-declared beside it', () => {
  assert.deepEqual(DASHBOARD_FILTERS, ['clientId', 'cityId', 'verticalId', 'zonalManagerId']);
  for (const key of DASHBOARD_FILTERS) {
    const fromList = listQuery.extract(key).describe();
    const fromDash = dashboardCountsQuery.extract(key).describe();
    assert.deepEqual(fromDash, fromList,
      `${key} has drifted from listQuery — extract it rather than re-declaring it`);
  }
});
