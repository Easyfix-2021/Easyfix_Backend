/*
 * attemptWindow — middleware/rate-limit.js. "5 wrong codes per 30 minutes" in
 * memory, for the two codes with no otp_details row to count on: the checkout
 * PIN (tbl_job) and the profile/bank-change OTP (tbl_easyfixer).
 *
 * Pinned: the claim counts and refuses in ONE synchronous step; the 6th claim
 * in a window is refused however the calls interleave; the lock lifts by itself
 * after the window; minutes round UP and are never 0; clear() resets; keys are
 * independent. Plus rateLimit's `message`, which the CRM login limiter uses.
 *
 * Runner: `node --test` (see npm test).
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { attemptWindow, rateLimit } = require('../middleware/rate-limit');

const realNow = Date.now;
afterEach(() => { Date.now = realNow; });

test('five claims are granted, the sixth is refused with the minutes to wait', () => {
  const w = attemptWindow();
  for (let i = 1; i <= 5; i++) assert.equal(w.claim('k').locked, false, `claim ${i}`);
  const sixth = w.claim('k');
  assert.equal(sixth.locked, true);
  assert.equal(sixth.retryAfterMinutes, 30);
  assert.deepEqual(w.state('k'), { locked: true, attemptsRemaining: 0, retryAfterMinutes: 30 });
});

test('state counts what was claimed', () => {
  const w = attemptWindow();
  w.claim('k'); w.claim('k');
  assert.deepEqual(w.state('k'), { locked: false, attemptsRemaining: 3, retryAfterMinutes: null });
  assert.deepEqual(w.state('other'), { locked: false, attemptsRemaining: 5, retryAfterMinutes: null });
});

test('a locked window stays locked however often it is tried, and one clear reopens it', () => {
  const w = attemptWindow({ max: 2 });
  w.claim('k'); w.claim('k');
  for (let i = 0; i < 10; i++) w.claim('k');
  assert.equal(w.state('k').attemptsRemaining, 0);
  w.clear('k');
  assert.equal(w.claim('k').locked, false, 'one clear is enough to open it again');
});

test('the lock lifts by itself when the window ends, and restarts at 1', () => {
  let clock = 1_000_000;
  Date.now = () => clock;
  const w = attemptWindow();
  for (let i = 0; i < 5; i++) w.claim('k');
  clock += 29 * 60_000 + 1;
  assert.equal(w.claim('k').locked, true, 'still inside the window');
  assert.equal(w.state('k').retryAfterMinutes, 1, 'a minute or less left reads as 1, never 0');
  clock += 60_000;
  assert.equal(w.claim('k').locked, false, 'window over — granted');
  assert.equal(w.state('k').attemptsRemaining, 4, 'the new window started at 1');
});

test('minutes round UP', () => {
  let clock = 1_000_000;
  Date.now = () => clock;
  const w = attemptWindow();
  for (let i = 0; i < 5; i++) w.claim('k');
  clock += 28 * 60_000 + 59_000;          // 1 min 1 s left → 2
  assert.equal(w.state('k').retryAfterMinutes, 2);
});

test('clear() is per key', () => {
  const w = attemptWindow();
  for (let i = 0; i < 5; i++) { w.claim('a'); w.claim('b'); }
  w.clear('a');
  assert.equal(w.state('a').locked, false);
  assert.equal(w.state('b').locked, true);
});

test('expired windows are swept, so a long-lived process does not grow without bound', () => {
  let clock = 1_000_000;
  Date.now = () => clock;
  const w = attemptWindow({ windowMs: 1000 });
  for (let i = 0; i < 100; i++) w.claim(`k${i}`);
  clock += 2000;
  w.claim('fresh');                        // any access after the window sweeps
  for (let i = 0; i < 100; i++) assert.equal(w.state(`k${i}`).attemptsRemaining, 5);
});

// ─── rateLimit's message ─────────────────────────────────────────────────
function fakeRes() {
  const r = { statusCode: 200, headers: {}, body: null, locals: {} };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}

test('rateLimit refuses over the limit with the configured sentence and Retry-After', () => {
  const limit = rateLimit({ windowMs: 60_000, max: 2, message: 'Please wait.', key: () => 'x' });
  let passed = 0;
  for (let i = 0; i < 3; i++) limit({}, fakeRes(), () => { passed += 1; });
  const res = fakeRes();
  limit({}, res, () => { passed += 1; });
  assert.equal(passed, 2);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error, 'Please wait.');
  assert.ok(Number(res.headers['Retry-After']) > 0);
});

test('rateLimit without a message keeps its old wording', () => {
  const limit = rateLimit({ max: 0, key: () => 'y' });
  limit({}, fakeRes(), () => {});          // first request always opens the bucket
  const res = fakeRes();
  limit({}, res, () => {});
  assert.equal(res.body.error, 'rate limit exceeded');
});
