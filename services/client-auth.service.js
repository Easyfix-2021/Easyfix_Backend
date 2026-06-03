const { pool } = require('../db');
const logger = require('../logger');
const { resolveLoginOtp, otpExpiryDate } = require('../utils/otp');
const jwt = require('jsonwebtoken');

/*
 * Client SPOC authentication — distinct from internal-user auth.
 * Principal: tbl_client_contacts (the SPOC). OTP channel: contact_email or contact_no.
 * JWT claim `sub` is namespaced as `spoc:<id>` so auth.js can distinguish.
 */

// Both lookups JOIN tbl_client and project `client_status` so callers can
// reject login when the parent client account is inactive (status != 1).
// Doing the JOIN here keeps the auth flow honest — every code path that
// reads a SPOC also sees whether their client is enabled.
async function findSpoc(identifier) {
  const col = /@/.test(identifier) ? 'cc.contact_email' : 'cc.contact_no';
  const [[row]] = await pool.query(
    `SELECT cc.id, cc.client_id, cc.contact_name, cc.contact_email, cc.contact_no,
            cl.client_status
       FROM tbl_client_contacts cc
       LEFT JOIN tbl_client cl ON cl.client_id = cc.client_id
      WHERE ${col} = ? AND cc.status = 1
      LIMIT 1`,
    [identifier]
  );
  return row || null;
}

async function findSpocById(id) {
  // client_name added so the sidebar can show the company name on the
  // Client Profile nav item without an extra round-trip. Cheap (single
  // LEFT JOIN, indexed PK) and the row is already being assembled here.
  const [[row]] = await pool.query(
    `SELECT cc.id, cc.client_id, cc.contact_name, cc.contact_email, cc.contact_no,
            cl.client_status, cl.client_name
       FROM tbl_client_contacts cc
       LEFT JOIN tbl_client cl ON cl.client_id = cc.client_id
      WHERE cc.id = ? AND cc.status = 1
      LIMIT 1`,
    [id]
  );
  return row || null;
}

async function createLoginOtp(identifier) {
  const spoc = await findSpoc(identifier);
  if (!spoc) return { found: false };
  // Parent client must be active. Block OTP issuance for SPOCs whose
  // client account has been deactivated by ops — otherwise an inactive
  // client could still receive OTPs and ride their old JWT.
  if (Number(spoc.client_status) !== 1) {
    return { found: false, reason: 'CLIENT_INACTIVE' };
  }
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

  return { found: true, expiresAt: expires };
}

async function verifyLoginOtp(identifier, otp) {
  const spoc = await findSpoc(identifier);
  if (!spoc) return { ok: false, reason: 'USER_NOT_FOUND' };
  // Double-guard: if the client was deactivated between send-otp and
  // verify-otp (or the SPOC managed to obtain a fresh OTP via another
  // path), refuse to issue a JWT.
  if (Number(spoc.client_status) !== 1) {
    return { ok: false, reason: 'CLIENT_INACTIVE' };
  }
  // Match the same (email, mobile, otp_type) tuple that createLoginOtp wrote.
  // AND-ing both columns ensures partial legacy rows never get returned.
  const [[row]] = await pool.query(
    `SELECT id, otp, valid_up_to, is_expired FROM otp_details
      WHERE user_email = ? AND user_mobile_no = ? AND otp_type = 'Login Otp'
      LIMIT 1`,
    [spoc.contact_email, spoc.contact_no]
  );
  if (!row) return { ok: false, reason: 'NO_OTP_ISSUED' };
  if (row.is_expired || new Date(row.valid_up_to).getTime() < Date.now()) {
    await pool.query('UPDATE otp_details SET is_expired = 1 WHERE id = ?', [row.id]);
    return { ok: false, reason: 'OTP_EXPIRED' };
  }
  if (Number(row.otp) !== Number(otp)) return { ok: false, reason: 'OTP_MISMATCH' };
  await pool.query('UPDATE otp_details SET is_expired = 1 WHERE id = ?', [row.id]);

  const token = jwt.sign(
    { sub: `spoc:${spoc.id}`, clientId: spoc.client_id, name: spoc.contact_name, email: spoc.contact_email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRY || '30d' }
  );
  return { ok: true, token, spoc };
}

module.exports = { findSpoc, findSpocById, createLoginOtp, verifyLoginOtp };
