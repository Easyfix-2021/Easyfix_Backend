'use strict';

const crypto = require('crypto');

/*
 * field-crypto — application-level ENVELOPE ENCRYPTION for values that must not
 * be readable from a database dump. Today that is a payout ACCOUNT NUMBER and
 * the ACCOUNT HOLDER'S NAME, but nothing below is bank-specific: it takes a
 * string and returns a string, so the next flow that needs a protected field
 * calls the same two functions rather than inventing a second scheme.
 *
 * Format:
 *   v2:<op_fp>:<rec_fp>:<dek_iv>:<dek_tag>:<dek_ct>:<sealed_dek>:<iv>:<tag>:<ct>
 *
 * Config — exactly two variables, and only ONE of them is a secret:
 *   EASYFIX_FIELD_ENC_KEY              THE operational secret. 32 raw bytes,
 *                                      base64. Used for both encrypt and
 *                                      decrypt. There is no second key in env.
 *   EASYFIX_FIELD_RECOVERY_PUBLIC_KEY  The recovery PUBLIC key, PEM base64'd to
 *                                      one line. NOT A SECRET — it can sit in
 *                                      git, a config map, a screenshot. Its
 *                                      PRIVATE half never comes near this
 *                                      process. This is the BOOTSTRAP value;
 *                                      once a recovery key is stored in the
 *                                      database that one wins. See
 *                                      resolveRecoveryPublicKey().
 *
 * ── HOW ONE VALUE IS STORED ─────────────────────────────────────────────
 *   1. a fresh random 32-byte DATA KEY (DEK), unique to that single value
 *   2. the VALUE encrypted under the DEK        — AES-256-GCM, fresh IV, tag kept
 *   3. the DEK WRAPPED under the operational key — AES-256-GCM   → normal reads
 *   4. the SAME DEK SEALED to the recovery public key — RSA-OAEP/SHA-256
 *                                                                → break-glass
 * Two independent doors to the same DEK. Losing one does not lose the value.
 *
 * ── WHY THE DEK LAYER IS THE WHOLE POINT ────────────────────────────────
 * RE-KEYING IS A RE-WRAP OF 32 BYTES, NOT A RE-ENCRYPTION OF EVERY VALUE. The
 * value ciphertext — the last three fields — NEVER MOVES. Rotating the
 * operational key rewrites only the wrapped DEK; rotating the recovery key
 * rewrites only the sealed DEK; neither touches the other, and neither touches
 * the value.
 *
 * That is not a micro-optimisation, it is the difference between a rotation that
 * gets performed and one that gets postponed forever. Re-encrypting every value
 * means reading every row, holding both keys at once, writing every row back
 * under a lock, and owning a half-migrated column if the job dies in the middle
 * — a maintenance window, a rollback plan and a risk of loss. Re-wrapping means
 * touching a 60-byte blob per row with the value ciphertext untouched, so a job
 * that stops halfway has damaged nothing and can simply be resumed. A security
 * control nobody dares exercise is a security control that does not exist.
 *
 * ── WHY THE RECOVERY KEY MUST BE ASYMMETRIC ─────────────────────────────
 * The ask was "a master key kept in my personal notes that can still read
 * everything if the operational key is lost, rotated or leaked". The obvious
 * reading — a second SYMMETRIC key — CANNOT DELIVER THAT, and the reason is
 * worth stating because it is not obvious:
 *
 *   To seal a value to a symmetric key AT WRITE TIME, the server must HOLD that
 *   key at write time. A key the server holds lives in env, on the box, in the
 *   process, in a dump of that process. It is then exactly as exposed as the
 *   operational key it was meant to survive — a second copy of the same secret,
 *   not a backstop. The one place it must not be is the one place it has to be.
 *
 * Asymmetric dissolves the contradiction. Sealing needs only the PUBLIC half,
 * which is not a secret and is safe in env, in a table, in git. Opening needs
 * the PRIVATE half, which never leaves the owner's notes and never touches a
 * server, a transcript or this repository. The server can write a recovery path
 * it cannot itself walk. That asymmetry IS the feature.
 *
 * RSA-OAEP/SHA-256 rather than a KEM: `crypto.publicEncrypt` is in the standard
 * library, needs no dependency, and 32 bytes fits any modulus ≥ 2048 with room
 * to spare. The private half is used by scripts/field-recover.js and by nothing
 * else in this codebase.
 *
 * ── THE ONE PROPERTY THIS FILE EXISTS TO GUARANTEE ──────────────────────
 * THERE IS NO CODE PATH HERE THAT RETURNS PLAINTEXT WHEN A KEY IS ABSENT.
 * Not a fallback, not a "dev mode", not a warn-and-continue. A missing, short
 * or malformed key THROWS on write and REFUSES on read.
 *
 * That asymmetry is the whole argument. An outage is noticed within minutes and
 * is fixed by setting one env var; a silent plaintext fallback is noticed never,
 * and every account number written during the window stays readable in that
 * column FOREVER — there is no later migration that can un-leak a dump taken in
 * the meantime. So the failure mode is chosen deliberately: refuse the request,
 * do not degrade the storage.
 *
 * BOTH keys are fail-closed on WRITE, and that includes the public one. A row
 * written while no recovery key could be resolved would have no break-glass path
 * — the precise failure this feature exists to prevent — and it would look
 * completely normal until the day the operational key was gone and it turned out
 * to be the one row that could not be recovered. So an unresolvable recovery key
 * is a write outage, loudly, immediately.
 *
 * READS do not require the recovery key, deliberately. It is a write-side input;
 * refusing reads without it would convert a fixable write outage into a total
 * outage of the payout path for no security gain whatsoever. The operational key
 * IS still checked on read, before the blank short-circuit.
 *
 * ── WHY A VERSION PREFIX ────────────────────────────────────────────────
 * `v2:` is not decoration. A column holding opaque base64 with no marker cannot
 * be read by anything that does not already know the algorithm, the IV length
 * and the field order — which makes a scheme change a guessing game against
 * production data. With the prefix a future v3 reader can dispatch per row and a
 * mixed column stays legible during the rollout.
 *
 * v1 (a single key, no recovery path) IS NOT READ HERE AND NEVER WILL BE. Not
 * one such value exists in any database: the migrations that create these
 * columns are all still PENDING and nothing is deployed, so the population is
 * empty and cannot grow. Carrying a v1 branch would be a permanently-untestable
 * parse path serving zero rows — and worse, a v1 row has no sealed DEK, so
 * accepting one would mean accepting a value with no recovery path, the exact
 * invariant the write side refuses to break. Refused as a non-envelope, and
 * pinned by a test.
 *
 * ── WHY THE ENVELOPE CARRIES TWO FINGERPRINTS ───────────────────────────
 * A version prefix says WHICH SCHEME. It does not say WHICH KEY, and there are
 * two keys, each independently rotatable.
 *
 *   op_fp   the OPERATIONAL key whose wrap must be opened for a normal read.
 *   rec_fp  the RECOVERY public key the DEK was SEALED to.
 *
 * Without op_fp, a row met after an operational rotation fails the GCM tag and
 * AES-GCM cannot say whether the cause was the wrong key or a tampered
 * ciphertext — it refuses either way, correctly, and that is all it can do.
 *
 * Without rec_fp, BREAK-GLASS ON A ROW SEALED TO A SUPERSEDED RECOVERY KEY FAILS
 * WITH NO WAY TO SAY WHICH KEY IT WANTS — and "which one of the keys in my notes
 * is this?" is the entire content of the error at the one moment somebody needs
 * it. Recovery keys are rotatable (a leaked one is re-sealed away; see
 * resealToRecoveryKey), so a row outliving its recovery key is a normal state,
 * not an anomaly.
 *
 * Both are the first 8 hex chars of sha256 over the key's RAW BYTES — for the
 * public key, over its DER/SPKI encoding, so PEM whitespace, line wrapping and
 * base64 padding cannot change the answer.
 *
 * THE IDS ARE DERIVED FROM THE KEYS, never assigned by an operator. A hand-typed
 * `KEY_ID=prod-2` can be typo'd, or reused for a different key in a different
 * environment — and then two distinct keys claim one id and every error message
 * built on it is a lie at exactly the moment someone is trusting it. A
 * fingerprint cannot disagree with its own key. It is also not key material: 8
 * hex chars of a SHA-256 digest are safe to print in a log and safe to store
 * beside the ciphertext, which is the whole point of putting it there.
 *
 * ── WHY GCM AND NOT CBC ─────────────────────────────────────────────────
 * The authentication tag. CBC would decrypt a tampered ciphertext into
 * plausible-looking garbage and hand it back as an account number; GCM makes
 * decipher.final() throw. A payout destination that can be altered in the
 * database without detection is worse than one that is merely readable. The
 * same reasoning applies to the WRAPPED DEK, which is why that is GCM too: a
 * malleable DEK would be a malleable value.
 *
 * ── SCOPE ───────────────────────────────────────────────────────────────
 * Deliberately field-level, not column-level or connection-level: the same two
 * values also live inside the `changes` / `old_values` JSON of
 * tbl_user_profile_update_request, and only a helper the application calls at
 * every write site can cover both. See services/profile-self.service.js.
 *
 * This module owns the ENVELOPE and the KEY MATERIAL and nothing else. It does
 * not know the recovery-key table's name or shape (see the `runner` contract on
 * resolveRecoveryPublicKey), it does not do bulk work, and it exposes the
 * single-envelope re-key primitives that bulk flows are built from — so there is
 * exactly one implementation of unwrap-then-rewrap in the codebase.
 */

