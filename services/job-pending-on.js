'use strict';
/*
 * "Pending on" — WHO a job is waiting for right now (V3 Phase 3, spec rule 6).
 *
 * THE ONE ANSWER. The ops desk (routes/admin/ops-desk.js) and the technician
 * app (GET /mobile/jobs, /mobile/jobs/:id) both ask this function, so the desk
 * can never show "pending on EasyFix" while the phone says "your move". Two
 * copies of these twelve rules is how that disagreement would start, and it
 * would start silently — each side is internally consistent.
 *
 * THE PRECEDENCE is the prototype's renderDesk() (scratchpad proto.txt, the
 * design AUTHORITY), first match wins: help beats everything because a man
 * stopped at a gate is the most urgent row on the board; a claim beats pricing
 * because the claim says the booked work itself cannot happen; and so on down
 * to "not started".
 *
 * FIXED QUERY BUDGET: TWO batched SELECTs for any number of jobs —
 *   1. the in-flight tx_report rows (job-tx-report.service openForJobs);
 *   2. one tbl_job read carrying the two app-request flags, the open
 *      site-permission EXISTS, and the verification row (LEFT JOIN).
 * Never per row. The mobile list caps at 200 rows, which bounds both IN (?).
 *
 * The caller's rows supply job_status and checkin_date_time (they already hold
 * them); everything else is fetched here, so a caller cannot get a different
 * answer by forgetting to select a column.
 */

const txReports = require('./job-tx-report.service');
const jobService = require('./job.service');
const { STATUS: PERMISSION_STATUS } = require('./job-permission-request.service');
const { isEstimateApprovable } = require('./job-estimate-approval');

const { KIND, STATUS: REPORT_STATUS } = txReports;

const PENDING_ON = Object.freeze({ TECHNICIAN: 'technician', EASYFIX: 'easyfix', CLIENT: 'client' });

const COMPLETED_STATUSES = new Set([3, 5, 10]);
const CHECKED_IN_STATUSES = new Set([2, 20]);
const NOT_STARTED_STATUSES = new Set([0, 1]);
const PENDING_FOR_MATERIAL = 16;

const verdict = (pendingOn, waitingFor, band, situation) => ({ pendingOn, waitingFor, band, situation });

/**
 * The rules, as a pure function of one job's facts — exported for tests so
 * every branch is provable without a database.
 *
 *   job      { job_status }
 *   facts    { cancel_request, reschedule_request, site_access, verified_on, qc_status }
 *   reports  in-flight tx_report rows for this job
 */
