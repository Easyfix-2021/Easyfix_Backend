/*
 * QuickSight Custom Reports — the pure logic, no database.
 *
 * What an operator relies on: a file matching the definition parses to the
 * same rows whether it is .xlsx or .csv, a wrong header is refused by name,
 * Excel dates do not drift a day, a DOWNLOADED report re-uploads as-is, keys
 * survive a rename, the retention purge can never select a report's current
 * upload, and the audience/ownership rules.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');

const service = require('../services/quicksight/quicksight-dynamic-reports.service');

const {
  normalizeColumns, normalizeChart, parseUpload, pageRows, chartData, purgeQuery,
  canSee, canEdit, canTransferOwner, sameColumns, reportWorkbook,
} = service._internal;

const COLUMNS = [
  { key: 'c1', name: 'Name', type: 'text' },
  { key: 'c2', name: 'Amount', type: 'number' },
  { key: 'c3', name: 'Visit Date', type: 'date' },
];

async function xlsxBuffer(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const status400 = (re) => (err) => err.status === 400 && re.test(err.message);

test('xlsx and csv of the same data parse to the same rows (dates do not drift)', async () => {
  const xlsx = await xlsxBuffer([
    ['Visit Date', 'Name', 'Amount'],                           // order-insensitive header
    [new Date(Date.UTC(2026, 8, 1)), 'Asha', 1200.5],
    [new Date(Date.UTC(2026, 11, 31)), 'Ravi', 30],
  ]);
  const csv = Buffer.from('﻿visit date,NAME,amount\r\n01-09-2026,Asha,"1,200.5"\r\n2026-12-31,Ravi,30\r\n');
  const fromXlsx = await parseUpload(xlsx, 'data.xlsx', COLUMNS);
  const fromCsv = await parseUpload(csv, 'data.csv', COLUMNS);
  const expected = [['Asha', 1200.5, '2026-09-01'], ['Ravi', 30, '2026-12-31']];
  assert.deepEqual(fromXlsx.rows, expected);
  assert.deepEqual(fromCsv.rows, expected);
});

test('a CSV date is read day-first, never guessed as US month-first', async () => {
  const csv = Buffer.from('Name,Amount,Visit Date\nA,1,03-04-2026\n');
  const { rows } = await parseUpload(csv, 'x.csv', COLUMNS);
  assert.equal(rows[0][2], '2026-04-03');
});

test('a header mismatch is refused, naming the missing and the unexpected column', async () => {
  const buf = await xlsxBuffer([['Name', 'Amt', 'Visit Date'], ['A', 1, '2026-01-01']]);
  await assert.rejects(parseUpload(buf, 'x.xlsx', COLUMNS), status400(/missing column: Amount; unexpected column: Amt/));
});

test('a cell that is not its column type is refused with its sheet row number', async () => {
  const buf = await xlsxBuffer([['Name', 'Amount', 'Visit Date'], ['A', 'twelve', '2026-02-30']]);
  await assert.rejects(parseUpload(buf, 'x.xlsx', COLUMNS),
    status400(/row 2, Amount: "twelve" is not a number; row 2, Visit Date: "2026-02-30" is not a date/));
});

test('blank rows are skipped and an empty file is refused', async () => {
  const buf = await xlsxBuffer([['Name', 'Amount', 'Visit Date'], [null, null, null], ['A', null, null]]);
  assert.deepEqual((await parseUpload(buf, 'x.xlsx', COLUMNS)).rows, [['A', null, null]]);
  const empty = await xlsxBuffer([['Name', 'Amount', 'Visit Date']]);
  await assert.rejects(parseUpload(empty, 'x.xlsx', COLUMNS), status400(/no data rows/));
});

test('a downloaded report (title bands above the header) re-uploads to the same rows', async () => {
  const rows = [['Asha', 1200.5, '2026-09-01'], ['Ravi', null, null]];
  const wb = reportWorkbook('Visits', COLUMNS, rows, 'Uploaded 2026-09-23 10:00:00 · 2 rows');
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  assert.deepEqual((await parseUpload(buf, 'visits.xlsx', COLUMNS)).rows, rows);
});

test('column keys survive a rename; new columns get fresh keys; duplicates are refused', () => {
  const next = normalizeColumns([
    { key: 'c2', name: 'Total Amount', type: 'number' },     // renamed, reordered
    { key: 'c1', name: 'Name', type: 'text' },
    { name: 'Region', type: 'text' },                         // new
    { key: 'c99', name: 'Forged', type: 'text' },            // unknown key → treated as new
  ], COLUMNS);
  assert.deepEqual(next.map((c) => c.key), ['c2', 'c1', 'c4', 'c5']);
  assert.throws(() => normalizeColumns([{ name: 'A', type: 'text' }, { name: ' a ', type: 'text' }]), status400(/appears twice/));
});

test('Append is only allowed onto an upload with the identical column set', () => {
  assert.equal(sameColumns(COLUMNS, COLUMNS.map((c) => ({ ...c }))), true);
  assert.equal(sameColumns(COLUMNS, [COLUMNS[0], { ...COLUMNS[1], name: 'Amt' }, COLUMNS[2]]), false);
});

test('pageRows: type-aware sort with blanks last, search, paging — and never mutates the cache', () => {
  const rows = [['b', 10, null], ['a', 9, '2026-01-02'], ['c', null, '2026-01-01'], ['A2', 100, null]];
  const snapshot = JSON.stringify(rows);
  const asc = pageRows(rows, COLUMNS, { sortBy: 'c2', sortDir: 'asc' });
  assert.deepEqual(asc.rows.map((r) => r.c1), ['a', 'b', 'A2', 'c']);
  const desc = pageRows(rows, COLUMNS, { sortBy: 'c2', sortDir: 'desc' });
  assert.deepEqual(desc.rows.map((r) => r.c1), ['A2', 'b', 'a', 'c']);
  const found = pageRows(rows, COLUMNS, { q: 'a' });
  assert.deepEqual(found.rows.map((r) => r.c1), ['a', 'A2']);
  const paged = pageRows(rows, COLUMNS, { page: 2, pageSize: 3 });
  assert.equal(paged.total, 4);
  assert.deepEqual(paged.rows.map((r) => r.c1), ['A2']);
  assert.equal(JSON.stringify(rows), snapshot);
});

test('chartData: sums by X, keeps the top N and folds the rest into Others', () => {
  const chart = normalizeChart({ type: 'bar', x: 'c1', y: ['c2'], agg: 'sum' }, COLUMNS);
  const rows = [];
  for (let i = 0; i < 25; i += 1) rows.push([`n${i}`, i, null]);
  rows.push(['n24', 1, null]);
  const out = chartData(rows, COLUMNS, chart);
  assert.equal(out.points.length, 20);
  assert.deepEqual(out.points[0], { x: 'n24', c2: 25 });
  assert.deepEqual(out.points[19], { x: 'Others', c2: 0 + 1 + 2 + 3 + 4 + 5 });
  assert.deepEqual(out.series, [{ key: 'c2', name: 'Amount' }]);
});

test('chart validation: X cannot be a number column, values must be number columns', () => {
  assert.throws(() => normalizeChart({ type: 'bar', x: 'c2', y: ['c2'], agg: 'sum' }, COLUMNS), status400(/X axis/));
  assert.throws(() => normalizeChart({ type: 'bar', x: 'c1', y: ['c3'], agg: 'sum' }, COLUMNS), status400(/Number columns/));
  assert.deepEqual(normalizeChart({ type: 'pie', x: 'c3', y: ['c2'], agg: 'count' }, COLUMNS),
    { type: 'pie', x: 'c3', y: [], agg: 'count' });
});

test('retention purge never selects the current upload of an active report', () => {
  const cutoff = new Date('2026-08-24T00:00:00Z');
  const { sql, params } = purgeQuery(cutoff, 200);
  assert.deepEqual(params, [cutoff, 200]);
  const flat = sql.replace(/\s+/g, ' ');
  assert.match(flat, /up\.uploaded_at < \?/);
  assert.match(flat, /r\.is_active = 0 OR up\.id <> \(SELECT MAX\(u2\.id\) FROM tbl_qs_dynamic_report_upload u2 WHERE u2\.report_id = up\.report_id\)/);
});

test('audience and ownership', () => {
  const report = { created_by: 7 };
  const viewer = { userId: 1, roleId: 5, isAdmin: false, canManage: false };
  const owner = { userId: 7, roleId: 9, isAdmin: false, canManage: true };
  const admin = { userId: 2, roleId: 9, isAdmin: true, canManage: false };
  assert.equal(canSee(report, [], viewer), true);            // no restriction → every viewer
  assert.equal(canSee(report, [3], viewer), false);          // restricted, role not in it
  assert.equal(canSee(report, [3, 5], viewer), true);
  assert.equal(canSee(report, [3], owner), true);            // owner always sees
  assert.equal(canSee(report, [3], admin), true);            // admin key always sees
  assert.equal(canEdit(report, viewer), false);
  assert.equal(canEdit(report, { ...viewer, canManage: true }), false);   // manage, but not owner
  assert.equal(canEdit(report, owner), true);
  assert.equal(canEdit(report, { ...owner, canManage: false }), false);   // owner without the key
  assert.equal(canEdit(report, admin), true);
});

test('transferring ownership follows the OWNER and the email allowlist, never a role', () => {
  /*
   * The case this exists for is an owner who LOST QuickSight access, so the
   * rescue must not sit behind a role grant that the same reorganisation can
   * revoke. Hence: the Admin KEY does NOT grant it, even though an admin can
   * otherwise edit, upload to and archive every report.
   */
  const report = { created_by: 7 };
  const owner    = { userId: 7, roleId: 9, isAdmin: false, canManage: true,  onOwnerAllowlist: false };
  const admin    = { userId: 2, roleId: 2, isAdmin: true,  canManage: true,  onOwnerAllowlist: false };
  const listed   = { userId: 4, roleId: 5, isAdmin: false, canManage: false, onOwnerAllowlist: true };
  const stranger = { userId: 9, roleId: 5, isAdmin: false, canManage: true,  onOwnerAllowlist: false };

  assert.equal(canTransferOwner(report, owner), true, 'the owner may hand over their own report');
  assert.equal(canTransferOwner(report, listed), true, 'a named operator may rescue any report');
  assert.equal(canTransferOwner(report, admin), false, 'the Admin key must NOT grant transfer');
  assert.equal(canTransferOwner(report, stranger), false);

  // The Admin key keeps every OTHER power over the same report.
  assert.equal(canEdit(report, admin), true);
  assert.equal(canSee(report, [3], admin), true);
  // An allowlisted rescuer outside the audience still cannot browse it — that
  // is why transferOwner() must not run the audience check.
  assert.equal(canSee(report, [3], listed), false);
});
