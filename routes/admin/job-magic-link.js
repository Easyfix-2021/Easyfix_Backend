const router = require('express').Router();
const Joi = require('joi');
const { pool } = require('../../db');
const validate = require('../../middleware/validate');
const requireAction = require('../../middleware/require-action');
const { modernOk, modernError } = require('../../utils/response');
const magicLinkService = require('../../services/job-magic-link.service');
const conversationService = require('../../services/whatsapp-conversation.service');
const logger = require('../../logger');
const { scopedJob } = require('./jobs');

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
  // Admin-only escape hatch for the per-client send cap. When `true`,
  // the BE bypasses `magic_link_send_count < max_send_count` so an
  // operator can keep sending past the configured limit. Route-side
  // checks that the caller's role is Admin before honouring it;
  // non-admin override attempts get a 403 (the FE never offers the
  // button to non-admin users, so this is a defence-in-depth check).
  override: Joi.boolean().default(false),
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
  scopedJob,
  async (req, res, next) => {
    try {
      const jobId = Number(req.params.id);
      let { action, override } = req.body;

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

      /*
       * Pre-check B removed (2026-06-08).
       *
       * Previously this block 403-rejected manual sends for clients
       * without `auto_process_unconfirmed_order='true'` in their custom
       * properties. That conflated TWO different concerns:
       *   - The auto_process flag's purpose is to gate the CRON's
       *     automatic magic-link dispatch (see services/job-magic-link-cron.js
       *     where the flag IS correctly enforced — opted-in clients
       *     get auto-sends, opted-out clients don't).
       *   - The MANUAL operator-triggered send is a separate flow.
       *     Operators with `isJobMagicLinkSend` permission should be
       *     able to send magic links to any client's unconfirmed orders
       *     regardless of the auto-process opt-in — that's the explicit
       *     manual override the permission exists to enable.
       *
       * The cron path keeps its opt-in gate. This route's only remaining
       * gates are: status==9 (still Unconfirmed), per-job send cap
       * (enforced atomically inside sendForJob), and the override-Admin
       * check below.
       *
       * The BE response continues to include `client_opted_in` so the
       * FE can render an informational badge ("Manual only — auto cron
       * not enabled for this client") without using it as a gate.
       */

      // Pre-check C: admin role required when override=true.
      // `req.userRole` is populated by the `role(['admin'])` middleware
      // mounted at routes/admin/index.js (sets the full tbl_role row
      // including role_name). Only the literal 'Admin' role_name can
      // bypass the cap — broader 'admin' GROUP roles (Executive Supply,
      // Project Manager, etc.) don't qualify. Conservative on purpose:
      // tightening later is harder than loosening.
      if (override === true) {
        const roleName = (req.userRole?.role_name || '').toLowerCase();
        if (roleName !== 'admin') {
          return modernError(
            res,
            403,
            'Override requires Admin role',
          );
        }
        logger.info(
          { jobId, userId: req.user?.user_id, role: req.userRole?.role_name },
          'magic-link: admin override invoked',
        );
      }

      // Per-job send cap is now enforced atomically inside
      // magicLinkService.sendForJob — including the per-client
      // configurable max (read from tbl_client_custom_properties under
      // c_prop_name='max_magic_link_send_count', default 3) and the
      // override-bypass path. Removed the duplicate route-side pre-check
      // here so the cap definition stays in one place; the service
      // throws 429 SEND_LIMIT_REACHED with the actual numeric cap in
      // the message when the limit is hit.

      // Defensive action coercion (see docblock)
      if (action === 'first' && job.magic_link_sent_at != null) {
        logger.info(
          { jobId, requestedAction: 'first', coercedTo: 'resend' },
          'magic-link: coercing first→resend (link was already sent)',
        );
        action = 'resend';
      }

      // Per-client channel selector: 'conversation' → in-chat AI flow;
      // anything else (incl. unset) → the magic-link FORM (unchanged default).
      const [[modeRow]] = await pool.query(
        `SELECT LOWER(REPLACE(c_prop_values, '_', ' ')) AS flow_mode
           FROM tbl_client_custom_properties
          WHERE client_id = ?
            AND LOWER(REPLACE(c_prop_name, '_', ' ')) = LOWER('Order Confirmation Mode')
            AND status = 1
          LIMIT 1`,
        [job.fk_client_id],
      );
      const conversational = String(modeRow?.flow_mode || '').trim() === 'conversation';

      const result = conversational
        ? await conversationService.startConversation(jobId, { action }, pool)
        : await magicLinkService.sendForJob(jobId, { action, override: !!override }, pool);
      return modernOk(res, { ...result, channel: conversational ? 'conversation' : 'form' });
    } catch (e) {
      return next(e);
    }
  },
);

/*
 * GET /jobs/:id/magic-link-status
 *
 * No additional action gate — any admin-group user with scope on the job
 * can view send/submit telemetry. The `scopedJob` middleware enforces
 * row-level scope (client/city/vertical within the caller's manage_* scope),
 * returning 404 for out-of-scope job_ids so existence isn't leaked.
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
  scopedJob,
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
