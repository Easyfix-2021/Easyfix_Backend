const router = require('express').Router();
const Joi    = require('joi');

const validate = require('../../middleware/validate');
const { roleByName } = require('../../middleware/role');
const userService = require('../../services/user.service');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');

/*
 * /api/admin/users — Manage Users settings surface.
 *
 * Mount inherits:
 *   - requireAuth + role(['admin'])  via routes/admin/index.js
 *
 * Mutation routes additionally roleByName(['Admin']) — only the canonical
 * Admin role can create / edit / deactivate users. Other admin-group roles
 * (Finance, Project Manager, etc.) can READ for context but not mutate.
 *
 * Internal-user gate (user_type_id = 5) is enforced in the service layer.
 */

// ─── Validators ──────────────────────────────────────────────────────
const idParam = Joi.object({ userId: Joi.number().integer().positive().required() });

const listQuery = Joi.object({
  q:               Joi.string().allow('', null).optional(),
  roleId:          Joi.number().integer().positive().optional(),
  cityId:          Joi.number().integer().positive().optional(),
  includeInactive: Joi.boolean().default(false),
  limit:           Joi.number().integer().min(1).max(1000).default(200),
  offset:          Joi.number().integer().min(0).default(0),
  sortBy:          Joi.string().valid(...Object.keys(userService.SORTABLE_COLUMNS)).default('user_name'),
  sortDir:         Joi.string().lowercase().valid('asc', 'desc').default('asc'),
});

const createBody = Joi.object({
  user_name:      Joi.string().trim().min(2).max(200).required(),
  official_email: Joi.string().trim().lowercase().email().max(255).required(),
  mobile_no:      Joi.string().trim().pattern(/^[0-9]{10}$/).required(),
  alternate_no:   Joi.string().trim().pattern(/^[0-9]{10}$/).allow('', null).optional(),
  user_role:      Joi.number().integer().positive().required(),
  city_id:        Joi.number().integer().positive().allow(null).optional(),
  // RBAC scope CSVs — comma-separated id strings (legacy varchar; no
  // FK enforcement). The literal "0" is a wildcard meaning "all" —
  // see lib/scope.js. We don't validate contents beyond shape so that
  // legacy callers and bulk-imports keep working.
  manage_clients:    Joi.string().allow('', null).optional(),
  manage_cities:     Joi.string().allow('', null).optional(),
  manage_states:     Joi.string().allow('', null).optional(),
  manage_verticals:  Joi.string().allow('', null).optional(),
  reporting_manager: Joi.number().integer().positive().allow(null).optional(),
});

const updateBody = Joi.object({
  mobile_no:         Joi.string().trim().pattern(/^[0-9]{10}$/).optional(),
  alternate_no:      Joi.string().trim().pattern(/^[0-9]{10}$/).allow('', null).optional(),
  user_role:         Joi.number().integer().positive().optional(),
  city_id:           Joi.number().integer().positive().allow(null).optional(),
  manage_clients:    Joi.string().allow('', null).optional(),
  manage_cities:     Joi.string().allow('', null).optional(),
  manage_states:     Joi.string().allow('', null).optional(),
  manage_verticals:  Joi.string().allow('', null).optional(),
  reporting_manager: Joi.number().integer().positive().allow(null).optional(),
  is_active:         Joi.boolean().optional(),
}).min(1);

// ─── Bulk-update sub-router ──────────────────────────────────────────
// Mounted FIRST so the bulk routes (/bulk-lookups, /bulk-upload-template,
// /bulk-upload) resolve before the dynamic /:userId param route would
// otherwise catch them. Same Express ordering rule as /escalated,
// /action-reasons, /transaction etc.
router.use(require('./users-bulk'));

