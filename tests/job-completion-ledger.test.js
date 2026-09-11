/*
 * THE COMPLETION LEDGER — services/job-ledger.service.js + its hook in
 * services/job.service.js setStatus (2026-09-11).
 *
 * A job entering Completed (3 / 5) through this backend used to post nothing:
 * no tbl_job_transaction row, no technician / EasyFix / client ledger rows, no
 * current_balance move. Legacy posts all of them at the CRM Check Out
 * (sp_ef_checkout_job_and_update_transaction). Pinned here:
 *   1. the rate-card split IS legacy's: golden output of RateCardCalculationsImpl,
 *      compiled unmodified, over every distinct QA fee combination and the clamp
 *      boundaries — with a control proving the fixture catches a wrong formula;
 *   2. the amounts are legacy saveCheckOutJob's (tax, per-unit re-split × qty,
 *      material netting — each row once, not the cumulative double-count);
 *   3. the signs are the SP's collected_by table, and 0 / NULL posts nothing;
 *   4. the SP's two idempotency keys, so neither stack can post a job twice;
 *   5. the lock order and the locking tail reads (the lost-update fix), and the
 *      plain existence reads (the deadlock that FOR UPDATE there would cause);
 *   6. setStatus: one transaction, rollback on a failed post, nothing on 3 ↔ 5,
 *      and a technician actor never lands in a tbl_user FK.
 *
 * Runner: `node --test` (see npm test).
 */
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.WEBHOOK_OUTBOUND_ENABLED = 'false';

const ledger = require('../services/job-ledger.service');

// ── A scripted connection that records transaction control too ─────────

const W = {};
function resetWorld() {
  Object.assign(W, {
    job: { job_id: 42, job_status: 10, fk_easyfixter_id: 7, collected_by: 2, fk_client_id: 5 },
    taxRate: 0,
    minFee: 0,
    lines: [],
    materials: [],
    jt: false,
    jtDup: false,
    efrLedger: false,
    tails: { efr: 100, ef: 1000, client: 50 },
    lockGot: 1,
    failOn: null,
  });
}
resetWorld();

const ROUTES = [
  [/FROM tbl_job WHERE job_id = \? FOR UPDATE/i, () => [W.job]],
  [/FROM tbl_tax_rate/i, () => [{ rate: W.taxRate }]],
  [/tbl_easyfixer_rating_parameters_weightage/i, () => [{ param_weightage: W.minFee }]],
  [/FROM tbl_job_services js/i, () => W.lines],
  [/FROM job_material/i, () => W.materials],
  [/SELECT 1 FROM tbl_job_transaction/i, () => (W.jt ? [{ 1: 1 }] : [])],
  [/INSERT INTO tbl_job_transaction/i, () => {
    if (!W.jtDup) return { insertId: 1 };
    const e = new Error('Duplicate entry'); e.code = 'ER_DUP_ENTRY'; return e;
  }],
  [/SELECT 1 FROM tbl_easyfixer_transaction WHERE job_id/i, () => (W.efrLedger ? [{ 1: 1 }] : [])],
  [/GET_LOCK/i, () => [{ got: W.lockGot }]],
  [/FROM tbl_easyfixer_transaction WHERE easyfixer_id/i, () => [{ balance: W.tails.efr }]],
  [/FROM tbl_easyfix_transaction ORDER BY/i, () => [{ balance: W.tails.ef }]],
  [/FROM tbl_client_transaction WHERE client_id/i, () => [{ balance: W.tails.client }]],
];

function scriptedConn(extraRoutes = []) {
  const calls = [];
  const routes = [...extraRoutes, ...ROUTES];
  return {
    calls,
    async query(sql, params) {
      const text = String(Array.isArray(sql) ? sql[0] : sql);
      calls.push({ sql: text.replace(/\s+/g, ' ').trim(), params });
      if (W.failOn && W.failOn.test(text)) throw new Error('simulated DB failure');
      for (const [re, resp] of routes) {
        if (re.test(text)) {
          const rows = resp(text, params);
          if (rows instanceof Error) throw rows;
          return [rows, []];
        }
      }
      return [[], []];
    },
    beginTransaction: async () => { calls.push({ sql: 'BEGIN' }); },
    commit: async () => { calls.push({ sql: 'COMMIT' }); },
    rollback: async () => { calls.push({ sql: 'ROLLBACK' }); },
    release: () => { calls.push({ sql: 'RELEASE' }); },
  };
}

