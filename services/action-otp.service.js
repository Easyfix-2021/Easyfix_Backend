const { pool } = require('../db');
const logger = require('../logger');
const { resolveMobileOtp, otpExpiryDate } = require('../utils/otp');
const { istIsPast } = require('../utils/ist-calendar');

/*
 * Action-OTP service — sends a one-time code to the CURRENTLY logged-in
 * admin's own registered mobile/email to gate a sensitive operation
 * (entity delete / restore), then verifies it.
 *
 * Reuses the existing OTP plumbing verbatim:
 *   - otp_details, single-row-per-(user_email, user_mobile_no, otp_type) model
 *     (same as services/auth.service.js createLoginOtp/verifyLoginOtp), but
 *     with a DISTINCT otp_type so an action code never collides with the
 *     admin's own login OTP row.
 *   - utils/otp.js resolveMobileOtp() (prod = random generateOtp(); QA with
 *     QA_DETERMINISTIC_OTP=true = last 4 digits of the admin's mobile) +
 *     otpExpiryDate() (5-min TTL).
 *   - services/otp-delivery.service.js deliverOtp() — the generic channel
 *     dispatcher (mobile → WhatsApp then SMS fallback; email → Email then
 *     WhatsApp). No new delivery code.
 *
 * The OTP is the gate: it is consumed (is_expired = 1) on the first correct
 * verify, so it cannot be replayed.
 */

// otp_type discriminators — distinct from 'crm_login' so an action code and a
// login code for the same admin live in separate rows and never clobber.
const OTP_TYPES = {
  delete: 'admin_action_delete',
  restore: 'admin_action_restore',
};

/*
 * Generate + persist + deliver an action OTP for `admin` (a req.user row,
 * which carries official_email + mobile_no + user_name).
 * Returns { delivered, expiresAt }. Never throws on delivery failure — the
 * row is persisted regardless (the verify step is the real gate); only a
 * truly-missing contact (no mobile AND no email) is a hard 422.
 */
async function sendActionOtp(admin, action) {
  logger.info('Send action OTP · action=' + action);
  const otpType = OTP_TYPES[action];
  if (!otpType) throw new Error(`unknown action-otp type: ${action}`);

  const email = admin.official_email || null;
  const mobile = admin.mobile_no || null;
  if (!mobile && !email) {
    const e = new Error('Your account has no registered mobile or email to receive an OTP');
    e.status = 422;
    throw e;
  }

  // Prod → random; QA (QA_DETERMINISTIC_OTP=true) → last 4 digits of the
  // admin's registered mobile. Email-only admins (no mobile) fall back to
  // random even on QA — read that from the dev log below.
  const otp = resolveMobileOtp(mobile);
  const now = new Date();
  const expires = otpExpiryDate(now);

  // <=> is the NULL-safe equality operator — matches a row whose email/mobile
  // are both NULL too, so the (email, mobile, otp_type) tuple stays single-row
  // even for an admin missing one channel.
  const [[existing]] = await pool.query(
    `SELECT id FROM otp_details
      WHERE user_email <=> ? AND user_mobile_no <=> ? AND otp_type = ?
      LIMIT 1`,
    [email, mobile, otpType],
  );

  if (existing) {
    await pool.query(
      `UPDATE otp_details
          SET otp = ?, generated_on = ?, valid_up_to = ?, is_expired = 0, count = count + 1
        WHERE id = ?`,
      [otp, now, expires, existing.id],
    );
  } else {
    await pool.query(
      `INSERT INTO otp_details
         (otp, otp_type, user_email, user_mobile_no, generated_on, valid_up_to, is_expired, count)
       VALUES (?, ?, ?, ?, ?, ?, 0, 1)`,
      [otp, otpType, email, mobile, now, expires],
    );
  }

  if (process.env.NODE_ENV !== 'production') {
    logger.event('🔑', 'cyan',
      `Action OTP (${action}) for admin ${email || mobile}: ${otp} (valid 5 min) — dev only`);
  }

  let delivered = false;
  try {
    const { deliverOtp } = require('./otp-delivery.service');
    // Prefer the mobile channel for a sensitive action (WhatsApp → SMS), which
    // is what an admin's "registered mobile" expects; fall back to email.
    const result = await deliverOtp({
      identifier: mobile || email,
      email,
      mobile,
      name: admin.user_name,
      otp,
      contextLabel: `admin-${action}`,
    });
    delivered = !!(result && result.finalDelivered);
  } catch (e) {
    logger.warn({ err: e.message, action }, 'action-otp: delivery failed (row persisted, verify still works)');
  }

  logger.info('Action OTP issued · action=' + action + ' · delivered=' + delivered);
  return { delivered, expiresAt: expires };
}

/*
 * Verify + consume an action OTP for `admin`. Returns { valid, reason? }.
 * Mirrors verifyLoginOtp: expiry flag → expiry timestamp → value match, then
 * consume (is_expired = 1) so it is single-use.
 */
async function verifyActionOtp(admin, action, otp) {
  logger.info('Verify action OTP · action=' + action);
  const otpType = OTP_TYPES[action];
  if (!otpType) return { valid: false, reason: 'UNKNOWN_ACTION' };
  if (otp === undefined || otp === null || String(otp).trim() === '') {
    return { valid: false, reason: 'OTP_REQUIRED' };
  }

  const email = admin.official_email || null;
  const mobile = admin.mobile_no || null;

  const [[row]] = await pool.query(
    `SELECT id, otp, valid_up_to, is_expired FROM otp_details
      WHERE user_email <=> ? AND user_mobile_no <=> ? AND otp_type = ?
      LIMIT 1`,
    [email, mobile, otpType],
  );

  if (!row) return { valid: false, reason: 'NO_OTP_ISSUED' };
  if (row.is_expired === true || row.is_expired === 1) return { valid: false, reason: 'OTP_EXPIRED' };
  // Explicit IST parse rather than relying on the process TZ pin in
  // server.js. This is an auth path: it should stay correct even if a future
  // entry point (a worker, a one-off script) never loads that file.
  if (istIsPast(row.valid_up_to)) {
    await pool.query('UPDATE otp_details SET is_expired = 1 WHERE id = ?', [row.id]);
    return { valid: false, reason: 'OTP_EXPIRED' };
  }
  if (Number(row.otp) !== Number(otp)) return { valid: false, reason: 'OTP_MISMATCH' };

  await pool.query('UPDATE otp_details SET is_expired = 1 WHERE id = ?', [row.id]);
  logger.info('Action OTP verified · action=' + action);
  return { valid: true };
}

module.exports = { sendActionOtp, verifyActionOtp, OTP_TYPES };
