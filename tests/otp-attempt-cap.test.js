/*
 * THE OTP GUESS CAP — services/otp-attempts.service.js.
 *
 * utils/otp.js declared OTP_MAX_ATTEMPTS = 5 from the day it was written,
 * exported it, and nothing ever read it. Four services verify OTPs and all four
 * compared the submitted code and returned OTP_MISMATCH without counting. A
 * 4-digit code with a 5-minute window and no cap is about ten thousand guesses
 * against a live OTP.
 *
 * WHAT IS PINNED HERE, and why each one matters:
 *
 *   1. The cap FAILS OPEN when the column is absent. This is the property that
 *      makes the deploy order safe in both directions, and the one most likely
 *      to be "tidied" into a throw by someone who reads fail-open as a bug.
 *      Getting it wrong locks every user out of every login surface.
 *
 *   2. The probe HEALS: an absent column is re-asked after a minute, so the cap
 *      switches on by itself once the migration runs on a live environment.
 *      Caching "absent" forever would leave the fix silently inert.
 *
 *   3. The reset exists and is called on resend. Without it the counter is
 *      per-ROW rather than per-CODE: five mistypes would lock an account
 *      permanently and "Resend OTP" could not help.
 *
 *   4. All FOUR verify paths are wired, and check the cap BEFORE comparing. A
 *      security rule in three of four places is the failure this module exists
 *      to prevent, and a source-level check is the only thing that notices a
 *      fifth login surface arriving later without it.
 *
 * No DB: the fake-pool seam answers every read, so nothing is written anywhere.
 *
 * Runner: `node --test` (see npm test).
 */

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { installFakePool } = require('./helpers/fake-pool');

/* Mutable per-test: what the column probe and the counter read should answer. */
const scenario = { columnPresent: true, failedAttempts: 0 };

const routes = [
  [/INFORMATION_SCHEMA\.COLUMNS/, () => (scenario.columnPresent ? [{ 1: 1 }] : [])],
  [/SELECT failed_attempts FROM otp_details/, () => [{ failed_attempts: scenario.failedAttempts }]],
  [/UPDATE otp_details SET failed_attempts = failed_attempts \+ 1/, () => ({ affectedRows: 1 })],
  [/UPDATE otp_details SET failed_attempts = 0/, () => ({ affectedRows: 1 })],
];

let fake;
let svc;
const realNow = Date.now;

before(() => {
  fake = installFakePool(routes);
  svc = require('../services/otp-attempts.service');
});

beforeEach(() => {
  Date.now = realNow;
  scenario.columnPresent = true;
  scenario.failedAttempts = 0;
  fake.calls.length = 0;
  svc._resetProbeCache();
});

const probes = () => fake.calls.filter((c) => /INFORMATION_SCHEMA\.COLUMNS/.test(c.sql)).length;

// ─── 1. FAIL OPEN ─────────────────────────────────────────────────────────
test('with the column ABSENT the cap is inert — no lockout, no error', async () => {
  scenario.columnPresent = false;
  assert.equal(await svc.isLockedOut(7), false, 'a missing column must never lock anyone out');
  assert.equal(await svc.recordFailedAttempt(7), null);
  await svc.clearAttempts(7);            // must not throw
  // And it must not have attempted the counter statements at all.
  assert.equal(fake.calls.filter((c) => /failed_attempts/.test(c.sql) && /UPDATE/.test(c.sql)).length, 0);
});

// ─── 2. THE PROBE IS CACHED, AND HEALS ────────────────────────────────────
test('a PRESENT column is probed once for the life of the process', async () => {
  await svc.isLockedOut(1);
  await svc.isLockedOut(2);
  await svc.isLockedOut(3);
  assert.equal(probes(), 1, 'a present column must be cached, not re-asked per login');
});

test('an ABSENT column is re-probed after the window — the cap turns itself on', async () => {
  /*
   * The migration-after-deploy order. Without the re-probe the process would
   * keep answering "absent" until someone restarted it, and nothing would say
   * the security fix was not running.
   */
  let clock = 1_000_000;
  Date.now = () => clock;
  scenario.columnPresent = false;
  scenario.failedAttempts = svc.OTP_MAX_ATTEMPTS;   // a spent budget, waiting to be noticed

  assert.equal(await svc.isLockedOut(7), false, 'before the migration: fail open');
  assert.equal(await svc.isLockedOut(7), false, 'inside the window: still cached absent');
  assert.equal(probes(), 1, 'an absent answer must not be re-asked on every login either');

  scenario.columnPresent = true;                    // the migration runs
  clock += svc.ABSENT_RECHECK_MS + 1;               // …and the window passes
  assert.equal(await svc.isLockedOut(7), true, 'after the window the cap must take effect unaided');
  assert.equal(probes(), 2);
});

