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

  // sendForApproval's one-timestamp-per-send lookup (MAX(sent_on) on the job).
  [/^\s*SELECT MAX\(sent_on\) AS maxSentOn FROM quotation_details WHERE job_id = \?/i,
    (sql, params) => {
      const sentOns = QUOTATIONS.filter((r) => r.job_id === params[0] && r.sent_on != null).map((r) => new Date(r.sent_on).getTime());
      return [{ maxSentOn: sentOns.length ? new Date(Math.max(...sentOns)) : null }];
    }],

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
// Job-level write lock (assertTechCanWriteQuotation / assertTechCanSendForApproval)
// AMENDMENT (owner decision, 2026-09-22): drafting the NEXT quotation is now
// allowed at 15 too — only SEND is refused there, with its own message.
// ═════════════════════════════════════════════════════════════════════════

test('addQuotationLine at 15 is now ALLOWED — drafting the next quotation while the current one is with the client', async () => {
  JOBS[JOB_ID].job_status = 15;
  const out = await estimateService.addQuotationLine(JOB_ID, TECH_EFR_ID, { type: 'product', itemId: 1, quantity: 1, amount: 50 });
  assert.ok(out.lineId);
  assert.equal(QUOTATIONS[0].sent_on, null, 'a fresh line at 15 is still a DRAFT');
});

test('addQuotationLine at a status with no defined transition (e.g. 6 CANCELLED) -> 409 "This material is locked"', async () => {
  JOBS[JOB_ID].job_status = 6;
  await assert.rejects(
    estimateService.addQuotationLine(JOB_ID, TECH_EFR_ID, { type: 'product', itemId: 1, quantity: 1, amount: 50 }),
    (e) => { assert.equal(e.status, 409); assert.match(e.message, /This material is locked/); return true; },
  );
});