const VERSION = 'v2';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;   // the GCM standard; 96 bits is the size the mode is defined for
const KEY_BYTES = 32;  // AES-256, and also the DEK size
const FP_CHARS = 8;    // 8 hex chars = 32 bits of sha256 — see the fingerprint note above

/* RSA-OAEP with SHA-256. Spelled out rather than left to defaults because
 * Node's default oaepHash is SHA-1, and a value sealed under SHA-1 OAEP cannot
 * be opened by a SHA-256 reader — a mismatch here would be discovered on the
 * one day it must not be. */
const OAEP = { padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' };

/* A recovery key smaller than this is refused outright. An operator reusing an
 * ancient 1024-bit key would otherwise get a working system whose break-glass
 * path is the weakest link in it, and would never find out. */
const MIN_RECOVERY_MODULUS_BITS = 2048;

/*
 * Anchored, and deliberately NOT /g — a global regex carries `lastIndex` across
 * calls, which makes a shared module-level `.test()` stateful and return false
 * for every other caller. (Same reasoning as lib/emp-code.js.)
 *
 * Ten fields: the version, two fingerprints, and seven base64 blobs. Built from
 * the constants so FP_CHARS has one home; evaluated once at module load, so the
 * construction costs nothing per call.
 */
const B64_FIELD = '[A-Za-z0-9+/]+={0,2}';
const FP_FIELD = `[0-9a-f]{${FP_CHARS}}`;
const ENCRYPTED_RE = new RegExp(`^${VERSION}:${FP_FIELD}:${FP_FIELD}(?::${B64_FIELD}){7}$`);

/* Base64 shape check for a KEY or a PEM blob, so a hex-encoded or quoted paste
 * is a loud "malformed" rather than a silent short key: Buffer.from(s,'base64')
 * quietly discards characters outside the alphabet. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/*
 * The widest envelope either encrypted column can hold — VARCHAR(2048), set by
 * migrations/2026-09-01-hrms-01-*.sql. THESE TWO NUMBERS MUST AGREE; if you
 * change the column, change this line in the same commit.
 *
 * Checked at ENCRYPT time so an over-long value is a 400 at the boundary rather
 * than a truncated, permanently undecryptable row — MySQL outside STRICT mode
 * truncates silently, and an envelope missing its tail fails the GCM tag forever
 * after.
 *
 * ARITHMETIC. Fixed overhead is 835 chars:
 *     'v2'                                    2
 *     9 colons                                9
 *     op_fp + rec_fp                         16
 *     dek_iv    12 B → ceil(12/3)*4          16
 *     dek_tag   16 B → ceil(16/3)*4          24
 *     dek_ct    32 B → ceil(32/3)*4          44
 *     sealed    512 B (RSA-4096) → …        684   ← the dominant term
 *     iv        12 B                         16
 *     tag       16 B                         24
 * plus the value itself at ceil(n/3)*4 for n PLAINTEXT BYTES. So 2048 leaves
 * 1213 chars of payload = 909 bytes, against a real worst case of 480 bytes (a
 * 120-CHARACTER holder name in a 4-byte-per-character script). BYTES, not
 * characters — the application's 120-char limit is not a 120-byte limit, and a
 * non-ASCII name is the case that would find a tight ceiling.
 *
 * A smaller recovery modulus only widens the margin: RSA-3072 seals to 512
 * base64 chars instead of 684, RSA-2048 to 344.
 */
const MAX_CIPHERTEXT_CHARS = 2048;

function cryptoError(message) {
  // { status, code } is the error shape every service in this feature throws;
  // routes surface e.status plus the machine code. 500, not 400 — a key
  // problem is an operator/config fault, never something the caller sent.
  return Object.assign(new Error(message), { status: 500, code: 'FIELD_ENC_UNAVAILABLE' });
}

function decryptFailed(message, cause) {
  return Object.assign(new Error(message), { status: 500, code: 'FIELD_DECRYPT_FAILED', cause });
}

// ═══════════════════════════════════════════════════════════════════════════
// KEY MATERIAL
// ═══════════════════════════════════════════════════════════════════════════

/*
 * The public name of a key: sha256 of its RAW BYTES, first 8 hex chars.
 *
 * Of the raw bytes, not the base64 text, so the same key fingerprints
 * identically however it was pasted (padded, unpadded, with stray whitespace).
 * 32 bits is ample for an id whose only job is to answer "is this the key I am
 * holding?" — and a truncated digest is not reversible to key material, which is
 * what makes it safe to store next to the ciphertext.
 */
function fingerprint(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, FP_CHARS);
}

