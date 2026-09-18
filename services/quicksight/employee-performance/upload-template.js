/*
 * QuickSight — Employee Performance: the Excel template uploaded INSIDE the CRM.
 *
 * THE FLOW (owner decision, final). Open jobs, closed jobs and the CRM counts
 * come live from the database. Everything else MIS used to paste into its
 * workbook arrives through this template: Download → fill → Upload → the CRM
 * checks every row (uploads.service.js previewUpload) → Confirm → saved
 * (commitUpload). No Python, no .bat, no data.js.
 *
 * WHAT IS IN IT
 *   - "Read me" first: the steps, what each sheet does on upload (daily
 *     replace vs monthly upsert), and the checks.
 *   - The 5 uploadable sheets, named EXACTLY as in the MIS workbook and with
 *     its header rows, so MIS can paste its own sheets in (and copy these back
 *     into its workbook). The columns build_data.py REQUIRES (compose.js
 *     REQUIRED, the one copy of that list) are highlighted and carry a note on
 *     the expected value; the rest are grey and ignored. NO data rows.
 *   - "Example rows": one filled row per sheet. Examples never sit inside a
 *     data sheet — every row there is saved as real data.
 *
 * emp detail carries "Team Name <Mon>" columns for the PREVIOUS and CURRENT
 * IST month. Their month is read by build_data.py's month_of_header rule
 * (compose.js monthOfHeader), and a sheet row is saved for every month that
 * has such a column.
 *
 * The old 8-sheet template for update_dashboard.bat (excel-template.js) is
 * separate and untouched.
 */

'use strict';

const ExcelJS = require('exceljs');

const { workbookCells } = require('./compose');
const { currentIstMonth, shiftMonth } = require('../../../utils/ist-calendar');

const FONT = 'Arial';
const NAVY = 'FF1F3556';
const YELLOW = 'FFFFF2CC';
const GREY = 'FFF2F2F2';
const RED = 'FFC00000';
const MUTED = 'FF666666';

/** The five sheets an upload carries, in the MIS workbook's order. */
const UPLOAD_SHEETS = Object.freeze([
  'target list', 'emp detail', 'Secondary spoc target list', 'time champ data', 'ivr data record',
]);

/** build_data.py's required columns for one of the five sheets. */
function requiredColumns(sheetName) {
  const hit = workbookCells.REQUIRED.find(([name]) => name === sheetName);
  if (!hit) throw new Error(`upload-template: '${sheetName}' is not a build_data.py sheet`);
  return hit[1];
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];

const monthIndex = (ym) => Number(ym.slice(5, 7)) - 1;

// The IVR export's own header row, trimmed (the export pads every header with spaces).
const IVR_HEADERS = ['Sl.No', 'Agent Name', 'Agent Number', 'Total Bill Secs', 'Avg Handling Time',
  'Total Incoming Calls', 'Total Outgoing Calls', 'Total IVR Calls', 'Total Failed Calls', 'Total Answered Calls',
  'Total Missed Calls', 'Answered Incoming Calls', 'Missed Incoming Calls', 'Failed Incoming Calls',
  'Answered Outgoing Calls', 'Missed Outgoing Calls', 'Failed Outgoing Calls', 'Answered IVR Calls',
  'Missed IVR Calls', 'Incoming Bill Second', 'Outgoing Bill Second', 'Total Abandoned Calls',
  'Abandoned Incoming Calls', 'Abandoned Outgoing Calls', 'Abandoned IVR Calls', 'Total Login Time',
  'Total Interval', 'Agent Added On', 'Agent Status', 'Date'];

/*
 * One entry per uploadable sheet: full MIS header row, the note on each
 * required header, and one example row (for "Example rows" only).
 */
