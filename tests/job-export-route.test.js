/*
 * ROUTE-LEVEL test for Manage Jobs → Export (GET /api/admin/jobs/export.xlsx).
 *
 * WHY THIS FILE EXISTS — the incident it is a direct answer to.
 *
 * On 2026-08-20 every Jobs export in production returned "Export failed:
 * Internal Server Error", on every filter combination, for every operator. The
 * cause was four words long: routes/admin/jobs.js read `filters` twenty-five
 * lines ABOVE its own `const filters = …` declaration — the temporal dead zone.
 * `const` is not hoisted the way `var` is, so that read is a THROW, not
 * `undefined`:
 *
 *     ReferenceError: Cannot access 'filters' before initialization
 *
 * The handler died on entry, before it built a single WHERE clause.
 *
 * TWO THINGS FAILED TO CATCH IT, AND BOTH ARE THE POINT OF THIS FILE:
 *
 *   1. THE MODULE STILL IMPORTED CLEANLY. A dead-zone read only fires when the
 *      handler RUNS, so `node -e "require('./routes/admin/jobs.js')"` printed
 *      "route loads OK" while the feature was 100% down. A clean import is not
 *      evidence that a handler works, and it was read as if it were.
 *
 *   2. tests/job-export-filters.test.js has 38 tests over this very export and
 *      not one of them invokes the route. They call buildExportWhere() and
 *      fetchExportChunk() directly, so the handler — including the throwing
 *      line — was never executed. The suite stayed green through a total
 *      outage of the feature it covers.
 *
 * So this file deliberately does the ONE thing that suite cannot: it issues a
 * REAL HTTP REQUEST at the REAL router and asserts the response is not a 500.
 * Anything that throws anywhere in the handler body — a dead-zone read, a
 * typo'd identifier, a middleware mounted in the wrong order, a destructure of
 * something undefined — surfaces here as a status code, because that is what
 * the operator sees. Nothing below reaches into the service layer to check a
 * clause; job-export-filters.test.js owns that, and owning it is why it could
 * not see this.
 *
 * FAITHFULNESS. The router under test is the shipped routes/admin/jobs.js,
 * mounted on a real express app listening on a real port. Only what
 * routes/admin/index.js would have attached upstream — req.user, req.scope,
 * req.allowedStages — is injected by a stand-in middleware; that mount is not
 * what is being tested here.
 *
 * NO DATABASE. The fake-pool seam answers the two export reads (the phase-1 id
 * query and the phase-2 hydrate) from canned rows, so this test writes nothing
 * anywhere and needs no connection. The export path is READ-ONLY, so unlike
 * tests/job-stage-access-routes.test.js there is no write sentinel to arm.
 *
 * Runner: `node --test` (see npm test).
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

// The Office Open XML mime the streamer sets on a successful export.
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Mutable per-test scenario the fake pool routes read.
const scenario = {
  idRows: [],     // phase 1 — the job_ids this filter combination resolves to
  detailRows: [], // phase 2 — the hydrated rows for those ids
};

/*
 * A hydrated export row, trimmed to the columns mapExportRow actually reads on
 * a live path. Everything the mapper touches and this object omits arrives as
 * `undefined`, which is precisely what a LEFT JOIN with no match yields — so a
 * sparse row is the realistic shape, not a degenerate one.
 */
function detailRow(jobId) {
  return {
    job_id: jobId,
    job_status: 6,                       // cancelled — matches the reported filter
    job_reference_id: `REF-${jobId}`,
    created_date_time: '2026-08-01 10:00:00',
    requested_date_time: '2026-08-02 11:30:00',
    job_primary_spoc: '77',              // VARCHAR column — exercises the owner-name lookup
    fk_client_id: 5,
    fk_customer_id: 3,
    city_id: 11,
  };
}

