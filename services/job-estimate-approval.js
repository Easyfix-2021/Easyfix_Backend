/*
 * Shared "can a client/partner approve or reject THIS estimate right now"
 * gate — Material Management phase 2, sub-project D (2026-09-18).
 *
 * Owner rule (see docs/superpowers/specs/2026-09-18-pending-for-material-
 * status-16-design.md, "Flow" + "UI"): at status 16 (Pending for Material)
 * the quote has NOT been PM-reviewed yet — partners and clients get a View
 * Details action only, never Approve/Reject. A job is only client-
 * actionable at status 15 (ESTIMATE_PENDING_APPROVAL), which — since
 * send-for-approval now sets 16 instead — a job reaches ONLY via a PM's
 * material-review approve (routes/admin/jobs.js POST /:id/material-review).
 *
 * ONE shared definition because this gate has (at least) four call sites
 * across two auth surfaces (the authed client portal and the public
 * magic-link token flow), and a per-route copy of `job_status === 15` is
 * exactly how a fifth surface gets missed the next time this changes:
 *   - routes/client/index.js    PATCH /jobs/:id/estimate/approve|reject
 *   - routes/client/index.js    GET action-item builder ("Jobs waiting on you")
 *   - routes/public/estimate.js GET  /:token (status derivation)
 *   - routes/public/estimate.js PATCH /:token/approve|reject
 *
 * Two forms because the two files have different existing error idioms:
 * routes/client/index.js's estimate routes call modernError(res, ...)
 * directly (isEstimateApprovable, a plain boolean check), while
 * routes/public/estimate.js already has a `{status, message}` ->
 * modernError translator (mapKnownError) that assertEstimateApprovable's
 * throw is designed to flow through.
 */

const ESTIMATE_PENDING_APPROVAL = 15;

function isEstimateApprovable(jobStatus) {
  return Number(jobStatus) === ESTIMATE_PENDING_APPROVAL;
}

function assertEstimateApprovable(jobStatus) {
  if (!isEstimateApprovable(jobStatus)) {
    const err = new Error('This estimate is still being reviewed by EasyFix.');
    err.status = 409;
    throw err;
  }
}

module.exports = { isEstimateApprovable, assertEstimateApprovable, ESTIMATE_PENDING_APPROVAL };
