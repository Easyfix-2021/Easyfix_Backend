const router = require('express').Router();
const Joi    = require('joi');

const validate      = require('../../middleware/validate');
const requireAction = require('../../middleware/require-action');
const stateSvc = require('../../services/state.service');
const { modernOk, modernError } = require('../../utils/response');
const logger   = require('../../logger');

/*
 * Manage Cities → States tab. See services/state.service.js for the rule
 * (one zonal manager per state, copied onto every city of the state).
 *
 * PERMISSIONS. Every write needs isStateEdit, seeded by
 * migrations/2026-09-21-state-zonal-manager.sql for Admin / Project Manager /
 * Admin Supply (the isCityApprove set). Until that migration runs, writes are
 * 403 for everyone — the correct fail-closed direction. The GET stays ungated
 * like GET /admin/cities: reading the state master is what dropdowns do.
 *
 * This replaces the generic crudFactory mount at /admin/settings/states, which
 * had no action check and no manager rule — see routes/admin/settings.js.
 */
const requireStateEdit = requireAction('isStateEdit');

const idParam = Joi.object({ stateId: Joi.number().integer().positive().required() });
const listQuery = Joi.object({ includeInactive: Joi.boolean().default(false) });

const name = Joi.string().trim().min(2).max(100);
const code = Joi.string().trim().max(10).allow('', null);
const manager = Joi.number().integer().positive();

// A state can never be saved without a manager (decided 2026-09-21), so it is
// REQUIRED on create. On update it is optional — absent means "rename only".
const createBody = Joi.object({ state_name: name.required(), state_code: code.optional(), state_user: manager.required() });
const updateBody = Joi.object({ state_name: name.optional(), state_code: code.optional(), state_user: manager.optional() }).min(1);
const assignBody = Joi.object({
  state_ids:  Joi.array().items(Joi.number().integer().positive()).min(1).max(100).unique().required(),
  state_user: manager.required(),
});

const actor = (req) => (req.user && req.user.user_id) || null;

function fail(res, next, label, e) {
  if (e && e.status) {
    logger.warn(label + ' failed · ' + e.message);
    return modernError(res, e.status, e.message);
  }
  return next(e);
}

// ─── READ ────────────────────────────────────────────────────────────
router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    logger.info('List states · includeInactive=' + req.query.includeInactive);
    const data = await stateSvc.listStates(req.query);
    logger.info('Returning ' + data.items.length + ' states');
    modernOk(res, data);
  } catch (e) { next(e); }
});

// ─── WRITE ───────────────────────────────────────────────────────────
// Declared before /:stateId so 'assign-manager' is never read as an id.
router.post('/assign-manager', requireStateEdit, validate(assignBody), async (req, res, next) => {
  try {
    logger.info('Assign manager · manager=' + req.body.state_user + ' states=' + req.body.state_ids.length);
    const r = await stateSvc.assignManager(req.body.state_ids, req.body.state_user, actor(req));
    modernOk(res, r, `${r.manager_name} now manages ${r.states_updated} state(s) · ${r.cities_updated} cities updated`);
  } catch (e) { fail(res, next, 'Assign manager', e); }
});

router.post('/', requireStateEdit, validate(createBody), async (req, res, next) => {
  try {
    logger.info('Create state · name=' + req.body.state_name);
    const created = await stateSvc.createState(req.body, actor(req));
    res.status(201);
    modernOk(res, created, 'State added');
  } catch (e) { fail(res, next, 'Create state', e); }
});

router.patch('/:stateId', requireStateEdit, validate(idParam, 'params'), validate(updateBody), async (req, res, next) => {
  try {
    logger.info('Update state · id=' + req.params.stateId + ' fields=' + Object.keys(req.body).join(','));
    const r = await stateSvc.updateState(Number(req.params.stateId), req.body, actor(req));
    modernOk(res, r, req.body.state_user !== undefined
      ? `State saved · ${r.cities_updated} cities updated`
      : 'State saved');
  } catch (e) { fail(res, next, 'Update state', e); }
});

router.post('/:stateId/resync', requireStateEdit, validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Re-sync state · id=' + req.params.stateId);
    const r = await stateSvc.resyncState(Number(req.params.stateId), actor(req));
    modernOk(res, r, r.cities_updated
      ? `${r.cities_updated} cities brought in line with the state's manager`
      : 'Every city already matches the state\'s manager');
  } catch (e) { fail(res, next, 'Re-sync state', e); }
});

module.exports = router;
