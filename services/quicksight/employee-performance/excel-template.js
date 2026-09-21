/*
 * QuickSight — Employee Performance: the downloadable Excel template.
 *
 * TODAY'S FLOW. MIS fills this workbook, drops it into update_dashboard.bat's
 * input folder, runs the .bat (build_data.py), and uploads the data.js it
 * writes through the Employee tab's "Upload Data". So this template has to be
 * exactly what build_data.py accepts — the sheet names and the header names in
 * its REQUIRED map — and nothing that would change its numbers.
 *
 * WHAT IS IN IT
 *   - "Read me" first: the steps and the checks that silently change numbers.
 *   - The 8 data sheets, named exactly as build_data.py looks them up, in the
 *     order of the real MIS workbook. Row 1 carries the source export's full
 *     header row (so an export pastes in place); the columns build_data.py
 *     actually reads are highlighted, the rest are grey. NO data rows.
 *   - "Example rows": one filled row per sheet showing the value formats.
 *
 * WHY THE EXAMPLES LIVE ON THEIR OWN SHEET. build_data.py reads every row of
 * every data sheet. An example row left inside "Close order" would be counted
 * as a real job and move the revenue — so the data sheets ship header-only,
 * and the examples sit on a sheet build_data.py never opens. The example
 * people are named "Sample …" so they can never be mistaken for staff.
 *
 * Header strings are the trimmed names (the IVR export pads its own with
 * spaces; build_data.py matches names case- and space-insensitively).
 */

'use strict';

const ExcelJS = require('exceljs');

const FONT = 'Arial';
const NAVY = 'FF1F3556';
const YELLOW = 'FFFFF2CC';
const GREY = 'FFF2F2F2';
const RED = 'FFC00000';
const MUTED = 'FF666666';

// The Manage Jobs export (services/job-export.service.js EXPORT_COLUMNS), in order.
const JOB_EXPORT_HEADERS = [
  'No.', 'Job Id', 'Job Reference Id', 'Branch Details', 'Customer Name', 'Customer Address', 'Pincode', 'City',
  'State', 'Aging', 'Visit Number', 'Job Status', 'Bucket Status', 'Client', 'Client Ref Id', 'Category',
  'Client Spoc Name', 'Tier', 'Current OWNER', 'Booked By', 'Zonal Manager', 'Job Owner', 'Job Scheduled By',
  'A & CO by', 'Ticket Created Date', 'Booking Date', 'Original Appointment Date', 'Appointment Date',
  'App CheckIn Date', 'App Checkout Date', 'Audit & Checkout Date', 'Is Estimate Sent', 'Estimate Sent On',
  'Estimate Approved On', 'Estimate Rejected On', 'Estimate Status', 'Estimate TAT', 'Cancel Date',
  'Cancel/Enquiry Comment', 'Cancel/Enquiry Reason', 'Cancle By', 'Job Description', 'Job Type', 'Client Comment',
  'Current TX Name', 'Current TX Id', 'Previous TX Name', 'Previous TX Id', 'OTA', 'Pre-Defined TAT', 'TAT Status',
  'SDA Status', 'Rating', 'Customer Rating Comment', 'Total Charge', 'EF share', 'Margin(%)', 'Client Owner',
  'Pending Due To', 'Pending Reason', 'Pending Remarks', 'Ready For Billing', 'Ticket confirmation action',
  'Scheduled Before original AppointmentAppointment', 'Closed On App Hours Ago', 'Aging Slab', 'Vertical Name',
  'Primary SPOC', 'Client Secondary SPOC', 'First time scheduling date', 'First Scheduled by', 'Is Escalated',
  'First Escalated On', 'Escalation TAT', 'Remark',
];

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];

// Calendar month in IST, so the example month never flips at 18:30 UTC.
function istMonthIndex(now) {
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  return { month: ist.getUTCMonth(), year: ist.getUTCFullYear() };
}

/*
 * One entry per data sheet. `required` mirrors build_data.py's REQUIRED map
 * (plus the "Team Name <month>" columns it checks separately); tests assert
 * every one is present.
 */