function sheetSpecs(now) {
  const cur = currentIstMonth(now);
  const prev = shiftMonth(cur, -1);
  const teamPrev = `Team Name ${MONTH_SHORT[monthIndex(prev)]}`;
  const teamCur = `Team Name ${MONTH_SHORT[monthIndex(cur)]}`;
  const day = (d) => new Date(`${cur}-${String(d).padStart(2, '0')}T00:00:00.000Z`);
  const monthName = MONTH_LONG[monthIndex(cur)];

  return [
    {
      name: 'target list',
      headers: ['Primary spoc', 'Target Amount', 'Daily Target', 'Vertical', 'month'],
      notes: {
        'Primary spoc': 'The SPOC as named in emp detail: CRM CURRENT NAME, Row Labels or EMPLOYE NAME.',
        'Target Amount': 'The month\'s target in rupees, a number.',
        'Daily Target': 'The per-day target in rupees, a number (usually Target Amount ÷ 26).',
        month: 'The full month name, e.g. August.',
      },
      example: { 'Primary spoc': 'Sample SPOC', 'Target Amount': 2600000, 'Daily Target': 100000, Vertical: 'Furniture',
        month: monthName },
    },
    {
      name: 'emp detail',
      headers: ['EMP ID', 'EMPLOYE NAME', 'CRM CURRENT NAME', 'Row Labels', 'vertical', teamPrev, teamCur],
      teamHeaders: [teamPrev, teamCur],
      notes: {
        'EMP ID': 'Employee code, e.g. E200001. TimeChamp rows fall back to it when the name does not match.',
        'EMPLOYE NAME': 'Full name shown on the dashboard. Also matches TimeChamp names and target names.',
        'CRM CURRENT NAME': 'The person\'s CRM user name, exactly. Each person once per file.',
        'Row Labels': 'Another name the target lists may use for this person (optional).',
        vertical: 'The person\'s vertical. Blank or 0 = the team lead\'s vertical.',
        [teamPrev]: `Team in ${MONTH_LONG[monthIndex(prev)]}. Every "Team Name <month>" column saves the row for that month; blank = no team.`,
        [teamCur]: `Team in ${monthName}. Delete a month's column to leave that month untouched.`,
      },
      example: { 'EMP ID': 'E200001', 'EMPLOYE NAME': 'Sample Person', 'CRM CURRENT NAME': 'Sample SPOC',
        'Row Labels': 'Sample', vertical: 'Furniture', [teamPrev]: 'Sample Team', [teamCur]: 'Sample Team' },
    },
    {
      name: 'Secondary spoc target list',
      headers: ['Name', 'Total Target', 'month'],
      notes: {
        Name: 'The person as named in emp detail: CRM CURRENT NAME, Row Labels or EMPLOYE NAME.',
        'Total Target': 'The month\'s personal target in rupees, a number. Per day = Total Target ÷ 26.',
        month: 'The full month name, e.g. August.',
      },
      example: { Name: 'Sample SPOC', 'Total Target': 520000, month: monthName },
    },
    {
      name: 'time champ data',
      headers: ['Employee Id', 'Employee Name', 'Team Name', 'Department Name', 'Start Time', 'End Time',
        'Total Hours', 'Working Hours', 'Productive Hours', 'Away Hours', 'Date'],
      dateHeader: 'Date',
      notes: {
        'Employee Id': 'TimeChamp employee id, e.g. E200001.',
        'Employee Name': 'TimeChamp employee name. Matched to EMPLOYE NAME or CRM CURRENT NAME, then by EMP ID.',
        'Working Hours': 'DECIMAL hours, 0 to 24 (7.5 = seven and a half hours), not hh:mm.',
        'Productive Hours': 'DECIMAL hours, 0 to 24.',
        'Away Hours': 'DECIMAL hours, 0 to 24.',
        Date: 'The day, as a date cell. Every date in the file REPLACES that whole day — upload complete days.',
      },
      example: { 'Employee Id': 'E200001', 'Employee Name': 'Sample Person', 'Team Name': 'Sample Team',
        'Department Name': 'Operations', 'Start Time': '09:40', 'End Time': '19:05', 'Total Hours': 9.4,
        'Working Hours': 8.6, 'Productive Hours': 7.6, 'Away Hours': 0.8, Date: day(2) },
    },
    {
      name: 'ivr data record',
      headers: IVR_HEADERS,
      dateHeader: 'Date',
      notes: {
        'Agent Name': 'The agent. Matched to emp detail CRM CURRENT NAME only.',
        'Total Incoming Calls': 'Whole number, 0 or more.',
        'Total Outgoing Calls': 'Whole number, 0 or more.',
        'Total Missed Calls': 'Whole number, 0 or more.',
        'Avg Handling Time': 'SECONDS as a number (256.3), not hh:mm:ss.',
        Date: 'The day, as a date cell. Every date in the file REPLACES that whole day — upload complete days.',
      },
      example: { 'Sl.No': 1, 'Agent Name': 'Sample SPOC', 'Agent Number': '9000000000', 'Total Bill Secs': 12045,
        'Avg Handling Time': 256.3, 'Total Incoming Calls': 5, 'Total Outgoing Calls': 141, 'Total Answered Calls': 47,
        'Total Missed Calls': 3, 'Agent Status': 'Active', Date: day(2) },
    },
  ].map((spec) => ({ ...spec, required: requiredColumns(spec.name) }));
}

