const logger = require('../logger');
const inbox = require('./notification-inbox.service');
const smsService = require('./sms.service');
const emailService = require('./email.service');
const whatsappService = require('./meta.whatsapp.service');
const fcmService = require('./fcm.service');
const smsTemplate = require('./sms-template.service');
const { displaySlot, appointmentDateLabel } = require('./time-slot');

/*
 * Positional vars passed to DLT-template fill for the
 * CUSTOMER_NOT_REACHABLE row. Order matters — these map 1-to-1 against
 * {#var1#}..{#varN#} in the registered template body. {#var#} (single-
 * variable templates) and the legacy <otp> placeholder both resolve to
 * the first element. If the DLT registration changes, update this list
 * to match the new variable order.
 *
 * ⚠ DLT: the COUNT (6), the ORDER, and the template's surrounding literal
 * text are registered with the telecom operator. A mismatch is not cosmetic —
 * operators silently drop the message on the way to the handset while
 * SMSCountry still returns 200 OK. Never add, remove or reorder an element
 * here without re-registering the template.
 *
 * var6 — THE BOOKING BAND. Telling the customer a SLOT rather than an exact
 * minute is deliberate and stays that way (owner: "we don't want to commit
 * that the technician will reach exactly at 5:30 as it can get late, but we
 * are committing that they will reach in this slot"). What was wrong was
 * WHICH band: this read the RAW tbl_job.time_slot column, which is DERIVED
 * (the band containing requested_date_time, re-derived by resolveTimeSlot on
 * every write) and therefore stale on rows like job #482491 — requested_date_time
 * 05:30, i.e. 'After Hours', stored beside time_slot '3pm to 7pm'. That
 * customer was texted a window the system would not honour. displaySlot is the
 * shared read-side composition (services/time-slot.js), the same one the public
 * shared-job link uses: the appointment instant wins, and a date-only booking /
 * the 00:00 "no time captured" sentinel keeps its stored label, canonicalised
 * for spelling only. The variable stays a band, in the same position.
 *
 * var5 (requested_date_time) is intentionally UNTOUCHED — it is the raw
 * appointment column and the band is derived FROM it, so the two cannot
 * contradict each other once var6 is derived.
 */
function customerNotReachableVars(jobCtx) {
  return [
    String(jobCtx.customer_name       || ''),
    String(jobCtx.job_id              || ''),
    String(jobCtx.client_name         || ''),
    String(jobCtx.easyfixer_name      || ''),
    String(jobCtx.requested_date_time || ''),
    displaySlot(jobCtx.requested_date_time, jobCtx.time_slot),
  ];
}

/*
 * ─── THE RESCHEDULED WINDOW ──────────────────────────────────────────────
 *
 * rescheduleWindow(jobCtx) → { dateLabel, band } | null
 *
 * What the customer is actually being told the visit moved TO. Null when the
 * job carries no readable appointment date at all — see the RescheduleTech case
 * for what we say then.
 *
 * DATE + BAND, NEVER THE MINUTE. Same rule the public shared-job link follows
 * (services/job-share.service.js buildAppointmentLabel): a customer-facing
 * surface commits to a WINDOW — owner, 2026-08-03: "we don't want to commit that
 * the technician will reach exactly at 5:30 as it can get late, but we are
 * committing that they will reach in this slot". An SMS is the least
 * retractable surface we have, so it gets the band and nothing finer.
 *
 * `band` is displaySlot, the shared read-side composition — the appointment
 * INSTANT wins, and only a date-only booking / the 00:00 "no time captured"
 * sentinel falls back to the stored tbl_job.time_slot label (canonicalised for
 * spelling only). Never deriving a band from the sentinel is the point: 00:00
 * is not midnight, and banding it would text tens of thousands of legacy
 * date-only jobs an 'After Hours' window nobody booked. `band` is '' when there
 * is nothing trustworthy to show — callers must not print an empty window.
 *
 * The DATE is read straight off the same column via time-slot.appointmentDateLabel;
 * the sentinel is harmless there because a date-only row still has a real date.
 */
function rescheduleWindow(jobCtx) {
  const dateLabel = appointmentDateLabel(jobCtx && jobCtx.requested_date_time);
  if (!dateLabel) return null;
  return { dateLabel, band: displaySlot(jobCtx.requested_date_time, jobCtx.time_slot) || '' };
}