/* Over the DER/SPKI encoding, so the SAME key fingerprints identically whether
 * it arrived as a PEM, a base64'd PEM, CRLF-wrapped, or already a KeyObject.
 * A fingerprint that changed with whitespace would orphan rows on a re-import. */
function publicKeyFingerprint(key) {
  return fingerprint(key.export({ type: 'spki', format: 'der' }));
}

/* base64 | Buffer → a validated 32-byte operational key. `label` names the
 * source in the message so "which input did I get wrong" is answered by the
 * error itself. Never echoes the value. */
function toOperationalKey(value, label) {
  if (Buffer.isBuffer(value)) {
    if (value.length !== KEY_BYTES) {
      throw cryptoError(`${label} must be ${KEY_BYTES} bytes, got ${value.length}`);
    }
    return value;
  }
  const text = String(value ?? '').trim();
  if (!text) throw cryptoError(`${label} is not set — refusing to handle protected fields`);
  if (!BASE64_RE.test(text)) {
    throw cryptoError(`${label} is not valid base64 — refusing to handle protected fields`);
  }
  const key = Buffer.from(text, 'base64');
  if (key.length !== KEY_BYTES) {
    throw cryptoError(
      `${label} must decode to ${KEY_BYTES} bytes, got ${key.length}`
      + ' — refusing to handle protected fields',
    );
  }
  return key;
}