const find = (conn, re) => conn.calls.filter((c) => re.test(c.sql));
const idx = (conn, re) => conn.calls.findIndex((c) => re.test(c.sql));

// The Node header's own worked example (400, EF 200 + 10%, OH 10 + 20%, client 0):
// technician 118 and EasyFix 282 per unit. Legacy agrees here — no client
// share, nothing clamps.
const CHAIR = { job_service_id: 1, service_id: 900, total_charge: 400, quantity: 3, client_service_id: 900,
  client_fixed: 0, client_variable: 0, easyfix_direct_fixed: 200, easyfix_direct_variable: 10,
  overhead_fixed: 10, overhead_variable: 20 };
const NO_CARD = { job_service_id: 2, service_id: 901, total_charge: 999, quantity: 1, client_service_id: null };

beforeEach(resetWorld);

// ── 1. The split is legacy's ─────────────────────────────────────────

const golden = require(path.join(__dirname, 'fixtures', 'legacy-rate-card-golden.json'));
const asCard = (c) => ({ client_fixed: c[1], client_variable: c[2], easyfix_direct_fixed: c[3],
  easyfix_direct_variable: c[4], overhead_fixed: c[5], overhead_variable: c[6] });

test('the rate-card split matches legacy RateCardCalculationsImpl on every golden case', () => {
  assert.ok(golden.cases.length > 1000, `expected the full golden set, got ${golden.cases.length}`);
  const off = [];
  for (const c of golden.cases) {
    const s = ledger.legacyRateCardShares(c[0], asCard(c), c[7]);
    const d = Math.max(Math.abs(s.client - c[8]), Math.abs(s.easyfix - c[9]), Math.abs(s.easyfixer - c[10]));
    if (d > 1e-6) off.push(`${c.slice(0, 8).join(',')} → got ${s.client},${s.easyfix},${s.easyfixer} want ${c.slice(8).join(',')}`);
  }
  assert.deepEqual(off.slice(0, 5), [], `${off.length} of ${golden.cases.length} cases disagree with legacy`);
});

test('the golden set discriminates — it catches the booking-time cascade, which is a different formula', () => {
  // Positive control. utils/rate-card-calc.js takes the client share out of the
  // technician's residual and has no clamps; if the fixture could not tell it
  // from legacy, the test above would prove nothing.
  const { computeJobServiceCharges } = require('../utils/rate-card-calc');
  let differ = 0;
  for (const c of golden.cases) {
    const r = computeJobServiceCharges({ total_amount: c[0], ...asCard(c) }, 1)._breakdown;
    if (Math.abs(r.easyfixer_share_per_unit - c[10]) > 0.01) differ += 1;
  }
  assert.ok(differ > 100, `only ${differ} cases tell the cascade apart — the golden set is too weak`);
  // And the known agreeing case agrees, so the difference is the formula, not the harness.
  const chair = ledger.legacyRateCardShares(400, CHAIR, 0);
  assert.equal(Math.round(chair.easyfixer * 100) / 100, 118);
  assert.equal(Math.round(chair.easyfix * 100) / 100, 282);
});

// ── 2. The amounts are legacy saveCheckOutJob's ──────────────────────

