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
    failErrno: null,
    postedAlready: false,
    releaseFails: false,
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
  [/@@SESSION\.innodb_lock_wait_timeout/i, () => [{ wait: 50 }]],
  [/FROM tbl_easyfixer WHERE efr_id = \? FOR UPDATE/i, () => [{ efr_id: 7 }]],
  [/COUNT\(\*\) AS n FROM tbl_job_transaction/i, () => [{ n: W.postedAlready ? 1 : 0 }]],
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
      if (W.releaseFails && /RELEASE_LOCK/i.test(text)) throw new Error('connection was killed');
      if (W.failOn && W.failOn.test(text)) {
        const e = new Error('simulated DB failure');
        if (W.failErrno) { e.errno = W.failErrno; W.failOn = null; }   // retryable: fail once
        throw e;
      }
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
    destroy: () => { calls.push({ sql: 'DESTROY' }); },
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
  assert.equal(cache.params[0], 454, 'current_balance becomes the new ledger tail');
  assert.equal(cache.params[2], 7);
  assert.ok(cache.params[1] instanceof Date, 'balance_updated is stamped, as the SP does');
  assert.match(cache.sql, /balance_updated = \?/);
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

test('a busy ledger lock fails the post loudly, with a message the caller is allowed to see', async () => {
  W.lines = [CHAIR]; W.lockGot = 0;
  // 409, not 5xx: the error handler drops the sentence on anything >= 500, and
  // "the ledger is busy, try again" is exactly what ops need to read.
  await assert.rejects(ledger.postCompletionLedger(scriptedConn(), { jobId: 42, fromStatus: 10 }),
    (e) => e.status === 409 && e.code === 'LEDGER_BUSY');
});

// ── 5. Locks ────────────────────────────────────────────────────────

