/*
 * QuickSight report sub-router — MTD (month-to-date, per Primary SPOC).
 *
 *   action key : isQuickSightMtdView   (+ family ef-QuickSight)
 *   service    : services/quicksight/mtd.service.js
 *   seed       : migrations/2026-09-22-seed-quicksight-mtd.sql
 *
 *   GET /api/admin/quicksight/mtd
 *     → one page of people, each with the five counts, plus the totals, the
 *       Unattributed row and the reconciliation flag over the WHOLE filtered
 *       set. The Performance report's MTD tab.
 *
 *   GET /api/admin/quicksight/mtd/summary
 *     → the same totals with no rows: the tab's KPI tiles. Shares the table's
 *       cache entry, so opening the tab is ONE build of the four job reads.
 *
 *   Both take: startDate, endDate (YYYY-MM-DD; default the current IST month,
 *   1st .. today — which is what MTD means), verticalId, zonalManagerId
 *   (0 = All, the sentinel every other QuickSight filter uses). The table also
 *   takes page, size, sortBy, sortDir.
 *
 * A bad window is a 400 'Validation failed' like any other parameter, because
 * the window is resolved INSIDE the Joi schema (withWindow below) rather than
 * discovered later in a loader — the Open column reads no window at all, so a
 * report that validated only where it read would happily answer for the wrong
 * month with one of its five columns perfectly correct.
 *
 * ⚠ THIS REPORT DISAGREES WITH EMPLOYEE PRODUCTIVITY ON PURPOSE. It attributes
 * a job to the CLIENT'S PRIMARY SPOC ("whose book of business"), where Employee
 * Productivity attributes it to whoever performed the action ("who did the
 * work"). Both are right; they answer different questions. The service header
 * carries the owner's decision in full — read it before filing the difference.
 *
 * ACCESS: the family key plus this report's own key, nothing wider. MTD names
 * employees and counts their accounts, so it is granted deliberately, the same
 * caution as Employee Performance and User Performance. Unlike Employee
 * Productivity this is NOT a reporting manager's view of their own team — it is
 * a global book-of-business report — so it does not mount the admin-or-RM gate.
 *
 * GET only, so the FE can drive both endpoints with useFetch keyed on the
 * serialized filter state.
 */

const router = require('express').Router();
const Joi = require('joi');

const requireQuickSight = require('../../../middleware/require-quicksight');
const validate = require('../../../middleware/validate');
const { modernOk, modernError } = require('../../../utils/response');
const service = require('../../../services/quicksight/mtd.service');
const logger = require('../../../logger');

const ACTION_KEY = 'isQuickSightMtdView';
router.use(requireQuickSight(ACTION_KEY));

// ── Joi schemas (inline; the shared validator is read-only) ──────────
// 'YYYY-MM-DD' date strings, '' allowed so the FE can clear a picker without
// sending the key at all; ids default 0 (= All), as in employee-productivity.js.
const DATE = Joi.string().pattern(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/).allow('', null)
  .messages({ 'string.pattern.base': '{{#label}} must be a date (YYYY-MM-DD)' });

const baseFilter = {
  startDate: DATE,
  endDate: DATE,
  verticalId: Joi.number().integer().min(0).default(0),
  zonalManagerId: Joi.number().integer().min(0).default(0),
  // The CRM's cache-buster, as on the other QuickSight tabs. Never a filter.
  v: Joi.any().strip(),
};

/*
 * Resolve — and DEFAULT — the window here, through the service's one window
 * rule (sources.checkWindow), so `startDate` / `endDate` reach the handler as
 * the EFFECTIVE window and an impossible one ('2026-02-30', from after to, a
 * range longer than the loaders allow) is a plain 400 rather than a 500 from
 * inside a loader three awaits later.
 */
const withWindow = (schema) => schema.custom((value, helpers) => {
  try {
    const w = service.checkWindow({ from: value.startDate, to: value.endDate });
    return { ...value, startDate: w.from, endDate: w.to };
  } catch (err) {
    if (err && err.status === 400) return helpers.message(err.message);
    throw err;
  }
}, 'MTD window');

const summarySchema = withWindow(Joi.object({ ...baseFilter }));
const tableSchema = withWindow(Joi.object({
  ...baseFilter,
  page: Joi.number().integer().min(1).default(1),
  size: Joi.number().integer().min(1).max(service.MAX_PAGE_SIZE).default(service.DEFAULT_PAGE_SIZE),
  sortBy: Joi.string().valid(...service.SORT_KEYS).default(service.DEFAULT_SORT_BY),
  sortDir: Joi.string().valid('asc', 'desc').default(service.DEFAULT_SORT_DIR),
}));

// Per-person counts against named employees: keep every read out of caches,
// its 400s included.
function noStore(_req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

const argsOf = (q) => ({
  from: q.startDate, to: q.endDate, verticalId: q.verticalId, zonalManagerId: q.zonalManagerId,
});

/*
 * 400 a window the service still refuses (belt and braces — the schema has
 * already resolved it), 422 a read wider than the export's row ceiling, which
 * is the caller's cue to narrow the range rather than a server fault.
 */
const answer = (build) => async (req, res, next) => {
  try {
    return modernOk(res, await build(req));
  } catch (err) {
    if (err && (err.status === 400 || err.status === 422)) {
      logger.warn('QuickSight MTD refused · ' + err.message);
      return modernError(res, err.status, err.message);
    }
    return next(err);
  }
};

router.get('/', noStore, validate(tableSchema, 'query'), answer(async (req) => {
  const q = req.query;
  logger.info('QuickSight MTD table · ' + q.startDate + '→' + q.endDate
    + ' verticalId=' + q.verticalId + ' zonalManagerId=' + q.zonalManagerId
    + ' page=' + q.page + ' size=' + q.size + ' sortBy=' + q.sortBy + ' sortDir=' + q.sortDir);
  return service.getMtdTable({
    ...argsOf(q), sortBy: q.sortBy, sortDir: q.sortDir, page: q.page, size: q.size,
  });
}));

router.get('/summary', noStore, validate(summarySchema, 'query'), answer(async (req) => {
  const q = req.query;
  logger.info('QuickSight MTD summary · ' + q.startDate + '→' + q.endDate
    + ' verticalId=' + q.verticalId + ' zonalManagerId=' + q.zonalManagerId);
  return service.getMtdSummary(argsOf(q));
}));

module.exports = router;
