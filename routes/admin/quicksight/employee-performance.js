/*
 * QuickSight report sub-router — Employee Performance (uploaded snapshot).
 *   action key : isQuickSightEmployeePerformanceView  (+ family ef-QuickSight)
 *   upload key : isQuickSightEmployeePerformanceUpload
 *   service    : services/quicksight/quicksight-employee-performance.service.js
 *
 *   GET  /api/admin/quicksight/employee-performance/meta
 *     → { dateFrom, dateTo, employeeCount, spocCount, uploadedAt,
 *         uploadedBy: { userId, name }, originalName, sizeBytes } | null
 *
 *   GET  /api/admin/quicksight/employee-performance/template   (upload key)
 *     → employee-performance-template.xlsx — the 8 sheets update_dashboard.bat
 *       reads, header-only, plus Read me and Example rows.
 *
 *   POST /api/admin/quicksight/employee-performance/upload
 *     multipart/form-data: file=<data.js | data.json, optionally gzipped>
 *     → meta (as above). Replaces the current snapshot.
 *
 * NATIVE READS — the Employee tab rebuilt in the CRM's own components. Every
 * number comes from services/quicksight/employee-performance/aggregate.js (the
 * dashboard's own aggregation, parity-tested); these routes only parse the
 * query, load the cached snapshot and call it. All are Cache-Control no-store
 * and 404 'No Employee Performance data has been uploaded yet' (details.code
 * NO_SNAPSHOT) until something is uploaded. These replaced /dashboard — the
 * composed ~6.5 MB page and its postMessage "drawn" signal — which is retired
 * and must not come back: dashboard.html now lives only as the parity fixture.
 *
 *   GET /options                                   → aggregate.buildOptions(D)
 *   GET /summary?<filters>                         → aggregate.buildSummary(D, filters)
 *   GET /open-jobs?<filters>&page&pageSize&sortBy&sortDir   → aggregate.pageOpenJobs
 *   GET /technicians?<filters>&page&pageSize&sortBy&sortDir → aggregate.pageTechnicians
 *   GET /member?<filters>&name=<CRM name>          → aggregate.memberDetail
 *                                                    (404 MEMBER_NOT_FOUND)
 *
 *   <filters>: vertical, employee (repeatable or comma-joined), zm, month
 *   (YYYY-MM | ALL), from, to (YYYY-MM-DD). `v` is the CRM's cache-buster
 *   (the snapshot's uploadedAt) and is ignored.
 *
 * The data is not in easyfix_core (targets, TimeChamp and IVR come from
 * outside), so this report is uploaded by MIS rather than queried — see the
 * service header. Uploading is its own key: whoever prepares the file is not
 * necessarily everyone who may view it.
 *
 * LIVE — the same reads over a dashboard object composed from the DATABASE
 * (open jobs, closed jobs, CRM counts) plus the Excel uploads stored in the
 * tbl_qs_ep_* tables. services/quicksight/employee-performance/live.service.js
 * builds and caches it; the numbers are still aggregate.js's. The snapshot
 * routes above stay as they are until the CRM moves over.
 *
 *   GET /live/options?from&to&month        → buildOptions(D) + meta
 *   GET /live/summary?<filters>            → buildSummary(D, filters) + meta
 *   GET /live/open-jobs?<filters>&page&pageSize&sortBy&sortDir
 *   GET /live/technicians?<filters>&page&pageSize&sortBy&sortDir
 *   GET /live/member?<filters>&name=<CRM name>   (404 MEMBER_NOT_FOUND)
 *
 *   The window (the closed jobs and CRM counts read, and D.dates) comes from
 *   from / to (YYYY-MM-DD) and month (YYYY-MM | ALL): default the current IST
 *   month 1st .. today; a month alone is that month; at most 3 months; from on
 *   or before to and not after today; a to after today is read up to today.
 *   A bad window is a 400 'Validation failed' like any other parameter. meta
 *   carries the effective window, when the jobs were read, the last upload,
 *   what is stored per source, and the Unattributed line (live.service header).
 *
 *   GET  /live/template                    (upload key) → the 5-sheet .xlsx
 *   POST /live/upload?dryRun=true|false    (upload key)
 *     multipart/form-data: file=<the filled .xlsx, max 15 MB>
 *     dryRun=true (the default) → uploads.previewUpload: the check report,
 *       nothing saved. dryRun=false → uploads.commitUpload: saved in one
 *       transaction, the live cache dropped.
 *     400 unreadable file / blocking errors (details.preview = the report) ·
 *     409 another save in progress · 503 storage not set up (details.code
 *     QS_EP_STORAGE_MISSING) until the migration has run.
 *
 *     The 15 MB below bounds the COMPRESSED upload and nothing more: an .xlsx
 *     is a zip and expands, so what the workbook costs to OPEN is capped in
 *     uploads.service.js (inspectArchive), which measures the archive before
 *     ExcelJS decompresses it and refuses an oversized one with a 400 of its
 *     own. The limit lives there, not here, because it is about the file after
 *     multer has already accepted it — and because commitUpload is reachable
 *     from anywhere, not only from this route.
 */

