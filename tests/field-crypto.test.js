/*
 * lib/field-crypto — AES-256-GCM for the two HRMS bank columns.
 *
 * ─── WHAT THESE TESTS ARE FOR ──────────────────────────────────────────────
 *
 * Four properties. The first is the one that matters most, and it is the only
 * one whose failure would be INVISIBLE in production:
 *
 *   1. NO PLAINTEXT FALLBACK, EVER. With the key missing, short or malformed,
 *      every write throws and every read refuses. A helper that quietly stored
 *      the raw account number during a config outage would pass every other
 *      test in this file, ship green, and leave those rows readable in the
 *      column forever — there is no later migration that un-leaks a dump.
 *
 *   2. A TAMPERED VALUE IS REJECTED, NOT DECODED. GCM's tag is the reason this
 *      is not CBC: an altered ciphertext must throw, never decrypt into
 *      plausible garbage that a payout run would treat as an account number.
 *
 *   3. THE ENVELOPE IS SELF-DESCRIBING AND NON-DETERMINISTIC. `v1:` so a future
 *      key or algorithm rotation can dispatch per row; a fresh random IV so two
 *      employees banking at the same account do not produce identical columns.
 *
 *   4. THE MASKS LEAK NEITHER THE VALUE NOR THE CIPHERTEXT, and refuse a
 *      ciphertext outright rather than rendering '••••cGVy'.
 *
 * Pure functions — no DB, no network, nothing written anywhere. `node --test`
 * runs each test FILE in its own process, so the EASYFIX_FIELD_ENC_KEY
 * manipulation below cannot reach another suite.
 *
 * Runner: `npm test` (node --test --test-force-exit).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const KEY = crypto.randomBytes(32).toString('base64');
process.env.EASYFIX_FIELD_ENC_KEY = KEY;

const {
  encryptField, decryptField, isEncrypted, maskAccountNumber, maskName,
} = require('../lib/field-crypto');

const ACCOUNT = '50100123456789';
const HOLDER = 'Priya Sharma';

/* Run `fn` with EASYFIX_FIELD_ENC_KEY set to `value` (undefined = unset), then
 * put the real key back whatever happens. */
