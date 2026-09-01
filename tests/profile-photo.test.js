/*
 * Profile photo — /api/profile/photo.
 *
 * Covers the six things that make this endpoint safe rather than merely
 * working, because every one of them fails SILENTLY if it regresses:
 *
 *   1. the file type is decided by the BYTES, not by the uploader's claim
 *   2. the size cap is enforced by Multer, before the buffer is allocated
 *   3. the user id comes from the token and can never come from the request
 *   4. replacing a photo deletes the object it replaced
 *   5. deleting clears the column to NULL and removes the object
 *   6. "no photo" is a 404, not a 500 and not an empty 200
 *
 * Nothing here touches a real DB or a real bucket: the mysql2 pool is the
 * repo's fake-pool harness, and utils/s3-storage is monkeypatched on its
 * namespace (the service calls `s3.putAtKey(...)`, never a destructured
 * reference, precisely so this seam exists).
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const express = require('express');

const { installFakePool } = require('./helpers/fake-pool');
const { migrationPath, readMigration } = require('./helpers/migration-file');

const s3 = require('../utils/s3-storage');

const MIGRATION = '2026-09-01-hrms-05-profile-photo.sql';

// ─── Fixtures: the smallest byte strings that ARE (or are not) each type ──
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const pngBytes = () => Buffer.concat([PNG_SIG, Buffer.alloc(64, 0x11)]);
const jpegBytes = () => Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(64, 0x22)]);
const webpBytes = () => Buffer.concat([
  Buffer.from('RIFF', 'latin1'), Buffer.from([0x40, 0, 0, 0]),
  Buffer.from('WEBP', 'latin1'), Buffer.alloc(64, 0x33),
]);
// A PDF. Every byte of it says "not an image"; only the declared MIME will lie.
const pdfBytes = () => Buffer.concat([Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1'), Buffer.alloc(64, 0x44)]);

const JWT_USER_ID = 4242;
const OTHER_USER_ID = 999;

let server;
let baseUrl;
let fake;
let principal;         // what the stubbed requireAuth puts on req.user
let storedKey;         // what the SELECT reports as the caller's current key
let events;            // ordered log of db + s3 side effects
let s3Original;

const AUTH_PATH = require.resolve('../middleware/auth');

before(async () => {
  /*
   * Stub requireAuth by seeding the module cache BEFORE the router requires it.
   * The router applies the middleware itself (`router.use(requireAuth)`), so
   * there is no other seam — and going through a real JWT would test
   * middleware/auth, which has its own tests, rather than this surface.
   */
  require.cache[AUTH_PATH] = {
    id: AUTH_PATH,
    filename: AUTH_PATH,
    loaded: true,
    exports: (req, _res, next) => { req.user = principal; next(); },
  };

  fake = installFakePool([
    [/SELECT profile_image_key/i, () => (storedKey ? [{ profile_image_key: storedKey }] : [])],
    [/INSERT INTO tbl_user_personal_details/i, (_sql, params) => {
      events.push({ op: 'db:upsert', params });
      return { affectedRows: 1 };
    }],
    [/UPDATE tbl_user_personal_details/i, (_sql, params) => {
      events.push({ op: 'db:clear', params });
      return { affectedRows: 1 };
    }],
  ]);

  s3Original = {
    isEnabled: s3.isEnabled,
    putAtKey: s3.putAtKey,
    getPresignedUrl: s3.getPresignedUrl,
    deleteObject: s3.deleteObject,
  };
  s3.isEnabled = () => true;
  s3.putAtKey = async (args) => { events.push({ op: 's3:put', ...args }); return args.key; };
  s3.getPresignedUrl = async (key) => `https://bucket.example/${key}?X-Amz-Expires=300`;
  s3.deleteObject = async (key) => { events.push({ op: 's3:delete', key }); return { deleted: true }; };

  // eslint-disable-next-line global-require
  const router = require('../routes/profile-photo');
  const app = express();
  app.use('/profile', router);
  // eslint-disable-next-line no-unused-vars
  app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  Object.assign(s3, s3Original);
  if (fake) fake.restore();
  delete require.cache[AUTH_PATH];
  if (server) await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  principal = { user_id: String(JWT_USER_ID), role: 2, __principal: 'admin' };
  storedKey = null;
  events = [];
  fake.reset();
});

