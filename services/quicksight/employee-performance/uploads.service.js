/*
 * QuickSight — Employee Performance: the Excel UPLOAD and its STORAGE.
 *
 * Owner decisions (final). Open jobs, closed jobs and the CRM counts come live
 * from the database. The other five MIS sheets — "target list", "emp detail",
 * "Secondary spoc target list", "time champ data", "ivr data record" — are
 * uploaded as an .xlsx with the MIS sheet names and headers
 * (upload-template.js), checked, previewed, confirmed and stored in the
 * tbl_qs_ep_* tables (migrations/2026-09-16-create-qs-employee-performance-
 * inputs.sql, which documents every column and write rule).
 *
 *   parseUpload(buffer, { now })          the file alone: structure, cells, in-file duplicates
 *   previewUpload(buffer, { db, now })    + what is stored: who is on emp detail, overwritten dates,
 *                                           and whether the CRM knows each emp detail name (§7)
 *   commitUpload(buffer, { db, userId, fileName, now })   ONE transaction; re-previews first
 *   loadUploads({ from, to, db })         the stored rows → compose() inputs
 *
 * ─── ONE READER OF THE SHEETS: compose.js ────────────────────────────────────
 *
 * Nothing here re-implements build_data.py. Cells are read with compose.js's
 * own ports of norm / sval / to_num / to_date / month_of_header /
 * vertical_or_none (workbookCells). And WHO a row belongs to — canon_name's
 * CRM name / Row Labels / EMPLOYE NAME aliases, TimeChamp's name-then-EMP-ID
 * match, IVR's CRM-name match — is answered by running compose.js's
 * fromWorkbookSheets() over ONE month at a time (resolveMonth below):
 *
 *   - "Close order" carries one row per name to resolve; its Primary SPOC comes
 *     back canon_name'd, in order.
 *   - "time champ data" / "ivr data record" carry the rows with their ROW INDEX
 *     in Working Hours / Total Incoming Calls; the rows fromWorkbookSheets
 *     emits per employee name those indices, i.e. exactly which stored row it
 *     credited to whom. The real values are then taken from the stored row.
 *
 * So the preview's "not on emp detail" warnings and the dashboard can never
 * disagree about a person, and the parity compose.js proved carries over.
 *
 * ─── THE FILE IS MEASURED BEFORE IT IS OPENED ────────────────────────────────
 *
 * The upload route's 15 MB cap bounds the .xlsx as it arrives — the COMPRESSED
 * bytes. An .xlsx is a zip, so a file inside that cap can expand to gigabytes,
 * and ExcelJS inflates the whole workbook before any row limit below applies.
 * inspectArchive (§4) reads the zip's central directory first and refuses an
 * oversized or hostile archive with a 400 naming the limit and the size, so
 * that can never become a fatal out-of-memory nothing can catch.
 *
 * ─── PEOPLE ARE RESOLVED AT READ TIME, PER MONTH ─────────────────────────────
 *
 * Rows are stored as uploaded (names, ids). loadUploads resolves each month
 * against THAT month's stored emp detail; rows for someone not on it are kept
 * and reported in `hidden`, and attach by themselves once an emp detail upload
 * adds the person. A month with no emp detail contributes no employees,
 * targets or activity at all: it has nobody until its emp detail is uploaded
 * (owner decision 6 — live.service puts that month's jobs on Unattributed).
 *
 * ─── STORAGE NOT SET UP ──────────────────────────────────────────────────────
 *
 * previewUpload / commitUpload throw status 503 (code QS_EP_STORAGE_MISSING)
 * until the migration has run; loadUploads returns empty inputs instead.
 */

'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const ExcelJS = require('exceljs');

const { pool } = require('../../../db');
const logger = require('../../../logger');
const { fromWorkbookSheets, workbookCells } = require('./compose');
const { UPLOAD_SHEETS } = require('./upload-template');
const { currentIstMonth, todayIst, shiftMonth, monthLabel } = require('../../../utils/ist-calendar');
const { isAbsentAnswer } = require('../../../utils/schema-absent-error');
const { nameKey } = require('../../../utils/name-key');
const { withMysqlNamedLock } = require('../../mysql-named-lock.service');

const { REQUIRED, MONTH_NAMES, norm, sval, toNum, toDate, verticalOrNone, monthOfHeader } = workbookCells;

const TABLES = Object.freeze({
  batch: 'tbl_qs_ep_upload_batch',
  roster: 'tbl_qs_ep_roster',
  primary: 'tbl_qs_ep_primary_target',
  secondary: 'tbl_qs_ep_secondary_target',
  timechamp: 'tbl_qs_ep_timechamp_daily',
  ivr: 'tbl_qs_ep_ivr_daily',
});

const STORAGE_MISSING_MESSAGE = 'Employee Performance storage is not set up yet '
  + '(run migrations/2026-09-16-create-qs-employee-performance-inputs.sql)';

const [SHEET_PRIMARY, SHEET_ROSTER, SHEET_SECONDARY, SHEET_TIMECHAMP, SHEET_IVR] = UPLOAD_SHEETS;
const LIVE_SHEETS = ['Open order', 'Close order', 'crm data'];
const TEMPLATE_ONLY_SHEETS = ['Read me', 'Example rows'];

// A month NAME means the nearest such month: 8 back .. 3 ahead of the IST month.
const MONTHS_BACK = 8;
const MONTHS_AHEAD = 3;
const MAX_ROWS_PER_SHEET = 20000;
const MAX_ISSUES_LISTED = 1000;         // per sheet, per kind; the counts stay exact
const INSERT_CHUNK = 500;
const LOCK_NAME = 'qs_ep_upload';
const LEN = { name: 150, id: 32, vertical: 100, team: 150, fileName: 255 };
const MAX_INT = 2147483647;

// The CRM's own users, for the emp detail check (§7).
const CRM_USER_TABLE = 'tbl_user';
// Roles that never belong to an office employee: 19 Technician (the legacy ghost
// rows of tbl_easyfixer), 20 and 21 Client Dashboard User (CLAUDE.md's role
// model). Their names collide with real employees', so they are left out.
const NON_STAFF_ROLES = Object.freeze([19, 20, 21]);
// tbl_user.user_status: 1 active, 0 inactive, 3 admin-deleted (user.service.js).
const USER_ACTIVE = 1;

// pandas.read_excel's default NA strings: such a cell is blank to build_data.py.
const PANDAS_NA = new Set(['', '#N/A', '#N/A N/A', '#NA', '-1.#IND', '-1.#QNAN', '-NaN', '-nan', '1.#IND',
  '1.#QNAN', '<NA>', 'N/A', 'NA', 'NULL', 'NaN', 'None', 'n/a', 'nan', 'null']);

function statusError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status }, extra);
}
const storageMissing = () => statusError(503, STORAGE_MISSING_MESSAGE, { code: 'QS_EP_STORAGE_MISSING' });

const own = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);
const dict = () => Object.create(null);

/* ═══ 1. Cells: exceljs value → the pandas cell compose.js reads ═════════════ */

const pad2 = (n) => String(n).padStart(2, '0');
const EXCEL_DAY_ONE_MS = Date.UTC(1899, 11, 31);   // serial 1; below it openpyxl yields a time

/**
 * One exceljs cell as { kind, value }. kind: blank | number | text | date |
 * time | bool | error. value is what pandas.read_excel(dtype=object) holds
 * (compose.js's JSON convention: { $dt } datetime, { $time } time).
 */
function readCell(raw) {
  if (raw === null || raw === undefined) return { kind: 'blank', value: null };
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return { kind: 'blank', value: null };
    const hms = `${pad2(raw.getUTCHours())}:${pad2(raw.getUTCMinutes())}:${pad2(raw.getUTCSeconds())}`;
    if (raw.getTime() < EXCEL_DAY_ONE_MS) return { kind: 'time', value: { $time: hms } };
    return { kind: 'date', value: { $dt: `${raw.toISOString().slice(0, 10)} ${hms}` } };
  }
  if (typeof raw === 'number') return Number.isFinite(raw) ? { kind: 'number', value: raw } : { kind: 'blank', value: null };
  if (typeof raw === 'boolean') return { kind: 'bool', value: raw };
  if (typeof raw === 'string') return PANDAS_NA.has(raw) ? { kind: 'blank', value: null } : { kind: 'text', value: raw };
  if (typeof raw === 'object') {
    if (own(raw, 'error')) return { kind: 'error', value: String(raw.error) };
    if (Array.isArray(raw.richText)) return readCell(raw.richText.map((p) => p.text || '').join(''));
    if (own(raw, 'formula') || own(raw, 'sharedFormula')) return readCell(raw.result);
    if (own(raw, 'text')) return readCell(raw.text);
  }
  return { kind: 'text', value: String(raw) };
}

/* ═══ 2. Issues ══════════════════════════════════════════════════════════════ */

function newSheetReport(name) {
  return { name, present: false, rows: 0, errorCount: 0, warningCount: 0, errors: [], warnings: [] };
}

function addIssue(report, kind, row, column, message) {
  const list = kind === 'error' ? report.errors : report.warnings;
  if (kind === 'error') report.errorCount += 1;
  else report.warningCount += 1;
  if (list.length < MAX_ISSUES_LISTED) list.push({ row, column, message });
}

/* ═══ 3. Value rules ═════════════════════════════════════════════════════════ */

/** A month number → 'YYYY-MM', the nearest one in [-8, +3] months of now (IST). */
function monthForNumber(monthNumber, now) {
  const cur = currentIstMonth(now);
  for (let delta = -MONTHS_BACK; delta <= MONTHS_AHEAD; delta += 1) {
    const ym = shiftMonth(cur, delta);
    if (Number(ym.slice(5, 7)) === monthNumber) return ym;
  }
  return null;
}

/*
 * Each reader takes (cell, label, issue) where issue(message, severity) records
 * against the current row/column, and returns the value or undefined (error).
 */
function readText(cell, label, issue, max) {
  if (cell.kind === 'blank') return '';
  if (cell.kind === 'error') {
    issue(`${label} has the Excel error ${cell.value}`);
    return undefined;
  }
  const s = sval(cell.value);
  if (s.length > max) {
    issue(`${label} is longer than ${max} characters`);
    return undefined;
  }
  return s;
}

