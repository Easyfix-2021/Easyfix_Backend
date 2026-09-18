/*
 * QuickSight — Employee Performance: Excel upload → check → save → load.
 *
 * No database. The fake pool (tests/helpers/fake-pool.js) is backed by a tiny
 * in-memory copy of the tbl_qs_ep_* tables that answers exactly the statements
 * uploads.service.js issues — so "a date is replaced, the other dates stay" is
 * proved on stored rows, not on SQL text.
 *
 * What must hold, worst first:
 *   - an ERROR anywhere blocks the save; a WARNING (person not on that month's
 *     emp detail, a date in the future) does not;
 *   - emp detail is checked against the CRM's own users: a name no user has and
 *     an inactive user warn, two rows the CRM reads as ONE name block;
 *   - TimeChamp / IVR: each date in the file replaces that date only;
 *   - monthly sheets: a repeated key in the file is rejected, rows not in the
 *     file stay, and a person's target saved under another of their names is
 *     replaced rather than added to;
 *   - no tables yet → 503 "storage is not set up" for preview and save, and
 *     empty inputs (not an error) for the dashboard;
 *   - loadUploads() produces what compose() takes — fed straight into compose
 *     here — and resolves people exactly as fromWorkbookSheets does.
 *
 * Runner: TZ=UTC node --test-reporter=spec --test-force-exit tests/quicksight-ep-uploads.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');

const { makeFakePool } = require('./helpers/fake-pool');
const { buildUploadTemplate } = require('../services/quicksight/employee-performance/upload-template');
const {
  parseUpload, previewUpload, commitUpload, loadUploads, STORAGE_MISSING_MESSAGE, _internals: I,
} = require('../services/quicksight/employee-performance/uploads.service');
const { compose, fromWorkbookSheets } = require('../services/quicksight/employee-performance/compose');

const NOW = new Date('2026-09-10T06:00:00Z');   // 10 Sep 2026 IST
const d = (ymd) => new Date(`${ymd}T00:00:00.000Z`);   // an Excel date cell, as exceljs writes it

/* ── the in-memory tables behind the fake pool ───────────────────────────── */

const cmp = (...keys) => (a, b) => {
  for (const k of keys) {
    if (a[k] < b[k]) return -1;
    if (a[k] > b[k]) return 1;
  }
  return 0;
};

/*
 * The internal CRM users the emp detail names are checked against. `users` may
 * be a function so a test can make that one read fail without touching the rest.
 */
const CRM_USERS = [
  { user_name: 'Tara Quill ', user_status: 1 },   // the CRM's own trailing space
  { user_name: 'Bram', user_status: 1 },
  { user_name: 'Cyra', user_status: 1 },
  { user_name: 'Johan', user_status: 1 },
  { user_name: 'Neha', user_status: 1 },
  { user_name: 'Harshit Bhardwaj', user_status: 1 },
];

function makeStore({ tablesPresent = true, lock = 1, users = CRM_USERS } = {}) {
  const t = { batch: [], roster: new Map(), primary: new Map(), secondary: new Map(), timechamp: [], ivr: [] };
  const absent = () => Object.assign(new Error("Table 'easyfix.tbl_qs_ep_roster' doesn't exist"),
    { code: 'ER_NO_SUCH_TABLE', errno: 1146 });
  const guard = (fn) => (sql, params) => {
    if (!tablesPresent) throw absent();
    return fn(sql, params);
  };
  const inRanges = (date, params) => {
    for (let i = 0; i < params.length; i += 2) if (date >= params[i] && date < params[i + 1]) return true;
    return false;
  };
  const upsert = (map, keyOf, row, keep = []) => {
    const k = keyOf(row);
    const prev = map.get(k);
    map.set(k, prev ? { ...row, ...Object.fromEntries(keep.map((f) => [f, prev[f]])) } : row);
  };
  const routes = [
    [/GET_LOCK/, [{ acquired: lock }]],
    [/RELEASE_LOCK/, [{ released: 1 }]],
    [/information_schema\.tables/, () => (tablesPresent ? Object.values(I.TABLES).map((name) => ({ name })) : [])],
    [/FROM tbl_user/, () => (typeof users === 'function' ? users() : users)],
    [/INSERT INTO tbl_qs_ep_upload_batch/, guard((sql, p) => {
      t.batch.push(p);
      return { insertId: t.batch.length };
    })],
    [/INSERT INTO tbl_qs_ep_roster/, guard((sql, [rows]) => {
      for (const r of rows) {
        upsert(t.roster, (x) => `${x.month}|${x.crm_key}`, { month: r[0], crm_key: r[1], crm_name: r[2], emp_id: r[3],
          employee_name: r[4], row_labels: r[5], vertical: r[6], team_name: r[7], row_no: r[8], batch_id: r[9] }, ['row_no']);
      }
      return { affectedRows: rows.length };
    })],
    [/INSERT INTO tbl_qs_ep_primary_target/, guard((sql, [rows]) => {
      for (const r of rows) {
        upsert(t.primary, (x) => `${x.month}|${x.person_key}`, { month: r[0], person_key: r[1], person_name: r[2],
          target_amount: r[3], daily_target: r[4], row_no: r[5], batch_id: r[6] });
      }
      return {};
    })],
    [/INSERT INTO tbl_qs_ep_secondary_target/, guard((sql, [rows]) => {
      for (const r of rows) {
        upsert(t.secondary, (x) => `${x.month}|${x.person_key}`, { month: r[0], person_key: r[1], person_name: r[2],
          total_target: r[3], row_no: r[4], batch_id: r[5] });
      }
      return {};
    })],
    [/INSERT INTO tbl_qs_ep_timechamp_daily/, guard((sql, [rows]) => {
      for (const r of rows) {
        t.timechamp.push({ work_date: r[0], name_key: r[1], employee_id: r[2], employee_name: r[3], working_hours: r[4],
          productive_hours: r[5], away_hours: r[6], batch_id: r[7] });
      }
      return {};
    })],
    [/INSERT INTO tbl_qs_ep_ivr_daily/, guard((sql, [rows]) => {
      for (const r of rows) {
        t.ivr.push({ call_date: r[0], agent_key: r[1], agent_name: r[2], incoming_calls: r[3], outgoing_calls: r[4],
          missed_calls: r[5], avg_handling_secs: r[6], batch_id: r[7] });
      }
      return {};
    })],
    [/DELETE FROM tbl_qs_ep_primary_target/, guard((sql, [month, keys]) => {
      for (const k of keys) t.primary.delete(`${month}|${k}`);
      return {};
    })],
    [/DELETE FROM tbl_qs_ep_secondary_target/, guard((sql, [month, keys]) => {
      for (const k of keys) t.secondary.delete(`${month}|${k}`);
      return {};
    })],
    [/DELETE FROM tbl_qs_ep_timechamp_daily/, guard((sql, [dates]) => {
      t.timechamp = t.timechamp.filter((r) => !dates.includes(r.work_date));
      return {};
    })],
    [/DELETE FROM tbl_qs_ep_ivr_daily/, guard((sql, [dates]) => {
      t.ivr = t.ivr.filter((r) => !dates.includes(r.call_date));
      return {};
    })],
    [/FROM tbl_qs_ep_roster/, guard((sql, [months]) => [...t.roster.values()]
      .filter((r) => months.includes(r.month)).sort(cmp('month', 'row_no', 'crm_key')))],
    [/FROM tbl_qs_ep_primary_target/, guard((sql, [months]) => [...t.primary.values()]
      .filter((r) => months.includes(r.month)).sort(cmp('month', 'row_no', 'person_key')))],
    [/FROM tbl_qs_ep_secondary_target/, guard((sql, [months]) => [...t.secondary.values()]
      .filter((r) => months.includes(r.month)).sort(cmp('month', 'row_no', 'person_key')))],
    [/FROM tbl_qs_ep_timechamp_daily/, guard((sql, params) => t.timechamp
      .filter((r) => inRanges(r.work_date, params)).sort(cmp('work_date', 'name_key')))],
    [/FROM tbl_qs_ep_ivr_daily/, guard((sql, params) => t.ivr
      .filter((r) => inRanges(r.call_date, params)).sort(cmp('call_date', 'agent_key')))],
  ];
  const fake = makeFakePool(routes);
  return { db: fake.pool, calls: fake.calls, t };
}

