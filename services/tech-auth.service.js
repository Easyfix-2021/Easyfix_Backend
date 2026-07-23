const { pool } = require('../db');
const logger = require('../logger');
const { resolveLoginOtp, otpExpiryDate } = require('../utils/otp');
const jwt = require('jsonwebtoken');

/*
 * Technician authentication — against tbl_easyfixer.
 * OTP delivered via efr_no (mobile). JWT `sub` = `efr:<id>`.
 */

/*
 * Login identity resolution — deliberately NOT filtered on efr_status.
 *
 * The old lookup was `efr_no = ? AND efr_status = 1`, which conflated two
 * different questions: "who is this?" (identity) and "may they work?"
 * (eligibility). Because the caller's response to "no identity" is CREATE, every
 * rule that hid a row silently became a rule that MINTED one — a deactivated or
 * rejected technician who logged in again got a brand-new empty stub instead of
 * their own record, orphaning their history. Identity resolution now ignores
 * status entirely; eligibility is enforced downstream where it belongs
 * (candidate-ranking + job assign both hard-gate on efr_status = 1, so a
 * deactivated tech can log in and see their status but can never be given work).
 *
 * `bestRowOrder` picks the most authoritative row when a mobile has several
 * (production has genuine duplicates — see SCHEMA.md and the cleanup queries in
 * migrations/): a CRM-verified row wins, then an active one, then the newest.
 * `(x = 1) DESC` — not `x DESC` — so NULL flags sort last instead of ahead of 0.
 */
const TECH_COLS = 'efr_id, efr_name, efr_no, efr_email, efr_status, is_technician_verified, user_id';
const BEST_ROW_ORDER =
  'ORDER BY (is_technician_verified = 1) DESC, (efr_status = 1) DESC, efr_id DESC';

/** Primary lookup: the technician's own login number on tbl_easyfixer. */
async function resolveByEfrNo(mobile, runner = pool) {
  const [[row]] = await runner.query(
    `SELECT ${TECH_COLS} FROM tbl_easyfixer
      WHERE efr_no = ?
      ${BEST_ROW_ORDER}
      LIMIT 1`,
    [mobile]);
  return row || null;
}

/*
 * Reconciliation lookup: tbl_user.mobile_no.
 *
 * tbl_easyfixer.efr_no and tbl_user.mobile_no DIVERGE in production — e.g. a
 * technician whose tbl_user row carries one number while their easyfixer row
 * carries another. Authenticating on efr_no alone made that technician
 * unreachable by their tbl_user number, so logging in with it created a stub
 * alongside their real (often fully verified) record. Scoped to role 19 so a
 * non-technician tbl_user row sharing a number can never resolve to somebody
 * else's easyfixer record.
 */
async function resolveByUserMobile(mobile, runner = pool) {
  const [[row]] = await runner.query(
    `SELECT e.efr_id, e.efr_name, e.efr_no, e.efr_email, e.efr_status,
            e.is_technician_verified, e.user_id
       FROM tbl_easyfixer e
       JOIN tbl_user u ON u.user_id = e.user_id
      WHERE u.mobile_no = ? AND u.user_role = ?
      ORDER BY (e.is_technician_verified = 1) DESC, (e.efr_status = 1) DESC, e.efr_id DESC
      LIMIT 1`,
    [mobile, TECH_ROLE_ID]);
  return row || null;
}

/** Identity resolution for login: own number first, then tbl_user reconciliation. */
async function findByMobile(mobile, runner = pool) {
  return (await resolveByEfrNo(mobile, runner))
      || (await resolveByUserMobile(mobile, runner));
}

/*
 * Token → technician. Also NOT filtered on efr_status: a deactivated technician
 * must stay able to authenticate, reach /mobile/registration/status and see why
 * they're deactivated (plus the support contact). Filtering here rejected their
 * token on EVERY request with "technician not found or inactive", which is what
 * made deactivation indistinguishable from a broken session. Work remains
 * blocked downstream — see the note on findByMobile.
 */
