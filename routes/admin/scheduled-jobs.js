const router = require('express').Router();
const Joi = require('joi');
const validate = require('../../middleware/validate');
const sj = require('../../services/scheduled-jobs.service');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');

/*
 * Scheduled Jobs admin endpoints (2026-06-06).
 *
 *   GET  /api/admin/scheduled-jobs            list all registered jobs
 *   POST /api/admin/scheduled-jobs/:id/trigger  fire a job out-of-band
 *
 * Access gate: only operators whose `tbl_user.official_email` is
 * present in the `scheduled.jobs.visible.emails` easyfix_properties
 * row may use these endpoints. The same allowlist drives the
 * sidebar's "Scheduled Jobs" entry visibility on the FE — see
 * routes/auth.js (`/auth/me` payload includes a `scheduledJobsAccess`
 * boolean derived from the same check).
 *
 * Why an email allowlist not a role/menu_action: this page is
 * intentionally an ops-internal escape hatch. The user explicitly
 * asked for no tbl_menu entry. Email allowlist via easyfix_properties
 * lets ops grant/revoke access without a code change.
 */

const idParam = Joi.object({
  id: Joi.string().min(1).max(100).pattern(/^[a-z0-9-]+$/i).required(),
});

/*
 * Test-send body (2026-06-06). `mobile` is loose-validated (digits + a
 * handful of separators) up to 15 chars — the per-job tester does the
 * strict India-format check + normalisation. `sourceId` is the optional
 * row id (efr_id / job_id depending on the job); we accept either a
 * number or a numeric string so a paste from the URL bar works. An
 * empty string is treated the same as omitted, so an operator who
 * focuses the field then thinks better of it doesn't get a validator
 * error.
 */
const testBody = Joi.object({
  mobile: Joi.string().trim().min(10).max(15).pattern(/^[\d+\-\s()]+$/).required(),
  sourceId: Joi.alternatives()
    .try(Joi.number().integer().positive(), Joi.string().trim().allow(''))
    .optional(),
});

function requireAllowedEmail(req, res, next) {
  if (!sj.isAllowedUser(req.user)) {
    logger.warn(
      { userId: req.user?.user_id, email: req.user?.official_email },
      'scheduled-jobs route denied — email not in allowlist',
    );
    return modernError(res, 403, 'Not authorised — operator email is not on the Scheduled Jobs allowlist.');
  }
  return next();
}

// Apply the gate to every route in this file (mirrors the per-route-
// group pattern in routes/admin/index.js — auth + admin role guard
// already ran upstream; this is the extra allowlist layer).
router.use(requireAllowedEmail);

router.get('/', async (_req, res, next) => {
  try {
    modernOk(res, { jobs: sj.list() });
  } catch (e) { next(e); }
});

router.post('/:id/trigger', validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info(
      { userId: req.user?.user_id, jobId: req.params.id },
      'scheduled-jobs manual trigger',
    );
    const result = await sj.trigger(req.params.id);
    modernOk(res, { id: req.params.id, result }, 'job triggered');
  } catch (e) {
    if (e && e.status === 404) return modernError(res, 404, e.message);
    next(e);
  }
});

/*
 * Test send (2026-06-06). Operator-supplied mobile receives a single
 * WhatsApp using the job's underlying template. Real recipient (customer
 * for magic-link, easyfixer for profile-reminder) is NEVER contacted —
 * the per-job tester enforces that at the service layer. Optional
 * `sourceId` lets the operator borrow REAL details (name / client name)
 * from an actual row so the test message renders identically; the
 * lookup is read-only and the message still routes only to `mobile`.
 *
 * Surfaces all per-job validation errors (400 / 404) as proper HTTP
 * codes so the FE modal can render them inline.
 */
router.post(
  '/:id/test',
  validate(idParam, 'params'),
  validate(testBody, 'body'),
  async (req, res, next) => {
    try {
      const sourceId = (req.body.sourceId == null || req.body.sourceId === '')
        ? null
        : req.body.sourceId;
      logger.info(
        {
          userId: req.user?.user_id,
          jobId: req.params.id,
          mobile: req.body.mobile,
          sourceId,
        },
        'scheduled-jobs test send',
      );
      const result = await sj.test(req.params.id, {
        mobile: String(req.body.mobile).trim(),
        sourceId,
      });
      modernOk(res, { id: req.params.id, result }, 'test sent');
    } catch (e) {
      // Service-layer errors carry status + code; surface them as-is so
      // the FE can show e.g. "No easyfixer found with id 1234" inline
      // rather than a generic 500.
      if (e && e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

module.exports = router;
