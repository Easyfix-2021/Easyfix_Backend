/*
 * QuickSight report sub-router — Premature Confirmations.
 *   action key : isQuickSightPrematureConfirmationsView (+ family ef-QuickSight)
 *   service    : services/quicksight/quicksight-premature-confirmations.service.js
 *
 *   POST /api/admin/quicksight/premature-confirmations/summary
 *     body: { clientId?[], verticalId?[], serviceCategoryId?[], cityId?[],
 *             movedById?[], dateFrom?, dateTo?, format? }
 *     → { rows, byUser, totals }   (or XLSX)
 *
 * Jobs pushed from Unconfirmed to Pending for Scheduling without the customer
 * ever confirming — no form submission (or an Unreachable outcome) AND no real
 * phone contact. See the service header for what counts and for the honest
 * limits of the "Moved By" attribution.
 *
 * PLAYBACK: each row carries `short_call_ids` — the calls that connected but ran
 * under the threshold. The FE plays them through the EXISTING
 * GET /api/admin/calls/:id/recording presigned-URL endpoint (the same one Call
 * Analytics uses), so no second audio path is introduced and the recording's
 * own access gate still applies.
 */

const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../../middleware/validate');
const requireQuickSight = require('../../../middleware/require-quicksight');
const { modernOk } = require('../../../utils/response');
const { streamStyledXlsx } = require('../../../utils/xlsx-styled-export');
const { extendJobFilter } = require('../../../validators/quicksight.validator');
const { fileStamp, displayStamp, FMT, decorateColumns } = require('../../../services/quicksight/_shared');
const service = require('../../../services/quicksight/quicksight-premature-confirmations.service');
const logger = require('../../../logger');

const ACTION_KEY = 'isQuickSightPrematureConfirmationsView';
router.use(requireQuickSight(ACTION_KEY));

const summaryBody = extendJobFilter({
  dateFrom: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // Narrow to specific operators once a pattern is spotted.
  movedById: Joi.array().items(Joi.number().integer().positive()).optional(),
  limit: Joi.number().integer().min(1).max(2000).default(500),
});

const COLUMN_RULES = [
  { match: (k) => ['client_name', 'city_name', 'customer_name', 'moved_by', 'flagText'].includes(k), hints: { align: 'left' } },
  { match: (k) => ['call_count', 'max_duration', 'job_id'].includes(k), hints: { align: 'right', numFmt: FMT.COUNT } },
];

router.post('/summary', validate(summaryBody), async (req, res, next) => {
  try {
    logger.info('Premature Confirmations report · format=' + (req.body.format || 'json'));
    const data = await service.getPrematureConfirmations({
      clientId: req.body.clientId,
      verticalId: req.body.verticalId,
      serviceCategoryId: req.body.serviceCategoryId,
      cityId: req.body.cityId,
      movedById: req.body.movedById,
      dateFrom: req.body.dateFrom,
      dateTo: req.body.dateTo,
      limit: req.body.limit,
    });

    if (req.body.format === 'xlsx') {
      const { columns, rows } = service.toXlsx(data);
      await streamStyledXlsx(res, `premature-confirmations-${fileStamp()}.xlsx`, {
        title: 'EasyFix · Premature Confirmations',
        meta: `${data.totals.jobs} Job(s) · ${data.byUser.length} Operator(s) · Short-Call Threshold ${data.totals.shortCallThresholdSecs}s · Generated ${displayStamp()}`,
        sheetName: 'Premature Confirmations',
        columns: decorateColumns(columns, COLUMN_RULES),
        rows,
        kpis: [
          { label: 'Flagged Jobs', value: data.totals.jobs, numFmt: FMT.COUNT, accent: 'FFE11D48' },
          { label: 'No Calls At All', value: data.totals.noCalls, numFmt: FMT.COUNT, accent: 'FFE11D48' },
          { label: 'Short Calls Only', value: data.totals.shortCallsOnly, numFmt: FMT.COUNT, accent: 'FFF59E0B' },
          { label: 'Form Not Submitted', value: data.totals.notSubmitted, numFmt: FMT.COUNT },
        ],
        emptyMessage: 'No Premature Confirmations Found — Every Confirmed Job Had Customer Contact.',
      });
      return;
    }

    modernOk(res, data);
  } catch (e) { next(e); }
});

module.exports = router;
