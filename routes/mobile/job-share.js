const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { modernOk, modernError } = require('../../utils/response');
const delegation = require('../../services/job-share-delegation.service');
const logger = require('../../logger');

/*
 * /api/mobile/jobs/:id/share — a technician DELEGATES a job to someone else.
 *
 * Auth: requireTechAuth runs UPSTREAM in routes/mobile/index.js, so req.tech is
 * populated. These five routes are the ONLY /jobs surface the delegation lock
 * (middleware/require-tech-lifecycle-capability.js) lets both parties through
 * unchanged — they are how a live share ENDS, so locking them would strand it.
 * That also means req.tech.efr_id here is always the REAL caller, never the
 * substituted owner identity the lock installs for the delegate elsewhere.
 *
 *   POST   /:id/share         create (original only, job must be live)
 *   DELETE /:id/share         cancel (original only, pending|accepted only)
 *   GET    /:id/share         read   (either party; null for anyone else)
 *   POST   /:id/share/accept  accept (delegate only, pending only)
 *   POST   /:id/share/reject  reject (delegate only, pending only)
 *
 * Every status rule is enforced in the service's transition table, not here —
 * these handlers only resolve WHO is asking.
 */

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

const createBody = Joi.object({
  delegateEfrId:  Joi.number().integer().positive().optional().allow(null),
  contactName:    Joi.string().trim().max(150).optional().allow('', null),
  // 10-digit Indian mobile, same shape the rest of the mobile router accepts.
  contactNumber:  Joi.string().trim().pattern(/^[0-9]{10}$/).optional().allow('', null),
}).or('delegateEfrId', 'contactNumber');

const rejectBody = Joi.object({
  reason: Joi.string().trim().max(32).optional().allow('', null),
});

function handleErr(res, next, e) {
  if (e && e.status) return modernError(res, e.status, e.message, e.details);
  return next(e);
}

router.post('/:id/share', validate(idParam, 'params'), validate(createBody), async (req, res, next) => {
  try {
    const jobId = Number(req.params.id);
    logger.info('Share job · jobId=' + jobId + ' · by=' + req.tech.efr_id);
    const share = await delegation.createShare(jobId, req.tech.efr_id, {
      delegateEfrId: req.body.delegateEfrId ?? null,
      contactName:   req.body.contactName || null,
      contactNumber: req.body.contactNumber || null,
    });
    return res.status(201).json({ success: true, data: { share } });
  } catch (e) { return handleErr(res, next, e); }
});

router.delete('/:id/share', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const jobId = Number(req.params.id);
    logger.info('Cancel job share · jobId=' + jobId + ' · by=' + req.tech.efr_id);
    return modernOk(res, { share: await delegation.cancelShare(jobId, req.tech.efr_id) });
  } catch (e) { return handleErr(res, next, e); }
});

router.get('/:id/share', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const jobId = Number(req.params.id);
    return modernOk(res, { share: await delegation.getShareForViewer(jobId, req.tech.efr_id) });
  } catch (e) { return handleErr(res, next, e); }
});

router.post('/:id/share/accept', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const jobId = Number(req.params.id);
    logger.info('Accept job share · jobId=' + jobId + ' · delegate=' + req.tech.efr_id);
    return modernOk(res, { share: await delegation.acceptShare(jobId, req.tech.efr_id) });
  } catch (e) { return handleErr(res, next, e); }
});

router.post('/:id/share/reject', validate(idParam, 'params'), validate(rejectBody), async (req, res, next) => {
  try {
    const jobId = Number(req.params.id);
    logger.info('Reject job share · jobId=' + jobId + ' · delegate=' + req.tech.efr_id);
    return modernOk(res, {
      share: await delegation.rejectShare(jobId, req.tech.efr_id, req.body.reason || null),
    });
  } catch (e) { return handleErr(res, next, e); }
});

module.exports = router;
