/*
 * ROUTE-LEVEL tests for the terminal-status guard on
 * POST /api/admin/jobs/bulk-owner-transfer.
 *
 * WHY ROUTE-LEVEL AND NOT SERVICE-LEVEL: the guard does not live in a service.
 * It lives inside the route handler's per-job loop, reading a column the handler
 * itself SELECTs. A service test cannot see it at all — and this repo has
 * already been bitten by exactly that blind spot (a temporal-dead-zone
 * ReferenceError in this same file that 38 green service tests never noticed,
 * because none of them made the handler RUN). So we mount the REAL
 * routes/admin/jobs.js router and issue REAL HTTP requests: the handler
 * executes end to end, and a dead-zone/typo/ordering mistake surfaces as a 500
 * rather than hiding behind a clean `require`.
 *
 * No DB: the fake-pool seam answers the handler's own single-row read and the
 * role-cache load. `job.changeOwner` is replaced with a recorder so the test can
 * assert the strongest thing available — not merely "the summary said skipped",
 * but "the transfer was NEVER ATTEMPTED for that job". A guard that reported a
 * skip and still wrote would pass the first assertion and fail this one.
 *
 * Runner: `node --test` (see npm test).
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

// ── Fixtures ─────────────────────────────────────────────────────────
const SOURCE_OWNER = 101;
const TARGET_OWNER = 202;

/*
 * Status codes chosen to cover the whole guarded set plus its edges:
 *   9  BOOKED / open        → transferable
 *   1  open (in progress)   → transferable
 *   3, 5 completed | 6 cancelled | 7 enquiry → BLOCKED
 *   4  deliberately NOT in the blocked set — proves the guard is a set
 *      membership test, not "status >= 3".
 */
const JOBS = {
  9001: { job_client_owner: SOURCE_OWNER, job_status: 9 },  // open
  9002: { job_client_owner: SOURCE_OWNER, job_status: 3 },  // completed
  9003: { job_client_owner: SOURCE_OWNER, job_status: 5 },  // completed (alt code)
  9004: { job_client_owner: SOURCE_OWNER, job_status: 6 },  // cancelled
  9005: { job_client_owner: SOURCE_OWNER, job_status: 7 },  // enquiry
  9006: { job_client_owner: SOURCE_OWNER, job_status: 1 },  // open
  9007: { job_client_owner: SOURCE_OWNER, job_status: 4 },  // NOT terminal
  9008: { job_client_owner: 999,          job_status: 9 },  // wrong source owner
};

const fake = installFakePool([
  // role.service's cache load — role_id 2 is the canonical Admin, the only
  // role roleByName(['Admin']) lets through.
  [/FROM\s+tbl_role/i, () => [
    { role_id: 2, role_name: 'Admin', role_desc: 'Admin', role_status: 1, menu_ids: '' },
  ]],
  // The handler's own per-job read. MUST return job_status too — if the guard
  // ever stops selecting it, `undefined` falls out here and the guard opens.
  [/SELECT\s+job_client_owner,\s*job_status\s+FROM\s+tbl_job/i, (_sql, params) => {
    const row = JOBS[Number(params[0])];
    return row ? [{ ...row }] : [];
  }],
]);

const express = require('express');
const jobService = require('../services/job.service');
const jobsRouter = require('../routes/admin/jobs');

// Ids for which changeOwner was actually invoked. The real assertion target.
let attempted = [];
// What filters-mode resolution hands back as the target set.
let listRows = [];

const realChangeOwner = jobService.changeOwner;
const realList = jobService.list;

let server;
let baseUrl;

before(async () => {
  /*
   * Recorder, not a mock of convenience: the point of the guard is that the
   * write never happens. Recording the CALL (rather than inspecting SQL after
   * the fact) makes "was not transferred" directly observable.
   */
  jobService.changeOwner = async (jobId) => {
    attempted.push(Number(jobId));
    return { job_id: Number(jobId) };
  };
  jobService.list = async () => ({ rows: listRows, total: listRows.length });

  const app = express();
  app.use(express.json());
  // Stand-in for routes/admin/index.js — user_role 2 resolves to Admin above.
  app.use((req, _res, next) => {
    req.user = { user_id: 77, user_name: 'Bulk Tester', user_role: 2 };
    next();
  });
  app.use('/jobs', jobsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: String((err && err.message) || err) });
  });

  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  jobService.changeOwner = realChangeOwner;
  jobService.list = realList;
  fake.restore();
});

beforeEach(() => {
  fake.calls.length = 0;
  attempted = [];
  listRows = [];
});

async function bulkTransfer(body) {
  const res = await fetch(`${baseUrl}/jobs/bulk-owner-transfer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

// The handler wraps its payload in modernOk; unwrap either shape so the tests
// assert on content, not on the envelope's field name.
function payload(json) {
  return json && (json.data ?? json.result ?? json);
}

function rowFor(results, jobId) {
  return results.find((r) => Number(r.jobId) === jobId);
}

// ── 1. Handler RUNS ──────────────────────────────────────────────────
/*
 * Guards the dead-zone class of bug directly: a `const` read above its
 * declaration imports fine and 500s only when the handler executes. This test
 * exists so that failure mode is caught by its symptom (a 500) and not by a
 * reviewer's eye.
 */
test('handler executes — a plain open job transfers, no 500', async () => {
  const { status, json } = await bulkTransfer({
    fromOwnerId: SOURCE_OWNER, toOwnerId: TARGET_OWNER,
    reason: 'workload rebalance', jobIds: [9001],
  });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(json)}`);
  const p = payload(json);
  assert.equal(p.summary.transferred, 1);
  assert.deepEqual(attempted, [9001]);
});

