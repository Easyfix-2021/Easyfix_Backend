const logger = require('../logger');
const pushDelivery = require('./push-delivery.service');

/*
 * Job-offer push — fires an FCM data-push to a technician's device(s) when a
 * job is OFFERED to them under THE OFFER MODEL (CRM/auto assign with the offer
 * flow enabled). The job stays BOOKED with fk_easyfixter_id set and a
 * tbl_job_offer row in OFFERED state; this push tells the app to surface the
 * offer so the tech can accept/reject. The RN app listens for a push whose
 * data payload is { type: "job_offer", job_id } and opens the offer screen.
 *
 * Token routing + the send/prune loop live in push-delivery.service.js (the one
 * shared delivery layer); this module only builds the message and shapes the
 * return. `type`/`job_id` route the NEW Expo app; `screen`/`key` mirror the
 * LEGACY Flutter push contract (routes on data.screen==='NewTicket', reads
 * data.key) so an offered job deep-links to the accept screen on BOTH apps.
 *
 * Best-effort by contract: never throws — a push failure must NEVER break the
 * assignment that triggered it.
 */

/*
 * Notify a technician that a job has been OFFERED to them. Fully fire-and-forget:
 * wraps everything in try/catch, never throws, and is safe to call without
 * awaiting (or with `.catch(() => {})`). Returns a small summary object.
 */
async function sendJobOfferPush(efrId, { jobId } = {}) {
  try {
    logger.info('Sending job-offer push · efrId=' + efrId + ' · jobId=' + jobId);
    if (!efrId) return { delivered: false, reason: 'no efrId' };

    const data = { type: 'job_offer', job_id: String(jobId), key: String(jobId), screen: 'NewTicket' };
    const r = await pushDelivery.deliverToEfr(
      efrId,
      { title: 'EasyFix', body: 'New job offer — tap to accept', data },
      { channel: 'job-offer', label: `job-offer · efr=${efrId} · job=${jobId}` },
    );

    if (r.reason === 'no tokens') {
      logger.info({ efrId, jobId }, 'job-offer-push: no device tokens — skipping');
      return { delivered: false, reason: 'no tokens' };
    }
    logger.info('Job-offer push delivered to ' + r.deliveredCount + '/' + r.tokenCount + ' devices · jobId=' + jobId);
    return { delivered: r.delivered, deliveredCount: r.deliveredCount, tokenCount: r.tokenCount };
  } catch (e) {
    // Absolute backstop — called best-effort from assign() and must never throw.
    logger.warn({ efrId, jobId, err: e.message }, 'job-offer-push: send failed (swallowed)');
    return { delivered: false, error: e.message };
  }
}

module.exports = {
  sendJobOfferPush,
  // Back-compat shim: routes/admin/validate.js imports resolveTokens for its
  // debug test-push (raw-token path, no prune). Same signature + string[] return.
  resolveTokens: pushDelivery.resolveTokensForEfr,
};
