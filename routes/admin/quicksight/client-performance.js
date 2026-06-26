/*
 * QuickSight report sub-router — Client Performance.
 *
 *   registry slug   : performance
 *   urlBase         : client-performance   (mounted at /api/admin/quicksight/client-performance)
 *   action key      : isQuickSightClientPerformanceView
 *   service file    : services/quicksight/quicksight-client-performance.service.js
 *
 * Parent chain (routes/admin/index.js) already applies requireAuth →
 * role(['admin']) → maskMobile → req.scope. This sub-router layers the
 * QuickSight family key + the per-report key on top via requireQuickSight,
 * and (per the legacy roleId==2 Admin-only gate) restricts to the Admin role
 * by name. Other admin-group roles get a hard 403 (registry decision
 * `accessDenied`: the FE shows its access panel — diverges intentionally from
 * the legacy soft-200 message).
 *
 * Endpoint:
 *   GET /api/admin/quicksight/client-performance
 *       ?period=monthly|weekly
 *       &clientId=&zonalManagerId=&verticalId=&projectManagerId=&serviceCategoryId=
 *       &format=xlsx
 *   - Read-only report (legacy used POST only to carry an array body; we
 *     accept repeatable/scalar query params via Joi `.single()`).
 *   - period defaults to monthly (mirrors the legacy else-branch).
 *   - format=xlsx streams a branded, KPI + data-bar styled workbook via
 *     utils/xlsx-styled-export.streamStyledXlsx.
 */

const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../../middleware/validate');
const requireQuickSight = require('../../../middleware/require-quicksight');
const { roleByName } = require('../../../middleware/role');
const { modernOk, modernError } = require('../../../utils/response');
const { streamStyledXlsx } = require('../../../utils/xlsx-styled-export');
const { extendJobFilter } = require('../../../validators/quicksight.validator');
const {
  fileStamp,
  displayStamp,
  FMT,
  decorateColumns,
} = require('../../../services/quicksight/_shared');
const service = require('../../../services/quicksight/quicksight-client-performance.service');

const ACTION_KEY = 'isQuickSightClientPerformanceView';

// All endpoints in this sub-router require the QuickSight family key + this
// report's view key, AND the Admin role (legacy roleId==2 parity).
router.use(requireQuickSight(ACTION_KEY));
router.use(roleByName(['Admin']));

/*
 * Query schema — jobFilterBase (clientId / verticalId / zonalManagerId /
 * serviceCategoryId / projectManagerId / format …) extended with `period`.
 * jobFilterBase already includes stateId / cityId (ignored by this report,
 * matching the legacy "present on the DTO but unread" behaviour) and the
 * `format` valid('json','xlsx') toggle.
 */
const querySchema = extendJobFilter({
  period: Joi.string().valid('monthly', 'weekly').default('monthly'),
});

/*
 * Column decoration rules for this report — passed to the shared
 * decorateColumns(columns, rules). We MUST NOT rename keys/headers — only add
 * presentation hints. Keys follow the toXlsx() shape: `projectManager`,
 * `clientName`, then per period `p{i}_{field}`. FIRST matching rule wins;
 * unmatched columns pass through unchanged. Data bars go ONLY on the per-period
 * `ticketCreated` volume columns (the headline count) — never on IDs/names/
 * percentages/rupees. Percentages here are WHOLE numbers → FMT.PCT.
 */
const COLUMN_RULES = [
  {
    match: (key) => key === 'projectManager' || key === 'clientName',
    hints: { align: 'left' },
  },
  {
    match: (key) => /_ticketCreated$/.test(key),
    hints: { align: 'right', numFmt: FMT.COUNT, dataBar: true, dataBarColor: 'FF2E86DE' },
  },
  {
    match: (key) => /_cancellationAfterAllocation$/.test(key) || /_averageTat$/.test(key),
    hints: { align: 'right', numFmt: FMT.COUNT },
  },
  {
    match: (key) => /_enquiryPercentage$/.test(key) || /_escalationPercentage$/.test(key),
    hints: { align: 'right', numFmt: FMT.PCT },
  },
  {
    match: (key) => /_averageTicketSize$/.test(key) || /_sumOfTotalCharge$/.test(key),
    hints: { align: 'right', numFmt: FMT.RUPEE },
  },
];

// Headline KPIs from the grouped rows — totals for the MOST-RECENT period
// (index 0 of each client's periods array), the period the title reflects.
function buildKpis(rows) {
  let tickets = 0;
  let revenue = 0;
  for (const r of rows) {
    const recent = r.periods && r.periods[0];
    if (!recent) continue;
    tickets += Number(recent.ticketCreated) || 0;
    revenue += Number(recent.sumOfTotalCharge) || 0;
  }
  return [
    { label: 'Tickets Received', value: tickets },
    { label: 'Revenue', value: revenue, numFmt: FMT.RUPEE, accent: 'FF10B981' },
    { label: 'Clients', value: rows.length, accent: 'FFF59E0B' },
  ];
}

router.get('/', validate(querySchema, 'query'), async (req, res, next) => {
  try {
    const { period, format } = req.query;
    const filters = {
      clientId: req.query.clientId,
      zonalManagerId: req.query.zonalManagerId,
      verticalId: req.query.verticalId,
      projectManagerId: req.query.projectManagerId,
      serviceCategoryId: req.query.serviceCategoryId,
    };

    const rows = await service.getClientPerformance({ period, filters });

    if (format === 'xlsx') {
      const { columns, rows: flatRows } = service.toXlsx(rows, period);
      // Active period drives the title/meta (this report compares 3 periods;
      // the most-recent label is the headline one). Fall back to the period
      // toggle word when there are no rows.
      const activeLabel = rows[0]?.periods?.[0]?.label || period;
      const periodWord = period === 'weekly' ? 'Weekly' : 'Monthly';
      const filename = `client-performance-${period}-${fileStamp()}.xlsx`;
      await streamStyledXlsx(res, filename, {
        title: 'EasyFix · Client Performance',
        meta: `Period: ${periodWord} (${activeLabel}) · ${rows.length} Clients · Generated ${displayStamp()}`,
        sheetName: 'Client Performance',
        columns: decorateColumns(columns, COLUMN_RULES),
        rows: flatRows,
        kpis: buildKpis(rows),
        emptyMessage: 'No Client Performance Data For This Period.',
      });
      return;
    }

    return modernOk(res, rows);
  } catch (err) {
    if (err && err.status) {
      return modernError(res, err.status, err.message || 'Request failed');
    }
    return next(err);
  }
});

module.exports = router;