function decide(job, facts = {}, reports = []) {
  const status = Number(job.job_status);
  const byKind = new Map();
  for (const r of reports) if (!byKind.has(r.kind)) byKind.set(r.kind, r);
  const help = byKind.get(KIND.HELP);
  const cant = byKind.get(KIND.CANT_COMPLETE);
  const extra = byKind.get(KIND.ADDITIONAL_WORK);
  const left = extra && extra.left_site_on ? '_left' : '';

  // 1. He picked a reason and the bench has not picked up.
  if (help) return verdict(PENDING_ON.EASYFIX, 'help', 'A', `help:${help.reason_code}`);
  // 2. A claim that the booked work cannot happen — the desk verifies with the customer.
  if (cant && cant.status === REPORT_STATUS.OPEN) return verdict(PENDING_ON.EASYFIX, 'verify_claim', 'D', 'cant_complete');
  if (Number(facts.cancel_request) === 1) return verdict(PENDING_ON.EASYFIX, 'verify_claim', 'D', 'cancel_request');
  // 3.
  if (Number(facts.reschedule_request) === 1) return verdict(PENDING_ON.EASYFIX, 'reschedule_request', 'D', 'reschedule_request');
  // 4. Reported, not yet priced.
  if (extra && extra.status === REPORT_STATUS.OPEN) return verdict(PENDING_ON.EASYFIX, 'pricing', 'A', `additional_work_reported${left}`);
  /*
   * 5. With the client. The spec reads "report priced, or job_status 15"; the
   * two are the SAME condition while the estimate is live, because pricing is
   * what moves the job to 15 — and they differ only AFTER the client acts,
   * which moves the job off 15 (approve → 1) while the report can still say
   * 'priced'. Keying on 15 alone — the client portal's own approvable gate,
   * job-estimate-approval.isEstimateApprovable — is what stops an approved
   * job reading "waiting for the client" forever if the approve path never
   * flips the report.
   */
  if (isEstimateApprovable(status)) return verdict(PENDING_ON.CLIENT, 'client_approval', 'B', `estimate_with_client${left}`);
  // 6. The desk sent it back for better photos.
  if (extra && extra.status === REPORT_STATUS.RETURNED) return verdict(PENDING_ON.TECHNICIAN, 'resend_photos', 'A', 'additional_work_returned');
  // 7.
  if (status === PENDING_FOR_MATERIAL) return verdict(PENDING_ON.EASYFIX, 'material_review', 'A', 'material_review');
  // 8. A gate pass / NOC the client has not answered.
  if (Number(facts.site_access) === 1) return verdict(PENDING_ON.CLIENT, 'site_access', 'B', 'site_access');
  if (COMPLETED_STATUSES.has(status)) {
    // 9. Submitted — EasyFix's audit comes first (sheet 14 order).
    if (!facts.verified_on) return verdict(PENDING_ON.EASYFIX, 'audit', 'C', 'submitted_for_audit');
    // 10. Out of our hands, on the client's timer.
    if (facts.qc_status === 'pending') return verdict(PENDING_ON.CLIENT, 'client_qc', 'C', 'client_qc');
    /*
     * NOT IN THE SPEC'S LIST, added because the list has no answer for it and
     * would otherwise fall through to "technician · not started": the client
     * disputed the work. The spec's client-portal section says "desk sees it in
     * band C/D"; D, because it is a claim against finished work that the desk
     * must settle. waitingFor 'audit' keeps the app inside its closed
     * "Waiting for EasyFix" vocabulary.
     */
    if (facts.qc_status === 'disputed') return verdict(PENDING_ON.EASYFIX, 'audit', 'D', 'qc_disputed');
    // QC passed / auto-passed: nobody is waiting on anybody.
    return verdict(null, null, null, 'closed');
  }
  // 11.
  if (CHECKED_IN_STATUSES.has(status)) return verdict(PENDING_ON.TECHNICIAN, 'working', 'A', extra ? 'additional_work_approved' : 'working');
  // 12.
  if (NOT_STARTED_STATUSES.has(status)) return verdict(PENDING_ON.TECHNICIAN, 'not_started', null, 'not_started');
  // Cancelled / enquiry / on hold: the job is not in anyone's hands on site.
  return verdict(null, null, null, 'closed');
}

/**
 * @param {object} conn  pool or connection
 * @param {Array<{job_id, job_status, checkin_date_time}>} jobRows
 * @returns {Promise<Map<number, {pendingOn, waitingFor, band, situation}>>}
 */
async function pendingOnForJobs(conn, jobRows) {
  const out = new Map();
  const rows = (jobRows || []).filter((r) => r && Number.isSafeInteger(Number(r.job_id)));
  const ids = [...new Set(rows.map((r) => Number(r.job_id)))];
  if (!ids.length) return out;

  const reports = await txReports.openForJobs(conn, ids);
  /*
   * The two request flags use the CRM Technician Requests queue's OWN predicate
   * (job.service appRequestClause: job_status = 1 AND flag), so the desk band
   * and the CRM queue list exactly the same asks. COALESCE-wrapped there
   * because both flags are bit(1) and a raw Buffer is always truthy.
   */
  const cancel = jobService.appRequestClause('cancel');
  const resched = jobService.appRequestClause('reschedule');
  const [facts] = await conn.query(
    `SELECT j.job_id,
            ${cancel.sql} AS cancel_request,
            ${resched.sql} AS reschedule_request,
            EXISTS (SELECT 1 FROM tbl_job_permission_request p
                     WHERE p.job_id = j.job_id AND p.status = ?) AS site_access,
            v.verified_on, v.qc_status
       FROM tbl_job j
       LEFT JOIN tbl_job_verification v ON v.job_id = j.job_id
      WHERE j.job_id IN (?)`,
    [...cancel.params, ...resched.params, PERMISSION_STATUS.REQUESTED, ids],
  );

  const factsById = new Map(facts.map((f) => [Number(f.job_id), f]));
  const reportsById = new Map();
  for (const r of reports) {
    const id = Number(r.job_id);
    if (!reportsById.has(id)) reportsById.set(id, []);
    reportsById.get(id).push(r);
  }
  for (const row of rows) {
    const id = Number(row.job_id);
    out.set(id, decide(row, factsById.get(id) || {}, reportsById.get(id) || []));
  }
  return out;
}

module.exports = { pendingOnForJobs, PENDING_ON, _internals: { decide } };