function readNumber(cell, label, issue, { min = 0, max = Number.MAX_VALUE, integer = false } = {}) {
  let v;
  if (cell.kind === 'number') {
    v = cell.value;
  } else if (cell.kind === 'text') {
    v = toNum(cell.value);
    if (!Number.isFinite(v)) {
      issue(`${label} '${cell.value}' is not a number`);
      return undefined;
    }
    issue(`${label} is a number stored as text`, 'warning');
  } else if (cell.kind === 'blank') {
    issue(`${label} is blank — enter a number (0 if none)`);
    return undefined;
  } else if (cell.kind === 'error') {
    issue(`${label} has the Excel error ${cell.value}`);
    return undefined;
  } else {
    issue(`${label} is a ${cell.kind === 'bool' ? 'TRUE/FALSE' : cell.kind} cell, not a number`);
    return undefined;
  }
  if (v < min || v > max) {
    issue(`${label} ${v} is outside ${min} to ${max === Number.MAX_VALUE ? 'any maximum' : max}`);
    return undefined;
  }
  if (integer && !Number.isInteger(v)) {
    issue(`${label} ${v} is not a whole number`);
    return undefined;
  }
  return v;
}

function readDate(cell, label, issue) {
  if (cell.kind === 'date' || cell.kind === 'text') {
    const ymd = toDate(cell.value);
    if (ymd) return ymd;
    issue(`${label} '${cell.kind === 'text' ? cell.value : cell.value.$dt}' is not a date — use a date cell or YYYY-MM-DD`);
    return undefined;
  }
  if (cell.kind === 'blank') issue(`${label} is blank`);
  else if (cell.kind === 'number') issue(`${label} is a plain number (${cell.value}), not a date — format the column as a date`);
  else if (cell.kind === 'error') issue(`${label} has the Excel error ${cell.value}`);
  else issue(`${label} is a ${cell.kind === 'bool' ? 'TRUE/FALSE' : cell.kind} cell, not a date`);
  return undefined;
}

function readMonth(cell, label, issue, now) {
  if (cell.kind === 'text') {
    const i = MONTH_NAMES.indexOf(norm(cell.value));
    if (i >= 0) return monthForNumber(i + 1, now);
    issue(`${label} '${cell.value}' is not a month name — write it in full, e.g. August`);
    return undefined;
  }
  issue(cell.kind === 'blank' ? `${label} is blank` : `${label} must be a month name such as August`);
  return undefined;
}

/* ═══ 4. parseUpload ═════════════════════════════════════════════════════════ */

const requiredOf = (sheetName) => REQUIRED.find(([n]) => n === sheetName)[1];

/**
 * Header map of one worksheet: norm(header) → column number (first wins, as
 * compose.js indexWorkbook), plus the headers in order.
 */
function readHeaders(ws) {
  const columns = new Map();
  const headers = [];
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
    const c = readCell(cell.value);
    if (c.kind === 'blank') return;
    const key = norm(c.value);
    headers.push({ col, key, text: sval(c.value) });
    if (!columns.has(key)) columns.set(key, col);
  });
  return { columns, headers };
}

/**
 * Walks one sheet's data rows. `visit(ctx)` gets { rowNumber, get(header),
 * issue(column)(message, severity), failed } for each row that is not blank in
 * every watched column; returns the report's row count.
 */
function eachDataRow(ws, report, columns, watched, visit) {
  let count = 0;
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const cells = new Map(watched.map((h) => {
      const col = columns.get(norm(h));
      return [h, readCell(col ? row.getCell(col).value : null)];
    }));
    if ([...cells.values()].every((c) => c.kind === 'blank')) return;
    count += 1;
    if (count > MAX_ROWS_PER_SHEET) {
      if (count === MAX_ROWS_PER_SHEET + 1) {
        addIssue(report, 'error', rowNumber, null, `More than ${MAX_ROWS_PER_SHEET} rows — split the file`);
      }
      return;
    }
    const ctx = {
      rowNumber,
      failed: false,
      get: (h) => cells.get(h),
      issue: (column) => (message, severity = 'error') => {
        if (severity === 'error') ctx.failed = true;
        addIssue(report, severity, rowNumber, column, message);
      },
    };
    visit(ctx);
  });
  report.rows = Math.min(count, MAX_ROWS_PER_SHEET);
}

function parseRoster(ws, report, now) {
  const { columns, headers } = readHeaders(ws);
  const teamCols = headers.filter((h) => /^team name/.test(h.key));
  const fileIssue = (message) => addIssue(report, 'error', 1, null, message);
  if (!teamCols.length) fileIssue("Sheet 'emp detail' has no 'Team Name ...' column.");
  const monthByCol = [];
  const seenMonth = new Map();
  for (const h of teamCols) {
    const m = monthOfHeader(h.text);
    if (m === null) {
      fileIssue(`Column '${h.text}' does not name a month — write e.g. 'Team Name ${MONTH_NAMES[0].slice(0, 3)}'`);
      continue;
    }
    const month = monthForNumber(m, now);
    if (seenMonth.has(month)) {
      fileIssue(`Columns '${seenMonth.get(month)}' and '${h.text}' are both ${monthLabel(month)}`);
      continue;
    }
    seenMonth.set(month, h.text);
    monthByCol.push({ col: h.col, header: h.text, month });
  }
  const required = requiredOf(SHEET_ROSTER);
  const rows = [];
  const firstRowOf = new Map();
  // Team cells are read by column number: two headers may normalise alike.
  const teamHeaders = monthByCol.map((t) => t.header);
  eachDataRow(ws, report, columns, [...required, ...teamHeaders], (ctx) => {
    const crmName = readText(ctx.get('CRM CURRENT NAME'), 'CRM CURRENT NAME', ctx.issue('CRM CURRENT NAME'), LEN.name);
    if (crmName === '') {
      ctx.issue('CRM CURRENT NAME')('CRM CURRENT NAME is blank — row skipped', 'warning');
      return;
    }
    const empId = readText(ctx.get('EMP ID'), 'EMP ID', ctx.issue('EMP ID'), LEN.id);
    const employeeName = readText(ctx.get('EMPLOYE NAME'), 'EMPLOYE NAME', ctx.issue('EMPLOYE NAME'), LEN.name);
    const rowLabels = readText(ctx.get('Row Labels'), 'Row Labels', ctx.issue('Row Labels'), LEN.name);
    const verticalCell = ctx.get('vertical');
    let vertical = null;
    if (verticalCell.kind === 'error') ctx.issue('vertical')(`vertical has the Excel error ${verticalCell.value}`);
    else vertical = verticalOrNone(verticalCell.value);
    if (vertical !== null && vertical.length > LEN.vertical) {
      ctx.issue('vertical')(`vertical is longer than ${LEN.vertical} characters`);
    }
    const teams = dict();
    for (const t of monthByCol) {
      const team = readText(ctx.get(t.header), t.header, ctx.issue(t.header), LEN.team);
      if (team === '') {
        ctx.issue(t.header)(`No team for ${monthLabel(t.month)} — saved on that month's emp detail with no team`, 'warning');
      }
      teams[t.month] = team;
    }
    if (crmName === undefined) return;
    const crmKey = norm(crmName);
    if (firstRowOf.has(crmKey)) {
      ctx.issue('CRM CURRENT NAME')(`CRM CURRENT NAME '${crmName}' is already on row ${firstRowOf.get(crmKey)} — each person once per file`);
      return;
    }
    firstRowOf.set(crmKey, ctx.rowNumber);
    if (ctx.failed) return;
    rows.push({ row: ctx.rowNumber, crmName, crmKey, empId, employeeName, rowLabels, vertical, teams });
  });
  return { rows, months: monthByCol.map((t) => t.month).sort() };
}

function parseTargets(ws, report, now, spec) {
  const { columns } = readHeaders(ws);
  const rows = [];
  const firstRowOf = new Map();
  eachDataRow(ws, report, columns, requiredOf(report.name), (ctx) => {
    const personName = readText(ctx.get(spec.name), spec.name, ctx.issue(spec.name), LEN.name);
    if (personName === '') {
      ctx.issue(spec.name)(`${spec.name} is blank — row skipped`, 'warning');
      return;
    }
    const month = readMonth(ctx.get('month'), 'month', ctx.issue('month'), now);
    const values = {};
    for (const [field, header] of spec.amounts) {
      values[field] = readNumber(ctx.get(header), header, ctx.issue(header));
    }
    if (personName === undefined || month === undefined) return;
    const rawKey = norm(personName);
    const dupKey = `${month}|${rawKey}`;
    if (firstRowOf.has(dupKey)) {
      ctx.issue(spec.name)(`'${personName}' is already on row ${firstRowOf.get(dupKey)} for ${monthLabel(month)} — one row per person per month`);
      return;
    }
    firstRowOf.set(dupKey, ctx.rowNumber);
    if (ctx.failed) return;
    rows.push({ row: ctx.rowNumber, personName, rawKey, month, ...values });
  });
  return { rows };
}

function parseDaily(ws, report, now, spec) {
  const { columns } = readHeaders(ws);
  const rows = [];
  const today = todayIst(now);
  const seen = spec.uniques.map(() => new Map());
  eachDataRow(ws, report, columns, requiredOf(report.name), (ctx) => {
    const date = readDate(ctx.get('Date'), 'Date', ctx.issue('Date'));
    const out = { row: ctx.rowNumber, date };
    for (const [field, header, max] of spec.texts) {
      const v = readText(ctx.get(header), header, ctx.issue(header), max);
      if (v === '') ctx.issue(header)(`${header} is blank`);
      out[field] = v;
    }
    for (const [field, header, rule] of spec.numbers) {
      out[field] = readNumber(ctx.get(header), header, ctx.issue(header), rule);
    }
    if (date !== undefined && date > today) ctx.issue('Date')(`Date ${date} is in the future`, 'warning');
    if (date === undefined) return;
    spec.uniques.forEach(([field, header, keyOf], i) => {
      if (!out[field]) return;
      const k = `${date}|${keyOf(out[field])}`;
      if (seen[i].has(k)) {
        ctx.issue(header)(`${header} '${out[field]}' is already on row ${seen[i].get(k)} for ${date}`);
      } else {
        seen[i].set(k, ctx.rowNumber);
      }
    });
    if (ctx.failed) return;
    rows.push(spec.finish(out));
  });
  return { rows, dates: [...new Set(rows.map((r) => r.date))].sort() };
}

