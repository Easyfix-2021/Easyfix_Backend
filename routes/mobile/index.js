const router = require('express').Router();
const Joi = require('joi');
const { OFFER_STATUS } = require('../../services/offer-status');

const validate = require('../../middleware/validate');
const logger = require('../../logger');
const requireTechAuth = require('../../middleware/tech-auth');
const { pool } = require('../../db');
const techAuth = require('../../services/tech-auth.service');
const registrationProfile = require('../../services/technician-registration-profile.service');
const jobService = require('../../services/job.service');
const addressService = require('../../services/address.service');
const jobCommentService = require('../../services/job-comment.service');
const shareService = require('../../services/job-share.service');
const voice = require('../../services/voice.service');
const easyfixerLifecycle = require('../../services/easyfixer-lifecycle.service');
const { dailyBridgeCapReached, persistBridgeCall } = require('../public/_public-call');
const { modernOk, modernError } = require('../../utils/response');
const { rateLimit } = require('../../middleware/rate-limit');
const {
  requireTechJobMutationCapability,
} = require('../../middleware/require-tech-lifecycle-capability');
const { otpFailureHttpStatus } = require('./otp-http-status');
const { upsertEasyfixerDocuments } = require('../../services/easyfixer-document.service');
const sensitiveChange = require('../../services/easyfixer-sensitive-change.service');
const profileOtp = require('../../services/easyfixer-profile-otp.service');

const mobile = Joi.string().pattern(/^[0-9]{10}$/);

// These limiters execute before Joi so abusive requests are throttled before
// route work. Never retain the raw pre-validation body as a Map key: /api/mobile
// accepts JSON bodies up to 10 MB, and unique oversized `mobile` strings would
// otherwise stay resident for the whole window. Valid mobiles get their own
// fixed-size bucket; every malformed value collapses into the caller's bounded
// IP bucket.
function boundedIpPart(req) {
  return String(req.ip ?? 'unknown').trim().slice(0, 64) || 'unknown';
}

function mobileOrIpRateKey(namespace, req) {
  const candidate = typeof req.body?.mobile === 'string'
    ? req.body.mobile.trim()
    : '';
  if (/^\d{10}$/.test(candidate)) return `${namespace}:mobile:${candidate}`;
  return `${namespace}:invalid:${boundedIpPart(req)}`;
}

// OTP issue has two independent ceilings: per mobile controls resend/provider
// spend for one account, while per IP stops attackers rotating valid numbers.
// Unknown numbers receive an OTP for self-onboarding but create no identity row
// until verification succeeds. In-memory per process; replace with a shared
// store before running multiple backend replicas (see rate-limit.js).
const loginOtpMobileRateLimit = rateLimit({
  windowMs: 10 * 60_000,
  max: 20,
  key: (req) => mobileOrIpRateKey('login-otp', req),
});
const loginOtpIpRateLimit = rateLimit({
  windowMs: 10 * 60_000,
  max: 60,
  key: (req) => `login-otp:ip:${boundedIpPart(req)}`,
});

// OTP verification is public too. Two independent generous buckets prevent
// brute force against one number AND high-cardinality probing from one IP,
// while staying well above legitimate manual/QA retry volume.
const verifyOtpMobileRateLimit = rateLimit({
  windowMs: 10 * 60_000,
  max: 30,
  key: (req) => mobileOrIpRateKey('verify-otp', req),
});
const verifyOtpIpRateLimit = rateLimit({
  windowMs: 10 * 60_000,
  max: 120,
  key: (req) => `verify-otp:ip:${boundedIpPart(req)}`,
});

// Mirror the FCM token into tbl_easyfixer_app.device_id — the CANONICAL
// per-technician push target (legacy EasyFix_API targeted exactly this
// column: Easyfixer @Column(name="device_id", table="tbl_easyfixer_app")).
// The historical Node write path only filled device_info.fire_base_token,
// leaving the canonical column empty so registration-status fan-out had
// nothing to read. We additively keep tbl_easyfixer_app.device_id in sync
// WITHOUT changing the existing device_info behaviour. UPDATE-then-INSERT
// (same defensive upsert setLanguage uses — tbl_easyfixer_app has no usable
// unique constraint beyond the efr_id PK). Best-effort: a failure here must
// never break login/registration, so callers wrap it in try/catch.
async function upsertEasyfixerAppToken(efrId, fcmToken) {
  if (!efrId) return;
  // Empty token → CLEAR the canonical column (single-active-device): on a fresh
  // login the active device may have no push token yet, and the previously
  // stored token belongs to a now-logged-out phone — never leave it pointing
  // there. This mirrors the device_info row, whose fire_base_token is likewise
  // NULLed on a tokenless login. POST /mobile/device fills it when it arrives.
  const token = fcmToken ? String(fcmToken).trim() : null;
  const [upd] = await pool.query(
    'UPDATE tbl_easyfixer_app SET device_id = ?, last_login_time = NOW() WHERE efr_id = ?',
    [token, efrId],
  );
  // Only create a row when there's an actual token to store.
  if (upd.affectedRows === 0 && token) {
    await pool.query(
      'INSERT INTO tbl_easyfixer_app (efr_id, device_id, last_login_time) VALUES (?, ?, NOW())',
      [efrId, token],
    );
  }
}

// ─── Auth (public) ─────────────────────────────────────────────────
router.post('/auth/login-otp', loginOtpIpRateLimit, loginOtpMobileRateLimit, validate(Joi.object({ mobile: mobile.required() })), async (req, res, next) => {
  try {
    logger.info('Login OTP requested');
    const r = await techAuth.createLoginOtp(req.body.mobile);
    logger.info('Login OTP processed · delivered=' + r.delivered);
    modernOk(res, {
      delivered: r.delivered,
      expiresAt: r.expiresAt || null,
      resendInSeconds: r.resendInSeconds,
    });
  } catch (e) { next(e); }
});

// Verify OTP — mirrors legacy `POST /test-api/api/verify-otp` (UserDto) so the
// app can upgrade in-place. Accepts the same field names the legacy controller
// did (deviceId, fireBaseToken) plus our modern camelCase (fcmToken). If any
// device fields are supplied, we upsert `device_info` in the SAME request so
// the technician is push-reachable immediately after login — no second
// /mobile/device round-trip needed (the standalone /mobile/device endpoint
// stays for token-rotation cases).
//
// Legacy reference: https://qa.easyfix.in/test-api/swagger-ui/index.html#/login-controller/verifyOtpUsingPOST
//   request: { userId, otp, deviceId, fireBaseToken, userName }
//   response: { status, message, data: <session-with-device> }
// Our modern envelope wraps the same fields under { success, data }.
router.post('/auth/verify-otp', verifyOtpIpRateLimit, verifyOtpMobileRateLimit, validate(Joi.object({
  mobile:        mobile.required(),
  otp:           Joi.number().integer().min(1000).max(9999).required(),
  // Optional device fields — when present, the device is registered for push
  // notifications inside this same call. fireBaseToken is the legacy name;
  // fcmToken is the new one. Accept either, prefer the explicit fcmToken.
  deviceId:      Joi.string().trim().max(255).optional(),
  fcmToken:      Joi.string().trim().max(4096).optional(),
  fireBaseToken: Joi.string().trim().max(4096).optional(),
  appVersion:    Joi.string().trim().max(50).optional(),
  language:      Joi.string().trim().max(50).optional(),
  // Additive R.03 fields. Both pincode names are accepted during the app
  // rollout; homePincode is canonical and old clients may omit everything.
  homePincode:   Joi.string().trim().pattern(/^\d{6}$/).optional(),
  pincode:       Joi.string().trim().pattern(/^\d{6}$/).optional(),
  referralSource: Joi.string().trim().max(255).allow('').optional(),
})), async (req, res, next) => {
  try {
    logger.info('Verify login OTP · hasDeviceId=' + Boolean(req.body.deviceId));
    if (req.body.homePincode && req.body.pincode
        && req.body.homePincode !== req.body.pincode) {
      return modernError(res, 400, 'homePincode and pincode must match when both are supplied');
    }
    const homePincode = req.body.homePincode || req.body.pincode || null;
    const hasRegistrationProfile = Boolean(
      homePincode || req.body.referralSource || req.body.language,
    );
    let verifiedProfile = null;
    const r = await techAuth.verifyLoginOtp(
      req.body.mobile,
      req.body.otp,
      hasRegistrationProfile ? {
        onVerifiedTech: async (tech, { runner }) => {
          verifiedProfile = await registrationProfile.persistVerifiedProfile(
            tech.efr_id,
            {
              homePincode,
              referralSource: req.body.referralSource,
              language: req.body.language,
            },
            runner,
          );
        },
      } : undefined,
    );
    if (!r.ok) {
      logger.warn('Login OTP verification failed · ' + r.reason);
      return modernError(res, otpFailureHttpStatus(r.reason), r.reason);
    }

    // Device-info upsert. device_info schema reality (verified 2026-05-27
    // against QA `SHOW CREATE TABLE`):
    //   - NO unique constraint exists on (user_id, device_id) — only PK on
    //     `id` + a non-unique secondary key on user_id. This means
    //     `INSERT ... ON DUPLICATE KEY UPDATE` SILENTLY FAILS to upsert
    //     (no constraint to violate → always INSERT → row count grows
    //     unbounded per login). Therefore we manually UPDATE-then-INSERT.
    //   - `is_logged_in` is VARCHAR(255), not TINYINT — values are string
    //     '1' / '0' to match legacy data shape.
    //   - Engine is MyISAM — no transactions. The three statements below
    //     run sequentially; a partial failure mid-sequence (rare) leaves
    //     a benign half-state that the next login self-heals.
    //
    // Single-active-session policy: on every verify-otp with a deviceId,
    // mark all OTHER device rows for this user as `is_logged_in = '0'`.
    // The next push fan-out reads only is_logged_in='1' rows so the old
    // phone stops receiving notifications immediately.
    const fcm = req.body.fcmToken || req.body.fireBaseToken || null;
    let deviceRegistered = false;
    if (req.body.deviceId) {
      try {
        // 1) Kick out every OTHER device for this technician
        await pool.query(
          "UPDATE device_info SET is_logged_in = '0' WHERE user_id = ? AND device_id <> ?",
          [r.tech.efr_id, req.body.deviceId],
        );

        // 2) Try to UPDATE the row for THIS (user_id, device_id) — refreshes
        //    FCM token, app version, language, marks logged-in, bumps time
        const [upd] = await pool.query(
          `UPDATE device_info SET
             fire_base_token   = ?,
             app_version_name  = COALESCE(?, app_version_name),
             language          = COALESCE(?, language),
             is_logged_in      = '1',
             last_login_time   = NOW()
           WHERE user_id = ? AND device_id = ?`,
          [fcm, req.body.appVersion || null, req.body.language || null,
           r.tech.efr_id, req.body.deviceId],
        );

        // 3) No matching row → INSERT fresh. Matches the column set + types
        //    used by the standalone /mobile/device endpoint.
        if (upd.affectedRows === 0) {
          await pool.query(
            `INSERT INTO device_info
               (user_id, device_id, fire_base_token, app_version_name, language, is_logged_in, last_login_time)
             VALUES (?, ?, ?, ?, ?, '1', NOW())`,
            [r.tech.efr_id, req.body.deviceId, fcm, req.body.appVersion || null, req.body.language || null],
          );
        }
        // Mirror the active device's token into the canonical push target
        // (tbl_easyfixer_app.device_id) — unconditionally, so a login with no
        // token CLEARS it rather than leaving the just-logged-out device's token
        // there. Single-active-device, in lockstep with the device_info sweep.
        await upsertEasyfixerAppToken(r.tech.efr_id, fcm);
        deviceRegistered = true;
      } catch (devErr) {
        // Soft-fail — login still succeeds, push just won't reach this
        // device until /mobile/device is hit explicitly.
        require('../../logger').warn(
          { err: devErr.message, efrId: r.tech.efr_id, deviceId: req.body.deviceId },
          'device_info upsert failed during verify-otp',
        );
      }
    } else if (fcm) {
      // No deviceId in the payload (some app builds send only the FCM token on
      // login) — we can't run the device_info single-session sweep (it keys on
      // device_id), but the registration/status push fan-out reads
      // tbl_easyfixer_app.device_id FIRST. Without mirroring the token there the
      // technician is unreachable ("registration-push: no device tokens — skipping").
      // Best-effort, never breaks login. Guarded on `fcm` so a deviceId-less
      // re-auth that carries no token never clears a still-live token.
      try {
        await upsertEasyfixerAppToken(r.tech.efr_id, fcm);
        deviceRegistered = true;
      } catch (devErr) {
        require('../../logger').warn(
          { err: devErr.message, efrId: r.tech.efr_id },
          'tbl_easyfixer_app token sync failed during verify-otp (no deviceId)',
        );
      }
    }

    logger.info('Login OTP verified · deviceRegistered=' + deviceRegistered + ' · fcmStored=' + Boolean(fcm));
    res.cookie('techToken', r.token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 86400 * 1000 });
    modernOk(res, {
      token: r.token,
      tech: {
        efr_id: r.tech.efr_id,
        name:   r.tech.efr_name,
        mobile: r.tech.efr_no,
        email:  r.tech.efr_email,
        ...(verifiedProfile?.location ? {
          homePincode: verifiedProfile.location.pincode,
          city: verifiedProfile.location.city,
          state: verifiedProfile.location.state,
        } : {}),
        ...(verifiedProfile?.language ? { language: verifiedProfile.language } : {}),
      },
      // `registered` = the device was registered for push this login, via the
      // device_info session AND/OR the canonical tbl_easyfixer_app token. True
      // for: deviceId+token, deviceId-only (session created, token cleared), and
      // the deviceId-less `else if (fcm)` path that still synced the FCM token.
      // `deviceId` is null when the client sent none; `fcmStored` reflects
      // whether a push token was actually persisted on this request.
      device: {
        registered: deviceRegistered,
        deviceId: req.body.deviceId || null,
        fcmStored: Boolean(fcm),
      },
    });
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    return next(e);
  }
});

