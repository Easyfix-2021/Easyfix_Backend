/*
 * QuickSight report sub-router — Call Tracking.
 *   action key : isQuickSightCallTrackingView  (+ family ef-QuickSight)
 *   service    : services/quicksight/quicksight-call-tracking.service.js
 *
 *   POST /api/admin/quicksight/call-tracking/summary
 *     body: { dateFrom?, dateTo? (jci.inserted_time window — BOTH default to IST
 *             TODAY), clientId?[], verticalId?[], serviceCategoryId?[],
 *             callerId?[] (tbl_user ids — who MADE the call),
 *             provider? ('plivo'|'kaleyra'|''), partyRole? (derived receiver
 *             type, ''=all), format? }
 *     → { totals, byJob: [per job], byUser: [per (day, user)], byDay: [trend] }
 *       (or a 2-sheet XLSX when format='xlsx')
 *
 *   POST /api/admin/quicksight/call-tracking/calls
 *     body: the SAME filters + { jobId? | selectedCallerId? | day? }
 *     → { items: [per call], capped }
 *
 * The date window is NOT optional in effect: tbl_job_caller_info carries ~940k
 * rows, so the service defaults both edges to IST today rather than ever running
 * unwindowed.
 *
 * NOTE on the shared filter base: extendJobFilter also accepts zonalManagerId /
 * projectManagerId / stateId / cityId. This report deliberately honours ONLY the
 * filters listed above — the others are not wired into buildScope, so do not add
 * them to the UI here expecting them to bite.
 */

const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../../middleware/validate');
const requireQuickSight = require('../../../middleware/require-quicksight');
const { modernOk } = require('../../../utils/response');
const { buildStyledWorkbook, streamWorkbook } = require('../../../utils/xlsx-styled-export');
const { extendJobFilter, idArray } = require('../../../validators/quicksight.validator');
const { fileStamp, displayStamp, FMT, decorateColumns } = require('../../../services/quicksight/_shared');
const service = require('../../../services/quicksight/quicksight-call-tracking.service');
const logger = require('../../../logger');

const ACTION_KEY = 'isQuickSightCallTrackingView';
router.use(requireQuickSight(ACTION_KEY));

const DATE = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);

// The filter half of the contract, shared by /summary and /calls so the two can
// never diverge (the drill-down reconciling with the summary depends on it).
// Enums come from the service so they cannot drift from the SQL derivation.
const FILTER_KEYS = {
  // jci.inserted_time window. Both default to IST today IN THE SERVICE — left
  // optional here so the default lives in exactly one place.
  dateFrom: DATE.optional(),
  dateTo: DATE.optional(),
  // Who MADE the call (jci.caller_id → tbl_user). Array of ids; empty = all.
  callerId: idArray,
  // '' = all, so the FE can send its empty select value unchanged.
  provider: Joi.string().valid(...service.PROVIDERS).allow('').optional(),
  partyRole: Joi.string().valid(...service.PARTY_ROLES).allow('').optional(),
};

/*
 * Cross-field date guard: reject dateFrom > dateTo with a 400 instead of letting
 * it through. The service ALSO clamps an inverted window (windowOf anchors from
 * to to), so this is not about preventing a bad query — it is about not silently
 * ignoring what the operator asked for. Before the clamp existed, an inverted
 * range produced a self-contradicting report (an unsatisfiable predicate zeroed
 * the KPIs and both tables while the trend's own inversion guard still drew real
 * bars). Clamping fixed the contradiction; this makes the mistake VISIBLE rather
 * than quietly answering a different question than the one asked.
 *
 * Joi.ref works here because both are 'YYYY-MM-DD' strings, which compare
 * correctly lexicographically. Only applied when BOTH are present — either one
 * alone is a legitimate half-open request the service defaults.
 */
const withDateOrder = (schema) => schema.custom((value, helpers) => {
  if (value.dateFrom && value.dateTo && value.dateFrom > value.dateTo) {
    return helpers.error('any.invalid');
  }
  return value;
}, 'dateFrom <= dateTo').messages({
  'any.invalid': '"dateFrom" must be on or before "dateTo"',
});

const summaryBody = withDateOrder(extendJobFilter({ ...FILTER_KEYS }));