const READ_ME_STEPS = [
  'Fill the sheets you have data for. A sheet you have nothing for stays header-only: it changes nothing.',
  'Keep the sheet names and the header names. Upper/lower case and extra spaces do not matter, column order does not matter, extra columns are ignored.',
  'In the CRM: QuickSight → Performance → Employee → Upload Data → choose this file.',
  'The CRM checks every row and shows, per sheet, what it found. Errors (red) block the upload: fix them and upload again. Warnings (amber) are saved as they are.',
  'Confirm. Everything in the file is saved together, or nothing is.',
];

const READ_ME_SHEETS = [
  ['emp detail — MONTHLY', 'One row per person. The month comes from the "Team Name <Mon>" columns: a row is saved for EVERY month that has such a column (a blank team = on that month\'s list with no team). A person already saved for that month is updated; people not in the file stay as they are. The same CRM CURRENT NAME twice in the file is rejected.'],
  ['target list — MONTHLY', 'One row per Primary SPOC per month. Saved per (month, person): it replaces that person\'s target for that month, under whichever of their names it was saved. The same person twice for one month is rejected.'],
  ['Secondary spoc target list — MONTHLY', 'Same as target list, for personal targets (per day = Total Target ÷ 26).'],
  ['time champ data — DAILY', 'Every DATE in the file REPLACES everything saved for that date from TimeChamp. Other dates are untouched. Always upload the whole day, never one corrected row.'],
  ['ivr data record — DAILY', 'Every DATE in the file REPLACES everything saved for that date from IVR. Other dates are untouched.'],
  ['Not in this file', 'Open jobs, closed jobs and CRM data (Booked, Scheduled, Audit, Closed, Cancelled) come live from the CRM. "Open order", "Close order" and "crm data" sheets are ignored if present.'],
];

const READ_ME_CHECKS = [
  ['People not on emp detail', 'TimeChamp, IVR and target rows for someone who is not on THAT MONTH\'s emp detail are saved but hidden on the dashboard, and listed as warnings. They appear as soon as an emp detail upload adds the person.'],
  ['How names match', 'Target lists: CRM CURRENT NAME, Row Labels or EMPLOYE NAME. TimeChamp: EMPLOYE NAME or CRM CURRENT NAME, then EMP ID. IVR: CRM CURRENT NAME only.'],
  ['Month names', 'Write the full name (August, not Aug). A month name means the nearest such month: up to 8 months back or 3 months ahead.'],
  ['Dates', 'Real date cells (or text like 2026-09-15). A plain number is rejected. Dates in the future are a warning.'],
  ['Numbers', 'Hours are decimal hours from 0 to 24. Avg Handling Time is seconds. Call counts are whole numbers. Targets are numbers of 0 or more. Blank or text values are rejected.'],
  ['Do not copy "Example rows" into the data sheets', 'Every row in a data sheet is saved as real data.'],
];

function styleHeader(cell, { required }) {
  cell.font = { name: FONT, size: 10, bold: required, color: { argb: required ? 'FF000000' : 'FF808080' } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: required ? YELLOW : GREY } };
  cell.alignment = { vertical: 'top', wrapText: true };
  cell.border = { bottom: { style: 'thin', color: { argb: 'FFBFBFBF' } } };
}

