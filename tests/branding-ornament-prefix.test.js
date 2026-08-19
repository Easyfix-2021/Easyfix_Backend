/*
 * Characterization tests for the ornament-key PREFIX GUARD in
 * services/branding.service.
 *
 * WHY THIS IS A SECURITY TEST, NOT A FORMATTING TEST
 *
 * `GET /api/public/branding/active` is deliberately UNAUTHENTICATED — the login
 * page has to render the right logo before any token exists. It presigns
 * whatever sits in `easyfix_theme_variant.ornament_key`. Without a prefix
 * guard, a row containing `easyfixer_documents/<aadhaar-scan>` turns that
 * endpoint into a presigned-URL oracle for the ENTIRE S3 bucket, reachable by
 * anyone who can load the login page.
 *
 * Joi pins the prefix on the write path, but rows can also arrive from a
 * migration, a support script, or a direct UPDATE — none of which pass through
 * a validator. So the resolver re-checks, and this file is what stops that
 * re-check being removed as redundant by someone reading only the Joi schema.
 *
 * The failure mode these pin is SILENT: an unguarded key still returns a
 * perfectly valid URL. Nothing errors, nothing logs at error level, and the
 * only symptom is that a private object became publicly fetchable.
 *
 * s3-storage AND db are stubbed through require.cache, so this needs no network,
 * no AWS config and no database. Stubbing db matters for more than isolation:
 * requiring the real one opens a mysql pool that keeps the event loop alive, so
 * `node --test` would hang forever instead of exiting — which in CI reads as a
 * timeout, not a failure. The real modules are restored afterwards so test order
 * cannot matter. Runner: `node --test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const S3_PATH = require.resolve('../utils/s3-storage');
const DB_PATH = require.resolve('../db');
const SERVICE_PATH = require.resolve('../services/branding.service');

/*
 * Loads branding.service against a stubbed s3 module. Both modules are dropped
 * from the cache first so each test gets a clean pairing rather than whatever a
 * previous require left behind.
 */
function loadWithS3Stub({ enabled = true, presign, throws = false, variantRows = [] } = {}) {
  const signed = [];
  const realS3 = require.cache[S3_PATH];
  const realDb = require.cache[DB_PATH];

  delete require.cache[S3_PATH];
  delete require.cache[DB_PATH];
  delete require.cache[SERVICE_PATH];

  /*
   * A pool that resolveOrnamentUrl never queries, but which must exist so the
   * module loads — and must NOT be the real one, which would hold the process
   * open. `variantRows` lets the getActiveVariant tests below feed it a row;
   * every other test leaves it empty and the stub behaves exactly as before.
   */
  require.cache[DB_PATH] = {
    id: DB_PATH,
    filename: DB_PATH,
    loaded: true,
    exports: { pool: { query: async () => [variantRows, []] } },
  };

  require.cache[S3_PATH] = {
    id: S3_PATH,
    filename: S3_PATH,
    loaded: true,
    exports: {
      isEnabled: () => enabled,
      async getPresignedUrl(key, expiresIn) {
        signed.push({ key, expiresIn });
        if (throws) throw new Error('object missing');
        return presign ? presign(key, expiresIn) : `https://s3.example/${key}?sig=x`;
      },
    },
  };

  const svc = require(SERVICE_PATH);
  const restore = () => {
    delete require.cache[S3_PATH];
    delete require.cache[DB_PATH];
    delete require.cache[SERVICE_PATH];
    if (realS3) require.cache[S3_PATH] = realS3;
    if (realDb) require.cache[DB_PATH] = realDb;
  };
  return { svc, signed, restore };
}

test('a Branding/ key is presigned', async () => {
  const { svc, signed, restore } = loadWithS3Stub();
  try {
    const url = await svc.resolveOrnamentUrl('Branding/diwali-2026.png');
    assert.match(url, /^https:\/\/s3\.example\/Branding\/diwali-2026\.png/);
    assert.equal(signed.length, 1);
  } finally { restore(); }
});