const router = require('express').Router();
const multer = require('multer');
const Joi = require('joi');

const requireQuickSight = require('../../../middleware/require-quicksight');
const requireAction = require('../../../middleware/require-action');
const validate = require('../../../middleware/validate');
const { modernOk, modernError } = require('../../../utils/response');
const service = require('../../../services/quicksight/quicksight-employee-performance.service');
const aggregate = require('../../../services/quicksight/employee-performance/aggregate');
const { buildTemplateWorkbook } = require('../../../services/quicksight/employee-performance/excel-template');
const live = require('../../../services/quicksight/employee-performance/live.service');
const uploads = require('../../../services/quicksight/employee-performance/uploads.service');
const { buildUploadTemplate } = require('../../../services/quicksight/employee-performance/upload-template');
const { streamWorkbook } = require('../../../utils/xlsx-styled-export');
const logger = require('../../../logger');

const ACTION_KEY = 'isQuickSightEmployeePerformanceView';
const UPLOAD_KEY = 'isQuickSightEmployeePerformanceUpload';
router.use(requireQuickSight(ACTION_KEY));

// The CRM gzips before sending (~1 MB); the cap leaves room for a browser that
// cannot and sends data.js as-is.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 60 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    if (!/\.(js|json)(\.gz)?$/i.test(file.originalname)) {
      return cb(Object.assign(new Error('Only the data.js file from update_dashboard.bat is accepted'), { status: 400 }));
    }
    cb(null, true);
  },
});

// Multer's own errors (size, field name) carry no status and would surface as 500s.
function singleFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      return modernError(res, 400, err.code === 'LIMIT_FILE_SIZE' ? 'The file is too large (max 60 MB)' : err.message);
    }
    return next(err);
  });
}

router.get('/meta', async (_req, res, next) => {
  try {
    return modernOk(res, await service.getMeta());
  } catch (err) { return next(err); }
});

const NO_DATA = 'No Employee Performance data has been uploaded yet';

// The Excel template MIS fills before running update_dashboard.bat. Same key as
// the upload: it is the first half of that same job.
router.get('/template', requireAction(UPLOAD_KEY), async (_req, res, next) => {
  try {
    return await streamWorkbook(res, 'employee-performance-template.xlsx', buildTemplateWorkbook());
  } catch (err) { return next(err); }
});

