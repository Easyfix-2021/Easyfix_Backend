/*
 * GET /api/client/jobs · /orders/counts · /export/jobs — the shared filter set.
 *
 * WHY THIS FILE EXISTS. Until 2026-08-26 these three routes each built their
 * own filter set, and they had drifted badly: /jobs silently DROPPED the
 * statuses / flag / cityIds / ownerIds params the Order History page sends, so
 * that page rendered "Filters active" over completely unfiltered rows, its two
 * tabs returned identical results, and the badge above the table counted a
 * different population again.
 *
 * ⚠ AND NOTHING CAUGHT IT, because every existing test sits one level below
 * these handlers, at jobService.list(). That is the exact blind spot
 * tests/job-export-route.test.js was written about: 38 green service tests over
 * the admin export while a TDZ ReferenceError had the route 100% down. So these
 * tests drive the ROUTE HANDLERS, not the service.
 *
 * The fake pool records every (sql, params), which is the whole point — what is
 * asserted here is the SQL the handler causes, not a return value it could
 * produce while filtering nothing.
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/* The caller's subtree. 42 is the SPOC, 43/44 report to them; 99 does NOT. */
let subtree = [{ id: 42 }, { id: 43 }, { id: 44 }];
let me = { manager_id: 7 };            // not top of the tree → scoped
let matchingTotal = 3;                 // what COUNT(*) reports for the filter set

const fake = installFakePool([
  [/SELECT manager_id FROM tbl_client_contacts/i, () => [me]],
  [/WITH RECURSIVE team/i, () => subtree],
  [/SELECT COUNT\(\*\) AS total/i, () => [{ total: matchingTotal }]],
  [/INFORMATION_SCHEMA/i, []],
  /*
   * The data query returns as many rows as its own LIMIT allows, exactly like
   * a real DB would — the last two bound params are limit and offset. Returning
   * a fixed [] made total > rows.length for ANY total, so the truncation flag
   * was true even when nothing had been dropped.
   */
  [/FROM tbl_job j/i, (sql, params) => {
    const limit = Number(params[params.length - 2]) || 50;
    return Array.from({ length: Math.min(matchingTotal, limit) }, (_, i) => ({ job_id: i + 1 }));
  }],
]);

const router = require('../routes/client/index');

