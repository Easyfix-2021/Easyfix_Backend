const { pool } = require('../db');
const logger = require('../logger');
const jobService = require('./job.service');
const jobLocation = require('./job-location.service');
const smsService = require('./sms.service');
const gallabox = require('./gallabox.whatsapp.service');

/*
 * The approved Gallabox template that carries the job-closing PIN.
 *
 * 'customer_job_pin' is the name registered in the Gallabox console on
 * 2026-09-09, confirmed by the product owner. It is a DEFAULT rather than a
 * literal so the name can be corrected without a deploy — Gallabox answers 200
 * for a template name it does not recognise and the handset simply never
 * receives anything, so a wrong name here is a SILENT non-delivery that no
 * delivery check can catch, and being able to fix it from config matters more
 * than saving one indirection.
 *
 * Setting it to an empty string is meaningful: it disables the WhatsApp path
 * and falls back to SMS with a loud log line.
 */
const CLOSING_PIN_TEMPLATE = String(
  process.env.GALLABOX_CLOSING_PIN_TEMPLATE ?? 'customer_job_pin',
).trim();

/*
 * Mobile Job Lifecycle — the technician-app order flow that sits on top
 * of the shared jobService transitions:
 *
 *   cancel        → a cancel REQUEST for ops (job_status 1, flag set)
 *   reschedule    → a reschedule REQUEST for ops (job_status 1, flag set)
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
 *   - is_cancelled_by_app /       BIT — "the technician has ASKED for this".
 *     is_rescheduled_by_app       See THE REQUEST MODEL below.
 *   - cancel_date_time /          Request stamps for the cancel ask. NOT the
 *     cancel_comment /            same columns setStatus(6) writes for an
 *     job_cancel_reason_id_by_easyfixer   actioned cancellation.
 *   - reschedule_date_time_app    VARCHAR(255) — the REQUESTED appointment as
 *                                 'yyyy-MM-dd HH:mm' TEXT. Deliberately not a
 *                                 DATETIME: it is a proposal, not a schedule.
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

/*
 * ═══════════════════ THE REQUEST MODEL ═══════════════════════════════
 *
 * A technician does NOT cancel or reschedule a job. They ASK, and ops
 * actions the ask. This is what the Flutter app did and what the CRM has
 * always been built to read; the Node port briefly made both endpoints
 * act directly, which is what this restores.
 *
 * A request is: job_status = STATUS_REQUEST_PENDING (1, "Scheduled" —
 * unchanged for a job about to start) plus is_cancelled_by_app = 1 or
 * is_rescheduled_by_app = 1, plus the ask's own stamps. The job does not
 * move. Production carries 19 jobs sitting at exactly that state right
 * now; rows at job_status 6 with is_cancelled_by_app = 1 are the ones ops
 * later actioned into a real cancellation.
 *
 * TWO CONSEQUENCES THAT ARE EASY TO GET WRONG:
 *
 *  1. NO setStatus. Not setStatus(6) for cancel (that IS the cancellation
 *     — webhook, customer SMS, cancel_by, the lot), and not setStatus with
 *     the current status for reschedule either: the no-op-transition trick
 *     the old reschedule route used rode the extras allowlist straight
 *     into `requested_date_time`, i.e. it MOVED THE REAL APPOINTMENT. A
 *     request must leave requested_date_time alone; only ops writes it.
 *
 *  2. NO WhatsApp on cancel. The legacy implementation had its cancel
 *     WhatsApp commented out and shipped that way for years, so a customer
 *     has never been told "your technician asked to cancel" — which is
 *     correct, because at request time nothing has been decided yet.
 *     Its absence here is deliberate; do not "restore" it. Reschedule DOES
 *     notify, but the Project Manager, not the customer — the person who
 *     has to action the ask.
 */
const STATUS_REQUEST_PENDING = 1;

/*
 * tbl_job_comment.comment_on for the two asks — legacy wire codes, verified
 * against ~50k live rows (comment_on 9) and ~2.4k (comment_on 8), all with
 * source_type 'API_App'. Exported so nothing re-types the digit.
 */
const COMMENT_ON_RESCHEDULE_BY_APP = 8;
const COMMENT_ON_CANCEL_BY_APP     = 9;

/*
 * bit(1) comes back from mysql2 as a Buffer, not a number, and EVERY
 * Buffer is truthy — including the one holding 0. `if (row.is_cancelled_by_app)`
 * therefore reports every job as having a pending request. Always read a
 * BIT through here.
 */
function bitTrue(v) {
  if (Buffer.isBuffer(v)) return v[0] === 1;
  return Number(v) === 1;
}

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
    return _colCache[colName];
  } catch (e) {
    /*
     * Soft-fail to false is right for an optional column, but it is wrong to
     * make that answer PERMANENT.
     *
     * The old bare `catch { _colCache[colName] = false; }` did exactly that:
     * the memo guard is `!= null`, and `false != null`, so one transient
     * information_schema error pinned the column as missing for the rest of
     * the process. saveSelfie turns a false into a hard 501 "selfie column not
     * present on this deployment" — a claim that is simply untrue, since
     * tx_selfie_id is present in production. A technician could not upload a
     * reached-location selfie again until the container restarted.
     *
     * Not cached now, so the next call re-probes and the 501 is at worst a
     * retryable blip. The bare catch also swallowed the error with no log at
     * all, which is why this left no trace to find.
     */
    logger.warn('tbl_job column probe failed · ' + colName + ' · ' + e.message
      + ' — treating as absent for this call only');
    return false;
  }
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

