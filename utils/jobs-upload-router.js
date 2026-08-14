/*
 * Shared factory for the bulk-job-upload sub-router.
 *
 * Two consumers use this:
 *   routes/admin/jobs-upload.js  — clientId from req.body, actor = req.user
 *   routes/client/jobs-upload.js — clientId from req.spoc, actor = { user_id: null }
 *
 * Everything else (multer config, .xlsx template generation, file
 * parsing, bulkUpload invocation, error mapping) is identical and
 * lives here. Each consumer is a ~15-line file that injects the two
 * resolvers via createJobsUploadRouter(opts).
 *
 * Why a router factory (not a service): ~80% of this code is Express
 * plumbing — router setup, multer wiring, response formatting. A pure
 * service function would still leave both consumers duplicating that
 * plumbing. The factory returns a fully-formed Router that drops in
 * via `router.use('/jobs', require('./jobs-upload'))`.
 */
const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');

const { parseBuffer } = require('./excel-parser');
const { bulkUpload } = require('../services/job-upload.service');
const { modernOk, modernError } = require('./response');

// In-memory multer storage: buffer parsed immediately, discarded on
// request end. 10 MB limit matches the legacy SPRING_SERVLET_MULTIPART
// limit. Safe to share across consumers — multer instances are
// stateless middleware factories.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    if (!/\.xlsx?$/i.test(file.originalname)) {
      return cb(Object.assign(new Error('only .xlsx / .xls files accepted'), { status: 400 }));
    }
    cb(null, true);
  },
});

/*
 * Build the canonical 10-column .xlsx template with Excel-level data
 * validations:
 *   - Customer Mobile Number → whole-number, 10 digits (rejects text)
 *   - Type of Service        → list from a hidden vocabulary sheet
 *                              (Installation / Repair / UnInstallation)
 *   - Mode of Payment        → list from a hidden vocabulary sheet
 *                              (Free for customer / Paid by Customer)
 *
 * Excel validations are applied to rows 2..1000 so clients can paste
 * large batches without re-applying the rules.
 *
 * We use `exceljs` (not the `xlsx` library) because the SheetJS
 * community build can't reliably write dataValidation rules. The
 * parser still uses xlsx on the read side — it doesn't need to honor
 * validations, just read the cell values.
 *
 * Generic template — no client-specific data — so admin + client
 * SPOC download byte-equivalent files.
 */
async function buildTemplateBuffer() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'EasyFix';
  wb.created = new Date();

  // Main sheet — preserve legacy name "buldJobFormatSheet" (sic).
  const ws = wb.addWorksheet('buldJobFormatSheet');
  const headers = [
    'Client Reference ID',
    'Customer Name',
    'Customer Mobile Number',
    'Service Delivery Address',
    'Date of Appointment (dd-mm-yyyy)',
    'Product Quantity',
    'Mode of Payment (Free for customer / Paid by customer)',
    'Type of Service (Installation / Repair / UnInstallation)',
    'Job Description',
    'Special Comments',
  ];
  ws.addRow(headers);
  ws.getRow(1).font = { bold: true };
  ws.columns = headers.map((h) => ({
    width: Math.max(18, Math.min(40, h.length + 4)),
  }));

  // Hidden vocabulary sheets — `state = 'veryHidden'` keeps them out
  // of the unhide menu so operators can't accidentally edit the vocab
  // and break the dropdowns.
  const modeSheet = wb.addWorksheet('hidden', { state: 'veryHidden' });
  modeSheet.addRow(['Free for customer']);
  modeSheet.addRow(['Paid by Customer']);
  const typeSheet = wb.addWorksheet('hidden1', { state: 'veryHidden' });
  typeSheet.addRow(['Installation']);
  typeSheet.addRow(['Repair']);
  typeSheet.addRow(['UnInstallation']);

  for (let r = 2; r <= 1000; r++) {
    // Mobile (col C) — whole number with exactly 10 digits.
    // [1000000000, 9999999999] enforces 10-digit length (Excel has no
    // "string length" rule for numeric cells).
    ws.getCell(`C${r}`).dataValidation = {
      type: 'whole', operator: 'between',
      showErrorMessage: true, allowBlank: false,
      formulae: [1000000000, 9999999999],
      errorStyle: 'error',
      errorTitle: 'Invalid mobile',
      error: 'Customer Mobile must be a 10-digit number.',
    };
    // Mode of Payment (col G) — single-pick list.
    ws.getCell(`G${r}`).dataValidation = {
      type: 'list', allowBlank: true,
      formulae: ['=hidden!$A$1:$A$2'],
      showErrorMessage: true,
      errorStyle: 'error',
      errorTitle: 'Invalid value',
      error: 'Pick one: Free for customer / Paid by Customer.',
    };
    // Type of Service (col H) — list with informational error style so
    // operators can type a CSV ("Installation, Repair") for multi-pick.
    // BE parser whitelists each token strictly.
    ws.getCell(`H${r}`).dataValidation = {
      type: 'list', allowBlank: true,
      formulae: ['=hidden1!$A$1:$A$3'],
      showErrorMessage: true,
      errorStyle: 'information',
      errorTitle: 'Multi-select allowed',
      error: 'Pick one, or type multiple values comma-separated, e.g. "Installation, Repair".',
    };
  }

  return wb.xlsx.writeBuffer();
}

