/*
 * Client XLSX import/export utilities.
 *
 * One file covers three operator-facing flows:
 *   - Client list export   → exportClientList(rows, scope)
 *   - Rate card export     → exportRateCards(client, rows)
 *   - SPOC bulk import     → parseSpocUpload(buffer) → row-result report
 *   - SPOC list report     → exportSpocList(rows)
 *
 * Exporter design:
 *   - All exporters write to an in-memory ExcelJS workbook and return
 *     a Buffer (no temp files). The route streams the buffer with
 *     proper Content-Type + Content-Disposition so the browser saves
 *     the file directly.
 *   - Header row is bolded with a light-blue fill (matches existing
 *     users-bulk export style for visual consistency).
 *   - Column widths are auto-sized to header length + a sensible cap.
 *
 * Importer design:
 *   - parseSpocUpload accepts a Buffer (multer memory storage); returns
 *     a structured row-result list — { rowNumber, status, ... } — so
 *     the route can surface per-row errors back to the UI.
 *   - Dedupe + insert happens in the route layer (it has the dup-check
 *     + TX wrapper); this service only parses + validates.
 */

const ExcelJS = require('exceljs');
const logger = require('../logger');

/* ─── Shared workbook setup ───────────────────────────────────────── */

function newWorkbook(sheetName) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'EasyFix';
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName);
  return { wb, ws };
}

function applyHeader(ws, headers) {
  ws.addRow(headers);
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = {
    type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEF2F7' },
  };
  ws.columns = headers.map((h) => ({ width: Math.max(14, Math.min(40, String(h).length + 4)) }));
}