// ─── Protected ─────────────────────────────────────────────────────
router.use(requireTechAuth);

// Server-side counterpart to the app's lifecycle policy. All /jobs writes are
// guarded here before any sub-router or inline handler can mutate state: offer
// decisions require new-work eligibility; already-assigned work uses the
// continuation capability. Reads stay available for restricted technicians.
router.use(requireTechJobMutationCapability);

// Idempotency layer (offline outbox) — keyed off req.tech (set above by
// requireTechAuth). Retries of a same-keyed write replay the stored response
// instead of re-running the side-effect. No-op when no Idempotency-Key header.
router.use(require('../../middleware/idempotency')());

// Notice Board — mounted via shared factory (zero duplication with
// /api/admin/notices). See routes/mobile/notices.js — it's a 10-line
// wrapper around utils/notice-reader-router.js.
router.use('/notices', require('./notices'));

// My Team — the authed technician's downline (efr_manager_id). Mobile-only.
router.use('/team', require('./team'));

// Registration Identity save is isolated so its atomic name+Aadhaar contract
// and authoritative duplicate handling can be route-tested independently.
router.use('/profile', require('./profile-identity'));

// Technician order-lifecycle + estimate sub-routers (NEW 2026-06-15, mobile-only
// — no CRM overlap). MOUNTED BEFORE the inline `/jobs` + `/jobs/:id` handlers
// below so the literal paths (`/jobs/search`, `/jobs/:id/rate-card`,
// `/jobs/:id/cancel`, …) win over the `/jobs/:id` param route. These sub-routers
// do NOT define `GET /jobs` or `GET /jobs/:id`, so the existing list + detail
// handlers still resolve by fall-through.
router.use('/jobs', require('./jobs-lifecycle'));
router.use('/jobs', require('./jobs-estimate'));

router.get('/me', (req, res) => modernOk(res, { tech: req.tech }));

// Technician-initiated re-application. The protected-router idempotency layer
// above replays requests carrying an Idempotency-Key; the transactional
// lifecycle transition is also state-idempotent when a client retries without
// a header after losing the response.
router.post('/reapply', validate(Joi.object({
  reason: Joi.string().trim().max(500).allow('', null).optional(),
})), async (req, res, next) => {
  try {
    const result = await easyfixerLifecycle.requestReapplication(
      req.tech.efr_id,
      req.body || {},
    );
    modernOk(res, result, result.changed ? 're-application submitted' : 're-application already submitted');
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message, e.details);
    next(e);
  }
});

// Wall-only scalar summary. No ledger rows are returned and the app fetches it
// only for INACTIVE/DORMANT/REAPPLIED lifecycle screens.
router.get('/reapplication-summary', async (req, res, next) => {
  try {
    modernOk(res, await easyfixerLifecycle.getReapplicationSummary(req.tech.efr_id));
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message, e.details);
    next(e);
  }
});