function addReadMe(wb) {
  const ws = wb.addWorksheet('Read me', { views: [{ showGridLines: false }] });
  ws.columns = [{ width: 40 }, { width: 110 }];
  const put = (row, col, value, font) => {
    const cell = ws.getCell(row, col);
    cell.value = value;
    cell.font = { name: FONT, size: 10, ...font };
    cell.alignment = { vertical: 'top', wrapText: true };
  };
  put(1, 1, 'Employee Performance — upload template', { size: 16, bold: true, color: { argb: NAVY } });
  put(2, 1, 'Upload this file in the CRM. Nothing to run on your computer.', { color: { argb: MUTED } });

  let r = 4;
  const section = (title, color = NAVY) => {
    put(r, 1, title, { size: 12, bold: true, color: { argb: color } });
  };
  section('Steps');
  READ_ME_STEPS.forEach((text, i) => {
    r += 1;
    put(r, 1, `${i + 1}.`, { bold: true });
    put(r, 2, text);
  });
  r += 2;
  section('What each sheet does when uploaded');
  READ_ME_SHEETS.forEach(([title, text]) => {
    r += 1;
    put(r, 1, title, { bold: true });
    put(r, 2, text);
  });
  r += 2;
  section('Checks', RED);
  READ_ME_CHECKS.forEach(([title, text]) => {
    r += 1;
    put(r, 1, title, { bold: true });
    put(r, 2, text);
  });
}

function addDataSheet(wb, spec) {
  const ws = wb.addWorksheet(spec.name, { views: [{ state: 'frozen', ySplit: 1 }] });
  const required = new Set([...spec.required, ...(spec.teamHeaders || [])]);
  spec.headers.forEach((header, i) => {
    const cell = ws.getCell(1, i + 1);
    cell.value = header;
    styleHeader(cell, { required: required.has(header) });
    if (spec.notes[header]) cell.note = spec.notes[header];
    const column = ws.getColumn(i + 1);
    column.width = Math.max(12, Math.min(header.length + 4, 30));
    if (header === spec.dateHeader) column.numFmt = 'yyyy-mm-dd';
  });
  ws.getRow(1).height = 30;
}

function addExamples(wb, specs) {
  const ws = wb.addWorksheet('Example rows', { views: [{ showGridLines: false }] });
  const title = ws.getCell(1, 1);
  title.value = 'One example row per sheet — the value formats. Do NOT copy these into the data sheets.';
  title.font = { name: FONT, size: 12, bold: true, color: { argb: RED } };
  let r = 3;
  specs.forEach((spec) => {
    const heading = ws.getCell(r, 1);
    heading.value = spec.name;
    heading.font = { name: FONT, size: 11, bold: true, color: { argb: NAVY } };
    r += 1;
    const required = new Set([...spec.required, ...(spec.teamHeaders || [])]);
    spec.headers.filter((h) => Object.prototype.hasOwnProperty.call(spec.example, h)).forEach((header, i) => {
      const h = ws.getCell(r, i + 1);
      h.value = header;
      styleHeader(h, { required: required.has(header) });
      const v = ws.getCell(r + 1, i + 1);
      v.value = spec.example[header];
      v.font = { name: FONT, size: 10 };
      if (spec.example[header] instanceof Date) v.numFmt = 'yyyy-mm-dd';
      if (!ws.getColumn(i + 1).width || ws.getColumn(i + 1).width < 22) ws.getColumn(i + 1).width = 22;
    });
    r += 3;
  });
}

/**
 * The upload template. `now` picks the IST month for the two "Team Name <Mon>"
 * columns (previous and current) and the example dates.
 * @param {{ now?: Date }} [options]
 * @returns {ExcelJS.Workbook}
 */
function buildUploadTemplate({ now = new Date() } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'EasyFix CRM';
  wb.created = now;
  const specs = sheetSpecs(now);
  addReadMe(wb);
  specs.forEach((spec) => addDataSheet(wb, spec));
  addExamples(wb, specs);
  return wb;
}

module.exports = {
  buildUploadTemplate,
  UPLOAD_SHEETS,
};
