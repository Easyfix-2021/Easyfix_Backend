'use strict';

const crypto = require('crypto');

/*
 * field-crypto — application-level AES-256-GCM for the two columns that must
 * not be readable from a database dump: a payout ACCOUNT NUMBER and the
 * ACCOUNT HOLDER'S NAME.
 *
 * Format:  v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
 * Key:     env EASYFIX_FIELD_ENC_KEY — 32 raw bytes, base64-encoded.
 *
 * ── THE ONE PROPERTY THIS FILE EXISTS TO GUARANTEE ──────────────────────
 * THERE IS NO CODE PATH HERE THAT RETURNS PLAINTEXT WHEN THE KEY IS ABSENT.
 * Not a fallback, not a "dev mode", not a warn-and-continue. A missing,
 * short or malformed key THROWS on write and REFUSES on read.
 *
 * That asymmetry is the whole argument. An outage is noticed within minutes
 * and is fixed by setting one env var; a silent plaintext fallback is noticed
 * never, and every account number written during the window stays readable in
 * that column FOREVER — there is no later migration that can un-leak a dump
 * taken in the meantime. So the failure mode is chosen deliberately: refuse
 * the request, do not degrade the storage.
 *
 * ── WHY A VERSION PREFIX ────────────────────────────────────────────────
 * `v1:` is not decoration. A column holding opaque base64 with no marker
 * cannot be read by anything that does not already know the algorithm, the
 * IV length and the tag length — which makes a key rotation or an algorithm
 * change a guessing game against production data. With the prefix, a future
 * v2 reader can dispatch per row and a mixed column is legible during the
 * rollout.
 *
 * ── WHY GCM AND NOT CBC ─────────────────────────────────────────────────
 * The authentication tag. CBC would decrypt a tampered ciphertext into
 * plausible-looking garbage and hand it back as an account number; GCM makes
 * decipher.final() throw. A payout destination that can be altered in the
 * database without detection is worse than one that is merely readable.
 *
 * ── SCOPE ───────────────────────────────────────────────────────────────
 * Deliberately field-level, not column-level or connection-level: the same
 * two values also live inside the `changes` / `old_values` JSON of
 * tbl_user_profile_update_request, and only a helper the application calls at
 * every write site can cover both. See services/profile-self.service.js.
 */

const VERSION = 'v1';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;   // the GCM standard; 96 bits is the size the mode is defined for
const KEY_BYTES = 32;  // AES-256

/*
 * Anchored, and deliberately NOT /g — a global regex carries `lastIndex`
 * across calls, which makes a shared module-level `.test()` stateful and
 * return false for every other caller. (Same reasoning as lib/emp-code.js.)
 */
const ENCRYPTED_RE = /^v1:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]*={0,2}$/;

/* Base64 shape check for the KEY itself, so a hex-encoded or quoted paste is a
 * loud "malformed" rather than a silent short key: Buffer.from(s,'base64')
 * quietly discards characters outside the alphabet. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/* The widest ciphertext either encrypted column can hold (VARCHAR(255), set by
 * migrations/2026-09-01-hrms-01-*.sql). Checked at ENCRYPT time so an
 * over-long value is a 400 at the boundary rather than a truncated,
 * permanently undecryptable row — MySQL outside STRICT mode truncates silently,
 * and a ciphertext missing its tail fails the GCM tag forever after. */
const MAX_CIPHERTEXT_CHARS = 255;

function cryptoError(message) {
  // { status, code } is the error shape every service in this feature throws;
  // routes surface e.status plus the machine code. 500, not 400 — a key
  // problem is an operator/config fault, never something the caller sent.
  return Object.assign(new Error(message), { status: 500, code: 'FIELD_ENC_UNAVAILABLE' });
}

/*
 * Resolve the key, or throw. Read from the environment on EVERY call rather
 * than captured at module load: this module is required at process start,
 * before some deployments have finished populating the environment, and a
 * captured-at-import key would freeze an early `undefined` into a permanent
 * outage that a restart is needed to clear. The decode is memoised on the raw
 * string, so the steady-state cost is one string comparison.
 */
let cached = { raw: null, key: null };

function loadKey() {
  const raw = process.env.EASYFIX_FIELD_ENC_KEY;
  if (!raw || !String(raw).trim()) {
    throw cryptoError('EASYFIX_FIELD_ENC_KEY is not set — refusing to handle bank details');
  }
  const trimmed = String(raw).trim();
  if (cached.raw === trimmed) return cached.key;

  if (!BASE64_RE.test(trimmed)) {
    throw cryptoError('EASYFIX_FIELD_ENC_KEY is not valid base64 — refusing to handle bank details');
  }
  const key = Buffer.from(trimmed, 'base64');
  if (key.length !== KEY_BYTES) {
    throw cryptoError(
      `EASYFIX_FIELD_ENC_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`
      + ' — refusing to handle bank details',
    );
  }
  cached = { raw: trimmed, key };
  return key;
}

