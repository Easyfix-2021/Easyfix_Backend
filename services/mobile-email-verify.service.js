/**
 * services/mobile-email-verify.service.js
 *
 * Technician email exist-check + email-verification-link flow.
 *
 * Surface (all efrId-first, matching the rest of services/*):
 *   checkEmailExists(efrId, email) → { exists }   — collision check vs OTHER techs
 *   sendVerification(efrId, email, { origin }) → { sent } — mint token + mail link
 *   verifyToken(token)            → { ok, efrId } — consume the link (PUBLIC route)
 *   getStatus(efrId)              → { verified }  — app polls this every 30s
 *
 * Token ledger: migrations/2026-06-16-create-tbl-efr-email-verification.sql
 *   (tbl_efr_email_verification — EasyFix-owned, single-use, 24h TTL).
 *
 * Verification flips the ALREADY-EXISTING tbl_easyfixer.is_email_verified flag
 * (read by the CRM verification screen — services/easyfixer-verification.service.js);
 * this flow is the first writer. Every write is scoped to the token's OWN
 * efr_id, never a caller-supplied one.
 *
 * Style: CommonJS, mysql2/promise, parameterised SQL only. `pool` imported
 * directly (consistent with the other mobile services in this repo).
 */

const crypto = require('crypto');
const { pool } = require('../db');
const emailService = require('./email.service');
const logger = require('../logger');

// Token lifetime. 24h — long enough for a technician to open the mail at their
// leisure, short enough that a leaked link goes stale quickly.
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

// Normalise an email for comparison/storage: trim + lowercase. Emails are
// effectively case-insensitive for delivery and we don't want "A@x.com" vs
// "a@x.com" to read as two different addresses in the collision check.
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// BIT(1)/tinyint → boolean. Mirrors the `bool()` helper in
// services/easyfixer-verification.service.js so is_email_verified reads the
// same here as it does on the CRM screen.
function toBool(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (Buffer.isBuffer(v)) return v[0] === 1;
  return Number(v) === 1;
}

/**
 * Resolve the backend base URL the verification link points AT.
 *
 * The link target is THIS backend's own public route
 * (/api/public/email-verify/<token>) — the technician's mail client opens it
 * directly, so it must be an absolute backend URL, not a frontend page.
 * Prefer the per-environment PUBLIC_API_BASE_URL env; fall back to the
 * request origin (protocol + host) the route passes in. Trailing slash
 * stripped so the join below never doubles up.
 */
function resolveBaseUrl(origin) {
  const base = process.env.PUBLIC_API_BASE_URL || origin || '';
  return String(base).replace(/\/+$/, '');
}

/**
 * checkEmailExists(efrId, email) → { exists }
 *
 * `exists` is TRUE when ANOTHER technician already uses this email
 * (efr_email has no UNIQUE constraint, so we enforce uniqueness in code).
 * Excludes the caller's own row so re-saving an unchanged email isn't a
 * false collision. Trim+lowercase compare on both sides.
 */
async function checkEmailExists(efrId, email) {
  logger.info('Check email exists (collision vs other techs)');
  const normalized = normalizeEmail(email);
  if (!normalized) return { exists: false };
  const [rows] = await pool.query(
    `SELECT efr_id FROM tbl_easyfixer
      WHERE LOWER(TRIM(efr_email)) = ? AND efr_id <> ?
      LIMIT 1`,
    [normalized, efrId],
  );
  logger.info('Email collision check · exists=' + (rows.length > 0));
  return { exists: rows.length > 0 };
}

/**
 * sendVerification(efrId, email, { origin }) → { sent }
 *
 * Mints a single-use token (crypto.randomBytes — never Math.random), records
 * it with a 24h TTL, builds the public link, and mails it via the existing
 * MS-Graph email service (which self-guards NOTIFICATIONS_DISABLE / TEST_EMAILS).
 */
