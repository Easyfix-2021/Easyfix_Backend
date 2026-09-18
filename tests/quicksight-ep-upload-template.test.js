/*
 * QuickSight — Employee Performance: the template uploaded INSIDE the CRM.
 *
 * The guarantees that matter, worst first:
 *
 *   1. NO DATA ROWS IN THE DATA SHEETS. The upload saves every row it finds; an
 *      example left in "time champ data" would be a real person's real day.
 *   2. THE FIVE MIS SHEETS AND EVERY HEADER build_data.py REQUIRES, spelled the
 *      way it looks them up — MIS copies these sheets to and from its workbook.
 *      REQUIRED below is an independent copy of build_data.py's map (not
 *      compose.js's), so a drift in either is caught here.
 *   3. emp detail's "Team Name <Mon>" columns are the previous and current IST
 *      month, readable by build_data.py's month_of_header.
 *   4. The empty template, and the template with its own examples pasted in,
 *      pass the upload check — the file we hand out is one we accept.
 *
 * Runner: TZ=UTC node --test-reporter=spec --test-force-exit tests/quicksight-ep-upload-template.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');

const { buildUploadTemplate, UPLOAD_SHEETS } = require('../services/quicksight/employee-performance/upload-template');
const { parseUpload } = require('../services/quicksight/employee-performance/uploads.service');

// build_data.py REQUIRED (Easyfix dashboard_automation), the five uploadable sheets.
const REQUIRED = {
  'target list': ['Primary spoc', 'Target Amount', 'Daily Target', 'month'],
  'emp detail': ['EMP ID', 'EMPLOYE NAME', 'CRM CURRENT NAME', 'Row Labels', 'vertical'],
  'Secondary spoc target list': ['Name', 'Total Target', 'month'],
  'time champ data': ['Employee Id', 'Employee Name', 'Working Hours', 'Productive Hours', 'Away Hours', 'Date'],
  'ivr data record': ['Agent Name', 'Total Incoming Calls', 'Total Outgoing Calls', 'Total Missed Calls',
    'Avg Handling Time', 'Date'],
};
// build_data.py's norm() and month_of_header() (1-based month).
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october',
  'november', 'december'];
const monthOfHeader = (h) => {
  for (const w of norm(h).replace(/_/g, ' ').split(' ')) {
    const i = MONTHS.findIndex((m) => m.startsWith(w.slice(0, 3)));
    if (w.length >= 3 && i >= 0) return i + 1;
  }
  return null;
};

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

test('the workbook is Read me, the five MIS sheets in MIS order, then Example rows', async () => {
  const wb = await roundTrip(buildUploadTemplate({ now: NOW }));
  assert.deepEqual(wb.worksheets.map((ws) => ws.name),
    ['Read me', 'target list', 'emp detail', 'Secondary spoc target list', 'time champ data', 'ivr data record',
      'Example rows']);
  assert.deepEqual([...UPLOAD_SHEETS], Object.keys(REQUIRED));
});

test('every header build_data.py requires is present and highlighted; the rest are grey', async () => {
  const wb = await roundTrip(buildUploadTemplate({ now: NOW }));
  for (const [sheet, cols] of Object.entries(REQUIRED)) {
    const ws = wb.getWorksheet(sheet);
    const headers = headerRow(ws);
    const missing = cols.filter((c) => !headers.map(norm).includes(norm(c)));
    assert.deepEqual(missing, [], `"${sheet}" is missing column(s)`);
    ws.getRow(1).eachCell({ includeEmpty: false }, (cell) => {
      const required = cols.map(norm).includes(norm(cell.value))
        || (sheet === 'emp detail' && /^team name/.test(norm(cell.value)));
      assert.equal(Boolean(cell.font.bold), required, `"${sheet}" / "${cell.value}" highlight`);
      assert.equal(cell.fill.fgColor.argb, required ? 'FFFFF2CC' : 'FFF2F2F2');
      if (required) assert.ok(cell.note, `"${sheet}" / "${cell.value}" carries a note on the expected value`);
    });
  }
  // The exports paste in place: TimeChamp's and IVR's own header rows, in order.
  assert.deepEqual(headerRow(wb.getWorksheet('time champ data')), ['Employee Id', 'Employee Name', 'Team Name',
    'Department Name', 'Start Time', 'End Time', 'Total Hours', 'Working Hours', 'Productive Hours', 'Away Hours', 'Date']);
  const ivr = headerRow(wb.getWorksheet('ivr data record'));
  assert.equal(ivr.length, 30);
  assert.equal(ivr[0], 'Sl.No');
  assert.equal(ivr[29], 'Date');
});

test('the data sheets carry NO rows beyond the header — an example there would be saved as data', async () => {
  const wb = await roundTrip(buildUploadTemplate({ now: NOW }));
  for (const sheet of UPLOAD_SHEETS) {
    const extra = [];
    wb.getWorksheet(sheet).eachRow({ includeEmpty: false }, (row, n) => { if (n > 1) extra.push(n); });
    assert.deepEqual(extra, [], `"${sheet}" has data rows`);
  }
  const titles = new Set();
  wb.getWorksheet('Example rows').eachRow((row) => titles.add(String(row.getCell(1).value)));
  for (const sheet of UPLOAD_SHEETS) assert.ok(titles.has(sheet), `no example for "${sheet}"`);
});

test('emp detail has Team Name columns for the previous and current IST month', async () => {
  const teamMonths = async (now) => {
    const wb = await roundTrip(buildUploadTemplate({ now }));
    return headerRow(wb.getWorksheet('emp detail')).filter((h) => /^team name/.test(norm(h))).map(monthOfHeader);
  };
  assert.deepEqual(await teamMonths(NOW), [8, 9]);
  // 2026-08-31 19:00 UTC is already 1 September in India.
  assert.deepEqual(await teamMonths(new Date('2026-08-31T19:00:00Z')), [8, 9]);
  assert.deepEqual(await teamMonths(new Date('2027-01-10T04:00:00Z')), [12, 1], 'across the year end');
});

test('the empty template passes the upload check with nothing to save', async () => {
  const buffer = Buffer.from(await buildUploadTemplate({ now: NOW }).xlsx.writeBuffer());
  const parsed = await parseUpload(buffer, { now: NOW });
  assert.equal(parsed.blocking, false, JSON.stringify(parsed.sheets.flatMap((s) => s.errors)));
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.warnings, []);
  for (const s of parsed.sheets) {
    assert.equal(s.present, true);
    assert.equal(s.rows, 0, s.name);
  }
  assert.deepEqual(parsed.data.roster.months, ['2026-08', '2026-09']);
});

test('the template with its own example rows pasted in is accepted row for row', async () => {
  const wb = await roundTrip(buildUploadTemplate({ now: NOW }));
  const examples = wb.getWorksheet('Example rows');
  // Example rows: a heading row with the sheet name, a header row, a value row.
  examples.eachRow((row, n) => {
    const sheet = wb.getWorksheet(String(row.getCell(1).value));
    if (!sheet || n === 1) return;
    const headers = headerRow(sheet);
    examples.getRow(n + 1).eachCell({ includeEmpty: false }, (cell, col) => {
      const value = examples.getRow(n + 2).getCell(col).value;
      sheet.getRow(2).getCell(headers.indexOf(String(cell.value)) + 1).value = value;
    });
  });
  const parsed = await parseUpload(Buffer.from(await wb.xlsx.writeBuffer()), { now: NOW });
  assert.equal(parsed.blocking, false, JSON.stringify(parsed.sheets.flatMap((s) => s.errors)));
  for (const s of parsed.sheets) assert.equal(s.rows, 1, `${s.name} example row`);
  assert.equal(parsed.data.timechamp.rows[0].date, '2026-09-02');
  assert.equal(parsed.data.primary.rows[0].month, '2026-09');
  assert.deepEqual({ ...parsed.data.roster.rows[0].teams }, { '2026-08': 'Sample Team', '2026-09': 'Sample Team' });
});
