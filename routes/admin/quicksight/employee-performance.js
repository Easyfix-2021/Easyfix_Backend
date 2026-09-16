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
 *   GET  /api/admin/quicksight/employee-performance/dashboard
 *     → { html } — the dashboard page with the latest snapshot inlined, for the
 *       CRM to render in a sandboxed iframe. 404 when nothing is uploaded.
 *
 *   POST /api/admin/quicksight/employee-performance/upload
 *     multipart/form-data: file=<data.js | data.json, optionally gzipped>
 *     → meta (as above). Replaces the current snapshot.
 *
 * The data is not in easyfix_core (targets, TimeChamp and IVR come from
 * outside), so this report is uploaded by MIS rather than queried — see the
 * service header. Uploading is its own key: whoever prepares the file is not
 * necessarily everyone who may view it.
 */

const router = require('express').Router();
const multer = require('multer');

const requireQuickSight = require('../../../middleware/require-quicksight');
const requireAction = require('../../../middleware/require-action');
const { modernOk, modernError } = require('../../../utils/response');
const service = require('../../../services/quicksight/quicksight-employee-performance.service');
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

router.get('/dashboard', async (_req, res, next) => {
  try {
    const html = await service.getDashboardHtml();
    if (!html) return modernError(res, 404, 'No Employee Performance data has been uploaded yet');
    // Per-employee revenue: keep it out of every intermediary cache.
    res.set('Cache-Control', 'no-store');
    return modernOk(res, { html });
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

module.exports = router;
