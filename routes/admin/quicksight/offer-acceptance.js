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
 *     → { rows: [per-tech], bySource: [...], byOwner: [...], byDay: [...], totals: {...} }  (or XLSX)
 */

const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../../middleware/validate');
const requireQuickSight = require('../../../middleware/require-quicksight');
const { modernOk } = require('../../../utils/response');
const { streamStyledXlsx } = require('../../../utils/xlsx-styled-export');
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

const COUNT_KEYS = ['efrId', 'offered', 'accepted', 'rejected', 'expired', 'open', 'avgResponseMins'];
const COLUMN_RULES = [
  { match: (k) => k === 'efrName', hints: { align: 'left' } },
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
      const { columns, rows } = service.toXlsx(data);
      await streamStyledXlsx(res, `offer-acceptance-${fileStamp()}.xlsx`, {
        title: 'EasyFix · Offer Acceptance',
        meta: `${data.rows.length} Technicians · Overall Acceptance ${data.totals.acceptanceRate}% · Generated ${displayStamp()}`,
        sheetName: 'Offer Acceptance',
        columns: decorateColumns(columns, COLUMN_RULES),
        rows,
        kpis: [
          { label: 'Total Offered', value: data.totals.offered, numFmt: FMT.COUNT, accent: 'FF2E86DE' },
          { label: 'Accepted', value: data.totals.accepted, numFmt: FMT.COUNT, accent: 'FF10B981' },
          { label: 'Acceptance Rate', value: data.totals.acceptanceRate, numFmt: FMT.PCT, accent: 'FF10B981' },
          { label: 'Avg Response (Min)', value: data.totals.avgResponseSecs != null ? Math.round((data.totals.avgResponseSecs / 60) * 10) / 10 : 0, numFmt: FMT.COUNT },
        ],
        emptyMessage: 'No Offer Data Found.',
      });
      return;
    }
    return modernOk(res, data);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
