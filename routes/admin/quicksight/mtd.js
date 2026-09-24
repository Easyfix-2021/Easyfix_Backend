/*
 * QuickSight report sub-router — MTD (the MTD Client Report).
 *
 *   action key : isQuickSightMtdView   (+ family ef-QuickSight)
 *   services   : services/quicksight/mtd.service.js         (per-SPOC table)
 *                services/quicksight/mtd-report.service.js  (the report)
 *   seed       : migrations/2026-09-22-seed-quicksight-mtd.sql
 *
 *   GET /api/admin/quicksight/mtd/report
 *     → the six KPI tiles and sections 1 to 10 of the owner's MIS "MTD Client
 *       Report", live: the day-wise bars and the open-jobs line, the donut,
 *       both days-open splits, the cancel reasons and comment themes, the
 *       city table and the status × aging matrix — plus the options each
 *       picker should offer.
 *
 *   GET /api/admin/quicksight/mtd/jobs
 *     → section 11: the jobs behind one cell of that matrix, paged. Shares the
 *       report's cache entry, so clicking a number costs no second read.
 *
 *   GET /api/admin/quicksight/mtd
 *     → one page of people, each with the five counts, plus the totals, the
 *       Unattributed row and the reconciliation flag over the WHOLE filtered
 *       set. The per-SPOC table, shown as the tab's last section.
 *
 *   GET /api/admin/quicksight/mtd/summary
 *     → the same totals with no rows: that table's own KPI line. Shares the
 *       table's cache entry, so opening the tab is ONE build of the four job
 *       reads.
 *
 *   All four take: startDate, endDate (YYYY-MM-DD; default the current IST
 *   month, 1st .. today — which is what MTD means), verticalId,
 *   zonalManagerId (0 = All, the sentinel every other QuickSight filter uses).
 *   The table takes page, size, sortBy, sortDir; the report and the job list
 *   also take the MIS filter bar's three multi-select pickers — clientId,
 *   vertical and spocUserId, each repeatable or comma-separated.
 *
 * THE TWO OLD ENDPOINTS ARE UNCHANGED. /mtd and /mtd/summary answer exactly
 * what they answered before the report was added, off their own service and
 * their own cache; the per-SPOC table the owner asked for first is still the
 * thing they serve.
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
 * GET only, so the FE can drive every endpoint with useFetch keyed on the
 * serialized filter state.
 */

const router = require('express').Router();
const Joi = require('joi');

const requireQuickSight = require('../../../middleware/require-quicksight');
const validate = require('../../../middleware/validate');
const { modernOk, modernError } = require('../../../utils/response');
const service = require('../../../services/quicksight/mtd.service');
const report = require('../../../services/quicksight/mtd-report.service');
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

/*
 * ── the report's three multi-select pickers ──────────────────────────────
 *
 * Client, Vertical and Primary SPOC are the MIS filter bar's own, and they are
 * MULTI-select there, so each key may repeat (?clientId=4&clientId=9) or
 * arrive comma-separated (?clientId=4,9) — whichever the FE finds easier to
 * build. Both spellings are normalised to a list here so the service sees one
 * shape.
 *
 * Splitting on commas is safe for the two NUMERIC pickers. It is NOT safe for
 * a vertical NAME, which could contain a comma, so that one only ever repeats
 * the key — `single` lets one value arrive unwrapped, and nothing is split.
 *
 * Absent = every option, the pickers' "All". An explicitly empty value is the
 * same thing rather than "no jobs": the FE clears a picker by dropping the
 * key, and a filter matching nothing is never what a cleared picker means.
 */
const idList = Joi.alternatives().try(
  Joi.array().items(Joi.number().integer().min(0)).single(),
  // The comma form is pattern-checked rather than parsed leniently: '' is a
  // CLEARED picker and must mean every option, where Number('') would quietly
  // make it the id 0 — which is a real selection (the jobs with no client at
  // all). Anything that is neither is a 400, not a filter silently ignored.
  Joi.string().pattern(/^\s*\d+(\s*,\s*\d+)*\s*$/).allow(''),
).custom((value) => {
  const parts = (Array.isArray(value) ? value : String(value).split(','))
    .map((v) => String(v).trim())
    .filter((v) => v !== '')
    .map(Number);
  return parts.length ? [...new Set(parts)] : undefined;
}, 'id list');

const nameList = Joi.array().items(Joi.string().trim().allow('')).single()
  .custom((value) => {
    const parts = value.filter((v) => v !== '');
    return parts.length ? [...new Set(parts)] : undefined;
  }, 'name list');

const reportFilter = {
  ...baseFilter,
  clientId: idList,
  vertical: nameList,
  spocUserId: idList,
};

const reportSchema = withWindow(Joi.object({ ...reportFilter }));
const jobsSchema = withWindow(Joi.object({
  ...reportFilter,
  // 'all' is the default on both, which is the template's own starting point:
  // every open job, every days-open band.
  status: Joi.string().valid(...report.SA_STATUSES, 'all').default('all'),
  bucket: Joi.string().valid(...report.SA_BUCKETS.map((b) => b.key), 'all').default('all'),
  q: Joi.string().allow('', null).max(120).default(''),
  page: Joi.number().integer().min(1).default(1),
  size: Joi.number().integer().min(1).max(report.MAX_PAGE_SIZE).default(report.DEFAULT_PAGE_SIZE),
  sortBy: Joi.string().valid(...report.JOB_SORT_KEYS).default('daysOpen'),
  sortDir: Joi.string().valid('asc', 'desc').default('desc'),
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

// The report's args: the window and the two export predicates, plus the three
// in-memory pickers. `undefined` on any of the three is "every option".
const reportArgsOf = (q) => ({
  ...argsOf(q),
  clientIds: q.clientId,
  verticals: q.vertical,
  spocUserIds: q.spocUserId,
});

const pickedOf = (q) => 'client=' + (q.clientId ? q.clientId.length : 'all')
  + ' vertical=' + (q.vertical ? q.vertical.length : 'all')
  + ' spoc=' + (q.spocUserId ? q.spocUserId.length : 'all');

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

/*
 * The report and the job list are declared BEFORE '/' so Express matches
 * '/report' and '/jobs' as themselves. ('/' would not swallow them either way,
 * but keeping the specific paths above the generic one is the habit that stops
 * the next added route from being shadowed.)
 */
router.get('/report', noStore, validate(reportSchema, 'query'), answer(async (req) => {
  const q = req.query;
  logger.info('QuickSight MTD report · ' + q.startDate + '→' + q.endDate
    + ' verticalId=' + q.verticalId + ' zonalManagerId=' + q.zonalManagerId
    + ' · ' + pickedOf(q));
  return report.getMtdReport(reportArgsOf(q));
}));

router.get('/jobs', noStore, validate(jobsSchema, 'query'), answer(async (req) => {
  const q = req.query;
  logger.info('QuickSight MTD jobs · ' + q.startDate + '→' + q.endDate
    + ' status=' + q.status + ' bucket=' + q.bucket + ' page=' + q.page + ' size=' + q.size
    + ' · ' + pickedOf(q));
  return report.getMtdJobs({
    ...reportArgsOf(q),
    status: q.status === 'all' ? null : q.status,
    bucket: q.bucket === 'all' ? null : q.bucket,
    q: q.q,
    sortBy: q.sortBy,
    sortDir: q.sortDir,
    page: q.page,
    size: q.size,
  });
}));

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