// ─── Helpers ─────────────────────────────────────────────────────────
async function postPhoto(bytes, declaredType, { extra = {}, query = '' } = {}) {
  const form = new FormData();
  form.append('photo', new Blob([bytes], { type: declaredType }), 'avatar.png');
  for (const [k, v] of Object.entries(extra)) form.append(k, String(v));
  const response = await fetch(`${baseUrl}/profile/photo${query}`, { method: 'POST', body: form });
  return { status: response.status, body: await response.json() };
}

async function call(method, path = '/profile/photo') {
  const response = await fetch(`${baseUrl}${path}`, { method });
  return { status: response.status, body: await response.json() };
}

const puts = () => events.filter((e) => e.op === 's3:put');
const deletes = () => events.filter((e) => e.op === 's3:delete');

// ─── 1. The bytes decide, not the uploader ───────────────────────────
test('a PDF announced as image/png is rejected on its magic bytes', async () => {
  const res = await postPhoto(pdfBytes(), 'image/png');

  assert.equal(res.status, 400);
  assert.equal(res.body.details.code, 'UNSUPPORTED_IMAGE');
  /*
   * The assertion that actually matters. A declared-MIME check (what the
   * neighbouring notice/upload routes do) passes this request: the part says
   * image/png, so the allowlist says yes. Only reading the file's own header
   * catches it — and if this ever regresses, the endpoint stores an arbitrary
   * payload and serves it back under `Content-Type: image/png`.
   */
  assert.equal(puts().length, 0, 'nothing may be written to S3 when the content is not an image');
});

test('a real PNG is stored under the SNIFFED content type', async () => {
  // Declared as octet-stream on purpose: the stored Content-Type must describe
  // the bytes, so it must not be copied from the part header in either direction.
  const res = await postPhoto(pngBytes(), 'application/octet-stream');

  assert.equal(res.status, 200);
  assert.equal(res.body.data.content_type, 'image/png');
  assert.equal(puts()[0].contentType, 'image/png');
  assert.match(puts()[0].key, /^ProfilePhotos\/u4242_\d+_[0-9a-f]{8}$/,
    'the key carries no file extension — the MIME rides on the object Content-Type');
});

test('sniffImageMime accepts exactly JPEG, PNG and WEBP', async () => {
  // eslint-disable-next-line global-require
  const { sniffImageMime } = require('../services/profile-photo.service');

  assert.equal(sniffImageMime(pngBytes()), 'image/png');
  assert.equal(sniffImageMime(jpegBytes()), 'image/jpeg');
  assert.equal(sniffImageMime(webpBytes()), 'image/webp');

  assert.equal(sniffImageMime(pdfBytes()), null);
  assert.equal(sniffImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null,
    'SVG is markup with a script surface, not one of the three raster types');
  assert.equal(sniffImageMime(Buffer.from('GIF89a' + 'x'.repeat(32), 'latin1')), null,
    'GIF is deliberately outside the allowlist');

  // A PNG whose signature was mangled by a text-mode transfer: the first four
  // bytes still read as PNG, the CR/LF/EOF guard bytes do not. Checking only
  // `89 50 4E 47` would wave this through as a valid PNG.
  const mangled = Buffer.concat([PNG_SIG, Buffer.alloc(32)]);
  mangled[4] = 0x0A;
  assert.equal(sniffImageMime(mangled), null, 'the PNG signature is checked in full');

  // A RIFF container that is not WEBP (e.g. a WAV) must not pass as an image.
  const wav = Buffer.concat([
    Buffer.from('RIFF', 'latin1'), Buffer.from([0x40, 0, 0, 0]),
    Buffer.from('WAVE', 'latin1'), Buffer.alloc(32),
  ]);
  assert.equal(sniffImageMime(wav), null, 'the RIFF form type is checked, not just the container');

  assert.equal(sniffImageMime(Buffer.from([0xFF, 0xD8])), null, 'a buffer too short to identify is not an image');
  assert.equal(sniffImageMime(null), null);
});

