const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { modernOk, modernError } = require('../../utils/response');
const team = require('../../services/mobile-team.service');
const logger = require('../../logger');

/*
 * /api/mobile/team — the authed technician's downline ("My Team").
 *
 * Auth: requireTechAuth is applied UPSTREAM in routes/mobile/index.js before
 * this router is mounted, so req.tech.efr_id is populated. The legacy {id} path
 * param is DROPPED — the master is always req.tech.efr_id, so a tech can only
 * see their own downline. `membershipType` is accepted for legacy compatibility
 * but not required (the downline is derived from efr_manager_id).
 *
 * Response: modern { success, data: { items, total } } — the app's extractList
 * reads the array from `items`.
 */
router.get('/', async (req, res, next) => {
  try {
    logger.info('Fetching My Team downline');
    const members = await team.getMyTeam(req.tech.efr_id);
    logger.info('Found ' + members.length + ' team members');
    modernOk(res, { items: members, total: members.length });
  } catch (e) {
    logger.warn('My Team fetch failed · ' + e.message);
    next(e);
  }
});

const month = Joi.string().pattern(/^\d{4}-(0[1-9]|1[0-2])$/);
const monthQuery = Joi.object({ month: month.optional() });
const memberListQuery = Joi.object({
  month: month.optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(50).default(20),
});

// Team Profile landing data. This is additive; GET /team above retains its
// exact legacy-compatible {items,total} contract.
router.get('/profile', validate(monthQuery, 'query'), async (req, res, next) => {
  try {
    logger.info(`Fetching Team Profile · month=${req.query.month || 'current'}`);
    modernOk(res, await team.getTeamProfile(req.tech.efr_id, req.query));
  } catch (error) {
    if (error.status) return modernError(res, error.status, error.message);
    return next(error);
  }
});

router.get('/members', validate(memberListQuery, 'query'), async (req, res, next) => {
  try {
    logger.info(`Fetching paged team members · month=${req.query.month || 'current'} page=${req.query.page}`);
    modernOk(res, await team.listMembers(req.tech.efr_id, req.query));
  } catch (error) {
    if (error.status) return modernError(res, error.status, error.message);
    return next(error);
  }
});

router.get(
  '/members/:memberId',
  validate(Joi.object({
    memberId: Joi.number().integer().positive().required(),
  }), 'params'),
  validate(monthQuery, 'query'),
  async (req, res, next) => {
    try {
      logger.info(`Fetching team member detail · memberId=${req.params.memberId}`);
      modernOk(res, await team.getMemberDetail(
        req.tech.efr_id,
        Number(req.params.memberId),
        req.query,
      ));
    } catch (error) {
      if (error.status) return modernError(res, error.status, error.message);
      return next(error);
    }
  },
);

module.exports = router;
