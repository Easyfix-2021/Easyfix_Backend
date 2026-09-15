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
 * SCOPE: read / report surface PLUS create + edit (2026-09-14, per ops). The
 * legacy OpenCityController write endpoints mutate tbl_open_city + fire
 * WhatsApp + transferJobOwnershipToZM. `addUpdate` is now ported (POST / and
 * PUT /:id — side effects documented in the service), as are
 * `actionOnSupplyRequest`, `addComment` and `saveEfrInvite`.
 * Writes are gated by the same per-report view key as the reads (product
 * decision: anyone who can see the dashboard can raise a request).
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
 *   GET /pin/:pin               ← map_my_india + findCityUser (New City prefill)
 *   POST /                      ← addUpdate (id = 0)
 *   PUT /:id                    ← addUpdate (id ≠ 0, Open requests only)
 *   POST /:id/remarks           ← addComment
 *   POST /:id/action            ← actionOnSupplyRequest (new / existing supply, cancel, complete)
 *   POST /invite                ← saveEfrInvite (header "Invite Sent")
 */

const router = require('express').Router();
const Joi = require('joi');

const logger = require('../../../logger');
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
const pinParam = Joi.object({ pin: Joi.string().pattern(/^\d{6}$/).required() });

// Create — requestFor 1 = Job ID, 2 = New City. Location fields are resolved
// server-side from the job / PIN, so the body carries only what the operator
// actually chooses.
const reason = Joi.string().trim().min(1).max(1000).required()
  .messages({ 'any.required': 'Reason is required', 'string.empty': 'Reason is required' });
const createBody = Joi.object({
  requestFor: Joi.number().integer().valid(1, 2).required(),
  jobId: Joi.number().integer().min(1)
    .when('requestFor', { is: 1, then: Joi.required(), otherwise: Joi.forbidden() }),
  pin: Joi.string().pattern(/^\d{6}$/)
    .when('requestFor', { is: 2, then: Joi.required(), otherwise: Joi.forbidden() }),
  clientId: Joi.number().integer().min(1).allow(null)
    .when('requestFor', { is: 1, then: Joi.forbidden() }),
  // Optional override; defaults to the city's Zonal Manager.
  stateUser: Joi.number().integer().min(1).allow(null),
  catgId: Joi.number().integer().min(1).required(),
  comments: reason,
});
const updateBody = Joi.object({
  catgId: Joi.number().integer().min(1).required(),
  comments: reason,
});

const remarks = Joi.string().trim().min(1).max(500).required()
  .messages({ 'any.required': 'Remarks are required', 'string.empty': 'Remarks are required' });
const techName = Joi.string().trim().pattern(/^[A-Za-z ]+$/).min(2).max(100)
  .messages({ 'string.pattern.base': 'Technician name can contain only letters and spaces' });
const techMobile = Joi.string().pattern(/^[5-9]\d{9}$/)
  .messages({ 'string.pattern.base': 'Contact number must be 10 digits starting with 5–9' });

const remarkBody = Joi.object({ comment: remarks });
// actionType 1 new supply · 2 existing supply · 3 cancel · 4 complete.
const actionBody = Joi.object({
  actionType: Joi.number().integer().valid(1, 2, 3, 4).required(),
  remarks,
  newSupplyName: techName.when('actionType', { is: 1, then: Joi.required(), otherwise: Joi.forbidden() }),
  newSupplyNumber: techMobile.when('actionType', { is: 1, then: Joi.required(), otherwise: Joi.forbidden() }),
  oldSupplyId: Joi.number().integer().min(1)
    .when('actionType', { is: 2, then: Joi.required(), otherwise: Joi.forbidden() }),
});
const inviteBody = Joi.object({
  name: techName.required(),
  mobile: techMobile.required(),
  remarks: Joi.string().trim().allow('', null).max(500),
});

// ── GET / — primary report list (paginated) + ?format=xlsx export ────────
router.get('/', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    logger.info('Supply Gap list · page=' + req.query.page + ' pageSize=' + req.query.pageSize + ' supplyStatus=' + req.query.supplyStatus + ' format=' + (req.query.format || 'json'));
    if (req.query.format === 'xlsx') {
      const rows = await service.exportRows(req.query);
      logger.info('Found ' + rows.length + ' supply requests to export');
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
      logger.info('Streamed Supply Gap xlsx · ' + rows.length + ' supply requests');
      return;
    }
    const result = await service.list(req.query);
    logger.info('Returning Supply Gap list · ' + (result && result.totalRecords != null ? result.totalRecords : (result && result.data ? result.data.length : 0)) + ' supply requests');
    return modernOk(res, result);
  } catch (err) {
    if (err && err.status) {
      logger.warn('Supply Gap list failed · ' + err.message);
      return modernError(res, err.status, err.message);
    }
    logger.error('Supply Gap list error · ' + err.message);
    return next(err);
  }
});

