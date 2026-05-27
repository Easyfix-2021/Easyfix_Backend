const logger = require('../logger');
const inbox = require('./notification-inbox.service');
const smsService = require('./sms.service');
const emailService = require('./email.service');
const whatsappService = require('./meta.whatsapp.service');
const fcmService = require('./fcm.service');
const smsTemplate = require('./sms-template.service');

/*
 * Positional vars passed to DLT-template fill for the
 * CUSTOMER_NOT_REACHABLE row. Order matters — these map 1-to-1 against
 * {#var1#}..{#varN#} in the registered template body. {#var#} (single-
 * variable templates) and the legacy <otp> placeholder both resolve to
 * the first element. If the DLT registration changes, update this list
 * to match the new variable order.
 */
function customerNotReachableVars(jobCtx) {
  return [
    String(jobCtx.customer_name       || ''),
    String(jobCtx.job_id              || ''),
    String(jobCtx.client_name         || ''),
    String(jobCtx.easyfixer_name      || ''),
    String(jobCtx.requested_date_time || ''),
    String(jobCtx.time_slot           || ''),
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
      case 'RescheduleTech':
        if (jobCtx.customer_mob_no) {
          smsService.send({ to: jobCtx.customer_mob_no, message: `EasyFix: Your ${jobCtx.job_type} has been rescheduled.` });
        }
        break;
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
  } catch (err) {
    logger.warn({ eventName, jobId: jobCtx.job_id, err: err.message }, 'notification orchestrator error');
  }
}

module.exports = { onJobEvent };