// Dashboard — aggregated payload (2026-05-25, repointed at the new
// orchestrator). Replaces the older 4-counts query. The orchestrator
// composes shared services so CRM + Mobile see the same counts logic.
//
// Query params:
//   noticesLimit (int 1-10, default 3) — how many notices to inline
//     in `notices.items` for the dashboard strip / carousel.
//
// See services/mobile-dashboard.service.js for the full payload shape.
const mobileDashboardService = require('../../services/mobile-dashboard.service');
router.get(
  '/dashboard',
  validate(Joi.object({
    noticesLimit: Joi.number().integer().min(1).max(10).optional(),
  }), 'query'),
  async (req, res, next) => {
    try {
      logger.info('Load dashboard · noticesLimit=' + (req.query.noticesLimit != null ? req.query.noticesLimit : 'default'));
      modernOk(res, await mobileDashboardService.getDashboard(
        req.tech.efr_id,
        { noticesLimit: req.query.noticesLimit },
      ));
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

// Jobs assigned to me
router.get('/jobs', async (req, res, next) => {
  try {
    logger.info('List my jobs · status=' + (req.query.status != null ? req.query.status : 'any') + ' · limit=' + (req.query.limit != null ? req.query.limit : 50));
    const { rows, total } = await jobService.list({
      easyfixerId: req.tech.efr_id,
      status: req.query.status != null ? Number(req.query.status) : undefined,
      limit: Math.min(Number(req.query.limit) || 50, 200),
    });
    logger.info('Found ' + rows.length + ' jobs · total=' + total);
    modernOk(res, { items: rows, total });
  } catch (e) { next(e); }
});

// Rejected offers history — the jobs THIS technician declined (offer_status=2
// REJECTED on tbl_job_offer). MOUNTED BEFORE `GET /jobs/:id` so the literal
// `rejected` segment wins over the `:id` param route. Intentionally a LIMITED
// projection: just enough to render a "rejected" history card (who/what/when/
// where-city), with NONE of the sensitive operational fields — no address /
// pincode / GPS / customer name / customer mobile / easyfixer mobile / amount.
// Joins mirror job.service.js LIST_COLUMNS / LIST_JOIN conventions: city is
// reached via tbl_address (j.fk_address_id) → tbl_city, client via
// j.fk_client_id, category via j.fk_service_catg_id, type via
// j.fk_service_type_id. Scoped to req.tech.efr_id. If tbl_job_offer isn't yet
// provisioned (offer model rolling out), return an empty list instead of 500ing.
router.get('/jobs/rejected', async (req, res, next) => {
  try {
    logger.info('List rejected job offers history');
    const [items] = await pool.query(
      `SELECT jo.job_id, jo.reject_reason, jo.responded_at,
              cl.client_name,
              sc.service_catg_name AS service_category,
              st.service_type_name AS service_type,
              ci.city_name,
              j.requested_date_time
         FROM tbl_job_offer jo
         JOIN tbl_job j           ON j.job_id            = jo.job_id
         LEFT JOIN tbl_client cl  ON cl.client_id        = j.fk_client_id
         LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = j.fk_service_catg_id
         LEFT JOIN tbl_service_type st ON st.service_type_id = j.fk_service_type_id
         LEFT JOIN tbl_address ad ON ad.address_id       = j.fk_address_id
         LEFT JOIN tbl_city ci    ON ci.city_id          = ad.city_id
        WHERE jo.fk_easyfixter_id = ? AND jo.offer_status = ${OFFER_STATUS.REJECTED}
        ORDER BY jo.responded_at DESC
        LIMIT 100`,
      [req.tech.efr_id],
    );
    logger.info('Found ' + items.length + ' rejected offers');
    modernOk(res, { items });
  } catch (e) {
    // Offer model may not be provisioned on every DB yet — don't 500 the
    // history screen just because tbl_job_offer doesn't exist.
    if (e?.code === 'ER_NO_SUCH_TABLE') {
      logger.warn('Rejected offers unavailable · ' + e.message);
      return modernOk(res, { items: [] });
    }
    next(e);
  }
});

// Offers currently EXTENDED to this technician — the OPEN offers on
// tbl_job_offer (offer_status=0 OFFERED) under the offer-pool model. Returns
// full job previews so the app can render them with the SAME mapper it already
// uses for GET /jobs (opportunities): jobService.listOfferedForTech() yields
// `{ items: JobPreview[] }` in that identical shape. MOUNTED BEFORE
// `GET /jobs/:id` so the literal `offered` segment wins over the `:id` param
// route. Tolerant of the offer table being absent (offer model rolling out) —
// listOfferedForTech() returns `{ items: [] }` rather than throwing, so a DB
// without tbl_job_offer simply shows no offers.
router.get('/jobs/offered', async (req, res, next) => {
  try {
    logger.info('List open job offers extended to me');
    const result = await jobService.listOfferedForTech(req.tech.efr_id);
    logger.info('Found ' + ((result && result.items ? result.items.length : 0)) + ' open offers');
    modernOk(res, result);
  } catch (e) { next(e); }
});

router.get('/jobs/:id', async (req, res, next) => {
  try {
    logger.info('View job detail · id=' + req.params.id);
    const job = await jobService.getById(Number(req.params.id));
    if (!job) return modernError(res, 404, 'job not found');
    // Owner (accepted the job) OR a tech who currently has an OPEN offer on it
    // may view it — under the offer-pool model an offered job stays
    // fk_easyfixter_id=NULL until accepted, so the offered tech must be allowed
    // to open it to review + Accept/Reject.
    const canView = job.fk_easyfixter_id === req.tech.efr_id
      || (await jobService.techHasOpenOffer(job.job_id, req.tech.efr_id));
    if (!canView) return modernError(res, 404, 'job not found');
    // Defence-in-depth (2026-07-08): the app never shows or dials the customer
    // number — it uses the masked /customer-call bridge — so the raw number
    // must not even reach the device. Strip it MOBILE-ONLY here; the shared
    // getById keeps it for the CRM's own /admin route, and the bridge resolves
    // it server-side from tbl_customer, so nothing that needs it is affected.
    if (job.customer_mob_no != null) job.customer_mob_no = null;
    if (job.customer && typeof job.customer === 'object' && job.customer.phone != null) job.customer.phone = null;
    modernOk(res, job);
  } catch (e) { next(e); }
});

// Mint a public "share job" link + ready-to-share message for a job the
// technician OWNS (is assigned to). The link opens a NON-CONFIDENTIAL public
// page (service, address + Navigate, masked Call to the customer). Non-owners
// get 404 (no existence disclosure). buildShareBundle throws 410 for a
// finished/cancelled job so the app can tell the tech it can't be shared.
router.get('/jobs/:id/share-link', async (req, res, next) => {
  try {
    const jobId = Number(req.params.id);
    logger.info('Mint job share link · id=' + jobId + ' · efr=' + req.tech.efr_id);
    const job = await jobService.getById(jobId);
    if (!job || job.fk_easyfixter_id !== req.tech.efr_id) {
      return modernError(res, 404, 'job not found');
    }
    const bundle = await shareService.buildShareBundle(jobId, pool, { sharedByEfrId: req.tech.efr_id });
    return modernOk(res, bundle);
  } catch (e) {
    return e && typeof e.status === 'number' ? modernError(res, e.status, e.message) : next(e);
  }
});

// ─── Masked click-to-call: bridge the technician ⇄ customer ──────────
// The app NEVER shows or dials the customer's number. from = the tech's on-file
// efr_no (auto — no typing); to = customer (resolved server-side, never
// returned), bridged via Plivo. Same masking posture as the CRM operator
// click-to-call.
//
// SCOPE — the tech must OWN the job (it is assigned to them). An open offer is
// deliberately NOT enough (tightened 2026-07-29).
//
// WHY: under the offer-pool model one job is offered to SEVERAL technicians at
// once, and `fk_easyfixter_id` stays NULL until one accepts. While the previous
// rule (`owner OR open offer`) leaked no phone number — the bridge is masked and
// the raw number is stripped from the mobile payload — it did let EVERY offered
// tech ring the same customer about a job only one of them will ever do, before
// any of them had committed to it. Viewing the job (line ~359) and rejecting the
// offer (line ~527) still accept an open offer, because a tech must be able to
// review and decline; only CONTACTING the customer now requires acceptance.
async function resolveMobileCallLegs(req, jobId) {
  const job = await jobService.getById(jobId);
  if (!job) return { error: { status: 404, msg: 'job not found' } };
  const canCall = job.fk_easyfixter_id === req.tech.efr_id;
  if (!canCall) return { error: { status: 404, msg: 'job not found' } };
  const techMobile = req.tech.efr_no;
  if (!techMobile) return { error: { status: 422, msg: 'No mobile number on file for your account' } };
  const [[cust]] = await pool.query(
    `SELECT c.customer_mob_no AS mobile,
            COALESCE(j.job_customer_name, c.customer_name) AS name, j.job_status
       FROM tbl_job j LEFT JOIN tbl_customer c ON c.customer_id = j.fk_customer_id
      WHERE j.job_id = ? LIMIT 1`,
    [jobId],
  );
  if (!cust || !cust.mobile) return { error: { status: 422, msg: 'No customer number on file to connect the call' } };
  return { techMobile, customer: cust };
}

// Optional masked from(tech)→to(customer) preview for a confirm dialog.
router.post('/jobs/:id/customer-call/preview', async (req, res, next) => {
  try {
    const legs = await resolveMobileCallLegs(req, Number(req.params.id));
    if (legs.error) return modernError(res, legs.error.status, legs.error.msg);
    const preview = await voice.previewCallLegs({ provider: 'plivo', from: legs.techMobile, to: legs.customer.mobile, alwaysApplyEnvOverride: true });
    return modernOk(res, preview);
  } catch (e) { next(e); }
});

// Place the masked bridge call (tech's phone rings first, then the customer).
//
// ALWAYS a PSTN bridge — deliberately independent of `voice.call.mode`. That
// property is a CRM-ONLY feature gate (read solely in routes/admin/calls.js to
// 409 the web-calling endpoints and pick the CRM panel); it is currently 'web'
// because the CRM needs WebRTC. plivo.service.clickToCall() never reads it — it
// only consults plivo.calling.enabled — so a 'web' setting has no effect here.
// This MUST stay true: the technician has no browser leg, so if callMode() ever
// gets wired into clickToCall, this route must pin mode='mobile' explicitly.
router.post('/jobs/:id/customer-call', async (req, res, next) => {
  try {
    const jobId = Number(req.params.id);
    const legs = await resolveMobileCallLegs(req, jobId);
    if (legs.error) return modernError(res, legs.error.status, legs.error.msg);

    if (await dailyBridgeCapReached(jobId)) {
      return modernError(res, 429, 'Call limit reached for this job today. Please try again later.');
    }

    logger.info('Mobile customer bridge call · jobId=' + jobId + ' · efr=' + req.tech.efr_id);
    const result = await voice.clickToCall({ provider: 'plivo', from: legs.techMobile, to: legs.customer.mobile, alwaysApplyEnvOverride: true });

    const audit = {
      jobId,
      callId: result.callId,
      fromMob: legs.techMobile,
      fromName: req.tech.efr_name || 'Technician',
      toMob: legs.customer.mobile,
      toId: null,
      toName: legs.customer.name || 'Customer',
      jobStatus: legs.customer.job_status,
      jobEfrId: req.tech.efr_id,
      provider: result.provider,
    };

    if (!result.delivered && (result.suppressed || result.disabled)) {
      await persistBridgeCall(audit);
      return modernOk(res, { delivered: false, suppressed: true });
    }
    if (!result.delivered) {
      logger.warn({ jobId, diagnostic: result.diagnostic, err: result.error }, 'mobile customer-call failed');
      return modernError(res, 502, 'Could not place the call. Please try again.');
    }
    await persistBridgeCall(audit);
    return modernOk(res, { delivered: true });
  } catch (e) { next(e); }
});

// Accept the job OFFER. Under THE OFFER-POOL MODEL a job can be offered to
// MULTIPLE technicians at once; while offered it stays job_status 0 (BOOKED)
// with fk_easyfixter_id NULL (no single owner), and each offered tech has an
// OFFERED row on tbl_job_offer. So there is NO "this job belongs to me" check
// to do here — fk_easyfixter_id is deliberately NULL until someone wins the
// race. Existence and eligibility (does this tech have an open offer? is the
// job still BOOKED+unowned?) are enforced inside
// jobService.acceptOffer(), which performs the race-safe first-wins claim
// (UPDATE … WHERE job_status=0 AND fk_easyfixter_id IS NULL): the winner's
// offer flips to ACCEPTED and all other open offers EXPIRE; a loser gets a
// status-bearing 409 ('already accepted by another technician'), surfaced
// verbatim below.
router.post('/jobs/:id/accept', async (req, res, next) => {
  try {
    logger.info('Accept job offer · id=' + req.params.id);
    const jobId = Number(req.params.id);
    await jobService.acceptOffer(jobId, req.tech.efr_id);
    logger.info('Job offer accepted · id=' + jobId);
    modernOk(res, { accepted: true });
  } catch (e) {
    // acceptOffer throws a status-bearing error when this tech can't claim the
    // offer (race lost — already accepted by another technician, offer already
    // rejected/expired, or the job has moved past BOOKED) — surface it verbatim.
    // The lost-race case is a 409 so the app shows a clear "offer no longer
    // available" message.
    if (e.status) {
      logger.warn('Accept job offer failed · id=' + req.params.id + ' · ' + e.message);
      return modernError(res, e.status, e.message);
    }
    next(e);
  }
});

// Reject an open pool offer, or a legacy direct assignment when the offer table
// is absent/unused. Ownership, job state and the latest offer are validated and
// locked inside the service transaction; there is deliberately no read-then-
// write authorization check in this route.
router.post('/jobs/:id/reject', validate(Joi.object({
  reason: Joi.string().min(3).max(500).required(),
  reasonId: Joi.number().integer().optional(),
})), async (req, res, next) => {
  try {
    logger.info('Reject job offer · id=' + req.params.id + ' · reasonId=' + (req.body.reasonId != null ? req.body.reasonId : 'none'));
    await jobService.rejectOffer(
      Number(req.params.id),
      req.tech.efr_id,
      { reason: req.body.reason, reasonId: req.body.reasonId },
    );
    logger.info('Job offer rejected · id=' + req.params.id);
    modernOk(res, { rejected: true });
  } catch (e) {
    if (e.status) {
      logger.warn('Reject job offer failed · id=' + req.params.id + ' · ' + e.message);
      return modernError(res, e.status, e.message);
    }
    next(e);
  }
});

// ETA: tech-side "on the way" signal. NOT a status transition — just
// stamps `eta_status` + `eta_requested_time`. Routed through the
// shared setStatus() extras path (no-op transition pattern) so the
// stamps + last_update_time + any future side-effects live in one
// canonical function. eta_status / eta_requested_time are already on
// STATUS_EXTRAS_ALLOWLIST.
router.post('/jobs/:id/eta', validate(Joi.object({
  etaStatus: Joi.string().max(20).optional(),
  etaTime:   Joi.date().iso().optional(),
})), async (req, res, next) => {
  try {
    logger.info('Send ETA on-the-way signal · id=' + req.params.id + ' · etaStatus=' + (req.body.etaStatus || 'OTW'));
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_easyfixter_id !== req.tech.efr_id) return modernError(res, 404, 'job not found');
    await jobService.setStatus(
      job.job_id,
      {
        status: Number(job.job_status),        // no-op transition
        extras: {
          eta_status:         req.body.etaStatus || 'OTW',
          eta_requested_time: new Date(req.body.etaTime || Date.now()),
        },
      },
      /*
       * `user_id` here is an efr_id, not a tbl_user id — a namespace collision
       * that is already live on cancel_by / fk_checkout_by / commented_by and is
       * NOT changed by this line. `efr_id` is added alongside it, on every
       * technician actor in this router, purely to NAME the namespace: it is how
       * services/job-log.service.js tells a technician from an operator and keeps
       * tbl_job_logs.changed_by a tbl_user id and nothing else.
       */
      { user_id: req.tech.efr_id, efr_id: req.tech.efr_id },
    );
    logger.info('ETA signal stamped · id=' + job.job_id);
    modernOk(res, { sent: true });
  } catch (e) {
    if (e.status) {
      logger.warn('Send ETA signal failed · id=' + req.params.id + ' · ' + e.message);
      return modernError(res, e.status, e.message);
    }
    next(e);
  }
});

// Status: → 2 (IN_PROGRESS). `setStatus` fires the TechStart webhook
// automatically based on the transition (BOOKED|SCHEDULED → IN_PROGRESS).
// Mobile-specific stamps (GPS, address, pincode, fk_checkin_by) ride
// through the `extras` whitelist so the transition rules + stamps land
// in a single shared UPDATE — no duplication of status-transition logic.
router.post('/jobs/:id/checkin', validate(Joi.object({
  // Location stamp is nice-to-have, NOT a gate — the customer PIN is the real
  // check-in control. Requiring gps used to 400 the whole request before the PIN
  // verify ran whenever coords were unavailable (GPS off / permission denied),
  // effectively making check-in unreachable. Optional keeps the tech unblocked.
  gps: Joi.string().pattern(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/).optional().allow('', null),
  address: Joi.string().max(500).optional(),
  pincode: Joi.string().pattern(/^[0-9]{6}$/).optional(),
  otp: Joi.string().optional(),
})), async (req, res, next) => {
  try {
    logger.info('Check in to job · id=' + req.params.id);
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_easyfixter_id !== req.tech.efr_id) return modernError(res, 404, 'job not found');
    // Verify the customer check-in PIN (tbl_job.otp, the 4-digit code SMS'd to
    // the customer). When the job carries a PIN it MUST match — a wrong PIN can
    // never start the job (legacy parity: the dedicated verify-otp-customer step).
    // Jobs without a PIN (empty otp) skip the check so existing flows don't break.
    const jobPin = job.otp == null ? '' : String(job.otp).trim();
    const submittedOtp = req.body.otp == null ? '' : String(req.body.otp).trim();
    if (jobPin && jobPin !== submittedOtp) {
      logger.warn('Check-in blocked · id=' + req.params.id + ' · PIN mismatch');
      // Structured error so the app re-prompts for the PIN specifically, instead
      // of mislabelling every 4xx as "wrong PIN". modernError only auto-sets the
      // HTTP-log hint for string errors, so set it manually for the object form.
      if (res.locals) res.locals.logHint = 'check-in PIN mismatch';
      return modernError(res, 409, {
        message: 'Incorrect check-in PIN. Ask the customer for the PIN sent to them.',
        code: 'INVALID_CHECKIN_PIN',
      });
    }
    /*
     * Location stamps are NON-DESTRUCTIVE — absence is not a value.
     *
     * These were built as `req.body.gps || null`, which turns "the technician
     * didn't send a location" into an explicit `checkin_gps_location = NULL`
     * in the UPDATE. tbl_job holds ONE set of check-in columns for the whole
     * job, so that didn't merely fail to record the new reading — it ERASED
     * the stored one. Two real paths hit it, both with GPS off or permission
     * denied (which the schema above deliberately allows):
     *   - an app retry moments after a check-in that DID capture coordinates;
     *   - a revisit's second check-in, wiping visit 1's location.
     * Either way the column ended up NULL with nothing put in its place.
     *
     * So only include a column when the technician actually supplied one; an
     * omitted (or blank) field leaves whatever is stored untouched. This is
     * the same shape the /checkout handler below already uses for its own
     * optional stamps.
     *
     * fk_checkin_by stays unconditional: it always has a value (the
     * authenticated tech) and SHOULD track the most recent check-in.
     */
    /*
     * The check-in TIMESTAMP — the anchor for TAT Segment 1 (ticket created →
     * check-in) and the start of Segment 2. This backend never wrote it: the
     * only writer in the estate was the legacy Java mobile API, so any job
     * worked through the new app had no Visit clock at all.
     *
     * Written WRITE-ONCE (setStatus COALESCEs it — see WRITE_ONCE_EXTRAS), so a
     * revisit's second check-in or an app retry cannot move the anchor forward
     * and quietly improve a Visit TAT that was already breached.
     *
     * Server clock, not a client-supplied one. Legacy trusted the app's
     * `eventTimeStamp` when present, which makes an SLA anchor forgeable by the
     * device being measured.
     */
    const extras = { fk_checkin_by: req.tech.efr_id, checkin_date_time: new Date() };
    const stampIfPresent = (col, raw) => {
      const v = typeof raw === 'string' ? raw.trim() : raw;
      if (v !== null && v !== undefined && v !== '') extras[col] = v;
    };
    stampIfPresent('checkin_gps_location', req.body.gps);
    stampIfPresent('checkin_address',      req.body.address);
    stampIfPresent('checkin_pincode',      req.body.pincode);

    await jobService.setStatus(
      job.job_id,
      { status: 2 /* IN_PROGRESS */, extras },
      { user_id: req.tech.efr_id, efr_id: req.tech.efr_id },
    );
    logger.info('Checked in · id=' + job.job_id + ' · status->IN_PROGRESS');
    modernOk(res, { checkedIn: true });
  } catch (e) {
    if (e.status) {
      logger.warn('Check in failed · id=' + req.params.id + ' · ' + e.message);
      return modernError(res, e.status, e.message);
    }
    next(e);
  }
});

// Checkout — completion with the full problem / cash / revisit capture.
//   isNextVisit=true  → job_status 10 REVISIT (comes back for another visit)
//   else              → job_status 3  COMPLETED
// `setStatus` fires the transition webhook + stamps checkout_date_time +
// fk_checkout_by; the cash/problem/revisit columns ride through the extras
// allowlist so everything lands in one UPDATE. otherRemark has no tbl_job
// column, so it's persisted below as a tbl_job_comment (comment_on=3, check-out)
// after the transition. A revisit stamps both revisit_date + revisit_time_slot.
router.post('/jobs/:id/checkout',
  validate(Joi.object({
    haveProblemWithJob:       Joi.boolean().default(false),
    problemReasonId:          Joi.number().integer().positive().optional().allow(null),
    otherRemark:              Joi.string().max(1000).optional().allow('', null),
    isCashCollected:          Joi.boolean().default(false),
    collectedAmount:          Joi.number().min(0).optional().allow(null),
    collectCashReasonId:      Joi.number().integer().positive().optional().allow(null),
    isNextVisit:              Joi.boolean().default(false),
    // wall-clock ISO 'yyyy-MM-ddTHH:mm:ss' — kept as a STRING and projected
    // verbatim to 'YYYY-MM-DD HH:mm:ss' (never new Date()'d) to dodge the IST shift.
    requestedDateTime:        Joi.string().max(40).optional().allow('', null),
    easyfixerRevisitReasonId: Joi.number().integer().positive().optional().allow(null),
  })),
  async (req, res, next) => {
  try {
    logger.info('Check out of job · id=' + req.params.id + ' · isNextVisit=' + (req.body.isNextVisit === true) + ' · cashCollected=' + (req.body.isCashCollected === true));
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_easyfixter_id !== req.tech.efr_id) return modernError(res, 404, 'job not found');
    const b = req.body;
    const isRevisit = b.isNextVisit === true;
    const extras = {
      app_checkout_date_time: new Date(),
      is_collected_cash_by_app: b.isCashCollected ? 1 : 0,
    };
    if (b.isCashCollected) {
      if (b.collectedAmount != null)     extras.material_charge = b.collectedAmount;
      if (b.collectCashReasonId != null) extras.collect_cash_reason_id = b.collectCashReasonId;
    }
    if (b.haveProblemWithJob && b.problemReasonId != null) {
      extras.problem_reason_id = b.problemReasonId;
    }
    if (isRevisit) {
      if (b.easyfixerRevisitReasonId != null) extras.revisit_reason_id = b.easyfixerRevisitReasonId;
      if (b.requestedDateTime) {
        // App sends wall-clock 'yyyy-MM-ddTHH:mm:ss'. Legacy keeps the revisit
        // appointment as two columns (revisit_date + revisit_time_slot). Split so
        // the chosen time survives even if revisit_date is a DATE column, and so
        // the work-progress read + the transition webhook's revisitTimeSlot stop
        // returning NULL.
        const dt = String(b.requestedDateTime).replace('T', ' ').slice(0, 19); // 'YYYY-MM-DD HH:mm:ss'
        extras.revisit_date = dt;
        const timePart = dt.slice(11); // 'HH:mm:ss' — empty when only a date was sent
        if (timePart) extras.revisit_time_slot = timePart;
      }
    }
    await jobService.setStatus(
      job.job_id,
      { status: isRevisit ? 10 /* REVISIT */ : 3 /* COMPLETED */, extras },
      { user_id: req.tech.efr_id, efr_id: req.tech.efr_id },
    );
    logger.info('Checked out · id=' + job.job_id + ' · status->' + (isRevisit ? 'REVISIT' : 'COMPLETED'));

    // otherRemark has no tbl_job column — persist it as a check-out job comment
    // (comment_on=3; addComment also mirrors it onto tbl_job.remarks). Best-effort:
    // the status transition already committed, so a comment failure must NOT fail
    // the checkout response.
    const remark = b.otherRemark == null ? '' : String(b.otherRemark).trim();
    if (remark) {
      try {
        await jobCommentService.addComment(job.job_id, {
          comments: remark,
          comment_on: 3, // check_out
          efr_id: req.tech.efr_id,
          job_stage: isRevisit ? 10 : 3,
        });
      } catch (ce) {
        logger.warn('Checkout remark comment failed · id=' + job.job_id + ' · ' + ce.message);
      }
    }

    modernOk(res, {
      jobId: job.job_id,
      completedAt: extras.app_checkout_date_time,
      collectedAmount: extras.material_charge,
    });
  } catch (e) {
    if (e.status) {
      logger.warn('Check out failed · id=' + req.params.id + ' · ' + e.message);
      return modernError(res, e.status, e.message);
    }
    next(e);
  }
});

