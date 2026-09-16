/*
 * Payout approval guards (2026-09-16).
 *
 * `sp_ef_approve_payout_by_finance` is the only money-writing stored procedure
 * this backend calls: it stamps is_approved_by_fin = 2, INSERTs a DEBIT into
 * tbl_easyfixer_transaction and overwrites tbl_easyfixer.current_balance — and
 * it has NO guard of its own. The routes had none either, so:
 *
 *   - the technician came from the REQUEST BODY, was passed to the SP and was
 *     also the only thing the scope check looked at, so a caller could have
 *     any technician they had scope over debited for someone else's payout;
 *   - nothing checked the payout's state, so a retry or a double click posted
 *     a second debit. Four payouts on QA carry exactly that (₹59,892), and two
 *     were rejected AFTER being paid.
 *
 * The technician now comes from the row and each route names the states it may
 * act from. Amount rules are deliberately unchanged (owner's call).
 *
 * Runner: `node --test` (see npm test).
 */
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const S = { status: 1, payoutRow: true, scope: [{ efr_cityId: 5 }] };

const fake = installFakePool([
  [/GET_LOCK/i, () => [{ acquired: 1, got: 1 }]],
  [/RELEASE_LOCK/i, () => [{ released: 1 }]],
  [/FROM tbl_service_payout WHERE payout_id/i, () => (S.payoutRow ? [{ efr_id: 7, status: S.status }] : [])],
  [/SELECT efr_cityId FROM tbl_easyfixer/i, () => S.scope],
  [/^\s*UPDATE tbl_service_payout/i, () => ({ affectedRows: 1 })],
  [/CALL sp_ef_approve_payout/i, () => []],
]);

const router = require('../routes/admin/finance');

after(() => fake.restore());
beforeEach(() => { fake.reset(); S.status = 1; S.payoutRow = true; S.scope = [{ efr_cityId: 5 }]; });

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

test('finance approval debits the technician named by the PAYOUT ROW, not by the caller', async () => {
  const r = await call('/payouts/:id/fin-approve', 'post', { efrId: 999, finApprovedAmount: 500 }, { id: '55' });
  assert.equal(r.statusCode, 200);
  const sp = find(/CALL sp_ef_approve_payout_by_finance/i);
  assert.ok(sp, 'the SP must be called');                     // positive control
  assert.equal(sp.params[0], 55);
  assert.equal(sp.params[1], 7, 'the row owns the technician — 999 from the body must be ignored');
});

test('an already-PAID payout cannot be finance-approved again — the double-debit door', async () => {
  S.status = 2;
  const r = await call('/payouts/:id/fin-approve', 'post', { finApprovedAmount: 500 }, { id: '55' });
  assert.equal(r.statusCode, 409);
  assert.match(r.body.error, /already paid/);
  assert.equal(find(/CALL sp_ef_approve_payout_by_finance/i), undefined, 'no second debit');
});

test('a payout still only RAISED cannot skip ops approval', async () => {
  S.status = 0;
  const r = await call('/payouts/:id/fin-approve', 'post', { finApprovedAmount: 500 }, { id: '55' });
  assert.equal(r.statusCode, 409);
  assert.equal(find(/CALL sp_ef_approve_payout_by_finance/i), undefined);
});

test('the state is read as a NUMBER — tinyint(1) would arrive as a boolean and make 2 and 3 both false', async () => {
  await call('/payouts/:id/fin-approve', 'post', { finApprovedAmount: 500 }, { id: '55' });
  const read = find(/FROM tbl_service_payout WHERE payout_id/i);
  assert.ok(read, 'the gate must read the row');
  assert.match(read.sql, /CAST\(is_approved_by_fin AS SIGNED\)/i);
});

test('an out-of-scope payout is a 404 and discloses nothing about its state', async () => {
  S.status = 2;                 // would be a 409 if the gate checked state first
  S.scope = [];                 // efr not found for this caller's scope
  const r = await call('/payouts/:id/fin-approve', 'post', { finApprovedAmount: 500 }, { id: '55' });
  assert.equal(r.statusCode, 404);
  assert.equal(r.body.error, 'payout not found');
  assert.equal(find(/CALL sp_ef_approve_payout_by_finance/i), undefined);
});

test('a missing payout is a 404', async () => {
  S.payoutRow = false;
  const r = await call('/payouts/:id/fin-approve', 'post', { finApprovedAmount: 500 }, { id: '55' });
  assert.equal(r.statusCode, 404);
});