// ─── Request audit rows (shared by cancel + reschedule) ─────────────
/*
 * The two audit trails every app request leaves, both best-effort.
 *
 * BEST-EFFORT IS THE POINT: the tbl_job UPDATE above them has already
 * committed, so the technician's ask exists whether or not the CRM's
 * history tables took the row. Failing the request here would show the
 * technician an error for an ask that landed — and they would send it
 * again, producing two.
 *
 *  - tbl_easyfixer_call_record: the legacy TECHNICIAN-side action feed the
 *    CRM's Call Info modal reads. `action` and `source` are ENUMs
 *    ('accepted','rejected','cancelled') / ('app','website','crm'), so
 *    only those literals are storable — a typo here inserts a silent NULL,
 *    not an error. Reschedule has no enum member of its own and legacy
 *    never wrote one, so it does NOT get a call record.
 *  - tbl_job_comment: comment_on 9 = cancel-by-app, 8 = reschedule-by-app.
 *    Verified against ~53k live rows of exactly this shape.
 *
 * `commented_by` is left NULL on purpose. It is a tbl_user FK and its
 * reader (job-comment.service listComments) joins it to tbl_user for the
 * display name; the legacy app wrote an efr id into it, so those rows
 * render whichever OPERATOR happens to hold that user_id. The technician's
 * identity goes in tbl_job_comment.efr_id, the column that actually types
 * it — same choice the checkout remark path already makes.
 */
async function recordRequestCallRecord(jobId, efrId, { action, reasonId, comment }) {
  try {
    await pool.query(
      `INSERT INTO tbl_easyfixer_call_record
         (efr_id, job_id, action, reason_id, comment, source, insert_date_time)
       VALUES (?, ?, ?, ?, ?, 'app', ?)`,
      [efrId, jobId, action, reasonId ?? null, comment || null, new Date()],
    );
  } catch (e) {
    logger.warn('Request call-record failed (request still recorded) · jobId=' + jobId
      + ' · action=' + action + ' · ' + e.message);
  }
}

async function recordRequestComment(jobId, efrId, { commentOn, reasonId, comment, requestedDateTime }) {
  try {
    await pool.query(
      `INSERT INTO tbl_job_comment
         (job_id, comments, comment_on, enum_reason_id, efr_id,
          requested_date_time, source_type, job_stage)
       VALUES (?, ?, ?, ?, ?, ?, 'API_App', ?)`,
      [
        jobId,
        // '' rather than NULL for a reason-only ask: the row must exist even
        // with nothing typed, because the ask itself is the history entry.
        // Legacy wrote a single space here for the same reason.
        comment || '',
        commentOn,
        reasonId ?? null,
        efrId,
        requestedDateTime || null,
        STATUS_REQUEST_PENDING,
      ],
    );
  } catch (e) {
    logger.warn('Request job-comment failed (request still recorded) · jobId=' + jobId
      + ' · comment_on=' + commentOn + ' · ' + e.message);
  }
}

// ─── Cancel REQUEST (legacy actionType 27) ──────────────────────────
/*
 * POST /jobs/:id/cancel { reason, reasonId }
 *
 * Records the technician's ASK to cancel. It does not cancel: see THE
 * REQUEST MODEL above for why setStatus(6) is wrong here.
 *
 * `reasonId` is an `action_taken_reason` id — action_type 27, user_type 4
 * (lookup.service.appCancelReasons, served at
 * /shared/lookup/app-cancel-reasons). It is NOT the
 * `job_cancel_reason_by_easyfixer_app` table this comment used to name;
 * that claim was wrong, and joining the live ids (267–271) against
 * action_taken_reason is what disproved it. Written to
 * job_cancel_reason_id_by_easyfixer (the app-specific slot the CRM's
 * "cancelled by app" reporting reads) and mirrored onto enum_reason_id
 * (the generic slot the Remarks history resolves).
 *
 * cancel_reason_id / cancel_by are deliberately NOT written: those belong
 * to an actioned cancellation and setting them now would make a pending
 * ask indistinguishable from a decision ops never made.
 */
