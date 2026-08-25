/*
 * GET /api/admin/easyfixers/:efrId/mirror/*  — READ-ONLY technician app mirror.
 *
 * Mounted on /easyfixers alongside routes/admin/easyfixers.js (the same
 * two-routers-one-prefix split /jobs already uses). It therefore inherits the
 * whole /api/admin gate chain from routes/admin/index.js:30-38 —
 * requireAuth → role(['admin']) → maskMobile → rejectMaskedMobile → scope.
 *
 * maskMobile matters most: the reply is written with modernOk on the ADMIN
 * `res`, so the technician's payload passes through the mask on its way out
 * and every customer number in it is bulleted. middleware/mask-mobile.js also
 * lists this path as ALWAYS-masked, closing the generic `?unmasked=true`
 * escape hatch — there is no edit form here, so that hatch could only ever
 * have been an operator dumping every customer mobile a technician has seen.
 *
 * The design, the replay mechanics and the three security properties live in
 * services/easyfixer-app-mirror.service.js. This file is the gate.
 */

const router = require('express').Router();

const easyfixer = require('../../services/easyfixer.service');
const sensitiveChange = require('../../services/easyfixer-sensitive-change.service');
const { isAllowedMirrorPath, replayMobileGet } = require('../../services/easyfixer-app-mirror.service');
const { rateLimit } = require('../../middleware/rate-limit');
const { assertEntityInScope } = require('../../lib/scope');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');
const { pool } = require('../../db');

// Identical answer for "no such technician" and "not yours". A 403 on the
// second confirms the id is real, which is the whole existence oracle the
// scope guard exists to close (routes/admin/easyfixers.js:319-320).
const NOT_FOUND = 'easyfixer not found';

/*
 * /api/admin has no global rate limit (server.js), and this endpoint fans one
 * operator click out into a full mobile handler — DB reads included. Keyed on
 * the OPERATOR, not the IP: an office NATs to one address, so an IP key would
 * throttle a floor of support staff as though they were one person. Same shape
 * as bankOtpLimiter in routes/admin/easyfixers.js. Module scope, because
 * rateLimit() closes over its own Map and a per-request instance caps nothing.
 */
const mirrorLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  key: (req) => `efr-app-mirror:${req.user && req.user.user_id ? req.user.user_id : req.ip}`,
});

/*
 * GET /admin/easyfixers/:efrId/mirror-session
 *
 * Everything the CRM must put into browser storage BEFORE the app bundle
 * boots, plus what it needs to tell the operator honestly.
 *
 * Declared BEFORE the '/:efrId/mirror/*' route below. Express matches in
 * declaration order and `mirror-session` would otherwise never be reached if
 * the wildcard were broadened — cheap insurance, since the failure would be a
 * confusing 404 on a path that plainly exists.
 *
 * Deliberately NOT part of the replay: none of this is something the app asks
 * for. It is the CRM's own bootstrap, so it is shaped for the CRM.
 */
router.get('/:efrId/mirror-session', mirrorLimiter, async (req, res, next) => {
  try {
    const efrId = Number(req.params.efrId);
    if (!Number.isInteger(efrId) || efrId <= 0) return modernError(res, 404, NOT_FOUND);
    const row = await easyfixer.getById(efrId);
    if (!row) return modernError(res, 404, NOT_FOUND);
    // Same 404-not-403 rule as the replay route — see NOT_FOUND.
    if (!assertEntityInScope(req, { city_id: row.efr_cityId }).ok) {
      return modernError(res, 404, NOT_FOUND);
    }

    /*
     * The version the technician's device last reported.
     *
     * Read from tbl_easyfixer_app, NOT device_info: measured on QA,
     * device_info.app_version_name is 100% NULL across 6,597 rows — the column
     * is written in code but never lands. tbl_easyfixer_app.app_version_name
     * is populated for ~2,082 of 7,891 rows.
     *
     * So null is the COMMON answer, not an edge case, and the CRM must say
     * "version unknown" rather than implying a match. Ordered by last_login_time
     * so a technician with several device rows reports the one he actually uses.
     */
    let technicianAppVersion = null;
    let language = null;
    try {
      const [[app]] = await pool.query(
        `SELECT app_version_name, language
           FROM tbl_easyfixer_app
          WHERE efr_id = ?
          ORDER BY last_login_time IS NULL, last_login_time DESC
          LIMIT 1`,
        [efrId],
      );
      if (app) {
        technicianAppVersion = app.app_version_name || null;
        language = app.language || null;
      }
    } catch (e) {
      // Never fail the page over a version banner — it is advisory.
      logger.warn('Mirror session: device lookup failed · efrId=' + efrId + ' · ' + e.message);
    }

    /*
     * The technician object seeded as `easyfix.technician`. Shaped to match
     * what the app's own verify-otp writes, because SessionProvider reads it
     * back and a missing field reads as a corrupt session rather than an
     * absent one.
     */
    const technician = {
      efrId: row.efr_id,
      efr_id: row.efr_id,
      name: [row.efr_first_name, row.efr_last_name].filter(Boolean).join(' ').trim() || row.efr_name || null,
      mobile: row.efr_no || null,
      cityId: row.efr_cityId ?? null,
      lifecycleStatus: row.lifecycle_status || null,
    };

    return modernOk(res, { technician, technicianAppVersion, language });
  } catch (e) { next(e); }
});

