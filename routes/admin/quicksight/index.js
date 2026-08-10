/*
 * QuickSight reports — folder router.
 *
 * Mounted by routes/admin/index.js at /api/admin/quicksight (Node resolves
 * the directory `require('./quicksight')` to this index.js). The parent
 * admin router already applies requireAuth → role(['admin']) → maskMobile
 * → rejectMaskedMobile → req.scope, so everything below inherits those
 * gates. Per-report access control layers on top via requireQuickSight
 * (the ef-QuickSight family key + each report's own action key), applied
 * inside each report sub-router.
 *
 * Refactor history (2026-06-14): the previous single-file
 * routes/admin/quicksight.js held only the /token session-bridge handler.
 * It was split into this folder so the native QuickSight reports rebuild
 * can give each of the 10 reports its OWN disjoint sub-router file
 * (parallel, conflict-free per-report work). The /token route is preserved
 * VERBATIM in ./token.js and mounted first so GET /api/admin/quicksight/token
 * resolves EXACTLY as before.
 *
 * Sub-router base paths are the canonical urlBase values from
 * /tmp/qs/_registry.json — do not invent variants.
 */

const router = require('express').Router();

// Session-bridge token mint (legacy Angular EF-QuickSight handshake).
// Preserved 1:1 — GET /api/admin/quicksight/token.
router.use(require('./token'));

// ─── Native report sub-routers (one per report family) ──────────────
// Each is a disjoint file edited only by its own report agent in
// Phase 1/2. They are stubs today (no endpoints) so this index can
// require them now without breaking the mount.
router.use('/open-orders',            require('./open-orders'));
router.use('/client-performance',     require('./client-performance'));
router.use('/vertical-orders',        require('./vertical-orders'));
router.use('/priority-jobs',          require('./priority-jobs'));
router.use('/material-report',        require('./material-report'));
router.use('/city-performance',       require('./city-performance'));
router.use('/technician-performance', require('./technician-performance'));
// STATE + USER Performance — the City scorecard over two new dimensions, built
// for the Performance Report page's tabs. ONE sub-router mounted twice; it reads
// req.baseUrl to pick the dimension + the matching action key.
router.use('/state-performance',      require('./region-performance'));
router.use('/user-performance',       require('./region-performance'));
router.use('/supply-gap',             require('./supply-gap'));
router.use('/employee-productivity',  require('./employee-productivity'));
router.use('/admin-dashboard',        require('./admin-dashboard'));
router.use('/offer-acceptance',       require('./offer-acceptance'));
router.use('/profile-update-requests', require('./profile-update-requests'));
// Call effort audit: per-job and per-(day, user) call volume off the legacy
// tbl_job_caller_info log — who called, whom, and at which job step.
router.use('/call-tracking',          require('./call-tracking'));
// Confirmation-quality audit: jobs pushed to Pending for Scheduling without the
// customer ever confirming (no form submission / Unreachable, and no real call).
router.use('/premature-confirmations', require('./premature-confirmations'));

module.exports = router;