test('a key OUTSIDE Branding/ is never presigned — the S3-oracle guard', async () => {
  const { svc, signed, restore } = loadWithS3Stub();
  try {
    /*
     * Every one of these is a real prefix used elsewhere in this codebase, so
     * each represents an object that genuinely exists in the bucket and must
     * never become publicly fetchable through the branding route.
     */
    const hostile = [
      'easyfixer_documents/aadhaar-front.jpg',
      'ClientDocs/rate-card.pdf',
      'JobSupportings/invoice.pdf',
      'Notices/announcement.png',
      'Skills/plumbing.png',
    ];
    for (const key of hostile) {
      assert.equal(await svc.resolveOrnamentUrl(key), null, `must refuse ${key}`);
    }
    assert.equal(signed.length, 0, 'getPresignedUrl must not be reached at all');
  } finally { restore(); }
});

test('prefix matching is exact — no traversal, no near-miss, no case fold', async () => {
  const { svc, signed, restore } = loadWithS3Stub();
  try {
    const nearMisses = [
      'Branding-private/secret.png',   // hyphen, not a directory boundary
      'branding/lower.png',            // S3 keys are case-sensitive
      'x/Branding/nested.png',         // prefix present but not at the start
      '../Branding/escape.png',        // traversal-flavoured
    ];
    for (const key of nearMisses) {
      const out = await svc.resolveOrnamentUrl(key);
      assert.equal(out, null, `must refuse ${JSON.stringify(key)}`);
    }
    assert.equal(signed.length, 0);
  } finally { restore(); }
});

test('trim runs BEFORE the prefix check — normalising in, never bypassing out', async () => {
  const { svc, signed, restore } = loadWithS3Stub();
  try {
    /*
     * The ordering here is load-bearing and invisible in the code.
     *
     * Because the value is trimmed BEFORE the prefix test, surrounding
     * whitespace normalises a key INTO the guard: ' Branding/x.png' becomes a
     * legitimate 'Branding/x.png' and is signed as such. That is safe.
     *
     * Check-then-trim would have been the vulnerable ordering — a hostile key
     * could have been padded to dodge the comparison and then trimmed back to
     * something real before signing. This asserts both halves so the ordering
     * cannot be flipped by a future tidy-up.
     */
    const url = await svc.resolveOrnamentUrl('  Branding/padded.png  ');
    assert.match(url, /Branding\/padded\.png/);
    assert.equal(signed[0].key, 'Branding/padded.png', 'the SIGNED key is the trimmed one');

    // ...and padding a hostile key still does not get it through.
    assert.equal(await svc.resolveOrnamentUrl('  easyfixer_documents/aadhaar.jpg  '), null);
    assert.equal(signed.length, 1, 'the hostile key never reached the signer');
  } finally { restore(); }
});

test('empty, null and undefined resolve to null rather than throwing', async () => {
  const { svc, restore } = loadWithS3Stub();
  try {
    for (const v of [null, undefined, '', '   ']) {
      assert.equal(await svc.resolveOrnamentUrl(v), null);
    }
  } finally { restore(); }
});

test('a local /easydoc path passes through unsigned — the dev fallback', async () => {
  const { svc, signed, restore } = loadWithS3Stub({ enabled: false });
  try {
    // writeBuffer() hands back a relative URL when S3 is off; it is already
    // loadable and there is nothing to sign.
    assert.equal(await svc.resolveOrnamentUrl('/easydoc/general/x.png'), '/easydoc/general/x.png');
    assert.equal(signed.length, 0);
  } finally { restore(); }
});

test('S3 disabled yields null for a Branding/ key, not a broken URL', async () => {
  const { svc, restore } = loadWithS3Stub({ enabled: false });
  try {
    assert.equal(await svc.resolveOrnamentUrl('Branding/x.png'), null);
  } finally { restore(); }
});

test('a presign failure degrades to null — it must not 500 the login page', async () => {
  const { svc, restore } = loadWithS3Stub({ throws: true });
  try {
    // The login page renders for logged-OUT users. A missing object must cost
    // them an ornament, never an error page.
    assert.equal(await svc.resolveOrnamentUrl('Branding/gone.png'), null);
  } finally { restore(); }
});