// Reschedule (tech-initiated). Doesn't change job_status; just shifts
// the appointment + stamps the reschedule audit columns. We call
// setStatus with the EXISTING status (no transition) just to ride
// through the extras-whitelist write path + emit the RescheduleTech
// webhook via the same code path /admin/jobs/:id/reschedule uses.
//
// `resch_job_count` is incremented via a follow-up query because the
// extras whitelist binds parameterised values — incrementing requires
// `COALESCE(resch_job_count, 0) + 1` which is an expression, not a
// bind. Done in a separate UPDATE; safe because both writes are on
// the same row and idempotent if a retry lands.
router.post('/jobs/:id/reschedule', validate(Joi.object({
  newDate: Joi.date().iso().required(),
  reasonId: Joi.number().integer().positive().required(),
  remarks: Joi.string().max(500).optional(),
})), async (req, res, next) => {
  try {
    logger.info('Reschedule job · id=' + req.params.id + ' · reasonId=' + req.body.reasonId);
    const job = await jobService.getById(Number(req.params.id));
    if (!job || job.fk_easyfixter_id !== req.tech.efr_id) return modernError(res, 404, 'job not found');
    await jobService.setStatus(
      job.job_id,
      {
        status: Number(job.job_status),       // no-op transition; just rides the extras path
        extras: {
          requested_date_time:   new Date(req.body.newDate),
          reschedule_reason_id:  req.body.reasonId,
          reschedule_remarks:    req.body.remarks || null,
          reschedule_at_app:     new Date(),
          is_rescheduled_by_app: 1,
        },
      },
      { user_id: req.tech.efr_id, efr_id: req.tech.efr_id },
    );
    await pool.query(
      `UPDATE tbl_job SET resch_job_count = COALESCE(resch_job_count, 0) + 1 WHERE job_id = ?`,
      [job.job_id],
    );
    // RescheduleTech webhook isn't auto-fired by setStatus on a no-op
    // transition — fire it explicitly here. (statusToEventName only
    // maps actual transitions; rescheduling isn't a status change.)
    jobService.fireWebhook('RescheduleTech', job.job_id);
    logger.info('Job rescheduled · id=' + job.job_id);
    modernOk(res, { rescheduled: true });
  } catch (e) {
    if (e.status) {
      logger.warn('Reschedule job failed · id=' + req.params.id + ' · ' + e.message);
      return modernError(res, e.status, e.message);
    }
    next(e);
  }
});

