/*
 * Manage Users list — the photo_url column.
 *
 * WHAT THIS PINS
 * ──────────────
 *   1. A user WITH a profile_image_key gets a presigned URL.
 *   2. A user WITHOUT one gets null — not '', not a placeholder image URL.
 *      null is what the CRM reads as "render the initials monogram", so a
 *      broken <img> and "no photo set" must not collapse into each other.
 *   3. S3 NOT CONFIGURED (isEnabled() false — a supported local-dev state)
 *      yields null for EVERY row and never calls the signer. getPresignedUrl
 *      throws "S3 is not configured" on such a host, and Manage Users is an
 *      operator's core screen: an object-store problem must cost the avatar
 *      column and nothing else.
 *   4. NO N+1 — one statement for the whole page. The key lives on the same
 *      tbl_user_personal_details row the personal-email loader already reads,
 *      so the column is free; per-row profile-photo.service.getPhoto() would
 *      have been one DB read plus one presign each.
 *   5. The COUNT query gains no join and no new alias, so it stays identical
 *      to the main query's WHERE. (A LEFT JOIN with a predicate over it would
 *      have 500-ed the count on an unknown alias — the jobs-list failure mode.)
 *   6. The presign is minted for an HOUR, not the shared 5-minute default.
 *      Manage Users holds its rows in React state and only refetches on a
 *      filter/sort/page change, so at 300s an operator reading the grid for
 *      six minutes gets a wall of 403 "Request has expired" avatars — measured
 *      on the structurally identical notice payload in production 2026-08-14.
 *
 * NO DB, NO NETWORK, NO BUCKET: the mysql2 pool is replaced by
 * tests/helpers/fake-pool, and utils/s3-storage is stubbed on the module
 * object (user.service calls s3.isEnabled() / s3.getPresignedUrl() through it,
 * so the stub is what runs). Nothing is written anywhere.
 * Runner: `node --test`.
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

// ── Fake DB ───────────────────────────────────────────────────────────────
// Two users: 601 has a photo, 602 does not.
const USER_ROWS = [
  { user_id: 601, user_code: 'E000601', user_name: 'With Photo',    user_status: 1 },
  { user_id: 602, user_code: 'E000602', user_name: 'Without Photo', user_status: 1 },
];

// The side-table rows as MySQL returns them: 602 is simply absent (no row at
// all is the common case), and a present row can still carry a NULL key.
let detailRows = [
  { user_id: 601, personal_email: 'a@gmail.com', profile_image_key: 'Profile_Photos/601_abc123' },
];

const ROUTES = [
  // Must precede the tbl_user routes — "tbl_user_personal_details" is a
  // substring hazard against /FROM tbl_user/.
  [/FROM tbl_user_personal_details/i, () => detailRows],
  [/COUNT\(\*\)/i, [{ total: USER_ROWS.length }]],
  [/FROM tbl_user_allowed_stages/i, []],
  [/LIMIT \? OFFSET \?/i, () => USER_ROWS.map((r) => ({ ...r }))],
];

const fake = installFakePool(ROUTES);

// ── Fake S3 ───────────────────────────────────────────────────────────────
const s3 = require('../utils/s3-storage');
const realS3 = { isEnabled: s3.isEnabled, getPresignedUrl: s3.getPresignedUrl };
let s3Enabled = true;
const presigns = [];   // every (key, ttl) the service asked to sign

s3.isEnabled = () => s3Enabled;
s3.getPresignedUrl = async (key, ttl) => {
  presigns.push({ key, ttl });
  return `https://bucket.example/${key}?X-Amz-Expires=${ttl}`;
};

const userService = require('../services/user.service');

after(() => {
  fake.restore();
  Object.assign(s3, realS3);
});

beforeEach(() => {
  fake.reset();
  presigns.length = 0;
  s3Enabled = true;
  detailRows = [
    { user_id: 601, personal_email: 'a@gmail.com', profile_image_key: 'Profile_Photos/601_abc123' },
  ];
});

const byId = (items) => Object.fromEntries(items.map((r) => [r.user_id, r]));

// ── 1. The happy path, and the empty state next to it ─────────────────────

test('a row WITH a profile_image_key gets a presigned URL; a row without gets null', async () => {
  const { items } = await userService.listUsers({});
  const u = byId(items);

  assert.match(u[601].photo_url, /^https:\/\/bucket\.example\/Profile_Photos\/601_abc123\?/);
  assert.equal(u[602].photo_url, null,
    'null = render the initials monogram; never \'\' and never a placeholder image URL');
  assert.equal(presigns.length, 1, 'only the row that actually has a key is signed');
});

test('a present side-table row with a NULL key is the same empty state as no row at all', async () => {
  detailRows = [{ user_id: 601, personal_email: 'a@gmail.com', profile_image_key: null }];
  const { items } = await userService.listUsers({});
  assert.equal(byId(items)[601].photo_url, null);
  assert.equal(presigns.length, 0, 'NULL is the only spelling of "no photo" — no signing attempted');
});

// ── 2. Storage unconfigured must cost the column, not the screen ──────────

test('S3 DISABLED yields null for every row and never calls the signer', async () => {
  s3Enabled = false;
  const { items, total } = await userService.listUsers({});
  assert.equal(items.length, 2, 'the list still returns');
  assert.equal(total, 2);
  for (const r of items) assert.equal(r.photo_url, null);
  assert.equal(presigns.length, 0,
    'getPresignedUrl throws "S3 is not configured" on such a host — it must not be reached');
});

test('a transient signer failure degrades to null rather than 500-ing the list', async () => {
  s3.getPresignedUrl = async () => { throw new Error('signer exploded'); };
  try {
    const { items } = await userService.listUsers({});
    assert.equal(byId(items)[601].photo_url, null);
  } finally {
    s3.getPresignedUrl = async (key, ttl) => { presigns.push({ key, ttl }); return `https://bucket.example/${key}?ttl=${ttl}`; };
  }
});

// ── 3. Cost: one statement for the page, and an untouched COUNT ───────────

test('NO N+1 — the whole page costs ONE side-table statement', async () => {
  await userService.listUsers({});
  const reads = fake.calls.filter((c) => /tbl_user_personal_details/i.test(c.sql));
  assert.equal(reads.length, 1, 'batched IN (…) for the page, not a lookup per row');
  assert.match(reads[0].sql, /profile_image_key/, 'the key rides on the existing projection');
});

test('the avatar is NOT gated the way the home email address is', async () => {
  // includePersonalEmail defaults to false — the nine non-Admin admin-group
  // roles. They still get the face; they still do not get the home address.
  const row = byId((await userService.listUsers({})).items)[601];
  assert.ok(row.photo_url, 'photo_url ships to every admin-group role');
  assert.equal('personal_email' in row, false, '…and the email field stays behind its flag');
});

test('the COUNT query gains no join — it still reads tbl_user alone', async () => {
  await userService.listUsers({});
  const count = fake.calls.find((c) => /COUNT\(\*\)/i.test(c.sql));
  assert.ok(count, 'the count still runs');
  assert.equal(/tbl_user_personal_details/i.test(count.sql), false);
  assert.equal(/LEFT JOIN/i.test(count.sql), false,
    'a predicate over a joined alias the count does not carry is how the jobs list 500-ed');
});

// ── 4. The TTL, which is the whole reason this column is usable ───────────

test('avatars are signed for an HOUR, not the shared 5-minute default', async () => {
  await userService.listUsers({});
  assert.equal(presigns[0].ttl, 3600,
    'a grid left open past 300s would otherwise render 403 "Request has expired" for every avatar');
});