test('expiresIn is passed through, and is undefined on the public path', async () => {
  const { svc, signed, restore } = loadWithS3Stub();
  try {
    await svc.resolveOrnamentUrl('Branding/a.png');
    assert.equal(signed[0].expiresIn, undefined,
      'the public login read must keep the short default TTL');

    await svc.resolveOrnamentUrl('Branding/b.png', svc.ORNAMENT_PREVIEW_TTL_SEC);
    assert.equal(signed[1].expiresIn, svc.ORNAMENT_PREVIEW_TTL_SEC,
      'the admin preview opts into the longer editing-session TTL');
    assert.ok(svc.ORNAMENT_PREVIEW_TTL_SEC > 300,
      'preview TTL must exceed the 300s default it exists to replace');
  } finally { restore(); }
});

test('ORNAMENT_PREFIX is exactly "Branding/" — trailing slash included', () => {
  const { svc, restore } = loadWithS3Stub();
  try {
    // Without the trailing slash, "Branding-private/…" would match as a prefix.
    assert.equal(svc.ORNAMENT_PREFIX, 'Branding/');
  } finally { restore(); }
});

/* ===========================================================================
 * RENDER MODE — 'overlay' (ornament over the lockup) vs 'replace' (the asset
 * IS the brand mark). Column added by
 * migrations/2026-08-18-branding-render-mode.sql.
 *
 * WHY THIS SITS IN THE PREFIX-GUARD FILE. The two features are coupled through
 * one fact: in 'replace' mode the ornament is the ONLY brand mark on the
 * unauthenticated login page. So the prefix guard refusing a key is no longer
 * just "no decoration" — it would be "no logo at all". The last test below
 * pins the two together, which is the pairing most likely to be broken by
 * someone changing one of them in isolation.
 * ======================================================================== */

// A row shaped like easyfix_theme_variant, so getActiveVariant's mapping and
// fallback are exercised on realistic input rather than a bare object.
function variantRow(over = {}) {
  return {
    id: 7,
    name: 'Diwali 2026',
    starts_on: '2026-11-01',
    ends_on: '2026-11-10',
    ornament_key: 'Branding/diwali-2026.png',
    anchor_x: '50.00',
    anchor_y: '0.00',
    scale: '100.00',
    animated: true,
    render_mode: 'overlay',
    ...over,
  };
}

test('normalizeRenderMode fails safe to "overlay" for anything but "replace"', () => {
  const { svc, restore } = loadWithS3Stub();
  try {
    assert.equal(svc.normalizeRenderMode('replace'), 'replace');
    assert.equal(svc.normalizeRenderMode('  REPLACE '), 'replace', 'case + padding normalise IN');

    /*
     * The asymmetry is the point. Every one of these is a value a DBA, an
     * import or an un-migrated host could produce, and each must land on the
     * mode that still draws the EasyFix lockup. Defaulting the other way would
     * let one bad string blank the branding on a logged-out page.
     */
    for (const bad of [null, undefined, '', '   ', 'overlay', 'Overlay', 'replaces', 'repl', 0, 1, true, {}]) {
      assert.equal(svc.normalizeRenderMode(bad), 'overlay', `must fail safe for ${JSON.stringify(bad)}`);
    }
    assert.deepEqual(svc.RENDER_MODES, ['overlay', 'replace']);
  } finally { restore(); }
});

test('getActiveVariant keeps render_mode=replace when the ornament resolves', async () => {
  const { svc, restore } = loadWithS3Stub({
    variantRows: [variantRow({ render_mode: 'replace' })],
  });
  try {
    const v = await svc.getActiveVariant();
    assert.equal(v.render_mode, 'replace', 'a usable asset means the mode stands');
    assert.match(v.ornament_url, /Branding\/diwali-2026\.png/);
  } finally { restore(); }
});