// Profile sub-tree — covers the legacy /profile/* endpoints
router.get('/profile', async (req, res, next) => {
  try {
    logger.info('Load raw technician profile');
    const [[tech]] = await pool.query('SELECT * FROM tbl_easyfixer WHERE efr_id = ? AND NOT (tbl_easyfixer.efr_status <=> 3)', [req.tech.efr_id]);
    modernOk(res, tech);
  } catch (e) { next(e); }
});

// Composed profile view for the app's profile screen — identity + rating +
// grade + completedJobs, assembled by the orchestrator from the SAME shared
// services that power the dashboard (NO duplicated SQL). The legacy GET /profile
// above returns the raw tbl_easyfixer row; the app's ApiProfileService.
// getProfileDetails wants this enriched shape, so it GETs /profile/details.
const mobileProfileDetailsService = require('../../services/mobile-profile-details.service');
router.get('/profile/details', async (req, res, next) => {
  try {
    logger.info('Load composed profile details');
    const result = await mobileProfileDetailsService.getProfileDetails(req.tech.efr_id);
    modernOk(res, result);
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

router.get('/profile/percentage', async (req, res, next) => {
  try {
    logger.info('Load profile completion percentages');
    const [[p]] = await pool.query(
      `SELECT efr_profile_perc, efr_personal_details_perc, efr_professional_details_perc,
              efr_bank_details_perc, efr_identity_details_perc
         FROM tbl_easyfixer WHERE efr_id = ? AND NOT (tbl_easyfixer.efr_status <=> 3)`, [req.tech.efr_id]);
    modernOk(res, p);
  } catch (e) { next(e); }
});

// tbl_address is a SHARED/polymorphic table (job rows + technician-personal rows)
// and its column set can drift across deploys, so we probe the live columns once
// and only ever write the ones that actually exist. Resolves the `city` vs
// `city1` ambiguity automatically. Probe lives in address.service — every
// tbl_address writer needs it.
const addressColumns = () => addressService.addressColumnSet(pool);

// Personal-details — the profile-progression "personal" section (Flutter
// `profilePersonalDetails`). Widened from the original name/marital-only save to
// the full legacy contract: first/last name, DOB, marital status, no. of
// children, email, emergency contact, the two insurance flags + one insurance
// photo each (tbl_easyfixer_document type 10=Health, 11=Accidental).
//
// Emergency contact is written to tbl_easyfixer.efr_alt_no — the column the CRM
// verification screen reads (services/easyfixer-verification.service.js). The
// per-address emergency_contact_number on tbl_address is owned by the separate
// contact-info/address save, NOT here. Legacy `aboutYourSelf2` interest chips are
// intentionally dropped (placeholder content). Accepts the app's camelCase plus
// the legacy aliases (`martialStatus` misspelling, `noOfChild`, `aboutYourself`).
router.post('/profile/personal-details', validate(Joi.object({
  firstName: Joi.string().trim().max(255).optional(),
  lastName: Joi.string().trim().max(255).optional(),
  dateOfBirth: Joi.string().trim().max(40).optional(),
  maritalStatus: Joi.string().trim().max(50).optional(),
  martialStatus: Joi.string().trim().max(50).optional(),                  // legacy misspelling alias
  children: Joi.alternatives(Joi.number().integer().min(0), Joi.string().pattern(/^[0-9]{1,3}$/)).optional(),
  noOfChild: Joi.alternatives(Joi.number().integer().min(0), Joi.string().pattern(/^[0-9]{1,3}$/)).optional(),
  email: Joi.string().trim().email().max(255).optional(),
  emergencyContactNumber: Joi.string().trim().pattern(/^[0-9]{10}$/).optional(),
  about: Joi.string().trim().max(1000).allow('', null).optional(),
  aboutYourself: Joi.string().trim().max(1000).allow('', null).optional(),
  healthInsurance: Joi.boolean().optional(),
  accidentalInsurance: Joi.boolean().optional(),
  docs: Joi.object({
    healthInsurance: Joi.string().trim().max(255).optional(),
    accidentalInsurance: Joi.string().trim().max(255).optional(),
  }).optional(),
}).min(1)), async (req, res, next) => {
  const efrId = req.tech.efr_id;
  const lockKey = `efr_doc:${efrId}`;                 // serialize doc upserts per tech (no UNIQUE in schema)
  const conn = await pool.getConnection();
  try {
    logger.info('Save personal-details profile section');
    const b = req.body;
    const marital = b.maritalStatus || b.martialStatus || null;
    const childrenRaw = b.children !== undefined ? b.children : b.noOfChild;
    const children =
      childrenRaw === undefined || childrenRaw === null || childrenRaw === '' ? null : Number(childrenRaw);
    const about = b.about !== undefined ? b.about : b.aboutYourself;
    const health = b.healthInsurance === undefined ? null : (b.healthInsurance ? 1 : 0);
    const accidental = b.accidentalInsurance === undefined ? null : (b.accidentalInsurance ? 1 : 0);
    // Flip the section to 100% ONLY when every mandatory family field is present in
    // THIS request (matches the app's full-form submit). A partial save leaves the
    // existing perc untouched (COALESCE(null, …)) instead of falsely marking it done.
    const personalComplete = !!(
      b.firstName && b.lastName && b.dateOfBirth && b.email && marital &&
      children !== null && !Number.isNaN(children) && b.emergencyContactNumber
    );

    // Hold the per-tech lock across the WHOLE txn (released only after commit) so a
    // concurrent save sees this txn's committed doc rows before it SELECTs.
    await conn.query('SELECT GET_LOCK(?, 10)', [lockKey]);
    await conn.beginTransaction();
    await conn.query(
      `UPDATE tbl_easyfixer SET
         efr_first_name       = COALESCE(?, efr_first_name),
         efr_last_name        = COALESCE(?, efr_last_name),
         date_of_birth        = COALESCE(?, date_of_birth),
         efr_marital_status   = COALESCE(?, efr_marital_status),
         efr_children         = COALESCE(?, efr_children),
         efr_email            = COALESCE(?, efr_email),
         efr_alt_no           = COALESCE(?, efr_alt_no),
         about_yourself       = COALESCE(?, about_yourself),
         health_insurance     = COALESCE(?, health_insurance),
         accidental_insurance = COALESCE(?, accidental_insurance),
         efr_personal_details_perc = COALESCE(?, efr_personal_details_perc)
       WHERE efr_id = ?`,
      [
        b.firstName || null, b.lastName || null, b.dateOfBirth || null, marital,
        children === null || Number.isNaN(children) ? null : children,
        b.email || null, b.emergencyContactNumber || null,
        about === undefined ? null : about, health, accidental,
        personalComplete ? 100 : null, efrId,
      ]);

    // Insurance photos → tbl_easyfixer_document (10=Health, 11=Accidental).
    const docs = b.docs || {};
    await upsertEasyfixerDocuments(conn, efrId, [[10, docs.healthInsurance], [11, docs.accidentalInsurance]]);

    await conn.commit();
    logger.info('Personal-details saved · complete=' + personalComplete);
    modernOk(res, { updated: true });
  } catch (e) {
    logger.warn('Save personal-details failed · ' + e.message);
    try { await conn.rollback(); } catch (_) { /* connection already gone */ }
    next(e);
  } finally {
    try { await conn.query('SELECT RELEASE_LOCK(?)', [lockKey]); } catch (_) { /* lock auto-frees on release */ }
    conn.release();
  }
});

// Professional section. Persists experience level (experience_id FK), the
// selected tool ids (CSV → efr_tools), the use_whatsapp flag, and the three
// uploaded photos → tbl_easyfixer_document (7=Education Certificate, 8=Tools,
// 9=Bag Your Tools). Categories/skills themselves persist via the separate
// deep-skill flow (POST /profile/skills), NOT here. `unknown(true)` keeps the
// handler tolerant of legacy/extra fields the app may still send (hasTools,
// serviceTypeIds, hasBike) during the screen transition.
router.post('/profile/professional-details', validate(Joi.object({
  experienceId: Joi.number().integer().positive().optional(),
  useWhatsapp: Joi.boolean().optional(),
  toolIds: Joi.array().items(Joi.number().integer().positive()).optional(),
  // Per-tool photos (proof of possession): one entry per selected tool.
  tools: Joi.array().items(Joi.object({
    toolId: Joi.number().integer().positive().required(),
    photoKey: Joi.string().trim().max(255).optional(),
  })).optional(),
  docs: Joi.object({
    education: Joi.string().trim().max(255).optional(),
    toolBag: Joi.string().trim().max(255).optional(),
  }).optional(),
}).min(1).unknown(true)), async (req, res, next) => {
  const efrId = req.tech.efr_id;
  const lockKey = `efr_doc:${efrId}`;
  const conn = await pool.getConnection();
  try {
    logger.info('Save professional-details profile section');
    const b = req.body;
    const useWhatsapp = b.useWhatsapp === undefined ? null : (b.useWhatsapp ? 1 : 0);
    // Selected tool ids — prefer the rich per-tool `tools[]`, else the flat toolIds.
    const toolIdList = Array.isArray(b.tools) && b.tools.length
      ? b.tools.map((t) => t.toolId)
      : (Array.isArray(b.toolIds) ? b.toolIds : []);
    const toolsCsv = toolIdList.length ? toolIdList.join(',') : null;
    // Mark the section complete only once an experience level is chosen (the one
    // mandatory field here); a partial save leaves the prior perc untouched.
    const professionalComplete = !!b.experienceId;

    await conn.query('SELECT GET_LOCK(?, 10)', [lockKey]);
    await conn.beginTransaction();
    await conn.query(
      `UPDATE tbl_easyfixer SET
         experience_id = COALESCE(?, experience_id),
         efr_tools     = COALESCE(?, efr_tools),
         use_whatsapp  = COALESCE(?, use_whatsapp),
         efr_professional_details_perc = COALESCE(?, efr_professional_details_perc)
       WHERE efr_id = ?`,
      [b.experienceId || null, toolsCsv, useWhatsapp, professionalComplete ? 100 : null, efrId]);

    // Per-tool photos → tbl_easyfixer_document type 8, one row per tool with the
    // tool id stamped in efr_doc_text (schema-safe; no tool↔doc junction needed).
    // DIFF within the lock (the app only knows hasPhoto, not the stored key, so a
    // kept-but-not-re-picked tool sends NO photoKey and must NOT lose its photo):
    //   • delete photos for tools no longer in the selected set;
    //   • upsert a photo only for tools that supplied a new photoKey;
    //   • tools kept without a new key keep their existing row untouched.
    if (Array.isArray(b.tools)) {
      const desiredIds = b.tools.map((t) => Number(t.toolId)).filter((n) => Number.isInteger(n) && n > 0);
      if (desiredIds.length) {
        const ph = desiredIds.map(() => '?').join(',');
        await conn.query(
          `DELETE FROM tbl_easyfixer_document
            WHERE efr_id = ? AND efr_doc_type_id = 8
              AND (efr_doc_text IS NULL OR efr_doc_text NOT IN (${ph}))`,
          // efr_doc_text is VARCHAR (we store String(toolId)) — bind STRINGS so
          // the NOT IN is a string-vs-string compare, not an implicit numeric cast.
          [efrId, ...desiredIds.map(String)]);
      } else {
        await conn.query('DELETE FROM tbl_easyfixer_document WHERE efr_id = ? AND efr_doc_type_id = 8', [efrId]);
      }
      for (const tp of b.tools) {
        if (!tp || !tp.photoKey) continue;
        const [[ex]] = await conn.query(
          'SELECT efr_doc_id FROM tbl_easyfixer_document WHERE efr_id = ? AND efr_doc_type_id = 8 AND efr_doc_text = ? LIMIT 1',
          [efrId, String(tp.toolId)]);
        if (ex) {
          await conn.query('UPDATE tbl_easyfixer_document SET efr_document_name = ? WHERE efr_doc_id = ?', [tp.photoKey, ex.efr_doc_id]);
        } else {
          await conn.query(
            `INSERT INTO tbl_easyfixer_document (efr_id, efr_doc_type_id, efr_document_name, efr_doc_text, created_date, created_by)
             VALUES (?, 8, ?, ?, NOW(), ?)`,
            [efrId, tp.photoKey, String(tp.toolId), efrId]);
        }
      }
    }
    // Education (7) + Tool Bag (9) — single photo each.
    const docs = b.docs || {};
    await upsertEasyfixerDocuments(conn, efrId, [[7, docs.education], [9, docs.toolBag]]);

    await conn.commit();
    logger.info('Professional-details saved · tools=' + toolIdList.length + ' · complete=' + professionalComplete);
    modernOk(res, { updated: true });
  } catch (e) {
    logger.warn('Save professional-details failed · ' + e.message);
    try { await conn.rollback(); } catch (_) { /* connection already gone */ }
    next(e);
  } finally {
    try { await conn.query('SELECT RELEASE_LOCK(?)', [lockKey]); } catch (_) { /* lock auto-frees */ }
    conn.release();
  }
});

// Professional prefill — experience level, WhatsApp flag, the selected tools
// (with name + whether a photo is already on file), and the selected service
// categories (with the count of chosen deep-skill options). The per-category
// deep-skill DETAIL loads on demand via GET /deepskill/hierarchy/:categoryId.
router.get('/profile/professional', async (req, res, next) => {
  try {
    logger.info('Load professional prefill');
    const efrId = req.tech.efr_id;
    const [[ef]] = await pool.query(
      'SELECT experience_id, efr_tools, use_whatsapp FROM tbl_easyfixer WHERE efr_id = ? LIMIT 1', [efrId]);

    const toolIds = String(ef && ef.efr_tools ? ef.efr_tools : '')
      .split(',').map((s) => parseInt(s, 10)).filter((n) => Number.isInteger(n) && n > 0);
    let tools = [];
    if (toolIds.length) {
      const ph = toolIds.map(() => '?').join(',');
      const [nameRows] = await pool.query(
        `SELECT tool_id, tool_name FROM tbl_tools WHERE tool_id IN (${ph})`, toolIds);
      const nameById = new Map(nameRows.map((r) => [Number(r.tool_id), r.tool_name]));
      const [photoRows] = await pool.query(
        'SELECT efr_doc_text FROM tbl_easyfixer_document WHERE efr_id = ? AND efr_doc_type_id = 8', [efrId]);
      const withPhoto = new Set(
        photoRows.map((r) => parseInt(r.efr_doc_text, 10)).filter((n) => !Number.isNaN(n)));
      tools = toolIds.map((id) => ({ toolId: id, toolName: nameById.get(id) || null, hasPhoto: withPhoto.has(id) }));
    }

    const [catRows] = await pool.query(
      `SELECT m.category_id AS categoryId, c.service_catg_name AS categoryName, COUNT(*) AS skillCount
         FROM tbl_efr_deepskill_mapping m
         JOIN tbl_service_catg c ON c.service_catg_id = m.category_id
        WHERE m.easyfixer_id = ? AND m.is_repairing = 1
        GROUP BY m.category_id, c.service_catg_name
        ORDER BY c.service_catg_name ASC`, [efrId]);

    logger.info('Professional prefill · tools=' + tools.length + ' · categories=' + catRows.length);
    const wa = ef ? ef.use_whatsapp : null;
    modernOk(res, {
      experienceId: ef ? ef.experience_id : null,
      useWhatsapp: Buffer.isBuffer(wa) ? wa[0] === 1 : Number(wa) === 1,
      tools,
      categories: catRows.map((c) => ({
        categoryId: Number(c.categoryId), categoryName: c.categoryName, skillCount: Number(c.skillCount),
      })),
    });
  } catch (e) { next(e); }
});

// Personal prefill — the family/insurance fields written by POST /profile/personal-details
// (Step 2 "Family" + "Insurance" cards). DOB formatted yyyy-MM-dd for the native
// DateField; BIT flags cast to bool. Emergency comes from efr_alt_no.
router.get('/profile/personal', async (req, res, next) => {
  try {
    logger.info('Load personal prefill');
    const [[p]] = await pool.query(
      `SELECT efr_first_name, efr_last_name,
              DATE_FORMAT(date_of_birth, '%Y-%m-%d') AS date_of_birth,
              efr_marital_status, efr_children, efr_email, efr_alt_no, about_yourself,
              health_insurance, accidental_insurance, is_email_verified
         FROM tbl_easyfixer WHERE efr_id = ? LIMIT 1`, [req.tech.efr_id]);
    if (!p) return modernOk(res, null);
    const bit = (v) => (Buffer.isBuffer(v) ? v[0] === 1 : Number(v) === 1);
    modernOk(res, {
      firstName:              p.efr_first_name || null,
      lastName:               p.efr_last_name || null,
      dateOfBirth:            p.date_of_birth || null,
      maritalStatus:          p.efr_marital_status || null,
      children:               p.efr_children == null ? null : Number(p.efr_children),
      email:                  p.efr_email || null,
      emergencyContactNumber: p.efr_alt_no || null,
      about:                  p.about_yourself || null,
      healthInsurance:        bit(p.health_insurance),
      accidentalInsurance:    bit(p.accidental_insurance),
      emailVerified:          bit(p.is_email_verified),
    });
  } catch (e) { next(e); }
});

// Contact-info — the technician's SINGLE address (Step 2). Legacy never typed
// technician addresses (tbl_address.address_type is NULL for all ~21.6k tech
// rows), so the Home/Permanent/Other 3-tab model is dropped: one row keyed by
// tbl_easyfixer.user_id (the role-19 ghost user — the bridge populated at
// creation). Emergency contact lives on tbl_easyfixer.efr_alt_no (written by
// personal-details), NOT here. Column-probed (tbl_address is shared/polymorphic).
router.get('/profile/contact-info', async (req, res, next) => {
  try {
    logger.info('Load contact-info address');
    const [[ef]] = await pool.query('SELECT user_id FROM tbl_easyfixer WHERE efr_id = ? LIMIT 1', [req.tech.efr_id]);
    if (!ef || !ef.user_id) return modernOk(res, null);
    // SELECT * so a drifted/absent column never errors the read.
    const [[row]] = await pool.query(
      'SELECT * FROM tbl_address WHERE user_id = ? ORDER BY address_id DESC LIMIT 1', [ef.user_id]);
    if (!row) return modernOk(res, null);
    modernOk(res, {
      houseNo:        row.house_no ?? null,
      areaOrLocation: row.locality ?? null,
      landMark:       row.landmark ?? null,
      pinCode:        row.pin_code ?? null,
      city:           row.city1 ?? row.city ?? null,
      district:       row.district ?? null,
      state:          row.state ?? null,
      cityId:         row.city_id ?? null,
    });
  } catch (e) { next(e); }
});

router.post('/profile/contact-info', validate(Joi.object({
  houseNo:        Joi.string().trim().max(255).allow('', null).optional(),
  areaOrLocation: Joi.string().trim().max(255).allow('', null).optional(),
  landMark:       Joi.string().trim().max(255).allow('', null).optional(),
  pinCode:        Joi.string().trim().pattern(/^[0-9]{6}$/).allow('', null).optional(),
  city:           Joi.string().trim().max(255).allow('', null).optional(),
  cityId:         Joi.number().integer().positive().allow(null).optional(),
  district:       Joi.string().trim().max(255).allow('', null).optional(),
  state:          Joi.string().trim().max(255).allow('', null).optional(),
}).min(1)), async (req, res, next) => {
  try {
    logger.info('Save contact-info address');
    const b = req.body;
    const [[ef]] = await pool.query('SELECT user_id FROM tbl_easyfixer WHERE efr_id = ? LIMIT 1', [req.tech.efr_id]);
    if (!ef || !ef.user_id) return modernError(res, 409, 'Technician has no linked user account');
    const userId = ef.user_id;
    const cols = await addressColumns();
    // Candidate column → value; only columns that exist on the live table are written.
    // Both city1 + city are offered (whichever exists wins) to span schema drift.
    //
    // The WRITE stays hand-rolled and does NOT use address.service's write
    // helpers, deliberately: this is the polymorphic technician row — keyed by
    // user_id, not customer_id — and its column set (house_no / district / state
    // / city1 / is_address_details_filled) is disjoint from every customer-address
    // writer. Only the column probe is genuinely shared. Routing this through a
    // common builder would mean accepting an arbitrary column→value map, i.e.
    // `UPDATE ... SET` with extra steps, and would put the customer columns one
    // typo away from a technician row.
    const candidates = {
      house_no:                   b.houseNo ?? null,
      locality:                   b.areaOrLocation ?? null,
      landmark:                   b.landMark ?? null,
      pin_code:                   b.pinCode ?? null,
      district:                   b.district ?? null,
      state:                      b.state ?? null,
      city_id:                    b.cityId ?? null,
      city1:                      b.city ?? null,
      city:                       b.city ?? null,
      is_address_details_filled:  1,
    };
    const present = Object.entries(candidates).filter(([c]) => cols.has(c));
    if (!present.length) {
      logger.warn('Contact-info save skipped · no matching address columns');
      return modernOk(res, { updated: false });
    }

    const [[existing]] = await pool.query(
      'SELECT address_id FROM tbl_address WHERE user_id = ? ORDER BY address_id DESC LIMIT 1', [userId]);
    if (existing) {
      const sets = present.map(([c]) => `${c} = ?`).join(', ');
      await pool.query(`UPDATE tbl_address SET ${sets} WHERE address_id = ?`,
        [...present.map(([, v]) => v), existing.address_id]);
    } else {
      const colNames = ['user_id', ...present.map(([c]) => c)];
      const ph = colNames.map(() => '?').join(', ');
      await pool.query(`INSERT INTO tbl_address (${colNames.join(', ')}) VALUES (${ph})`,
        [userId, ...present.map(([, v]) => v)]);
    }
    logger.info('Contact-info address saved · mode=' + (existing ? 'update' : 'insert'));
    modernOk(res, { updated: true });
  } catch (e) { next(e); }
});

router.get('/bank-details', async (req, res, next) => {
  try {
    logger.info('Load bank details');
    // Explicit additive projection: the new app receives one stable camelCase
    // contract while legacy consumers can keep using their existing routes.
    // Avoid SELECT * so new DB columns cannot leak through this mobile API.
    const [[b]] = await pool.query(
      `SELECT d.efr_bank_acc_num,
              d.efr_bank_acc_name,
              d.efr_bank_ifsc,
              d.bank,
              d.is_verified_by_app,
              d.efr_bank_acc_num AS accountNumber,
              d.efr_bank_acc_name AS accountHolderName,
              d.efr_bank_ifsc AS ifscCode,
              n.bank_name AS bankName,
              d.is_verified_by_app AS isVerified
         FROM tbl_easyfixer_bank_details d
         LEFT JOIN bank_name n ON n.id = d.bank
        WHERE d.efr_Id = ?
        LIMIT 1`,
      [req.tech.efr_id],
    );
    modernOk(res, b || null);
  } catch (e) { next(e); }
});

/*
 * Rate limit for the bank-change OTP. Keyed on the TECHNICIAN, not the IP:
 * technicians share carrier NAT and office wifi, so an IP key would let one
 * person's retries lock out everyone around them. 5/min is a person tapping
 * "Resend", not a script — and each send costs a real WhatsApp message.
 *
 * Instantiated once at module scope; rateLimit() closes over its own Map, so
 * building it per-request would cap nothing. (Note: the limiter is
 * per-process, so the real ceiling is 5 × replicas — see middleware/rate-limit.js.)
 */
const bankOtpLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  key: (req) => `mobile-bank-otp:${req.tech && req.tech.efr_id ? req.tech.efr_id : req.ip}`,
});

/*
 * POST /bank-details/otp — send the technician their own bank-change OTP.
 *
 * WHY THIS EXISTS: POST /bank-details below is OTP-gated, and until this route
 * was added there was NO way for the app to obtain that code. sendOtp was
 * reachable only from the CRM (routes/admin/easyfixers.js POST /:id/bank/otp)
 * and the public magic-link flow, so the app door demanded a code it could not
 * ask for. The gate without this route is not a gate, it is a dead end.
 *
 * No :id — the technician is the JWT subject. A route that took a target id
 * would let any authenticated technician spray OTPs at other people's phones.
 *
 * Returns { sent: true } and NOTHING ELSE. The OTP value never leaves the
 * database; an endpoint that echoed it would make the whole gate theatre.
 */
router.post('/bank-details/otp', bankOtpLimiter, async (req, res, next) => {
  try {
    logger.info('Send bank-change OTP · source=app');
    await profileOtp.sendOtp(req.tech.efr_id, pool);
    logger.info('Bank-change OTP sent · source=app');
    // Built literally, not spread from the service's return value, so no
    // future field on that object can ride out to the client.
    modernOk(res, { sent: true }, 'OTP sent on WhatsApp');
  } catch (e) {
    if (e && typeof e.status === 'number') {
      logger.warn('Send bank-change OTP failed · ' + e.message);
      return modernError(res, e.status, e.message || 'request failed');
    }
    next(e);
  }
});

/*
 * Persist the technician's payout account.
 *
 * THIS ROUTE OWNS NO BANK SQL. It delegates to the SAME
 * easyfixer-sensitive-change.service::changeBank the CRM uses, passing
 * source:'app'. That service does OTP → vendor verification → write → audit
 * in one place, so the two doors cannot drift apart.
 *
 * WHAT CHANGED (2026-08-24) AND WHY:
 *   • `isVerified` is GONE from the request body. It was a client-supplied
 *     boolean written straight into `is_verified_by_app` — a flag the CRM
 *     side reads as "this account passed vendor verification". Any technician
 *     could POST {isVerified: true} with any account and have it stored as
 *     verified. The server now decides, by actually calling the vendor.
 *     Old app builds that still send the field are harmless: validate() runs
 *     with stripUnknown, so it is dropped rather than 400'd.
 *   • An OTP is now required. The JWT is not consent on its own — it lives
 *     for JWT_EXPIRY (30d), so it proves who logged in a month ago, not who
 *     is redirecting the money right now.
 *
 * Request the code first with POST /bank-details/otp (directly above), then
 * submit it here alongside the account.
 */
router.post('/bank-details', validate(Joi.object({
  otp: Joi.string().trim().pattern(/^[0-9]{4}$/).required()
    .messages({ 'any.required': 'OTP is required', 'string.pattern.base': 'OTP must be 4 digits' }),
  accountNumber: Joi.string().trim().pattern(/^[0-9]{9,18}$/).required(),
  ifsc: Joi.string().trim().pattern(/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/).required(),
  bankId: Joi.number().integer().positive().optional(),
  bankName: Joi.string().trim().max(255).optional(),
  accountHolderName: Joi.string().trim().min(1).max(255).required(),  // mandatory — name as per bank records
})), async (req, res, next) => {
  try {
    logger.info('Save bank details · bankId=' + (req.body.bankId != null ? req.body.bankId : 'none'));
    const data = await sensitiveChange.changeBank(
      req.tech.efr_id,
      {
        otp: req.body.otp,
        accountNumber: req.body.accountNumber,
        ifsc: req.body.ifsc,
        bankId: req.body.bankId,
        bankName: req.body.bankName,
        accountHolderName: req.body.accountHolderName,
        // The CRM's `reason` is an operator justification; on this path the
        // technician IS the actor, so the OTP is the authority and a fixed
        // marker keeps the audit column meaningful rather than empty.
        reason: 'Updated by technician from the app',
      },
      null,                                   // no tbl_user actor — see changeBank docblock
      { source: 'app', ipAddress: req.ip },
    );
    logger.info('Bank details saved · source=app');
    /*
     * Deliberately NOT echoing the vendor's account-holder name back to the
     * app. The technician chooses the account number they submit, so echoing
     * the name would turn this into a lookup for accounts that are not
     * theirs. The match verdict is enough for the UI to warn on.
     */
    modernOk(res, {
      saved: true,
      verified: data.verified,
      name_match: data.name_match,
    });
  } catch (e) {
    if (e && typeof e.status === 'number') {
      logger.warn('Save bank details failed · ' + e.message);
      return modernError(res, e.status, e.message || 'request failed');
    }
    next(e);
  }
});

router.post('/device', validate(Joi.object({
  deviceId: Joi.string().required(),
  fcmToken: Joi.string().required(),
  appVersion: Joi.string().optional(),
  language: Joi.string().max(10).optional(),
})), async (req, res, next) => {
  try {
    logger.info('Register push device');
    // Single-active-session: log out every OTHER device for this technician
    // (mirrors the verify-otp sweep) so push fan-out targets only this device.
    await pool.query(
      "UPDATE device_info SET is_logged_in = '0' WHERE user_id = ? AND device_id <> ?",
      [req.tech.efr_id, req.body.deviceId],
    );
    /*
     * `app_version_name` must be refreshed on the UPDATE arm, not only written
     * on the first INSERT: a device row is created once and re-upserted on every
     * login and token rotation, so without this the recorded build is frozen at
     * whatever the device was running the day it first registered — which is why
     * the column carried no usable version at all.
     *
     * COALESCE, not a bare VALUES(): `appVersion` is optional in the Joi schema,
     * so an older client (or any caller that omits it) sends NULL, and a bare
     * VALUES() would let that NULL erase a version we already knew. Keeping the
     * last known build is strictly better than forgetting it.
     */
    await pool.query(
      `INSERT INTO device_info (user_id, device_id, fire_base_token, app_version_name, language, is_logged_in, last_login_time)
       VALUES (?, ?, ?, ?, ?, 1, NOW())
       ON DUPLICATE KEY UPDATE fire_base_token = VALUES(fire_base_token),
                               app_version_name = COALESCE(VALUES(app_version_name), app_version_name),
                               is_logged_in = 1, last_login_time = NOW()`,
      [req.tech.efr_id, req.body.deviceId, req.body.fcmToken, req.body.appVersion || null, req.body.language || 'en']);
    // Keep the canonical push target (tbl_easyfixer_app.device_id) in sync so
    // registration-status fan-out can reach this device. Best-effort — a
    // failure here must not fail the device registration.
    try {
      await upsertEasyfixerAppToken(req.tech.efr_id, req.body.fcmToken);
    } catch (appErr) {
      require('../../logger').warn(
        { err: appErr.message, efrId: req.tech.efr_id },
        'tbl_easyfixer_app.device_id sync failed during /device',
      );
    }
    logger.info('Push device registered');
    modernOk(res, { registered: true });
  } catch (e) { next(e); }
});

// VERIFIED 2026-05-12 against ACD_APIs TrainingVideo.java:
//   training_videos columns: id, title, description, sub_title, sub_description,
//   training_video_id (FK → document.id).
// The PLAYABLE url is NOT a column on training_videos — the legacy DTO exposed it
// as the joined document's url (TrainingVideoTitleDescriptionDto:29 →
// getTrainingVideo().getUrl()). Earlier this endpoint returned no url at all, so
// the app's VideoPlayer got an empty source and nothing played. We LEFT JOIN
// `document` and return document.url as `url`.
//
// URL normalization: legacy document.url rows use a cleartext `http://` scheme
// (Android's New Architecture blocks cleartext) and some carry a malformed host
// (`core.easyfix_core.in`). The files all serve from the canonical static host
// over https, so we rebuild from the `/easydoc/...` path.
// Verified: https://core.easyfix.in/easydoc/... → 206 video/mp4 (range-supported).
//
// Moved to services/lms.service.js (2026-08-13) once the CRM grew its own
// video preview: the browser needs exactly the same repair the app does —
// cleartext is mixed-content-blocked on an https CRM and the malformed host
// resolves nowhere — and two copies of this would drift the moment either is
// touched. Imported rather than reimplemented.
const { normalizeVideoUrl: normalizeTrainingVideoUrl } = require('../../services/lms.service');
router.get('/training-videos', async (_req, res, next) => {
  try {
    logger.info('List training videos');
    // document_type_id = 2 is the "Video / Training Videos" type in `document_type`
    // (NOT tbl_document_type, where 2 = Ration Card). Kept in the JOIN ON clause
    // so it's a guard, not a row filter — a training_videos row whose doc is
    // missing/mistyped still returns (with url=''), rather than vanishing.
    const [rows] = await pool.query(
      `SELECT tv.id, tv.title, tv.description, tv.sub_title, tv.sub_description,
              d.url AS doc_url
         FROM training_videos tv
         LEFT JOIN document d
           ON d.id = tv.training_video_id AND d.document_type_id = 2
         ORDER BY tv.id DESC`
    );
    const items = rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      sub_title: r.sub_title,
      sub_description: r.sub_description,
      url: normalizeTrainingVideoUrl(r.doc_url),
    }));
    logger.info('Returning ' + items.length + ' training videos');
    modernOk(res, items);
  } catch (e) { next(e); }
});