async function cancel(jobId, efrId, { reason, reasonId }) {
  logger.info('Cancel request from app · jobId=' + jobId + ' reasonId=' + (reasonId ?? '-'));
  await getOwnedJob(jobId, efrId);

  const now = new Date();
  const comment = reason == null ? null : String(reason).trim() || null;
  /*
   * One UPDATE, not a transition. `fk_easyfixter_id = ?` is the second
   * ownership guard every write in this file carries (the route already
   * checked) — a request can only ever be raised against the technician's
   * own job, even if the route check is bypassed one day.
   */
  const [res] = await pool.query(
    `UPDATE tbl_job
        SET job_status = ?,
            is_cancelled_by_app = 1,
            cancel_date_time = ?,
            cancel_comment = ?,
            job_cancel_reason_id_by_easyfixer = ?,
            enum_reason_id = ?,
            remarks = ?,
            remarks_date_time = ?
      WHERE job_id = ? AND fk_easyfixter_id = ?`,
    [
      STATUS_REQUEST_PENDING, now, comment,
      reasonId ?? null, reasonId ?? null,
      comment, now,
      jobId, efrId,
    ],
  );
  if (!res || res.affectedRows === 0) {
    // getOwnedJob passed a moment ago, so zero rows means the job was
    // reassigned underneath us. Same 404 the ownership guard gives.
    const e = new Error('job not found'); e.status = 404; throw e;
  }

  await recordRequestCallRecord(jobId, efrId, { action: 'cancelled', reasonId, comment });
  await recordRequestComment(jobId, efrId, {
    commentOn: COMMENT_ON_CANCEL_BY_APP, reasonId, comment,
  });

  // NO WhatsApp here — see THE REQUEST MODEL. Nothing has been decided yet.
  logger.info('Cancel request recorded · jobId=' + jobId);
  return { requested: true, requestType: 'cancel' };
}

// ─── Reschedule REQUEST (legacy actionType 26) ──────────────────────
/*
 * POST /jobs/:id/reschedule { newDate, reasonId, remarks? }
 *
 * Records the technician's ASK to move the appointment. The APPOINTMENT
 * DOES NOT MOVE: `requested_date_time` is untouched and the proposal lands
 * in `reschedule_date_time_app` instead. The previous implementation wrote
 * requested_date_time through setStatus's extras allowlist, so a
 * technician could silently re-schedule a customer's visit with nobody
 * approving it — and, because it parsed the app's wall-clock string with
 * `new Date()` in a UTC container, usually to the wrong hour as well.
 *
 * `newDate` is an IST WALL-CLOCK string ('YYYY-MM-DDTHH:mm[:ss]' — the app
 * builds it from local getters, never toISOString). It is sliced, never
 * parsed: reschedule_date_time_app is VARCHAR and the value must survive
 * verbatim. See the assignBody note in validators/job.validator.js for why
 * Joi.date() is banned on every one of these fields.
 */
async function requestReschedule(jobId, efrId, { newDate, reasonId, remarks }) {
  logger.info('Reschedule request from app · jobId=' + jobId + ' reasonId=' + (reasonId ?? '-'));
  await getOwnedJob(jobId, efrId);

  const now = new Date();
  // 'YYYY-MM-DDTHH:mm:ss' → 'YYYY-MM-DD HH:mm'. Minute precision is what the
  // column holds in production and what the CRM renders.
  const requestedText = String(newDate).replace('T', ' ').slice(0, 16);
  const comment = remarks == null ? null : String(remarks).trim() || null;

  const sets = [
    'job_status = ?',
    'is_rescheduled_by_app = 1',
    'reschedule_date_time_app = ?',
    'enum_reason_id = ?',
    'remarks = ?',
    'remarks_date_time = ?',
    // Kept from the previous implementation: ops counts how many times a job
    // has been pushed, and the ask is the thing being counted.
    'resch_job_count = COALESCE(resch_job_count, 0) + 1',
  ];
  const vals = [STATUS_REQUEST_PENDING, requestedText, reasonId ?? null, comment, now];

  /*
   * reschedule_reason_id and the two reschedule_* comment columns are
   * CONDITIONAL, matching legacy. A 0 reasonId is the app's "nothing
   * picked" sentinel, not reason #0, and writing it would point the CRM's
   * reason join at a row that does not exist. Likewise reschedule_remarks /
   * reschedule_at_app are only stamped when a comment actually came with
   * the ask — blank-stamping them erases the remark from a PREVIOUS ask
   * that ops has not looked at yet.
   */
  if (reasonId != null && Number(reasonId) !== 0) {
    sets.push('reschedule_reason_id = ?');
    vals.push(Number(reasonId));
  }
  if (comment) {
    sets.push('reschedule_remarks = ?', 'reschedule_at_app = ?');
    vals.push(comment, now);
  }

  vals.push(jobId, efrId);
  const [res] = await pool.query(
    `UPDATE tbl_job SET ${sets.join(', ')} WHERE job_id = ? AND fk_easyfixter_id = ?`,
    vals,
  );
  if (!res || res.affectedRows === 0) {
    const e = new Error('job not found'); e.status = 404; throw e;
  }

  await recordRequestComment(jobId, efrId, {
    commentOn: COMMENT_ON_RESCHEDULE_BY_APP,
    reasonId,
    comment,
    requestedDateTime: requestedText,
  });

  // Fire-and-forget: the PM is who ACTIONS this, so they are told. Awaited so
  // failures are logged in request context, but never rethrown — a WhatsApp
  // outage must not lose a request that is already committed.
  await notifyPmOfRescheduleRequest(jobId, requestedText, reasonId);

  logger.info('Reschedule request recorded · jobId=' + jobId + ' · requested=' + requestedText);
  return { requested: true, requestType: 'reschedule', requestedDateTime: requestedText };
}

