const { pool } = require('../db');
const logger = require('../logger');
const ttlCache = require('../utils/ttl-cache');
const { resolveLoginOtp, staticLoginOtpFor, otpExpiryDate } = require('../utils/otp');
const { signUserToken } = require('../utils/jwt');
const { istIsPast } = require('../utils/ist-calendar');
const otpAttempts = require('./otp-attempts.service');

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

/*
 * ─── requireAuth's principal cache (added 2026-09-08) ─────────────────────
 *
 * WHY. findUserById is the single highest-frequency query in the process:
 * middleware/auth.js runs it before ANY work on /api/admin, /api/client,
 * /api/mobile and /api/shared. On 2026-09-08 the pool (connectionLimit 30,
 * queueLimit 50 — db.js) hit "Queue limit reached" with this frame on the
 * stack. Every authed request paying a pool acquire just to re-read one
 * unchanged row is the largest per-request saving available.
 *
 * WHY utils/ttl-cache DESPITE its "never for per-user data" header. That
 * header states a rule and its reason: "a value cached for user A would be
 * served to user B". The reason only bites when the key fails to
 * discriminate. Its actual CONTRACT is narrower than its prose summary:
 *   - "the cache KEY must be derivable purely from non-user inputs (the
 *     lookup name + its query args)" — the parenthetical DEFINES the
 *     permitted material, and `auth:user:<id>` is exactly the lookup name
 *     plus findUserById's one and only query arg;
 *   - "if the result varies by CALLER, the data is personalized" —
 *     findUserById(7) returns row 7 for every caller. It varies by
 *     ARGUMENT, and the argument is in the key. Cross-user bleed is
 *     structurally impossible here, and tests/auth-user-cache.test.js pins
 *     that (two ids → two rows) as its most important assertion.
 * The clause this call site genuinely does NOT satisfy is the staleness
 * one: "acceptable ONLY for data ... tolerant of a few minutes of
 * staleness (static master lists)". An auth principal is not. That is
 * answered below by the TTL — seconds, not the "few minutes" the header
 * contemplates — not by pretending the clause doesn't apply.
 * (The header of utils/ttl-cache.js deserves a sentence recording this
 * carve-out; that file is outside this change's scope.)
 *
 * WHAT A STALE ROW ACTUALLY PERMITS, column by column. Every one of these
 * is read straight off req.user by the gate stack, so a stale value is a
 * stale authorization decision, not a stale label:
 *   user_status   — the SELECT filters `user_status = 1`, so a cached hit
 *                   IS the authentication decision. Stale ⇒ a DEACTIVATED
 *                   or admin-DELETED (tombstoned, status 3) user keeps a
 *                   working session for up to the TTL. The worst of the
 *                   six, and the reason the TTL is seconds.
 *   user_type_id  — filtered `= 5` (internal). Stale ⇒ a user demoted out
 *                   of internal staff keeps CRM access.
 *   user_role     — feeds ROLE_ID_TO_GROUP (role.service) and every
 *                   role()/roleByName() guard. Stale ⇒ a demoted user
 *                   keeps the old group; a user moved out of Finance can
 *                   still reach finance-only reports.
 *   manage_clients / manage_cities / manage_states / manage_verticals
 *                 — the req.scope geo/client allowlists (lib/scope.js).
 *                   Stale ⇒ a re-scoped user still reads jobs, clients and
 *                   reports for territory they were just removed from.
 *   city_id, user_name, official_email, mobile_no, alternate_no, user_code
 *                 — display/identity only; a stale value here misleads,
 *                   it does not permit anything.
 *
 * TTL = 15s, from ONE knob shared with role.service's per-user permissions
 * cache (reconciled 2026-09-08 — see that file for the matching note).
 *
 *   - THE TTL IS A BACKSTOP, NOT THE STALENESS BOUND. Production runs a
 *     SINGLE backend process: deploy/docker-compose.prod-backend.yml sets
 *     container_name (which blocks `compose --scale`), nothing sets
 *     deploy.replicas, and ecosystem.config.js is instances:1 /
 *     exec_mode:'fork'. So in-process invalidation is COMPLETE — every
 *     writer that calls invalidateUserCaches() is visible on the very next
 *     request, with no window at all. What the TTL actually bounds is the
 *     UNINSTRUMENTED write: a direct SQL edit, or a writer nobody wired.
 *
 *     ⚠ An earlier version of this note reasoned from "ACA runs several
 *     replicas". That is the wrong deployment for this service, and it is
 *     the premise the whole number rests on — so if this ever moves to
 *     cluster mode or a second container, re-derive the TTL rather than
 *     keeping it: the cross-process world is the one where the TTL becomes
 *     the ONLY bound.
 *
 *   - WHY BOTH CACHES SHARE THE NUMBER. A request passes through both, so
 *     the staleness anyone experiences is the MAX of the two. A 15s cache
 *     beside a 60s one is a 60s system, and the 15s is decoration. The
 *     permissions cache was 60s until this was reconciled; lowering it is
 *     what actually improved the perceived propagation delay, not this one.
 *
 *   - WHY NOT LONGER. ttl-cache joins concurrent callers into ONE query
 *     regardless of TTL, which already collapses the FE's parallel widget
 *     loads; the TTL only has to span an operator's sequential
 *     click-through burst (measured at 3-8 requests per click). 15s → 60s
 *     buys a few points of hit rate for 4x the exposure window on a write
 *     nobody instrumented.
 *
 * Set AUTH_USER_CACHE_TTL_MS=0 to disable BOTH caches — one knob that tunes
 * and kills, rather than a second boolean for a value already able to
 * express "off". Default ON: this ships against a live incident, and a
 * cache that needs a var set before it does anything fails by re-running
 * the outage. Garbage or empty values parse to 0 and therefore disable —
 * the fail-safe direction. Guarded by tests/auth-cache-reconciliation.test.js,
 * which asserts the 0 actually reaches both.
 */
