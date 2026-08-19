/*
 * TAT Calculator — read-only admin diagnostic over the centralised TAT service.
 *   action key : isTatCalculatorView
 *   service    : services/tat.service.js
 *   page       : Easyfix_CRM_UI /admin-actions/tat-calculator
 *
 *   GET /api/admin/tat/policy                  → the matrix + assumptions
 *   GET /api/admin/tat/job/:jobId              → one job, four segments
 *   GET /api/admin/tat/client/:clientId?days=  → client roll-up (default 90d)
 *   GET /api/admin/tat/technician/:efrId       → technician roll-up (lifetime)
 *   GET /api/admin/tat/:dimension/:id?days=    → city | category | project-manager
 *                                                | vertical roll-up (default 90d)
 *
 * This exists so TAT can be INSPECTED before it is consumed anywhere — no
 * report, chip or escalation reads this service yet. Everything here is a read;
 * there is no Edit action key because there is nothing to edit.
 *
 * Mounted under /api/admin, so requireAuth + role(['admin']) + maskMobile +
 * req.scope are already applied by routes/admin/index.js — only the fine-grained
 * action guard is layered here.
 */

const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const requireAction = require('../../middleware/require-action');
const { modernOk, modernError } = require('../../utils/response');
const { streamStyledXlsx } = require('../../utils/xlsx-styled-export');
const { fileStamp, displayStamp, FMT } = require('../../services/quicksight/_shared');
const logger = require('../../logger');
const tat = require('../../services/tat.service');

const requireTatView = requireAction('isTatCalculatorView');

router.use(requireTatView);

const idParam = Joi.object({
  jobId: Joi.number().integer().positive(),
  clientId: Joi.number().integer().positive(),
  efrId: Joi.number().integer().positive(),
});

// Client lookback. Defaults to the spec's 90 days; capped at 2 years so a
// mistyped value cannot pull an unbounded scan.
const clientQuery = Joi.object({
  days: Joi.number().integer().min(1).max(730).default(tat.CLIENT_LOOKBACK_DAYS),
  format: Joi.string().valid('json', 'xlsx').default('json'),
});

/*
 * The matrix + caveats, straight from the service, so the "How It Works?" panel
 * renders the SAME numbers the computation uses. A hand-copied table in the UI
 * would drift the first time a target changes.
 */
router.get('/policy', (req, res, next) => {
  try {
    logger.info('TAT policy requested');
    return modernOk(res, tat.policy());
  } catch (e) { next(e); }
});

router.get('/job/:jobId', validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('TAT calculator · job · id=' + req.params.jobId);
    return modernOk(res, await tat.forJob(Number(req.params.jobId)));
  } catch (e) {
    if (e.status) {
      logger.warn('TAT job lookup failed · id=' + req.params.jobId + ' · ' + e.message);
      return modernError(res, e.status, e.message);
    }
    return next(e);
  }
});

router.get('/client/:clientId', validate(idParam, 'params'), validate(clientQuery, 'query'), async (req, res, next) => {
  try {
    logger.info('TAT calculator · client · id=' + req.params.clientId + ' · days=' + req.query.days);
    return maybeXlsx(req, res, await tat.forClient(Number(req.params.clientId), Number(req.query.days)), 'client');
  } catch (e) {
    if (e.status) {
      logger.warn('TAT client lookup failed · id=' + req.params.clientId + ' · ' + e.message);
      return modernError(res, e.status, e.message);
    }
    return next(e);
  }
});

router.get('/technician/:efrId', validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('TAT calculator · technician · id=' + req.params.efrId);
    return maybeXlsx(req, res, await tat.forTechnician(Number(req.params.efrId)), 'technician');
  } catch (e) {
    if (e.status) {
      logger.warn('TAT technician lookup failed · id=' + req.params.efrId + ' · ' + e.message);
      return modernError(res, e.status, e.message);
    }
    return next(e);
  }
});

/*
 * XLSX export of any aggregate result. `?format=xlsx` on the aggregate modes.
 *
 * One row per job with its four segment verdicts and both scores — the shape an
 * ops reviewer actually pastes into a client conversation. The segment MET %
 * summary rides in the KPI strip rather than a second sheet, because a single
 * sheet is what gets forwarded.
 *
 * The two scores stay in SEPARATE columns here exactly as they do on screen. A
 * combined column would be the one place this export could quietly undo the
 * ownership split the whole engine exists to preserve.
 */
