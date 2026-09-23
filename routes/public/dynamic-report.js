/*
 * /api/public/dynamic-report/* — a QuickSight Custom Report's public link.
 *
 * UNAUTHENTICATED (mounted under /api/public, ahead of requireAuth). The
 * `:token` is the report's random share_token (32 hex, revocable: the owner
 * switching the link off or archiving the report nulls it → 404 at once).
 * It grants read-only access to that ONE report's CURRENT upload — no
 * history, no uploadId, no uploader identity. It bypasses the report's role
 * audience by design: the owner published it.
 *
 *   GET /:token            → { name, columns, chart, current, retentionDays }
 *   GET /:token/rows       → ?page&pageSize&sortBy&sortDir&q (as the admin route)
 *   GET /:token/chart      → { chart, series, points }
 *   GET /:token/download   → xlsx
 */

const router = require('express').Router();
const crypto = require('crypto');
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { rateLimit } = require('../../middleware/rate-limit');
const { modernOk, modernError } = require('../../utils/response');
const { streamWorkbook } = require('../../utils/xlsx-styled-export');
const service = require('../../services/quicksight/quicksight-dynamic-reports.service');

// Keyed on the token (hashed), IP as the fallback — one link is one report.
const tokenKey = (req) => 'dynamic-report:' + crypto.createHash('sha256')
  .update(String(req.params.token || req.ip)).digest('hex').slice(0, 32);
const readLimit = rateLimit({ windowMs: 60 * 1000, max: 120, key: tokenKey });
const downloadLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 20, key: (req) => 'dl-' + tokenKey(req) });

function noStore(_req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

const handle = (fn) => async (req, res, next) => {
  try {
    return await fn(req, res);
  } catch (err) {
    if (err && err.status && err.status < 500) return modernError(res, err.status, err.message);
    return next(err);
  }
};

const rowsQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(service.MAX_PAGE_SIZE).default(50),
  sortBy: Joi.string().pattern(/^c\d{1,5}$/).allow('').default(''),
  sortDir: Joi.string().valid('asc', 'desc').default('asc'),
  q: Joi.string().max(200).allow('').default(''),
});

router.get('/:token', readLimit, noStore, handle(async (req, res) =>
  modernOk(res, await service.publicSummary(req.params.token))));

router.get('/:token/rows', readLimit, noStore, validate(rowsQuery, 'query'), handle(async (req, res) =>
  modernOk(res, await service.publicRows(req.params.token, req.query))));

router.get('/:token/chart', readLimit, noStore, handle(async (req, res) =>
  modernOk(res, await service.publicChart(req.params.token))));

router.get('/:token/download', downloadLimit, handle(async (req, res) => {
  const { filename, workbook } = await service.publicDownload(req.params.token);
  return streamWorkbook(res, filename, workbook);
}));

module.exports = router;