// ─── 3. THE RULE ──────────────────────────────────────────────────────────
test('under the cap is not locked out; AT the cap is', async () => {
  scenario.failedAttempts = svc.OTP_MAX_ATTEMPTS - 1;
  assert.equal(await svc.isLockedOut(7), false, 'the last guess must still be allowed');
  scenario.failedAttempts = svc.OTP_MAX_ATTEMPTS;
  assert.equal(await svc.isLockedOut(7), true, 'the cap is a ceiling, not a suggestion');
});

test('a wrong guess increments ATOMICALLY, never read-modify-write', async () => {
  scenario.failedAttempts = 3;
  await svc.recordFailedAttempt(7);
  const upd = fake.calls.find((c) => /UPDATE otp_details SET failed_attempts/.test(c.sql));
  assert.ok(upd, 'expected the increment');
  assert.match(upd.sql, /failed_attempts = failed_attempts \+ 1/,
    'concurrent guesses must both count — brute force is exactly the concurrent case');
  assert.ok(!/SET failed_attempts = \?/.test(upd.sql), 'must not write a value computed in JS');
});

test('a counter that fails to write does NOT fail the verify', async () => {
  // The user's code may have been correct. Losing the count is the lesser harm.
  const boom = installFakePool([
    [/INFORMATION_SCHEMA\.COLUMNS/, () => [{ 1: 1 }]],
    [/UPDATE otp_details/, () => { throw new Error('deadlock'); }],
  ]);
  delete require.cache[require.resolve('../services/otp-attempts.service')];
  const fresh = require('../services/otp-attempts.service');
  assert.equal(await fresh.recordFailedAttempt(7), null, 'must swallow, not throw');
  boom.restore();
  delete require.cache[require.resolve('../services/otp-attempts.service')];
  svc = require('../services/otp-attempts.service');
});

// ─── 4. EVERY VERIFY PATH IS WIRED ────────────────────────────────────────
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
const SERVICES = ['auth.service.js', 'client-auth.service.js', 'tech-auth.service.js', 'action-otp.service.js'];
const read = (f) => strip(fs.readFileSync(path.join(__dirname, '..', 'services', f), 'utf8'));

test('all FOUR OTP verify services check, count, and reset', () => {
  /*
   * Source-level, and deliberately so: the rule is only as good as its least
   * wired caller, and a unit test of the helper cannot see a service that
   * forgot to call it. Comments are stripped first — prose naming the
   * identifier would otherwise satisfy a raw grep.
   */
  for (const f of SERVICES) {
    const src = read(f);
    assert.match(src, /otpAttempts\.isLockedOut\(/, `${f}: must refuse an exhausted code BEFORE comparing`);
    assert.match(src, /otpAttempts\.recordFailedAttempt\(/, `${f}: must count a wrong guess`);
    assert.match(src, /otpAttempts\.clearAttempts\(/,
      `${f}: must reset on resend — without it the cap is a permanent lockout, not a cap`);
  }
});

test('the cap is checked BEFORE the code comparison, not after', () => {
  /*
   * Order is the whole point: checking after the compare would let an attacker
   * keep guessing forever as long as each guess was wrong — the exact scenario
   * the cap exists for.
   */
  for (const f of SERVICES) {
    const src = read(f);
    const lockIdx = src.indexOf('otpAttempts.isLockedOut(');
    const cmpIdx = src.indexOf('Number(row.otp) !== Number(otp)');
    assert.ok(lockIdx > -1 && cmpIdx > -1, `${f}: expected both the cap and the comparison`);
    assert.ok(lockIdx < cmpIdx, `${f}: the cap must be consulted before the comparison`);
  }
});

test('no OTP verify path exists that the cap does not cover', () => {
  /*
   * THE DENOMINATOR. The four above are the ones found on 2026-09-10. A fifth
   * login surface added later would verify OTPs without the cap and every test
   * above would still pass. So: find every service that COMPARES a stored OTP
   * to a submitted one — the structural marker a verify path cannot work
   * without — and require each of them to be in SERVICES.
   */
  const dir = path.join(__dirname, '..', 'services');
  const verifiers = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => /Number\(row\.otp\)\s*!==\s*Number\(otp\)/.test(read(f)));
  assert.ok(verifiers.length >= 4, `positive control: expected the four known verifiers, found ${verifiers.length}`);
  for (const f of verifiers) {
    assert.ok(SERVICES.includes(f),
      `${f} compares OTPs but is not covered by the guess cap — wire it through otp-attempts.service`);
  }
});
