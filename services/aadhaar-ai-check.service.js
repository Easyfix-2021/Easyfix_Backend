const crypto = require('crypto');

const { pool } = require('../db');
const logger = require('../logger');
const { aadhaarHmacKey } = require('../utils/aadhaar-uniqueness');

/*
 * The technician Identity step's AI Aadhaar check, ON RECORD (owner, 2026-09-29).
 *
 * POST /mobile/kyc/aadhaar-ocr records one row per check it runs; POST
 * /mobile/profile/identity-details refuses an identity save for which no check
 * is on record against the SAME inputs; the CRM verification page shows the
 * check the accepted save used.
 *
 * WHAT IS STORED — the minimum: outcome, verdict, a reason, the card's LAST 4
 * digits, the name score, the per-field discrepancies (Aadhaar numbers only
 * ever masked), a keyed fingerprint of the inputs, and two timestamps. Never
 * the full number, never an image.
 *
 * STALENESS. `input_fingerprint` is an HMAC over what the check actually read:
 * the name, Aadhaar number and DOB the form will hold AFTER the app adopts the
 * card read, plus the MD5 of each photo's bytes. The identity save recomputes it
 * from what it is about to write (+ the photo digests the app sends, which are
 * the same MD5s the upload route verifies against the bytes) — so a check run
 * before any of those changed simply does not match, and the save is refused.
 *
 * POST-ADOPTION, NOT AS TYPED. The app fills EMPTY fields from the card read
 * (adoptAadhaarOcr in the app's src/features/registration/aadhaarOcrOutcome.ts)
 * and then saves those values; fingerprinting what was typed would make every
 * check that filled a blank instantly stale. effectiveInputs() below is the
 * server-side mirror of that rule — empty fields only — and must stay in step.
 *
 * NOT RETROACTIVE. Nothing here reads or changes identity completeness
 * (services/profile-completion.service.js is untouched): rows saved before this
 * existed stay exactly as complete as they were. Only a save from now on needs
 * a check, and a PAN- or driving-licence-only save never does.
 *
 * MIGRATION-SAFE. migrations/2026-09-29-01-aadhaar-ai-check.sql creates the
 * table. Until it has run, the probe below reports it absent: checks are not
 * recorded and enforcement is skipped with a warning, instead of 500ing.
 */

const TABLE = 'tbl_easyfixer_aadhaar_ai_check';
const COLUMNS = Object.freeze([
  'id', 'efr_id', 'status', 'verdict', 'reason', 'aadhaar_last4', 'name_score',
  'discrepancies', 'input_fingerprint', 'created_at', 'submitted_at',
]);

const SCHEMA_POSITIVE_TTL_MS = 60 * 60 * 1000;
const SCHEMA_NEGATIVE_TTL_MS = 60 * 1000;
let probeCache = null;

/*
 * Cached column probe, the LMS_FLAG_COLUMNS shape: present → cached an hour;
 * absent or a failed probe → re-tested after a minute. A FAILED probe reports
 * the table PRESENT (a hiccup is not evidence of absence, and skipping
 * enforcement on a guess is the unsafe direction).
 */
async function installed(runner = pool) {
  const now = Date.now();
  if (probeCache) {
    const ttl = probeCache.value ? SCHEMA_POSITIVE_TTL_MS : SCHEMA_NEGATIVE_TTL_MS;
    if (now - probeCache.checkedAt < ttl) return probeCache.value;
  }
  try {
    const [rows] = await runner.query(
      `SELECT column_name AS c
         FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = ?`,
      [TABLE],
    );
    const present = new Set((rows || []).map((r) => String(r.c || r.COLUMN_NAME || '').toLowerCase()));
    const missing = COLUMNS.filter((c) => !present.has(c));
    const value = missing.length === 0;
    if (!value) {
      logger.warn('Aadhaar AI check schema probe · missing ' + TABLE + ' columns ' + missing.join(', ')
        + ' — checks are not recorded and identity saves are NOT enforced'
        + ' (run migrations/2026-09-29-01-aadhaar-ai-check.sql)');
    }
    probeCache = { value, checkedAt: now };
  } catch (e) {
    logger.warn('Aadhaar AI check schema probe failed · ' + e.message + ' — assuming the table is present');
    probeCache = { value: true, checkedAt: now - SCHEMA_POSITIVE_TTL_MS + SCHEMA_NEGATIVE_TTL_MS };
  }
  return probeCache.value;
}

const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '');
const TWELVE = /^\d{12}$/;
const MD5 = /^[a-f0-9]{32}$/i;

// YYYY-MM-DD, or ''. A trailing time is dropped (same rule as the app's normalizeIsoDate).
function isoDate(v) {
  const m = String(v == null ? '' : v).trim().match(/^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/);
  return m ? m[1] : '';
}

function maskAadhaar(v) {
  const d = digits(v);
  return d.length >= 4 ? `XXXX XXXX ${d.slice(-4)}` : null;
}

