const { pool } = require('../db');
const logger = require('../logger');
const { resolveLoginOtp, otpExpiryDate, OTP_RESEND_SECONDS } = require('../utils/otp');
const jwt = require('jsonwebtoken');
const easyfixerLifecycle = require('./easyfixer-lifecycle.service');
// Overdue training restricts app capabilities — see findById.
const lms = require('./lms.service');
const { withMysqlNamedLock } = require('./mysql-named-lock.service');
const { istIsPast } = require('../utils/ist-calendar');
const {
  TECH_ROLE_ID,
  createCanonicalTechnicianUser,
} = require('./technician-user.service');

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
  const lifecycleProjection = await easyfixerLifecycle.readProjection('tbl_easyfixer');
  const [[row]] = await pool.query(
    `SELECT efr_id, efr_name, efr_no, efr_email, efr_cityId, efr_service_category,
            efr_status, is_technician_verified, efr_manager_id, user_id,
            insert_date, update_date,
            ${lifecycleProjection}
       FROM tbl_easyfixer
      WHERE efr_id = ? AND NOT (efr_status <=> 3)
      LIMIT 1`, [id]);
  if (!row) return null;
  // readProjection() supplies raw snake_case columns for lifecycle derivation.
  // GET /mobile/me serializes req.tech directly, so overwrite those aliases as
  // well as redacting the nested snapshot; otherwise BLACKLISTED RCA text
  // would remain available at the root of the response.
  // Single-row/technician-facing read, so it also carries the INACTIVE
  // open-job overlay: a technician deactivated while they still own open jobs
  // keeps the operational app (continue / mutate / attendance) until the last
  // one closes, and never regains `receiveNewJobs`. One bounded COUNT, and only
  // when the status is INACTIVE — every other status returns without a query.
  // Runs BEFORE the overdue-training overlay below so that restriction, which
  // withdraws the same three capabilities, still wins.
  const technicianRow = await easyfixerLifecycle.overlayOpenJobCapabilities(
    easyfixerLifecycle.forTechnician(easyfixerLifecycle.lifecycleFromRow(row)),
    row.efr_id,
  );

  /*
   * OVERDUE TRAINING RESTRICTS THE APP.
   *
   * A technician past the due date on assigned training keeps only what they
   * need to get unstuck or get paid: training itself and claiming money. New
   * work, attendance and every job mutation are withdrawn until they finish.
   *
   * Layered on top of the lifecycle capabilities rather than modelled as a
   * new lifecycle STATUS, for three reasons:
   *
   *   - it is not a state of the technician's employment, it is a temporary
   *     consequence of a deadline, and it clears itself the moment they
   *     finish — no CRM transition, no log row, no reason code;
   *   - `capabilitiesForStatus` is a pure, widely-tested function of status
   *     alone, and threading an async training lookup through it would make
   *     every caller async for a concern most of them do not have;
   *   - the capability object is ALREADY the app's contract (the middleware
   *     enforces it server-side and the app reads it to shape its UI), so
   *     restricting here restricts every route and every screen at once.
   *
   * `claimMoney` is untouched: it is unconditionally true in the lifecycle
   * model and withholding earned money over an unwatched video would be
   * indefensible. `reapply` and `editRegistration` are also left alone —
   * neither creates work.
   *
   * Fail-OPEN. If this lookup throws, the technician keeps their normal
   * capabilities. A restriction is a punishment; imposing one because a query
   * failed would be worse than briefly missing one.
   */
  let trainingOverdue = false;
  try {
    trainingOverdue = await lms.hasOverdueTraining(row.efr_id);
  } catch (e) {
    logger.warn('Overdue-training check failed · efrId=' + row.efr_id + ' · ' + e.message);
  }
  const lifecycle = trainingOverdue
    ? {
      ...technicianRow,
      trainingOverdue: true,
      capabilities: {
        ...technicianRow.capabilities,
        receiveNewJobs: false,
        continueAssignedJobs: false,
        mutateAssignedJobs: false,
        markAttendance: false,
      },
    }
    : technicianRow;

  return {
    ...row,
    lifecycle_reason_code: technicianRow.status === 'BLACKLISTED'
      ? null
      : row.lifecycle_reason_code,
    lifecycle_reason: technicianRow.status === 'BLACKLISTED'
      ? null
      : row.lifecycle_reason,
    // req.tech is also returned by GET /mobile/me. Redact BLACKLISTED RCA text
    // at this shared boundary so auth middleware still receives capabilities
    // without leaking internal CRM notes through another mobile endpoint.
    // Carries the training restriction when one applies (see above).
    lifecycle,
  };
}

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
async function createStubTechnician(mobile, pinnedRunner = null) {
  logger.info('Self-onboard stub technician for unknown mobile');
  // verifyLoginOtp already owns a named-lock connection. Reuse it when
  // supplied so a burst of new-technician verifies cannot hold one pool slot
  // each while waiting for a second slot (pool starvation). Standalone callers
  // retain the original acquire/release behaviour.
  const ownsConnection = !pinnedRunner;
  const conn = pinnedRunner || await pool.getConnection();
  // Standalone callers need the original identity-create lock. A pinned runner
  // comes only from verifyLoginOtp, which already holds the stronger per-mobile
  // OTP issue/verify lock; taking a second named lock on that same session is
  // redundant and unsafe on older MySQL semantics where GET_LOCK replaced the
  // connection's previously held lock.
  const lockName = ownsConnection ? `tech_stub_create_${mobile}` : null;
  let stubLockAcquired = false;
  try {
    if (lockName) {
      const [[lock]] = await conn.query('SELECT GET_LOCK(?, 5) AS got', [lockName]);
      stubLockAcquired = Boolean(lock && lock.got === 1);
      if (!stubLockAcquired) {
        logger.warn('Could not acquire onboarding lock for stub technician create');
        const err = new Error('could not acquire onboarding lock for this mobile number, please retry');
        err.status = 409;
        throw err;
      }
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
      const userId = await createCanonicalTechnicianUser(mobile, conn);

      // efr_no is NOT DB-unique today (dup active mobiles exist — see SCHEMA.md
      // + the lock comment above), so this ON DUPLICATE KEY clause is inert
      // defense-in-depth; the surrounding per-mobile named lock (OTP lock for
      // verify callers, stub lock for standalone callers) is the real guard. It
      // becomes active automatically if a UNIQUE index is ever added on efr_no.
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
    if (stubLockAcquired) {
      try { await conn.query('SELECT RELEASE_LOCK(?)', [lockName]); } catch (_) { /* connection teardown releases it anyway */ }
    }
    if (ownsConnection) conn.release();
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
  // otp_details is legacy MyISAM (verified 2026-08-11), so a SQL transaction
  // cannot serialize issue/resend against verify. A short DB named lock does:
  // it is shared with verifyLoginOtp below and also prevents two first-time
  // sends from inserting separate rows for the same mobile.
  const otpLockName = `tech_login_otp_${mobile}`;
  const issued = await withMysqlNamedLock(otpLockName, async (runner) => {
    const [[existing]] = await runner.query(
      `SELECT id FROM otp_details
        WHERE user_mobile_no = ? AND otp_type = 'Mobile App Otp'
        ORDER BY id DESC
        LIMIT 1`,
      [mobile]
    );
    if (existing) {
      await runner.query(
        `UPDATE otp_details
            SET otp = ?, generated_on = ?, valid_up_to = ?, is_expired = 0,
                count = count + 1
          WHERE id = ?`,
        [otp, now, expires, existing.id]
      );
    } else {
      await runner.query(
        `INSERT INTO otp_details (otp, otp_type, user_email, user_mobile_no, generated_on, valid_up_to, is_expired, count)
         VALUES (?, 'Mobile App Otp', ?, ?, ?, ?, 0, 1)`,
        [otp, tech ? tech.efr_email : null, mobile, now, expires]
      );
    }
  }, pool, { timeoutSeconds: 5 });
  if (!issued.acquired) {
    const err = new Error('OTP request already in progress, please retry');
    err.status = 409;
    throw err;
  }
  if (process.env.NODE_ENV !== 'production') {
    logger.event('🔑', 'cyan',
      `OTP for ${mobile}: ${otp}  (${tech ? 'technician efr_id=' + tech.efr_id : 'NEW number — no row yet'}, valid 5 min) — dev only`);
  }

  // Technicians always log in with a mobile number, so the default branch
  // (WhatsApp first, SMS fallback) applies — email is only used if they have
  // one on file and prefer email templates (rare).
  const { deliverOtp } = require('./otp-delivery.service');
  let delivery;
  try {
    delivery = await deliverOtp({
      identifier: mobile,
      email: tech ? tech.efr_email : null,
      mobile,
      name: tech ? tech.efr_name : null,
      otp,
      contextLabel: 'technician',
    });
  } catch (deliveryError) {
    logger.error({ err: deliveryError.message }, 'Technician login OTP delivery crashed');
    const err = new Error('OTP could not be delivered, please retry');
    err.status = 503;
    err.code = 'OTP_DELIVERY_FAILED';
    throw err;
  }

  // NOTIFICATIONS_DISABLE is an intentional QA/dev suppression: the code is
  // available in non-production logs, so those hosts must still advance. Every
  // real host, however, may claim success only when at least one provider did.
  const delivered = Boolean(delivery?.finalDelivered || delivery?.disabled);
  if (!delivered) {
    const attemptedChannels = Array.isArray(delivery?.attempts)
      ? delivery.attempts.map((attempt) => attempt.channel).filter(Boolean)
      : [];
    logger.warn(
      { attemptedChannels },
      'Technician login OTP rejected because every delivery channel failed',
    );
    const err = new Error('OTP could not be delivered, please retry');
    err.status = 503;
    err.code = 'OTP_DELIVERY_FAILED';
    throw err;
  }

  // `found` stays TRUE for an unknown number: it reports "an OTP was delivered",
  // which the route surfaces as `delivered`. It never meant "this number is
  // already registered", and the app relies on it to advance to the OTP screen.
  logger.info('Technician login OTP issued · ' + (tech ? 'efr_id=' + tech.efr_id : 'new number'));
  return {
    found: true,
    delivered: true,
    expiresAt: expires,
    resendInSeconds: OTP_RESEND_SECONDS,
  };
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
async function verifyLoginOtp(mobile, otp, { onVerifiedTech } = {}) {
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
  // istIsPast, not `new Date(str)` — see utils/ist-calendar.js. A bare parse
  // of this IST wall-clock column gave every technician LOGIN otp 5h30m.
  if (row.is_expired || istIsPast(row.valid_up_to)) {
    // Conditional expiry cannot invalidate a freshly re-issued code that won
    // the issue/verify named lock after this stale read.
    await pool.query(
      `UPDATE otp_details SET is_expired = 1
        WHERE id = ? AND otp = ? AND is_expired = 0 AND valid_up_to < NOW()`,
      [row.id, row.otp],
    );
    logger.warn('OTP verify failed · reason=OTP_EXPIRED');
    return { ok: false, reason: 'OTP_EXPIRED' };
  }
  if (Number(row.otp) !== Number(otp)) {
    logger.warn('OTP verify failed · reason=OTP_MISMATCH');
    return { ok: false, reason: 'OTP_MISMATCH' };
  }

  /*
   * otp_details is MyISAM, so SELECT ... FOR UPDATE cannot protect it. The same
   * per-mobile DB named lock used by issue/resend serializes all replicas here.
   * Re-read under the lock, persist optional profile data, then atomically
   * consume with an is_expired=0 predicate. Exactly one racing verify can
   * observe+consume the code and receive a token.
   */
  const locked = await withMysqlNamedLock(`tech_login_otp_${mobile}`, async (runner) => {
    const [[current]] = await runner.query(
      `SELECT id, otp, valid_up_to, is_expired FROM otp_details
        WHERE id = ? AND user_mobile_no = ? AND otp_type = 'Mobile App Otp'
        LIMIT 1`,
      [row.id, mobile],
    );
    if (!current) return { ok: false, reason: 'NO_OTP_ISSUED' };
    if (current.is_expired || istIsPast(current.valid_up_to)) {
      return { ok: false, reason: 'OTP_EXPIRED' };
    }
    if (Number(current.otp) !== Number(otp)) {
      return { ok: false, reason: 'OTP_MISMATCH' };
    }

    // OTP proven. NOW resolve identity — creating only when the mobile is
    // genuinely unknown across both legacy identity tables.
    let tech = await findByMobile(mobile, runner);
    if (!tech) {
      tech = await createStubTechnician(mobile, runner);
      if (!tech) return { ok: false, reason: 'ONBOARDING_FAILED' };
      logger.info('Onboarded new technician after OTP verification · efr_id=' + tech.efr_id);
    }

    // Profile writes happen before consumption so a validation/DB failure
    // leaves the OTP reusable. The hook receives this pinned connection; its
    // InnoDB transaction commits while the named lock is still held.
    if (typeof onVerifiedTech === 'function') {
      await onVerifiedTech(tech, { runner });
    }

    const [consumed] = await runner.query(
      `UPDATE otp_details SET is_expired = 1
        WHERE id = ?
          AND user_mobile_no = ?
          AND otp_type = 'Mobile App Otp'
          AND otp = ?
          AND is_expired = 0
          AND valid_up_to >= NOW()`,
      [current.id, mobile, current.otp],
    );
    if (Number(consumed.affectedRows) !== 1) {
      return { ok: false, reason: 'OTP_ALREADY_USED' };
    }
    return { ok: true, tech };
  }, pool, { timeoutSeconds: 5 });

  if (!locked.acquired) {
    logger.warn('OTP verify failed · reason=OTP_VERIFICATION_BUSY');
    return { ok: false, reason: 'OTP_VERIFICATION_BUSY' };
  }
  if (!locked.result.ok) {
    logger.warn('OTP verify failed · reason=' + locked.result.reason);
    return locked.result;
  }

  const { tech } = locked.result;
  const token = jwt.sign(
    { sub: `efr:${tech.efr_id}`, name: tech.efr_name, mobile: tech.efr_no },
    process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRY || '30d' });
  logger.info('Technician OTP verified · token issued · efr_id=' + tech.efr_id
    + ' · active=' + (Number(tech.efr_status) === 1));
  return { ok: true, token, tech };
}

module.exports = { findByMobile, findById, createStubTechnician, createLoginOtp, verifyLoginOtp };
