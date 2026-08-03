const router = require('express').Router();
const Joi    = require('joi');

const validate = require('../../middleware/validate');
const { roleByName } = require('../../middleware/role');
const userService = require('../../services/user.service');
const entraProvisioning = require('../../services/entra-provisioning.service');
const { STAGE_KEYS } = require('../../lib/job-stages');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');

/*
 * Job Stage Access field — an array of stage keys (each one of the 9 canonical
 * keys in lib/job-stages.js). Three distinct values, all meaningful:
 *
 *   NULL              → ALL / unrestricted (the service stores NO rows)
 *   []                → explicit NO ACCESS (the service stores a sentinel row)
 *   ['unconfirmed',…] → restricted to those stages
 *   ABSENT (on PATCH) → no change
 *
 * `.allow(null)` is therefore load-bearing, not cosmetic: without it the only
 * way to express "unrestricted" would be [], which now means the opposite.
 * Reused across create/update/bulk.
 */
const allowedStagesField = Joi.array().items(Joi.string().valid(...STAGE_KEYS)).allow(null).optional();

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
  /*
   * OPTIONAL as of 2026-08-03 (was .required()). tbl_user.mobile_no is nullable
   * and 7 active users already have none, so nothing downstream assumes it.
   * The FORMAT is still enforced: supply a mobile and it must be 10 digits —
   * only the presence requirement was dropped, so a typo still fails rather
   * than silently storing a half-number.
   *
   * ⚠ LOGIN CONSEQUENCE, deliberately accepted: sign-in is OTP-only via email
   * OR mobile. A user with no mobile can only receive an OTP by email, so if
   * their @easyfix.in mailbox does not exist they cannot log in at all. Keep
   * that in mind for anyone created without one.
   */
  mobile_no:      Joi.string().trim().pattern(/^[0-9]{10}$/).allow('', null).optional(),
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
  allowed_stages:    allowedStagesField,
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
  allowed_stages:    allowedStagesField,
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
    /*
     * PROVISIONING RUNS FOR EVERY USER CREATED HERE — no per-person allowlist.
     *
     * It briefly did carry one (emailAllowed(FEATURES.canProvisionMailboxes)),
     * added on the theory that spending a licence seat deserved a gate narrower
     * than the route's own roleByName(['Admin']). That was wrong twice over:
     *
     *  1. WRONG BOUNDARY. A mailbox is part of creating a staff user, not a
     *     separate privilege. Whoever is trusted to create the CRM account is
     *     trusted to create its mailbox; anything else half-creates a person.
     *  2. FAILED CLOSED, SILENTLY. emailAllowed() returns false for an UNSET
     *     property, so with access.entraprovision.emails empty — its state in
     *     production — EVERY Add User recorded skipped_not_allowed and no
     *     mailbox was ever made. Observed on user 8735
     *     (vijay.nailwal@easyfix.in, 2026-08-03): CRM row created, Entra
     *     account absent, and nobody noticed until the user could not log in.
     *     A gate whose default is "nobody" turns an opt-in feature into a
     *     silent no-op.
     *
     * The real containment boundary is the roleByName(['Admin']) already on
     * this route, plus entra.provisioning.enabled as the master switch. Those
     * are the two things that decide whether a directory write happens.
     */
    const created = await userService.createUser({
      ...req.body,
      createdBy: req.user?.user_id,
    });
    res.status(201);
    /*
     * `created.provisioning` is attached by userService.createUser — the
     * Microsoft 365 mailbox outcome. It rides along on the SUCCESS payload and
     * deliberately does NOT influence the status code: the CRM user was
     * created either way (that is today's contract), we are only making a
     * missing mailbox visible instead of silent. With the feature flag off it
     * reads { accountStatus: 'skipped_disabled', … }.
     */
    const prov = created && created.provisioning;
    logger.info('User created · userId=' + (created && (created.user_id || created.id))
      + (prov ? ' · mailbox=' + prov.accountStatus + '/' + prov.licenceStatus : ''));
    let message = 'User added';
    if (prov && prov.pending) {
      // Provisioning outran the inline deadline and is finishing detached — the
      // outcome lands in tbl_user_entra_provisioning, readable from
      // GET /api/admin/users/:userId/provisioning.
      message = 'User added — Microsoft 365 mailbox provisioning is still running; check the Provisioning panel shortly';
    } else if (prov && prov.attempted && !prov.mailboxReady) {
      message = 'User added — but the Microsoft 365 mailbox is NOT ready: ' + (prov.reason || 'see provisioning outcome');
    }
    modernOk(res, created, message);
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
    // Job Stage Access — optional here too so ops can apply the same stage
    // set to N users at once. Same tri-state as the single-user routes:
    // null = unrestricted, [] = no access, non-empty = restricted.
    allowed_stages:    allowedStagesField,
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

