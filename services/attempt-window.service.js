/*
 * SHARED GUESS WINDOWS — "5 attempts per 30 minutes" for the two codes that
 * have no otp_details row to count on:
 *   checkoutPin  — the closing PIN (tbl_job.otp), keyed per JOB   ('job:<id>')
 *   profileOtp   — the profile/bank-change OTP (tbl_easyfixer),
 *                  keyed per TECHNICIAN                          ('efr:<id>')
 * The login OTP counts on otp_details itself (services/otp-attempts.service.js).
 *
 * Same rule as that one: every attempt is CLAIMED before its compare; a full
 * window refuses without comparing; a right answer clears; the lock lifts by
 * itself 30 minutes after the window opened.
 *
 * WHERE THE COUNT LIVES. tbl_attempt_window (migrations/2026-09-11-create-tbl-
 * attempt-window.sql), so every backend container counts in one place and the
 * admin "Unlock OTP / PIN" action clears it for all of them. Until that table
 * exists — and whenever a query against it fails — each process counts in its
 * own memory (middleware/rate-limit.js attemptWindow), as it did before the
 * table: degraded to per-process, NEVER to unlimited, never a 500.
 *
 * ATOMIC CLAIM. The row is created if missing (INSERT IGNORE), then ONE guarded
 * UPDATE both checks and counts: its WHERE refuses a full window, and InnoDB
 * runs concurrent UPDATEs of the row one at a time against the latest value.
 * So at most 5 claims succeed per window however many arrive at once, across
 * containers. In memory, claim() is synchronous — Node runs it to completion.
 *
 * TIME. All arithmetic in SQL against Date parameters (the pool serializes them
 * as IST, as the stored value was) — never NOW(): the session time_zone is
 * SYSTEM, not IST.
 *
 * Every function takes an optional `db` so a caller with an injected pool (the
 * profile OTP service) keeps its test seam: a fake pool stays the only
 * database touched.
 */

const { pool } = require('../db');
const logger = require('../logger');
const { attemptWindow } = require('../middleware/rate-limit');
const { OTP_MAX_ATTEMPTS, OTP_ATTEMPT_WINDOW_MINUTES } = require('../utils/otp');

const TABLE = 'tbl_attempt_window';
const MAX = OTP_MAX_ATTEMPTS;
const WINDOW_MINUTES = OTP_ATTEMPT_WINDOW_MINUTES;
const WINDOW_MS = WINDOW_MINUTES * 60 * 1000;
const ABSENT_RECHECK_MS = 60 * 1000;

let _present = false;
let _absentCheckedAt = 0;

async function tablePresent(db) {
  if (_present) return true;
  if (_absentCheckedAt && Date.now() - _absentCheckedAt < ABSENT_RECHECK_MS) return false;
  try {
    const [rows] = await db.query(
      `SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`, [TABLE],
    );
    if (rows.length > 0) {
      _present = true;
      logger.info(`Guess windows now SHARED — counting in ${TABLE} (checkout PIN, profile/bank OTP).`);
      return true;
    }
    if (!_absentCheckedAt) {
      logger.warn(`Guess windows counting PER PROCESS — ${TABLE} does not exist. Run `
        + 'migrations/2026-09-11-create-tbl-attempt-window.sql before running more than one backend container.');
    }
  } catch (e) {
    logger.warn('Guess-window table probe failed · ' + e.message);
  }
  _absentCheckedAt = Date.now();
  return false;
}

/* A "no such table" error: forget the cached answer, so the next call re-probes. */
function noteFailure(e) {
  if (e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146)) { _present = false; _absentCheckedAt = 0; }
}

const GRANTED = Object.freeze({ locked: false, attemptsRemaining: null, retryAfterMinutes: null });