const HOURS = { min: 0, max: 24 };
const CALLS = { min: 0, max: MAX_INT, integer: true };

const DAILY_SPECS = {
  [SHEET_TIMECHAMP]: {
    texts: [['employeeId', 'Employee Id', LEN.id], ['employeeName', 'Employee Name', LEN.name]],
    numbers: [['working', 'Working Hours', HOURS], ['productive', 'Productive Hours', HOURS],
      ['away', 'Away Hours', HOURS]],
    uniques: [['employeeName', 'Employee Name', norm], ['employeeId', 'Employee Id', (v) => v]],
    finish: (r) => ({ ...r, nameKey: norm(r.employeeName) }),
  },
  [SHEET_IVR]: {
    texts: [['agentName', 'Agent Name', LEN.name]],
    numbers: [['incoming', 'Total Incoming Calls', CALLS], ['outgoing', 'Total Outgoing Calls', CALLS],
      ['missed', 'Total Missed Calls', CALLS], ['aht', 'Avg Handling Time', { min: 0 }]],
    uniques: [['agentName', 'Agent Name', norm]],
    finish: (r) => ({ ...r, agentKey: norm(r.agentName) }),
  },
};

const TARGET_SPECS = {
  [SHEET_PRIMARY]: { name: 'Primary spoc', amounts: [['targetAmount', 'Target Amount'], ['dailyTarget', 'Daily Target']] },
  [SHEET_SECONDARY]: { name: 'Name', amounts: [['totalTarget', 'Total Target']] },
};

/* ── The .xlsx zip, measured before a byte of it is decompressed ──────────── */

/*
 * The upload route's multer cap (15 MB) bounds the .xlsx AS IT ARRIVES — the
 * compressed bytes — and nothing else. An .xlsx is a zip; deflate reaches about
 * 1000:1 on the repetitive XML Excel writes; and ExcelJS's wb.xlsx.load()
 * inflates every part of the archive into memory before the first row limit in
 * this file can apply. So a file comfortably inside the cap can ask Node for
 * gigabytes and take the process down with a V8 fatal out-of-memory. That is
 * not an exception — it is a process exit, which no try/catch turns into a 400,
 * and on a shared server it is not one operator's bad upload but everybody's
 * backend. The archive is therefore MEASURED before it is opened.
 *
 * A zip's CENTRAL DIRECTORY, at the end of the file, lists every entry with its
 * name, compression method and uncompressed size, so the expanded size of a
 * workbook is knowable without inflating any of it — the only order that helps,
 * since inflating is the thing that kills the process. Nothing in package.json
 * reads zips (archiver writes them; exceljs's jszip and unzipper are its own
 * transitive dependencies, and both inflate first), so the format is read by
 * hand below. The byte offsets are APPNOTE.TXT 4.3.7 (local header), 4.3.12
 * (central directory), 4.3.14/4.3.15 (ZIP64) and 4.3.16 (end of directory).
 *
 * Three passes, cheapest first:
 *
 *   1. the directory's declared sizes   free   the ordinary decompression bomb
 *   2. names, counts, methods           free   an archive Excel would not write
 *   3. a capped verification inflate    ~ms    pass 1 reads the FILE'S OWN
 *                                              numbers, and a bomb can lie
 *
 * Pass 3 is the one that has to be right: a bomb that declares 1 KB and inflates
 * to 2 GB would sail past any check that believed the header. zlib's
 * maxOutputLength makes zlib itself REFUSE to allocate past a ceiling — it
 * throws ERR_BUFFER_TOO_LARGE instead of growing the buffer — so measuring the
 * file can never become the crash the measurement exists to prevent. Every
 * entry is inflated once here, counted and thrown away; ExcelJS then inflates
 * the same streams, now known to fit.
 */

const MB = 1024 * 1024;

/*
 * The ceilings, on the DECOMPRESSED workbook.
 *
 * MAX_ROWS_PER_SHEET (20,000) over the five upload sheets is the largest file
 * this service accepts at all, and a worksheet row of seven cells is ~275 bytes
 * of sheet XML, so a workbook sitting exactly on that limit is roughly 50 MB
 * expanded, shared strings included. 120 MB is a bit over twice that: every
 * file the row limits allow still opens, and nothing else does. The workbook
 * MIS actually sends — 8 sheets, six weeks of daily TimeChamp and IVR rows —
 * expands to about 3 MB, so the real file has ~40x headroom. 60 MB for one part
 * is the same headroom again for the single biggest sheet.
 */
const MAX_UNCOMPRESSED_TOTAL = 120 * MB;
const MAX_UNCOMPRESSED_ENTRY = 60 * MB;
// The filled template is 39 entries; a workbook Excel wrote has a few dozen.
const MAX_ZIP_ENTRIES = 512;
// 7 sheets in the template, 8 in the MIS workbook. Hundreds is a parser stress
// test, not a file anybody filled in — and each one is a sheet ExcelJS builds.
const MAX_SHEET_PARTS = 64;
const MAX_ENTRY_NAME = 512;

const ZIP_SIG = Object.freeze({
  local: 0x04034b50, central: 0x02014b50, eocd: 0x06054b50, zip64Eocd: 0x06064b50, zip64Locator: 0x07064b50,
});
const EOCD_FIXED = 22;              // the end-of-central-directory record without its comment
const CENTRAL_FIXED = 46;           // one central directory header without name/extra/comment
const LOCAL_FIXED = 30;             // one local file header without name/extra
const ZIP_COMMENT_MAX = 0xffff;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
const DEFLATED = 8;
const STORED = 0;
const SHEET_PART = /^xl\/worksheets\/[^/]+\.xml$/i;

/** '3.4 MB' · '120 MB' · '812.0 KB' — the size a person can act on. */
function humanBytes(bytes) {
  const mb = bytes / MB;
  if (mb >= 1) return `${Number(mb.toFixed(mb >= 100 ? 0 : 1))} MB`;
  return `${Number((bytes / 1024).toFixed(1))} KB`;
}

/*
 * Both refusals are 400s the upload dialog shows as they are: the file is the
 * operator's to fix, and nothing here is ever a 500. `notAWorkbook` keeps the
 * wording loadWorkbook already used for a file ExcelJS could not read, so a
 * corrupt file reads the same whether this pass or ExcelJS caught it.
 */
const notAWorkbook = (reason) => statusError(400, `The file is not a readable .xlsx workbook (${reason})`);
const tooBig = (message) => statusError(400, message);

/** An 8-byte ZIP64 field as a number, refusing one too large to be exact. */
function readU64(buf, at, what) {
  const v = buf.readBigUInt64LE(at);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw notAWorkbook(`${what} is impossibly large`);
  return Number(v);
}

/**
 * The offset of the end-of-central-directory record: the LAST one whose comment
 * length reaches exactly the end of the file, scanned back over the 64 KB a
 * comment can occupy. (The signature can occur inside compressed data, so the
 * comment length is what identifies the real record.)
 */
function findEndOfCentralDirectory(buf) {
  const earliest = Math.max(0, buf.length - EOCD_FIXED - ZIP_COMMENT_MAX);
  for (let at = buf.length - EOCD_FIXED; at >= earliest; at -= 1) {
    if (buf.readUInt32LE(at) !== ZIP_SIG.eocd) continue;
    if (at + EOCD_FIXED + buf.readUInt16LE(at + 20) === buf.length) return at;
  }
  return -1;
}

/**
 * Where the central directory is and how many entries it holds. A count or an
 * offset that did not fit the 1989 record is stored as all-ones there and the
 * real value lives in the ZIP64 record the locator points at (4.3.15); ExcelJS
 * does not write ZIP64, but a workbook that came through another tool may.
 */
function readDirectoryLocation(buf) {
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) throw notAWorkbook('it has no zip end-of-central-directory record');
  let entries = buf.readUInt16LE(eocd + 10);
  let size = buf.readUInt32LE(eocd + 12);
  let offset = buf.readUInt32LE(eocd + 16);
  const locator = eocd - 20;
  if ((entries === U16_MAX || size === U32_MAX || offset === U32_MAX)
      && locator >= 0 && buf.readUInt32LE(locator) === ZIP_SIG.zip64Locator) {
    const at = readU64(buf, locator + 8, 'the ZIP64 directory offset');
    if (at < 0 || at + 56 > buf.length || buf.readUInt32LE(at) !== ZIP_SIG.zip64Eocd) {
      throw notAWorkbook('its ZIP64 end-of-central-directory record is damaged');
    }
    entries = readU64(buf, at + 32, 'the ZIP64 entry count');
    size = readU64(buf, at + 40, 'the ZIP64 directory size');
    offset = readU64(buf, at + 48, 'the ZIP64 directory offset');
  }
  if (offset + size > buf.length) throw notAWorkbook('its central directory runs past the end of the file');
  return { entries, offset, size };
}

/**
 * The ZIP64 extended information extra field (header id 0x0001) of one central
 * directory entry: 8-byte values for exactly the fields stored as all-ones, in
 * the fixed order uncompressed, compressed, local header offset. Anything else
 * in the extra area is skipped by its own length.
 */
function readZip64Extra(buf, at, length, entry) {
  const end = at + length;
  for (let p = at; p + 4 <= end; p += 4 + buf.readUInt16LE(p + 2)) {
    if (buf.readUInt16LE(p) !== 0x0001) continue;
    let v = p + 4;
    const take = (what) => {
      if (v + 8 > end) throw notAWorkbook(`its ZIP64 size record for '${entry.name}' is truncated`);
      const n = readU64(buf, v, what);
      v += 8;
      return n;
    };
    if (entry.uncompressed === U32_MAX) entry.uncompressed = take('an entry size');
    if (entry.compressed === U32_MAX) entry.compressed = take('an entry size');
    if (entry.local === U32_MAX) entry.local = take('an entry offset');
    return;
  }
  throw notAWorkbook(`'${entry.name}' claims a ZIP64 size but carries no ZIP64 record`);
}

