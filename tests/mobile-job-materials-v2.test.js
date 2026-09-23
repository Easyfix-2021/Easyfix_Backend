/*
 * Material Request Flow v2 (2026-09-21) — services/mobile-job-estimate.
 * service.js coverage. See
 * docs/superpowers/specs/2026-09-21-material-request-flow-v2-design.md
 * ("Testing", the backend items):
 *
 *   - draft insert -> send -> 16/2 with pre-status stored; send at 15 -> 409;
 *     send with no drafts -> 422; send with body `lines` inserts them
 *     atomically.
 *   - technician delete at review_pending allowed; at approval_pending ->
 *     409; deleting the last sent line at 16 -> pre-status.
 *
 * Uses type='product' lines throughout (itemId only, no materialId) so
 * fixtures don't need the material-master / price-resolver tables that
 * tests/mobile-job-materials.test.js already covers in full — this file is
 * about STATE/LOCK/TRANSITION behaviour, which is identical for both line
 * types (resolveLineForInsert only branches on `type` for pricing, never for
 * the state machine).
 *
 * Runner: `node --test --test-force-exit tests/mobile-job-materials-v2.test.js`.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { installFakePool } = require('./helpers/fake-pool');
const qls = require('../services/quotation-line-state');

const TECH_EFR_ID = 42;
const JOB_ID = 300;

// job_id -> { fk_client_id, fk_easyfixter_id, job_status }
const JOBS = {
  [JOB_ID]: { fk_client_id: 5, fk_easyfixter_id: TECH_EFR_ID, job_status: 2 },
};

let QUOTATIONS;      // [{ id, job_id, type, name, unit, unit_price, client_charge, sent_on, action_on, status, client_status }]
let nextId;
let PRE_STATUS;      // job_id -> stored pre_material_status

function row(over = {}) {
  return {
    id: null, job_id: JOB_ID, type: 'product', name: 'Item', unit: 1, unit_price: 100,
    client_charge: 0, sent_on: null, action_on: null, status: 1, client_status: null,
    ...over,
  };
}

const fake = installFakePool([
  [/SELECT job_id, fk_client_id, fk_easyfixter_id, job_status\s+FROM tbl_job/i, (sql, params) => {
    const j = JOBS[params[0]];
    return j ? [{ job_id: params[0], ...j }] : [];
  }],
  [/SELECT j\.fk_service_catg_id, ci\.state_id/i, () => [{ fk_service_catg_id: 1, state_id: 1 }]],

  [/^\s*INSERT INTO quotation_details/i, (sql, params) => {
    const id = nextId++;
    // Matches insertDraftLine's bound param order exactly:
    // type,name,unit,unit_price,client_charge,easyfxer_id,sent_on,job_id,client_service_id,material_id
    const [type, name, unit, unitPrice, clientCharge, , sentOn, jobId, clientServiceId, materialId] = params;
    QUOTATIONS.push(row({
      id, job_id: jobId, type, name, unit, unit_price: unitPrice, client_charge: clientCharge,
      sent_on: sentOn, client_service_id: clientServiceId, material_id: materialId,
    }));
    return { insertId: id };
  }],

  // sendForApproval's draft lock/count (FOR UPDATE).
  [/^\s*SELECT id FROM quotation_details[\s\S]*sent_on IS NULL[\s\S]*FOR UPDATE/i, (sql, params) =>
    QUOTATIONS.filter((r) => r.job_id === params[0] && r.sent_on == null).map((r) => ({ id: r.id }))],

  // sendForApproval's bulk "mark drafts sent".
  [/^\s*UPDATE quotation_details SET sent_on = \?/i, (sql, params) => {
    const [sentOn, jobId] = params;
    let n = 0;
    for (const r of QUOTATIONS) { if (r.job_id === jobId && r.sent_on == null) { r.sent_on = sentOn; n += 1; } }
    return { affectedRows: n };
  }],

  // deleteQuotationLine's single-line state fetch.
  [/^\s*SELECT id, job_id, sent_on, action_on,\s*CAST\(status AS UNSIGNED\) AS status, CAST\(client_status AS SIGNED\) AS client_status/i,
    (sql, params) => {
      const r = QUOTATIONS.find((x) => x.id === params[0]);
      return r ? [{ id: r.id, job_id: r.job_id, sent_on: r.sent_on, action_on: r.action_on, status: r.status, client_status: r.client_status }] : [];
    }],

  // deleteQuotationLine's DELETE.
  [/^\s*DELETE FROM quotation_details WHERE id = \? AND job_id = \?/i, (sql, params) => {
    const [id, jobId] = params;
    const before_ = QUOTATIONS.length;
    QUOTATIONS = QUOTATIONS.filter((r) => !(r.id === id && r.job_id === jobId));
    return { affectedRows: before_ - QUOTATIONS.length };
  }],

  // deleteAllQuotationLines' bulk DELETE (draft OR review_pending).
  [/^\s*DELETE FROM quotation_details WHERE job_id = \? AND \(/i, (sql, params) => {
    const [jobId] = params;
    const before_ = QUOTATIONS.length;
    QUOTATIONS = QUOTATIONS.filter((r) => !(r.job_id === jobId
      && qls.TECH_EDITABLE_STATES.includes(qls.quotationLineState(r))));
    return { affectedRows: before_ - QUOTATIONS.length };
  }],

  // maybeRevertFromPendingMaterial's review_pending COUNT.
  [/^\s*SELECT COUNT\(\*\) AS n FROM quotation_details[\s\S]*sent_on IS NOT NULL AND[\s\S]*action_on IS NULL\)/i,
    (sql, params) => [{ n: QUOTATIONS.filter((r) => r.job_id === params[0] && qls.quotationLineState(r) === qls.STATE.REVIEW_PENDING).length }]],

  [/^\s*SELECT pre_material_status FROM tbl_job_material_review/i, (sql, params) =>
    (PRE_STATUS[params[0]] != null ? [{ pre_material_status: PRE_STATUS[params[0]] }] : [])],
  [/^\s*INSERT INTO tbl_job_material_review \(job_id, pre_material_status\)/i, (sql, params) => {
    PRE_STATUS[params[0]] = params[1];
    return { affectedRows: 1 };
  }],

  [/^\s*UPDATE tbl_job SET job_status = \?, material_sub_status = NULL/i, () => ({ affectedRows: 1 })],
  [/^\s*UPDATE tbl_job\s+SET approval_sent_on_date_time/i, () => ({ affectedRows: 1 })],
  [/^\s*INSERT INTO tbl_job_image/i, () => ({ affectedRows: 1 })],

  // listQuotationLines — computed `state` via the REAL derivation (this file
  // tests the SERVICE's mapping into the response shape, not the predicate
  // itself — quotation-line-state.test.js owns that).
  [/^\s*SELECT id, type, name, unit, unit_price, material_id, client_service_id,\s*client_charge, approved_charge, sent_on, action_on,/i,
    (sql, params) => QUOTATIONS.filter((r) => r.job_id === params[0]).map((r) => ({
      id: r.id, type: r.type, name: r.name, unit: r.unit, unit_price: r.unit_price,
      material_id: r.material_id ?? null, client_service_id: r.client_service_id ?? null,
      client_charge: r.client_charge, approved_charge: r.approved_charge ?? null,
      sent_on: r.sent_on, action_on: r.action_on, state: qls.quotationLineState(r),
    }))],
]);

const estimateService = require('../services/mobile-job-estimate.service');

beforeEach(() => {
  fake.reset();
  JOBS[JOB_ID] = { fk_client_id: 5, fk_easyfixter_id: TECH_EFR_ID, job_status: 2 };
  QUOTATIONS = []; nextId = 1; PRE_STATUS = {};
});

after(() => fake.restore());

function jobUpdate(calls, re) { return calls.find((c) => re.test(c.sql)); }

// ═════════════════════════════════════════════════════════════════════════
// Job-level write lock (assertTechCanWriteQuotation)
// ═════════════════════════════════════════════════════════════════════════

test('addQuotationLine at 15 -> 409 "Waiting for client approval"', async () => {
  JOBS[JOB_ID].job_status = 15;
  await assert.rejects(
    estimateService.addQuotationLine(JOB_ID, TECH_EFR_ID, { type: 'product', itemId: 1, quantity: 1, amount: 50 }),
    (e) => { assert.equal(e.status, 409); assert.match(e.message, /Waiting for client approval/); return true; },
  );
  assert.equal(QUOTATIONS.length, 0);
});

test('addQuotationLine at a status with no defined transition (e.g. 6 CANCELLED) -> 409 "This material is locked"', async () => {
  JOBS[JOB_ID].job_status = 6;
  await assert.rejects(
    estimateService.addQuotationLine(JOB_ID, TECH_EFR_ID, { type: 'product', itemId: 1, quantity: 1, amount: 50 }),
    (e) => { assert.equal(e.status, 409); assert.match(e.message, /This material is locked/); return true; },
  );
});

test('addQuotationLine allowed from 1, 2, 20 and 16', async () => {
  for (const status of [1, 2, 20, 16]) {
    QUOTATIONS = []; nextId = 1;
    JOBS[JOB_ID].job_status = status;
    const out = await estimateService.addQuotationLine(JOB_ID, TECH_EFR_ID, { type: 'product', itemId: 1, quantity: 1, amount: 50 });
    assert.ok(out.lineId, `status ${status} must allow adding a line`);
    assert.equal(QUOTATIONS[0].sent_on, null, 'a fresh line is always a DRAFT — sent_on NULL');
  }
});

// ═════════════════════════════════════════════════════════════════════════
// Bulk draft add — POST /:id/quotation/draft
// ═════════════════════════════════════════════════════════════════════════

test('addQuotationLines: bulk add creates one draft row per input, in order, one transaction', async () => {
  const out = await estimateService.addQuotationLines(JOB_ID, TECH_EFR_ID, [
    { type: 'product', itemId: 1, quantity: 1, amount: 10 },
    { type: 'product', itemId: 2, quantity: 2, amount: 20 },
  ]);
  assert.equal(out.lineIds.length, 2);
  assert.equal(QUOTATIONS.length, 2);
  assert.ok(QUOTATIONS.every((r) => r.sent_on == null), 'every bulk-added line is a draft');
});

test('addQuotationLines: a job-level lock failure rolls back — zero rows created', async () => {
  JOBS[JOB_ID].job_status = 15;
  await assert.rejects(
    estimateService.addQuotationLines(JOB_ID, TECH_EFR_ID, [{ type: 'product', itemId: 1, quantity: 1, amount: 10 }]),
    (e) => { assert.equal(e.status, 409); return true; },
  );
  assert.equal(QUOTATIONS.length, 0);
});

test('addQuotationLines: an empty array is 422, not a silent no-op', async () => {
  await assert.rejects(
    estimateService.addQuotationLines(JOB_ID, TECH_EFR_ID, []),
    (e) => { assert.equal(e.status, 422); return true; },
  );
});

// ═════════════════════════════════════════════════════════════════════════
// sendForApproval — draft -> send -> 16/2, pre-status stored; 15 -> 409;
// no drafts -> 422; body `lines` inserted atomically first
// ═════════════════════════════════════════════════════════════════════════

test('sendForApproval: no draft at all -> 422 "Add materials before sending for approval", nothing written', async () => {
  await assert.rejects(
    estimateService.sendForApproval(JOB_ID, TECH_EFR_ID, {}),
    (e) => { assert.equal(e.status, 422); assert.match(e.message, /Add materials before sending for approval/); return true; },
  );
  assert.equal(jobUpdate(fake.calls, /approval_sent_on_date_time/i), undefined, 'the job move must never land on a 422');
});

test('sendForApproval: a pre-existing draft -> sent, job moves 2 -> 16/2, pre-status (2) stored', async () => {
  QUOTATIONS.push(row({ id: 1, sent_on: null }));
  const out = await estimateService.sendForApproval(JOB_ID, TECH_EFR_ID, {});
  assert.equal(out.sent, true);
  assert.ok(QUOTATIONS[0].sent_on, 'the draft must now be stamped sent_on');
  assert.equal(PRE_STATUS[JOB_ID], 2, 'the job\'s status BEFORE this call (2) must be stored as pre_material_status');
  const upd = jobUpdate(fake.calls, /approval_sent_on_date_time/i);
  assert.ok(upd);
});

test('sendForApproval: body `lines` are inserted as drafts THEN sent, in the same call', async () => {
  const out = await estimateService.sendForApproval(JOB_ID, TECH_EFR_ID, {
    lines: [{ type: 'product', itemId: 9, quantity: 1, amount: 30 }],
  });
  assert.equal(out.sent, true);
  assert.equal(QUOTATIONS.length, 1);
  assert.ok(QUOTATIONS[0].sent_on, 'a line supplied inline must be sent by the end of the same call, not left draft');
});

test('sendForApproval: already at 16 -> stays 16, pre-status NOT re-stored', async () => {
  JOBS[JOB_ID].job_status = 16;
  PRE_STATUS[JOB_ID] = 20; // a value from an EARLIER round
  QUOTATIONS.push(row({ id: 1, sent_on: null }));
  await estimateService.sendForApproval(JOB_ID, TECH_EFR_ID, {});
  assert.equal(PRE_STATUS[JOB_ID], 20, 'a job already at 16 must not overwrite its stored pre-status');
});

test('sendForApproval at 15 -> 409, nothing written', async () => {
  JOBS[JOB_ID].job_status = 15;
  QUOTATIONS.push(row({ id: 1, sent_on: null }));
  await assert.rejects(
    estimateService.sendForApproval(JOB_ID, TECH_EFR_ID, {}),
    (e) => { assert.equal(e.status, 409); assert.match(e.message, /Waiting for client approval/); return true; },
  );
  assert.equal(QUOTATIONS[0].sent_on, null, 'the pre-existing draft must be untouched');
});

test('materialRequired is a literal alias of sendForApproval — same 422 with no draft', async () => {
  await assert.rejects(
    estimateService.materialRequired(JOB_ID, TECH_EFR_ID),
    (e) => { assert.equal(e.status, 422); return true; },
  );
});

// ═════════════════════════════════════════════════════════════════════════
// Technician delete — review_pending allowed, approval_pending locked,
// last-line revert-to-pre-status
// ═════════════════════════════════════════════════════════════════════════

test('deleteQuotationLine: a draft line is deletable, no job transition', async () => {
  QUOTATIONS.push(row({ id: 1, sent_on: null }));
  const out = await estimateService.deleteQuotationLine(JOB_ID, TECH_EFR_ID, 1);
  assert.equal(out.deleted, true);
  assert.equal(QUOTATIONS.length, 0);
});

test('deleteQuotationLine: a review_pending line is deletable', async () => {
  JOBS[JOB_ID].job_status = 16;
  QUOTATIONS.push(row({ id: 1, sent_on: new Date(), action_on: null }));
  const out = await estimateService.deleteQuotationLine(JOB_ID, TECH_EFR_ID, 1);
  assert.equal(out.deleted, true);
});

test('deleteQuotationLine: an approval_pending line -> 409 "This material is locked", not deleted', async () => {
  JOBS[JOB_ID].job_status = 16; // the job-level gate still passes at 16
  QUOTATIONS.push(row({ id: 1, sent_on: new Date(), action_on: new Date(), status: 1, client_status: null }));
  await assert.rejects(
    estimateService.deleteQuotationLine(JOB_ID, TECH_EFR_ID, 1),
    (e) => { assert.equal(e.status, 409); assert.match(e.message, /This material is locked/); return true; },
  );
  assert.equal(QUOTATIONS.length, 1, 'the approval_pending line must survive');
});

test('deleteQuotationLine: deleting the LAST review_pending line at 16 reverts the job to its pre-status', async () => {
  JOBS[JOB_ID].job_status = 16;
  PRE_STATUS[JOB_ID] = 20; // stored when the job first entered 16
  QUOTATIONS.push(row({ id: 1, sent_on: new Date(), action_on: null }));
  await estimateService.deleteQuotationLine(JOB_ID, TECH_EFR_ID, 1);
  const revert = jobUpdate(fake.calls, /material_sub_status = NULL/i);
  assert.ok(revert, 'the revert-to-pre-status UPDATE must have run');
  assert.equal(revert.params[0], 20, 'must restore the STORED pre-status, not a hardcoded default');
});

test('deleteQuotationLine: deleting ONE of TWO review_pending lines at 16 does NOT revert (one still pending)', async () => {
  JOBS[JOB_ID].job_status = 16;
  QUOTATIONS.push(row({ id: 1, sent_on: new Date(), action_on: null }));
  QUOTATIONS.push(row({ id: 2, sent_on: new Date(), action_on: null }));
  await estimateService.deleteQuotationLine(JOB_ID, TECH_EFR_ID, 1);
  assert.equal(jobUpdate(fake.calls, /material_sub_status = NULL/i), undefined, 'a job with a remaining review_pending line must stay at 16');
  assert.equal(QUOTATIONS.length, 1);
});

test('deleteAllQuotationLines: removes draft + review_pending, leaves an approval_pending line untouched', async () => {
  JOBS[JOB_ID].job_status = 16;
  QUOTATIONS.push(row({ id: 1, sent_on: null }));                                            // draft
  QUOTATIONS.push(row({ id: 2, sent_on: new Date(), action_on: null }));                      // review_pending
  QUOTATIONS.push(row({ id: 3, sent_on: new Date(), action_on: new Date(), status: 1 }));     // approval_pending — untouched
  const out = await estimateService.deleteAllQuotationLines(JOB_ID, TECH_EFR_ID);
  assert.equal(out.deleted, 2);
  assert.deepEqual(QUOTATIONS.map((r) => r.id), [3]);
});

test('deleteAllQuotationLines at 16 with no lines left after: reverts to pre-status (default 2, none stored)', async () => {
  JOBS[JOB_ID].job_status = 16;
  QUOTATIONS.push(row({ id: 1, sent_on: new Date(), action_on: null }));
  await estimateService.deleteAllQuotationLines(JOB_ID, TECH_EFR_ID);
  const revert = jobUpdate(fake.calls, /material_sub_status = NULL/i);
  assert.ok(revert);
  assert.equal(revert.params[0], 2, 'no stored pre-status defaults to 2 (IN_PROGRESS)');
});

// ═════════════════════════════════════════════════════════════════════════
// GET /:id/quotation (listQuotationLines) — each line carries `state`
// ═════════════════════════════════════════════════════════════════════════

test('listQuotationLines: returns each line\'s derived state', async () => {
  QUOTATIONS.push(row({ id: 1, sent_on: null }));
  QUOTATIONS.push(row({ id: 2, sent_on: new Date(), action_on: null }));
  QUOTATIONS.push(row({ id: 3, sent_on: new Date(), action_on: new Date(), status: 0 }));
  const out = await estimateService.listQuotationLines(JOB_ID, TECH_EFR_ID);
  const byId = Object.fromEntries(out.items.map((i) => [i.lineId, i.state]));
  assert.equal(byId[1], 'draft');
  assert.equal(byId[2], 'review_pending');
  assert.equal(byId[3], 'rejected');
});

test('listQuotationLines 404s when the job is not this technician\'s', async () => {
  await assert.rejects(estimateService.listQuotationLines(JOB_ID, 999), (e) => { assert.equal(e.status, 404); return true; });
});

/*
 * MUTATION CHECKS (performed manually, not left in the suite):
 *
 * 1. "deleting the LAST review_pending line reverts" — commented out the
 *    `if (Number(job.job_status) === STATUS_PENDING_FOR_MATERIAL)` guard's
 *    body in deleteQuotationLine (services/mobile-job-estimate.service.js)
 *    so maybeRevertFromPendingMaterial was never called. Re-ran this file:
 *    "deleting the LAST review_pending line at 16 reverts..." went red
 *    (revert UPDATE never ran). Reverted.
 * 2. "sendForApproval: no draft at all -> 422" — changed `draftRows.length
 *    === 0` to `=== 1` in sendForApproval. Re-ran: the 422 test went red
 *    (no throw), AND "a pre-existing draft -> sent" also failed (now
 *    422ing on 1 draft). Reverted.
 * 3. "an approval_pending line -> 409" — changed assertTechLineEditable's
 *    TECH_EDITABLE_STATES check to `true` unconditionally in
 *    quotation-line-state.js's isTechEditable. Re-ran: the 409 test went
 *    red (the line was deleted instead). Reverted.
 */
