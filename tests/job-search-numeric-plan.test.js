/*
 * THE NUMERIC QUICK-SEARCH PREDICATE — shape, parity, and binding order.
 *
 * WHAT CHANGED AND WHY THIS FILE EXISTS. Manage Jobs quick search matched a
 * digits-only term against `cu.customer_mob_no` — a column of the outer LEFT
 * JOIN — inside an OR with three tbl_job predicates. MySQL therefore could not
 * decide a row until tbl_customer had been joined to it, and a single phone
 * search paid ~481k PK probes into tbl_customer (EXPLAIN: `cu eq_ref … Using
 * where`). The branch is now an uncorrelated `j.fk_customer_id IN (SELECT …
 * FROM tbl_customer …)`, which MySQL runs ONCE as a range scan on the
 * customer_mob_no index and probes — measured 2027 ms → 1088 ms on the data
 * query and 1864 ms → 865 ms on the COUNT, on the real 481k-row table.
 *
 * That is a REWRITE OF A PREDICATE THAT MUST NOT CHANGE WHICH ROWS COME BACK,
 * so the interesting tests here are not "does it emit the string I expect"
 * (that too, further down) but:
 *
 *   1. SEMANTIC PARITY. `evaluate()` below PARSES the predicate the service
 *      actually emits and RUNS it over an in-memory fixture, then compares the
 *      matched id set against an independent, hard-coded model of the previous
 *      committed semantics. It refuses any predicate form it does not
 *      recognise, so a regression that dropped the prefix anchor, correlated
 *      the subquery, or swapped IN for NOT IN fails loudly instead of being
 *      quietly followed. The fixture carries the exact production rows from
 *      the original bug report (98453028|06 and 93|530280|25, both of which
 *      contain "530280" mid-number and must NOT match).
 *
 *   2. BINDING ORDER. The q clause is one of a dozen AND-ed filters. A shifted
 *      binding does not throw — it silently filters on the wrong value — so
 *      the invariant asserted is the strong one: the params a call produces
 *      WITHOUT q must be a byte-exact PREFIX of the params the same call
 *      produces WITH q. Nothing else can move.
 *
 *   3. COUNT ≡ DATA. This repo has a recorded bug class where the COUNT query
 *      and the page query drift apart on joins and the endpoint 500s. The new
 *      predicate names no join alias at all, which CHANGES the COUNT query's
 *      join set (tbl_customer is no longer pulled in) — that is deliberate and
 *      is pinned here, together with the identity of the two WHERE clauses.
 *
 *   4. NO INTERPOLATION. The term never reaches the SQL string, including when
 *      it contains %, _ or a quote.
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

const dataQuery = () => fake.calls.find((c) => /LIMIT \? OFFSET \?/.test(c.sql));
const countQuery = () => fake.calls.find((c) => /^SELECT COUNT\(\*\) AS total/i.test(c.sql));
/*
 * The COUNT query has no projection subqueries, so its FIRST 'WHERE' is the
 * top-level one. (The mobile branch's subquery carries a nested WHERE, but it
 * sits inside the last AND-ed clause and therefore always after this index —
 * one of the reasons the branch was kept in the WHERE rather than promoted to
 * a joined derived table, which would have put a WHERE ahead of it.)
 */
const topLevelWhere = () => {
  const sql = countQuery().sql;
  return sql.slice(sql.indexOf('WHERE')).trim();
};

async function listWith(args) {
  fake.reset();
  await jobSvc.list({ limit: 50, offset: 0, ...args });
  return { count: countQuery(), data: dataQuery() };
}

/* ── the predicate interpreter ─────────────────────────────────────────────
 * Recognises exactly the four branch forms the service is allowed to emit.
 * Anything else throws, which is the point.
 */
function likeMatch(value, pattern) {
  if (value === null || value === undefined) return false;   // NULL LIKE … → NULL
  const rx = new RegExp(
    '^' + String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '[\\s\\S]*').replace(/_/g, '[\\s\\S]') + '$',
  );
  return rx.test(String(value));
}