function sheetSpecs(now) {
  const { month, year } = istMonthIndex(now);
  const prev = (month + 11) % 12;
  const teamCur = `Team Name ${MONTH_SHORT[month]}`;
  const teamPrev = `Team Name ${MONTH_SHORT[prev]}`;
  const ym = `${year}-${String(month + 1).padStart(2, '0')}`;
  const day = (d) => `${ym}-${String(d).padStart(2, '0')}`;

  return [
    {
      name: 'Open order',
      source: 'Manage Jobs → Bucket Status: Open · Job Status: Select All · Date Type: Ticket Created · Date Range → Export. Paste the whole export (header row included) over cell A1.',
      headers: JOB_EXPORT_HEADERS,
      required: ['Job Id', 'Vertical Name', 'State', 'City', 'Client', 'Aging', 'Pending Due To', 'Pending Reason',
        'Zonal Manager', 'Current TX Name', 'Current TX Id', 'Primary SPOC'],
      example: {
        'Job Id': 540001, 'Vertical Name': 'Furniture', State: 'Maharashtra', City: 'Pune', Client: 'Sample Client',
        Aging: 3, 'Pending Due To': 'Customer', 'Pending Reason': 'Self Assembly', 'Zonal Manager': 'Sample Zonal Manager',
        'Current TX Name': 'Sample Technician', 'Current TX Id': 11001, 'Primary SPOC': 'Sample SPOC',
      },
    },
    {
      name: 'Close order',
      source: 'Manage Jobs → Bucket Status: Closed / Completed · Job Status: Completed · Date Type: Completed · Date Range → Export. Paste the whole export (header row included) over cell A1.',
      headers: JOB_EXPORT_HEADERS,
      required: ['Primary SPOC', 'Total Charge', 'Margin(%)', 'Audit & Checkout Date', 'Client', 'TAT Status',
        'SDA Status', 'Zonal Manager', 'Vertical Name', 'Current TX Name', 'Current TX Id', 'A & CO by'],
      example: {
        'Primary SPOC': 'Sample SPOC', 'Total Charge': 3499, 'Margin(%)': 17.12,
        'Audit & Checkout Date': new Date(Date.UTC(year, month, 2, 17, 20)), Client: 'Sample Client', 'TAT Status': 1,
        'SDA Status': 1, 'Zonal Manager': 'Sample Zonal Manager', 'Vertical Name': 'Furniture',
        'Current TX Name': 'Sample Technician', 'Current TX Id': 11001, 'A & CO by': 'Sample SPOC',
      },
    },
    {
      name: 'target list',
      source: 'Monthly Primary SPOC targets, one row per SPOC per month. Month is the month NAME (e.g. August).',
      headers: ['Primary spoc', 'Target Amount', 'Daily Target', 'Vertical', 'month'],
      required: ['Primary spoc', 'Target Amount', 'Daily Target', 'month'],
      example: {
        'Primary spoc': 'Sample SPOC', 'Target Amount': 2600000, 'Daily Target': 100000, Vertical: 'Furniture',
        month: MONTH_LONG[month],
      },
    },
    {
      name: 'emp detail',
      source: 'The employee list. Every name used as Primary SPOC or A & CO by must appear here (CRM CURRENT NAME), or that person is silently left out. One "Team Name <Mon>" column per month.',
      headers: ['EMP ID', 'EMPLOYE NAME', 'CRM CURRENT NAME', 'Row Labels', 'vertical', teamPrev, teamCur],
      required: ['EMP ID', 'EMPLOYE NAME', 'CRM CURRENT NAME', 'Row Labels', 'vertical', teamCur],
      example: {
        'EMP ID': 'E200001', 'EMPLOYE NAME': 'Sample SPOC', 'CRM CURRENT NAME': 'Sample SPOC', 'Row Labels': 'Sample SPOC',
        vertical: 'Furniture', [teamPrev]: 'Sample Team', [teamCur]: 'Sample Team',
      },
    },
    {
      name: 'Secondary spoc target list',
      source: 'Monthly personal targets. Daily target = Total Target ÷ 26. Month is the month NAME.',
      headers: ['Name', 'Total Target', 'month'],
      required: ['Name', 'Total Target', 'month'],
      example: { Name: 'Sample SPOC', 'Total Target': 520000, month: MONTH_LONG[month] },
    },
    {
      name: 'time champ data',
      source: 'TimeChamp daily export, one row per person per day. Hours are DECIMAL hours (6.5), not hh:mm. Add the Date on every row.',
      headers: ['Employee Id', 'Employee Name', 'Team Name', 'Department Name', 'Start Time', 'End Time', 'Total Hours',
        'Working Hours', 'Productive Hours', 'Away Hours', 'Date'],
      required: ['Employee Id', 'Employee Name', 'Working Hours', 'Productive Hours', 'Away Hours', 'Date'],
      example: {
        'Employee Id': 'E200001', 'Employee Name': 'Sample SPOC', 'Team Name': 'Sample Team', 'Department Name': 'Operations',
        'Start Time': '09:40', 'End Time': '19:05', 'Total Hours': 9.4, 'Working Hours': 8.6, 'Productive Hours': 7.6,
        'Away Hours': 0.8, Date: day(2),
      },
    },
    {
      name: 'crm data',
      source: 'CRM activity per employee per day (Floor Discipline / Employee Productivity export). "employee id" must match EMP ID in emp detail.',
      headers: ['Employee', 'Booked', 'Scheduled', 'Audit', 'Closed', 'Revenue', 'Cancelled', 'employee id', 'Date'],
      required: ['employee id', 'Booked', 'Scheduled', 'Audit', 'Closed', 'Cancelled', 'Date'],
      example: {
        Employee: 'Sample SPOC', Booked: 4, Scheduled: 6, Audit: 2, Closed: 12, Revenue: 41000, Cancelled: 1,
        'employee id': 'E200001', Date: day(2),
      },
    },
    {
      name: 'ivr data record',
      source: 'IVR agent report, one row per agent per day. Agent Name must be the CRM CURRENT NAME. Avg Handling Time is in SECONDS. Add the Date on every row.',
      headers: ['Sl.No', 'Agent Name', 'Agent Number', 'Total Bill Secs', 'Avg Handling Time', 'Total Incoming Calls',
        'Total Outgoing Calls', 'Total IVR Calls', 'Total Failed Calls', 'Total Answered Calls', 'Total Missed Calls',
        'Answered Incoming Calls', 'Missed Incoming Calls', 'Failed Incoming Calls', 'Answered Outgoing Calls',
        'Missed Outgoing Calls', 'Failed Outgoing Calls', 'Answered IVR Calls', 'Missed IVR Calls', 'Incoming Bill Second',
        'Outgoing Bill Second', 'Total Abandoned Calls', 'Abandoned Incoming Calls', 'Abandoned Outgoing Calls',
        'Abandoned IVR Calls', 'Total Login Time', 'Total Interval', 'Agent Added On', 'Agent Status', 'Date'],
      required: ['Agent Name', 'Total Incoming Calls', 'Total Outgoing Calls', 'Total Missed Calls', 'Avg Handling Time', 'Date'],
      example: {
        'Sl.No': 1, 'Agent Name': 'Sample SPOC', 'Avg Handling Time': 256, 'Total Incoming Calls': 5,
        'Total Outgoing Calls': 141, 'Total Missed Calls': 3, Date: day(2),
      },
    },
  ];
}

