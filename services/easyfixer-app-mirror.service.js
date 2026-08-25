/*
 * easyfixer-app-mirror — render the technician app inside the CRM by
 * REPLAYING the technician's own /api/mobile/* GET requests in-process.
 *
 * ─── WHY A REPLAY AND NOT A SECOND SET OF QUERIES ─────────────────────────
 *
 * Support needs to see what the technician sees. Rebuilding those screens
 * from admin-side queries produces a second implementation that drifts: the
 * operator is then looking at something the technician never saw, which is
 * worse than not looking at all. Calling the real mobile handlers means the
 * mirror is correct by construction — including every lifecycle capability,
 * training restriction and ownership filter those handlers apply.
 *
 * ─── THE THREE SECURITY PROPERTIES ────────────────────────────────────────
 *
 * 1. THE MINTED TOKEN NEVER LEAVES THE PROCESS.
 *    It lives inside the replay closure, is written to exactly one place
 *    (the synthetic request's Authorization header), and is never returned,
 *    never logged, never attached to an error. This is the single line
 *    between "a safe read-only mirror" and "a CRM endpoint that hands out
 *    impersonation credentials for any technician". Every log line below
 *    carries the efrId and the path and nothing else, deliberately. TTL is
 *    30 seconds so even a hypothetical leak has almost no window.
 *
 * 2. middleware/tech-auth.js RUNS UNMODIFIED.
 *    There is no bypass flag, no `req.__mirror` short-circuit, no second
 *    code path in the auth middleware. The replay authenticates the same
 *    way a phone does — a real Bearer token verified against JWT_SECRET —
 *    so the mirror cannot become a hole in technician auth without also
 *    breaking technician auth for everyone.
 *
 * 3. GET ONLY, AND ONLY OFF THE ALLOWLIST BELOW.
 *    /api/mobile is not a read-only surface. POST /mobile/device runs a
 *    single-active-session sweep that logs the technician's real phone out
 *    (routes/mobile/index.js) — a replayed write there would take a working
 *    technician offline mid-job. The caller enforces the method; this module
 *    enforces the path, and the two together mean an unlisted or non-GET
 *    request is refused before a token is ever minted.
 */

const jwt = require('jsonwebtoken');
const logger = require('../logger');

// Short enough that the token is expired before a replay could plausibly be
// captured and reused. Nothing legitimate outlives one in-process call.
const MIRROR_TOKEN_TTL = '30s';

/*
 * GET allowlist — anchored patterns, not prefixes.
 *
 * Prefixes were the obvious choice and are wrong: `/jobs` as a prefix would
 * silently admit `GET /jobs/:id/share-link`, which MINTS a public share link
 * and records the technician as its sharer. An anchored list fails closed —
 * a new mobile screen is invisible to the mirror until someone adds it here,
 * which is the review step this list exists to force.
 *
 * Deliberately ABSENT (do not add without a fresh decision):
 *   /bank-details, /upi-details  — payout instructions
 *   /kyc/*, /email/*             — identity verification flows with vendor
 *                                  calls and state transitions behind GETs
 *   /uploads/*                   — S3 upload primitives
 *   /jobs/:id/share-link         — mints a credential-ish public link
 */
const ALLOWED_GET_PATHS = [
  /^\/me$/,
  /^\/reapplication-summary$/,
  /*
   * The home screen — and the most important entry here.
   *
   * GET /mobile/dashboard is itself an aggregate: services/mobile-dashboard
   * .service.js fans out to jobs, notices, performance, wallet balance and
   * today's attendance in one call. It is the first thing the app requests
   * after boot, so without it the mirror opens on an empty home and an
   * operator concludes the technician's app is broken.
   */
  /^\/dashboard$/,
  // Orders
  /^\/jobs$/,
  /^\/jobs\/(offered|rejected|search)$/,
  /^\/jobs\/\d+$/,
  /^\/jobs\/\d+\/(rate-card|questionnaire|work-progress)$/,
  // Profile + registration
  /^\/profile$/,
  /^\/profile\/(details|percentage|professional|personal|contact-info|identity-details)$/,
  /^\/registration\/(status|remaining)$/,
  /^\/serviceable-pincodes$/,
  // Attendance, earnings, ratings, ID card
  /^\/attendance$/,
  /^\/earnings$/,
  /^\/ratings$/,
  /^\/icard$/,
  // Training
  /^\/training-status$/,
  /^\/training-videos$/,
  /^\/training-videos\/percentage$/,
  // Performance / history / earnings tabs
  /^\/phe\/(overview|in-qa|missed|withdrawals)$/,
  /^\/phe\/months\/[\w-]+\/jobs$/,
  /^\/phe\/jobs\/\d+$/,
  /^\/performance\/(weekly|grade-advice|offer-stats)$/,
  // Rewards
  /^\/rewards\/(summary|ledger|address|claims|referral)$/,
  /^\/rewards\/referral\/attribution$/,
  // Team
  /^\/team$/,
  /^\/team\/(profile|members)$/,
  /^\/team\/members\/\d+(\/jobs)?$/,
  // Notice board + static lookups
  /^\/notices\/active$/,
  /^\/deepskill\/hierarchy\/\d+$/,
  /^\/experience$/,
  /^\/lookups\/pincode\/\d{6}$/,
  /^\/app-version$/,
];

