const { pool } = require('../db');
const logger = require('../logger');
const { resolveLoginOtp, otpExpiryDate } = require('../utils/otp');
const jwt = require('jsonwebtoken');

/*
 * Client SPOC authentication — distinct from internal-user auth.
 * Principal: tbl_client_contacts (the SPOC). OTP channel: contact_email or contact_no.
 * JWT claim `sub` is namespaced as `spoc:<id>` so auth.js can distinguish.
 */

async function findSpoc(identifier) {
  const col = /@/.test(identifier) ? 'contact_email' : 'contact_no';
  const [[row]] = await pool.query(
    `SELECT id, client_id, contact_name, contact_email, contact_no
       FROM tbl_client_contacts WHERE ${col} = ? AND status = 1 LIMIT 1`,
    [identifier]
  );
  return row || null;
}

async function findSpocById(id) {
  const [[row]] = await pool.query(
    `SELECT id, client_id, contact_name, contact_email, contact_no
       FROM tbl_client_contacts WHERE id = ? AND status = 1 LIMIT 1`,
    [id]
  );
  return row || null;
}

async function createLoginOtp(identifier) {
  logger.info('Create client SPOC login OTP');
  const spoc = await findSpoc(identifier);
  if (!spoc) logger.warn('Create login OTP · SPOC not found');
  if (!spoc) return { found: false };
  // SPOC identifier can be email or mobile (we accept both via findSpoc).
  // resolveLoginOtp picks 2468 for email or last 4 digits of mobile in QA;
  // real random in prod.
  const otp = resolveLoginOtp(identifier);
  const now = new Date();
  const expires = otpExpiryDate(now);
  // Single-row-per-(email, mobile, otp_type) upsert. Always write BOTH email
  // and mobile from the SPOC record, so legacy partial rows can never match
  // a future verify. See auth.service.js for the full rationale.
  const [[existing]] = await pool.query(
    `SELECT id FROM otp_details
      WHERE user_email = ? AND user_mobile_no = ? AND otp_type = 'Login Otp'
      LIMIT 1`,
    [spoc.contact_email, spoc.contact_no]
  );
  if (existing) {
    await pool.query(
      `UPDATE otp_details
          SET otp = ?, generated_on = ?, valid_up_to = ?, is_expired = 0,
              count = count + 1
        WHERE id = ?`,
      [otp, now, expires, existing.id]
    );
  } else {
    await pool.query(
      `INSERT INTO otp_details (otp, otp_type, user_email, user_mobile_no, generated_on, valid_up_to, is_expired, count)
       VALUES (?, 'Login Otp', ?, ?, ?, ?, 0, 1)`,
      [otp, spoc.contact_email, spoc.contact_no, now, expires]
    );
  }
  if (process.env.NODE_ENV !== 'production') {
    logger.event('🔑', 'cyan',
      `OTP for ${spoc.contact_email || spoc.contact_no}: ${otp}  (client SPOC id=${spoc.id}, valid 5 min) — dev only`);
  }

  const { deliverOtp } = require('./otp-delivery.service');
  await deliverOtp({
    identifier,
    email: spoc.contact_email,
    mobile: spoc.contact_no,
    name: spoc.contact_name,
    otp,
    contextLabel: 'spoc',
  });

  logger.info('Client SPOC login OTP issued · spocId=' + spoc.id + ' clientId=' + spoc.client_id);
  return { found: true, expiresAt: expires };
}

async function verifyLoginOtp(identifier, otp) {
  logger.info('Verify client SPOC login OTP');
  const spoc = await findSpoc(identifier);
  if (!spoc) logger.warn('Verify login OTP · reason=USER_NOT_FOUND');
  if (!spoc) return { ok: false, reason: 'USER_NOT_FOUND' };
  // Match the same (email, mobile, otp_type) tuple that createLoginOtp wrote.
  // AND-ing both columns ensures partial legacy rows never get returned.
  const [[row]] = await pool.query(
    `SELECT id, otp, valid_up_to, is_expired FROM otp_details
      WHERE user_email = ? AND user_mobile_no = ? AND otp_type = 'Login Otp'
      LIMIT 1`,
    [spoc.contact_email, spoc.contact_no]
  );
  if (!row) logger.warn('Verify login OTP · reason=NO_OTP_ISSUED · spocId=' + spoc.id);
  if (!row) return { ok: false, reason: 'NO_OTP_ISSUED' };
  if (row.is_expired || new Date(row.valid_up_to).getTime() < Date.now()) {
    await pool.query('UPDATE otp_details SET is_expired = 1 WHERE id = ?', [row.id]);
    logger.warn('Verify login OTP · reason=OTP_EXPIRED · spocId=' + spoc.id);
    return { ok: false, reason: 'OTP_EXPIRED' };
  }
  if (Number(row.otp) !== Number(otp)) logger.warn('Verify login OTP · reason=OTP_MISMATCH · spocId=' + spoc.id);
  if (Number(row.otp) !== Number(otp)) return { ok: false, reason: 'OTP_MISMATCH' };
  await pool.query('UPDATE otp_details SET is_expired = 1 WHERE id = ?', [row.id]);

  const token = jwt.sign(
    { sub: `spoc:${spoc.id}`, clientId: spoc.client_id, name: spoc.contact_name, email: spoc.contact_email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRY || '30d' }
  );
  logger.info('Client SPOC login OTP verified · spocId=' + spoc.id + ' clientId=' + spoc.client_id);
  return { ok: true, token, spoc };
}

module.exports = { findSpoc, findSpocById, createLoginOtp, verifyLoginOtp };
