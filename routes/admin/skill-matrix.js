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

/*
 * List query. Search / sort / pagination are ALL server-side — the matrix runs
 * to thousands of rows on live data, so the client can never hold it whole.
 *
 * `sortBy` is whitelisted against the service's SORTABLE_COLUMNS keys (the
 * service re-checks; nothing client-supplied ever reaches ORDER BY). It has NO
 * default on purpose: omitting it is the 3rd-click "unsorted" state, which the
 * service answers with its historical default order.
 */
const listQuery = Joi.object({
  categoryId: Joi.number().integer().positive().optional(),
  q: Joi.string().allow('').max(200).optional(),
  sortBy: Joi.string().valid(...Object.keys(matrix.SORTABLE_COLUMNS)).optional(),
  sortDir: Joi.string().valid('asc', 'desc').default('asc'),
  limit: Joi.number().integer().min(1).max(500).default(100),
  offset: Joi.number().integer().min(0).default(0),
});
router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const { items, total } = await matrix.list(req.query);
    return modernOk(res, { items, total });
  } catch (e) { next(e); }
});

/*
 * Manual gap-fill. The AI build leaves visit/charge/estimate line items (and the
 * odd genuine miss) unmapped; these let ops map a service → deep skill by hand.
 * Manual rows are preserved across rebuilds and feed ranking like AI rows.
 */
const catgQuery = Joi.object({ categoryId: Joi.number().integer().positive().required() });

// "Which skill" picker — active deep skills in the category.
router.get('/deep-skills', validate(catgQuery, 'query'), async (req, res, next) => {
  try {
    return modernOk(res, await matrix.listDeepSkillsForCategory(req.query.categoryId));
  } catch (e) { next(e); }
});

// "Which service" picker — active services in the category + whether each is
// already mapped (unmapped ones are the gaps).
router.get('/category-services', validate(catgQuery, 'query'), async (req, res, next) => {
  try {
    return modernOk(res, await matrix.listCategoryServices(req.query.categoryId));
  } catch (e) { next(e); }
});

// Lightweight gap COUNT for the "Gaps Only (N)" badge — integers only, never
// the full service list (some categories run to 1000+ services).
router.get('/gaps-count', validate(catgQuery, 'query'), async (req, res, next) => {
  try {
    return modernOk(res, await matrix.gapsCount(req.query.categoryId));
  } catch (e) { next(e); }
});

const mappingBody = Joi.object({
  categoryId: Joi.number().integer().positive().required(),
  serviceName: Joi.string().trim().min(1).max(255).required(),
  deepSkillId: Joi.number().integer().positive().required(),
});
router.post('/mapping', validate(mappingBody), async (req, res, next) => {
  try {
    const out = await matrix.addManualMapping({
      serviceCatgId: req.body.categoryId,
      serviceName: req.body.serviceName,
      deepSkillId: req.body.deepSkillId,
    });
    return modernOk(res, out, 'Mapping saved');
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });
router.delete('/mapping/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    return modernOk(res, await matrix.deleteMapping(req.params.id), 'Mapping removed');
  } catch (e) { next(e); }
});

module.exports = router;
