/*
 * Shared deep-skill image resolver (2026-06-11).
 *
 * Mounted at GET /api/shared/deep-skills/:id/image-url.
 *
 * WHY this exists alongside the admin endpoint:
 *   - /api/admin/deep-skills/:id/image-url is gated by admin group +
 *     CRM-staff JWT. That's correct for the in-app skill editor.
 *   - But OTHER 1Office services (KPI Manager, Corporate Recruitment,
 *     HR, Asset, etc.) AND the technician mobile app sometimes need to
 *     render a deep-skill image too. None of those have an admin
 *     bearer; many have a client / mobile bearer.
 *   - `/api/shared/*` is the canonical mount for endpoints any
 *     authenticated user can hit, regardless of group. Reuses the
 *     same service-layer `getImageUrl(skillId)` so prefix discipline,
 *     S3 fallback, and presign TTL stay consistent across both
 *     endpoints. ONE source of truth (services/deep-skill.service.js),
 *     two routes.
 *
 * Response shape mirrors the admin endpoint exactly:
 *   200 { success: true, data: { image: <key>, url: <presigned|null> } }
 *   404 if the deep_skill row doesn't exist
 *   401 if no JWT
 *
 * Use cases for the consumer side:
 *   - Mobile app's catalog browser surfacing deep skill thumbnails
 *   - Cross-service skill-picker components in HR / Asset / KPI repos
 *   - Any future surface that consumes `tbl_deep_skill.deepskill_image`
 *     keys without holding an admin bearer
 */

const router = require('express').Router();
const Joi = require('joi');
const validate = require('../../middleware/validate');
const ds = require('../../services/deep-skill.service');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');

const idParam = Joi.object({
  id: Joi.number().integer().positive().required(),
});

router.get('/:id/image-url',
  validate(idParam, 'params'),
  async (req, res, next) => {
    try {
      logger.info('Get deep-skill image url · id=' + req.params.id);
      const data = await ds.getImageUrl(req.params.id);
      logger.info('Returning deep-skill image url · id=' + req.params.id + ' hasUrl=' + Boolean(data && data.url));
      modernOk(res, data);
    } catch (e) {
      if (e?.status && e.status >= 400 && e.status < 500) {
        logger.warn('Deep-skill image url not available · id=' + req.params.id + ' · ' + e.message);
        return modernError(res, e.status, e.message);
      }
      logger.error('Deep-skill image url failed · id=' + req.params.id + ' · ' + e.message);
      next(e);
    }
  },
);

module.exports = router;
