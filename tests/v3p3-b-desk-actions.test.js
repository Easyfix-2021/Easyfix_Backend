'use strict';
/*
 * The ops desk's actions on a technician's claim (V3 3.3 / 3.5 / 3.6):
 *   POST /ops-desk/reports/:id/price | return | resolve
 * and the client-decision hook services/ops-desk.service.js settleAdditionalWork.
 *
 * WHAT IS AT RISK
 *   PRICE must land where the CLIENT'S EXISTING approve flow picks it up — not a
 *   parallel estimate. Concretely: a quotation_details line in quotation-line-
 *   state's `approval_pending` state (the exact set job-estimate-approval.js
 *   stampApprovalPendingLines stamps on approve), and the job at 15 (the only
 *   status GET /client/action-queue lists and isEstimateApprovable accepts).
 *   The assertion runs the INSERTED values through quotationLineState() itself,
 *   so a line that silently became review_pending or draft fails here.
 *   txAmount <= clientAmount at both the route and the service.
 *   A job that already carries a client decision is refused (the approve route
 *   would 409 it forever).
 *   RESOLVE reuses the CRM's cancel (setStatus 6) and reschedule writers.
 *
 * MUTATIONS RUN (each turned this file red, then was restored):
 *   MP1 priceReport: the service-level `txAmount > clientAmount` refusal removed
 *       → "service refuses a share above the price" failed.
 *   MP2 priceReport: the approved/rejected-stamp precondition removed
 *       → "a job the client already decided is refused" failed (200, line inserted).
 *   MP3 priceReport: action_on bound NULL instead of now
 *       → "price lands as an approval_pending line" failed (state review_pending).
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

process.env.WEBHOOK_OUTBOUND_ENABLED = 'false';

const state = { report: null, job: null, actions: ['isJobAppRequestResolve'], scope: undefined };

function reportRow(over = {}) {
  return {
    id: 21, job_id: 42, efr_id: 901, kind: 'additional_work', status: 'open',
    reason_code: null, reason_text: null, client_amount: null, tx_amount: null, ...over,
  };
}
function jobRow(over = {}) {
  return {
    job_id: 42, job_status: 2, fk_client_id: 5, city_id: 11, vertical_id: 3, fk_easyfixter_id: 901,
    fk_customer_id: 3, requested_date_time: '2030-01-01 10:00:00', approved_on_date_time: null,
    approval_reject_date_time: null, otp: null, remarks: null, custom_property: null, ...over,
  };
}

const fake = installFakePool([
  [/INFORMATION_SCHEMA/i, () => [{ n: 3 }]],
  [/FROM tbl_job_tx_report WHERE id = \?/i, () => (state.report ? [state.report] : [])],
  // settleAdditionalWork reads the priced claim first (its id keys the pay-out
  // row and its tx_amount IS the pay-out) — see tests/v3p3-settle-payout.test.js.
  [/SELECT id, tx_amount FROM tbl_job_tx_report/i, () => [{ id: 71, tx_amount: 1000 }]],
  [/INSERT INTO job_material/i, () => ({ affectedRows: 1 })],
  [/^\s*UPDATE tbl_job_tx_report/i, () => ({ affectedRows: 1 })],
  [/INSERT INTO quotation_details/i, () => ({ insertId: 555, affectedRows: 1 })],
  [/WHERE\s+j\.job_id\s*=\s*\?\s*LIMIT\s+1/i, () => (state.job ? [state.job] : [])],
  [/FROM\s+tbl_job\s+WHERE\s+job_id\s*=\s*\?/i, () => (state.job ? [state.job] : [])],
  [/^\s*UPDATE tbl_job\b/i, () => ({ affectedRows: 1 })],
  [/INSERT INTO tbl_job_chat/i, () => ({ insertId: 9, affectedRows: 1 })],
  [/FROM tbl_job_chat WHERE id = \?/i, () => [{ id: 9, sender_kind: 'desk', efr_id: null, user_id: 77, body: 'On it', sent_on: '2026-09-24 10:00:00' }]],
  [/FROM tbl_job_transaction WHERE fk_job_id IN/i, () => [{ job_id: 42, efr_charge: 800 }]],
  [/FROM tbl_job_services js/i, () => [{ job_id: 42, job_service_id: 1, quantity: 2, total_charge: 800, material_charge: 0 }]],
  [/SELECT job_id, type, client_charge FROM job_material/i, () => [{ job_id: 42, type: 'Incentive', client_charge: 250 }]],
]);

const express = require('express');
const deskRouter = require('../routes/admin/ops-desk');
const desk = require('../services/ops-desk.service');
const { quotationLineState, STATE } = require('../services/quotation-line-state');

let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      user_id: 77, manage_clients: '0', manage_cities: '0', manage_states: '0', manage_verticals: '0',
      permissions: { menuIds: [], actionPermissions: state.actions },
    };
    req.userRole = { role_name: 'Admin' };
    req.scope = undefined;
    req.allowedStages = null;
    next();
  });
  app.use('/', deskRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => res.status(500).json({ error: String(err && err.message) }));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { if (server) server.close(); fake.restore(); });

beforeEach(() => {
  state.report = reportRow(); state.job = jobRow(); state.actions = ['isJobAppRequestResolve'];
  fake.reset();
});

async function post(path, body) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const callsLike = (re) => fake.calls.filter((c) => re.test(c.sql));

test('price lands as an approval_pending line and moves the job to 15', async () => {
  const r = await post('/ops-desk/reports/21/price', { clientAmount: 2000, txAmount: 1000, note: 'bent track' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.status, 'priced');

  const [priced] = callsLike(/UPDATE tbl_job_tx_report SET status = 'priced'/);
  assert.ok(priced, 'report moved to priced');
  assert.deepEqual(priced.params, [2000, 1000, 'bent track', 21]);
  assert.match(priced.sql, /AND status = 'open'/, 'guarded on still open');

  const [line] = callsLike(/INSERT INTO quotation_details/);
  assert.ok(line, 'quotation line inserted');
  const cols = line.sql.match(/\(([^)]*)\)\s*VALUES/)[1].split(',').map((c) => c.trim());
  const vals = line.sql.match(/VALUES\s*\(([^)]*)\)/)[1].split(',').map((v) => v.trim());
  let p = 0;
  const row = {};
  cols.forEach((c, i) => { row[c] = vals[i] === '?' ? line.params[p++] : vals[i].replace(/'/g, ''); });
  assert.equal(quotationLineState({ ...row, client_status: null }), STATE.APPROVAL_PENDING,
    'the client approve flow stamps approval_pending lines only');
  assert.equal(row.type, 'material', 'the client estimate preview lists material lines');
  assert.equal(Number(row.approved_charge), 2000);
  assert.equal(Number(row.tx_charge), 1000);
  assert.equal(Number(row.margin), 1000);
  assert.equal(Number(row.job_id), 42);

  const preStatus = callsLike(/INSERT INTO tbl_job_material_review/);
  assert.equal(preStatus.length, 1, 'pre-status stored so a reject can restore it');
  assert.ok(preStatus[0].params.includes(2));
  const move = callsLike(/UPDATE tbl_job SET/).find((c) => c.params.includes(15));
  assert.ok(move, 'job moved to 15 (ESTIMATE_PENDING_APPROVAL)');
});

test('a job already at 15 stays at 15 (one estimate, one decision)', async () => {
  state.job = jobRow({ job_status: 15 });
  const r = await post('/ops-desk/reports/21/price', { clientAmount: 500, txAmount: 200 });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.jobStatus, 15);
  assert.equal(callsLike(/INSERT INTO tbl_job_material_review/).length, 0);
});

test('txAmount above clientAmount is refused at the route, nothing written', async () => {
  const r = await post('/ops-desk/reports/21/price', { clientAmount: 1000, txAmount: 1001 });
  assert.equal(r.status, 400);
  assert.equal(callsLike(/^\s*(INSERT|UPDATE)/i).length, 0);
});

test('service refuses a share above the price', async () => {
  await assert.rejects(
    desk.priceReport({ report: reportRow(), job: jobRow() }, { clientAmount: 100, txAmount: 101 }, { user_id: 77 }),
    (e) => e.status === 400,
  );
  assert.equal(callsLike(/INSERT INTO quotation_details/).length, 0);
});

test('a job the client already decided is refused', async () => {
  state.job = jobRow({ approved_on_date_time: '2026-09-01 10:00:00' });
  const r = await post('/ops-desk/reports/21/price', { clientAmount: 2000, txAmount: 1000 });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'CLIENT_ALREADY_DECIDED');
  assert.equal(callsLike(/INSERT INTO quotation_details/).length, 0);
});

test('a report that is not open is not priced twice', async () => {
  state.report = reportRow({ status: 'priced' });
  const r = await post('/ops-desk/reports/21/price', { clientAmount: 2000, txAmount: 1000 });
  assert.equal(r.status, 409);
  assert.equal(callsLike(/INSERT INTO quotation_details/).length, 0);
});

test('403 without the action key; 404 for a report that does not exist', async () => {
  state.actions = [];
  assert.equal((await post('/ops-desk/reports/21/price', { clientAmount: 2, txAmount: 1 })).status, 403);
  state.actions = ['isJobAppRequestResolve'];
  state.report = null;
  assert.equal((await post('/ops-desk/reports/21/price', { clientAmount: 2, txAmount: 1 })).status, 404);
});

test('return: open additional work only, note required', async () => {
  assert.equal((await post('/ops-desk/reports/21/return', {})).status, 400);
  const r = await post('/ops-desk/reports/21/return', { note: 'Re-shoot the bent track' });
  assert.equal(r.status, 200);
  const [upd] = callsLike(/SET status = 'returned'/);
  assert.deepEqual(upd.params, ['Re-shoot the bent track', 21]);
});

test('resolve help → resolved, and the bench pick-up is logged', async () => {
  state.report = reportRow({ kind: 'help', reason_code: 'gate' });
  const r = await post('/ops-desk/reports/21/resolve', {});
  assert.equal(r.status, 200);
  assert.ok(callsLike(/SET status = 'resolved'/).length === 1);
  const log = callsLike(/INSERT INTO tbl_job_logs/).find((c) => c.params.includes('help picked up'));
  assert.ok(log, 'help picked up logged');
});

test('resolve cant_complete → cancel runs the CRM cancel (setStatus 6)', async () => {
  state.report = reportRow({ kind: 'cant_complete', reason_code: '31' });
  const r = await post('/ops-desk/reports/21/resolve', { outcome: 'cancel' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const cancel = callsLike(/UPDATE tbl_job SET/).find((c) => /cancel_date_time/.test(c.sql));
  assert.ok(cancel, 'setStatus 6 stamped the cancel columns');
  assert.ok(cancel.params.includes(6));
});

test('resolve cant_complete → revisit needs a date and a reason, and claims nothing without them', async () => {
  state.report = reportRow({ kind: 'cant_complete' });
  const r = await post('/ops-desk/reports/21/resolve', { outcome: 'revisit' });
  assert.equal(r.status, 400);
  assert.equal(callsLike(/SET status = 'resolved'/).length, 0);
  const r2 = await post('/ops-desk/reports/21/resolve', { outcome: 'revisit', revisitOn: '2099-01-02 10:00' });
  assert.equal(r2.status, 400, 'reasonId required with revisitOn');
});

test('resolve cant_complete → revisit reschedules through job.reschedule', async () => {
  state.report = reportRow({ kind: 'cant_complete' });
  const r = await post('/ops-desk/reports/21/resolve', { outcome: 'revisit', revisitOn: '2099-01-02 10:00', reasonId: 7 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const moved = callsLike(/UPDATE tbl_job\s+SET requested_date_time/);
  assert.equal(moved.length, 1);
  assert.equal(moved[0].params[0], '2099-01-02 10:00:00');
});

test('additional work is priced or returned, never resolved', async () => {
  const r = await post('/ops-desk/reports/21/resolve', { outcome: 'cancel' });
  assert.equal(r.status, 400);
});

test('settleAdditionalWork: approved flips priced → approved and logs it', async () => {
  const ok = await desk.settleAdditionalWork(42, true, { user_id: 5 });
  assert.equal(ok, true);
  const [upd] = callsLike(/UPDATE tbl_job_tx_report SET status = \?/);
  assert.equal(upd.params[0], 'approved');
  assert.match(upd.sql, /status = 'priced'/);
  assert.equal(callsLike(/INSERT INTO job_material/).length, 1, 'the approval pays his share');
  assert.ok(callsLike(/INSERT INTO tbl_job_logs/).some((c) => c.params.includes('additional work approved')));
  fake.reset();
  await desk.settleAdditionalWork(42, false, null);
  assert.equal(callsLike(/UPDATE tbl_job_tx_report SET status = \?/)[0].params[0], 'resolved');
  assert.equal(callsLike(/INSERT INTO tbl_job_logs/).length, 0, 'a rejection writes no approved row');
  assert.equal(callsLike(/INSERT INTO job_material/).length, 0, 'a rejection pays nothing');
});

/* ─── the /jobs/:id trio and the verification queue ───────────────────── */