/**
 * Build an Express sub-router exposing:
 *   GET  /upload-template   → 10-column .xlsx with validations baked in
 *   POST /upload?dryRun=    → multipart .xlsx; bulk-creates Unconfirmed jobs
 *
 * @param {object} opts
 * @param {(req) => number} opts.resolveClientId
 *   Returns the client_id every row in the batch will be created
 *   against. Throw `Object.assign(new Error(msg), { status })` to
 *   reject the request with a specific HTTP status — the route maps
 *   thrown errors to modernError(res, status, message).
 * @param {(req) => {user_id: number|null}} opts.resolveActor
 *   Returns the actor object the bulkUpload service stamps onto each
 *   created row (used for `fk_created_by` audit). For admin → req.user.
 *   For SPOC → { user_id: null } (SPOCs live in tbl_client_contacts).
 *
 * @returns {express.Router}
 */
function createJobsUploadRouter({ resolveClientId, resolveActor }) {
  if (typeof resolveClientId !== 'function' || typeof resolveActor !== 'function') {
    throw new Error('createJobsUploadRouter requires resolveClientId + resolveActor functions');
  }
  const router = express.Router();

  router.get('/upload-template', async (req, res, next) => {
    try {
      const buf = await buildTemplateBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="easyfix-unconfirmed-jobs-upload-template.xlsx"');
      res.setHeader('Cache-Control', 'no-store');
      res.send(Buffer.from(buf));
    } catch (err) { next(err); }
  });

  router.post('/upload', upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) return modernError(res, 400, 'missing "file" upload');
      const dryRun = String(req.query.dryRun || '').toLowerCase() === 'true';

      let clientId;
      try {
        clientId = resolveClientId(req);
      } catch (e) {
        return modernError(res, e.status || 400, e.message);
      }
      if (!Number.isInteger(clientId) || clientId <= 0) {
        return modernError(res, 400, 'resolveClientId did not return a positive integer');
      }

      let parsed;
      try {
        parsed = parseBuffer(req.file.buffer);
      } catch (parseErr) {
        return modernError(res, 400, `could not parse xlsx: ${parseErr.message}`);
      }
      if (parsed.totalRows === 0) {
        return modernError(res, 400, 'xlsx has no data rows (expecting header in row 1, data from row 2)');
      }

      const actor = resolveActor(req);
      const report = await bulkUpload(parsed, actor, { dryRun, clientId });

      modernOk(res, report, dryRun ? 'validation complete (no rows inserted)' : 'bulk upload complete');
    } catch (e) {
      if (e.code === 'LIMIT_FILE_SIZE') return modernError(res, 400, 'file exceeds 10MB');
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  });

  return router;
}

module.exports = { createJobsUploadRouter, buildTemplateBuffer };