// ── GET /job/:jobId — job-detail prefill (declared BEFORE /:id so the
//    static "job" segment isn't captured by the :id param) ──────────────
router.get('/job/:jobId', validate(jobIdParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Supply Gap job detail · jobId=' + req.params.jobId);
    const data = await service.jobDetail(Number(req.params.jobId));
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) {
      logger.warn('Supply Gap job detail failed · ' + err.message);
      return modernError(res, err.status, err.message);
    }
    logger.error('Supply Gap job detail error · ' + err.message);
    return next(err);
  }
});

// ── GET /tx-status?mobileNo= — live TX status label ──────────────────────
router.get('/tx-status', validate(txStatusQuery, 'query'), async (req, res, next) => {
  try {
    logger.info('Supply Gap TX status lookup by mobile');
    const data = await service.txStatus(req.query.mobileNo);
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) {
      logger.warn('Supply Gap TX status failed · ' + err.message);
      return modernError(res, err.status, err.message);
    }
    logger.error('Supply Gap TX status error · ' + err.message);
    return next(err);
  }
});

// ── GET /tx-count?cityId=&catgId= — active TX count for a city+category ───
router.get('/tx-count', validate(txCountQuery, 'query'), async (req, res, next) => {
  try {
    logger.info('Supply Gap TX count · cityId=' + req.query.cityId + ' catgId=' + req.query.catgId);
    const data = await service.txCount(Number(req.query.cityId), Number(req.query.catgId));
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) {
      logger.warn('Supply Gap TX count failed · ' + err.message);
      return modernError(res, err.status, err.message);
    }
    logger.error('Supply Gap TX count error · ' + err.message);
    return next(err);
  }
});

// ── GET /tx/:efrId?catgId= — "Add Existing Technician" eligibility ───────
router.get('/tx/:efrId', validate(txParam, 'params'), validate(txQuery, 'query'), async (req, res, next) => {
  try {
    logger.info('Supply Gap TX eligibility · efrId=' + req.params.efrId + ' catgId=' + req.query.catgId);
    const data = await service.txDetails(Number(req.params.efrId), Number(req.query.catgId));
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) {
      logger.warn('Supply Gap TX eligibility failed · ' + err.message);
      return modernError(res, err.status, err.message);
    }
    logger.error('Supply Gap TX eligibility error · ' + err.message);
    return next(err);
  }
});

// ── GET /:id/allocations — "Added Tx :N" popup ───────────────────────────
// ── GET /pin/:pin — New City prefill (city, district, state, Zonal Manager) ──
router.get('/pin/:pin', validate(pinParam, 'params'), async (req, res, next) => {
  try {
    modernOk(res, await service.pinDetail(req.params.pin));
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

// ── POST / — New Supply Request ──────────────────────────────────────────
router.post('/', validate(createBody), async (req, res, next) => {
  try {
    const result = await service.create(req.body, req.user);
    logger.info('Returning created supply gap · id=' + result.id);
    modernOk(res, result);
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

// ── POST /invite — header "Invite Sent" (technician invite, no gap) ───────
router.post('/invite', validate(inviteBody), async (req, res, next) => {
  try {
    modernOk(res, await service.invite(req.body, req.user));
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

// ── POST /:id/remarks — "+ Add Remark" ───────────────────────────────────
router.post('/:id/remarks', validate(idParam, 'params'), validate(remarkBody), async (req, res, next) => {
  try {
    modernOk(res, await service.addRemark(req.params.id, req.body.comment, req.user));
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

// ── POST /:id/action — new supply / existing supply / cancel / complete ───
router.post('/:id/action', validate(idParam, 'params'), validate(actionBody), async (req, res, next) => {
  try {
    const result = await service.act(req.params.id, req.body, req.user);
    logger.info('Returning supply gap action · id=' + req.params.id + ' status=' + result.status);
    modernOk(res, result);
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

// ── PUT /:id — edit an Open request (category + reason) ──────────────────
router.put('/:id', validate(idParam, 'params'), validate(updateBody), async (req, res, next) => {
  try {
    const result = await service.update(req.params.id, req.body, req.user);
    modernOk(res, result);
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

router.get('/:id/allocations', validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Supply Gap allocations · id=' + req.params.id);
    const data = await service.allocations(Number(req.params.id));
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) {
      logger.warn('Supply Gap allocations failed · ' + err.message);
      return modernError(res, err.status, err.message);
    }
    logger.error('Supply Gap allocations error · ' + err.message);
    return next(err);
  }
});

// ── GET /:id/history — action/remark timeline ────────────────────────────
router.get('/:id/history', validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Supply Gap history · id=' + req.params.id);
    const data = await service.history(Number(req.params.id));
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) {
      logger.warn('Supply Gap history failed · ' + err.message);
      return modernError(res, err.status, err.message);
    }
    logger.error('Supply Gap history error · ' + err.message);
    return next(err);
  }
});

// ── GET /:id — row detail (eye-icon modal) ───────────────────────────────
router.get('/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Supply Gap row detail · id=' + req.params.id);
    const data = await service.detail(Number(req.params.id));
    return modernOk(res, data);
  } catch (err) {
    if (err && err.status) {
      logger.warn('Supply Gap row detail failed · ' + err.message);
      return modernError(res, err.status, err.message);
    }
    logger.error('Supply Gap row detail error · ' + err.message);
    return next(err);
  }
});

module.exports = router;
