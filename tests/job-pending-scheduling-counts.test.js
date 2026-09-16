/*
 * The My Orders → Pending for Scheduling TAB STRIP:
 * GET /api/admin/jobs/pending-scheduling/counts → { all, pending, offered, expired }.
 *
 * The four tabs (All / Not offered / Offered-waiting / No takers) are the four
 * `offerState` values the LIST already takes, so every count sits directly above
 * the page it counts. That is the whole risk: a badge whose number is produced
 * by a second copy of the list's predicates drifts the first time either side is
 * edited, and it drifts SILENTLY — a wrong number looks exactly like a right
 * one. This repo has the receipt: the client portal's Order History badge was a
 * hand-written COUNT of the list's WHERE and stopped agreeing with it, which is
 * why list() grew `countOnly` (see its note) and now `groupByOfferState`.
 *
 * So what is pinned here is not the arithmetic — it is the SHARING:
 *
 *  1. ONE query, grouped. Not four filtered counts, and not a count per tab.
 *  2. The strip's WHERE + params are IDENTICAL to the WHERE + params the list's
 *     own COUNT query builds for the same filters — compared as text, so a new
 *     predicate on either side has to be on both.
 *  3. The GROUP BY key is the SAME CASE ladder the list projects as each row's
 *     `offer_state` chip (offerStateCaseSql), alias-renaming aside. A tab's
 *     number and the chips on the rows it lists cannot describe different sets.
 *  4. `offerState` cannot reach the service from this entrypoint — it would
 *     narrow the population BEFORE the grouping and zero three of four numbers.
 *  5. `all` = pending + offered + expired, with the ACCEPTED-offer anomaly
 *     ('none', which no tab can list) excluded rather than folded in.
 *  6. tbl_job_offer absent ⇒ the bucket counts as entirely 'pending', with no
 *     reference to the missing table — the same degradation the filter makes.
 *
 * Non-destructive: fake pool, no real DB, zero writes. Runner: `node --test`.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

// Controls what the memoised tbl_job_offer existence probe sees, and what the
// two count shapes come back with. Set per test.
const scenario = { jobOfferTableExists: true, groups: [], total: 0 };

const fake = installFakePool([
  [/SHOW COLUMNS/i, []],
  [/FROM easyfix_properties/i, []],
  [/FROM tbl_job_customer_request LIMIT 1/i, []],
  [/SELECT 1 FROM tbl_job_offer LIMIT 1/i, () => {
    if (!scenario.jobOfferTableExists) {
      const e = new Error("Table 'easyfix_core.tbl_job_offer' doesn't exist");
      e.code = 'ER_NO_SUCH_TABLE';
      throw e;
    }
    return [{ 1: 1 }];
  }],
  [/SELECT magic_link_delivery_status FROM tbl_job LIMIT 1/i, [{ magic_link_delivery_status: null }]],
  [/AS offer_state, COUNT\(\*\) AS c/i, () => scenario.groups],
  [/^SELECT COUNT\(\*\) AS total/i, () => [{ total: scenario.total }]],
]);

const jobSvc = require('../services/job.service');
const {
  listQuery, pendingSchedulingCountsQuery, PENDING_SCHEDULING_COUNT_FILTERS,
} = require('../validators/job.validator');

const groupQuery = () => fake.calls.find((c) => /AS offer_state, COUNT\(\*\) AS c/.test(c.sql));
const countQuery = () => fake.calls.find((c) => /^SELECT COUNT\(\*\) AS total/i.test(c.sql));
const dataQuery  = () => fake.calls.find((c) => /LIMIT \? OFFSET \?/.test(c.sql));

/*
 * Everything after the projection: the joins the alias-sniffing chose plus the
 * WHERE. Both statements are `SELECT <projection> ${countJoin} ${where}`, so
 * this is the comparable half — and it is compared as TEXT, because the point is
 * that one builder produced both.
 */
