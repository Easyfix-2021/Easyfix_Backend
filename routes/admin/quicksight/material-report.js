/*
 * QuickSight report sub-router — Material Report.
 *
 *   registry slug   : materiallist
 *   urlBase         : material-report   (mounted at /api/admin/quicksight/material-report)
 *   action key      : isQuickSightMaterialReportView
 *   service file    : services/quicksight/quicksight-material-report.service.js
 *
 * Single legacy endpoint rebuilt natively:
 *   GET /api/admin/quicksight/material-report?clientId=&from=&to=[&format=xlsx]
 *
 * Legacy source: ACD_APIs POST /downloadMaterialReportForClient (Excel-on-disk
 * + download-URL). The native build exposes a JSON list (on-screen table) that
 * ALSO honours ?format=xlsx (server-side stream via utils/xlsx-export.js) — the
 * same 27 columns in EXACT legacy order/spelling, one row per element-deployed
 * line.
 *
 * Parent chain (routes/admin/index.js) already runs requireAuth → role(['admin'])
 * → maskMobile → req.scope. This sub-router layers the QuickSight gate on top
 * (ef-QuickSight family key + the per-report isQuickSightMaterialReportView key)
 * via requireQuickSight, applied to EVERY route below.
 *
 * Gating note: legacy /downloadMaterialReportForClient was permitAll (token
 * logged, never enforced — any caller could export any client). The native
 * build is INTENTIONALLY hardened to admin-group + ef-QuickSight + the
 * per-report key. Data stays GLOBAL (no req.scope row filtering) — admin sees
 * ALL clients, matching the legacy data semantics.
 *
 * 60-day cap: legacy enforced it FRONTEND-only (material-list.component.ts).
 * The native build enforces it SERVER-SIDE here via the Joi custom rule
 * (registry/native spec requirement).
 */

const router = require('express').Router();
const Joi = require('joi');

const requireQuickSight = require('../../../middleware/require-quicksight');
const validate = require('../../../middleware/validate');
const { modernOk, modernError } = require('../../../utils/response');
const { streamStyledXlsx } = require('../../../utils/xlsx-styled-export');
const logger = require('../../../logger');
const s3Storage = require('../../../utils/s3-storage');
const { fileStamp, FMT } = require('../../../services/quicksight/_shared');
const { materialReport } = require('../../../services/quicksight/quicksight-material-report.service');

// Per-report QuickSight gate on every route in this sub-router.
router.use(requireQuickSight('isQuickSightMaterialReportView'));

/*
 * Inline Joi schema (kept here so the shared validator is never edited).
 *
 *   clientId : single positive integer (legacy single-select). REQUIRED.
 *   from     : start date (yyyy-mm-dd). REQUIRED.
 *   to       : end date (yyyy-mm-dd), must be >= from. REQUIRED.
 *   format   : 'xlsx' toggles the server-side export branch (optional).
 *
 * The custom rule enforces the legacy 60-day window SERVER-SIDE (legacy had it
 * client-side only). Message matches the legacy MessageDialog copy verbatim:
 *   'Date difference should be less than 60 days'.
 */
// Bare yyyy-mm-dd (matches the legacy LocalDate body fields). Kept as STRINGS
// (not Joi.date()) so we bind the exact calendar date to SQL with zero
// timezone slip — the DB DATETIME comparison is on the bound date directly.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const materialReportQuery = Joi.object({
  clientId: Joi.number().integer().positive().required(),
  from: Joi.string().pattern(DATE_ONLY).required()
    .messages({ 'string.pattern.base': 'from must be a yyyy-mm-dd date' }),
  to: Joi.string().pattern(DATE_ONLY).required()
    .messages({ 'string.pattern.base': 'to must be a yyyy-mm-dd date' }),
  format: Joi.string().valid('json', 'xlsx').default('json'),
}).custom((value, helpers) => {
  const fromMs = Date.parse(`${value.from}T00:00:00Z`);
  const toMs = Date.parse(`${value.to}T00:00:00Z`);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
    return helpers.message('Invalid date');
  }
  if (toMs < fromMs) {
    return helpers.message('to must be on or after from');
  }
  const days = (toMs - fromMs) / 86400000;
  if (days > 60) {
    return helpers.message('Date difference should be less than 60 days');
  }
  return value;
}, 'material-report date window');

