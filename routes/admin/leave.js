const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { getEffectivePermissions } = require('../../services/role.service');
const leave = require('../../services/leave.service');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');

/*
 * Employee Hub — leave. /api/admin/leave; the mount inherits requireAuth +
 * role(['admin']). EVERY CRM user — no action key: who may approve is data —
 * anyone ABOVE the requester in the reporting hierarchy, never the requester;
 * isRosterAdmin only adds requests with no Reporting Head. Decided in
 * services/leave.service.js (isApprover / teamOf).
 */

const ymd = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);
const idParam = validate(Joi.object({ id: Joi.number().integer().positive().required() }), 'params');
const note = Joi.string().trim().max(500).allow('', null);

// Same resolution as routes/admin/roster.js.
async function isRosterAdmin(req) {
  if (!req.user.permissions) req.user.permissions = await getEffectivePermissions(req.user.user_id);
  return (req.user.permissions.actionPermissions || []).includes('isRosterAdmin');
}

function handle(fn) {
  return async (req, res, next) => {
    try {
      modernOk(res, await fn(req));
    } catch (e) {
      if (!e.status) return next(e);
      logger.warn('Leave request rejected · ' + req.method + ' ' + req.path + ' · actor=' + req.user.user_id + ' · ' + e.status + ' · ' + e.message);
      return modernError(res, e.status, e.message);
    }
  };
}

router.get('/me', validate(Joi.object({ month: Joi.string().pattern(/^\d{4}-(0[1-9]|1[0-2])$/) }), 'query'),
  handle((req) => leave.me({ userId: req.user.user_id, month: req.query.month })));

router.get('/requests/past',
  validate(Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
  }), 'query'),
  handle((req) => leave.pastRequests({ userId: req.user.user_id, ...req.query })));

router.post('/requests',
  validate(Joi.object({ dryRun: Joi.boolean().truthy('1').falsy('0').default(false) }), 'query'),
  validate(Joi.object({
    kind: Joi.string().valid(...leave.KINDS).required(),
    fromDate: ymd.required(),
    toDate: ymd.required(),
    duration: Joi.string().valid(...leave.DURATIONS).default('FULL'),
    reason: Joi.string().trim().max(500).allow('', null),
  })),
  handle((req) => leave.create({ userId: req.user.user_id, ...req.body, dryRun: req.query.dryRun })));

router.post('/requests/:id/withdraw', idParam,
  handle((req) => leave.withdraw({ actorId: req.user.user_id, id: req.params.id })));

router.post('/requests/:id/cancel', idParam, validate(Joi.object({ note })),
  handle(async (req) => leave.cancel({ actorId: req.user.user_id, isAdmin: await isRosterAdmin(req), id: req.params.id, note: req.body.note })));

router.post('/requests/:id/decide', idParam,
  validate(Joi.object({
    decision: Joi.string().valid('APPROVE', 'REJECT').required(),
    note: Joi.when('decision', { is: 'REJECT', then: Joi.string().trim().min(1).max(500).required(), otherwise: note }),
  })),
  handle(async (req) => leave.decide({ actorId: req.user.user_id, isAdmin: await isRosterAdmin(req), id: req.params.id, ...req.body })));

router.get('/approvals',
  validate(Joi.object({
    status: Joi.string().valid('pending', 'history').default('pending'),
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
  }), 'query'),
  handle(async (req) => leave.approvals({ actorId: req.user.user_id, isAdmin: await isRosterAdmin(req), ...req.query })));

router.get('/alerts', handle(async (req) => leave.alerts({ userId: req.user.user_id, isAdmin: await isRosterAdmin(req) })));

router.post('/alerts/:key/ack', validate(Joi.object({ key: Joi.string().pattern(/^[a-z]+:\d+$/).max(64).required() }), 'params'),
  handle((req) => leave.ackAlert({ userId: req.user.user_id, key: req.params.key })));

module.exports = router;