function view(r) {
  const inWindow = !!r && (r.in_window === true || Number(r.in_window) === 1);
  const used = inWindow ? Number(r.attempts) || 0 : 0;
  const locked = used >= MAX;
  return {
    locked,
    attemptsRemaining: Math.max(0, MAX - used),
    // Rounded UP and never 0: "try again in 0 minutes" while refusing reads as broken.
    retryAfterMinutes: locked ? Math.max(1, Math.ceil((Number(r.secs_left) || 0) / 60)) : null,
  };
}

async function readState(fullKey, db) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - WINDOW_MS);
  const [[r]] = await db.query(
    `SELECT attempts,
            (window_start IS NOT NULL AND window_start >= ?) AS in_window,
            TIMESTAMPDIFF(SECOND, ?, DATE_ADD(window_start, INTERVAL ? MINUTE)) AS secs_left
       FROM ${TABLE} WHERE attempt_key = ?`,
    [cutoff, now, WINDOW_MINUTES, fullKey],
  );
  return view(r);
}

function sharedAttemptWindow(namespace) {
  const memory = attemptWindow({ max: MAX, windowMs: WINDOW_MS });
  const full = (key) => `${namespace}:${key}`;
  return {
    namespace,

    /** Count one attempt. `locked: true` → the window is full: refuse WITHOUT comparing. */
    async claim(key, db = pool) {
      if (!(await tablePresent(db))) return memory.claim(key);
      try {
        const now = new Date();
        const cutoff = new Date(now.getTime() - WINDOW_MS);
        await db.query(
          `INSERT IGNORE INTO ${TABLE} (attempt_key, attempts, window_start, updated_on) VALUES (?, 0, NULL, ?)`,
          [full(key), now],
        );
        // attempts is assigned BEFORE window_start: MySQL evaluates the SET left
        // to right, so both IFs then test the OLD window (swapped, an expired
        // window would reopen first and the stale count would carry on).
        const [res] = await db.query(
          `UPDATE ${TABLE}
              SET attempts     = IF(window_start IS NULL OR window_start < ?, 1, attempts + 1),
                  window_start = IF(window_start IS NULL OR window_start < ?, ?, window_start),
                  updated_on   = ?
            WHERE attempt_key = ?
              AND (window_start IS NULL OR window_start < ? OR attempts < ?)`,
          [cutoff, cutoff, now, now, full(key), cutoff, MAX],
        );
        if (res && res.affectedRows > 0) return GRANTED;
        const st = await readState(full(key), db);
        if (st.locked) logger.warn(`Attempt refused · ${full(key)} · lifts in ~${st.retryAfterMinutes}m`);
        return st;
      } catch (e) {
        noteFailure(e);
        logger.warn(`Guess-window claim failed · ${full(key)} · counting in memory · ${e.message}`);
        return memory.claim(key);
      }
    },

    /** How many attempts are left / when the lock lifts. */
    async state(key, db = pool) {
      if (!(await tablePresent(db))) return memory.state(key);
      try { return await readState(full(key), db); } catch (e) {
        noteFailure(e);
        logger.warn(`Guess-window read failed · ${full(key)} · ${e.message}`);
        return memory.state(key);
      }
    },

    /** Close the window — on a right answer, or an admin unlock. Clears memory too. */
    async clear(key, db = pool) {
      memory.clear(key);
      if (!(await tablePresent(db))) return;
      try { await db.query(`DELETE FROM ${TABLE} WHERE attempt_key = ?`, [full(key)]); } catch (e) {
        noteFailure(e);
        logger.warn(`Guess-window clear failed · ${full(key)} · ${e.message}`);
      }
    },
  };
}

/* The two windows — ONE instance each, shared by the routes that count and the
 * admin unlock, so even the in-memory fallback is cleared in the same place. */
const checkoutPin = sharedAttemptWindow('checkout-pin');
const profileOtp = sharedAttemptWindow('profile-otp');

/** Tests only — forget the cached table probe. */
function _resetProbeCache() { _present = false; _absentCheckedAt = 0; }

module.exports = { checkoutPin, profileOtp, sharedAttemptWindow, TABLE, ABSENT_RECHECK_MS, _resetProbeCache };
