/*
 * OTP GUESS CAP — the storage and the rule behind utils/otp.js
 * OTP_MAX_ATTEMPTS, which until 2026-09-10 was declared, exported, and read
 * by nothing.
 *
 * Four services verify OTPs — auth (CRM), client-auth, tech-auth and
 * action-otp — and all four had the same unbounded shape: load the row for
 * this identifier, compare the submitted code, return OTP_MISMATCH. Nothing
 * counted the mismatches. A 4-digit code with a 5-minute window and no cap is
 * about ten thousand guesses against a live OTP.
 *
 * This module is the ONE place the cap lives, because four copies of a
 * security rule is four chances to fix three of them.
 *
 * ── IT FAILS OPEN, ON PURPOSE ──────────────────────────────────────────
 * `failed_attempts` arrives with migrations/2026-09-10-otp-failed-attempts.sql.
 * Until that has run, columnPresent() is false and every function here is a
 * no-op, so login behaves exactly as it did before.
 *
 * That is the right direction for an auth path and it is a deliberate choice
 * rather than an oversight: failing CLOSED on a missing column would lock out
 * every user of every login surface the moment the code deployed ahead of the
 * SQL, and throwing would 500 them instead. The cost of failing open is that
 * the cap is not enforced until the migration runs — a return to exactly
 * today's behaviour, which is the worst case either way.
 *
 * ── THE PROBE HEALS ITSELF ─────────────────────────────────────────────
 * A PRESENT column is cached for the life of the process (columns do not get
 * dropped under a running service). An ABSENT one is re-probed at most once a
 * minute. Caching "absent" forever would mean the cap stayed off after the
 * migration ran on a live environment, until somebody happened to restart it —
 * the deploy order would be safe but the fix would be silently inert, and
 * nothing would say so.
 *
 * ── THE RESET IS NOT OPTIONAL ──────────────────────────────────────────
 * clearAttempts() must run wherever a NEW code is written onto an existing
 * row. Without it the counter is per-ROW rather than per-CODE: a user who
 * mistyped five times could never log in again, and "Resend OTP" would be a
 * button that changes nothing. That would be a lockout bug wearing a security
 * feature's clothes.
 */

const { pool } = require('../db');
const logger = require('../logger');
const { OTP_MAX_ATTEMPTS } = require('../utils/otp');

/** How long an ABSENT answer is trusted before asking again. */
const ABSENT_RECHECK_MS = 60 * 1000;

let _present = false;      // once true, stays true
let _absentCheckedAt = 0;  // epoch ms of the last "absent" answer; 0 = never asked

async function columnPresent(db = pool) {
  if (_present) return true;
  if (_absentCheckedAt && Date.now() - _absentCheckedAt < ABSENT_RECHECK_MS) return false;
  try {
    const [rows] = await db.query(
      `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'otp_details'
          AND COLUMN_NAME = 'failed_attempts' LIMIT 1`,
    );
    if (rows.length > 0) {
      _present = true;
      if (_absentCheckedAt) logger.info('OTP attempt cap now ACTIVE — otp_details.failed_attempts appeared.');
      return true;
    }
    if (!_absentCheckedAt) {
      logger.warn('OTP attempt cap INACTIVE — otp_details.failed_attempts is missing. '
        + 'Run migrations/2026-09-10-otp-failed-attempts.sql; until then OTP guesses are unbounded.');
    }
    _absentCheckedAt = Date.now();
    return false;
  } catch (e) {
    // A failed probe must not fail the login it was asked about.
    logger.warn('OTP attempt-cap probe failed · ' + e.message);
    _absentCheckedAt = Date.now();
    return false;
  }
}

/**
 * Has this row spent its guess budget?
 *
 * TAKES AN ID AND READS THE COLUMN ITSELF, rather than a pre-SELECTed row.
 * The obvious design was to add `failed_attempts` to the four existing
 * projections and pass the row in — but those SELECTs run BEFORE the migration
 * does, and naming a column that does not exist is a hard SQL error on every
 * login. That would turn the fail-open design into a total outage in exactly
 * the window it was written to survive.
 *
 * So: no change to any existing query, and one extra read by primary key only
 * when the cap is actually active.
 */
async function isLockedOut(rowId, db = pool) {
  if (!(await columnPresent(db))) return false;
  try {
    const [[r]] = await db.query('SELECT failed_attempts FROM otp_details WHERE id = ?', [rowId]);
    return Number((r && r.failed_attempts) || 0) >= OTP_MAX_ATTEMPTS;
  } catch (e) {
    // Same direction as everything else here: a broken counter must not lock
    // out a user whose code may well be correct.
    logger.warn('OTP attempt-cap read failed · rowId=' + rowId + ' · ' + e.message);
    return false;
  }
}

/**
 * Count one wrong guess. Returns the new total, or null when the cap is
 * inactive.
 *
 * The UPDATE is unconditional rather than read-modify-write: two concurrent
 * wrong guesses must both count, and `failed_attempts = failed_attempts + 1`
 * is atomic in a way `SELECT` then `SET n+1` is not. Brute force is the case
 * where concurrency is the point.
 */
async function recordFailedAttempt(rowId, db = pool) {
  if (!(await columnPresent(db))) return null;
  try {
    await db.query(
      'UPDATE otp_details SET failed_attempts = failed_attempts + 1 WHERE id = ?', [rowId],
    );
    const [[r]] = await db.query('SELECT failed_attempts FROM otp_details WHERE id = ?', [rowId]);
    const n = Number(r && r.failed_attempts) || 0;
    if (n >= OTP_MAX_ATTEMPTS) {
      logger.warn(`OTP attempt cap reached · otpRowId=${rowId} · attempts=${n}/${OTP_MAX_ATTEMPTS} `
        + '· further guesses against this code are refused until a new one is sent');
    }
    return n;
  } catch (e) {
    // Losing the count is bad; failing the verify because the counter did not
    // write is worse — the user's code may well have been correct.
    logger.warn('OTP attempt increment failed · rowId=' + rowId + ' · ' + e.message);
    return null;
  }
}

/**
 * Give the row a fresh budget. Call wherever a NEW code is written onto an
 * existing row — see the header for why skipping this turns the cap into a
 * permanent lockout.
 */
async function clearAttempts(rowId, db = pool) {
  if (!(await columnPresent(db))) return;
  try {
    await db.query('UPDATE otp_details SET failed_attempts = 0 WHERE id = ?', [rowId]);
  } catch (e) {
    logger.warn('OTP attempt reset failed · rowId=' + rowId + ' · ' + e.message);
  }
}

/** Tests only — forget every cached probe answer. */
function _resetProbeCache() { _present = false; _absentCheckedAt = 0; }

module.exports = {
  OTP_MAX_ATTEMPTS,
  ABSENT_RECHECK_MS,
  isLockedOut,
  recordFailedAttempt,
  clearAttempts,
  columnPresent,
  _resetProbeCache,
};
