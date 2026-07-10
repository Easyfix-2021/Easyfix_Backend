/*
 * /api/internal/* — aggregator for machine-to-machine endpoints reached
 * only by other EasyFix backends (currently the legacy Java EasyFix_CRM),
 * never by a browser or end user.
 *
 * Mount semantics:
 *   - NO JWT / Basic auth is applied here. This mount lives AHEAD of the
 *     authed /api aggregator (sibling to /api/public), so requireAuth /
 *     maskMobile never wrap it.
 *   - Each sub-router does its OWN auth via a shared secret header
 *     (X-Internal-Resolve-Secret vs env INTERNAL_IMAGE_RESOLVE_SECRET).
 *     ANY new sub-router added here MUST self-verify — do not rely on a
 *     parent guard.
 */

const router = require('express').Router();

// Resolve a stored tbl_job_image.image value → browser-renderable URL.
// Called server-to-server by the legacy CRM's /resolveJobImage action.
router.use('/job-image-url', require('./job-image-url'));

module.exports = router;