router.get('/:efrId/mirror/*', mirrorLimiter, async (req, res, next) => {
  try {
    const efrId = Number(req.params.efrId);
    if (!Number.isInteger(efrId) || efrId <= 0) return modernError(res, 404, NOT_FOUND);

    // ── Gate 1: the technician must exist … ──────────────────────────────
    const row = await easyfixer.getById(efrId);
    if (!row) return modernError(res, 404, NOT_FOUND);
    // … and be inside the caller's city scope. 404, never 403 — see NOT_FOUND.
    if (!assertEntityInScope(req, { city_id: row.efr_cityId }).ok) {
      return modernError(res, 404, NOT_FOUND);
    }

    /* ── Gate 2: path allowlist ───────────────────────────────────────────
     * Taken from req.path (raw, still percent-encoded) rather than
     * req.params[0] (which Express has already decoded) so the mobile router
     * decodes exactly once, as it would for a real phone. */
    const marker = req.path.indexOf('/mirror/');
    const subPath = marker === -1 ? '' : req.path.slice(marker + '/mirror'.length);
    if (!isAllowedMirrorPath(subPath)) {
      logger.warn('App mirror path refused · efrId=' + efrId + ' · path=' + subPath);
      return modernError(res, 404, 'not found');
    }

    const q = req.url.indexOf('?');
    const search = q === -1 ? '' : req.url.slice(q);

    logger.info('App mirror view · efrId=' + efrId + ' · path=' + subPath);

    /* One audit row per view. NOT awaited: recordChange swallows its own
     * failures by design (easyfixer-sensitive-change.service.js:157-200) and
     * returns {logged:false} rather than throwing, so awaiting it would only
     * add DB latency to every screen the operator opens. `change_type` is
     * VARCHAR, not ENUM — 'app_view' needs no migration. The .catch is for a
     * pool that rejects outside the service's try, so a torn DB connection can
     * never surface as an unhandled rejection. */
    sensitiveChange.recordChange({
      efrId,
      changeType: 'app_view',
      oldValue: null,                 // a view changes nothing — both sides null
      newValue: null,
      changedBySource: 'crm',
      changedByUserId: req.user.user_id,
      ipAddress: req.ip,
    }).catch(() => { /* audit is best-effort; the service already logs at ERROR */ });

    const replay = await replayMobileGet({ efrId, subPath, search, query: req.query, ip: req.ip });

    // The mobile handler's own status is preserved so the CRM can render its
    // 404s/403s as the app would. Both arms go through res.json, so both are
    // masked. `replay` carries only { status, body } — never the token.
    if (replay.status >= 400) {
      return modernError(res, replay.status, (replay.body && replay.body.error) || 'mirror request failed');
    }

    /*
     * Return the mobile handler's body VERBATIM — do not re-wrap it.
     *
     * Every /api/mobile/* route already answers with the modern envelope
     * { success, data }. Passing that through modernOk() produces
     * { success, data: { success, data: … } }, and the app's own client
     * (src/lib/api.ts) unwraps exactly one level — so every screen would
     * receive an envelope where it expected its payload and render empty.
     *
     * res.json is used directly rather than modernOk for that reason. It is
     * still res.json, so maskMobile — which wraps res.json on the admin
     * router — applies exactly as before. Verified end to end: the mirrored
     * dashboard comes back with the technician's mobile as "9554••••••".
     */
    return res.json(replay.body);
  } catch (e) { next(e); }
});

/*
 * Anything that is not a GET is refused HERE, before a token is minted and
 * before the mobile router is touched. Registered after the GET above, so a
 * GET never reaches it.
 *
 * This is not defensive tidiness: POST /mobile/device runs a single-active-
 * session sweep (routes/mobile/index.js:1522-1525) that would log the
 * technician's real phone out mid-job. A read-only mirror that could replay a
 * write is not a read-only mirror.
 */
router.all('/:efrId/mirror/*', (_req, res) => modernError(res, 405, 'the app mirror is read-only'));

module.exports = router;