const COUNT_KEYS = [
  'jobId', 'calls', 'connected', 'uniqueJobs', 'topStatusCalls',
  'totalDurationSecs', 'avgDurationSecs', 'maxDurationSecs',
];
const COLUMN_RULES = [
  {
    match: (k) => [
      'clientName', 'jobStatusLabel', 'userName', 'day', 'topStatusLabel',
      'callersLabel', 'partiesLabel', 'stepsLabel', 'firstCallAt', 'lastCallAt',
    ].includes(k),
    hints: { align: 'left' },
  },
  { match: (k) => k === 'connectRate', hints: { align: 'right', numFmt: FMT.PCT } },
  { match: (k) => COUNT_KEYS.includes(k), hints: { align: 'right', numFmt: FMT.COUNT } },
];

// Pull ONLY the contract's filters off the body — anything else the shared base
// tolerates is intentionally not forwarded (see the note in the header).
function filtersOf(body) {
  return {
    clientId: body.clientId,
    verticalId: body.verticalId,
    serviceCategoryId: body.serviceCategoryId,
    callerId: body.callerId,
    dateFrom: body.dateFrom,
    dateTo: body.dateTo,
    provider: body.provider,
    partyRole: body.partyRole,
  };
}

router.post('/summary', validate(summaryBody), async (req, res, next) => {
  try {
    logger.info('Call Tracking report · format=' + (req.body.format || 'json'));
    const data = await service.getCallTracking(filtersOf(req.body));

    if (req.body.format === 'xlsx') {
      /*
       * TWO sheets — By Job / Daily By User — mirroring the on-screen grains.
       * Each buildStyledWorkbook call after the first passes the SAME workbook,
       * then streamWorkbook ships it (see utils/xlsx-styled-export). The KPI band
       * rides on the first sheet only; repeating it would just be noise.
       */
      const { sheets } = service.toXlsx(data);
      let wb;
      sheets.forEach((sheet, i) => {
        wb = buildStyledWorkbook({
          wb,
          title: `EasyFix · Call Tracking — ${sheet.name}`,
          meta: i === 0
            ? `${data.totals.calls} Calls · ${data.byJob.length} Jobs · ${data.totals.uniqueCallers} Callers · Connect ${data.totals.connectRate}% · Generated ${displayStamp()}`
            : undefined,
          sheetName: sheet.name,
          columns: decorateColumns(sheet.columns, COLUMN_RULES),
          rows: sheet.rows,
          kpis: i === 0 ? [
            { label: 'Total Calls', value: data.totals.calls, numFmt: FMT.COUNT, accent: 'FF2E86DE' },
            { label: 'Connected', value: data.totals.connected, numFmt: FMT.COUNT, accent: 'FF10B981' },
            { label: 'Connect Rate', value: data.totals.connectRate, numFmt: FMT.PCT, accent: 'FF10B981' },
            { label: 'Avg Talk (Sec)', value: data.totals.avgDurationSecs != null ? data.totals.avgDurationSecs : 0, numFmt: FMT.COUNT },
          ] : undefined,
          emptyMessage: 'No Calls Found.',
        });
      });
      await streamWorkbook(res, `call-tracking-${fileStamp()}.xlsx`, wb);
      return;
    }
    return modernOk(res, data);
  } catch (e) {
    next(e);
  }
});

/*
 * POST /api/admin/quicksight/call-tracking/calls
 *
 * Count drill-down: the individual calls behind ONE number. Body = the SAME
 * filter schema as /summary plus the clicked cell:
 *   { jobId? , selectedCallerId? , day? }
 * Reusing the summary filters is the point — the rows returned are exactly the
 * ones that produced the number, so the two always reconcile.
 */
// Same cross-field date guard as /summary — the drill-down shares FILTER_KEYS so
// that the rows reconcile with the counts, and it must therefore share the
// validation too (a range /summary rejects must not be accepted here).
const callsBody = withDateOrder(extendJobFilter({
  ...FILTER_KEYS,
  // Selection — which cell was clicked. `callerId` above is the FILTER (an
  // array); `selectedCallerId` is the single user whose row was clicked.
  jobId: Joi.number().integer().min(1).optional(),
  selectedCallerId: Joi.number().integer().min(1).optional(),
  day: DATE.optional(),
}));

router.post('/calls', validate(callsBody), async (req, res, next) => {
  try {
    logger.info('Call Tracking drill-down · jobId=' + (req.body.jobId ?? '-')
      + ' caller=' + (req.body.selectedCallerId ?? '-')
      + ' day=' + (req.body.day ?? '-'));
    const data = await service.getCallDetails(filtersOf(req.body), {
      jobId: req.body.jobId,
      selectedCallerId: req.body.selectedCallerId,
      day: req.body.day,
    });
    return modernOk(res, data);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
