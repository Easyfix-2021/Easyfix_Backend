const router = require('express').Router();

/*
 * Inbound provider webhooks (external → us). Mounted at /api/webhook.
 * Each sub-router applies its OWN secret / signature check — there is no
 * shared JWT auth on this group (providers can't carry our tokens).
 */
router.use('/', require('./whatsapp'));
// Plivo voice status callbacks (ring / hangup). Self-authorised via the signed
// `t` token on each request — see routes/webhook/plivo.js.
router.use('/plivo', require('./plivo'));
// Plivo Multi-Party Call (conference) status callbacks. SEPARATE router so the
// 1:1 ring/hangup handlers above are untouched; same signed-`t` authorisation.
router.use('/plivo-conference', require('./plivo-conference'));
// STT sidecar OOM alerts (internal `stt-oom-watch` sidecar → us). Authorised by
// the shared STT_OOM_WEBHOOK_KEY header; 200 no-op unless configured.
router.use('/stt-oom', require('./stt-oom'));

module.exports = router;