async function withKey(value, fn) {
  const saved = process.env.EASYFIX_FIELD_ENC_KEY;
  if (value === undefined) delete process.env.EASYFIX_FIELD_ENC_KEY;
  else process.env.EASYFIX_FIELD_ENC_KEY = value;
  try {
    await fn();
  } finally {
    process.env.EASYFIX_FIELD_ENC_KEY = saved;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 1. ROUND TRIP AND ENVELOPE SHAPE
// ═══════════════════════════════════════════════════════════════════════

test('a value round-trips through encrypt → decrypt unchanged', () => {
  const ct = encryptField(ACCOUNT);
  assert.notEqual(ct, ACCOUNT);
  assert.equal(decryptField(ct), ACCOUNT);
  assert.equal(decryptField(encryptField(HOLDER)), HOLDER);
  // Unicode survives — a holder name is not guaranteed to be ASCII.
  assert.equal(decryptField(encryptField('Zoë D’Souza')), 'Zoë D’Souza');
});

test('the envelope is v1:<iv>:<tag>:<ct> and carries a FRESH IV every time', () => {
  const a = encryptField(ACCOUNT);
  const b = encryptField(ACCOUNT);
  for (const ct of [a, b]) {
    const parts = ct.split(':');
    assert.equal(parts.length, 4, 'four colon-separated parts');
    assert.equal(parts[0], 'v1', 'the version prefix is what lets a v2 reader dispatch per row');
    assert.equal(Buffer.from(parts[1], 'base64').length, 12, 'a 96-bit GCM IV');
    assert.equal(Buffer.from(parts[2], 'base64').length, 16, 'the auth tag is retained');
  }
  // Same plaintext, different ciphertext. A deterministic scheme would let
  // anyone with table access see WHICH employees share an account number
  // without decrypting a thing.
  assert.notEqual(a, b, 'a fresh random IV per value');
  assert.equal(decryptField(a), decryptField(b));
});

test('isEncrypted recognises the envelope and nothing else', () => {
  assert.equal(isEncrypted(encryptField(ACCOUNT)), true);
  for (const notCt of [ACCOUNT, HOLDER, '', null, undefined, 42, {},
    'v2:a:b:c', 'v1:only:three', 'v1::a:b']) {
    assert.equal(isEncrypted(notCt), false, `${JSON.stringify(notCt)} is not an envelope`);
  }
});

test('a blank encrypts to null and decrypts to null — but the KEY is still checked', () => {
  for (const blank of [null, undefined, '']) {
    assert.equal(encryptField(blank), null);
    assert.equal(decryptField(blank), null);
  }
  // The gate must not be skippable by passing a blank: if the key check ran
  // AFTER the blank short-circuit, "encrypt every field" would silently become
  // "encrypt every field that happened to be filled in".
  return withKey(undefined, () => {
    assert.throws(() => encryptField(''), (e) => e.code === 'FIELD_ENC_UNAVAILABLE');
    assert.throws(() => decryptField(''), (e) => e.code === 'FIELD_ENC_UNAVAILABLE');
  });
});

test('an already-encrypted value is not double-wrapped', () => {
  const once = encryptField(ACCOUNT);
  assert.equal(encryptField(once), once);
});

// ═══════════════════════════════════════════════════════════════════════
// 2. TAMPERING — THE GCM TAG IS THE POINT
// ═══════════════════════════════════════════════════════════════════════

test('a tampered ciphertext is REJECTED, never decrypted into garbage', () => {
  const [v, iv, tag, ct] = encryptField(ACCOUNT).split(':');

  // Flip one bit of the payload.
  const bytes = Buffer.from(ct, 'base64');
  bytes[0] ^= 0x01;
  const altered = [v, iv, tag, bytes.toString('base64')].join(':');
  assert.throws(() => decryptField(altered), (e) => e.code === 'FIELD_DECRYPT_FAILED',
    'an altered payload must throw, not return plausible garbage');

  // Substitute a different IV — same key, same tag, different nonce.
  const otherIv = crypto.randomBytes(12).toString('base64');
  assert.throws(() => decryptField([v, otherIv, tag, ct].join(':')),
    (e) => e.code === 'FIELD_DECRYPT_FAILED');

  // Strip the tag's authority by swapping it for another value's.
  const foreignTag = encryptField(HOLDER).split(':')[2];
  assert.throws(() => decryptField([v, iv, foreignTag, ct].join(':')),
    (e) => e.code === 'FIELD_DECRYPT_FAILED');

  // And the untouched original still reads, so the assertions above are about
  // the tampering and not about a broken fixture.
  assert.equal(decryptField([v, iv, tag, ct].join(':')), ACCOUNT);
});

test('a value encrypted under a DIFFERENT key is rejected, not silently wrong', () => {
  const foreign = encryptField(ACCOUNT);
  return withKey(crypto.randomBytes(32).toString('base64'), () => {
    assert.throws(() => decryptField(foreign), (e) => e.code === 'FIELD_DECRYPT_FAILED');
  });
});

test('a NON-envelope stored value is REFUSED on read, never returned as-is', () => {
  /*
   * This is the plaintext fallback wearing a different hat. If decryptField
   * returned an unrecognised value untouched, one write that bypassed this
   * helper — a manual UPDATE, an import script, a future code path — would put
   * the read path back to serving raw account numbers with every test green.
   */
  for (const stored of [ACCOUNT, 'plain text', 'v2:a:b:c', 'not:an:envelope:at:all']) {
    assert.throws(() => decryptField(stored), (e) => e.code === 'FIELD_ENC_UNAVAILABLE',
      `${stored} must be refused`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 3. FAIL CLOSED — THE PROPERTY THIS FILE EXISTS FOR
// ═══════════════════════════════════════════════════════════════════════

test('a MISSING key throws on write and refuses on read — it never falls back to plaintext', async () => {
  const ct = encryptField(ACCOUNT);
  await withKey(undefined, () => {
    let stored;
    assert.throws(
      () => { stored = encryptField(ACCOUNT); },
      (e) => e.code === 'FIELD_ENC_UNAVAILABLE',
      'a write with no key must throw',
    );
    // THE assertion. Not "it threw" — "it produced nothing that could be
    // stored". A helper that returned the plaintext, or returned it alongside a
    // warning, would satisfy a weaker check and leak in production.
    assert.equal(stored, undefined, 'nothing storable may come back');

    assert.throws(() => decryptField(ct), (e) => e.code === 'FIELD_ENC_UNAVAILABLE',
      'a read with no key must refuse');
  });
  // The key came back, so the outage was an outage and not corruption.
  assert.equal(decryptField(ct), ACCOUNT);
});

test('a SHORT or MALFORMED key is treated exactly like a missing one', async () => {
  const ct = encryptField(ACCOUNT);
  const badKeys = {
    'empty string': '',
    'whitespace only': '   ',
    '16 bytes (AES-128)': crypto.randomBytes(16).toString('base64'),
    '31 bytes (one short)': crypto.randomBytes(31).toString('base64'),
    '64 bytes (two keys pasted)': crypto.randomBytes(64).toString('base64'),
    'hex, not base64': crypto.randomBytes(32).toString('hex'),
    'not base64 at all': 'this is not a key!!',
  };
  for (const [label, value] of Object.entries(badKeys)) {
    // eslint-disable-next-line no-await-in-loop -- each case must run with the
    // env set to exactly its own value; running them concurrently would race.
    await withKey(value, () => {
      assert.throws(() => encryptField(ACCOUNT), (e) => e.code === 'FIELD_ENC_UNAVAILABLE',
        `write with ${label} must throw`);
      assert.throws(() => decryptField(ct), (e) => e.code === 'FIELD_ENC_UNAVAILABLE',
        `read with ${label} must refuse`);
    });
  }
});

test('a value too long to store encrypted is refused, not silently truncated', () => {
  /*
   * bank_account_number / bank_account_name are VARCHAR(255) and a ciphertext
   * runs ~4x the plaintext. Outside STRICT mode MySQL TRUNCATES rather than
   * erroring, and a ciphertext missing its tail fails the GCM tag forever
   * after — an unrecoverable row written by a successful-looking request. The
   * ceiling is enforced here so the failure is a 400 at the boundary instead.
   */
  const tooLong = 'x'.repeat(400);
  assert.throws(() => encryptField(tooLong),
    (e) => e.status === 400 && e.code === 'FIELD_TOO_LONG');
  // The widest value the application actually accepts still fits comfortably:
  // a 32-character account number and a 120-character holder name.
  assert.ok(encryptField('9'.repeat(32)).length <= 255);
  assert.ok(encryptField('A'.repeat(120)).length <= 255);
});

// ═══════════════════════════════════════════════════════════════════════
// 4. THE MASKS
// ═══════════════════════════════════════════════════════════════════════

test('maskAccountNumber shows four digits and a FIXED number of bullets', () => {
  assert.equal(maskAccountNumber('6789'), '••••6789');
  // Given a full number it uses the tail — and the output length does not
  // reveal how long the number was, which would itself hint at the bank.
  assert.equal(maskAccountNumber(ACCOUNT), '••••6789');
  assert.equal(maskAccountNumber('123456789012345678'), '••••5678');
  assert.equal(maskAccountNumber(null), null);
  assert.equal(maskAccountNumber(''), null);
});

test('maskName keeps one initial per part and hides the rest', () => {
  assert.equal(maskName(HOLDER), 'P•••• S••••');
  assert.equal(maskName('Anita Kumari Rao'), 'A•••• K•••• R••••');
  assert.equal(maskName('Ravi'), 'R••••');
  assert.equal(maskName('  Ravi   Kumar  '), 'R•••• K••••');
  assert.equal(maskName(null), null);
  // Fixed-width bullets: two names of very different length mask identically,
  // so the mask does not leak the name's length.
  assert.equal(maskName('Al Bo'), maskName('Alexandra Bornstein'));
});

test('neither mask ever emits the input value or a ciphertext', () => {
  const masked = maskAccountNumber(ACCOUNT) + ' ' + maskName(HOLDER);
  assert.equal(masked.includes(ACCOUNT), false);
  assert.equal(masked.includes(HOLDER), false);
  assert.equal(masked.includes('Sharma'), false);
  // A ciphertext is not a display value: '••••cGVy' would look like a masked
  // account number and be entirely meaningless.
  const ct = encryptField(ACCOUNT);
  assert.throws(() => maskAccountNumber(ct), (e) => e.code === 'FIELD_ENC_UNAVAILABLE');
  assert.throws(() => maskName(ct), (e) => e.code === 'FIELD_ENC_UNAVAILABLE');
});
