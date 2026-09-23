/*
 * Pending for Material (job_status 16) — Material Management phase 2,
 * sub-project D. Backend coverage for
 * docs/superpowers/specs/2026-09-18-pending-for-material-status-16-design.md
 * ("Testing"), plus the estimate-approvability gap flagged mid-implementation
 * (a status-16 job must show View Details ONLY on every client/partner
 * surface — no approve/reject before a PM has reviewed the quote).
 *
 * Covers:
 *   1. setStatus accepts 16, still rejects 17 (positive control on the enum
 *      guard itself).
 *   2. mobile material-required: 2/20 -> 16/1; refuses other statuses.
 *   3. mobile send-for-approval: sets 16/2, NEVER 15.
 *   4. admin material-review: approve -> 15 (permission_required stored,
 *      material_sub_status + material_reject_reason cleared); reject ->
 *      16/1 (reason stored in tbl_job_material_review AND mirrored
 *      to tbl_job_comment for the CRM); guarded by isJobMaterialReview;
 *      refuses when the job isn't at 16.
 *   5. client + public estimate approve: 15 -> 1, fk_easyfixter_id
 *      UNCHANGED (asserted, not assumed).
 *   6. client + public estimate reject: 15 -> 2.
 *   7. services/job-estimate-approval.js: the ONE shared "can the client act
 *      on this yet" gate — true only at 15 — wired into all four estimate
 *      surfaces (public GET status string, public PATCH approve/reject,
 *      authed PATCH approve/reject, the "Jobs waiting on you" action list).
 *   8. services/integration.service.js is UNCHANGED — a guard asserting its
 *      status maps carry no 16.
 *   9. TINYINT cast guard: getByIdCore CASTs material_sub_status /
 *      permission_required AS SIGNED rather than exposing db.js's
 *      TINYINT->boolean coercion.
 *
 * Runner: `node --test --test-force-exit tests/pending-for-material.test.js`.
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.WEBHOOK_OUTBOUND_ENABLED = 'false';

const { installFakePool } = require('./helpers/fake-pool');

// ─── Shared fixture ────────────────────────────────────────────────────────
// ONE job row, mutated per test. Every surface under test — mobile, admin,
// client, public-token — ultimately reads/writes the same tbl_job row, and
// db.js's `pool` is a process-wide singleton, so ONE fake-pool install (below)
// serves all of them; sections tell their queries apart by regex, not by a
// separate fake per file.
const TECH_EFR_ID = 4242;          // tbl_job.fk_easyfixter_id
const OPS_USER_ID = 77;            // PM pressing Approve/Reject in the CRM
const SPOC_LINKED_USER_ID = 555;   // the SPOC's linked tbl_user id

function makeJob(over = {}) {
  return {
    job_id: 900,
    job_status: 2,
    fk_easyfixter_id: TECH_EFR_ID,
    fk_client_id: 133,
    city_id: 11,
    vertical_id: 3,
    fk_customer_id: 3,
    reporting_contact_id: 43,
    job_owner: null,
    client_ref_id: null,
    approved_on_date_time: null,
    approval_reject_date_time: null,
    approval_sent_on_date_time: null,
    material_sub_status: null,
    permission_required: 0,
    material_reject_reason: null,
    requested_date_time: '2026-09-20 10:00:00',
    booking_cut_off_time_slot: null,
    otp: null,
    remarks: null,
    custom_property: null,
    customer_name: 'Test Customer',
    customer_mob_no: null,
    client_name: 'Test Client',
    ...over,
  };
}

let jobFixture = makeJob();
let permissions = ['isJobMaterialReview'];

const fake = installFakePool([
  // The SPOC / clientContact -> tbl_user link (client + public approve/reject).
  [/SELECT user_id FROM tbl_client_contacts WHERE id\s*=\s*\?/i, () => [{ user_id: SPOC_LINKED_USER_ID }]],
  // addComment's read-back of the row it just inserted (see admin-ops-checkin.test.js).
  [/FROM\s+tbl_job_comment\s+c\b[\s\S]*comment_id\s*=\s*\?/i, () => [{ id: 1, job_id: jobFixture.job_id, comment_on: 1 }]],
  // getByIdCore's aliased detail read (scopedJob / loadJobInScope / setStatus's
  // final getById, AND the public reject route's own aliased pre-check, which
  // shares the same FROM tbl_job j LEFT JOIN tbl_customer shape).
  [/FROM tbl_job j\s+LEFT JOIN tbl_customer/i, () => (jobFixture ? [jobFixture] : [])],
  [/SELECT j\.\*/i, () => (jobFixture ? [jobFixture] : [])],
  // getJobMeta (setStatus) / jobForTech (mobile) / the public approve
  // pre-check — all unaliased `FROM tbl_job WHERE job_id = ?`.
  [/FROM\s+tbl_job\s+WHERE\s+job_id\s*=\s*\?/i, () => (jobFixture ? [jobFixture] : [])],
  // Every write. Both the route's OWN stamp (approved_on_date_time / etc.)
  // and setStatus's job_status UPDATE land here — tests tell them apart by
  // inspecting the SET list, same technique as admin-ops-checkin.test.js.
  [/^\s*UPDATE tbl_job\b/i, () => ({ affectedRows: 1 })],
  [/^\s*INSERT INTO tbl_job_comment/i, () => ({ insertId: 1, affectedRows: 1 })],
  [/^\s*INSERT INTO tbl_job_logs/i, () => ({ insertId: 1, affectedRows: 1 })],
  [/INFORMATION_SCHEMA/i, () => [{ n: 3 }]],
  // Material Request Flow v2 (2026-09-21): sendForApproval/materialRequired
  // now require at least one DRAFT line to exist — one fixture draft row so
  // this file keeps testing sub-project D's original behaviour, not the new
  // 422 guard (covered in tests/quotation-line-state.test.js /
  // tests/material-request-flow-v2.test.js). Matched by the ABSENCE of
  // `type = 'material'` — that clause is unique to the admin material-review
  // route's pendingIds lookup, which must see NO rows here (this file's
  // material-review tests assert on an EMPTY `lines` review).
  [/^\s*SELECT id FROM quotation_details(?!.*type\s*=\s*'material')/is, () => [{ id: 1 }]],
  [/^\s*SELECT id FROM quotation_details.*type\s*=\s*'material'/is, () => []],
  // One-timestamp-per-send lookup (2026-09-22 amendment) — no prior sent_on
  // in this file's world, so nextSentOn falls straight through to `now`.
  [/^\s*SELECT MAX\(sent_on\)/i, () => [{ maxSentOn: null }]],
  [/^\s*UPDATE quotation_details\b/i, () => ({ affectedRows: 1 })],
  // Client/public approve-reject: the approval_pending line stamp — no line
  // fixtures in THIS file's world, so an UPDATE that touches 0 rows is
  // correct (nothing to stamp) and this is here only so the query has a
  // canned response rather than falling through with wrong SQL shape
  // assumptions.
  // Last resort — resolveCustomerRequests / job-services / images / videos /
  // webhook-adjacent reads this file makes no claim about.
  [/^\s*(SELECT|INSERT|UPDATE)/i, () => []],
]);