// Splits the emitted `(a OR b OR c)` on TOP-LEVEL ' OR ' only (parenthesis-aware),
// so the subquery branch survives intact instead of being cut in half.
function splitTopLevelOr(clause) {
  assert.match(clause, /^\(.*\)$/s, 'the q clause must be a single parenthesised group');
  const body = clause.slice(1, -1);
  const parts = []; let depth = 0; let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && body.startsWith(' OR ', i)) { parts.push(body.slice(start, i)); i += 3; start = i + 1; }
  }
  parts.push(body.slice(start));
  return parts.map((p) => p.trim());
}

function evaluate(clause, params, fixture) {
  const branches = splitTopLevelOr(clause);
  let p = 0;
  const preds = branches.map((b) => {
    if (b === 'j.job_id = ?') { const v = params[p++]; return (job) => job.job_id === v; }
    if (b === 'j.job_reference_id LIKE ?') { const v = params[p++]; return (job) => likeMatch(job.job_reference_id, v); }
    if (b === 'j.client_ref_id LIKE ?') { const v = params[p++]; return (job) => likeMatch(job.client_ref_id, v); }
    const inSub = /^j\.fk_customer_id IN \(SELECT (\w+)\.customer_id FROM tbl_customer \1 WHERE \1\.customer_mob_no LIKE \?\)$/.exec(b);
    if (inSub) {
      const v = params[p++];
      return (job, customers) => {
        // Uncorrelated: the set is computed once, from tbl_customer alone.
        const ids = new Set(customers.filter((c) => likeMatch(c.customer_mob_no, v)).map((c) => c.customer_id));
        // NULL fk_customer_id → `NULL IN (…)` is UNKNOWN, i.e. not TRUE.
        return job.fk_customer_id !== null && ids.has(job.fk_customer_id);
      };
    }
    throw new Error(
      `unrecognised search branch: ${JSON.stringify(b)}. If this is a deliberate new `
      + 'branch, teach the interpreter about it AND extend the reference model below — '
      + 'do not delete the assertion.',
    );
  });
  assert.equal(p, params.length, 'every bound param must belong to a recognised branch');
  return new Set(fixture.jobs.filter((job) => preds.some((f) => f(job, fixture.customers))).map((j) => j.job_id));
}

/*
 * Independent model of the PREVIOUS committed semantics — written from the
 * behaviour, not from the service, so agreement means something:
 *   job_id = t  OR  ref LIKE %t%  OR  client_ref LIKE %t%
 *                OR  (t is >= 9 digits AND the job's customer's mobile starts with t)
 */
const MOBILE_MIN_DIGITS = 9;
function referenceModel(q, fixture) {
  const byId = new Map(fixture.customers.map((c) => [c.customer_id, c]));
  const out = new Set();
  for (const job of fixture.jobs) {
    const hit =
      job.job_id === Number(q)
      || likeMatch(job.job_reference_id, `%${q}%`)
      || likeMatch(job.client_ref_id, `%${q}%`)
      || (q.length >= MOBILE_MIN_DIGITS
          && job.fk_customer_id !== null
          && likeMatch((byId.get(job.fk_customer_id) || {}).customer_mob_no, `${q}%`));
    if (hit) out.add(job.job_id);
  }
  return out;
}

/*
 * Fixture. Rows 1–3 are the production bug report itself: searching 530280
 * returned three jobs — the right one plus two that matched on their PHONE
 * NUMBERS mid-digit. Rows 4+ cover the shapes that decide parity: a
 * caller-supplied reference id (~3.8k such rows exist in production), a NULL
 * customer, an orphan FK, NULL ref columns, and a substring-of-the-id match.
 */
