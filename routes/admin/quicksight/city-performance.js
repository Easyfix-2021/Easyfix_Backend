/*
 * QuickSight report sub-router — City Performance.
 *
 *   registry slug   : cityperformance
 *   urlBase         : city-performance   (mounted at /api/admin/quicksight/city-performance)
 *   action key      : isQuickSightCityPerformanceView
 *   service file    : services/quicksight/quicksight-city-performance.service.js
 *
 * Parent chain (routes/admin/index.js) already applies requireAuth →
 * role(['admin']) → maskMobile → req.scope. This sub-router layers the
 * QuickSight family key + the per-report key on top via requireQuickSight.
 *
 * The legacy report was a pair of permitAll() POST endpoints sharing the same
 * JobSearchListDto body + flag, so they MUST migrate together. Native uses GET
 * query params (read-only / cacheable; Joi .single() accepts repeatable or
 * scalar id params) — the no-role gate is replaced by the ef-QuickSight family
 * key + this report's view key (registry `accessDenied` hard-403 decision;
 * the FE shows its access panel). No data-level scoping — admin sees ALL.
 *
 * Endpoints:
 *   GET /                 — paginated per-city scorecard  (?format=xlsx export)
 *       ?flag=monthly|weekly &page &pageSize
 *       &clientId &zonalManagerId &verticalId &serviceCategoryId &stateId &projectManagerId
 *   GET /tat-summary      — 3-period TAT highlights widget (no pagination)
 *       ?flag=monthly|weekly
 *       &clientId &zonalManagerId &serviceCategoryId &stateId
 *       (deliberately IGNORES verticalId & projectManagerId — legacy asymmetry)
 */

const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../../middleware/validate');
const requireQuickSight = require('../../../middleware/require-quicksight');
const { modernOk, modernError } = require('../../../utils/response');
const { streamStyledXlsx } = require('../../../utils/xlsx-styled-export');
const { extendJobFilter } = require('../../../validators/quicksight.validator');
const service = require('../../../services/quicksight/quicksight-city-performance.service');

const ACTION_KEY = 'isQuickSightCityPerformanceView';

// Per-report access gate: ef-QuickSight family key + this report's own key.
router.use(requireQuickSight(ACTION_KEY));

/*
 * Table query schema — jobFilterBase (clientId / verticalId / zonalManagerId /
 * serviceCategoryId / projectManagerId / stateId / cityId / format) extended
 * with flag + pagination. cityId is accepted (present on the legacy DTO) but
 * IGNORED by the service — city is the GROUP dimension here, not a filter.
 * pageSize caps at 200 (the FE "All" → pageSizeToLimit(200) ceiling).
 */
const tableSchema = extendJobFilter({
  flag: Joi.string().valid('monthly', 'weekly').default('monthly'),
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(200).default(10),
});

/*
 * TAT-summary query schema — flag + ONLY the four filters the legacy widget
 * reads (client / zonal / category / state). verticalId & projectManagerId are
 * intentionally NOT exposed here (legacy commented them out); cityId likewise
 * unused. No pagination — always 3 period summaries. Built fresh (not via
 * extendJobFilter) so the unread filters aren't silently accepted.
 */
const idArray = Joi.array().items(Joi.number().integer()).single().default([]);
const tatSummarySchema = Joi.object({
  flag: Joi.string().valid('monthly', 'weekly').default('monthly'),
  clientId: idArray,
  zonalManagerId: idArray,
  serviceCategoryId: idArray,
  stateId: idArray,
  format: Joi.string().valid('json', 'xlsx').default('json'),
});

const stamp = () => new Date().toISOString().slice(0, 10);

// Human-friendly generated-on stamp for the meta band (e.g. "15 Jun 2026").
const DISPLAY_STAMP = () =>
  new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

// Period label (most-recent period) for the KPI card captions, taken from
// the flattened header set so it matches the on-screen "current period".
const recentLabel = (columns) => {
  const tkt = columns.find((c) => c.key === 'p0_tkt');
  // headers look like "JUNE · Ticket Created" — strip the metric suffix.
  return tkt ? String(tkt.header).split('·')[0].trim() : '';
};

