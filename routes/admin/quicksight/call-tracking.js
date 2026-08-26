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
 *     → { totals, byJob: [per job], byUser: [per (day, user)],
 *           byUserCombined: [per user, whole window + per-active-day averages],
 *           byOther: [per (day, caller, direction) with NO job attached],
 *           byProvider: [per (vendor, stack, direction) — the whole window
 *             regrouped, so it reconciles with totals exactly],
 *           byDay: [trend] }
 *       (or a 5-sheet XLSX when format='xlsx')
 *       totals additionally carries the conference tiles — partiesReached,
 *       conferenceCalls, conferenceBilledSecs, conferenceBilledCalls (all
 *       numbers, never null; see the service header for what each counts and
 *       why conferenceBilledCalls is NOT a ratio against conferenceCalls).
 *
 *   POST /api/admin/quicksight/call-tracking/charts
 *     body: the SAME filters + { grain: 'job'|'user'|'direct'|'inbound' }
 *     → { grain, totals, byDay, parties, steps, callers } — the Graphical View
 *       aggregated over the ACTIVE TAB's calls, not the whole window. Its own
 *       endpoint because /summary is uncapped and large; a tab click must not
 *       refetch it to move a chart.
 *
 *   POST /api/admin/quicksight/call-tracking/calls
 *     body: the SAME filters + { jobId? | selectedCallerId? | day? | noJob? }
 *     → { items: [per call, each with legs[]], capped }
 *
 * OTHER CALLS (byOther): every call with NO job attached — the rows `totals` has
 * always counted and no table could show, which is how an operator got "9 Total
 * Calls" over a By Job table of 2. TWO populations share that bucket and the
 * grain carries DIRECTION so the tab cannot mislabel the bigger one: staff
 * DIRECT calls (caller_id > 0, 'OUT' — placed from Manage EasyFixers /
 * Customers with no job context) and legacy INBOUND calls (caller_id 0, 'IN',
 * written outside this backend). `noJob: true` on /calls applies the SAME
 * predicate the grain is built on, so those counts drill like every other one.
 *
 * CONFERENCE CALLS: a conference is ONE call that gained people, so it is ONE
 * row everywhere a count is shown — every existing number in totals, byJob,
 * byUser, byUserCombined, byDay and the XLSX is unchanged, because buildScope
 * reads tbl_job_caller_info, which still has exactly one row per call. The extra
 * PARTIES are returned as a nested `legs[]` on each drill-down item (role +
 * name, never a number), never as extra rows: the drill-down reconciling with
 * the count it was opened from is a hard invariant of the service. See the
 * service header for the one accepted gap — `partyRole` still describes the
 * originally-dialled counterparty, not everyone who ended up on the call.
 *
 * HOW MANY PEOPLE were reached is a SEPARATE, explicitly labelled set of tiles
 * (partiesReached / conferenceCalls / conferenceBilledSecs /
 * conferenceBilledCalls), computed by their own aggregates off the same scope —
 * counts of PEOPLE and ROOMS beside counts of CALLS, never mixed into them.
 * They are window-level, so in the XLSX they ride the first sheet's KPI band and
 * meta line rather than being repeated down every row.
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
  // Combined-grain columns. activeDays is the DENOMINATOR of the averages below
  // it and is a whole count; avgDurationPerDaySecs is whole seconds.
  'activeDays', 'avgDurationPerDaySecs',
];
const COLUMN_RULES = [
  {
    match: (k) => [
      'clientName', 'jobStatusLabel', 'userName', 'day', 'topStatusLabel',
      'callersLabel', 'partiesLabel', 'stepsLabel', 'firstCallAt', 'lastCallAt',
      // Other Calls sheet — 'IN' / 'OUT', a label, not a number.
      'direction',
    ].includes(k),
    hints: { align: 'left' },
  },
  { match: (k) => k === 'connectRate', hints: { align: 'right', numFmt: FMT.PCT } },
  /*
   * Calls-per-day carries ONE decimal — the service rounds to 1dp, and the
   * shared FMT.COUNT integer mask would print 12.4 as "12" while the cell still
   * held 12.4, so a sort and the printed value would disagree.
   */
  { match: (k) => k === 'avgCallsPerDay', hints: { align: 'right', numFmt: '#,##0.0' } },
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
       * FOUR sheets — By Job / Daily By User / By User (Combined) / Other Calls
       * — mirroring the on-screen grains. The last one carries the calls the
       * KPI band counts and the other three cannot show (no job attached).
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
          /*
           * The conference COST rides the meta line, not a KPI card, because it
           * may not travel without its coverage: billed_leg_seconds is NULL
           * until the MPCEnd webhook lands, so the sum is a floor, not a total.
           * "(N rooms reported)" is that coverage, and a card has room for one
           * number only. N counts ROOMS in scope — a room is minted for every
           * Plivo call — so it is deliberately NOT phrased as a fraction of the
           * conference count beside it.
           */
          meta: i === 0
            ? `${data.totals.calls} Calls · ${data.byJob.length} Jobs · ${data.totals.uniqueCallers} Callers · Connect ${data.totals.connectRate}% · `
              + `${data.totals.conferenceCalls} Conference Calls · Conf Billed ${data.totals.conferenceBilledSecs} Sec (${data.totals.conferenceBilledCalls} rooms reported) · `
              + `Generated ${displayStamp()}`
            : undefined,
          sheetName: sheet.name,
          columns: decorateColumns(sheet.columns, COLUMN_RULES),
          rows: sheet.rows,
          kpis: i === 0 ? [
            { label: 'Total Calls', value: data.totals.calls, numFmt: FMT.COUNT, accent: 'FF2E86DE' },
            { label: 'Connected', value: data.totals.connected, numFmt: FMT.COUNT, accent: 'FF10B981' },
            { label: 'Connect Rate', value: data.totals.connectRate, numFmt: FMT.PCT, accent: 'FF10B981' },
            { label: 'Avg Talk (Sec)', value: data.totals.avgDurationSecs != null ? data.totals.avgDurationSecs : 0, numFmt: FMT.COUNT },
            /*
             * PEOPLE, not calls — it sits next to Connected on purpose, because
             * the pair is the point: they are equal until a call gains someone,
             * and partiesReached >= connected always holds.
             */
            { label: 'Parties Reached', value: data.totals.partiesReached, numFmt: FMT.COUNT, accent: 'FF8B5CF6' },
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
  // min(1) is deliberate and stays: jci.caller_id holds 0 as a SENTINEL for "no
  // attributed caller", not as a user id, so 0 must never reach the scope as a
  // selection. The Other Calls tab's unattributed rows carry userId null for the
  // same reason (drillableUserId) and drill on { noJob, day } instead.
  selectedCallerId: Joi.number().integer().min(1).optional(),
  day: DATE.optional(),
  /*
   * Complete the Other Calls grain, whose rows are (day × caller × direction).
   * Without these a drill returns the union across directions and callers, and
   * the list stops reconciling with the number that opened it — the invariant
   * this endpoint exists to uphold. `unattributed` is how a caller-less row
   * selects itself without relaxing selectedCallerId's min(1).
   */
  direction: Joi.string().valid('IN', 'OUT').optional(),
  /*
   * The By Provider tab's third dimension — which stack placed the call. Enum
   * from the service so a value cannot pass validation before the SQL clause
   * that defines it exists. Combines with `provider` (already a FILTER key) and
   * `direction` to select exactly one cell of that grain.
   */
  stack: Joi.string().valid(...service.STACKS).optional(),
  unattributed: Joi.boolean().optional(),
  /*
   * The Other Calls tab. Narrows the scope to calls with NO job attached — the
   * same predicate the byOther grain is built on, applied to the same
   * buildScope, which is what makes those counts clickable and reconciling.
   * Combines with day / selectedCallerId; it is a scope narrowing, not a mode.
   */
  noJob: Joi.boolean().optional(),
}));