/* ── building upload files ───────────────────────────────────────────────── */

/**
 * The real template with `rows` pasted under each sheet's header, as objects
 * keyed by header. `headers` replaces a sheet's header row (to break it).
 */
async function uploadFile(rows = {}, { headers = {}, drop = [], now = NOW } = {}) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await buildUploadTemplate({ now }).xlsx.writeBuffer());
  for (const name of drop) wb.removeWorksheet(wb.getWorksheet(name).id);
  for (const [name, list] of Object.entries(headers)) {
    const ws = wb.getWorksheet(name);
    ws.spliceRows(1, 1, list);
  }
  for (const [name, list] of Object.entries(rows)) {
    const ws = wb.getWorksheet(name);
    const head = [];
    ws.getRow(1).eachCell({ includeEmpty: false }, (c, col) => { head[col] = String(c.value); });
    list.forEach((obj, i) => {
      for (const [h, v] of Object.entries(obj)) {
        const col = head.indexOf(h);
        assert.ok(col > 0, `test file: no column '${h}' in '${name}'`);
        const cell = ws.getRow(i + 2).getCell(col);
        if (v && v.numFmt) {            // { value, numFmt }: override the template's column format
          cell.value = v.value;
          cell.numFmt = v.numFmt;
        } else {
          cell.value = v;
        }
      }
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Template for NOW (September): emp detail's month columns are Aug and Sep.
const emp = (crm, extra = {}) => ({ 'EMP ID': extra.id || '', 'EMPLOYE NAME': extra.name || '', 'CRM CURRENT NAME': crm,
  'Row Labels': extra.label || '', vertical: extra.vertical === undefined ? 'Furniture' : extra.vertical,
  'Team Name Aug': extra.aug === undefined ? 'Alpha' : extra.aug, 'Team Name Sep': extra.sep === undefined ? 'Alpha' : extra.sep });
const tc = (date, id, name, working = 8, productive = 7.5, away = 0.5) => ({ 'Employee Id': id, 'Employee Name': name,
  'Working Hours': working, 'Productive Hours': productive, 'Away Hours': away, Date: d(date) });
const ivrRow = (date, agent, incoming = 5, outgoing = 10, missed = 1, aht = 120.5) => ({ 'Agent Name': agent,
  'Total Incoming Calls': incoming, 'Total Outgoing Calls': outgoing, 'Total Missed Calls': missed,
  'Avg Handling Time': aht, Date: d(date) });

const TEAM = [
  emp('Tara Quill', { id: 'E900001', name: 'Tara Q', label: 'Tara' }),
  emp('Bram', { id: 'E900002', name: 'Bram Oakes', label: 'B', aug: 'Bravo', sep: 'Alpha' }),
];

const sheetOf = (report, name) => report.sheets.find((s) => s.name === name);
const messages = (report, name, kind) => sheetOf(report, name)[kind].map((i) => i.message);

/* ── cells ───────────────────────────────────────────────────────────────── */

test('exceljs cells become the pandas cells compose.js reads', () => {
  assert.deepEqual(I.readCell(new Date('2026-08-01T00:00:00Z')), { kind: 'date', value: { $dt: '2026-08-01 00:00:00' } });
  assert.deepEqual(I.readCell(new Date('1899-12-30T12:30:00Z')), { kind: 'time', value: { $time: '12:30:00' } });
  assert.deepEqual(I.readCell({ formula: 'A1*2', result: 6.5 }), { kind: 'number', value: 6.5 });
  assert.deepEqual(I.readCell({ richText: [{ text: 'Tara ' }, { text: 'Quill' }] }), { kind: 'text', value: 'Tara Quill' });
  assert.deepEqual(I.readCell({ formula: 'VLOOKUP()', result: { error: '#N/A' } }), { kind: 'error', value: '#N/A' });
  assert.equal(I.readCell('N/A').kind, 'blank', "pandas' default NA strings are blank");
  assert.equal(I.readCell(null).kind, 'blank');
});

test('a month name means the nearest such month, 8 back to 3 ahead of the IST month', () => {
  assert.equal(I.monthForNumber(8, NOW), '2026-08');
  assert.equal(I.monthForNumber(12, NOW), '2026-12');
  assert.equal(I.monthForNumber(1, NOW), '2026-01');
  assert.equal(I.monthForNumber(12, new Date('2027-01-05T06:00:00Z')), '2026-12');
  assert.equal(I.monthForNumber(3, new Date('2027-01-05T06:00:00Z')), '2027-03');
});

/* ── the zip, before ExcelJS decompresses it ─────────────────────────────── */

/*
 * The upload route's multer cap bounds the COMPRESSED .xlsx only, and
 * wb.xlsx.load() inflates the whole workbook before any row limit here applies
 * — so a file inside the cap used to be able to expand to gigabytes and take
 * the process down (an ERR_STRING_TOO_LONG thrown from ExcelJS's stream
 * callback, outside the promise, which the try/catch around the load never
 * sees). inspectArchive refuses those from the zip's own central directory,
 * before anything is decompressed.
 *
 * The fixtures are built here rather than committed: every one of them is a
 * few hundred bytes on disk that CLAIMS to be, or really is, hundreds of
 * megabytes. Entry CRCs are left zero on purpose — no hostile fixture below
 * ever reaches ExcelJS, each is refused before that, and the honest workbook in
 * the first test is the real template ExcelJS itself wrote.
 */

const zlib = require('node:zlib');

const MB = 1024 * 1024;
const LIMITS = I.ARCHIVE_LIMITS;

/**
 * A zip of `entries`, each { name, data | body, method, declaredUncompressed,
 * declaredCompressed } — the declared sizes are separate from the real bytes so
 * a fixture can lie about itself the way a bomb does. `declaredEntryCount`
 * makes the end-of-central-directory record disagree with the directory.
 */
function makeZip(entries, { declaredEntryCount = entries.length } = {}) {
  const parts = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.method === undefined ? 8 : e.method;
    const name = Buffer.from(e.name, 'utf8');
    const body = e.body !== undefined ? e.body : (method === 0 ? e.data : zlib.deflateRawSync(e.data));
    const unc = e.declaredUncompressed !== undefined ? e.declaredUncompressed : (e.data ? e.data.length : 0);
    const comp = e.declaredCompressed !== undefined ? e.declaredCompressed : body.length;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);          // local file header signature
    local.writeUInt16LE(20, 4);                  // version needed
    local.writeUInt16LE(e.flags || 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(comp, 18);
    local.writeUInt32LE(unc, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    parts.push(local, body);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);        // central directory header signature
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.flags || 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(comp, 20);
    central.writeUInt32LE(unc, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);           // where the local header is
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);             // end of central directory signature
  eocd.writeUInt16LE(declaredEntryCount, 8);
  eocd.writeUInt16LE(declaredEntryCount, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, eocd]);
}

/** A raw deflate stream that really expands to `bytes`, never held in memory. */
async function reallyExpandsTo(bytes) {
  const chunk = Buffer.alloc(MB, ' ');
  const out = [];
  const z = zlib.createDeflateRaw({ level: 6 });
  z.on('data', (d) => out.push(d));
  const ended = new Promise((res) => z.on('end', res));
  for (let written = 0; written < bytes;) {
    const take = Math.min(chunk.length, bytes - written);
    written += take;
    if (!z.write(take === chunk.length ? chunk : chunk.subarray(0, take))) {
      await new Promise((res) => z.once('drain', res));
    }
  }
  z.end();
  await ended;
  return Buffer.concat(out);
}

const sheetPart = (n, declaredUncompressed) => ({ name: `xl/worksheets/sheet${n}.xml`,
  data: Buffer.from('<worksheet/>'), declaredUncompressed });

const refusal = async (buffer) => {
  const err = await parseUpload(buffer, { now: NOW }).then(() => null, (e) => e);
  assert.ok(err, 'the file was accepted');
  return err;
};

test('the real template is measured exactly and passes with room to spare', async () => {
  const file = await uploadFile({ 'emp detail': TEAM, 'time champ data': [tc('2026-09-01', 'E900001', 'Tara Q')] });
  const m = I.inspectArchive(file);
  // Pass 1 reads the file's claim, pass 3 inflates and counts: for a workbook
  // ExcelJS wrote they are the same number, which is what "does not lie" means.
  assert.equal(m.declaredBytes, m.expandedBytes);
  assert.ok(m.expandedBytes < LIMITS.MAX_UNCOMPRESSED_TOTAL / 10,
    `the filled template expands to ${m.expandedBytes} bytes, too close to the ${LIMITS.MAX_UNCOMPRESSED_TOTAL} ceiling`);
  assert.ok(m.sheetParts > 0 && m.sheetParts <= LIMITS.MAX_SHEET_PARTS);
  assert.ok(m.entries > 0 && m.entries <= LIMITS.MAX_ZIP_ENTRIES);

  // …and the same file still goes through the whole upload unchanged.
  const { db } = makeStore();
  const report = await previewUpload(file, { db, now: NOW });
  assert.equal(report.blocking, false, JSON.stringify(report.sheets.flatMap((s) => s.errors)));
  assert.equal(sheetOf(report, 'emp detail').rows, 2);
  assert.equal(sheetOf(report, 'time champ data').rows, 1);
});

test('a workbook whose declared expansion exceeds the ceiling is refused, naming both sizes', async () => {
  // Four parts of 40 MB each: every one inside the per-part limit, the total not.
  const buffer = makeZip([1, 2, 3, 4].map((n) => sheetPart(n, 40 * MB)));
  assert.ok(buffer.length < 4096, 'the whole bomb is under 4 KB on the wire');
  const err = await refusal(buffer);
  assert.equal(err.status, 400);
  assert.match(err.message, /expands to 160 MB when opened, more than the 120 MB this upload allows/);
  assert.doesNotMatch(err.message, /^The file is not a readable/, 'a size refusal says what to do about it');
  // And through the route's own entry point, not only parseUpload.
  const { db } = makeStore();
  await assert.rejects(previewUpload(buffer, { db, now: NOW }), { status: 400 });
});

test('one absurdly large part is refused on its own, whatever the total says', async () => {
  const err = await refusal(makeZip([sheetPart(1, 200 * MB)]));
  assert.equal(err.status, 400);
  assert.match(err.message, /Part 'xl\/worksheets\/sheet1\.xml' of the workbook expands to 200 MB/);
  assert.match(err.message, /more than the 60 MB one sheet may use/);
});

test('a zip whose declared sizes lie is refused by the capped verification inflate', async () => {
  // 61 MB of real deflate stream behind a header claiming 8 KB — the pass that
  // believes the directory waves this through and the process dies inflating it.
  const body = await reallyExpandsTo(61 * MB);
  const buffer = makeZip([{ name: 'xl/worksheets/sheet1.xml', body, declaredUncompressed: 8 * 1024,
    declaredCompressed: body.length }]);
  assert.ok(buffer.length < MB, 'still a small file on the wire');
  const err = await refusal(buffer);
  assert.equal(err.status, 400);
  assert.match(err.message, /expands past the 120 MB this upload allows when opened/);
  assert.match(err.message, /bigger than the 8 KB its own size records claim, so they cannot be trusted/);
  assert.match(err.message, /stopped at part 'xl\/worksheets\/sheet1\.xml'/);
});

test('hostile zips are refused before ExcelJS sees them: names, counts, methods, a lying directory', async () => {
  const cases = [
    ['a traversing entry name', makeZip([{ name: '../../../etc/passwd', data: Buffer.from('x') }]),
      /escapes the archive/],
    ['an absolute entry name', makeZip([{ name: '/etc/passwd', data: Buffer.from('x') }]),
      /absolute path as an entry name/],
    ['a Windows path', makeZip([{ name: 'xl\\worksheets\\sheet1.xml', data: Buffer.from('x') }]),
      /Windows path as an entry name/],
    ['an unsupported compression method',
      makeZip([{ name: 'xl/workbook.xml', data: Buffer.from('x'), method: 12 }]),
      /compression method 12, which Excel does not write/],
    ['an encrypted entry', makeZip([{ name: 'xl/workbook.xml', data: Buffer.from('x'), flags: 0x1 }]),
      /password protected/],
    ['absurdly many sheets',
      makeZip(Array.from({ length: LIMITS.MAX_SHEET_PARTS + 1 }, (_, i) => sheetPart(i + 1))),
      new RegExp(`has ${LIMITS.MAX_SHEET_PARTS + 1} sheets, more than the ${LIMITS.MAX_SHEET_PARTS}`)],
    ['a directory that disagrees with its own count',
      makeZip([sheetPart(1)], { declaredEntryCount: 9 }), /lists 1 parts where the file declares 9/],
    ['no zip at all', Buffer.from('PK not really a zip, just the two letters'), /no zip end-of-central-directory/],
  ];
  for (const [what, buffer, expected] of cases) {
    const err = await refusal(buffer);
    assert.equal(err.status, 400, what);
    assert.match(err.message, expected, what);
  }
  // An entry count past the ceiling is refused from the end record alone, so a
  // directory claiming a million parts is never walked.
  const many = makeZip([sheetPart(1)], { declaredEntryCount: LIMITS.MAX_ZIP_ENTRIES + 1 });
  assert.match((await refusal(many)).message,
    new RegExp(`has ${LIMITS.MAX_ZIP_ENTRIES + 1} parts inside it, more than the ${LIMITS.MAX_ZIP_ENTRIES}`));
});

/* ── structure ───────────────────────────────────────────────────────────── */

test('a missing sheet or column blocks, naming it; job sheets are ignored with a note', async () => {
  const buffer = await uploadFile({}, {
    drop: ['ivr data record'],
    headers: { 'time champ data': ['Employee Id', 'Employee Name', 'Working Hours', 'Date'] },
  });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  wb.addWorksheet('Close order').getCell('A1').value = 'Primary SPOC';
  const parsed = await parseUpload(Buffer.from(await wb.xlsx.writeBuffer()), { now: NOW });
  assert.equal(parsed.blocking, true);
  assert.deepEqual(messages(parsed, 'ivr data record', 'errors'), ["Sheet 'ivr data record' is missing from the workbook."]);
  assert.deepEqual(messages(parsed, 'time champ data', 'errors'),
    ["Sheet 'time champ data' is missing column(s): Productive Hours, Away Hours"]);
  assert.match(parsed.warnings[0], /'Close order' is ignored: open jobs, closed jobs and CRM data come live/);
  await assert.rejects(parseUpload(Buffer.from('not a workbook')), { status: 400 });
});

/* ── errors block, warnings do not ───────────────────────────────────────── */

test('preview: bad cells are blocking errors; off-roster people and future dates are warnings', async () => {
  const { db } = makeStore();
  const bad = await uploadFile({
    'emp detail': TEAM,
    'time champ data': [
      tc('2026-09-01', 'E900001', 'Tara Q', '7:30'),           // text that is not a number
      { ...tc('2026-09-02', 'E900001', 'Tara Q'), Date: { value: 46266, numFmt: 'General' } },  // a bare serial
      tc('2026-09-03', 'E900001', 'Tara Q', 25),                 // more than 24 hours
    ],
    'ivr data record': [ivrRow('2026-09-01', 'Bram', 2.5)],     // half a call
    'target list': [{ 'Primary spoc': 'Tara', 'Target Amount': 'lots', 'Daily Target': 1000, month: 'Aug' }],
  });
  const report = await previewUpload(bad, { db, now: NOW });
  assert.equal(report.blocking, true);
  assert.deepEqual(messages(report, 'time champ data', 'errors'), [
    "Working Hours '7:30' is not a number",
    'Date is a plain number (46266), not a date — format the column as a date',
    'Working Hours 25 is outside 0 to 24',
  ]);
  assert.deepEqual(sheetOf(report, 'time champ data').errors.map((e) => [e.row, e.column]),
    [[2, 'Working Hours'], [3, 'Date'], [4, 'Working Hours']]);
  assert.deepEqual(messages(report, 'ivr data record', 'errors'), ['Total Incoming Calls 2.5 is not a whole number']);
  assert.deepEqual(messages(report, 'target list', 'errors'), [
    "month 'Aug' is not a month name — write it in full, e.g. August",
    "Target Amount 'lots' is not a number",
  ]);

  const warningsOnly = await uploadFile({
    'emp detail': TEAM,
    'time champ data': [tc('2026-09-01', 'E900001', 'Tara Q'), tc('2026-09-01', 'E555', 'Stranger'),
      tc('2026-09-12', 'E900002', 'Bram Oakes')],
    'ivr data record': [ivrRow('2026-09-01', 'Bram'), ivrRow('2026-09-01', ' IVR')],
    'Secondary spoc target list': [{ Name: 'Vinay', 'Total Target': 260000, month: 'September' }],
  });
  const ok = await previewUpload(warningsOnly, { db, now: NOW });
  assert.equal(ok.blocking, false, JSON.stringify(ok.sheets.flatMap((s) => s.errors)));
  assert.deepEqual(messages(ok, 'time champ data', 'warnings'), [
    'Date 2026-09-12 is in the future',
    "'Stranger' (E555) is not on September 2026's emp detail — saved, but hidden on the dashboard until they are added",
  ]);
  assert.deepEqual(messages(ok, 'ivr data record', 'warnings'),
    ["'IVR' is not on September 2026's emp detail — saved, but hidden on the dashboard until they are added"]);
  assert.deepEqual(messages(ok, 'Secondary spoc target list', 'warnings'),
    ["'Vinay' is not on September 2026's emp detail — saved, but hidden on the dashboard until they are added"]);
  const sep = ok.months.find((m) => m.month === '2026-09');
  assert.deepEqual(sep.hiddenAfterUpload, { timechamp: 1, ivr: 1, primaryTargets: 0, secondaryTargets: 1 });
  assert.deepEqual(sep.empDetail, { stored: 0, inFile: 2, added: 2, updated: 0, after: 2 });
});

test('a warning-only file saves; a blocking file is refused with the report and writes nothing', async () => {
  const store = makeStore();
  const bad = await uploadFile({ 'emp detail': TEAM, 'time champ data': [tc('2026-09-01', 'E1', 'X', -1)] });
  await assert.rejects(commitUpload(bad, { db: store.db, userId: 7, now: NOW }), (err) => {
    assert.equal(err.status, 400);
    assert.equal(err.preview.blocking, true);
    return true;
  });
  assert.equal(store.t.batch.length, 0);
  assert.equal(store.t.roster.size, 0);
  assert.ok(!store.calls.some((c) => /^\s*(INSERT|DELETE)/.test(c.sql)), 'no write was attempted');

  const empty = await uploadFile({});
  await assert.rejects(commitUpload(empty, { db: store.db, userId: 7, now: NOW }), { status: 400, message: 'The file has no rows to save' });

  const warned = await uploadFile({ 'emp detail': TEAM, 'time champ data': [tc('2026-09-01', 'E555', 'Stranger')] });
  const saved = await commitUpload(warned, { db: store.db, userId: 7, now: NOW });
  assert.equal(saved.preview.blocking, false);
  assert.equal(saved.preview.sheets.find((s) => s.name === 'time champ data').warningCount, 1);
  assert.deepEqual(store.t.timechamp.map((r) => r.employee_name), ['Stranger'], 'stored although not on emp detail');
});

/* ── emp detail against the CRM's own users ───────────────────────────────── */

test('emp detail: a name no CRM user has and an inactive one warn, from ONE read', async () => {
  const store = makeStore({ users: [
    { user_name: 'Tara Quill ', user_status: 1 },
    { user_name: 'Harshit Bhardwaj', user_status: 0 },   // left the company
    { user_name: 'Harkirpa Kaur', user_status: 1 },
  ] });
  const report = await previewUpload(await uploadFile({
    'emp detail': [
      emp('tara  quill', { id: 'E900001', name: 'Tara Q' }),   // spacing and case are not a difference
      emp('Harshit Bhardwaj', { id: 'E900002' }),
      emp('Harkripa kaur', { id: 'E900003' }),                 // the CRM spells it Harkirpa Kaur
    ],
  }), { db: store.db, now: NOW });

  assert.equal(report.blocking, false, 'who the CRM knows is never a reason to refuse the file');
  assert.deepEqual(messages(report, 'emp detail', 'warnings'), [
    "August 2026 and September 2026: CRM CURRENT NAME 'Harshit Bhardwaj' is an inactive CRM user — right if they "
    + 'have left, and the jobs they closed still count',
    "August 2026 and September 2026: CRM CURRENT NAME 'Harkripa kaur' is not a CRM user — this row's jobs and CRM "
    + 'activity are attributed to nobody; check the spelling against Manage Users',
  ]);
  assert.deepEqual(sheetOf(report, 'emp detail').warnings.map((w) => [w.row, w.column]),
    [[3, 'CRM CURRENT NAME'], [4, 'CRM CURRENT NAME']]);

  const reads = store.calls.filter((c) => /FROM tbl_user/.test(c.sql));
  assert.equal(reads.length, 1, 'one batched read for the whole sheet, never one per row');
  assert.deepEqual(reads[0].params, [[19, 20, 21]], 'technicians and client dashboard users are left out');
  assert.match(reads[0].sql, /SELECT user_name, user_status/);
  assert.ok(!/INSERT|UPDATE|DELETE/.test(reads[0].sql), 'the check only reads');
});

test('emp detail: two rows the CRM reads as ONE name block the save; one name on two months does not', async () => {
  const store = makeStore();
  const clash = await uploadFile({
    'emp detail': [
      emp('Johan', { id: 'E900003', name: 'Vineet Jangid' }),
      emp('Johan\uFEFF', { id: 'E900004', name: 'Johan Roy' }),   // a zero-width space: two people, one name
    ],
  });
  const report = await previewUpload(clash, { db: store.db, now: NOW });
  assert.equal(report.blocking, true);
  assert.deepEqual(messages(report, 'emp detail', 'errors'), [
    "August 2026 and September 2026: CRM CURRENT NAME 'Johan\uFEFF' is the same name as row 2's 'Johan' — the two "
    + 'rows would be merged into one person; keep one row per person',
  ]);
  await assert.rejects(commitUpload(clash, { db: store.db, userId: 7, now: NOW }), { status: 400 });
  assert.equal(store.t.roster.size, 0, 'nothing was saved');

  // One person on two months is the ordinary case: a two-month sheet, then a September-only one.
  await commitUpload(await uploadFile({ 'emp detail': [emp('Johan', { id: 'E900003' })] }),
    { db: store.db, userId: 7, now: NOW });
  const septemberOnly = ['EMP ID', 'EMPLOYE NAME', 'CRM CURRENT NAME', 'Row Labels', 'vertical', 'Team Name Sep'];
  const again = await uploadFile({ 'emp detail': [{ 'CRM CURRENT NAME': 'Johan', 'EMP ID': 'E900003',
    vertical: 'Furniture', 'Team Name Sep': 'Delta' }] }, { headers: { 'emp detail': septemberOnly } });
  const second = await previewUpload(again, { db: store.db, now: NOW });
  assert.equal(second.blocking, false);
  assert.deepEqual(messages(second, 'emp detail', 'errors'), []);
  await commitUpload(again, { db: store.db, userId: 7, now: NOW });
  assert.deepEqual([...store.t.roster.keys()], ['2026-08|johan', '2026-09|johan'], 'one person, two months');
});

test('the CRM user list failing leaves the whole report standing — never a 500', async () => {
  const store = makeStore({ users: () => {
    throw Object.assign(new Error('Lock wait timeout exceeded'), { code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205 });
  } });
  const report = await previewUpload(await uploadFile({
    'emp detail': [emp('Nobody At All', { id: 'E900007' })],
    'time champ data': [tc('2026-09-01', 'E900007', 'Nobody At All')],
  }), { db: store.db, now: NOW });

  assert.equal(report.blocking, false);
  assert.deepEqual(messages(report, 'emp detail', 'warnings'), [], 'no name is accused when the list is unreadable');
  assert.deepEqual(report.warnings, ['The CRM user list could not be read, so the emp detail names were not checked '
    + 'against it — everything else in this report is complete']);
  assert.deepEqual(report.months.find((m) => m.month === '2026-09').empDetail,
    { stored: 0, inFile: 1, added: 1, updated: 0, after: 1 }, 'the structural check is complete');

  // The duplicate check asks no database, so it still blocks.
  const blocked = await previewUpload(await uploadFile({
    'emp detail': [emp('Johan', { id: 'E1' }), emp('Johan\uFEFF', { id: 'E2' })],
  }), { db: store.db, now: NOW });
  assert.equal(blocked.blocking, true);
  assert.equal(sheetOf(blocked, 'emp detail').errorCount, 1);
});

/* ── monthly: duplicate keys rejected, upsert per (month, person) ─────────── */

test('monthly sheets: a key repeated in the file is rejected — the same name, or two names of one person', async () => {
  const { db } = makeStore();
  const report = await previewUpload(await uploadFile({
    'emp detail': [...TEAM, emp('tara  quill', { id: 'E900009' })],
    'target list': [
      { 'Primary spoc': 'Tara Quill', 'Target Amount': 2600000, 'Daily Target': 100000, month: 'September' },
      { 'Primary spoc': 'TARA QUILL', 'Target Amount': 1, 'Daily Target': 1, month: 'september' },
      { 'Primary spoc': 'Tara', 'Target Amount': 2, 'Daily Target': 2, month: 'September' },
      { 'Primary spoc': 'Tara', 'Target Amount': 3, 'Daily Target': 3, month: 'August' },
    ],
  }), { db, now: NOW });
  assert.equal(report.blocking, true);
  assert.deepEqual(messages(report, 'emp detail', 'errors'),
    ["CRM CURRENT NAME 'tara  quill' is already on row 2 — each person once per file"]);
  assert.deepEqual(messages(report, 'target list', 'errors'), [
    "'TARA QUILL' is already on row 2 for September 2026 — one row per person per month",
    "'Tara' is Tara Quill, who is already on row 2 as 'Tara Quill' — one row per person for September 2026",
  ]);
});

test('monthly sheets upsert per (month, person): other rows stay, positions stay, an alias row is replaced', async () => {
  const store = makeStore();
  await commitUpload(await uploadFile({
    'emp detail': [...TEAM, emp('Johan', { id: 'E900003', name: 'Vineet Jangid' })],
    'target list': [{ 'Primary spoc': 'Tara', 'Target Amount': 2600000, 'Daily Target': 100000, month: 'August' },
      { 'Primary spoc': 'Bram', 'Target Amount': 520000, 'Daily Target': 20000, month: 'August' }],
    'Secondary spoc target list': [{ Name: 'Vineet', 'Total Target': 260000, month: 'August' }],   // nobody yet
  }), { db: store.db, userId: 7, fileName: 'aug.xlsx', now: NOW });
  assert.deepEqual([...store.t.secondary.keys()], ['2026-08|vineet']);
  assert.deepEqual([...store.t.primary.keys()], ['2026-08|tara quill', '2026-08|bram'], 'keyed by the person, not the alias');

  const second = await uploadFile({
    'emp detail': [emp('Johan', { id: 'E900003', name: 'Vineet Jangid', label: 'Vineet', aug: 'Charlie', sep: 'Charlie' }),
      emp('Neha', { id: 'E900004' })],
    'target list': [{ 'Primary spoc': 'Tara Quill', 'Target Amount': 2700000, 'Daily Target': 103846.15, month: 'August' }],
    'Secondary spoc target list': [{ Name: 'Johan', 'Total Target': 300000, month: 'August' }],
  });
  const preview = await previewUpload(second, { db: store.db, now: NOW });
  assert.equal(preview.blocking, false);
  assert.deepEqual(messages(preview, 'Secondary spoc target list', 'warnings'),
    ["Replaces the August 2026 target saved as 'Vineet'"]);
  const aug = preview.months.find((m) => m.month === '2026-08');
  assert.deepEqual(aug.empDetail, { stored: 3, inFile: 2, added: 1, updated: 1, after: 4 });
  assert.deepEqual(aug.primaryTargets, { inFile: 1, updated: 1, replaced: 0 });
  assert.deepEqual(aug.secondaryTargets, { inFile: 1, updated: 0, replaced: 1 });

  const saved = await commitUpload(second, { db: store.db, userId: 7, fileName: 'fix.xlsx', now: NOW });
  assert.equal(saved.batchId, 2);
  const roster = [...store.t.roster.values()].filter((r) => r.month === '2026-08').sort((a, b) => a.row_no - b.row_no);
  assert.deepEqual(roster.map((r) => [r.crm_name, r.row_no, r.team_name]),
    [['Tara Quill', 1, 'Alpha'], ['Bram', 2, 'Bravo'], ['Johan', 3, 'Charlie'], ['Neha', 4, 'Alpha']],
    'untouched people stay; Johan keeps his place; Neha is appended');
  assert.deepEqual([...store.t.secondary.keys()], ['2026-08|johan'], "'Vineet' was Johan's target: replaced, not added");
  assert.equal(store.t.primary.get('2026-08|tara quill').target_amount, 2700000);
  assert.equal(store.t.primary.get('2026-08|bram').target_amount, 520000, 'a target not in the file stays');

  const batch = store.t.batch[1];
  assert.deepEqual(batch.slice(0, 1), ['fix.xlsx']);
  assert.equal(batch[2], 'emp detail,target list,Secondary spoc target list');
  assert.deepEqual([batch[5], batch[6], batch[8]], ['2026-08', '2026-09', 7]);

  const loaded = await loadUploads({ from: '2026-08-01', to: '2026-08-31', db: store.db });
  assert.deepEqual({ ...loaded.targets.personal.Johan }, { '2026-08': 300000 / 26 });
  assert.equal(loaded.hidden.secondaryTargets.length, 0);
});

/* ── daily: each date in the file replaces that date only ────────────────── */

test('TimeChamp and IVR: every date in the file replaces that date, and only that source', async () => {
  const store = makeStore();
  await commitUpload(await uploadFile({
    'emp detail': TEAM,
    'time champ data': [tc('2026-09-01', 'E900001', 'Tara Q', 8), tc('2026-09-01', 'E900002', 'Bram Oakes', 9),
      tc('2026-09-02', 'E900001', 'Tara Q', 6), tc('2026-09-02', 'E900002', 'Bram Oakes', 6)],
    'ivr data record': [ivrRow('2026-09-01', 'Bram', 4), ivrRow('2026-09-02', 'Bram', 6)],
  }), { db: store.db, userId: 7, now: NOW });
  assert.equal(store.t.timechamp.length, 4);

  // A corrected 2 September: TimeChamp only, one person renamed in the export.
  const fix = await uploadFile({
    'time champ data': [tc('2026-09-02', 'E900001', 'Tara Quill', 7.25), tc('2026-09-02', 'E900002', 'Bram Oakes', 8)],
  });
  const preview = await previewUpload(fix, { db: store.db, now: NOW });
  assert.deepEqual(preview.overwrites, [{ source: 'timechamp', date: '2026-09-02', storedRows: 2, fileRows: 2 }]);
  const saved = await commitUpload(fix, { db: store.db, userId: 8, now: NOW });
  assert.deepEqual(saved.saved, { empDetail: 0, primaryTargets: 0, secondaryTargets: 0, timechamp: 2, ivr: 0 });

  const tcRows = store.t.timechamp.map((r) => [r.work_date, r.employee_name, r.working_hours]).sort();
  assert.deepEqual(tcRows, [
    ['2026-09-01', 'Bram Oakes', 9], ['2026-09-01', 'Tara Q', 8],
    ['2026-09-02', 'Bram Oakes', 8], ['2026-09-02', 'Tara Quill', 7.25],
  ], 'the old 2 September rows are gone (no stale "Tara Q" row), 1 September is untouched');
  assert.deepEqual(store.t.ivr.map((r) => [r.call_date, r.incoming_calls]).sort(), [['2026-09-01', 4], ['2026-09-02', 6]],
    'IVR for the same date is untouched');
  const deletes = store.calls.filter((c) => /DELETE FROM tbl_qs_ep_timechamp_daily/.test(c.sql)).map((c) => c.params[0]);
  assert.deepEqual(deletes, [['2026-09-01', '2026-09-02'], ['2026-09-02']]);

  const loaded = await loadUploads({ from: '2026-09-01', to: '2026-09-02', db: store.db });
  assert.deepEqual(loaded.timechamp.filter((r) => r.key === 'Tara Quill').map((r) => [r.date, r.working]),
    [['2026-09-01', 8], ['2026-09-02', 7.25]]);
});

/* ── storage not set up ──────────────────────────────────────────────────── */

test('before the migration: preview and save answer 503; loadUploads returns empty inputs', async () => {
  const store = makeStore({ tablesPresent: false });
  const file = await uploadFile({ 'emp detail': TEAM });
  for (const run of [() => previewUpload(file, { db: store.db, now: NOW }),
    () => commitUpload(file, { db: store.db, userId: 7, now: NOW })]) {
    await assert.rejects(run(), (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.code, 'QS_EP_STORAGE_MISSING');
      assert.equal(err.message, STORAGE_MISSING_MESSAGE);
      assert.match(err.message, /run migrations\/2026-09-16-create-qs-employee-performance-inputs\.sql/);
      return true;
    });
  }
  assert.ok(store.calls.some((c) => /RELEASE_LOCK/.test(c.sql)), 'the upload lock is released');

  const loaded = await loadUploads({ from: '2026-09-01', to: '2026-09-10', db: store.db });
  assert.equal(loaded.storage, 'missing');
  assert.deepEqual([loaded.employees, loaded.timechamp, loaded.ivr, loaded.rosterMonths], [[], [], [], []]);
  assert.deepEqual(loaded.targets.spocs, []);
  assert.deepEqual(loaded.resolveNames('2026-09', ['Tara']), new Map([['Tara', null]]));
  await assert.rejects(loadUploads({ from: '2026-09-10', to: '2026-09-01', db: store.db }), TypeError);
});

