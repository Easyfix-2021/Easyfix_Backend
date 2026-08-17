const { pool } = require('../db');
const logger = require('../logger');
const { resolveLoginOtp, staticLoginOtpFor, otpExpiryDate } = require('../utils/otp');
const { signUserToken } = require('../utils/jwt');
const { istIsPast } = require('../utils/ist-calendar');

/*
 * Auth model reality (2026-04-17):
 *   - tbl_user has NO password column. Internal user login is OTP-only.
 *   - Legacy EasyFix_CRM also supports Microsoft Azure AD OAuth; that is not
 *     replicated here yet. /api/auth/login is stubbed 501 and will either be
 *     wired to Azure AD or dropped once the blueprint is updated.
 *
 * INTERNAL-ONLY GATE (added 2026-04-20):
 *   - CRM access is restricted to rows where `tbl_user.user_type_id = 5`
 *     (Internal users). Client SPOC, external partner, and other user types
 *     use separate auth paths (/api/client/* + tbl_client_contacts, etc.)
 *     and must never be issued a CRM JWT.
 *   - Gate lives at the DB-query level rather than post-fetch filtering:
 *       (a) non-internal users can't even TRIGGER an OTP (the query returns
 *           no row → `createLoginOtp` returns {found: false}),
 *       (b) verifyLoginOtp's re-query also returns null → USER_NOT_FOUND.
 *     Single layer, no branch for "authenticated but forbidden" — exactly
 *     the same response shape as an invalid identifier. Prevents enumeration
 *     of which emails belong to non-internal user_type_ids.
 *   - If the set of allowed user_type_ids grows (e.g. "Technology team" wants
 *     a new type), change the WHERE clause to `user_type_id IN (?, ?)` and
 *     update this comment — one place to edit, two SELECTs to stay in sync.
 */

async function findActiveUserByIdentifier(identifier) {
  const raw = String(identifier || '').trim();
  const isEmail = /@/.test(raw);
  // Email login is case-insensitive: users may type "Pranav@easyfix.in" but the
  // row is stored lowercase (see user.service.js create/dup-check). Match on
  // LOWER(official_email) with a lowercased param — the same house pattern the
  // duplicate-email check uses. Mobile identifiers are digits (no case), so they
  // are compared as-is: this keeps the mobile_no index usable and never mangles
  // the value with toLowerCase(). Both createLoginOtp and verifyLoginOtp route
  // through here and then key otp_details by the RETURNED row's canonical
  // official_email/mobile_no, so OTP correlation stays intact regardless of casing.
  const whereCol = isEmail ? 'LOWER(official_email)' : 'mobile_no';
  const value = isEmail ? raw.toLowerCase() : raw;
  const [[user]] = await pool.query(
    `SELECT user_id, user_code, user_name, official_email, user_role, user_type_id,
            city_id, mobile_no, alternate_no,
            manage_clients, manage_cities, manage_states, manage_verticals,
            user_status
       FROM tbl_user
      WHERE ${whereCol} = ?
        AND user_status = 1
        AND user_type_id = 5
      LIMIT 1`,
    [value]
  );
  return user || null;
}

async function findUserById(userId) {
  const [[user]] = await pool.query(
    `SELECT user_id, user_code, user_name, official_email, user_role, user_type_id,
            city_id, mobile_no, alternate_no,
            manage_clients, manage_cities, manage_states, manage_verticals,
            user_status
       FROM tbl_user
      WHERE user_id = ?
        AND user_status = 1
        AND user_type_id = 5
      LIMIT 1`,
    [userId]
  );
  return user || null;
}

