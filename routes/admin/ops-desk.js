'use strict';
/*
 * routes/admin/ops-desk.js — the live-ops desk and its verification queue
 * (V3 Phase 3: 3.2 desk, 3.3 pricing, 3.4 desk chat, 3.5 help, 3.6 verify,
 * 3.9 money card). Mounted at the admin root from routes/admin/index.js, so its
 * paths are written in full: /ops-desk/*, /verification, /jobs/:id/{verify,chat,money}.
 * The /jobs/:id/* paths are disjoint from routes/admin/jobs.js (nothing there
 * is named verify / chat / money), the same prefix split /jobs already uses
 * across job-charges.js and job-documents.js.
 *
 * ONE GATE: the existing action key isJobAppRequestResolve (seeded by
 * migrations/executed/2026-09-15-seed-job-app-request-action.sql), through the
 * same requireAction middleware every admin router uses. The desk's work IS
 * answering what a technician asked from the field — the thing that key was
 * seeded to gate — so a new key would only be a second grant to keep in step.
 *
 * Row scope: req.scope (buildRequestScopeWithHierarchy, attached once by
 * routes/admin/index.js) for lists, scopedJob / assertEntityInScope for a
 * single job or report — out of scope is a 404, never a 403.
 */
const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const requireAction = require('../../middleware/require-action');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');
const desk = require('../../services/ops-desk.service');
const verification = require('../../services/job-verification.service');
const { scopedJob } = require('./jobs');

const gate = requireAction('isJobAppRequestResolve');
const idParam = Joi.object({ id: Joi.number().integer().positive().required() });
const pageQuery = Joi.object({
  limit: Joi.number().integer().min(1).max(desk.LIMIT_MAX).default(50),
  offset: Joi.number().integer().min(0).default(0),
});
const ymdHm = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/);

// Errors carrying a status are the service's own 4xx; the code survives for
// the CRM to branch on (same shape app-request/reject uses).
function fail(res, next, e) {
  if (e && e.status) return modernError(res, e.status, e.code ? { message: e.message, code: e.code } : e.message);
  return next(e);
}

// Load the report AND its job, scope-checked; 404 either way on a miss.
async function scopedReport(req, res, next) {
  try {
    const found = await desk.loadReportInScope(Number(req.params.id), req);
    if (!found) return modernError(res, 404, 'report not found');
    req.scopedReport = found;
    return next();
  } catch (e) { return next(e); }
}

// ─── GET /ops-desk?band=A|B|C|D&limit=&offset= ─────────────────────────────
router.get('/ops-desk', gate,
  validate(pageQuery.keys({ band: Joi.string().valid('A', 'B', 'C', 'D').optional() }), 'query'),
  async (req, res, next) => {
    try {
      const out = await desk.listDesk({
        scope: req.scope, allowedStages: req.allowedStages,
        band: req.query.band || null, limit: req.query.limit, offset: req.query.offset,
      });
      modernOk(res, out);
    } catch (e) { fail(res, next, e); }
  });

// ─── POST /ops-desk/reports/:id/price { clientAmount, txAmount, note? } ────
router.post('/ops-desk/reports/:id/price', gate, validate(idParam, 'params'),
  validate(Joi.object({
    // Whole rupees: quotation_details.unit_price is an INT column and would
    // truncate paise silently (mobile-job-estimate.service.js refuses them too).
    clientAmount: Joi.number().integer().min(1).max(10000000).required(),
    txAmount: Joi.number().integer().min(0).max(Joi.ref('clientAmount')).required()
      .messages({ 'number.max': 'txAmount cannot be more than clientAmount' }),
    note: Joi.string().trim().max(255).allow('', null).optional(),
  })),
  scopedReport,
  async (req, res, next) => {
    try {
      logger.info(`Price additional work · report=${req.params.id} · by userId=${req.user.user_id}`);
      const out = await desk.priceReport(req.scopedReport, {
        clientAmount: req.body.clientAmount, txAmount: req.body.txAmount, note: req.body.note || null,
      }, req.user);
      modernOk(res, out, 'estimate sent to the client');
    } catch (e) { fail(res, next, e); }
  });