async function findById(id) {
  const [[row]] = await pool.query(
    `SELECT efr_id, efr_name, efr_no, efr_email, efr_cityId, efr_service_category,
            efr_status, is_technician_verified
       FROM tbl_easyfixer WHERE efr_id = ? LIMIT 1`, [id]);
  return row || null;
}

// Technician role_id in tbl_role (see CLAUDE.md role model — role 19 "Technician").
const TECH_ROLE_ID = 19;

/*
 * Self-onboarding for an unknown mobile.
 *
 * Creates the legacy-parity stub for a technician who has never existed in the
 * system, so an unknown number can still receive a login OTP and walk the
 * onboarding stepper (the mobile-registration gate derives `personal_pending`
 * from a fresh stub — is_personal_detail_filled = 0). Two rows, one TXN:
 *
 *   tbl_user      — role 19 (Technician), is_personal_detail_filled = 0,
 *                   user_status = 0 (un-vetted lead — matches the legacy
 *                   createUser default and keeps the ghost out of active-user
 *                   queries). FK target that mobile-registration.service.js
 *                   LEFT JOINs for the gate.
 *   tbl_easyfixer — efr_no = mobile, new_easy_fixer = 1, efr_status = 1,
 *                   insert/update_date = NOW(), user_id FK → the new tbl_user.
 *                   is_technician_verified + the *_verified_by_crm flags are
 *                   left NULL (un-vetted lead — CRM stamps them later).
 *
 * Concurrency: two simultaneous login-otp hits for the same new number would
 * race to create the stub. efr_no is NOT DB-unique in production (dup active
 * mobiles exist — see SCHEMA.md), so the real guard is the same MySQL
 * named-lock pattern easyfixer.service.create() uses: serialise per-mobile,
 * then re-check findByMobile INSIDE the lock and return the existing row if a
 * concurrent request already created it. The ON DUPLICATE KEY UPDATE on the
 * INSERT is defensive only — inert today, but keeps this race-safe (no 500)
 * if a unique index is ever added on efr_no per the SCHEMA.md backfill note.
 * Returns the new (or concurrently-created) tech row in findByMobile's shape.
 */
async function createStubTechnician(mobile) {
  logger.info('Self-onboard stub technician for unknown mobile');
  const conn = await pool.getConnection();
  // GET_LOCK / RELEASE_LOCK are connection-scoped — both must run on the SAME
  // pinned connection (never via pool.query). Mirrors easyfixer.service.create().
  const lockName = `tech_stub_create_${mobile}`; // < 64 chars, mobile is 10 digits
  try {
    const [[lock]] = await conn.query('SELECT GET_LOCK(?, 5) AS got', [lockName]);
    if (!lock || lock.got !== 1) {
      logger.warn('Could not acquire onboarding lock for stub technician create');
      const err = new Error('could not acquire onboarding lock for this mobile number, please retry');
      err.status = 409;
      throw err;
    }

    /*
     * Re-check under the lock, using the SAME status-blind resolver as login.
     *
     * This is the guard against re-creating over an existing technician. The
     * previous re-check reused the `efr_status = 1` predicate, so it only saw
     * ACTIVE rows — a deactivated or rejected technician was invisible to it and
     * a duplicate got created anyway. Running the full resolver (efr_no, then
     * tbl_user.mobile_no) means we create ONLY when the number is genuinely
     * unknown to the platform, in any table, in any status. A verified
     * technician can therefore never be shadowed by a stub.
     */
    const existing = await findByMobile(mobile, conn);
    if (existing) {
      logger.info('Existing technician found under lock — not creating · efr_id=' + existing.efr_id);
      return existing;
    }

    await conn.beginTransaction();
    try {
      // Columns mirror user.service.create()'s canonical INSERT. login_status is
      // intentionally omitted (not set by the canonical CRM insert either — let
      // the DB default apply). user_status = 0: an un-vetted lead, matching the
      // legacy createUser default and keeping the ghost out of active-user
      // queries (e.g. client-verticals' "user_status <> 0" SPOC lookup).
      const [userRes] = await conn.query(
        `INSERT INTO tbl_user (mobile_no, user_role, is_personal_detail_filled, user_status, insert_date)
         VALUES (?, ?, 0, 0, NOW())`,
        [mobile, TECH_ROLE_ID]);
      const userId = userRes.insertId;

      // efr_no is NOT DB-unique today (dup active mobiles exist — see SCHEMA.md
      // + the lock comment above), so this ON DUPLICATE KEY clause is inert
      // defense-in-depth; the GET_LOCK is the real race guard. It becomes active
      // automatically if a UNIQUE index is ever added on efr_no.
      await conn.query(
        `INSERT INTO tbl_easyfixer (efr_no, new_easy_fixer, efr_status, user_id, insert_date, update_date)
         VALUES (?, 1, 1, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE efr_id = efr_id`,
        [mobile, userId]);

      await conn.commit();
      logger.info('Stub technician created · efr_id=' + (userId ? '(user_id=' + userId + ')' : '?'));
    } catch (e) {
      logger.error('Stub technician create failed · ' + e.message);
      await conn.rollback();
      throw e;
    }

    // Re-fetch on the pinned connection so the new (or concurrently-created)
    // row is returned in findByMobile's shape regardless of which insert won.
    return await findByMobile(mobile, conn);
  } finally {
    try { await conn.query('SELECT RELEASE_LOCK(?)', [lockName]); } catch (_) { /* connection teardown releases it anyway */ }
    conn.release();
  }
}

