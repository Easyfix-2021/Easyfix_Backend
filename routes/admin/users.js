const router = require('express').Router();
const Joi    = require('joi');

const validate = require('../../middleware/validate');
const { roleByName } = require('../../middleware/role');
const userService = require('../../services/user.service');
const entraProvisioning = require('../../services/entra-provisioning.service');
// "Your EasyFix account is ready" — the sign-in-details mail. Used by the
// mailbox-repair endpoint below; the create path calls it from the service.
const welcomeMail = require('../../services/user-welcome-mail.service');
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
 * PERSONAL EMAIL — stored in tbl_user_personal_details (an EasyFix-owned side
 * table; tbl_user is legacy and must not gain columns). It is where the
 * "your EasyFix account is ready" credential mail goes, because a brand-new
 * Microsoft 365 mailbox cannot be its own delivery address.
 *
 * REQUIREDNESS MATRIX — enforced HERE and, independently, in
 * services/user.service.js. Both layers, on purpose: requiredness lives in two
 * places in this codebase and the deeper one silently wins. Loosening only the
 * Joi schema is exactly what made mobile_no keep answering "required" from a
 * form that showed it as optional.
 *
 *   Add User                          → REQUIRED   (expressible in Joi: below)
 *   Edit an ACTIVE user               → REQUIRED   ┐ depends on the TARGET ROW's
 *   Edit an INACTIVE user             → optional   ├ status, which is a DB fact,
 *   The edit that DEACTIVATES a user  → optional   ┘ not a payload fact — so the
 *                                                    PATCH handler checks it
 *                                                    explicitly, using the same
 *                                                    exported predicate the
 *                                                    service uses.
 */
const personalEmailCreateField = Joi.string().trim().lowercase().email().max(255).required();
// On PATCH the FORMAT is enforced by Joi; PRESENCE is decided by the handler
// below (and again by the service). '' / null mean "clear it", which is only
// reachable for a user the matrix exempts.
const personalEmailUpdateField = Joi.string().trim().lowercase().email().max(255).allow('', null).optional();

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
  personal_email:    personalEmailCreateField,
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
  personal_email:    personalEmailUpdateField,
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

/*
 * ─── Microsoft 365 availability PRE-FLIGHT ──────────────────────────
 *
 * POST /api/admin/users/check-official-email
 *   { email } → { available: true,  email, taken: false }
 *             → { available: false, email, taken, suggested, reason }
 *
 * `taken` IS NOT `!available`, and that is the whole reason it is published.
 * available:false covers two facts an operator has to be told apart: "Microsoft
 * 365 already has this address" (taken:true — pick the suggestion) and "the
 * directory could not tell us" (taken:false — a 403 before consent, a 429, a
 * timeout, or a domain we do not own; nothing is wrong with the address). They
 * need different words in front of a person, and the FE cannot derive one from
 * the other. Do not collapse them back into one flag.
 *
 * WHY BEFORE THE CREATE, NOT DURING IT. Add User writes the tbl_user row and
 * only then provisions, so discovering the collision mid-create would leave an
 * orphan CRM row whose official_email can never get a mailbox. The operator has
 * to be able to accept the suggested numbered address BEFORE anything is
 * written — "first check … then proceed … then save in DB accordingly".
 *
 * ⚠ THIS IS NOT THE GUARD. A pre-flight the client is free to skip guards
 * nothing; it is a courtesy that makes the good path pleasant. The actual guard
 * is in decideAccountAction(), which refuses to reuse a directory object that is
 * not recorded against this user_id no matter what the client did or did not
 * ask first.
 *
 * SEPARATE FROM GET /check-email above, which asks a different question of a
 * different system: that one is "is this address on another tbl_user row",
 * this one is "does Microsoft 365 already have a mailbox here". Both can be
 * true independently — a CRM row can exist with no mailbox (the whole reason
 * tbl_user_entra_provisioning exists) and a mailbox can exist with no CRM row.
 *
 * Same authority as POST / (create user): only the canonical Admin role, which
 * is who can act on the answer. Read-only — it performs no directory write.
 */
