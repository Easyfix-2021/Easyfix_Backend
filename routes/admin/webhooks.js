const router = require('express').Router();

const validate = require('../../middleware/validate');
const webhook = require('../../services/webhook.service');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');
const {
  idParam, eventCreateBody, eventUpdateBody, eventsQuery,
  mappingListQuery, mappingCreateBody, mappingUpdateBody,
  manualDispatchBody, logsQuery,
} = require('../../validators/webhook.validator');

// ─── Events registry ────────────────────────────────────────────────
router.get('/events', validate(eventsQuery, 'query'), async (req, res, next) => {
  logger.info('List webhook events · includeInactive=' + req.query.includeInactive);
  try { modernOk(res, await webhook.listEvents(req.query)); } catch (e) { next(e); }
});

router.post('/events', validate(eventCreateBody), async (req, res, next) => {
  try {
    logger.info('Create webhook event · key=' + (req.body.key || req.body.eventKey || ''));
    const created = await webhook.createEvent(req.body, req.user);
    logger.info('Webhook event created · id=' + (created && created.id));
    res.status(201);
    modernOk(res, created, 'event created');
  } catch (e) { next(e); }
});

router.patch('/events/:id', validate(idParam, 'params'), validate(eventUpdateBody), async (req, res, next) => {
  try {
    logger.info('Update webhook event · id=' + req.params.id);
    const updated = await webhook.updateEvent(req.params.id, req.body, req.user);
    if (!updated) return modernError(res, 404, 'event not found');
    logger.info('Webhook event updated · id=' + req.params.id);
    modernOk(res, updated, 'event updated');
  } catch (e) { next(e); }
});

// ─── Mappings registry ──────────────────────────────────────────────
router.get('/mappings', validate(mappingListQuery, 'query'), async (req, res, next) => {
  logger.info('List webhook mappings · eventId=' + (req.query.eventId || '') + ' clientId=' + (req.query.clientId || ''));
  try { modernOk(res, await webhook.listMappings(req.query)); } catch (e) { next(e); }
});

router.post('/mappings', validate(mappingCreateBody), async (req, res, next) => {
  try {
    logger.info('Create webhook mapping · eventId=' + req.body.eventId);
    const ev = await webhook.listEvents({ includeInactive: true });
    if (!ev.some((e) => e.id === req.body.eventId)) {
      logger.warn('Create webhook mapping rejected · eventId ' + req.body.eventId + ' does not exist');
      return modernError(res, 400, `eventId ${req.body.eventId} does not exist`);
    }
    const created = await webhook.createMapping(req.body);
    logger.info('Webhook mapping created · id=' + (created && created.id));
    res.status(201);
    modernOk(res, created, 'mapping created');
  } catch (e) { next(e); }
});

router.patch('/mappings/:id', validate(idParam, 'params'), validate(mappingUpdateBody), async (req, res, next) => {
  try {
    logger.info('Update webhook mapping · id=' + req.params.id);
    const updated = await webhook.updateMapping(req.params.id, req.body);
    if (!updated) return modernError(res, 404, 'mapping not found');
    logger.info('Webhook mapping updated · id=' + req.params.id);
    modernOk(res, updated, 'mapping updated');
  } catch (e) { next(e); }
});

router.delete('/mappings/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Deactivate webhook mapping · id=' + req.params.id);
    await webhook.deleteMapping(req.params.id);
    logger.info('Webhook mapping deleted · id=' + req.params.id);
    modernOk(res, { deleted: true }, 'mapping deactivated');
  } catch (e) { next(e); }
});

// ─── Manual dispatch + logs ─────────────────────────────────────────
router.post('/dispatch', validate(manualDispatchBody), async (req, res, next) => {
  try {
    logger.info('Manual webhook dispatch · eventId=' + (req.body.eventId || '') + ' jobId=' + (req.body.jobId || ''));
    const r = await webhook.manualDispatch(req.body);
    logger.info('Manual dispatch queued');
    modernOk(res, r, 'manual dispatch queued');
  } catch (e) {
    if (e.status) logger.warn('Manual dispatch failed · ' + e.message);
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

router.get('/logs', validate(logsQuery, 'query'), async (req, res, next) => {
  logger.info('List webhook logs · mappingId=' + (req.query.mappingId || '') + ' limit=' + (req.query.limit || '') + ' offset=' + (req.query.offset || ''));
  try { modernOk(res, await webhook.listLogs(req.query)); } catch (e) { next(e); }
});

// ─── Preview the enriched payload without dispatching ───────────────
router.get('/preview/:jobId', async (req, res, next) => {
  try {
    const jobId = Number(req.params.jobId);
    logger.info('Preview webhook payload · jobId=' + req.params.jobId);
    if (!Number.isInteger(jobId) || jobId <= 0) return modernError(res, 400, 'invalid jobId');
    const payload = await webhook.buildJobPayload(jobId);
    if (!payload) return modernError(res, 404, 'job not found');
    delete payload._fk_client_id;
    logger.info('Returning webhook preview payload · jobId=' + jobId);
    modernOk(res, payload);
  } catch (e) { next(e); }
});

module.exports = router;