/*
 * XLSX column set — 27 columns, EXACT legacy order + spelling preserved
 * (saveMaterial, JobServiceImpl.java:4397-4403). NOTE the verbatim legacy
 * typos/oddities kept on purpose:
 *   - 'PO Recieved Date'   (legacy spelling)
 *   - 'Qty /sqrft/nos'     (legacy spacing)
 * Date columns are pre-formatted as 'dd-MM-yyyy HH:mm' strings in the row
 * mapper so the on-disk cells match the legacy POI date style exactly. The
 * keys here read the pre-formatted shape produced by toXlsxRows() below.
 */
const XLSX_COLUMNS = [
  { key: 'jobId', header: 'Job Id', align: 'right', numFmt: FMT.COUNT },
  { key: 'clientRefId', header: 'Ref Id' },
  { key: 'branchDetails', header: 'Branch', width: 18 },
  { key: 'customerName', header: 'Customer Name', width: 22 },
  { key: 'address', header: 'Address', width: 30 },
  { key: 'ticketCreatedDateTime', header: 'Ticket Created On', width: 18 },
  { key: 'appointmentDateTime', header: 'Appointment On', width: 18 },
  { key: 'checkInDateTime', header: 'App CheckIn On', width: 18 },
  { key: 'appCheckoutDateTime', header: 'App checkOut Date', width: 18 },
  { key: 'estimateSentOn', header: 'Estimate Sent On', width: 18 },
  { key: 'estimateActionOn', header: 'Estimate Action On', width: 18 },
  { key: 'poUploadDate', header: 'PO Recieved Date', width: 18 },
  { key: 'checkOutDateTime', header: 'Checkout Date Time', width: 18 },
  { key: 'jobDesc', header: 'Job Desc', width: 28 },
  { key: 'serviceType', header: 'Service Type' },
  { key: 'serviceName', header: 'Element Deployed', width: 24 },
  // Quantity — real numeric magnitude → count format + teal in-cell data bar.
  { key: 'unit', header: 'Qty /sqrft/nos', align: 'right', numFmt: FMT.COUNT, dataBar: true, dataBarColor: 'FF14B8A6' },
  // Rate — per-unit rupee price (not a magnitude to bar) → rupee format only.
  { key: 'cxCharge', header: 'Rate', align: 'right', numFmt: FMT.RUPEE },
  // Total Amount — rupee magnitude → rupee format + amber in-cell data bar.
  { key: 'totalCost', header: 'Total Amount', align: 'right', numFmt: FMT.RUPEE, dataBar: true, dataBarColor: 'FFF59E0B' },
  { key: 'clientSpocName', header: 'Client SPOC', width: 20 },
  { key: 'cityName', header: 'City', width: 16 },
  { key: 'stateName', header: 'State', width: 16 },
  { key: 'zonalManager', header: 'Zonal Manager', width: 20 },
  { key: 'customProperty', header: 'Custom Property', width: 22 },
  { key: 'poImageLink', header: 'PO', width: 24 },
  { key: 'jobSheetLink', header: 'JobSheet Link', width: 24 },
  { key: 'feedbackLink', header: 'Feedback Link', width: 24 },
];

// Date keys rendered as 'dd-MM-yyyy HH:mm' strings in the export (legacy POI
// cell format). Numeric/text keys pass through unchanged.
const XLSX_DATE_KEYS = new Set([
  'ticketCreatedDateTime',
  'appointmentDateTime',
  'checkInDateTime',
  'appCheckoutDateTime',
  'estimateSentOn',
  'estimateActionOn',
  'poUploadDate',
  'checkOutDateTime',
]);

/*
 * Format a Date (or parseable date value) as 'dd-MM-yyyy HH:mm' for the xlsx
 * cells. Null/empty → '' (legacy left empty cells). The values are already
 * IST-stamped DATETIMEs in the DB, so we render the raw clock fields.
 */