/** True if `value` is already a v1 envelope. Never throws; takes no key. */
function isEncrypted(value) {
  return typeof value === 'string' && ENCRYPTED_RE.test(value);
}

/*
 * plaintext → 'v1:<iv>:<tag>:<ct>'.
 *
 * null / undefined / '' → null (there is nothing to protect), but THE KEY IS
 * CHECKED FIRST regardless. A blank must not become the one input that skips
 * the fail-closed gate, or "encrypt every field" quietly becomes "encrypt every
 * field that happened to be filled in on a healthy day".
 *
 * Already-encrypted input is returned unchanged rather than double-wrapped:
 * old_values snapshots copy a value that is already at rest in the column, and
 * a second envelope would need two decryptions to read and one to detect.
 */
function encryptField(plaintext) {
  // FIRST, before any short-circuit. A guard placed after the blank early
  // return would be skipped by exactly the inputs nobody looks at, and
  // "encrypt every field" would degrade to "encrypt every field that happened
  // to be filled in" without a single test going red.
  const key = loadKey();
  if (plaintext == null || plaintext === '') return null;
  const text = String(plaintext);
  if (isEncrypted(text)) return text;

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const out = [
    VERSION,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ct.toString('base64'),
  ].join(':');

  if (out.length > MAX_CIPHERTEXT_CHARS) {
    throw Object.assign(
      new Error(`value is too long to store encrypted (${out.length} > ${MAX_CIPHERTEXT_CHARS} chars)`),
      { status: 400, code: 'FIELD_TOO_LONG' },
    );
  }
  return out;
}

/*
 * 'v1:<iv>:<tag>:<ct>' → plaintext.
 *
 * null / '' → null. Everything else must be a well-formed v1 envelope: a value
 * that is NOT one is REFUSED, never returned as-is. Returning it would be the
 * plaintext fallback wearing a different hat — one bad write, or one row
 * inserted by a tool that bypassed this helper, and the read path starts
 * serving raw account numbers while every test still passes.
 *
 * A tampered ciphertext, IV or tag fails the GCM tag inside final() and throws
 * here. It never decrypts to garbage that the caller could mistake for an
 * account number.
 */
function decryptField(value) {
  const key = loadKey();
  if (value == null || value === '') return null;
  const text = String(value);
  if (!isEncrypted(text)) {
    throw cryptoError('stored value is not in the v1 encrypted format — refusing to read it');
  }
  const [, ivB64, tagB64, ctB64] = text.split(':');
  try {
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (e) {
    // Wrong key, altered ciphertext, altered IV, altered tag — all land here,
    // and all mean the same thing to a caller: this value cannot be trusted.
    throw Object.assign(
      new Error('bank value failed decryption — it was altered or the key changed'),
      { status: 500, code: 'FIELD_DECRYPT_FAILED', cause: e },
    );
  }
}

/*
 * '••••1234' for display. Takes the CLEAR bank_account_last4 column (or a full
 * plaintext account number, whose last four it uses) — never a ciphertext,
 * which is a programming error and throws rather than rendering '••••cGVy'.
 *
 * Fixed four bullets, not one per hidden digit: the length of an Indian account
 * number is itself a hint about the bank, and the mask exists to say "we hold
 * an account ending 1234", nothing more.
 */
function maskAccountNumber(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (isEncrypted(text)) {
    throw cryptoError('maskAccountNumber received a ciphertext — pass bank_account_last4 or the plaintext');
  }
  return '••••' + text.slice(-4);
}

/*
 * 'Priya Sharma' → 'P•••• S••••'. One initial per whitespace-separated token,
 * then a FIXED four bullets — enough for an approver to confirm the name they
 * were told to expect, not enough to reconstruct it, and it does not leak the
 * length of each part the way a per-character mask would.
 */
function maskName(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (isEncrypted(text)) {
    throw cryptoError('maskName received a ciphertext — decrypt it first');
  }
  if (!text) return null;
  return text.split(/\s+/).map((part) => part.charAt(0) + '••••').join(' ');
}

module.exports = {
  encryptField,
  decryptField,
  isEncrypted,
  maskAccountNumber,
  maskName,
};
