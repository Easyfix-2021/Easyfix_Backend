/*
 * Resolution branches for a stored tbl_job_image value.
 *
 * These assertions could not exist before 2026-09-10: the chain lived inline in
 * the /images/:imageId/file handler, so exercising it needed a request, a pool
 * and a scope guard. Extracting it to services/job-image-delivery.js is what
 * made the branches reachable — and the extraction happened because a SECOND
 * route (/url) now has to resolve identically.
 *
 * S3 is stubbed OFF so these cover the URL branches, which is where the
 * production bugs were: an unverified legacy redirect (ERR_BLOCKED_BY_ORB) and
 * the open-redirect guard.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Stub S3 BEFORE the module under test requires it, so no AWS client is built
// and the S3 branch is skipped deterministically.
const s3Path = require.resolve(path.join(ROOT, 'utils/s3-storage.js'));
require.cache[s3Path] = {
  id: s3Path, filename: s3Path, loaded: true,
  exports: { isEnabled: () => false, exists: async () => false, getPresignedUrl: async () => 'unused' },
};

const delivery = require(path.join(ROOT, 'services/job-image-delivery.js'));

// Deterministic fetch stub — the real HEAD is a network call.
const realFetch = global.fetch;
function stubFetch(impl) { global.fetch = impl; }
test.after(() => { global.fetch = realFetch; });

function fetchByPath(okPaths) {
  return (url) => {
    const hit = okPaths.some((p) => String(url).includes(p));
    return Promise.resolve(hit
      ? { ok: true, status: 200, headers: new Map([['content-type', 'image/jpeg']]) }
      : { ok: false, status: 404, headers: new Map([['content-type', 'text/html']]) });
  };
}

const HTML_404 = () => Promise.resolve({ ok: false, status: 404, headers: new Map([['content-type', 'text/html; charset=iso-8859-1']]) });
const IMAGE_200 = () => Promise.resolve({ ok: true, status: 200, headers: new Map([['content-type', 'image/jpeg']]) });
// `new Map()` has .get, which is all legacyUrlHasImage uses.

test('an allowlisted legacy URL whose file EXISTS is served', async () => {
  process.env.LEGACY_FILE_HOSTS = 'core.easyfix.in';
  stubFetch(IMAGE_200);
  const r = await delivery.resolve('http://core.easyfix.in/easydoc/upload_jobs/538390_checkin_x.jpg');
  assert.equal(r.kind, 'legacy');
  assert.ok(r.url.startsWith('https://'), 'must be https-upgraded — a browser blocks http images on an https page');
});

test('an allowlisted legacy URL whose file is MISSING is refused, not redirected', async () => {
  process.env.LEGACY_FILE_HOSTS = 'core.easyfix.in';
  stubFetch(HTML_404);
  const r = await delivery.resolve('http://core.easyfix.in/easydoc/upload_jobs/530707_gone.jpg');
  assert.equal(r.kind, 'none', 'redirecting here hands the browser an HTML error page — ORB blocks it and the operator sees no reason');
  assert.match(r.reason, /legacy host has no image/);
});

test('a HEAD that FAILS is not evidence of absence — still served', async () => {
  process.env.LEGACY_FILE_HOSTS = 'core.easyfix.in';
  stubFetch(() => Promise.reject(Object.assign(new Error('boom'), { name: 'TimeoutError' })));
  const r = await delivery.resolve('http://core.easyfix.in/easydoc/upload_jobs/x.jpg');
  assert.equal(r.kind, 'legacy', 'a network fault must not hide a file that is really there');
});

test('an absolute URL on a NON-allowlisted host is never redirected to', async () => {
  process.env.LEGACY_FILE_HOSTS = 'core.easyfix.in';
  let called = false;
  stubFetch(() => { called = true; return IMAGE_200(); });
  const r = await delivery.resolve('https://evil.example.com/steal.jpg');
  assert.equal(r.kind, 'none', 'this value comes from a DB column — redirecting anywhere is an open redirect');
  assert.equal(called, false, 'must not even contact a non-allowlisted host');
});

test('an absolute FILE_BASE_URL is used for a bare filename', async () => {
  process.env.LEGACY_FILE_HOSTS = 'core.easyfix.in';
  process.env.FILE_BASE_URL = 'https://files.example.com/easydoc';
  const r = await delivery.resolve('somefile.jpg');
  assert.equal(r.kind, 'base-url');
  assert.equal(r.url, 'https://files.example.com/easydoc/upload_jobs/somefile.jpg');
  delete process.env.FILE_BASE_URL;
});

test('a RELATIVE FILE_BASE_URL is never used as a redirect base', async () => {
  // It would bounce back to this backend, which serves no static files.
  // Asserted TWO ways, because "kind is not base-url" is the real claim and a
  // bare `=== none` hid it: with the legacy fallback finding nothing the answer
  // is none, and with it finding the file the answer is legacy — never
  // base-url either way. This test previously passed only because it inherited
  // another test's fetch stub.
  process.env.LEGACY_FILE_HOSTS = 'core.easyfix.in';
  process.env.FILE_BASE_URL = '/easydoc';

  stubFetch(fetchByPath([]));            // nothing on the legacy host
  const missing = await delivery.resolve('somefile.jpg');
  assert.equal(missing.kind, 'none');

  stubFetch(fetchByPath(['/upload_jobs/']));   // the file IS on the legacy host
  const found = await delivery.resolve('somefile.jpg');
  assert.equal(found.kind, 'legacy', 'the fallback should serve it');
  assert.ok(!found.url.startsWith('/easydoc'), 'a relative base must never become the redirect target');

  delete process.env.FILE_BASE_URL;
});

test('a bare-filename VIDEO on the legacy host is served, not refused for its content-type', async () => {
  // Job 545900 (2026-09-30): the legacy uploader stored `…_4.mp4` beside four
  // .jpg rows. The host answered 200 video/mp4, but the probe accepted only
  // image/* and PDF, so the "Play video" tile 404'd while the file was there.
  process.env.LEGACY_FILE_HOSTS = 'core.easyfix.in';
  stubFetch((url) => Promise.resolve(String(url).includes('/upload_jobs/')
    ? { ok: true, status: 200, headers: new Map([['content-type', 'video/mp4']]) }
    : { ok: false, status: 404, headers: new Map([['content-type', 'text/html']]) }));
  const r = await delivery.resolve('545900_20260930132025_4.mp4');
  assert.equal(r.kind, 'legacy');
  assert.match(r.url, /\/upload_jobs\/545900_20260930132025_4\.mp4$/);

  const stored = await delivery.resolve('https://core.easyfix.in/easydoc/upload_jobs/clip.mp4');
  assert.equal(stored.kind, 'legacy', 'the stored-URL branch must accept video too');
});

test('an empty stored value resolves to nothing', async () => {
  const r = await delivery.resolve('   ');
  assert.equal(r.kind, 'none');
});

test('positive control: the resolver CAN return legacy, so the refusals above are real', async () => {
  process.env.LEGACY_FILE_HOSTS = 'core.easyfix.in';
  stubFetch(IMAGE_200);
  const r = await delivery.resolve('https://core.easyfix.in/easydoc/upload_jobs/ok.jpg');
  assert.equal(r.kind, 'legacy', 'if this failed, every assertion above would pass for the wrong reason');
});

// ── Bare filename on the legacy host ────────────────────────────────
// The gap behind job 530707: seven tiles reading "Image not found" while every
// file was present and returning 200. Rows store a plain name, not a URL, and
// production's FILE_BASE_URL is the RELATIVE "/easydoc", so neither
// absolute-URL branch fired and nothing looked on the host holding the file.

test('a bare filename is found in upload_jobs', async () => {
  process.env.LEGACY_FILE_HOSTS = 'core.easyfix.in';
  process.env.FILE_BASE_URL = '/easydoc';
  stubFetch(fetchByPath(['/upload_jobs/']));
  const r = await delivery.resolve('530707_checkin_20260822144344.jpg');
  assert.equal(r.kind, 'legacy');
  assert.match(r.url, /\/easydoc\/upload_jobs\/530707_checkin_20260822144344\.jpg$/);
  delete process.env.FILE_BASE_URL;
});

test('a file present ONLY in feedback_jobs is still found — both directories are tried', async () => {
  process.env.LEGACY_FILE_HOSTS = 'core.easyfix.in';
  process.env.FILE_BASE_URL = '/easydoc';
  stubFetch(fetchByPath(['/feedback_jobs/']));
  const r = await delivery.resolve('feedback530707.pdf');
  assert.equal(r.kind, 'legacy', 'one hardcoded directory would restore the images and leave the PDF broken');
  assert.match(r.url, /\/feedback_jobs\/feedback530707\.pdf$/);
  delete process.env.FILE_BASE_URL;
});

test('a bare filename in NO legacy directory resolves to nothing', async () => {
  process.env.LEGACY_FILE_HOSTS = 'core.easyfix.in';
  process.env.FILE_BASE_URL = '/easydoc';
  stubFetch(fetchByPath([]));
  const r = await delivery.resolve('530707_never_existed.jpg');
  assert.equal(r.kind, 'none');
  delete process.env.FILE_BASE_URL;
});

test('PROBING is strict: an unverifiable candidate is NOT accepted', async () => {
  // Opposite default to legacyUrlHasImage, deliberately. When VALIDATING a
  // stored URL a network fault must not hide a real file; when GUESSING a
  // directory it must not manufacture one — otherwise a timeout on the first
  // candidate redirects the browser to a URL nobody confirmed.
  process.env.LEGACY_FILE_HOSTS = 'core.easyfix.in';
  process.env.FILE_BASE_URL = '/easydoc';
  stubFetch(() => Promise.reject(Object.assign(new Error('down'), { name: 'TimeoutError' })));
  const r = await delivery.resolve('530707_checkin_x.jpg');
  assert.equal(r.kind, 'none', 'an unreachable host must not yield a redirect to an unconfirmed URL');
  delete process.env.FILE_BASE_URL;
});

test('resolveLegacyFile returns the verified legacy-host URL for a job-keyed PDF, else null', async () => {
  process.env.LEGACY_FILE_HOSTS = 'core.easyfix.in';
  delete process.env.FILE_BASE_URL;
  const seen = [];
  stubFetch((url) => {
    seen.push(String(url));
    return Promise.resolve(String(url).endsWith('/feedback_jobs/feedback530707.pdf')
      ? { ok: true, status: 200, headers: new Map([['content-type', 'application/pdf']]) }
      : { ok: false, status: 404, headers: new Map([['content-type', 'text/html']]) });
  });
  assert.equal(
    await delivery.resolveLegacyFile('feedback_jobs', 'feedback530707.pdf'),
    'https://core.easyfix.in/easydoc/feedback_jobs/feedback530707.pdf',
  );
  assert.equal(await delivery.resolveLegacyFile('estimateapproval', 'Estimate_Approval_1.pdf'), null,
    'an HTML 404 must never become a link');
  assert.ok(seen.includes('https://core.easyfix.in/easydoc/estimateapproval/Estimate_Approval_1.pdf'),
    'positive control: the null came from probing the right path, not from skipping it');
});