/*
 * KeyObject | PEM text | base64'd PEM → a validated RSA public KeyObject.
 *
 * Liberal in what it accepts because the same key arrives three ways — from env
 * (base64'd, since a PEM is multi-line and `\n` in a .env file, a compose file,
 * an ECS task definition and an SSM parameter all behave differently), from a
 * database row, and from a caller doing a re-seal. Strict in what it validates,
 * because a recovery key that is the wrong TYPE or too SMALL would otherwise
 * work perfectly right up until it was the only thing standing between the
 * company and its data.
 */
function toPublicKey(value, label) {
  let key;
  if (value && typeof value === 'object' && value.type === 'public') {
    key = value;
  } else {
    const text = String(value ?? '').trim();
    if (!text) throw cryptoError(`${label} is not set`);
    const decoded = text.includes('-----BEGIN')
      ? text
      : (BASE64_RE.test(text)
        ? Buffer.from(text, 'base64').toString('utf8')
        : text);
    /* CRLF → LF, and trim AFTER decoding. OpenSSL's PEM decoder rejects both a
     * CRLF-wrapped key and one with whitespace before its '-----BEGIN' —
     * "DECODER routines::unsupported", which reads as "your key is broken"
     * rather than "your key has a space in front of it". A key pasted through a
     * Windows editor, a web form or a chat client arrives that way routinely,
     * and base64ing it for transport PRESERVES the damage rather than fixing
     * it. The fingerprint is over the DER, so neither normalisation can move
     * it — the same key is the same ring entry however it was pasted. */
    const pem = decoded.replace(/\r\n/g, '\n').trim();
    /*
     * ⚠ REFUSE A PRIVATE KEY, LOUDLY. crypto.createPublicKey() ACCEPTS a
     * private PEM and silently derives the public half from it — so pasting the
     * recovery PRIVATE key into this variable would WORK. Everything would
     * encrypt, every test would pass, and the one secret whose entire design
     * requirement is that it never touches a server would be sitting in env, in
     * the process, in every dump of it, forever. Nothing downstream could ever
     * detect it. This is the only place it can be caught.
     */
    if (/-----BEGIN[^-]*PRIVATE KEY-----/.test(pem)) {
      throw cryptoError(
        `${label} was given a PRIVATE key. Only the PUBLIC half belongs in configuration —`
        + ' the private half must never reach a server. Re-export the public key and,'
        + ' since this one has now been on a server, treat it as compromised.',
      );
    }
    try {
      key = crypto.createPublicKey(pem);
    } catch (e) {
      // The PEM text is not echoed. It is not a secret, but it is long, and an
      // error message is not a place to paste a key of any colour.
      throw cryptoError(`${label} did not parse as a public key PEM (${e.message})`);
    }
  }
  if (key.asymmetricKeyType !== 'rsa') {
    // An ed25519 or EC key parses fine and then fails at publicEncrypt with a
    // message about padding, which reads as a bug in this file rather than as
    // "you generated the wrong kind of key".
    throw cryptoError(
      `${label} must be an RSA key, got ${key.asymmetricKeyType} — RSA-OAEP is the sealing scheme`,
    );
  }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < MIN_RECOVERY_MODULUS_BITS) {
    throw cryptoError(
      `${label} is ${bits}-bit; the minimum is ${MIN_RECOVERY_MODULUS_BITS} and 4096 is`
      + ' recommended for a key this long-lived',
    );
  }
  return key;
}

/*
 * Resolve the operational key, or throw. Read from the environment on EVERY
 * call rather than captured at module load: this module is required at process
 * start, before some deployments have finished populating the environment, and
 * a captured-at-import key would freeze an early `undefined` into a permanent
 * outage that a restart is needed to clear. The decode is memoised on the raw
 * string, so the steady-state cost is one string comparison.
 */
let cachedOp = { raw: null, key: null, fp: null };

function loadOperationalKey() {
  const raw = process.env.EASYFIX_FIELD_ENC_KEY;
  if (!raw || !String(raw).trim()) {
    throw cryptoError('EASYFIX_FIELD_ENC_KEY is not set — refusing to handle protected fields');
  }
  const trimmed = String(raw).trim();
  if (cachedOp.raw === trimmed) return cachedOp;
  const key = toOperationalKey(trimmed, 'EASYFIX_FIELD_ENC_KEY');
  cachedOp = { raw: trimmed, key, fp: fingerprint(key) };
  return cachedOp;
}

