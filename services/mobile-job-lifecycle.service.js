const { pool } = require('../db');
const logger = require('../logger');
const jobService = require('./job.service');
const smsService = require('./sms.service');
const smsTemplate = require('./sms-template.service');

/*
 * Mobile Job Lifecycle — the technician-app order flow that sits on top
 * of the shared jobService transitions:
 *
 *   cancel        → job_status 6  (CANCELLED)
 *   checkin-sms   → (re)send the customer the check-in PIN SMS
 *   selfie        → store the reached-location selfie ref on the job
 *   search        → find the tech's job by id (dashboard search)
 *
 * NOTE: `startWork` (→ IN_PROGRESS) and `complete` (→ COMPLETED/REVISIT)
 * were removed as duplicates of POST /jobs/:id/checkin and
 * POST /jobs/:id/checkout (which already own those transitions).
 *
 * Every mutation is scoped to the authed technician's efr_id: the caller
 * (routes/mobile/jobs-lifecycle.js) verifies fk_easyfixter_id === efr_id
 * BEFORE invoking these functions, but each write here ALSO pins
 * `fk_easyfixter_id = ?` in the WHERE clause as a second guard so a
 * tech can never mutate another tech's job even if the route check is
 * bypassed in future.
 *
 * Schema notes (verified against EasyFix_CRM JobDaoImpl.java mapper +
 * the legacy mobile API contract /tmp/deepskill-src/lib/src/api/app_api.dart):
 *   - fk_easyfixter_id            legacy typo, preserved.
 *   - cancel_reason_id / cancel_comment / cancel_by / cancel_date_time
 *                                 CANCELLED stamps (also stamped by
 *                                 jobService.setStatus — we route cancel
 *                                 through it so the CancelJob webhook +
 *                                 customer SMS fire from one place).
 *   - tx_selfie_id                FK to `document.id` for the reached-
 *                                 location selfie (JobDaoImpl.java:1874).
 *   - is_collected_cash_by_app    BIT — cash collected on this visit.
 *   - collect_cash_reason_id      FK collect_cash_reason_by_app.id.
 *   - material_charge             amount collected (legacy `materialCharge`).
 *   - problem_reason_id           FK problem_with_job_reason.id.
 *   - revisit_reason_id           FK revisit_reason_by_app.id.
 *   - revisit_date / revisit_time_slot   next-visit appointment.
 *
 * All column writes are probe-gated so a partially-migrated deploy
 * degrades gracefully (skips the missing column, never 500s).
 */

const STATUS_CANCELLED = 6;

// ─── Column-existence probes (cached per-process) ───────────────────
/*
 * Mirrors the probe pattern in job.service.js / job-comment.service.js:
 * INFORMATION_SCHEMA lookup, cached, soft-fail-to-false so an
 * un-migrated deploy skips the column instead of breaking the write.
 */
const _colCache = {};
async function hasJobColumn(colName) {
  if (_colCache[colName] != null) return _colCache[colName];
  try {
    const [rows] = await pool.query(
      `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'tbl_job'
          AND COLUMN_NAME  = ?
        LIMIT 1`,
      [colName],
    );
    _colCache[colName] = rows.length > 0;
  } catch {
    _colCache[colName] = false;
  }
  return _colCache[colName];
}

// ─── Ownership guard ─────────────────────────────────────────────────
/*
 * Fetch the minimal job row + confirm it belongs to the technician.
 * Returns the row when owned, or throws a tagged error (.status) the
 * route maps to the right HTTP code. Single indexed lookup — no joins.
 */
async function getOwnedJob(jobId, efrId) {
  const [[row]] = await pool.query(
    `SELECT job_id, job_status, fk_easyfixter_id, fk_customer_id, fk_client_id, otp
       FROM tbl_job WHERE job_id = ? LIMIT 1`,
    [jobId],
  );
  if (!row) {
    const e = new Error('job not found'); e.status = 404; throw e;
  }
  if (Number(row.fk_easyfixter_id) !== Number(efrId)) {
    // 404 (not 403) so a tech can't probe which job ids exist.
    const e = new Error('job not found'); e.status = 404; throw e;
  }
  return row;
}

