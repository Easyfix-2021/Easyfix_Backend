/*
 * utils/job-reference.js
 *
 * Formatter for tbl_job.job_reference_id.
 *
 * Legacy convention (confirmed by ops 2026-06-04): the column carries
 * the value `REF-{job_id}` — e.g. job_id 482286 → `"REF-482286"`. The
 * format is row-identity-bound (NOT a synthetic random suffix), so the
 * value can only be computed AFTER the INSERT completes and the
 * AUTO_INCREMENT id is known.
 *
 * Caller pattern in services/job.service.js::create():
 *   1. INSERT tbl_job WITHOUT setting job_reference_id (leave NULL)
 *   2. Capture `jobId = ins.insertId`
 *   3. UPDATE tbl_job SET job_reference_id = formatJobReferenceId(jobId)
 *      WHERE job_id = ? — same open transaction; atomic with the INSERT
 *
 * A caller-supplied `input.job_reference_id` short-circuits the auto-
 * compute (preserves backwards-compat with integration callers that
 * pass an explicit id). A caller opting into the legacy "reuse
 * client_ref_id" behaviour via `input.reuse_client_ref = true` ALSO
 * short-circuits, in which case `client_ref_id` is bound to
 * job_reference_id during the original INSERT.
 */

function formatJobReferenceId(jobId) {
  const n = Number(jobId);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `REF-${n}`;
}

module.exports = { formatJobReferenceId };