async function createLoginOtp(mobile) {
  logger.info('Create technician login OTP');
  /*
   * NOTHING IS CREATED HERE. This endpoint is public and unauthenticated, so
   * self-onboarding at send-OTP time meant that merely typing a 10-digit number
   * and tapping "Send OTP" permanently wrote a tbl_user + tbl_easyfixer row —
   * an unauthenticated write, and an enumeration/pollution vector. Onboarding
   * moved to verifyLoginOtp, which runs only AFTER the caller proves they
   * control the number.
   *
   * An unknown number still gets an OTP (that's how a genuinely new technician
   * onboards); `tech` is simply null and the OTP row carries a NULL user_email,
   * which verifyLoginOtp already tolerates — it matches on mobile alone.
   */
  const tech = await findByMobile(mobile);
  if (!tech) {
    logger.info('Unknown mobile — issuing OTP without creating any row (onboarding happens on verify)');
  }
  // Tech logins are always mobile-based, so resolveLoginOtp will return
  // the last 4 digits of the mobile in QA mode (env QA_DETERMINISTIC_OTP=true).
  // In prod the env var is unset → real random OTP. Same gate as auth-service.
  const otp = resolveLoginOtp(mobile);
  const now = new Date();
  const expires = otpExpiryDate(now);
  // Single-row-per-(mobile, otp_type) upsert keyed on the mobile number — the
  // real login identity for technicians. efr_email is written informationally
  // (and may be NULL). Keying the upsert on mobile (not email) keeps exactly one
  // live OTP row per technician and matches verifyLoginOtp's lookup, so techs
  // with no efr_email on file can still receive and verify an OTP.
  const [[existing]] = await pool.query(
    `SELECT id FROM otp_details
      WHERE user_mobile_no = ? AND otp_type = 'Mobile App Otp'
      ORDER BY id DESC
      LIMIT 1`,
    [mobile]
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
       VALUES (?, 'Mobile App Otp', ?, ?, ?, ?, 0, 1)`,
      [otp, tech ? tech.efr_email : null, mobile, now, expires]
    );
  }
  if (process.env.NODE_ENV !== 'production') {
    logger.event('🔑', 'cyan',
      `OTP for ${mobile}: ${otp}  (${tech ? 'technician efr_id=' + tech.efr_id : 'NEW number — no row yet'}, valid 5 min) — dev only`);
  }

  // Technicians always log in with a mobile number, so the default branch
  // (WhatsApp first, SMS fallback) applies — email is only used if they have
  // one on file and prefer email templates (rare).
  const { deliverOtp } = require('./otp-delivery.service');
  await deliverOtp({
    identifier: mobile,
    email: tech ? tech.efr_email : null,
    mobile,
    name: tech ? tech.efr_name : null,
    otp,
    contextLabel: 'technician',
  });

  // `found` stays TRUE for an unknown number: it reports "an OTP was delivered",
  // which the route surfaces as `delivered`. It never meant "this number is
  // already registered", and the app relies on it to advance to the OTP screen.
  logger.info('Technician login OTP issued · ' + (tech ? 'efr_id=' + tech.efr_id : 'new number'));
  return { found: true, expiresAt: expires };
}

/*
 * Verify, THEN onboard.
 *
 * Order is deliberate and is the whole point of the change: the OTP is checked
 * against the mobile alone (it never needed a technician row — the lookup below
 * keys on user_mobile_no), and only once the caller has PROVEN control of the
 * number do we resolve-or-create their identity. That is what stops an
 * unauthenticated `/auth/login-otp` hit from writing rows.
 *
 * There is no USER_NOT_FOUND path any more. An unknown-but-verified number is a
 * legitimate first-time technician, so it onboards here instead of being
 * rejected.
 */
async function verifyLoginOtp(mobile, otp) {
  logger.info('Verify technician login OTP');
  // Match on (mobile, otp_type) ALONE. The mobile number is the real login
  // identity for technicians; user_email is stored purely informationally
  // (and is NULL for techs with no efr_email on file). Including user_email in
  // this predicate was a correctness bug: when efr_email is NULL the createLoginOtp
  // INSERT writes user_email = NULL, and `WHERE user_email = NULL` can never
  // match (SQL NULL semantics) → such technicians could never verify. Dropping
  // the email predicate fixes that without changing OTP generation.
  const [[row]] = await pool.query(
    `SELECT id, otp, valid_up_to, is_expired FROM otp_details
      WHERE user_mobile_no = ? AND otp_type = 'Mobile App Otp'
      ORDER BY id DESC
      LIMIT 1`,
    [mobile]);
  if (!row) {
    logger.warn('OTP verify failed · reason=NO_OTP_ISSUED');
    return { ok: false, reason: 'NO_OTP_ISSUED' };
  }
  if (row.is_expired || new Date(row.valid_up_to).getTime() < Date.now()) {
    await pool.query('UPDATE otp_details SET is_expired = 1 WHERE id = ?', [row.id]);
    logger.warn('OTP verify failed · reason=OTP_EXPIRED');
    return { ok: false, reason: 'OTP_EXPIRED' };
  }
  if (Number(row.otp) !== Number(otp)) {
    logger.warn('OTP verify failed · reason=OTP_MISMATCH');
    return { ok: false, reason: 'OTP_MISMATCH' };
  }

  /*
   * OTP proven. NOW resolve identity — creating one only if this number is
   * genuinely unknown across tbl_easyfixer (any status) and tbl_user.
   *
   * The OTP is consumed AFTER this, not before: if onboarding hits a transient
   * error the technician can retry with the same code instead of being told to
   * request a new one. The replay window that opens is bounded by the per-mobile
   * GET_LOCK inside createStubTechnician, so two racing verifies still produce
   * exactly one row (both then receive a token for the same efr_id).
   */
  let tech = await findByMobile(mobile);
  if (!tech) {
    tech = await createStubTechnician(mobile);
    if (!tech) {
      logger.warn('OTP verified but no technician could be resolved or created');
      return { ok: false, reason: 'ONBOARDING_FAILED' };
    }
    logger.info('Onboarded new technician after OTP verification · efr_id=' + tech.efr_id);
  }

  await pool.query('UPDATE otp_details SET is_expired = 1 WHERE id = ?', [row.id]);
  const token = jwt.sign(
    { sub: `efr:${tech.efr_id}`, name: tech.efr_name, mobile: tech.efr_no },
    process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRY || '30d' });
  logger.info('Technician OTP verified · token issued · efr_id=' + tech.efr_id
    + ' · active=' + (Number(tech.efr_status) === 1));
  return { ok: true, token, tech };
}

module.exports = { findByMobile, findById, createStubTechnician, createLoginOtp, verifyLoginOtp };