router.post('/upload', requireAction(UPLOAD_KEY), singleFile, async (req, res, next) => {
  try {
    if (!req.file) return modernError(res, 400, 'Choose the data.js file to upload');
    const meta = await service.saveSnapshot({
      buffer: req.file.buffer,
      originalName: req.file.originalname.replace(/\.gz$/i, ''),
      user: req.user,
    });
    logger.info('Employee Performance data uploaded', {
      userId: meta.uploadedBy.userId, dateFrom: meta.dateFrom, dateTo: meta.dateTo,
      employees: meta.employeeCount, bytes: meta.sizeBytes,
    });
    return modernOk(res, meta, 'Employee Performance data updated');
  } catch (err) {
    if (err.status === 400) return modernError(res, 400, err.message);
    return next(err);
  }
});

// ─── native reads ───────────────────────────────────────────────────────

const NAME_MAX = 200;
const LIST_MAX = 500;

/*
 * vertical / employee: `?employee=A&employee=B` or `?employee=A,B` (or both)
 * → a de-duplicated array. qs turns MORE THAN 20 repeats of one key into an
 * index-keyed OBJECT ({"0":…,"20":…}) instead of an array, which a plain
 * Joi.array().single() refuses — so "Select all" over many employees would
 * 400. That object is accepted here as the list it is; any other object
 * (`employee[x]=…`) is not. Names are split on ',' and trimmed: no vertical or
 * CRM name in the data carries either.
 */
const isIndexObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).every((k, i) => k === String(i));

const nameList = Joi.any().custom((value, helpers) => {
  let raw;
  if (typeof value === 'string') raw = [value];
  else if (Array.isArray(value)) raw = value;
  else if (isIndexObject(value)) raw = Object.values(value);
  if (!raw || !raw.every((x) => typeof x === 'string')) return helpers.error('any.invalid');
  const names = [...new Set(raw.flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean))];
  if (names.length > LIST_MAX || names.some((x) => x.length > NAME_MAX)) return helpers.error('any.invalid');
  return names;
}, 'repeatable or comma-joined names').messages({
  'any.invalid': `{{#label}} must be up to ${LIST_MAX} names, repeated or comma-joined`,
});

const DATE = Joi.string().pattern(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/).allow('')
  .messages({ 'string.pattern.base': '{{#label}} must be a date (YYYY-MM-DD)' });

// The dashboard's filter bar. '' and 'ALL' mean "Select All" in aggregate.js.
const FILTER_KEYS = {
  vertical: nameList,
  employee: nameList,
  zm: Joi.string().max(NAME_MAX).allow(''),
  month: Joi.string().pattern(/^(ALL|\d{4}-(0[1-9]|1[0-2]))$/).allow('')
    .messages({ 'string.pattern.base': '{{#label}} must be ALL or a month (YYYY-MM)' }),
  from: DATE,
  to: DATE,
  v: Joi.any().strip(),   // cache-buster (the snapshot's uploadedAt)
};

const withDateOrder = (schema) => schema.custom((value, helpers) => {
  if (value.from && value.to && value.from > value.to) return helpers.error('any.invalid');
  return value;
}, 'from <= to').messages({ 'any.invalid': '"from" must be on or before "to"' });

const pagingKeys = (sortKeys) => ({
  page: Joi.number().integer().min(1),
  pageSize: Joi.number().integer().min(1).max(aggregate.MAX_PAGE_SIZE),
  // '' = the default (uploaded) order.
  sortBy: Joi.string().valid(...Object.keys(sortKeys)).allow(''),
  sortDir: Joi.string().valid('asc', 'desc').allow(''),
});

const optionsQuery = Joi.object({ v: Joi.any().strip() });
const summaryQuery = withDateOrder(Joi.object(FILTER_KEYS));
const openJobsQuery = withDateOrder(Joi.object({ ...FILTER_KEYS, ...pagingKeys(aggregate.OPEN_JOB_SORT_KEYS) }));
const techniciansQuery = withDateOrder(Joi.object({ ...FILTER_KEYS, ...pagingKeys(aggregate.TECHNICIAN_SORT_KEYS) }));
// The filter bar is accepted as sent; memberDetail applies only month/from/to.
const memberQuery = withDateOrder(Joi.object({ ...FILTER_KEYS, name: Joi.string().max(NAME_MAX).required() }));

