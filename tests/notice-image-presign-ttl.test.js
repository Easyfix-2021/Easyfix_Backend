/*
 * Regression guard for the notice-image presign TTL.
 *
 * THE BUG (production, 2026-08-14). A notice attachment rendered as a broken
 * image. S3's own error body named it exactly:
 *
 *   <Code>AccessDenied</Code><Message>Request has expired</Message>
 *   <Expires>2026-08-14T05:25:12Z</Expires>
 *
 * Not permissions, not a missing object, not the signature — the URL simply
 * timed out. Every other presign in this codebase is minted for something the
 * user is about to click, so 300s is ample. Notice image URLs are different:
 * they are embedded in the /admin/notices/active payload, and the CRM's
 * NoticeFlash copies that into React state and deliberately does not refresh a
 * card the operator is already reading. The URL therefore starts ageing on
 * dashboard load and may not be requested until the operator has scrolled
 * through a long notice — or worked down a queue of several.
 *
 * WHAT THIS PINS, and why both halves matter: notice images get the longer
 * TTL, AND nothing else does. Widening the shared PRESIGN_TTL_SEC would have
 * been the one-line fix, but it is read by 23 call sites including client
 * documents and job supporting files — those carry PII and their short window
 * is a deliberate posture. A future "simplification" that collapses the two
 * constants back together would reintroduce that quietly, so the second test
 * fails loudly if the default ever drifts.
 *
 * Signing is purely local (no network, no real bucket), so dummy credentials
 * are enough and this test touches nothing outside the process.
 *
 * Runner: `node --test`.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const SVC_PATH = '../utils/s3-storage';
const saved = {};
const ENV_KEYS = [
  'S3_BUCKET_NAME', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
  'S3_PRESIGN_TTL_SEC', 'S3_NOTICE_PRESIGN_TTL_SEC',
];

let s3;

before(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  // A bucket name is what flips isEnabled(); the credentials only have to be
  // well-formed for the signer, which never leaves the process.
  process.env.S3_BUCKET_NAME = 'test-bucket-not-real';
  process.env.AWS_REGION = 'ap-south-1';
  process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
  process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  delete process.env.S3_PRESIGN_TTL_SEC;          // exercise the DEFAULTS,
  delete process.env.S3_NOTICE_PRESIGN_TTL_SEC;   // not this machine's config
  delete require.cache[require.resolve(SVC_PATH)];
  s3 = require(SVC_PATH);
});

after(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  delete require.cache[require.resolve(SVC_PATH)];
});

const expiresOf = (url) => Number((String(url).match(/X-Amz-Expires=(\d+)/) || [])[1]);

test('a notice image URL outlives a reading session, not just a click', async () => {
  const url = await s3.resolveNoticeImageUrl('Notices/1786622319544_8896cf94');
  const ttl = expiresOf(url);

  assert.ok(ttl >= 1800,
    `notice presigns must outlive a reading session; got ${ttl}s. At 300s these `
    + 'expired before the operator scrolled to the attachment.');
  assert.equal(ttl, 3600, 'the documented default is 1 hour');
});

test('every OTHER presign keeps the short default — the PII posture is untouched', async () => {
  /*
   * The negative half. Raising the shared PRESIGN_TTL_SEC would also have made
   * the first test pass, while quietly extending the window on client documents
   * and job supporting files. This is what stops that.
   */
  const url = await s3.getPresignedUrl('JobSupportings/whatever');
  assert.equal(expiresOf(url), 300,
    'the shared default must stay at 5 minutes — it covers PII-bearing documents');
});

test('the notice TTL is env-overridable without touching the shared default', async () => {
  process.env.S3_NOTICE_PRESIGN_TTL_SEC = '900';
  delete require.cache[require.resolve(SVC_PATH)];
  const fresh = require(SVC_PATH);

  assert.equal(expiresOf(await fresh.resolveNoticeImageUrl('Notices/x')), 900,
    'ops can tune this per environment');
  assert.equal(expiresOf(await fresh.getPresignedUrl('JobSupportings/y')), 300,
    'and tuning it must not move the shared one');

  delete process.env.S3_NOTICE_PRESIGN_TTL_SEC;
  delete require.cache[require.resolve(SVC_PATH)];
});