// ─── Cancel (legacy actionType 27) ──────────────────────────────────
/*
 * POST /jobs/:id/cancel { reason, reasonId }
 *
 * Routes through jobService.setStatus(CANCELLED) so the shared path owns
 * the cancel_* stamps + the CancelJob webhook + the customer SMS. The
 * legacy mobile endpoint was `easyfixer-call-record/cancel` with
 * actionType=27; the cancel-by-app reason id maps to cancel_reason_id
 * and the free-text comment to cancel_comment.
 *
 * `reasonId` is the FK into the app's cancel-reason list
 * (job_cancel_reason_by_easyfixer_app). We ALSO mirror it onto the
 * legacy app-specific column job_cancel_reason_id_by_easyfixer (probe-
 * gated) so the CRM "cancelled by app" reporting keeps working.
 */
async function cancel(jobId, efrId, { reason, reasonId }) {
  await getOwnedJob(jobId, efrId);

  await jobService.setStatus(
    jobId,
    { status: STATUS_CANCELLED, reasonId: reasonId || null, comment: reason || null },
    { user_id: efrId },
  );

  // Mirror the app-specific cancel reason + flag for legacy CRM reports.
  // Soft-fail: the status transition already committed via setStatus;
  // this mirror is a reporting convenience, not a correctness gate.
  try {
    const sets = [];
    const vals = [];
    if (reasonId != null && await hasJobColumn('job_cancel_reason_id_by_easyfixer')) {
      sets.push('job_cancel_reason_id_by_easyfixer = ?');
      vals.push(Number(reasonId));
    }
    if (await hasJobColumn('is_cancelled_by_app')) {
      sets.push('is_cancelled_by_app = 1');
    }
    if (sets.length) {
      vals.push(jobId, efrId);
      await pool.query(
        `UPDATE tbl_job SET ${sets.join(', ')} WHERE job_id = ? AND fk_easyfixter_id = ?`,
        vals,
      );
    }
  } catch (mirrorErr) {
    logger.warn({ err: mirrorErr.message, jobId, efrId }, 'cancel: app-reason mirror failed (job already cancelled)');
  }

  return { cancelled: true };
}

// ─── Check-in PIN SMS ────────────────────────────────────────────────
/*
 * POST /jobs/:id/checkin-sms
 *
 * (Re)sends the customer the check-in PIN (the 4-digit code stamped on
 * tbl_job.otp at order confirmation — see job.service.js setStatus
 * BOOKED branch). The technician asks the customer to read it back to
 * verify they're at the right doorstep. Legacy endpoint was
 * `jobs/check-in-sms-customer/{jobId}`.
 *
 * Reuses the existing SMS template service (job_stage='CHECK_IN', falling
 * back to inline text when no DLT template row exists — mirrors the
 * notification-orchestrator fallback pattern) + sms.service.send.
 */
async function sendCheckinSms(jobId, efrId) {
  await getOwnedJob(jobId, efrId);

  // Pull the customer's mobile + the PIN in one indexed join.
  const [[row]] = await pool.query(
    `SELECT cu.customer_mob_no, j.otp, j.fk_client_id
       FROM tbl_job j
       LEFT JOIN tbl_customer cu ON cu.customer_id = j.fk_customer_id
      WHERE j.job_id = ? LIMIT 1`,
    [jobId],
  );
  if (!row || !row.customer_mob_no) {
    const e = new Error('customer mobile not on file for this job');
    e.status = 422; throw e;
  }
  const pin = row.otp != null && String(row.otp).trim() !== '' ? String(row.otp).trim() : null;
  if (!pin) {
    // No PIN minted yet (job never went through the BOOKED-confirm path).
    const e = new Error('no check-in PIN available for this job');
    e.status = 422; throw e;
  }

  // Prefer a DLT-approved template; fall back to inline text so dev /
  // un-seeded deploys still deliver something (DLT may drop it in prod).
  // VERIFY: confirm the live tbl_sms_transational_meta row uses
  // job_stage='CHECK_IN' for the check-in PIN template.
  let message = null;
  try {
    const tpl = await smsTemplate.getTemplate('CHECK_IN', { clientId: row.fk_client_id || 1 });
    if (tpl) message = smsTemplate.fill(tpl, [pin]);
  } catch (tplErr) {
    logger.warn({ err: tplErr.message, jobId }, 'checkin-sms: template lookup failed, using inline text');
  }
  if (!message) {
    message = `EasyFix: Your technician check-in PIN is ${pin}. Share it only with the technician at your door.`;
  }

  await smsService.send({ to: row.customer_mob_no, message });
  return { sent: true };
}

