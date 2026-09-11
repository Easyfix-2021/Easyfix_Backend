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
 * SHARED RATE LIMITS — sharedRateLimit() below is middleware/rate-limit.js's
 * rateLimit() counted here instead: the same fixed window is the same claim
 * with its own max and window ('rate:<limiter key>'). Used by the public LOGIN
 * routes (CRM routes/auth.js, technician app routes/mobile/index.js), whose
 * ceilings must hold across containers. Every other rateLimit() stays in memory.
 *
 * WHERE THE COUNT LIVES. tbl_attempt_window (migrations/executed/2026-09-11-
 * create-tbl-attempt-window.sql), so every backend container counts in one place and the
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
 * HOUSEKEEPING. A row idle for longer than the longest window is an expired
 * window, which a claim treats exactly like no row — so claims delete those, at
 * most once per SWEEP_EVERY_MS per process. Without it every IP and mobile that
 * ever hit a login would stay a row forever.
 *
 * Every function takes an optional `db` so a caller with an injected pool (the
 * profile OTP service) keeps its test seam: a fake pool stays the only
 * database touched.
 */

const { pool } = require('../db');
const logger = require('../logger');
const { attemptWindow } = require('../middleware/rate-limit');
const { modernError } = require('../utils/response');
const { maskMobile } = require('../utils/mask-mobile');
const { OTP_MAX_ATTEMPTS, OTP_ATTEMPT_WINDOW_MINUTES } = require('../utils/otp');

const TABLE = 'tbl_attempt_window';
const KEY_MAX_LENGTH = 100;               // attempt_key VARCHAR(100)
const MAX = OTP_MAX_ATTEMPTS;
const WINDOW_MS = OTP_ATTEMPT_WINDOW_MINUTES * 60 * 1000;
const ABSENT_RECHECK_MS = 60 * 1000;
const SWEEP_EVERY_MS = 10 * 60 * 1000;

let _present = false;
let _absentCheckedAt = 0;
let _lastSweepAt = 0;
let _longestWindowMs = 0;                 // grows as windows are created