/*
 * ── THE RECOVERY KEY, AND WHERE IT COMES FROM ───────────────────────────
 *
 * Resolution order, highest first:
 *   1. the ACTIVE row in the recovery-key store  (rotation without a deploy)
 *   2. env EASYFIX_FIELD_RECOVERY_PUBLIC_KEY     (bootstrap, and only that)
 *   3. fail closed
 *
 * The database wins because rotating a recovery key must not require a deploy —
 * a control that needs a release train is a control that gets deferred. env
 * remains the bootstrap for an environment whose store is still empty, and for
 * local development.
 *
 * THIS MODULE DOES NOT KNOW THE TABLE. It is handed a `runner`, an object the
 * caller supplies:
 *
 *   runner.activeRecoveryKey()            → Promise<row | null>
 *   runner.recoveryKeyByFingerprint(fp)   → Promise<row | null>
 *   row = { public_key: <PEM or base64'd PEM>, fingerprint?, ...anything else }
 *
 * That keeps the table's name, shape, migration and admin flow entirely with
 * the agents that own them, and keeps these tests free of a database. If the
 * row carries a `fingerprint`, it is VERIFIED against the one derived from the
 * key bytes rather than trusted — a stored id that disagrees with its own key is
 * precisely the lie that deriving fingerprints exists to prevent, and it becomes
 * possible again the moment another writer puts one in a column.
 *
 * `resolveRecoveryPublicKey` PRIMES a module-level cache that the synchronous
 * encryptField then uses. encryptField cannot await, and making it async would
 * change every caller in services/ and routes/ — which is not this change.
 *
 * ponytail: the cache is refreshed only when a caller calls resolve() again
 * (boot, and after a rotation). A replica that has not re-resolved keeps sealing
 * to the PREVIOUS recovery key, which is harmless and self-describing — the
 * envelope records rec_fp, so those rows are still recoverable with the key they
 * name. Add a TTL only if a rotation ever needs to be globally effective within
 * a known window.
 */
let cachedRecoveryEnv = { raw: null, key: null, fp: null };
let storedRecovery = null;   // { key, fp, source: 'database' } once primed

function recoveryFromEnv() {
  const raw = process.env.EASYFIX_FIELD_RECOVERY_PUBLIC_KEY;
  if (!raw || !String(raw).trim()) return null;
  const trimmed = String(raw).trim();
  if (cachedRecoveryEnv.raw === trimmed) return cachedRecoveryEnv;
  const key = toPublicKey(trimmed, 'EASYFIX_FIELD_RECOVERY_PUBLIC_KEY');
  cachedRecoveryEnv = { raw: trimmed, key, fp: publicKeyFingerprint(key), source: 'env' };
  return cachedRecoveryEnv;
}

/* The recovery key a WRITE will seal to, or throw. Synchronous by necessity —
 * see the note above. */
function activeRecoveryKey() {
  if (storedRecovery) return storedRecovery;
  const fromEnv = recoveryFromEnv();
  if (fromEnv) return fromEnv;
  throw cryptoError(
    'no recovery key is configured — set EASYFIX_FIELD_RECOVERY_PUBLIC_KEY, or store one and'
    + ' call resolveRecoveryPublicKey(). Refusing to write a value with no recovery path',
  );
}

/* Turn a store row into a validated { key, fp }, checking any fingerprint the
 * row claims against the one its key bytes actually produce. */
function keyFromRow(row, label) {
  const key = toPublicKey(row.public_key ?? row.publicKey, label);
  const fp = publicKeyFingerprint(key);
  const claimed = row.fingerprint ?? row.key_fingerprint;
  if (claimed && String(claimed) !== fp) {
    throw cryptoError(
      `${label} row claims fingerprint ${claimed} but its key bytes derive ${fp}`
      + ' — the stored row and the stored key disagree; do not write with it',
    );
  }
  return { key, fp };
}

/*
 * Prime (or re-prime) the active recovery key from the store, falling back to
 * env. Call at boot and after a recovery-key rotation. Returns a descriptor —
 * `{ fingerprint, source }` — with no key material in it, so it is safe to log.
 */
async function resolveRecoveryPublicKey(runner) {
  if (runner && typeof runner.activeRecoveryKey === 'function') {
    const row = await runner.activeRecoveryKey();
    if (row) {
      const { key, fp } = keyFromRow(row, 'active recovery key');
      storedRecovery = { key, fp, source: 'database' };
      return { fingerprint: fp, source: 'database' };
    }
  }
  // No stored key: fall back to env, and DROP any previously primed one so a
  // deleted row cannot keep being used from a stale cache.
  storedRecovery = null;
  const fromEnv = recoveryFromEnv();
  if (fromEnv) return { fingerprint: fromEnv.fp, source: 'env' };
  throw cryptoError(
    'no recovery key is configured — the store has no active row and'
    + ' EASYFIX_FIELD_RECOVERY_PUBLIC_KEY is unset. Refusing to write a value with no'
    + ' recovery path',
  );
}

/*
 * Look up the recovery public key a given envelope names, for reporting: "this
 * row is sealed to 3f2a1b9c, which is the key created on <date>". It cannot
 * decrypt anything — that needs the private half — but it turns a fingerprint
 * into something an operator can recognise in their notes.
 */
async function recoveryKeyByFingerprint(fp, runner) {
  if (!runner || typeof runner.recoveryKeyByFingerprint !== 'function') return null;
  const row = await runner.recoveryKeyByFingerprint(fp);
  if (!row) return null;
  const resolved = keyFromRow(row, `recovery key ${fp}`);
  if (resolved.fp !== fp) {
    throw cryptoError(
      `recovery key store returned a key fingerprinting ${resolved.fp} when asked for ${fp}`,
    );
  }
  return { ...resolved, row };
}

// ═══════════════════════════════════════════════════════════════════════════
// THE ENVELOPE
// ═══════════════════════════════════════════════════════════════════════════

/* AES-256-GCM in one line each, used for BOTH layers — the value under the DEK
 * and the DEK under the operational key. One implementation, so the wrapped DEK
 * cannot drift into being the unauthenticated one. */