// ─── Real-time mobile uniqueness probe ──────────────────────────────
// Mounted BEFORE /:userId so Express doesn't try to parse "check-mobile"
// as an integer user id. Used by the Add/Edit User form for inline
// validation — the operator finds out a mobile is taken before clicking
// Save. Read-only, idempotent; safe for any admin-group user.
const checkMobileQuery = Joi.object({
  mobile:        Joi.string().trim().pattern(/^[0-9]{10}$/).required(),
  excludeUserId: Joi.number().integer().positive().optional(),
});
router.get('/check-mobile', validate(checkMobileQuery, 'query'), async (req, res, next) => {
  logger.info('Check mobile uniqueness · excludeUserId=' + (req.query.excludeUserId || ''));
  try {
    const result = await userService.isMobileTakenByAnother(
      req.query.mobile, req.query.excludeUserId
    );
    modernOk(res, result);
  } catch (e) { next(e); }
});

// ─── Real-time email uniqueness probe ───────────────────────────────
// Same shape as /check-mobile. When `name` is supplied AND the email is
// taken, the response also carries a `suggestion` field with the next
// free <first>.<last>[<n>]@easyfix.in slot so the FE can offer
// one-click adoption of an available address.
const checkEmailQuery = Joi.object({
  email:         Joi.string().trim().lowercase().email().max(255).required(),
  excludeUserId: Joi.number().integer().positive().optional(),
  name:          Joi.string().trim().max(200).allow('', null).optional(),
});
router.get('/check-email', validate(checkEmailQuery, 'query'), async (req, res, next) => {
  logger.info('Check email uniqueness · excludeUserId=' + (req.query.excludeUserId || '') + ' withSuggestion=' + Boolean(req.query.name));
  try {
    const result = await userService.isEmailTakenByAnother(
      req.query.email, req.query.excludeUserId, req.query.name
    );
    modernOk(res, result);
  } catch (e) { next(e); }
});

// ─── READ ────────────────────────────────────────────────────────────
router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  logger.info('List users · q=' + (req.query.q || '') + ' roleId=' + (req.query.roleId || '') + ' cityId=' + (req.query.cityId || '') + ' includeInactive=' + req.query.includeInactive + ' limit=' + req.query.limit + ' offset=' + req.query.offset);
  try {
    const data = await userService.listUsers(req.query);
    modernOk(res, data);
  } catch (e) { next(e); }
});

router.get('/:userId', validate(idParam, 'params'), async (req, res, next) => {
  logger.info('Get user · userId=' + req.params.userId);
  try {
    const row = await userService.getUserById(Number(req.params.userId));
    if (!row) return modernError(res, 404, 'User not found');
    modernOk(res, row);
  } catch (e) { next(e); }
});

// ─── Hierarchy graph — Users → Hierarchy ────────────────────────────
// Returns a tree rooted at `userId` containing every direct + indirect
// report (BFS expanded server-side via DFS over tbl_user.reporting_manager)
// plus the chain of ancestors above them. Powers the Users → Hierarchy
// graph view. The user can be looked up by id or by official_email
// before hitting this endpoint via the standard list filter.
router.get('/:userId/hierarchy', validate(idParam, 'params'), async (req, res, next) => {
  logger.info('Build user hierarchy tree · userId=' + req.params.userId);
  try {
    const tree = await userService.buildHierarchyTree(Number(req.params.userId));
    if (!tree) return modernError(res, 404, 'User not found');
    modernOk(res, tree);
  } catch (e) { next(e); }
});