/*
 * Nothing in this service ever writes a zip entry to disk — every part goes
 * through ExcelJS into memory — so a traversing name cannot escape anywhere
 * here today. It is still refused, for two reasons: it is proof the file was
 * not written by Excel (which emits `xl/...`, `docProps/...`, `_rels/...` and
 * nothing else), and the day any part of this pipeline does touch the disk the
 * check is already in place rather than remembered.
 */
function checkEntryName(name) {
  if (name.length === 0) throw notAWorkbook('it has an entry with no name');
  if (name.length > MAX_ENTRY_NAME) throw notAWorkbook('it has an entry with an absurdly long name');
  if (name.includes('\0')) throw notAWorkbook('it has an entry name containing a NUL byte');
  if (name.includes('\\')) throw notAWorkbook(`it has a Windows path as an entry name ('${name}')`);
  if (/^(\/|[A-Za-z]:)/.test(name)) throw notAWorkbook(`it has an absolute path as an entry name ('${name}')`);
  if (name.split('/').includes('..')) throw notAWorkbook(`it has an entry name that escapes the archive ('${name}')`);
}

/**
 * Every central directory entry as { name, method, compressed, uncompressed,
 * local }. The walk stops at the first header that is not one, and the count is
 * required to match what the end record declared: a directory that does not
 * describe itself is a file we will not reason about, and every parser
 * downstream reads these same numbers.
 */
function readCentralDirectory(buf) {
  const { entries, offset, size } = readDirectoryLocation(buf);
  if (entries > MAX_ZIP_ENTRIES) {
    throw tooBig(`The workbook has ${entries} parts inside it, more than the ${MAX_ZIP_ENTRIES} an .xlsx may hold `
      + '— this is not a file Excel wrote');
  }
  const end = offset + size;
  const out = [];
  let at = offset;
  while (at + CENTRAL_FIXED <= end && buf.readUInt32LE(at) === ZIP_SIG.central) {
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const nameAt = at + CENTRAL_FIXED;
    if (nameAt + nameLen + extraLen + commentLen > end) throw notAWorkbook('its central directory is truncated');
    const entry = {
      name: buf.toString('utf8', nameAt, nameAt + nameLen),
      flags: buf.readUInt16LE(at + 8),
      method: buf.readUInt16LE(at + 10),
      compressed: buf.readUInt32LE(at + 20),
      uncompressed: buf.readUInt32LE(at + 24),
      local: buf.readUInt32LE(at + 42),
    };
    if (entry.uncompressed === U32_MAX || entry.compressed === U32_MAX || entry.local === U32_MAX) {
      readZip64Extra(buf, nameAt + nameLen, extraLen, entry);
    }
    out.push(entry);
    at = nameAt + nameLen + extraLen + commentLen;
  }
  if (out.length !== entries) {
    throw notAWorkbook(`its central directory lists ${out.length} parts where the file declares ${entries}`);
  }
  return out;
}

/**
 * The TRUE expanded size of one entry, capped: the declared size in the
 * directory is the file's own claim about itself and a bomb's claim is a lie.
 *
 * The whole remainder of the buffer is handed to zlib rather than the declared
 * compressed length, for the same reason — a raw deflate stream ends where it
 * ends and zlib ignores what follows, so what comes back is the entry's real
 * size whatever the header says. `maxOutputLength` is the safety: zlib stops
 * and throws ERR_BUFFER_TOO_LARGE rather than allocating past `budget`, so this
 * measurement can never itself be the out-of-memory it is preventing.
 *
 * @returns {number|null} the expanded byte count, or null when it exceeds budget
 */
function inflatedSize(buf, entry, budget) {
  const head = entry.local;
  if (head < 0 || head + LOCAL_FIXED > buf.length || buf.readUInt32LE(head) !== ZIP_SIG.local) {
    throw notAWorkbook(`'${entry.name}' has no local header where the directory says it does`);
  }
  const dataAt = head + LOCAL_FIXED + buf.readUInt16LE(head + 26) + buf.readUInt16LE(head + 28);
  if (dataAt > buf.length) throw notAWorkbook(`'${entry.name}' starts past the end of the file`);
  // Stored: the bytes are their own expansion, bounded by what the file holds.
  if (entry.method === STORED) return Math.min(entry.compressed, buf.length - dataAt);
  try {
    return zlib.inflateRawSync(buf.subarray(dataAt), { maxOutputLength: Math.max(budget, 1) }).length;
  } catch (err) {
    if (err && err.code === 'ERR_BUFFER_TOO_LARGE') return null;
    throw notAWorkbook(`'${entry.name}' is not readable (${err.message})`);
  }
}

/**
 * Refuse an oversized or hostile .xlsx BEFORE ExcelJS decompresses it. Throws a
 * 400 naming the limit and the size; returns the measurement otherwise.
 *
 * @returns {{ entries: number, sheetParts: number, declaredBytes: number, expandedBytes: number }}
 * @throws 400 too large to open · 400 not a zip an .xlsx could be
 */
function inspectArchive(buffer) {
  if (buffer.length < EOCD_FIXED) throw notAWorkbook('it is too short to be a zip');
  const entries = readCentralDirectory(buffer);

  // Pass 1 — the declared sizes. An honest bomb is refused here, for free, and
  // the operator gets the real numbers back because the file told us them.
  let declaredBytes = 0;
  let sheetParts = 0;
  for (const e of entries) {
    checkEntryName(e.name);
    // Bit 0 of the general purpose flags: the entry is encrypted (4.4.4).
    if (e.flags & 0x1) throw notAWorkbook('it is password protected — save it without a password and upload again');
    if (e.method !== STORED && e.method !== DEFLATED) {
      throw notAWorkbook(`'${e.name}' uses compression method ${e.method}, which Excel does not write`);
    }
    if (e.uncompressed > MAX_UNCOMPRESSED_ENTRY) {
      throw tooBig(`Part '${e.name}' of the workbook expands to ${humanBytes(e.uncompressed)}, more than the `
        + `${humanBytes(MAX_UNCOMPRESSED_ENTRY)} one sheet may use — split the file into smaller uploads`);
    }
    declaredBytes += e.uncompressed;
    if (SHEET_PART.test(e.name)) sheetParts += 1;
  }
  if (declaredBytes > MAX_UNCOMPRESSED_TOTAL) {
    throw tooBig(`The workbook expands to ${humanBytes(declaredBytes)} when opened, more than the `
      + `${humanBytes(MAX_UNCOMPRESSED_TOTAL)} this upload allows — delete the sheets and rows it does not `
      + 'need, or split the file into smaller uploads');
  }

  // Pass 2 — the counts. Every sheet is one ExcelJS builds in memory whether
  // this upload reads it or not, so hundreds of them are refused before that.
  if (sheetParts > MAX_SHEET_PARTS) {
    throw tooBig(`The workbook has ${sheetParts} sheets, more than the ${MAX_SHEET_PARTS} this upload allows `
      + `— upload the filled template, which has ${UPLOAD_SHEETS.length + TEMPLATE_ONLY_SHEETS.length}`);
  }

  // Pass 3 — inflate every entry once, capped, and count what actually comes
  // out. This is what stands between a LYING header and the process. Getting
  // here at all means pass 1 was satisfied, so the refusal below says only what
  // the two passes together prove: the archive expands past the ceiling AND its
  // own size records said it would not, whichever entry happened to run us out.
  let expandedBytes = 0;
  for (const e of entries) {
    const budget = Math.min(MAX_UNCOMPRESSED_ENTRY, MAX_UNCOMPRESSED_TOTAL - expandedBytes);
    const actual = inflatedSize(buffer, e, budget);
    if (actual === null) {
      throw tooBig(`The workbook expands past the ${humanBytes(MAX_UNCOMPRESSED_TOTAL)} this upload allows when `
        + `opened — bigger than the ${humanBytes(declaredBytes)} its own size records claim, so they cannot be `
        + `trusted (stopped at part '${e.name}')`);
    }
    expandedBytes += actual;
  }
  return { entries: entries.length, sheetParts, declaredBytes, expandedBytes };
}

async function loadWorkbook(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw statusError(400, 'Choose the filled .xlsx template to upload');
  inspectArchive(buffer);
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch (err) {
    throw statusError(400, `The file is not a readable .xlsx workbook (${err.message})`);
  }
  return wb;
}

/**
 * The uploaded file on its own — no database. Every sheet and column the
 * upload needs, every cell rule, and duplicate keys inside the file.
 *
 * @returns {Promise<{
 *   fileSha256: string, blocking: boolean,
 *   errors: string[], warnings: string[],               // file level
 *   sheets: [{ name, present, rows, errorCount, warningCount,
 *              errors: [{row, column, message}], warnings: [...] }],
 *   data: { roster: {rows, months}, primary: {rows}, secondary: {rows},
 *           timechamp: {rows, dates}, ivr: {rows, dates} }   // valid rows only
 * }>}
 */
async function parseUpload(buffer, { now = new Date() } = {}) {
  const wb = await loadWorkbook(buffer);
  const errors = [];
  const warnings = [];
  const byName = new Map();
  for (const ws of wb.worksheets) {
    const key = norm(ws.name);
    if (byName.has(key)) {
      errors.push(`Sheets '${byName.get(key).name}' and '${ws.name}' have the same name`);
      continue;
    }
    byName.set(key, ws);
  }
  const known = new Set([...UPLOAD_SHEETS, ...TEMPLATE_ONLY_SHEETS].map(norm));
  for (const [key, ws] of byName) {
    if (known.has(key)) continue;
    warnings.push(LIVE_SHEETS.some((n) => norm(n) === key)
      ? `Sheet '${ws.name}' is ignored: open jobs, closed jobs and CRM data come live from the CRM`
      : `Sheet '${ws.name}' is not part of the upload and is ignored`);
  }

  const reports = new Map(UPLOAD_SHEETS.map((n) => [n, newSheetReport(n)]));
  const data = {
    roster: { rows: [], months: [] }, primary: { rows: [] }, secondary: { rows: [] },
    timechamp: { rows: [], dates: [] }, ivr: { rows: [], dates: [] },
  };
  for (const name of UPLOAD_SHEETS) {
    const report = reports.get(name);
    const ws = byName.get(norm(name));
    if (!ws) {
      addIssue(report, 'error', null, null, `Sheet '${name}' is missing from the workbook.`);
      continue;
    }
    report.present = true;
    const { columns } = readHeaders(ws);
    const missing = requiredOf(name).filter((c) => !columns.has(norm(c)));
    if (missing.length) {
      addIssue(report, 'error', 1, null, `Sheet '${name}' is missing column(s): ${missing.join(', ')}`);
      continue;
    }
    if (name === SHEET_ROSTER) data.roster = parseRoster(ws, report, now);
    else if (name === SHEET_PRIMARY) data.primary = parseTargets(ws, report, now, TARGET_SPECS[name]);
    else if (name === SHEET_SECONDARY) data.secondary = parseTargets(ws, report, now, TARGET_SPECS[name]);
    else if (name === SHEET_TIMECHAMP) data.timechamp = parseDaily(ws, report, now, DAILY_SPECS[name]);
    else data.ivr = parseDaily(ws, report, now, DAILY_SPECS[name]);
  }
  const sheets = [...reports.values()];
  return {
    fileSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    blocking: errors.length > 0 || sheets.some((s) => s.errorCount > 0),
    errors,
    warnings,
    sheets,
    data,
  };
}

