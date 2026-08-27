const { pool } = require('../db');
const logger = require('../logger');
const gallabox = require('./gallabox.whatsapp.service');

/*
 * Enquiry WhatsApp notifications (2026-07-09).
 *
 * Restores a legacy behaviour lost in the 5-service consolidation: when a job
 * is marked ENQUIRY (status 7), the OLD stack sent TWO Gallabox WhatsApp
 * templates — one to the client SPOC, one to the customer. The sender lived in
 * the legacy dashboard API (API_AngularClientDashboard), reached via a
 * fire-and-forget `get_token?flag=enquiry` hop, so it was missed when the
 * CRM / dashboard / etc. were merged into this backend. `statusToEventName(7)`
 * returns null (no webhook/orchestrator event), so this is wired directly at
 * the setStatus(7) "mark as Enquiry" TRANSITION — matching legacy, which fired
 * on that action (where a reason is always picked). It deliberately does NOT
 * fire on a direct createJob(initial_status=7) booking: create() never stamps
 * enquiry_reason_id, so that path would send a blank-reason template.
 *
 * Templates (SAME Gallabox account/channel as legacy — this backend's
 * GALLABOX_CHANNEL_ID already equals the legacy 6239ce4aa43d5900047800d1):
 *   - `spoc_enquiry` → client SPOC   (always, when a SPOC number resolves)
 *   - `cx_enquiry`   → customer       (default ON)
 *
 * IMPORTANT: these two templates use NAMED bodyValues (client_name, job_id, …)
 * — unlike every other template in this backend, which uses positional
 * {1,2,3}. `gallabox.sendTemplate` forwards bodyValues verbatim, so we build
 * named objects in the EXACT legacy key order.
 *
 * NOT PORTED — the legacy per-client customer-suppression: the old flow skipped
 * `cx_enquiry` when a `tbl_client_setting` row existed for the client. In this
 * backend `tbl_client_setting` was repurposed for auto-allocation (keyed by
 * setting_id), so "a row exists" is now true for most clients and would wrongly
 * mute nearly every customer. Both messages are sent; a clean per-client
 * suppression flag can be added later if a specific client needs it.
 *
 * Always fires on the Enquiry transition — no per-feature flag (parity with
 * legacy, which sent unconditionally). Platform-wide safety still applies via
 * gallabox.sendTemplate: NOTIFICATIONS_DISABLE hard-off, and TEST_MOBILE
 * redirects every send to a test number in QA.
 */

/*
 * Cached probe for the enquiry_* enrichment columns (mirrors job.service's
 * hasEnquiryColumns). loadEnquiryContext references j.enquiry_reason_id /
 * enquiry_date_time by name, so on a legacy-shaped deploy WITHOUT those columns
 * the SELECT would throw and silently suppress both sends. Skip gracefully
 * instead — a deploy without the enquiry columns has no reason data to send.
 */