// Customer lookup by mobile (from tech app for OTP flows)
/*
 * Customer lookup by mobile. The number travels in the BODY, not the path
 * (2026-08-12): a URL is logged on every request, on every error, and by every
 * upstream proxy/CDN we do not control, so a phone number in the path was
 * written out at request rate. A query string would be no better — it is part
 * of req.originalUrl too.
 */
async function lookupCustomerByMobile(rawMobile, res, next) {
  try {
    logger.info('Lookup customer by mobile');
    const mobile = String(rawMobile || '').replace(/\D/g, '');
    const [[cust]] = await pool.query(
      'SELECT customer_id, customer_name, customer_mob_no, customer_email FROM tbl_customer WHERE customer_mob_no = ? LIMIT 1',
      [mobile]);
    logger.info('Customer lookup · found=' + Boolean(cust));
    return modernOk(res, cust || null);
  } catch (e) { return next(e); }
}

// Canonical.
router.post('/customers/lookup', (req, res, next) => (
  lookupCustomerByMobile(req.body?.mobile, res, next)
));

/*
 * The deprecated GET /customers/mobile/:mobile alias was removed 2026-08-12.
 * It was unreachable rather than merely unused: this router is behind technician
 * JWT auth, the only holder of such a token is the new RN technician app (not
 * yet live, and it never called this), and the old Flutter app authenticates
 * against the legacy secret so it cannot reach /api/mobile/* at all. Its
 * deprecation warning could never fire.
 *
 * The equivalent alias on the CLIENT router is deliberately still in place:
 * Easyfix_Client_App is an installed mobile binary, so builds predating the POST
 * migration are still in the field and would 404. Retire that one only when its
 * deprecation log line has been quiet across a full release cycle.
 */

