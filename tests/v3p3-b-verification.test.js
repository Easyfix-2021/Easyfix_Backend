'use strict';
/*
 * EasyFix check → client QC → ledger post (V3 3.6 / 3.8 / 3.11) —
 * services/job-verification.service.js and the client-portal QC routes.
 *
 * WHAT IS AT RISK
 *   - verify() must NOT post money (sheet 14: the wallet comes after client QC)
 *     and must start the QC clock from the client's own window, else the
 *     property, else 24h.
 *   - postAfterQc() posts through the live ledger path (inLedgerTransaction +
 *     postCompletionLedger) with crmUserId = verified_by and the job's checkout
 *     time as the transaction date, NEVER throws, records post_error, and never
 *     posts a revisit (posting is one-shot per job).
 *   - the cron is bounded (200), sequential, and idempotent: a row the client
 *     decided in between is not auto-passed, and only unposted rows are posted.
 *   - the client QC routes use the portal's own scope gate (loadJobInScope).
 *
 * The ledger is stubbed at its module boundary (inLedgerTransaction /
 * postCompletionLedger) — tests/backfill-completion-ledger.test.js and the
 * ledger's own suite own what a post writes; this file owns WHEN and WITH WHAT.
 *
 * MUTATIONS RUN (each turned this file red, then was restored):
 *   MV1 postAfterQc: crmUserId: v.verified_by → null
 *       → "posts through the ledger with the auditor and the checkout date" failed.
 *   MV2 runQcAutoPass: `if (!upd.affectedRows) continue;` removed
 *       → "the cron auto-passes only rows still pending" failed (autoPassed 2).
 *   MV3 postAfterQc: the completed-status (3/5) check removed
 *       → "a revisit is not posted" failed (the ledger was called).
 */
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

process.env.WEBHOOK_OUTBOUND_ENABLED = 'false';

const state = {
  timing: null, verification: null, jobStatus: 3, checkout: '2026-09-20 14:09:00',
  due: [], toPost: [], guardHits: new Set(), dupInsert: false,
};

const fake = installFakePool([
  [/GET_LOCK/i, () => [{ acquired: 1 }]],
  [/RELEASE_LOCK/i, () => [{ released: 1 }]],
  [/FROM tbl_client_qc_timing/i, () => (state.timing ? [state.timing] : [])],
  [/INSERT INTO tbl_job_verification/i, () => {
    if (state.dupInsert) { const e = new Error('dup'); e.code = 'ER_DUP_ENTRY'; throw e; }
    return { affectedRows: 1 };
  }],
  [/FROM tbl_job_verification WHERE job_id = \?/i, () => (state.verification ? [state.verification] : [])],
  [/WHERE qc_status = 'pending' AND qc_due_on <= \?/i, () => state.due],
  [/WHERE qc_status IN \('passed', 'auto'\) AND posted_on IS NULL/i, () => state.toPost],
  [/UPDATE tbl_job_verification SET qc_status = 'auto'/i, (_sql, params) => ({ affectedRows: state.guardHits.has(params[1]) ? 1 : 0 })],
  [/UPDATE tbl_job_verification SET qc_status = \?/i, () => ({ affectedRows: state.verification && state.verification.qc_status === 'pending' ? 1 : 0 })],
  [/^\s*UPDATE tbl_job_verification/i, () => ({ affectedRows: 1 })],
  [/SELECT job_status, checkout_date_time FROM tbl_job WHERE job_id = \? FOR UPDATE/i,
    () => [{ job_status: state.jobStatus, checkout_date_time: state.checkout }]],
]);

const ledger = require('../services/job-ledger.service');
const verification = require('../services/job-verification.service');

const ledgerCalls = [];
let ledgerResult = { posted: true, jobTransaction: true, ledgers: true };
let ledgerThrows = null;
let inFlight = 0;
let maxInFlight = 0;
const realLedger = { inLedgerTransaction: ledger.inLedgerTransaction, postCompletionLedger: ledger.postCompletionLedger };
ledger.inLedgerTransaction = async (fn) => {
  inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    if (ledgerThrows) throw ledgerThrows;
    const conn = await require('../db').pool.getConnection();
    await new Promise((r) => setImmediate(r));
    return await fn(conn);
  } finally { inFlight -= 1; }
};
ledger.postCompletionLedger = async (_conn, args) => { ledgerCalls.push(args); return ledgerResult; };

after(() => { Object.assign(ledger, realLedger); fake.restore(); });

beforeEach(() => {
  Object.assign(state, {
    timing: null, verification: null, jobStatus: 3, checkout: '2026-09-20 14:09:00',
    due: [], toPost: [], guardHits: new Set(), dupInsert: false,
  });
  ledgerCalls.length = 0; ledgerResult = { posted: true, jobTransaction: true, ledgers: true };
  ledgerThrows = null; maxInFlight = 0;
  fake.reset();
});

const calls = (re) => fake.calls.filter((c) => re.test(c.sql));
const NOW = new Date('2026-09-24T06:00:00Z');