const checkOfficialEmailBody = Joi.object({
  email: Joi.string().trim().lowercase().email().max(255).required(),
});
router.post('/check-official-email',
  roleByName(['Admin']),
  validate(checkOfficialEmailBody),
  async (req, res, next) => {
    logger.info('Check official email availability · domainOnly=' + String(req.body.email).split('@')[1]);
    try {
      const check = await entraProvisioning.isUpnAvailable(req.body.email);
      // `taken: false` on the free path too, so the shape is the same on both
      // branches and a client never has to treat the key as maybe-absent.
      if (check.available) return modernOk(res, { available: true, email: check.email, taken: false });

      /*
       * A numbered variant is only meaningful when the address is DEFINITIVELY
       * taken. When the check came back unavailable because the directory could
       * not answer (403 before consent, 429, a timeout) or because the domain is
       * not one we own, suggesting mohit.kumar2@ would be inventing an answer on
       * top of a non-answer — `suggested` stays null and the reason says why.
       */
      let suggested = null;
      let reason = check.reason;
      if (check.taken) {
        const s = await entraProvisioning.suggestAvailableUpn(check.email);
        suggested = s.suggested;
        if (!suggested && s.reason) reason = check.reason + ' — ' + s.reason;
      }
      logger.info('Official email NOT available · taken=' + (check.taken ? 'yes' : 'no')
        + ' · suggested=' + (suggested ? 'yes' : 'no'));
      modernOk(res, { available: false, email: check.email, taken: !!check.taken, suggested, reason });
    } catch (e) { next(e); }
  }
);

/*
 * Is the CALLER the canonical Admin role (as opposed to any other member of the
 * `admin` GROUP)? `req.userRole` is resolved once by the group guard mounted in
 * routes/admin/index.js, so this costs nothing extra.
 */
function isAdminRole(req) {
  return String(req.userRole?.role_name || '').trim().toLowerCase() === 'admin';
}

