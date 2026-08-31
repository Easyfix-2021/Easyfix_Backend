/*
 * The Open-breakdown split, and the action queue's approval label.
 *
 * BOTH WERE WRONG IN THE SAME DIRECTION: they called things "pending on you"
 * that the client could not act on.
 *
 *   The bar's "pending on you" was estimatePending + noResponse — status 15
 *   PLUS every job flagged call_later, which is a CUSTOMER not answering their
 *   phone. And "pending with EasyFix" came from newTickets + inProgress, which
 *   omits 15, 21 and 10 — open jobs by any reading.
 *
 *   The action queue labelled EVERY row "Estimate approval" behind an Approve
 *   button. Measured on QA: 6,832 rows at status 7 (enquiry) against 54 at
 *   status 15. The other 6,832 offered to approve an estimate that had never
 *   been sent.
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

let queueRows = [];

const fake = installFakePool([
  /*
   * ⚠ ORDER MATTERS — the fake dispatches on FIRST match. The manager_id probe
   * must be routed BEFORE the generic tbl_client_contacts pattern, or that one
   * swallows it and returns a row with no manager_id — which resolves the SPOC
   * as TOP of the tree, making hierarchyFilter return undefined and every scope
   * assertion silently pass against an unscoped query.
   *
   * manager_id 7 = not top, so the subtree filter genuinely applies.
   */
  [/SELECT manager_id FROM tbl_client_contacts/i, [{ manager_id: 7 }]],
  [/WITH RECURSIVE team/i, [{ id: 42 }, { id: 43 }]],
  [/FROM tbl_client_contacts/i, [{ id: 11 }]],
  [/job_service_status = 1/i, () => queueRows],
  [/AS newTickets/i, [{ newTickets: 2, inProgress: 5, completed: 9, cancelled: 1, escalated: 0, openTotal: 20, awaitingYou: 3 }]],
  /*
   * Catch-all, LAST. /dashboard-summary composes a dozen queries — boxes,
   * ageing, attention, breakdowns, trend — and this file characterises two of
   * them. One empty row satisfies every `[[x]]` destructure without the test
   * having to fixture queries it makes no claim about; the fake dispatches on
   * FIRST match, so the specific routes above still win.
   */
  [/^\s*SELECT/i, [{}]],
]);

const router = require('../routes/client/index');