test('amounts: per-unit re-split × quantity, unpriced lines add nothing, materials net once per row', async () => {
  W.lines = [CHAIR, NO_CARD];
  W.materials = [
    { type: 'Material', tx_charge: 50, client_charge: 80 },
    { type: 'Travel', tx_charge: 20, client_charge: 30 },
    { type: 'travel', tx_charge: 10, client_charge: 15 },     // a SECOND travel row: counted once (legacy double-counts)
    { type: 'Penalty', tx_charge: 5, client_charge: 8 },
    { type: 'Something else', tx_charge: 100, client_charge: 100 }, // unknown types add nothing, as in legacy
  ];
  const a = await ledger.computeCompletionAmounts(scriptedConn(), 42);
  // services: 118 × 3 = 354 technician, 282 × 3 = 846 EasyFix, 0 client.
  // materials: tx = 50 + 20 + 10 − 5 = 75; cx = 80 + 30 + 15 − 8 = 117.
  assert.equal(a.efr, 354 + 75);
  assert.equal(a.ef, 846 + (117 - 75));
  assert.equal(a.client, 0);
  assert.equal(a.tax, 0);
  assert.deepEqual(a.unpriced, [2], 'the line with no rate card is reported, not priced');
});

test('service tax comes off the price before the split, and — as in legacy — is not multiplied by quantity', async () => {
  W.lines = [CHAIR];
  W.taxRate = 18;
  const a = await ledger.computeCompletionAmounts(scriptedConn(), 42);
  // 400 − 72 = 328 → EF conv 232.8, overhead (328 − 232.8) × 0.2 + 10 = 29.04,
  // EasyFix 261.84, technician 66.16 per unit; × 3.
  assert.equal(a.efr, 198.48);
  assert.equal(a.ef, 785.52);
  assert.equal(a.tax, 72, 'saveCheckOutJob adds the per-unit tax once per line');
});

test('the minimum technician fee floors the technician share, exactly as legacy', async () => {
  W.lines = [{ ...CHAIR, quantity: 1, total_charge: 250 }];
  W.minFee = 150;
  const a = await ledger.computeCompletionAmounts(scriptedConn(), 42);
  // EF conv 225 > 250 − 150 → factor1 = 100; overhead min(150 × .2 + 10, 0) = 0.
  assert.equal(a.efr, 150);
  assert.equal(a.ef, 100);
});

// ── 3. The signs ────────────────────────────────────────────────────

test('signs follow the SP collected_by table; anything else posts nothing', () => {
  const amounts = { efr: 100, ef: 30, client: 5 };
  assert.deepEqual(ledger.ledgerMoves(1, amounts), {
    efr: { type: ledger.DEBIT, amount: 35 }, ef: { type: ledger.CREDIT, amount: 30 }, client: { type: ledger.CREDIT, amount: 5 } });
  assert.deepEqual(ledger.ledgerMoves(2, amounts), {
    efr: { type: ledger.CREDIT, amount: 100 }, ef: { type: ledger.CREDIT, amount: 30 }, client: { type: ledger.CREDIT, amount: 5 } });
  assert.deepEqual(ledger.ledgerMoves(3, amounts), {
    efr: { type: ledger.CREDIT, amount: 100 }, ef: { type: ledger.CREDIT, amount: 30 }, client: { type: ledger.DEBIT, amount: 130 } });
  for (const cb of [0, null, undefined, 4, '']) assert.equal(ledger.ledgerMoves(cb, amounts), null, `collected_by ${cb}`);
});

// ── 4. Posting, keys and balances ────────────────────────────────────

const inserted = (conn, table) => find(conn, new RegExp(`INSERT INTO ${table}\\b`, 'i'));

