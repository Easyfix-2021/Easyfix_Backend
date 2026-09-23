/*
 * Ops Material Approval — sub-project E of Material Management phase 2.
 * Backend coverage for
 * docs/superpowers/specs/2026-09-18-ops-material-approval-design.md
 * ("Testing"), extending sub-project D's POST /admin/jobs/:id/material-review
 * (tests/pending-for-material.test.js) with the per-line `lines` review.
 *
 * STATUS VALUES — reused from routes/admin/quotations.js PATCH
 * /:id/approve|reject, verified against services/job.service.js's dashboard
 * filters, services/job-export.service.js and mobile-job-estimate.service.js's
 * own `quotation_actioned_on` — NOT the 3-value (0 pending/1 approved/
 * 2 rejected) scheme the design doc's prose describes, which appears nowhere
 * in the codebase (see routes/admin/jobs.js's "STATUS VALUES" comment on the
 * material-review route for the full grep evidence). The real, 2-value
 * scheme this file exercises:
 *   status = 1, action_on NULL      → PENDING  (as inserted by the tech app)
 *   status = 1, action_on stamped   → APPROVED
 *   status = 0, action_on stamped   → REJECTED
 *
 * Covers (spec "Testing", numbered):
 *   1. Approve writes approved_charge/status=1 (approved) and status=0
 *      (rejected) with action_by/action_on, job lands at 15 — one
 *      connection/transaction; a failing line write leaves the job at 16.
 *   2. Missing line / unknown line_id / negative amount / amount on a
 *      rejected line → 422, job stays at 16.
 *   3. Client preview returns ONLY reviewed-approved material lines +
 *      approved_charge — positive control: a pending and a rejected line on
 *      the same job are absent; unit_price appears nowhere in the payload.
 *   4. material_subtotal / grand_total include the approved amounts.
 *   5. A whole-review reject leaves every line untouched (still pending).
 *
 * Plus the task's explicit extra: the technician's unit_price must NEVER
 * appear in a client-facing payload (asserted directly against the SQL text,
 * not just the mapped output — see "never SELECTs unit_price" below).
 *
 * Runner: `node --test --test-force-exit tests/ops-material-approval.test.js`.
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.WEBHOOK_OUTBOUND_ENABLED = 'false';

const { installFakePool } = require('./helpers/fake-pool');

const OPS_USER_ID = 77;
const TECH_EFR_ID = 4242;
const JOB_ID = 700;

function makeJob(over = {}) {
  return {
    job_id: JOB_ID,
    job_status: 16,
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
    material_sub_status: 2,
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

/*
 * In-memory `quotation_details` — the ONE fixture both the admin route's
 * pending-line lookup AND services/job-line-total.js's client-facing read
 * work against, so a test can create a line, review it through the route,
 * and then check what the client would see.
 *
 * Row shape: { id, job_id, type, name, unit, unit_price, approved_charge,
 *              status, action_by, action_on }
 */
let quotationRows = [];
let jobFixture = makeJob();
let permissions = ['isJobMaterialReview'];
let simulateLineWriteFailureFor = null; // a line id, or null

function materialLine(over = {}) {
  return {
    // sent_on defaults to "already sent" — Material Request Flow v2
    // (2026-09-21) narrows "pending" to review_pending (sent_on IS NOT NULL
    // AND action_on IS NULL); a fixture line with sent_on unset would no
    // longer read as pending under the real predicate.
    id: null, job_id: JOB_ID, type: 'material', name: 'Pipe fitting',
    unit: 2, unit_price: 999, approved_charge: null,
    status: 1, action_by: null, action_on: null, sent_on: new Date('2026-09-20T10:00:00Z'),
    ...over,
  };
}

/*
 * The pending-line lookup's fake response is DERIVED from the actual SQL
 * text sent (regex over `sql`, not a hand-copied predicate) — so if the real
 * query in routes/admin/jobs.js ever drops a condition, this fake stops
 * enforcing it too, and any test relying on that condition goes red instead
 * of silently staying green. Same technique for the client-facing read below.
 */