function gcmSeal(key, plaintext) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ct };
}

function gcmOpen(key, iv, tag, ct) {
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** True if `value` is already a v2 envelope. Never throws; takes no key. */
function isEncrypted(value) {
  return typeof value === 'string' && ENCRYPTED_RE.test(value);
}

/* Split a validated envelope into its parts, keeping BOTH the decoded buffers
 * and the original base64 text of the three fields a re-key must copy through
 * byte for byte. Only ever called after isEncrypted, so the field count and
 * alphabet are already guaranteed; the LENGTHS are not, and are left to GCM and
 * RSA to reject. */
function parseEnvelope(text) {
  const [, opFp, recFp, dekIv, dekTag, dekCt, sealed, iv, tag, ct] = text.split(':');
  const b = (s) => Buffer.from(s, 'base64');
  return {
    opFp,
    recFp,
    dekIv: b(dekIv),
    dekTag: b(dekTag),
    dekCt: b(dekCt),
    sealed: b(sealed),
    sealedB64: sealed,
    iv: b(iv),
    tag: b(tag),
    ct: b(ct),
    ivB64: iv,
    tagB64: tag,
    ctB64: ct,
  };
}

/* Assemble. The only place field ORDER is written down for a write, so a
 * re-key cannot disagree with an encrypt about where the DEK lives. */
function buildEnvelope({ opFp, recFp, wrapped, sealedB64, ivB64, tagB64, ctB64 }) {
  return [
    VERSION, opFp, recFp,
    wrapped.iv.toString('base64'),
    wrapped.tag.toString('base64'),
    wrapped.ct.toString('base64'),
    sealedB64, ivB64, tagB64, ctB64,
  ].join(':');
}

function notAnEnvelope(what) {
  return cryptoError(`stored value is not in the v2 encrypted format — refusing to ${what} it`);
}

/*
 * plaintext → 'v2:<op_fp>:<rec_fp>:<dek_iv>:<dek_tag>:<dek_ct>:<sealed>:<iv>:<tag>:<ct>'.
 *
 * A FRESH DEK PER VALUE, never a shared one. Two employees banking at the same
 * account must not produce anything comparable, and a per-value DEK also means
 * the blast radius of any single unsealed DEK is exactly one field.
 *
 * null / undefined / '' → null (there is nothing to protect), but BOTH KEYS ARE
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
  // to be filled in" without a single test going red. Both keys, both here:
  // a write with no recovery path is as much a defect as one with no key.
  const op = loadOperationalKey();
  const rec = activeRecoveryKey();
  if (plaintext == null || plaintext === '') return null;
  const text = String(plaintext);
  if (isEncrypted(text)) return text;

  const dek = crypto.randomBytes(KEY_BYTES);
  const value = gcmSeal(dek, Buffer.from(text, 'utf8'));
  const out = buildEnvelope({
    opFp: op.fp,
    recFp: rec.fp,
    wrapped: gcmSeal(op.key, dek),
    sealedB64: crypto.publicEncrypt({ key: rec.key, ...OAEP }, dek).toString('base64'),
    ivB64: value.iv.toString('base64'),
    tagB64: value.tag.toString('base64'),
    ctB64: value.ct.toString('base64'),
  });

  if (out.length > MAX_CIPHERTEXT_CHARS) {
    throw Object.assign(
      new Error(`value is too long to store encrypted (${out.length} > ${MAX_CIPHERTEXT_CHARS} chars)`),
      { status: 400, code: 'FIELD_TOO_LONG' },
    );
  }
  return out;
}

/* Open the DEK with an operational key whose fingerprint the envelope names.
 * Shared by decryptField and the re-key primitives so "which key, and what does
 * a mismatch mean" is decided once. */
function unwrapDek(env, opKey, opFp) {
  if (env.opFp !== opFp) {
    /*
     * DISTINCT from a tag failure on purpose. "The tag did not verify" and "I do
     * not hold this key" are the same event to AES-GCM and completely different
     * events to whoever is paged: the first is corruption or tampering, the
     * second is a rotation that lost a key — and its remedy is either to restore
     * that key or to break-glass with the recovery key named in the same
     * message. Fingerprints are hash prefixes, not key material.
     *
     * The code is FIELD_KEY_NOT_IN_RING, kept verbatim across two redesigns: the
     * machine code is a stable contract and the meaning — "the key this row
     * names is not the key I hold" — has never changed.
     */
    throw Object.assign(
      new Error(
        `value was encrypted under operational key ${env.opFp} but the key in hand is ${opFp}`
        + ` — restore that key, or break-glass with scripts/field-recover.js and the recovery`
        + ` key ${env.recFp}`,
      ),
      {
        status: 500,
        code: 'FIELD_KEY_NOT_IN_RING',
        fingerprint: env.opFp,
        activeFingerprint: opFp,
        recoveryFingerprint: env.recFp,
      },
    );
  }
  try {
    return gcmOpen(opKey, env.dekIv, env.dekTag, env.dekCt);
  } catch (e) {
    throw decryptFailed(
      'the wrapped data key failed its authentication tag — it was altered or corrupted in storage',
      e,
    );
  }
}

/*
 * envelope → plaintext, via the OPERATIONAL key. The normal read path; the
 * recovery key plays no part in it and is not even resolved.
 *
 * null / '' → null. Everything else must be a well-formed v2 envelope: a value
 * that is NOT one is REFUSED, never returned as-is. Returning it would be the
 * plaintext fallback wearing a different hat — one bad write, or one row
 * inserted by a tool that bypassed this helper, and the read path starts serving
 * raw account numbers while every test still passes. A v1 value lands in that
 * same refusal; see the header.
 *
 * A tampered ciphertext, IV, tag or WRAPPED DEK fails a GCM tag and throws here.
 * It never decrypts to garbage that the caller could mistake for an account
 * number.
 */
function decryptField(value) {
  const op = loadOperationalKey();
  if (value == null || value === '') return null;
  const text = String(value);
  if (!isEncrypted(text)) throw notAnEnvelope('read');
  const env = parseEnvelope(text);
  const dek = unwrapDek(env, op.key, op.fp);
  try {
    return gcmOpen(dek, env.iv, env.tag, env.ct).toString('utf8');
  } catch (e) {
    // The key was right (its fingerprint matched and it opened the DEK), so a
    // failure here is corruption or tampering of the value itself.
    throw decryptFailed(
      'value failed its authentication tag — it was altered or corrupted in storage', e,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BREAK GLASS — everything below needs the recovery PRIVATE key, which no
// server holds. Nothing in the request path calls any of it.
// ═══════════════════════════════════════════════════════════════════════════

/*
 * Unseal the DEK with the recovery PRIVATE key.
 *
 * `privateKeyPem` is a PEM string, Buffer or KeyObject and is NEVER logged,
 * stored, echoed or attached to an error — the closest anything here comes to
 * naming it is the FINGERPRINT of its public half, which is what makes the
 * mismatch message useful without making it dangerous.
 */
function unsealDek(env, privateKeyPem) {
  let priv;
  try {
    priv = crypto.createPrivateKey(privateKeyPem);
  } catch (e) {
    throw Object.assign(
      new Error(`the recovery private key did not parse (${e.message})`),
      { status: 500, code: 'FIELD_RECOVERY_FAILED' },
    );
  }
  /*
   * Check the fingerprint BEFORE attempting the unseal, so "you brought the
   * wrong key out of your notes" and "this row's sealed DEK was tampered with"
   * are different errors. RSA-OAEP fails identically for both, and at 2am with
   * three keys in a password manager, "the row wants 3f2a1b9c, you supplied
   * 91cc07de" is the whole answer.
   */
  const suppliedFp = publicKeyFingerprint(crypto.createPublicKey(priv));
  if (suppliedFp !== env.recFp) {
    throw Object.assign(
      new Error(
        `this value is sealed to recovery key ${env.recFp}, but the private key supplied is the`
        + ` half of ${suppliedFp} — fetch the matching recovery key`,
      ),
      {
        status: 500,
        code: 'FIELD_RECOVERY_KEY_MISMATCH',
        fingerprint: env.recFp,
        suppliedFingerprint: suppliedFp,
      },
    );
  }
  try {
    return crypto.privateDecrypt({ key: priv, ...OAEP }, env.sealed);
  } catch (e) {
    throw Object.assign(
      new Error(
        `the sealed data key failed to unseal under recovery key ${env.recFp} — it was altered`
        + ' or corrupted in storage',
      ),
      // Deliberately not FIELD_DECRYPT_FAILED: this is the break-glass door and
      // its failures have their own remedy. And deliberately not
      // FIELD_RECOVERY_KEY_MISMATCH: the key was right, so this is tampering.
      { status: 500, code: 'FIELD_RECOVERY_FAILED', cause: e },
    );
  }
}

/*
 * BREAK GLASS. envelope → plaintext using ONLY the recovery private key.
 *
 * EASYFIX_FIELD_ENC_KEY is not read, not needed and may be absent, wrong or
 * belong to a different environment entirely — that is the entire point. This
 * is what makes the recovery key a genuine backstop rather than a second copy of
 * the operational one.
 */
function recoverField(value, privateKeyPem) {
  if (value == null || value === '') return null;
  const text = String(value);
  if (!isEncrypted(text)) throw notAnEnvelope('read');
  const env = parseEnvelope(text);
  const dek = unsealDek(env, privateKeyPem);
  try {
    return gcmOpen(dek, env.iv, env.tag, env.ct).toString('utf8');
  } catch (e) {
    throw decryptFailed(
      'value failed its authentication tag — it was altered or corrupted in storage', e,
    );
  }
}

/*
 * ── THE TWO RE-KEY PRIMITIVES ───────────────────────────────────────────
 *
 * One envelope in, one envelope out. Exported rather than buried in the CLI
 * because two bulk flows will be built on them, and a second implementation of
 * unwrap-then-rewrap is exactly the duplication the boundary guard in
 * tests/bank-encryption-boundary.test.js exists to prevent.
 *
 * THE VALUE CIPHERTEXT IS BYTE-IDENTICAL AFTERWARDS in both. That is not a
 * pleasant side effect, it is the property that makes a bulk re-key SAFE TO
 * INTERRUPT: a job killed halfway has produced rows that differ from their
 * originals only in a DEK wrapper, every one of them still readable by somebody,
 * and re-running it is idempotent by fingerprint. Pinned by a test.
 */

/*
 * Re-wrap the DEK under a NEW operational key.
 *
 * Unwraps with `opts.currentKey` (a normal rotation, both keys in hand) or with
 * `opts.recoveryPrivateKey` (break-glass: the previous operational key is GONE).
 * The sealed DEK, the recovery fingerprint and the value ciphertext all pass
 * through untouched, so the break-glass door stays open after the repair.
 */
function rewrapToOperationalKey(envelope, newKey, opts = {}) {
  const text = String(envelope ?? '');
  if (!isEncrypted(text)) throw notAnEnvelope('rewrap');
  const env = parseEnvelope(text);
  const target = toOperationalKey(newKey, 'the new operational key');

  let dek;
  if (opts.currentKey != null) {
    const current = toOperationalKey(opts.currentKey, 'the current operational key');
    dek = unwrapDek(env, current, fingerprint(current));
  } else if (opts.recoveryPrivateKey != null) {
    dek = unsealDek(env, opts.recoveryPrivateKey);
  } else {
    throw cryptoError('rewrapToOperationalKey needs opts.currentKey or opts.recoveryPrivateKey');
  }

  const out = buildEnvelope({
    opFp: fingerprint(target),
    recFp: env.recFp,          // unchanged
    wrapped: gcmSeal(target, dek),
    sealedB64: env.sealedB64,  // unchanged — the break-glass door stays open
    ivB64: env.ivB64,          // unchanged
    tagB64: env.tagB64,        // unchanged
    ctB64: env.ctB64,          // unchanged
  });
  // Prove it before handing it back. An envelope the normal path cannot open
  // would be written to the column and discovered by the next reader, having
  // overwritten the only copy that worked.
  assertOpens(out, target, dek);
  return out;
}

/*
 * Re-seal the DEK to a NEW recovery public key — the answer to a LEAKED recovery
 * key. Needs the OLD recovery private key, because that is the only thing that
 * can open the seal being replaced.
 *
 * ⚠ A recovery key that was LOST rather than leaked cannot be re-sealed away:
 *   this function needs it. Rows already written keep no break-glass path, the
 *   data is NOT lost (the operational key still reads it perfectly), and the
 *   path returns as rows are rewritten. Say that to the operator, not "rotated".
 *
 * The wrapped DEK, the operational fingerprint and the value ciphertext pass
 * through untouched, so a re-seal cannot break a normal read.
 */
function resealToRecoveryKey(envelope, newPublicKey, opts = {}) {
  const text = String(envelope ?? '');
  if (!isEncrypted(text)) throw notAnEnvelope('reseal');
  const env = parseEnvelope(text);
  if (opts.recoveryPrivateKey == null) {
    throw cryptoError(
      'resealToRecoveryKey needs opts.recoveryPrivateKey — the OLD recovery private key is the'
      + ' only thing that can open the seal being replaced',
    );
  }
  const target = toPublicKey(newPublicKey, 'the new recovery public key');
  const dek = unsealDek(env, opts.recoveryPrivateKey);

  return buildEnvelope({
    opFp: env.opFp,            // unchanged
    recFp: publicKeyFingerprint(target),
    wrapped: { iv: env.dekIv, tag: env.dekTag, ct: env.dekCt },  // unchanged
    sealedB64: crypto.publicEncrypt({ key: target, ...OAEP }, dek).toString('base64'),
    ivB64: env.ivB64,          // unchanged
    tagB64: env.tagB64,        // unchanged
    ctB64: env.ctB64,          // unchanged
  });
}

/* Re-open a freshly built envelope with the key it claims, before it is
 * returned to be written anywhere. */
function assertOpens(envelope, opKey, expectedDek) {
  const env = parseEnvelope(envelope);
  const dek = unwrapDek(env, opKey, fingerprint(opKey));
  if (!crypto.timingSafeEqual(dek, expectedDek)) {
    throw decryptFailed('re-wrapped data key did not round-trip — refusing to return it');
  }
  gcmOpen(dek, env.iv, env.tag, env.ct);
}

/*
 * The CLI's rewrap: re-wrap under the CURRENT env operational key using the
 * recovery private key. A one-liner over the primitive so the tool and the bulk
 * flows share an implementation.
 */
function rewrapField(value, privateKeyPem) {
  const op = loadOperationalKey();
  if (value == null || value === '') return null;
  return rewrapToOperationalKey(String(value), op.key, { recoveryPrivateKey: privateKeyPem });
}

// ═══════════════════════════════════════════════════════════════════════════
// DISPLAY
// ═══════════════════════════════════════════════════════════════════════════

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
  // The request path. Unchanged signatures — no caller in services/ or routes/
  // needs to know any of the above happened.
  encryptField,
  decryptField,
  isEncrypted,
  maskAccountNumber,
  maskName,

  // Recovery-key resolution. The admin flow owns the table; this owns the key.
  resolveRecoveryPublicKey,
  recoveryKeyByFingerprint,

  // Break glass and bulk re-keying. Every one of these needs a key the servers
  // do not hold. scripts/field-recover.js is a thin wrapper over them.
  recoverField,
  rewrapField,
  rewrapToOperationalKey,
  resealToRecoveryKey,
};
