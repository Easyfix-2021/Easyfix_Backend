/*
 * Manage Job → Export: the filters, the RBAC scope, and the bound.
 *
 * ── THE REPORTED BUG (operator, 2026-08-20) ─────────────────────────────────
 * "Manage Job -> Export. With Closed Job filter, downloaded Open orders data."
 *
 * Not "the filter was ignored" — the EXACT COMPLEMENT of the request.
 * routes/admin/jobs.js validates /export.xlsx with `listQuery` and handed
 * req.query to services/job-export.service.js buildClauses(), which spoke only
 * the legacy Java panel's vocabulary (clientIdFromUI / dateFrom / dateTo /
 * custName, and a `status` matched by SUBSTRING against text tokens). The UI
 * sends clientId / startDate / endDate / customerQ and NUMERIC `statuses`, so
 * every filter arrived undefined and the no-filter guard substituted its own
 * WHERE. Measured on the code as it stood, EVERY case below produced the same
 * two clauses:
 *
 *     WHERE J.created_date_time >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
 *       AND J.job_status NOT IN (3, 5, 6, 7)
 *
 * 3, 5, 6 and 7 ARE the closed/terminal statuses: ask for Closed, receive
 * precisely Not-Closed. From the production log, two consecutive lines:
 *
 *     GET …/export.xlsx?statuses=3%2C5&startDate=2026-08-01&endDate=2026-08-17
 *     Export jobs xlsx · status=- clientId=- from=Sat Aug 01 2026 …
 *
 * Two more defects in the same path, fixed in the same change:
 *   • RBAC was passed to the service and never read — `grep allowedStages`
 *     returned nothing — so a scope-restricted operator exported rows they
 *     cannot see on screen. The most serious of the three.
 *   • Free-text `q` was dropped, while the route's docblock claimed it was
 *     "honoured here unlike the escalated export".
 *
 * ── WHAT THIS FILE PINS ─────────────────────────────────────────────────────
 *  1. The acceptance case: a Closed-status export returns CLOSED jobs.
 *  2. RBAC: clients / cities / verticals scope + Job Stage Access reach the
 *     query that selects the job_ids, and scope only ever NARROWS.
 *  3. The bound: which filters may lift the default window and which may not.
 *     A weak filter that lifted it would turn every export into a full-table
 *     scan — a new production-load incident wearing a bug fix's clothes.
 *  4. Coverage: every listQuery key is accounted for, and the key set is
 *     DERIVED FROM THE SCHEMA, not hand-typed. A hand-typed list would let a
 *     key added tomorrow be dropped in silence with this suite green — the
 *     original bug rebuilt inside its own regression test.
 *
 * Non-destructive: fake pool, no real DB, zero writes. Runner: `node --test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * The service reaches the DB for exactly two things in this file: the memoised
 * tbl_client.vertical_id probe (SHOW COLUMNS) and the two-phase chunk fetch.
 * Install the fake BEFORE requiring anything that captures `pool`.
 */
const fake = installFakePool([
  [/SHOW COLUMNS FROM tbl_client LIKE 'vertical_id'/i, [{ Field: 'vertical_id' }]],
  [/SHOW COLUMNS/i, []],
  [/FROM easyfix_properties/i, []],
  // Phase 1 of fetchExportChunk — the id scan. One id back is enough to prove
  // phase 2 runs; the rows themselves are irrelevant here.
  [/^SELECT J\.job_id/i, [{ job_id: 4242 }]],
]);

const {
  buildExportWhere, fetchExportChunk, FILTER_COVERAGE, UNAPPLIED_FILTERS,
} = require('../services/job-export.service');
const { listQuery } = require('../validators/job.validator');

const where = (filters) => buildExportWhere(filters).where;
// Both halves, for assertions that need to see the bound VALUES too.
const whereAndParams = (filters) => buildExportWhere(filters);
const BASELINE = where({});

/*
 * The default window an unfiltered export gets. Unchanged by this fix on
 * purpose: it is the only reason the exporter never took the box down a second
 * time, and it is what a weak filter must NOT be able to remove.
 */
const DEFAULT_FLOOR = 'J.created_date_time >= DATE_SUB(NOW(), INTERVAL 6 MONTH)';
const DEFAULT_STATUS_FLOOR = 'J.job_status NOT IN (3, 5, 6, 7)';

/* ── 1. THE ACCEPTANCE CASE ──────────────────────────────────────────────── */