function handlerFor(path, method) {
  const layer = router.stack.find((e) => e.route && e.route.path === path && e.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function res() {
  return {
    statusCode: null, body: null, headers: {}, sent: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    send(b) { this.sent = b; return this; },
  };
}

async function call(path, query = {}, access = {}) {
  const r = res();
  const req = { spoc: { id: 42, client_id: 133 }, access, query };
  await handlerFor(path, 'get')(req, r, (e) => { throw e; });
  return r;
}

/* Every SELECT the handler ran against tbl_job, list + count alike. */
const jobQueries = () => fake.calls.filter((c) => /FROM tbl_job j/i.test(c.sql));

/*
 * The paged data query, as opposed to its COUNT sibling. Discriminated on
 * `LIMIT ? OFFSET ?`, which only the data query carries — NOT on the absence
 * of "SELECT COUNT", because the LIST projection embeds a service_count
 * subquery and that predicate quietly matched nothing at all.
 */
const listQuery = () => jobQueries().find((c) => /LIMIT \? OFFSET \?/.test(c.sql));

beforeEach(() => {
  fake.reset();
  subtree = [{ id: 42 }, { id: 43 }, { id: 44 }];
  me = { manager_id: 7 };
  matchingTotal = 3;
});

/* ─── the drop itself ──────────────────────────────────────────────────── */

test('?statuses reaches the WHERE — the Bucket filter used to be decorative', async () => {
  await call('/jobs', { statuses: '3,5' });
  const q = jobQueries();
  assert.ok(q.length, 'the handler must query tbl_job');
  for (const c of q) {
    assert.match(c.sql, /j\.job_status IN \(\?,\?\)/,
      'statuses was dropped before 2026-08-26: the page filtered and got everything back');
    assert.ok(c.params.includes(3) && c.params.includes(5), 'both codes must be bound');
  }
});

test('?cityIds reaches the WHERE, and the COUNT joins tbl_address to match', async () => {
  await call('/jobs', { cityIds: '7,9' });
  for (const c of jobQueries()) {
    assert.match(c.sql, /ad\.city_id IN \(\?,\?\)/, 'City filter must apply');
    assert.match(c.sql, /JOIN tbl_address/i,
      'a WHERE on ad. without the matching join is the known scoped-user 500');
  }
});

test('flag=completedOrders adds BOTH billing predicates, never just one', async () => {
  await call('/jobs', { flag: 'completedOrders' });
  for (const c of jobQueries()) {
    assert.match(c.sql, /j\.ready_for_billing = 'Yes'/, 'the In-Warranty tab predicate');
    assert.match(c.sql, /j\.sub_job_id IS NULL/,
      'without this a billable parent and its sub-job are both counted');
  }
});

test('flag=otherOrders adds no billing predicate — the two tabs must differ', async () => {
  await call('/jobs', { flag: 'otherOrders' });
  for (const c of jobQueries()) {
    assert.doesNotMatch(c.sql, /ready_for_billing/,
      'both tabs returned identical rows before this change');
  }
});

/* ─── the id-domain trap, which is the security half ───────────────────── */

test('?ownerIds narrows reporting_contact_id — NOT job_owner', async () => {
  await call('/jobs', { ownerIds: '43' });
  for (const c of jobQueries()) {
    assert.match(c.sql, /j\.reporting_contact_id IN \(/,
      'ownerIds are tbl_client_contacts ids');
    assert.doesNotMatch(c.sql, /j\.job_owner IN/,
      'job_owner is a tbl_user id AND is NULL on every portal-booked job — it could never match');
  }
});

test('?ownerIds can only NARROW the subtree, never widen it', async () => {
  // 99 is outside the caller's subtree. Picking it must not reach their book.
  await call('/jobs', { ownerIds: '43,99' });
  const c = jobQueries()[0];
  assert.match(c.sql, /j\.reporting_contact_id IN \(\?\)/, 'exactly one id survives the intersection');
  assert.ok(c.params.includes(43), '43 is in the subtree and is kept');
  assert.ok(!c.params.includes(99),
    'a Store SPOC must not read a peer by picking them in a dropdown');
});

test('an ownerIds pick entirely outside the subtree yields 1=0, not everything', async () => {
  await call('/jobs', { ownerIds: '99' });
  const c = jobQueries()[0];
  assert.match(c.sql, /1=0/,
    'an empty intersection must fail CLOSED — dropping the clause would show the whole client');
});

test('a top-of-tree SPOC is unrestricted, and ownerIds then becomes the restriction', async () => {
  me = { manager_id: null };                       // top of the tree
  await call('/jobs', { ownerIds: '43' });
  const c = jobQueries()[0];
  assert.match(c.sql, /j\.reporting_contact_id IN \(\?\)/);
  assert.ok(c.params.includes(43));
  // Rendered as IN (?) — jobService.list runs clientId through toIdArray.
  assert.match(c.sql, /j\.fk_client_id IN \(/,
    'client scope is what stops a top SPOC reaching another tenant with a guessed id');
});

/* ─── the two numbers that used to contradict each other ───────────────── */

test('/orders/counts builds the SAME WHERE as /jobs for the same query', async () => {
  const shared = { cityIds: '7', ownerIds: '43', q: 'ABC' };

  await call('/jobs', shared);
  const listWhere = jobQueries()[0].sql.split(/\bWHERE\b/)[1];

  fake.reset();
  await call('/orders/counts', shared);
  const countWheres = jobQueries().map((c) => c.sql.split(/\bWHERE\b/)[1]);

  assert.equal(countWheres.length, 3, 'one per Order History tab, plus the open badge');
  // Each count legitimately adds ONE predicate of its own — billing adds two,
  // the open badge adds a status IN. Strip those and the rest must be
  // identical, character for character: that is the whole property, because a
  // badge over a table is a claim about the same rows.
  // The predicates can land anywhere in the clause list, so strip them with or
  // without a leading AND and tidy up whatever separator that leaves.
  const strip = (w) => w
    .replace(/j\.ready_for_billing = 'Yes'(\s+AND\s+)?/, '')
    .replace(/(\s+AND\s+)?j\.sub_job_id IS NULL/, '')
    .replace(/(\s+AND\s+)?j\.job_status IN \([?,]+\)/, '')
    .replace(/^\s*AND\s+/, '')
    .replace(/\s+/g, ' ');
  for (const w of countWheres) {
    assert.equal(strip(w).trim(), listWhere.replace(/\s+/g, ' ').trim(),
      'the badge and the table must describe ONE population');
  }
});

test('/orders/counts is hierarchy-scoped — it used to count the whole client', async () => {
  await call('/orders/counts', {});
  for (const c of jobQueries()) {
    assert.match(c.sql, /j\.reporting_contact_id IN \(/,
      '"All Orders 1,834" over "Showing 1-10 of 212" was this missing clause');
  }
});

test('/orders/counts runs COUNTs only — no wasted list projection', async () => {
  await call('/orders/counts', {});
  const q = jobQueries();
  // Two Order History tab badges + the shell's "Open jobs" badge.
  assert.equal(q.length, 3, 'exactly three queries, one per badge');
  for (const c of q) {
    assert.match(c.sql, /SELECT COUNT\(\*\) AS total/, 'countOnly must skip the data query');
  }
  assert.ok(!q.some((c) => /LIMIT \? OFFSET \?/.test(c.sql)),
    'a badge that pages rows it never reads is pure latency on every navigation');
});

/* ─── the export, which had no scope at all ────────────────────────────── */

test('/export/jobs is hierarchy-scoped — a Store SPOC used to export the whole account', async () => {
  const r = await call('/export/jobs', {});
  assert.ok(r.headers['Content-Disposition'], 'still returns a workbook');
  for (const c of jobQueries()) {
    assert.match(c.sql, /j\.reporting_contact_id IN \(/,
      'this route passed clientId and nothing else until 2026-08-26');
  }
});

test('/export/jobs honours the same filters as the list it was exported from', async () => {
  await call('/export/jobs', { statuses: '3,5', cityIds: '7', flag: 'completedOrders' });
  const c = jobQueries()[0];
  assert.match(c.sql, /j\.job_status IN \(/, 'statuses');
  assert.match(c.sql, /ad\.city_id IN \(/, 'cityIds');
  assert.match(c.sql, /ready_for_billing/, 'flag');
});

/* ─── escalation: wired 2026-08-26, a documented no-op before that ──────── */

test('flag=escalatedJobs filters on the ratings table — it used to list EVERY job', async () => {
  await call('/jobs', { flag: 'escalatedJobs' });
  for (const c of jobQueries()) {
    assert.match(c.sql, /EXISTS \(\s*SELECT 1 FROM tbl_easyfixer_rating_by_customer/,
      'the client was shown their whole book under an "Escalated Orders" header');
    assert.match(c.sql, /esc_f\.is_escalated = 1/, 'the flag itself, not merely a rating row');
  }
});

test('the escalation filter is EXISTS, never a join — a job with two rating rows must not double', async () => {
  await call('/jobs', { flag: 'escalatedJobs' });
  const countQ = jobQueries().find((c) => /SELECT COUNT\(\*\)/.test(c.sql));
  assert.ok(countQ, 'the count must run');
  assert.doesNotMatch(countQ.sql, /JOIN tbl_easyfixer_rating_by_customer/,
    'a JOIN would multiply the row per rating and inflate the total');
});

test('escalation columns are appended ONLY when escalation is asked for', async () => {
  await call('/jobs', { flag: 'escalatedJobs' });
  const listQ = listQuery();
  assert.match(listQ.sql, /escu\.user_name AS escalated_by_name/,
    'the page renders this column and received nothing before');
  assert.match(listQ.sql, /MAX\(e2\.table_id\)/,
    'pick the LATEST rating row, not whichever the optimiser reached first');

  fake.reset();
  await call('/jobs', {});
  const plain = listQuery();
  assert.doesNotMatch(plain.sql, /escalated_by_name/,
    'every other caller of jobService.list must be unaffected');
  assert.doesNotMatch(plain.sql, /tbl_easyfixer_rating_by_customer/, 'and pay no join for it');
});

test("isEscalated=false is not an escalation filter — a URL carries booleans as text", async () => {
  await call('/jobs', { isEscalated: 'false' });
  for (const c of jobQueries()) {
    assert.doesNotMatch(c.sql, /is_escalated/,
      "the string 'false' is truthy; treating it as a filter is the classic coercion bug");
  }
});

/* ─── the export cap is now visible to the caller ───────────────────────── */

test('/export/jobs reports the cap and whether it bit', async () => {
  const r = await call('/export/jobs', {});
  assert.equal(r.headers['X-Export-Row-Cap'], '10000', 'raised from 5,000 on 2026-08-26');
  assert.equal(r.headers['X-Export-Truncated'], '0', 'total 3 < cap, so nothing was dropped');
  assert.equal(r.headers['X-Export-Total'], '3');
});

test('a truncated export SAYS SO, and the header is readable cross-origin', async () => {
  // More rows match than the cap can return — the handler must notice.
  matchingTotal = 42000;
  const r = await call('/export/jobs', {});

  assert.equal(r.headers['X-Export-Truncated'], '1',
    'a capped workbook is indistinguishable from a complete one once it is open');
  assert.equal(r.headers['X-Export-Total'], '42000');
  assert.match(r.headers['Access-Control-Expose-Headers'] || '', /X-Export-Truncated/,
    'the portal is a different origin — an unexposed header is set, sent and invisible');
});

/* ─── sort, which is what makes a capped page honest ───────────────────── */

test('?sortBy reaches the ORDER BY — /completed calls its 500 "the most recent"', async () => {
  await call('/jobs', { sortBy: 'checkout_date_time', sortDir: 'desc' });
  const q = listQuery();
  assert.match(q.sql, /ORDER BY j\.checkout_date_time DESC/,
    'unsorted, the route falls back to job_id DESC — most recently CREATED, a different set');
});

test('an unknown sortBy falls back rather than reaching the SQL', async () => {
  await call('/jobs', { sortBy: 'j.job_id; DROP TABLE tbl_job', sortDir: 'desc' });
  const q = listQuery();
  assert.doesNotMatch(q.sql, /DROP TABLE/, 'sortBy is whitelisted, never interpolated');
  assert.match(q.sql, /ORDER BY j\.job_id DESC/, 'and an unknown key falls back to the default');
});

test('sortDir is coerced, not trusted', async () => {
  await call('/jobs', { sortBy: 'checkout_date_time', sortDir: 'nonsense' });
  assert.match(listQuery().sql, /checkout_date_time DESC/, 'anything but asc means desc');
});

/* ─── scope: the same allStores rule the dashboard uses ────────────────── */

/*
 * WHY THESE EXIST. `allStores` is the role's documented "sees the whole client
 * vs only its own booking subtree" switch, and four routes applied it as a
 * `allStores ? undefined : hierarchyFilter(...)` prefix at the call site while
 * every list route called hierarchyFilter bare. So a Senior Leader's Home read
 * "Total open · 6" over the whole client and the /jobs list it links to
 * returned the 2 in their own subtree.
 *
 * The rule now lives INSIDE hierarchyFilter, which is what makes these three
 * routes correct without each remembering a prefix — so the assertions are on
 * the SQL the handlers cause, not on the resolver in isolation.
 */

const LIST_ROUTES = ['/jobs', '/orders/counts', '/export/jobs'];

for (const path of LIST_ROUTES) {
  test(`${path} · an allStores SPOC is unrestricted, like their dashboard`, async () => {
    await call(path, {}, { allStores: true });
    const q = jobQueries();
    assert.ok(q.length, 'the handler must query tbl_job');
    for (const c of q) {
      assert.doesNotMatch(c.sql, /reporting_contact_id IN \(/,
        'Total open counted the whole client; this list must open on the same book');
    }
  });

  test(`${path} · everyone else keeps the reporting-hierarchy filter`, async () => {
    await call(path, {}, { allStores: false });
    for (const c of jobQueries()) {
      assert.match(c.sql, /reporting_contact_id IN \(/,
        'allStores:false is exactly "the hierarchy filter stays in force"');
    }
  });
}

test('?spoc outside the subtree is IGNORED for a scoped SPOC', async () => {
  await call('/jobs', { spoc: '99' }, { allStores: false });
  const q = listQuery();
  // 42/43/44 is the subtree; 99 reports to nobody in it.
  assert.ok(q.params.includes(42) && q.params.includes(43) && q.params.includes(44),
    'an id outside the subtree degrades to the caller own scope');
  assert.ok(!q.params.includes(99),
    'without the containment check a Store SPOC reads a peer book by guessing an id');
});

test('?spoc anywhere in the client is honoured for an allStores SPOC', async () => {
  await call('/jobs', { spoc: '99' }, { allStores: true });
  const q = listQuery();
  assert.ok(q.params.includes(99),
    'someone who may already see the whole client is not spying by naming one of its SPOCs');
  assert.ok(!q.params.includes(43),
    'and the pick NARROWS — it must not widen back to the subtree or the client');
});

test('an EMPTY scope counts nothing, never everything', async () => {
  subtree = [];
  me = { manager_id: 7 };
  await call('/jobs', {}, { allStores: false });
  for (const c of jobQueries()) {
    assert.match(c.sql, /reporting_contact_id IN \(/,
      'an empty subtree must still emit a clause — a dropped one means whole-client');
  }
});

/* ─── the nav badge on the "Open jobs" tab ─────────────────────────────── */

test('/orders/counts returns an OPEN count, not just every order on file', async () => {
  const r = await call('/orders/counts', {}, { allStores: true });
  const d = r.body.data;
  assert.ok('openOrders' in d,
    'the shell badged the "Open jobs" tab with otherOrders — EVERY order — so it read '
    + '"99+" over a page saying "209 orders on file · 2 of them open"');
  assert.ok('otherOrders' in d && 'completedOrders' in d,
    'and the two Order History tab badges must keep working');
});

test('the open count is DERIVED from the canonical status set, not retyped', async () => {
  await call('/orders/counts', {}, { allStores: true });
  /*
   * Every place that can express the rule directly uses the negative form —
   * job_status NOT IN (3,5,6,7). jobService.list only filters with IN, so this
   * one has to be a positive list; deriving it from ALL_STATUS_VALUES is what
   * stops the two drifting. A new code is open unless it is declared terminal.
   */
  const { STATUS } = require('../services/job.service');
  const expected = [...new Set(Object.values(STATUS))]
    .filter((c) => ![3, 5, 6, 7].includes(c)).sort((a, b) => a - b);
  const openQ = jobQueries().find((c) =>
    expected.every((code) => c.params.includes(code)));
  assert.ok(openQ, `one COUNT must bind exactly the open codes ${expected.join(',')}`);
  for (const code of [3, 5, 6, 7]) {
    assert.ok(!openQ.params.includes(code), `${code} is terminal and must not be counted as open`);
  }
});

/* ─── the tab-badge routes that hand-rolled their own scope ────────────── */

/*
 * These four counted self plus DIRECT reports with their own
 * `CAST(manager_id AS UNSIGNED) = ?` query — non-recursive, and blind to
 * allStores — while the lists their badges sit over resolve the full
 * recursive subtree through hierarchyFilter. /tickets/counts even carried a
 * comment claiming it applied "the same scope as GET /jobs".
 *
 * They embed the predicate inside SUM(CASE WHEN …) as well as in the WHERE,
 * which is why scopePredicate returns a bare expression: an omitted clause
 * would leave `CASE WHEN AND …`, so unrestricted has to be a literal TRUE.
 */
const BADGE_ROUTES = [
  '/tickets/counts', '/appointments/counts', '/under-audit/counts', '/client-delay/counts',
];

for (const path of BADGE_ROUTES) {
  test(`${path} · allStores is unrestricted, like the list it badges`, async () => {
    await call(path, {}, { allStores: true });
    const q = jobQueries();
    assert.ok(q.length, 'the handler must query tbl_job');
    for (const c of q) {
      assert.doesNotMatch(c.sql, /reporting_contact_id IN \(/,
        'a badge narrower than the list beneath it is the bug this fixes');
      assert.doesNotMatch(c.sql, /CASE WHEN\s+AND/i,
        'an omitted predicate inside a CASE is a syntax error, not an open filter');
    }
  });

  test(`${path} · a scoped SPOC gets the RECURSIVE subtree`, async () => {
    await call(path, {}, { allStores: false });
    const q = jobQueries();
    assert.ok(q.some((c) => /reporting_contact_id IN \(/.test(c.sql)), 'still scoped');
    // 44 reports to 43, not to the caller — the hand-rolled expansion was
    // non-recursive and would have missed exactly this row.
    const scoped = q.find((c) => /reporting_contact_id IN \(/.test(c.sql));
    assert.ok(scoped.params.includes(44),
      'an indirect report must be inside the badge, as they are inside the list');
  });
}