const FIXTURE = {
  customers: [
    { customer_id: 11, customer_mob_no: '9845302806' },   // contains 530280 mid-number
    { customer_id: 12, customer_mob_no: '9353028025' },   // contains 530280 mid-number
    { customer_id: 13, customer_mob_no: '5302801234' },   // STARTS with 530280
    { customer_id: 14, customer_mob_no: null },
    { customer_id: 15, customer_mob_no: '98453028' },     // shorter than a full mobile
  ],
  jobs: [
    { job_id: 530280, job_reference_id: 'REF-530280', client_ref_id: 'WO1024566', fk_customer_id: 14 },
    { job_id: 411001, job_reference_id: 'REF-411001', client_ref_id: null,        fk_customer_id: 11 },
    { job_id: 411002, job_reference_id: 'REF-411002', client_ref_id: null,        fk_customer_id: 12 },
    { job_id: 411003, job_reference_id: 'REF-411003', client_ref_id: null,        fk_customer_id: 13 },
    { job_id: 298642, job_reference_id: 'WO-999998-X', client_ref_id: null,       fk_customer_id: null },
    { job_id: 415302, job_reference_id: 'REF-415302', client_ref_id: null,        fk_customer_id: 99 }, // orphan FK
    { job_id: 453027, job_reference_id: 'REF-453027', client_ref_id: '171-2677513-3675553', fk_customer_id: 15 },
    { job_id: 100200, job_reference_id: null,         client_ref_id: null,        fk_customer_id: 11 },
  ],
};

// Pull the q clause back out of the emitted WHERE: it is always the last
// AND-ed group, and the only one that is a bare parenthesised OR chain.
function qClauseOf(where, nOtherClauses) {
  const body = where.replace(/^WHERE\s*/, '');
  const parts = [];
  let depth = 0; let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && body.startsWith(' AND ', i)) { parts.push(body.slice(start, i)); i += 4; start = i + 1; }
  }
  parts.push(body.slice(start));
  assert.equal(parts.length, nOtherClauses + 1, `expected ${nOtherClauses} non-q clause(s) plus the q clause`);
  return parts[parts.length - 1].trim();
}

beforeEach(() => fake.reset());

/* ── 1. semantic parity ──────────────────────────────────────────────────── */

const NUMERIC_TERMS = [
  '530280',       // the reported term — an exact job id
  '5302',         // short fragment: substring of ids, never a phone
  '999998',       // an id that does not exist; only a caller-supplied ref can match
  '1',            // single digit
  '98453028',     // 8 digits — one short of the phone threshold
  '984530280',    // exactly 9 — the phone branch switches on here
  '9845302806',   // a full mobile
  '5302801234',   // a full mobile that is also an id-looking prefix
  '0000000000',
  '99999999999999999999', // longer than any real value
];

for (const q of NUMERIC_TERMS) {
  test(`PARITY: q=${q} selects exactly the rows the previous predicate selected`, async () => {
    const { count } = await listWith({ q, status: 5 });
    const clause = qClauseOf(topLevelWhere(), 1);
    const qParams = count.params.slice(1);            // [status, …qParams]
    const got = evaluate(clause, qParams, FIXTURE);
    const want = referenceModel(q, FIXTURE);
    assert.deepEqual([...got].sort(), [...want].sort(),
      `q=${q} changed which rows match.\n  clause: ${clause}\n  params: ${JSON.stringify(qParams)}`);
  });
}

test('PARITY: the reported bug stays fixed — 530280 must not match a phone mid-number', async () => {
  const { count } = await listWith({ q: '530280', status: 5 });
  const matched = evaluate(qClauseOf(topLevelWhere(), 1), count.params.slice(1), FIXTURE);
  assert.ok(matched.has(530280), 'the job the operator asked for must match');
  assert.ok(!matched.has(411001), '9845302806 contains 530280 mid-number and must NOT match');
  assert.ok(!matched.has(411002), '9353028025 contains 530280 mid-number and must NOT match');
});

test('PARITY: a 10-digit term still matches on a mobile PREFIX, and only a prefix', async () => {
  const { count } = await listWith({ q: '5302801234', status: 5 });
  const matched = evaluate(qClauseOf(topLevelWhere(), 1), count.params.slice(1), FIXTURE);
  assert.ok(matched.has(411003), 'customer 13 (5302801234) must match on the mobile branch');
  assert.ok(!matched.has(411001), 'a mid-number occurrence must never match');
});

