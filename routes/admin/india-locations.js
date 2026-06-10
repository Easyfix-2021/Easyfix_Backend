const router = require('express').Router();
const Joi = require('joi');
const ExcelJS = require('exceljs');

const validate = require('../../middleware/validate');
const svc = require('../../services/india-locations.service');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');

/*
 * Admin Action: Seed India Locations (2026-06-10 v2).
 *
 * Endpoints, all under /api/admin/india-locations:
 *
 *   GET  /list?page=&pageSize=                paginated current state for the modal
 *   POST /seed                                 start an async seed run; body
 *                                              `{ force?, csvUrl? }`. Seeder
 *                                              auto-fetches the public India
 *                                              pincode CSV (no file upload).
 *                                              Returns { jobId }.
 *   GET  /seed/jobs/current                    snapshot of the in-flight job (if any)
 *   GET  /seed/jobs/:jobId                     snapshot of a specific job
 *   POST /seed/jobs/:jobId/cancel              flag a running job to abort at the next
 *                                              batch boundary
 *   GET  /download                             streamed XLSX of the entire tbl_pincode
 *
 * The seeder itself lives in services/india-locations.service.js and is
 * also invoked by scripts/seed-india-locations.js. One implementation,
 * three front-doors (CLI + HTTP-sync legacy + HTTP-async job).
 *
 * Removed (2026-06-10 v2): the multer-based CSV upload + the csvPath
 * body variant — per ops UX, operators just hit "Start Seeding" and the
 * BE fetches the canonical CSV from a public URL itself. The CLI script
 * still supports csvPath via runSeed() directly.
 */

const listQuery = Joi.object({
  // 0-indexed page; matches the CRM_UI TablePagination convention.
  page:     Joi.number().integer().min(0).default(0),
  pageSize: Joi.number().integer().min(1).max(500).default(50),
  // Per-column sort (2026-06-10). Whitelist enforcement happens in the
  // service via SORT_COLUMN_MAP — Joi only does a loose string check so
  // the FE can pass any of the six known keys (pincode, location,
  // city_name, state_name, country_name, remark) without us hard-coding
  // the list in two places.
  sortBy:    Joi.string().optional(),
  sortOrder: Joi.string().valid('ASC', 'DESC').optional(),
});

router.get('/list', validate(listQuery, 'query'), async (req, res, next) => {
  try {
    const { page, pageSize, sortBy, sortOrder } = req.query;
    const result = await svc.listPincodesPaginated({
      limit:     pageSize,
      offset:    page * pageSize,
      sortBy:    sortBy || 'pincode_id',
      sortOrder: sortOrder || 'DESC',
    });
    return modernOk(res, result);
  } catch (e) { return next(e); }
});

/*
 * POST /seed/acknowledge (2026-06-10) — sets the view-baseline timestamp
 * to "now" so that the next list fetch tags every existing row as
 * 'Existing'. The modal calls this BEFORE refetching the list when the
 * operator clicks Refresh; the click sequence is acknowledge → refetch.
 * Mounted BEFORE the parametric `/seed/jobs/:jobId` route so the literal
 * segment wins.
 */
router.post('/seed/acknowledge', async (_req, res, next) => {
  try {
    const iso = await svc.setViewBaselineAt(new Date());
    return modernOk(res, { viewBaselineAt: iso }, 'Baseline acknowledged');
  } catch (e) { return next(e); }
});

/*
 * POST /seed — kick off an async seed run.
 *
 * Body shape (2026-06-10): plain JSON.
 *   `{ force?: boolean, csvUrl?: string }`
 *
 * No CSV upload required from the FE — the seeder auto-fetches the
 * canonical India pincode CSV from a public URL. Resolution order:
 *   1. `csvUrl` from request body (if provided)
 *   2. `INDIA_PINCODES_CSV_URL` env var
 *   3. Hardcoded DEFAULT_INDIA_CSV_URL (GitHub-hosted mirror)
 *
 * Returns immediately with `{ jobId, status: 'running' }`. The modal
 * polls `/seed/jobs/:jobId` for progress + final stats.
 *
 * Removed (2026-06-10): the previous multipart-upload + csvPath body
 * variants per ops UX request — operators don't want to source-pick a
 * CSV; they want one-click seeding from a free public dataset.
 * The CLI script still supports csvPath via `runSeed` directly.
 */
const seedBody = Joi.object({
  force:  Joi.boolean().optional(),
  csvUrl: Joi.string().uri().optional(),
});