/*
 * What the form holds once the app has adopted the card read — EMPTY FIELDS
 * ONLY, mirroring adoptAadhaarOcr. A field the technician filled keeps what
 * they typed, however wrong; that disagreement is a discrepancy, not a fill.
 */
function effectiveInputs(typed = {}, extracted = null) {
  const x = extracted || {};
  const typedNumber = digits(typed.aadhaarNumber);
  const cardNumber = digits(x.aadhaarNumber);
  const typedName = String(typed.name == null ? '' : typed.name).trim();
  return {
    name: typedName || String(x.name == null ? '' : x.name).trim(),
    aadhaarNumber: !TWELVE.test(typedNumber) && TWELVE.test(cardNumber) ? cardNumber : typedNumber,
    dob: isoDate(typed.dob) || isoDate(x.dob),
  };
}

function fingerprint(efrId, { name, aadhaarNumber, dob, frontMd5, backMd5 }) {
  return crypto
    .createHmac('sha256', aadhaarHmacKey())
    .update(JSON.stringify([
      Number(efrId),
      String(name == null ? '' : name).replace(/\s+/g, ' ').trim().toLowerCase(),
      digits(aadhaarNumber),
      isoDate(dob),
      String(frontMd5 || '').toLowerCase(),
      String(backMd5 || '').toLowerCase(),
    ]))
    .digest('hex');
}

const md5 = (buffer) => crypto.createHash('md5').update(buffer).digest('hex');

/*
 * The decision table, server side. Same rules as the app's
 * deriveAadhaarOcrOutcome: status from the name comparison, number/DOB
 * discrepancies only when BOTH sides are complete, and
 *   verdict 'verified' = matched with no discrepancy
 *           'mismatch' = a name mismatch or ANY discrepancy
 *           'not_run'  = no extraction, or no name to compare
 */
function evaluate(ocr = {}, typed = {}) {
  if (!ocr.available || !ocr.extracted) {
    return {
      status: 'unavailable',
      verdict: 'not_run',
      reason: ocr.reason || 'unreadable',
      aadhaarLast4: null,
      nameScore: null,
      discrepancies: [],
    };
  }
  const x = ocr.extracted;
  const nm = ocr.nameMatch;
  const status = nm ? (nm.matched ? 'matched' : 'mismatch') : 'unmatched';
  const discrepancies = [];
  if (status === 'mismatch') {
    discrepancies.push({ field: 'name', expected: nm.expected || null, found: nm.found || x.name || null });
  }
  const typedNumber = digits(typed.aadhaarNumber);
  const cardNumber = digits(x.aadhaarNumber);
  if (TWELVE.test(typedNumber) && TWELVE.test(cardNumber) && typedNumber !== cardNumber) {
    discrepancies.push({ field: 'aadhaarNumber', expected: maskAadhaar(typedNumber), found: maskAadhaar(cardNumber) });
  }
  const typedDob = isoDate(typed.dob);
  const cardDob = isoDate(x.dob);
  if (typedDob && cardDob && typedDob !== cardDob) {
    discrepancies.push({ field: 'dob', expected: typedDob, found: cardDob });
  }
  let verdict = 'not_run';
  if (status === 'mismatch' || discrepancies.length > 0) verdict = 'mismatch';
  else if (status === 'matched') verdict = 'verified';
  const score = nm && typeof nm.score === 'number' && nm.score >= 0 && nm.score <= 1 ? nm.score : null;
  return {
    status,
    verdict,
    reason: status === 'unmatched' ? 'name_not_compared' : null,
    aadhaarLast4: TWELVE.test(cardNumber) ? cardNumber.slice(-4) : null,
    nameScore: score,
    discrepancies,
  };
}

/**
 * Record one completed check. `typed` is what the form held when the check was
 * launched; `front`/`back` are the uploaded image buffers. Returns null (and
 * records nothing) before the migration; a DB error propagates, because a check
 * the app believes counts but the server never stored would only surface later
 * as a refused save.
 */
