/*
 * OTP service for the easyfixer public profile-update flow.
 *
 * Stores the OTP directly on tbl_easyfixer (columns profile_update_otp,
 * profile_update_otp_valid_up_to) — avoids a separate table and keeps
 * the per-technician OTP naturally unique with no extra index.
 *
 * Channel: Gallabox WhatsApp — template `profile_update_otp`.
 * The OTP value is NEVER returned by sendOtp(); callers only receive
 * { sent: true } so the plain-text code never travels in a JSON response.
 */

'use strict';

const { resolveMobileOtp, otpExpiryDate } = require('../utils/otp');
const gallabox = require('./gallabox.whatsapp.service');
const logger = require('../logger');
const { istIsPast } = require('../utils/ist-calendar');
const { attemptWindow } = require('../middleware/rate-limit');

/*
 * Guess cap: 5 attempts per technician per 30 minutes, the same rule as the
 * login OTP (services/otp-attempts.service.js). That one counts on the user's
 * otp_details row; this code lives on tbl_easyfixer, which is not ours to
 * alter, so the window is kept in memory. It guards the profile update AND the
 * bank-account change (services/easyfixer-sensitive-change.service.js), where a
 * guessed code redirects a technician's pay.
 */
const profileOtpAttempts = attemptWindow();

/**
 * Generate a 4-digit OTP, write it to tbl_easyfixer.profile_update_otp /
 * profile_update_otp_valid_up_to, and send it via Gallabox WhatsApp.
 *
 * Writing a new OTP always overwrites the previous one, so a second "Send OTP"
 * tap naturally invalidates the first code — no separate expire step needed.
 *
 * @param {number} efrId  — the easyfixer's numeric ID (from the JWT)
 * @param {import('mysql2/promise').Pool} pool
 * @returns {Promise<{ sent: boolean }>}  — NEVER includes the OTP value
 */
async function sendOtp(efrId, pool) {
  logger.info('Send profile-update OTP · efrId=' + efrId);
  // 1. Load name + mobile, then write the new OTP in a single round-trip.
  const [[row]] = await pool.query(
    `SELECT efr_name, efr_no
       FROM tbl_easyfixer
      WHERE efr_id = ?
      LIMIT 1`,
    [efrId],
  );
  if (!row) {
    logger.warn('Send profile-update OTP failed · easyfixer not found · efrId=' + efrId);
    const e = new Error('Easyfixer not found');
    e.status = 404;
    throw e;
  }
  const { efr_name: name, efr_no: mobile } = row;
  if (!mobile) {
    logger.warn('Send profile-update OTP failed · no registered mobile · efrId=' + efrId);
    const e = new Error('Easyfixer has no registered mobile number');
    e.status = 422;
    throw e;
  }

  // 2. Generate OTP + expiry (5 min window).
  //    Prod → random; QA (QA_DETERMINISTIC_OTP=true) → last 4 digits of the
  //    easyfixer's mobile, so QA can complete the flow without WhatsApp/DB.
  const otp = resolveMobileOtp(mobile);
  const validUpTo = otpExpiryDate();

  // 3. Persist directly on tbl_easyfixer — overwrites any prior pending OTP.
  await pool.query(
    `UPDATE tbl_easyfixer
        SET profile_update_otp = ?,
            profile_update_otp_valid_up_to = ?
      WHERE efr_id = ?`,
    [otp, validUpTo, efrId],
  );

  // 4. Deliver via Gallabox. Failure is logged but not re-thrown — the column
  //    is already written; the user can tap "Resend" which overwrites with a
  //    fresh OTP.
  const result = await gallabox.sendTemplate({
    to: String(mobile),
    recipientName: String(name || ''),
    templateName: 'profile_update_otp',
    bodyValues: { 1: String(otp) },
  });

  if (!result.delivered && !result.disabled) {
    logger.warn(
      { efrId, error: result.error, httpStatus: result.httpStatus },
      'easyfixer-profile-otp: Gallabox delivery failed (OTP still stored)',
    );
  } else {
    logger.info({ efrId }, 'easyfixer-profile-otp: OTP sent via WhatsApp');
  }

  // Never expose the OTP value in the response.
  return { sent: true };
}

