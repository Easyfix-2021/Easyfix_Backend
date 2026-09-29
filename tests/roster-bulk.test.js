/*
 * Team Roster → Bulk Update (services/roster-bulk.service.js). Round-trips a
 * REAL template through ExcelJS: build → edit cells → dry run / commit /
 * error sheet, against a fake pool (no DB writes).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');

const { installFakePool } = require('./helpers/fake-pool');

// 1 (TL) → 2, 3 ; 9 reports to 8 (outside 1's line).
const ADJ = [
  { user_id: 1, reporting_manager: null }, { user_id: 2, reporting_manager: 1 },
  { user_id: 3, reporting_manager: 1 }, { user_id: 8, reporting_manager: null }, { user_id: 9, reporting_manager: 8 },
];
const ALL_PR = { monday: 'PR', tuesday: 'PR', wednesday: 'PR', thursday: 'PR', friday: 'PR', saturday: 'PR', sunday: 'PR' };
let prefs = [];
let rosterRows = [];

const fake = installFakePool([
  [/FROM tbl_employee_attendance_preference/i, (sql, params) => prefs.filter((p) => params.includes(p.user_id))],
  [/FROM tbl_employee_roster\s+WHERE \(user_id, roster_date\) IN/i, () => []],
  [/FROM tbl_employee_roster\s+WHERE user_id IN/i, (sql, params) => {
    const [from, to] = params.slice(-2);
    const ids = params.slice(0, -2);
    return rosterRows.filter((r) => ids.includes(r.user_id) && r.roster_date >= from && r.roster_date <= to);
  }],
  [/INSERT INTO tbl_employee_roster_action_log/i, () => ({ insertId: 77, affectedRows: 1 })],
  [/INSERT INTO tbl_employee_roster_change_log/i, () => ({ affectedRows: 1 })],
  [/INSERT INTO tbl_employee_roster\b/i, () => ({ affectedRows: 1 })],
  [/SELECT user_id, reporting_manager/i, ADJ],
  [/SELECT user_id FROM tbl_user WHERE user_status = 1 AND user_type_id = 5/i, () => ADJ.map((r) => ({ user_id: r.user_id }))],
  [/FROM tbl_user u LEFT JOIN tbl_role r/i, (sql, params) =>
    params.filter((id) => ADJ.some((a) => a.user_id === id)).map((id) => ({ user_id: id, user_name: 'U' + id, user_code: null, reporting_manager: null, role_name: 'Ops' }))],
]);

const bulk = require('../services/roster-bulk.service');
const { currentIstMonth, shiftMonth } = require('../utils/ist-calendar');

const NEXT = shiftMonth(currentIstMonth(), 1); // always fully inside the edit window
const TL = { actorId: 1, isAdmin: false };
function reset() { fake.calls.length = 0; prefs = [{ user_id: 2, default_shift_start: '10:00:00', ...ALL_PR }, { user_id: 3, default_shift_start: '10:00:00', ...ALL_PR }]; rosterRows = []; }
const rosterWrites = () => fake.calls.filter((c) => /INSERT INTO tbl_employee_roster\b/i.test(c.sql) && !/_log/.test(c.sql));

async function template(opts = {}) {
  const { buffer } = await bulk.buildTemplate({ ...TL, months: [NEXT], ...opts });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}
const ws = (wb) => wb.getWorksheet('Roster');
const rowOf = (wb, uid) => { let hit; ws(wb).eachRow((row, r) => { if (r > 1 && Number(row.getCell(1).value) === uid) hit = r; }); return hit; };
const buf = async (wb) => Buffer.from(await wb.xlsx.writeBuffer());

test('parseShift: 12-hour, 24-hour and Excel time values; 30-minute slots only', () => {
  assert.equal(bulk.parseShift('10:00 AM'), '10:00');
  assert.equal(bulk.parseShift('1:30 pm'), '13:30');
  assert.equal(bulk.parseShift('13:30'), '13:30');
  assert.equal(bulk.parseShift('12:00 AM'), '00:00');
  assert.equal(bulk.parseShift(0.5), '12:00');
  assert.equal(bulk.parseShift(''), '');
  assert.equal(bulk.parseShift('10:15'), undefined);
  assert.equal(bulk.parseShift('25:00'), undefined);
});

test('the template lists the TL\'s team (never themselves, never another line), pre-filled', async () => {
  reset();
  prefs[0].sunday = 'WO';
  const wb = await template();
  const ids = [];
  ws(wb).eachRow((row, r) => { if (r > 1) ids.push(Number(row.getCell(1).value)); });
  assert.deepEqual(ids.sort(), [2, 3]);
  const header = ws(wb).getRow(1).values.slice(6);
  assert.match(header[0], /^\d{2}\/\d{2}\/\d{4} \((Mon|Tue|Wed|Thu|Fri|Sat|Sun)\)$/);
  const r2 = ws(wb).getRow(rowOf(wb, 2));
  assert.equal(r2.getCell(5).value, '10:00 AM');
  const sunCol = header.findIndex((h) => h.endsWith('(Sun)')) + 6;
  assert.equal(r2.getCell(sunCol).value, 'WO', 'weekly WO pre-filled');
});

test('an untouched template is a no-op: dry run shows nothing to change, commit writes nothing', async () => {
  reset();
  const file = await buf(await template());
  const d = await bulk.dryRun({ ...TL, buffer: file });
  assert.equal(d.summary.changedCells, 0);
  assert.ok(d.rows.every((r) => r.outcome === 'unchanged'));
  await bulk.commit({ ...TL, buffer: file });
  assert.equal(rosterWrites().length, 0);
});

test('only changed cells are saved; a changed Shift applies to PR days', async () => {
  reset();
  const wb = await template();
  const r2 = ws(wb).getRow(rowOf(wb, 2));
  r2.getCell(6).value = 'WO';          // first date → WO
  const r3 = ws(wb).getRow(rowOf(wb, 3));
  r3.getCell(5).value = '01:00 PM';    // shift change for user 3
  const file = await buf(wb);

  const d = await bulk.dryRun({ ...TL, buffer: file });
  const days = ws(wb).getRow(1).cellCount - 5;
  assert.equal(d.summary.changedCells, 1 + days);
  assert.equal(d.rows.find((r) => r.name === 'U2').changes, '1 Day → WO');
  assert.match(d.rows.find((r) => r.name === 'U3').changes, /^Shift → 01:00 PM/);
  assert.deepEqual(d.sheet.rows.find((r) => r.cells[0] === '2').changedCols, [6]);

  await bulk.commit({ ...TL, buffer: file });
  const params = rosterWrites().flatMap((c) => c.params);
  const u2 = []; for (let i = 0; i < params.length; i += 8) if (params[i] === 2) u2.push(params.slice(i, i + 8));
  assert.equal(u2.length, 1, 'user 2: just the one edited day');
  assert.equal(u2[0][3], 'WO');
  assert.equal(u2[0][5], 'UPLOAD');
});

test('an unchanged Shift never overwrites an existing per-day shift', async () => {
  reset();
  const wb0 = await template();
  const firstDate = ws(wb0).getRow(1).getCell(6).value.replace(/^(\d{2})\/(\d{2})\/(\d{4}).*$/, '$3-$2-$1');
  rosterRows = [{ user_id: 2, roster_date: firstDate, day_type: 'PR', shift_start: '09:00', source: 'GRID' }];
  const d = await bulk.dryRun({ ...TL, buffer: await buf(await template()) });
  assert.equal(d.summary.changedCells, 0);
});

test('errors are reported per cell and block Confirm & Save; the error sheet paints them red', async () => {
  reset();
  const wb = await template();
  const sheet = ws(wb);
  const r2 = rowOf(wb, 2); // before the duplicate row is added
  sheet.getRow(r2).getCell(7).value = 'XX';
  sheet.getRow(rowOf(wb, 3)).getCell(5).value = '10:15';
  sheet.addRow([9, '', 'U9', 'Ops', '10:00 AM']);   // another TL's member
  sheet.addRow([1, '', 'U1', 'Ops', '10:00 AM']);   // the TL themselves
  sheet.addRow([2, '', 'U2', 'Ops', '10:00 AM']);   // duplicate
  const file = await buf(wb);

  const d = await bulk.dryRun({ ...TL, buffer: file });
  const errs = Object.values(d.sheet.errors);
  assert.ok(errs.includes('Use PR or WO'));
  assert.ok(errs.includes('Shift must be a 30-minute slot, e.g. 10:00 AM'));
  assert.ok(errs.includes('Not in your team'));
  assert.ok(errs.includes('You cannot plan your own roster'));
  assert.ok(errs.some((e) => e.startsWith('Duplicate')));
  assert.equal(d.sheet.errors[`${r2}:7`], 'Use PR or WO', 'keyed by the exact sheet cell');
  assert.ok(d.summary.blocked >= 4);

  await assert.rejects(bulk.commit({ ...TL, buffer: file }), (e) => e.status === 400);
  assert.equal(rosterWrites().length, 0);

  const out = await bulk.errorSheet({ ...TL, buffer: file });
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(out.buffer);
  const cell = back.getWorksheet('Roster').getRow(r2).getCell(7);
  assert.equal(cell.fill.fgColor.argb, 'FFF8B4B4');
  assert.match(String(cell.note.texts ? cell.note.texts.map((t) => t.text).join('') : cell.note), /PR or WO/);
});

test('a date column outside the edit window is rejected at the header', async () => {
  reset();
  const wb = await template();
  ws(wb).getRow(1).getCell(6).value = '01/01/2020 (Wed)';
  const d = await bulk.dryRun({ ...TL, buffer: await buf(wb) });
  assert.match(d.sheet.errors['1:6'], /^Not editable/);
  assert.equal(d.headerErrors.length, 1);
  assert.equal(d.rows[0].outcome, 'blocked', 'a header error blocks Confirm & Save in the dialog too');
  await assert.rejects(bulk.commit({ ...TL, buffer: await buf(wb) }), (e) => e.status === 400);
});
