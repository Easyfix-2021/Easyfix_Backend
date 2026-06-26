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
  // 1. Load name + mobile, then write the new OTP in a single round-trip.
  const [[row]] = await pool.query(
    `SELECT efr_name, efr_no
       FROM tbl_easyfixer
      WHERE efr_id = ?
      LIMIT 1`,
    [efrId],
  );
  if (!row) {
    const e = new Error('Easyfixer not found');
    e.status = 404;
    throw e;
  }
  const { efr_name: name, efr_no: mobile } = row;
  if (!mobile) {
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
 * @returns {Promise<{ valid: boolean }>}
 */
async function verifyOtp(efrId, otp, pool) {
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

  // Check TTL.
  if (new Date() > new Date(row.profile_update_otp_valid_up_to)) {
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

  // Integer comparison (OTP is a 4-digit INT).
  if (Number(row.profile_update_otp) !== Number(otp)) {
    logger.info({ efrId }, 'easyfixer-profile-otp: OTP mismatch');
    return { valid: false };
  }

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