test('a clean completion posts the job row, three ledgers and the balance cache', async () => {
  W.lines = [CHAIR];                                   // efr 354, ef 846, client 0
  const conn = scriptedConn();
  const r = await ledger.postCompletionLedger(conn, { jobId: 42, fromStatus: 10, crmUserId: 12, at: new Date('2026-09-11T10:00:00Z') });
  assert.equal(r.posted, true); assert.equal(r.jobTransaction, true); assert.equal(r.ledgers, true);
  const [jt] = inserted(conn, 'tbl_job_transaction');
  assert.deepEqual(jt.params.slice(0, 6), [42, 1200, 846, 354, 0, 2], 'job row: total, ef, efr, client, collected_by');
  const [efr] = inserted(conn, 'tbl_easyfixer_transaction');
  assert.deepEqual(efr.params.slice(0, 3), [7, 1, 'Job Id : 42'], 'technician, source 1, the legacy description');
  assert.deepEqual([efr.params[3], efr.params[5], efr.params[6], efr.params[7], efr.params[8]], [2, 354, 454, 12, 42],
    'credit 354 onto a 100 tail → 454, created by the CRM user');
  assert.equal(inserted(conn, 'tbl_easyfix_transaction')[0].params[5], 1846, 'EasyFix tail 1000 + 846');
  assert.equal(inserted(conn, 'tbl_client_transaction')[0].params[6], 50, 'client tail 50 + 0');
  const [cache] = find(conn, /UPDATE tbl_easyfixer SET current_balance/i);
  assert.deepEqual(cache.params, [454, 7], 'current_balance becomes the new ledger tail');
});

test('collected_by 1 (technician collected) debits the technician the EasyFix + client shares', async () => {
  W.lines = [CHAIR]; W.job.collected_by = 1;
  const conn = scriptedConn();
  await ledger.postCompletionLedger(conn, { jobId: 42, fromStatus: 10, crmUserId: null });
  const [efr] = inserted(conn, 'tbl_easyfixer_transaction');
  assert.equal(efr.params[3], ledger.DEBIT);
  assert.equal(efr.params[5], 846);
  assert.equal(efr.params[6], 100 - 846);
  assert.equal(efr.params[7], null, 'no CRM user → NULL created_by, never 0 (FK to tbl_user)');
});

test('the SP keys: an existing job row is kept, and an existing technician ledger row stops everything else', async () => {
  W.lines = [CHAIR]; W.jt = true;
  let conn = scriptedConn();
  let r = await ledger.postCompletionLedger(conn, { jobId: 42, fromStatus: 10 });
  assert.equal(inserted(conn, 'tbl_job_transaction').length, 0, 'job row exists: not inserted again');
  assert.equal(r.ledgers, true, 'but the ledgers still post, as the SP does');

  resetWorld(); W.lines = [CHAIR]; W.efrLedger = true;
  conn = scriptedConn();
  r = await ledger.postCompletionLedger(conn, { jobId: 42, fromStatus: 10 });
  assert.equal(r.ledgers, false); assert.equal(r.unpostable, undefined, 'already posted is not unpostable');
  for (const t of ['tbl_easyfixer_transaction', 'tbl_easyfix_transaction', 'tbl_client_transaction']) {
    assert.equal(inserted(conn, t).length, 0, `${t} must not be posted twice`);
  }
  assert.equal(find(conn, /GET_LOCK/i).length, 0, 'nothing to post: no lock taken');
  assert.equal(find(conn, /UPDATE tbl_easyfixer/i).length, 0);
});

test('a concurrent legacy post (duplicate job row) is tolerated, not fatal', async () => {
  W.lines = [CHAIR]; W.jtDup = true;
  const r = await ledger.postCompletionLedger(scriptedConn(), { jobId: 42, fromStatus: 10 });
  assert.equal(r.jobTransaction, false);
  assert.equal(r.ledgers, true);
});

test('unpostable jobs write nothing: no technician, collected_by unset, completed out of CANCELLED', async () => {
  const cases = [
    [{ fk_easyfixter_id: null }, 10, /no technician/],
    [{ collected_by: 0 }, 10, /collected_by/],
    [{ collected_by: null }, 10, /collected_by/],
    [{}, 6, /cancelled/],
  ];
  for (const [patch, from, why] of cases) {
    resetWorld(); W.lines = [CHAIR]; Object.assign(W.job, patch);
    const conn = scriptedConn();
    const r = await ledger.postCompletionLedger(conn, { jobId: 42, fromStatus: from });
    assert.equal(r.unpostable, true, JSON.stringify(patch));
    assert.match(r.reason, why);
    // Anchored: the job row's own `SELECT … FOR UPDATE` is expected and is not a write.
    assert.equal(find(conn, /^(INSERT|UPDATE)\b|GET_LOCK/i).length, 0, `${JSON.stringify(patch)} must not write or lock`);
    assert.equal(find(conn, /FOR UPDATE$/i).length, 1, 'positive control: the job row was read, so the check above had statements to see');
  }
});

