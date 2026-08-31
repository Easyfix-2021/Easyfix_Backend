/*
 * ONE DEFINITION OF WHO MAY SEE WHICH JOBS.
 *
 * WHY THIS FILE EXISTS. The Client Dashboard showed "Total open · 6" over a
 * bar reading 5 + 1, and clicking that card opened a list of 2. The cause was
 * not arithmetic — it was that the same question, "which jobs may this SPOC
 * see", was answered by three different pieces of code:
 *
 *   1. hierarchyFilter()  — the recursive subtree, honouring allStores.
 *   2. `allStores ? undefined : hierarchyFilter(...)` at four call sites,
 *      while every list route called hierarchyFilter bare. allStores now
 *      lives INSIDE the resolver, so a caller cannot forget the prefix.
 *   3. A hand-rolled `CAST(manager_id AS UNSIGNED) = ?` expansion — self plus
 *      DIRECT reports, non-recursive, role ignored — copied into FIVE
 *      handlers. A manager two levels up got a badge smaller than their own
 *      list; an allStores SPOC got one smaller still.
 *
 * These are source-level assertions on purpose. A behavioural test can only
 * cover the routes somebody remembered to write one for, and (3) spread by
 * copy-paste into handlers that had no tests at all. This fails on the copy.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'routes', 'client', 'index.js');
const RAW = fs.readFileSync(FILE, 'utf8');

/*
 * ⚠ COMMENTS STRIPPED BEFORE SCANNING. Every rule below is described in prose
 * somewhere in that file — including in the comments explaining why the old
 * shape was wrong — so a scanner that reads comments matches its own
 * documentation and fails forever.
 */
const CODE = RAW.split('\n')
  .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
  .join('\n');

test('no handler resolves its own reporting hierarchy', () => {
  assert.equal(CODE.includes('CAST(manager_id'), false,
    'self + DIRECT reports, non-recursive, role ignored — resolveClientHierarchy '
    + 'is the one definition. It was copy-pasted into five handlers.');
});

test('allStores is not re-applied at any call site', () => {
  assert.doesNotMatch(CODE, /allStores\s*\?\s*undefined\s*:/,
    'the rule lives inside hierarchyFilter; a prefix at the call site is what '
    + 'let list routes drift from the dashboard that links to them');
});

/*
 * Routes that read jobs WITHOUT a reporting-hierarchy filter. Each is listed
 * with the reason it is exempt, so adding a new one is a deliberate act rather
 * than an omission. A new unscoped job route fails this test.
 *
 * The four PATCH /jobs/:id/* writes are NOT here: they go through
 * loadJobForWrite, which applies the same resolver, so read scope and write
 * scope give one answer. They used to check tenancy only, which let any SPOC
 * who guessed a job id approve a colleague's job they could not see anywhere
 * on the site.
 */
const EXEMPT = new Set([
  'GET /team/bookings',                 // takes an explicit contact id
  'GET /notices',                       // notices are per-SPOC, not per-job
  'PATCH /notices/read',
  'GET /customers/:customerId/addresses',      // booking lookup, keyed by customer
  'GET /customers/mobile/:mobile/addresses',
  'GET /technicians',                   // technician directory, not a job list
  'GET /jobs/:id/images/:imageId',      // tenancy-checked by job id
]);

test('every job-listing route routes through the shared scope', () => {
  const lines = RAW.split('\n');
  const starts = [];
  lines.forEach((l, i) => {
    const m = /^router\.(get|post|patch|put|delete)\('([^']*)'/.exec(l);
    if (m) starts.push({ i, label: `${m[1].toUpperCase()} ${m[2]}` });
  });

  const unscoped = [];
  starts.forEach((s, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1].i : lines.length;
    const body = lines.slice(s.i, end)
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    // `new RegExp` per call: a /g literal's lastIndex persists across .test()
    // and would make every other route read as clean.
    if (!/tbl_job\b|jobService\.(list|getStatusCounts|getAttentionSummary)/.test(body)) return;
    if (/hierarchyFilter\(|clientJobFilters\(|loadJobForWrite\(/.test(body)) return;
    if (EXEMPT.has(s.label)) return;
    unscoped.push(s.label);
  });

  assert.deepEqual(unscoped, [],
    'a route reading tbl_job with no hierarchy scope and no entry in EXEMPT — '
    + 'either scope it through hierarchyFilter, or add it to EXEMPT with a reason');
});

test('the EXEMPT list has no dead entries', () => {
  /*
   * Two ways an exemption goes stale, and both hide the next route that
   * genuinely needs one: the route is gone, or the route has since been
   * scoped and the exemption is now doing nothing.
   */
  const lines = RAW.split('\n');
  const starts = [];
  lines.forEach((l, i) => {
    const m = /^router\.(get|post|patch|put|delete)\('([^']*)'/.exec(l);
    if (m) starts.push({ i, label: `${m[1].toUpperCase()} ${m[2]}` });
  });

  const present = new Set(starts.map((x) => x.label));
  assert.deepEqual([...EXEMPT].filter((e) => !present.has(e)), [],
    'an exemption for a route that no longer exists');

  const nowScoped = [];
  starts.forEach((s2, idx) => {
    if (!EXEMPT.has(s2.label)) return;
    const end = idx + 1 < starts.length ? starts[idx + 1].i : lines.length;
    const body = lines.slice(s2.i, end)
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    if (/hierarchyFilter\(|clientJobFilters\(|loadJobForWrite\(/.test(body)) nowScoped.push(s2.label);
  });
  assert.deepEqual(nowScoped, [],
    'these are scoped now — drop the exemption so it stops vouching for them');
});

/* ── read scope and write scope are ONE answer ────────────────────────── */

test('every client write on a job goes through the shared ownership check', () => {
  const lines = RAW.split('\n');
  const starts = [];
  lines.forEach((l, i) => {
    const m = /^router\.(get|post|patch|put|delete)\('([^']*)'/.exec(l);
    if (m) starts.push({ i, method: m[1], path: m[2] });
  });

  const bare = [];
  starts.forEach((s2, idx) => {
    if (s2.method === 'get') return;
    if (!/^\/jobs\/:id\//.test(s2.path)) return;
    const end = idx + 1 < starts.length ? starts[idx + 1].i : lines.length;
    const body = lines.slice(s2.i, end)
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    if (!/jobService\.getById/.test(body)) return;
    if (/loadJobForWrite\(/.test(body)) return;
    bare.push(`${s2.method.toUpperCase()} ${s2.path}`);
  });

  assert.deepEqual(bare, [],
    'a write that resolves a job by id and checks only fk_client_id lets any SPOC '
    + "act on a colleague's job by guessing its id");
});

test('the ownership check refuses a job with no reporting contact, for scoped callers only', () => {
  const fn = /async function loadJobForWrite[\s\S]*?\n}/.exec(RAW);
  assert.ok(fn, 'the helper must exist');
  assert.match(fn[0], /Array\.isArray\(scopeIds\)/,
    'undefined means unrestricted — an allStores or top-of-tree SPOC must still act');
  assert.match(fn[0], /404/,
    '403 on an existing-but-foreign job confirms which ids exist');
});
