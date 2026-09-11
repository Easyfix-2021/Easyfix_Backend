/*
 * OTP GUESS CAP — at most OTP_MAX_ATTEMPTS wrong codes per user within
 * OTP_ATTEMPT_WINDOW_MINUTES (5 in 30 minutes), after which verification is
 * refused until the window ends. It then resets BY ITSELF.
 *
 * WHY IT EXISTS: utils/otp.js declared OTP_MAX_ATTEMPTS = 5 from the day it was
 * written and nothing read it. Every OTP verify in this backend compared the
 * submitted code and returned a mismatch without counting. A 4-digit code with
 * no cap is about ten thousand guesses.
 *
 * WHY PER USER, ACROSS CODES. Owner's requirement: "max 5 times in 30 minutes,
 * so that the user does not get blocked in any case". An OTP lives
 * OTP_TTL_MINUTES (5), so a 30-minute limit on one code can never bind — the
 * code is dead first. Each user has ONE otp_details row, which every send path
 * UPDATEs in place with the new code, so the count lives on that row and
 * spans codes:
 *   - sending a new code does NOT reset it (or Resend is the way around it);
 *   - the lock lifts on its own, 30 minutes after the FIRST wrong code;
 *   - a successful verify clears it;
 *   - each wrong code reports how many attempts are left.
 *
 * ── WHERE THE STATE LIVES: two columns of otp_details ──────────────────
 *   failed_attempts  wrong codes in the current window. Added by
 *                    migrations/executed/2026-09-10-otp-failed-attempts.sql.
 *   updated_on       when the current window OPENED. An existing column: both
 *                    legacy JPA entities map it but no code ever sets it (they
 *                    only write back what they loaded), no Node code touches it,
 *                    and on 2026-09-11 it was NULL in all 10,928 QA rows. So it
 *                    had no meaning to break, and holding the window start there
 *                    needs no schema change. A counter alone cannot do this: it
 *                    knows HOW MANY, never WHEN, so it could never lift a lock
 *                    by itself.
 *
 * ── IT FAILS OPEN, ON PURPOSE ──────────────────────────────────────────
 * Until failed_attempts exists every function here is a no-op, and login
 * behaves as it did before any cap. Failing closed would lock every user of
 * every login surface out the moment the code outran the migration; naming a
 * missing column would 500 them. A present column is cached; an absent answer is
 * re-probed at most once a minute, so running the migration on a live
 * environment switches the cap on by itself. If the column vanishes mid-process
 * (qa-db-refresh restores QA from a replica), the first "unknown column" error
 * forgets the cached answer, so the next call re-probes.
 *
 * ── ALL TIME ARITHMETIC IS IN SQL ──────────────────────────────────────
 * The pool runs dateStrings:true + timezone '+05:30' (db.js): a DATETIME comes
 * back as a bare IST string, and the SESSION time_zone is SYSTEM, not IST. So
 * nothing here parses a returned date in JS and nothing calls NOW(). Every time
 * is a JS Date passed as a parameter — serialized to the IST wall clock exactly
 * as the stored value was — and MySQL does the subtraction.
 */

const { pool } = require('../db');
const logger = require('../logger');
const { OTP_MAX_ATTEMPTS, OTP_ATTEMPT_WINDOW_MINUTES } = require('../utils/otp');

const ABSENT_RECHECK_MS = 60 * 1000;
const WINDOW_MS = OTP_ATTEMPT_WINDOW_MINUTES * 60 * 1000;

let _present = false;      // once true, stays true until an "unknown column" error
let _absentCheckedAt = 0;  // epoch ms of the last "absent" answer; 0 = never asked