const READ_ME_STEPS = [
  'Fill the 8 data sheets (Open order … ivr data record). Keep the sheet names exactly as they are.',
  'Row 1 of each sheet is the header row. Highlighted columns are the ones the dashboard reads; grey ones are ignored but may stay.',
  'Column order does not matter and extra columns are ignored. Header names must match (upper/lower case does not matter).',
  'Put the filled file in the update_dashboard folder\'s input\\ folder and double-click update_dashboard.bat.',
  'In the CRM: QuickSight → Performance → Employee → Upload Data → choose the data.js the .bat created.',
];

const READ_ME_CHECKS = [
  ['Do not copy "Example rows" into the data sheets', 'Every row in a data sheet is counted as real data. The examples live on their own sheet for that reason.'],
  ['Zonal Manager says "null"', 'Clear those cells, or a manager named "null" appears in the breakdown.'],
  ['Names missing from emp detail', 'Every Primary SPOC and A & CO by name must be a CRM CURRENT NAME in emp detail, or that revenue is dropped with no error.'],
  ['Spaces at the end of technician names', '"Ravi " and "Ravi" become two technicians.'],
  ['TAT Status / SDA Status', 'Must be 0 or 1, not percentages.'],
  ['Margin(%)', 'Percent on a 0–100 scale. "Margin (%)" with a space will not be recognised.'],
  ['Audit & Checkout Date', 'Sets the start and end of the whole dashboard — one wrong year stretches every chart.'],
  ['Hours and seconds', 'TimeChamp hours are decimal (7.5). IVR Avg Handling Time is seconds (256).'],
];