test('two saves at once: the second is refused with 409 while the first holds the lock', async () => {
  const store = makeStore({ lock: 0 });
  await assert.rejects(commitUpload(await uploadFile({ 'emp detail': TEAM }), { db: store.db, userId: 7, now: NOW }),
    { status: 409 });
});

/* ── loadUploads → compose ───────────────────────────────────────────────── */

async function seededStore() {
  const store = makeStore();
  await commitUpload(await uploadFile({
    'emp detail': [
      emp('Tara Quill', { id: 'E900001', name: 'Tara Q', label: 'Tara', aug: 'Alpha', sep: 'Alpha' }),
      emp('Bram', { id: 'E900002', name: 'Bram Oakes', label: 'B', vertical: 0, aug: 'Bravo', sep: 'Alpha' }),
      emp('Cyra', { id: 'E900003', name: 'Cyra Vale', aug: 'Bravo', sep: '' }),
    ],
    'target list': [
      { 'Primary spoc': 'Tara', 'Target Amount': 2600000, 'Daily Target': 100000, month: 'August' },
      { 'Primary spoc': 'Tara Quill', 'Target Amount': 2860000, 'Daily Target': 110000, month: 'September' },
      { 'Primary spoc': 'Bram Oakes', 'Target Amount': 520000, 'Daily Target': 20000, month: 'August' },
    ],
    'Secondary spoc target list': [{ Name: 'B', 'Total Target': 260000, month: 'September' },
      { Name: 'Outsider', 'Total Target': 1, month: 'September' }],
    'time champ data': [
      tc('2026-08-31', 'E900001', 'Tara Q', 8, 7.6, 0.4),
      tc('2026-09-01', 'E900001', 'tara quill', 9, 8, 1),      // matched by CRM name
      tc('2026-09-01', 'T-77', 'Bram B', 6, 5, 1),              // matched by nobody
      tc('2026-09-01', 'E900003', 'C. Vale', 7, 6.5, 0.5),      // matched by EMP ID only
    ],
    'ivr data record': [ivrRow('2026-09-01', ' Bram ', 3, 30, 2, 200), ivrRow('2026-09-01', 'Bram Oakes', 9, 9, 9, 9)],
  }), { db: store.db, userId: 7, now: NOW });
  return store;
}

