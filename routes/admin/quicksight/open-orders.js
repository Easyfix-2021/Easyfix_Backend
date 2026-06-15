/*
 * QuickSight report sub-router — Open Orders.
 *
 *   registry slug   : openOrders
 *   urlBase         : open-orders   (mounted at /api/admin/quicksight/open-orders)
 *   action key      : isQuickSightOpenOrdersView
 *   service file    : services/quicksight/quicksight-open-orders.service.js
 *
 * Parent chain (routes/admin/index.js) already runs requireAuth → role(['admin']).
 * This sub-router layers the QuickSight family key + per-report key on top via
 * requireQuickSight. Both endpoints honour ?format=xlsx for a server-side
 * download (replaces the legacy clipboard-copy affordance).
 *
 * Legacy mapping:
 *   POST /summary  ← PM_JOBS_COUNT_FIlTER_LIST (getOwnerOpenOrderSummary)
 *   POST /by-owner ← PM_OPEN_ORDER_LIST        (getJobDetailsByPmUserId)
 */

const router = require('express').Router();
const Joi = require('joi');

const requireQuickSight = require('../../../middleware/require-quicksight');
const validate = require('../../../middleware/validate');
const { modernOk, modernError } = require('../../../utils/response');
const { sendXlsx } = require('../../../utils/xlsx-export');
const service = require('../../../services/quicksight/quicksight-open-orders.service');
const { extendJobFilter } = require('../../../validators/quicksight.validator');

// Per-report access gate: ef-QuickSight family key + this report's own key.
router.use(requireQuickSight('isQuickSightOpenOrdersView'));

// ── Joi schemas (inline; built from the shared jobFilterBase) ────────
// Summary accepts the FULL legacy filter body but only USES
// clientId/verticalId/zonalManagerId/serviceCategoryId.
const summarySchema = extendJobFilter();

// Drill-down adds the required pmUserId (the clicked Job Owner). Joi merges
// it on top of the base — pmUserId lives in the BODY, mirroring legacy
// behaviour where the FE re-sends the in-effect filter alongside the owner.
const byOwnerSchema = extendJobFilter({
  pmUserId: Joi.number().integer().required(),
});

// ── XLSX column sets (Title Case headers, corrected label/field alignment) ──
const SUMMARY_XLSX_COLUMNS = [
  { key: 'pmName', header: 'Job Owner', width: 28 },
  { key: 'waitingForAllocation', header: 'Waiting For Allocation' },
  { key: 'runningLate', header: 'Running Late' },
  { key: 'escalationCount', header: 'Escalation' },
  { key: 'unconfirmed', header: 'Unconfirmed' },
  { key: 'openOnApp', header: 'Waiting To Close >12 Hrs' },
  { key: 'waitingAudit', header: 'Waiting Audit >18 Hrs' },
  { key: 'totalAlerts', header: 'Total' },
];

const BY_OWNER_XLSX_COLUMNS = [
  { key: 'jobID', header: 'Job ID' },
  { key: 'clientName', header: 'Client Name', width: 24 },
  { key: 'clientSpocName', header: 'Client SPOC Name', width: 24 },
  { key: 'efrID', header: 'EasyFixer Id' },
  { key: 'efrName', header: 'EasyFixer Name', width: 22 },
  { key: 'jobBucketStatus', header: 'Bucket Status', width: 22 },
  { key: 'jobAge', header: 'Age' },
  { key: 'cityMappedUser', header: 'City Mapped User', width: 22 },
  { key: 'isEscalated', header: 'Escalated' },
];

// ── POST /summary — main Open Orders summary table ───────────────────
router.post('/summary', validate(summarySchema), async (req, res, next) => {
  try {
    const rows = await service.summary(req.body);

    if (req.body.format === 'xlsx') {
      return sendXlsx(res, {
        filename: 'open-orders-summary.xlsx',
        sheetName: 'Open Orders',
        columns: SUMMARY_XLSX_COLUMNS,
        rows,
      });
    }
    return modernOk(res, rows);
  } catch (err) {
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

// ── POST /by-owner — per-PM drill-down ───────────────────────────────
router.post('/by-owner', validate(byOwnerSchema), async (req, res, next) => {
  try {
    const { pmUserId, ...filters } = req.body;
    const rows = await service.byOwner(pmUserId, filters);

    if (req.body.format === 'xlsx') {
      return sendXlsx(res, {
        filename: `open-orders-pm-${pmUserId}.xlsx`,
        sheetName: 'Open Orders',
        columns: BY_OWNER_XLSX_COLUMNS,
        rows,
      });
    }
    return modernOk(res, rows);
  } catch (err) {
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

module.exports = router;
