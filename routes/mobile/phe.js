const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { modernOk, modernError } = require('../../utils/response');
const phe = require('../../services/mobile-phe.service');
const logger = require('../../logger');

/*
 * /api/mobile/phe — bounded, technician-scoped Performance + History +
 * Earnings reads. Authentication and the global mobile idempotency middleware
 * are applied upstream in routes/mobile/index.js. This router is read-only.
 */

const month = Joi.string().pattern(/^\d{4}-(0[1-9]|1[0-2])$/);
const pageQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(50).default(20),
});

router.get('/overview', validate(Joi.object({
  before: month.optional(),
  limit: Joi.number().integer().min(1).max(12).default(6),
}), 'query'), async (req, res, next) => {
  try {
    logger.info(`PHE overview requested · before=${req.query.before || 'current'} limit=${req.query.limit}`);
    modernOk(res, await phe.getOverview(req.tech.efr_id, req.query));
  } catch (error) {
    if (error.status) return modernError(res, error.status, error.message);
    return next(error);
  }
});

router.get(
  '/months/:month/jobs',
  validate(Joi.object({ month: month.required() }), 'params'),
  validate(pageQuery, 'query'),
  async (req, res, next) => {
    try {
      logger.info(`PHE month jobs requested · month=${req.params.month} page=${req.query.page}`);
      modernOk(res, await phe.getMonthJobs(
        req.tech.efr_id,
        req.params.month,
        req.query,
      ));
    } catch (error) {
      if (error.status) return modernError(res, error.status, error.message);
      return next(error);
    }
  },
);

router.get(
  '/jobs/:jobId',
  validate(Joi.object({
    jobId: Joi.number().integer().positive().required(),
  }), 'params'),
  async (req, res, next) => {
    try {
      logger.info(`PHE job proof requested · jobId=${req.params.jobId}`);
      modernOk(res, await phe.getJobDetail(
        req.tech.efr_id,
        Number(req.params.jobId),
      ));
    } catch (error) {
      if (error.status) return modernError(res, error.status, error.message);
      return next(error);
    }
  },
);

router.get('/missed', validate(Joi.object({
  // Product wording is explicitly "last 30 days". Keeping this fixed avoids
  // an unbounded historical scan disguised as a caller-controlled window.
  days: Joi.number().integer().valid(30).default(30),
}), 'query'), async (req, res, next) => {
  try {
    logger.info('PHE missed opportunities requested · days=30');
    modernOk(res, await phe.getMissed(req.tech.efr_id, req.query));
  } catch (error) {
    if (error.status) return modernError(res, error.status, error.message);
    return next(error);
  }
});

router.get('/withdrawals', validate(pageQuery, 'query'), async (req, res, next) => {
  try {
    logger.info(`PHE withdrawals requested · page=${req.query.page} limit=${req.query.limit}`);
    modernOk(res, await phe.getWithdrawals(req.tech.efr_id, req.query));
  } catch (error) {
    if (error.status) return modernError(res, error.status, error.message);
    return next(error);
  }
});

module.exports = router;
