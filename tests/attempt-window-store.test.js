/*
 * THE SHARED GUESS WINDOWS — services/attempt-window.service.js.
 *
 * The checkout PIN and the profile/bank OTP count in tbl_attempt_window so every
 * backend container shares one count (and one admin unlock clears it for all).
 * Pinned:
 *   - with the table: a claim is an INSERT IGNORE then ONE guarded UPDATE whose
 *     WHERE refuses a full window, all time as Date params, the count assigned
 *     before the window — and a refused claim reads the lock with its minutes;
 *   - namespaces keep the two codes apart; clear() deletes the shared row;
 *   - WITHOUT the table, or when a query fails, it counts in memory — degraded
 *     to per-process, never to unlimited — and a missing table is re-probed;
 *   - an injected pool is the only one touched.
 * The SQL semantics were run against MySQL — see the commit message.
 *
 * Runner: `node --test` (see npm test).
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool, makeFakePool } = require('./helpers/fake-pool');

const S = {};
const reset = () => Object.assign(S, { table: true, affected: 1, attempts: 5, inWindow: 1, secsLeft: 600, fail: null });
reset();
const ROUTES = [
  [/INFORMATION_SCHEMA\.TABLES/, () => (S.table ? [{ 1: 1 }] : [])],
  [/INSERT IGNORE INTO tbl_attempt_window/, () => ({ affectedRows: 1 })],
  [/UPDATE tbl_attempt_window/, () => { if (S.fail) throw S.fail; return { affectedRows: S.affected }; }],
  [/SELECT attempts,/, () => [{ attempts: S.attempts, in_window: S.inWindow, secs_left: S.secsLeft }]],
  [/DELETE FROM tbl_attempt_window/, () => ({ affectedRows: 1 })],
];
const fake = installFakePool(ROUTES);
const store = require('../services/attempt-window.service');

beforeEach(() => { reset(); fake.calls.length = 0; store._resetProbeCache(); });
const calls = (re) => fake.calls.filter((c) => re.test(c.sql));

test('with the table, a claim is INSERT IGNORE + ONE guarded UPDATE', async () => {
  const t0 = Date.now();
  assert.equal((await store.checkoutPin.claim('job:7')).locked, false);
  const ins = calls(/INSERT IGNORE INTO tbl_attempt_window/)[0];
  assert.ok(ins, 'the row is created if missing');
  assert.equal(ins.params[0], 'checkout-pin:job:7');
  const up = calls(/UPDATE tbl_attempt_window/)[0];
  assert.ok(up, 'expected the claim');
  assert.match(up.sql, /attempts\s+= IF\(window_start IS NULL OR window_start < \?, 1, attempts \+ 1\)/);
  assert.match(up.sql, /window_start = IF\(window_start IS NULL OR window_start < \?, \?, window_start\)/);
  assert.match(up.sql, /WHERE attempt_key = \?\s+AND \(window_start IS NULL OR window_start < \? OR attempts < \?\)/,
    'the check and the count must be ONE statement, or parallel guesses all pass the check');
  assert.ok(up.sql.indexOf('attempts     = IF') < up.sql.indexOf('window_start = IF'),
    'the count is assigned BEFORE the window — both IFs then see the OLD window');
  assert.doesNotMatch(up.sql, /NOW\(\)/);
  const [c1, c2, now, upd, key, c3, max] = up.params;
  assert.equal(key, 'checkout-pin:job:7');
  assert.equal(max, 5);
  for (const d of [c1, c2, now, upd, c3]) assert.ok(d instanceof Date);
  assert.equal(c1.getTime(), c2.getTime());
  assert.equal(c1.getTime(), c3.getTime());
  assert.equal(now.getTime() - c1.getTime(), 30 * 60 * 1000);
  assert.ok(now.getTime() >= t0);
});

test('a claim the WHERE refuses reads the lock, with the minutes to show', async () => {
  S.affected = 0; S.attempts = 5; S.secsLeft = 601;
  assert.deepEqual(await store.checkoutPin.claim('job:8'), { locked: true, attemptsRemaining: 0, retryAfterMinutes: 11 });
});

test('the PIN and the profile OTP never share a count', async () => {
  await store.checkoutPin.claim('efr:1');
  await store.profileOtp.claim('efr:1');
  assert.deepEqual(calls(/INSERT IGNORE/).map((c) => c.params[0]), ['checkout-pin:efr:1', 'profile-otp:efr:1']);
});

test('clear() deletes the shared row', async () => {
  await store.profileOtp.clear('efr:9');
  assert.deepEqual(calls(/DELETE FROM tbl_attempt_window WHERE attempt_key/)[0].params, ['profile-otp:efr:9']);
});

test('WITHOUT the table it counts in memory — per process, never unlimited', async () => {
  S.table = false;
  for (let i = 0; i < 5; i++) assert.equal((await store.checkoutPin.claim('job:mem1')).locked, false);
  const sixth = await store.checkoutPin.claim('job:mem1');
  assert.equal(sixth.locked, true);
  assert.equal(sixth.retryAfterMinutes, 30);
  assert.equal(calls(/tbl_attempt_window/).filter((c) => !/INFORMATION_SCHEMA/.test(c.sql)).length, 0,
    'nothing may be written to a table that is not there');
  await store.checkoutPin.clear('job:mem1');
  assert.equal((await store.checkoutPin.state('job:mem1')).locked, false, 'clear() empties memory too');
});

test('a failing claim falls back to memory, and a missing table is re-probed', async () => {
  await store.checkoutPin.state('job:x');                          // probe: present
  S.fail = Object.assign(new Error("Table 'easyfix.tbl_attempt_window' doesn't exist"), { code: 'ER_NO_SUCH_TABLE', errno: 1146 });
  assert.equal((await store.checkoutPin.claim('job:fail')).locked, false, 'the error itself counts in memory, not unlimited');
  S.table = false;
  await store.checkoutPin.state('job:x');
  assert.equal(calls(/INFORMATION_SCHEMA\.TABLES/).length, 2, 'the next call re-probed');
});

test('while the table keeps failing, the fallback still COUNTS — the 6th claim is refused', async () => {
  // A fallback that just granted would pass the test above; this one would not.
  S.fail = new Error('Lock wait timeout exceeded');           // not "no such table": stays present
  for (let i = 0; i < 5; i++) assert.equal((await store.checkoutPin.claim('job:failing')).locked, false, `claim ${i + 1}`);
  assert.equal((await store.checkoutPin.claim('job:failing')).locked, true, 'never unlimited, even when the DB is down');
  assert.equal(calls(/UPDATE tbl_attempt_window/).length, 6, 'positive control: every claim did try the shared table first');
});

test('an injected pool is the only database touched', async () => {
  const own = makeFakePool(ROUTES);
  await store.profileOtp.claim('efr:42', own.pool);
  assert.ok(own.calls.some((c) => /UPDATE tbl_attempt_window/.test(c.sql)), 'the injected pool ran the claim');
  assert.equal(calls(/tbl_attempt_window/).length, 0, 'the shared pool saw nothing');
});

/* ── sharedRateLimit — the login limiters ──────────────────────────────── */