// ─── WRITE ───────────────────────────────────────────────────────────
router.post('/', roleByName(['Admin']), validate(createBody), async (req, res, next) => {
  logger.info('Create user · role=' + req.body.user_role + ' cityId=' + (req.body.city_id || ''));
  try {
    const created = await userService.createUser({
      ...req.body,
      createdBy: req.user?.user_id,
    });
    res.status(201);
    logger.info('User created · userId=' + (created && (created.user_id || created.id)));
    modernOk(res, created, 'User added');
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

router.patch('/:userId',
  roleByName(['Admin']),
  validate(idParam, 'params'),
  validate(updateBody),
  async (req, res, next) => {
    logger.info('Update user · userId=' + req.params.userId + ' fields=' + Object.keys(req.body).join(','));
    try {
      const updated = await userService.updateUser(
        Number(req.params.userId), req.body, req.user?.user_id
      );
      if (!updated) return modernError(res, 404, 'User not found');
      logger.info('User updated · userId=' + req.params.userId);
      modernOk(res, updated, 'User updated');
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  }
);

/*
 * POST /api/admin/users/bulk-update
 *
 * Apply the same scope fields to N users in one shot — drives the
 * "Select Users & Apply" tab of the Bulk Update modal on Manage Users.
 *
 * Body:
 *   {
 *     userIds: [121, 122, 123],
 *     fields:  {
 *       manage_verticals: "1,4,6" | "0",   // "0" = All
 *       manage_clients:   "5,10,12" | "0",
 *       manage_states:    "1,2" | "0",
 *       manage_cities:    "5,12,28" | "0",
 *       reporting_manager: 22,             // user_id (single)
 *       city_id:           5,              // Home City (single)
 *     }
 *   }
 *
 * Only fields present in `fields` are touched. Mandatory rule from ops:
 * if `manage_verticals` is being changed, `manage_clients` MUST also
 * be supplied (non-empty / "0"). Prevents the bug where ops narrows
 * the vertical but forgets to re-pick clients, leaving the user with
 * the old client list under a new vertical.
 *
 * Returns per-user results so the UI can surface partial failures.
 */
const bulkUpdateBody = Joi.object({
  userIds: Joi.array().items(Joi.number().integer().positive()).min(1).max(500).required(),
  fields: Joi.object({
    manage_verticals:  Joi.string().allow('', null).optional(),
    manage_clients:    Joi.string().allow('', null).optional(),
    manage_states:     Joi.string().allow('', null).optional(),
    manage_cities:     Joi.string().allow('', null).optional(),
    reporting_manager: Joi.number().integer().positive().allow(null).optional(),
    city_id:           Joi.number().integer().positive().allow(null).optional(),
    // Role is validated by userService.updateUser — it rejects
    // non-admin-group roles with a 400 — so we only enforce shape
    // here. Joi.integer().positive keeps obvious garbage out.
    user_role:         Joi.number().integer().positive().optional(),
  }).min(1).required(),
});
router.post('/bulk-update', roleByName(['Admin']), validate(bulkUpdateBody), async (req, res, next) => {
  try {
    const { userIds, fields } = req.body;
    logger.info('Bulk-update users · userIds=' + userIds.length + ' fields=' + Object.keys(fields).join(','));

    // Vertical-without-client guard. `manage_verticals` being touched
    // requires `manage_clients` to be co-supplied (any value, including
    // "0" / "All"). Returns 400 BEFORE any DB write so the caller fixes
    // their form rather than rolling back N successful rows.
    if (Object.prototype.hasOwnProperty.call(fields, 'manage_verticals')
        && !Object.prototype.hasOwnProperty.call(fields, 'manage_clients')) {
      return modernError(
        res, 400,
        'When manage_verticals is changed, manage_clients must also be supplied (use "0" for All).',
      );
    }

    const results = [];
    let updated = 0; let failed = 0; let unchanged = 0;
    for (const userId of userIds) {
      try {
        const result = await userService.updateUser(Number(userId), fields, req.user?.user_id);
        if (result && result.__unchanged) {
          unchanged++;
          results.push({ userId, status: 'unchanged' });
        } else {
          updated++;
          results.push({ userId, status: 'updated' });
        }
      } catch (e) {
        failed++;
        results.push({
          userId,
          status: 'failed',
          error: e.status ? e.message : 'update failed',
        });
      }
    }
    logger.info('Bulk-update complete · updated=' + updated + ' unchanged=' + unchanged + ' failed=' + failed + ' total=' + userIds.length);
    modernOk(res, {
      summary: { total: userIds.length, updated, unchanged, failed },
      results,
    }, 'Bulk update complete');
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

router.delete('/:userId', roleByName(['Admin']), validate(idParam, 'params'), async (req, res, next) => {
  logger.info('Deactivate user · userId=' + req.params.userId);
  try {
    const ok = await userService.deactivateUser(Number(req.params.userId), req.user?.user_id);
    if (!ok) return modernError(res, 404, 'User not found');
    logger.info('User deactivated · userId=' + req.params.userId);
    modernOk(res, { deactivated: true });
  } catch (e) { next(e); }
});

module.exports = router;
