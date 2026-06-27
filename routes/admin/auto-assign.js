const router = require('express').Router();

const logger = require('../../logger');
const validate = require('../../middleware/validate');
const autoAssign = require('../../services/auto-assign.service');
const { modernOk } = require('../../utils/response');
const { candidatesQuery, bulkQuery, jobIdParam } = require('../../validators/auto-assign.validator');

// NOTE: route order matters — `/bulk` must come BEFORE `/:jobId`,
// otherwise Express interprets "bulk" as a jobId param and the numeric
// validator rejects it with 400.

// POST /api/admin/auto-assign/bulk?limit=50&dryRun=true
router.post('/bulk',
  validate(bulkQuery, 'query'),
  async (req, res, next) => {
    try {
      logger.info('Bulk auto-assign · limit=' + (req.query.limit ?? 50) + ' dryRun=' + (req.query.dryRun ? 'true' : 'false'));
      const out = await autoAssign.bulkAssignUnassigned(req.query, req.user);
      logger.info('Bulk auto-assign done · examined=' + out.summary.examined + ' assigned=' + out.summary.assignedCount);
      modernOk(res, out, req.query.dryRun ? 'bulk dry-run complete' : 'bulk auto-assign complete');
    } catch (e) {
      logger.error('Bulk auto-assign failed · ' + e.message);
      next(e);
    }
  }
);

// GET /api/admin/auto-assign/:jobId/candidates?limit=10&ignoreDistance=false
router.get('/:jobId/candidates',
  validate(jobIdParam, 'params'),
  validate(candidatesQuery, 'query'),
  async (req, res, next) => {
    try {
      logger.info('Ranking auto-assign candidates · jobId=' + req.params.jobId + ' limit=' + (req.query.limit ?? 10));
      const out = await autoAssign.getCandidates(req.params.jobId, req.query);
      logger.info('Returning ' + (out.candidates ? out.candidates.length : 0) + ' candidates · l1Count=' + (out.l1Count ?? 'n/a'));
      modernOk(res, out);
    } catch (e) {
      logger.warn('Candidate ranking failed · jobId=' + req.params.jobId + ' · ' + e.message);
      next(e);
    }
  }
);

// POST /api/admin/auto-assign/:jobId
router.post('/:jobId',
  validate(jobIdParam, 'params'),
  async (req, res, next) => {
    try {
      logger.info('Auto-assigning top candidate · jobId=' + req.params.jobId);
      const out = await autoAssign.assignTopCandidate(req.params.jobId, req.user);
      logger.info('Job auto-assigned · jobId=' + req.params.jobId + ' efrId=' + (out.chosen && out.chosen.efr_id));
      modernOk(res, out, 'auto-assigned');
    } catch (e) {
      logger.warn('Auto-assign failed · jobId=' + req.params.jobId + ' · ' + e.message);
      next(e);
    }
  }
);

module.exports = router;