router.post('/seed', validate(seedBody, 'body'), async (req, res, next) => {
  try {
    const force = req.body?.force === true;
    const csvUrl = req.body?.csvUrl || null; // service falls back to env + default

    logger.info(
      { userId: req.user?.user_id, csvUrl, force },
      'india-locations seed triggered (auto-fetch from URL)',
    );

    const jobId = svc.startSeedJob({ csvUrl, force, logger });
    return modernOk(res, { jobId, status: 'running' }, 'Seeding started');
  } catch (e) {
    if (e && e.status === 409) {
      return modernError(res, 409, e.message, { jobId: e.jobId });
    }
    if (e && e.status) return modernError(res, e.status, e.message);
    return next(e);
  }
});

/*
 * GET /seed/jobs/current — used by the modal on open to detect whether
 * a job is in flight (started from this or another tab) so it can
 * reattach and resume polling without re-uploading.
 */
/*
 * GET /seed/source-url (2026-06-10) — returns the effective CSV URL the
 * BE will fetch on the next Start Seeding click. Lets the modal surface
 * "Source: <url>" before the operator commits, so they know which open-
 * data source is about to be hit. Respects env override.
 */
router.get('/seed/source-url', async (_req, res, next) => {
  try {
    return modernOk(res, { url: svc.getEffectiveCsvUrl() });
  } catch (e) { return next(e); }
});

router.get('/seed/jobs/current', async (req, res, next) => {
  try {
    return modernOk(res, svc.getCurrentSeedJob());
  } catch (e) { return next(e); }
});

/*
 * GET /seed/last-completed (2026-06-10) — returns the snapshot of the
 * most recent successfully-completed seed run, or null if none exists.
 * Powers the "Last Seeding Details" summary panel on modal open so the
 * operator can see what the last run did without re-fetching the full
 * pincode list. Mounted BEFORE /seed/jobs/:jobId so the literal-segment
 * route wins over the param route.
 */
router.get('/seed/last-completed', async (req, res, next) => {
  try {
    const snap = await svc.getLastCompletedSeedJob();
    return modernOk(res, snap || null);
  } catch (e) { return next(e); }
});

const jobIdParam = Joi.object({
  jobId: Joi.string().guid({ version: ['uuidv4'] }).required(),
});

router.get('/seed/jobs/:jobId', validate(jobIdParam, 'params'), async (req, res, next) => {
  try {
    const snap = svc.getSeedJob(req.params.jobId);
    if (!snap) return modernError(res, 404, 'Seed job not found');
    return modernOk(res, snap);
  } catch (e) { return next(e); }
});

router.post('/seed/jobs/:jobId/cancel', validate(jobIdParam, 'params'), async (req, res, next) => {
  try {
    const snap = svc.cancelSeedJob(req.params.jobId);
    return modernOk(res, snap, 'Cancellation requested');
  } catch (e) {
    if (e && e.status) return modernError(res, e.status, e.message);
    return next(e);
  }
});

router.get('/download', async (req, res, next) => {
  try {
    res.setTimeout(120_000);

    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('India Locations');
    sheet.columns = [
      { header: 'Pincode ID',      key: 'pincode_id',     width: 12 },
      { header: 'Pincode',         key: 'pincode',        width: 10 },
      { header: 'Location',        key: 'location',       width: 28 },
      { header: 'City ID',         key: 'city_id',        width: 10 },
      { header: 'City Name',       key: 'city_name',      width: 22 },
      { header: 'State ID',        key: 'state_id',       width: 10 },
      { header: 'State Name',      key: 'state_name',     width: 22 },
      { header: 'Country ID',      key: 'country_id',     width: 10 },
      { header: 'Country Name',    key: 'country_name',   width: 16 },
      { header: 'Pincode Status',  key: 'pincode_status', width: 16 },
      { header: 'Created Date',    key: 'created_date',   width: 22 },
      { header: 'Remark',          key: 'remark',         width: 12 },
    ];
    sheet.getRow(1).font = { bold: true };

    // Stream rows in via the service's async generator so we never hold
    // all 155k rows in memory simultaneously.
    for await (const row of svc.exportAllPincodes()) {
      sheet.addRow({
        ...row,
        pincode_status: Number(row.pincode_status) === 1 ? 'Serviceable' : 'Non-Serviceable',
        created_date: row.created_date instanceof Date
          ? row.created_date
          : (row.created_date ? new Date(row.created_date) : null),
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="india-locations-${today}.xlsx"`,
    );
    // Stream the workbook bytes directly to the response — avoids
    // buffering the entire ~5-15MB XLSX in memory before flushing.
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { return next(e); }
});

module.exports = router;
