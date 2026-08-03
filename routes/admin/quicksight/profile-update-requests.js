/*
 * QuickSight report sub-router — Profile Update Requests.
 *   action key : isQuickSightProfileUpdateRequestsView  (+ family ef-QuickSight)
 *   service    : services/quicksight/quicksight-profile-update-requests.service.js
 *
 *   POST /api/admin/quicksight/profile-update-requests/summary
 *     body: { zonalManagerId?[], dateFrom?, dateTo?, submittedStatus?
 *             ('submitted'|'pending'|'expired'|'all'), lastAction?
 *             ('first'|'reminder'|'resend'), format? }
 *     → { rows: [per-tech], byStatus, byDay, totals }  (or XLSX)
 *
 * Note: easyfixers aren't client/vertical scoped, so those job filters don't
 * apply here — only zonalManager (via the tech's city → tbl_city.state_user).
 */

const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../../middleware/validate');
const requireQuickSight = require('../../../middleware/require-quicksight');
const { modernOk } = require('../../../utils/response');
const { streamStyledXlsx } = require('../../../utils/xlsx-styled-export');
const { extendJobFilter } = require('../../../validators/quicksight.validator');
const { fileStamp, displayStamp, FMT, decorateColumns } = require('../../../services/quicksight/_shared');
const service = require('../../../services/quicksight/quicksight-profile-update-requests.service');
const logger = require('../../../logger');

const ACTION_KEY = 'isQuickSightProfileUpdateRequestsView';
router.use(requireQuickSight(ACTION_KEY));

const summaryBody = extendJobFilter({
  dateFrom: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  submittedStatus: Joi.string().valid('submitted', 'pending', 'expired', 'all').optional(),
  lastAction: Joi.string().valid('first', 'reminder', 'resend').optional(),
});

const COUNT_KEYS = ['efrId', 'sendCount', 'daysToSubmit'];
const COLUMN_RULES = [
  { match: (k) => k === 'efrName' || k === 'cityName' || k === 'statusStr' || k === 'lastAction', hints: { align: 'left' } },
  { match: (k) => COUNT_KEYS.includes(k), hints: { align: 'right', numFmt: FMT.COUNT } },
];

router.post('/summary', validate(summaryBody), async (req, res, next) => {
  try {
    logger.info('Profile Update Requests report · format=' + (req.body.format || 'json'));
    const filters = {
      zonalManagerId: req.body.zonalManagerId,
      dateFrom: req.body.dateFrom,
      dateTo: req.body.dateTo,
      submittedStatus: req.body.submittedStatus,
      lastAction: req.body.lastAction,
    };
    const data = await service.getProfileUpdateRequests(filters);

    if (req.body.format === 'xlsx') {
      const { columns, rows } = service.toXlsx(data);
      await streamStyledXlsx(res, `profile-update-requests-${fileStamp()}.xlsx`, {
        title: 'EasyFix · Profile Update Requests',
        meta: `${data.totals.requests} Requests · ${data.totals.submitted} Submitted (${data.totals.submissionRate}%) · Generated ${displayStamp()}`,
        sheetName: 'Profile Update Requests',
        columns: decorateColumns(columns, COLUMN_RULES),
        rows,
        kpis: [
          { label: 'Requests (Links Sent)', value: data.totals.requests, numFmt: FMT.COUNT, accent: 'FF2E86DE' },
          { label: 'Submitted', value: data.totals.submitted, numFmt: FMT.COUNT, accent: 'FF10B981' },
          { label: 'Submission Rate', value: data.totals.submissionRate, numFmt: FMT.PCT, accent: 'FF10B981' },
          { label: 'Avg Days To Submit', value: data.totals.avgDaysToSubmit != null ? data.totals.avgDaysToSubmit : 0, numFmt: FMT.COUNT },
        ],
        emptyMessage: 'No Profile Update Requests Found.',
      });
      return;
    }
    return modernOk(res, data);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
