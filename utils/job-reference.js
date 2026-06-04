/*
 * utils/job-reference.js
 *
 * Auto-generator for tbl_job.job_reference_id. Used by services/job.service.js
 * when the caller does not supply an explicit `job_reference_id` AND has not
 * opted into the legacy "reuse client_ref_id" behaviour via `reuse_client_ref`.
 *
 * Format chosen: `JOB-YYYYMMDD-XXXXXX` where XXXXXX is 6 uppercase hex chars
 * (3 random bytes, ~16.7M space per day → collision-resistant for the volumes
 * we see). No legacy CRM convention was discoverable in the repo or
 * EasyFix Docs at the time of writing (2026-06-04), so this format was picked
 * for readability + low collision risk. If ops later confirm a different
 * legacy pattern (e.g. EFR-{seq}), swap the implementation here — every
 * caller goes through this helper.
 *
 * Length: 19 chars. Safe for the legacy DB column which has historically
 * stored client_ref_id values up to 32 chars without truncation.
 */
const crypto = require('crypto');

function pad2(n) { return String(n).padStart(2, '0'); }

function generateJobReferenceId(now = new Date()) {
  const yyyy = now.getFullYear();
  const mm   = pad2(now.getMonth() + 1);
  const dd   = pad2(now.getDate());
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase(); // 6 chars
  return `JOB-${yyyy}${mm}${dd}-${rand}`;
}

module.exports = { generateJobReferenceId };
