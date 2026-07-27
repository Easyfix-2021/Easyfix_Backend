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
  const raw = String(identifier || '').trim();
  const isEmail = /@/.test(raw);
  // Case-insensitive email match (mobile compared as-is so its index stays
  // usable). LOWER() on both sides handles any stored casing. Both createLoginOtp
  // and verifyLoginOtp key otp_details by the RETURNED row's canonical
  // contact_email/contact_no, so OTP correlation stays intact regardless of casing.
  const col = isEmail ? 'LOWER(cc.contact_email)' : 'cc.contact_no';
  const value = isEmail ? raw.toLowerCase() : raw;
  // SPOC must be active (cc.status = 1 — inactive SPOC = "you are inactive").
  // Also carry the CLIENT's active flag (cl.client_status) so callers can
  // block/label an inactive client distinctly.
  const [[row]] = await pool.query(
    `SELECT cc.id, cc.client_id, cc.contact_name, cc.contact_email, cc.contact_no,
            cl.client_status
       FROM tbl_client_contacts cc
       LEFT JOIN tbl_client cl ON cl.client_id = cc.client_id
      WHERE ${col} = ? AND cc.status = 1 LIMIT 1`,
    [value]
  );
  return row || null;
}

async function findSpocById(id) {
  const [[row]] = await pool.query(
    `SELECT cc.id, cc.client_id, cc.contact_name, cc.contact_email, cc.contact_no,
            cl.client_status
       FROM tbl_client_contacts cc
       LEFT JOIN tbl_client cl ON cl.client_id = cc.client_id
      WHERE cc.id = ? AND cc.status = 1 LIMIT 1`,
    [id]
  );
  return row || null;
}

/**
 * Resolve the active Client (user_type_id = 3) row in tbl_user that corresponds
 * to a SPOC, so its user_id + user_role can enrich the login token. SPOCs are
 * linked to tbl_user only by identity (tbl_client_contacts.user_id is often 0),
 * so we match on the SPOC's own email (canonical) then fall back to mobile.
 * Empty strings are treated as "no value" — many type-3 rows share an empty
 * official_email, and matching those would attach a wrong role. Returns null
 * (never throws) when there is no match; login is not gated on this.
 */
async function findClientUser(spoc) {
  const email = (spoc.contact_email || '').trim() || null;
  const mobile = (spoc.contact_no || '').trim() || null;
  if (!email && !mobile) return null;
  try {
    const [[user]] = await pool.query(
      `SELECT user_id, user_role FROM tbl_user
        WHERE user_type_id = 3 AND user_status = 1
          AND ( (? IS NOT NULL AND LOWER(official_email) = LOWER(?))
             OR (? IS NOT NULL AND mobile_no = ?) )
        ORDER BY (? IS NOT NULL AND LOWER(official_email) = LOWER(?)) DESC, user_id DESC
        LIMIT 1`,
      [email, email, mobile, mobile, email, email]
    );
    return user || null;
  } catch (e) {
    logger.warn('Login enrich · type-3 client user lookup failed · ' + e.message);
    return null;
  }
}

async function createLoginOtp(identifier) {
  logger.info('Create client SPOC login OTP');
  const spoc = await findSpoc(identifier);
  if (!spoc) logger.warn('Create login OTP · SPOC not found');
  if (!spoc) return { found: false };
  if (Number(spoc.client_status) !== 1) {
    logger.warn('Create login OTP · client inactive · clientId=' + spoc.client_id);
    return { found: false, clientInactive: true };
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
      WHERE user_email = ? AND user_mobile_no = ? AND otp_type = 'Client_login'
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
       VALUES (?, 'Client_login', ?, ?, ?, ?, 0, 1)`,
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
  if (Number(spoc.client_status) !== 1) {
    logger.warn('Verify login OTP · reason=CLIENT_INACTIVE · clientId=' + spoc.client_id);
    return { ok: false, reason: 'CLIENT_INACTIVE' };
  }
  // Match the same (email, mobile, otp_type) tuple that createLoginOtp wrote.
  // AND-ing both columns ensures partial legacy rows never get returned.
  const [[row]] = await pool.query(
    `SELECT id, otp, valid_up_to, is_expired FROM otp_details
      WHERE user_email = ? AND user_mobile_no = ? AND otp_type = 'Client_login'
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

  // Enrich (does NOT gate login): resolve the SPOC's matching active Client
  // (user_type_id = 3) row in tbl_user by email, falling back to mobile, to
  // carry user_id + user_role into the token for role-based authorization.
  // The SPOC (tbl_client_contacts) stays the login principal; a SPOC with no
  // matching type-3 user still authenticates (claims are null).
  const clientUser = await findClientUser(spoc);

  const token = jwt.sign(
    {
      sub: `spoc:${spoc.id}`,
      clientId: spoc.client_id,
      name: spoc.contact_name,
      email: spoc.contact_email,
      userId: clientUser?.user_id ?? null,
      userRole: clientUser?.user_role ?? null,
      userType: clientUser ? 3 : null,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRY || '30d' }
  );
  logger.info('Client SPOC login OTP verified · spocId=' + spoc.id + ' clientId=' + spoc.client_id
    + ' · clientUserId=' + (clientUser?.user_id ?? '-') + ' role=' + (clientUser?.user_role ?? '-'));
  return { ok: true, token, spoc };
}

module.exports = { findSpoc, findSpocById, createLoginOtp, verifyLoginOtp };