async function toBuffer(wb) {
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/* ─── 1. Client list export ───────────────────────────────────────── */

/*
 * `rows` is the same shape returned by client.service#listClients —
 * we don't re-query, we just project. Operators get one tidy sheet.
 */
async function exportClientList(rows) {
  logger.info('Export client list to XLSX · rows=' + (rows ? rows.length : 0));
  const { wb, ws } = newWorkbook('Clients');
  // Columns mirror the UI list order (ID/Name/Email/City/Primary SPOC/
  // Secondary SPOC) + audit metadata for ops reporting.
  applyHeader(ws, [
    'Client ID', 'Client Name', 'Email', 'City',
    'Primary SPOC', 'Secondary SPOC',
    'Type', 'Reference Code', 'Booking Cut-off (hr)',
    'Collected By', 'Status',
  ]);
  const collectedByLabel = (code) => (
    code === 1 ? 'Easyfixer' :
    code === 2 ? 'Easyfix' :
    code === 3 ? 'Client' :
    code === 0 ? 'Any' : ''
  );
  for (const r of rows) {
    ws.addRow([
      r.client_id, r.client_name, r.client_email ?? '',
      r.city_name ?? '',
      r.primary_spoc?.name ?? r.primary_spoc?.user_email ?? '',
      r.secondary_spoc?.name ?? r.secondary_spoc?.user_email ?? '',
      r.client_type ?? '', r.reference_code ?? '',
      r.booking_cut_off ?? '',
      collectedByLabel(r.collected_by),
      r.client_status === 1 ? 'Active' : 'Inactive',
    ]);
  }
  logger.info('Returning client list XLSX · rows=' + rows.length);
  return toBuffer(wb);
}

/* ─── 2. Rate card export ─────────────────────────────────────────── */

async function exportRateCards(clientName, rateCards) {
  logger.info('Export rate cards to XLSX · rateCards=' + (rateCards ? rateCards.length : 0));
  const { wb, ws } = newWorkbook('Rate Cards');
  applyHeader(ws, [
    'Service Type ID', 'Service Type Name',
    'Easyfix Direct Fixed', 'Easyfix Direct Variable',
    'Overhead Fixed',       'Overhead Variable',
    'Client Fixed',         'Client Variable',
  ]);
  for (const r of rateCards) {
    ws.addRow([
      r.service_type_id, r.service_type_name ?? '',
      Number(r.easyfix_direct_fixed)    || 0,
      Number(r.easyfix_direct_variable) || 0,
      Number(r.overhead_fixed)          || 0,
      Number(r.overhead_variable)       || 0,
      Number(r.client_fixed)            || 0,
      Number(r.client_variable)         || 0,
    ]);
  }
  // A header line for client identity at the top — overwrite row 1
  // with a banner row, push real header down. Decided against this to
  // keep the file CSV-parseable; client name lives in the filename
  // instead.
  void clientName;
  logger.info('Returning rate cards XLSX · rateCards=' + rateCards.length);
  return toBuffer(wb);
}

/* ─── 3. SPOC list export (cross-client report) ───────────────────── */

async function exportSpocList(rows) {
  logger.info('Export SPOC list to XLSX · rows=' + (rows ? rows.length : 0));
  const { wb, ws } = newWorkbook('SPOC Report');
  applyHeader(ws, [
    'Client ID', 'Client Name',
    'Contact ID', 'Contact Name', 'Email', 'Phone',
    'Alt Phone', 'Designation', 'Status',
  ]);
  for (const r of rows) {
    ws.addRow([
      r.client_id, r.client_name ?? '',
      r.contact_id, r.contact_name ?? '', r.contact_email ?? '',
      r.contact_no ?? '', r.contact_alt_no ?? '',
      r.contact_desgn ?? '',
      r.status === 1 ? 'Active' : 'Inactive',
    ]);
  }
  logger.info('Returning SPOC list XLSX · rows=' + rows.length);
  return toBuffer(wb);
}

/* ─── 4. SPOC bulk-import parser ──────────────────────────────────── */

/*
 * Spec column layout (row 1 = header, data from row 2):
 *   A: Contact Name        (required)
 *   B: Email               (required, RFC-ish)
 *   C: Phone               (required, 10 digits)
 *   D: Alt Phone           (optional, 10 digits if present)
 *   E: Designation         (optional, ≤100)
 *
 * Returns:
 *   { rows: [{ rowNumber, status, payload?, errors? }] }
 *
 * Status: 'valid' (ready to insert) | 'invalid' (errors[] listed)
 *
 * The route layer takes the `valid` rows, runs them through the
 * existing dup-check + create-contact flow (one TX per row), and
 * folds the results back into the operator-visible report.
 */
async function parseSpocUpload(buffer) {
  logger.info('Parse SPOC bulk upload');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) {
    logger.warn('SPOC upload rejected · Workbook is empty');
    throw Object.assign(new Error('Workbook is empty'), { status: 400 });
  }
  const results = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return; // header
    // ExcelJS `.values` is 1-indexed for cells (index 0 reserved); we
    // slice off the leading undefined so col-letter → array-index is clean.
    const cells = Array.isArray(row.values) ? row.values.slice(1) : [];
    const [
      contactName, contactEmail, contactNo, contactAltNo, contactDesgn,
    ] = cells.map((v) => v == null ? '' : String(v).trim());
    const errors = [];
    if (!contactName) errors.push('contact name is required');
    if (!contactEmail || !/.+@.+\..+/.test(contactEmail)) errors.push('valid email required');
    const phoneClean = String(contactNo || '').replace(/\D/g, '');
    if (!/^\d{10}$/.test(phoneClean)) errors.push('phone must be 10 digits');
    const altPhoneClean = contactAltNo ? String(contactAltNo).replace(/\D/g, '') : '';
    if (altPhoneClean && !/^\d{10}$/.test(altPhoneClean)) errors.push('alt phone must be 10 digits');
    if (contactDesgn && contactDesgn.length > 100) errors.push('designation > 100 chars');
    if (errors.length > 0) {
      results.push({ rowNumber, status: 'invalid', errors });
      return;
    }
    results.push({
      rowNumber,
      status: 'valid',
      payload: {
        contactName,
        contactEmail,
        contactNo: phoneClean,
        contactAltNo: altPhoneClean || null,
        contactDesgn: contactDesgn || null,
      },
    });
  });
  logger.info('Parsed SPOC upload · rows=' + results.length);
  return { rows: results };
}

/* ─── 6. Bulk SPOC ASSIGNMENT (Primary + Secondary internal users) ── */
/* ─── 7. Bulk Monthly Revenue template + parser ──────────────────── */

/*
 * Pre-seeded XLSX template for the bulk monthly-revenue upload.
 *
 * Column layout:
 *   A: Client ID         (pre-filled, locked for reference)
 *   B: Client Name       (pre-filled, locked for reference)
 *   C: Monthly Revenue (INR)  (blank — operator fills in)
 *
 * `clients` is an array of { client_id, client_name } rows returned by
 * a targeted SELECT for the chosen clientIds.
 */