const XLSX_COLUMNS = [
  { header: 'Job ID', key: 'jobId', width: 12, numFmt: FMT.COUNT },
  { header: 'Reference', key: 'jobReferenceId', width: 18, align: 'left' },
  { header: 'Client', key: 'clientName', width: 28, align: 'left' },
  { header: 'City', key: 'cityName', width: 18, align: 'left' },
  { header: 'Category', key: 'categoryName', width: 22, align: 'left' },
  { header: 'Technician', key: 'technicianName', width: 22, align: 'left' },
  { header: 'Project Manager', key: 'projectManager', width: 20, align: 'left' },
  { header: 'Vertical', key: 'verticalName', width: 18, align: 'left' },
  { header: 'Local / Travel', key: 'jobType', width: 14, align: 'left' },
  { header: 'Estimate Sent', key: 'estimateSent', width: 14, align: 'left' },
  { header: 'Seg 1 Visit', key: 'seg1', width: 12, align: 'left' },
  { header: 'Seg 1 Hrs', key: 'seg1Hrs', width: 11, numFmt: FMT.COUNT },
  { header: 'Seg 2 Estimate', key: 'seg2', width: 14, align: 'left' },
  { header: 'Seg 2 Hrs', key: 'seg2Hrs', width: 11, numFmt: FMT.COUNT },
  { header: 'Seg 3 Approval (Client)', key: 'seg3', width: 22, align: 'left' },
  { header: 'Seg 3 Hrs', key: 'seg3Hrs', width: 11, numFmt: FMT.COUNT },
  { header: 'Seg 4 Completion', key: 'seg4', width: 16, align: 'left' },
  { header: 'Seg 4 Hrs', key: 'seg4Hrs', width: 11, numFmt: FMT.COUNT },
  { header: 'EasyFix Score', key: 'efScore', width: 14, align: 'left' },
  { header: 'Client Score', key: 'clientScore', width: 13, align: 'left' },
  { header: 'Performance', key: 'performance', width: 14, align: 'left' },
];

function toXlsxRow(j) {
  const s = j.segments;
  return {
    jobId: j.jobId,
    jobReferenceId: j.jobReferenceId,
    clientName: j.clientName,
    cityName: j.cityName,
    categoryName: j.categoryName,
    technicianName: j.technicianName,
    projectManager: j.projectManager,
    verticalName: j.verticalName,
    jobType: j.jobType,
    estimateSent: j.isEstimateSent ? 'Yes' : 'No',
    seg1: s[0].status, seg1Hrs: s[0].hours,
    seg2: s[1].status, seg2Hrs: s[1].hours,
    seg3: s[2].status, seg3Hrs: s[2].hours,
    seg4: s[3].status, seg4Hrs: s[3].hours,
    efScore: j.efScore,
    clientScore: j.clientScore,
    performance: j.performance,
  };
}

async function maybeXlsx(req, res, data, slug) {
  if (req.query.format !== 'xlsx') return modernOk(res, data);
  const sum = data.summary;
  logger.info('TAT export · ' + slug + ' · jobs=' + (data.jobs || []).length);
  await streamStyledXlsx(res, `tat-${slug}-${fileStamp()}.xlsx`, {
    title: 'EasyFix · Segment TAT',
    meta: `${data.subject ? data.subject.name + ' · ' : ''}${data.windowLabel || ''}`
      + ` · ${sum.jobsAnalysed} Job(s) · Generated ${displayStamp()}`
      + (data.truncated ? ` · PARTIAL VIEW (capped at ${data.rowCap})` : ''),
    sheetName: 'Segment TAT',
    columns: XLSX_COLUMNS,
    rows: (data.jobs || []).map(toXlsxRow),
    kpis: [
      { label: 'EasyFix Score', value: sum.efScorePct, numFmt: '0.0"%"', accent: 'FF10B981' },
      { label: 'Client Score (Seg 3)', value: sum.clientScorePct, numFmt: '0.0"%"', accent: 'FFF59E0B' },
      { label: 'Jobs Analysed', value: sum.jobsAnalysed, numFmt: FMT.COUNT },
      { label: 'Poor + Partial', value: (sum.labels.Poor || 0) + (sum.labels.Partial || 0), numFmt: FMT.COUNT, accent: 'FFE11D48' },
    ],
    emptyMessage: 'No Completed Jobs In This Window.',
  });
}

/*
 * City / Category / Project Manager / Vertical — one generic handler over
 * tat.forDimension. Mounted LAST so the specific routes above always win; the
 * dimension is validated against the service's own table rather than a literal
 * list here, so the two cannot drift.
 */
const dimensionParam = Joi.object({
  dimension: Joi.string().valid(...Object.keys(tat.DIMENSION_MODES)).required(),
  id: Joi.number().integer().positive().required(),
});

router.get('/:dimension/:id', validate(dimensionParam, 'params'), validate(clientQuery, 'query'), async (req, res, next) => {
  try {
    logger.info('TAT calculator · ' + req.params.dimension + ' · id=' + req.params.id);
    return maybeXlsx(req, res, await tat.forDimension(req.params.dimension, Number(req.params.id), Number(req.query.days)), req.params.dimension);
  } catch (e) {
    if (e.status) {
      logger.warn('TAT ' + req.params.dimension + ' lookup failed · id=' + req.params.id + ' · ' + e.message);
      return modernError(res, e.status, e.message);
    }
    return next(e);
  }
});

module.exports = router;