const filtersOf = (q) => ({
  verticals: q.vertical, employees: q.employee, zm: q.zm, month: q.month, from: q.from, to: q.to,
});
const pagingOf = (q) => ({ page: q.page, pageSize: q.pageSize, sortBy: q.sortBy, sortDir: q.sortDir });

// Per-employee revenue: keep every read (its 400s and 404s too) out of caches.
function noStore(_req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

// Load the snapshot (parsed once per upload by the service), 404 without one.
const fromSnapshot = (build) => async (req, res, next) => {
  try {
    const D = await service.getSnapshotD();
    if (!D) return modernError(res, 404, NO_DATA, { code: 'NO_SNAPSHOT' });
    return build(D, req, res);
  } catch (err) { return next(err); }
};

router.get('/options', noStore, validate(optionsQuery, 'query'),
  fromSnapshot((D, _req, res) => modernOk(res, aggregate.buildOptions(D))));

router.get('/summary', noStore, validate(summaryQuery, 'query'),
  fromSnapshot((D, req, res) => modernOk(res, aggregate.buildSummary(D, filtersOf(req.query)))));

router.get('/open-jobs', noStore, validate(openJobsQuery, 'query'),
  fromSnapshot((D, req, res) => modernOk(res, aggregate.pageOpenJobs(D, filtersOf(req.query), pagingOf(req.query)))));

router.get('/technicians', noStore, validate(techniciansQuery, 'query'),
  fromSnapshot((D, req, res) => modernOk(res, aggregate.pageTechnicians(D, filtersOf(req.query), pagingOf(req.query)))));

router.get('/member', noStore, validate(memberQuery, 'query'),
  fromSnapshot((D, req, res) => {
    const detail = aggregate.memberDetail(D, filtersOf(req.query), req.query.name);
    if (!detail) return modernError(res, 404, 'This person has no Employee Performance data', { code: 'MEMBER_NOT_FOUND' });
    return modernOk(res, detail);
  }));

// ─── live reads (database + stored uploads) ─────────────────────────────

const MONTH = FILTER_KEYS.month;

/*
 * The live window is validated — and DEFAULTED — here, so a bad one is the same
 * 'Validation failed' 400 as any other parameter, and from / to reach the
 * handler as the effective window (live.resolveLiveWindow).
 */
const withLiveWindow = (schema) => schema.custom((value, helpers) => {
  try {
    const w = live.resolveLiveWindow({ from: value.from, to: value.to, month: value.month });
    return { ...value, from: w.from, to: w.to };
  } catch (err) {
    if (err && err.status === 400) return helpers.message(err.message);
    throw err;
  }
}, 'live window');

const liveOptionsQuery = withLiveWindow(Joi.object({ from: DATE, to: DATE, month: MONTH, v: Joi.any().strip() }));
const liveSummaryQuery = withLiveWindow(Joi.object(FILTER_KEYS));
const liveOpenJobsQuery = withLiveWindow(Joi.object({ ...FILTER_KEYS, ...pagingKeys(aggregate.OPEN_JOB_SORT_KEYS) }));
const liveTechniciansQuery = withLiveWindow(Joi.object({ ...FILTER_KEYS, ...pagingKeys(aggregate.TECHNICIAN_SORT_KEYS) }));
const liveMemberQuery = withLiveWindow(Joi.object({ ...FILTER_KEYS, name: Joi.string().max(NAME_MAX).required() }));

// Build (or reuse) the live D for the validated window.
const fromLive = (build) => async (req, res, next) => {
  try {
    const result = await live.buildLiveD({ from: req.query.from, to: req.query.to });
    return build(result, req, res);
  } catch (err) {
    // 400 a window the service refuses, 422 more jobs than the export ceiling.
    if (err && (err.status === 400 || err.status === 422)) return modernError(res, err.status, err.message);
    return next(err);
  }
};

router.get('/live/options', noStore, validate(liveOptionsQuery, 'query'),
  fromLive(({ D, meta }, _req, res) => modernOk(res, { ...aggregate.buildOptions(D), meta })));

router.get('/live/summary', noStore, validate(liveSummaryQuery, 'query'),
  fromLive(({ D, meta }, req, res) => modernOk(res, { ...aggregate.buildSummary(D, filtersOf(req.query)), meta })));

router.get('/live/open-jobs', noStore, validate(liveOpenJobsQuery, 'query'),
  fromLive(({ D }, req, res) => modernOk(res, aggregate.pageOpenJobs(D, filtersOf(req.query), pagingOf(req.query)))));

router.get('/live/technicians', noStore, validate(liveTechniciansQuery, 'query'),
  fromLive(({ D }, req, res) => modernOk(res, aggregate.pageTechnicians(D, filtersOf(req.query), pagingOf(req.query)))));

router.get('/live/member', noStore, validate(liveMemberQuery, 'query'),
  fromLive(({ D }, req, res) => {
    const detail = aggregate.memberDetail(D, filtersOf(req.query), req.query.name);
    if (!detail) return modernError(res, 404, 'This person has no Employee Performance data', { code: 'MEMBER_NOT_FOUND' });
    return modernOk(res, detail);
  }));

// ─── live uploads (the 5 MIS sheets) ────────────────────────────────────

// The COMPRESSED .xlsx only — see the header. What it expands to when ExcelJS
// opens it is capped in uploads.service.js, which measures the zip first.
const XLSX_MAX_MB = 15;
const xlsxUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: XLSX_MAX_MB * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    if (!/\.xlsx$/i.test(file.originalname)) {
      return cb(Object.assign(new Error('Only the filled .xlsx template is accepted'), { status: 400 }));
    }
    cb(null, true);
  },
});

