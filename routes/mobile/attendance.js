const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { modernOk, modernError } = require('../../utils/response');
const attendanceService = require('../../services/mobile-attendance.service');
const logger = require('../../logger');

/*
 * Technician attendance + leave sub-router.
 *
 * Mounted at the mobile ROOT (no path prefix) in routes/mobile/index.js:
 *   router.use(require('./attendance'));
 * so the full paths it declares below resolve to:
 *   GET    /api/mobile/attendance
 *   POST   /api/mobile/attendance
 *   POST   /api/mobile/leave
 *   POST   /api/mobile/leave/unmark
 *
 * It's mounted WITHOUT a prefix (rather than at '/attendance') precisely
 * because the blueprint groups these under TWO top-level paths
 * (`/attendance` and `/leave`) — declaring the absolute sub-paths here
 * keeps both groups in one file (no-route-duplication rule) instead of
 * forking a second `leave.js` that would re-import the same service.
 *
 * Auth: requireTechAuth is applied UPSTREAM in routes/mobile/index.js via
 * `router.use(requireTechAuth)` BEFORE this sub-router is mounted, so by
 * the time a request lands here `req.tech` is populated. Every handler
 * scopes to `req.tech.efr_id` (the authed technician) — never a
 * client-supplied easyfixer id.
 */

// ─── GET /attendance?from&to ───────────────────────────────────────────
// Returns marked days in the window with live morning/evening job counts.
//   → { days:[ { date, morningSlot, eveningSlot,
//               jobCountMorning, jobCountEvening, isLeave } ] }
router.get(
  '/attendance',
  validate(Joi.object({
    from: Joi.date().iso().required(),
    to: Joi.date().iso().required(),
  }), 'query'),
  async (req, res, next) => {
    try {
      logger.info('Fetch attendance · from=' + req.query.from + ' to=' + req.query.to);
      const result = await attendanceService.getAttendance(req.tech.efr_id, {
        from: req.query.from,
        to: req.query.to,
      });
      logger.info('Returning ' + (result.days ? result.days.length : 0) + ' attendance days');
      modernOk(res, result);
    } catch (e) {
      if (e.status) {
        logger.warn('Fetch attendance rejected · ' + e.message);
        return modernError(res, e.status, e.message);
      }
      next(e);
    }
  },
);

// ─── POST /attendance — upsert one day ─────────────────────────────────
// Body: { date, morningSlot, eveningSlot } → { marked: true }
// At least one slot must be true — "marking attendance" is a present
// signal; the absence of a row IS the no-show, not a 0/0 row.
router.post(
  '/attendance',
  validate(Joi.object({
    date: Joi.date().iso().required(),
    morningSlot: Joi.boolean().required(),
    eveningSlot: Joi.boolean().required(),
  }).or('morningSlot', 'eveningSlot')),
  async (req, res, next) => {
    try {
      logger.info('Mark attendance · date=' + req.body.date + ' morning=' + req.body.morningSlot + ' evening=' + req.body.eveningSlot);
      const result = await attendanceService.markDay(req.tech.efr_id, {
        date: req.body.date,
        morningSlot: req.body.morningSlot,
        eveningSlot: req.body.eveningSlot,
      });
      logger.info('Attendance marked · date=' + req.body.date);
      modernOk(res, result);
    } catch (e) {
      if (e.status) {
        logger.warn('Mark attendance rejected · ' + e.message);
        return modernError(res, e.status, e.message);
      }
      next(e);
    }
  },
);

// ─── POST /leave — mark leave across a range ───────────────────────────
// Body: { startDate, endDate } → { marked: true }
router.post(
  '/leave',
  validate(Joi.object({
    startDate: Joi.date().iso().required(),
    endDate: Joi.date().iso().required(),
  })),
  async (req, res, next) => {
    try {
      logger.info('Mark leave · startDate=' + req.body.startDate + ' endDate=' + req.body.endDate);
      const result = await attendanceService.markLeave(req.tech.efr_id, {
        startDate: req.body.startDate,
        endDate: req.body.endDate,
      });
      logger.info('Leave marked · ' + req.body.startDate + ' → ' + req.body.endDate);
      modernOk(res, result);
    } catch (e) {
      if (e.status) {
        logger.warn('Mark leave rejected · ' + e.message);
        return modernError(res, e.status, e.message);
      }
      next(e);
    }
  },
);

// ─── POST /leave/unmark — clear leave across a range ───────────────────
// Body: { startDate, endDate } → { unmarked: true }
router.post(
  '/leave/unmark',
  validate(Joi.object({
    startDate: Joi.date().iso().required(),
    endDate: Joi.date().iso().required(),
  })),
  async (req, res, next) => {
    try {
      logger.info('Unmark leave · startDate=' + req.body.startDate + ' endDate=' + req.body.endDate);
      const result = await attendanceService.unmarkLeave(req.tech.efr_id, {
        startDate: req.body.startDate,
        endDate: req.body.endDate,
      });
      logger.info('Leave unmarked · ' + req.body.startDate + ' → ' + req.body.endDate);
      modernOk(res, result);
    } catch (e) {
      if (e.status) {
        logger.warn('Unmark leave rejected · ' + e.message);
        return modernError(res, e.status, e.message);
      }
      next(e);
    }
  },
);

module.exports = router;