const filterHalf = (sql) => sql.slice(sql.indexOf('FROM tbl_job j')).replace(/GROUP BY offer_state\s*$/, '').trim();

// Collapse the offer subquery aliases so the two renderings of the one ladder
// (the strip's josc/josc2/josc3, the chip's jo6/jo7/jo8, and their `…e`/`…m`
// children) compare as the expressions they are.
const sameLadder = (sql) => sql.replace(/\bjosc\d?/g, 'A').replace(/\bjo[678]/g, 'A');
const ladderOf = (re, sql) => {
  const m = re.exec(sql);
  assert.ok(m, 'no offer_state CASE found in: ' + sql.slice(0, 400));
  return sameLadder(m[1]);
};

// The filters the strip forwards, all at once — including the two CSV ones and
// the free-text search, i.e. every shape the grid's filter card can send.
const FILTERS = { q: 'bosch', categoryId: 21, cityId: '7,9', clientId: '3', zonalManagerId: '11,12' };

beforeEach(() => {
  fake.reset();
  scenario.jobOfferTableExists = true;
  scenario.groups = [];
  scenario.total = 0;
});

/* ── 1. One grouped query ────────────────────────────────────────────────── */

test('ONE grouped query — never one count per tab, never a page of rows', async () => {
  await jobSvc.getPendingSchedulingCounts({});
  const grouped = fake.calls.filter((c) => /AS offer_state, COUNT\(\*\) AS c/.test(c.sql));
  assert.equal(grouped.length, 1, 'four tabs must cost one query, not four');
  assert.equal(countQuery(), undefined, 'no separate COUNT(*) — the groups carry the totals');
  assert.equal(dataQuery(), undefined, 'a count endpoint must never run the data query');
  assert.match(grouped[0].sql, /GROUP BY offer_state\s*$/, 'the grouping is what makes it one query');
});

/* ── 2. The strip filters exactly as the grid does ───────────────────────── */

test('the strip and the grid are the SAME where + params (they cannot disagree)', async () => {
  await jobSvc.getPendingSchedulingCounts(FILTERS);
  const strip = groupQuery();

  fake.reset();
  // What the grid's "All" tab sends: the same filters, the bucket pinned, no
  // offerState. Its COUNT query is the number the strip's `all` must match.
  await jobSvc.list({ ...FILTERS, status: 0, assigned: false, limit: 50, offset: 0 });
  const grid = countQuery();

  assert.equal(filterHalf(strip.sql), filterHalf(grid.sql), 'joins + WHERE must be identical text');
  assert.deepEqual(strip.params, grid.params, 'and bound identically, in the same order');
  // The bucket itself, spelt out: a strip that lost either pin would count the
  // whole book. status is bound (0), the assignment test is a literal.
  assert.match(filterHalf(strip.sql), /WHERE j\.job_status = \? AND j\.fk_easyfixter_id IS NULL\b/);
  assert.equal(strip.params[0], jobSvc.STATUS.BOOKED);
  // cityId / zonalManagerId reference `ad.` / `ci.`, so the alias sniffing must
  // have pulled their joins into the strip too — the recorded COUNT-join 500.
  assert.match(strip.sql, /LEFT JOIN tbl_address/i);
  assert.match(strip.sql, /LEFT JOIN tbl_city/i);
});

test('every filter the endpoint accepts actually reaches the WHERE', async () => {
  // A filter silently dropped between the route and list() is the failure this
  // catches: the strip would answer for a wider population than the grid shows.
  for (const [key, value] of Object.entries(FILTERS)) {
    fake.reset();
    await jobSvc.getPendingSchedulingCounts({ [key]: value });
    const withFilter = filterHalf(groupQuery().sql);
    fake.reset();
    await jobSvc.getPendingSchedulingCounts({});
    assert.notEqual(withFilter, filterHalf(groupQuery().sql), `${key} changed nothing — it is being dropped`);
  }
});

/* ── 3. The GROUP BY key IS the chip ─────────────────────────────────────── */

