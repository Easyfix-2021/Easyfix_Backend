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
const { streamStyledXlsx } = require('../../../utils/xlsx-styled-export');
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

// Human-friendly generated-on stamp for the meta band (e.g. "15 Jun 2026").
const DISPLAY_STAMP = () =>
  new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

// Filename-safe date stamp (e.g. "2026-06-15").
const FILE_STAMP = () => new Date().toISOString().slice(0, 10);

// Counts → thousands-grouped integers.
const FMT_COUNT = '#,##0';

// ── XLSX column sets (Title Case headers, corrected label/field alignment) ──
// Keys/headers/widths are UNCHANGED from the original; only display polish
// (align / numFmt / data bars) is layered on. All buckets are COUNTS → '#,##0'
// + right-aligned. Data bars highlight the three highest-signal alert columns:
//   Escalation (red), Running Late (amber), Waiting For Allocation (blue).
const SUMMARY_XLSX_COLUMNS = [
  { key: 'pmName', header: 'Job Owner', width: 28, align: 'left' },
  { key: 'waitingForAllocation', header: 'Waiting For Allocation', align: 'right', numFmt: FMT_COUNT, dataBar: true, dataBarColor: 'FF2E86DE' },
  { key: 'runningLate', header: 'Running Late', align: 'right', numFmt: FMT_COUNT, dataBar: true, dataBarColor: 'FFF59E0B' },
  { key: 'escalationCount', header: 'Escalation', align: 'right', numFmt: FMT_COUNT, dataBar: true, dataBarColor: 'FFEF4444' },
  { key: 'unconfirmed', header: 'Unconfirmed', align: 'right', numFmt: FMT_COUNT },
  { key: 'openOnApp', header: 'Waiting To Close >12 Hrs', align: 'right', numFmt: FMT_COUNT },
  { key: 'waitingAudit', header: 'Waiting Audit >18 Hrs', align: 'right', numFmt: FMT_COUNT },
  { key: 'totalAlerts', header: 'Total', align: 'right', numFmt: FMT_COUNT },
];

// Drill-down: a job-level list. Age + the escalated flag are the only numeric
// columns; Age carries a blue data bar so the oldest jobs stand out.
const BY_OWNER_XLSX_COLUMNS = [
  { key: 'jobID', header: 'Job ID', align: 'right', numFmt: FMT_COUNT },
  { key: 'clientName', header: 'Client Name', width: 24, align: 'left' },
  { key: 'clientSpocName', header: 'Client SPOC Name', width: 24, align: 'left' },
  { key: 'efrID', header: 'EasyFixer Id', align: 'right', numFmt: FMT_COUNT },
  { key: 'efrName', header: 'EasyFixer Name', width: 22, align: 'left' },
  { key: 'jobBucketStatus', header: 'Bucket Status', width: 22, align: 'left' },
  { key: 'jobAge', header: 'Age', align: 'right', numFmt: FMT_COUNT, dataBar: true, dataBarColor: 'FF2E86DE' },
  { key: 'cityMappedUser', header: 'City Mapped User', width: 22, align: 'left' },
  { key: 'isEscalated', header: 'Escalated', align: 'right', numFmt: FMT_COUNT },
];

// ── POST /summary — main Open Orders summary table ───────────────────
router.post('/summary', validate(summarySchema), async (req, res, next) => {
  try {
    const rows = await service.summary(req.body);

    if (req.body.format === 'xlsx') {
      // Per-column SUM footer + headline KPI totals across all Job Owners.
      const sum = (key) => rows.reduce((acc, r) => acc + (Number(r[key]) || 0), 0);
      const totalRow = {
        pmName: 'Total',
        waitingForAllocation: sum('waitingForAllocation'),
        runningLate: sum('runningLate'),
        escalationCount: sum('escalationCount'),
        unconfirmed: sum('unconfirmed'),
        openOnApp: sum('openOnApp'),
        waitingAudit: sum('waitingAudit'),
        totalAlerts: sum('totalAlerts'),
      };

      const kpis = [
        { label: 'Total Escalations', value: totalRow.escalationCount, accent: 'FFEF4444' },
        { label: 'Total Running Late', value: totalRow.runningLate, accent: 'FFF59E0B' },
        { label: 'Total Waiting For Allocation', value: totalRow.waitingForAllocation, accent: 'FF2E86DE' },
        { label: 'Total Unconfirmed', value: totalRow.unconfirmed, accent: 'FF6366F1' },
      ];

      const ownerCount = rows.length;
      const meta =
        `${ownerCount} ${ownerCount === 1 ? 'Job Owner' : 'Job Owners'} · ` +
        `Generated ${DISPLAY_STAMP()}`;

      await streamStyledXlsx(res, `open-orders-summary-${FILE_STAMP()}.xlsx`, {
        title: 'EasyFix · Open Orders',
        meta,
        sheetName: 'Open Orders',
        columns: SUMMARY_XLSX_COLUMNS,
        rows,
        kpis,
        totalRow,
        emptyMessage: 'No Open Orders Found.',
      });
      return;
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
      // Job-level drill-down — KPIs summarise this owner's open jobs. (The
      // service rows are job-level and carry no pmName, so the meta line keys
      // off the clicked pmUserId rather than a name.)
      const escalatedCount = rows.reduce((acc, r) => acc + (Number(r.isEscalated) || 0), 0);
      const oldestAge = rows.reduce((acc, r) => Math.max(acc, Number(r.jobAge) || 0), 0);
      const kpis = [
        { label: 'Total Open Jobs', value: rows.length, accent: 'FF2E86DE' },
        { label: 'Escalated Jobs', value: escalatedCount, accent: 'FFEF4444' },
        { label: 'Oldest Job Age (Days)', value: oldestAge, accent: 'FFF59E0B' },
      ];

      const meta =
        `Job Owner #${pmUserId} · ` +
        `${rows.length} ${rows.length === 1 ? 'Open Job' : 'Open Jobs'} · ` +
        `Generated ${DISPLAY_STAMP()}`;

      await streamStyledXlsx(res, `open-orders-pm-${pmUserId}-${FILE_STAMP()}.xlsx`, {
        title: 'EasyFix · Open Orders By Job Owner',
        meta,
        sheetName: 'Open Orders',
        columns: BY_OWNER_XLSX_COLUMNS,
        rows,
        kpis,
        emptyMessage: 'No Open Orders Found.',
      });
      return;
    }
    return modernOk(res, rows);
  } catch (err) {
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

module.exports = router;
