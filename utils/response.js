/*
 * Two response shapes coexist in this backend:
 *
 *  modern  — used by /api/admin, /api/client, /api/mobile, /api/shared, /api/auth
 *              { success: true,  data: ..., message?: ... }
 *              { success: false, error: "msg", code?: "APP_CODE", details?: {...} }
 *
 *  legacy  — used by /api/integration/v1/* ONLY
 *              Mirrors the Dropwizard :8090 contract exactly, byte-for-byte.
 *              { status: "200", message: "OK", data: {...} }     // note: status is a STRING
 *
 * Route groups MUST use the formatter matching their contract.
 * Never mix. Never apply a global response middleware that rewrites either shape.
 */

function modernOk(res, data, message) {
  const body = { success: true, data };
  if (message) body.message = message;
  return res.json(body);
}

function modernError(res, status, error, details) {
  // Surface the actual reason in the one-line HTTP log (middleware/http-log.js
  // reads res.locals.logHint) so a 4xx/5xx says WHAT failed, not just "not found".
  if (res.locals && typeof error === 'string') res.locals.logHint = error.slice(0, 140);
  const body = { success: false, error };
  if (details) body.details = details;
  return res.status(status).json(body);
}

function legacyOk(res, data, message = 'OK') {
  return res.json({ status: '200', message, data });
}

function legacyError(res, httpStatus, message, data = null) {
  if (res.locals && typeof message === 'string') res.locals.logHint = message.slice(0, 140);
  return res.status(httpStatus).json({
    status: String(httpStatus),
    message,
    data,
  });
}

/*
 * The OTP guess cap's two outcomes as HTTP — one place, for every OTP verify
 * route (services/otp-attempts.service.js: 5 wrong codes per 30 minutes).
 * Returns the sent response when `r` is one of them, else null so the route's
 * own reason map runs. The sentence goes in `error`, the field every client
 * shows; the numbers go in `details` beside a `code`, the same shape as
 * middleware/idempotency.js inProgress().
 *
 * An OTP_MISMATCH without attemptsRemaining is the cap failing open (its column
 * is absent) → null → the route's existing message, unchanged.
 *
 * mismatchStatus: the status the route ALREADY used for a wrong code — keep it,
 * clients may branch on it. change-phone has always answered 400.
 */
function otpGuessCapError(res, r, mismatchStatus = 401) {
  if (!r) return null;
  if (r.reason === 'OTP_ATTEMPTS_EXCEEDED') {
    const m = Math.ceil(Number(r.retryAfterMinutes));
    if (!(m > 0)) {
      return modernError(res, 429, 'Too many incorrect attempts. Please try again later.',
        { code: 'OTP_ATTEMPTS_EXCEEDED' });
    }
    res.setHeader('Retry-After', String(m * 60));
    return modernError(res, 429,
      `Too many incorrect attempts. Please try again in ${m} minute${m === 1 ? '' : 's'}.`,
      { code: 'OTP_ATTEMPTS_EXCEEDED', retryAfterMinutes: m });
  }
  if (r.reason === 'OTP_MISMATCH' && Number.isInteger(r.attemptsRemaining)) {
    const n = r.attemptsRemaining;
    return modernError(res, mismatchStatus, `Incorrect OTP. ${n} attempt${n === 1 ? '' : 's'} left.`,
      { code: 'OTP_MISMATCH', attemptsRemaining: n });
  }
  return null;
}

module.exports = { modernOk, modernError, legacyOk, legacyError, otpGuessCapError };
