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

/*
 * Material Request Flow v2 (2026-09-21) — the client's approve/reject
 * decision now ALSO stamps client_status/client_action_on on every
 * `approval_pending` quotation_details line for the job, in the SAME
 * transaction as the tbl_job move (setStatus's `conn` option). ONE function
 * because it has the same four call sites this file's header already
 * enumerates (routes/client/index.js's authed approve/reject, routes/public/
 * estimate.js's token approve/reject) — a per-route copy is exactly how a
 * fifth surface misses it next time.
 *
 * Targets `approval_pending` lines specifically (quotationLineState's own
 * predicate: action_on IS NOT NULL AND status = 1 AND client_status IS
 * NULL) rather than "every line on the job" — a `rejected` (CRM-rejected)
 * line was never shown to the client and must never look client-actioned.
 */
const quotationLineState = require('./quotation-line-state');
const logger = require('../logger');
const { pool } = require('../db');
const path = require('node:path');

async function stampApprovalPendingLines(conn, jobId, approved) {
  const predicate = quotationLineState.statePredicateSql('quotation_details', quotationLineState.STATE.APPROVAL_PENDING);
  await conn.query(
    `UPDATE quotation_details
        SET client_status = ?, client_action_on = ?
      WHERE job_id = ? AND (${predicate})`,
    [approved ? 1 : 0, new Date(), jobId],
  );
}

/*
 * The APPROVE half of stampApprovalPendingLines' two call sites (client
 * portal, public magic-link) plus a third (admin on-behalf approval,
 * routes/admin/jobs.js POST /:id/client-approval-on-behalf) all do the exact
 * same two writes on their own transaction: stamp the approval_pending lines,
 * then move the job to 1 (SCHEDULED) keeping the same technician (setStatus's
 * default branch never touches fk_easyfixter_id). ONE function so a future
 * change to "what a client approval does" cannot land in two of the three and
 * miss the third — same reasoning as stampApprovalPendingLines' own header.
 *
 * Each caller still owns its OWN tbl_job columns (approved_by_client_contact /
 * approved_on_date_time) before calling this — those are idempotency-guard
 * columns specific to the SPOC/token flows, not part of "what a client
 * approval does" in general, and an admin's on-behalf approval has no
 * client_contact id to put there (see the FK note on stampApprovalPendingLines'
 * own caller list — never a client-contact id in a tbl_user FK, and the
 * reverse: never a tbl_user id in a client-contact FK).
 */
async function approveEstimateLinesAndStatus(conn, jobId, actor) {
  await stampApprovalPendingLines(conn, jobId, true);
  // eslint-disable-next-line global-require
  await require('./job.service').setStatus(jobId, { status: 1 }, actor, { conn });
}

/*
 * ═══════════════════════════════════════════════════════════════════════
 * VISIT SCHEDULING + SITE-ACCESS PERMISSION (Material Request Flow v2,
 * 2026-09-22 owner correction — "never pre-assume the next visit date").
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Replaces the SAME-DAY auto-reschedule amendment (baseDate/findSlot/3PM
 * rule, tbl_job_auto_schedule, needs_scheduling) this branch shipped earlier
 * and the owner then rejected. The client/CRM now PICKS the visit date/time
 * themselves (services/visit-slots.service.js tells them what's free) and
 * says whether the technician will need help getting on site. ALL THREE
 * approve surfaces — client portal, public magic-link, admin on-behalf —
 * call approveWithVisitSchedule() below so "what does approving with a
 * chosen visit do" cannot land in two of the three and miss the third, same
 * reasoning as approveEstimateLinesAndStatus's own header.
 */

const visitSlots = require('./visit-slots.service');

const PERMISSION_CHOICES = Object.freeze(['now', 'later', 'not_required']);

/*
 * mimetype -> allowed extension(s) for the permission document. Deliberately
 * its OWN table, not job-image.service's ALLOWED_UPLOAD_MIME byte-sniff gate
 * (routes/admin/jobs.js's ClientApprovalProof upload made exactly this call
 * already, for the same reason): that gate doesn't recognise heic/heif (no
 * stable magic number this codebase sniffs for), and the spec explicitly
 * asks for heic. Both mimetype AND extension must agree, same rule as that
 * route's CLIENT_APPROVAL_PROOF_TYPES.
 */