/*
 * Positional vars for the JOB_RESCHEDULED DLT row — the reschedule twin of
 * customerNotReachableVars above, and deliberately built the same way so both
 * are read back off the wire by the same kind of probe test.
 *
 * ⚠ NOT YET REGISTERED. Ops must register `JOB_RESCHEDULED` in
 * tbl_sms_transational_meta (job_stage = 'JOB_RESCHEDULED', status = 1) with
 * FIVE variables in exactly this order:
 *
 *   {#var1#} customer name   {#var2#} job id      {#var3#} job type
 *   {#var4#} appointment date ('Wed, 05 Aug 2026')
 *   {#var5#} booking band    ('3PM to 7PM' / 'After Hours')
 *
 * Suggested body (ops owns the final wording — it is the registered text that
 * must match, byte for byte, whatever the operator approves):
 *   "Dear {#var1#}, your EasyFix {#var3#} request {#var2#} has been rescheduled
 *    to {#var4#}, {#var5#}. Our technician will reach you within this slot.
 *    - Team EasyFix"
 *
 * Until that row exists getTemplate returns null and the branch below sends an
 * inline body that carries the SAME window, so the message improves the moment
 * this ships and becomes deliverable-by-registration the moment ops adds the row.
 *
 * Once registered, the COUNT and ORDER are frozen: a mismatch is not cosmetic —
 * operators silently drop the message on the way to the handset while SMSCountry
 * still returns 200 OK.
 */
function jobRescheduledVars(jobCtx) {
  const win = rescheduleWindow(jobCtx) || { dateLabel: '', band: '' };
  return [
    String(jobCtx.customer_name || ''),
    String(jobCtx.job_id        || ''),
    String(jobCtx.job_type      || 'service'),
    win.dateLabel,
    win.band,
  ];
}

/*
 * Notification orchestrator: maps job-lifecycle events to (channel, recipient, template) fan-out.
 * Fire-and-forget with internal error swallowing — never blocks the caller.
 *
 * Event → channels map (extend as product team defines more):
 *   TechAssigned        → Tech: FCM + WhatsApp.  Customer: SMS.
 *   TechStart           → Customer: SMS ETA.      Tech: FCM ack.
 *   TechVisitComplete   → Customer: SMS + WhatsApp feedback. Inbox entry for PM.
 *   CancelJob           → Customer: SMS. PM inbox.
 *   RescheduleTech      → Customer: SMS/WhatsApp. PM inbox.
 */