// ─── POST /ops-desk/reports/:id/return { note } ─────────────────────────────
router.post('/ops-desk/reports/:id/return', gate, validate(idParam, 'params'),
  validate(Joi.object({ note: Joi.string().trim().min(3).max(255).required() })),
  scopedReport,
  async (req, res, next) => {
    try {
      modernOk(res, await desk.returnReport(req.scopedReport, { note: req.body.note }, req.user), 'sent back to the technician');
    } catch (e) { fail(res, next, e); }
  });

// ─── POST /ops-desk/reports/:id/resolve { outcome?, revisitOn?, reasonId?, comment? }
router.post('/ops-desk/reports/:id/resolve', gate, validate(idParam, 'params'),
  validate(Joi.object({
    outcome: Joi.string().valid('revisit', 'cancel').optional(),
    revisitOn: ymdHm.optional(),
    reasonId: Joi.number().integer().positive().optional(),
    comment: Joi.string().trim().max(500).allow('', null).optional(),
  })),
  scopedReport,
  async (req, res, next) => {
    try {
      const out = await desk.resolveReport(req.scopedReport, req.body, req.user, { allowedStages: req.allowedStages });
      modernOk(res, out, 'resolved');
    } catch (e) { fail(res, next, e); }
  });

// ─── GET /verification?limit=&offset= ────────────────────────────────────
router.get('/verification', gate, validate(pageQuery, 'query'), async (req, res, next) => {
  try {
    modernOk(res, await desk.verificationQueue({
      scope: req.scope, allowedStages: req.allowedStages, limit: req.query.limit, offset: req.query.offset,
    }));
  } catch (e) { fail(res, next, e); }
});

// ─── POST /jobs/:id/verify — "Pass audit"; starts client QC, posts nothing ──
router.post('/jobs/:id/verify', gate, validate(idParam, 'params'), scopedJob, async (req, res, next) => {
  try {
    logger.info(`Verify job · jobId=${req.params.id} · by userId=${req.user.user_id}`);
    modernOk(res, await verification.verifyJob(req.scopedJob, req.user), 'audit passed — sent to client QC');
  } catch (e) { fail(res, next, e); }
});

// ─── GET/POST /jobs/:id/chat ─────────────────────────────────────────────
router.get('/jobs/:id/chat', gate, validate(idParam, 'params'),
  validate(Joi.object({ after: Joi.number().integer().min(0).default(0) }), 'query'),
  scopedJob,
  async (req, res, next) => {
    try {
      // eslint-disable-next-line global-require
      const items = await require('../../services/job-chat.service').list(Number(req.params.id), { after: req.query.after });
      modernOk(res, { items });
    } catch (e) { fail(res, next, e); }
  });

router.post('/jobs/:id/chat', gate, validate(idParam, 'params'),
  validate(Joi.object({
    body: Joi.string().trim().min(1).max(500).required(),
    // Optional here (the desk has no offline outbox) but honoured, so a
    // double-submitted reply lands once.
    clientMsgId: Joi.string().max(64).allow('', null).optional(),
  })),
  scopedJob,
  async (req, res, next) => {
    try {
      // eslint-disable-next-line global-require
      const msg = await require('../../services/job-chat.service').post(Number(req.params.id), {
        senderKind: 'desk', userId: req.user.user_id, body: req.body.body, clientMsgId: req.body.clientMsgId || null,
      });
      modernOk(res, msg, 'sent');
    } catch (e) { fail(res, next, e); }
  });

// ─── GET /jobs/:id/money → { client, tx, margin } (JobModal Summary card) ───
router.get('/jobs/:id/money', gate, validate(idParam, 'params'), scopedJob, async (req, res, next) => {
  try {
    const m = (await desk.moneyForJobs([Number(req.params.id)])).get(Number(req.params.id)) || {};
    modernOk(res, {
      client: m.client ?? null, tx: m.tx ?? null, margin: m.margin ?? null, txPosted: m.txPosted ?? null,
    });
  } catch (e) { fail(res, next, e); }
});

module.exports = router;
