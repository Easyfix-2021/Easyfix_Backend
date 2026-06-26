const router = require('express').Router();
const requireAuth = require('../../middleware/auth');

router.use('/lookup', require('./lookup'));

// File upload + delete require auth (lookup already applies its own).
router.use(requireAuth, require('./files'));

/*
 * Deep-skill image resolver (2026-06-11). Any authenticated user
 * (admin / client / mobile) can resolve a deep_skill_id to a short-
 * TTL presigned S3 URL. Sits on /api/shared/deep-skills/:id/image-url
 * — distinct from the admin-only editor endpoint at
 * /api/admin/deep-skills/:id/image-url which returns the same shape
 * but is gated to CRM staff. See routes/shared/deep-skills.js for the
 * rationale (other 1Office services + mobile app need this same data
 * without an admin bearer).
 */
router.use('/deep-skills', requireAuth, require('./deep-skills'));

module.exports = router;