test('rows are bucketed by the SAME ladder the list projects as the row chip', async () => {
  await jobSvc.getPendingSchedulingCounts({});
  const strip = ladderOf(/SELECT (CASE[\s\S]+?END) AS offer_state, COUNT/, groupQuery().sql);
  // offerColumns() is the LIST projection — the chip the operator reads on the
  // row. Same expression, or a tab can list a row whose chip contradicts it.
  const chip = ladderOf(/\((CASE[\s\S]+?END)\) AS offer_state/, jobSvc.offerColumns(true, jobSvc.offerExpiryEnabled()));
  assert.equal(strip, chip, 'the tab counts and the row chips must be one expression');
  // And it is the shared builder that produced both, not two texts that happen
  // to match today.
  assert.ok(
    groupQuery().sql.includes(jobSvc.offerStateCaseSql(jobSvc.offerExpiryEnabled(), ['josc', 'josc2', 'josc3'])),
    'the strip must render offerStateCaseSql, not a ladder of its own',
  );
  // A projection/GROUP BY fragment carries NO placeholders: the params belong to
  // the WHERE, positionally, and an inlined constant is what keeps that true.
  assert.doesNotMatch(
    groupQuery().sql.slice(0, groupQuery().sql.indexOf('FROM tbl_job j')), /\?/,
    'the bucket expression must inline its constants — a ? here would shift every param',
  );
});

/* ── 4. offerState cannot get in ─────────────────────────────────────────── */

test('offerState cannot reach the service — it would zero three of the four numbers', async () => {
  await jobSvc.getPendingSchedulingCounts({ ...FILTERS, offerState: 'offered' });
  const withIt = groupQuery();
  fake.reset();
  await jobSvc.getPendingSchedulingCounts(FILTERS);
  assert.equal(withIt.sql, groupQuery().sql, 'offerState must not change the statement');
  assert.deepEqual(withIt.params, groupQuery().params, 'nor bind anything');
  // `jos…` is the FILTER's alias and nothing else uses it (the strip's ladder is
  // josc…, the projection's is jo…). An exact probe for "the filter fired".
  assert.doesNotMatch(withIt.sql, /tbl_job_offer jos\d?\s/, 'no offerState clause may be emitted');
});

test('the caller cannot re-point the bucket either', async () => {
  // status / assigned are the endpoint's identity, not its input: an endpoint
  // named for Pending-for-Scheduling that counted some other bucket would be
  // wrong in a way nothing on screen could reveal.
  await jobSvc.getPendingSchedulingCounts({ status: 3, assigned: true, statuses: '3,5' });
  assert.match(filterHalf(groupQuery().sql), /WHERE j\.job_status = \? AND j\.fk_easyfixter_id IS NULL\b/);
  assert.deepEqual(groupQuery().params, [jobSvc.STATUS.BOOKED]);
});

/* ── 5. The response shape ───────────────────────────────────────────────── */

test('all = pending + offered + expired, and the four keys are the whole payload', async () => {
  scenario.groups = [
    { offer_state: 'pending', c: 5 },
    { offer_state: 'offered', c: 2 },
    { offer_state: 'expired', c: 3 },
  ];
  const counts = await jobSvc.getPendingSchedulingCounts({});
  assert.deepEqual(counts, { all: 10, pending: 5, offered: 2, expired: 3 });
});

test('a state with no rows is 0, never absent — the tab still has to render', async () => {
  scenario.groups = [{ offer_state: 'offered', c: 4 }];
  assert.deepEqual(await jobSvc.getPendingSchedulingCounts({}), { all: 4, pending: 0, offered: 4, expired: 0 });
  // An empty bucket is four zeroes, not an empty object.
  scenario.groups = [];
  assert.deepEqual(await jobSvc.getPendingSchedulingCounts({}), { all: 0, pending: 0, offered: 0, expired: 0 });
});

