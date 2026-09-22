const { pool } = require('../db');
const logger = require('../logger');
const emailService = require('./email.service');
const inbox = require('./notification-inbox.service');
const { estimateLinesForJob } = require('./job-line-total');
const { collectValidEmails } = require('./email-address.util');

/*
 * "Send Request to Client" (Material Management phase 2, sub-project E
 * follow-on). Fired by routes/admin/jobs.js POST /:id/material-review AFTER
 * an 'approve' decision has committed (16 -> 15) — never inside that
 * transaction, and never awaited by the route: this mirrors
 * sendEstimateEmail's fire-and-forget shape exactly (see
 * POST /:id/estimate/send-for-approval), because a mail/notification hiccup
 * must not turn a landed status move into a 500 that makes the PM press
 * Approve again.
 *
 * Email + notification are independently try/caught below so a failure in
 * one never blocks the other.
 */

/*
 * Recipient rule — deliberately NOT the same as sendEstimateEmail's (which
 * unions client_spoc_email + owner + contact_email + manager_name CSV):
 * this is a client-facing "please approve" ask, so the internal job owner is
 * excluded, and the contact on file is preferred over the job's own SPOC
 * email field, used only as a fallback when there is no valid contact email.
 * Validation/dedupe reuses services/email-address.util.js — the same rule
 * sendEstimateEmail uses — rather than a second regex.
 */
async function resolveClientContactEmail(job) {
  let contactEmail = null;
  if (job.reporting_contact_id) {
    const [[c]] = await pool.query(
      'SELECT contact_email FROM tbl_client_contacts WHERE id = ?',
      [job.reporting_contact_id],
    );
    contactEmail = c ? c.contact_email : null;
  }
  const primary = collectValidEmails([{ value: contactEmail, source: 'contact.contact_email' }]);
  if (primary.recipients.length > 0) return primary.recipients;
  return collectValidEmails([{ value: job.client_spoc_email, source: 'job.client_spoc_email' }]).recipients;
}

function buildBody({ jobLabel, materials, materialTotal, link }) {
  const lineBlock = materials
    .map((m) => `  ${m.name || '—'} x ${m.unit}  =  ${m.approved_charge.toFixed(2)}`)
    .join('\n');
  const text = `A material quote for job #${jobLabel} needs your approval.\n\n`
    + (materials.length ? `Materials:\n${lineBlock}\n\n` : '')
    + `Material total: ${materialTotal.toFixed(2)}\n\n`
    + (link ? `Review and approve: ${link}\n\n` : '')
    + `Regards,\nEasyFix`;
  const html = `<p>A material quote for job #${jobLabel} needs your approval.</p>`
    + (materials.length
      ? `<ul>${materials.map((m) => `<li>${m.name || '—'} x ${m.unit} — ${m.approved_charge.toFixed(2)}</li>`).join('')}</ul>`
      : '')
    + `<p><b>Material total: ${materialTotal.toFixed(2)}</b></p>`
    + (link ? `<p><a href="${link}">Review and approve</a></p>` : '');
  return { text, html };
}

async function sendMaterialClientRequest(jobId) {
  const [[job]] = await pool.query(
    `SELECT j.job_id, j.job_reference_id, j.reporting_contact_id, j.client_spoc_email, j.job_client_owner,
            j.fk_client_id
       FROM tbl_job j
      WHERE j.job_id = ? LIMIT 1`,
    [jobId],
  );
  if (!job) {
    logger.warn('Material client request skipped — job not found · jobId=' + jobId);
    return;
  }

  const jobLabel = job.job_reference_id || job.job_id;
  const { materials, totals } = await estimateLinesForJob(jobId);

  try {
    const recipients = await resolveClientContactEmail(job);
    if (recipients.length === 0) {
      logger.warn('Material client request email skipped — no valid client contact email · jobId=' + jobId);
    } else {
      const base = clientPortalBaseUrl();
      let link = '';
      if (!base) {
        logger.warn('CLIENT_URL is not set — material client request email omits the deep link · jobId=' + jobId);
      } else {
        link = `${base}/jobs?jobId=${jobId}`;
      }
      const { text, html } = buildBody({ jobLabel, materials, materialTotal: totals.material_subtotal, link });
      // CC the client's Primary + Secondary EasyFix SPOCs (owner, 2026-09-21) so
      // the team can chase the approval. Same SPOC rule as the job console; never
      // duplicates a To address; a SPOC with no valid email is simply skipped.
      // Lazy require: job.service is large and routes/admin/jobs.js already
      // loads both — requiring it at module top risks a circular import.
      const { resolveClientSpocUsers } = require('./job.service');
      const spocs = await resolveClientSpocUsers(job.fk_client_id);
      const toSet = new Set(recipients.map((e) => e.toLowerCase()));
      const cc = collectValidEmails([
        { value: spocs.primary?.email, source: 'primary_spoc' },
        { value: spocs.secondary?.email, source: 'secondary_spoc' },
      ]).recipients.filter((e) => !toSet.has(e.toLowerCase()));
      await emailService.send({
        to: recipients,
        cc: cc.length ? cc : undefined,
        subject: `Approval needed: materials for job #${jobLabel}`,
        text,
        html,
        category: 'material.send-to-client',
      });
      logger.info('Material client request email sent · jobId=' + jobId + ' recipients=' + recipients.length + ' cc=' + cc.length);
    }
  } catch (err) {
    logger.warn('Material client request email failed (non-fatal) · jobId=' + jobId + ' · ' + err.message);
  }

  try {
    // userId resolved the same way the booking-confirmation writer does
    // (routes/client/index.js POST /jobs) — the client feed ignores it (GET
    // /notices matches by job_id -> fk_client_id), it just has to be a value.
    await inbox.create({
      userId: job.job_client_owner || 0,
      jobId,
      title: 'Material approval needed',
      desc: `Job #${jobLabel} — material total ${totals.material_subtotal.toFixed(2)} needs your approval.`,
    });
  } catch (err) {
    logger.warn('Material client request notification failed (non-fatal) · jobId=' + jobId + ' · ' + err.message);
  }
}


/* The Client Dashboard origin, for the email's deep link. CLIENT_URL is always
   the one Client Dashboard URL (owner, 2026-09-21) — trim a trailing slash so
   the link is never //jobs. */
function clientPortalBaseUrl(env = process.env) {
  return String(env.CLIENT_URL || '').trim().replace(/\/+$/, '');
}

module.exports = { sendMaterialClientRequest, clientPortalBaseUrl };