async function buildBulkMonthlyRevenueTemplate(clients = []) {
  logger.info('Build bulk monthly-revenue template · clients=' + clients.length);
  const { wb, ws } = newWorkbook('Monthly Revenue');
  applyHeader(ws, [
    'Client ID', 'Client Name (reference)', 'Monthly Revenue (INR)',
  ]);
  // Lock header cells explicitly (belt-and-suspenders — they're locked by
  // default under sheet protection, but being explicit aids code clarity).
  for (let col = 1; col <= 3; col++) {
    ws.getRow(1).getCell(col).protection = { locked: true };
  }
  for (const c of clients) {
    const row = ws.addRow([c.client_id, c.client_name ?? '', null]);
    // Shade the reference columns so operators know they're read-only.
    row.getCell(1).font = { italic: true, color: { argb: 'FF888888' } };
    row.getCell(2).font = { italic: true, color: { argb: 'FF888888' } };
    // Lock Client ID (A) and Client Name (B) — default under protection, set
    // explicitly for clarity.
    row.getCell(1).protection = { locked: true };
    row.getCell(2).protection = { locked: true };
    // UNLOCK Monthly Revenue (C) so the operator can type into it.
    row.getCell(3).protection = { locked: false };
  }
  // Enable sheet protection with an empty password. Every cell is locked by
  // default once protection is active; only column C data cells are unlocked
  // (set above). The operator can click into unlocked cells and type, but
  // cannot edit Client ID or Client Name.
  await ws.protect('', {
    selectLockedCells:   true,
    selectUnlockedCells: true,
    formatCells:         false,
    formatColumns:       false,
    formatRows:          false,
    insertRows:          false,
    insertColumns:       false,
    deleteRows:          false,
    deleteColumns:       false,
    sort:                false,
    autoFilter:          false,
  });
  return toBuffer(wb);
}

/*
 * Parse a bulk monthly-revenue upload buffer.
 *
 * Column layout (same as template):
 *   A: Client ID         (number, required, positive int)
 *   B: Client Name       (ignored — reference only)
 *   C: Monthly Revenue   (number, required, >= 0)
 *
 * Returns:
 *   { rows: [{ rowNumber, status: 'valid'|'invalid', payload?, errors? }] }
 *
 *   payload shape: { clientId, monthlyRevenue }
 */
async function parseBulkMonthlyRevenue(buffer) {
  logger.info('Parse bulk monthly-revenue upload');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) {
    logger.warn('Bulk monthly-revenue upload rejected · Workbook is empty');
    throw Object.assign(new Error('Workbook is empty'), { status: 400 });
  }
  const results = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return; // header
    const cells = Array.isArray(row.values) ? row.values.slice(1) : [];
    const [clientIdRaw, /* clientName */, revenueRaw] = cells;
    const errors = [];

    const clientId = toInt(clientIdRaw);
    if (!clientId) errors.push('Client ID is required and must be a positive integer (column A)');

    const revenueStr = revenueRaw == null ? '' : String(revenueRaw).trim();
    const revenue = Number(revenueStr);
    let validRevenue = null;
    if (revenueStr === '') {
      errors.push('Monthly Revenue is required (column C)');
    } else if (!Number.isFinite(revenue) || revenue < 0) {
      errors.push('Monthly Revenue must be a non-negative number (column C)');
    } else {
      validRevenue = revenue;
    }

    if (errors.length > 0) {
      results.push({ rowNumber, status: 'invalid', errors });
      return;
    }
    results.push({
      rowNumber,
      status: 'valid',
      payload: { clientId, monthlyRevenue: validRevenue },
    });
  });
  logger.info('Parsed bulk monthly-revenue upload · rows=' + results.length);
  return { rows: results };
}

// (Section break — old section 6 header retained for readability)


/*
 * The legacy "Upload Clients" page is actually a Primary/Secondary
 * SPOC reassignment tool. Column layout (matches legacy
 * processClientSpocExcel — cells 0, 2, 3 are read; cell 1 is the
 * human-readable client name for visual confirmation only):
 *
 *   A: Client ID         (number, required)
 *   B: Client Name       (string, optional — for human reference)
 *   C: Primary SPOC ID   (user_id, required)
 *   D: Secondary SPOC ID (user_id, required)
 *
 * Validation surfaced per row:
 *   - All three IDs must be positive ints
 *   - Primary != Secondary (legacy guard)
 *   - Errors don't stop the run — caller handles per-row report.
 *
 * Returns:
 *   { rows: [{ rowNumber, status: 'valid'|'invalid', payload?, errors? }] }
 *
 * The route layer applies the upsert to tbl_vertical_mapping in a
 * single TX per row.
 */