// ─── Net-new technician sub-routers (2026-06-15, mobile-only) ───────
// Mounted AFTER the inline routes above so they can never shadow an existing
// handler — they only own paths the inline routes don't define. All are
// requireTechAuth-scoped (inherited from line 128) and touch only mobile/legacy
// shared tables for READ/WRITE — zero CRM route overlap.
//   /deepskill/hierarchy/:categoryId · /deepskill/skills
// Rewards (added 2026-08-13) — points balance, ledger, shop, claims, referral.
// Every route inside scopes to req.tech.efr_id; nothing here converts points
// to money, and nothing here ever should.
router.use('/rewards', require('./rewards'));
router.use('/deepskill', require('./deepskill'));
//   /registration/status · /remaining · /personal-details · /language
router.use('/registration', require('./registration'));
//   /attendance · /leave · /leave/unmark
router.use(require('./attendance'));
//   /experience
router.use(require('./lookups'));
//   /profile/name · /profile/image · /earnings · /icard · /ratings
//   /training-videos/percentage · /app-version · /logout · /upi-details
//   /kyc/aadhaar-pan-exists  (POST — the number travels in the body, never the URL)
router.use(require('./profile-extra'));
//   /phe/overview · /phe/months/:month/jobs · /phe/jobs/:jobId
//   /phe/missed · /phe/withdrawals (bounded Performance/History/Earnings reads)
router.use('/phe', require('./phe'));
//   /performance/weekly  (live OTA/SDA weekly chart — net-new GAP #5)
router.use('/performance', require('./performance'));
//   /kyc/digilocker/* · /kyc/pan-ocr · /kyc/aadhaar/* · /kyc/bank/verify · /kyc/upi/verify
//   (3rd-party KYC server-proxy — net-new GAP #2; needs SUREPASS_VERIFICATION_KEY)
router.use('/kyc', require('./kyc'));
//   /email/exists · /email/send-verification · /email/status  (net-new GAP #4)
router.use('/email', require('./email-verify'));
//   /uploads  (generic S3 multipart upload primitive — net-new GAP #1)
router.use('/uploads', require('./uploads'));

module.exports = router;
