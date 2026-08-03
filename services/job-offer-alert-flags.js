const { getProperty } = require('./properties.service');

/*
 * Job-offer LOUD ALERT flags (2026-07-29) — ONE place where the master switch
 * and its two sub-switches are read, so the "master overrides every sub"
 * rule can't drift between the three consumers:
 *
 *   services/job-offer-push.service.js   → loudSoundEnabled()  (push styling +
 *                                          data.loudAlert) AND
 *                                          loudAlertMasterEnabled() (data.loudBanner)
 *   services/mobile-dashboard.service.js → loudAlertMasterEnabled() (dashboard flag)
 *   services/job-offer-reminder-cron.js  → offerReminderEnabled()  (re-push cron)
 *
 * THREE keys total (easyfix_properties, read through the cached properties
 * service) — there is NO banner key:
 *
 *   job.offer.loud_alert.enabled          MASTER   default 'false'  (default-OFF)
 *   job.offer.loud_alert.sound.enabled    sub      default 'true'
 *   job.offer.reminder.enabled            sub      default 'false'
 *
 * THE BANNER IS INTRINSIC TO THE FEATURE — DO NOT RE-ADD A SWITCH FOR IT.
 * The banner (flags.loudOfferAlert on the mobile dashboard + data.loudBanner on
 * the offer push) IS the loud alert: it is the surface that makes a technician
 * notice the offer at all, so a "loud alert with the banner off" is not a state
 * the product has. Both banner consumers therefore read the MASTER directly.
 * The one and only banner control is the master flag; a future
 * `job.offer.loud_alert.banner.enabled` would only add a way to half-ship the
 * feature (sound with nothing to look at) and a second thing ops must get right
 * during a revert. If you are here to make the banner independently switchable,
 * that is a product decision that was made the other way — leave it alone.
 *
 * WHY the master defaults OFF while the sound sub defaults ON: the master is the
 * only thing ops has to flip (one row) to light the whole feature up, and it is
 * the only thing they have to flip back to revert to EXACTLY today's behaviour
 * with no deploy. The subs exist to turn individual pieces back off DURING a
 * rollout (e.g. "keep the in-app banner but stop the sound") — so the sound's
 * natural default, once the master is on, is on. Because every sub is AND-ed
 * with the master, a missing/undefined master still means the whole feature is
 * OFF. That is the fail-safe rule the mobile app mirrors: absent flag == off ==
 * today.
 *
 * Idiom note: the master copies ensurePincodeEnabled() in job.service.js
 * (default-OFF: ONLY the literal 'true' enables), while the sound sub copies
 * offerFlowEnabled() (default-ON: only the literal 'false' disables).
 */

// Default-OFF master. Anything other than the literal 'true' leaves the entire
// feature dark — including a missing property row and a cold property cache.
function loudAlertMasterEnabled() {
  return String(getProperty('job.offer.loud_alert.enabled') ?? 'false').toLowerCase() === 'true';
}

// Default-ON sub, AND-ed with the master: drives the FCM sound/channel styling
// and the `data.loudAlert` key the app reads to decide whether to play its own
// in-app alert sound. SOUND ONLY — the banner is not gated by this (or by any
// other sub); both banner surfaces read loudAlertMasterEnabled() directly, so
// "stop the sound" leaves the banner up. See the header block.
function loudSoundEnabled() {
  return loudAlertMasterEnabled()
    && String(getProperty('job.offer.loud_alert.sound.enabled') ?? 'true').toLowerCase() !== 'false';
}

// Default-OFF sub, AND-ed with the master: the escalation re-push cron. Kept
// default-OFF (unlike the sound sub) because it SENDS additional traffic
// rather than restyling traffic that already goes out — turning the master on
// must not, by itself, start pushing more notifications at technicians.
function offerReminderEnabled() {
  return loudAlertMasterEnabled()
    && String(getProperty('job.offer.reminder.enabled') ?? 'false').toLowerCase() === 'true';
}

/*
 * Cross-repo push-styling constants. The Android channel id and sound resource
 * name MUST match what the technician app registers at runtime — a channel id
 * the app never created falls back to the default channel and the whole feature
 * silently degrades to today's quiet push. Change these in lockstep with the app.
 *   ANDROID_CHANNEL_ID   — notification channel the app creates at startup
 *   ALERT_SOUND          — Android raw resource name, NO extension
 *   IOS_ALERT_SOUND      — APNs sound file name, WITH extension
 *   INTERRUPTION_LEVEL   — iOS: break through Focus modes
 */
const ANDROID_CHANNEL_ID = 'job_offer_v1';
const ALERT_SOUND = 'offer_alert';
const IOS_ALERT_SOUND = 'offer_alert.wav';
const INTERRUPTION_LEVEL = 'time-sensitive';

module.exports = {
  loudAlertMasterEnabled,
  loudSoundEnabled,
  offerReminderEnabled,
  ANDROID_CHANNEL_ID,
  ALERT_SOUND,
  IOS_ALERT_SOUND,
  INTERRUPTION_LEVEL,
};
