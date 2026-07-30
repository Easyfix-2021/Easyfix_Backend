/*
 * jobStatusLabel — the ONE backend source of truth for CRM-facing job-status
 * text (a tbl_job.job_status code → human label).
 *
 * Mirrors the frontend statusLabel (Easyfix_CRM_UI/src/lib/utils.ts) EXACTLY, so
 * an exported XLSX cell, an API field, and the on-screen chip always read the
 * same. Any code that turns a tbl_job.job_status into CRM text should call this
 * — do not hand-roll another map (that is how call-info drifted to
 * 10='Revisit' while every screen said 'Closed from App').
 *
 * ⚠ This is NOT services/integration.service.js's statusLabel(). THAT map is
 * FROZEN to the legacy Dropwizard contract external clients depend on
 * (0='Unconfirmed', 9='Call Later', 10='Revisit'); this is the CRM's own
 * vocabulary (0='Booked', 9='Unconfirmed', 10='Closed from App'). They are
 * deliberately different — never merge them. Likewise leave the frozen public
 * order-tracking map (services/job-magic-link.service.js) and the supply-gap
 * report's OWN status domain (Open/Assigned/…) alone; those are not
 * tbl_job.job_status.
 *
 * BOOKED sub-split by tech presence (identical to the FE): status 0 with a tech
 * assigned → 'Pending App Ack', status 0 with none → 'Pending for Scheduling',
 * and plain 'Booked' only when assignment is unknown. Callers that have the
 * job's fk_easyfixter_id pass `assigned` (a boolean); callers that only have the
 * code omit it and get the base 'Booked'. Pass the JOB's assigned tech — not,
 * e.g., a call record's own technician.
 */

const JOB_STATUS_LABELS = Object.freeze({
  0: 'Booked',
  1: 'Scheduled',
  2: 'In Progress',
  3: 'Completed',
  5: 'Completed',
  6: 'Cancelled',
  7: 'Enquiry',
  9: 'Unconfirmed',
  10: 'Closed from App',
  15: 'Estimate Pending',
  20: 'In Progress',
  21: 'On Hold',
});

/**
 * @param {number|string|null|undefined} code   tbl_job.job_status
 * @param {boolean|null} [assigned]  whether the JOB has a tech (fk_easyfixter_id != null)
 * @returns {string} CRM label; '' for null/blank/non-numeric code
 */
function jobStatusLabel(code, assigned) {
  if (code === null || code === undefined || code === '') return '';
  const n = Number(code);
  if (Number.isNaN(n)) return '';
  // BOOKED sub-state — only when the caller actually knows tech-presence.
  if (n === 0 && (assigned === true || assigned === false)) {
    return assigned ? 'Pending App Ack' : 'Pending for Scheduling';
  }
  return JOB_STATUS_LABELS[n] || `Status ${n}`;
}

module.exports = { jobStatusLabel, JOB_STATUS_LABELS };