/* ═══ 5. resolveMonth: compose.js answers "who is this row" ══════════════════ */

const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function sheetOf(name, rows, extraColumns = []) {
  const columns = [...requiredOf(name), ...extraColumns];
  return { name, columns, rows: rows.map((obj) => columns.map((c) => (own(obj, c) ? obj[c] : null))) };
}

/**
 * Runs compose.js fromWorkbookSheets over ONE month (see the header).
 *
 * @param {object} p
 *   month      'YYYY-MM'
 *   roster     [{ crmName, empId, employeeName, rowLabels, vertical, team }] in row order
 *   primary    [{ personName, targetAmount, dailyTarget }]
 *   secondary  [{ personName, totalTarget }]
 *   timechamp  [{ date, employeeId, employeeName }]
 *   ivr        [{ date, agentName }]
 *   names      [string] to canon_name
 * @returns {{ employees, targets, canon: string[], timechamp: [{index, key, date}], ivr: [{index, key, date}] }}
 */
function resolveMonth({ month, roster = [], primary = [], secondary = [], timechamp = [], ivr = [], names = [] }) {
  const monthName = capitalise(MONTH_NAMES[Number(month.slice(5, 7)) - 1]);
  const firstDay = `${month}-01`;
  const teamHeader = `Team Name ${monthName}`;
  const out = fromWorkbookSheets([
    sheetOf('Open order', []),
    sheetOf('Close order', [{ 'Audit & Checkout Date': firstDay },
      ...names.map((n) => ({ 'Primary SPOC': n, 'Audit & Checkout Date': firstDay }))]),
    sheetOf('target list', primary.map((r) => ({ 'Primary spoc': r.personName, 'Target Amount': r.targetAmount,
      'Daily Target': r.dailyTarget, month: monthName }))),
    sheetOf('emp detail', roster.map((r) => ({ 'EMP ID': r.empId, 'EMPLOYE NAME': r.employeeName,
      'CRM CURRENT NAME': r.crmName, 'Row Labels': r.rowLabels, vertical: r.vertical, [teamHeader]: r.team })), [teamHeader]),
    sheetOf('Secondary spoc target list', secondary.map((r) => ({ Name: r.personName, 'Total Target': r.totalTarget,
      month: monthName }))),
    sheetOf('time champ data', timechamp.map((r, i) => ({ 'Employee Id': r.employeeId, 'Employee Name': r.employeeName,
      'Working Hours': i + 1, 'Productive Hours': 0, 'Away Hours': 0, Date: r.date }))),
    sheetOf('crm data', []),
    sheetOf('ivr data record', ivr.map((r, i) => ({ 'Agent Name': r.agentName, 'Total Incoming Calls': i + 1,
      'Total Outgoing Calls': 0, 'Total Missed Calls': 0, 'Avg Handling Time': 0, Date: r.date }))),
  ]);
  return {
    employees: out.employees,
    targets: out.targets,
    canon: out.closedRows.slice(1).map((r) => r.spoc),
    timechamp: out.timechamp.map((r) => ({ index: r.working - 1, key: r.key, date: r.date })),
    ivr: out.ivr.map((r) => ({ index: r.incoming - 1, key: r.key, date: r.date })),
  };
}

/* ═══ 6. Stored rows ═════════════════════════════════════════════════════════ */

const monthStart = (ym) => `${ym}-01`;

/** 'YYYY-MM' of every month touching [from, to]. */
function monthsBetween(from, to) {
  const out = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = shiftMonth(m, 1)) out.push(m);
  return out;
}

const groupBy = (rows, keyOf) => {
  const out = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
};

/** Stored rows of the given months, grouped by month (camelCase, numbers as numbers). */
async function loadStoredMonths(db, months) {
  const empty = { roster: new Map(), primary: new Map(), secondary: new Map(), timechamp: new Map(), ivr: new Map() };
  if (!months.length) return empty;
  // One index range per month, so a file spanning distant months never scans between them.
  const dayRanges = (col) => ({
    sql: months.map(() => `(${col} >= ? AND ${col} < ?)`).join(' OR '),
    params: months.flatMap((m) => [monthStart(m), monthStart(shiftMonth(m, 1))]),
  });
  const tcRange = dayRanges('work_date');
  const ivrRange = dayRanges('call_date');
  const [[roster], [primary], [secondary], [timechamp], [ivr]] = await Promise.all([
    db.query(`SELECT month, crm_key, crm_name, emp_id, employee_name, row_labels, vertical, team_name, row_no
                FROM ${TABLES.roster} WHERE month IN (?) ORDER BY month, row_no, crm_key`, [months]),
    db.query(`SELECT month, person_key, person_name, target_amount, daily_target, row_no
                FROM ${TABLES.primary} WHERE month IN (?) ORDER BY month, row_no, person_key`, [months]),
    db.query(`SELECT month, person_key, person_name, total_target, row_no
                FROM ${TABLES.secondary} WHERE month IN (?) ORDER BY month, row_no, person_key`, [months]),
    db.query(`SELECT work_date, name_key, employee_id, employee_name, working_hours, productive_hours, away_hours
                FROM ${TABLES.timechamp} WHERE ${tcRange.sql} ORDER BY work_date, name_key`, tcRange.params),
    db.query(`SELECT call_date, agent_key, agent_name, incoming_calls, outgoing_calls, missed_calls, avg_handling_secs
                FROM ${TABLES.ivr} WHERE ${ivrRange.sql} ORDER BY call_date, agent_key`, ivrRange.params),
  ]);
  return {
    roster: groupBy(roster.map((r) => ({
      month: r.month, crmKey: r.crm_key, crmName: r.crm_name, empId: r.emp_id, employeeName: r.employee_name,
      rowLabels: r.row_labels, vertical: r.vertical, team: r.team_name, rowNo: Number(r.row_no),
    })), (r) => r.month),
    primary: groupBy(primary.map((r) => ({
      month: r.month, personKey: r.person_key, personName: r.person_name, targetAmount: Number(r.target_amount),
      dailyTarget: Number(r.daily_target), rowNo: Number(r.row_no),
    })), (r) => r.month),
    secondary: groupBy(secondary.map((r) => ({
      month: r.month, personKey: r.person_key, personName: r.person_name, totalTarget: Number(r.total_target),
      rowNo: Number(r.row_no),
    })), (r) => r.month),
    timechamp: groupBy(timechamp.map((r) => ({
      date: r.work_date, nameKey: r.name_key, employeeId: r.employee_id, employeeName: r.employee_name,
      working: Number(r.working_hours), productive: Number(r.productive_hours), away: Number(r.away_hours),
    })), (r) => r.date.slice(0, 7)),
    ivr: groupBy(ivr.map((r) => ({
      date: r.call_date, agentKey: r.agent_key, agentName: r.agent_name, incoming: Number(r.incoming_calls),
      outgoing: Number(r.outgoing_calls), missed: Number(r.missed_calls), aht: Number(r.avg_handling_secs),
    })), (r) => r.date.slice(0, 7)),
  };
}

async function assertStorage(db) {
  const names = Object.values(TABLES);
  const [rows] = await db.query(
    `SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name IN (?)`, [names],
  );
  const present = new Set(rows.map((r) => r.name || r.NAME || r.TABLE_NAME));
  if (names.some((n) => !present.has(n))) throw storageMissing();
}

/* ═══ 7. The CRM user check ══════════════════════════════════════════════════ */

/*
 * "emp detail" is HR's monthly list of who was active, and every row's CRM
 * CURRENT NAME is a promise that a CRM user answers to that name. That promise
 * is the ONLY thing tying an employee to their work: sources.service
 * resolvePeople() matches tbl_user.user_name against the month's emp detail
 * names, so a name nobody in the CRM has costs that person every job they
 * closed — silently, in a total that still looks plausible. The preview says so
 * before anything is saved.
 *
 * WARNINGS, not errors. A name may be absent for a good reason (the CRM user is
 * created later, the person is a new joiner) and someone who has LEFT must stay
 * on the past months' sheets — the emp detail of a month is the record of who
 * was there, owner rule (d). Refusing the file would make that impossible.
 *
 * The ONE blocking case is two rows that are one name. parseUpload already
 * refuses two rows whose crm_key collides; what reaches here are the pairs that
 * differ under the WORKBOOK's norm (build_data.py's) yet are a single name to
 * the CRM matcher — a stray zero-width space, say. Both rows would be stored,
 * the first would claim the name, and the month would quietly lose a person.
 */

/**
 * nameKey(user_name) → is any CRM user of that name still active, for every
 * internal user: ONE read-only query for the whole sheet, however many rows it
 * has.
 *
 * The names are compared HERE rather than in the WHERE clause. nameKey
 * (utils/name-key) is the one normalisation that decides whether a user's name
 * is an employee's name, and a TRIM()/LOWER() in SQL would be a second, subtly
 * different one: a stored name with a double space or a non-breaking space
 * would pass the preview and then be dropped by the dashboard, which is exactly
 * the disagreement this check exists to prevent. So the staff rows come back
 * whole — the ~4,700 technician ghosts stay out — and the comparison is the
 * dashboard's own.
 *
 * @returns {Promise<Map|null>} null when the list could not be read; the
 *   caller then reports that and keeps every other check.
 */
