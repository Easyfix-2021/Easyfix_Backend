'use strict';

/*
 * The public I-Card verification surface —
 * services/technician-verification.service.js and the page in front of it.
 *
 * ─── WHY THESE TESTS EXIST ────────────────────────────────────────────────
 *
 * This endpoint is the ONLY thing standing between a customer at their front
 * door and someone impersonating an EasyFix technician. It has to hold four
 * properties at once, and checking some of them proves very little:
 *
 *   1. A FORGED TOKEN IS NEVER ACCEPTED. Otherwise anyone mints their own card.
 *   2. IT IS NOT ENUMERABLE, and it is not an oracle: an unknown technician and
 *      a bad signature must be indistinguishable, or the endpoint becomes a
 *      directory of who exists.
 *   3. THE VERDICT IS LIVE AND FAILS CLOSED. A blacklisted technician whose
 *      efr_status is still 1 must read NOT AUTHORISED — that is the fraud case.
 *   4. IT LEAKS NOTHING. No mobile, no Aadhaar, no address, and never the
 *      lifecycle reason, which carries internal RCA on blacklisted rows.
 *
 * Non-destructive: fake pool, no real DB.
 *   node --test --test-force-exit tests/technician-verification.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-verification';

const EFR_ID = 4471;
const OTHER_ID = 9902;

const scenario = { row: null };

function technician(over = {}) {
  return {
    efr_id: EFR_ID,
    efr_name: 'Ravi Kumar',
    efr_profile_img: 'MobileUploads/4471_photo',
    efr_status: 1,
    is_technician_verified: 1,
    efr_manager_id: null,
    scheduled_reactivation_date: null,
    efr_service_category: 'Electrician,Plumber',
    profile_activation_date_time: '2025-01-05 10:00:00',
    lifecycle_status: 'ACTIVE',
    lifecycle_changed_at: '2026-08-10 10:00:00',
    adhaar_card_number: '123456789012',
    user_id: 7,
    is_identity_details_verified_by_crm: 1,
    user_personal_details_filled: 1,
    city_name: 'Bengaluru',
    ...over,
  };
}

const fake = installFakePool([
  [/FROM tbl_easyfixer e/i, () => (scenario.row ? [scenario.row] : [])],
]);

const verification = require('../services/technician-verification.service');
const express = require('express');

let server;
let baseUrl;
const realFetch = globalThis.fetch;

before(async () => {
  const app = express();
  app.use('/verify-technician', require('../routes/public/verify-technician'));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  fake.restore();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function scan(token) {
  const res = await realFetch(`${baseUrl}/verify-technician/${token}`);
  return { status: res.status, html: await res.text() };
}

/* ─────────────────────────── the token itself ──────────────────────────── */

test('the token is unguessable, stable, and long enough to be redacted from logs', () => {
  const token = verification.tokenFor(EFR_ID);

  // Stable: the card is rendered once and may be screenshotted or printed.
  assert.equal(token, verification.tokenFor(EFR_ID));
  assert.notEqual(token, verification.tokenFor(OTHER_ID));

  // 24+ base64url chars in ONE segment, so utils/log-format.js redacts it as
  // <token>. A numeric id here would be written to the access log on every scan.
  assert.equal(token.length, 32);
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.doesNotMatch(token, /\./, 'a dot would split the segment and defeat the redaction');

  // The id round-trips, so no storage is needed.
  assert.equal(verification.efrIdFromToken(token), EFR_ID);
});

/*
 * ⚠ THE URL HAS TO LAND INSIDE THE VPN ALLOWLIST.
 *
 * crm.easyfix.in is gated at the AWS ALB by source IP, with an explicit bypass
 * for /public/*, /_next/* and /api/public/*. A customer scanning a technician's
 * card is BY DEFINITION off-VPN, so a link on any other host or path is a 403
 * in their hand — the feature would look built and be unreachable in the field.
 * These assertions are the only thing standing between that and a shipped QR.
 */