async function recordCheck(efrId, { ocr, typed = {}, front, back }, { database = pool } = {}) {
  if (!(await installed(database))) return null;
  const result = evaluate(ocr, typed);
  const effective = effectiveInputs(typed, ocr && ocr.available ? ocr.extracted : null);
  const fp = fingerprint(efrId, { ...effective, frontMd5: md5(front), backMd5: md5(back) });
  const [inserted] = await database.query(
    `INSERT INTO ${TABLE}
       (efr_id, status, verdict, reason, aadhaar_last4, name_score, discrepancies, input_fingerprint, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(efrId),
      result.status,
      result.verdict,
      result.reason,
      result.aadhaarLast4,
      result.nameScore,
      result.discrepancies.length ? JSON.stringify(result.discrepancies) : null,
      fp,
      new Date(),
    ],
  );
  logger.info({ efrId, status: result.status, verdict: result.verdict }, 'Aadhaar AI check recorded');
  return { id: Number(inserted.insertId), status: result.status, verdict: result.verdict };
}

// Fields whose save must be backed by a check. PAN / driving licence are not.
const IDENTITY_FIELDS = ['aadhaarNumber', 'aadhaar', 'name', 'firstName', 'lastName', 'dob'];

function touchesAadhaarIdentity(body = {}) {
  return IDENTITY_FIELDS.some((k) => body[k] !== undefined && body[k] !== null && body[k] !== '')
    || Boolean(body.docs && (body.docs.aadhaarFront || body.docs.aadhaarBack));
}

function checkRequiredError(code, message) {
  const error = new Error(message);
  error.status = 422;
  error.details = { code };
  return error;
}

/**
 * The enforcement rule. For a save that writes Aadhaar identity, BOTH Aadhaar
 * photos and their digests must be in the save, and a recorded check must
 * carry the fingerprint of (name, Aadhaar number, DOB, front MD5, back MD5)
 * exactly as this save writes them. Returns the matching check row
 * ({ id, verdict }), or null when the save needs none / the table is absent.
 */
async function assertCurrentCheck(runner, efrId, body = {}) {
  if (!touchesAadhaarIdentity(body)) return null;
  if (!(await installed(runner))) {
    logger.warn({ efrId }, 'Identity save NOT checked against an Aadhaar AI check · table absent');
    return null;
  }
  const docs = body.docs || {};
  const photoDigests = body.aadhaarPhotoDigests || {};
  if (!docs.aadhaarFront || !docs.aadhaarBack || !MD5.test(photoDigests.front || '') || !MD5.test(photoDigests.back || '')) {
    throw checkRequiredError(
      'AADHAAR_PHOTOS_REQUIRED',
      'Add both Aadhaar photos and run Verify With AI before saving your identity',
    );
  }
  const fp = fingerprint(efrId, {
    name: body.name,
    aadhaarNumber: body.aadhaarNumber || body.aadhaar,
    dob: body.dob,
    frontMd5: photoDigests.front,
    backMd5: photoDigests.back,
  });
  const [rows] = await runner.query(
    `SELECT id, verdict, input_fingerprint = ? AS is_current
       FROM ${TABLE}
      WHERE efr_id = ?
      ORDER BY is_current DESC, id DESC
      LIMIT 1`,
    [fp, Number(efrId)],
  );
  const row = rows && rows[0];
  if (row && Number(row.is_current) === 1) return { id: Number(row.id), verdict: row.verdict };
  throw row
    ? checkRequiredError('AADHAAR_AI_CHECK_STALE', 'Your details changed after the AI check — run Verify With AI again')
    : checkRequiredError('AADHAAR_AI_CHECK_REQUIRED', 'Run Verify With AI on your Aadhaar before saving your identity');
}

async function markSubmitted(runner, checkId) {
  if (!checkId) return;
  await runner.query(`UPDATE ${TABLE} SET submitted_at = ? WHERE id = ?`, [new Date(), Number(checkId)]);
}

function parseDiscrepancies(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

/**
 * The check behind the technician's latest SUBMITTED identity — what the CRM
 * shows and what the app's "under review" note reads. null when none (a legacy
 * save, or the table is absent).
 */
async function latestSubmitted(efrId, { database = pool } = {}) {
  if (!(await installed(database))) return null;
  const [rows] = await database.query(
    `SELECT id, status, verdict, reason, aadhaar_last4, name_score, discrepancies, created_at, submitted_at
       FROM ${TABLE}
      WHERE efr_id = ? AND submitted_at IS NOT NULL
      ORDER BY submitted_at DESC, id DESC
      LIMIT 1`,
    [Number(efrId)],
  );
  const r = rows && rows[0];
  if (!r) return null;
  return {
    id: Number(r.id),
    status: r.status,
    verdict: r.verdict,
    reason: r.reason || null,
    masked_number: r.aadhaar_last4 ? `XXXX XXXX ${r.aadhaar_last4}` : null,
    name_score: r.name_score == null ? null : Number(r.name_score),
    discrepancies: parseDiscrepancies(r.discrepancies),
    checked_at: r.created_at,
    submitted_at: r.submitted_at,
  };
}

// Correlated per-row read for a PAGINATED list (index efr_id, submitted_at).
function latestVerdictSql(alias = 'e') {
  return `(SELECT aic.verdict FROM ${TABLE} aic
            WHERE aic.efr_id = ${alias}.efr_id AND aic.submitted_at IS NOT NULL
            ORDER BY aic.submitted_at DESC, aic.id DESC LIMIT 1)`;
}

module.exports = {
  installed,
  recordCheck,
  assertCurrentCheck,
  markSubmitted,
  latestSubmitted,
  latestVerdictSql,
  touchesAadhaarIdentity,
  _internals: {
    TABLE,
    COLUMNS,
    effectiveInputs,
    evaluate,
    fingerprint,
    md5,
    resetProbeForTests() { probeCache = null; },
  },
};
