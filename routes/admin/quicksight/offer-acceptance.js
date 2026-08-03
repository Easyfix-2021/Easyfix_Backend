/*
 * QuickSight report sub-router — Offer Acceptance.
 *   action key : isQuickSightOfferAcceptanceView  (+ family ef-QuickSight)
 *   service    : services/quicksight/quicksight-offer-acceptance.service.js
 *
 *   POST /api/admin/quicksight/offer-acceptance/summary
 *     body: { clientId?[], verticalId?[], zonalManagerId?[], serviceCategoryId?[],
 *             offeredById?[] (user who made the offer), dateFrom?, dateTo? (offered_at window),
 *             respondedFrom?, respondedTo? (responded_at / acceptance window),
 *             source? ('top10'|'search'|'auto'), format? }
 *     → { rows: [per-tech], bySource: [...], byOwner: [...], byJob: [...], byDay: [...], totals: {...} }  (or XLSX)
 *       Every grouping carries BOTH `offered` (rows = technicians offered) and
 *       `rounds` (SUM offer_count = offer actions incl. re-offers).
 */

const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../../middleware/validate');
const requireQuickSight = require('../../../middleware/require-quicksight');
const { modernOk } = require('../../../utils/response');
const { buildStyledWorkbook, streamWorkbook } = require('../../../utils/xlsx-styled-export');
const { extendJobFilter, idArray } = require('../../../validators/quicksight.validator');
const { fileStamp, displayStamp, FMT, decorateColumns } = require('../../../services/quicksight/_shared');
const service = require('../../../services/quicksight/quicksight-offer-acceptance.service');
const logger = require('../../../logger');

const ACTION_KEY = 'isQuickSightOfferAcceptanceView';
router.use(requireQuickSight(ACTION_KEY));

const summaryBody = extendJobFilter({
  // offered_at cohort window (when the offer was made).
  dateFrom: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // responded_at window (the acceptance date — when the tech accepted/rejected).
  respondedFrom: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  respondedTo: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  source: Joi.string().valid('top10', 'search', 'auto').optional(),
  // "Offered By" = who made the offer (tbl_job_offer.offered_by_user_id). Array of user ids; empty = all.
  offeredById: idArray,
});

const COUNT_KEYS = ['efrId', 'jobId', 'offered', 'reoffers', 'techsOffered', 'waves', 'accepted', 'rejected', 'expired', 'open', 'avgResponseMins', 'timeToAcceptMins'];
const COLUMN_RULES = [
  { match: (k) => ['efrName', 'ownerName', 'clientName', 'jobStatusLabel', 'offerersLabel', 'acceptedBy', 'firstOfferedAt'].includes(k), hints: { align: 'left' } },
  { match: (k) => k === 'acceptanceRate', hints: { align: 'right', numFmt: FMT.PCT } },
  { match: (k) => COUNT_KEYS.includes(k), hints: { align: 'right', numFmt: FMT.COUNT } },
];

