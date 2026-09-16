/*
 * POST /mobile/device (routes/mobile/index.js) stamps device_info.last_login_time
 * (DATETIME) with a bound Date, never SQL NOW() (2026-09-16). db.js pool
 * timezone '+05:30' stores a bound Date as the IST wall clock regardless of
 * host; NOW() takes the DB session's own (SYSTEM) zone.
 *
 * requireTechAuth (real JWT + DB lookup) is stubbed to bypass auth and set
 * req.tech directly — this test is about the device_info writer, not login.
 *
 * Runner: `node --test` (see npm test).
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const { installFakePool } = require('./helpers/fake-pool');

function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, '..', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub('middleware/tech-auth', (req, _res, next) => { req.tech = { efr_id: 4471 }; next(); });

const fake = installFakePool([
  [/^\s*UPDATE device_info SET is_logged_in/i, () => ({ affectedRows: 1 })],
  [/^\s*INSERT INTO device_info/i, () => ({ insertId: 1 })],
  [/^\s*UPDATE tbl_easyfixer_app/i, () => ({ affectedRows: 1 })],
]);

let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/mobile', require('../routes/mobile'));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/mobile`;
});
after(async () => { await new Promise((r) => server.close(r)); if (fake.restore) fake.restore(); });

test('POST /mobile/device binds last_login_time as a Date, never NOW()', async () => {
  const r = await fetch(base + '/device', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'dev-1', fcmToken: 'tok-1' }),
  });
  assert.equal(r.status, 200, JSON.stringify(await r.json()));

  const ins = fake.calls.find((c) => /INSERT INTO device_info/.test(c.sql));
  assert.ok(ins, 'the device_info upsert ran');
  assert.doesNotMatch(ins.sql, /NOW\(\)/, 'last_login_time must not be SQL NOW()');
  // (user_id, device_id, fire_base_token, app_version_name, language, is_logged_in, last_login_time)
  // + ON DUPLICATE KEY UPDATE ..., last_login_time = ?
  assert.ok(ins.params[5] instanceof Date, 'last_login_time (VALUES) is the 6th bound value');
  assert.ok(ins.params[6] instanceof Date, 'last_login_time (ON DUPLICATE KEY) is the 7th bound value');
  assert.equal(ins.params[5].getTime(), ins.params[6].getTime());
});