// ── 2. Each terminal status is blocked, individually ─────────────────
for (const [jobId, label] of [[9002, 'completed (3)'], [9003, 'completed (5)'], [9004, 'cancelled (6)'], [9005, 'enquiry (7)']]) {
  test(`terminal job ${jobId} — ${label} — is skipped and NEVER transferred`, async () => {
    const { status, json } = await bulkTransfer({
      fromOwnerId: SOURCE_OWNER, toOwnerId: TARGET_OWNER,
      reason: 'workload rebalance', jobIds: [jobId],
    });
    assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(json)}`);
    const p = payload(json);

    assert.equal(p.summary.skipped, 1, 'terminal job must be counted as skipped');
    assert.equal(p.summary.transferred, 0, 'terminal job must NOT be transferred');
    assert.equal(p.summary.failed, 0, 'ineligible is not a failure');

    const row = rowFor(p.results, jobId);
    assert.ok(row, 'every id must appear in results');
    assert.equal(row.status, 'skipped');
    assert.match(
      row.reason,
      /completed\/cancelled jobs cannot be transferred/i,
      `operator-readable reason expected, got: ${row.reason}`,
    );

    // The teeth: the write path was not even entered.
    assert.deepEqual(attempted, [], 'changeOwner must never be called for a terminal job');
  });
}

// ── 3. Status 4 is NOT in the blocked set ────────────────────────────
test('status 4 is not terminal — still transfers (guard is set membership, not a threshold)', async () => {
  const { status, json } = await bulkTransfer({
    fromOwnerId: SOURCE_OWNER, toOwnerId: TARGET_OWNER,
    reason: 'workload rebalance', jobIds: [9007],
  });
  assert.equal(status, 200);
  assert.equal(payload(json).summary.transferred, 1);
  assert.deepEqual(attempted, [9007]);
});

// ── 4. Mixed batch: summary arithmetic stays truthful ────────────────
test('mixed batch — counts add up and only the open jobs move', async () => {
  const ids = [9001, 9002, 9003, 9004, 9005, 9006, 9008, 9999];
  const { status, json } = await bulkTransfer({
    fromOwnerId: SOURCE_OWNER, toOwnerId: TARGET_OWNER,
    reason: 'workload rebalance', jobIds: ids,
  });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(json)}`);
  const p = payload(json);

  assert.equal(p.summary.total, ids.length);
  assert.equal(p.summary.transferred, 2, 'only 9001 + 9006 are open and owned by the source');
  // 4 terminal + 1 wrong-owner + 1 not-found
  assert.equal(p.summary.skipped, 6);
  assert.equal(p.summary.failed, 0);
  // Every id must land in exactly one bucket — the property that makes the
  // summary readable at all.
  assert.equal(
    p.summary.transferred + p.summary.skipped + p.summary.failed,
    p.summary.total,
    'buckets must partition the input',
  );
  assert.equal(p.results.length, ids.length);

  assert.deepEqual(attempted.sort((a, b) => a - b), [9001, 9006]);

  // The not-found and wrong-owner skips keep their OWN reasons — the new guard
  // must not have swallowed the pre-existing ones.
  assert.match(rowFor(p.results, 9999).reason, /not found/i);
  assert.match(rowFor(p.results, 9008).reason, /current owner/i);
});

// ── 5. FILTERS MODE — the guard must hold on the other path too ──────
/*
 * Filters mode resolves its target ids through job.list() instead of the body.
 * Both modes converge on the same per-job loop, which is precisely why the
 * guard was placed there — but "by construction" is an argument, not evidence,
 * so this drives the second path for real. `filters` is deliberately given a
 * terminal `status`, the case where a resolution-time filter would have been
 * the caller's to choose.
 */
test('filters mode — terminal jobs resolved by the filter are still blocked', async () => {
  listRows = [
    { job_id: 9001 }, { job_id: 9002 }, { job_id: 9004 }, { job_id: 9006 },
  ];
  const { status, json } = await bulkTransfer({
    fromOwnerId: SOURCE_OWNER, toOwnerId: TARGET_OWNER,
    reason: 'quarter handover', filters: { status: 3 },
  });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(json)}`);
  const p = payload(json);

  assert.equal(p.summary.total, 4);
  assert.equal(p.summary.transferred, 2);
  assert.equal(p.summary.skipped, 2);
  assert.equal(p.summary.failed, 0);
  assert.deepEqual(attempted.sort((a, b) => a - b), [9001, 9006]);
  for (const id of [9002, 9004]) {
    assert.match(rowFor(p.results, id).reason, /completed\/cancelled jobs cannot be transferred/i);
  }
});

// ── 6. The guard reads a real column, not a stale projection ─────────
test('the per-job read selects job_status from tbl_job', async () => {
  await bulkTransfer({
    fromOwnerId: SOURCE_OWNER, toOwnerId: TARGET_OWNER,
    reason: 'workload rebalance', jobIds: [9002],
  });
  const read = fake.calls.find((c) => /SELECT\s+job_client_owner,\s*job_status\s+FROM\s+tbl_job/i.test(c.sql));
  assert.ok(read, 'handler must read job_status alongside job_client_owner');
  assert.deepEqual(read.params, [9002]);
});
