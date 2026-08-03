/*
 * routes/public/_public-call.js — shared building blocks for UNAUTHENTICATED,
 * token-scoped public routes that (a) rate-limit by verified jobId and (b)
 * bridge a masked Plivo/Kaleyra call.
 *
 * Extracted so the customer job-completion flow and the technician "share job"
 * flow can share ONE implementation of the rate limiters, the daily bridge cap,
 * the audit persist, and the public error message instead of diverging copies.
 *
 * Token-type isolation is intentionally NOT baked in here: peek-token is a
 * FACTORY (`makePeekToken(verifyFn)`) so each surface injects its own verifier
 * (verifyJobToken vs verifyJobShareToken). Everything else keys off the
 * `req.verifiedJobId` that peek sets, so it stays token-agnostic.
 *
 * NOTE: job-completion.js still carries its own inline copies of these helpers
 * (unchanged to avoid churning the live customer flow); migrating it to import
 * from here is a safe, separate follow-up.
 */

const { pool } = require('../../db');
const kaleyra = require('../../services/kaleyra.service');
const { modernError } = require('../../utils/response');
const { rateLimit } = require('../../middleware/rate-limit');
const logger = require('../../logger');

// Generic, provider-agnostic message returned to the PUBLIC client whenever a
// bridge call fails for a real (non-suppressed) reason. The true diagnostic is
// logged server-side only — never leaked to an unauthenticated client.
const CALL_FAILED_PUBLIC_MSG = 'Could not place the call. Please try again.';

// Per-job daily bridge-call ceiling — a harder limit than the per-window rate
// limiter, so a leaked token can't spam-dial across resets.
const MAX_BRIDGE_CALLS_PER_JOB_PER_DAY = 10;

/*
 * Peek-the-token middleware FACTORY. Runs the injected `verifyFn(token)` only
 * (no live-state DB check) so the rate limiter can key on the verified jobId.
 * A bad token does NOT 401 here — it leaves req.verifiedJobId = null and lets
 * the per-endpoint verify emit the proper 401. NOT an auth boundary.
 */
function makePeekToken(verifyFn) {
  return function peekToken(req, _res, next) {
    try {
      const { jobId } = verifyFn(req.params.token);
      req.verifiedJobId = jobId;
    } catch (_e) {
      req.verifiedJobId = null;
    }
    return next();
  };
}

// Per-token rate limit: 30 req / 10 min, keyed on jobId (IP fallback for
// unverifiable tokens so the bucket isn't a shared "anon" DoS pool).
const tokenRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  key: (req) => (req.verifiedJobId ? `job:${req.verifiedJobId}` : `ip:${req.ip}`),
});

// Stricter limiter for the expensive/abusable bridge-call routes: 5 / 10 min,
// distinct 'call:' bucket so call attempts don't share the general budget.
const callRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  key: (req) => (req.verifiedJobId ? `call:${req.verifiedJobId}` : `call-ip:${req.ip}`),
});

// Centralised mapper for the thrown plain-object `{status, message}` shape.
// Anything without a numeric `status` is an unexpected server error → next(e).
function mapKnownError(res, next, e) {
  if (e && typeof e.status === 'number') {
    return modernError(res, e.status, e.message || 'request failed');
  }
  return next(e);
}

// Returns true when the job is at/over the daily bridge-call cap. Counts
// PUBLIC-initiated rows only (caller_id IS NULL) in the last 24h, so operators'
// CRM click-to-calls don't burn the public budget. Fail-open on a count error.
async function dailyBridgeCapReached(jobId, max = MAX_BRIDGE_CALLS_PER_JOB_PER_DAY) {
  try {
    const [[{ cnt }]] = await pool.query(
      `SELECT COUNT(*) AS cnt
         FROM tbl_job_caller_info
        WHERE job_id = ?
          AND caller_id IS NULL
          AND inserted_time >= (NOW() - INTERVAL 1 DAY)`,
      [jobId],
    );
    return Number(cnt) >= max;
  } catch (e) {
    logger.warn({ jobId, err: e && e.message }, 'public-call: daily bridge-cap count failed — allowing call (fail-open)');
    return false;
  }
}

/*
 * Best-effort audit of a PUBLIC-initiated bridge call to tbl_job_caller_info.
 * The from/to legs are recorded as caller/reciever (preserving the legacy
 * column typo); caller_id = NULL + inserted_by = NULL marks it public-initiated
 * (not staff). NEVER throws — a failed audit must not fail the call response.
 */
async function persistBridgeCall({
  jobId, callId, fromMob, fromName,
  toMob, toId, toName, jobStatus, jobEfrId, provider,
}) {
  try {
    await pool.query(
      `INSERT INTO tbl_job_caller_info
         (job_id, unique_id, caller, caller_id, caller_name,
          reciever, reciever_id, reciever_name,
          job_status, job_efr_id, call_type, inserted_by, is_updated, provider)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'OUT', NULL, 0, ?)`,
      [
        jobId,
        callId || null,
        kaleyra.normaliseIndianPhone(fromMob),
        fromName || 'Caller',
        kaleyra.normaliseIndianPhone(toMob),
        toId ?? null,
        toName || null,
        jobStatus ?? null,
        jobEfrId ?? null,
        provider || 'plivo',
      ],
    );
  } catch (e) {
    logger.warn({ jobId, err: e && e.message }, 'public-call: tbl_job_caller_info persist failed (call already placed — non-fatal)');
  }
}

module.exports = {
  CALL_FAILED_PUBLIC_MSG,
  MAX_BRIDGE_CALLS_PER_JOB_PER_DAY,
  makePeekToken,
  tokenRateLimit,
  callRateLimit,
  mapKnownError,
  dailyBridgeCapReached,
  persistBridgeCall,
};
