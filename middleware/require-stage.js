/*
 * Job Stage Access — transition guard middleware factory.
 *
 * Precedent: middleware/require-action.js (route-layer permission guard).
 *
 * Enforces the TRANSITION half of Job Stage Access: a user restricted to a
 * subset of lifecycle stages may only move a job INTO one of those stages.
 * (The VISIBILITY half — only SEEING jobs in allowed stages — is enforced in
 * job.service list/counts/attention.)
 *
 * ⚠ ROUTE-LAYER ONLY. This must sit on the /api/admin/* job routes and NOWHERE
 * inside job.service (setStatus / assign / offerToTechnicians / reschedule /
 * acceptOffer). Those service functions are shared with routes/mobile/index.js;
 * technicians carry NO CRM stage grants and must never be blocked by this.
 *
 * Placement: AFTER `scopedJob`, so `req.scopedJob.job_status` (the SOURCE
 * status) is available, and BEFORE the route handler (so an unauthorized
 * transition short-circuits with 403 before any handler-level validation).
 *
 * `kind` selects how the TARGET status is derived:
 *   'status'     → target = Number(req.body.status)  (explicit status change)
 *   'assign'     → target = 1 (SCHEDULED)            (direct assign schedules the job)
 *   'offer'      → target = 1 (SCHEDULED)            (offer intends to schedule)
 *   'reschedule' → NO status change; require the job's CURRENT stage be visible.
 *
 * Bypass roles (Admin/Finance) and unrestricted users resolve to
 * req.allowedStages.mode === 'all' (set in routes/admin/index.js) → no-op.
 */

const { modernError } = require('../utils/response');
const { transitionAllowed, stageVisible } = require('../lib/job-stages');

const SCHEDULED = 1; // tbl_job.job_status SCHEDULED — the effective target of assign/offer.

function requireStageForTransition(kind) {
  if (!['status', 'assign', 'offer', 'reschedule'].includes(kind)) {
    throw new Error(`requireStageForTransition(): unknown kind "${kind}"`);
  }

  return function stageGuard(req, res, next) {
    const allowed = req.allowedStages;
    // Unrestricted (no rows) or bypass role → nothing to enforce.
    if (!allowed || allowed.mode === 'all') return next();

    // scopedJob must have run first. Guard defensively rather than crash.
    const source = req.scopedJob ? Number(req.scopedJob.job_status) : null;

    if (kind === 'reschedule') {
      // Reschedule doesn't change job_status — the user just needs the job's
      // current stage to be one they're allowed to see/act on.
      if (!stageVisible(allowed, source)) {
        return modernError(res, 403, 'You do not have access to this job stage.');
      }
      return next();
    }

    const target = kind === 'status' ? Number(req.body?.status) : SCHEDULED;
    if (!transitionAllowed(allowed, source, target)) {
      return modernError(res, 403, 'You are not allowed to move this job to that stage.');
    }
    return next();
  };
}

module.exports = requireStageForTransition;
module.exports.requireStageForTransition = requireStageForTransition;