// ─── READ ────────────────────────────────────────────────────────────
router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  logger.info('List users · q=' + (req.query.q || '') + ' roleId=' + (req.query.roleId || '') + ' cityId=' + (req.query.cityId || '') + ' includeInactive=' + req.query.includeInactive + ' limit=' + req.query.limit + ' offset=' + req.query.offset);
  try {
    /*
     * personal_email is included ONLY for the Admin role. This route carries no
     * roleByName guard — every one of the ten admin-group roles can read it —
     * but only Admin can create or edit a user, so only Admin can act on a
     * missing address. Shipping the home email of ~7.5k staff in a single
     * limit=1000 page to roles that cannot use it is a bulk-harvest surface with
     * no corresponding feature. The edit form reads the value from
     * GET /:userId, so nothing here regresses.
     */
    const data = await userService.listUsers({ ...req.query, includePersonalEmail: isAdminRole(req) });
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
    /*
     * `created.welcome_mail` is the sign-in-details mail outcome, attached by
     * userService.createUser next to `provisioning` and shaped
     * { status: 'sent'|'skipped'|'failed'|'pending', reason, to?, cc? }. It is
     * reported, never fatal: a mail failure does not undo a created user. It
     * NEVER carries the temporary password — that value reaches the mail body
     * and nothing else (see services/user-welcome-mail.service.js).
     */
    const mail = created && created.welcome_mail;
    logger.info('User created · userId=' + (created && (created.user_id || created.id))
      + (prov ? ' · mailbox=' + prov.accountStatus + '/' + prov.licenceStatus : '')
      + (mail ? ' · welcomeMail=' + mail.status : ''));
    let message = 'User added';
    if (prov && prov.pending) {
      // Provisioning outran the inline deadline and is finishing detached — the
      // outcome lands in tbl_user_entra_provisioning, readable from
      // GET /api/admin/users/:userId/provisioning.
      message = 'User added — Microsoft 365 mailbox provisioning is still running; check the Provisioning panel shortly';
    } else if (prov && prov.attempted && !prov.mailboxReady) {
      message = 'User added — but the Microsoft 365 mailbox is NOT ready: ' + (prov.reason || 'see provisioning outcome');
    } else if (mail && mail.status === 'sent') {
      message = 'User added — sign-in details emailed to ' + mail.to
        + (mail.cc && mail.cc.length ? ' (cc ' + mail.cc.join(', ') + ')' : '');
    } else if (mail && mail.status === 'failed') {
      message = 'User added and the mailbox is ready, but the sign-in details could NOT be emailed: ' + mail.reason;
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
      /*
       * ── personal_email presence, per the matrix at the top of this file ──
       * Joi already enforced the FORMAT; whether the field is MANDATORY depends
       * on the target row's current status, which Joi cannot see. We resolve the
       * row once (it also gives us the crisp 404) and apply the SAME predicate
       * the service applies, so route and service can never drift.
       *
       * `target.personal_email` is the fail-soft side-table read inside
       * getUserById, so an active user who already has one on record is not
       * forced to re-send it — "required" here means the row must not be LEFT
       * without one.
       */
      const target = await userService.getUserById(Number(req.params.userId));
      if (!target) return modernError(res, 404, 'User not found');
      if (userService.isPersonalEmailRequiredOnUpdate(target.user_status, req.body.is_active)) {
        const effective = req.body.personal_email !== undefined
          ? String(req.body.personal_email || '').trim()
          : String(target.personal_email || '').trim();
        if (!effective) {
          logger.warn('Update user rejected · personal_email required for an active user · userId=' + req.params.userId);
          return modernError(res, 400, 'personal_email is required when editing an active user');
        }
      }

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
        /*
         * enforcePersonalEmail: false — see the matrix at the top of this file.
         * The rule governs the Add/Edit User FORM. This modal applies scope
         * CSVs / manager / role to up to 500 EXISTING users and has no
         * personal_email field, so enforcing it here would not collect a single
         * address; it would only make every active user who lacks one today
         * impossible to bulk-update.
         */
        const result = await userService.updateUser(
          Number(userId), fields, req.user?.user_id, { enforcePersonalEmail: false },
        );
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

      /*
       * ── THE TEMP PASSWORD, on the REPAIR path ─────────────────────────
       * This endpoint exists to rescue a CRM row whose Entra account is absent
       * (user 8735 / vijay.nailwal@easyfix.in is the case that prompted it).
       * That is the CREATE branch inside provisionUserMailbox, so it mints a
       * fresh 20-char CSPRNG password — and without a sink it would generate it,
       * hand it to Graph and drop it, leaving the operator with a green "Mailbox
       * is ready" and a user who still cannot sign in. That is precisely the
       * dead end this feature was built to close, so the repair route sinks the
       * password and mails it exactly like Add User does.
       *
       * Same containment as the create path: a local for the life of the
       * request, handed straight to the mail sender, nulled after. Never logged,
       * never bound into SQL, never on the response — `mail` below carries only
       * { status, reason, to?, cc? }. It is now held for as long as the licence
       * read-back waits (up to licenceVerifyBudgetMs(), ~90s) rather than ~4s, which
       * changes the DURATION and nothing else: still one local, still nulled in
       * the `finally` on every path including the throwing one.
       *
       * ── WHY THIS PATH IS RACED, NOT JUST AWAITED ──────────────────────────
       * The licence read-back now backs off exponentially for ~90s so an
       * eventually-consistent Graph write is actually observed (the user-8805
       * incident: we gave up 1.2s in). Awaiting that inline would turn an admin
       * click into a 90-second request and die at the proxy — the same 504 the
       * create path's deadline exists to avoid.
       *
       * The alternative was to give the REPAIR path its own short budget, and
       * that is the wrong trade: this endpoint is the rescue, and its create
       * branch is the ONLY one that mints a credential for a user whose first
       * run failed. Cutting its patience short would recreate the exact
       * stranding it exists to fix. So it gets the same treatment the create
       * path already has — respond at the deadline, keep provisioning (and the
       * chained mail, with the password still in this closure) running.
       */
      let tempPassword = null;
      const running = entraProvisioning.provisionUserMailbox({
        userId,
        userName: user.user_name,
        officialEmail: user.official_email,
        trigger: 'admin-retry',
        actorId: req.user?.user_id,
        onTempPassword: (pw) => { tempPassword = pw; },
      }).then(async (outcome) => {
        /*
         * Fail-soft, and gated on mailboxReady inside the service — an account
         * with no licence has no mailbox, so no credential mail goes out for it.
         * An already-existing account mints nothing, so GATE 3 reports 'skipped'
         * and tells the operator to reset from the M365 admin centre.
         */
        let mail;
        try {
          mail = await welcomeMail.sendWelcomeMail({
            userId,
            userName: user.user_name,
            officialEmail: user.official_email,
            personalEmail: user.personal_email,
            tempPassword,
            provisioning: outcome,
          });
        } catch (e) {
          mail = { status: welcomeMail.MAIL_STATUS.FAILED, reason: e.message };
        } finally {
          tempPassword = null; // done with it — do not retain past the send
        }
        return { outcome, mail };
      }).catch((e) => {
        /*
         * `.catch` on the promise itself, not only the route's try/catch: past
         * the deadline this promise is unawaited, and an unhandled rejection
         * takes the process down on Node 18+.
         */
        tempPassword = null;
        logger.warn('Mailbox provisioning threw on the repair path · userId=' + userId + ' · ' + e.message);
        return {
          outcome: { attempted: true, accountStatus: 'failed', licenceStatus: 'not_attempted', mailboxReady: false, reason: e.message },
          mail: { status: welcomeMail.MAIL_STATUS.SKIPPED, reason: 'mailbox provisioning failed, so no credentials were issued' },
        };
      });

      const settled = await userService.withProvisionInlineDeadline(running);
      if (settled.timedOut) {
        const pending = 'Still provisioning after ' + userService.PROVISION_INLINE_DEADLINE_MS
          + 'ms — it is STILL RUNNING, not abandoned. If it completes, the sign-in details are emailed '
          + 'automatically; read the outcome from GET /api/admin/users/' + userId + '/provisioning';
        logger.warn('Provision mailbox exceeded the inline deadline — continuing in the background · userId='
          + userId + ' · deadlineMs=' + userService.PROVISION_INLINE_DEADLINE_MS);
        return modernOk(res, {
          user_id: userId,
          official_email: user.official_email,
          provisioning: {
            attempted: true, pending: true, accountStatus: 'pending',
            licenceStatus: 'pending', mailboxReady: false, reason: pending,
          },
          welcome_mail: {
            status: welcomeMail.MAIL_STATUS.PENDING,
            reason: 'waiting on mailbox provisioning — the sign-in details are mailed automatically if it completes',
          },
        }, pending);
      }
      const { outcome, mail } = settled.value;

      // 200 either way — the caller asked us to TRY, and the outcome (including
      // "the licence step failed, here is exactly why") is the payload. A 5xx
      // would hide the reason behind the generic error handler.
      let msg = outcome.mailboxReady
        ? 'Mailbox is ready (' + outcome.accountStatus + ' / ' + outcome.licenceStatus + ')'
        : 'Mailbox NOT ready — ' + (outcome.reason || outcome.accountStatus + ' / ' + outcome.licenceStatus);
      if (mail.status === welcomeMail.MAIL_STATUS.SENT) {
        msg += ' — sign-in details emailed to ' + mail.to
          + (mail.cc && mail.cc.length ? ' (cc ' + mail.cc.join(', ') + ')' : '');
      } else if (outcome.mailboxReady) {
        // Only worth saying when the mailbox IS ready: otherwise "no mail" is a
        // consequence of the line above, not a second thing to fix.
        msg += mail.status === welcomeMail.MAIL_STATUS.FAILED
          ? ' — but the sign-in details could NOT be emailed: ' + mail.reason
          : ' — no sign-in details were emailed: ' + mail.reason;
      }
      logger.info('Provision mailbox result · userId=' + userId + ' · ' + msg + ' · welcomeMail=' + mail.status);
      modernOk(res, {
        user_id: userId,
        official_email: user.official_email,
        provisioning: outcome,
        welcome_mail: mail,
      }, msg);
    } catch (e) { next(e); }
  }
);

