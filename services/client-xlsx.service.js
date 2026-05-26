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
  return toBuffer(wb);
}

/* ─── 2. Rate card export ─────────────────────────────────────────── */

async function exportRateCards(clientName, rateCards) {
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
  return toBuffer(wb);
}

/* ─── 3. SPOC list export (cross-client report) ───────────────────── */

async function exportSpocList(rows) {
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
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) {
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
  return { rows: results };
}

/* ─── 6. Bulk SPOC ASSIGNMENT (Primary + Secondary internal users) ── */

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
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) {
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
  return { rows: results };
}

function toInt(v) {
  if (v == null) return null;
  const n = Number(String(v).trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/*
 * Template for the bulk SPOC assignment upload — header + a clarifying
 * second row in muted italics so operators see the column shape at a
 * glance.
 */
async function buildBulkSpocAssignmentTemplate() {
  const { wb, ws } = newWorkbook('SPOC Assignment');
  applyHeader(ws, [
    'Client ID (number)', 'Client Name (for reference)',
    'Primary SPOC User ID', 'Secondary SPOC User ID',
  ]);
  ws.addRow([113, 'A10 Design (example)', 42, 17]);
  ws.getRow(2).font = { italic: true, color: { argb: 'FF888888' } };
  return toBuffer(wb);
}

/* ─── 5. SPOC bulk-upload template ────────────────────────────────── */

async function buildSpocTemplate() {
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
};