async function createLoginOtp(identifier) {
  logger.info('Create login OTP requested');
  const user = await findActiveUserByIdentifier(identifier);
  if (!user) {
    logger.warn('Create login OTP · no active internal user matched identifier');
    return { found: false };
  }

  // resolveLoginOtp() returns a real random OTP in production. In QA,
  // when QA_DETERMINISTIC_OTP=true is set in /opt/easyfix/backend.env,
  // it returns a predictable value: 2468 for email logins, last 4 digits
  // of the dialed number for mobile logins. The QA flag MUST never be
  // set in prod — would be a complete auth bypass.
  const otp = resolveLoginOtp(identifier);
  const now = new Date();
  const expires = otpExpiryDate(now);

  // Single-row-per-(email, mobile, otp_type) model. We look up by ALL THREE
  // fields together so:
  //   • a mobile reassigned to a different email gets its own row (no false reuse),
  //   • legacy partial rows that have only email OR only mobile (set during the
  //     old per-request-INSERT regime, or imported from prior tools) cannot match
  //     and therefore can never collide with new auth flows.
  // Always write BOTH email AND mobile from the user record on every UPSERT —
  // never just one — so the (email, mobile, otp_type) tuple stays meaningful.
  const [[existing]] = await pool.query(
    `SELECT id FROM otp_details
      WHERE user_email = ? AND user_mobile_no = ? AND otp_type = 'crm_login'
      LIMIT 1`,
    [user.official_email, user.mobile_no]
  );

  if (existing) {
    // Refresh the existing row in place. count++ is the legacy "OTPs issued"
    // counter; we don't reset it on each cycle so support can see how many
    // times a given user re-requested.
    await pool.query(
      `UPDATE otp_details
          SET otp = ?, generated_on = ?, valid_up_to = ?, is_expired = 0,
              count = count + 1
        WHERE id = ?`,
      [otp, now, expires, existing.id]
    );
  } else {
    // First-ever OTP for this (email, mobile, otp_type) tuple — fresh INSERT.
    // We do NOT fall back to "INSERT if any partial-row exists" because
    // partial legacy rows shouldn't be repaired silently — they should stay
    // out of the auth flow entirely, exactly as the user requested.
    const [insertResult] = await pool.query(
      `INSERT INTO otp_details
         (otp, otp_type, user_email, user_mobile_no, generated_on, valid_up_to, is_expired, count)
       VALUES (?, 'crm_login', ?, ?, ?, ?, 0, 1)`,
      [otp, user.official_email, user.mobile_no, now, expires]
    );
    if (!insertResult?.insertId) {
      // Should be impossible given MySQL's AUTO_INCREMENT on otp_details.id, but
      // fail closed rather than send a code the user can't verify.
      throw new Error('Failed to persist OTP row before dispatch');
    }
  }

  // DEV ONLY: log the OTP so developers can test without an SMS/email gateway.
  // Step 11 will deliver via SMSCountry + Gmail; at that point remove this log line
  // and send via the notification services instead.
  if (process.env.NODE_ENV !== 'production') {
    logger.event('🔑', 'cyan',
      `OTP for ${user.official_email || user.mobile_no}: ${otp}  (staff user_id=${user.user_id}, valid 5 min) — dev only`);
  }

  // Fixed-OTP test accounts (utils/otp.js::STATIC_LOGIN_OTP_ACCOUNTS): the code
  // is a published constant, so there is nothing to deliver — skip the real
  // email/WhatsApp send entirely (no message ever reaches the mailbox) while
  // still reporting success so the client advances to the OTP-entry screen. The
  // OTP row was already written above, so verifyLoginOtp() finds it normally.
  if (staticLoginOtpFor(identifier) != null) {
    logger.info('Login OTP is a STATIC test-account code — delivery suppressed · user_id=' + user.user_id);
    return {
      found: true,
      userId: user.user_id,
      email: user.official_email,
      expiresAt: expires,
      delivered: true,
      channelsTried: 'static-test-otp',
    };
  }

  // Channel-preference delivery:
  //   email identifier → Email first, WhatsApp fallback
  //   mobile identifier → WhatsApp first, SMS fallback
  // TEST_EMAILS / TEST_MOBILE redirections inside each provider service keep
  // dev traffic from reaching real users.
  const { deliverOtp } = require('./otp-delivery.service');
  const delivery = await deliverOtp({
    identifier,
    email: user.official_email,
    mobile: user.mobile_no,
    name: user.user_name,
    otp,
    contextLabel: 'staff',
  });

  /*
   * DO NOT DISCARD THE DELIVERY OUTCOME.
   *
   * Dropping it is how "OTP sent" got shown for an OTP that no channel ever
   * carried — the email suppressed because the mailbox does not exist AND the
   * WhatsApp fallback unavailable (no mobile on file / Gallabox down / template
   * unapproved). That is verbatim the "no screen could say why" symptom this
   * whole change exists to kill, so the truth has to reach the route.
   *
   * `disabled` is NOT a failure: it means NOTIFICATIONS_DISABLE suppressed every
   * provider on this host (QA/dev), where the OTP is read from the logs.
   */
  const dispatched = !!(delivery && (delivery.finalDelivered || delivery.disabled));
  const channelsTried = (delivery && Array.isArray(delivery.attempts) ? delivery.attempts : [])
    .map((a) => a.channel + '=' + (a.delivered ? 'ok' : (a.skipped || a.error || 'failed')))
    .join(', ');

  if (dispatched) {
    logger.info('Login OTP issued and dispatched · user_id=' + user.user_id
      + ' · channels=[' + channelsTried + ']');
  } else {
    logger.error('Login OTP issued but NOT DELIVERED on any channel · user_id=' + user.user_id
      + ' · channels=[' + channelsTried + ']');
  }

  return {
    found: true,
    userId: user.user_id,
    email: user.official_email,
    expiresAt: expires,
    delivered: dispatched,
    channelsTried,
  };
}

async function verifyLoginOtp(identifier, otp) {
  logger.info('Verify login OTP requested');
  const user = await findActiveUserByIdentifier(identifier);
  if (!user) return { ok: false, reason: 'USER_NOT_FOUND' };

  // Match the same (email, mobile, otp_type) tuple createLoginOtp wrote
  // against. AND-ing both columns ensures legacy partial rows (rows that
  // had only email or only mobile) never get returned here — they simply
  // can't satisfy the predicate. Single-row-per-tuple model means LIMIT 1
  // is redundant in the happy path but kept as a safety net.
  const [[row]] = await pool.query(
    `SELECT id, otp, valid_up_to, is_expired
       FROM otp_details
      WHERE user_email = ? AND user_mobile_no = ? AND otp_type = 'crm_login'
      LIMIT 1`,
    [user.official_email, user.mobile_no]
  );

  if (!row) return { ok: false, reason: 'NO_OTP_ISSUED' };
  if (row.is_expired === true || row.is_expired === 1) return { ok: false, reason: 'OTP_EXPIRED' };
  // istIsPast, not `new Date(str)`: valid_up_to is an IST wall-clock string,
  // and a bare parse on a UTC pod grants this LOGIN otp an extra 5h30m.
  if (istIsPast(row.valid_up_to)) {
    await pool.query('UPDATE otp_details SET is_expired = 1 WHERE id = ?', [row.id]);
    return { ok: false, reason: 'OTP_EXPIRED' };
  }
  if (Number(row.otp) !== Number(otp)) return { ok: false, reason: 'OTP_MISMATCH' };

  // Consume the OTP so it can't be reused.
  await pool.query('UPDATE otp_details SET is_expired = 1 WHERE id = ?', [row.id]);

  const token = signUserToken(user);
  logger.info('Login OTP verified · token issued · user_id=' + user.user_id);
  return { ok: true, token, user };
}

module.exports = {
  findActiveUserByIdentifier,
  findUserById,
  createLoginOtp,
  verifyLoginOtp,
};
