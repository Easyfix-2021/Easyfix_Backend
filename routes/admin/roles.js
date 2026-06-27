const router = require('express').Router();
const Joi    = require('joi');

const validate = require('../../middleware/validate');
const { roleByName } = require('../../middleware/role');
const roleService = require('../../services/role.service');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');

/*
 * /api/admin/roles — Manage Roles settings surface.
 *
 * Mount inherits requireAuth + role(['admin']) at routes/admin/index.js.
 * Mutation routes additionally roleByName(['Admin']) so only canonical
 * Admins (role_id 2) can edit the role table itself — that's a privilege-
 * escalation surface and must not be open to every admin-group role.
 *
 * NOTE: Group classification (admin/client/mobile/default) is NOT editable
 * from this UI. It's a code-level mapping in ROLE_ID_TO_GROUP because the
 * group decides which route mount the role can hit — flipping a role from
 * 'client' to 'admin' from a form would be a real-time security event.
 * Adding a new role_id therefore requires (a) creating the row through
 * this UI, then (b) a code change to register its group, then (c) deploy.
 */

// ─── Validators ──────────────────────────────────────────────────────
const idParam = Joi.object({ roleId: Joi.number().integer().positive().required() });

const listQuery = Joi.object({
  q:               Joi.string().allow('', null).optional(),
  includeInactive: Joi.boolean().default(false),
  limit:           Joi.number().integer().min(1).max(1000).default(200),
  offset:          Joi.number().integer().min(0).default(0),
  sortBy:          Joi.string().valid(...Object.keys(roleService.SORTABLE_COLUMNS)).default('role_name'),
  sortDir:         Joi.string().lowercase().valid('asc', 'desc').default('asc'),
});

// menu_ids / menu_action_ids are int arrays validated for shape only. The
// service layer dedupes + sorts and tolerates junk (legacy data is messy).
const idArray = Joi.array().items(Joi.number().integer().positive()).default([]);

const createBody = Joi.object({
  role_name:       Joi.string().trim().min(2).max(100).required(),
  role_desc:       Joi.string().trim().max(500).allow('', null).optional(),
  menu_ids:        idArray.optional(),
  menu_action_ids: idArray.optional(),
});

const updateBody = Joi.object({
  role_name:       Joi.string().trim().min(2).max(100).optional(),
  role_desc:       Joi.string().trim().max(500).allow('', null).optional(),
  is_active:       Joi.boolean().optional(),
  // Explicitly nullable on update: passing `[]` clears all menu/action perms,
  // matching the legacy "save with nothing checked" behaviour.
  menu_ids:        Joi.array().items(Joi.number().integer().positive()).optional(),
  menu_action_ids: Joi.array().items(Joi.number().integer().positive()).optional(),
}).min(1);

// ─── READ ────────────────────────────────────────────────────────────
router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    logger.info('List roles · q=' + (req.query.q ?? '-') + ' includeInactive=' + req.query.includeInactive + ' limit=' + req.query.limit + ' offset=' + req.query.offset);
    const data = await roleService.listRoles(req.query);
    logger.info('Returning ' + (data?.items?.length ?? data?.length ?? 0) + ' roles');
    modernOk(res, data);
  } catch (e) { next(e); }
});

router.get('/:roleId', validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Get role · roleId=' + req.params.roleId);
    const row = await roleService.getRoleByIdFull(Number(req.params.roleId));
    if (!row) { logger.warn('Role not found · roleId=' + req.params.roleId); return modernError(res, 404, 'Role not found'); }
    modernOk(res, row);
  } catch (e) { next(e); }
});

// ─── WRITE ───────────────────────────────────────────────────────────
router.post('/', roleByName(['Admin']), validate(createBody), async (req, res, next) => {
  try {
    logger.info('Create role · name=' + req.body.role_name + ' menus=' + (req.body.menu_ids?.length ?? 0) + ' actions=' + (req.body.menu_action_ids?.length ?? 0));
    const created = await roleService.createRole({
      ...req.body,
      createdBy: req.user?.user_id,
    });
    logger.info('Role created · roleId=' + (created?.role_id ?? created?.id ?? '-'));
    res.status(201);
    modernOk(res, created, 'Role added');
  } catch (e) {
    if (e.status) { logger.warn('Create role failed · ' + e.message); return modernError(res, e.status, e.message); }
    next(e);
  }
});

router.patch('/:roleId',
  roleByName(['Admin']),
  validate(idParam, 'params'),
  validate(updateBody),
  async (req, res, next) => {
    try {
      logger.info('Update role · roleId=' + req.params.roleId + ' fields=' + Object.keys(req.body).join(','));
      const updated = await roleService.updateRole(
        Number(req.params.roleId), req.body, req.user?.user_id
      );
      if (!updated) { logger.warn('Role not found · roleId=' + req.params.roleId); return modernError(res, 404, 'Role not found'); }
      logger.info('Role updated · roleId=' + req.params.roleId);
      modernOk(res, updated, 'Role updated');
    } catch (e) {
      if (e.status) { logger.warn('Update role failed · roleId=' + req.params.roleId + ' · ' + e.message); return modernError(res, e.status, e.message); }
      next(e);
    }
  }
);

router.delete('/:roleId', roleByName(['Admin']), validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Deactivate role · roleId=' + req.params.roleId);
    const ok = await roleService.deactivateRole(Number(req.params.roleId));
    if (!ok) { logger.warn('Role not found · roleId=' + req.params.roleId); return modernError(res, 404, 'Role not found'); }
    logger.info('Role deactivated · roleId=' + req.params.roleId);
    modernOk(res, { deactivated: true });
  } catch (e) {
    if (e.status) { logger.warn('Deactivate role failed · roleId=' + req.params.roleId + ' · ' + e.message); return modernError(res, e.status, e.message); }
    next(e);
  }
});

module.exports = router;