let _enquiryColsExist = null;
async function enquiryColumnsExist() {
  if (_enquiryColsExist != null) return _enquiryColsExist;
  try {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'tbl_job'
          AND column_name IN ('enquiry_reason_id', 'enquiry_comment', 'enquiry_date_time')`,
    );
    _enquiryColsExist = Number(rows[0].n) === 3;
  } catch (err) {
    // A failure is NOT cached. This asks the SCHEMA, so absence is zero rows and
    // any error is a genuine fault — freezing it would disable this until restart.
    logger.warn('Enquiry column probe failed — assuming absent for this call only · '
      + (err && err.message ? err.message : err));
    return false;
  }
  return _enquiryColsExist;
}

/*
 * Single query: everything both templates need, with SQL-side date formatting
 * and TIMESTAMPDIFF for "age" (full 24h-day difference, matching the legacy
 * ChronoUnit.DAYS.between(ticket_created, enquiry)). The enquiry reason text
 * comes from action_taken_reason (tbl_job.enquiry_reason_id → its id — see
 * the setStatus ENQUIRY branch). SPOC resolves reporting_contact_id →
 * tbl_client_contacts, falling back to the tbl_job.client_spoc* columns.
 */
async function loadEnquiryContext(jobId) {
  const [[row]] = await pool.query(
    `SELECT
        j.job_id,
        j.client_ref_id,
        j.fk_client_id,
        cl.client_name,
        /*
         * Customer name on a JOB surface (2026-08-03). Both templates describe
         * ONE job, so the name they carry is "the customer on THIS JOB" — the
         * name typed on the booking page (tbl_job.job_customer_name, a per-job
         * override; see MUTABLE_COLUMNS in services/job.service.js), with the
         * customer-master name only as the fallback.
         *
         * NULLIF(TRIM(...), '') is load-bearing: MySQL COALESCE guards NULL
         * only, so COALESCE('', cu.customer_name) returns '' — and a blank
         * named variable is exactly what some BSPs reject (see the "reason"
         * fallback below, which exists for the same reason). '' is reachable:
         * validators/job.validator.js allows '' on create AND update,
         * create() binds it via the ?? operator (which does not catch ''),
         * and update()'s MUTABLE_COLUMNS loop binds input[col] verbatim.
         *
         * customer_master_name stays the raw tbl_customer value — it feeds
         * Gallabox's recipient.name (contact-book identity), not the job copy.
         */
        COALESCE(NULLIF(TRIM(j.job_customer_name), ''), cu.customer_name) AS customer_name,
        cu.customer_name AS customer_master_name,
        cu.customer_mob_no,
        cc.contact_name AS spoc_contact_name,
        cc.contact_no   AS spoc_contact_no,
        j.client_spoc_name,
        j.client_spoc,
        atr.action_desc AS enquiry_reason,
        DATE_FORMAT(j.ticket_created_date_time, '%d-%m-%Y %H:%i') AS ticket_created_fmt,
        TIMESTAMPDIFF(DAY, j.ticket_created_date_time, COALESCE(j.enquiry_date_time, NOW())) AS age_days
       FROM tbl_job j
       LEFT JOIN tbl_client          cl  ON cl.client_id   = j.fk_client_id
       LEFT JOIN tbl_customer        cu  ON cu.customer_id = j.fk_customer_id
       LEFT JOIN tbl_client_contacts cc  ON cc.id          = j.reporting_contact_id
       LEFT JOIN action_taken_reason atr ON atr.id         = j.enquiry_reason_id
      WHERE j.job_id = ?
      LIMIT 1`,
    [jobId],
  );
  return row || null;
}

// Legacy formatting: days>1 → "n days", else "n day" (so 0→"0 day", 1→"1 day").
function ageLabel(days) {
  if (days == null) return '';
  const n = Number(days);
  if (!Number.isFinite(n)) return '';
  return n > 1 ? `${n} days` : `${n} day`;
}

async function sendEnquiryWhatsapp(jobId) {
  if (!(await enquiryColumnsExist())) {
    logger.warn('Enquiry WhatsApp skipped — enquiry_* columns absent on this deploy · jobId=' + jobId);
    return;
  }
  const ctx = await loadEnquiryContext(jobId);
  if (!ctx) { logger.warn('Enquiry WhatsApp: job not found · jobId=' + jobId); return; }

  const clientName   = ctx.client_name   || '';
  // Job-scoped display name — goes into the template BODY of both messages.
  const customerName = ctx.customer_name || '';
  /*
   * Gallabox `recipient.name` is the CONTACT-BOOK display name for the person
   * behind cu.customer_mob_no — "this customer record", not "the customer on
   * this job" — so it deliberately keeps the tbl_customer master name and is
   * unaffected by the per-job override above.
   */
  const customerContactName = ctx.customer_master_name || '';
  const clientRefId  = ctx.client_ref_id != null ? String(ctx.client_ref_id) : '';
  // Never send an empty named template variable (some BSPs reject the whole
  // template). Prefer action_taken_reason.action_desc; fall back to a generic
  // non-empty label so the message always delivers.
  const reason       = (ctx.enquiry_reason || '').trim() || 'Enquiry';
  const ticketDate   = ctx.ticket_created_fmt || '';
  const age          = ageLabel(ctx.age_days);
  const jobIdStr     = String(ctx.job_id);

  // SPOC recipient: reporting_contact_id → tbl_client_contacts, else the
  // tbl_job.client_spoc* fallback (mirrors legacy Job.getClientContactSpoc()).
  const spocMobile = (ctx.spoc_contact_no && String(ctx.spoc_contact_no).trim())
    ? ctx.spoc_contact_no
    : ctx.client_spoc;
  const spocName = ctx.spoc_contact_name || ctx.client_spoc_name || '';

  // ── spoc_enquiry → client SPOC (always). NAMED bodyValues, legacy key order. ──
  if (spocMobile) {
    try {
      await gallabox.sendTemplate({
        to: spocMobile,
        recipientName: spocName,
        templateName: 'spoc_enquiry',
        bodyValues: {
          client_name: clientName,
          client_ref_id: clientRefId,
          enquiry_reason: reason,
          job_id: jobIdStr,
          customer_name: customerName,
          ticket_created_date: ticketDate,
          age,
        },
      });
    } catch (err) {
      logger.warn('Enquiry WhatsApp spoc_enquiry failed · jobId=' + jobId + ' · ' + (err && err.message ? err.message : err));
    }
  } else {
    logger.warn('Enquiry WhatsApp: no SPOC number resolved · jobId=' + jobId);
  }

  // ── cx_enquiry → customer. NAMED bodyValues; client_ref_id = job_id here
  //    (a legacy quirk: cx_enquiry passes the job id, not the real ref id). ──
  if (ctx.customer_mob_no) {
    try {
      await gallabox.sendTemplate({
        to: ctx.customer_mob_no,
        recipientName: customerContactName,
        templateName: 'cx_enquiry',
        bodyValues: {
          customer_name: customerName,
          client_name: clientName,
          client_ref_id: jobIdStr,
          reason_cancellation: reason,
        },
      });
    } catch (err) {
      logger.warn('Enquiry WhatsApp cx_enquiry failed · jobId=' + jobId + ' · ' + (err && err.message ? err.message : err));
    }
  } else {
    logger.warn('Enquiry WhatsApp: no customer number · jobId=' + jobId);
  }
}

/*
 * Fire-and-forget entry point (mirrors job.service fireNotification). Safe to
 * call synchronously from setStatus — the work runs on the next tick and never
 * throws into the caller (so a WhatsApp hiccup can't fail the status change).
 */
function fireEnquiryWhatsapp(jobId) {
  setImmediate(async () => {
    try {
      await sendEnquiryWhatsapp(jobId);
    } catch (err) {
      logger.warn('Enquiry WhatsApp dispatch error · jobId=' + jobId + ' · ' + (err && err.message ? err.message : err));
    }
  });
}

module.exports = { fireEnquiryWhatsapp, sendEnquiryWhatsapp };