async function tablePresent(db) {
  if (_present) return true;
  if (_absentCheckedAt && Date.now() - _absentCheckedAt < ABSENT_RECHECK_MS) return false;
  try {
    const [rows] = await db.query(
      `SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`, [TABLE],
    );
    if (rows.length > 0) {
      _present = true;
      logger.info(`Guess windows now SHARED — counting in ${TABLE} (checkout PIN, profile/bank OTP, login rate limits).`);
      return true;
    }
    if (!_absentCheckedAt) {
      logger.warn(`Guess windows and login rate limits counting PER PROCESS — ${TABLE} does not exist. Run `
        + 'migrations/executed/2026-09-11-create-tbl-attempt-window.sql before running more than one backend container.');
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

/* Delete expired windows — fire-and-forget, so no claim waits on it. */
function maybeSweep(db, now) {
  if (now.getTime() - _lastSweepAt < SWEEP_EVERY_MS) return;
  _lastSweepAt = now.getTime();
  // updated_on is the last GRANTED claim, never before window_start: idle past
  // the longest window means expired for every namespace.
  db.query(`DELETE FROM ${TABLE} WHERE updated_on < ?`, [new Date(now.getTime() - _longestWindowMs)])
    .catch((e) => logger.warn('Guess-window sweep failed · ' + e.message));
}

const GRANTED = Object.freeze({ locked: false, attemptsRemaining: null, retryAfterMinutes: null });

function sharedAttemptWindow(namespace, { max = MAX, windowMs = WINDOW_MS, logRefusals = true } = {}) {
  const memory = attemptWindow({ max, windowMs });
  _longestWindowMs = Math.max(_longestWindowMs, windowMs);
  const full = (key) => {
    const k = `${namespace}:${key}`;
    // INSERT IGNORE would silently TRUNCATE a longer key, and a claim on the
    // truncated row never matches — unlimited. Throwing lands in memory instead.
    if (k.length > KEY_MAX_LENGTH) throw new Error(`attempt key longer than ${KEY_MAX_LENGTH}`);
    return k;
  };
  // For logs: never throws, and a login limiter's mobile is masked.
  const label = (key) => `${namespace}:${String(key).slice(0, KEY_MAX_LENGTH).replace(/\d{10}/g, (m) => maskMobile(m))}`;

  const view = (r) => {
    const inWindow = !!r && (r.in_window === true || Number(r.in_window) === 1);
    const used = inWindow ? Number(r.attempts) || 0 : 0;
    const locked = used >= max;
    return {
      locked,
      attemptsRemaining: Math.max(0, max - used),
      // Rounded UP and never 0: "try again in 0 minutes" while refusing reads as broken.
      retryAfterMinutes: locked ? Math.max(1, Math.ceil((Number(r.secs_left) || 0) / 60)) : null,
    };
  };

  const readState = async (fullKey, db) => {
    const now = new Date();
    const cutoff = new Date(now.getTime() - windowMs);
    const [[r]] = await db.query(
      `SELECT attempts,
              (window_start IS NOT NULL AND window_start >= ?) AS in_window,
              TIMESTAMPDIFF(SECOND, ?, DATE_ADD(window_start, INTERVAL ? SECOND)) AS secs_left
         FROM ${TABLE} WHERE attempt_key = ?`,
      [cutoff, now, Math.round(windowMs / 1000), fullKey],
    );
    return view(r);
  };

  return {
    namespace,

    /** Count one attempt. `locked: true` → the window is full: refuse WITHOUT comparing. */
    async claim(key, db = pool) {
      if (!(await tablePresent(db))) return memory.claim(key);
      try {
        const now = new Date();
        const cutoff = new Date(now.getTime() - windowMs);
        maybeSweep(db, now);
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
          [cutoff, cutoff, now, now, full(key), cutoff, max],
        );
        if (res && res.affectedRows > 0) return GRANTED;
        const st = await readState(full(key), db);
        if (st.locked && logRefusals) logger.warn(`Attempt refused · ${label(key)} · lifts in ~${st.retryAfterMinutes}m`);
        return st;
      } catch (e) {
        noteFailure(e);
        logger.warn(`Guess-window claim failed · ${label(key)} · counting in memory · ${e.message}`);
        return memory.claim(key);
      }
    },

    /** How many attempts are left / when the lock lifts. */
    async state(key, db = pool) {
      if (!(await tablePresent(db))) return memory.state(key);
      try { return await readState(full(key), db); } catch (e) {
        noteFailure(e);
        logger.warn(`Guess-window read failed · ${label(key)} · ${e.message}`);
        return memory.state(key);
      }
    },

    /** Close the window — on a right answer, or an admin unlock. Clears memory too. */
    async clear(key, db = pool) {
      memory.clear(key);
      if (!(await tablePresent(db))) return;
      try { await db.query(`DELETE FROM ${TABLE} WHERE attempt_key = ?`, [full(key)]); } catch (e) {
        noteFailure(e);
        logger.warn(`Guess-window clear failed · ${label(key)} · ${e.message}`);
      }
    },
  };
}

/* The two windows — ONE instance each, shared by the routes that count and the
 * admin unlock, so even the in-memory fallback is cleared in the same place. */
const checkoutPin = sharedAttemptWindow('checkout-pin');
const profileOtp = sharedAttemptWindow('profile-otp');

/*
 * PER-MOBILE LOGIN LIMITS — the technician app's code-request and code-entry
 * limiters (routes/mobile/index.js) pass `perMobile: '<limiter>'` and key each
 * valid mobile with techMobileRateKey(). Registered here so the admin "Unlock
 * OTP / PIN" (routes/admin/otp-locks.js) shows and clears exactly the rows they
 * count on — one key builder for both, so they cannot drift apart. The per-IP
 * limiters are not unlockable: unlocking a PERSON must not reset a network's
 * budget, and the operator does not know the network anyway.
 */
const techMobileRateKey = (limiter, mobile) => `${limiter}:mobile:${mobile}`;
const perMobileWindows = new Map();       // limiter → its window, in registration order

/** Each per-mobile login limit on this mobile: [{ limiter, locked, attemptsRemaining, retryAfterMinutes }]. */
async function techLoginLimits(mobile, db = pool) {
  const out = [];
  for (const [limiter, w] of perMobileWindows) out.push({ limiter, ...(await w.state(techMobileRateKey(limiter, mobile), db)) });
  return out;
}

/** Lift them — the shared rows and this process's memory fallback. */
async function clearTechLoginLimits(mobile, db = pool) {
  for (const [limiter, w] of perMobileWindows) await w.clear(techMobileRateKey(limiter, mobile), db);
}

/*
 * rateLimit() (middleware/rate-limit.js) with its count in the shared table:
 * same options, same 429 + Retry-After. Build it ONCE at module scope.
 * Refusals are not logged here — http-log already logs every 429, and a flood
 * would otherwise be a WARN per request.
 * ponytail: a refused request still costs ~3 primary-key queries; if a flood
 * ever shows in the pool, cache "locked until" in memory.
 */
function sharedRateLimit({
  windowMs = 60_000, max = 600, key = (req) => req.ip, message = 'rate limit exceeded', perMobile = null,
} = {}) {
  const w = sharedAttemptWindow('rate', { max, windowMs, logRefusals: false });
  if (perMobile) perMobileWindows.set(perMobile, w);
  return async (req, res, next) => {
    try {
      const r = await w.claim(String(key(req) || 'anon'));
      if (!r.locked) return next();
      res.setHeader('Retry-After', r.retryAfterMinutes * 60);
      return modernError(res, 429, message);
    } catch (e) { return next(e); }
  };
}

/** Tests only — forget the cached table probe and the last sweep. */
function _resetProbeCache() { _present = false; _absentCheckedAt = 0; _lastSweepAt = 0; }

module.exports = {
  checkoutPin, profileOtp, sharedAttemptWindow, sharedRateLimit,
  techMobileRateKey, techLoginLimits, clearTechLoginLimits,
  TABLE, ABSENT_RECHECK_MS, SWEEP_EVERY_MS, _resetProbeCache,
};
