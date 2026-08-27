const crypto = require('node:crypto');
const logger = require('../logger');

const ACTIVE_AADHAAR_CONSTRAINT = 'uq_easyfixer_active_aadhaar';

/*
 * Aadhaar uniqueness — application-level guard + DB-violation classifier.
 *
 * WHY AN APPLICATION GUARD EXISTS AGAIN (2026-08-12)
 * migrations/2026-08-11-03-active-aadhaar-uniqueness.sql adds a generated column
 * AND a UNIQUE index over it, and the writer services were changed to rely on
 * that index alone. In production only the ADD COLUMN applied: the ADD UNIQUE
 * INDEX aborts while duplicate active values exist, and 11 such groups do. That
 * left every Aadhaar write completely unguarded, so the duplicate set kept
 * growing (8 groups -> 11 in a day) — which in turn pushes the index further out
 * of reach. This module breaks that loop from the code side.
 *
 * THIS IS AN IN-PROCESS STOP-GAP, NOT THE GUARANTEE. It cannot serialise the 5
 * legacy services that share easyfix_core and will never call GET_LOCK. Ops
 * resolving the duplicate groups and landing uq_easyfixer_active_aadhaar is the
 * only cross-service guarantee; keep the schema-verify invariant reporting it.
 *
 * PII: an Aadhaar value must never reach a log, a lock name, an error message,
 * `details`, or a response body. logger.js renders every key of every object
 * with no redaction, so a raw mysql2 ER_DUP_ENTRY (whose message embeds the
 * rejected value) must never be handed to a logger.
 */

function isAadhaarUniqueViolation(error) {
  if (error?.code !== 'ER_DUP_ENTRY') return false;
  // mysql2 includes the rejected value in message/sqlMessage. Inspect only for
  // the constraint name; callers must replace the original error before it can
  // reach application logs or an HTTP response.
  return [error.constraint, error.sqlMessage, error.message]
    .some((value) => String(value || '').includes(ACTIVE_AADHAAR_CONSTRAINT));
}

function aadhaarConflictError() {
  const error = new Error('This Aadhaar number is already registered to another technician');
  error.status = 409;
  error.details = { code: 'AADHAAR_ALREADY_REGISTERED' };
  return error;
}

function mapAadhaarUniqueViolation(error) {
  return isAadhaarUniqueViolation(error) ? aadhaarConflictError() : error;
}

/**
 * Fail-closed companion to the classifier above. isAadhaarUniqueViolation only
 * recognises the constraint by its literal name, and this migration has already
 * been hand-run once and partially failed — so an index created under a
 * different name is a real possibility. In that case the raw mysql2 error, whose
 * message embeds the rejected Aadhaar, would reach the error handler and be
 * logged verbatim. Apply ONLY to statements that write identity columns, so the
 * substitution's blast radius is exactly the statements whose duplicate-key
 * message can carry PII. Client-visible behaviour is unchanged (still a 500);
 * only the log line loses the value.
 */
function scrubDuplicateEntry(error, { aadhaarBound } = {}) {
  if (error?.code !== 'ER_DUP_ENTRY' || !aadhaarBound) return error;
  const mapped = mapAadhaarUniqueViolation(error);
  if (mapped !== error) return mapped;
  const scrubbed = new Error('a database uniqueness constraint rejected this identity write');
  scrubbed.code = 'ER_DUP_ENTRY';
  return scrubbed;
}

/** The single definition of the generated column's NULLIF(TRIM(x),'') input rule. */
function normalizeAadhaar(value) {
  return String(value ?? '').trim();
}

/*
 * A process-lifetime random key is the fallback when neither AADHAAR_LOCK_SALT
 * nor JWT_SECRET is set. It keeps the digest non-reversible, at the cost of
 * replicas disagreeing on the lock name — which only weakens cross-process
 * serialisation, never correctness of the SELECT performed under the lock.
 */
let fallbackKey = null;
function lockKeyMaterial() {
  const configured = process.env.AADHAAR_LOCK_SALT || process.env.JWT_SECRET;
  if (configured) return configured;
  if (!fallbackKey) {
    fallbackKey = crypto.randomBytes(32);
    logger.warn('AADHAAR_LOCK_SALT/JWT_SECRET unset — Aadhaar lock names are process-local');
  }
  return fallbackKey;
}

/**
 * Named-lock identifier for one Aadhaar value.
 *
 * HMAC rather than a bare digest: the Aadhaar space is 10^12, so an unsalted
 * hash is trivially reversible, and GET_LOCK names are visible in
 * performance_schema.metadata_locks and SHOW PROCESSLIST on a database shared
 * with 5 legacy services. Hash collisions are harmless — they only over-
 * serialise two unrelated numbers, and the SELECT under the lock still compares
 * the real value. 12 + 32 chars stays inside MySQL's 64-character limit.
 */
function activeAadhaarLockName(value) {
  return `efr_aadhaar:${crypto
    .createHmac('sha256', lockKeyMaterial())
    .update(normalizeAadhaar(value))
    .digest('hex')
    .slice(0, 32)}`;
}

