const ExcelJS = require('exceljs');
const { pool } = require('../db');
const logger = require('../logger');
const attendancePref = require('./attendance-preference.service');
const holidays = require('./holiday.service');
const roster = require('./roster.service');
const { monthBounds } = require('../utils/ist-calendar');

/*
 * Team Roster → Bulk Update: Download Template → fill → upload (dry run shows
 * every error, cell by cell) → Confirm & Save.
 *
 * Template = one row per employee, one column per editable date, pre-filled
 * with what is in effect today (resolveDays), so the operator only edits what
 * differs. Upload writes ONLY cells whose value differs from what is in
 * effect — an untouched template is a no-op, and untouched days keep
 * following the weekly days instead of being frozen into roster rows.
 *
 * Shift is one column per employee, pre-filled with their Default Shift. It
 * counts only when CHANGED from that default: then every PR day in the file
 * gets it. Left alone, existing per-day shifts are kept (never overwritten
 * with the default).
 *
 * Validation, the dry-run preview, the error sheet and the commit all run
 * through ONE function (validateSheet), so the preview cannot disagree with
 * what gets saved.
 */

const FIXED_COLS = ['User ID', 'Emp Code', 'Name', 'Role', 'Shift'];
const FIRST_DATE_COL = FIXED_COLS.length + 1; // 1-based
const MAX_CELLS = 20000;
const DAY_ABBR = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HEADER_RE = /^(\d{2})\/(\d{2})\/(\d{4})\b/;
const ERROR_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8B4B4' } };

function mkErr(status, message) { const e = new Error(message); e.status = status; return e; }