test('verify starts the client QC clock from the client window and posts nothing', async () => {
  state.timing = { qc_hours: 48, check_hours: 2 };
  state.verification = { job_id: 42, qc_status: 'pending' };
  const out = await verification.verifyJob({ job_id: 42, job_status: 3, fk_client_id: 5 }, { user_id: 77 }, { now: NOW });
  const [ins] = calls(/INSERT INTO tbl_job_verification/);
  assert.deepEqual(ins.params.slice(0, 3), [42, NOW, 77]);
  assert.equal(ins.params[3].getTime() - NOW.getTime(), 48 * 3600 * 1000);
  assert.match(ins.sql, /'pending'/);
  assert.equal(ledgerCalls.length, 0, 'verify must not post the ledger');
  assert.equal(out.already, false);
  assert.ok(calls(/INSERT INTO tbl_job_logs/).some((c) => c.params.includes('job verified')));
});

test('no client row → property or the 24h default', async () => {
  await verification.verifyJob({ job_id: 42, job_status: 5, fk_client_id: 5 }, { user_id: 77 }, { now: NOW });
  const [ins] = calls(/INSERT INTO tbl_job_verification/);
  assert.equal(ins.params[3].getTime() - NOW.getTime(), 24 * 3600 * 1000);
});

test('only a completed / revisit job is verifiable', async () => {
  await assert.rejects(
    verification.verifyJob({ job_id: 42, job_status: 2, fk_client_id: 5 }, { user_id: 77 }),
    (e) => e.status === 409,
  );
  assert.equal(calls(/INSERT INTO tbl_job_verification/).length, 0);
});

test('a second verify returns the first row (ER_DUP_ENTRY), no second log', async () => {
  state.dupInsert = true;
  state.verification = { job_id: 42, verified_by: 70, qc_status: 'pending' };
  const out = await verification.verifyJob({ job_id: 42, job_status: 3, fk_client_id: 5 }, { user_id: 77 });
  assert.equal(out.already, true);
  assert.equal(out.verifiedBy, 70);
  assert.equal(calls(/INSERT INTO tbl_job_logs/).length, 0);
});

test('posts through the ledger with the auditor and the checkout date', async () => {
  state.verification = { job_id: 42, verified_by: 88, qc_status: 'passed', posted_on: null };
  const out = await verification.postAfterQc(42, { now: NOW });
  assert.equal(out.posted, true);
  assert.equal(ledgerCalls.length, 1);
  assert.equal(ledgerCalls[0].jobId, 42);
  assert.equal(ledgerCalls[0].crmUserId, 88);
  assert.equal(ledgerCalls[0].fromStatus, 3);
  assert.equal(ledgerCalls[0].jobTransactionAt, '2026-09-20 14:09:00');
  const [stamp] = calls(/SET posted_on = \?, post_error = NULL/);
  assert.deepEqual(stamp.params, [NOW, 42]);
  assert.match(stamp.sql, /posted_on IS NULL/);
  assert.ok(calls(/INSERT INTO tbl_job_logs/).some((c) => c.params.includes('ledger posted')));
});

test('an already-posted completion is stamped, not re-posted, and not re-logged', async () => {
  state.verification = { job_id: 42, verified_by: 88, qc_status: 'auto', posted_on: null };
  ledgerResult = { posted: false, jobTransaction: false, ledgers: false, reason: 'technician ledger already has this job' };
  const out = await verification.postAfterQc(42, { now: NOW });
  assert.equal(out.posted, true);
  assert.equal(calls(/SET posted_on = \?/).length, 1);
  assert.equal(calls(/INSERT INTO tbl_job_logs/).length, 0);
});

test('an unpostable job records post_error and does not throw', async () => {
  state.verification = { job_id: 42, verified_by: 88, qc_status: 'passed', posted_on: null };
  ledgerResult = { posted: false, jobTransaction: false, ledgers: false, unpostable: true, reason: 'collected_by is not set' };
  const out = await verification.postAfterQc(42, { now: NOW });
  assert.equal(out.posted, false);
  const [err] = calls(/SET post_error = \?/);
  assert.deepEqual(err.params, ['collected_by is not set', 42]);
  assert.equal(calls(/SET posted_on = \?/).length, 0);
});

test('a ledger failure (LEDGER_BUSY) is recorded, never thrown', async () => {
  state.verification = { job_id: 42, verified_by: 88, qc_status: 'passed', posted_on: null };
  ledgerThrows = Object.assign(new Error('The ledger is busy'), { code: 'LEDGER_BUSY' });
  const out = await verification.postAfterQc(42, { now: NOW });
  assert.equal(out.posted, false);
  assert.equal(calls(/SET post_error = \?/)[0].params[0], 'The ledger is busy');
});

test('a revisit is not posted', async () => {
  state.verification = { job_id: 42, verified_by: 88, qc_status: 'passed', posted_on: null };
  state.jobStatus = 10;
  const out = await verification.postAfterQc(42, { now: NOW });
  assert.equal(out.posted, false);
  assert.equal(ledgerCalls.length, 0);
  assert.match(calls(/SET post_error = \?/)[0].params[0], /status 10/);
});

