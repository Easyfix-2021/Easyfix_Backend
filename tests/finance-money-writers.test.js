/*
 * The three money writers in routes/admin/finance.js that did not follow the
 * ledger protocol (2026-09-16):
 *
 *   POST /transactions                 — added the amount whatever the type, so
 *                                        every Debit moved the client balance by
 *                                        +amount instead of -amount;
 *   POST /ndm-recharges/:id/approve    — bumped the balance CACHE and wrote no
 *                                        ledger row, behind a guard that could
 *                                        never fire;
 *   POST /easyfixer/:id/recharge       — took the row's balance from the cache
 *                                        and bound the STRING 'ADMIN_RECHARGE'
 *                                        into a tinyint.
 *
 * These drive the real route stacks (so `validate()` runs) against the fake
 * pool. Every case that matters asserts the SQL AND the bound parameters,
 * because a balance that is merely present proves nothing about its sign.
 *
 * Runner: `node --test` (see npm test).
 */
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const S = {
  clientTail: [{ balance: '500.00' }],
  efrTail: [{ balance: '100.00' }],
  recharge: null,
  claimed: 1,          // affectedRows of the conditional UPDATE tbl_ndm_recharge
  techRow: [{ efr_id: 7 }],
};

const fake = installFakePool([
  [/@@SESSION\.innodb_lock_wait_timeout/i, () => [{ wait: 50 }]],
  [/GET_LOCK/i, () => [{ got: 1, acquired: 1 }]],
  [/RELEASE_LOCK/i, () => [{ released: 1 }]],
  [/SELECT efr_cityId FROM tbl_easyfixer/i, () => [{ efr_cityId: 5 }]],
  [/FROM tbl_ndm_recharge r/i, () => (S.recharge ? [S.recharge] : [])],
  [/^\s*UPDATE tbl_ndm_recharge/i, () => ({ affectedRows: S.claimed })],
  [/SELECT efr_id FROM tbl_easyfixer WHERE efr_id = \? FOR UPDATE/i, () => S.techRow],
  [/FROM tbl_easyfixer_transaction WHERE easyfixer_id = \? ORDER BY/i, () => S.efrTail],
  [/FROM tbl_client_transaction WHERE client_id = \? ORDER BY/i, () => S.clientTail],
  [/^\s*INSERT INTO tbl_easyfixer_transaction/i, () => ({ insertId: 91 })],
  [/^\s*INSERT INTO tbl_client_transaction/i, () => ({ insertId: 77 })],
  [/^\s*INSERT INTO tbl_ndm_recharge/i, () => ({ insertId: 55 })],
  [/^\s*UPDATE tbl_easyfixer SET current_balance/i, () => ({ affectedRows: 1 })],
]);

const router = require('../routes/admin/finance');

