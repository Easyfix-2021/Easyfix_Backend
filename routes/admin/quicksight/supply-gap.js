/*
 * QuickSight report sub-router — Supply Gap Analysis (legacy "Open City").
 *
 *   registry slug   : opencity
 *   urlBase         : supply-gap   (mounted at /api/admin/quicksight/supply-gap)
 *   action key      : isQuickSightSupplyGapView
 *   service file    : services/quicksight/quicksight-supply-gap.service.js
 *
 * Parent chain (routes/admin/index.js) already runs requireAuth → role(['admin']).
 * This sub-router layers the QuickSight family key + per-report key on top via
 * requireQuickSight. The list endpoint honours ?format=xlsx for a server-side
 * streamed download (replaces the legacy 5s-disk-URL hack).
 *
 * SCOPE: this is the READ / report surface only. The legacy OpenCityController
 * also exposes write endpoints (addUpdate / actionOnSupplyRequest / addComment)
 * that mutate tbl_open_city + fire WhatsApp + transferJobOwnershipToZM. Those
 * are the full-CRUD dashboard's write flow with orchestrator side-effects and
 * are intentionally NOT ported into the QuickSight rebuild (registry decision +
 * openQuestions). All endpoints below are read-only.
 *
 * Legacy mapping:
 *   GET /                       ← findAllOpenCities (+ downloadExcelSupplyRequest when format=xlsx)
 *   GET /:id                    ← findByOpenCityId
 *   GET /:id/allocations        ← getAllocatedTxList
 *   GET /:id/history            ← actionHistorySupplyequest (sic)
 *   GET /job/:jobId             ← getJobDetailById
 *   GET /tx/:efrId?catgId=      ← getAllocateTxDetails
 *   GET /tx-status?mobileNo=     ← getEasyfixerStatus
 *   GET /tx-count?cityId=&catgId= ← findTxCountByCityAndCategory
 */

const router = require('express').Router();
const Joi = require('joi');

const requireQuickSight = require('../../../middleware/require-quicksight');
const validate = require('../../../middleware/validate');
const { modernOk, modernError } = require('../../../utils/response');
const { streamStyledXlsx } = require('../../../utils/xlsx-styled-export');
const {
  fileStamp,
  displayStamp,
  FMT,
  decorateColumns,
} = require('../../../services/quicksight/_shared');
const service = require('../../../services/quicksight/quicksight-supply-gap.service');

/*
 * Column-hint rules for the service-built XLSX_COLUMNS — passed to the shared
 * decorateColumns(columns, rules). FIRST match wins; unmatched columns pass
 * through unchanged (text columns keep the helper's centered default). No key
 * or header is renamed; only presentation hints are added:
 *   - Gap Days  -> count format + AMBER data bar (gap severity headline).
 *   - Added Count -> count format + BLUE data bar (supplies allocated).
 *   - GapId / Job Id / PinCode -> count format, right-aligned, NO data bar
 *     (identifiers — a bar would be meaningless / misleading on city names).
 */
const COLUMN_RULES = [
  {
    match: (key) => key === 'gapDays',
    hints: { align: 'right', numFmt: FMT.COUNT, dataBar: true, dataBarColor: 'FFF59E0B' },
  },
  {
    match: (key) => key === 'addedCount',
    hints: { align: 'right', numFmt: FMT.COUNT, dataBar: true, dataBarColor: 'FF2E86DE' },
  },
  {
    match: (key) => key === 'gapId' || key === 'jobId' || key === 'pinCode',
    hints: { align: 'right', numFmt: FMT.COUNT },
  },
];

/*
 * Headline KPIs from the export rows:
 *   - Total Supply Requests : one row per supply gap.
 *   - Total Open Cities     : distinct non-blank city names.
 *   - Total Gap Days        : sum of gapDays (cumulative open-gap age).
 *   - Total Supplies Added  : sum of addedCount (allocations made).
 */
function buildKpis(rows) {
  const cities = new Set();
  let totalGap = 0;
  let totalAdded = 0;
  for (const r of rows) {
    if (r.city != null && String(r.city).trim() !== '') cities.add(String(r.city).trim());
    totalGap += Number(r.gapDays) || 0;
    totalAdded += Number(r.addedCount) || 0;
  }
  return [
    { label: 'Total Supply Requests', value: rows.length },
    { label: 'Total Open Cities', value: cities.size, accent: 'FFF59E0B' },
    { label: 'Total Gap Days', value: totalGap, accent: 'FFEF4444' },
    { label: 'Total Supplies Added', value: totalAdded, accent: 'FF10B981' },
  ];
}

