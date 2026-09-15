const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { modernOk, modernError } = require('../../utils/response');
const activityLogService = require('../../services/activity-log.service');
const logger = require('../../logger');

/*
 * /api/mobile/activity-log — Unified append-only audit trail.
 *
 * Mobile app logs key lifecycle events (OTP verified, registration step,
 * registration submitted, app first open). CRM and backend services also
 * append here for a complete technician journey audit trail.
 *
 * Auth: requireTechAuth applied upstream in routes/mobile/index.js;
 * req.tech is guaranteed populated for authenticated routes.
 * For public/pre-auth events (e.g. INVITE_SENT from supply dashboard),
 * a separate POST endpoint on the admin router (routes/admin/activity-log.js)
 * accepts them with admin auth instead.
 */

// POST /activity-log — Mobile app submits events.
// Used for: APP_FIRST_OPEN, OTP_VERIFIED, REGISTRATION_STEP_*, REGISTRATION_SUBMITTED
router.post(
  '/',
  validate(Joi.object({
    eventType: Joi.string()
      .trim()
      .max(48)
      .required()
      .valid(
        'APP_FIRST_OPEN',
        'OTP_VERIFIED',
        'REGISTRATION_STEP_PERSONAL',
        'REGISTRATION_STEP_BANKING',
        'REGISTRATION_STEP_IDENTITY',
        'REGISTRATION_SUBMITTED',
        'TRAINING_STARTED',
        'TRAINING_COMPLETED',
        'ASSESSMENT_SUBMITTED',
      ),
    section: Joi.string().trim().max(32).optional(),
    summary: Joi.string().trim().max(500).optional(),
    metadata: Joi.object().optional(),
  })),
  async (req, res, next) => {
    try {
      const { eventType, section, summary, metadata } = req.body;
      logger.info(`Activity log · event=${eventType} · efr=${req.tech.efr_id}`);

      const result = await activityLogService.appendEvent({
        efr_id: req.tech.efr_id,
        mobile: req.tech.efr_no,
        event_type: eventType,
        category: 'LIFECYCLE',
        section,
        source: 'APP',
        actor_type: 'TECHNICIAN',
        actor_user_id: null,
        actor_name: 'Technician',
        summary: summary || eventType,
        metadata,
      });

      modernOk(res, result);
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

module.exports = router;