test('the mobile branch is uncorrelated and prefix-anchored (the two properties that make it fast AND correct)', async () => {
  const { count } = await listWith({ q: '9845302806' });
  const clause = qClauseOf(topLevelWhere(), 0);
  assert.match(clause, /j\.fk_customer_id IN \(SELECT \w+\.customer_id FROM tbl_customer \w+ WHERE \w+\.customer_mob_no LIKE \?\)/,
    'the mobile branch must be an uncorrelated set lookup on tbl_customer');
  assert.doesNotMatch(clause, /\bcu\./, 'it must not reference the outer LEFT JOIN alias — that is what forced the join');
  assert.doesNotMatch(clause, /\bj\.\w+\s*=\s*\w+\.customer_id/, 'it must not be correlated to the outer row');
  assert.doesNotMatch(clause, /NOT IN/, 'IN only — NOT IN against a nullable column rejects every row');
  assert.equal(count.params[count.params.length - 1], '9845302806%', 'the mobile pattern must be prefix-anchored');
});

test('below MOBILE_MIN_DIGITS the mobile branch is not emitted at all', async () => {
  const { count } = await listWith({ q: '98453028' });               // 8 digits
  const clause = qClauseOf(topLevelWhere(), 0);
  assert.doesNotMatch(clause, /tbl_customer/, 'a term too short to be a phone must not touch tbl_customer');
  assert.equal(splitTopLevelOr(clause).length, 3);
  assert.deepEqual(count.params, [98453028, '%98453028%', '%98453028%']);
});

/* ── 2. binding order ────────────────────────────────────────────────────── */

const FILTER_SET = {
  status: 5,
  clientId: '252',
  cityId: '7,9',
  ownerId: 41,
  startDate: '2026-07-01',
  endDate: '2026-07-31',
  scope: { clients: { mode: 'allow', ids: [252, 253] }, cities: { mode: 'allow', ids: [7, 9] } },
  allowedStages: { mode: 'list', stages: ['scheduling'] },
};

for (const q of ['530280', '9845302806']) {
  test(`BINDING ORDER: adding q=${q} appends params and shifts nothing (${Object.keys(FILTER_SET).length} other filters)`, async () => {
    const without = await listWith(FILTER_SET);
    const withQ = await listWith({ ...FILTER_SET, q });

    const base = without.count.params;
    assert.ok(base.length > 0, 'the filter set must actually bind params, or this test proves nothing');
    assert.deepEqual(withQ.count.params.slice(0, base.length), base,
      'the other filters must bind the SAME values in the SAME positions once q is added');
    assert.ok(withQ.count.params.length > base.length, 'q must bind its own params');

    // …and the same holds for the WHERE text: q is AND-ed on at the end.
    const whereWithout = without.count.sql.slice(without.count.sql.indexOf('WHERE')).trim();
    const whereWith = withQ.count.sql.slice(withQ.count.sql.indexOf('WHERE')).trim();
    assert.ok(whereWith.startsWith(whereWithout + ' AND '),
      `the q clause must be appended, not interleaved.\n  without: ${whereWithout}\n  with:    ${whereWith}`);
  });
}

test('BINDING ORDER: the data query is the COUNT params plus limit/offset, in that order', async () => {
  for (const q of ['530280', '9845302806', 'ravi kumar']) {
    const { count, data } = await listWith({ ...FILTER_SET, q, limit: 25, offset: 75 });
    assert.deepEqual(data.params.slice(0, count.params.length), count.params,
      `q=${q}: the data query must bind exactly the COUNT params first`);
    assert.deepEqual(data.params.slice(count.params.length), [25, 75],
      `q=${q}: …then limit and offset, and nothing else`);
  }
});

/* ── 3. COUNT ≡ DATA ─────────────────────────────────────────────────────── */