async function get(path) {
  const r = await fetch(base + path);
  return { status: r.status, body: await r.json() };
}

test('GET /jobs/:id/money: client = priced lines + job_material, tx = the ledger share', async () => {
  const r = await get('/jobs/42/money');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // 2 x 800 service + 250 visit charge billed; technician posted 800.
  assert.deepEqual(r.body.data, { client: 1850, tx: 800, margin: 1050, txPosted: true });
});

test('POST /jobs/:id/chat writes a desk line as the CRM user', async () => {
  const r = await post('/jobs/42/chat', { body: 'On it' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [ins] = callsLike(/INSERT INTO tbl_job_chat/);
  assert.equal(ins.params[1], 'desk');
  assert.equal(ins.params[3], 77);
  assert.equal((await post('/jobs/42/chat', { body: '' })).status, 400);
});

test('the /jobs/:id trio is gated and scope-checked', async () => {
  state.actions = [];
  assert.equal((await post('/jobs/42/verify', {})).status, 403);
  assert.equal((await get('/jobs/42/chat')).status, 403);
  assert.equal((await get('/jobs/42/money')).status, 403);
  state.actions = ['isJobAppRequestResolve'];
  state.job = null;
  assert.equal((await post('/jobs/42/verify', {})).status, 404);
});

test('GET /verification: oldest-first audit page + claims, bounded', async () => {
  const r = await get('/verification?limit=10&offset=20');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const audit = callsLike(/LEFT JOIN tbl_job_verification v ON v.job_id = j.job_id/).find((c) => /ORDER BY j\.checkout_date_time/.test(c.sql));
  assert.ok(audit, 'audit query ran');
  assert.match(audit.sql, /v\.job_id IS NULL/);
  assert.deepEqual(audit.params.slice(-2), [10, 20]);
  const claims = callsLike(/kind IN \('cant_complete', 'cancel'\)/);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].params[claims[0].params.length - 1], 201, 'claims capped at 200 (+1 to detect truncation)');
  assert.deepEqual(Object.keys(r.body.data).sort(), ['audit', 'claims']);
});

test('resolve a cancel claim as revisit: the ask is rejected and the job rescheduled', async () => {
  state.report = reportRow({ kind: 'cancel', reason_code: '12' });
  state.job = jobRow({ job_status: 1 });
  const r = await post('/ops-desk/reports/21/resolve', { outcome: 'revisit', revisitOn: '2099-01-03 09:00', reasonId: 7 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // The CRM Reject writer clears the ask; since 2026-09-25 (owner, Production
  // 14943e5) the reschedule ALSO clears any cancellation ask, so the clear runs
  // once or twice — what matters is that it ran and the ask ends cleared.
  assert.ok(callsLike(/SET is_cancelled_by_app = 0/).length >= 1, 'the cancellation ask is cleared');
  assert.equal(callsLike(/UPDATE tbl_job\s+SET requested_date_time/).length, 1);
});