function filterQuotationRows(sql, jobIds) {
  const statusMatch = sql.match(/status[^=]*=\s*(\d+)/i);
  const requiredStatus = statusMatch ? Number(statusMatch[1]) : null;
  const requiresActionOnNotNull = /action_on\s+IS\s+NOT\s+NULL/i.test(sql);
  const requiresActionOnNull = /action_on\s+IS\s+NULL/i.test(sql) && !requiresActionOnNotNull;
  const requiresSentOnNotNull = /sent_on\s+IS\s+NOT\s+NULL/i.test(sql);
  const requiresTypeMaterial = /type\s*=\s*'material'/i.test(sql);
  return quotationRows.filter((r) => {
    if (!jobIds.includes(r.job_id)) return false;
    if (requiresTypeMaterial && r.type !== 'material') return false;
    if (requiredStatus != null && Number(r.status) !== requiredStatus) return false;
    if (requiresActionOnNotNull && r.action_on == null) return false;
    if (requiresActionOnNull && r.action_on != null) return false;
    if (requiresSentOnNotNull && r.sent_on == null) return false;
    return true;
  });
}

const fake = installFakePool([
  [/FROM\s+tbl_job_comment\s+c\b[\s\S]*comment_id\s*=\s*\?/i, () => [{ id: 1, job_id: JOB_ID, comment_on: 1 }]],
  [/FROM tbl_job j\s+LEFT JOIN tbl_customer/i, () => (jobFixture ? [jobFixture] : [])],
  [/SELECT j\.\*/i, () => (jobFixture ? [jobFixture] : [])],
  [/FROM\s+tbl_job\s+WHERE\s+job_id\s*=\s*\?/i, () => (jobFixture ? [jobFixture] : [])],
  [/^\s*UPDATE tbl_job\b/i, () => ({ affectedRows: 1 })],
  [/^\s*INSERT INTO tbl_job_comment/i, () => ({ insertId: 1, affectedRows: 1 })],
  [/^\s*INSERT INTO tbl_job_material_review/i, () => ({ insertId: 1, affectedRows: 1 })],
  [/^\s*INSERT INTO tbl_job_logs/i, () => ({ insertId: 1, affectedRows: 1 })],
  [/INFORMATION_SCHEMA/i, () => [{ n: 3 }]],

  // Admin material-review — pending-line lookup ("SELECT id FROM
  // quotation_details ..."). No alias, distinguishes it from the
  // client-facing read below.
  [/^\s*SELECT id FROM quotation_details/i, (sql, params) => filterQuotationRows(sql, [params[0]]).map((r) => ({ id: r.id }))],

  // Admin material-review — per-line write.
  [/^\s*UPDATE quotation_details\b/i, (sql, params) => {
    const isApprove = /approved_charge/.test(sql);
    const id = isApprove ? params[3] : params[2];
    if (simulateLineWriteFailureFor != null && id === simulateLineWriteFailureFor) {
      throw new Error('simulated line write failure');
    }
    const row = quotationRows.find((r) => r.id === id);
    if (row) {
      // The written status is READ OUT of the actual SQL literal (`SET
      // status = N`), never hardcoded here — otherwise a regression that
      // changes the real literal (e.g. reject writing status=2 instead of
      // the verified 0) would go undetected: this fake would keep applying
      // the OLD, hand-assumed value regardless of what the source now says.
      const statusLiteral = sql.match(/\bstatus\s*=\s*(\d+)/i);
      if (isApprove) {
        [row.approved_charge, row.action_by, row.action_on] = params;
      } else {
        [row.action_by, row.action_on] = params;
      }
      row.status = statusLiteral ? Number(statusLiteral[1]) : null;
    }
    return { affectedRows: row ? 1 : 0 };
  }],

  // services/job-line-total.js — the client-facing read (aliased `qd.*`).
  [/FROM quotation_details qd/i, (sql, params) => filterQuotationRows(sql, params).map((r) => ({
    line_id: r.id, job_id: r.job_id, name: r.name, unit: r.unit, approved_charge: r.approved_charge,
  }))],
  [/FROM tbl_job_services js/i, () => []],

  [/^\s*(SELECT|INSERT|UPDATE)/i, () => []],
]);

after(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  fake.restore();
});

beforeEach(() => {
  fake.calls.length = 0;
  jobFixture = makeJob();
  quotationRows = [];
  permissions = ['isJobMaterialReview'];
  simulateLineWriteFailureFor = null;
});

function boundValue(call, col) {
  const at = call.sql.search(new RegExp(`\\b${col}\\s*=`));
  if (at < 0) return undefined;
  const before = (call.sql.slice(0, at).match(/\?/g) || []).length;
  return call.params[before];
}
function jobUpdates(calls) { return calls.filter((c) => /^\s*UPDATE tbl_job\b/i.test(c.sql)); }
function statusUpdates(calls) { return jobUpdates(calls).filter((c) => /\bjob_status\s*=\s*\?/i.test(c.sql)); }
function quotationUpdates(calls) { return calls.filter((c) => /^\s*UPDATE quotation_details\b/i.test(c.sql)); }

