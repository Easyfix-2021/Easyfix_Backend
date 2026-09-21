/*
 * QuickSight — Employee Performance: the downloadable Excel template.
 *
 * MIS fills this workbook and runs update_dashboard.bat (build_data.py) on it,
 * so the guarantees that matter, worst first:
 *
 *   1. NO DATA ROWS IN THE DATA SHEETS. build_data.py counts every row; an
 *      example left in "Close order" would be a real job with real revenue.
 *   2. EVERY SHEET AND COLUMN build_data.py REQUIRES IS THERE, spelled exactly
 *      (its validate() stops the whole run on one missing header). REQUIRED
 *      below mirrors build_data.py's own map; the "Team Name <month>" column is
 *      checked the way build_data.py finds it.
 *   3. Only people who may upload can download it.
 *
 * Proven end to end outside this suite: the empty template passes
 * build_data.py's validation, and with "Example rows" pasted into the data
 * sheets it produces a data.js the upload accepts.
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.S3_BUCKET_NAME = '';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-ep-template-'));
process.env.QS_EMPLOYEE_PERFORMANCE_DIR = TMP;

const VIEW_KEY = 'isQuickSightEmployeePerformanceView';
const UPLOAD_KEY = 'isQuickSightEmployeePerformanceUpload';
const S = { perms: ['ef-QuickSight', VIEW_KEY, UPLOAD_KEY] };

const rolePath = require.resolve(path.join(__dirname, '..', 'services/role.service'));
require.cache[rolePath] = {
  id: rolePath, filename: rolePath, loaded: true,
  exports: { getEffectivePermissions: async () => ({ menuIds: [], actionPermissions: S.perms }) },
};

const ExcelJS = require('exceljs');
const express = require('express');
const { buildTemplateWorkbook } = require('../services/quicksight/employee-performance/excel-template');

// build_data.py REQUIRED (Easyfix dashboard_automation), sheet -> columns.
const REQUIRED = {
  'Open order': ['Job Id', 'Vertical Name', 'State', 'City', 'Client', 'Aging', 'Pending Due To', 'Pending Reason',
    'Zonal Manager', 'Current TX Name', 'Current TX Id', 'Primary SPOC'],
  'Close order': ['Primary SPOC', 'Total Charge', 'Margin(%)', 'Audit & Checkout Date', 'Client', 'TAT Status',
    'SDA Status', 'Zonal Manager', 'Vertical Name', 'Current TX Name', 'Current TX Id', 'A & CO by'],
  'target list': ['Primary spoc', 'Target Amount', 'Daily Target', 'month'],
  'emp detail': ['EMP ID', 'EMPLOYE NAME', 'CRM CURRENT NAME', 'Row Labels', 'vertical'],
  'Secondary spoc target list': ['Name', 'Total Target', 'month'],
  'time champ data': ['Employee Id', 'Employee Name', 'Working Hours', 'Productive Hours', 'Away Hours', 'Date'],
  'crm data': ['employee id', 'Booked', 'Scheduled', 'Audit', 'Closed', 'Cancelled', 'Date'],
  'ivr data record': ['Agent Name', 'Total Incoming Calls', 'Total Outgoing Calls', 'Total Missed Calls',
    'Avg Handling Time', 'Date'],
};
// build_data.py's norm(): trim, collapse whitespace, lower-case.
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october',
  'november', 'december'];
// build_data.py month_of_header(): some word of 3+ letters is the start of a month name.
const monthOfHeader = (h) => norm(h).replace(/_/g, ' ').split(' ')
  .map((w) => (w.length >= 3 ? MONTHS.findIndex((m) => m.startsWith(w.slice(0, 3))) : -1))
  .find((i) => i >= 0);

const headerRow = (ws) => {
  const out = [];
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell) => out.push(String(cell.value)));
  return out;
};

async function roundTrip(wb) {
  const again = new ExcelJS.Workbook();
  await again.xlsx.load(await wb.xlsx.writeBuffer());
  return again;
}

const NOW = new Date('2026-09-17T10:00:00Z');

test('every sheet and header build_data.py requires is present, spelled as it looks them up', async () => {
  const wb = await roundTrip(buildTemplateWorkbook({ now: NOW }));
  const byNorm = new Map(wb.worksheets.map((ws) => [norm(ws.name), ws]));
  for (const [sheet, cols] of Object.entries(REQUIRED)) {
    const ws = byNorm.get(norm(sheet));
    assert.ok(ws, `sheet "${sheet}" is missing`);
    const headers = new Set(headerRow(ws).map(norm));
    const missing = cols.filter((c) => !headers.has(norm(c)));
    assert.deepEqual(missing, [], `sheet "${sheet}" is missing column(s)`);
  }
  const teamCols = headerRow(byNorm.get('emp detail')).filter((h) => /^team name/.test(norm(h)));
  assert.ok(teamCols.length >= 1, 'emp detail needs a "Team Name <month>" column');
  assert.deepEqual(teamCols.map(monthOfHeader), [7, 8], 'previous and current IST month, readable by build_data.py');
});

test('the data sheets carry NO rows beyond the header — an example there would be counted as data', async () => {
  const wb = await roundTrip(buildTemplateWorkbook({ now: NOW }));
  for (const sheet of Object.keys(REQUIRED)) {
    const ws = wb.getWorksheet(sheet);
    const extra = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => { if (n > 1) extra.push(n); });
    assert.deepEqual(extra, [], `"${sheet}" has data rows`);
  }
});

test('Read me comes first and the examples sit on their own sheet, covering every data sheet', async () => {
  const wb = await roundTrip(buildTemplateWorkbook({ now: NOW }));
  assert.equal(wb.worksheets[0].name, 'Read me');
  const ex = wb.getWorksheet('Example rows');
  assert.ok(ex, 'Example rows sheet');
  const titles = new Set();
  ex.eachRow((row) => titles.add(String(row.getCell(1).value)));
  for (const sheet of Object.keys(REQUIRED)) assert.ok(titles.has(sheet), `no example for "${sheet}"`);
});

test('the job sheets keep the Manage Jobs export header row, so an export pastes in place', async () => {
  const wb = await roundTrip(buildTemplateWorkbook({ now: NOW }));
  const open = headerRow(wb.getWorksheet('Open order'));
  assert.equal(open[0], 'No.');
  assert.ok(open.includes('Remark'));
  assert.ok(open.length >= 75);
});

/* ── route ─────────────────────────────────────────────────────────────── */

let server;
let base;
before(async () => {
  const app = express();
  app.use((req, _res, next) => { req.user = { user_id: 9, user_name: 'MIS User' }; next(); });
  app.use('/api/admin/quicksight/employee-performance', require('../routes/admin/quicksight/employee-performance'));
  app.use((err, _req, res, _next) => { res.status(500).json({ success: false, error: String(err && err.message) }); });
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/api/admin/quicksight/employee-performance`;
});
after(async () => {
  if (server) await new Promise((r) => server.close(r));
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('GET /template streams the workbook to someone with the upload key', async () => {
  S.perms = ['ef-QuickSight', VIEW_KEY, UPLOAD_KEY];
  const res = await fetch(`${base}/template`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /spreadsheetml/);
  assert.match(res.headers.get('content-disposition'), /employee-performance-template\.xlsx/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
  assert.ok(wb.getWorksheet('Close order'));
});

test('GET /template is refused without the upload key, even with the view key', async () => {
  S.perms = ['ef-QuickSight', VIEW_KEY];
  const res = await fetch(`${base}/template`);
  assert.equal(res.status, 403);
  S.perms = ['ef-QuickSight', VIEW_KEY, UPLOAD_KEY];
});
