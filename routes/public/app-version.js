const router = require('express').Router();

const logger = require('../../logger');
const { getProperty } = require('../../services/properties.service');
const { modernOk } = require('../../utils/response');

/*
 * GET /api/public/app-version?platform=android
 *
 * Force-update policy for the technician app. Returns the minimum ALLOWED
 * build; the app blocks itself when its installed versionCode is lower.
 *
 * DELIBERATELY TOKEN-LESS — unlike its /public siblings this route verifies no
 * token, because it gates the LOGIN screen itself: an outdated app has no
 * session yet and must still be able to read the policy. That's safe here
 * because the response carries ONLY version policy — no user data, no PII,
 * nothing scoped to a job or technician. Do not add anything sensitive to it.
 *
 * Ops-flippable via easyfix_properties (NO deploy needed to force an update):
 *   app.android.min.version.code   minimum allowed versionCode (e.g. "50")
 *   app.android.store.url          override the store link (optional)
 *   (same shape for app.ios.* when iOS ships)
 *
 * FAIL-OPEN by design: a missing, empty, or unparseable property yields
 * minVersionCode 0, which blocks nobody. A force-update gate that failed CLOSED
 * would brick EVERY installed app on a single config typo (or a cold property
 * cache) — the blast radius of wrongly blocking everyone is far worse than an
 * old client staying up a little longer. Same reason the app treats any fetch
 * error as "not blocked".
 */

const DEFAULT_STORE_URL = {
  android: 'https://play.google.com/store/apps/details?id=com.dev.easyfix',
  ios: '',
};

/** Parse a property into a usable versionCode. Anything invalid → 0 (gate off). */
function toVersionCode(raw) {
  const n = Number(String(raw ?? '').trim());
  return Number.isInteger(n) && n > 0 ? n : 0;
}

router.get('/', async (req, res, next) => {
  try {
    const platform = String(req.query.platform || 'android').toLowerCase() === 'ios' ? 'ios' : 'android';
    const minVersionCode = toVersionCode(getProperty(`app.${platform}.min.version.code`));
    const storeUrl =
      String(getProperty(`app.${platform}.store.url`) || '').trim() || DEFAULT_STORE_URL[platform];

    logger.info('App version policy · platform=' + platform + ' · minVersionCode=' + minVersionCode);
    modernOk(res, { platform, minVersionCode, storeUrl });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
