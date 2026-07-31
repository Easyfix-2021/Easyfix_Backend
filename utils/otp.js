const crypto = require('crypto');

const OTP_TTL_MINUTES = 5;
const OTP_MAX_ATTEMPTS = 5;

// QA convenience constant — fixed OTP for any email login when
// QA_DETERMINISTIC_OTP=true. Mobile logins use last 4 digits of the
// dialed number instead. NEVER set the env var in production — see
// resolveLoginOtp() below for the gate.
const QA_EMAIL_OTP = 2468;

/**
 * Fixed-OTP test accounts — ALWAYS resolve to a static OTP, in EVERY
 * environment (production included), and their OTP email/SMS is suppressed
 * (auth.service.js::createLoginOtp skips delivery for them). This exists so a
 * persistent QA / app-review test login works without a live mail/SMS gateway
 * and without depending on any env flag.
 *
 * SECURITY — how this differs from QA_DETERMINISTIC_OTP:
 *   • QA_DETERMINISTIC_OTP makes EVERY login guessable, so it is hard-gated to
 *     the QA host and must never run in prod.
 *   • THIS is an explicit allowlist of individual accounts, so the blast radius
 *     is exactly those accounts. Anyone who knows a listed email + its OTP can
 *     log in AS THAT ACCOUNT (and nobody else). Therefore:
 *       - list ONLY dedicated, low-privilege test users,
 *       - never add a real staff member's email,
 *       - it does NOT bypass the user lookup — the account must still exist as
 *         an active internal user (user_status=1, user_type_id=5).
 * Keys MUST be lowercase; staticLoginOtpFor() lowercases+trims the identifier.
 */
const STATIC_LOGIN_OTP_ACCOUNTS = {
  'pradeep@easyfix.in': 2468,
};

/**
 * Fixed OTP for an allowlisted test account, or null for every other login.
 * Applies in ALL environments (prod included) by design — the caller must not
 * env-gate this.
 *
 * @param {string} identifier  the login identifier the user typed (email/mobile)
 * @returns {number|null}       the static 4-digit OTP, or null if not allowlisted
 */
function staticLoginOtpFor(identifier) {
  const key = String(identifier || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(STATIC_LOGIN_OTP_ACCOUNTS, key)
    ? STATIC_LOGIN_OTP_ACCOUNTS[key]
    : null;
}

function generateOtp() {
  // 4-digit random OTP, matches legacy otp_details.otp INT column.
  // The default behavior — used by every flow except the QA login
  // override (resolveLoginOtp).
  return 1000 + crypto.randomInt(0, 9000);
}

/**
 * Pick the OTP value for a login attempt.
 *
 * Default (production): cryptographically random 4-digit code via
 *   generateOtp(). Same as before — no behavior change.
 *
 * QA override: when QA_DETERMINISTIC_OTP=true, returns a predictable
 *   OTP so the QA team can log in without hitting an SMS/email gateway:
 *     • Email identifier → always 2468
 *     • Mobile identifier → last 4 digits of the mobile number
 *
 * The env var must be unset (or any non-"true" value) on prod. Setting
 * it on prod would let anyone log in as anyone with knowledge of the
 * mobile number alone — a catastrophic auth bypass. The deploy
 * pipelines do NOT inject this var; it must be set explicitly via
 * bootstrap-env.sh on the QA EC2 only.
 *
 * @param {string} identifier  what the user typed in the login form
 *                             (email like 'foo@x.com' or mobile like '9876543210')
 * @returns {number}           4-digit OTP
 */
function resolveLoginOtp(identifier) {
  // Allowlisted test accounts get their fixed OTP in EVERY environment (prod
  // included) — checked BEFORE the QA env gate below, so it is independent of
  // QA_DETERMINISTIC_OTP. See STATIC_LOGIN_OTP_ACCOUNTS for the security notes.
  const staticOtp = staticLoginOtpFor(identifier);
  if (staticOtp != null) {
    return staticOtp;
  }

  if (process.env.QA_DETERMINISTIC_OTP !== 'true') {
    return generateOtp();
  }
  // Heuristic identical to auth-service's identifier dispatch — '@' = email.
  // Trim defensively; extra whitespace from form inputs would otherwise
  // break the type detection and silently fall through to mobile-mode.
  const trimmed = String(identifier || '').trim();
  if (trimmed.includes('@')) {
    return QA_EMAIL_OTP;
  }
  // Mobile path: take the last 4 digits. Strip non-digits first so a user
  // typing '+91 98765 43210' still gets '3210', matching the mobile they
  // see in their CRM profile.
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 4) {
    // Pathologically short identifier — fall back to random so we don't
    // emit a 1-or-2-digit OTP that the INT column would right-pad.
    return generateOtp();
  }
  return parseInt(digits.slice(-4), 10);
}

/**
 * QA-deterministic OTP for NON-login action flows that deliver a code to a
 * KNOWN mobile number (e.g. the easyfixer Update-Profile form).
 *
 * Default (production — QA_DETERMINISTIC_OTP unset): cryptographically random
 *   4-digit code via generateOtp(). No behaviour change.
 *
 * QA override (QA_DETERMINISTIC_OTP=true): the last 4 digits of the supplied
 *   mobile, so the QA team can complete the flow without reading WhatsApp or
 *   the DB. Mirrors resolveLoginOtp()'s mobile branch.
 *
 * Same hard env gate as resolveLoginOtp() — the var MUST be unset on prod.
 * Setting it on prod would make any action OTP guessable from the target's
 * mobile alone (e.g. anyone could pass the profile-edit OTP knowing just the
 * technician's phone). Deploy pipelines do NOT inject it; it is set only on
 * the QA EC2 via bootstrap-env.sh.
 *
 * @param {string|number} mobile  the destination mobile the OTP is sent to
 * @returns {number}              4-digit OTP (random on prod, last-4 on QA)
 */
function resolveMobileOtp(mobile) {
  if (process.env.QA_DETERMINISTIC_OTP !== 'true') {
    return generateOtp();
  }
  const digits = String(mobile || '').replace(/\D/g, '');
  if (digits.length < 4) {
    // Pathologically short / missing mobile — fall back to random rather than
    // emit a 1-3 digit OTP the INT column can't round-trip cleanly.
    return generateOtp();
  }
  return parseInt(digits.slice(-4), 10);
}

function otpExpiryDate(fromDate = new Date()) {
  return new Date(fromDate.getTime() + OTP_TTL_MINUTES * 60 * 1000);
}

module.exports = {
  generateOtp,
  resolveLoginOtp,
  resolveMobileOtp,
  staticLoginOtpFor,
  otpExpiryDate,
  OTP_TTL_MINUTES,
  OTP_MAX_ATTEMPTS,
};