test('loadUploads gives compose() its inputs: per-month teams, targets, TimeChamp and IVR', async () => {
  const store = await seededStore();
  const loaded = await loadUploads({ from: '2026-08-31', to: '2026-09-01', db: store.db });
  assert.equal(loaded.storage, 'ready');
  assert.deepEqual(loaded.months, ['2026-08', '2026-09']);
  assert.deepEqual(loaded.rosterMonths, ['2026-08', '2026-09']);
  assert.deepEqual(loaded.employees.map((e) => [e.key, e.display, e.vertical, { ...e.teams }]), [
    ['Tara Quill', 'Tara Q', 'Furniture', { '2026-08': 'Alpha', '2026-09': 'Alpha' }],
    ['Bram', 'Bram Oakes', null, { '2026-08': 'Bravo', '2026-09': 'Alpha' }],
    ['Cyra', 'Cyra Vale', 'Furniture', { '2026-08': 'Bravo', '2026-09': '' }],
  ]);
  assert.deepEqual({ ...loaded.targets.daily['Tara Quill'] }, { '2026-08': 100000, '2026-09': 110000 });
  assert.deepEqual({ ...loaded.targets.monthly.Bram }, { '2026-08': 520000 });
  assert.equal(loaded.targets.total['Tara Quill'], 2600000 + 2860000);
  assert.deepEqual({ ...loaded.targets.personal.Bram }, { '2026-09': 10000 });
  assert.deepEqual(loaded.timechamp.map((r) => [r.key, r.date, r.working]).sort(), [
    ['Cyra', '2026-09-01', 7], ['Tara Quill', '2026-08-31', 8], ['Tara Quill', '2026-09-01', 9]]);
  assert.deepEqual(loaded.ivr, [{ key: 'Bram', date: '2026-09-01', incoming: 3, outgoing: 30, missed: 2, aht: 200 }]);
  assert.deepEqual(loaded.hidden.timechamp, [{ date: '2026-09-01', employeeId: 'T-77', employeeName: 'Bram B' }]);
  assert.deepEqual(loaded.hidden.ivr, [{ date: '2026-09-01', agentName: 'Bram Oakes' }], 'IVR matches the CRM name only');
  assert.deepEqual(loaded.hidden.secondaryTargets, [{ month: '2026-09', personName: 'Outsider' }]);
  assert.deepEqual(loaded.resolveNames('2026-09', ['tara', 'BRAM OAKES', 'Nobody']),
    new Map([['tara', 'Tara Quill'], ['BRAM OAKES', 'Bram'], ['Nobody', null]]));

  const D = compose({
    window: { from: '2026-08-31', to: '2026-09-01' },
    employees: loaded.employees,
    targets: loaded.targets,
    timechamp: loaded.timechamp,
    ivr: loaded.ivr,
    closedRows: [{ spoc: 'Tara Quill', charge: 5000, date: '2026-09-01', client: 'Acme', zm: 'ZM', vertical: 'Furniture',
      tx: 'T', txid: '1', aco: 'Bram', margin: 20, tat: 1, sda: 1 }],
    openRows: [],
  });
  assert.deepEqual(Object.keys(D.employees), ['Tara Quill', 'Bram', 'Cyra']);
  assert.deepEqual(D.primarySpocs, ['Bram', 'Tara Quill']);
  const tara = D.employees['Tara Quill'];
  assert.deepEqual(tara.productivity.map((p) => [p.date, p.working, p.productive]), [['2026-08-31', 8, 7.6], ['2026-09-01', 9, 8]]);
  assert.deepEqual(tara.daily.map((x) => [x.date, x.target, x.revenue]), [['2026-08-31', 100000, 0], ['2026-09-01', 110000, 5000]]);
  const bram = D.employees.Bram;
  assert.equal(bram.team, 'Alpha', "September's team");
  assert.deepEqual(bram.productivity.map((p) => [p.incoming, p.outgoing, p.missed, p.avgEng]), [[0, 0, 0, 0], [3, 30, 2, 200]]);
  assert.deepEqual(bram.revPerf.map((r) => [r.target, r.achieved]), [[0, 0], [10000, 5000]]);
  assert.equal(D.employees.Cyra.productivity[1].working, 7, 'EMP ID fallback');
  assert.deepEqual(D.teamMembers, { Alpha: ['Tara Quill', 'Bram'] });
});