test('a busy ledger lock fails the post loudly instead of racing', async () => {
  W.lines = [CHAIR]; W.lockGot = 0;
  await assert.rejects(ledger.postCompletionLedger(scriptedConn(), { jobId: 42, fromStatus: 10 }), (e) => e.status === 503);
});

// ── 5. Locks ────────────────────────────────────────────────────────

test('lock order and read kinds: plain existence reads, then the named lock, then LOCKING tails, balance cache last', async () => {
  W.lines = [CHAIR];
  const conn = scriptedConn();
  await ledger.postCompletionLedger(conn, { jobId: 42, fromStatus: 10 });
  const jobLock = idx(conn, /FROM tbl_job WHERE job_id = \? FOR UPDATE/i);
  const named = idx(conn, /GET_LOCK/i);
  const efrTail = idx(conn, /FROM tbl_easyfixer_transaction WHERE easyfixer_id/i);
  const efTail = idx(conn, /FROM tbl_easyfix_transaction ORDER BY/i);
  const clTail = idx(conn, /FROM tbl_client_transaction WHERE client_id/i);
  const firstInsert = idx(conn, /INSERT INTO tbl_easyfixer_transaction/i);
  const cache = idx(conn, /UPDATE tbl_easyfixer SET/i);
  for (const [n, i] of Object.entries({ jobLock, named, efrTail, efTail, clTail, firstInsert, cache })) assert.ok(i >= 0, `${n} not found`);
  assert.ok(jobLock < named && named < efrTail && efrTail < efTail && efTail < clTail && clTail < firstInsert && firstInsert < cache,
    'job row → named lock → technician / EasyFix / client tails → inserts → technician row (the SP\'s own order)');
  for (const i of [efrTail, efTail, clTail]) {
    assert.match(conn.calls[i].sql, /FOR UPDATE$/i, 'a tail read must be LOCKING, or it answers from a stale snapshot');
  }
  for (const re of [/SELECT 1 FROM tbl_job_transaction/i, /SELECT 1 FROM tbl_easyfixer_transaction WHERE job_id/i]) {
    assert.doesNotMatch(find(conn, re)[0].sql, /FOR UPDATE/i,
      'existence reads stay plain: FOR UPDATE on an absent key gap-locks the index end and deadlocks two completions');
  }
});

// ── 6. setStatus ────────────────────────────────────────────────────

const db = require('../db');
const realPool = { query: db.pool.query, getConnection: db.pool.getConnection };
const PHOTO = /FROM tbl_job_image[\s\S]*image_category/i;
let poolCalls = [];
let txConn = null;

function installPool(meta) {
  poolCalls = [];
  txConn = scriptedConn([[/UPDATE tbl_job SET/i, () => ({ affectedRows: 1 })]]);
  db.pool.query = async (sql, params) => {
    const text = String(Array.isArray(sql) ? sql[0] : sql);
    poolCalls.push({ sql: text.replace(/\s+/g, ' ').trim(), params });
    if (PHOTO.test(text)) return [[{ 1: 1 }], []];
    if (/INFORMATION_SCHEMA/i.test(text)) return [[{ n: 3 }], []];
    if (/FROM\s+tbl_job\s+WHERE\s+job_id/i.test(text)) return [[meta], []];
    return [[], []];
  };
  db.pool.getConnection = async () => txConn;
}
after(() => { db.pool.query = realPool.query; db.pool.getConnection = realPool.getConnection; });

const jobSvc = require('../services/job.service');
const META = { job_id: 42, job_status: 10, fk_easyfixter_id: 7, fk_customer_id: 3, fk_client_id: 5,
  requested_date_time: '2026-09-10 10:00:00', booking_cut_off_time_slot: null, otp: null };
