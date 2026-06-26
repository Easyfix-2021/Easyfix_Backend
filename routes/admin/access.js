const router = require('express').Router();
const { modernOk } = require('../../utils/response');
const { featuresForUser } = require('../../services/feature-access.service');

/*
 * GET /api/admin/access/features — per-user property-gated capability flags for
 * the CURRENT admin, e.g. { canSwitchCallMode, canDeleteEntities }. Drives the
 * FE show/hide of property-gated Admin Actions.
 *
 * DISPLAY ONLY — every gated route independently enforces the same allowlist via
 * requirePropertyAllowlist, so a forged flag buys nothing. Mounted under
 * /api/admin (requireAuth + role(['admin']) already applied upstream).
 */
router.get('/features', (req, res) => modernOk(res, featuresForUser(req.user)));

module.exports = router;
