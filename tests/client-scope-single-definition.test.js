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
 * The four PATCH /jobs/:id/* writes are tenancy-checked (fk_client_id) but NOT
 * hierarchy-checked, so a Store SPOC who guesses a job id can act on a peer's
 * job. That is a real gap, deliberately NOT widened or narrowed here — it is
 * an authorisation question about WRITES, separate from the counting bug this
 * file is about, and closing it changes who can approve what.
 */
const EXEMPT = new Set([
  'PATCH /jobs/:id/approve',            // tenancy-only write — see note above
  'PATCH /jobs/:id/reject',             // tenancy-only write
  'PATCH /jobs/:id/estimate/approve',   // tenancy-only write
  'PATCH /jobs/:id/estimate/reject',    // tenancy-only write
  'GET /cities',                        // filter dropdown, client-wide by design
  'GET /lookup/cities',                 // filter dropdown, client-wide by design
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
    if (/hierarchyFilter\(|clientJobFilters\(/.test(body)) return;
    if (EXEMPT.has(s.label)) return;
    unscoped.push(s.label);
  });

  assert.deepEqual(unscoped, [],
    'a route reading tbl_job with no hierarchy scope and no entry in EXEMPT — '
    + 'either scope it through hierarchyFilter, or add it to EXEMPT with a reason');
});

test('the EXEMPT list has no dead entries', () => {
  const present = new Set();
  RAW.split('\n').forEach((l) => {
    const m = /^router\.(get|post|patch|put|delete)\('([^']*)'/.exec(l);
    if (m) present.add(`${m[1].toUpperCase()} ${m[2]}`);
  });
  const stale = [...EXEMPT].filter((e) => !present.has(e));
  assert.deepEqual(stale, [],
    'an exemption for a route that no longer exists hides the next one that needs it');
});