function styleHeader(cell, { required }) {
  cell.font = { name: FONT, size: 10, bold: required, color: { argb: required ? 'FF000000' : 'FF808080' } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: required ? YELLOW : GREY } };
  cell.alignment = { vertical: 'top', wrapText: true };
  cell.border = { bottom: { style: 'thin', color: { argb: 'FFBFBFBF' } } };
}

function addReadMe(wb) {
  const ws = wb.addWorksheet('Read me', { views: [{ showGridLines: false }] });
  ws.columns = [{ width: 44 }, { width: 100 }];
  const put = (row, col, value, font) => {
    const cell = ws.getCell(row, col);
    cell.value = value;
    cell.font = { name: FONT, size: 10, ...font };
    cell.alignment = { vertical: 'top', wrapText: true };
    return cell;
  };
  put(1, 1, 'Employee Performance — Excel template', { size: 16, bold: true, color: { argb: NAVY } });
  put(2, 1, 'For update_dashboard.bat. The CRM does not read this file directly: upload the data.js the .bat creates.', { color: { argb: MUTED } });

  let r = 4;
  put(r, 1, 'Steps', { size: 12, bold: true, color: { argb: NAVY } });
  READ_ME_STEPS.forEach((text, i) => {
    r += 1;
    put(r, 1, `${i + 1}.`, { bold: true });
    put(r, 2, text);
  });

  r += 2;
  put(r, 1, 'Check before running the .bat — each of these silently changes the numbers', { size: 12, bold: true, color: { argb: RED } });
  READ_ME_CHECKS.forEach(([title, why]) => {
    r += 1;
    put(r, 1, title, { bold: true });
    put(r, 2, why);
  });
  return ws;
}

function addDataSheet(wb, spec) {
  const ws = wb.addWorksheet(spec.name, { views: [{ state: 'frozen', ySplit: 1 }] });
  const required = new Set(spec.required);
  spec.headers.forEach((header, i) => {
    const cell = ws.getCell(1, i + 1);
    cell.value = header;
    styleHeader(cell, { required: required.has(header) });
    ws.getColumn(i + 1).width = Math.max(12, Math.min(header.length + 4, 30));
  });
  ws.getRow(1).height = 30;
  // Guidance past a spacer column: it stays outside any pasted export block.
  const note = ws.getCell(1, spec.headers.length + 2);
  note.value = spec.source;
  note.font = { name: FONT, size: 10, italic: true, color: { argb: RED } };
  note.alignment = { vertical: 'top', wrapText: true };
  ws.getColumn(spec.headers.length + 2).width = 70;
  return ws;
}

function addExamples(wb, specs) {
  const ws = wb.addWorksheet('Example rows', { views: [{ showGridLines: false }] });
  let r = 1;
  const title = ws.getCell(r, 1);
  title.value = 'One example row per sheet — the value formats. Do NOT copy these into the data sheets.';
  title.font = { name: FONT, size: 12, bold: true, color: { argb: RED } };
  r += 2;
  specs.forEach((spec) => {
    const heading = ws.getCell(r, 1);
    heading.value = spec.name;
    heading.font = { name: FONT, size: 11, bold: true, color: { argb: NAVY } };
    r += 1;
    const cols = spec.headers.filter((h) => Object.prototype.hasOwnProperty.call(spec.example, h));
    cols.forEach((header, i) => {
      const h = ws.getCell(r, i + 1);
      h.value = header;
      styleHeader(h, { required: spec.required.includes(header) });
      const v = ws.getCell(r + 1, i + 1);
      v.value = spec.example[header];
      v.font = { name: FONT, size: 10 };
      if (spec.example[header] instanceof Date) v.numFmt = 'yyyy-mm-dd hh:mm';
      if (ws.getColumn(i + 1).width === undefined || ws.getColumn(i + 1).width < 22) ws.getColumn(i + 1).width = 22;
    });
    r += 3;
  });
  return ws;
}

/*
 * The whole template workbook. `now` only picks the example month and the two
 * "Team Name <Mon>" columns (previous and current IST month).
 */
function buildTemplateWorkbook({ now = new Date() } = {}) {
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
  buildTemplateWorkbook,
  _internals: { sheetSpecs, JOB_EXPORT_HEADERS },
};