const resDouble = () => ({
  statusCode: 200, body: null, headers: {},
  setHeader(n, v) { this.headers[n] = v; },
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
});
const TEN_MIN = 10 * 60_000;
const limiter = store.sharedRateLimit({
  windowMs: TEN_MIN, max: 20, message: 'slow down', key: (req) => `login-otp:mobile:${req.body.mobile}`,
});
const hit = async (mobile) => {
  const res = resDouble();
  let passed = false;
  await limiter({ ip: '203.0.113.1', body: { mobile } }, res, () => { passed = true; });
  return { res, passed };
};

test('a limiter claims with ITS OWN max and window, under the rate: namespace', async () => {
  assert.equal((await hit('9876543210')).passed, true);
  const up = calls(/UPDATE tbl_attempt_window/)[0];
  assert.ok(up, 'expected the claim');
  const [cutoff, , now, , key, , max] = up.params;
  assert.equal(key, 'rate:login-otp:mobile:9876543210');
  assert.equal(max, 20);
  assert.equal(now.getTime() - cutoff.getTime(), TEN_MIN);
});

test('past its ceiling it answers 429 with the message and a Retry-After', async () => {
  S.affected = 0; S.attempts = 20; S.secsLeft = 301;
  const { res, passed } = await hit('9876543211');
  assert.equal(passed, false);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error, 'slow down');
  assert.equal(res.headers['Retry-After'], 360, 'minutes rounded up, in seconds');
  assert.equal(calls(/SELECT attempts,/)[0].params[2], 600, 'the lock is read against ITS window, in seconds');
});

test('below its ceiling a refused UPDATE still passes (a window that just expired)', async () => {
  S.affected = 0; S.attempts = 5;                  // ≥ the PIN max, < this limiter's 20
  assert.equal((await hit('9876543212')).passed, true);
});

test('with no table it keeps the old per-process ceiling', async () => {
  S.table = false;
  for (let i = 0; i < 20; i++) assert.equal((await hit('9000000001')).passed, true, `hit ${i + 1}`);
  assert.equal((await hit('9000000001')).res.statusCode, 429);
});

test('a key too long for the column counts in memory — never a truncated row', async () => {
  const long = '9'.repeat(120);
  for (let i = 0; i < 20; i++) assert.equal((await hit(long)).passed, true);
  assert.equal((await hit(long)).res.statusCode, 429, 'never unlimited');
  assert.equal(calls(/INSERT IGNORE|UPDATE tbl_attempt_window/).length, 0, 'nothing written with an over-long key');
});

test('a failure log masks the mobile in the key', async () => {
  const logger = require('../logger');
  const seen = [];
  const orig = logger.warn;
  logger.warn = (m) => { seen.push(String(m)); };
  try {
    S.fail = new Error('Lock wait timeout exceeded');
    await hit('9876543213');
  } finally { logger.warn = orig; }
  const line = seen.find((m) => /claim failed/.test(m));
  assert.ok(line, 'positive control: the failure was logged');
  assert.doesNotMatch(line, /9876543213/);
  assert.match(line, /rate:login-otp:mobile:/);
});

/* ── housekeeping ─────────────────────────────────────────────────────── */

test('a claim sweeps rows idle past the LONGEST window — once per interval', async () => {
  await hit('9876543214');                          // a 10-minute limiter triggers it…
  const sweeps = calls(/DELETE FROM tbl_attempt_window WHERE updated_on < \?/);
  assert.equal(sweeps.length, 1, 'positive control: the sweep ran');
  const [cutoff] = sweeps[0].params;
  assert.ok(cutoff instanceof Date);
  const age = Date.now() - cutoff.getTime();
  // …but must not delete a 30-minute PIN lock that is still running.
  assert.ok(age >= 30 * 60_000 && age < 30 * 60_000 + 5_000, `cutoff is 30 min back, got ${age}ms`);
  await hit('9876543215');
  await store.checkoutPin.claim('job:sweep');
  assert.equal(calls(/WHERE updated_on < \?/).length, 1, `at most once per ${store.SWEEP_EVERY_MS}ms`);
});