async function sendVerification(efrId, email, { origin } = {}) {
  logger.info('Send email verification link · ttlHours=24');
  const normalized = normalizeEmail(email);
  const token = crypto.randomBytes(24).toString('hex'); // 48 hex chars
  const validUpTo = new Date(Date.now() + TOKEN_TTL_MS);

  await pool.query(
    `INSERT INTO tbl_efr_email_verification (efr_id, email, token, valid_up_to)
     VALUES (?, ?, ?, ?)`,
    [efrId, normalized, token, validUpTo],
  );

  const base = resolveBaseUrl(origin);
  const link = `${base}/api/public/email-verify/${token}`;

  const subject = 'Verify your EasyFix email';
  const text =
    `Please confirm your EasyFix email address by opening the link below:\n\n${link}\n\n` +
    `This link is valid for 24 hours. If you did not request this, you can ignore this email.`;
  const html =
    `<p>Please confirm your EasyFix email address by clicking the button below.</p>` +
    `<p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#2563eb;color:#ffffff;` +
    `text-decoration:none;border-radius:6px;font-family:sans-serif;font-size:14px;">Verify Email</a></p>` +
    `<p style="font-family:sans-serif;font-size:12px;color:#6b7280;">Or paste this link into your browser:<br>` +
    `<a href="${link}">${link}</a></p>` +
    `<p style="font-family:sans-serif;font-size:12px;color:#6b7280;">This link is valid for 24 hours. ` +
    `If you did not request this, you can safely ignore this email.</p>`;

  const result = await emailService.send({
    to: normalized,
    subject,
    text,
    html,
    category: 'transactional',
  });

  // `accepted` (Graph 202 = queued), not `delivered` — email.service cannot
  // tell us the mailbox received anything. Logging it as "delivered" is what
  // made the OTP variant of this bug so hard to see.
  logger.info(
    { efrId, accepted: !!result.accepted, disabled: !!result.disabled },
    'email-verify: verification link queued with Microsoft Graph',
  );

  return { sent: true };
}

/**
 * verifyToken(token) → { ok, efrId }
 *
 * Consumes the link from the PUBLIC route (NO efrId — the token IS the
 * authority). Finds an unconsumed, unexpired token; on hit, stamps
 * verified_at on the token row AND flips is_email_verified on the token's
 * OWN tbl_easyfixer row. Idempotency / single-use is enforced by the
 * `verified_at IS NULL` predicate — a second open returns { ok:false }.
 */
async function verifyToken(token) {
  logger.info('Verify email token (public consume)');
  if (!token) return { ok: false };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT id, efr_id FROM tbl_efr_email_verification
        WHERE token = ? AND verified_at IS NULL AND valid_up_to >= NOW()
        LIMIT 1
        FOR UPDATE`,
      [token],
    );
    if (!rows.length) {
      logger.warn('Email token invalid, expired or already used');
      await conn.rollback();
      return { ok: false };
    }
    const { id, efr_id: efrId } = rows[0];

    await conn.query(
      `UPDATE tbl_efr_email_verification SET verified_at = NOW() WHERE id = ?`,
      [id],
    );
    // Flip the status flag on the token's OWN technician row.
    await conn.query(
      `UPDATE tbl_easyfixer SET is_email_verified = 1 WHERE efr_id = ?`,
      [efrId],
    );

    await conn.commit();
    logger.info({ efrId }, 'email-verify: email verified');
    return { ok: true, efrId };
  } catch (err) {
    logger.error('Verify email token failed, rolled back · ' + err.message);
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * getStatus(efrId) → { verified }
 *
 * Reads the persisted is_email_verified flag (BIT/tinyint → boolean). The
 * app polls this every 30s after sending a verification link.
 */
async function getStatus(efrId) {
  logger.info('Get email verification status');
  const [rows] = await pool.query(
    `SELECT is_email_verified FROM tbl_easyfixer WHERE efr_id = ? AND NOT (tbl_easyfixer.efr_status <=> 3) LIMIT 1`,
    [efrId],
  );
  if (!rows.length) return { verified: false };
  return { verified: toBool(rows[0].is_email_verified) };
}

module.exports = { checkEmailExists, sendVerification, verifyToken, getStatus };