function shift12(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${String(h % 12 === 0 ? 12 : h % 12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
const SHIFT_LIST = Array.from({ length: 48 }, (_, n) => {
  const i = (n + 16) % 48; // 08:00 AM first, like the CRM picker
  return shift12(`${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
});

function dateHeader(ymd) {
  return `${ymd.slice(8)}/${ymd.slice(5, 7)}/${ymd.slice(0, 4)} (${DAY_ABBR[roster.weekdayIndex(ymd)]})`;
}

/** Cell → plain text. ExcelJS hands back rich text, formulas and hyperlinks as objects. */
function cellText(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if ('result' in v) return cellText(v.result);
    if ('text' in v) return String(v.text);
  }
  return String(v).trim();
}

/** "10:00 AM" | "1:30 pm" | "13:30" | an Excel time (Date / day fraction) → 'HH:MM', '' for blank, undefined if invalid. */
function parseShift(raw) {
  const v = cellText(raw);
  if (v === '') return '';
  let h; let m;
  if (v instanceof Date) { h = v.getUTCHours(); m = v.getUTCMinutes(); }
  else if (typeof raw === 'number' && raw >= 0 && raw < 1) { const mins = Math.round(raw * 1440); h = Math.floor(mins / 60); m = mins % 60; }
  else {
    const t = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?$/.exec(v);
    if (!t) return undefined;
    h = Number(t[1]); m = Number(t[2]);
    if (t[3]) {
      if (h < 1 || h > 12) return undefined;
      h = (h % 12) + (/p/i.test(t[3]) ? 12 : 0);
    }
  }
  if (!(h >= 0 && h <= 23) || (m !== 0 && m !== 30)) return undefined;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Editable dates in the picked months ('YYYY-MM'), clamped to the edit window. */
function datesForMonths(months, win) {
  const out = new Set();
  for (const mk of months) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mk)) throw mkErr(400, `Invalid month ${mk}`);
    const { start, end } = monthBounds(mk); // end is exclusive
    for (const d of roster.listDates(start, end)) if (d < end && d >= win.editFrom && d <= win.editTo) out.add(d);
  }
  return [...out].sort();
}

/** Everyone the actor may plan for (active employees) — the template's default list. */
async function editableUserIds(reach) {
  let ids;
  if (reach.isAdmin) {
    const [all] = await pool.query('SELECT user_id FROM tbl_user WHERE user_status = 1 AND user_type_id = 5');
    ids = all.map((r) => Number(r.user_id));
  } else {
    ids = [...reach.descendants];
  }
  return ids.filter((id) => roster.canEditUser(reach, id));
}

// ─── Template ─────────────────────────────────────────────────────────
async function buildTemplate({ actorId, isAdmin, months, userIds }) {
  const win = roster.editWindow({ canEditToday: isAdmin });
  const dates = datesForMonths(months || [], win);
  if (!dates.length) throw mkErr(400, 'Pick at least one month with editable days');
  const reach = await roster.actorReach(actorId, isAdmin);
  let ids;
  if (userIds && userIds.length) {
    ids = [...new Set(userIds.map(Number))];
    if (ids.some((id) => !roster.canEditUser(reach, id))) throw mkErr(403, 'You can only plan the roster for your own team members, not yourself');
  } else {
    ids = await editableUserIds(reach);
  }
  const users = await roster.loadActiveUsers(ids);
  if (!users.length) throw mkErr(400, 'No employees to plan for');
  if (users.length * dates.length > MAX_CELLS) throw mkErr(400, `Too large — pick fewer months or employees (max ${MAX_CELLS} cells)`);

  const { byUser, prefs } = await roster.resolveDays(users.map((u) => Number(u.user_id)), dates[0], dates[dates.length - 1]);
  const hol = new Map(holidays.getRange({ from: dates[0], to: dates[dates.length - 1] }).map((h) => [h.date, h.name]));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Roster', { views: [{ state: 'frozen', xSplit: FIXED_COLS.length, ySplit: 1 }] });
  const lists = wb.addWorksheet('Lists', { state: 'veryHidden' });
  SHIFT_LIST.forEach((s, i) => { lists.getCell(i + 1, 1).value = s; });

  const header = ws.addRow([...FIXED_COLS, ...dates.map(dateHeader)]);
  header.font = { bold: true };
  dates.forEach((d, i) => {
    if (!hol.has(d)) return;
    const c = header.getCell(FIRST_DATE_COL + i);
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDECEA' } };
    c.note = `Holiday: ${hol.get(d)}`;
  });
  for (const u of users) {
    const uid = Number(u.user_id);
    const shift = prefs.get(uid)?.default_shift_start || attendancePref.DEFAULT_SHIFT;
    ws.addRow([uid, u.user_code || '', u.user_name, u.role_name || '', shift12(shift), ...dates.map((d) => byUser.get(uid)[d].type)]);
  }
  const last = users.length + 1;
  const lastCol = ws.getColumn(FIRST_DATE_COL + dates.length - 1).letter;
  const firstCol = ws.getColumn(FIRST_DATE_COL).letter;
  const shiftCol = ws.getColumn(FIXED_COLS.length).letter;
  ws.dataValidations.add(`${firstCol}2:${lastCol}${last}`, {
    type: 'list', allowBlank: true, formulae: ['"PR,WO"'],
    showErrorMessage: true, errorTitle: 'PR or WO', error: 'Use PR (Present) or WO (Week Off).',
  });
  ws.dataValidations.add(`${shiftCol}2:${shiftCol}${last}`, {
    type: 'list', allowBlank: true, formulae: [`Lists!$A$1:$A$${SHIFT_LIST.length}`],
    showErrorMessage: true, errorTitle: 'Shift', error: 'Pick a 30-minute slot, e.g. 10:00 AM.',
  });
  ws.getColumn(1).width = 9; ws.getColumn(2).width = 11; ws.getColumn(3).width = 26; ws.getColumn(4).width = 20; ws.getColumn(5).width = 11;
  for (let i = 0; i < dates.length; i++) ws.getColumn(FIRST_DATE_COL + i).width = 15;

  const help = wb.addWorksheet('How To Use');
  [
    'Change PR (Present) / WO (Week Off) cells and, if needed, the Shift column, then upload this file.',
    'Leave anything you are not changing as it is — only cells that differ from the current plan are saved.',
    'Shift applies to every PR day in this file, but only if you change it from the employee\'s default.',
    'Do not edit the User ID column or the date headers. A blank cell means "no change".',
    'LV / SL = approved leave: those days are locked — leave them as they are.',
  ].forEach((t) => help.addRow([t]));
  help.getColumn(1).width = 110;

  return { buffer: await wb.xlsx.writeBuffer(), from: dates[0], to: dates[dates.length - 1] };
}

// ─── Validate (dry run, error sheet and commit all use this) ──────────
async function loadSheet(buffer) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch { throw mkErr(400, 'Could not read the file — upload the .xlsx template'); }
  const ws = wb.getWorksheet('Roster') || wb.worksheets[0];
  if (!ws) throw mkErr(400, 'The file has no sheet');
  return { wb, ws };
}

async function validateSheet(ws, { actorId, isAdmin }) {
  const win = roster.editWindow({ canEditToday: isAdmin });
  const reach = await roster.actorReach(actorId, isAdmin);
  const errors = new Map(); // 'row:col' → message
  const addErr = (r, c, msg) => { if (!errors.has(`${r}:${c}`)) errors.set(`${r}:${c}`, msg); };

  const headerRow = ws.getRow(1);
  const lastCol = ws.actualColumnCount || headerRow.cellCount;
  if (cellText(headerRow.getCell(1).value) !== 'User ID') throw mkErr(400, 'This is not the roster template — download it again');
  const dateCols = []; // { col, date }
  for (let c = FIRST_DATE_COL; c <= lastCol; c++) {
    const h = cellText(headerRow.getCell(c).value);
    if (h === '') continue;
    const m = HEADER_RE.exec(typeof h === 'string' ? h : '');
    const date = m ? `${m[3]}-${m[2]}-${m[1]}` : null;
    if (!date || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(date)) { addErr(1, c, 'Date header changed — expected DD/MM/YYYY (Day)'); continue; }
    if (date < win.editFrom || date > win.editTo) { addErr(1, c, `Not editable — dates from ${win.editFrom} to ${win.editTo} only`); continue; }
    if (dateCols.some((x) => x.date === date)) { addErr(1, c, 'Duplicate date column'); continue; }
    dateCols.push({ col: c, date });
  }
  if (!dateCols.length && !errors.size) throw mkErr(400, 'No date columns found — download the template again');

  // First pass: which rows are employees, and who they are.
  const rows = [];
  const seen = new Map();
  ws.eachRow({ includeEmpty: false }, (row, r) => {
    if (r === 1) return;
    const idText = cellText(row.getCell(1).value);
    const name = cellText(row.getCell(3).value);
    if (idText === '' && name === '' && dateCols.every((x) => cellText(row.getCell(x.col).value) === '')) return;
    const uid = Number(idText);
    if (!Number.isInteger(uid) || uid <= 0) { addErr(r, 1, 'User ID missing or changed'); rows.push({ r, uid: null, name }); return; }
    if (seen.has(uid)) addErr(r, 1, `Duplicate — this employee is also on row ${seen.get(uid)}`);
    else seen.set(uid, r);
    if (!roster.canEditUser(reach, uid)) addErr(r, 1, uid === reach.actorId ? 'You cannot plan your own roster' : 'Not in your team');
    rows.push({ r, uid, name });
  });
  if (!rows.length) throw mkErr(400, 'The file has no employee rows');

  const uids = [...seen.keys()];
  const active = new Map((await roster.loadActiveUsers(uids)).map((u) => [Number(u.user_id), u]));
  for (const x of rows) if (x.uid && !active.has(x.uid) && !errors.has(`${x.r}:1`)) addErr(x.r, 1, 'Inactive or unknown employee');

  const valid = uids.filter((id) => active.has(id));
  const dates = dateCols.map((x) => x.date).sort();
  const { byUser, prefs } = valid.length && dates.length
    ? await roster.resolveDays(valid, dates[0], dates[dates.length - 1])
    : { byUser: new Map(), prefs: new Map() };

  const cells = [];
  const out = [];
  for (const x of rows) {
    const row = ws.getRow(x.r);
    const u = x.uid ? active.get(x.uid) : null;
    const days = u ? byUser.get(x.uid) : null;
    const changedCols = [];
    let newShift;
    const shiftRaw = row.getCell(FIXED_COLS.length).value;
    const shift = parseShift(shiftRaw);
    if (shift === undefined) addErr(x.r, FIXED_COLS.length, 'Shift must be a 30-minute slot, e.g. 10:00 AM');
    else if (u && shift !== '') {
      const def = prefs.get(x.uid)?.default_shift_start || attendancePref.DEFAULT_SHIFT;
      if (shift !== def) newShift = shift;
    }
    let woCount = 0; let prCount = 0; let shiftDays = 0; let shiftCells = 0;
    for (const { col, date } of dateCols) {
      const v = cellText(row.getCell(col).value);
      const t = typeof v === 'string' ? v.toUpperCase() : '';
      if (t === '') continue; // blank = no change
      const cur = days ? days[date] : null;
      // Approved full-day leave: the template pre-fills LV / SL (or the WO) — left alone it is skipped.
      if (cur && cur.locked) { if (t !== cur.type) addErr(x.r, col, 'Locked: approved leave'); continue; }
      if (!roster.DAY_TYPES.includes(t)) { addErr(x.r, col, 'Use PR or WO'); continue; }
      if (!days) continue;
      const typeChanged = cur.type !== t;
      const shiftChanged = newShift !== undefined && t === 'PR' && cur.shift !== newShift;
      if (!typeChanged && !shiftChanged) continue;
      const cellShift = newShift !== undefined && t === 'PR' ? newShift : undefined;
      if (cellShift) shiftCells++;
      cells.push({ userId: x.uid, date, dayType: t, shift: cellShift });
      if (typeChanged) { changedCols.push(col); if (t === 'WO') woCount++; else prCount++; }
      else shiftDays++;
    }
    if (shiftCells) changedCols.push(FIXED_COLS.length);
    const rowErrors = [...errors.entries()].filter(([k]) => k.startsWith(`${x.r}:`)).map(([, m]) => m);
    const parts = [];
    if (woCount) parts.push(`${woCount} Day${woCount > 1 ? 's' : ''} → WO`);
    if (prCount) parts.push(`${prCount} Day${prCount > 1 ? 's' : ''} → PR`);
    if (shiftCells) parts.push(`Shift → ${shift12(newShift)}${shiftDays ? ` (${shiftDays} More Day${shiftDays > 1 ? 's' : ''})` : ''}`);
    out.push({
      row_number: x.r,
      name: u ? u.user_name : (x.name || '—'),
      emp_code: u ? u.user_code || null : null,
      outcome: rowErrors.length ? 'blocked' : parts.length ? 'update' : 'unchanged',
      errors: rowErrors,
      changes: parts.join(' · '),
      changed_cols: changedCols,
    });
  }
  const headerErrors = [...errors.entries()].filter(([k]) => k.startsWith('1:')).map(([, m]) => m);
  return { errors, headerErrors, rows: out, cells, dateCols, lastCol };
}

/** The sheet as the operator uploaded it, for the in-dialog grid (values + error/changed marks). */
function sheetView(ws, v) {
  const toText = (c) => { const t = cellText(c.value); return t instanceof Date ? t.toISOString().slice(11, 16) : String(t); };
  const headers = [];
  for (let c = 1; c <= v.lastCol; c++) headers.push(toText(ws.getRow(1).getCell(c)));
  const byRow = new Map(v.rows.map((r) => [r.row_number, r]));
  const errs = {};
  for (const [k, m] of v.errors) errs[k] = m;
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, r) => {
    if (r === 1 || !byRow.has(r)) return;
    const cells = [];
    for (let c = 1; c <= v.lastCol; c++) cells.push(toText(row.getCell(c)));
    rows.push({ rowNumber: r, cells, changedCols: byRow.get(r).changed_cols });
  });
  return { headers, rows, errors: errs };
}

async function dryRun({ actorId, isAdmin, buffer }) {
  const { ws } = await loadSheet(buffer);
  const v = await validateSheet(ws, { actorId, isAdmin });
  // A bad date header blocks the whole file — surfaced as its own blocked row
  // so the dialog's "any blocked row disables Confirm & Save" rule covers it.
  const rows = v.headerErrors.length
    ? [{ row_number: 1, name: 'Date Headers', emp_code: null, outcome: 'blocked', errors: v.headerErrors, changes: '', changed_cols: [] }, ...v.rows]
    : v.rows;
  const blocked = rows.filter((r) => r.outcome === 'blocked').length;
  return {
    rows,
    summary: {
      employees: v.rows.length,
      toUpdate: v.rows.filter((r) => r.outcome === 'update').length,
      unchanged: v.rows.filter((r) => r.outcome === 'unchanged').length,
      blocked,
      changedCells: v.cells.length,
      headerErrors: v.headerErrors.length,
    },
    headerErrors: v.headerErrors,
    sheet: sheetView(ws, v),
  };
}

/** The uploaded file back, error cells filled red with the reason as a cell note. */
async function errorSheet({ actorId, isAdmin, buffer }) {
  const { wb, ws } = await loadSheet(buffer);
  const v = await validateSheet(ws, { actorId, isAdmin });
  for (const [k, msg] of v.errors) {
    const [r, c] = k.split(':').map(Number);
    const cell = ws.getRow(r).getCell(c);
    cell.fill = ERROR_FILL;
    cell.note = msg;
  }
  return { buffer: await wb.xlsx.writeBuffer(), errorCount: v.errors.size };
}

async function commit({ actorId, isAdmin, buffer }) {
  const { ws } = await loadSheet(buffer);
  const v = await validateSheet(ws, { actorId, isAdmin });
  if (v.errors.size) throw mkErr(400, `${v.errors.size} error${v.errors.size > 1 ? 's' : ''} in the file — fix them and upload again`);
  if (!v.cells.length) return { changedCells: 0, employees: 0 };
  const userIds = [...new Set(v.cells.map((c) => c.userId))];
  const empCodes = new Map((await roster.loadActiveUsers(userIds)).map((u) => [Number(u.user_id), u.user_code || null]));
  const dates = v.cells.map((c) => c.date).sort();
  await roster.inTransaction(async (conn) => {
    const actionId = await roster.insertAction(conn, {
      action: 'BULK_UPLOAD', actorId, users: userIds.length, cells: v.cells.length,
      scope: `${roster.rangeLabel(dates[0], dates[dates.length - 1])} · Bulk Upload`,
    });
    await roster.applyCells(conn, { actorId, actionId, source: 'UPLOAD', cells: v.cells, empCodes });
  });
  logger.info('Roster bulk upload · actor=' + actorId + ' · users=' + userIds.length + ' · cells=' + v.cells.length);
  return { changedCells: v.cells.length, employees: userIds.length };
}

module.exports = { buildTemplate, dryRun, errorSheet, commit, parseShift, datesForMonths, SHIFT_LIST };