async function onJobEvent(eventName, jobCtx) {
  // jobCtx expected: { job_id, customer_mob_no, easyfixer_name, job_owner, job_type, ...}
  logger.info('Notification event · event=' + eventName + ' jobId=' + (jobCtx && jobCtx.job_id));
  try {
    switch (eventName) {
      case 'TechAssigned':
        if (jobCtx.customer_mob_no) {
          smsService.send({ to: jobCtx.customer_mob_no, message: `EasyFix: Technician ${jobCtx.easyfixer_name} assigned to your ${jobCtx.job_type} request.` });
        }
        if (jobCtx.job_owner) {
          await inbox.create({ userId: jobCtx.job_owner, jobId: jobCtx.job_id,
            title: 'Technician assigned', desc: `${jobCtx.easyfixer_name} accepted job ${jobCtx.job_id}` });
        }
        break;
      case 'TechStart':
        if (jobCtx.customer_mob_no) {
          smsService.send({ to: jobCtx.customer_mob_no, message: `EasyFix: ${jobCtx.easyfixer_name} is on the way for your ${jobCtx.job_type} appointment.` });
        }
        break;
      case 'TechVisitComplete':
        if (jobCtx.customer_mob_no) {
          smsService.send({ to: jobCtx.customer_mob_no, message: `EasyFix: Your ${jobCtx.job_type} is complete. Please rate your experience.` });
        }
        if (jobCtx.job_owner) {
          await inbox.create({ userId: jobCtx.job_owner, jobId: jobCtx.job_id,
            title: 'Job completed', desc: `Job ${jobCtx.job_id} marked complete by ${jobCtx.easyfixer_name}` });
        }
        break;
      case 'CancelJob':
        if (jobCtx.customer_mob_no) {
          smsService.send({ to: jobCtx.customer_mob_no, message: `EasyFix: Your ${jobCtx.job_type} request has been cancelled.` });
        }
        if (jobCtx.job_owner) {
          await inbox.create({ userId: jobCtx.job_owner, jobId: jobCtx.job_id,
            title: 'Job cancelled', desc: `Job ${jobCtx.job_id} cancelled.` });
        }
        break;
      /*
       * Reschedule — TELL THE CUSTOMER THE NEW WINDOW.
       *
       * This used to send a bare `Your ${job_type} has been rescheduled.` It
       * never said to WHEN, so the only way to find out was to phone us back —
       * and being a plain template literal it was also a non-DLT body, i.e. at
       * risk of being dropped silently by the operator (200 OK from SMSCountry,
       * nothing on the handset) exactly as noted on CustomerNotReachable below.
       * Appending text to that literal would have fixed neither problem, so this
       * follows the same two-tier shape that branch established: a DLT-registered
       * template first, an inline body carrying the same window as the fallback.
       *
       * BRACED CASE BLOCK — `let message` is also declared by the
       * CustomerNotReachable case, and a switch body is ONE lexical scope, so
       * without these braces the two declarations collide at parse time.
       */
      case 'RescheduleTech': {
        if (jobCtx.customer_mob_no) {
          const win = rescheduleWindow(jobCtx);
          const jobType = jobCtx.job_type || 'service';
          let message = null;
          /*
           * Only reach for the template when the window can actually be FILLED.
           * The registered body has its literal text wrapped around {#var4#},
           * {#var5#} ("…rescheduled to {#var4#}, {#var5#}.") — filling those
           * blank would put "rescheduled to , ." on the customer's handset,
           * which is worse than the vague message this replaces. A job with no
           * readable appointment therefore skips the template and takes the
           * no-window wording below.
           */
          if (win && win.band) {
            try {
              const tpl = await smsTemplate.getTemplate('JOB_RESCHEDULED', { clientId: jobCtx.fk_client_id });
              message = smsTemplate.fill(tpl, jobRescheduledVars(jobCtx));
            } catch (e) {
              // Fail-soft: the reschedule itself already committed. A template
              // lookup (a DB read) must never turn a successful reschedule into
              // an error — same shape as CustomerNotReachable below.
              logger.warn({ err: e.message, jobId: jobCtx.job_id }, 'JOB_RESCHEDULED template lookup failed');
            }
            if (!message) {
              logger.warn('JOB_RESCHEDULED template empty — using inline fallback · jobId=' + jobCtx.job_id);
            }
          }
          if (!message) {
            /*
             * Inline fallback — same window, three shapes, never a dangling
             * separator or an empty slot:
             *   date + band  → the full promise
             *   date only    → a job whose stored band is unreadable/absent; the
             *                  date is real and useful on its own, and inventing
             *                  a band we cannot justify is the exact bug
             *                  displaySlot exists to prevent
             *   neither      → say the visit MOVED and that we will confirm the
             *                  new window. A reschedule with no readable
             *                  appointment is a real state (the job was pushed
             *                  back to unscheduled, or it is a legacy date-less
             *                  row), and silence about it is what sent customers
             *                  to the phone in the first place. Promising a
             *                  follow-up is the only honest thing we can say
             *                  when we genuinely do not have a window yet.
             */
            if (win && win.band)   message = `EasyFix: Your ${jobType} has been rescheduled to ${win.dateLabel}, ${win.band}.`;
            else if (win)          message = `EasyFix: Your ${jobType} has been rescheduled to ${win.dateLabel}.`;
            else                   message = `EasyFix: Your ${jobType} has been rescheduled. We will confirm the new date and time shortly.`;
          }
          smsService.send({ to: jobCtx.customer_mob_no, message });
        }
        break;
      }
      case 'CustomerNotReachable':
        // Unreachable outcome — send the customer-facing SMS using the
        // DLT-registered CUSTOMER_NOT_REACHABLE template from
        // tbl_sms_transational_meta. Reuses sms-template.service so the
        // body uses the same {#varN#} placeholder format the carriers
        // expect (a non-DLT body would silently drop on the way to the
        // handset even though SMSCountry returns 200 OK). If no row is
        // registered we fall back to a sensible inline default so the
        // customer at least gets notified — note this fallback is also
        // at risk of carrier-side dropping, but it's still better than
        // total silence and gives ops a visible signal.
        if (jobCtx.customer_mob_no) {
          let message = null;
          try {
            const tpl = await smsTemplate.getTemplate('CUSTOMER_NOT_REACHABLE', { clientId: jobCtx.fk_client_id });
            message = smsTemplate.fill(tpl, customerNotReachableVars(jobCtx));
          } catch (e) {
            logger.warn({ err: e.message, jobId: jobCtx.job_id }, 'CUSTOMER_NOT_REACHABLE template lookup failed');
          }
          if (!message) {
            logger.warn('CUSTOMER_NOT_REACHABLE template empty — using inline fallback · jobId=' + jobCtx.job_id);
            message = `EasyFix: We tried calling you about your ${jobCtx.job_type || 'service'} request but couldn't reach. We'll try again soon — please call us back at your convenience.`;
          }
          smsService.send({ to: jobCtx.customer_mob_no, message });
        }
        if (jobCtx.job_owner) {
          await inbox.create({ userId: jobCtx.job_owner, jobId: jobCtx.job_id,
            title: 'Customer unreachable', desc: `Job ${jobCtx.job_id} marked as Call Later — customer not reachable.` });
        }
        break;
      default:
        logger.debug({ eventName }, 'orchestrator: no mapping for event');
    }
    logger.info('Notification event handled · event=' + eventName + ' jobId=' + (jobCtx && jobCtx.job_id));
  } catch (err) {
    logger.warn({ eventName, jobId: jobCtx.job_id, err: err.message }, 'notification orchestrator error');
  }
}

/* The DLT positional-var builders are exported for direct unit assertion. The
 * canonical tests still drive the real onJobEvent path and read the array back
 * off the wire (tests/notification-unreachable-slot.test.js,
 * tests/notification-reschedule-window.test.js) — that is what proves fill() and
 * the branch wiring, not just the list. */
module.exports = { onJobEvent, customerNotReachableVars, jobRescheduledVars };