/*
 * ── Microsoft 365 mailbox provisioning ───────────────────────────────
 *
 * GET  /api/admin/users/:userId/provisioning        — read the recorded state
 * POST /api/admin/users/:userId/provision-mailbox   — (re)provision / repair
 *
 * WHY THE POST EXISTS: creating the CRM user is what SHOULD create the
 * mailbox, but that step can fail on its own (Graph down, no licence seat,
 * consent not granted yet) and re-creating the CRM user is not an option — the
 * row is referenced by tbl_job audit columns. This endpoint is the repair
 * path. It is what fixes the reported case (user_id 8710, ankitjha@easyfix.in,
 * Project Manager, mailbox never created) without anyone touching tbl_user.
 *
 * IDEMPOTENT: the service looks the account up in the directory before
 * creating, so a second click records 'already_exists' and moves on to the
 * licence check rather than making a duplicate account. Safe to click twice.
 *
 * GATING — two layers, both of which must pass:
 *   1. requireAuth + role(['admin'])   (inherited from routes/admin/index.js)
 *   2. roleByName(['Admin'])           the same guard every other mutating
 *                                      route in this file uses, and the same
 *                                      one Add User uses to provision
 * A third per-person allowlist layer was tried and REMOVED (2026-08-03): it
 * fails closed on an unset property, and the property is unset in production,
 * so it silently denied everyone — including the recovery path for the users it
 * had already caused to be created without a mailbox.
 * The SERVICE remains fail-closed on
 * easyfix_properties['entra.provisioning.enabled'] (default 'false'), so an
 * Admin gets a recorded "skipped: feature disabled" until someone deliberately
 * turns the feature on. THAT is the master switch.
 */
router.get('/:userId/provisioning',
  roleByName(['Admin']),
  validate(idParam, 'params'),
  async (req, res, next) => {
    logger.info('Read mailbox provisioning state · userId=' + req.params.userId);
    try {
      const user = await userService.getUserById(Number(req.params.userId));
      if (!user) return modernError(res, 404, 'User not found');
      const state = await entraProvisioning.getProvisioning(Number(req.params.userId));
      modernOk(res, {
        user_id: user.user_id,
        official_email: user.official_email,
        // null = provisioning has never been recorded for this user at all
        // (the row predates this feature). That is itself the answer an
        // operator needs, so we return it rather than 404-ing.
        provisioning: state,
        feature_enabled: entraProvisioning.provisioningEnabled(),
        sku_part_number: entraProvisioning.configuredSkuPartNumber() || null,
      });
    } catch (e) { next(e); }
  }
);

/*
 * Guarded by roleByName(['Admin']) only — the SAME authority as Add User, which
 * now provisions unconditionally. The per-person
 * requirePropertyAllowlist(FEATURES.canProvisionMailboxes) that used to sit here
 * was removed for two reasons:
 *
 *  - INCONSISTENT: an Admin could cause the identical directory write by simply
 *    creating a user, but got a 403 when repairing one. The allowlist bought no
 *    containment, only confusion.
 *  - IT DEADLOCKED THE RECOVERY PATH: the allowlist fails closed on an unset
 *    property, and it IS unset in production — so the endpoint documented as the
 *    fix for a missing mailbox could not be called by anyone, including the
 *    people whose users were affected.
 *
 * The action is idempotent (an existing account resolves to already_exists and
 * spends no extra seat), so repeated calls cannot over-consume licences.
 */
router.post('/:userId/provision-mailbox',
  roleByName(['Admin']),
  validate(idParam, 'params'),
  async (req, res, next) => {
    const userId = Number(req.params.userId);
    logger.info('Provision mailbox requested · userId=' + userId + ' · actorId=' + (req.user?.user_id || ''));
    try {
      const user = await userService.getUserById(userId);
      if (!user) return modernError(res, 404, 'User not found');

      const outcome = await entraProvisioning.provisionUserMailbox({
        userId,
        userName: user.user_name,
        officialEmail: user.official_email,
        trigger: 'admin-retry',
        actorId: req.user?.user_id,
      });

      // 200 either way — the caller asked us to TRY, and the outcome (including
      // "the licence step failed, here is exactly why") is the payload. A 5xx
      // would hide the reason behind the generic error handler.
      const msg = outcome.mailboxReady
        ? 'Mailbox is ready (' + outcome.accountStatus + ' / ' + outcome.licenceStatus + ')'
        : 'Mailbox NOT ready — ' + (outcome.reason || outcome.accountStatus + ' / ' + outcome.licenceStatus);
      logger.info('Provision mailbox result · userId=' + userId + ' · ' + msg);
      modernOk(res, { user_id: userId, official_email: user.official_email, provisioning: outcome }, msg);
    } catch (e) { next(e); }
  }
);

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