test('the QR URL is absolute, on the CRM origin, and inside the /api/public allowlist', () => {
  const saved = [process.env.CRM_PUBLIC_BASE_URL, process.env.MAGIC_LINK_BASE_URL];
  try {
    delete process.env.CRM_PUBLIC_BASE_URL;
    delete process.env.MAGIC_LINK_BASE_URL;
    const url = verification.verifyUrlFor(EFR_ID);

    // Absolute — a relative path in a QR is simply unscannable, so the prod
    // origin is hardcoded as the last fallback rather than left empty.
    assert.match(url, /^https:\/\//);
    assert.match(url, /^https:\/\/crm\.easyfix\.in\//);
    assert.match(url, /\/api\/public\/verify-technician\//);
    assert.doesNotMatch(url, /backend\.easyfix\.in/,
      'the backend origin is not in the CRM VPN allowlist');
    assert.equal(url.endsWith(verification.tokenFor(EFR_ID)), true);

    // Per-environment override, so a QA card never points at prod.
    process.env.MAGIC_LINK_BASE_URL = 'https://qa.crm.easyfix.in';
    assert.match(verification.verifyUrlFor(EFR_ID), /^https:\/\/qa\.crm\.easyfix\.in\/api\/public\//);

    // CRM_PUBLIC_BASE_URL wins, and a trailing slash never doubles up.
    process.env.CRM_PUBLIC_BASE_URL = 'https://crm.example.com/';
    assert.match(verification.verifyUrlFor(EFR_ID), /^https:\/\/crm\.example\.com\/api\/public\//);
  } finally {
    [process.env.CRM_PUBLIC_BASE_URL, process.env.MAGIC_LINK_BASE_URL] = saved;
    if (saved[0] === undefined) delete process.env.CRM_PUBLIC_BASE_URL;
    if (saved[1] === undefined) delete process.env.MAGIC_LINK_BASE_URL;
  }
});

test('a forged or tampered token is rejected', () => {
  const token = verification.tokenFor(EFR_ID);

  // Flip one character of the signature.
  const tampered = (token.slice(0, 31)) + (token[31] === 'A' ? 'B' : 'A');
  assert.equal(verification.efrIdFromToken(tampered), null);

  // A hand-built token carrying a real id but no valid MAC.
  const forged = Buffer.concat([
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(EFR_ID); return b; })(),
    Buffer.alloc(20, 0),
  ]).toString('base64url');
  assert.equal(verification.efrIdFromToken(forged), null);

  for (const junk of ['', 'EF-4471', '4471', 'x'.repeat(32), 'a'.repeat(31), 'a'.repeat(33)]) {
    assert.equal(verification.efrIdFromToken(junk), null, `accepted junk: ${junk}`);
  }
});

/* ──────────────────────────── the live verdict ─────────────────────────── */

test('an active, verified technician reads as Verified', async () => {
  scenario.row = technician();
  const { status, html } = await scan(verification.tokenFor(EFR_ID));

  assert.equal(status, 200);
  assert.match(html, /Verified &amp; Currently Active/);
  assert.match(html, /Ravi Kumar/);
  assert.match(html, /EF-4471/);
  assert.match(html, /Bengaluru/);
});

/*
 * ⚠ THE FRAUD CASE. efr_status is STILL 1 on this row — only the lifecycle says
 * BLACKLISTED. Anything that reads one column would clear this person.
 */
test('a BLACKLISTED technician whose efr_status is still 1 reads as Not Authorised', async () => {
  scenario.row = technician({ lifecycle_status: 'BLACKLISTED', efr_status: 1 });
  const { status, html } = await scan(verification.tokenFor(EFR_ID));

  assert.equal(status, 200);
  assert.match(html, /Not Authorised/);
  assert.doesNotMatch(html, /Verified &amp; Currently Active/);
  // The status word itself must not reach the page: it is an employment
  // decision about a named person, and the scanner only needs "do not proceed".
  assert.doesNotMatch(html, /BLACKLISTED/i);
});

test('a deactivated technician reads as Not Authorised', async () => {
  scenario.row = technician({ lifecycle_status: 'INACTIVE', efr_status: 0 });
  const { html } = await scan(verification.tokenFor(EFR_ID));
  assert.match(html, /Not Authorised/);
});

test('an unverified technician is not passed off as verified', async () => {
  scenario.row = technician({ is_technician_verified: 0 });
  const { html } = await scan(verification.tokenFor(EFR_ID));
  assert.match(html, /Not Authorised/);
});

/* ───────────────────────── enumeration + leakage ───────────────────────── */

test('an unknown technician and a forged token render the SAME page', async () => {
  scenario.row = null;                       // token is valid, row is gone
  const missing = await scan(verification.tokenFor(EFR_ID));
  const forged = await scan('A'.repeat(32));

  assert.equal(missing.status, 200);
  assert.equal(forged.status, 200);
  assert.equal(missing.html, forged.html, 'the difference would reveal which ids exist');
  assert.match(missing.html, /Could Not Be Verified/);
});

test('the page never carries mobile, Aadhaar, or a lifecycle reason', async () => {
  scenario.row = technician({
    efr_no: '9812345678',
    adhaar_card_number: '123456789012',
    lifecycle_reason: 'Repeated customer complaints — internal RCA #4471',
  });
  const { html } = await scan(verification.tokenFor(EFR_ID));

  assert.doesNotMatch(html, /9812345678/);
  assert.doesNotMatch(html, /123456789012/);
  /*
   * Word-boundaried on purpose. A bare /RCA/i matched "uppe(rca)se" in the
   * page's own stylesheet — a 3-letter token inside an unrelated word, which
   * would have read as a PII leak that was never there.
   */
  assert.doesNotMatch(html, /\bRCA\b/);
  assert.doesNotMatch(html, /\bcomplaints\b/i);
  assert.doesNotMatch(html, /internal RCA #\d+/i);
});

test('a technician name containing HTML is escaped, not rendered', async () => {
  scenario.row = technician({ efr_name: '<img src=x onerror=alert(1)>Ravi' });
  const { html } = await scan(verification.tokenFor(EFR_ID));

  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test('the verdict is never cached — it is only true for the instant it was read', async () => {
  scenario.row = technician();
  const res = await realFetch(`${baseUrl}/verify-technician/${verification.tokenFor(EFR_ID)}`);
  assert.match(String(res.headers.get('cache-control')), /no-store/);
});
