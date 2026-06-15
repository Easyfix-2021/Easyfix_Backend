/*
 * QuickSight report sub-router — Priority Jobs (legacy "Hotspot City").
 *
 *   registry slug   : priorityJobs
 *   urlBase         : priority-jobs   (mounted at /api/admin/quicksight/priority-jobs)
 *   action key      : isQuickSightPriorityJobsView
 *   service file    : services/quicksight/quicksight-priority-jobs.service.js
 *
 * Parent chain (routes/admin/index.js) already runs requireAuth → role(['admin']).
 * This sub-router layers the QuickSight family key + per-report key on top via
 * requireQuickSight. Endpoints honour ?format=xlsx for a server-side download
 * (replaces the legacy client-side exceljs export).
 *
 * Legacy mapping (live cityWiseOwnedJobsAgingReport flow; the older
 * PM_JOBS_HOTSPOT is superseded and NOT used by the current priorityJobs page):
 *   POST /grid       ← /pmJobs/cityWiseOwnedJobsAgingReport (grid + KPIs)
 *   POST /city-jobs  ← /pmJobs/openOrdersJobList            (city drill-down)
 *   POST /export     ← /pmJobs/hotspotCityCopyData          (xlsx export)
 *
 * OWNERSHIP / ROLE scoping is faithful legacy parity: it scopes by
 * tbl_job.job_client_owner only (NOT the richer req.scope). Non-admin users
 * (user_role !== 2) are forced to their own owned jobs; Admin (user_role === 2)
 * sees ALL unless an ownerId list is supplied in the body. The service resolves
 * this from req.user — see resolveOwnerScope().
 */

const router = require('express').Router();
const Joi = require('joi');

const requireQuickSight = require('../../../middleware/require-quicksight');
const validate = require('../../../middleware/validate');
const { modernOk, modernError } = require('../../../utils/response');
const { sendXlsx } = require('../../../utils/xlsx-export');
const service = require('../../../services/quicksight/quicksight-priority-jobs.service');
const { extendJobFilter, idArray } = require('../../../validators/quicksight.validator');

// Per-report access gate: ef-QuickSight family key + this report's own key.
router.use(requireQuickSight('isQuickSightPriorityJobsView'));

// ── Joi schemas (inline; built from the shared jobFilterBase) ────────
// This report uses serviceCategoryId / stateId / cityId (from the base) plus
// an `ownerId` list (the legacy "Job Owner" filter → job_client_owner). The
// base's other dimensions (clientId/verticalId/zonalManagerId/projectManagerId)
// are accepted-but-ignored, matching the legacy JobSearchListDto contract.
const gridSchema = extendJobFilter({
  ownerId: idArray,
  pageNo: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(10),
});

// Drill-down: cityId REQUIRED (FE forces it to the clicked city before calling).
const cityJobsSchema = extendJobFilter({
  ownerId: idArray,
  cityId: Joi.array().items(Joi.number().integer()).single().min(1).required(),
});

// Export: same filter set; no pagination.
const exportSchema = extendJobFilter({ ownerId: idArray });

// ── XLSX column set — 18 cols, exact legacy "Hotspot_Job_Data" order ──
// (corrected label/field alignment per registry decision; Title Case headers).
const EXPORT_XLSX_COLUMNS = [
  { key: 'job_id', header: 'Job ID' },
  { key: 'jobAge', header: 'Job Age' },
  { key: 'jobCurrentOwner', header: 'Job Owner', width: 24 },
  { key: 'clientName', header: 'Client Name', width: 24 },
  { key: 'jobDescription', header: 'Job Description', width: 30 },
  { key: 'cityName', header: 'City Name', width: 18 },
  { key: 'zonalManager', header: 'Zonal Manager', width: 22 },
  { key: 'cityType', header: 'City Type' },
  { key: 'jobStatus', header: 'Job Status', width: 18 },
  { key: 'efr_id', header: 'EFR ID' },
  { key: 'efr_name', header: 'EFR Name', width: 22 },
  { key: 'catgName', header: 'Category', width: 22 },
  { key: 'appointmentDateTime', header: 'Appointment DateTime', width: 22 },
  { key: 'originalAppointmentDateTime', header: 'Original Appointment', width: 22 },
  { key: 'pendingDueTo', header: 'Pending Due To', width: 16 },
  { key: 'reason', header: 'Reason', width: 24 },
  { key: 'remarks', header: 'Remarks', width: 30 },
  { key: 'lastUpdatedRemarksDateTime', header: 'Last Updated Remarks', width: 22 },
];

// ── POST /grid — main Priority Jobs city-aging grid + KPIs ────────────
router.post('/grid', validate(gridSchema), async (req, res, next) => {
  try {
    const { pageNo, pageSize, ...filters } = req.body;
    const result = await service.grid(req.user, filters, { pageNo, pageSize });
    return modernOk(res, result);
  } catch (err) {
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

// ── POST /city-jobs — drill-down for the clicked city ─────────────────
router.post('/city-jobs', validate(cityJobsSchema), async (req, res, next) => {
  try {
    const rows = await service.cityJobs(req.user, req.body);
    return modernOk(res, rows);
  } catch (err) {
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

// ── POST /export — job-level XLSX (closed-jobs quirk preserved in service) ──
router.post('/export', validate(exportSchema), async (req, res, next) => {
  try {
    const rows = await service.copyData(req.user, req.body);

    if (req.body.format === 'xlsx') {
      return sendXlsx(res, {
        filename: 'priority-jobs.xlsx',
        sheetName: 'Hotspot Job Data',
        columns: EXPORT_XLSX_COLUMNS,
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