async function loadCrmUsers(db) {
  try {
    const [rows] = await db.query(
      `SELECT user_name, user_status FROM ${CRM_USER_TABLE} WHERE user_role NOT IN (?)`,
      [NON_STAFF_ROLES],
    );
    const byKey = new Map();
    for (const r of rows) {
      const key = nameKey(r.user_name);
      if (key === '') continue;
      const active = Number(r.user_status) === USER_ACTIVE;
      // One name, several users — the CRM has such pairs. Active if ANY of them is.
      byKey.set(key, byKey.get(key) === true || active);
    }
    return byKey;
  } catch (err) {
    logger.warn('Employee Performance upload: the CRM user list could not be read', { err: err.message });
    return null;
  }
}

const CRM_USERS_UNREADABLE = 'The CRM user list could not be read, so the emp detail names were not checked against '
  + 'it — everything else in this report is complete';

/** 'August 2026' · 'August 2026 and September 2026' — the months an emp detail row is on. */
function monthsLabel(months) {
  const labels = months.map(monthLabel);
  if (labels.length <= 1) return labels[0] || '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * The file's emp detail rows against the CRM's own users. Issues go on the emp
 * detail sheet report, column CRM CURRENT NAME:
 *
 *   error    two rows are one name — the month would lose a person (blocking)
 *   warning  no internal CRM user has the name — the row is attributed nothing
 *   warning  the name's CRM users are all inactive — right if they have left
 *
 * A row covers every month column in the file, so a message names them all.
 * `users` null (the list could not be read) leaves the duplicate check running.
 */
function checkCrmUsers(roster, users, report) {
  const label = monthsLabel(roster.months);
  const where = label ? `${label}: ` : '';
  const firstOf = new Map();
  for (const row of roster.rows) {
    const key = nameKey(row.crmName);
    const first = firstOf.get(key);
    if (first) {
      addIssue(report, 'error', row.row, 'CRM CURRENT NAME',
        `${where}CRM CURRENT NAME '${row.crmName}' is the same name as row ${first.row}'s '${first.crmName}' — `
        + 'the two rows would be merged into one person; keep one row per person');
      continue;
    }
    firstOf.set(key, row);
    if (users === null) continue;
    const active = users.get(key);
    if (active === undefined) {
      addIssue(report, 'warning', row.row, 'CRM CURRENT NAME',
        `${where}CRM CURRENT NAME '${row.crmName}' is not a CRM user — this row's jobs and CRM activity are `
        + 'attributed to nobody; check the spelling against Manage Users');
    } else if (!active) {
      addIssue(report, 'warning', row.row, 'CRM CURRENT NAME',
        `${where}CRM CURRENT NAME '${row.crmName}' is an inactive CRM user — right if they have left, and the `
        + 'jobs they closed still count');
    }
  }
}

/* ═══ 8. previewUpload ═══════════════════════════════════════════════════════ */

/** The roster of one month after the upload: stored rows, file rows upserted by crm_key. */
function mergeRoster(stored, fileRows, month) {
  const byKey = new Map(stored.map((r) => [r.crmKey, { ...r, source: 'stored' }]));
  let next = stored.reduce((max, r) => Math.max(max, r.rowNo), 0);
  for (const f of fileRows) {
    const fields = { month, crmKey: f.crmKey, crmName: f.crmName, empId: f.empId, employeeName: f.employeeName,
      rowLabels: f.rowLabels, vertical: f.vertical, team: f.teams[month], fileRow: f.row };
    const prev = byKey.get(f.crmKey);
    if (prev) {
      byKey.set(f.crmKey, { ...fields, rowNo: prev.rowNo, source: 'updated' });
    } else {
      next += 1;
      byKey.set(f.crmKey, { ...fields, rowNo: next, source: 'added' });
    }
  }
  return [...byKey.values()].sort((a, b) => a.rowNo - b.rowNo || (a.crmKey < b.crmKey ? -1 : 1));
}

const TARGET_LISTS = [
  { kind: 'primary', sheet: SHEET_PRIMARY, table: TABLES.primary },
  { kind: 'secondary', sheet: SHEET_SECONDARY, table: TABLES.secondary },
];

/**
 * Everything about ONE month after the upload: the merged roster, who each
 * target / TimeChamp / IVR row belongs to, the target keys to write and the
 * stored target rows they replace. Issues are added to the sheet reports.
 */
function previewMonth(month, file, stored, reports) {
  const label = monthLabel(month);
  const fileRoster = file.roster.months.includes(month) ? file.roster.rows : [];
  const roster = mergeRoster(stored.roster.get(month) || [], fileRoster, month);
  const replacedDates = {
    timechamp: new Set(file.timechamp.dates.filter((d) => d.startsWith(month))),
    ivr: new Set(file.ivr.dates.filter((d) => d.startsWith(month))),
  };
  const activity = (kind) => [
    ...(stored[kind].get(month) || []).filter((r) => !replacedDates[kind].has(r.date)).map((r) => ({ ...r, source: 'stored' })),
    ...file[kind].rows.filter((r) => r.date.startsWith(month)).map((r) => ({ ...r, source: 'file' })),
  ];
  const tcRows = activity('timechamp');
  const ivrRows = activity('ivr');
  const targetRows = Object.fromEntries(TARGET_LISTS.map(({ kind }) => [kind, {
    file: file[kind].rows.filter((r) => r.month === month),
    stored: stored[kind].get(month) || [],
  }]));

  const names = [];
  const nameAt = (n) => names.push(n) - 1;
  const rosterNameIdx = roster.filter((r) => r.source !== 'stored')
    .map((r) => ({ r, crm: nameAt(r.crmName), label: r.rowLabels ? nameAt(r.rowLabels) : -1,
      display: r.employeeName ? nameAt(r.employeeName) : -1 }));
  for (const { kind } of TARGET_LISTS) {
    for (const r of [...targetRows[kind].file, ...targetRows[kind].stored]) r.nameIdx = nameAt(r.personName);
  }
  const hasRoster = roster.length > 0;
  const oracle = hasRoster
    ? resolveMonth({ month, roster, timechamp: tcRows, ivr: ivrRows, names })
    : { canon: names.map(sval), timechamp: [], ivr: [] };
  const crmKeyOf = new Map(roster.map((r) => [r.crmName, r.crmKey]));
  const personOf = (idx) => (crmKeyOf.has(oracle.canon[idx]) ? oracle.canon[idx] : null);

  // emp detail: a name this row brings that already means someone else.
  for (const { r, crm, label: li, display } of rosterNameIdx) {
    const report = reports.get(SHEET_ROSTER);
    const clash = (idx, column, value) => {
      const who = personOf(idx);
      if (idx >= 0 && who !== null && who !== r.crmName) {
        addIssue(report, 'warning', r.fileRow, column,
          `${column} '${value}' already means ${who} on ${label}'s emp detail — that name stays with ${who}`);
      }
    };
    clash(crm, 'CRM CURRENT NAME', r.crmName);
    clash(li, 'Row Labels', r.rowLabels);
    clash(display, 'EMPLOYE NAME', r.employeeName);
  }

  // Targets: the key is the person the name resolves to, else the typed name.
  const targets = {};
  const hidden = { timechamp: 0, ivr: 0, primary: 0, secondary: 0 };
  for (const { kind, sheet } of TARGET_LISTS) {
    const report = reports.get(sheet);
    const column = TARGET_SPECS[sheet].name;
    const keyOf = (r) => {
      const who = personOf(r.nameIdx);
      return who !== null ? crmKeyOf.get(who) : norm(r.personName);
    };
    const writes = [];
    const byKey = new Map();
    for (const r of targetRows[kind].file) {
      const who = personOf(r.nameIdx);
      const key = keyOf(r);
      // Same typed name twice was already refused by parseUpload; this is two names for one person.
      if (byKey.has(key)) {
        const first = byKey.get(key);
        addIssue(report, 'error', r.row, column,
          `'${r.personName}' is ${who}, who is already on row ${first.row} as '${first.personName}' — one row per person for ${label}`);
        continue;
      }
      byKey.set(key, r);
      writes.push({ ...r, personKey: key });
      if (hasRoster && who === null) {
        addIssue(report, 'warning', r.row, column,
          `'${r.personName}' is not on ${label}'s emp detail — saved, but hidden on the dashboard until they are added`);
      }
    }
    if (!hasRoster && writes.length) {
      addIssue(report, 'warning', null, null,
        `${label} has no emp detail yet — its ${writes.length} rows are saved but hidden until it is uploaded`);
    }
    const replaced = [];
    const kept = [];
    let updated = 0;
    for (const s of targetRows[kind].stored) {
      if (byKey.has(s.personKey)) {
        updated += 1;                          // same key: the upsert overwrites it
      } else if (byKey.has(keyOf(s))) {
        replaced.push(s);                      // same person saved under another name: deleted
        addIssue(report, 'warning', byKey.get(keyOf(s)).row, column,
          `Replaces the ${label} target saved as '${s.personName}'`);
      } else {
        kept.push(s);
      }
    }
    const after = [...kept, ...writes];
    // Two rows that resolve to one person would be added together by the build.
    for (const [, group] of groupBy(after, keyOf)) {
      if (group.length > 1) {
        addIssue(report, 'warning', null, null,
          `${label}: ${group.map((g) => `'${g.personName}'`).join(' and ')} are the same person — their targets will be added together; upload one row for them`);
      }
    }
    hidden[kind] = after.filter((r) => personOf(r.nameIdx) === null).length;
    targets[kind] = { writes, replaced, updated };
  }

  // TimeChamp / IVR: which rows nobody on this month's emp detail takes.
  const crmOf = new Map(roster.map((r) => [r.crmName, r]));
  for (const [kind, sheet, rows, matches] of [
    ['timechamp', SHEET_TIMECHAMP, tcRows, oracle.timechamp], ['ivr', SHEET_IVR, ivrRows, oracle.ivr]]) {
    const report = reports.get(sheet);
    const takenBy = new Map();
    for (const m of matches) {
      if (!takenBy.has(m.index)) takenBy.set(m.index, []);
      takenBy.get(m.index).push(m.key);
    }
    const fileRows = rows.filter((r) => r.source === 'file');
    hidden[kind] = rows.filter((_, i) => !takenBy.has(i)).length;
    if (!hasRoster) {
      if (fileRows.length) {
        addIssue(report, 'warning', null, null,
          `${label} has no emp detail yet — its ${fileRows.length} rows are saved but hidden until it is uploaded`);
      }
      continue;
    }
    rows.forEach((r, i) => {
      if (r.source !== 'file') return;
      const who = takenBy.get(i);
      if (!who) {
        const name = kind === 'timechamp' ? `'${r.employeeName}' (${r.employeeId})` : `'${r.agentName}'`;
        addIssue(report, 'warning', r.row, kind === 'timechamp' ? 'Employee Name' : 'Agent Name',
          `${name} is not on ${label}'s emp detail — saved, but hidden on the dashboard until they are added`);
      } else if (kind === 'timechamp') {
        for (const key of who) {
          const e = crmOf.get(key);
          if (e && r.nameKey !== norm(e.employeeName) && r.nameKey !== e.crmKey) {
            addIssue(report, 'warning', r.row, 'Employee Id',
              `'${r.employeeName}' is counted as ${key} by Employee Id ${r.employeeId} only — the names differ`);
          }
        }
      }
    });
  }

  return {
    month,
    roster,
    targets,
    summary: {
      month,
      empDetail: {
        stored: (stored.roster.get(month) || []).length,
        inFile: fileRoster.length,
        added: roster.filter((r) => r.source === 'added').length,
        updated: roster.filter((r) => r.source === 'updated').length,
        after: roster.length,
      },
      primaryTargets: { inFile: targets.primary.writes.length, updated: targets.primary.updated,
        replaced: targets.primary.replaced.length },
      secondaryTargets: { inFile: targets.secondary.writes.length, updated: targets.secondary.updated,
        replaced: targets.secondary.replaced.length },
      hiddenAfterUpload: { timechamp: hidden.timechamp, ivr: hidden.ivr, primaryTargets: hidden.primary,
        secondaryTargets: hidden.secondary },
    },
  };
}

async function buildPreview(buffer, { db, now }) {
  await assertStorage(db);
  const parsed = await parseUpload(buffer, { now });
  const { data } = parsed;
  const reports = new Map(parsed.sheets.map((s) => [s.name, s]));
  if (data.roster.rows.length) {
    const users = await loadCrmUsers(db);
    if (users === null) parsed.warnings.push(CRM_USERS_UNREADABLE);
    checkCrmUsers(data.roster, users, reports.get(SHEET_ROSTER));
  }
  const months = [...new Set([
    ...(data.roster.rows.length ? data.roster.months : []),
    ...data.primary.rows.map((r) => r.month),
    ...data.secondary.rows.map((r) => r.month),
    ...data.timechamp.dates.map((d) => d.slice(0, 7)),
    ...data.ivr.dates.map((d) => d.slice(0, 7)),
  ])].sort();
  const stored = await loadStoredMonths(db, months);
  const perMonth = months.map((m) => previewMonth(m, data, stored, reports));

  const overwrites = [];
  for (const [kind, source] of [['timechamp', 'timechamp'], ['ivr', 'ivr']]) {
    const storedByDate = groupBy([...stored[kind].values()].flat(), (r) => r.date);
    const fileByDate = groupBy(data[kind].rows, (r) => r.date);
    for (const date of data[kind].dates) {
      const storedRows = (storedByDate.get(date) || []).length;
      if (storedRows > 0) overwrites.push({ source, date, storedRows, fileRows: fileByDate.get(date).length });
    }
  }
  const sheets = parsed.sheets;
  return {
    parsed,
    perMonth,
    report: {
      fileSha256: parsed.fileSha256,
      blocking: parsed.errors.length > 0 || sheets.some((s) => s.errorCount > 0),
      errors: parsed.errors,
      warnings: parsed.warnings,
      sheets,
      overwrites,
      months: perMonth.map((p) => p.summary),
    },
  };
}

/**
 * The upload check shown before anything is saved: the file's own errors and
 * warnings plus everything that depends on what is stored and on the CRM's own
 * users (§7). Writes nothing.
 *
 * @returns {Promise<{ fileSha256, blocking, errors, warnings,
 *   sheets: [{ name, present, rows, errorCount, warningCount, errors: [{row, column, message}], warnings }],
 *   overwrites: [{ source: 'timechamp'|'ivr', date, storedRows, fileRows }],
 *   months: [{ month, empDetail: {stored, inFile, added, updated, after},
 *              primaryTargets: {inFile, updated, replaced}, secondaryTargets: {inFile, updated, replaced},
 *              hiddenAfterUpload: {timechamp, ivr, primaryTargets, secondaryTargets} }] }>}
 * @throws 400 unreadable file / too large to open (§4) · 503 storage not set up
 */
async function previewUpload(buffer, { db = pool, now = new Date() } = {}) {
  const { report } = await buildPreview(buffer, { db, now });
  return report;
}

/* ═══ 9. commitUpload ════════════════════════════════════════════════════════ */

async function insertChunks(conn, sql, rows) {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await conn.query(sql, [rows.slice(i, i + INSERT_CHUNK)]);
  }
}