test('addQuotationLine allowed from 1, 2, 20, 16 AND 15', async () => {
  for (const status of [1, 2, 20, 16, 15]) {
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
  JOBS[JOB_ID].job_status = 6; // cancelled — genuinely locked (15 is now a valid drafting status)
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

test('sendForApproval at 15 -> 409 with the exact contract message, nothing written', async () => {
  JOBS[JOB_ID].job_status = 15;
  QUOTATIONS.push(row({ id: 1, sent_on: null }));
  await assert.rejects(
    estimateService.sendForApproval(JOB_ID, TECH_EFR_ID, {}),
    (e) => {
      assert.equal(e.status, 409);
      assert.equal(e.message, 'Your previous quotation is with the client — send this one after they decide');
      return true;
    },
  );
  assert.equal(QUOTATIONS[0].sent_on, null, 'the pre-existing draft must be untouched');
});

test('sendForApproval at 16 -> stays 16 (unaffected by the 15 amendment)', async () => {
  JOBS[JOB_ID].job_status = 16;
  QUOTATIONS.push(row({ id: 1, sent_on: null }));
  const out = await estimateService.sendForApproval(JOB_ID, TECH_EFR_ID, {});
  assert.equal(out.sent, true);
  const upd = jobUpdate(fake.calls, /approval_sent_on_date_time/i);
  assert.equal(boundValue(upd, 'job_status'), 16);
});

function boundValue(call, col) {
  const at = call.sql.search(new RegExp(`\\b${col}\\s*=\\s*\\?`));
  const before_ = (call.sql.slice(0, at).match(/\?/g) || []).length;
  return call.params[before_];
}

// ─── One-timestamp-per-send, strictly later (owner decision, 2026-09-22) ──
// A QUOTATION is the set of lines sharing one exact sent_on; two sends must
// never collide onto the same stamp or they would merge into one quotation.

test('sendForApproval: a second send stamps a sent_on strictly LATER than the first send\'s', async () => {
  QUOTATIONS.push(row({ id: 1, sent_on: null }));
  await estimateService.sendForApproval(JOB_ID, TECH_EFR_ID, {});
  const firstSentOn = new Date(QUOTATIONS[0].sent_on).getTime();

  JOBS[JOB_ID].job_status = 16; // sendForApproval left it at 16
  QUOTATIONS.push(row({ id: 2, sent_on: null }));
  await estimateService.sendForApproval(JOB_ID, TECH_EFR_ID, {});
  const secondSentOn = new Date(QUOTATIONS[1].sent_on).getTime();

  assert.ok(secondSentOn > firstSentOn, 'the second send must be strictly later than the first — never equal, never merged');
  assert.notEqual(QUOTATIONS[0].sent_on, QUOTATIONS[1].sent_on, 'the two sends must be two distinct quotations');
});

test('materialRequired is a literal alias of sendForApproval — same 422 with no draft', async () => {
  await assert.rejects(
    estimateService.materialRequired(JOB_ID, TECH_EFR_ID),
    (e) => { assert.equal(e.status, 422); return true; },
  );
});

test('materialRequired at 15 -> 409 with sendForApproval\'s own message (it is a literal alias)', async () => {
  JOBS[JOB_ID].job_status = 15;
  QUOTATIONS.push(row({ id: 1, sent_on: null }));
  await assert.rejects(
    estimateService.materialRequired(JOB_ID, TECH_EFR_ID),
    (e) => { assert.equal(e.status, 409); assert.match(e.message, /send this one after they decide/); return true; },
  );
});

// ═════════════════════════════════════════════════════════════════════════
// Technician delete — AMENDMENT (owner decision, 2026-09-22): ONLY draft is
// tech-editable now. review_pending (sent, not yet reviewed) is locked, same
// as approval_pending — "Save" is for drafts; anything more is a NEW
// quotation. The old "deletes the last review_pending line at 16 reverts to
// pre-status" transition is therefore unreachable from the technician and
// has been removed (CRM Reject Request still reverts, unchanged — see
// tests/material-request-flow-v2-admin.test.js / ops-material-approval).
// ═════════════════════════════════════════════════════════════════════════

test('deleteQuotationLine: a draft line is deletable, no job transition', async () => {
  QUOTATIONS.push(row({ id: 1, sent_on: null }));
  const out = await estimateService.deleteQuotationLine(JOB_ID, TECH_EFR_ID, 1);
  assert.equal(out.deleted, true);
  assert.equal(QUOTATIONS.length, 0);
});

test('deleteQuotationLine: a review_pending line -> 409 "This material is locked", not deleted (2026-09-22: sent lines are locked to the technician)', async () => {
  JOBS[JOB_ID].job_status = 16;
  QUOTATIONS.push(row({ id: 1, sent_on: new Date(), action_on: null }));
  await assert.rejects(
    estimateService.deleteQuotationLine(JOB_ID, TECH_EFR_ID, 1),
    (e) => { assert.equal(e.status, 409); assert.match(e.message, /This material is locked/); return true; },
  );
  assert.equal(QUOTATIONS.length, 1, 'the review_pending line must survive');
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

test('deleteAllQuotationLines: removes ONLY drafts — a review_pending line AND an approval_pending line both survive', async () => {
  JOBS[JOB_ID].job_status = 16;
  QUOTATIONS.push(row({ id: 1, sent_on: null }));                                            // draft — deleted
  QUOTATIONS.push(row({ id: 2, sent_on: new Date(), action_on: null }));                      // review_pending — spared
  QUOTATIONS.push(row({ id: 3, sent_on: new Date(), action_on: new Date(), status: 1 }));     // approval_pending — spared
  const out = await estimateService.deleteAllQuotationLines(JOB_ID, TECH_EFR_ID);
  assert.equal(out.deleted, 1);
  assert.deepEqual(QUOTATIONS.map((r) => r.id).sort(), [2, 3], 'only the draft may be removed by Delete All');
});

test('deleteAllQuotationLines: no revert-to-pre-status UPDATE is ever issued (the transition is unreachable now)', async () => {
  JOBS[JOB_ID].job_status = 16;
  QUOTATIONS.push(row({ id: 1, sent_on: null }));                       // draft
  QUOTATIONS.push(row({ id: 2, sent_on: new Date(), action_on: null })); // review_pending — the only kind left after delete-all
  await estimateService.deleteAllQuotationLines(JOB_ID, TECH_EFR_ID);
  assert.equal(jobUpdate(fake.calls, /material_sub_status = NULL/i), undefined, 'delete-all must never revert the job — it can no longer remove the last review_pending line');
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

// ─── quotationNo (owner decision, 2026-09-22) ───────────────────────────

test('listQuotationLines: two sends number 1 and 2; a draft added after both numbers null', async () => {
  // First quotation.
  QUOTATIONS.push(row({ id: 1, sent_on: null }));
  await estimateService.sendForApproval(JOB_ID, TECH_EFR_ID, {});
  JOBS[JOB_ID].job_status = 16;

  // Second quotation.
  QUOTATIONS.push(row({ id: 2, sent_on: null }));
  await estimateService.sendForApproval(JOB_ID, TECH_EFR_ID, {});

  // The next quotation, still drafting.
  QUOTATIONS.push(row({ id: 3, sent_on: null }));

  const out = await estimateService.listQuotationLines(JOB_ID, TECH_EFR_ID);
  const byId = Object.fromEntries(out.items.map((i) => [i.lineId, i.quotationNo]));
  assert.equal(byId[1], 1, 'the first send is quotation 1');
  assert.equal(byId[2], 2, 'the second send is quotation 2');
  assert.equal(byId[3], null, 'a draft has no quotation number yet');
});

/*
 * MUTATION CHECKS (performed manually, not left in the suite):
 *
 * 1. "sendForApproval: no draft at all -> 422" — changed `draftRows.length
 *    === 0` to `=== 1` in sendForApproval. Re-ran: the 422 test went red
 *    (no throw), AND "a pre-existing draft -> sent" also failed (now
 *    422ing on 1 draft). Reverted.
 * 2. "an approval_pending line -> 409" — changed assertTechLineEditable's
 *    TECH_EDITABLE_STATES check to `true` unconditionally in
 *    quotation-line-state.js's isTechEditable. Re-ran: the 409 test went
 *    red (both the review_pending AND approval_pending "-> 409" tests, and
 *    the delete-all "removes ONLY drafts" test, since a review_pending line
 *    was now deletable too). Reverted.
 * 3. "sendForApproval at 15 -> 409 with the exact contract message" —
 *    removed the `if (s === STATUS_ESTIMATE_PENDING_APPROVAL)` branch from
 *    assertTechCanSendForApproval (services/mobile-job-estimate.service.js),
 *    leaving only the generic assertTechCanWriteQuotation delegation. Re-ran:
 *    the test went red (200 sent instead of 409 — 15 is in
 *    TECH_QUOTATION_WRITE_STATUSES now, so the generic check alone lets it
 *    through). Reverted.
 * 4. "a second send stamps a sent_on strictly LATER than the first" —
 *    changed quotation-line-state.js's nextSentOn to `return now;`
 *    unconditionally (dropping the lastSentOn bump). Re-ran: went red
 *    (secondSentOn === firstSentOn — the fake clock doesn't advance between
 *    the two calls in the same test tick). Reverted.
 * 5. "two sends number 1 and 2; a draft ... numbers null" — changed
 *    quotation-line-state.js's quotationNumbers to start numbering at 0
 *    (`i` instead of `i + 1`). Re-ran: went red (byId[1] === 0, not 1).
 *    Reverted.
 * 6. "deleting the LAST review_pending line reverts" (this transition is
 *    now REMOVED, not merely untested) — reintroduced the old
 *    maybeRevertFromPendingMaterial call at the end of deleteQuotationLine.
 *    Re-ran: "deleteQuotationLine: a review_pending line -> 409 ... not
 *    deleted" still passed as a 409 (assertTechLineEditable throws before
 *    reaching the revert call), confirming the transition is provably
 *    unreachable, not just deleted from the test file. Reverted.
 */
