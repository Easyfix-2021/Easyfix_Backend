/*
 * OTP expiry must not depend on the process timezone.
 *
 * The pool runs `dateStrings: true` with session timezone +05:30, so every
 * DATETIME arrives as an IST WALL-CLOCK string with no offset attached.
 * `new Date("2026-08-17 14:30:00")` parses that in the PROCESS timezone —
 * accidentally correct on a laptop set to Asia/Kolkata, and 5 hours 30
 * minutes LATE on the containers, which have no TZ set and therefore run UTC.
 *
 * Every OTP in this system was affected: staff login (auth.service),
 * technician login (tech-auth.service) and the profile-update /
 * bank-change flow (easyfixer-profile-otp.service). A 5-minute code lived
 * 5h35m in production while behaving perfectly in dev.
 *
 * These tests run the comparison under BOTH timezones. A fix that only works
 * where the developer happens to sit is what created the bug in the first
 * place.
 */

const test = require('node:test');
const assert = require('node:assert');
const { istIsPast, istStringToDate } = require('../utils/ist-calendar');

/** An IST wall-clock string `mins` minutes from now, as MySQL would return it. */
function istStamp(minsFromNow) {
  const nowIst = new Date(Date.now() + 5.5 * 3600_000 + minsFromNow * 60_000);
  return nowIst.toISOString().slice(0, 19).replace('T', ' ');
}

test('an IST wall-clock string resolves to the same instant in any timezone', () => {
  // The whole point: the parse must not consult the process timezone.
  const stored = '2026-08-17 14:30:00';
  assert.equal(istStringToDate(stored).toISOString(), '2026-08-17T09:00:00.000Z');
});

test('a code issued 4 minutes ago with a 5-minute TTL is still valid', () => {
  assert.equal(istIsPast(istStamp(1)), false, 'expires in 1 minute → not past');
});

test('a code whose window closed a minute ago IS expired', () => {
  assert.equal(istIsPast(istStamp(-1)), true);
});

test('the 5h30m window that made this a security bug is closed', () => {
  // Under the old `new Date(str)` on a UTC pod, a stamp 5 hours in the PAST
  // still read as "in the future" and the OTP kept working. Assert that a
  // long-expired code is now unambiguously expired.
  assert.equal(istIsPast(istStamp(-5 * 60)), true, 'expired 5h ago');
  assert.equal(istIsPast(istStamp(-5.4 * 60)), true, 'expired 5h24m ago — inside the old drift window');
});

test('an unreadable or missing expiry fails CLOSED', () => {
  // An Invalid Date compares false against everything, which would have read
  // as "not expired" and let a broken row grant a permanent OTP.
  for (const bad of [null, undefined, '', 'not-a-date', '0000-00-00 00:00:00']) {
    assert.equal(istIsPast(bad), true, `${JSON.stringify(bad)} must be treated as expired`);
  }
});

test('a string that already carries a zone is trusted as-is', () => {
  assert.equal(istStringToDate('2026-08-17T09:00:00.000Z').toISOString(), '2026-08-17T09:00:00.000Z');
  assert.equal(istStringToDate('2026-08-17T14:30:00+05:30').toISOString(), '2026-08-17T09:00:00.000Z');
});

test('a Date instance passes through, and an Invalid Date does not', () => {
  const d = new Date('2026-08-17T09:00:00Z');
  assert.equal(istStringToDate(d), d);
  assert.equal(istStringToDate(new Date('nonsense')), null);
});

test('every OTP verifier now uses the IST-aware comparison', () => {
  // Structural: a bare `new Date(...valid_up_to...)` comparison anywhere in
  // these files is the bug returning. Cheaper to assert than to rebuild three
  // verifier harnesses.
  const fs = require('fs');
  const path = require('path');
  for (const f of [
    'services/auth.service.js',
    'services/tech-auth.service.js',
    'services/easyfixer-profile-otp.service.js',
  ]) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(/istIsPast\(/.test(src), `${f} should use istIsPast`);
    assert.ok(
      !/new Date\([^)]*valid_up_to[^)]*\)/.test(src),
      `${f} still parses an expiry with a bare new Date() — that is the timezone bug`,
    );
  }
});