// ═════════════════════════════════════════════════════════════════════════
// Route harness — the REAL routes/admin/jobs.js router mounted, exactly as
// tests/pending-for-material.test.js does it.
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

async function adminPost(body) {
  const res = await fetch(`${adminBaseUrl}/jobs/${JOB_ID}/material-review`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// A spy around pool.getConnection that records beginTransaction / commit /
// rollback calls, so the transaction's SHAPE (not just its final SQL) can be
// asserted — e.g. "rollback ran, commit never did" on a failing line write.
async function withConnSpy(fn) {
  const db = require('../db');
  const orig = db.pool.getConnection;
  const events = [];
  db.pool.getConnection = async () => {
    const conn = await orig();
    // Capture the ORIGINAL bound methods before reassigning — a wrapper that
    // read `conn[name]` at call time would call itself (infinite recursion),
    // since the property is reassigned to the wrapper before it ever runs.
    const originals = {
      beginTransaction: conn.beginTransaction.bind(conn),
      commit: conn.commit.bind(conn),
      rollback: conn.rollback.bind(conn),
    };
    for (const name of Object.keys(originals)) {
      conn[name] = async (...args) => { events.push(name); return originals[name](...args); };
    }
    return conn;
  };
  try {
    await fn();
  } finally {
    db.pool.getConnection = orig;
  }
  return events;
}

// ═════════════════════════════════════════════════════════════════════════
// 1. Approve: writes + job move to 15, one transaction
// ═════════════════════════════════════════════════════════════════════════

test('approve: approved line gets approved_charge/status=1/action stamps, rejected line gets status=0, job -> 15', async () => {
  quotationRows = [
    materialLine({ id: 91, name: 'Pipe', unit: 2 }),
    materialLine({ id: 92, name: 'Tape', unit: 1 }),
  ];
  const events = await withConnSpy(async () => {
    const res = await adminPost({
      decision: 'approve',
      permission_required: 1,
      lines: [
        { line_id: 91, decision: 'approve', approved_amount: 450 },
        { line_id: 92, decision: 'reject' },
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });
  assert.deepEqual(events, ['beginTransaction', 'commit'], 'exactly one begin + one commit, no rollback');

  const approvedRow = quotationRows.find((r) => r.id === 91);
  assert.equal(approvedRow.status, 1);
  assert.equal(approvedRow.approved_charge, 450);
  assert.equal(approvedRow.action_by, OPS_USER_ID);
  assert.ok(approvedRow.action_on, 'action_on must be stamped');

  const rejectedRow = quotationRows.find((r) => r.id === 92);
  assert.equal(rejectedRow.status, 0);
  assert.equal(rejectedRow.approved_charge, null, 'a rejected line is never given an approved_charge');
  assert.ok(rejectedRow.action_on, 'action_on must be stamped on the rejected line too');

  const statusUpd = statusUpdates(fake.calls)[0];
  assert.ok(statusUpd);
  assert.equal(boundValue(statusUpd, 'job_status'), 15);
  assert.equal(boundValue(statusUpd, 'permission_required'), 1);

  // Line writes must land BEFORE the job's status move — the transaction
  // reviews the lines, then promotes the job, never the other way round.
  const qUpdIdx = fake.calls.findIndex((c) => /^\s*UPDATE quotation_details\b/i.test(c.sql));
  const jobUpdIdx = fake.calls.findIndex((c) => c === statusUpd);
  assert.ok(qUpdIdx >= 0 && qUpdIdx < jobUpdIdx, 'quotation_details writes must precede the job_status UPDATE');
});

test('a job with no material lines is still approvable — empty lines array', async () => {
  quotationRows = [];
  const res = await adminPost({ decision: 'approve', permission_required: 0, lines: [] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(quotationUpdates(fake.calls).length, 0);
  assert.equal(boundValue(statusUpdates(fake.calls)[0], 'job_status'), 15);
});

test('a job with no material lines is still approvable — lines omitted entirely', async () => {
  quotationRows = [];
  const res = await adminPost({ decision: 'approve', permission_required: 0 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(boundValue(statusUpdates(fake.calls)[0], 'job_status'), 15);
});

test('TRANSACTION: a failing line write leaves the job at 16 (never reaches setStatus)', async () => {
  quotationRows = [
    materialLine({ id: 91, name: 'Pipe' }),
    materialLine({ id: 92, name: 'Tape' }),
  ];
  simulateLineWriteFailureFor = 92;
  const events = await withConnSpy(async () => {
    const res = await adminPost({
      decision: 'approve',
      lines: [
        { line_id: 91, decision: 'approve', approved_amount: 100 },
        { line_id: 92, decision: 'approve', approved_amount: 200 },
      ],
    });
    assert.equal(res.status, 500, JSON.stringify(res.body));
  });
  assert.deepEqual(events, ['beginTransaction', 'rollback'], 'must roll back, never commit, on a failing line write');
  assert.equal(statusUpdates(fake.calls).length, 0, 'the job must never reach 15 when a line write fails');
});

// ═════════════════════════════════════════════════════════════════════════
// 2. Coverage / amount validation → 422, job stays at 16
// ═════════════════════════════════════════════════════════════════════════

// Material Request Flow v2 (2026-09-21): a missing or an unknown/extra
// line_id is now 409 (the quote changed under the reviewer), not 422 — see
// routes/admin/jobs.js's MATERIAL_LINES_CHANGED_MESSAGE.
test('409: a pending line missing from the review', async () => {
  quotationRows = [materialLine({ id: 91 }), materialLine({ id: 92 })];
  const res = await adminPost({ decision: 'approve', lines: [{ line_id: 91, decision: 'approve', approved_amount: 10 }] });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(res.body?.error ?? '', /reload and review again/i);
  assert.equal(statusUpdates(fake.calls).length, 0);
  assert.equal(quotationUpdates(fake.calls).length, 0, 'nothing may be written before the coverage check passes');
});

test('409: an unknown line_id', async () => {
  quotationRows = [materialLine({ id: 91 })];
  const res = await adminPost({
    decision: 'approve',
    lines: [
      { line_id: 91, decision: 'approve', approved_amount: 10 },
      { line_id: 999, decision: 'reject' },
    ],
  });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(statusUpdates(fake.calls).length, 0);
});

test('422: a duplicate line_id', async () => {
  quotationRows = [materialLine({ id: 91 })];
  const res = await adminPost({
    decision: 'approve',
    lines: [
      { line_id: 91, decision: 'approve', approved_amount: 10 },
      { line_id: 91, decision: 'approve', approved_amount: 20 },
    ],
  });
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.equal(statusUpdates(fake.calls).length, 0);
});

test('422: a negative approved_amount', async () => {
  quotationRows = [materialLine({ id: 91 })];
  const res = await adminPost({ decision: 'approve', lines: [{ line_id: 91, decision: 'approve', approved_amount: -5 }] });
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.equal(statusUpdates(fake.calls).length, 0);
});

test('422: approved_amount missing on an approved line', async () => {
  quotationRows = [materialLine({ id: 91 })];
  const res = await adminPost({ decision: 'approve', lines: [{ line_id: 91, decision: 'approve' }] });
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.equal(statusUpdates(fake.calls).length, 0);
});

test('422: approved_amount present on a rejected line', async () => {
  quotationRows = [materialLine({ id: 91 })];
  const res = await adminPost({ decision: 'approve', lines: [{ line_id: 91, decision: 'reject', approved_amount: 50 }] });
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.equal(statusUpdates(fake.calls).length, 0);
});

test('approved_amount of exactly 0 is accepted (>= 0, not > 0)', async () => {
  quotationRows = [materialLine({ id: 91 })];
  const res = await adminPost({ decision: 'approve', lines: [{ line_id: 91, decision: 'approve', approved_amount: 0 }] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(quotationRows[0].approved_charge, 0);
});

// ═════════════════════════════════════════════════════════════════════════
// 5. Whole-review reject leaves every line untouched
// ═════════════════════════════════════════════════════════════════════════

// Material Request Flow v2 (2026-09-21) — "Reject Request" changed shape:
// every review_pending material line is now REJECTED (status=0, action_on
// stamped) and the job returns to its PRE-status (2, IN_PROGRESS, is the
// default this fixture's tbl_job_material_review lookup falls back to —
// nothing seeds a row, so getPreMaterialStatus's own default applies), NOT
// "stays 16, lines untouched" as sub-project D originally shipped.
test('a whole-review reject marks every review_pending line REJECTED and returns the job to its pre-status', async () => {
  quotationRows = [materialLine({ id: 91 }), materialLine({ id: 92 })];
  const res = await adminPost({ decision: 'reject', reason: 'Quote missing brand' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(quotationRows[0].status, 0, 'line 91 must be rejected');
  assert.ok(quotationRows[0].action_on, 'line 91 must be stamped action_on');
  assert.equal(quotationRows[1].status, 0, 'line 92 must be rejected');
  assert.ok(quotationRows[1].action_on, 'line 92 must be stamped action_on');
  const upd = statusUpdates(fake.calls)[0];
  assert.ok(upd, 'the job status move must have run');
  assert.equal(boundValue(upd, 'job_status'), 2, 'no stored pre-status defaults to 2 (IN_PROGRESS)');
  assert.equal(boundValue(upd, 'material_sub_status'), null);
});

test('a `lines` payload sent alongside a whole-review reject is ignored — every review_pending line is rejected regardless of what `lines` said', async () => {
  quotationRows = [materialLine({ id: 91 })];
  // `lines` asks to APPROVE line 91 with no amount at all — if this were
  // validated as a coverage/content review it would 409 or 422. Since
  // decision is 'reject', `lines` must never reach those checks, and the
  // line must still land REJECTED (not approved, and not left untouched).
  const res = await adminPost({ decision: 'reject', reason: 'anything', lines: [{ line_id: 91, decision: 'approve' }] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(quotationRows[0].status, 0, 'the line is rejected — `lines`\' own "approve" was never consulted');
  assert.equal(quotationRows[0].approved_charge, null, 'a whole-review reject never writes an approved_charge');
});

// ═════════════════════════════════════════════════════════════════════════
// 3 + 4. Client-facing read — services/job-line-total.js
// ═════════════════════════════════════════════════════════════════════════

const { estimateLinesForJob, approvedMaterialLinesForJobs } = require('../services/job-line-total');

test('never SELECTs unit_price — the technician\'s price must not even be fetchable here', async () => {
  quotationRows = [materialLine({ id: 1, status: 1, action_on: new Date(), approved_charge: 300, unit_price: 12345 })];
  await approvedMaterialLinesForJobs([JOB_ID]);
  const call = fake.calls.find((c) => /FROM quotation_details qd/i.test(c.sql));
  assert.ok(call, 'the query must have run');
  assert.doesNotMatch(call.sql, /unit_price/i, 'unit_price must not be part of the SELECT list');
  assert.match(call.sql, /approved_charge/i);
});

test('POSITIVE CONTROL: a pending and a rejected line on the same job are ABSENT from the client read; only the approved one shows', async () => {
  quotationRows = [
    materialLine({ id: 1, name: 'Pending Pipe',  status: 1, action_on: null,        approved_charge: null }),
    materialLine({ id: 2, name: 'Rejected Tape', status: 0, action_on: new Date(),  approved_charge: null }),
    materialLine({ id: 3, name: 'Approved Nut',  status: 1, action_on: new Date(),  approved_charge: 300, unit: 4 }),
  ];
  const { materials } = await estimateLinesForJob(JOB_ID);
  assert.equal(materials.length, 1, `expected exactly the approved line, got ${JSON.stringify(materials)}`);
  assert.equal(materials[0].name, 'Approved Nut');
  assert.equal(materials[0].approved_charge, 300);
  assert.equal(materials[0].unit, 4);
  assert.ok(!('unit_price' in materials[0]), 'unit_price must not appear on a material line object');
  assert.ok(!JSON.stringify(materials).includes('unit_price'));
});

test('material_subtotal and grand_total include the approved material amount', async () => {
  quotationRows = [materialLine({ id: 5, status: 1, action_on: new Date(), approved_charge: 250 })];
  const { totals } = await estimateLinesForJob(JOB_ID);
  assert.equal(totals.material_subtotal, 250);
  assert.equal(totals.grand_total, 250);
});

test('a job with no approved material lines reports empty materials + zero totals, not an error', async () => {
  quotationRows = [materialLine({ id: 6, status: 1, action_on: null })]; // still pending
  const { materials, totals } = await estimateLinesForJob(JOB_ID);
  assert.deepEqual(materials, []);
  assert.equal(totals.material_subtotal, 0);
  assert.equal(totals.grand_total, 0);
});

// ═════════════════════════════════════════════════════════════════════════
// Both client-facing surfaces read the SAME helper (no duplicated SQL)
// ═════════════════════════════════════════════════════════════════════════

test('routes/client/index.js and routes/public/estimate.js both import the shared helper', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  for (const file of ['routes/client/index.js', 'routes/public/estimate.js']) {
    const src = read(file);
    assert.match(src, /require\('\.\.\/\.\.\/services\/job-line-total'\)/, `${file} must import the shared helper`);
    assert.match(src, /materials/, `${file} must surface the materials the helper returns`);
  }
});