async function writeUpload(conn, preview, { userId, fileName, now }) {
  const { parsed, perMonth, report } = preview;
  const { data } = parsed;
  const monthsWith = (pred) => perMonth.filter(pred).map((p) => p.month);
  const monthly = monthsWith((p) => p.summary.empDetail.inFile || p.targets.primary.writes.length
    || p.targets.secondary.writes.length);
  const dates = [...data.timechamp.dates, ...data.ivr.dates].sort();
  const sheetsWithRows = [
    [SHEET_ROSTER, data.roster.rows], [SHEET_PRIMARY, data.primary.rows], [SHEET_SECONDARY, data.secondary.rows],
    [SHEET_TIMECHAMP, data.timechamp.rows], [SHEET_IVR, data.ivr.rows],
  ].filter(([, rows]) => rows.length).map(([n]) => n);

  const [batch] = await conn.query(
    `INSERT INTO ${TABLES.batch}
       (file_name, file_sha256, sheets, date_from, date_to, month_from, month_to, summary_json, uploaded_by, uploaded_on)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [fileName, report.fileSha256, sheetsWithRows.join(','), dates[0] || null, dates[dates.length - 1] || null,
      monthly[0] || null, monthly[monthly.length - 1] || null, JSON.stringify(report), userId, now],
  );
  const batchId = batch.insertId;

  const rosterRows = perMonth.flatMap((p) => p.roster.filter((r) => r.source !== 'stored').map((r) => [
    r.month, r.crmKey, r.crmName, r.empId, r.employeeName, r.rowLabels, r.vertical, r.team, r.rowNo, batchId]));
  if (rosterRows.length) {
    // row_no is NOT updated: a person keeps their place in the month's list.
    await insertChunks(conn,
      `INSERT INTO ${TABLES.roster}
         (month, crm_key, crm_name, emp_id, employee_name, row_labels, vertical, team_name, row_no, batch_id)
       VALUES ?
       ON DUPLICATE KEY UPDATE crm_name = VALUES(crm_name), emp_id = VALUES(emp_id),
         employee_name = VALUES(employee_name), row_labels = VALUES(row_labels), vertical = VALUES(vertical),
         team_name = VALUES(team_name), batch_id = VALUES(batch_id)`, rosterRows);
  }

  const saved = { empDetail: rosterRows.length, primaryTargets: 0, secondaryTargets: 0, timechamp: 0, ivr: 0 };
  for (const { kind, table } of TARGET_LISTS) {
    for (const p of perMonth) {
      const t = p.targets[kind];
      if (t.replaced.length) {
        await conn.query(`DELETE FROM ${table} WHERE month = ? AND person_key IN (?)`,
          [p.month, t.replaced.map((r) => r.personKey)]);
      }
    }
    const writes = perMonth.flatMap((p) => p.targets[kind].writes);
    if (!writes.length) continue;
    saved[`${kind}Targets`] = writes.length;
    if (kind === 'primary') {
      await insertChunks(conn,
        `INSERT INTO ${table} (month, person_key, person_name, target_amount, daily_target, row_no, batch_id)
         VALUES ?
         ON DUPLICATE KEY UPDATE person_name = VALUES(person_name), target_amount = VALUES(target_amount),
           daily_target = VALUES(daily_target), row_no = VALUES(row_no), batch_id = VALUES(batch_id)`,
        writes.map((w) => [w.month, w.personKey, w.personName, w.targetAmount, w.dailyTarget, w.row, batchId]));
    } else {
      await insertChunks(conn,
        `INSERT INTO ${table} (month, person_key, person_name, total_target, row_no, batch_id)
         VALUES ?
         ON DUPLICATE KEY UPDATE person_name = VALUES(person_name), total_target = VALUES(total_target),
           row_no = VALUES(row_no), batch_id = VALUES(batch_id)`,
        writes.map((w) => [w.month, w.personKey, w.personName, w.totalTarget, w.row, batchId]));
    }
  }

  if (data.timechamp.rows.length) {
    await conn.query(`DELETE FROM ${TABLES.timechamp} WHERE work_date IN (?)`, [data.timechamp.dates]);
    await insertChunks(conn,
      `INSERT INTO ${TABLES.timechamp}
         (work_date, name_key, employee_id, employee_name, working_hours, productive_hours, away_hours, batch_id)
       VALUES ?`,
      data.timechamp.rows.map((r) => [r.date, r.nameKey, r.employeeId, r.employeeName, r.working, r.productive,
        r.away, batchId]));
    saved.timechamp = data.timechamp.rows.length;
  }
  if (data.ivr.rows.length) {
    await conn.query(`DELETE FROM ${TABLES.ivr} WHERE call_date IN (?)`, [data.ivr.dates]);
    await insertChunks(conn,
      `INSERT INTO ${TABLES.ivr}
         (call_date, agent_key, agent_name, incoming_calls, outgoing_calls, missed_calls, avg_handling_secs, batch_id)
       VALUES ?`,
      data.ivr.rows.map((r) => [r.date, r.agentKey, r.agentName, r.incoming, r.outgoing, r.missed, r.aht, batchId]));
    saved.ivr = data.ivr.rows.length;
  }
  return { batchId, saved, sheets: sheetsWithRows };
}

/**
 * Save an upload: re-runs the preview against what is stored NOW (a preview
 * the browser saw earlier is never trusted), refuses it when anything blocks,
 * then writes everything in ONE transaction under a MySQL named lock so two
 * operators saving at once cannot interleave.
 *
 * @param {Buffer} buffer
 * @param {{ db?: pool, userId: number, fileName?: string, now?: Date }} options
 *   db must be a pool (a connection is taken for the lock and transaction).
 * @returns {Promise<{ batchId, saved: {empDetail, primaryTargets, secondaryTargets, timechamp, ivr},
 *   sheets: string[], preview }>}
 * @throws 400 (err.preview) blocking errors / nothing to save · 409 another upload is saving · 503 storage
 */
async function commitUpload(buffer, { db = pool, userId, fileName = 'employee-performance-upload.xlsx', now = new Date() } = {}) {
  if (!Number.isInteger(userId) || userId <= 0) throw new TypeError('commitUpload: userId must be a positive integer');
  const name = String(fileName).slice(0, LEN.fileName);
  const { acquired, result } = await withMysqlNamedLock(LOCK_NAME, async (conn) => {
    const preview = await buildPreview(buffer, { db: conn, now });
    if (preview.report.blocking) {
      throw statusError(400, 'The file has errors — fix them and upload again', { preview: preview.report });
    }
    const { data } = preview.parsed;
    if (!['roster', 'primary', 'secondary', 'timechamp', 'ivr'].some((k) => data[k].rows.length)) {
      throw statusError(400, 'The file has no rows to save', { preview: preview.report });
    }
    await conn.beginTransaction();
    try {
      const written = await writeUpload(conn, preview, { userId, fileName: name, now });
      await conn.commit();
      return { ...written, preview: preview.report };
    } catch (err) {
      try {
        await conn.rollback();
      } catch (rollbackErr) {
        logger.warn('Employee Performance upload rollback failed', { err: rollbackErr.message });
      }
      if (isAbsentAnswer(err)) throw storageMissing();
      throw err;
    }
  }, db, { timeoutSeconds: 10 });
  if (!acquired) throw statusError(409, 'Another Employee Performance upload is being saved — try again in a moment');
  logger.info('Employee Performance upload saved', { batchId: result.batchId, userId, ...result.saved });
  return result;
}

/* ═══ 10. loadUploads ════════════════════════════════════════════════════════ */

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
let warnedMissing = false;

function emptyTargets() {
  return { spocs: [], daily: dict(), monthly: dict(), total: dict(), personal: dict() };
}

/**
 * The stored uploads as compose() inputs for the window [from, to] (IST dates,
 * inclusive). Each month is resolved against THAT month's emp detail.
 *
 * @returns {Promise<{
 *   storage: 'ready'|'missing', window: {from, to}, months: string[],
 *   rosterMonths: string[],                  // months with an emp detail uploaded
 *   roster: { [month]: [{ key, crmName, empId, employeeName, rowLabels, vertical, team }] },
 *                                            // = sources.service resolvePeople's rosterByMonth; crmName === key
 *   employees: [{ key, display, vertical, teams: { [month]: team } }],   // compose inputs.employees
 *   targets: { spocs, daily, monthly, total, personal },                 // compose inputs.targets
 *   timechamp: [{ key, date, working, productive, away }],               // compose inputs.timechamp
 *   ivr: [{ key, date, incoming, outgoing, missed, aht }],               // compose inputs.ivr
 *   hidden: { timechamp: [{date, employeeId, employeeName}], ivr: [{date, agentName}],
 *             primaryTargets: [{month, personName}], secondaryTargets: [{month, personName}] },
 *   resolveNames(month, names): Map<name, employee key | null>   // canon_name against that month's emp detail
 * }>}
 * Employee keys are CRM CURRENT NAMEs (the latest spelling in the window).
 */
async function loadUploads({ from, to, db = pool } = {}) {
  if (!YMD_RE.test(String(from)) || !YMD_RE.test(String(to)) || from > to) {
    throw new TypeError('loadUploads: from and to must be YYYY-MM-DD with from <= to');
  }
  const months = monthsBetween(from, to);
  const result = {
    storage: 'ready', window: { from, to }, months, rosterMonths: [], roster: {}, employees: [],
    targets: emptyTargets(), timechamp: [], ivr: [],
    hidden: { timechamp: [], ivr: [], primaryTargets: [], secondaryTargets: [] },
    resolveNames: (_month, names) => new Map((names || []).map((n) => [n, null])),
  };
  let stored;
  try {
    stored = await loadStoredMonths(db, months);
  } catch (err) {
    if (!isAbsentAnswer(err)) throw err;
    if (!warnedMissing) {
      warnedMissing = true;
      logger.warn(`Employee Performance uploads unavailable — ${STORAGE_MISSING_MESSAGE}`);
    }
    return { ...result, storage: 'missing' };
  }
  warnedMissing = false;

  const inWindow = (d) => d >= from && d <= to;
  // One key per person across months: the latest CRM CURRENT NAME spelling.
  const latestName = new Map();
  for (const m of months) for (const r of stored.roster.get(m) || []) latestName.set(r.crmKey, r.crmName);
  const keyMaps = new Map();
  const unifyIn = (m) => {
    const byName = keyMaps.get(m);
    return (name) => (byName.has(name) ? latestName.get(byName.get(name)) : null);
  };

  const employees = new Map();
  const spocs = new Set();
  const T = result.targets;
  const put = (target, key, month, value) => {
    if (!own(target, key)) target[key] = dict();
    target[key][month] = value;
  };
  for (const m of months) {
    const roster = stored.roster.get(m) || [];
    const primary = stored.primary.get(m) || [];
    const secondary = stored.secondary.get(m) || [];
    const tc = stored.timechamp.get(m) || [];
    const ivr = stored.ivr.get(m) || [];
    if (!roster.length) {
      for (const r of tc) if (inWindow(r.date)) result.hidden.timechamp.push({ date: r.date, employeeId: r.employeeId, employeeName: r.employeeName });
      for (const r of ivr) if (inWindow(r.date)) result.hidden.ivr.push({ date: r.date, agentName: r.agentName });
      for (const r of primary) result.hidden.primaryTargets.push({ month: m, personName: r.personName });
      for (const r of secondary) result.hidden.secondaryTargets.push({ month: m, personName: r.personName });
      continue;
    }
    result.rosterMonths.push(m);
    keyMaps.set(m, new Map(roster.map((r) => [r.crmName, r.crmKey])));
    const unify = unifyIn(m);
    const names = [...primary, ...secondary].map((r) => r.personName);
    const o = resolveMonth({ month: m, roster, primary, secondary, timechamp: tc, ivr, names });
    // crmName IS the employee key, so a consumer keying people by crmName
    // (sources.service resolvePeople's rosterByMonth) agrees with employees[].key
    // even when a later month spells the same name with other case or spacing.
    result.roster[m] = roster.map((r) => ({ key: unify(r.crmName), crmName: unify(r.crmName), empId: r.empId,
      employeeName: r.employeeName, rowLabels: r.rowLabels, vertical: r.vertical, team: r.team }));

    for (const e of o.employees) {
      const key = unify(e.key);
      if (!employees.has(key)) employees.set(key, { key, display: e.display, vertical: e.vertical, teams: dict() });
      const entry = employees.get(key);
      entry.display = e.display;                 // months ascend: the latest month's values win
      entry.vertical = e.vertical;
      entry.teams[m] = e.teams[m];
    }

    const asKey = (name) => unify(name) || name;   // a name nobody on emp detail has stays as typed (hidden)
    for (const n of o.targets.spocs) spocs.add(asKey(n));
    for (const field of ['daily', 'monthly', 'personal']) {
      for (const [n, byMonth] of Object.entries(o.targets[field])) {
        if (own(byMonth, m)) put(T[field], asKey(n), m, byMonth[m]);
      }
    }
    for (const [n, v] of Object.entries(o.targets.total)) {
      const k = asKey(n);
      T.total[k] = (own(T.total, k) ? T.total[k] : 0) + v;
    }
    o.canon.forEach((c, i) => {
      if (unify(c) !== null) return;
      const list = i < primary.length ? result.hidden.primaryTargets : result.hidden.secondaryTargets;
      list.push({ month: m, personName: names[i] });
    });

    const taken = { timechamp: new Set(), ivr: new Set() };
    for (const t of o.timechamp) {
      const r = tc[t.index];
      taken.timechamp.add(t.index);
      if (inWindow(r.date)) {
        result.timechamp.push({ key: unify(t.key), date: r.date, working: r.working, productive: r.productive, away: r.away });
      }
    }
    for (const t of o.ivr) {
      const r = ivr[t.index];
      taken.ivr.add(t.index);
      if (inWindow(r.date)) {
        result.ivr.push({ key: unify(t.key), date: r.date, incoming: r.incoming, outgoing: r.outgoing, missed: r.missed,
          aht: r.aht });
      }
    }
    tc.forEach((r, i) => {
      if (!taken.timechamp.has(i) && inWindow(r.date)) {
        result.hidden.timechamp.push({ date: r.date, employeeId: r.employeeId, employeeName: r.employeeName });
      }
    });
    ivr.forEach((r, i) => {
      if (!taken.ivr.has(i) && inWindow(r.date)) result.hidden.ivr.push({ date: r.date, agentName: r.agentName });
    });
  }
  T.spocs = [...spocs];
  result.employees = [...employees.values()];
  result.resolveNames = (month, names) => {
    const list = [...(names || [])];
    const roster = stored.roster.get(month) || [];
    if (!roster.length || !keyMaps.has(month)) return new Map(list.map((n) => [n, null]));
    const { canon } = resolveMonth({ month, roster, names: list });
    const unify = unifyIn(month);
    return new Map(list.map((n, i) => [n, unify(canon[i])]));
  };
  return result;
}

module.exports = {
  parseUpload,
  previewUpload,
  commitUpload,
  loadUploads,
  STORAGE_MISSING_MESSAGE,
  _internals: {
    readCell,
    monthForNumber,
    resolveMonth,
    TABLES,
    inspectArchive,
    ARCHIVE_LIMITS: Object.freeze({
      MAX_UNCOMPRESSED_TOTAL, MAX_UNCOMPRESSED_ENTRY, MAX_ZIP_ENTRIES, MAX_SHEET_PARTS,
    }),
  },
};
