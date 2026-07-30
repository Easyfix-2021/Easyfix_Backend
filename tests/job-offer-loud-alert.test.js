/*
 * Characterization tests for the JOB-OFFER LOUD ALERT flag surface (2026-07-29):
 *
 *   1. job-offer-alert-flags — the master-overrides-every-sub rule, and the
 *      default-OFF fail-safe (missing property == today's behaviour). THREE keys
 *      only: master + sound + reminder. The BANNER has no sub-flag — it is
 *      intrinsic to the loud alert and follows the master, which is what the
 *      "sound off, banner still on" cases below pin.
 *   2. job-offer-push.service — what lands in the FCM message for each flag
 *      state: the four legacy data keys never change, loudAlert appears only
 *      while the SOUND sub is on, loudBanner appears whenever the MASTER is on,
 *      and the styling options are attached ONLY when loud is on.
 *   3. mobile-dashboard.service — the top-level flags.loudOfferAlert block,
 *      which mirrors the master.
 *
 * Properties are driven through the REAL properties.service cache (a fake pool
 * serves easyfix_properties + flushCache() reloads it), so these tests exercise
 * the actual read path rather than a stubbed getProperty — the flags module
 * destructures getProperty at require time, and a stub would silently miss that.
 *
 * Non-destructive: fake pool, no real DB, no network. Runner: `node --test`.
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

// Live property table contents for the current test.
let props = {};

const fake = installFakePool([
  [/FROM easyfix_properties/i, () =>
    Object.entries(props).map(([property_key, property_value]) => ({ property_key, property_value }))],
]);

const propsSvc = require('../services/properties.service');
const alertFlags = require('../services/job-offer-alert-flags');
const jobOfferPush = require('../services/job-offer-push.service');
const pushDelivery = require('../services/push-delivery.service');
const dashboardSvc = require('../services/mobile-dashboard.service');
const jobService = require('../services/job.service');
const noticeService = require('../services/notice.service');
const performanceService = require('../services/performance.service');

// Load a property set into the real cache.
async function setProps(next) {
  props = next;
  await propsSvc.flushCache();
}

// ── Capture what job-offer-push hands to the delivery layer ──────────
// deliverToEfr is looked up off the module object at call time, so replacing it
// here intercepts the message without touching the sender's code.
const realDeliverToEfr = pushDelivery.deliverToEfr;
let captured = null;
pushDelivery.deliverToEfr = async (efrId, message, opts) => {
  captured = { efrId, message, opts };
  return { delivered: true, deliveredCount: 1, tokenCount: 1 };
};

after(() => { pushDelivery.deliverToEfr = realDeliverToEfr; fake.restore(); });
beforeEach(() => { captured = null; fake.reset(); });

// ─── 1. Flag resolution ──────────────────────────────────────────────

test('every flag is OFF when no properties exist at all (fail-safe default)', async () => {
  await setProps({});
  assert.equal(alertFlags.loudAlertMasterEnabled(), false);
  assert.equal(alertFlags.loudSoundEnabled(), false);
  assert.equal(alertFlags.offerReminderEnabled(), false);
});

test('the banner has NO sub-flag — the module exports exactly three readers', async () => {
  // Pins the product decision structurally: a re-added loudBannerEnabled()
  // (or any other banner switch) fails here, not just in the payload cases.
  assert.equal(alertFlags.loudBannerEnabled, undefined, 'the banner must not get its own switch back');
  assert.deepEqual(
    Object.keys(alertFlags).filter((k) => typeof alertFlags[k] === 'function').sort(),
    ['loudAlertMasterEnabled', 'loudSoundEnabled', 'offerReminderEnabled'],
  );
});

test('MASTER OFF overrides every sub, even when the subs are explicitly true', async () => {
  await setProps({
    'job.offer.loud_alert.enabled': 'false',
    'job.offer.loud_alert.sound.enabled': 'true',
    'job.offer.reminder.enabled': 'true',
  });
  assert.equal(alertFlags.loudSoundEnabled(), false, 'sound sub must not survive a dead master');
  assert.equal(alertFlags.offerReminderEnabled(), false, 'reminder sub must not survive a dead master');
});

test('MASTER ON: sound defaults ON, reminder defaults OFF', async () => {
  await setProps({ 'job.offer.loud_alert.enabled': 'true' });
  assert.equal(alertFlags.loudSoundEnabled(), true);
  assert.equal(alertFlags.offerReminderEnabled(), false, 'the re-push cron must never start from the master alone');
});

test('MASTER ON: the sound sub can be switched off on its own', async () => {
  await setProps({ 'job.offer.loud_alert.enabled': 'true', 'job.offer.loud_alert.sound.enabled': 'false' });
  assert.equal(alertFlags.loudSoundEnabled(), false);
  assert.equal(alertFlags.loudAlertMasterEnabled(), true, 'turning the sound off must not take the master (= the banner) with it');
});

test('a stray banner property row is INERT — the banner follows the master alone', async () => {
  // Someone re-seeding the retired key must not be able to switch the banner
  // off (nor, with the master off, on).
  await setProps({ 'job.offer.loud_alert.enabled': 'true', 'job.offer.loud_alert.banner.enabled': 'false' });
  assert.equal(alertFlags.loudAlertMasterEnabled(), true);
  await setProps({ 'job.offer.loud_alert.banner.enabled': 'true' });
  assert.equal(alertFlags.loudAlertMasterEnabled(), false);
});

// ─── 2. The offer push payload ───────────────────────────────────────

test('flags OFF: the four legacy data keys are untouched and NO styling is sent', async () => {
  await setProps({});
  const r = await jobOfferPush.sendJobOfferPush(42, { jobId: 100 });
  assert.equal(r.delivered, true);

  // The legacy contract the Flutter + Expo apps both route on.
  assert.equal(captured.message.data.type, 'job_offer');
  assert.equal(captured.message.data.job_id, '100');
  assert.equal(captured.message.data.key, '100');
  assert.equal(captured.message.data.screen, 'NewTicket');
  // With every flag off the payload is a TRUE no-op: the alert keys are absent,
  // not sent as '0', so flipping the master back is a byte-for-byte revert.
  assert.deepEqual(Object.keys(captured.message.data), ['type', 'job_id', 'key', 'screen']);

  // With loud off the message carries NO styling keys, which is what makes
  // fcm.service emit the pre-2026-07-29 payload verbatim.
  assert.deepEqual(Object.keys(captured.message), ['title', 'body', 'data']);
});

test('MASTER ON: both alert keys are set and the cross-repo channel/sound options ride along', async () => {
  await setProps({ 'job.offer.loud_alert.enabled': 'true' });
  await jobOfferPush.sendJobOfferPush(42, { jobId: 100 });

  assert.equal(captured.message.data.loudAlert, '1');
  assert.equal(captured.message.data.loudBanner, '1');
  // Cross-repo contract — these strings must match what the app registers.
  assert.equal(captured.message.androidChannelId, 'job_offer_v1');
  assert.equal(captured.message.sound, 'offer_alert');
  assert.equal(captured.message.iosSound, 'offer_alert.wav');
  assert.equal(captured.message.interruptionLevel, 'time-sensitive');
  // The legacy routing keys are unchanged — only the alert keys were added.
  assert.equal(captured.message.data.screen, 'NewTicket');
});

test('MASTER ON but sound sub OFF: the sound key + styling drop, the BANNER key stays', async () => {
  await setProps({ 'job.offer.loud_alert.enabled': 'true', 'job.offer.loud_alert.sound.enabled': 'false' });
  await jobOfferPush.sendJobOfferPush(42, { jobId: 100 });
  assert.equal(captured.message.data.loudAlert, undefined, 'no sound key while the sound sub is off');
  assert.equal(captured.message.data.loudBanner, '1', '"keep the banner, stop the sound" must still show the banner');
  assert.equal(captured.message.androidChannelId, undefined);
  assert.deepEqual(Object.keys(captured.message), ['title', 'body', 'data']);
});

test('the banner key rides on the MASTER — no property can drop it while the master is on', async () => {
  // The retired banner key, re-seeded 'false' by a stale migration or a hand
  // edit, must NOT be able to suppress data.loudBanner.
  await setProps({ 'job.offer.loud_alert.enabled': 'true', 'job.offer.loud_alert.banner.enabled': 'false' });
  await jobOfferPush.sendJobOfferPush(42, { jobId: 100 });
  assert.equal(captured.message.data.loudBanner, '1', 'the banner is intrinsic — only the master turns it off');
  assert.equal(captured.message.data.loudAlert, '1');
  assert.equal(captured.message.androidChannelId, 'job_offer_v1');
});

test('a REMINDER push only changes the copy + log channel, never the routing data', async () => {
  await setProps({ 'job.offer.loud_alert.enabled': 'true' });
  await jobOfferPush.sendJobOfferPush(42, { jobId: 100, reminder: true });
  assert.equal(captured.opts.channel, 'job-offer-reminder');
  assert.match(captured.message.body, /still waiting/i);
  // Same deep link + same styling, so a reminder opens the same screen.
  assert.equal(captured.message.data.screen, 'NewTicket');
  assert.equal(captured.message.data.job_id, '100');
  assert.equal(captured.message.androidChannelId, 'job_offer_v1');
});

// ─── 3. The dashboard flags block ────────────────────────────────────

// getDashboard fans out to three sibling services; stub them so this test stays
// scoped to the flags block (each is read off its module object at call time).
function stubDashboardDeps() {
  jobService.list = async () => ({ rows: [], total: 0 });
  jobService.listOfferedForTech = async () => ({ items: [] });
  noticeService.listActiveForSurface = async () => [];
  noticeService.countUnreadForSurface = async () => 0;
  performanceService.getForTech = async () => ({ grade: 'A', rating: 4.5 });
}

test('dashboard exposes flags.loudOfferAlert=false while the master is off', async () => {
  stubDashboardDeps();
  await setProps({ 'job.offer.loud_alert.banner.enabled': 'true' });
  const payload = await dashboardSvc.getDashboard(42);
  assert.deepEqual(payload.flags, { loudOfferAlert: false }, 'a stray banner row must not light the dashboard flag');
});

test('dashboard exposes flags.loudOfferAlert=true on the master alone', async () => {
  stubDashboardDeps();
  await setProps({ 'job.offer.loud_alert.enabled': 'true' });
  const payload = await dashboardSvc.getDashboard(42);
  assert.deepEqual(payload.flags, { loudOfferAlert: true });
});

test('dashboard flags.loudOfferAlert stays TRUE when the sound sub alone is off', async () => {
  stubDashboardDeps();
  await setProps({ 'job.offer.loud_alert.enabled': 'true', 'job.offer.loud_alert.sound.enabled': 'false' });
  const payload = await dashboardSvc.getDashboard(42);
  assert.equal(payload.flags.loudOfferAlert, true, 'the banner survives "stop the sound"');
});

// ─── 4. Offer countdown on the dashboard previews ────────────────────

test('offer previews carry offered_at/expires_at through the mobile mapper — with every flag OFF', async () => {
  stubDashboardDeps();
  // An open offer, exactly as listOfferedForTech now returns it (snake_case
  // list-projection row + the two timing fields stamped on).
  jobService.listOfferedForTech = async () => ({
    items: [{ job_id: 100, job_status: 0, customer_name: 'A',
              offered_at: '2026-07-29 15:20:00', expires_at: '2026-07-29 15:50:00' }],
  });
  // Today's Jobs previews come from list() and have no offer.
  jobService.list = async () => ({ rows: [{ job_id: 55, job_status: 1, requested_date_time: null }], total: 1 });

  await setProps({}); // every flag off — the countdown is ADDITIVE, not gated
  const payload = await dashboardSvc.getDashboard(42);

  assert.equal(payload.flags.loudOfferAlert, false, 'precondition: the feature really is off');
  const preview = payload.newRequests[0];
  assert.equal(preview.jobId, 100, 'the rest of the preview is still camelCase');
  assert.equal(preview.offered_at, '2026-07-29 15:20:00', 'countdown fields stay snake_case by contract');
  assert.equal(preview.expires_at, '2026-07-29 15:50:00');

  // A non-offer preview must NOT gain null placeholders — a null expires_at
  // would read as "there is an offer, expiry unknown".
  for (const job of payload.activeJobs) {
    assert.ok(!('offered_at' in job), 'a plain job preview must not carry offer timing');
    assert.ok(!('expires_at' in job), 'a plain job preview must not carry offer timing');
  }
});