function fmtXlsxDate(v) {
  if (v == null) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Project service rows into xlsx-friendly rows (date strings pre-formatted).
function toXlsxRows(rows) {
  return rows.map((r) => {
    const out = { ...r };
    for (const k of XLSX_DATE_KEYS) out[k] = fmtXlsxDate(r[k]);
    return out;
  });
}

/*
 * GET /api/admin/quicksight/material-report?clientId=&from=&to=[&format=xlsx]
 *
 * Returns completed-job material/service usage for one client within a ≤60-day
 * checkout window: one row per element-deployed line (job-level fields
 * repeated), jobs with zero elements excluded (legacy Excel parity).
 *
 * format=xlsx streams the same rows as a 27-column .xlsx download.
 */
router.get('/', validate(materialReportQuery, 'query'), async (req, res, next) => {
  try {
    // from/to are validated yyyy-mm-dd strings — bound directly to SQL.
    const { clientId, from, to } = req.query;

    const rows = await materialReport(clientId, from, to);

    if (req.query.format === 'xlsx') {
      logger.info(
        { report: 'quicksight-material-report', clientId, from, to, rows: rows.length },
        'QuickSight Material Report xlsx export',
      );

      // KPI summary — derived from the SAME rows already streamed. Each row is
      // one element-deployed line, so row count = elements; distinct jobIds =
      // jobs; unit/totalCost are summable numeric magnitudes.
      const distinctJobs = new Set(rows.map((r) => r.jobId)).size;
      const totalQuantity = rows.reduce((s, r) => s + (Number(r.unit) || 0), 0);
      const totalAmount = rows.reduce((s, r) => s + (Number(r.totalCost) || 0), 0);

      const filename = `material-report-${to}-${fileStamp()}.xlsx`;
      await streamStyledXlsx(res, filename, {
        title: 'EasyFix · Material Report',
        meta: `Client #${clientId} · ${from} → ${to} · ${rows.length} Rows`,
        sheetName: 'ClientProductDeployedList',
        kpis: [
          { label: 'Total Jobs', value: distinctJobs, accent: 'FF6366F1' },
          { label: 'Total Elements', value: rows.length, accent: 'FF0EA5E9' },
          { label: 'Total Quantity', value: totalQuantity, accent: 'FF14B8A6' },
          { label: 'Total Amount', value: totalAmount, accent: 'FFF59E0B', numFmt: FMT.RUPEE },
        ],
        columns: XLSX_COLUMNS,
        rows: toXlsxRows(rows),
        totalRow: {
          serviceName: 'Total',
          unit: totalQuantity,
          totalCost: totalAmount,
        },
        emptyMessage: 'No Material Lines Found.',
      });
      return;
    }

    return modernOk(res, rows);
  } catch (err) {
    // Map a thrown service error carrying an explicit HTTP status to a modern
    // error; otherwise defer to the global error handler.
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

/*
 * GET /api/admin/quicksight/material-report/image-url?key=<stored-image-key>
 *
 * Mints a short-TTL presigned S3 URL for one PO / JobSheet / Feedback image
 * referenced by a Material Report row. The report rows carry a stable
 * `image-url?key=...` link (built in the service via buildImageLink) whose
 * `key` is the raw `tbl_job_image.image` value — either a canonical S3 key
 * under the `JobSupportings/` prefix or a legacy bare filename.
 *
 * Resolution reuses the SAME job-image resolver the rest of the app uses
 * (s3-storage.resolveImageUrl) so prefix discipline, the legacy-filename
 * fallback, and the presign TTL stay consistent with the Job Image read
 * path. Mirrors the deep-skill `image-url` endpoint contract:
 *
 *   200 { success: true, data: { url: <presigned|local-fallback|null> } }
 *
 * Bearer-gated by the parent chain (requireAuth → admin group) + the
 * per-report QuickSight key applied above via router.use(requireQuickSight).
 * The FE fetches this with the authenticated api client, then opens the
 * returned url — it must NOT point a raw <img src=/api/...> at the proxy
 * (that 401s with no Authorization header).
 */
const imageUrlQuery = Joi.object({
  key: Joi.string().trim().min(1).required()
    .messages({ 'any.required': 'key is required', 'string.empty': 'key is required' }),
});

router.get('/image-url', validate(imageUrlQuery, 'query'), async (req, res, next) => {
  try {
    const { key } = req.query;
    const url = await s3Storage.resolveImageUrl(key);
    return modernOk(res, { url });
  } catch (err) {
    if (err && err.status) return modernError(res, err.status, err.message);
    return next(err);
  }
});

module.exports = router;