function singleXlsx(req, res, next) {
  xlsxUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      return modernError(res, 400, err.code === 'LIMIT_FILE_SIZE' ? `The file is too large (max ${XLSX_MAX_MB} MB)` : err.message);
    }
    if (err.status === 400) return modernError(res, 400, err.message);
    return next(err);
  });
}

// Preview unless the caller explicitly confirms: a missing flag never saves.
const liveUploadQuery = Joi.object({ dryRun: Joi.boolean().default(true), v: Joi.any().strip() });

router.get('/live/template', noStore, requireAction(UPLOAD_KEY), async (_req, res, next) => {
  try {
    return await streamWorkbook(res, 'employee-performance-upload-template.xlsx', buildUploadTemplate());
  } catch (err) { return next(err); }
});

router.post('/live/upload', noStore, requireAction(UPLOAD_KEY), validate(liveUploadQuery, 'query'), singleXlsx,
  async (req, res, next) => {
    try {
      if (!req.file) return modernError(res, 400, 'Choose the filled .xlsx template to upload');
      if (req.query.dryRun) {
        return modernOk(res, await uploads.previewUpload(req.file.buffer));
      }
      const result = await uploads.commitUpload(req.file.buffer, {
        userId: Number(req.user.user_id),
        fileName: req.file.originalname,
      });
      live.invalidateLiveCache();
      logger.info('Employee Performance uploads saved', { batchId: result.batchId, userId: req.user.user_id, ...result.saved });
      return modernOk(res, result, 'Employee Performance uploads saved');
    } catch (err) {
      if (err && err.status === 400) {
        return modernError(res, 400, err.message, err.preview ? { code: 'QS_EP_UPLOAD_BLOCKED', preview: err.preview } : undefined);
      }
      if (err && err.status === 409) return modernError(res, 409, err.message, { code: 'QS_EP_UPLOAD_BUSY' });
      if (err && err.status === 503) return modernError(res, 503, err.message, { code: err.code || 'QS_EP_STORAGE_MISSING' });
      return next(err);
    }
  });

module.exports = router;