test('one person is one key across months, even when a later upload respells the CRM name', async () => {
  const store = makeStore();
  await commitUpload(await uploadFile({ 'emp detail': [emp('harshit  bhardwaj', { name: 'Harshit B' })] }),
    { db: store.db, userId: 7, now: NOW });
  const septemberOnly = ['EMP ID', 'EMPLOYE NAME', 'CRM CURRENT NAME', 'Row Labels', 'vertical', 'Team Name Sep'];
  await commitUpload(await uploadFile({ 'emp detail': [{ 'CRM CURRENT NAME': 'Harshit Bhardwaj', 'EMPLOYE NAME': 'Harshit B',
    vertical: 'Sports', 'Team Name Sep': 'Delta' }] }, { headers: { 'emp detail': septemberOnly } }),
  { db: store.db, userId: 7, now: NOW });
  assert.equal(store.t.roster.size, 2, 'same (month, person) keys: August kept, September updated');

  const loaded = await loadUploads({ from: '2026-08-01', to: '2026-09-10', db: store.db });
  assert.deepEqual(loaded.employees.map((e) => [e.key, e.vertical, { ...e.teams }]),
    [['Harshit Bhardwaj', 'Sports', { '2026-08': 'Alpha', '2026-09': 'Delta' }]]);
  assert.deepEqual(loaded.roster['2026-08'], [{ key: 'Harshit Bhardwaj', crmName: 'Harshit Bhardwaj', empId: '',
    employeeName: 'Harshit B', rowLabels: '', vertical: 'Furniture', team: 'Alpha' }]);
  assert.equal(loaded.resolveNames('2026-08', ['HARSHIT BHARDWAJ']).get('HARSHIT BHARDWAJ'), 'Harshit Bhardwaj');
});

