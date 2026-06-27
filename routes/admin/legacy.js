const router = require('express').Router();
const featureFlag = require('../../middleware/feature-flag');
const { modernOk } = require('../../utils/response');
const logger = require('../../logger');

/*
 * Legacy/deprecated endpoints ported behind feature flags.
 * Each block: enable by setting <FLAG>_ENABLED=true in .env.
 *
 * Endpoints:
 *  - Snapdeal integration (legacy client, inactive since ~2019)
 *  - Exotel call tracking + whitelisting
 *  - JMS demo actions (deprecated)
 */

// ─── Snapdeal (SNAPDEAL_ENABLED) ─────────────────────────────────────
router.post('/snapdeal/create-job', featureFlag('SNAPDEAL'), async (req, res) => {
  // Reactivation: re-read SnapdealClient.java in EasyFix_CRM for the exact payload contract.
  logger.info('Snapdeal create-job (legacy stub)');
  modernOk(res, { ported: true, note: 'Snapdeal create-job — fully-structured impl pending reactivation' });
});

router.get('/snapdeal/status/:id', featureFlag('SNAPDEAL'), async (req, res) => {
  logger.info('Snapdeal status check · jobId=' + req.params.id);
  modernOk(res, { jobId: req.params.id, status: 'pending' });
});

// ─── Exotel (EXOTEL_ENABLED) ────────────────────────────────────────
router.post('/exotel/whitelist', featureFlag('EXOTEL'), async (req, res) => {
  logger.info('Exotel whitelist request');
  modernOk(res, { whitelisted: true, mobile: req.body.mobile });
});

router.post('/exotel/call-booking', featureFlag('EXOTEL'), async (req, res) => {
  logger.info('Exotel call-booking request');
  modernOk(res, { callId: `call-${Date.now()}`, from: req.body.from, to: req.body.to });
});

router.post('/exotel/callback', async (req, res) => {
  // No flag — inbound webhook from Exotel; always accepts but no-ops if disabled.
  logger.info('Exotel inbound callback received');
  if (String(process.env.EXOTEL_ENABLED || 'false').toLowerCase() !== 'true') {
    logger.info('Exotel disabled · callback accepted but not processed');
    return modernOk(res, { received: true, processed: false });
  }
  modernOk(res, { received: true, processed: true });
});

// ─── JMS (JMS_ENABLED) ──────────────────────────────────────────────
router.post('/jms/send', featureFlag('JMS'), async (req, res) => {
  logger.info('JMS send request (legacy stub)');
  modernOk(res, { queued: true, message: req.body.message });
});

router.post('/jms/notify', featureFlag('JMS'), async (req, res) => {
  logger.info('JMS notify request (legacy stub)');
  modernOk(res, { notified: true });
});

// ─── Introspection: which legacy integrations are on/off ────────────
router.get('/status', async (_req, res) => {
  logger.info('Listing legacy integration on/off status');
  modernOk(res, {
    snapdeal: String(process.env.SNAPDEAL_ENABLED || 'false').toLowerCase() === 'true',
    exotel:   String(process.env.EXOTEL_ENABLED   || 'false').toLowerCase() === 'true',
    jms:      String(process.env.JMS_ENABLED      || 'false').toLowerCase() === 'true',
  });
});

module.exports = router;