test('QC not done / already posted → no ledger call', async () => {
  state.verification = { job_id: 42, qc_status: 'pending', posted_on: null };
  assert.equal((await verification.postAfterQc(42)).posted, false);
  state.verification = { job_id: 42, qc_status: 'passed', posted_on: '2026-09-23 10:00:00' };
  assert.equal((await verification.postAfterQc(42)).already, true);
  assert.equal(ledgerCalls.length, 0);
});

test('the cron auto-passes only rows still pending, bounded, one at a time', async () => {
  state.due = [{ job_id: 1 }, { job_id: 2 }];
  state.guardHits = new Set([1]);                     // job 2: the client decided in between
  state.toPost = [{ job_id: 1 }, { job_id: 3 }];
  state.verification = { job_id: 1, verified_by: 88, qc_status: 'auto', posted_on: null };
  const r = await verification.runQcAutoPass({ now: NOW });
  assert.equal(r.due, 2);
  assert.equal(r.autoPassed, 1);
  assert.equal(r.postAttempts, 2);
  assert.equal(maxInFlight, 1, 'posts run sequentially');
  const [dueQ] = calls(/qc_due_on <= \?/);
  assert.deepEqual(dueQ.params, [NOW, 200]);
  const [postQ] = calls(/posted_on IS NULL/);
  assert.equal(postQ.params[0], 200);
  assert.match(calls(/SET qc_status = 'auto'/)[0].sql, /AND qc_status = 'pending'/);
  assert.equal(calls(/INSERT INTO tbl_job_logs/).filter((c) => c.params.includes('client qc')).length, 1);
});

test('the cron says so when the migration has not run', async () => {
  const db = require('../db');
  const orig = db.pool.query;
  db.pool.query = async (sql, p) => {
    if (/qc_due_on <= \?/.test(sql)) { const e = new Error('no table'); e.code = 'ER_NO_SUCH_TABLE'; throw e; }
    return orig(sql, p);
  };
  try {
    const r = await verification.runQcAutoPass({ now: NOW });
    assert.equal(r.skipped, true);
  } finally { db.pool.query = orig; }
});

/* ─── client portal routes ─────────────────────────────────────────────── */

const clientRouter = require('../routes/client/index');
function stackFor(path, method) {
  const layer = clientRouter.stack.find((e) => e.route && e.route.path === path && e.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
  return layer.route.stack.map((s) => s.handle);
}
function res() {
  return {
    statusCode: 200, body: null, locals: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

test('client QC approve: scope-gated, guarded, then posts', async () => {
  const handlers = stackFor('/jobs/:id/qc/approve', 'post');
  const jobGet = require('../services/job.service');
  const origGet = jobGet.getById;
  jobGet.getById = async () => ({ job_id: 42, fk_client_id: 133, reporting_contact_id: 43 });
  state.verification = { job_id: 42, verified_by: 88, qc_status: 'pending', posted_on: null };
  try {
    const r = res();
    await handlers[handlers.length - 1](
      { spoc: { id: 42, client_id: 133 }, access: { allStores: true }, query: {}, params: { id: '42' }, body: {} },
      r, (e) => { throw e; },
    );
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    const [upd] = calls(/UPDATE tbl_job_verification SET qc_status = \?/);
    assert.deepEqual(upd.params.slice(0, 1), ['passed']);
    assert.match(upd.sql, /AND qc_status = 'pending'/);

    // Another client's job is a 404 before anything is written.
    fake.reset();
    jobGet.getById = async () => ({ job_id: 42, fk_client_id: 999, reporting_contact_id: 43 });
    const r2 = res();
    await handlers[handlers.length - 1](
      { spoc: { id: 42, client_id: 133 }, access: { allStores: true }, query: {}, params: { id: '42' }, body: {} },
      r2, (e) => { throw e; },
    );
    assert.equal(r2.statusCode, 404);
    assert.equal(calls(/UPDATE tbl_job_verification/).length, 0);
  } finally { jobGet.getById = origGet; }
});

test('client QC dispute requires a note (validator on the route)', async () => {
  const handlers = stackFor('/jobs/:id/qc/dispute', 'post');
  assert.equal(handlers.length, 2, 'validate + handler');
  const r = res();
  let nextCalled = false;
  await handlers[0]({ body: {}, originalUrl: '/api/client/jobs/42/qc/dispute', method: 'POST', query: {}, params: {} }, r, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(r.statusCode, 400);
});

test('GET /client/qc is bounded and client-scoped', async () => {
  const handlers = stackFor('/qc', 'get');
  const r = res();
  await handlers[0]({ spoc: { id: 42, client_id: 133 }, access: { allStores: true }, query: { limit: '9999' }, params: {} }, r, (e) => { throw e; });
  const [list] = calls(/FROM tbl_job_verification v\s+JOIN tbl_job j/);
  assert.ok(list, 'list query ran');
  assert.ok(list.params.includes(133), 'client id bound');
  assert.ok(list.params.includes(200), 'limit clamped to 200');
});
