/*
 * routes/admin/advances.js audit-trail timestamps (2026-09-16). Every
 * tbl_efr_advance_payment date column (initiated_on, ops_action_on,
 * fin_action_on, updated_on) is DATETIME, so each writer binds a Date —
 * db.js pool timezone '+05:30' stores it as the IST wall clock; SQL NOW()
 * would take the DB session's own (SYSTEM) zone instead.
 *
 * Runner: `node --test` (see npm test).
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installFakePool } = require('./helpers/fake-pool');

// scopedAdvance's row has no client/city/vertical, so assertEntityInScope's
// null-dimension rule waves every caller through with no scope setup needed.
const fake = installFakePool([
  [/FROM tbl_efr_advance_payment a[\s\S]*LEFT JOIN/i, () => [{ advance_id: 1, client_id: null, efr_id: 5, vertical_id: null, city_id: null }]],
  [/SELECT adv_status FROM tbl_efr_advance_payment WHERE advance_id/i, () => [{ adv_status: 0 }]],
  [/^\s*UPDATE tbl_efr_advance_payment/i, () => ({ affectedRows: 1 })],
]);

let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { user_id: 9 }; next(); });
  app.use('/api/admin/advances', require('../routes/admin/advances'));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/api/admin/advances`;
});
after(async () => { await new Promise((r) => server.close(r)); if (fake.restore) fake.restore(); });
beforeEach(() => { fake.calls.length = 0; });

test('ops-approve stamps ops_action_on + updated_on with the SAME bound Date, never NOW()', async () => {
  const r = await fetch(base + '/1/ops-approve', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  });
  assert.equal(r.status, 200, JSON.stringify(await r.json()));

  const upd = fake.calls.find((c) => /UPDATE tbl_efr_advance_payment/.test(c.sql));
  assert.ok(upd, 'the ops-approve UPDATE ran');
  assert.doesNotMatch(upd.sql, /NOW\(\)/, 'ops_action_on/updated_on must not be SQL NOW()');
  // SET adv_status = 1, ops_action_on = ?, ops_action_by = ?, ops_remarks = ?, updated_on = ?, updated_by = ?
  assert.ok(upd.params[0] instanceof Date, 'ops_action_on is the first bound value');
  assert.ok(upd.params[3] instanceof Date, 'updated_on is the fourth bound value');
  assert.equal(upd.params[0].getTime(), upd.params[3].getTime(), 'paired columns share one instant');
});