// ── GET / — paginated per-city scorecard ─────────────────────────────
router.get('/', validate(tableSchema, 'query'), async (req, res, next) => {
  try {
    const { flag, page, pageSize, format } = req.query;
    const filters = {
      clientId: req.query.clientId,
      zonalManagerId: req.query.zonalManagerId,
      verticalId: req.query.verticalId,
      serviceCategoryId: req.query.serviceCategoryId,
      stateId: req.query.stateId,
      projectManagerId: req.query.projectManagerId,
    };

    const payload = await service.getCityPerformance({ flag, page, pageSize, filters });

    if (format === 'xlsx') {
      const { columns, rows } = service.toXlsx(payload, flag);

      // Enrich the service-built columns with display polish: thousands
      // formatting + in-cell data bars on the VOLUME columns only (Ticket
      // Created / Open Orders), and right alignment on every numeric column.
      // Percentage columns arrive PRE-FORMATTED as strings ("86%" / "-")
      // from the service flattener, so they carry no numFmt/dataBar (a
      // dataBar on a % column would be meaningless, and a numFmt only
      // applies to numeric cells anyway). Keys/headers are left untouched.
      const styledColumns = columns.map((col) => {
        if (/_tkt$/.test(col.key)) {
          // Ticket Created — primary volume metric → blue data bar.
          return { ...col, align: 'right', numFmt: '#,##0', dataBar: true, dataBarColor: 'FF2E86DE' };
        }
        if (/_open$/.test(col.key)) {
          // Open Orders — secondary volume metric → amber data bar.
          return { ...col, align: 'right', numFmt: '#,##0', dataBar: true, dataBarColor: 'FFF59E0B' };
        }
        if (/_sda$|_tat$/.test(col.key)) {
          // Pre-stringified percentages — keep centered, no numFmt/dataBar.
          return { ...col, align: 'center' };
        }
        // State / City text columns → left aligned.
        return { ...col, align: 'left' };
      });

      // Headline KPIs from the MOST-RECENT period (p0) across the exported
      // page of cities: total Tickets Created, total Open Orders, and the
      // number of cities clearing the 85% TAT bar (TAT% cells are "NN%"
      // strings; "-" / non-numeric are skipped).
      const lbl = recentLabel(columns);
      let totalTkt = 0;
      let totalOpen = 0;
      let citiesAtTat = 0;
      for (const row of rows) {
        totalTkt += Number(row.p0_tkt) || 0;
        totalOpen += Number(row.p0_open) || 0;
        const tatNum = parseFloat(String(row.p0_tat));
        if (Number.isFinite(tatNum) && tatNum >= 85) citiesAtTat += 1;
      }
      const kpis = [
        { label: lbl ? `${lbl} · Tickets Created` : 'Tickets Created', value: totalTkt, accent: 'FF2E86DE' },
        { label: lbl ? `${lbl} · Open Orders` : 'Open Orders', value: totalOpen, accent: 'FFF59E0B' },
        { label: 'Cities ≥ 85% TAT', value: citiesAtTat, accent: 'FF10B981' },
      ];

      const flagLabel = flag === 'weekly' ? 'Weekly' : 'Monthly';
      const cityCount = payload?.totalRecords ?? rows.length;
      const meta =
        `Period: ${flagLabel} · ${cityCount} ${cityCount === 1 ? 'City' : 'Cities'} · ` +
        `Generated ${DISPLAY_STAMP()}`;

      const filename = `city-performance-${flag}-${stamp()}.xlsx`;
      await streamStyledXlsx(res, filename, {
        title: 'EasyFix · City Performance',
        meta,
        sheetName: 'City Performance',
        columns: styledColumns,
        rows,
        kpis,
        emptyMessage: 'No Cities Found.',
      });
      return;
    }

    return modernOk(res, payload);
  } catch (err) {
    if (err && err.status) {
      return modernError(res, err.status, err.message || 'Request failed');
    }
    return next(err);
  }
});

// ── GET /tat-summary — 3-period TAT highlights widget ────────────────
router.get('/tat-summary', validate(tatSummarySchema, 'query'), async (req, res, next) => {
  try {
    const { flag } = req.query;
    const filters = {
      clientId: req.query.clientId,
      zonalManagerId: req.query.zonalManagerId,
      serviceCategoryId: req.query.serviceCategoryId,
      stateId: req.query.stateId,
    };

    const summary = await service.getCityTatSummary({ flag, filters });
    return modernOk(res, summary);
  } catch (err) {
    if (err && err.status) {
      return modernError(res, err.status, err.message || 'Request failed');
    }
    return next(err);
  }
});

module.exports = router;
