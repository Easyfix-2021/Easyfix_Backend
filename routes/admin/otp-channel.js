const router = require('express').Router();

const { requirePropertyAllowlist } = require('../../middleware/require-property-allowlist');
const { FEATURES } = require('../../services/feature-access.service');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');
const propertiesSvc = require('../../services/properties.service');
const otpDelivery = require('../../services/otp-delivery.service');

/*
 * Login OTP channel — Admin Action.
 *
 * Which channel is tried FIRST when a user signs in with a MOBILE NUMBER:
 * WhatsApp (Gallabox template) or SMS (SMSCountry, DLT template). The other
 * always stays as the fallback — this endpoint reorders the two, it can never
 * disable one, because OTP is the only way into the product and a bad flip must
 * not be able to lock everyone out.
 *
 * Email-identifier logins are NOT affected (that path is Email → WhatsApp).
 *
 * Property-gated by `access.otpchannel.emails` (same model as Switch Call Mode /
 * Build Skill Matrix — the gate both hides the card AND enforces the endpoints).
 * Deliberately NOT an RBAC menu_action: like its siblings it carries no
 * menu_action row, so it can never be granted from the Manage Role screen.
 */
router.use(requirePropertyAllowlist(FEATURES.canSwitchOtpChannel, { label: 'Switch OTP Channel' }));

// ─── GET / — the current primary channel + dual-channel state ────────
// `dualChannelFromProperty` tells the FE whether it is showing a STORED setting
// or a value still inherited from the legacy OTP_DUAL_CHANNEL_MOBILE env var —
// worth distinguishing, because the env value is what an un-set property falls
// back to, and the first admin toggle takes ownership of it permanently.
router.get('/', (req, res) => {
  logger.info('Get login OTP channel');
  return modernOk(res, {
    channel: otpDelivery.otpChannel(),
    channels: otpDelivery.CHANNELS,
    dualChannel: otpDelivery.dualChannelEnabled(),
    dualChannelFromProperty: otpDelivery.dualChannelFromProperty(),
  });
});

// ─── POST / — set login.otp.channel ──────────────────────────────────
// Mirrors POST /admin/calls/analysis-mode: persist to easyfix_properties, then
// flushCache() so it applies immediately instead of waiting out the 1h TTL.
router.post('/', async (req, res, next) => {
  try {
    const channel = otpDelivery.normaliseChannel(req.body.channel);
    logger.info('Set login OTP channel · channel=' + (channel || '—'));
    if (!otpDelivery.isValidChannel(channel)) {
      logger.warn('Set login OTP channel rejected · invalid channel');
      return modernError(res, 400, "channel must be 'whatsapp' or 'sms'.");
    }
    await propertiesSvc.setProperty('login.otp.channel', channel);
    await propertiesSvc.flushCache();
    logger.info(`login.otp.channel set to '${channel}' by user #${req.user.user_id}`);
    // Re-read through the service rather than echoing the input — the response
    // then reports what readers will actually resolve, not what was requested.
    return modernOk(res, { channel: otpDelivery.otpChannel() });
  } catch (e) { next(e); }
});

// ─── POST /dual-channel — set login.otp.dual.channel ─────────────────
// Separate endpoint (not a second field on POST /) so each setting is its own
// intent, mirroring how /admin/calls splits /mode and /default-provider.
//
// This is the lever that matters during an incident: Gallabox reports success
// the moment it QUEUES, so a template that is registered-but-not-Meta-approved
// silently swallows OTPs and the SMS fallback never fires. Turning this on makes
// both channels go out together. It used to be an env var — i.e. a redeploy
// during exactly the outage you'd need it for — hence the move to a property.
router.post('/dual-channel', async (req, res, next) => {
  try {
    const raw = req.body.dualChannel;
    logger.info('Set login OTP dual-channel · value=' + String(raw));
    // Accept a real boolean or its string form; reject anything else rather than
    // coercing — a truthy typo must not silently switch OTP delivery.
    const v = typeof raw === 'boolean' ? raw
      : String(raw ?? '').trim().toLowerCase() === 'true' ? true
        : String(raw ?? '').trim().toLowerCase() === 'false' ? false
          : null;
    if (v === null) {
      logger.warn('Set login OTP dual-channel rejected · invalid value');
      return modernError(res, 400, 'dualChannel must be true or false.');
    }
    await propertiesSvc.setProperty('login.otp.dual.channel', v ? 'true' : 'false');
    await propertiesSvc.flushCache();
    logger.info(`login.otp.dual.channel set to '${v}' by user #${req.user.user_id}`);
    return modernOk(res, {
      dualChannel: otpDelivery.dualChannelEnabled(),
      dualChannelFromProperty: otpDelivery.dualChannelFromProperty(),
    });
  } catch (e) { next(e); }
});

module.exports = router;
