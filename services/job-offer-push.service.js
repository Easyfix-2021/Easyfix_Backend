const { pool } = require('../db');
const logger = require('../logger');
const fcmService = require('./fcm.service');

/*
 * Job-offer push — fires an FCM data-push to a technician's device(s) when a
 * job is OFFERED to them under THE OFFER MODEL (CRM/auto assign with the offer
 * flow enabled). The job stays BOOKED with fk_easyfixter_id set and a
 * tbl_job_offer row in OFFERED state; this push tells the app to surface the
 * offer so the tech can accept/reject. The RN app listens for a push whose
 * data payload is { type: "job_offer", job_id } and opens the offer screen.
 *
 * Token resolution is cloned verbatim from registration-status-push.service.js
 * (the canonical fan-out): TWO sources, unioned + deduped —
 *   1. tbl_easyfixer_app.device_id — the CANONICAL per-technician push target.
 *   2. device_info.fire_base_token (is_logged_in='1', user_id = efr_id) — the
 *      token this Node backend writes on verify-otp / POST /mobile/device.
 * Reading both keeps fan-out correct while some rows only carry one of them.
 *
 * Best-effort by contract: every function swallows its own errors — a push
 * failure must NEVER break the assignment that triggered it.
 */

/*
 * Resolve the set of FCM tokens for a technician. Returns a deduped array of
 * non-empty token strings. Never throws — on any DB error logs + returns
 * whatever was gathered (possibly []).
 */
async function resolveTokens(efrId) {
  const tokens = new Set();

  // 1) Canonical: tbl_easyfixer_app.device_id (one row per technician).
  try {
    const [[appRow]] = await pool.query(
      'SELECT device_id FROM tbl_easyfixer_app WHERE efr_id = ? LIMIT 1',
      [efrId],
    );
    const t = appRow && appRow.device_id ? String(appRow.device_id).trim() : '';
    if (t) tokens.add(t);
  } catch (e) {
    logger.warn({ efrId, err: e.message }, 'job-offer-push: tbl_easyfixer_app token lookup failed');
  }

  // 2) Active device_info rows (the token this backend writes on login).
  //    user_id holds the efr_id for technicians (see verify-otp upsert).
  try {
    const [rows] = await pool.query(
      `SELECT fire_base_token
         FROM device_info
        WHERE user_id = ? AND is_logged_in = '1' AND fire_base_token IS NOT NULL`,
      [efrId],
    );
    for (const r of rows) {
      const t = r.fire_base_token ? String(r.fire_base_token).trim() : '';
      if (t) tokens.add(t);
    }
  } catch (e) {
    logger.warn({ efrId, err: e.message }, 'job-offer-push: device_info token lookup failed');
  }

  return Array.from(tokens);
}

/*
 * Clear a token FCM has reported as NotRegistered / InvalidRegistration from
 * BOTH token stores so fan-out stops targeting a dead device. Scoped to the
 * technician so it never touches another user's rows. Best-effort — never throws.
 */
async function pruneDeadToken(efrId, token) {
  if (!efrId || !token) return;
  try {
    await pool.query(
      "UPDATE device_info SET fire_base_token = NULL, is_logged_in = '0' WHERE user_id = ? AND fire_base_token = ?",
      [efrId, token],
    );
    await pool.query(
      'UPDATE tbl_easyfixer_app SET device_id = NULL WHERE efr_id = ? AND device_id = ?',
      [efrId, token],
    );
    logger.push(`job-offer · pruned dead token · efr=${efrId}`);
  } catch (e) {
    logger.warn({ efrId, err: e.message }, 'job-offer-push: dead-token prune failed');
  }
}

/*
 * Notify a technician that a job has been OFFERED to them. Fully fire-and-forget:
 * wraps everything in try/catch, never throws, and is safe to call without
 * awaiting (or with `.catch(() => {})`). Returns a small summary object.
 */
async function sendJobOfferPush(efrId, { jobId } = {}) {
  try {
    if (!efrId) return { delivered: false, reason: 'no efrId' };

    const tokens = await resolveTokens(efrId);
    if (!tokens.length) {
      logger.info({ efrId, jobId }, 'job-offer-push: no device tokens — skipping');
      return { delivered: false, reason: 'no tokens' };
    }

    const data = { type: 'job_offer', job_id: String(jobId) };

    const results = await Promise.all(
      tokens.map(async (token) => {
        const r = await fcmService
          .sendPush({ token, title: 'EasyFix', body: 'New job offer — tap to accept', data })
          .catch((e) => ({ delivered: false, error: e.message }));
        // Prune tokens FCM reports as permanently dead so we stop re-pushing to
        // them. Skip when the send was redirected to a test device — that dead
        // signal is about the test token, not the real one.
        if (r && r.deadToken && !r.redirected) await pruneDeadToken(efrId, token);
        return r;
      }),
    );

    const deliveredCount = results.filter((r) => r && r.delivered).length;
    logger.push(`job-offer · efr=${efrId} · job=${jobId} · ${deliveredCount}/${tokens.length} devices`);
    return { delivered: deliveredCount > 0, deliveredCount, tokenCount: tokens.length };
  } catch (e) {
    // Absolute backstop — called best-effort from assign() and must never throw.
    logger.warn({ efrId, jobId, err: e.message }, 'job-offer-push: send failed (swallowed)');
    return { delivered: false, error: e.message };
  }
}

module.exports = {
  sendJobOfferPush,
  resolveTokens,
};