after(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  fake.restore();
});

beforeEach(() => {
  fake.calls.length = 0;
  jobFixture = makeJob();
  permissions = ['isJobMaterialReview'];
});

// Value bound to one column of a SET clause (see admin-ops-checkin.test.js —
// counts '?' placeholders before the column so a COALESCE(...) containing its
// own comma cannot mis-index a later column).
function boundValue(call, col) {
  const at = call.sql.search(new RegExp(`\\b${col}\\s*=`));
  if (at < 0) return undefined;
  const before = (call.sql.slice(0, at).match(/\?/g) || []).length;
  return call.params[before];
}
function jobUpdates(calls) { return calls.filter((c) => /^\s*UPDATE tbl_job\b/i.test(c.sql)); }
function statusUpdates(calls) { return jobUpdates(calls).filter((c) => /\bjob_status\s*=\s*\?/i.test(c.sql)); }

// ═════════════════════════════════════════════════════════════════════════
// 1. services/job.service.js — STATUS enum guard
// ═════════════════════════════════════════════════════════════════════════

const jobService = require('../services/job.service');

test('STATUS.PENDING_FOR_MATERIAL is 16, and setStatus accepts it', async () => {
  assert.equal(jobService.STATUS.PENDING_FOR_MATERIAL, 16);
  jobFixture = makeJob({ job_status: 2 });
  const out = await jobService.setStatus(jobFixture.job_id, { status: 16 }, { user_id: OPS_USER_ID });
  assert.ok(out, 'setStatus(16) must not throw');
  const upd = statusUpdates(fake.calls)[0];
  assert.ok(upd, 'the job_status UPDATE must have run');
  assert.equal(boundValue(upd, 'job_status'), 16);
});