test('getActiveVariant downgrades replace→overlay when there is no ornament at all', async () => {
  const { svc, restore } = loadWithS3Stub({
    variantRows: [variantRow({ render_mode: 'replace', ornament_key: null })],
  });
  try {
    /*
     * THE DECISION THIS PINS: a 'replace' variant with nothing to render falls
     * back to the official lockup rather than rendering nothing. This state is
     * ordinary — an operator saves the festival window first and uploads the
     * art afterwards — and in between, the login page must not lose its logo.
     */
    const v = await svc.getActiveVariant();
    assert.equal(v.ornament_url, null);
    assert.equal(v.render_mode, 'overlay', 'no asset → fall back to the lockup, never a blank header');
  } finally { restore(); }
});

test('getActiveVariant downgrades replace→overlay when the presign fails', async () => {
  const { svc, restore } = loadWithS3Stub({
    throws: true,
    variantRows: [variantRow({ render_mode: 'replace' })],
  });
  try {
    // The object was deleted out from under the row. Same rule: a correct logo
    // beats an empty one, and it still must not 500 the login page.
    const v = await svc.getActiveVariant();
    assert.equal(v.ornament_url, null);
    assert.equal(v.render_mode, 'overlay');
  } finally { restore(); }
});

test('getActiveVariant leaves an ordinary overlay variant alone', async () => {
  const { svc, restore } = loadWithS3Stub({ variantRows: [variantRow()] });
  try {
    const v = await svc.getActiveVariant();
    assert.equal(v.render_mode, 'overlay');
    assert.match(v.ornament_url, /Branding\/diwali-2026\.png/);
    // The pre-existing mapping contract still holds alongside the new field.
    assert.equal(v.anchor_x, 50);
    assert.equal(v.scale, 100);
  } finally { restore(); }
});

test('a REFUSED key cannot blank the login page — prefix guard meets replace mode', async () => {
  const { svc, signed, restore } = loadWithS3Stub({
    variantRows: [variantRow({ render_mode: 'replace', ornament_key: 'easyfixer_documents/aadhaar-front.jpg' })],
  });
  try {
    /*
     * The nastiest interaction of the two features. A hostile key is refused by
     * the prefix guard (unchanged, non-negotiable) — and because the mode said
     * 'replace', honouring it would have left the unauthenticated login page
     * with NO brand mark whatsoever. Both halves must hold at once:
     *   the key is never signed, AND the page still gets its lockup.
     */
    const v = await svc.getActiveVariant();
    assert.equal(signed.length, 0, 'the prefix guard still refuses to sign it');
    assert.equal(v.ornament_url, null);
    assert.equal(v.render_mode, 'overlay', 'and the page falls back to the EasyFix lockup');
  } finally { restore(); }
});

/* ─── The PATCH-partiality contract, pinned at the schema ─────────────────
 * updateVariant builds its SET clause from hasOwnProperty, so whether a PATCH
 * touches render_mode is decided entirely by whether Joi puts the key in the
 * validated value. A `.default()` on the update schema would materialise it on
 * every request and silently reset a 'replace' variant each time an operator
 * nudged the anchor. The validator needs no db and no S3, so it is required
 * directly.
 */
test('render_mode: create defaults to overlay, PATCH stays partial', () => {
  const { variantCreate, variantUpdate } = require('../validators/branding.validator');

  const created = variantCreate.validate({ name: 'Holi', starts_on: '2026-03-03', ends_on: '2026-03-04' });
  assert.equal(created.error, undefined);
  assert.equal(created.value.render_mode, 'overlay', 'omitting the field on create means todays behaviour');

  const patched = variantUpdate.validate({ anchor_x: 42 });
  assert.equal(patched.error, undefined);
  assert.equal(
    Object.prototype.hasOwnProperty.call(patched.value, 'render_mode'), false,
    'an unrelated PATCH must not carry render_mode — it would reset a replace variant',
  );

  // Explicitly sent, it is accepted and canonicalised...
  assert.equal(variantUpdate.validate({ render_mode: 'REPLACE' }).value.render_mode, 'replace');
  // ...and the vocabulary is closed.
  assert.ok(variantUpdate.validate({ render_mode: 'hide-everything' }).error, 'unknown modes are rejected');
});