after(() => fake.restore());
beforeEach(() => {
  fake.reset();
  S.clientTail = [{ balance: '500.00' }];
  S.efrTail = [{ balance: '100.00' }];
  S.recharge = { efr_id: 7, recharge_amount: '500.00', recharge_type: 2, payment_mode: 'ICICI Bank', approved: 0, ndm_name: 'Harendra Kumar' };
  S.claimed = 1;
  S.techRow = [{ efr_id: 7 }];
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

async function call(path, method, body, params = {}) {
  const r = mkRes();
  // scope undefined ⇒ assertEntityInScope passes (lib/scope), so these tests
  // characterise the money statements, not the city scope.
  const req = { scope: undefined, user: { user_id: 12 }, query: {}, params, body,
    method: method.toUpperCase(), originalUrl: `/api/admin/finance${path}`, path };
  for (const layer of stackFor(path, method)) {
    let nexted = false;
    await layer.handle(req, r, (e) => { if (e) throw e; nexted = true; });
    if (!nexted) break;
  }
  return r;
}

const find = (re) => fake.calls.find((c) => re.test(c.sql));
const all = (re) => fake.calls.filter((c) => re.test(c.sql));
const writes = () => fake.calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(c.sql));
const idx = (re) => fake.calls.findIndex((c) => re.test(c.sql));

// ─── POST /transactions — the sign ──────────────────────────────────

test('a client DEBIT lowers the balance, and stores the amount as a magnitude', async () => {
  const r = await call('/transactions', 'post', { clientId: 5, transactionType: 1, amount: 100 });
  assert.equal(r.statusCode, 201);
  const ins = find(/INSERT INTO tbl_client_transaction/i);
  assert.ok(ins, 'the ledger row must be written');
  // (client_id, job_id, source, transaction_type, amount, balance, description, transaction_date, created_date, created_by)
  assert.equal(ins.params[3], 1, 'transaction_type carries the sign');
  assert.equal(ins.params[4], 100, 'amount is the positive magnitude, never negated');
  assert.equal(ins.params[5], 400, 'balance = tail 500 − 100. Was 600 before this fix');
  assert.equal(r.body.data.newBalance, 400);
});

test('a client CREDIT raises it — the control that proves the debit case is the sign, not a broken route', async () => {
  const r = await call('/transactions', 'post', { clientId: 5, transactionType: 2, amount: 100 });
  assert.equal(r.statusCode, 201);
  assert.equal(find(/INSERT INTO tbl_client_transaction/i).params[5], 600);
});

test('only Debit and Credit are accepted, and the amount must be a positive number', async () => {
  for (const body of [
    { clientId: 5, transactionType: 3, amount: 100 },    // the option the CRM used to offer
    { clientId: 5, transactionType: 0, amount: 100 },
    { clientId: 5, transactionType: 1, amount: -100 },   // the operator workaround for a debit
    { clientId: 5, transactionType: 1, amount: 0 },
  ]) {
    fake.reset();
    const r = await call('/transactions', 'post', body);
    assert.equal(r.statusCode, 400, `must be refused: ${JSON.stringify(body)}`);
    assert.deepEqual(writes(), [], 'a refused entry must write nothing');
  }
});

test('the client tail is read under THE ledger lock and the read is locking', async () => {
  await call('/transactions', 'post', { clientId: 5, transactionType: 2, amount: 100 });
  const lock = find(/GET_LOCK/i);
  assert.ok(lock, 'a named lock must be taken');
  assert.equal(lock.params[0], 'easyfix:completion-ledger',
    'the SAME lock a completion takes — a private client_ledger_<id> lock excludes nothing');
  const tail = find(/FROM tbl_client_transaction WHERE client_id = \? ORDER BY/i);
  assert.ok(tail, 'the tail must be read');            // positive control before asserting on it
  assert.match(tail.sql, /FOR UPDATE\s*$/i, 'a plain read answers from a pre-lock snapshot');
  assert.ok(idx(/GET_LOCK/i) < idx(/FROM tbl_client_transaction WHERE client_id = \? ORDER BY/i),
    'lock before the tail read');
  assert.equal(find(/INSERT INTO tbl_client_transaction/i).params[2], 1,
    'source is the integer 1, not the column default 0');
});

test('rounding is done once, in decimal — not left to float drift', async () => {
  S.clientTail = [{ balance: '0.10' }];
  const r = await call('/transactions', 'post', { clientId: 5, transactionType: 2, amount: 0.2 });
  assert.equal(r.body.data.newBalance, 0.3, '0.1 + 0.2 must not be 0.30000000000000004 in a money column');
});

// ─── POST /ndm-recharges/:id/approve ────────────────────────────────

test('approving an NDM recharge posts a ledger row, and the cache follows the ledger tail', async () => {
  const r = await call('/ndm-recharges/:id/approve', 'post', {}, { id: '9' });
  assert.equal(r.statusCode, 200);
  const ins = find(/INSERT INTO tbl_easyfixer_transaction/i);
  assert.ok(ins, 'a ledger row is the whole point — the route used to write none');
  // (easyfixer_id, source, description, transaction_type, transaction_date, amount, balance, created_date, created_by, job_id)
  assert.equal(ins.params[0], 7);
  assert.equal(ins.params[1], 9, "payment_mode 'ICICI Bank' → legacy source code 9");
  assert.equal(ins.params[2], 'Recharge by NDM : Harendra Kumar', "legacy's own description");
  assert.equal(ins.params[3], 2, 'recharge_type 2 = credit');
  assert.equal(ins.params[5], 500);
  assert.equal(ins.params[6], 600, 'balance = technician tail 100 + 500');
  assert.equal(ins.params[9], 0, 'job_id 0, as the legacy SP writes for a non-job entry');
  const cache = find(/UPDATE tbl_easyfixer SET current_balance/i);
  assert.ok(cache && cache.params[0] === 600, 'the cache is set to the new tail, absolutely');
  assert.ok(!/COALESCE\(current_balance/i.test(cache.sql), 'never a relative bump: it preserves drift');
});

test('recharge_type 1 DEBITS, as the legacy SP does', async () => {
  S.recharge.recharge_type = 1;
  await call('/ndm-recharges/:id/approve', 'post', {}, { id: '9' });
  const ins = find(/INSERT INTO tbl_easyfixer_transaction/i);
  assert.equal(ins.params[3], 1);
  assert.equal(ins.params[6], -400, 'tail 100 − 500. The route used to credit whatever the type');
});

test('an unmapped payment mode posts source 0, exactly as legacy does', async () => {
  S.recharge.payment_mode = 'UPI';
  await call('/ndm-recharges/:id/approve', 'post', {}, { id: '9' });
  assert.equal(find(/INSERT INTO tbl_easyfixer_transaction/i).params[1], 0);
  fake.reset();
  S.recharge.payment_mode = 'Cash';
  await call('/ndm-recharges/:id/approve', 'post', {}, { id: '9' });
  assert.equal(find(/INSERT INTO tbl_easyfixer_transaction/i).params[1], 2, "'Cash' → 2");
});

test('the already-approved guard reads a NUMBER, because typeCast hands back a boolean', async () => {
  const read = async () => {
    fake.reset();
    return call('/ndm-recharges/:id/approve', 'post', {}, { id: '9' });
  };
  S.recharge.approved = 1;
  let r = await read();
  assert.equal(r.statusCode, 409);
  assert.deepEqual(writes(), [], 'an approved recharge must not be credited again');
  // The defence is in the SQL: CAST makes the value a number before it ever
  // reaches JS. Without it, db.js returns tinyint(1) as `true`, `true === 1`
  // is false, and the guard is dead code.
  S.recharge.approved = 0;
  await read();
  assert.match(find(/FROM tbl_ndm_recharge r/i).sql, /CAST\(r\.approved_by_finance AS SIGNED\)/i);
});

test('the conditional UPDATE is the idempotency key — two sequential approvals cannot both credit', async () => {
  S.claimed = 0;                     // someone else claimed it first
  const r = await call('/ndm-recharges/:id/approve', 'post', {}, { id: '9' });
  assert.equal(r.statusCode, 409);
  assert.match(find(/UPDATE tbl_ndm_recharge/i).sql, /AND approved_by_finance = 0/,
    'an unconditional UPDATE lets a second approval through');
  assert.equal(find(/INSERT INTO tbl_easyfixer_transaction/i), undefined, 'nothing posted');
});

test('a missing technician refuses the approval rather than crediting an orphan', async () => {
  S.techRow = [];
  // The refusal is thrown with err.status = 409 and reaches the client through
  // the error middleware, so here it surfaces as a rejection, not a response.
  await assert.rejects(
    () => call('/ndm-recharges/:id/approve', 'post', {}, { id: '9' }),
    (e) => e.status === 409 && /orphan credit/.test(e.message),
  );
  assert.equal(find(/INSERT INTO tbl_easyfixer_transaction/i), undefined, 'nothing posted');
});

test('lock order: the recharge row, then the named lock, then the technician row, then the tail', async () => {
  await call('/ndm-recharges/:id/approve', 'post', {}, { id: '9' });
  const order = [
    idx(/UPDATE tbl_ndm_recharge/i),
    idx(/GET_LOCK/i),
    idx(/SELECT efr_id FROM tbl_easyfixer WHERE efr_id = \? FOR UPDATE/i),
    idx(/FROM tbl_easyfixer_transaction WHERE easyfixer_id = \? ORDER BY/i),
    idx(/INSERT INTO tbl_easyfixer_transaction/i),
    idx(/UPDATE tbl_easyfixer SET current_balance/i),
  ];
  assert.ok(order.every((i) => i >= 0), `every step must have run: ${order.join(',')}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), `wrong order: ${order.join(',')}`);
  assert.ok(idx(/RELEASE_LOCK/i) > idx(/INSERT INTO tbl_easyfixer_transaction/i), 'released after the write');
});

test('a new-CRM recharge defaults to CREDIT, and an undefined type is refused', async () => {
  let r = await call('/ndm-recharges', 'post', { efrId: 7, rechargeAmount: 500 });
  assert.equal(r.statusCode, 201);
  assert.equal(find(/INSERT INTO tbl_ndm_recharge/i).params[3], 2,
    'defaulted to 1 (debit) before — so a new-CRM recharge would have debited the technician on approval');
  fake.reset();
  r = await call('/ndm-recharges', 'post', { efrId: 7, rechargeAmount: 500, rechargeType: 3 });
  assert.equal(r.statusCode, 400);
});

// ─── POST /easyfixer/:id/recharge ───────────────────────────────────

test('an admin recharge derives its balance from the ledger tail and binds a NUMERIC source', async () => {
  S.efrTail = [{ balance: '250.00' }];
  const r = await call('/easyfixer/:id/recharge', 'post', { amount: 100, reference: 'NEFT-1' }, { id: '7' });
  assert.equal(r.statusCode, 200);
  const ins = find(/INSERT INTO tbl_easyfixer_transaction/i);
  assert.equal(ins.params[1], 7, 'source 7 = Adjustment. It was the string ADMIN_RECHARGE, stored as 0');
  assert.ok(!ins.params.some((p) => p === 'ADMIN_RECHARGE'), 'no string may reach a tinyint column');
  assert.equal(ins.params[3], 2, 'credit');
  assert.equal(ins.params[6], 350, 'tail 250 + 100 — not the cache after a relative bump');
  assert.equal(find(/UPDATE tbl_easyfixer SET current_balance/i).params[0], 350);
  assert.equal(r.body.data.newBalance, 350);
});

test('an admin recharge for a technician who does not exist is a 404, not a credit', async () => {
  S.techRow = [];
  const r = await call('/easyfixer/:id/recharge', 'post', { amount: 100 }, { id: '7' });
  assert.equal(r.statusCode, 404);
  assert.equal(find(/INSERT INTO tbl_easyfixer_transaction/i), undefined);
});

test('every money write in this file goes through the ledger lock', async () => {
  // Denominator: the three routes above are the only writers of these tables in
  // routes/admin/finance.js (census 2026-09-16). Each must take the lock.
  for (const [path, body, params] of [
    ['/transactions', { clientId: 5, transactionType: 2, amount: 10 }, {}],
    ['/ndm-recharges/:id/approve', {}, { id: '9' }],
    ['/easyfixer/:id/recharge', { amount: 10 }, { id: '7' }],
  ]) {
    fake.reset();
    await call(path, 'post', body, params);
    const locks = all(/GET_LOCK/i);
    assert.equal(locks.length, 1, `${path} must take exactly one named lock`);
    assert.equal(locks[0].params[0], 'easyfix:completion-ledger', `${path} must take THE ledger lock`);
  }
});
