/*
 * Admin Actions → Unlock OTP / PIN — routes/admin/otp-locks.js, through the real
 * router and the real requireAction guard (permissions stubbed at role.service).
 *
 * Pinned: the RBAC key gates all four routes; a person's lookup lists every
 * otp_details flow and the technician's profile/bank OTP, from an email or a
 * mobile however it was typed; one unlock clears all of those; a job's PIN lock
 * is shown and cleared through scopedJob (out of scope → 404); nothing returns
 * a code. For a mobile it also shows and clears the technician app's per-mobile
 * login limits — proven by a round trip through the REAL limiters in
 * routes/mobile/index.js, in memory and against the shared table — and never
 * the per-IP ones.
 *
 * Runner: `node --test` (see npm test).
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const { installFakePool } = require('./helpers/fake-pool');

const S = {};
const reset = () => Object.assign(S, {
  table: false,
  perms: ['isOtpUnlock'],
  scoped: true,
  tech: { efr_id: 55, efr_name: 'Ravi' },
  otpRows: [
    { id: 11, otp_type: 'Mobile App Otp', failed_attempts: 5, in_window: 1, secs_left: 900 },
    { id: 12, otp_type: 'crm_login', failed_attempts: 2, in_window: 1, secs_left: 1500 },
  ],
});
reset();

const fake = installFakePool([
  [/INFORMATION_SCHEMA\.COLUMNS/, () => [{ COLUMN_NAME: 'failed_attempts' }, { COLUMN_NAME: 'updated_on' }]],
  [/INFORMATION_SCHEMA\.TABLES/, () => (S.table ? [{ 1: 1 }] : [])],   // memory unless a test turns it on
  [/INSERT IGNORE INTO tbl_attempt_window/, () => ({ affectedRows: 1 })],
  [/UPDATE tbl_attempt_window/, () => ({ affectedRows: 1 })],
  [/SELECT attempts,/, () => [{ attempts: 0, in_window: 0, secs_left: 0 }]],
  [/DELETE FROM tbl_attempt_window/, () => ({ affectedRows: 1 })],
  [/FROM otp_details\s+WHERE user_email = \? OR user_mobile_no = \?/, () => S.otpRows],
  [/UPDATE otp_details SET failed_attempts = 0, updated_on = NULL\s+WHERE \(user_email = \? OR user_mobile_no = \?\)/,
    () => ({ affectedRows: 2 })],
  [/FROM tbl_easyfixer/, () => (S.tech ? [S.tech] : [])],
]);

function stub(rel, exports) {
  const p = require.resolve(path.join(__dirname, '..', rel));
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub('services/role.service', { getEffectivePermissions: async () => ({ menuIds: [], actionPermissions: S.perms }) });
stub('routes/admin/jobs', {
  scopedJob: (req, res, next) => {
    if (!S.scoped) return res.status(404).json({ success: false, error: 'job not found' });
    req.scopedJob = { job_id: Number(req.params.id), otp: '4455' };
    return next();
  },
});
const store = require('../services/attempt-window.service');
const mobileRouter = require('../routes/mobile');   // registers the per-mobile limiters, as server.js does

// The technician app's real limiters, in mount order: [ipLimit, mobileLimit].
const limiters = (path) => mobileRouter.stack
  .find((l) => l.route && l.route.path === path && l.route.methods.post).route.stack.slice(0, 2).map((l) => l.handle);
const hit = async (mw, mobile, ip = '203.0.113.5') => {
  let passed = false;
  const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this; }, json() { return this; } };
  await mw({ ip, body: { mobile } }, res, () => { passed = true; });
  return passed;
};

let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { user_id: 9 }; next(); });
  app.use('/api/admin/otp-locks', require('../routes/admin/otp-locks'));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/api/admin/otp-locks`;
});
after(async () => { await new Promise((r) => server.close(r)); if (fake.restore) fake.restore(); });
beforeEach(() => { reset(); fake.calls.length = 0; });

const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const post = async (p, body) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json() };
};

test('without isOtpUnlock every route is refused', async () => {
  S.perms = [];
  for (const r of [await get('/?identifier=9876543210'), await post('/unlock', { identifier: '9876543210' }),
    await get('/job/77'), await post('/job/77/unlock')]) {
    assert.equal(r.status, 403);
    assert.match(r.body.error, /isOtpUnlock/);
  }
});

test('a person: every login flow and the technician profile/bank OTP, from a mobile typed any way', async () => {
  const r = await get('/?identifier=' + encodeURIComponent(' +91 98765 43210 '));
  assert.equal(r.status, 200);
  const d = r.body.data;
  assert.equal(d.identifier, '9876543210', 'normalised to the 10 digits otp_details stores');
  const q = fake.calls.find((c) => /FROM otp_details/.test(c.sql));
  assert.deepEqual(q.params.slice(-2), ['9876543210', '9876543210']);
  assert.equal(d.capActive, true);
  assert.deepEqual(d.login.map((x) => [x.otpType, x.locked, x.attemptsRemaining, x.retryAfterMinutes]),
    [['Mobile App Otp', true, 0, 15], ['crm_login', false, 3, null]]);
  assert.equal(d.technician.efrId, 55);
  assert.equal(d.technician.profileOtp.locked, false);
});

test('an email is looked up lower-case; it has no technician profile OTP', async () => {
  const r = await get('/?identifier=' + encodeURIComponent('Someone@EasyFix.in'));
  assert.equal(r.body.data.identifier, 'someone@easyfix.in');
  assert.equal(r.body.data.technician, null);
});

test('Unlock clears every login flow AND the technician profile/bank OTP', async () => {
  for (let i = 0; i < 5; i++) await store.profileOtp.claim('efr:55');
  assert.equal((await store.profileOtp.state('efr:55')).locked, true, 'positive control: the profile OTP was locked');
  const r = await post('/unlock', { identifier: '9876543210' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.loginRowsCleared, 2);
  assert.equal(r.body.data.technicianCleared, true);
  const upd = fake.calls.find((c) => /UPDATE otp_details SET failed_attempts = 0/.test(c.sql));
  assert.deepEqual(upd.params, ['9876543210', '9876543210']);
  assert.equal((await store.profileOtp.state('efr:55')).locked, false);
});

test('a job: the closing-PIN lock is shown and cleared — never the PIN itself', async () => {
  for (let i = 0; i < 5; i++) await store.checkoutPin.claim('job:77');
  const before = await get('/job/77');
  assert.equal(before.body.data.pin.locked, true);
  assert.equal(before.body.data.hasPin, true);
  assert.ok(!JSON.stringify(before.body).includes('4455'), 'the PIN value is never in the response');
  const r = await post('/job/77/unlock');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.pin.locked, false);
  assert.equal((await store.checkoutPin.state('job:77')).locked, false);
});

test('a mobile shows the technician app\'s per-mobile login limits, each with its own ceiling; an email has none', async () => {
  const d = (await get('/?identifier=9876500010')).body.data;
  assert.deepEqual(d.appLoginLimits.map((x) => [x.limiter, x.locked, x.attemptsRemaining]),
    [['login-otp', false, 20], ['verify-otp', false, 30]]);
  assert.deepEqual((await get('/?identifier=someone@easyfix.in')).body.data.appLoginLimits, []);
});

test('Unlock lifts the app\'s own login limits — round trip through the real limiters — and never the per-IP one', async () => {
  const m = '9876500001';
  const ip = '203.0.113.77';
  const [loginIp, loginMobile] = limiters('/auth/login-otp');
  const [, verifyMobile] = limiters('/auth/verify-otp');
  for (let i = 0; i < 20; i++) assert.equal(await hit(loginMobile, m), true);
  for (let i = 0; i < 30; i++) assert.equal(await hit(verifyMobile, m), true);
  for (let i = 0; i < 60; i++) assert.equal(await hit(loginIp, String(9000000100 + i), ip), true);
  assert.equal(await hit(loginMobile, m), false, 'positive control: code requests locked');
  assert.equal(await hit(verifyMobile, m), false, 'positive control: code entries locked');
  assert.equal(await hit(loginIp, m, ip), false, 'positive control: the IP budget is spent');
  const locked = (await get('/?identifier=' + m)).body.data.appLoginLimits;
  assert.deepEqual(locked.map((x) => [x.limiter, x.locked]), [['login-otp', true], ['verify-otp', true]]);
  assert.ok(locked.every((x) => x.retryAfterMinutes >= 1));

  const r = await post('/unlock', { identifier: m });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.appLoginLimitsCleared, true);
  assert.deepEqual(r.body.data.appLoginLimits.map((x) => x.locked), [false, false]);
  assert.equal(await hit(loginMobile, m), true, 'the technician can request a code again');
  assert.equal(await hit(verifyMobile, m), true, 'and enter one');
  assert.equal(await hit(loginIp, '9000000999', ip), false, 'a PERSON\'s unlock never resets a network\'s budget');
});

test('with the shared table, Unlock deletes exactly the rows the limiters count on', async () => {
  S.table = true; store._resetProbeCache();
  try {
    const m = '9876500002';
    await hit(limiters('/auth/login-otp')[1], m);
    await hit(limiters('/auth/verify-otp')[1], m);
    const claimed = fake.calls.filter((c) => /UPDATE tbl_attempt_window/.test(c.sql)).map((c) => c.params[4]);
    assert.deepEqual(claimed, ['rate:login-otp:mobile:9876500002', 'rate:verify-otp:mobile:9876500002']);
    fake.calls.length = 0;
    assert.equal((await post('/unlock', { identifier: m })).status, 200);
    const deleted = fake.calls.filter((c) => /DELETE FROM tbl_attempt_window WHERE attempt_key/.test(c.sql))
      .map((c) => c.params[0]).filter((k) => k.startsWith('rate:'));
    assert.deepEqual(deleted, claimed, 'the unlock and the limiters build the same key');
  } finally { S.table = false; store._resetProbeCache(); }
});

test('a job outside the operator\'s scope is 404, and nothing is cleared', async () => {
  for (let i = 0; i < 5; i++) await store.checkoutPin.claim('job:78');
  S.scoped = false;
  assert.equal((await post('/job/78/unlock')).status, 404);
  assert.equal((await store.checkoutPin.state('job:78')).locked, true);
});