test('ACCEPTANCE: a Closed-status export returns CLOSED jobs, not their complement', () => {
  /*
   * The operator's exact request, taken from the access log:
   *   ?statuses=3,5&startDate=2026-08-01&endDate=2026-08-17
   *
   * BEFORE (measured on the unfixed code, every filter dropped):
   *   WHERE J.created_date_time >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
   *     AND J.job_status NOT IN (3, 5, 6, 7)
   *   params: []
   *
   * AFTER:
   *   WHERE J.job_status IN (?, ?)
   *     AND J.created_date_time >= DATE(?)
   *     AND J.created_date_time < DATE(?) + INTERVAL 1 DAY
   *   params: [3, 5, startDate, endDate]
   */
  const filters = {
    statuses: '3,5',
    startDate: new Date('2026-08-01T00:00:00.000Z'),
    endDate: new Date('2026-08-17T00:00:00.000Z'),
  };
  const { where: w, params } = buildExportWhere(filters);

  assert.match(w, /J\.job_status IN \(\?, \?\)/, 'the asked-for statuses must be IN the WHERE');
  assert.deepEqual(params.slice(0, 2), [3, 5], 'and bound as the numeric codes the UI sent');

  // The heart of the report: the guard that produced the complement is gone.
  assert.ok(!w.includes(DEFAULT_STATUS_FLOOR),
    'the NOT IN (3, 5, 6, 7) guard must not fire once the caller pinned a status — it excluded exactly the rows asked for');
  assert.ok(!w.includes(DEFAULT_FLOOR),
    'an explicit date window replaces the default window rather than stacking on it');

  // The window itself, in list()'s IST-calendar-day form.
  assert.match(w, /J\.created_date_time >= DATE\(\?\)/);
  assert.match(w, /J\.created_date_time < DATE\(\?\) \+ INTERVAL 1 DAY/);
  assert.deepEqual(params.slice(2), [filters.startDate, filters.endDate]);
});

test('a single numeric `status` takes the same direct path (statuses wins when both are sent)', () => {
  assert.match(where({ status: 3 }), /J\.job_status IN \(\?\)/);
  assert.deepEqual(buildExportWhere({ status: 3, statuses: '6,7' }).params, [6, 7],
    '`statuses` outranks `status`, exactly as job.service list() orders them');
});

test('a NON-numeric status still takes the legacy substring-token path, untouched', () => {
  /*
   * The legacy vocabulary carries behaviour numeric codes cannot express — most
   * visibly the acknowledge/scheduling technician predicate and its documented
   * legacy bug. Reverse-mapping codes into tokens would be lossy, so the two
   * paths stay separate and the token path keeps its old output.
   */
  const w = where({ status: 'completed' });
  assert.deepEqual(buildExportWhere({ status: 'completed' }).params, [3, 5]);
  assert.match(w, /J\.job_status IN \(\?, \?\)/);

  // The documented legacy bug: acknowledge + any other tab constrains EVERY
  // selected status by the technician predicate, not just status 0.
  assert.match(where({ status: 'completed,acknowledge' }), /J\.fk_easyfixter_id IS NOT NULL/);
  // …and acknowledge + scheduling drops that half entirely.
  assert.ok(!where({ status: 'acknowledge,scheduling' }).includes('J.fk_easyfixter_id IS NOT NULL'));
});

/* ── 2. RBAC ─────────────────────────────────────────────────────────────── */

const SCOPE = {
  clients:   { mode: 'allow', ids: [7, 9] },
  cities:    { mode: 'allow', ids: [3] },
  verticals: { mode: 'allow', ids: [2] },
};

test('RBAC scope reaches the WHERE at all — it used to be dropped on the floor', () => {
  const w = where({ scope: SCOPE });
  assert.match(w, /J\.fk_client_id IN \(\?, \?\)/, 'clients scope');
  assert.match(w, /A\.city_id IN \(\?\)/, 'cities scope');
  assert.match(w, /CL\.vertical_id IN \(\?\)/, 'verticals scope');
});

test('the verticals scope reads tbl_client, NOT the many-to-many mapping', () => {
  /*
   * job.service list() scopes on cl.vertical_id. Scoping on
   * tbl_vertical_mapping instead would WIDEN: that table is many-to-many and
   * joined here with no user_type filter, so a client whose own vertical is 5
   * but which carries a mapping row for vertical 3 would be hidden in the
   * table and exported to an operator scoped to vertical 3. An RBAC fix that
   * widens is worse than no fix.
   */
  const w = where({ scope: SCOPE });
  assert.ok(!/TVM\.vertical_id IN/.test(w), 'must not scope through tbl_vertical_mapping');
});