test('lock order and read kinds: plain existence reads, named lock, TECHNICIAN ROW, then LOCKING tails', async () => {
  W.lines = [CHAIR];
  const conn = scriptedConn();
  await ledger.postCompletionLedger(conn, { jobId: 42, fromStatus: 10 });
  const jobLock = idx(conn, /FROM tbl_job WHERE job_id = \? FOR UPDATE/i);
  const named = idx(conn, /GET_LOCK/i);
  const techRow = idx(conn, /FROM tbl_easyfixer WHERE efr_id = \? FOR UPDATE/i);
  const efrTail = idx(conn, /FROM tbl_easyfixer_transaction WHERE easyfixer_id/i);
  const efTail = idx(conn, /FROM tbl_easyfix_transaction ORDER BY/i);
  const clTail = idx(conn, /FROM tbl_client_transaction WHERE client_id/i);
  const firstInsert = idx(conn, /INSERT INTO tbl_easyfixer_transaction/i);
  const cache = idx(conn, /UPDATE tbl_easyfixer SET/i);
  for (const [n, i] of Object.entries({ jobLock, named, techRow, efrTail, efTail, clTail, firstInsert, cache })) assert.ok(i >= 0, `${n} not found`);
  assert.ok(jobLock < named && named < techRow && techRow < efrTail && efrTail < efTail && efTail < clTail && clTail < firstInsert && firstInsert < cache,
    'job row → named lock → TECHNICIAN ROW → technician / EasyFix / client tails → inserts → balance cache. '
    + 'The technician row precedes the tails because withdrawal pay, admin recharge, NDM approval and a legacy '
    + 'Check Out\'s FK check all take it first; with it last, they hold it while waiting for the tail gap this post holds.');
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
    // setStatus's cancel guard asks the POOL whether this job is posted.
    if (/COUNT\(\*\) AS n FROM tbl_job_transaction/i.test(text)) return [[{ n: W.postedAlready ? 1 : 0 }], []];
    // getById, which setStatus returns (and now hangs the ledger outcome on).
    if (/WHERE\s+j\.job_id\s*=\s*\?\s*LIMIT\s+1/i.test(text)) return [[{ job_id: 42, job_status: 3 }], []];
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

test('a completion that cannot be posted still lands, posts nothing, and TELLS THE CALLER why', async () => {
  /*
   * Not refused: legacy's collected_by gate is in its check-out SCREEN, not its
   * server (the SP posts zero-amount rows instead), and this backend has no
   * screen where ops can set Collected By on a job that is ready to complete.
   * Refusing would block completions with no remedy. So it lands, unposted, and
   * says so — a WARN in a container log is not an answer to a click.
   */
  installPool({ ...META });
  W.lines = [CHAIR]; W.job.collected_by = 0;
  const out = await jobSvc.setStatus(42, { status: 3 }, CRM);
  const seq = txConn.calls.map((c) => c.sql);
  assert.ok(seq.includes('COMMIT'), 'the status change commits');
  assert.equal(seq.filter((s) => /INSERT INTO tbl_(easyfixer|easyfix|client)_transaction/i.test(s)).length, 0, 'no money moved');
  assert.equal(out.ledger.posted, false);
  assert.match(out.ledger.reason, /collected_by/, 'the caller is told which fix unblocks it');
});

test('a posted completion reports what it posted', async () => {
  installPool({ ...META });
  W.lines = [CHAIR];
  const out = await jobSvc.setStatus(42, { status: 3 }, CRM);
  assert.equal(out.ledger.posted, true);
  assert.equal(out.ledger.job_transaction, true);
  assert.equal(out.ledger.amounts.efr, 354);
  assert.equal(out.ledger.balances.efr, 454);
});

test('a CRM move into 3 / 5 posts even when the technician app completed the job first', async () => {
  installPool({ ...META, job_status: 3 });
  W.lines = [CHAIR]; W.job.job_status = 3;
  await jobSvc.setStatus(42, { status: 5 }, CRM);
  assert.equal(inserted(txConn, 'tbl_easyfixer_transaction').length, 1,
    'ops moving 3 → 5 is the moment a technician-completed job gets its ledger');
});

test('a technician-app completion posts nothing, and never writes an efr id into a tbl_user FK', async () => {
  installPool({ ...META, job_status: 2 });
  W.lines = [CHAIR];
  await jobSvc.setStatus(42, { status: 3 }, TECH);
  assert.equal(txConn.calls.length, 0, 'no transaction: legacy posts at the ops Check Out, not at the technician\'s close');
  const u = poolCalls.find((c) => /^UPDATE tbl_job SET/i.test(c.sql));
  assert.equal(checkoutBy(u.sql, u.params), null, 'fk_checkout_by: NULL, not efr 55 (a tbl_user FK)');
});

test('a partner-API completion posts nothing either', async () => {
  installPool({ ...META, job_status: 2 });
  W.lines = [CHAIR];
  await jobSvc.setStatus(42, { status: 3 }, { user_id: null }, { partnerApi: true });
  assert.equal(txConn.calls.length, 0);
  assert.equal(poolCalls.filter((c) => /^UPDATE tbl_job SET/i.test(c.sql)).length, 1, 'the status still changes');
});

test('a posted completion cannot be cancelled here — nothing in this backend reverses a posting', async () => {
  installPool({ ...META, job_status: 3 });
  W.postedAlready = true;
  const guardSaw = () => poolCalls.filter((c) => /COUNT\(\*\) AS n FROM tbl_job_transaction/i.test(c.sql)).length;
  await assert.rejects(jobSvc.setStatus(42, { status: 6 }, CRM),
    (e) => e.status === 409 && e.code === 'COMPLETION_POSTED' && /legacy CRM/.test(e.message),
    `the guard ran ${guardSaw()} time(s); pool saw: ${poolCalls.map((c) => c.sql.slice(0, 50)).join(' | ')}`);
  assert.equal(guardSaw(), 1, 'positive control: the guard asked whether the job is posted');
  assert.equal(poolCalls.filter((c) => /^UPDATE tbl_job SET/i.test(c.sql)).length, 0, 'refused before the write');

  installPool({ ...META, job_status: 3 });
  W.postedAlready = false;
  await jobSvc.setStatus(42, { status: 6 }, CRM);           // unposted: cancelling is still allowed
  assert.ok(poolCalls.some((c) => /^UPDATE tbl_job SET/i.test(c.sql)), 'the cancellation writes');
});

// ── 7. The transaction wrapper ──────────────────────────────────────

test('a deadlock is retried once; a second one becomes LEDGER_BUSY, never a 500', async () => {
  installPool({ ...META });
  W.lines = [CHAIR]; W.failOn = /INSERT INTO tbl_easyfix_transaction/i; W.failErrno = 1213;  // clears itself: fails once
  await jobSvc.setStatus(42, { status: 3 }, CRM);
  assert.ok(txConn.calls.map((c) => c.sql).includes('COMMIT'), 'the retry committed');

  installPool({ ...META });
  W.lines = [CHAIR];
  const always = new Error('deadlock'); always.errno = 1213;
  await assert.rejects(
    ledger.inLedgerTransaction(() => { throw always; }, { db: { getConnection: async () => txConn } }),
    (e) => e.status === 409 && e.code === 'LEDGER_BUSY',
  );
  assert.equal(txConn.calls.filter((c) => c.sql === 'ROLLBACK').length, 2, 'two attempts, both rolled back');
});

test('row-lock waits are bounded below the named-lock timeout and the session is restored', async () => {
  installPool({ ...META });
  W.lines = [CHAIR];
  await jobSvc.setStatus(42, { status: 3 }, CRM);
  const sets = txConn.calls.filter((c) => /SET SESSION innodb_lock_wait_timeout/i.test(c.sql));
  assert.deepEqual(sets.map((c) => c.params[0]), [5, 50],
    'bounded to 5s inside the post, then put back — pooled connections are not reset on release');
  assert.ok(txConn.calls.map((c) => c.sql).indexOf('COMMIT') < txConn.calls.findIndex((c) => /RELEASE_LOCK/i.test(c.sql)),
    'the named lock outlives the commit, or another writer could read the tail before these rows are visible');
});

test('a connection whose lock release fails is destroyed, not handed back to the pool', async () => {
  installPool({ ...META });
  W.lines = [CHAIR]; W.releaseFails = true;
  await jobSvc.setStatus(42, { status: 3 }, CRM);
  const seq = txConn.calls.map((c) => c.sql);
  assert.ok(seq.includes('DESTROY') && !seq.includes('RELEASE'),
    'GET_LOCK is re-entrant per session: a pooled connection still holding it would block every other completion');
});