async function parseBulkSpocAssignment(buffer) {
  logger.info('Parse bulk SPOC assignment upload');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) {
    logger.warn('Bulk SPOC assignment upload rejected · Workbook is empty');
    throw Object.assign(new Error('Workbook is empty'), { status: 400 });
  }
  const results = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return; // header
    const cells = Array.isArray(row.values) ? row.values.slice(1) : [];
    const [clientIdRaw, _clientName, primaryRaw, secondaryRaw] = cells;
    void _clientName;
    const clientId   = toInt(clientIdRaw);
    const primaryId  = toInt(primaryRaw);
    const secondId   = toInt(secondaryRaw);
    const errors = [];
    if (!clientId)  errors.push('clientId required (column A)');
    if (!primaryId) errors.push('primary SPOC user_id required (column C)');
    if (!secondId)  errors.push('secondary SPOC user_id required (column D)');
    if (primaryId && secondId && primaryId === secondId) {
      errors.push('Primary and Secondary SPOC cannot be the same user');
    }
    if (errors.length > 0) {
      results.push({ rowNumber, status: 'invalid', errors });
      return;
    }
    results.push({
      rowNumber,
      status: 'valid',
      payload: { clientId, primaryUserId: primaryId, secondaryUserId: secondId },
    });
  });
  logger.info('Parsed bulk SPOC assignment upload · rows=' + results.length);
  return { rows: results };
}

function toInt(v) {
  if (v == null) return null;
  const n = Number(String(v).trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/*
 * Template for the bulk SPOC assignment upload.
 *
 * When `clients` is provided (array of { client_id, client_name }), each
 * client becomes a pre-seeded row with the SPOC id columns left blank.
 * This is the new pre-seeded variant used by POST /bulk-template.
 *
 * When called with no arguments (backward compat — existing
 * GET /bulk-spoc-template route), we fall back to the original example
 * row so the endpoint keeps its existing behaviour unchanged.
 */
async function buildBulkSpocAssignmentTemplate(clients) {
  logger.info('Build bulk SPOC assignment template · clients=' + (clients ? clients.length : 0));
  const { wb, ws } = newWorkbook('SPOC Assignment');
  applyHeader(ws, [
    'Client ID', 'Client Name (reference)',
    'Primary SPOC User ID', 'Secondary SPOC User ID',
  ]);
  // Lock header cells explicitly (belt-and-suspenders — locked by default under
  // sheet protection, but being explicit aids code clarity).
  for (let col = 1; col <= 4; col++) {
    ws.getRow(1).getCell(col).protection = { locked: true };
  }
  if (clients && clients.length > 0) {
    for (const c of clients) {
      const row = ws.addRow([c.client_id, c.client_name ?? '', null, null]);
      // Shade the reference columns so operators know they're read-only.
      row.getCell(1).font = { italic: true, color: { argb: 'FF888888' } };
      row.getCell(2).font = { italic: true, color: { argb: 'FF888888' } };
      // Lock Client ID (A) and Client Name (B).
      row.getCell(1).protection = { locked: true };
      row.getCell(2).protection = { locked: true };
      // UNLOCK Primary SPOC User ID (C) and Secondary SPOC User ID (D).
      row.getCell(3).protection = { locked: false };
      row.getCell(4).protection = { locked: false };
    }
  } else {
    // Backward-compat: example row (same as before)
    const exRow = ws.addRow([113, 'A10 Design (example)', 42, 17]);
    exRow.font = { italic: true, color: { argb: 'FF888888' } };
    exRow.getCell(1).protection = { locked: true };
    exRow.getCell(2).protection = { locked: true };
    exRow.getCell(3).protection = { locked: false };
    exRow.getCell(4).protection = { locked: false };
  }
  // Enable sheet protection with an empty password. Every cell is locked by
  // default once protection is active; only columns C + D data cells are
  // unlocked (set above). The operator can click into unlocked cells and type,
  // but cannot edit Client ID or Client Name.
  await ws.protect('', {
    selectLockedCells:   true,
    selectUnlockedCells: true,
    formatCells:         false,
    formatColumns:       false,
    formatRows:          false,
    insertRows:          false,
    insertColumns:       false,
    deleteRows:          false,
    deleteColumns:       false,
    sort:                false,
    autoFilter:          false,
  });
  return toBuffer(wb);
}

/* ─── 5. SPOC bulk-upload template ────────────────────────────────── */

async function buildSpocTemplate() {
  logger.info('Build SPOC bulk-upload template');
  const { wb, ws } = newWorkbook('SPOCs');
  applyHeader(ws, [
    'Contact Name', 'Email', 'Phone (10 digits)',
    'Alt Phone (optional)', 'Designation (optional)',
  ]);
  // A demo row so operators see the shape.
  ws.addRow(['Demo Contact', 'demo@example.com', '9999999999', '', 'Manager']);
  ws.getRow(2).font = { italic: true, color: { argb: 'FF888888' } };
  return toBuffer(wb);
}

module.exports = {
  exportClientList,
  exportRateCards,
  exportSpocList,
  parseSpocUpload,
  buildSpocTemplate,
  parseBulkSpocAssignment,
  buildBulkSpocAssignmentTemplate,
  buildBulkMonthlyRevenueTemplate,
  parseBulkMonthlyRevenue,
};
