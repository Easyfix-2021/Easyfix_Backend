const router = require('express').Router();
const Joi = require('joi');
const { pool } = require('../../db');
const validate = require('../../middleware/validate');
const requireAction = require('../../middleware/require-action');
const { modernOk, modernError } = require('../../utils/response');
const magicLinkService = require('../../services/job-magic-link.service');
const logger = require('../../logger');

/*
 * Customer Magic-Link Completion for Unconfirmed Orders — admin endpoints.
 *
 * Plan: /Users/harshit/.claude/plans/distributed-foraging-perlis.md
 *
 * The router exposes two job-nested endpoints:
 *
 *   POST /jobs/:id/send-magic-link    — operator-triggered send/resend/reminder
 *   GET  /jobs/:id/magic-link-status  — read current send/submit telemetry
 *
 * Both inherit the standard /api/admin gate stack from routes/admin/index.js
 * (requireAuth → role(['admin']) → maskMobile → rejectMaskedMobile →
 * scope attach). Send additionally requires the `isJobMagicLinkSend` action
 * permission; status read is open to any admin-group user.
 *
 * Action gating uses the shared `requireAction()` middleware factory
 * (middleware/require-action.js). Earlier drafts of this file inlined
 * the check, which never actually matched because no upstream middleware
 * populates req.user.permissions — the canonical migration to the
 * factory happened on 2026-05-30.
 */

// ─── Action-permission guard ─────────────────────────────────────────
const requireJobMagicLinkSend = requireAction('isJobMagicLinkSend');

// ─── Joi schemas ─────────────────────────────────────────────────────
const idParam = Joi.object({
  id: Joi.number().integer().positive().required(),
});

const sendBody = Joi.object({
  action: Joi.string().valid('first', 'reminder', 'resend').default('first'),
});

/*
 * POST /jobs/:id/send-magic-link
 *
 * Guards (in order):
 *   1. isJobMagicLinkSend action permission (inline above)
 *   2. id Joi-validated as positive integer
 *   3. body { action } defaults to 'first'
 *
 * Pre-checks (in order — order matters; we fail fast on the cheapest):
 *   A. Job exists AND job_status === 9 (Unconfirmed). Anything else is
 *      a no-op for this feature — once the order moves out of
 *      Unconfirmed, the magic link is meaningless.
 *   B. Client opted in via tbl_client_custom_properties row
 *      (c_prop_name='auto_process_unconfirmed_order',
 *       LOWER(c_prop_values)='true', status=1). Same gate the auto-send
 *      orchestrator uses — the manual button MUST NOT bypass it,
 *      otherwise a CRM operator can send a customer-facing link to a
 *      client that hasn't approved this flow.
 *   C. Per-job send cap: magic_link_send_count < 3.
 *
 * Defensive action coercion: if the caller passes action='first' but
 * the link has already been sent once (magic_link_sent_at IS NOT NULL),
 * we coerce to 'resend'. The FE should already have done this, but the
 * BE shouldn't trust it — otherwise telemetry gets polluted.
 *
 * Success response (modernOk):
 *   { delivered, token, url, action, send_count, magic_link_sent_at }
 */
router.post(
  '/:id/send-magic-link',
  requireJobMagicLinkSend,
  validate(idParam, 'params'),
  validate(sendBody),
  async (req, res, next) => {
    try {
      const jobId = Number(req.params.id);
      let { action } = req.body;

      // Pre-check A: job exists + is Unconfirmed
      const [[job]] = await pool.query(
        'SELECT job_status, fk_client_id, magic_link_sent_at, magic_link_send_count FROM tbl_job WHERE job_id = ?',
        [jobId],
      );
      if (!job) {
        return modernError(res, 404, 'job not found');
      }
      if (job.job_status !== 9) {
        return modernError(
          res,
          400,
          'Order is no longer Unconfirmed — cannot send magic link',
        );
      }

      // Pre-check B: client opted in (mandatory even for the manual button)
      // Schema note: tbl_client_custom_properties uses legacy `c_prop_*` cols
      // (c_prop_name / c_prop_values plural). Earlier draft referenced
      // property_name/property_value which don't exist on the schema.
      const [[optIn]] = await pool.query(
        `SELECT c_prop_values AS property_value FROM tbl_client_custom_properties
          WHERE client_id = ? AND c_prop_name = 'auto_process_unconfirmed_order'
            AND status = 1
          LIMIT 1`,
        [job.fk_client_id],
      );
      if (!optIn || String(optIn.property_value || '').toLowerCase() !== 'true') {
        return modernError(
          res,
          403,
          'Client is not opted in to auto-process Unconfirmed Orders',
        );
      }

      // Pre-check C: per-job send cap
      const currentCount = Number(job.magic_link_send_count || 0);
      if (currentCount >= 3) {
        return modernError(res, 429, 'Send limit reached (3 sends max per order)');
      }

      // Defensive action coercion (see docblock)
      if (action === 'first' && job.magic_link_sent_at != null) {
        logger.info(
          { jobId, requestedAction: 'first', coercedTo: 'resend' },
          'magic-link: coercing first→resend (link was already sent)',
        );
        action = 'resend';
      }

      const result = await magicLinkService.sendForJob(jobId, { action }, pool);
      return modernOk(res, result);
    } catch (e) {
      return next(e);
    }
  },
);

/*
 * GET /jobs/:id/magic-link-status
 *
 * No additional action gate — any admin-group user with scope on the job
 * can view send/submit telemetry. The scope guard from the parent mount
 * still applies for who can reach /api/admin/* in the first place.
 *
 * Response shape (modernOk):
 *   {
 *     magic_link_sent_at:         DATETIME | null,
 *     magic_link_send_count:      INT,
 *     magic_link_last_action:     'first' | 'reminder' | 'resend' | null,
 *     customer_submitted_at:      DATETIME | null,
 *     customer_submitted_payload: JSON      | null,
 *     fk_client_id:               INT,
 *     client_opted_in:            0 | 1
 *   }
 *
 * `client_opted_in` lets the FE disable the Send button when the client
 * isn't subscribed to the flow, without a second roundtrip.
 */
router.get(
  '/:id/magic-link-status',
  validate(idParam, 'params'),
  async (req, res, next) => {
    try {
      const jobId = Number(req.params.id);
      const [[row]] = await pool.query(
        `SELECT
            j.magic_link_sent_at,
            j.magic_link_send_count,
            j.magic_link_last_action,
            j.customer_submitted_at,
            j.customer_submitted_payload,
            j.fk_client_id,
            (CASE WHEN EXISTS (
                SELECT 1 FROM tbl_client_custom_properties
                 WHERE client_id = j.fk_client_id
                   AND c_prop_name = 'auto_process_unconfirmed_order'
                   AND LOWER(c_prop_values) = 'true'
                   AND status = 1
            ) THEN 1 ELSE 0 END) AS client_opted_in
           FROM tbl_job j
          WHERE j.job_id = ?`,
        [jobId],
      );
      if (!row) {
        return modernError(res, 404, 'job not found');
      }
      return modernOk(res, row);
    } catch (e) {
      return next(e);
    }
  },
);

module.exports = router;