test('loadUploads resolves people exactly as fromWorkbookSheets does on the same sheets', async () => {
  const store = await seededStore();
  const loaded = await loadUploads({ from: '2026-09-01', to: '2026-09-30', db: store.db });

  // The same September data as ONE workbook in build_data.py's shape.
  const sheet = (name, columns, rows) => ({ name, columns, rows: rows.map((r) => columns.map((c) => (c in r ? r[c] : null))) });
  const wb = [
    sheet('Open order', ['Job Id', 'Vertical Name', 'State', 'City', 'Client', 'Aging', 'Pending Due To', 'Pending Reason',
      'Zonal Manager', 'Current TX Name', 'Current TX Id', 'Primary SPOC'], []),
    sheet('Close order', ['Primary SPOC', 'Total Charge', 'Margin(%)', 'Audit & Checkout Date', 'Client', 'TAT Status',
      'SDA Status', 'Zonal Manager', 'Vertical Name', 'Current TX Name', 'Current TX Id', 'A & CO by'], []),
    sheet('target list', ['Primary spoc', 'Target Amount', 'Daily Target', 'month'],
      [{ 'Primary spoc': 'Tara Quill', 'Target Amount': 2860000, 'Daily Target': 110000, month: 'September' }]),
    sheet('emp detail', ['EMP ID', 'EMPLOYE NAME', 'CRM CURRENT NAME', 'Row Labels', 'vertical', 'Team Name Sep'], [
      { 'EMP ID': 'E900001', 'EMPLOYE NAME': 'Tara Q', 'CRM CURRENT NAME': 'Tara Quill', 'Row Labels': 'Tara', vertical: 'Furniture', 'Team Name Sep': 'Alpha' },
      { 'EMP ID': 'E900002', 'EMPLOYE NAME': 'Bram Oakes', 'CRM CURRENT NAME': 'Bram', 'Row Labels': 'B', vertical: 0, 'Team Name Sep': 'Alpha' },
      { 'EMP ID': 'E900003', 'EMPLOYE NAME': 'Cyra Vale', 'CRM CURRENT NAME': 'Cyra', vertical: 'Furniture' },
    ]),
    sheet('Secondary spoc target list', ['Name', 'Total Target', 'month'],
      [{ Name: 'B', 'Total Target': 260000, month: 'September' }, { Name: 'Outsider', 'Total Target': 1, month: 'September' }]),
    sheet('time champ data', ['Employee Id', 'Employee Name', 'Working Hours', 'Productive Hours', 'Away Hours', 'Date'], [
      { 'Employee Id': 'E900001', 'Employee Name': 'tara quill', 'Working Hours': 9, 'Productive Hours': 8, 'Away Hours': 1, Date: '2026-09-01' },
      { 'Employee Id': 'T-77', 'Employee Name': 'Bram B', 'Working Hours': 6, 'Productive Hours': 5, 'Away Hours': 1, Date: '2026-09-01' },
      { 'Employee Id': 'E900003', 'Employee Name': 'C. Vale', 'Working Hours': 7, 'Productive Hours': 6.5, 'Away Hours': 0.5, Date: '2026-09-01' },
    ]),
    sheet('crm data', ['employee id', 'Booked', 'Scheduled', 'Audit', 'Closed', 'Cancelled', 'Date'], []),
    sheet('ivr data record', ['Agent Name', 'Total Incoming Calls', 'Total Outgoing Calls', 'Total Missed Calls',
      'Avg Handling Time', 'Date'], [
      { 'Agent Name': ' Bram ', 'Total Incoming Calls': 3, 'Total Outgoing Calls': 30, 'Total Missed Calls': 2, 'Avg Handling Time': 200, Date: '2026-09-01' },
      { 'Agent Name': 'Bram Oakes', 'Total Incoming Calls': 9, 'Total Outgoing Calls': 9, 'Total Missed Calls': 9, 'Avg Handling Time': 9, Date: '2026-09-01' },
    ]),
  ];
  const expected = fromWorkbookSheets(wb);
  const plain = (v) => JSON.parse(JSON.stringify(v));
  assert.deepEqual(plain(loaded.employees).map(({ key, display, vertical, teams }) => ({ key, display, vertical, teams: teams['2026-09'] })),
    plain(expected.employees).map(({ key, display, vertical, teams }) => ({ key, display, vertical, teams: teams['2026-09'] })));
  assert.deepEqual(plain(loaded.timechamp), plain(expected.timechamp));
  assert.deepEqual(plain(loaded.ivr), plain(expected.ivr));
  assert.deepEqual(plain(loaded.targets.personal), plain(expected.targets.personal));
  assert.deepEqual(plain(loaded.targets.daily), plain(expected.targets.daily));
});
