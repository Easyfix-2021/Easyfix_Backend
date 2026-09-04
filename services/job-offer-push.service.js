const logger = require('../logger');
const pushDelivery = require('./push-delivery.service');
const alertFlags = require('./job-offer-alert-flags');

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
 * LOUD ALERT (2026-07-29): a job offer is the ONE push a technician loses money
 * by missing, so — behind the `job.offer.loud_alert.*` property flags (see
 * job-offer-alert-flags.js) — it is sent on a dedicated high-importance channel
 * with its own sound. Two OPT-IN data keys tell the foregrounded app what to do
 * with it:
 *   data.loudAlert='1'  ← loudSoundEnabled()        → play the in-app buzzer/haptics
 *   data.loudBanner='1' ← loudAlertMasterEnabled()  → show the top-strip banner
 * The BANNER HAS NO SUB-FLAG — it is intrinsic to the loud alert and rides on
 * the master alone, so "keep the banner, stop the sound" is a state but "sound
 * with no banner" is not (see job-offer-alert-flags.js; don't add one).
 * Both are OMITTED when their flag is off (the app reads a missing key as off),
 * so with the master flag off — the default — this module emits the exact same
 * FCM payload, byte for byte, that it always has. That is what makes flipping
 * `job.offer.loud_alert.enabled` back to 'false' a true no-deploy revert.
 *
 * Best-effort by contract: never throws — a push failure must NEVER break the
 * assignment that triggered it.
 */

const DELIVERY_CONCURRENCY = 10;

/*
 * Build the one canonical job-offer message. Single-recipient, batch, and
 * reminder sends all call this function so routing keys, copy, and loud-alert
 * flags cannot drift between delivery paths.
 */
function buildJobOfferMessage(jobId, reminder = false) {
  // Read each flag ONCE per push so the sound styling and the data keys can
  // never disagree with each other within a single send. The banner reads the
  // MASTER — it has no sub-flag of its own.
  const loud = alertFlags.loudSoundEnabled();
  const banner = alertFlags.loudAlertMasterEnabled();

  // Both alert keys are OPT-IN — present only while their flag is on. The app
  // reads a missing key as off, so with the master off the payload is exactly
  // the four legacy keys the pre-2026-07-29 backend sent.
  const data = {
    type: 'job_offer',
    job_id: String(jobId),
    key: String(jobId),
    screen: 'NewTicket',
    ...(loud ? { loudAlert: '1' } : {}),
    ...(banner ? { loudBanner: '1' } : {}),
  };

  // Alert styling is attached ONLY when loud is on. Omitting these keys is
  // what makes fcm.service emit today's exact payload — see buildMessage().
  const body = reminder
    ? 'Job offer still waiting — tap to accept'
    : 'New job offer — tap to accept';
  const message = { title: 'EasyFix', body, data };
  if (loud) {
    message.androidChannelId  = alertFlags.ANDROID_CHANNEL_ID;
    message.sound             = alertFlags.ALERT_SOUND;
    message.iosSound          = alertFlags.IOS_ALERT_SOUND;
    message.interruptionLevel = alertFlags.INTERRUPTION_LEVEL;
  }

  return { message, channel: reminder ? 'job-offer-reminder' : 'job-offer' };
}

/*
 * Notify a technician that a job has been OFFERED to them. Fully fire-and-forget:
 * wraps everything in try/catch, never throws, and is safe to call without
 * awaiting (or with `.catch(() => {})`). Returns a small summary object.
 *
 * `reminder` only changes the copy (an escalation re-push says so) and the log
 * channel — the data payload, deep link, and alert styling are identical, so a
 * reminder opens exactly the same screen as the original offer.
 */