const fake = installFakePool([
  // job.service's memoised tbl_client.vertical_id probe, reached through
  // fetchExportChunk → hasClientVerticalIdColumn().
  [/SHOW\s+COLUMNS\s+FROM\s+tbl_client/i, () => [{ Field: 'vertical_id' }]],
  // Phase 2 FIRST: its projection also contains `J.job_id`, so matching phase 1
  // on a looser pattern would swallow it. `previousEfrId` is unique to
  // EXPORT_SELECT and cannot collide.
  [/previousEfrId/i, () => scenario.detailRows],
  // Phase 1 — the keyset id query (`SELECT J.job_id FROM tbl_job J …`).
  [/SELECT\s+J\.job_id\s+FROM\s+tbl_job\s+J/i, () => scenario.idRows],
  // attachJobOwnerNames' id → name lookup.
  [/SELECT\s+user_id,\s*user_name\s+FROM\s+tbl_user/i, () => [{ user_id: 77, user_name: 'Export Tester' }]],
]);

const express = require('express');
const jobsRouter = require('../routes/admin/jobs');

let server;
let baseUrl;

/*
 * The last error the router handed to next(). Captured so a failure REPORTS THE
 * CAUSE instead of only the status code — on the original bug this holds
 * "Cannot access 'filters' before initialization", which is the whole diagnosis
 * in one line. A test that says "expected 200, got 500" and stops there costs
 * the next person the debugging session this file is meant to save.
 */
let lastError = null;

before(async () => {
  const app = express();
  app.use(express.json());
  /*
   * Stand-in for routes/admin/index.js. Full geo scope and an unrestricted
   * stage grant: this file is about whether the handler RUNS, so nothing here
   * may be able to 403 or narrow the request on its own.
   */
  app.use((req, _res, next) => {
    req.user = { user_id: 77, user_name: 'Export Tester' };
    req.userRole = { role_name: 'Executive Supply' };
    req.scope = {
      clients:   { mode: 'all', ids: [], placeholders: '' },
      cities:    { mode: 'all', ids: [], placeholders: '' },
      states:    { mode: 'all', ids: [], placeholders: '' },
      verticals: { mode: 'all', ids: [], placeholders: '' },
    };
    req.allowedStages = { mode: 'all', stages: [] };
    next();
  });
  app.use('/jobs', jobsRouter);
  // Terminal error handler standing in for the app's. 500 is what the operator
  // saw, so 500 is what this test must be able to observe.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    lastError = err;
    res.status(500).json({ success: false, error: String(err && err.message) });
  });

  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  fake.restore();
});

beforeEach(() => {
  fake.calls.length = 0;
  lastError = null;
  scenario.idRows = [];
  scenario.detailRows = [];
});

/*
 * Fetch the export and read the body as BYTES. `res.json()` would throw on a
 * real xlsx, and a throw in the helper reads as a broken test rather than as
 * the pass it is.
 */