// ─── Reached-location selfie ─────────────────────────────────────────
/*
 * POST /jobs/:id/selfie { selfieImageId }
 *
 * Stores the reached-location selfie reference on the job. The selfie
 * file is uploaded separately (the app POSTs the image, gets back a
 * document id, then calls this with that id). Maps to tbl_job.tx_selfie_id
 * (FK document.id — JobDaoImpl.java:1874). Legacy endpoint:
 * `jobs/upload-selfie` with body { jobId, selfieId }.
 *
 * Not a status transition — a plain owned-row UPDATE.
 */
async function saveSelfie(jobId, efrId, { selfieImageId }) {
  await getOwnedJob(jobId, efrId);

  if (!(await hasJobColumn('tx_selfie_id'))) {
    // VERIFY: tx_selfie_id confirmed on legacy schema; if a deploy lacks
    // it the selfie ref simply isn't persisted (image upload still
    // succeeded out-of-band). Surface a clear error rather than a silent
    // no-op so the gap is visible in QA.
    const e = new Error('selfie column not present on this deployment');
    e.status = 501; throw e;
  }

  await pool.query(
    `UPDATE tbl_job SET tx_selfie_id = ?, last_update_time = ?
      WHERE job_id = ? AND fk_easyfixter_id = ?`,
    [Number(selfieImageId), new Date(), jobId, efrId],
  );
  return { ok: true };
}

// ─── Dashboard search by job id ─────────────────────────────────────
/*
 * GET /jobs/search?jobId=
 *
 * Finds the technician's job by id for the dashboard search bar. Returns
 * a compact camelCase detail summary (NOT the full getById payload — the
 * search result card only needs the headline fields). Scoped to the
 * authed tech: a job belonging to someone else returns null, identical
 * to "not found", so a tech can't enumerate other techs' jobs.
 */
async function searchByJobId(jobId, efrId) {
  const [[row]] = await pool.query(
    `SELECT j.job_id, j.job_reference_id, j.client_ref_id, j.job_status,
            j.job_type, j.requested_date_time, j.time_slot, j.otp,
            cu.customer_name, cu.customer_mob_no,
            ad.address, ad.locality, ad.landmark, ad.pin_code, ad.gps_location,
            ci.city_name,
            cl.client_name,
            sc.service_catg_name AS service_category
       FROM tbl_job j
       LEFT JOIN tbl_customer    cu ON cu.customer_id     = j.fk_customer_id
       LEFT JOIN tbl_address     ad ON ad.address_id       = j.fk_address_id
       LEFT JOIN tbl_city        ci ON ci.city_id          = ad.city_id
       LEFT JOIN tbl_client      cl ON cl.client_id        = j.fk_client_id
       LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = j.fk_service_catg_id
      WHERE j.job_id = ? AND j.fk_easyfixter_id = ?
      LIMIT 1`,
    [jobId, efrId],
  );
  if (!row) return null;
  return {
    jobId:           row.job_id,
    jobReferenceId:  row.job_reference_id,
    clientRefId:     row.client_ref_id,
    jobStatus:       row.job_status,
    jobType:         row.job_type,
    requestedAt:     row.requested_date_time,
    timeSlot:        row.time_slot,
    checkinPin:      row.otp ?? null,
    customerName:    row.customer_name,
    customerMobile:  row.customer_mob_no,
    address:         row.address,
    locality:        row.locality,
    landmark:        row.landmark,
    pincode:         row.pin_code,
    gpsLocation:     row.gps_location,
    city:            row.city_name,
    clientName:      row.client_name,
    serviceCategory: row.service_category,
  };
}

module.exports = {
  cancel,
  sendCheckinSms,
  saveSelfie,
  searchByJobId,
};