// Bold footer totals for the two numeric count columns.
function buildTotalRow(rows) {
  let totalGap = 0;
  let totalAdded = 0;
  for (const r of rows) {
    totalGap += Number(r.gapDays) || 0;
    totalAdded += Number(r.addedCount) || 0;
  }
  return { gapId: 'Total', gapDays: totalGap, addedCount: totalAdded };
}

// Per-report access gate: ef-QuickSight family key + this report's own key.
router.use(requireQuickSight('isQuickSightSupplyGapView'));

// ── Joi schemas (inline; this report has its own non-job filter set, so it
//    does NOT extend jobFilterBase — the shared base is the dimension-id
//    array contract, irrelevant to the open-city filters). ───────────────

// List query: matches the legacy FilterDatasupplyList defaults.
const listQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  // pageSize cap 200 (TablePagination 'All' cap convention — pass BE max explicitly).
  pageSize: Joi.number().integer().min(1).max(200).default(10),
  zonalManager: Joi.number().integer().allow(null).default(0),
  supplyStatus: Joi.number().integer().valid(0, 1, 2, 3, 4, 5).default(5),
  requestFor: Joi.number().integer().valid(0, 1, 2).default(0),
  startDate: Joi.date().iso().allow('', null),
  endDate: Joi.date().iso().allow('', null).min(Joi.ref('startDate')),
  searchText: Joi.string().trim().allow('', null).max(100),
  format: Joi.string().valid('json', 'xlsx').default('json'),
});

const idParam = Joi.object({ id: Joi.number().integer().min(1).required() });
const jobIdParam = Joi.object({ jobId: Joi.number().integer().min(1).required() });
const txParam = Joi.object({ efrId: Joi.number().integer().min(1).required() });
const txQuery = Joi.object({ catgId: Joi.number().integer().min(1).required() });
const txStatusQuery = Joi.object({ mobileNo: Joi.string().trim().required().max(20) });
const txCountQuery = Joi.object({
  cityId: Joi.number().integer().min(1).required(),
  catgId: Joi.number().integer().min(1).required(),
});

// ── GET / — primary report list (paginated) + ?format=xlsx export ────────
router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    if (req.query.format === 'xlsx') {
      const rows = await service.exportRows(req.query);
      const cities = new Set(
        rows.map((r) => (r.city != null ? String(r.city).trim() : '')).filter(Boolean),
      );
      const filename = `supply-gap-analysis-${fileStamp()}.xlsx`;
      await streamStyledXlsx(res, filename, {
        title: 'EasyFix · Supply Gap Analysis',
        meta: `${cities.size} Cities · ${rows.length} Supply Requests · Generated ${displayStamp()}`,
        sheetName: 'Supply Requests',
        columns: decorateColumns(service.XLSX_COLUMNS, COLUMN_RULES),
        rows,
        kpis: buildKpis(rows),
        totalRow: buildTotalRow(rows),
        emptyMessage: 'No Supply Gap Data Found.',
      });
      return;
    }
    const result = await service.list(req.query);
    return modernOk(res, result);
  } catch (err) {
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

// ── GET /job/:jobId — job-detail prefill (declared BEFORE /:id so the
//    static "job" segment isn't captured by the :id param) ──────────────
router.get('/job/:jobId', validate(jobIdParam, 'params'), async (req, res, next) => {
  try {
    const data = await service.jobDetail(Number(req.params.jobId));
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

// ── GET /tx-status?mobileNo= — live TX status label ──────────────────────
router.get('/tx-status', validate(txStatusQuery, 'query'), async (req, res, next) => {
  try {
    const data = await service.txStatus(req.query.mobileNo);
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

// ── GET /tx-count?cityId=&catgId= — active TX count for a city+category ───
router.get('/tx-count', validate(txCountQuery, 'query'), async (req, res, next) => {
  try {
    const data = await service.txCount(Number(req.query.cityId), Number(req.query.catgId));
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

// ── GET /tx/:efrId?catgId= — "Add Existing Technician" eligibility ───────
router.get('/tx/:efrId', validate(txParam, 'params'), validate(txQuery, 'query'), async (req, res, next) => {
  try {
    const data = await service.txDetails(Number(req.params.efrId), Number(req.query.catgId));
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

// ── GET /:id/allocations — "Added Tx :N" popup ───────────────────────────
router.get('/:id/allocations', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const data = await service.allocations(Number(req.params.id));
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

// ── GET /:id/history — action/remark timeline ────────────────────────────
router.get('/:id/history', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const data = await service.history(Number(req.params.id));
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

// ── GET /:id — row detail (eye-icon modal) ───────────────────────────────
router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    const data = await service.detail(Number(req.params.id));
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

module.exports = router;