/*
 * ── POST /api/admin/users/:userId/reset-mailbox-password ─────────────
 *
 * THE STRANDED-USER RESCUE. The welcome mail needs a mailbox AND a password in
 * the same run, and a user whose first attempt failed after account creation can
 * never have both: run 1 minted the password but had no mailbox yet, and every
 * later run takes the REUSE branch, which mints nothing. mohit.kumar@easyfix.in
 * is the case — account created, licence unconfirmed, retried 36 minutes later
 * and completed cleanly, and not one credential mail was ever sent. No number of
 * Provision Mailbox clicks can fix that, because the missing thing is a
 * credential, not a mailbox.
 *
 * ⚠ A SEPARATE, EXPLICITLY NAMED ACTION — never folded into Provision Mailbox.
 * This resets a live account's password. Doing it silently as part of a retry
 * would lock out anyone already signed in to Outlook or Teams, so it has to be a
 * deliberate click on a control that says what it does.
 *
 * Same authority as every other mutating route here (roleByName(['Admin']) on
 * top of the mount's requireAuth + role(['admin'])). Logged with the actor id
 * on entry and on completion: resetting somebody's password is an audited act.
 *
 * The password lives ONLY in a local for the life of the send, exactly as the
 * create and repair paths do. It is never logged, never bound into SQL and
 * never on the response — `welcomeMail` carries { status, reason } only.
 */