router.post('/summary', validate(summaryBody), async (req, res, next) => {
  try {
    logger.info('Offer Acceptance report · format=' + (req.body.format || 'json'));
    const filters = {
      clientId: req.body.clientId,
      verticalId: req.body.verticalId,
      zonalManagerId: req.body.zonalManagerId,
      serviceCategoryId: req.body.serviceCategoryId,
      offeredById: req.body.offeredById,
      dateFrom: req.body.dateFrom,
      dateTo: req.body.dateTo,
      respondedFrom: req.body.respondedFrom,
      respondedTo: req.body.respondedTo,
      source: req.body.source,
    };
    const data = await service.getOfferAcceptance(filters);

    if (req.body.format === 'xlsx') {
      /*
       * THREE sheets — Technician / Offerer / Job — mirroring the on-screen
       * tabs, so the download carries everything the report can show. Each
       * buildStyledWorkbook call after the first passes the SAME workbook, then
       * streamWorkbook ships it (see utils/xlsx-styled-export). The KPI band
       * rides on the first sheet only; repeating it on each would just be noise.
       */
      const { sheets } = service.toXlsx(data);
      let wb;
      sheets.forEach((sheet, i) => {
        wb = buildStyledWorkbook({
          wb,
          title: `EasyFix · Offer Acceptance — ${sheet.name}`,
          meta: i === 0
            ? `${data.rows.length} Technicians · ${data.byJob.length} Jobs · Overall Acceptance ${data.totals.acceptanceRate}% · Generated ${displayStamp()}`
            : undefined,
          sheetName: sheet.name,
          columns: decorateColumns(sheet.columns, COLUMN_RULES),
          rows: sheet.rows,
          kpis: i === 0 ? [
            { label: 'Total Offered', value: data.totals.offered, numFmt: FMT.COUNT, accent: 'FF2E86DE' },
            { label: 'Accepted', value: data.totals.accepted, numFmt: FMT.COUNT, accent: 'FF10B981' },
            { label: 'Acceptance Rate', value: data.totals.acceptanceRate, numFmt: FMT.PCT, accent: 'FF10B981' },
            { label: 'Avg Response (Min)', value: data.totals.avgResponseSecs != null ? Math.round((data.totals.avgResponseSecs / 60) * 10) / 10 : 0, numFmt: FMT.COUNT },
          ] : undefined,
          emptyMessage: 'No Offer Data Found.',
        });
      });
      await streamWorkbook(res, `offer-acceptance-${fileStamp()}.xlsx`, wb);
      return;
    }
    return modernOk(res, data);
  } catch (e) {
    next(e);
  }
});

/*
 * POST /api/admin/quicksight/offer-acceptance/offers
 *
 * Count drill-down: the individual offers behind ONE number in the report.
 * Body = the SAME filter schema as /summary plus the clicked cell:
 *   { jobId? | efrId? | offeredById?, status?: 'accepted'|'rejected'|'expired'|'open' }
 * Reusing the summary filters is the point — the rows returned are exactly the
 * ones that produced the number, so the two always reconcile.
 */
const offersBody = extendJobFilter({
  dateFrom: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  respondedFrom: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  respondedTo: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  source: Joi.string().valid('top10', 'search', 'auto').optional(),
  offeredById: idArray,
  // Selection — which cell was clicked. `offeredById` above is the FILTER (an
  // array); this is the single offerer whose row was clicked, where 0 means the
  // synthetic "Unassigned" (NULL offered_by) bucket, so .min(0) not .min(1).
  jobId: Joi.number().integer().min(1).optional(),
  efrId: Joi.number().integer().min(1).optional(),
  selectedOffererId: Joi.number().integer().min(0).optional(),
  status: Joi.string().valid('accepted', 'rejected', 'expired', 'open').optional(),
});

router.post('/offers', validate(offersBody), async (req, res, next) => {
  try {
    const filters = {
      clientId: req.body.clientId,
      verticalId: req.body.verticalId,
      zonalManagerId: req.body.zonalManagerId,
      serviceCategoryId: req.body.serviceCategoryId,
      offeredById: req.body.offeredById,
      dateFrom: req.body.dateFrom,
      dateTo: req.body.dateTo,
      respondedFrom: req.body.respondedFrom,
      respondedTo: req.body.respondedTo,
      source: req.body.source,
    };
    logger.info('Offer Acceptance drill-down · jobId=' + (req.body.jobId ?? '-')
      + ' efrId=' + (req.body.efrId ?? '-')
      + ' offerer=' + (req.body.selectedOffererId ?? '-')
      + ' status=' + (req.body.status ?? 'all'));
    const data = await service.getOfferDetails(filters, {
      jobId: req.body.jobId,
      efrId: req.body.efrId,
      offeredById: req.body.selectedOffererId,
      status: req.body.status,
    });
    return modernOk(res, data);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
