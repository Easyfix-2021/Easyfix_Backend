const router = require('express').Router();

const requireAuth = require('../../middleware/auth');
const { role } = require('../../middleware/role');
const { buildRequestScopeWithHierarchy } = require('../../lib/scope');
const { loadAllowedStages } = require('../../services/user.service');
const maskMobile = require('../../middleware/mask-mobile');
const rejectMaskedMobile = require('../../middleware/reject-masked-mobile');
const { pool } = require('../../db');

/*
 * Every /api/admin/* sub-resource inherits these gates:
 *   - requireAuth         → valid JWT, fresh tbl_user row on req.user
 *   - role(['admin'])     → user_role must classify to 'admin' group
 *   - scope attach        → computes the hierarchy-unioned scope ONCE per
 *                           request and stashes on req.scope. Downstream
 *                           handlers + assertEntityInScope read this.
 *   - maskMobile          → wraps res.json so every mobile-bearing field
 *                           (customer_mob_no, mobile_no, efr_no, caller,
 *                           reciever, …) ships as "first 4 digits + bullets"
 *                           to the operator's browser. Edit forms opt out
 *                           with ?unmasked=true. NOT applied to
 *                           /integration/v1/* or /webhook/* — those mount
 *                           separately and intentionally keep the legacy
 *                           contract.
 *
 * Fine-grained role restrictions (e.g. finance-only reports) layer on with
 * roleByName() at the sub-route level.
 */
router.use(requireAuth);
router.use(role(['admin']));
router.use(maskMobile);
// Reject any incoming POST/PATCH/PUT whose body contains a masked mobile
// value (a string with the • bullet at a known MOBILE_FIELDS key). The
// outbound mask wraps response data; this inbound guard prevents that
// masked data from round-tripping into a write. See
// middleware/reject-masked-mobile.js for the full rationale.
router.use(rejectMaskedMobile);
router.use(async (req, _res, next) => {
  // Hierarchy-aware scope: own manage_* ∪ every direct/indirect report's
  // manage_*. Bypass roles (Admin/Finance) get `undefined` = no row filter.
  //
  // Job Stage Access: also resolve req.allowedStages ONCE per request. Consumed
  // by the jobs list/counts/attention (visibility) + middleware/require-stage
  // (transitions). NOT subject to the Admin/Finance scope bypass — a stage
  // grant is an explicit per-user setting, so it applies to whoever it was set
  // on (see routes/auth.js for the full rationale). No rows → {mode:'all'} =
  // unrestricted, which is still every user's default.
  try {
    req.scope = await buildRequestScopeWithHierarchy(req, pool);
    req.allowedStages = await loadAllowedStages(req.user.user_id);
  } catch (e) { return next(e); }
  next();
});

router.use('/properties',      require('./properties'));
router.use('/easyfixers',      require('./easyfixers'));
/* A SECOND router on the same prefix (same split /jobs already uses): the
 * READ-ONLY technician-app mirror, GET /easyfixers/:efrId/mirror/*. Paths are
 * disjoint from easyfixers.js — nothing there matches three segments — so
 * order does not matter. It replays the technician's own /api/mobile GETs
 * in-process; see routes/admin/easyfixer-app-mirror.js for the gate and
 * services/easyfixer-app-mirror.service.js for the security properties. */