test('COUNT and data filter on the identical WHERE for every term shape', async () => {
  for (const q of ['530280', '5302', '9845302806', 'ravi', 'REF-530280', '']) {
    const { count, data } = await listWith({ ...FILTER_SET, q });
    const where = count.sql.slice(count.sql.indexOf('WHERE')).trim();
    assert.ok(data.sql.includes(where), `q=${JSON.stringify(q)}: the data query must carry the same WHERE`);
  }
});

test('a numeric term no longer drags tbl_customer into the COUNT query; a text term still does', async () => {
  // The predicate is now pure-`j`, so the COUNT can be served from tbl_job alone.
  const numeric = await listWith({ q: '9845302806', status: 5 });
  assert.doesNotMatch(numeric.count.sql, /LEFT JOIN tbl_customer/i,
    'the numeric path must not pull the customer join into COUNT — that join was the cost');
  assert.match(numeric.count.sql, /tbl_customer qmob/, 'the subquery still reads tbl_customer, self-contained');

  // The eleven-column text search genuinely reads cu./cl./ci./ef./ow., so its
  // COUNT must still join them — proving the alias sniffing was not broken.
  const text = await listWith({ q: 'ravi', status: 5 });
  for (const t of ['tbl_customer', 'tbl_client', 'tbl_city', 'tbl_easyfixer', 'tbl_user']) {
    assert.match(text.count.sql, new RegExp(`LEFT JOIN ${t}\\b`, 'i'),
      `the text search reads ${t} in its WHERE, so COUNT must join it`);
  }
});

/* ── 4. the non-numeric path is untouched, and nothing is interpolated ────── */

test('the eleven-column text search is unchanged — same clause, same 11 bindings', async () => {
  const { count } = await listWith({ q: 'ravi' });
  const clause = qClauseOf(topLevelWhere(), 0);
  assert.match(clause, /^\(CAST\(j\.job_id AS CHAR\) LIKE \?/);
  assert.equal((clause.match(/LIKE \?/g) || []).length, 11, 'eleven columns, eleven placeholders');
  assert.deepEqual(count.params, Array(11).fill('%ravi%'));
});

test('terms that are not purely digits keep the text path — including mixed, wildcard and quoted', async () => {
  for (const q of ['REF-530280', 'WO1024566', '530280a', '53 0280', '9845302806x', '+919845302806']) {
    const { count } = await listWith({ q });
    assert.equal((qClauseOf(topLevelWhere(), 0).match(/LIKE \?/g) || []).length, 11,
      `${JSON.stringify(q)} contains a non-digit and must take the text path`);
    assert.deepEqual(count.params, Array(11).fill(`%${q}%`));
  }
});

test('SQL wildcards and quotes in the term are BOUND, never interpolated', async () => {
  for (const q of ['100%', '_53028', "o'brien", '5%_30', '"; DROP TABLE tbl_job; --']) {
    const { count, data } = await listWith({ q, status: 5 });
    for (const call of [count, data]) {
      assert.ok(!call.sql.includes(q), `the term ${JSON.stringify(q)} must not appear in the SQL text`);
    }
    assert.ok(count.params.includes(`%${q}%`), 'it must arrive as a bound parameter instead');
  }
});

test('digits-only terms are bound too — no id is ever formatted into the SQL', async () => {
  for (const q of ['530280', '9845302806']) {
    const { count, data } = await listWith({ q, status: 5 });
    for (const call of [count, data]) {
      const where = call.sql.slice(call.sql.indexOf('WHERE'));
      assert.ok(!where.includes(q), `${q} must not appear in the WHERE text`);
    }
    assert.ok(count.params.includes(Number(q)), 'the id branch binds the term as a number');
  }
});

test('an empty / absent term emits no search clause at all', async () => {
  for (const q of ['', null, undefined]) {
    const { count } = await listWith({ q, status: 5 });
    assert.equal(topLevelWhere(), 'WHERE j.job_status = ?', `${JSON.stringify(q)} must add no clause`);
    assert.deepEqual(count.params, [5]);
  }
});