test('the verticalId FILTER stays independent of the verticals SCOPE', () => {
  /*
   * The filter is an EXISTS on the mapping (list()'s shape); the scope is
   * CL.vertical_id. If the scope were written against the V join instead, the
   * two could never both hold for different ids and the sheet would come back
   * EMPTY with nothing in it to explain why.
   */
  const w = where({ scope: SCOPE, verticalId: 3 });
  assert.match(w, /EXISTS \(SELECT 1 FROM tbl_vertical_mapping vm WHERE vm\.client_id = J\.fk_client_id AND vm\.vertical_id = \?\)/);
  assert.match(w, /CL\.vertical_id IN \(\?\)/);
});

test('cityId and the cities scope filter the SAME column', () => {
  /*
   * Two columns for one concept inside one function is how a job whose address
   * city has no tbl_city row appears on screen and vanishes from the sheet.
   * list() uses ad.city_id for both; here that is A.city_id for both.
   */
  const w = where({ scope: SCOPE, cityId: '11,12' });
  const matches = w.match(/A\.city_id IN \(/g) || [];
  assert.equal(matches.length, 2, 'scope and filter both land on A.city_id');
  assert.ok(!/city\.city_id/.test(w), 'and neither uses the tbl_city PK');
});

test('scope NARROWS: an out-of-scope clientId yields nothing, never that client’s rows', () => {
  const { where: w, params } = buildExportWhere({ scope: SCOPE, clientId: '99' });
  // Both predicates are present and ANDed, so client 99 ∧ client ∈ {7,9} = ∅.
  assert.match(w, /J\.fk_client_id IN \(\?, \?\)[\s\S]*J\.fk_client_id IN \(\?\)/);
  assert.deepEqual(params, [7, 9, 3, 2, 99]);
});

test('mode "none" on any dimension is zero rows, not "everything"', () => {
  for (const dim of ['clients', 'cities', 'verticals']) {
    const w = where({ scope: { ...SCOPE, [dim]: { mode: 'none', ids: [] } } });
    assert.match(w, /1=0/, `${dim} mode=none must emit 1=0`);
  }
});

test('Job Stage Access restricts the exported statuses', () => {
  const { where: w, params } = buildExportWhere({ allowedStages: { mode: 'list', stages: ['pending-close'] } });
  assert.match(w, /J\.job_status IN \(\?, \?\)/);
  assert.deepEqual(params.sort((a, b) => a - b), [2, 20],
    'the same union lib/job-stages.js gives the jobs list');
});

test('stage access INTERSECTS a status filter, it never replaces it', () => {
  const w = where({ allowedStages: { mode: 'list', stages: ['pending-close'] }, statuses: '2' });
  assert.equal((w.match(/J\.job_status IN \(/g) || []).length, 2,
    'two independent job_status pins, ANDed — a caller cannot widen past their stages');
});

test('an empty stage union is zero rows; mode "all" adds nothing', () => {
  assert.match(where({ allowedStages: { mode: 'list', stages: ['not-a-stage'] } }), /1=0/);
  assert.equal(where({ allowedStages: { mode: 'all' } }), BASELINE);
});

test('RBAC lands in PHASE 1 — the query that selects the job_ids', async () => {
  /*
   * Phase 2 hydrates BY ID and re-filters nothing, so a predicate applied only
   * there is worthless. This asserts on the statement the service actually
   * sends, not on buildExportWhere's return value.
   */
  fake.reset();
  await fetchExportChunk({
    filters: { scope: SCOPE, allowedStages: { mode: 'list', stages: ['pending-close'] } },
    chunkSize: 10,
  });
  const idQuery = fake.calls.find((c) => /^SELECT J\.job_id/i.test(c.sql));
  assert.ok(idQuery, 'phase 1 must run');
  assert.match(idQuery.sql, /J\.fk_client_id IN/, 'clients scope in the id scan');
  assert.match(idQuery.sql, /A\.city_id IN/, 'cities scope in the id scan');
  assert.match(idQuery.sql, /CL\.vertical_id IN/, 'verticals scope in the id scan');
  assert.match(idQuery.sql, /J\.job_status IN/, 'stage access in the id scan');
  assert.ok(idQuery.params.includes(7) && idQuery.params.includes(3) && idQuery.params.includes(2),
    'and bound, not string-built');
});

/* ── 3. THE BOUND ────────────────────────────────────────────────────────── */

test('with NO filters at all, the export is the last 6 months of non-terminal jobs', () => {
  assert.equal(BASELINE,
    `WHERE ${DEFAULT_FLOOR} AND ${DEFAULT_STATUS_FLOOR}`,
    'the pre-existing default is deliberately unchanged');
});

test('a WEAK filter must NOT lift the default window', () => {
  /*
   * This is the defect that sank the first attempt at this fix. Once ANY
   * filter lifted the cap, `reopen=false` ALONE produced
   *   WHERE (J.job_reopen_flag = 0 OR J.job_reopen_flag IS NULL)
   * with no date and no status bound, over ~450k rows, streamed to the
   * 200,000-row ceiling. Before the fix every export was capped; shipping that
   * would have been a NEW production-load incident, not a fix.
   */
  const weak = {
    'reopen=false':      { reopen: 'false' },
    'assigned=false':    { assigned: 'false' },
    'sourceType':        { sourceType: 'website' },
    'one-character q':   { q: 'a' },          // listQuery allows length 1
    'dueTo':             { dueTo: 'client' },
    'clientId':          { clientId: '12,34' },
    'cityId':            { cityId: '3' },
    'categoryId':        { categoryId: 4 },
    'verticalId':        { verticalId: 2 },
    'ownerId':           { ownerId: 8 },
    'startDate alone':   { startDate: new Date('2020-01-01T00:00:00.000Z') },
    'endDate alone':     { endDate: new Date('2026-08-17T00:00:00.000Z') },
    'RBAC scope':        { scope: SCOPE },
  };
  for (const [label, filters] of Object.entries(weak)) {
    assert.ok(where(filters).includes(DEFAULT_FLOOR),
      `${label} must not remove the 6-month floor`);
  }
});

test('a single-character q does not become eleven unbounded leading-wildcard LIKEs', () => {
  const { where: w, params } = buildExportWhere({ q: 'a' });
  assert.equal(params.filter((p) => p === '%a%').length, 11, 'eleven terms, eleven binds');
  assert.ok(w.includes(DEFAULT_FLOOR), 'and still inside the default window');
});

test('a COMPLETE date window is the caller’s own bound and replaces the default', () => {
  const w = where({
    startDate: new Date('2024-01-01T00:00:00.000Z'),
    endDate: new Date('2024-03-01T00:00:00.000Z'),
  });
  assert.ok(!w.includes(DEFAULT_FLOOR));
  assert.ok(!w.includes(DEFAULT_STATUS_FLOOR),
    'a date-bounded export is bounded; the status floor has no work left to do');
});

test('an EQUALITY on an identity column bounds the export by itself', () => {
  for (const filters of [
    { jobsId: '12345' },
    { jobsId: 'REF12345' },
    { customerId: 91 },
    { easyfixerId: 55 },
    { easyfixerMobileNumber: '9876543210' },
    { clientReferenceId: 'ABC-1' },
  ]) {
    const w = where(filters);
    assert.ok(!w.includes(DEFAULT_FLOOR), `${JSON.stringify(filters)} is bounded by what it selects`);
  }
});

test('a status pin keeps the window but drops the status floor', () => {
  /*
   * "Closed jobs, no dates given" is a legitimate ask: honour the status,
   * still cap the history. The two guards are independent for exactly this.
   */
  const w = where({ statuses: '3,5' });
  assert.ok(w.includes(DEFAULT_FLOOR), 'still capped at 6 months');
  assert.ok(!w.includes(DEFAULT_STATUS_FLOOR), 'but not forced back to non-terminal statuses');
  assert.match(w, /J\.job_status IN \(\?, \?\)/);
});

test('a stage grant INSIDE the terminal set still returns rows', () => {
  /*
   * THE BLOCKER THE FIRST CUT SHIPPED. lib/job-stages.js gives 'audit-complete'
   * the visible set [3, 5] and 'cancelled' [6] — both entirely inside the
   * terminal statuses the default floor removes. ANDing the two produced
   *
   *     J.job_status IN (3, 5) AND J.job_status NOT IN (3, 5, 6, 7)
   *
   * which is zero rows, always, silently: a permanently empty export for the
   * audit team. Every stage test here used 'pending-close' (2, 20) or
   * 'unconfirmed' (9), which is why the suite was green.
   */
  for (const [stages, expected] of [[['audit-complete'], [3, 5]], [['cancelled'], [6]]]) {
    const r = whereAndParams({ allowedStages: { mode: 'list', stages } });
    assert.ok(r.where.includes('J.job_status IN'), `${stages} must pin the status set`);
    assert.equal(
      r.where.includes(DEFAULT_STATUS_FLOOR), false,
      `${stages}: the terminal floor must not be ANDed onto a stage grant — that is zero rows`,
    );
    assert.deepEqual(r.params.slice(0, expected.length), expected);
    // the DATE floor still bounds it
    assert.ok(r.where.includes(DEFAULT_FLOOR), 'the window floor still applies');
  }
});

test('a MIXED stage grant keeps every status the operator can see on screen', () => {
  // The plausible-looking failure: the sheet renders, and silently omits the
  // Audit & Complete rows while keeping the Unconfirmed ones.
  const r = whereAndParams({ allowedStages: { mode: 'list', stages: ['unconfirmed', 'audit-complete'] } });
  for (const st of [9, 3, 5]) {
    assert.ok(r.params.includes(st), `status ${st} is visible on screen and must be in the sheet`);
  }
  assert.equal(r.where.includes(DEFAULT_STATUS_FLOOR), false);
});

test('RBAC scope alone can never lift a guard', () => {
  /*
   * A scope is the boundary of what an operator may ever see, not a filter
   * they chose. If it lifted the cap, a scoped operator exporting with no
   * filters would pull their entire client's history.
   */
  const w = where({ scope: SCOPE, allowedStages: { mode: 'list', stages: ['pending-close'] } });
  // The DATE floor is what bounds the row count, and RBAC must never lift it.
  assert.ok(w.includes(DEFAULT_FLOOR), 'a scope must not lift the window');
  /*
   * The STATUS floor is a different matter, and this assertion used to demand
   * the opposite — passing only vacuously, because the sample stage
   * 'pending-close' is [2, 20] and does not overlap the terminal set. Stages
   * that DO overlap made the two predicates annihilate each other; see the
   * cases below, which are the ones that were missing.
   */
});

/* ── 4. COVERAGE, DERIVED FROM THE SCHEMA ────────────────────────────────── */

/*
 * A representative, VALID value per listQuery key. Values are chosen so the
 * schema accepts them (asserted below), which is what stops this map drifting
 * into fiction.
 */
const SAMPLE = {
  q: 'ravi',
  status: 3,
  statuses: '3,5',
  assigned: 'false',
  isEscalated: 'true',
  noServices: 'true',
  offerState: 'offered',
  clientId: '12,34',
  cityId: '3',
  projectManagerId: '8',
  zonalManagerId: '9',
  ownerId: 8,
  easyfixerId: 55,
  customerId: 91,
  customerQ: 'ravi',
  clientRef: 'ABC-1',
  efrMobile: '9876543210',
  pin: '110001',
  stateId: 2,
  categoryId: 4,
  verticalId: 2,
  sourceType: 'website',
  dateType: 'scheduled',
  rating: 4,
  reopen: 'true',
  dueTo: 'client',
  zonalId: 6,
  startDate: '2026-08-01',
  endDate: '2026-08-17',
  quotationStatus: 'approved',
  requestedBefore: 'now',
  sortBy: 'job_id',
  sortDir: 'asc',
  limit: 50,
  offset: 0,
};

test('THE LEDGER IS DERIVED, NOT TYPED: every listQuery key is accounted for', () => {
  /*
   * ⚠ The one assertion that keeps this whole file honest. The key set comes
   * from `listQuery.describe().keys` — the schema itself — so a filter added
   * to the validator tomorrow FAILS HERE instead of being silently dropped by
   * the export, which is precisely how the reported bug happened. A hand-typed
   * copy of the key list would rebuild that bug inside its own regression test.
   */
  const schemaKeys = Object.keys(listQuery.describe().keys).sort();
  const ledgerKeys = Object.keys(FILTER_COVERAGE).sort();
  assert.deepEqual(ledgerKeys, schemaKeys,
    'FILTER_COVERAGE in services/job-export.service.js must list EVERY listQuery key and no others');

  const sampleKeys = Object.keys(SAMPLE).sort();
  assert.deepEqual(sampleKeys, schemaKeys, 'and this test must exercise every one of them');
});

test('every SAMPLE value is one the validator actually accepts', () => {
  for (const [key, value] of Object.entries(SAMPLE)) {
    const { error } = listQuery.validate({ [key]: value });
    assert.equal(error, undefined, `${key}=${JSON.stringify(value)} must be a legal listQuery value`);
  }
});

test('every key the ledger calls a FILTER emits a predicate', () => {
  /*
   * The original bug in one assertion: a filter that is claimed to be honoured
   * but produces no SQL. Each key is sent ALONE and must change the WHERE.
   */
  for (const [key, [kind]] of Object.entries(FILTER_COVERAGE)) {
    if (kind !== 'filter') continue;
    const w = where({ [key]: SAMPLE[key] });
    assert.notEqual(w, BASELINE, `${key} is declared a filter but emitted nothing`);
  }
});

test('every key the ledger calls IGNORED emits nothing — no accidental predicates', () => {
  for (const [key, [kind]] of Object.entries(FILTER_COVERAGE)) {
    if (kind !== 'ignored') continue;
    assert.equal(where({ [key]: SAMPLE[key] }), BASELINE,
      `${key} is declared ignored but changed the WHERE`);
  }
});

test('`dateType` is a MODIFIER: it moves the column the window applies to', () => {
  const range = { startDate: SAMPLE.startDate, endDate: SAMPLE.endDate };
  assert.match(where(range), /J\.created_date_time >= DATE\(\?\)/, 'default is created_date_time');
  assert.match(where({ ...range, dateType: 'scheduled' }), /J\.scheduled_date_time >= DATE\(\?\)/);
  assert.match(where({ ...range, dateType: 'completed' }), /J\.checkout_date_time >= DATE\(\?\)/);
  // Unknown value falls back rather than 400ing, exactly as list() does, so a
  // stale bookmark still returns something sensible.
  assert.match(where({ ...range, dateType: 'nonsense' }), /J\.created_date_time >= DATE\(\?\)/);
  assert.equal(where({ dateType: 'scheduled' }), BASELINE, 'and on its own it emits nothing');
});

test('the route’s "cannot apply" list is derived from the ledger', () => {
  const expected = Object.keys(FILTER_COVERAGE)
    .filter((k) => FILTER_COVERAGE[k][0] === 'ignored' && !['limit', 'offset', 'isEscalated'].includes(k));
  assert.deepEqual([...UNAPPLIED_FILTERS], expected);
  // isEscalated is NOT reported as dropped: list() ignores it identically, so
  // the sheet still matches the screen. limit/offset are not filters here.
  assert.ok(!UNAPPLIED_FILTERS.includes('isEscalated'));
  assert.ok(!UNAPPLIED_FILTERS.includes('limit'));
});

/* ── 5. THE PREDICATES THAT MUST MIRROR job.service list() ───────────────── */

test('q searches list()’s eleven columns, including the ones needing no new join', () => {
  const w = where({ q: 'ravi' });
  for (const term of [
    'CAST(J.job_id AS CHAR) LIKE ?',
    'J.job_reference_id LIKE ?',
    'J.client_ref_id LIKE ?',
    "COALESCE(NULLIF(TRIM(J.job_customer_name), ''), C.customer_name) LIKE ?",
    'C.customer_mob_no LIKE ?',
    'CL.client_name LIKE ?',
    'city.city_name LIKE ?',
    'EFR.efr_name LIKE ?',
    'J.client_spoc_name LIKE ?',
    'J.client_spoc LIKE ?',
  ]) {
    assert.ok(w.includes(term), `q must search ${term}`);
  }
  /*
   * The owner term is an EXISTS, not a join: FILTER_FROM deliberately omits
   * the ten tbl_user self-joins so the id scan walks an index instead of
   * building projections it will never select.
   */
  assert.match(w, /EXISTS \(SELECT 1 FROM tbl_user qow WHERE qow\.user_id = J\.job_owner AND qow\.user_name LIKE \?\)/);
});

test('the customer-name term is the JOB’s name with the master as fallback', () => {
  /*
   * A plain COALESCE would blank the name for every job whose
   * job_customer_name is an empty string rather than NULL, and searching the
   * master name alone returns nothing for every job that overrides it.
   */
  for (const w of [where({ q: 'ravi' }), where({ customerQ: 'ravi' })]) {
    assert.ok(w.includes("COALESCE(NULLIF(TRIM(J.job_customer_name), ''), C.customer_name)"));
  }
});

test('startDate/endDate use DATE() on the PARAMETER, never on the column', () => {
  /*
   * Two reasons, both measured in list() on 2026-08-18: DATE() on the column
   * makes the predicate non-SARGable, and the params are Joi dates serialised
   * at the pool's +05:30 — so a raw `>= ? AND <= ?` made start = end return
   * NOTHING and skewed every other range by 5.5 hours.
   */
  const w = where({ startDate: SAMPLE.startDate, endDate: SAMPLE.endDate });
  assert.ok(!/DATE\(J\./.test(w), 'the column must never be wrapped');
  assert.match(w, /J\.created_date_time < DATE\(\?\) \+ INTERVAL 1 DAY/,
    'exclusive next-day upper bound, so the final day is whole');
});

test('csvIds filters accept a LIST — Number("12,34") is NaN and used to drop them', () => {
  assert.deepEqual(buildExportWhere({ clientId: '12,34' }).params, [12, 34]);
  assert.deepEqual(buildExportWhere({ cityId: '3,4,5' }).params, [3, 4, 5]);
  assert.deepEqual(buildExportWhere({ zonalManagerId: '9,10' }).params, [9, 10]);
  assert.deepEqual(buildExportWhere({ projectManagerId: '8' }).params, [8]);
  // …and a lone id still works, for the single-select callers.
  assert.deepEqual(buildExportWhere({ clientId: 12 }).params, [12]);
});

test('zonalId keeps its LEGACY meaning (the zonal MANAGER), zonalManagerId matches it', () => {
  /*
   * `zonalId` means two different things in the two vocabularies and it is the
   * one name they cannot share: legacy = tbl_city.state_user, list() = a zone
   * via tbl_zone_city_mapping. The legacy reading is kept because nothing
   * reachable sends the other one — Easyfix_CRM_UI's "Zonal" control was
   * rewired on 2026-08-18 to send `zonalManagerId` ("Zonal MANAGERS, not
   * zones") and no control writes filters.zonalId any more. The route logs the
   * param when it appears so the collision can never be silent.
   */
  assert.match(where({ zonalId: 6 }), /city\.state_user = \?/);
  assert.ok(!/tbl_zone_city_mapping/.test(where({ zonalId: 6 })),
    'do not "correct" this to the zone-mapping table without re-reading ZONAL_ID_COLLISION');
  assert.match(where({ zonalManagerId: '9' }), /city\.state_user IN \(\?\)/);
});

test('the deliberate legacy quirks survive', () => {
  // checkoutdatetime pins the completed statuses — legacy did this on that one
  // date type only, and it counts as the caller pinning a status.
  const w = where({ dateFrom: '2026-01-01', dateTo: '2026-01-31', dateType: 'checkoutdatetime' });
  assert.match(w, /J\.job_status IN \(3, 5\)/);
  // Legacy's unbalanced-paren aging-bucket bug is still emitted as ONE balanced
  // OR group (three buckets used to be a hard SQL error).
  assert.match(where({ bucketAgingRange: '1,2,3' }), /\(\(DATE_SUB\(NOW\(\), INTERVAL 24 HOUR\)[\s\S]*\)\)/);
  // The legacy pinCode filter stays a PREFIX match (index-usable); listQuery's
  // `pin` is list()'s CONTAINS form. Different names, different wraps, both
  // deliberate.
  assert.deepEqual(buildExportWhere({ pinCode: '110' }).params, ['110%']);
  assert.deepEqual(buildExportWhere({ pin: '110' }).params, ['%110%']);
});

/* ═══ the second-pass review findings, pinned ════════════════════════════ */

test('an empty `statuses` owns the status dimension — it must not fall through to `status`', () => {
  /*
   * services/job.service.js list() short-circuits on `statuses != null`: once
   * present it owns the dimension even when it parses to nothing. Falling
   * through to `status` would emit a clause the SCREEN does not have, making
   * the sheet narrower than the table — the divergence this change exists to
   * close, reintroduced on an edge case.
   */
  const w = where({ statuses: [], status: '9' });
  assert.equal(w.includes('J.job_status IN'), false,
    'an empty statuses[] must not let `status` emit a clause the screen lacks');
});

test('the default bounds REPORT themselves — no silent narrowing left', () => {
  /*
   * The complaint that started this work was a sheet that disagreed with the
   * screen and said nothing about it. The defaults are the last place this
   * module narrows without being asked, so they announce it; the route logs
   * them on the same request id as the export.
   */
  const bare = buildExportWhere({});
  assert.ok(Array.isArray(bare.appliedDefaults) && bare.appliedDefaults.length >= 2,
    'an unfiltered export imposes a window AND a status floor, and must say so');
  assert.ok(bare.appliedDefaults.some((d) => d.startsWith('window:')));
  assert.ok(bare.appliedDefaults.some((d) => d.startsWith('status:')));

  // A caller who pinned status gets the window default only — and is told which.
  const pinned = buildExportWhere({ statuses: '3,5' });
  assert.ok(pinned.appliedDefaults.some((d) => d.startsWith('window:')));
  assert.equal(pinned.appliedDefaults.some((d) => d.startsWith('status:')), false,
    'the caller pinned status, so no status default was imposed');

  // A caller who bounded it themselves gets nothing imposed at all.
  const bounded = buildExportWhere({ startDate: '2026-08-01', endDate: '2026-08-17' });
  assert.deepEqual(bounded.appliedDefaults, [],
    'an explicit window is the caller bounding their own query');
});

test('the default window follows the OPERATOR’S date axis, never a second one', () => {
  /*
   * checkout_date_time is populated only on statuses 3 and 5. A default floor
   * on created_date_time alongside a window on checkout_date_time put the two
   * bounds on different columns; combined with the terminal-status floor it
   * removed every job the query was about. Reachable in two clicks, because
   * both date inputs are optional and independent.
   */
  const w = where({ dateType: 'completed', startDate: '2026-08-01' });
  assert.ok(w.includes('J.checkout_date_time >= DATE(?)'), 'the operator’s window');
  assert.ok(w.includes('J.checkout_date_time >= DATE_SUB'), 'and the default on the SAME column');
  assert.equal(w.includes('J.created_date_time >= DATE_SUB'), false,
    'a second bound on a different axis is what emptied the sheet');
  assert.equal(w.includes(DEFAULT_STATUS_FLOOR), false,
    'naming a lifecycle axis pins the status dimension');
});

test('`dateType` ALONE still emits nothing — it is a modifier, not a filter', () => {
  // Reading a status pin out of the modifier alone would make an operator who
  // merely switched a dropdown silently change which jobs they get.
  assert.equal(where({ dateType: 'completed' }), BASELINE);
});

// ─── Export cell formatting (2026-08-21) ─────────────────────────────
//
// Three reported defects in Manage Jobs → Export:
//   Job Id, Current TX Id and Previous TX Id rendered with a thousands
//   separator ("522,124"), and Job Owner showed a user id instead of a name.

const { EXPORT_COLUMNS: COLS } = require('../services/job-export.service');

test('identifier columns use type "id" so they carry NO thousands separator', () => {
  // '#,##0' turns job 522124 into "522,124", which cannot be pasted back into
  // a search box. Identifiers are numeric but are not quantities.
  for (const key of ['jobId', 'txId', 'preTxId']) {
    const col = COLS.find((c) => c.key === key);
    assert.ok(col, `column ${key} must exist`);
    assert.equal(col.type, 'id', `${key} must be type "id", not "number"`);
  }
});

test('genuine quantities keep type "number" and their separator', () => {
  // The fix must not strip grouping from counts and money.
  for (const key of ['totalCharge', 'efShare', 'aging']) {
    const col = COLS.find((c) => c.key === key);
    assert.ok(col, `column ${key} must exist`);
    assert.equal(col.type, 'number', `${key} is a quantity and must keep grouping`);
  }
});

test('the exporter maps type "id" to a plain integer format', () => {
  const src = require('node:fs').readFileSync(
    require.resolve('../utils/xlsx-stream-export.js'), 'utf8',
  );
  assert.match(src, /const ID_NUM_FMT = '0';/, 'id columns must format as a bare integer');
  assert.match(src, /c\.type === 'id'\s*\?\s*\{ numFmt: ID_NUM_FMT \}/, 'the id branch must be wired');
});

test('Job Owner prefers the resolved name and falls back to the raw id', () => {
  const { mapExportRow } = require('../services/job-export.service');
  const withName = mapExportRow({ job_id: 1, job_primary_spoc: '4471', job_primary_spoc_name: 'Bhawana' }, 1);
  assert.equal(withName.jobOwner, 'Bhawana', 'a resolved name must win');

  // A deleted user, or a pre-2026 non-numeric value, must not blank the cell.
  const unresolved = mapExportRow({ job_id: 2, job_primary_spoc: '4471' }, 2);
  assert.equal(unresolved.jobOwner, '4471', 'unresolved falls back to the id, never to empty');

  const absent = mapExportRow({ job_id: 3 }, 3);
  assert.equal(absent.jobOwner, null, 'a DB without the column yields a blank cell');
});