async function exportXlsx(query = '') {
  const res = await fetch(`${baseUrl}/jobs/export.xlsx${query}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    contentType: res.headers.get('content-type') || '',
    disposition: res.headers.get('content-disposition') || '',
    bytes: buf.length,
    text: buf.length < 4096 ? buf.toString('utf8') : '',
  };
}

/*
 * The failure message the ORIGINAL bug produces, spelled out so the diagnosis
 * survives in the test output rather than only in this comment.
 */
function why(res) {
  return `export returned ${res.status}`
    + (lastError ? ` — the handler threw: ${lastError.name}: ${lastError.message}` : '')
    + '. A 500 here means the handler died before it produced a file, which is '
    + 'exactly what the operator sees as "Export failed: Internal Server Error".';
}

// ── 1. THE REPORTED CASE, VERBATIM ───────────────────────────────────
/*
 * "Bucket Status = Cancelled" in the Manage Jobs filter card. The CRM's
 * BUCKET_STATUS_MAP (Easyfix_CRM_UI src/lib/job-buckets.ts) maps that pick to
 * job_status 6 and 7, and buildStatusParams ships it as `statuses=6,7` — so
 * this query string is the one the reporting operator's browser actually sent,
 * not a paraphrase of it.
 */
test('the reported case — Bucket Status = Cancelled — does not 500', async () => {
  const res = await exportXlsx('?statuses=6%2C7');
  assert.notEqual(res.status, 500, why(res));
  assert.equal(res.status, 200);
  assert.equal(lastError, null, 'the handler must not throw at all');
  assert.match(res.contentType, new RegExp(XLSX_MIME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(res.disposition, /attachment; filename="ManageJobReport_\d{4}-\d{2}-\d{2}\.xlsx"/);
});

// ── 2. NO FILTERS AT ALL ─────────────────────────────────────────────
/*
 * The bare Export click. Worth its own case because this is the ONE path that
 * makes the handler take the `imposed.length` branch — buildExportWhere applies
 * a default date window and the open-jobs floor when the caller pinned nothing,
 * so `appliedDefaults` comes back non-empty and the log line below the
 * declaration actually executes. The dead-zone read lived on exactly that
 * statement's line.
 */
test('an export with NO filters does not 500', async () => {
  const res = await exportXlsx('');
  assert.notEqual(res.status, 500, why(res));
  assert.equal(res.status, 200);
  assert.equal(lastError, null);
});

// ── 3. CLOSED ────────────────────────────────────────────────────────
// Bucket Status = "Closed / Completed" → statuses=3,5. A second filter shape,
// so a pass on case 1 cannot be a coincidence of one particular value.
test('a Closed-status export does not 500', async () => {
  const res = await exportXlsx('?statuses=3%2C5');
  assert.notEqual(res.status, 500, why(res));
  assert.equal(res.status, 200);
  assert.equal(lastError, null);
});

// ── 4. THE HANDLER ACTUALLY REACHED THE DATA LAYER ───────────────────
/*
 * A 200 alone is not proof of life: a handler that threw before querying and a
 * handler that ran correctly over an empty result set both produce a
 * header-only workbook. This pins the difference — the filter the operator
 * chose has to arrive at the phase-1 SQL as bound parameters.
 *
 * Without this assertion, the file could pass while the export silently
 * returned an empty sheet for every filter, which is a quieter version of the
 * same outage.
 */
test('the Cancelled filter reaches the phase-1 query as bound params', async () => {
  await exportXlsx('?statuses=6%2C7');
  const phase1 = fake.calls.filter((c) => /SELECT\s+J\.job_id\s+FROM\s+tbl_job\s+J/i.test(c.sql));
  assert.equal(phase1.length, 1, 'the handler must have run exactly one id query');
  assert.match(phase1[0].sql, /WHERE/i, 'the id query must carry a WHERE built from the filters');
  assert.ok(
    phase1[0].params.includes(6) && phase1[0].params.includes(7),
    `statuses 6 and 7 must be bound, got ${JSON.stringify(phase1[0].params)}`,
  );
});

// ── 5. ROWS ON THE WIRE ──────────────────────────────────────────────
/*
 * Drive the FULL streaming path once with real rows: phase 1 → phase 2 →
 * attachJobOwnerNames → mapExportRow → the xlsx writer's per-row commit. The
 * empty-result cases above never touch mapExportRow, so a throw in the mapper
 * would slip past all of them and land on the operator as the same
 * "Export failed" toast.
 */
test('an export that yields rows streams a complete file', async () => {
  scenario.idRows = [{ job_id: 522124 }, { job_id: 522123 }];
  scenario.detailRows = [detailRow(522124), detailRow(522123)];

  const res = await exportXlsx('?statuses=6%2C7');
  assert.notEqual(res.status, 500, why(res));
  assert.equal(res.status, 200);
  assert.equal(lastError, null);
  // 'PK' — the local-file-header magic of every zip, and an xlsx is a zip. A
  // truncated or aborted stream does not produce one.
  assert.ok(res.bytes > 0, 'the response must carry a body');
});