/*
 * POST /api/admin/quicksight/call-tracking/charts
 *
 * The Graphical View, scoped to the tab the operator is looking at. Body = the
 * SAME filter schema as /summary plus { grain }.
 *
 * A SEPARATE endpoint on purpose. /summary now returns every row (the caps are
 * gone), so it is a large response; switching a tab must not refetch it just to
 * redraw a donut. This one is five pure aggregates and answers in kilobytes
 * whatever the window — see the service's GRAIN_SCOPE block.
 *
 * The enum comes from the service so a grain cannot pass validation before the
 * SQL scope that defines it exists.
 */
const chartsBody = withDateOrder(extendJobFilter({
  ...FILTER_KEYS,
  grain: Joi.string().valid(...service.CHART_GRAINS).required(),
}));

router.post('/charts', validate(chartsBody), async (req, res, next) => {
  try {
    const data = await service.getCallTrackingCharts(filtersOf(req.body), req.body.grain);
    return modernOk(res, data);
  } catch (e) {
    next(e);
  }
});

router.post('/calls', validate(callsBody), async (req, res, next) => {
  try {
    logger.info('Call Tracking drill-down · jobId=' + (req.body.jobId ?? '-')
      + ' caller=' + (req.body.selectedCallerId ?? '-')
      + ' day=' + (req.body.day ?? '-')
      + ' noJob=' + (req.body.noJob ? 'yes' : '-')
      + ' dir=' + (req.body.direction || '-')
      + ' unattributed=' + (req.body.unattributed ? 'yes' : '-')
      + ' stack=' + (req.body.stack || '-'));
    const data = await service.getCallDetails(filtersOf(req.body), {
      jobId: req.body.jobId,
      selectedCallerId: req.body.selectedCallerId,
      day: req.body.day,
      noJob: req.body.noJob,
      direction: req.body.direction,
      unattributed: req.body.unattributed,
      stack: req.body.stack,
    });
    return modernOk(res, data);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