const CRM = { user_id: 12 };
const TECH = { user_id: 55, efr_id: 55 };
const checkoutBy = (sql, params) => {
  // The bound value for fk_checkout_by: count the ? before its assignment.
  const at = sql.search(/fk_checkout_by = COALESCE/);
  return params[(sql.slice(0, at).match(/\?/g) || []).length];
};

test('10 → 3 posts inside ONE transaction: BEGIN, the status UPDATE, the ledger, COMMIT, then the lock and the connection', async () => {
  installPool({ ...META });
  W.lines = [CHAIR];
  await jobSvc.setStatus(42, { status: 3 }, CRM);
  const seq = txConn.calls.map((c) => c.sql);
  const begin = seq.indexOf('BEGIN'); const commit = seq.indexOf('COMMIT');
  const upd = seq.findIndex((s) => /^UPDATE tbl_job SET/i.test(s));
  const post = seq.findIndex((s) => /INSERT INTO tbl_easyfixer_transaction/i.test(s));
  const unlock = seq.findIndex((s) => /RELEASE_LOCK/i.test(s)); const rel = seq.indexOf('RELEASE');
  assert.ok(begin >= 0 && begin < upd && upd < post && post < commit && commit < unlock && unlock < rel,
    `expected BEGIN < UPDATE < ledger < COMMIT < RELEASE_LOCK < RELEASE, got ${JSON.stringify(seq.map((s) => s.slice(0, 40)))}`);
  assert.equal(poolCalls.filter((c) => /^UPDATE tbl_job SET/i.test(c.sql)).length, 0, 'the status write moved onto the transaction');
  const u = txConn.calls[upd];
  assert.equal(checkoutBy(u.sql, u.params), 12, 'a CRM completion stamps its user');
});

test('a failed post rolls the completion back and surfaces the error', async () => {
  installPool({ ...META });
  W.lines = [CHAIR]; W.failOn = /INSERT INTO tbl_easyfix_transaction/i;
  await assert.rejects(jobSvc.setStatus(42, { status: 3 }, CRM), /simulated DB failure/);
  const seq = txConn.calls.map((c) => c.sql);
  assert.ok(seq.includes('ROLLBACK'), 'rolled back');
  assert.ok(!seq.includes('COMMIT'), 'never committed');
  assert.ok(seq.some((s) => /RELEASE_LOCK/i.test(s)) && seq.includes('RELEASE'), 'lock and connection still released');
});

test('an unpostable completion still lands, with nothing posted', async () => {
  installPool({ ...META });
  W.lines = [CHAIR]; W.job.collected_by = 0;
  await jobSvc.setStatus(42, { status: 3 }, CRM);
  const seq = txConn.calls.map((c) => c.sql);
  assert.ok(seq.includes('COMMIT'), 'the status change commits');
  assert.equal(seq.filter((s) => /INSERT INTO tbl_(easyfixer|easyfix|client)_transaction/i.test(s)).length, 0);
});

test('a technician completion never writes an efr id into a tbl_user FK', async () => {
  installPool({ ...META, job_status: 2 });
  W.lines = [CHAIR];
  await jobSvc.setStatus(42, { status: 3 }, TECH);
  const u = txConn.calls.find((c) => /^UPDATE tbl_job SET/i.test(c.sql));
  assert.equal(checkoutBy(u.sql, u.params), null, 'fk_checkout_by: NULL, not efr 55');
  const [efr] = inserted(txConn, 'tbl_easyfixer_transaction');
  assert.equal(efr.params[7], null, 'ledger created_by: NULL, not efr 55');
});

test('moving between 3 and 5 is not a completion: no transaction, no ledger', async () => {
  installPool({ ...META, job_status: 3 });
  await jobSvc.setStatus(42, { status: 5 }, CRM);
  assert.equal(txConn.calls.length, 0, 'no connection was even taken');
  assert.equal(poolCalls.filter((c) => /^UPDATE tbl_job SET/i.test(c.sql)).length, 1, 'the plain status write still happens');
});