function handlerFor(path, method) {
  const layer = router.stack.find((e) => e.route && e.route.path === path && e.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
const res = () => ({
  statusCode: null, body: null,
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
});
async function call(path, access = { allStores: true }) {
  const r = res();
  await handlerFor(path, 'get')(
    { spoc: { id: 42, client_id: 133 }, access, query: {} },
    r, (e) => { throw e; });
  assert.equal(r.body?.success, true, JSON.stringify(r.body));
  return r.body.data;
}

const row = (job_id, job_status) => ({
  job_id, job_status, job_reference_id: `R${job_id}`, client_ref_id: null,
  ticket_created_date_time: '2026-08-01 10:00:00', age_days: 3,
  city_name: 'Pune', category: 'Carpentry', estimate_value: 100,
});

beforeEach(() => { fake.reset(); queueRows = []; });

/* ── the bar ─────────────────────────────────────────────────────────── */

test('the summary counts openTotal as NOT IN (3,5,6,7), not newTickets + inProgress', async () => {
  await call('/dashboard-summary');
  const q = fake.calls.find((c) => /AS newTickets/i.test(c.sql));
  assert.match(q.sql, /j\.job_status NOT IN \(3, 5, 6, 7\)[^,]*AS openTotal/,
    'the old basis omitted 15, 21 and 10 — open jobs the bar never counted');
  assert.match(q.sql, /j\.job_status = 15[^,]*AS awaitingYou/,
    'pending-on-you is status 15 exactly');
});

test('both halves come from ONE query, so the segments cannot stop summing', async () => {
  await call('/dashboard-summary');
  const withBoth = fake.calls.filter((c) => /AS openTotal/i.test(c.sql) && /AS awaitingYou/i.test(c.sql));
  assert.equal(withBoth.length, 1,
    'two queries is how the halves end up on different scopes and stop partitioning');
});

test('the two counts are reported RAW and are allowed to overlap', async () => {
  const d = await call('/dashboard-summary');
  assert.equal(d.counts.openTotal, 20);
  assert.equal(d.counts.awaitingYou, 3);
  /*
   * Status 15 is non-terminal, so it sits INSIDE openTotal — the card shows
   * each figure exactly as its label names it, by decision. The route must not
   * pre-subtract on the card's behalf: an earlier version did, and it produced
   * an "EasyFix" number that no stated definition yields.
   */
  assert.ok(d.counts.awaitingYou <= d.counts.openTotal, 'the overlap is expected');
  assert.equal(d.counts.pendingWithEasyfix, undefined, 'no pre-computed segment');
});

/* ── the queue ───────────────────────────────────────────────────────── */

test('⚠ the QUERY admits status 15 and nothing else', async () => {
  queueRows = [row(1, 15)];
  await call('/action-queue');
  const q = fake.calls.find((c) => /job_service_status = 1/i.test(c.sql));
  assert.ok(q, 'the queue query should have run');
  assert.match(q.sql, /J\.job_status = 15/,
    'membership is status 15 — an estimate sent and not yet decided');
  assert.doesNotMatch(q.sql, /job_status NOT IN \(3,5,6\)/,
    'the old filter admitted 6,832 enquiries on QA against 54 real approvals');
});

test('a status-15 row is an approval with the PATCH that clears it', async () => {
  queueRows = [row(1, 15)];
  const d = await call('/action-queue');
  assert.equal(d.items[0].type, 'approval');
  assert.equal(d.items[0].approvable, true);
  assert.equal(d.items[0].action.label, 'Approve');
  assert.equal(d.items[0].action.method, 'PATCH');
  assert.match(d.items[0].action.path, /\/estimate\/approve$/,
    'queue membership and the action that empties it must describe one set');
});

test('the label is DERIVED, so loosening the filter cannot resurrect the bug', async () => {
  /*
   * The WHERE admits only 15 today, so this row cannot occur in production.
   * It is exercised anyway: the value of deriving the label rather than
   * hardcoding it is precisely that a future filter change stays honest, and
   * an untested branch is not a guarantee.
   */
  queueRows = [row(2, 7)];
  const d = await call('/action-queue');
  assert.equal(d.items[0].type, 'open');
  assert.equal(d.items[0].approvable, false);
  assert.equal(d.items[0].action.label, 'View');
  assert.equal(d.items[0].action.method, 'GET',
    'a PATCH the server would reject is a button that lies');
});

/* ── repeatedly unreachable ───────────────────────────────────────────
 *
 * "Three call-laters in three days" means three DIFFERENT DAYS inside a
 * three-day span. The near misses are the specification, so they are what is
 * pinned: three calls in one afternoon is one bad afternoon, and one call
 * spread over three days is a single attempt.
 */

test('the count comes from the comment history, NOT the call_later flag', async () => {
  await call('/dashboard-summary');
  const q = fake.calls.find((c) => /comment_on = 16/i.test(c.sql));
  assert.ok(q, 'the unreachable count should query tbl_job_comment');
  /*
   * tbl_job.call_later is a bit(1) with no count and no dates — it can only
   * say "unreachable at least once, ever". Counting a PATTERN from it is
   * impossible, which is why the old noResponse bucket built on it was
   * inflating "pending on you" with jobs nobody could act on.
   */
  assert.match(q.sql, /tbl_job_comment/, 'the history table, which has one row per outcome');
  assert.doesNotMatch(q.sql, /call_later/, 'the flag cannot express three days');
});

test('DISTINCT dates — three calls in ONE day must not qualify', async () => {
  await call('/dashboard-summary');
  const q = fake.calls.find((c) => /comment_on = 16/i.test(c.sql));
  assert.match(q.sql, /DISTINCT[\s\S]*DATE\(c\.created_on\)/,
    'collapsing several calls on one day to one date is what excludes the one-afternoon case');
  assert.match(q.sql, /COUNT\(DISTINCT b\.d\) >= 3/,
    'three distinct DATES, not three rows');
});

test('the three-day SPAN is enforced, so three dates months apart do not qualify', async () => {
  await call('/dashboard-summary');
  const q = fake.calls.find((c) => /comment_on = 16/i.test(c.sql));
  assert.match(q.sql, /BETWEEN a\.d AND DATE_ADD\(a\.d, INTERVAL 2 DAY\)/,
    'an anchor date plus two — three consecutive days, not any three dates ever');
});

test('only OPEN jobs count — a closed job is not still unreachable', async () => {
  await call('/dashboard-summary');
  const q = fake.calls.find((c) => /comment_on = 16/i.test(c.sql));
  assert.match(q.sql, /j\.job_status NOT IN \(3,5,6,7\)/,
    'the job being open IS the recency filter; there is deliberately no date cutoff');
});

/* ── scope: the bug that put two populations on one screen ───────────── */

test('an allStores SPOC is UNRESTRICTED — no reporting-contact clause at all', async () => {
  await call('/dashboard-summary', { allStores: true });
  for (const q of fake.calls.filter((c) => /FROM\s+tbl_job/i.test(c.sql))) {
    assert.doesNotMatch(q.sql, /reporting_contact_id IN \(/,
      'a Senior Leader sees the whole client — the action queue beside this card already does');
  }
});

test('⚠ a scoped SPOC gets the SAME subtree the action queue uses', async () => {
  await call('/dashboard-summary', { allStores: false });
  const q = fake.calls.find((c) => /AS newTickets/i.test(c.sql));
  assert.match(q.sql, /j\.reporting_contact_id IN \(/, 'still scoped for everyone else');
  /*
   * This card used to resolve its OWN list — self plus DIRECT reports,
   * non-recursive — and ignore allStores entirely, while the queue beside it
   * used hierarchyFilter. Two panels counting two different populations, which
   * is how "Jobs Waiting for You" could show an approval that "Pending on you"
   * counted as zero.
   */
  const ownLookup = fake.calls.filter((c) => /CAST\(manager_id AS UNSIGNED\)/i.test(c.sql));
  assert.equal(ownLookup.length, 0,
    'no bespoke direct-reports query — resolveClientHierarchy is the one definition');
});

test('it is reported SEPARATELY from noResponse, not instead of it', async () => {
  const d = await call('/dashboard-summary');
  assert.ok('repeatedlyUnreachable' in d.attention, 'the pattern count');
  assert.ok('noResponse' in d.attention,
    'the bare flag stays — other consumers read it, and the two mean different things');
});

/* ── one definition of "open" across the whole card ──────────────────── */

test('the SLA-ageing bands use the SAME predicate the openTotal card counts', async () => {
  await call('/dashboard-summary');
  const q = fake.calls.find((c) => /AS d7plus/i.test(c.sql));
  assert.ok(q, 'the ageing bands must be queried');
  assert.match(q.sql, /j\.job_status NOT IN \(3,5,6,7\)/,
    'this enumerated IN (0,1,2,20,9,15,21) — the same seven codes MINUS 10, so a job '
    + 'open enough to be counted was not open enough to be aged');
  assert.doesNotMatch(q.sql, /job_status IN \(0,1,2,20,9,15,21\)/,
    'the positive list is what drifted; the negative set cannot');
});