test('the check and the CALL are serialised by a PER-PAYOUT named lock', async () => {
  await call('/payouts/:id/fin-approve', 'post', { finApprovedAmount: 500 }, { id: '55' });
  const lock = find(/GET_LOCK/i);
  assert.ok(lock, 'a lock must be taken');
  assert.equal(lock.params[0], 'payout_55',
    'per payout, not global: a FOR UPDATE could not hold — the SP\'s own START TRANSACTION implicitly commits');
  const order = ['GET_LOCK', 'FROM tbl_service_payout WHERE payout_id', 'CALL sp_ef_approve_payout_by_finance', 'RELEASE_LOCK']
    .map((re) => fake.calls.findIndex((c) => new RegExp(re, 'i').test(c.sql)));
  assert.ok(order.every((i) => i >= 0), `every step must run: ${order.join(',')}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), `wrong order: ${order.join(',')}`);
});

test('a PAID payout can no longer be rejected, and a rejection uses the row\'s technician', async () => {
  S.status = 2;
  let r = await call('/payouts/:id/fin-reject', 'post', {}, { id: '55' });
  assert.equal(r.statusCode, 409);
  assert.equal(find(/UPDATE tbl_service_payout/i), undefined, 'the debit would stand while the payout read as refused');

  fake.reset(); S.status = 1;
  r = await call('/payouts/:id/fin-reject', 'post', { efrId: 999 }, { id: '55' });
  assert.equal(r.statusCode, 200);
  const upd = find(/UPDATE tbl_service_payout/i);
  assert.ok(upd, 'the rejection must be written');
  // fin_reject_date is DATETIME — bound as a Date, never NOW() (the pool is
  // IST wall clock; NOW() would resolve in the DB session zone instead).
  assert.doesNotMatch(upd.sql, /fin_reject_date = NOW\(\)/i);
  assert.ok(upd.params[1] instanceof Date, 'fin_reject_date must be a bound Date');
  assert.equal(upd.params[0], 12, 'fin_rejected_by');
  assert.deepEqual([upd.params[2], upd.params[3]], [55, 7], 'efr 7 from the row, not 999 from the body');
});

test('creating a payout binds pm_req_date as a Date, not NOW()', async () => {
  const r = await call('/payouts', 'post', {
    efrId: 7, efrBalance: 100, opsAmount: 50, pmRequestAmount: 50,
  });
  assert.equal(r.statusCode, 201);
  const ins = find(/INSERT INTO tbl_service_payout/i);
  assert.ok(ins, 'the payout row must be inserted');
  // pm_req_date is DATETIME — bound as a Date, never NOW() (the pool is IST
  // wall clock; NOW() would resolve in the DB session zone instead).
  assert.doesNotMatch(ins.sql, /pm_req_date = NOW\(\)|pm_req_date\) VALUES[^)]*NOW\(\)/i);
  assert.ok(ins.params[3] instanceof Date, 'pm_req_date must be a bound Date');
});

test('ops approval refuses only an already-paid payout, so reject-then-fix still works', async () => {
  for (const [status, expected] of [[0, 200], [1, 200], [3, 200], [2, 409]]) {
    fake.reset(); S.status = status;
    const r = await call('/payouts/:id/ops-approve', 'post', { opsApprovedAmount: 100 }, { id: '55' });
    assert.equal(r.statusCode, expected, `status ${status} → ${expected}`);
    const called = !!find(/CALL sp_ef_approve_payout_by_ops/i);
    assert.equal(called, expected === 200, `status ${status}: SP called = ${called}`);
  }
});

test('bulk ops-approve no longer takes a technician per item, and gates each one', async () => {
  const r = await call('/payouts/bulk-ops-approve', 'post', { items: [{ payoutId: 55, opsApprovedAmount: 100 }] });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.results, [{ payoutId: 55, ok: true }]);
  assert.equal(find(/CALL sp_ef_approve_payout_by_ops/i).params[1], 7, 'efr from the row');
  assert.equal(find(/GET_LOCK/i).params[0], 'payout_55');

  fake.reset(); S.status = 2;
  const paid = await call('/payouts/bulk-ops-approve', 'post', { items: [{ payoutId: 55, opsApprovedAmount: 100 }] });
  assert.equal(paid.body.data.results[0].ok, false, 'a paid payout is reported, not re-approved');
  assert.equal(find(/CALL sp_ef_approve_payout_by_ops/i), undefined);
});