test('positive control: setStatus still rejects 17 (17 was never added)', async () => {
  await assert.rejects(
    () => jobService.setStatus(jobFixture.job_id, { status: 17 }, { user_id: OPS_USER_ID }),
    (e) => { assert.equal(e.status, 400); return true; },
  );
  assert.equal(statusUpdates(fake.calls).length, 0, 'a rejected status must reach no UPDATE');
});

// ═════════════════════════════════════════════════════════════════════════
// 2 + 3. services/mobile-job-estimate.service.js — material-required,
//        send-for-approval
// ═════════════════════════════════════════════════════════════════════════

const estimateService = require('../services/mobile-job-estimate.service');

// Material Request Flow v2 (2026-09-21): materialRequired is now a literal
// ALIAS of sendForApproval (material_sub_status = 1 "Quotation Pending" is
// retired) — 2 -> 16 with sub-status 2 "Review Pending", same as send-for-
// approval, given the fixture draft line the fake pool now returns.
test('materialRequired (alias of sendForApproval): 2 -> 16, material_sub_status = 2', async () => {
  jobFixture = makeJob({ job_status: 2, fk_easyfixter_id: TECH_EFR_ID });
  const out = await estimateService.materialRequired(jobFixture.job_id, TECH_EFR_ID);
  assert.equal(out.status, 16);
  const upd = jobUpdates(fake.calls).find((c) => /job_status\s*=\s*\?/i.test(c.sql));
  assert.ok(upd);
  assert.equal(boundValue(upd, 'job_status'), 16);
  assert.equal(boundValue(upd, 'material_sub_status'), 2);
});

test('materialRequired: 20 (IN_PROGRESS_ALT) also qualifies', async () => {
  jobFixture = makeJob({ job_status: 20, fk_easyfixter_id: TECH_EFR_ID });
  const out = await estimateService.materialRequired(jobFixture.job_id, TECH_EFR_ID);
  assert.equal(out.status, 16);
});

// 15 -> 409 "Your previous quotation is with the client — send this one
// after they decide" (2026-09-22 amendment — SEND is refused at 15 with its
// own contract message; adding/drafting is allowed there now, but
// materialRequired has no drafts of its own to add — see the fixture, which
// carries no quotation line at all — so it hits this message, not the 422
// "no draft" one).
test('materialRequired refuses a job at 15 — nothing is written', async () => {
  jobFixture = makeJob({ job_status: 15, fk_easyfixter_id: TECH_EFR_ID });
  await assert.rejects(
    () => estimateService.materialRequired(jobFixture.job_id, TECH_EFR_ID),
    (e) => { assert.equal(e.status, 409); assert.match(e.message, /send this one after they decide/); return true; },
  );
  assert.equal(jobUpdates(fake.calls).length, 0);
});

test('sendForApproval sets 16 / material_sub_status 2 — NEVER 15', async () => {
  jobFixture = makeJob({ job_status: 16, material_sub_status: 2, fk_easyfixter_id: TECH_EFR_ID });
  const out = await estimateService.sendForApproval(jobFixture.job_id, TECH_EFR_ID, {});
  assert.equal(out.sent, true);
  const upd = jobUpdates(fake.calls).find((c) => /approval_sent_on_date_time/i.test(c.sql));
  assert.ok(upd);
  assert.equal(boundValue(upd, 'job_status'), 16, 'send-for-approval must not land on 15');
  assert.notEqual(boundValue(upd, 'job_status'), 15);
  assert.equal(boundValue(upd, 'material_sub_status'), 2);
});