test("the ACCEPTED anomaly ('none') is excluded, not folded into a tab", async () => {
  // A job holding an accepted offer but no technician matches NO offerState
  // filter (see offerStateSql's carve-out), so no tab could list it. Counting it
  // in one would promise a row that tab cannot show.
  scenario.groups = [
    { offer_state: 'pending', c: 5 },
    { offer_state: 'offered', c: 2 },
    { offer_state: 'expired', c: 3 },
    { offer_state: 'none', c: 1 },
  ];
  assert.deepEqual(await jobSvc.getPendingSchedulingCounts({}), { all: 10, pending: 5, offered: 2, expired: 3 });
});

test('counts arrive as numbers even when the driver hands back strings', async () => {
  // mysql2 returns COUNT(*) as a number, but a BIGINT-shaped driver setting can
  // make it a string — and '5' + '2' is '52' on a strip that adds its own total.
  scenario.groups = [{ offer_state: 'pending', c: '5' }, { offer_state: 'offered', c: '2' }];
  assert.deepEqual(await jobSvc.getPendingSchedulingCounts({}), { all: 7, pending: 5, offered: 2, expired: 0 });
});

/* ── 6. The un-migrated deploy ───────────────────────────────────────────── */

test('tbl_job_offer absent ⇒ the whole bucket reads pending, and the table is never named', async () => {
  // The probe is memoised per process, so re-require the service with a fresh
  // module registry entry to re-run it against the absent-table scenario.
  scenario.jobOfferTableExists = false;
  scenario.total = 12;
  delete require.cache[require.resolve('../services/job.service')];
  const freshSvc = require('../services/job.service');
  fake.reset();

  const counts = await freshSvc.getPendingSchedulingCounts({});
  assert.deepEqual(counts, { all: 12, pending: 12, offered: 0, expired: 0 },
    'nothing was ever offered, so the bucket is entirely "not offered"');
  assert.equal(groupQuery(), undefined, 'the grouped query must not be attempted');
  const plain = countQuery();
  assert.ok(plain, 'a plain COUNT of the same bucket must still run (never a 500)');
  assert.doesNotMatch(plain.sql, /tbl_job_offer/, 'the absent table may not be referenced');
  assert.match(filterHalf(plain.sql), /WHERE j\.job_status = \? AND j\.fk_easyfixter_id IS NULL\b/);

  // Restore the module registry so any later require in this process is normal.
  delete require.cache[require.resolve('../services/job.service')];
  require('../services/job.service');
});

/* ── The query schema ────────────────────────────────────────────────────── */

const validateQuery = (query) =>
  pendingSchedulingCountsQuery.validate(query, { abortEarly: false, stripUnknown: true, convert: true });

test('every accepted key is the LIST\'s own rule, extracted — never a hand copy', () => {
  for (const key of PENDING_SCHEDULING_COUNT_FILTERS) {
    assert.deepEqual(
      pendingSchedulingCountsQuery.extract(key).describe(), listQuery.extract(key).describe(),
      `${key} must be listQuery's schema, or the strip and the grid can accept different values`,
    );
  }
});

test('offerState and the bucket pins are STRIPPED, not rejected', () => {
  // The FE reuses the grid's query string; 400ing it would blank the strip over
  // a key the endpoint simply has no use for.
  const { error, value } = validateQuery({
    ...FILTERS, offerState: 'offered', status: '0', assigned: 'false', limit: '50', offset: '0', sortBy: 'age',
  });
  assert.equal(error, undefined, 'extra keys must not 400');
  assert.deepEqual(Object.keys(value).sort(), [...PENDING_SCHEDULING_COUNT_FILTERS].sort());
});

test('a value the grid would reject is rejected here too', () => {
  assert.ok(validateQuery({ cityId: 'all' }).error, 'a non-CSV cityId must 400 on both endpoints');
  assert.ok(validateQuery({ categoryId: -1 }).error, 'so must a non-positive id');
  assert.equal(validateQuery({}).error, undefined, 'and no filter at all is the unfiltered strip');
});