async function sendJobOfferPush(efrId, { jobId, reminder = false } = {}) {
  try {
    logger.info('Sending job-offer push · efrId=' + efrId + ' · jobId=' + jobId + (reminder ? ' · reminder' : ''));
    if (!efrId) return { delivered: false, reason: 'no efrId' };

    const { message, channel } = buildJobOfferMessage(jobId, reminder);
    const r = await pushDelivery.deliverToEfr(
      efrId,
      message,
      { channel, label: `${channel} · efr=${efrId} · job=${jobId}` },
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

/*
 * Notify every technician in one offer fan-out. Token resolution remains two
 * SQL queries for 1–50 technicians, then FCM sends run in serial chunks of ten.
 * Like the single sender this is best-effort and never rejects into assignment.
 */
async function sendJobOfferPushBatch(efrIds, { jobId, reminder = false } = {}) {
  try {
    const ids = pushDelivery.normalizeTargetEfrIds(efrIds);
    logger.info(
      `Sending job-offer push batch · recipients=${ids.length} · jobId=${jobId}`
        + (reminder ? ' · reminder' : ''),
    );
    if (!ids.length) return { delivered: false, reason: 'no efrIds' };
    if (ids.length > pushDelivery.MAX_TARGETED_EFR_IDS) {
      logger.warn(
        { recipientCount: ids.length, limit: pushDelivery.MAX_TARGETED_EFR_IDS, jobId },
        'job-offer-push: recipient limit exceeded',
      );
      return { delivered: false, reason: 'recipient limit exceeded' };
    }

    const recipients = await pushDelivery.resolveTokensForEfrs(ids);
    if (!recipients.length) {
      logger.info({ jobId, recipientCount: ids.length }, 'job-offer-push: no device tokens — skipping batch');
      return { delivered: false, reason: 'no tokens' };
    }

    const { message, channel } = buildJobOfferMessage(jobId, reminder);
    const r = await pushDelivery.deliver(
      recipients,
      message,
      {
        concurrency: DELIVERY_CONCURRENCY,
        channel,
        label: `${channel} · recipients=${ids.length} · job=${jobId}`,
      },
    );
    logger.info(
      `Job-offer batch push delivered to ${r.deliveredCount}/${r.tokenCount} devices · jobId=${jobId}`,
    );
    return { delivered: r.delivered, deliveredCount: r.deliveredCount, tokenCount: r.tokenCount };
  } catch (e) {
    logger.warn({ jobId, err: e.message }, 'job-offer-push: batch send failed (swallowed)');
    return { delivered: false, error: e.message };
  }
}

/*
 * ── THE OTHER HALF OF A REASSIGN ────────────────────────────────────
 * When ops move an ACCEPTED job to a different technician, the outgoing one
 * loses it the instant the button is clicked (assign() releases the claim
 * before offering). Until this existed they learned only on their next
 * refresh, so a technician could keep travelling to a job that was no longer
 * theirs. This is the push that tells them.
 *
 * ROUTING KEYS ARE DELIBERATELY ABSENT, and that is the whole design:
 *   - NO `job_id` / `jobId`. The Expo app's routeTap deep-links on that key
 *     alone (useFcm.ts: `jobId != null && canOpenJob` → /order/[id]), and the
 *     destination is a job this technician can no longer fetch. Carrying the
 *     id under `removedJobId` keeps it available for correlation without
 *     arming that branch — a tap falls through every branch and stays inert.
 *   - NO `screen`. The LEGACY FLUTTER app — still what every technician
 *     actually runs — switches on data.screen and its `default:` opens
 *     SplashPage, i.e. the app home. Sending no screen is what selects that
 *     default deliberately rather than by accident.
 * Both apps therefore show the notification and open somewhere harmless. The
 * MESSAGE is the payload here; the deep link is the part we do not want.
 *
 * Best-effort by the same contract as the offer pushes: never throws, safe to
 * call unawaited. A failed push must never break the reassign that caused it.
 */
async function sendJobRemovedPush(efrId, { jobId, reassigned = false } = {}) {
  try {
    logger.info('Sending job-removed push · efrId=' + efrId + ' · jobId=' + jobId
      + (reassigned ? ' · reassigned' : ''));
    if (!efrId) return { delivered: false, reason: 'no efrId' };

    /*
     * The two callers mean different things and the technician can act on the
     * difference, so they do NOT share one sentence. A reassign hands the job
     * to someone else and it is gone for good; a plain unassign returns it to
     * the pool, where this same technician may well be offered it again. Saying
     * "reassigned to another technician" on an unassign would be a plain
     * untruth in the one place the technician has no way to check.
     */
    const message = {
      title: 'EasyFix',
      body: reassigned
        ? `Job #${jobId} has been reassigned to another technician and is no longer yours.`
        : `Job #${jobId} has been removed from your schedule.`,
      data: { type: 'job_removed', removedJobId: String(jobId) },
    };
    const r = await pushDelivery.deliverToEfr(
      efrId,
      message,
      { channel: 'job-removed', label: `job-removed · efr=${efrId} · job=${jobId}` + (reassigned ? ' · reassigned' : '') },
    );
    if (r.reason === 'no tokens') {
      logger.info({ efrId, jobId }, 'job-removed-push: no device tokens — skipping');
      return { delivered: false, reason: 'no tokens' };
    }
    logger.info('Job-removed push delivered to ' + r.deliveredCount + '/' + r.tokenCount + ' devices · jobId=' + jobId);
    return { delivered: r.delivered, deliveredCount: r.deliveredCount, tokenCount: r.tokenCount };
  } catch (e) {
    logger.warn({ efrId, jobId, err: e.message }, 'job-removed-push: send failed (swallowed)');
    return { delivered: false, error: e.message };
  }
}

module.exports = {
  sendJobOfferPush,
  sendJobOfferPushBatch,
  sendJobRemovedPush,
  // Back-compat shim: routes/admin/validate.js imports resolveTokens for its
  // debug test-push (raw-token path, no prune). Same signature + string[] return.
  resolveTokens: pushDelivery.resolveTokensForEfr,
  _internals: { buildJobOfferMessage },
};
