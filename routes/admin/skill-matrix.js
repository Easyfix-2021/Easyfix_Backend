const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { requirePropertyAllowlist } = require('../../middleware/require-property-allowlist');
const { FEATURES } = require('../../services/feature-access.service');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');
const matrix = require('../../services/service-skill-matrix.service');

/*
 * Job Skill Matrix — Admin Action. Manually build (via AI) the mapping from a
 * service (type + rate-card name) to its required deep skill(s), so ranking can
 * match a job's real skills to a technician's. Property-gated by
 * `skill.matrix.emails` (same model as Validate Flows — the gate shows/hides the
 * card AND enforces the endpoints). NOT an RBAC menu_action.
 */
router.use(requirePropertyAllowlist(FEATURES.canBuildSkillMatrix, { label: 'Build Skill Matrix' }));

const buildBody = Joi.object({
  categoryId: Joi.number().integer().positive().optional(),
  dryRun: Joi.boolean().default(false),
});

// POST /build — run (or dry-run) the AI matrix build. Synchronous; the optional
// categoryId lets ops build one category at a time to keep a run bounded.
router.post('/build', validate(buildBody), async (req, res, next) => {
  try {
    logger.info('Skill-matrix build requested · ' + JSON.stringify(req.body));
    const summary = await matrix.buildMatrix(req.body);
    return modernOk(res, summary, req.body.dryRun ? 'Dry run complete' : 'Skill matrix built');
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

router.get('/stats', async (req, res, next) => {
  try {
    return modernOk(res, await matrix.getStats());
  } catch (e) { next(e); }
});

const listQuery = Joi.object({
  categoryId: Joi.number().integer().positive().optional(),
  limit: Joi.number().integer().min(1).max(500).default(100),
  offset: Joi.number().integer().min(0).default(0),
});
router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    return modernOk(res, { items: await matrix.list(req.query) });
  } catch (e) { next(e); }
});

module.exports = router;