// ─── 2. The size cap ─────────────────────────────────────────────────
test('the size cap is enforced by Multer, before the handler sees anything', async () => {
  // eslint-disable-next-line global-require
  const { MAX_PHOTO_BYTES } = require('../services/profile-photo.service');
  const oversize = Buffer.concat([PNG_SIG, Buffer.alloc(MAX_PHOTO_BYTES + 1024, 0x11)]);

  const res = await postPhoto(oversize, 'image/png');

  assert.equal(res.status, 400, 'an oversized upload is a bad request, not a 500');
  assert.equal(res.body.details.code, 'LIMIT_FILE_SIZE');
  assert.match(res.body.error, /5 MB or smaller/);
  assert.equal(puts().length, 0);
  /*
   * LIMIT_FILE_SIZE is raised by Multer's own stream, which reports it through
   * next(err) from inside its middleware — a try/catch in the handler can never
   * see it. Getting a 400 here (rather than the 500 that error would otherwise
   * become) is what proves the routes/mobile/kyc.js-style wrapper is in place.
   */
});

test('a valid image just under the cap is accepted', async () => {
  // eslint-disable-next-line global-require
  const { MAX_PHOTO_BYTES } = require('../services/profile-photo.service');
  const big = Buffer.concat([PNG_SIG, Buffer.alloc(MAX_PHOTO_BYTES - PNG_SIG.length - 1024, 0x11)]);

  const res = await postPhoto(big, 'image/png');
  assert.equal(res.status, 200, 'the cap must not be off-by-one against legitimate photos');
});

// ─── 3. The id comes from the token, and only from the token ─────────
test('the photo is bound to the JWT subject, not to anything in the request', async () => {
  const res = await postPhoto(pngBytes(), 'image/png', {
    extra: { userId: OTHER_USER_ID, user_id: OTHER_USER_ID },
    query: `?userId=${OTHER_USER_ID}`,
  });

  assert.equal(res.status, 200);
  const upsert = events.find((e) => e.op === 'db:upsert');
  assert.equal(upsert.params[0], JWT_USER_ID,
    'the row written must be the token holder’s, whatever the request claims');
  assert.ok(!JSON.stringify(events).includes(String(OTHER_USER_ID)),
    'no id supplied by the caller may reach the DB or the S3 key');
});

test('a technician bearer cannot reach this CRM-only surface', async () => {
  // requireAuth also resolves efr bearers; their user_id is the STRING 'efr:12',
  // which Number() turns into NaN. Unguarded, that writes a row belonging to
  // nobody — so this surface must refuse them outright.
  principal = { user_id: 'efr:12', __principal: 'mobile' };
  const res = await postPhoto(pngBytes(), 'image/png');
  assert.equal(res.status, 403);
  assert.equal(puts().length, 0);
});