router.use('/easyfixers',      require('./easyfixer-app-mirror'));
router.use('/zones',           require('./zones'));
router.use('/pincodes',        require('./pincodes'));
router.use('/cities',          require('./cities'));
router.use('/service-categories', require('./service-categories'));
router.use('/service-types',      require('./service-types'));
router.use('/document-types',     require('./document-types'));
router.use('/skill-levels',       require('./skill-levels'));
router.use('/verticals',          require('./verticals'));
router.use('/tools',              require('./tools'));
router.use('/rate-cards-b2b',     require('./rate-cards-b2b'));
router.use('/rate-cards-b2c',     require('./rate-cards-b2c'));
router.use('/deep-skills',     require('./deep-skills'));
router.use('/auto-allocation', require('./auto-allocation'));
router.use('/jobs',          require('./jobs'));
router.use('/jobs',          require('./job-magic-link')); // adds /:id/send-magic-link + /:id/magic-link-status under /jobs (see file for shape)
// Billing & Charges job-workspace tab — Penalty/Travel/Incentive (job_material),
// service billing approval (tbl_job_services.approval_by_client), and Job Sheet /
// Purchase Order documents (tbl_job_image). Mutations gated by the
// `job.charges.emails` property allowlist (FEATURES.canManageJobCharges); the
// read is scope-only. Mounted under /jobs; both fall through from jobs.js.
router.use('/jobs',          require('./job-charges'));
router.use('/jobs',          require('./job-documents'));
router.use('/customer-requests', require('./customer-requests')); // ops inbox for tbl_job_customer_request (cancel/reschedule signals)
router.use('/auto-assign',   require('./auto-assign'));
router.use('/notifications', require('./notifications'));
router.use('/webhooks',        require('./webhooks'));
router.use('/quicksight',      require('./quicksight'));
router.use('/maps',            require('./maps'));
router.use('/finance',         require('./finance'));
// Payout Requests — finance processor for technician wallet withdrawals
// recorded by POST /api/mobile/withdraw. Gated Finance+Admin at the router
// level; per-action FE gating via isPayoutRequestsView / isPayoutRequestsProcess.
router.use('/withdrawals',     require('./withdrawals'));
router.use('/advances',        require('./advances'));
router.use('/clients',         require('./clients'));
router.use('/customers',       require('./customers'));
router.use('/call-info',       require('./call-info'));
router.use('/calls',           require('./calls'));
// Ops conference calling (Plivo Multi-Party Call). NO new feature flag — the
// operational switch is the EXISTING `plivo.calling.enabled` property (off ⇒
// Kaleyra, which has no live surface and therefore no conferences). Gated by
// Gated by the SAME RBAC key as calling — `isClickToCall`. There is deliberately
// no conference-specific permission: every ops call is a conference, so a lesser
// grant could only produce an operator who can place a call but not see its
// participants. The custom-number arm still brings its own per-operator rate
// limit because /api/admin/* is deliberately rate-limit-exempt.
// See routes/admin/conferences.js.
router.use('/conferences',     require('./conferences'));
router.use('/menus',           require('./menus'));
router.use('/products',        require('./products'));
router.use('/users',           require('./users'));
router.use('/roles',           require('./roles'));
// Per-user property-gated capability flags for the FE (canSwitchCallMode,
// canDeleteEntities) — display-only; the gated routes enforce the allowlist
// themselves. See routes/admin/access.js + services/feature-access.service.js.
router.use('/access',          require('./access'));
// Global (non-per-user) runtime UI toggles the CRM reads at render time:
// customer-number visibility + map clickability. Read-only; flipped via
// easyfix_properties. See routes/admin/config.js.
router.use('/config',          require('./config'));
// Admin Actions → OTP-gated Delete Easyfixer/User + Restore (tombstone + full
// JSON archive). Gated PER-USER by the easyfix_properties allowlist
// (access.entitydelete.emails) — NOT RBAC. See routes/admin/entity-deletion.js.
router.use('/entity-deletion', require('./entity-deletion'));
router.use('/rate-cards',      require('./rate-cards'));
router.use('/quotations',      require('./quotations'));
router.use('/questionnaires',  require('./questionnaires'));
router.use('/settings',        require('./settings'));
// Settings → Theme & Branding (2026-08-18) — banner copy, login tagline, and
// the festival theme calendar the public login page reads. RBAC-gated
// (isBrandingView / isBrandingEdit), NOT property-gated; only the AI art
// generator is (FEATURES.canGenerateBrandArt → branding.ai.emails).
router.use('/branding',        require('./branding'));
// Scheduled Jobs admin (2026-06-06) — list + manual trigger for
// node-cron tasks. Self-gates on the email allowlist
// (easyfix_properties.scheduled.jobs.visible.emails); no role/menu
// permission seeded.
router.use('/scheduled-jobs',  require('./scheduled-jobs'));
router.use('/validate',        require('./validate')); // Validate Flows — property-gated test-push (validate.flows.emails)
router.use('/skill-matrix',    require('./skill-matrix')); // Build Skill Matrix — property-gated AI build (skill.matrix.emails)
router.use('/tat',             require('./tat'));          // TAT Calculator — segment-wise TAT preview (isTatCalculatorView)
router.use('/teleprompter',    require('./teleprompter')); // AI Teleprompter for Calls — property-gated (teleprompter.emails)
router.use('/otp-channel',     require('./otp-channel')); // Login OTP channel (WhatsApp/SMS) — property-gated (access.otpchannel.emails)
router.use('/reports',         require('./reports'));
router.use('/aux',             require('./auxiliary'));
router.use('/legacy',          require('./legacy'));
// Notice Board (added 2026-05-22). Three mounts:
//   /notice-categories — admin-managed coloured chip tags
//   /notices           — CRUD + state transitions + active feed + mark-read
//   /holidays          — Nager.Date-backed "Upcoming Events" rail
router.use('/notice-categories', require('./notice-categories'));
router.use('/notices',           require('./notices'));
router.use('/holidays',          require('./holidays'));
// LMS (added 2026-08-13) — courses, course content, assignment, completion
// report. The training VIDEO catalogue stays on /aux/training-videos; this
// router deliberately does not restate it.
router.use('/lms',               require('./lms'));
/* A SECOND router on the same prefix — the action tool (B-01/B-02/B-13 and
 * the chase endpoints), split from lms.js by purpose rather than by table:
 * lms.js is the CRUD that sets training up, lms-action.js is what the team
 * looks at to find out what needs doing today. Same pattern /jobs already
 * uses across several files. Order does not matter — the paths are disjoint. */
router.use('/lms',               require('./lms-action'));
// Rewards (added 2026-08-13) — shop catalogue, claims queue, points ledger.
router.use('/rewards',           require('./rewards'));
// router.use('/clients',        require('./clients'));     // later
// router.use('/users',          require('./users'));       // later

module.exports = router;