// Whether the generated column exists. Probed once per process; a failure is
// treated as absent so nothing in the app assumes the migration ran.
let hasGeneratedColumn = null;
async function hasActiveAadhaarColumn(runner) {
  if (hasGeneratedColumn !== null) return hasGeneratedColumn;
  try {
    const [rows] = await runner.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'tbl_easyfixer'
          AND column_name = 'active_aadhaar_unique'
        LIMIT 1`,
    );
    hasGeneratedColumn = rows.length > 0;
    return hasGeneratedColumn;
  } catch (e) {
    // A failure is NOT cached. The success answer is frozen for the process because a column that exists does not vanish; a failure frozen the same way turns a two-second information_schema blip into a degraded mode that lasts until the container restarts, with nothing in the logs saying so.
    logger.warn('aadhaar: active_aadhaar_unique probe failed · ' + e.message
      + ' — treating as absent for this call only');
    return false;
  }
}

function resetActiveAadhaarColumnProbeForTests() {
  hasGeneratedColumn = null;
}

/**
 * Throw 409 when another non-deleted technician already holds this Aadhaar.
 *
 * `runner` comes FIRST because it must be the caller's pinned, lock-holding
 * connection: named locks are connection-scoped, so running this on the pool
 * would execute it outside the lock.
 *
 * Semantics match the generated column exactly — by construction when the
 * column exists, by transcription of the same CASE arms when it does not:
 *   - efr_status = 3 (soft-deleted) does NOT reserve a number (`<=>` is
 *     NULL-safe, so a NULL status still reserves);
 *   - TRIM, so ' 1234…' collides with '1234…';
 *   - blank/whitespace never collides — short-circuited before any query;
 *   - the caller's own row never counts as a conflict.
 * Never widen this to pan_card_number: the generated column covers Aadhaar only,
 * and matching PAN would reject an Aadhaar that merely equals someone's PAN.
 */
async function assertActiveAadhaarAvailable(runner, aadhaar, excludeEfrId) {
  const value = normalizeAadhaar(aadhaar);
  if (!value) return;
  const useGenerated = await hasActiveAadhaarColumn(runner);
  const [rows] = await runner.query(
    useGenerated
      ? `SELECT 1 AS conflict FROM tbl_easyfixer
          WHERE active_aadhaar_unique = ? AND efr_id <> ? LIMIT 1`
      : `SELECT 1 AS conflict FROM tbl_easyfixer
          WHERE NOT (efr_status <=> 3)
            AND NULLIF(TRIM(adhaar_card_number), '') = ?
            AND efr_id <> ? LIMIT 1`,
    [value, Number(excludeEfrId) || 0],
  );
  if (rows.length) throw aadhaarConflictError();
}

/**
 * Lock + check + run, the composition every writer uses.
 *
 * ORDERING RULE — never acquire this value lock while a transaction is open or
 * an InnoDB row lock is held. Both named locks are taken before any InnoDB lock,
 * so a session never waits on a user-level lock while holding row locks and a
 * named-lock wait can never join an InnoDB wait cycle. Coarse (value) before
 * fine (entity) gives a total order over the two named locks, so there is no
 * cycle among them either.
 *
 * A named lock is used rather than SELECT ... FOR UPDATE because there is no
 * index on adhaar_card_number — and the generated column's index is precisely
 * what is missing — so a locking read would degenerate into a full scan taking
 * next-key locks across the hottest table in the system.
 *
 * Blank input is a pure passthrough: no lock, no probe, no query. Without that
 * gate every doc-only or PAN-only save would hash the same empty string to the
 * same lock name and serialise the endpoint globally.
 */
async function withActiveAadhaarGuard(conn, aadhaar, excludeEfrId, fn) {
  const value = normalizeAadhaar(aadhaar);
  if (!value) return fn();

  // 5s, deliberately shorter than the 10s entity locks: genuine contention on a
  // single Aadhaar is pathological (double-submit or fraud) and a waiting
  // GET_LOCK pins a pool slot.
  const [[lock]] = await conn.query('SELECT GET_LOCK(?, 5) AS acquired', [
    activeAadhaarLockName(value),
  ]);
  if (Number(lock?.acquired) !== 1) {
    const error = new Error('Identity details are currently being updated; please retry');
    error.status = 409;
    // Deliberately the SAME code/message the per-technician lock emits. A
    // distinct "this Aadhaar is busy" response would be a timing oracle
    // revealing that someone else is submitting that exact number right now.
    error.details = { code: 'IDENTITY_UPDATE_IN_PROGRESS' };
    throw error;
  }

  try {
    await assertActiveAadhaarAvailable(conn, value, excludeEfrId);
    return await fn();
  } finally {
    await conn.query('SELECT RELEASE_LOCK(?) AS released', [activeAadhaarLockName(value)])
      .catch(() => {});
  }
}

module.exports = {
  ACTIVE_AADHAAR_CONSTRAINT,
  aadhaarConflictError,
  isAadhaarUniqueViolation,
  mapAadhaarUniqueViolation,
  scrubDuplicateEntry,
  normalizeAadhaar,
  activeAadhaarLockName,
  hasActiveAadhaarColumn,
  assertActiveAadhaarAvailable,
  withActiveAadhaarGuard,
  _internals: { resetActiveAadhaarColumnProbeForTests },
};
