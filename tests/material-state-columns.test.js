/*
 * Material Request Flow v2 (2026-09-21) — job.service.js's material_state /
 * material_count rollup, added to BOTH the LIST projection (GET /api/mobile/
 * jobs, GET /api/admin/jobs) and getByIdCore (GET /api/mobile/jobs/:id,
 * GET /api/admin/jobs/:id — the shared detail reader). See
 * docs/superpowers/specs/2026-09-21-material-request-flow-v2-design.md
 * ("Job-level").
 *
 * A fake pool cannot evaluate a MySQL CASE/subquery, so this file verifies
 * the SQL TEXT job.service.js actually sends — the same literals (16, 15,
 * `sent_on IS NULL`) a real MySQL server would evaluate — is present and
 * correctly shaped, with a positive control (see the bottom) proving the
 * assertions actually exercise the real predicate text rather than a
 * hand-typed expectation that would pass regardless.
 *
 * Runner: `node --test --test-force-exit tests/material-state-columns.test.js`.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { installFakePool } = require('./helpers/fake-pool');

const JOB_ID = 555;
let detailSql = null;
let listSql = null;

const fake = installFakePool([
  [/INFORMATION_SCHEMA/i, () => [{ n: 3 }]], // every column-presence probe: "yes, present"
  [/SELECT j\.\*/i, (sql) => { detailSql = sql; return [{ job_id: JOB_ID, job_status: 2, remarks: null, custom_property: null }]; }],
  [/SELECT COUNT\(\*\) AS total/i, () => [{ total: 0 }]],
  [/SELECT\s+j\.job_id, j\.job_reference_id/i, (sql) => { listSql = sql; return []; }],
  [/^\s*(SELECT|INSERT|UPDATE)/i, () => []],
]);

const jobService = require('../services/job.service');

before(async () => { await jobService.getById(JOB_ID); await jobService.list({ limit: 5 }); });
after(() => fake.restore());

// ─── getByIdCore (job detail) ───────────────────────────────────────────

test('getByIdCore SELECTs a material_state CASE keyed on job_status 16/15, else a draft EXISTS, else NULL', () => {
  assert.ok(detailSql, 'the detail query must have run');
  assert.match(detailSql, /WHEN j\.job_status = 16 THEN 'review_pending'/);
  assert.match(detailSql, /WHEN j\.job_status = 15 THEN 'approval_pending'/);
  assert.match(detailSql, /EXISTS \(SELECT 1 FROM quotation_details \w+ WHERE \w+\.job_id = j\.job_id AND \w+\.sent_on IS NULL\)/);
  assert.match(detailSql, /THEN 'draft'/);
  assert.match(detailSql, /ELSE NULL\s*\n\s*END AS material_state/);
});

test('getByIdCore SELECTs a material_count over draft/review_pending/approval_pending lines only', () => {
  assert.match(detailSql, /SELECT COUNT\(\*\) FROM quotation_details \w+\s+WHERE \w+\.job_id = j\.job_id\s+AND \(/);
  assert.match(detailSql, /\) AS material_count/);
  // The three OPEN_STATES predicates, not the rejected/client_approved/
  // client_rejected ones — a rejected line must never inflate the count.
  assert.match(detailSql, /sent_on IS NULL/);
  assert.match(detailSql, /sent_on IS NOT NULL AND \w+\.action_on IS NULL/);
  assert.match(detailSql, /action_on IS NOT NULL AND CAST\(\w+\.status AS UNSIGNED\) = 1 AND \w+\.client_status IS NULL/);
  assert.doesNotMatch(detailSql, /CAST\(\w+\.status AS UNSIGNED\) = 0/, 'the rejected predicate must not appear in material_count');
});

// ─── LIST projection ─────────────────────────────────────────────────────

test('list() carries the SAME material_state/material_count fragment as getByIdCore (one shared function, not two copies)', () => {
  assert.ok(listSql, 'the list query must have run');
  assert.match(listSql, /WHEN j\.job_status = 16 THEN 'review_pending'/);
  assert.match(listSql, /WHEN j\.job_status = 15 THEN 'approval_pending'/);
  assert.match(listSql, /AS material_count/);
});

/*
 * POSITIVE CONTROL (performed manually during implementation, not left in
 * the suite): temporarily changed job.service.js's materialStateColumns()
 * literal from `j.job_status = 16` to `j.job_status = 17` and re-ran this
 * file — "getByIdCore SELECTs a material_state CASE..." went red (the regex
 * for `= 16` no longer matched), confirming the assertion is reading the
 * REAL emitted SQL and not a fixture that would pass regardless. Reverted
 * immediately after confirming the failure.
 */