/*
 * Gallabox WhatsApp to the job's Project Manager.
 *
 * Recipient: tbl_job.job_vertical_manager → tbl_user. That column is the
 * job's own PM snapshot (populated on ~2/3 of recent jobs; where it
 * resolves it resolves to a real user with a mobile 100% of the time). It
 * is used rather than re-deriving the PM from tbl_vertical_mapping so the
 * message reaches whoever owned the job, not whoever owns the vertical
 * today.
 *
 * Template name is a DEFAULT, not a literal, for the same reason
 * CLOSING_PIN_TEMPLATE is: Gallabox answers 200 for a template name it does
 * not recognise and the handset simply never receives anything, so a wrong
 * name is a SILENT non-delivery no delivery check can catch. Setting the
 * env var to an empty string disables the send with a loud log line.
 */
const RESCHEDULE_REQUEST_TEMPLATE = String(
  process.env.GALLABOX_RESCHEDULE_REQUEST_TEMPLATE ?? 'pm_reschedule_request',
).trim();

async function notifyPmOfRescheduleRequest(jobId, requestedText, reasonId) {
  if (!RESCHEDULE_REQUEST_TEMPLATE) {
    logger.warn('PM reschedule WhatsApp disabled (GALLABOX_RESCHEDULE_REQUEST_TEMPLATE empty) · jobId=' + jobId);
    return;
  }
  try {
    const [[row]] = await pool.query(
      `SELECT pm.user_name AS pm_name, pm.mobile_no AS pm_mobile,
              ef.efr_name AS technician_name,
              COALESCE(NULLIF(TRIM(j.job_customer_name), ''), cu.customer_name) AS customer_name,
              (SELECT atr.action_desc FROM action_taken_reason atr
                WHERE atr.id = ? LIMIT 1) AS reason_desc
         FROM tbl_job j
         LEFT JOIN tbl_user      pm ON pm.user_id = j.job_vertical_manager
         LEFT JOIN tbl_easyfixer ef ON ef.efr_id  = j.fk_easyfixter_id
         LEFT JOIN tbl_customer  cu ON cu.customer_id = j.fk_customer_id
        WHERE j.job_id = ? LIMIT 1`,
      [reasonId ?? null, jobId],
    );
    if (!row || !row.pm_mobile) {
      // A third of jobs carry no vertical manager. Not an error — there is
      // nobody to tell, and the request is still visible in the CRM list.
      logger.warn('PM reschedule WhatsApp skipped · no project manager on job · jobId=' + jobId);
      return;
    }
    await gallabox.sendTemplate({
      to: row.pm_mobile,
      recipientName: row.pm_name || '',
      templateName: RESCHEDULE_REQUEST_TEMPLATE,
      /*
       * Positional binding — the shape every template in this backend except
       * the two enquiry ones uses. Positional keys against a NAMED template
       * bind to nothing and deliver "Hello []", so this must match how the
       * template was registered.
       *   {{1}} technician  {{2}} job id  {{3}} customer
       *   {{4}} requested slot  {{5}} reason
       */
      bodyValues: {
        1: row.technician_name || 'A technician',
        2: String(jobId),
        3: row.customer_name || 'the customer',
        4: requestedText,
        // Never send an empty template variable — some BSPs reject the whole
        // template rather than the one field.
        5: (row.reason_desc || '').trim() || 'Not specified',
      },
    });
  } catch (e) {
    logger.warn('PM reschedule WhatsApp failed (request still recorded) · jobId=' + jobId + ' · ' + e.message);
  }
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
  logger.info('Send check-in PIN SMS · jobId=' + jobId);
  await getOwnedJob(jobId, efrId);

  // Pull the customer's mobile + the PIN in one indexed join, plus the two
  // names the WhatsApp template addresses the customer and the technician by.
  const [[row]] = await pool.query(
    `SELECT cu.customer_mob_no,
            cu.customer_name,
            COALESCE(NULLIF(TRIM(j.job_customer_name), ''), cu.customer_name) AS display_name,
            ef.efr_name AS technician_name,
            j.otp, j.fk_client_id
       FROM tbl_job j
       LEFT JOIN tbl_customer cu ON cu.customer_id = j.fk_customer_id
       LEFT JOIN tbl_easyfixer ef ON ef.efr_id = j.fk_easyfixter_id
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

  /*
   * ── WHY THIS IS WHATSAPP NOW, AND WHY THE SMS PATH STAYS ──────────────────
   *
   * This used to ask sms-template.service for job_stage 'CHECK_IN'. That row
   * does not exist — measured against the live table, `job_stage = 'CHECK_IN'`
   * returns ZERO rows (the registered keys are lowerCamelCase: 'checkin',
   * 'checkInBeforeTime', 'checkInAfterTime'). So the lookup always returned
   * null, the inline fallback below it always won, and an UNREGISTERED body
   * went on the wire. Indian DLT scrubs an unregistered body at the aggregator:
   * every one of these was "Rejected, 0 INR" in the SMS Country console.
   *
   * It went unnoticed for months because nothing here could see it — the send
   * result was discarded and this function returned { sent: true } regardless,
   * so the app and the CRM's Resend button both reported success on a message
   * the provider had thrown away. That is fixed below too: the channel and the
   * delivery outcome are returned.
   *
   * And there is no correct SMS template to switch to. Every registered PIN
   * template says "to START the service" (resendJobPin, resendJobPinNew,
   * mobileCustomerOtp) because the PIN used to start the job; commit 1d69ff0
   * (2026-09-07) made it CLOSE the job instead. Rather than send words that
   * contradict the action, the closing PIN moves to WhatsApp, where the
   * template is ours to word correctly.
   *
   * SMS remains the fallback for a customer WhatsApp cannot reach.
   */
  const customerName = String(row.display_name || '').trim() || 'there';
  const technicianName = String(row.technician_name || '').trim() || 'our technician';

  let channel = 'sms';
  let delivered = false;

  if (CLOSING_PIN_TEMPLATE) {
    /*
     * Positional binding, matching the registered body:
     *   Hi {{1}}, your EasyFix *Job #{{2}}* is ready to be closed. Our
     *   technician {{3}} will ask you for this PIN to complete the visit: {{4}}
     * The shape must match how the template was registered — this repo already
     * carries the scar that positional keys against a NAMED template bind to
     * nothing and deliver "Hello []".
     */
    const wa = await gallabox.sendTemplate({
      to: row.customer_mob_no,
      recipientName: String(row.customer_name || '').trim(),
      templateName: CLOSING_PIN_TEMPLATE,
      bodyValues: { 1: customerName, 2: String(jobId), 3: technicianName, 4: pin },
    });
    if (wa.delivered) {
      logger.info('Closing PIN sent on WhatsApp · jobId=' + jobId);
      return { sent: true, channel: 'whatsapp', delivered: true };
    }
    if (wa.disabled) return { sent: false, channel: 'whatsapp', delivered: false, disabled: true };
    logger.warn(
      'Closing-PIN WhatsApp not delivered, falling back to SMS · jobId=' + jobId
      + ' · ' + (wa.error || 'httpStatus=' + wa.httpStatus),
    );
  } else {
    logger.warn(
      'GALLABOX_CLOSING_PIN_TEMPLATE is not set — the closing PIN is going out over '
      + 'SMS, which DLT currently rejects. Set it to the approved Gallabox template '
      + 'name. jobId=' + jobId,
    );
  }

  /*
   * The SMS fallback is deliberately the shortest sentence that still says what
   * the PIN is FOR. It remains unregistered with DLT and will very likely be
   * rejected — but a rejected fallback that is logged honestly is better than a
   * silent one, and the WhatsApp path above is the route that works.
   */
  const smsResult = await smsService.send({
    to: row.customer_mob_no,
    message: `EasyFix: Your job closing PIN is ${pin}. Share it only with the technician at your door.`,
  });
  delivered = Boolean(smsResult && smsResult.delivered);
  if (!delivered) {
    logger.warn('Closing-PIN SMS not delivered either · jobId=' + jobId);
  }
  return { sent: delivered, channel, delivered };
}

// ─── Reached-location geofence ───────────────────────────────────────
/*
 * The device fix the technician actually reported. Two shapes reach us and
 * both are optional:
 *   - `geofence: { latitude, longitude, … }` — the 2026-09-07 contract;
 *   - top-level `latitude` / `longitude` — what the app has been sending to
 *     this endpoint all along (Joi's stripUnknown was silently dropping them).
 * The block wins when present. Returns null when there is no usable fix, and
 * null means SKIP — never "outside".
 */
function resolveDeviceFix({ latitude, longitude, geofence }) {
  const lat = geofence && geofence.latitude != null ? geofence.latitude : latitude;
  const lng = geofence && geofence.longitude != null ? geofence.longitude : longitude;
  if (lat == null || lng == null) return null;
  const latitudeNum = Number(lat);
  const longitudeNum = Number(lng);
  if (!Number.isFinite(latitudeNum) || !Number.isFinite(longitudeNum)) return null;
  // (0,0) is the Gulf of Guinea — what a device with no fix degrades to, and
  // never a real arrival. Treat it as "no fix" rather than as 8,000 km outside.
  if (latitudeNum === 0 && longitudeNum === 0) return null;
  return { latitude: latitudeNum, longitude: longitudeNum };
}

/*
 * Evaluate the arrival fix against the site, enforce if ops has asked for it,
 * and record the result.
 *
 * SOFT BY DEFAULT: the server records and never rejects. Hard mode
 * (easyfix_properties `geofence.enforcement.enabled` = 'true') rejects with 400
 * ONLY when the server itself computed "outside" AND no override reason was
 * given. Every other combination proceeds, including:
 *   - the site has no coordinates            → nothing to compare against
 *   - the device sent no fix                 → nothing to compare with
 *   - outside the fence WITH a reason        → the audited override
 * i.e. missing data never blocks a job start, which is the product rule.
 *
 * The verdict is the SERVER's, computed from the raw device coordinates. The
 * client's own distanceMeters / withinFence claims are recorded nowhere and
 * decide nothing — a gate that reads a boolean supplied by the thing being
 * gated is not a gate. A divergence between the two is logged, because that is
 * the signal that an app build is computing the fence differently from us.
 */
async function recordArrivalGeofence(jobId, efrId, device, claimed) {
  const [[row]] = await pool.query(
    `SELECT ad.gps_location
       FROM tbl_job j
       LEFT JOIN tbl_address ad ON ad.address_id = j.fk_address_id
      WHERE j.job_id = ? LIMIT 1`,
    [jobId],
  );
  const verdict = jobLocation.evaluateGeofence(row && row.gps_location, device);
  const overrideReason = claimed && claimed.overrideReason
    ? String(claimed.overrideReason).trim() : '';

  if (!verdict) {
    logger.info('Arrival geofence not evaluated · jobId=' + jobId
      + ' · ' + (row && row.gps_location ? 'device fix unusable' : 'site has no coordinates')
      + ' — recording position only, not blocking');
  } else {
    logger.info('Arrival geofence · jobId=' + jobId
      + ' · distance=' + verdict.distanceMeters + 'm'
      + ' · radius=' + verdict.radiusMeters + 'm'
      + ' · within=' + verdict.withinFence
      + ' · override=' + (overrideReason ? 'yes' : 'no'));
    if (claimed && claimed.withinFence != null && Boolean(claimed.withinFence) !== verdict.withinFence) {
      logger.warn('Arrival geofence verdict differs from the app\'s · jobId=' + jobId
        + ' · app=' + Boolean(claimed.withinFence) + ' · server=' + verdict.withinFence
        + ' — the server verdict is authoritative');
    }
  }

  /*
   * Recorded on tbl_job_location_track — the EasyFix-owned live-track table the
   * CRM already reads for "where is my technician", indexed on (job_id,
   * captured_at). The arrival row is the one with within_fence NOT NULL; the
   * ops abuse report is `WHERE within_fence = 0 AND override_reason IS NOT NULL`.
   * Best-effort: an audit write must never be what stops a technician working.
   */
  try {
    await jobLocation.addPing(jobId, efrId, {
      latitude: device.latitude,
      longitude: device.longitude,
      accuracy: null,
      geofence: verdict
        ? { ...verdict, overrideReason: overrideReason || null }
        : { distanceMeters: null, withinFence: null, overrideReason: overrideReason || null },
    });
  } catch (e) {
    logger.warn('Arrival geofence audit write failed · jobId=' + jobId + ' · ' + e.message
      + ' — continuing, the technician is not blocked by an audit failure');
  }

  /*
   * Enforcement runs AFTER the audit write, deliberately. A blocked attempt is
   * the single most interesting row ops can have, and throwing before the
   * INSERT would make exactly those attempts the ones that leave no trace.
   * Blocked rows are `within_fence = 0 AND override_reason IS NULL`, so they
   * sit beside the overrides without polluting the override report.
   */
  if (verdict && !verdict.withinFence && !overrideReason && jobLocation.enforcementEnabled()) {
    logger.warn('Arrival BLOCKED, outside fence with no reason · jobId=' + jobId
      + ' · distance=' + verdict.distanceMeters + 'm');
    const e = new Error(
      'You are ' + Math.round(verdict.distanceMeters) + 'm from the job location '
      + '(allowed ' + Math.round(verdict.radiusMeters) + 'm). Add a reason to continue.',
    );
    e.status = 400;
    throw e;
  }
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
async function saveSelfie(jobId, efrId, { selfieImageId, latitude, longitude, geofence }) {
  logger.info('Save reached-location selfie · jobId=' + jobId + ' selfieImageId=' + selfieImageId);
  await getOwnedJob(jobId, efrId);

  /*
   * ── GEOFENCE (2026-09-07), ENTIRELY ADDITIVE ────────────────────────────
   *
   * Runs FIRST, before the tx_selfie_id write, so a hard-mode rejection cannot
   * leave the job half-mutated.
   *
   * A caller that sends no device coordinates — every caller that exists today,
   * and the CRM forever — takes ZERO new work: no address lookup, no INSERT,
   * no property read, no new failure mode. The function then behaves byte-for-
   * byte as it did before this change. That equivalence is the point of the
   * whole task and it is pinned by a test
   * (tests/mobile-reached-location-geofence.test.js).
   */
  const device = resolveDeviceFix({ latitude, longitude, geofence });
  if (device) {
    await recordArrivalGeofence(jobId, efrId, device, geofence);
  }

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
  logger.info('Selfie ref saved · jobId=' + jobId);
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
 *
 * customerName (2026-08-03): this card describes a JOB, so it shows the
 * per-job name captured on the booking form (tbl_job.job_customer_name)
 * and only falls back to the customer master when that is absent.
 * NULLIF(TRIM(...), '') is required — a plain COALESCE would render a
 * BLANK name for a '' job_customer_name, which job.validator.js still
 * permits on both the create and update paths.
 */
async function searchByJobId(jobId, efrId) {
  logger.info('Search job by id · jobId=' + jobId);
  const [[row]] = await pool.query(
    `SELECT j.job_id, j.job_reference_id, j.client_ref_id, j.job_status,
            j.job_type, j.requested_date_time, j.time_slot,
            COALESCE(NULLIF(TRIM(j.job_customer_name), ''), cu.customer_name) AS customer_name,
            cu.customer_mob_no,
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
  if (!row) logger.info('Search found no job · jobId=' + jobId);
  if (!row) return null;
  logger.info('Search matched job · jobId=' + jobId + ' status=' + row.job_status);
  return {
    jobId:           row.job_id,
    jobReferenceId:  row.job_reference_id,
    clientRefId:     row.client_ref_id,
    jobStatus:       row.job_status,
    jobType:         row.job_type,
    requestedAt:     row.requested_date_time,
    timeSlot:        row.time_slot,
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

/*
 * POST /jobs/:id/location { latitude, longitude, accuracy? }
 *
 * Append a real-time GPS ping to the job's live track (tbl_job_location_track)
 * for the CRM map. getOwnedJob 404s if it isn't this tech's job, so a tech can
 * only post locations for their own active jobs. The point-in-time
 * checkin_gps_location on tbl_job is unaffected — this is the continuous trail.
 */
/*
 * Statuses a location ping is accepted for — the window from the technician
 * ACCEPTING the job to finishing it.
 *
 * ─── WHY AN ALLOWLIST AND NOT `status < 3` ─────────────────────────────────
 *
 * A 409 here is not a soft failure: the app's background task treats it as
 * "stop tracking" and self-terminates (src/lib/native/backgroundLocation.ts).
 * That is the ONLY stop that works while the app is backgrounded with no
 * screen mounted, so every terminal state MUST still 409. A range check would
 * quietly admit any future status numbered below the terminal ones and break
 * that guarantee without anyone noticing.
 *
 * SCHEDULED (1) is the accept→check-in window: the technician has taken the
 * job and is travelling to it. It used to be rejected, which is why the CRM
 * trail was empty for exactly the period an operator most wants it.
 *
 * IN_PROGRESS_ALT (20) is a genuine checked-in state (jobService's
 * CHECKED_IN_STATES pairs it with 2), and the CRM has always offered the Live
 * Location button for it — so a strict `!== 2` meant an operator could open a
 * popover for a status-20 job whose pings the server was rejecting, and that
 * 409 permanently killed the technician's tracker. Fixed here.
 *
 * DELIBERATELY EXCLUDED: ESTIMATE_PENDING_APPROVAL (15) and ON_HOLD (21).
 * Both are real mid-job pauses, and both therefore stop tracking for good —
 * a job that returns 21 → 2 only resumes when a screen mounts. That is the
 * pre-existing behaviour for every non-2 status, not a regression, and
 * widening it is a product decision about whether to track a technician who
 * is not working.
 */
const LOCATION_PING_STATES = new Set([
  jobService.STATUS.SCHEDULED,      // 1  — accepted, travelling
  jobService.STATUS.IN_PROGRESS,    // 2  — checked in, working
  jobService.STATUS.IN_PROGRESS_ALT, // 20 — the other checked-in state
]);

async function recordLocationPing(jobId, efrId, ping) {
  logger.info('Record location ping · jobId=' + jobId);
  const job = await getOwnedJob(jobId, efrId); // 404 if not the tech's job
  if (!LOCATION_PING_STATES.has(Number(job.job_status))) {
    logger.warn('Location ping rejected, job outside tracking window · jobId=' + jobId + ' status=' + job.job_status);
    const e = new Error('job not in progress'); e.status = 409; throw e;
  }
  return jobLocation.addPing(jobId, efrId, ping);
}

// ─── Questionnaire (recce checklist) ────────────────────────────────
/*
 * GET /jobs/:id/questionnaire — the yes/no checklist for a job, with any saved
 * answers pre-filled. tbl_job.fk_questionaire_id picks the questionnaire;
 * tbl_questionaire_details holds the questions (status=1, ordered by seq);
 * tbl_questionaire_answer holds this job's answers. Returns [] when the job has
 * no questionnaire assigned. Answers fetched separately + last-write-wins so
 * legacy duplicate answer rows collapse cleanly.
 */
async function getQuestionnaire(jobId, efrId) {
  logger.info('Get questionnaire · jobId=' + jobId);
  const [[job]] = await pool.query(
    `SELECT fk_questionaire_id, fk_easyfixter_id FROM tbl_job WHERE job_id = ? LIMIT 1`,
    [jobId],
  );
  if (!job || Number(job.fk_easyfixter_id) !== Number(efrId)) {
    const e = new Error('job not found'); e.status = 404; throw e;
  }
  const qid = job.fk_questionaire_id;
  if (!qid) logger.info('No questionnaire assigned · jobId=' + jobId);
  if (!qid) return [];

  const [questions] = await pool.query(
    `SELECT c_qd_id, c_qd_text, c_qd_mandatory, c_qd_seq
       FROM tbl_questionaire_details
      WHERE c_questionaire_id = ? AND status = 1
      ORDER BY c_qd_seq ASC`,
    [qid],
  );
  const [answers] = await pool.query(
    `SELECT c_qd_id, c_qd_ans, c_qd_comments
       FROM tbl_questionaire_answer
      WHERE job_id = ?
      ORDER BY c_qd_ans_id ASC`,
    [jobId],
  );
  logger.info('Found ' + questions.length + ' questions, ' + answers.length + ' saved answers · jobId=' + jobId);
  const ansByQ = new Map();
  for (const a of answers) ansByQ.set(Number(a.c_qd_id), a); // ASC → last wins
  const yes = (v) => /^(1|yes|y|true)$/i.test(String(v == null ? '' : v).trim());
  return questions.map((q) => {
    const a = ansByQ.get(Number(q.c_qd_id));
    return {
      id:        q.c_qd_id,
      question:  q.c_qd_text,
      mandatory: Number(q.c_qd_mandatory) === 1,
      answer:    a && a.c_qd_ans != null ? yes(a.c_qd_ans) : undefined,
      remark:    a && a.c_qd_comments ? a.c_qd_comments : undefined,
    };
  });
}

/*
 * POST /jobs/:id/questionnaire { answers:[{questionId, answer(bool), remark?}] }
 * Upsert by (job_id, c_qd_id) — re-submitting overwrites instead of duplicating
 * (legacy did a plain INSERT). Answer stored as '1'/'0'; both NOT-NULL text
 * columns are always supplied. inserted_by left 0 (the column default) — efr_id
 * is a tbl_easyfixer id, not the tbl_user id inserted_by may key on, so we don't
 * stamp it to avoid a wrong-table reference.
 */
async function submitQuestionnaire(jobId, efrId, answers) {
  logger.info('Submit questionnaire · jobId=' + jobId + ' answers=' + (Array.isArray(answers) ? answers.length : 0));
  const [[job]] = await pool.query(
    `SELECT fk_questionaire_id, fk_easyfixter_id FROM tbl_job WHERE job_id = ? LIMIT 1`,
    [jobId],
  );
  if (!job || Number(job.fk_easyfixter_id) !== Number(efrId)) {
    const e = new Error('job not found'); e.status = 404; throw e;
  }
  const qid = job.fk_questionaire_id;
  if (!qid) { const e = new Error('no questionnaire for this job'); e.status = 409; throw e; }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const a of answers) {
      const ansStr = a.answer ? '1' : '0';
      const remark = a.remark || '';
      const [[existing]] = await conn.query(
        `SELECT c_qd_ans_id FROM tbl_questionaire_answer WHERE job_id = ? AND c_qd_id = ? LIMIT 1`,
        [jobId, a.questionId],
      );
      if (existing) {
        await conn.query(
          `UPDATE tbl_questionaire_answer SET c_qd_ans = ?, c_qd_comments = ?, update_date = NOW()
            WHERE c_qd_ans_id = ?`,
          [ansStr, remark, existing.c_qd_ans_id],
        );
      } else {
        await conn.query(
          `INSERT INTO tbl_questionaire_answer (c_qd_id, job_id, c_questionaire_id, c_qd_ans, c_qd_comments, inserted_by)
           VALUES (?, ?, ?, ?, ?, 0)`,
          [a.questionId, jobId, qid, ansStr, remark],
        );
      }
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    logger.warn('Submit questionnaire failed, rolled back · jobId=' + jobId + ' · ' + e.message);
    throw e;
  } finally {
    conn.release();
  }
  logger.info('Questionnaire saved · jobId=' + jobId);
  return { ok: true };
}

// ─── Work progress ──────────────────────────────────────────────────
/*
 * GET /jobs/:id/work-progress — the completion-stage snapshot the app renders
 * (problem / cash / revisit). All fields read straight off tbl_job. There is no
 * is_next_visit column → isNextVisit is derived from job_status === 10 (REVISIT).
 */
async function getWorkProgress(jobId, efrId) {
  logger.info('Get work progress · jobId=' + jobId);
  const [[r]] = await pool.query(
    `SELECT job_id, job_status, problem_reason_id, is_collected_cash_by_app,
            material_charge, collect_cash_reason_id, revisit_reason_id,
            revisit_date, revisit_time_slot, fk_easyfixter_id
       FROM tbl_job WHERE job_id = ? LIMIT 1`,
    [jobId],
  );
  if (!r || Number(r.fk_easyfixter_id) !== Number(efrId)) {
    const e = new Error('job not found'); e.status = 404; throw e;
  }
  return {
    jobId:           r.job_id,
    haveProblem:     Number(r.problem_reason_id) > 0,
    problemReasonId: r.problem_reason_id || undefined,
    isCashCollected: bitTrue(r.is_collected_cash_by_app),
    collectedAmount: r.material_charge || undefined,
    cashReasonId:    r.collect_cash_reason_id || undefined,
    isNextVisit:     Number(r.job_status) === 10,
    revisitDateTime: r.revisit_date || undefined,
    revisitTime:     r.revisit_time_slot || undefined,
    revisitReasonId: r.revisit_reason_id || undefined,
  };
}

module.exports = {
  cancel,
  requestReschedule,
  sendCheckinSms,
  saveSelfie,
  searchByJobId,
  recordLocationPing,
  getQuestionnaire,
  submitQuestionnaire,
  getWorkProgress,
  // The request model's wire constants — exported so callers and tests read
  // the one definition instead of re-typing a legacy code.
  STATUS_REQUEST_PENDING,
  COMMENT_ON_CANCEL_BY_APP,
  COMMENT_ON_RESCHEDULE_BY_APP,
  bitTrue,
};