const AUTH_CACHE_TTL_MS = Number(process.env.AUTH_USER_CACHE_TTL_MS ?? 15_000);
const AUTH_CACHE_PREFIX = 'auth:user:';
/*
 * Sentinel for "no such active internal user". ttl-cache never stores a
 * rejection, so throwing this is how a NULL stays uncached — a user created
 * or reactivated one second ago must not be locked out for the TTL by a
 * negative we cached a moment before. The tension with "a miss must not be
 * a free pass to hammer the DB" is resolved by ttl-cache's in-flight join
 * rather than by caching the negative: a burst of 200 concurrent requests
 * carrying a dead token still issues exactly ONE query, and sequential
 * misses cost precisely what they cost today, so nothing regresses. The
 * request 401s immediately afterwards either way.
 * One shared instance: identity-compared, never surfaced, no per-miss stack.
 */
const USER_MISS = new Error('user not found');

async function _loadUserById(userId) {
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

async function findUserById(userId) {
  if (!(AUTH_CACHE_TTL_MS > 0)) return _loadUserById(userId);
  try {
    return await ttlCache.cached(AUTH_CACHE_PREFIX + Number(userId), AUTH_CACHE_TTL_MS, async () => {
      const user = await _loadUserById(userId);
      if (!user) throw USER_MISS;
      return user;
    });
  } catch (err) {
    if (err === USER_MISS) return null;
    throw err;
  }
}

/*
 * Drop a user's cached auth principal. Call from EVERY writer that changes
 * user_status, user_type_id, user_role or a manage_* scope column on an
 * internal (user_type_id = 5) row — see services/user.service.js for the
 * covered ones. Without it the TTL still self-corrects; this just shortens
 * that to zero on the replica that served the write (and only that one —
 * see the multi-replica note above, which is why this is a shortcut, never
 * the safety mechanism).
 *
 * No argument clears every cached principal — via clearPrefix, NEVER
 * ttlCache.clear(), which takes no key and would wipe the whole shared
 * store (lookups, deep-skill image probes, the Plivo balance) along with it.
 */
/*
 * Bust EVERY per-user cache on the auth path, in one call.
 *
 * There are two of them — the user row here and the effective-permissions map
 * in role.service — and a writer that remembers one and forgets the other
 * leaves the system half-updated in a way nothing detects. That already
 * happened: the tombstone-delete path invalidated the user row and left the
 * deleted user's permissions cached. Callers should use THIS, not either
 * single-cache function, so the set can grow without auditing every writer.
 *
 * Lazily required: auth.service and role.service do not import each other at
 * module scope today, and a top-level require here would create the cycle.
 */
function invalidateUserCaches(userId) {
  invalidateUserCache(userId);
  try {
    require('./role.service').invalidatePermissionsCache(userId);
  } catch (err) {
    // Never let a cache eviction fail the write that triggered it — the DB
    // change has already committed, and the TTL is the backstop.
    logger.warn('Permissions cache invalidation failed · userId=' + userId + ' · ' + err.message);
  }
}

function invalidateUserCache(userId) {
  if (userId == null) ttlCache.clearPrefix(AUTH_CACHE_PREFIX);
  else ttlCache.clear(AUTH_CACHE_PREFIX + Number(userId));
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

  /*
   * Single-row-per-(email, mobile, otp_type) model, matched with <=> and NOT =.
   *
   * `=` LOCKED OUT EVERY USER WITH NO MOBILE NUMBER (2026-09-10). tbl_user
   * .mobile_no is nullable and 7 active QA users / at least one production user
   * have it NULL. Binding NULL to `user_mobile_no = ?` renders the predicate
   * `user_mobile_no = NULL`, which is NULL — never true — so:
   *   • this lookup missed the row it had itself just written, and every
   *     login-otp request INSERTed another one (the tell: `count` stayed 1 on
   *     every row, because the UPDATE branch below never ran, and `created_on`
   *     stayed NULL because only the INSERT omits it);
   *   • verifyLoginOtp's identical lookup missed too, so the user was told
   *     "no active OTP — request one first" while staring at a valid, unexpired
   *     code. They could not log in at all, and never would have.
   *
   * <=> is null-safe equality: NULL <=> NULL is true, NULL <=> '9810…' is
   * false. So it fixes the NULL case while PRESERVING the original intent —
   * a legacy partial row (email set, mobile NULL) still cannot match a user
   * who has a mobile, and vice versa. The protection was never in the `=`.
   *
   * Still write BOTH email and mobile from the user record on every upsert, so
   * the tuple stays meaningful.
   */
  const [[existing]] = await pool.query(
    `SELECT id FROM otp_details
      WHERE user_email <=> ? AND user_mobile_no <=> ? AND otp_type = 'crm_login'
      ORDER BY generated_on DESC, id DESC
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
    /* A NEW code gets a FRESH guess budget — see services/otp-attempts.service.js.
     * Separate call rather than `failed_attempts = 0` in the UPDATE above: that
     * column does not exist until the migration runs, and naming it here would
     * 500 every OTP request in the meantime. Without the reset the cap counts per
     * ROW rather than per CODE, and "Resend OTP" stops being able to help. */
    await otpAttempts.clearAttempts(existing.id);
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

  /*
   * The same tuple createLoginOtp wrote, matched the same null-safe way — see
   * the comment there for why `=` locked out every user with a NULL mobile.
   *
   * ORDER BY is not decoration. While the bug was live, each request appended
   * another row, so affected users now hold a PILE of crm_login rows. LIMIT 1
   * with no ordering lets MySQL return any of them: fixing only the match
   * would have swapped "no active OTP" for an equally unloggable
   * OTP_MISMATCH against a stale code. Newest wins, deterministically, and
   * that stays correct once the backlog is cleaned up.
   */
  const [[row]] = await pool.query(
    `SELECT id, otp, valid_up_to, is_expired
       FROM otp_details
      WHERE user_email <=> ? AND user_mobile_no <=> ? AND otp_type = 'crm_login'
      ORDER BY generated_on DESC, id DESC
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
  /*
   * THE GUESS CAP. utils/otp.js has declared OTP_MAX_ATTEMPTS = 5 since it was
   * written and nothing read it; a 4-digit code with a 5-minute window and no
   * cap is ~10,000 guesses. Checked BEFORE the comparison so an exhausted code
   * cannot be brute-forced further, and counted only on a genuine mismatch.
   * Inactive (and silent) until the failed_attempts migration runs.
   */
  if (await otpAttempts.isLockedOut(row.id)) {
    logger.warn('Login OTP refused · reason=OTP_ATTEMPTS_EXCEEDED · user_id=' + user.user_id);
    return { ok: false, reason: 'OTP_ATTEMPTS_EXCEEDED' };
  }
  if (Number(row.otp) !== Number(otp)) {
    await otpAttempts.recordFailedAttempt(row.id);
    return { ok: false, reason: 'OTP_MISMATCH' };
  }

  // Consume the OTP so it can't be reused.
  await pool.query('UPDATE otp_details SET is_expired = 1 WHERE id = ?', [row.id]);

  const token = signUserToken(user);
  logger.info('Login OTP verified · token issued · user_id=' + user.user_id);
  return { ok: true, token, user };
}

module.exports = {
  findActiveUserByIdentifier,
  findUserById,
  invalidateUserCache,
  invalidateUserCaches,
  createLoginOtp,
  verifyLoginOtp,
};