/**
 * @param {string} subPath router-relative mobile path, e.g. '/jobs/12'. RAW
 *   (still percent-encoded) — it is handed to the mobile router verbatim, so
 *   decoding here and re-encoding there would be one decode too many.
 */
function isAllowedMirrorPath(subPath) {
  if (typeof subPath !== 'string' || !subPath.startsWith('/')) return false;
  // Express does not normalise `..`, so this is belt-and-braces rather than
  // the only guard — but it removes a whole class of "does path-to-regexp
  // collapse this?" reasoning from the review of the list above.
  if (subPath.includes('..')) return false;
  return ALLOWED_GET_PATHS.some((re) => re.test(subPath));
}

/**
 * Replay one technician GET against the real mobile router.
 *
 * Returns `{ status, body }` — the handler's own HTTP status and JSON body,
 * and NOTHING else. Headers the handler set are discarded on purpose: the
 * only thing that could travel out of here besides the payload is a header,
 * and the mirror has no use for one.
 */
function replayMobileGet({ efrId, subPath, search = '', query = {}, ip }) {
  return new Promise((resolve) => {
    /* ⚠ SECURITY PROPERTY 1 — this token never leaves the process.
     * Scope: this closure. Destination: one header on a synthetic request
     * object that is garbage-collected when the promise settles. It is not
     * in the resolved value, not in the log lines below, not in the error
     * path. Claim shape matches what verify-otp issues today
     * (services/tech-auth.service.js) so middleware/tech-auth.js — which is
     * NOT modified for this feature (SECURITY PROPERTY 2) — accepts it by
     * the same rule it accepts a real phone's token. */
    const token = jwt.sign(
      { sub: `efr:${efrId}` },
      process.env.JWT_SECRET,
      { expiresIn: MIRROR_TOKEN_TTL },
    );

    const url = subPath + search;
    const fakeReq = {
      method: 'GET',                       // never anything else — see the caller
      url,                                 // router-relative; what Express matches on
      originalUrl: `/api/mobile${url}`,    // what handlers/log lines print
      baseUrl: '',
      headers: { authorization: `Bearer ${token}` },
      get(name) { return this.headers[String(name).toLowerCase()]; },
      cookies: {},                         // empty: the cookie arm of tech-auth must not fire
      body: {},
      query: { ...query },                 // Express's query getter does not exist on a plain object
      params: {},
      ip,
    };

    let settled = false;
    const settle = (status, body) => {
      if (settled) return;                 // a handler that answers twice must not reject the promise
      settled = true;
      resolve({ status, body });
    };

    /* The whole res contract the mobile handlers need. utils/response.js only
     * ever touches res.json, res.status().json() and res.locals; send/end/set
     * are here for the handful of handlers and middlewares (rate-limit's
     * Retry-After) that reach for them. Headers are accepted and dropped. */
    const fakeRes = {
      locals: {},
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      set() { return this; },
      setHeader() { return this; },
      json(body) { settle(this.statusCode, body); return this; },
      send(body) { settle(this.statusCode, body); return this; },
      end() { settle(this.statusCode, null); return this; },
    };

    // Required lazily so this service can be pulled into a test (or the admin
    // router) without dragging the entire mobile tree in at load time.
    // routes/mobile/index.js exports the Router itself, which IS the handler.
    require('../routes/mobile')(fakeReq, fakeRes, (err) => {
      if (!err) return settle(404, { success: false, error: 'not found' });
      // efrId + path only. The synthetic request — and therefore the token —
      // is never passed to the logger or re-thrown to an error handler that
      // might serialise it.
      logger.warn('App mirror replay failed · efrId=' + efrId
        + ' · path=' + subPath + ' · ' + (err && err.message));
      settle(500, { success: false, error: 'mirror replay failed' });
    });
  });
}

module.exports = { isAllowedMirrorPath, replayMobileGet, MIRROR_TOKEN_TTL, ALLOWED_GET_PATHS };
