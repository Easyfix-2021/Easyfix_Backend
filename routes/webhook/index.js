const router = require('express').Router();

/*
 * Inbound provider webhooks (external → us). Mounted at /api/webhook.
 * Each sub-router applies its OWN secret / signature check — there is no
 * shared JWT auth on this group (providers can't carry our tokens).
 */
router.use('/', require('./whatsapp'));

module.exports = router;