const PERMISSION_FILE_TYPES = Object.freeze({
  'application/pdf': ['.pdf'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'image/heic': ['.heic'],
  'image/heif': ['.heic', '.heif'],
});
const PERMISSION_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** {status, message} error, or null when the file is acceptable. Never throws itself. */
function permissionFileError(file) {
  if (!file) return 'attach the permission document (pdf, jpeg, png, webp or heic)';
  if (Number(file.size) > PERMISSION_FILE_MAX_BYTES) return 'the permission document must be 10MB or smaller';
  const mime = String(file.mimetype || '').trim().toLowerCase();
  const exts = PERMISSION_FILE_TYPES[mime];
  if (!exts) return `"${file.originalname}": unsupported file type (${file.mimetype})`;
  const ext = path.extname(file.originalname || '').toLowerCase();
  if (!exts.includes(ext)) return `"${file.originalname}": file extension does not match its declared type (${file.mimetype})`;
  return null;
}

/*
 * Validate `permission` + `permission_file` — pure, no DB, no write. Throws
 * {status: 400} for anything wrong. Returns the clean { choice, file }
 * approveWithVisitSchedule wants. `file` is the already-resolved contentType
 * mime (lower-cased), so the caller need not re-derive it.
 */
function validatePermissionChoice(rawChoice, file) {
  const choice = String(rawChoice || '').trim();
  if (!PERMISSION_CHOICES.includes(choice)) {
    const e = new Error("permission must be 'now', 'later' or 'not_required'"); e.status = 400; throw e;
  }
  if (choice === 'now') {
    const err = permissionFileError(file);
    if (err) { const e = new Error(err); e.status = 400; throw e; }
  }
  return { choice, file: choice === 'now' ? file : null };
}

// Same action_taken_reason bucket (action_type = 8, "Reschedule") the old
// auto-reschedule amendment seeded — see the shrunk migration
// migrations/executed/2026-09-22-material-approval-auto-schedule.sql.
const VISIT_CHOSEN_REASON = 'Material Approved — Visit Chosen';

async function visitChosenReasonId() {
  try {
    const [[row]] = await pool.query(
      'SELECT id FROM action_taken_reason WHERE action_type = 8 AND action_desc = ? LIMIT 1',
      [VISIT_CHOSEN_REASON],
    );
    return row ? row.id : null;
  } catch (e) {
    logger.warn({ err: e && e.message }, 'visitChosenReasonId: lookup failed (non-fatal)');
    return null;
  }
}

/*
 * approveWithVisitSchedule(jobId, actor, opts) — the ONE writer for "approve
 * this estimate AND book the visit the client picked AND record the
 * permission choice". opts:
 *   visitDateTime     'YYYY-MM-DD HH:00:00' — validated here via
 *                     visit-slots.service#assertSlotBookable.
 *   permissionChoice  raw 'now' | 'later' | 'not_required' string.
 *   permissionFile    the uploaded file (multer shape) when choice='now'.
 *   technicianId      the job's fk_easyfixter_id AT CALL TIME — approving
 *                     never changes it (setStatus's default branch), so the
 *                     caller's own already-loaded job row is reused rather
 *                     than a second SELECT.
 *   rescheduleActor   the actor job.service#reschedule() stamps fk_scheduled_by
 *                     with — null on the client/public paths ("system", never
 *                     a client-contact id in a tbl_user FK — see
 *                     approveEstimateLinesAndStatus's own header), the CRM
 *                     user object on the admin on-behalf path.
 *   permissionSpocId  fulfilled_by_contact_id for an immediate 'now' fulfil —
 *                     the client_contact id on the client/public paths, null
 *                     on the admin path (no client contact involved).
 *
 * VALIDATION ORDER — everything below runs BEFORE the transaction opens:
 *   1. permission/file shape (sync, no DB)
 *   2. assertSlotBookable (DB READS only — busy check, no write)
 * so a 400/409 here has touched nothing.
 *
 * TRANSACTION BOUNDARY (a deliberate choice, not an accident):
 *   (a) approveEstimateLinesAndStatus runs in its OWN transaction, unchanged
 *       from before this change — the estimate lines + job status move
 *       together or not at all.
 *   (b) job.service#reschedule() and (c) the permission-request write run
 *       AFTER that commit, not inside it — reschedule() manages its own
 *       transaction internally (see its own header) and folding a foreign
 *       connection into it is a bigger refactor than this fix calls for.
 *       Because step 2 above already re-validated the slot immediately
 *       before this function runs, (b) can only fail here on a genuine race
 *       (another approval landing in the gap) or a real DB error — rare.
 *       UNLIKE the rejected auto-reschedule amendment (which could never
 *       fail the approval and hid the failure behind a needs_scheduling
 *       flag), a chosen slot is an EXPLICIT user decision: a failure here is
 *       NEVER swallowed. It is logged AND surfaced back on the result as
 *       `scheduleError` (and `permissionError` for (c)) — the approval
 *       itself stays committed and durable, but the caller finds out the
 *       visit/permission step did not land and can tell the user to retry
 *       rather than silently showing a job that looks scheduled but isn't.
 */
/*
 * Where a job goes when the client REJECTS its estimate (V3 Phase 4, 4.3).
 *
 * Both reject paths (the portal and the magic link) hard-coded 2: "back to the
 * technician, who is on site". True for every estimate before Phase 4. Not for
 * additional work priced on a REVISIT: that technician left the site hours ago,
 * and 2 would put a job he is not working "in progress" under his name.
 * storePreMaterialStatus already records where the estimate came from; a job
 * that came from 10 goes back to 10, where the desk decides the booked-only
 * close or visit 2. Every other job keeps its 2 — nothing existing changes.
 */
async function estimateRejectStatus(jobId, conn) {
  const pre = await require('./material-review-store').getPreMaterialStatus(jobId, conn);
  return Number(pre) === 10 ? 10 : 2;
}

async function approveWithVisitSchedule(jobId, actor, opts) {
  const {
    visitDateTime, permissionChoice, permissionFile, technicianId,
    rescheduleActor = null, permissionSpocId = null, stamp = null,
  } = opts;

  const permission = validatePermissionChoice(permissionChoice, permissionFile);
  await visitSlots.assertSlotBookable(jobId, visitDateTime, new Date());

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (stamp) await stamp(conn);
    await approveEstimateLinesAndStatus(conn, jobId, actor);
    await conn.commit();
  } catch (e) {
    try { await conn.rollback(); } catch { /* connection may already be gone */ }
    throw e;
  } finally {
    conn.release();
  }

  const result = {
    visitDateTime, rescheduled: false, scheduleError: null,
    permission: { choice: permission.choice, requestId: null }, permissionError: null,
  };

  try {
    const reasonId = await visitChosenReasonId();
    // eslint-disable-next-line global-require
    await require('./job.service').reschedule(jobId, {
      requestedDateTime: visitDateTime,
      reasonId,
      rescheduleReason: VISIT_CHOSEN_REASON,
      remarks: 'Visit date/time chosen at material approval.',
    }, rescheduleActor);
    result.rescheduled = true;
  } catch (e) {
    logger.warn({ jobId, err: e && e.message }, 'approveWithVisitSchedule: reschedule to the chosen slot failed');
    result.scheduleError = e && e.message ? e.message : 'reschedule failed';
  }

  if (permission.choice !== 'not_required') {
    try {
      const permissionRequests = require('./job-permission-request.service'); // eslint-disable-line global-require
      const raised = await permissionRequests.raiseForApproval({
        jobId,
        efrId: technicianId,
        fulfilNow: permission.choice === 'now',
        file: permission.file,
        fileContentType: permission.file ? String(permission.file.mimetype || '').trim().toLowerCase() : null,
        spocId: permissionSpocId,
      });
      result.permission.requestId = raised ? raised.requestId : null;
    } catch (e) {
      logger.warn({ jobId, err: e && e.message }, 'approveWithVisitSchedule: permission-request write failed');
      result.permissionError = e && e.message ? e.message : 'permission request failed';
    }
  }

  return result;
}

module.exports = {
  estimateRejectStatus,
  isEstimateApprovable, assertEstimateApprovable, ESTIMATE_PENDING_APPROVAL,
  stampApprovalPendingLines,
  approveEstimateLinesAndStatus,
  PERMISSION_CHOICES,
  VISIT_CHOSEN_REASON,
  validatePermissionChoice,
  approveWithVisitSchedule,
};
