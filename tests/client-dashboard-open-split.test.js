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
  [/FROM tbl_client_contacts/i, [{ id: 11 }]],
  [/SELECT manager_id FROM tbl_client_contacts/i, [{ manager_id: null }]],
  [/WITH RECURSIVE team/i, [{ id: 42 }]],
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
async function call(path) {
  const r = res();
  await handlerFor(path, 'get')(
    { spoc: { id: 42, client_id: 133 }, access: { allStores: true }, query: {} },
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