async function columnPresent(db = pool) {
  if (_present) return true;
  if (_absentCheckedAt && Date.now() - _absentCheckedAt < ABSENT_RECHECK_MS) return false;
  try {
    const [rows] = await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'otp_details'
          AND COLUMN_NAME IN ('failed_attempts', 'updated_on')`,
    );
    if (rows.length === 2) {
      _present = true;
      logger.info(`OTP attempt cap now ACTIVE — max ${OTP_MAX_ATTEMPTS} wrong codes per `
        + `${OTP_ATTEMPT_WINDOW_MINUTES} minutes per user.`);
      return true;
    }
    if (!_absentCheckedAt) {
      logger.warn('OTP attempt cap INACTIVE — otp_details.failed_attempts does not exist. Run '
        + 'migrations/executed/2026-09-10-otp-failed-attempts.sql; until then OTP guesses are unbounded.');
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

/** A query error that means the column is gone — forget the cached "present". */
function noteFailure(e) {
  if (e && (e.code === 'ER_BAD_FIELD_ERROR' || e.errno === 1054)) {
    _present = false;
    _absentCheckedAt = 0;
  }
}

const OPEN = Object.freeze({ locked: false, attemptsRemaining: null, retryAfterMinutes: null });

/*
 * A row's state as the user sees it. A window that has closed is a full budget,
 * whatever the count says — the lock lifts by itself, and the next attempt
 * restarts the window at 1.
 */
function viewOf(r) {
  const inWindow = !!r && (r.in_window === true || Number(r.in_window) === 1);
  const used = inWindow ? Number(r.failed_attempts) || 0 : 0;
  const locked = used >= OTP_MAX_ATTEMPTS;
  return {
    locked,
    attemptsRemaining: Math.max(0, OTP_MAX_ATTEMPTS - used),
    retryAfterMinutes: locked ? Math.max(1, Math.ceil((Number(r.secs_left) || 0) / 60)) : null,
  };
}

/**
 * @param {number} rowId  otp_details.id of the user's OTP row
 * @returns {Promise<{locked: boolean, attemptsRemaining: number|null, retryAfterMinutes: number|null}>}
 *   attemptsRemaining: wrong codes still allowed now (null when the cap is inactive).
 *   retryAfterMinutes: when locked, whole minutes until the window ends, rounded
 *     UP and never below 1 — "try again in 0 minutes" while still refusing is the
 *     message that makes people think the screen is broken.
 * Never throws; an inactive or failed read is reported as unlocked.
 */
async function lockState(rowId, db = pool) {
  if (!(await columnPresent(db))) return OPEN;
  try {
    const now = new Date();
    const cutoff = new Date(now.getTime() - WINDOW_MS);
    const [[r]] = await db.query(
      `SELECT failed_attempts,
              (updated_on IS NOT NULL AND updated_on >= ?) AS in_window,
              TIMESTAMPDIFF(SECOND, ?, DATE_ADD(updated_on, INTERVAL ? MINUTE)) AS secs_left
         FROM otp_details WHERE id = ?`,
      [cutoff, now, OTP_ATTEMPT_WINDOW_MINUTES, rowId],
    );
    return viewOf(r);
  } catch (e) {
    noteFailure(e);
    logger.warn('OTP attempt-cap read failed · otp_details.id=' + rowId + ' · ' + e.message);
    return OPEN;
  }
}

/**
 * Claim one guess BEFORE the code is compared. Call it after the expiry check,
 * refuse without comparing when it says locked, and afterwards either
 * clearAttempts (right code) or lockState (wrong code — nothing more to write,
 * the guess is already counted; lockState says what to tell the user).
 *
 * WHY CLAIM FIRST. Reading the count, comparing, and only then counting lets a
 * burst of parallel guesses all pass the read before any count lands — on a
 * route with no rate limit (the CRM login) that is as many guesses as can be
 * sent in the code's five minutes. Here the check and the count are ONE
 * statement, and MySQL runs concurrent UPDATEs of the row one at a time, each
 * WHERE evaluated against the latest value — otp_details is MyISAM (measured
 * on QA, 2026-09-11), so by a TABLE lock; were it InnoDB, by a row lock. So at
 * most OTP_MAX_ATTEMPTS claims succeed per window however many arrive at once.
 *
 * The SET: if the window has expired (or never opened) the count restarts at 1
 * and a new window opens now; otherwise it increments. MySQL evaluates
 * single-table UPDATE assignments left to right, and a later assignment sees an
 * earlier one's NEW value, so failed_attempts is assigned FIRST and both IFs test
 * the OLD window. Swapped, an expired window would reopen first and the count
 * would carry on from the stale total (measured on MySQL: 6 instead of 1).
 *
 * @returns {Promise<{locked: boolean, attemptsRemaining: number|null, retryAfterMinutes: number|null}>}
 *   locked:true — the window is full; refuse WITHOUT comparing.
 */
async function claimAttempt(rowId, db = pool) {
  if (!(await columnPresent(db))) return OPEN;
  try {
    const now = new Date();
    const cutoff = new Date(now.getTime() - WINDOW_MS);
    const [res] = await db.query(
      `UPDATE otp_details
          SET failed_attempts = IF(updated_on IS NULL OR updated_on < ?, 1, failed_attempts + 1),
              updated_on      = IF(updated_on IS NULL OR updated_on < ?, ?, updated_on)
        WHERE id = ?
          AND (updated_on IS NULL OR updated_on < ? OR failed_attempts < ?)`,
      [cutoff, cutoff, now, rowId, cutoff, OTP_MAX_ATTEMPTS],
    );
    if (res && res.affectedRows > 0) return OPEN;
    // Nothing claimed: the window is full — or the row has gone, which reads as
    // unlocked below. Either way lockState has the minutes to show.
    const state = await lockState(rowId, db);
    if (state.locked) {
      logger.warn(`OTP attempt refused · otp_details.id=${rowId} · ${OTP_MAX_ATTEMPTS} attempts used in `
        + `${OTP_ATTEMPT_WINDOW_MINUTES}m · lifts in ~${state.retryAfterMinutes}m`);
    }
    return state;
  } catch (e) {
    noteFailure(e);
    // Losing the count is bad; failing the verify because the counter did not
    // write is worse — the user's code may well have been correct.
    logger.warn('OTP attempt claim failed · otp_details.id=' + rowId + ' · ' + e.message);
    return OPEN;
  }
}

/**
 * Close the window — on a SUCCESSFUL verify, and only there. Deliberately NOT
 * called when a new code is sent: that would let Resend bypass the cap.
 * updated_on goes back to NULL, the value no other code ever wrote.
 */
async function clearAttempts(rowId, db = pool) {
  if (!(await columnPresent(db))) return;
  try {
    await db.query(
      `UPDATE otp_details SET failed_attempts = 0, updated_on = NULL
        WHERE id = ? AND (failed_attempts <> 0 OR updated_on IS NOT NULL)`,
      [rowId],
    );
  } catch (e) {
    noteFailure(e);
    logger.warn('OTP attempt reset failed · otp_details.id=' + rowId + ' · ' + e.message);
  }
}

/*
 * ADMIN — Admin Actions → Unlock OTP / PIN (routes/admin/otp-locks.js).
 *
 * locksForIdentifier: every otp_details row for an email or mobile — one per
 * OTP type (CRM login, client login, technician login, admin actions, change
 * phone/email) — with its window state. `active: false` means the cap is not
 * running here yet (no failed_attempts column), so nothing can be locked.
 *
 * unlockIdentifier: close every window for that identifier; returns how many
 * rows it cleared. Deliberately not per OTP type: a person locked out is locked
 * out, and the operator on the phone should not have to know which flow did it.
 */
async function locksForIdentifier(identifier, db = pool) {
  if (!(await columnPresent(db))) return { active: false, rows: [] };
  const now = new Date();
  const cutoff = new Date(now.getTime() - WINDOW_MS);
  const [rows] = await db.query(
    `SELECT id, otp_type, failed_attempts,
            (updated_on IS NOT NULL AND updated_on >= ?) AS in_window,
            TIMESTAMPDIFF(SECOND, ?, DATE_ADD(updated_on, INTERVAL ? MINUTE)) AS secs_left
       FROM otp_details
      WHERE user_email = ? OR user_mobile_no = ?
      ORDER BY id`,
    [cutoff, now, OTP_ATTEMPT_WINDOW_MINUTES, identifier, identifier],
  );
  return { active: true, rows: rows.map((r) => ({ otpDetailsId: r.id, otpType: r.otp_type, ...viewOf(r) })) };
}

async function unlockIdentifier(identifier, db = pool) {
  if (!(await columnPresent(db))) return 0;
  const [res] = await db.query(
    `UPDATE otp_details SET failed_attempts = 0, updated_on = NULL
      WHERE (user_email = ? OR user_mobile_no = ?)
        AND (failed_attempts <> 0 OR updated_on IS NOT NULL)`,
    [identifier, identifier],
  );
  return Number(res && res.affectedRows) || 0;
}

/** Tests only — forget every cached probe answer. */
function _resetProbeCache() { _present = false; _absentCheckedAt = 0; }

module.exports = {
  OTP_MAX_ATTEMPTS,
  OTP_ATTEMPT_WINDOW_MINUTES,
  ABSENT_RECHECK_MS,
  lockState,
  claimAttempt,
  clearAttempts,
  locksForIdentifier,
  unlockIdentifier,
  _resetProbeCache,
};