router.post('/:userId/reset-mailbox-password',
  roleByName(['Admin']),
  validate(idParam, 'params'),
  async (req, res, next) => {
    const userId = Number(req.params.userId);
    const actorId = req.user?.user_id;
    logger.info('Mailbox password reset requested · userId=' + userId + ' · actorId=' + (actorId || ''));
    try {
      const user = await userService.getUserById(userId);
      if (!user) return modernError(res, 404, 'User not found');

      // The master switch. Off means we do not touch the directory at all —
      // same fail-closed rule the provisioning service applies.
      if (!entraProvisioning.provisioningEnabled()) {
        return modernError(res, 400, 'Microsoft 365 provisioning is turned off on this environment, so no mailbox password can be reset.');
      }

      /*
       * The DB-only refusals come first, so the common "there is nothing to
       * reset" cases cost no Graph round-trip.
       */
      const state = await entraProvisioning.getProvisioning(userId);
      if (!state || !state.entra_object_id) {
        return modernError(res, 400, 'No Microsoft 365 account is recorded for this user — run Provision Mailbox first, which creates the account and emails the sign-in details itself.');
      }
      if (!state.mailbox_ready) {
        return modernError(res, 400, 'The mailbox is not ready (account=' + state.account_status
          + ' / licence=' + state.licence_status + ') — a password is no use without a mailbox to sign in to. Run Provision Mailbox first.');
      }

      /*
       * OWNERSHIP. Resetting a password is only safe against the object we know
       * belongs to THIS user: if the address now resolves to a different object
       * (or the directory cannot say), a reset would change a stranger's
       * password. Same rule decideAccountAction applies before a create, applied
       * again here because this is the one endpoint that writes a credential to
       * an account it did not create.
       */
      const lookup = await entraProvisioning.findByUpn(user.official_email);
      if (!lookup.found) {
        return modernError(res, 409, 'Could not confirm ' + user.official_email + ' in the directory — '
          + (lookup.reason || 'the lookup was inconclusive') + '. Refusing to reset a password we cannot attribute.');
      }
      if (String(lookup.user.id).toLowerCase() !== String(state.entra_object_id).toLowerCase()) {
        return modernError(res, 409, user.official_email + ' belongs to a different Microsoft 365 account than the one recorded for this user — resetting it would change somebody else\'s password.');
      }

      let tempPassword = null;
      let mail;
      try {
        const reset = await entraProvisioning.resetEntraPassword(
          state.entra_object_id, (pw) => { tempPassword = pw; },
        );
        if (!reset.ok) {
          logger.error('Mailbox password reset FAILED · userId=' + userId + ' · actorId=' + (actorId || '') + ' · ' + reset.reason);
          return modernError(res, 502, 'Microsoft 365 refused the password reset — ' + reset.reason);
        }
        /*
         * The EXISTING sender, deliberately — all three gates and the HR CC
         * still apply, and there is exactly one copy of the mail wording and of
         * the "never send a credential mail without a credential" rule. The
         * provisioning outcome is synthesised from the RECORDED row (which we
         * just verified is ready), so GATE 1 sees the same facts it would on a
         * live run.
         */
        mail = await welcomeMail.sendWelcomeMail({
          userId,
          userName: user.user_name,
          officialEmail: user.official_email,
          personalEmail: user.personal_email,
          tempPassword,
          provisioning: {
            mailboxReady: true,
            accountStatus: state.account_status,
            licenceStatus: state.licence_status,
          },
        });
      } catch (e) {
        mail = { status: welcomeMail.MAIL_STATUS.FAILED, reason: e.message };
      } finally {
        tempPassword = null; // done with it — do not retain past the send
      }

      const msg = mail.status === welcomeMail.MAIL_STATUS.SENT
        ? 'Mailbox password reset — sign-in details emailed to ' + mail.to
          + (mail.cc && mail.cc.length ? ' (cc ' + mail.cc.join(', ') + ')' : '')
        : 'Mailbox password reset, but the sign-in details were NOT emailed: ' + mail.reason;
      logger.info('Mailbox password reset done · userId=' + userId + ' · actorId=' + (actorId || '')
        + ' · welcomeMail=' + mail.status);

      // The password was just changed either way, so the caller must be told
      // even when the mail failed — otherwise the user is locked out with a
      // credential nobody holds.
      modernOk(res, { ok: true, welcomeMail: { status: mail.status, reason: mail.reason } }, msg);
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

/*
 * TEST-ONLY handle on the request schemas. An Express Router IS a function, so
 * hanging a property off it is inert at runtime — nothing in the request path
 * reads it, and express only ever calls the function itself.
 *
 * It exists because the personal_email requiredness matrix lives in TWO places
 * (this file's Joi and services/user.service.js) and both must be tested. A
 * test that re-declared the schema would keep passing forever after someone
 * edited the real one; this way tests/user-personal-email.test.js asserts the
 * SHIPPED schemas.
 */
module.exports.__schemas = { createBody, updateBody, bulkUpdateBody };