/**
 * Verify the supplied OTP for an easyfixer.
 *
 * Reads profile_update_otp + profile_update_otp_valid_up_to from
 * tbl_easyfixer. Valid iff the stored code is non-null, matches the
 * submitted value, and the expiry has not elapsed. On success the columns
 * are NULLed out (consumed) so the same code cannot be reused.
 *
 * @param {number} efrId
 * @param {number|string} otp   — the 4-digit code the user submitted
 * @param {import('mysql2/promise').Pool} pool
 * Guess cap (profileOtpAttempts, above): the attempt is claimed before the
 * compare — synchronously, so parallel guesses cannot overshoot — and cleared
 * by a right code. A wrong one reports how many are left; the 5th, and anything
 * after it inside the window, reports when the lock lifts.
 *
 * @returns {Promise<{ valid: boolean, reason?: string,
 *   attemptsRemaining?: number, retryAfterMinutes?: number }>}
 */
async function verifyOtp(efrId, otp, pool) {
  logger.info('Verify profile-update OTP · efrId=' + efrId);
  const [[row]] = await pool.query(
    `SELECT profile_update_otp, profile_update_otp_valid_up_to
       FROM tbl_easyfixer
      WHERE efr_id = ?
      LIMIT 1`,
    [efrId],
  );

  if (!row || row.profile_update_otp === null) {
    logger.info({ efrId }, 'easyfixer-profile-otp: no active OTP found');
    return { valid: false };
  }

  /*
   * Check TTL. istIsPast, not `new Date(str)` — the column is an IST
   * wall-clock string and a bare parse resolves it in the PROCESS timezone,
   * so on a UTC pod this 5-minute code lived 5h30m. Correct on a laptop set
   * to Asia/Kolkata, wrong everywhere it matters.
   */
  if (istIsPast(row.profile_update_otp_valid_up_to)) {
    // Consume so it cannot be retried after expiry.
    await pool.query(
      `UPDATE tbl_easyfixer
          SET profile_update_otp = NULL,
              profile_update_otp_valid_up_to = NULL
        WHERE efr_id = ?`,
      [efrId],
    );
    logger.info({ efrId }, 'easyfixer-profile-otp: OTP expired');
    return { valid: false };
  }

  // No await from here to the compare: the claim and the compare are one step.
  const capKey = 'efr:' + efrId;
  const claim = profileOtpAttempts.claim(capKey);
  if (claim.locked) {
    logger.warn({ efrId }, 'easyfixer-profile-otp: refused · OTP_ATTEMPTS_EXCEEDED');
    return { valid: false, reason: 'OTP_ATTEMPTS_EXCEEDED', retryAfterMinutes: claim.retryAfterMinutes };
  }

  // Integer comparison (OTP is a 4-digit INT).
  if (Number(row.profile_update_otp) !== Number(otp)) {
    logger.info({ efrId }, 'easyfixer-profile-otp: OTP mismatch');
    const after = profileOtpAttempts.state(capKey);
    if (after.locked) return { valid: false, reason: 'OTP_ATTEMPTS_EXCEEDED', retryAfterMinutes: after.retryAfterMinutes };
    return { valid: false, reason: 'OTP_MISMATCH', attemptsRemaining: after.attemptsRemaining };
  }
  profileOtpAttempts.clear(capKey);

  // Consume on success — one-shot.
  await pool.query(
    `UPDATE tbl_easyfixer
        SET profile_update_otp = NULL,
            profile_update_otp_valid_up_to = NULL
      WHERE efr_id = ?`,
    [efrId],
  );

  logger.info({ efrId }, 'easyfixer-profile-otp: OTP verified OK');
  return { valid: true };
}

module.exports = { sendOtp, verifyOtp };