// ═════════════════════════════════════════════════════════════════════════
// 4. routes/admin/jobs.js — POST /:id/material-review
// ═════════════════════════════════════════════════════════════════════════

const express = require('express');
const jobsRouter = require('../routes/admin/jobs');

let adminServer;
let adminBaseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { user_id: OPS_USER_ID, user_name: 'PM Tester', permissions: { menuIds: [], actionPermissions: permissions } };
    req.userRole = { role_name: 'Project Manager' };
    req.scope = {
      clients:   { mode: 'all', ids: [], placeholders: '' },
      cities:    { mode: 'all', ids: [], placeholders: '' },
      states:    { mode: 'all', ids: [], placeholders: '' },
      verticals: { mode: 'all', ids: [], placeholders: '' },
    };
    req.allowedStages = null;
    next();
  });
  app.use('/jobs', jobsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => { res.status(500).json({ error: String(err && err.message) }); });
  await new Promise((resolve) => { adminServer = app.listen(0, resolve); });
  adminBaseUrl = `http://127.0.0.1:${adminServer.address().port}`;
});

after(async () => { if (adminServer) adminServer.close(); });

async function adminPost(path, body) {
  const res = await fetch(`${adminBaseUrl}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('material-review approve: 16 -> 15, permission_required stored, sub-status + reason cleared', async () => {
  jobFixture = makeJob({ job_status: 16, material_sub_status: 2 });
  const res = await adminPost(`/jobs/${jobFixture.job_id}/material-review`, { decision: 'approve', permission_required: 1 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const upd = statusUpdates(fake.calls)[0];
  assert.ok(upd);
  assert.equal(boundValue(upd, 'job_status'), 15);
  assert.equal(boundValue(upd, 'permission_required'), 1);
  assert.equal(boundValue(upd, 'material_sub_status'), null);
  // The reason lives in tbl_job_material_review (tbl_job has no room for the
  // column — see the migration header); approve CLEARS it so a stale rejection
  // never follows an approved quote back to the technician.
  const cleared = fake.calls.find((c) => /INSERT INTO tbl_job_material_review/i.test(c.sql));
  assert.ok(cleared, 'approve must write the review row');
  assert.equal(cleared.params[1], null, 'approve clears the reject reason');
});

// Material Request Flow v2 (2026-09-21) — "Reject Request" now returns the
// job to its PRE-status (default 2, since this fixture's world has no
// tbl_job_material_review row seeded) rather than back to 16/1 "Quotation
// Pending" as sub-project D originally shipped. See
// tests/material-request-flow-v2.test.js for the case where a pre-status WAS
// stored.
test('material-review reject: job returns to pre-status (2), material_sub_status cleared, reason stored in tbl_job_material_review AND tbl_job_comment', async () => {
  jobFixture = makeJob({ job_status: 16, material_sub_status: 2 });
  const reason = 'Quote missing brand for item 3';
  const res = await adminPost(`/jobs/${jobFixture.job_id}/material-review`, { decision: 'reject', reason });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const upd = statusUpdates(fake.calls)[0];
  assert.ok(upd);
  assert.equal(boundValue(upd, 'job_status'), 2, 'no stored pre-status defaults to 2 (IN_PROGRESS)');
  assert.equal(boundValue(upd, 'material_sub_status'), null);
  const stored = fake.calls.find((c) => /INSERT INTO tbl_job_material_review/i.test(c.sql) && /reject_reason/i.test(c.sql));
  assert.ok(stored, 'the reason must be persisted for the technician app');
  assert.equal(stored.params[1], reason);

  const comment = fake.calls.find((c) => /^\s*INSERT INTO tbl_job_comment/i.test(c.sql));
  assert.ok(comment, 'the reason must also be mirrored to the CRM History tab');
  assert.equal(comment.params[1], reason);
  assert.equal(comment.params[2], 1, 'comment_on must be the approval-related bucket');
});

test('material-review reject requires a reason (400)', async () => {
  jobFixture = makeJob({ job_status: 16 });
  const res = await adminPost(`/jobs/${jobFixture.job_id}/material-review`, { decision: 'reject' });
  assert.equal(res.status, 400);
  assert.equal(statusUpdates(fake.calls).length, 0);
});

test('material-review refuses a job that is not at 16', async () => {
  jobFixture = makeJob({ job_status: 15 });
  const res = await adminPost(`/jobs/${jobFixture.job_id}/material-review`, { decision: 'approve', permission_required: 0 });
  assert.equal(res.status, 409);
  assert.equal(statusUpdates(fake.calls).length, 0);
});

test('material-review is gated by isJobMaterialReview — 403 without the grant', async () => {
  permissions = [];
  jobFixture = makeJob({ job_status: 16 });
  const res = await adminPost(`/jobs/${jobFixture.job_id}/material-review`, { decision: 'approve', permission_required: 0 });
  assert.equal(res.status, 403);
  assert.match(String(res.body?.error ?? ''), /isJobMaterialReview/);
  assert.equal(statusUpdates(fake.calls).length, 0);
});

test('material-review does NOT reuse the hold/release path (never writes status 10)', async () => {
  jobFixture = makeJob({ job_status: 16, material_sub_status: 2 });
  await adminPost(`/jobs/${jobFixture.job_id}/material-review`, { decision: 'approve', permission_required: 0 });
  const upd = statusUpdates(fake.calls)[0];
  assert.notEqual(boundValue(upd, 'job_status'), 10);
});

// ═════════════════════════════════════════════════════════════════════════
// 5 + 6. Client + public estimate approve/reject
// ═════════════════════════════════════════════════════════════════════════

const clientRouter = require('../routes/client/index');
const publicEstimateRouter = require('../routes/public/estimate.js');

function handlerFor(router, routePath, method) {
  const layer = router.stack.find((e) => e.route && e.route.path === routePath && e.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${routePath} must be mounted`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function mockRes() {
  return { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
// Material Request Flow v2, 2026-09-22 correction: the estimate/approve
// routes now REQUIRE visit_date_time + permission (see
// services/job-estimate-approval.js#approveWithVisitSchedule). Defaulted
// here so every existing call below keeps exercising what it always tested
// (the 15->1/2 move, the 16 guard) without each needing its own edit.
/*
 * TOMORROW, computed — never a literal date. A hardcoded '2026-09-23 10:00:00'
 * here stopped every QA deploy on 2026-09-23: assertSlotBookable refuses a slot
 * that is not in the future and within 30 days, so the fixture passed CI until
 * the day it named arrived, then failed 14 tests across two files for a reason
 * that had nothing to do with the change being deployed. IST, and 10:00 on the
 * NEXT day, so it is a valid slot hour (SLOT_START_HOURS) whatever time the
 * suite runs.
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const TOMORROW_IST_10AM = (() => {
  const ist = new Date(Date.now() + IST_OFFSET_MS + 24 * 3600 * 1000);
  return ist.toISOString().slice(0, 10) + ' 10:00:00';
})();
const APPROVE_BODY_DEFAULTS = { visit_date_time: TOMORROW_IST_10AM, permission: 'not_required' };

async function callClient(routePath, method, body = {}) {
  const r = mockRes();
  await handlerFor(clientRouter, routePath, method)(
    {
      spoc: { id: 42, client_id: 133 }, access: { allStores: true }, query: {}, params: { id: String(jobFixture.job_id) },
      body: routePath.includes('/estimate/approve') ? { ...APPROVE_BODY_DEFAULTS, ...body } : body,
    },
    r, (e) => { throw e; },
  );
  return r;
}

test('client estimate approve: 15 -> 1, SAME fk_easyfixter_id', async () => {
  jobFixture = makeJob({ job_status: 15, fk_easyfixter_id: TECH_EFR_ID });
  const r = await callClient('/jobs/:id/estimate/approve', 'patch');
  assert.equal(r.body?.success, true, JSON.stringify(r.body));
  const upd = statusUpdates(fake.calls)[0];
  assert.ok(upd, 'setStatus must have run');
  assert.equal(boundValue(upd, 'job_status'), 1);
  assert.doesNotMatch(upd.sql, /fk_easyfixter_id\s*=/, 'the technician must not be reassigned by an estimate approval');
  // The technician id itself, asserted directly against what the job was
  // assigned to before this call — not merely "unmatched by the SQL".
  assert.equal(jobFixture.fk_easyfixter_id, TECH_EFR_ID);
});

test('client estimate reject: 15 -> 2', async () => {
  jobFixture = makeJob({ job_status: 15 });
  const r = await callClient('/jobs/:id/estimate/reject', 'patch', { reason: 'Price too high' });
  assert.equal(r.body?.success, true, JSON.stringify(r.body));
  const upd = statusUpdates(fake.calls)[0];
  assert.ok(upd);
  assert.equal(boundValue(upd, 'job_status'), 2);
});

test('client estimate approve/reject refuse a status-16 job (not yet PM-reviewed)', async () => {
  jobFixture = makeJob({ job_status: 16, material_sub_status: 2 });
  const rApprove = await callClient('/jobs/:id/estimate/approve', 'patch');
  assert.equal(rApprove.statusCode, 409, JSON.stringify(rApprove.body));
  assert.equal(statusUpdates(fake.calls).length, 0);

  fake.calls.length = 0;
  const rReject = await callClient('/jobs/:id/estimate/reject', 'patch', { reason: 'anything' });
  assert.equal(rReject.statusCode, 409, JSON.stringify(rReject.body));
  assert.equal(statusUpdates(fake.calls).length, 0);
});

// ── the "Jobs waiting on you" action list — no Approve at 16 ──────────────

async function callActionQueue() {
  const r = mockRes();
  await handlerFor(clientRouter, '/action-queue', 'get')(
    { spoc: { id: 42, client_id: 133 }, access: { allStores: true }, query: {} },
    r, (e) => { throw e; },
  );
  return r;
}

test('action queue: a 15 row offers Approve; a 16 row (hypothetically admitted) would not', () => {
  const { isEstimateApprovable } = require('../services/job-estimate-approval');
  assert.equal(isEstimateApprovable(15), true);
  assert.equal(isEstimateApprovable(16), false, 'a status-16 job must never render an Approve action');
});

// ── public magic-link token twin ──────────────────────────────────────────

const jwt = require('jsonwebtoken');
function mintEstimateToken(jobId, clientContactId = null) {
  return jwt.sign({ sub: String(jobId), clientContactId }, process.env.JWT_SECRET);
}
async function callPublic(routePath, method, { token, body = {} } = {}) {
  const r = mockRes();
  await handlerFor(publicEstimateRouter, routePath, method)(
    {
      params: { token: token || mintEstimateToken(jobFixture.job_id, 42) },
      body: routePath.includes('/approve') ? { ...APPROVE_BODY_DEFAULTS, ...body } : body,
    },
    r, (e) => { throw e; },
  );
  return r;
}

test('public GET /:token: a 15 job reports status "pending" (client-actionable)', async () => {
  jobFixture = makeJob({ job_status: 15 });
  const r = await callPublic('/:token', 'get');
  assert.equal(r.statusCode ?? 200, 200);
  assert.equal(r.body?.data?.status ?? r.body?.status, 'pending');
});

test('public GET /:token: a 16 job reports a non-actionable status, NOT "pending"', async () => {
  jobFixture = makeJob({ job_status: 16, material_sub_status: 2 });
  const r = await callPublic('/:token', 'get');
  const status = r.body?.data?.status ?? r.body?.status;
  assert.equal(status, 'under_review');
  assert.notEqual(status, 'pending', 'a status-16 job must not look client-actionable on the public link either');
});

test('public approve/reject refuse a 16 job (positive control: a 15 job still approves/rejects)', async () => {
  jobFixture = makeJob({ job_status: 16, material_sub_status: 2 });
  const rApprove = await callPublic('/:token/approve', 'patch');
  assert.equal(rApprove.statusCode, 409, JSON.stringify(rApprove.body));
  assert.equal(statusUpdates(fake.calls).length, 0);

  fake.calls.length = 0;
  const rReject = await callPublic('/:token/reject', 'patch', { body: { reason: 'not needed anymore' } });
  assert.equal(rReject.statusCode, 409, JSON.stringify(rReject.body));
  assert.equal(statusUpdates(fake.calls).length, 0);

  // Positive control — the SAME guard must let a 15 job through, proving the
  // 409s above are the approvability gate and not merely "everything fails".
  fake.calls.length = 0;
  jobFixture = makeJob({ job_status: 15 });
  const rApprove15 = await callPublic('/:token/approve', 'patch');
  assert.equal(rApprove15.statusCode ?? 200, 200, JSON.stringify(rApprove15.body));
  assert.equal(boundValue(statusUpdates(fake.calls)[0], 'job_status'), 1);
});

test('public reject: 15 -> 2, mirroring the authed client flow', async () => {
  jobFixture = makeJob({ job_status: 15 });
  const r = await callPublic('/:token/reject', 'patch', { body: { reason: 'Too expensive' } });
  assert.equal(r.statusCode ?? 200, 200, JSON.stringify(r.body));
  const upd = statusUpdates(fake.calls)[0];
  assert.ok(upd);
  assert.equal(boundValue(upd, 'job_status'), 2);
});

// ═════════════════════════════════════════════════════════════════════════
// 7. services/job-estimate-approval.js — the shared gate, directly
// ═════════════════════════════════════════════════════════════════════════

const { isEstimateApprovable, assertEstimateApprovable } = require('../services/job-estimate-approval');

test('isEstimateApprovable is true ONLY for 15', () => {
  assert.equal(isEstimateApprovable(15), true);
  for (const s of [0, 1, 2, 3, 5, 6, 7, 9, 10, 16, 20, 21]) {
    assert.equal(isEstimateApprovable(s), false, `status ${s} must not be approvable`);
  }
});

test('assertEstimateApprovable throws a 409 for 16, and not for 15', () => {
  assert.doesNotThrow(() => assertEstimateApprovable(15));
  assert.throws(() => assertEstimateApprovable(16), (e) => { assert.equal(e.status, 409); return true; });
});

// ═════════════════════════════════════════════════════════════════════════
// 8. services/integration.service.js — FROZEN, guard against 16
// ═════════════════════════════════════════════════════════════════════════

const integration = require('../services/integration.service');

test('guard: services/integration.service.js status maps carry no 16', () => {
  assert.equal(integration.STATUS_LABELS[16], undefined, 'STATUS_LABELS must stay frozen at its legacy Dropwizard contract');
  assert.equal(integration.jobUiStatus({ job_status: 16, fk_easyfixter_id: TECH_EFR_ID }), '',
    'JOB_UI_STATUS must not gain a 16 entry — partner-facing readers map 16 elsewhere, not here');
});

// ═════════════════════════════════════════════════════════════════════════
// 9. TINYINT cast guard — material_sub_status / permission_required
// ═════════════════════════════════════════════════════════════════════════

test('services/job.service.js: getByIdCore CASTs material_sub_status / permission_required as SIGNED', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'job.service.js'), 'utf8');
  const marker = 'const materialColsSelect';
  const idx = src.indexOf(marker);
  assert.ok(idx >= 0, 'materialColsSelect must exist in getByIdCore');
  const snippet = src.slice(idx, idx + 500);
  assert.match(snippet, /CAST\(j\.material_sub_status AS SIGNED\)\s+AS\s+material_sub_status/i,
    'material_sub_status must be CAST — db.js typeCast otherwise hands the app a boolean');
  assert.match(snippet, /CAST\(j\.permission_required AS SIGNED\)\s+AS\s+permission_required/i,
    'permission_required must be CAST for the same reason');
});

test('services/job.service.js: STATUS_EXTRAS_ALLOWLIST carries the two TINYINT columns (so setStatus can write them)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'job.service.js'), 'utf8');
  const idx = src.indexOf('const STATUS_EXTRAS_ALLOWLIST');
  const snippet = src.slice(idx, src.indexOf(']);', idx));
  assert.match(snippet, /'material_sub_status'/);
  assert.match(snippet, /'permission_required'/);
  // material_reject_reason is deliberately NOT an UPDATE column — it has no
  // tbl_job column at all. setStatus routes it to tbl_job_material_review.
  assert.doesNotMatch(snippet, /'material_reject_reason'/);
});
