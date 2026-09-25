const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { modernOk, modernError } = require('../../utils/response');
const signature = require('../../services/job-signature.service');
const logger = require('../../logger');

/*
 * /api/mobile/jobs/:id/signature — V3 Phase 4 (4.1, spec D6). Mounted from
 * routes/mobile/index.js under /jobs beside jobs-phase3.js, after
 * requireTechAuth / the lifecycle lock / idempotency. Two segments, so it
 * never collides with GET /jobs/:id.
 *
 * Owner-guarded inside the service (getOwnedJob → 404). No GET: the job
 * detail carries signatureOn (services/job-extras.service.js extrasForJobs).
 */

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });
const dim = Joi.number().integer().min(signature.DIM_MIN).max(signature.DIM_MAX).required();

// POST /jobs/:id/signature { svg: path data ≤200 KB, width, height } → { signatureOn }
router.post('/:id/signature', validate(idParam, 'params'),
  validate(Joi.object({ svg: Joi.string().max(signature.SVG_MAX).required(), width: dim, height: dim })),
  async (req, res, next) => {
    try {
      modernOk(res, await signature.saveSignature(Number(req.params.id), req.tech.efr_id, req.body), 'signature saved');
    } catch (e) {
      if (e && e.status) {
        logger.warn('Signature refused · jobId=' + req.params.id + ' · ' + e.message);
        return modernError(res, e.status, e.code ? { message: e.message, code: e.code } : e.message);
      }
      return next(e);
    }
  });

module.exports = router;