test('no route on this surface accepts a user id in the path, body or query', async () => {
  const src = fs.readFileSync(require.resolve('../routes/profile-photo'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // A structural check to complement the runtime one above: the runtime test
  // proves TODAY's handlers ignore a supplied id; this fails the moment someone
  // adds `/:userId` or reads one out of the request, which is the change that
  // would turn this endpoint into an any-user photo writer.
  assert.doesNotMatch(code, /router\.(get|post|delete|put|patch)\([^)]*:\w*[Uu]ser/,
    'no :userId (or similar) may appear in a route path here');
  assert.doesNotMatch(code, /req\.(params|query|body)[.[]\s*['"]?\w*[Uu]ser/,
    'no handler may read a user id out of the request');
});

// ─── 4. Replace deletes the object it replaced ───────────────────────
test('replacing a photo deletes the previous S3 object', async () => {
  storedKey = 'ProfilePhotos/u4242_1756000000000_deadbeef';

  const res = await postPhoto(pngBytes(), 'image/png');
  assert.equal(res.status, 200);

  assert.deepEqual(deletes().map((e) => e.key), [storedKey],
    'without this every re-upload strands one object in the bucket forever');
  assert.notEqual(puts()[0].key, storedKey, 'the replacement gets a fresh key');
});

test('the old object is deleted only AFTER the column stops pointing at it', async () => {
  storedKey = 'ProfilePhotos/u4242_1756000000000_deadbeef';
  await postPhoto(pngBytes(), 'image/png');

  const order = events.map((e) => e.op);
  assert.deepEqual(order, ['s3:put', 'db:upsert', 's3:delete'],
    'deleting before the UPDATE lands leaves the column pointing at bytes that are gone');
});

test('a first upload deletes nothing', async () => {
  storedKey = null;
  await postPhoto(pngBytes(), 'image/png');
  assert.equal(deletes().length, 0);
});

// ─── 5. Delete clears the column ─────────────────────────────────────
test('DELETE clears the column to NULL and removes the object', async () => {
  storedKey = 'ProfilePhotos/u4242_1756000000000_deadbeef';

  const res = await call('DELETE');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { removed: true });

  const cleared = fake.calls.find((c) => /UPDATE tbl_user_personal_details/i.test(c.sql));
  assert.match(cleared.sql, /profile_image_key\s*=\s*NULL/i,
    'NULL, never \'\' — one representation of "no photo" so no reader has to handle both');
  assert.deepEqual(deletes().map((e) => e.key), [storedKey]);
  assert.deepEqual(events.map((e) => e.op), ['db:clear', 's3:delete'],
    'clear the pointer first; an orphan beats a dangling key');
});

// ─── 6. "No photo" is a clean 404 ────────────────────────────────────
test('GET with no photo set is a clean 404, not a 500', async () => {
  storedKey = null;
  const res = await call('GET');

  assert.equal(res.status, 404, 'a user who has never set a photo is a normal state');
  assert.equal(res.body.details.code, 'NO_PROFILE_PHOTO');
  assert.equal(res.body.success, false);
});

test('DELETE with no photo set is a clean 404, not a 500', async () => {
  storedKey = null;
  const res = await call('DELETE');

  assert.equal(res.status, 404);
  assert.equal(res.body.details.code, 'NO_PROFILE_PHOTO');
  assert.equal(events.length, 0, 'nothing is written or deleted for a photo that never existed');
});

test('GET returns a presigned URL for the stored key', async () => {
  storedKey = 'ProfilePhotos/u4242_1756000000000_deadbeef';
  const res = await call('GET');

  assert.equal(res.status, 200);
  assert.equal(res.body.data.key, storedKey);
  assert.match(res.body.data.url, /^https:\/\/bucket\.example\/ProfilePhotos\//);
});

test('an empty POST is a 400 naming the field', async () => {
  const response = await fetch(`${baseUrl}/profile/photo`, { method: 'POST', body: new FormData() });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /photo/);
});

// ─── The migration ───────────────────────────────────────────────────
test('the migration adds one guarded column to the side table and never touches tbl_user', () => {
  // Resolved through the shared helper so this still passes on the day the file
  // moves to migrations/executed/ — see tests/helpers/migration-file.js.
  assert.ok(migrationPath(MIGRATION));
  /*
   * SCAN THE STATEMENTS, NOT THE PROSE. The first version of this test read the
   * raw file and failed on the migration's own comment explaining why
   * `ADD COLUMN IF NOT EXISTS` is not used — a guard flagging the note that
   * forbids the very thing it guards against. Any text-scanning check over a
   * documented artefact has to strip the documentation first.
   */
  const sql = readMigration(MIGRATION).replace(/^\s*--.*$/gm, '');

  assert.match(sql, /ADD COLUMN profile_image_key VARCHAR\(255\) NULL/i);
  assert.match(sql, /information_schema\.columns/i, 'the ADD must be probe-guarded so a re-run is a no-op');
  assert.doesNotMatch(sql, /ADD COLUMN IF NOT EXISTS/i, 'MariaDB-only syntax; this is MySQL');

  const alters = sql.match(/ALTER TABLE\s+(\w+)/gi) || [];
  assert.deepEqual([...new Set(alters.map((a) => a.split(/\s+/)[2]))], ['tbl_user_personal_details'],
    'tbl_user is shared by five legacy services and must never be altered');

  // hrms-01 defines and DROPs its own procedure; a shared name would let one
  // file drop the other's mid-run when both are applied in the same session.
  assert.doesNotMatch(sql, /_ensure_hrms_personal_detail_columns/,
    'the procedure name must be unique to this file');
});
