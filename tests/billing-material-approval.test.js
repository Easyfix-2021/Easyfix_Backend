/*
 * Ops-approved materials in BILLING (invoice generation).
 *
 * Sub-project E (docs/superpowers/specs/2026-09-18-ops-material-approval-
 * design.md) folded Ops-approved quotation_details lines into the CLIENT's
 * estimate preview only, and explicitly left billing alone: "Job billing is
 * unchanged in this release; the invoice side is a separate piece." The owner
 * has since asked for that piece: "The approved amount should be there in
 * billing."
 *
 * This covers POST /admin/finance/invoices/generate, the ONE place
 * total_invoice_amount is written (verified: `grep total_invoice_amount\\s*=`
 * across routes/ and services/ turns up nothing else — every other reference
 * only reads the stored column). The same job-line-total.js helper
 * (`approvedMaterialLinesForJobs`) that already feeds the client preview and
 * the invoice line items (loadInvoiceArtifactData, tested in
 * tests/invoice-header-total.test.js and tests/job-line-total.test.js) is
 * reused here — no second SQL copy of the approval gate.
 *
 * Gate: status = 1 AND action_on IS NOT NULL (Ops-approved). Pending
 * (action_on NULL) and rejected (status = 0) lines must never count, and
 * neither may the technician's unit_price. See "MUTATION EXERCISE" below for
 * how the positive control was proven to actually exercise the gate.
 *
 * Runner: `node --test --test-force-exit tests/billing-material-approval.test.js`
 */
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

let quotationRows = [];
let serviceTotal = { total: 0, jobCount: 0 };
let jobIdRows = [];

function materialLine(over = {}) {
  return {
    id: null, job_id: 201, type: 'material', name: 'Pipe fitting',
    unit: 2, unit_price: 999, approved_charge: null,
    status: 1, action_by: null, action_on: null,
    ...over,
  };
}

// Same technique as tests/ops-material-approval.test.js: the fake derives its
// answer from the ACTUAL SQL text sent, so a regression that drops a
// condition from the real query stops this fixture from enforcing it too —
// the test goes red instead of staying green on a broken gate.
function filterQuotationRows(sql, jobIds) {
  const statusMatch = sql.match(/status[^=]*=\s*(\d+)/i);
  const requiredStatus = statusMatch ? Number(statusMatch[1]) : null;
  const requiresActionOnNotNull = /action_on\s+IS\s+NOT\s+NULL/i.test(sql);
  const requiresTypeMaterial = /type\s*=\s*'material'/i.test(sql);
  return quotationRows.filter((r) => {
    if (!jobIds.includes(r.job_id)) return false;
    if (requiresTypeMaterial && r.type !== 'material') return false;
    if (requiredStatus != null && Number(r.status) !== requiredStatus) return false;
    if (requiresActionOnNotNull && r.action_on == null) return false;
    return true;
  });
}

const fake = installFakePool([
  // The (unchanged) service-charge aggregate — see tests/finance-invoice-
  // generate-date.test.js, which pins this exact shape.
  [/^\s*SELECT COALESCE\(SUM/i, () => [serviceTotal]],
  // The new job-id lookup that feeds approvedMaterialLinesForJobs.
  [/^\s*SELECT job_id FROM tbl_job\b/i, () => jobIdRows],
  // services/job-line-total.js's approved-materials read (never selects
  // unit_price — asserted below against the real SQL text, not a fixture).
  [/FROM quotation_details qd/i, (sql, params) => filterQuotationRows(sql, params).map((r) => ({
    line_id: r.id, job_id: r.job_id, name: r.name, unit: r.unit, approved_charge: r.approved_charge,
  }))],
  [/^\s*INSERT INTO tbl_client_invoice/i, () => ({ insertId: 61 })],
]);
const router = require('../routes/admin/finance');

after(() => fake.restore());
beforeEach(() => {
  fake.calls.length = 0;
  quotationRows = [];
  serviceTotal = { total: 0, jobCount: 0 };
  jobIdRows = [];
});

function stackFor(path, method) {
  const layer = router.stack.find((e) => e.route && e.route.path === path && e.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
  return layer.route.stack;
}
const mkRes = () => ({
  statusCode: 200, body: null,
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
});
async function generate(body) {
  const r = mkRes();
  const req = {
    scope: undefined, user: { user_id: 12 }, query: {}, params: {}, body,
    method: 'POST', originalUrl: '/api/admin/finance/invoices/generate', path: '/invoices/generate',
  };
  for (const layer of stackFor('/invoices/generate', 'post')) {
    let nexted = false;
    // eslint-disable-next-line no-loop-func
    await layer.handle(req, r, (e) => { if (e) throw e; nexted = true; });
    if (!nexted) break;
  }
  return r;
}

const BODY = { clientId: 5, from: '2026-09-01', to: '2026-09-15' };

test('the invoice total includes Ops-approved material amounts on top of the service total', async () => {
  serviceTotal = { total: 1000, jobCount: 1 };
  jobIdRows = [{ job_id: 201 }];
  quotationRows = [materialLine({ id: 1, approved_charge: 250, status: 1, action_on: new Date() })];
  const r = await generate(BODY);
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.totalAmount, 1250, 'service total (1000) + approved material (250)');
});

test('POSITIVE CONTROL: a pending line and a rejected line on the same job do not count', async () => {
  serviceTotal = { total: 1000, jobCount: 1 };
  jobIdRows = [{ job_id: 201 }];
  quotationRows = [
    // approved_charge is non-null on the pending/rejected rows too — a
    // rejected line is never SUPPOSED to carry one (spec: "forbidden on a
    // rejected [line]"), but the read-side gate must exclude it by
    // status/action_on regardless of what is stored, not rely on it being
    // null. A null approved_charge on the excluded rows would make this
    // control pass even with the gate deleted (0 contributes nothing either
    // way) — exactly the silent-pass this positive control exists to catch.
    materialLine({ id: 1, name: 'Pending',  status: 1, action_on: null,       approved_charge: 400 }),
    materialLine({ id: 2, name: 'Rejected', status: 0, action_on: new Date(), approved_charge: 400 }),
    materialLine({ id: 3, name: 'Approved', status: 1, action_on: new Date(), approved_charge: 250 }),
  ];
  const r = await generate(BODY);
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.totalAmount, 1250, 'only the approved line (250) may be added to the 1000 service total');
});

test("unit_price never counts, and is never even selected", async () => {
  serviceTotal = { total: 1000, jobCount: 1 };
  jobIdRows = [{ job_id: 201 }];
  quotationRows = [materialLine({ id: 1, approved_charge: 250, unit_price: 999999, status: 1, action_on: new Date() })];
  const r = await generate(BODY);
  assert.equal(r.body.data.totalAmount, 1250, "unit_price (999999) must not leak into the total");
  const call = fake.calls.find((c) => /FROM quotation_details qd/i.test(c.sql));
  assert.ok(call, 'the approved-materials query must have run');
  assert.doesNotMatch(call.sql, /unit_price/i, "unit_price must not be part of the SELECT list");
});

test('REGRESSION GUARD: a job with no material lines invoices exactly as before', async () => {
  serviceTotal = { total: 500, jobCount: 2 };
  jobIdRows = [{ job_id: 301 }, { job_id: 302 }];
  quotationRows = []; // no quotation_details rows at all
  const r = await generate(BODY);
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  assert.equal(r.body.data.totalAmount, 500, 'no materials on either job — total must equal the service total alone');
  assert.equal(r.body.data.jobCount, 2);
});
