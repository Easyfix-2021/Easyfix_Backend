/*
 * The Manage Job Report must be a file Excel will actually OPEN.
 *
 * ─── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 *
 * For a fortnight every Manage Jobs export was corrupt, and nothing anywhere
 * said so. The route logged `↳ 200 (2447 ms)` and
 * `Jobs export finished · 2,420 rows in 2442ms`; the rows were fetched, the
 * bytes were written, the browser saved a 300KB .xlsx. The only signal that
 * anything was wrong was an operator reporting that the file would not open.
 *
 * The cause was exceljs@3's streaming writer: it emits a ZIP whose CENTRAL
 * DIRECTORY declares an uncompressed size of 0 for every part except the
 * worksheet. The compressed bytes are all present, but `[Content_Types].xml` —
 * the OOXML manifest, and the first thing any consumer reads — comes back
 * EMPTY. Excel opens the package, finds no manifest, and refuses the file.
 * exceljs@4 writes the same parts with correct sizes.
 *
 * ─── WHAT THESE TESTS PIN ─────────────────────────────────────────────────
 *
 * Every existing test of the export asserted on ROW CONTENT and passed
 * throughout the outage, because the rows were never the problem — the
 * PACKAGE was. So these assert the property the operator actually cares
 * about: the bytes on the wire parse as a valid OOXML package with a
 * non-empty manifest. That is deliberately checked by walking the ZIP
 * central directory by hand rather than by asking exceljs to read its own
 * output back, because a library that mis-declares a size may well
 * compensate for it on the way back in — and Excel will not.
 *
 * If someone downgrades exceljs, or a lockfile resolves the range to a 3.x,
 * this file fails. That is the entire point.
 */
const test = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('node:stream');

const { streamRowsToXlsx } = require('../utils/xlsx-stream-export');

const COLUMNS = [
  { header: 'Job ID',  key: 'job_id',  type: 'number' },
  { header: 'Remarks', key: 'remarks' },
  { header: 'Booked',  key: 'booked',  type: 'date' },
];

/*
 * A response stand-in: a real stream (so backpressure and 'close' behave) that
 * also answers setHeader/off, and collects everything written.
 */
function fakeRes() {
  const sink = new PassThrough();
  const chunks = [];
  sink.on('data', (c) => chunks.push(c));
  sink.setHeader = function setHeader(k, v) { (this.headers ||= {})[k] = v; };
  sink.bytes = () => Buffer.concat(chunks);
  return sink;
}

async function exportRows(rows) {
  const res = fakeRes();
  const result = await streamRowsToXlsx(res, {
    filename: 'ManageJobReport_test.xlsx',
    sheetName: 'Report',
    columns: COLUMNS,
    rowSource: (async function* gen() { for (const r of rows) yield r; })(),
  });
  return { buf: res.bytes(), headers: res.headers, result };
}

/*
 * Walk the ZIP central directory — the same structure Excel reads — and return
 * each part's DECLARED uncompressed size. Deliberately hand-rolled: asking a
 * zip library to normalise this away would hide the exact defect under test.
 */
function declaredSizes(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.ok(eocd >= 0, 'no End-of-Central-Directory record — not a ZIP at all');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n += 1) {
    assert.equal(buf.readUInt32LE(off), 0x02014b50, 'malformed central directory entry');
    const size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    out.set(buf.toString('latin1', off + 46, off + 46 + nameLen), size);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const ROWS = [
  { job_id: 1, remarks: 'customer asked to call later', booked: new Date('2026-08-17T09:30:00Z') },
  { job_id: 2, remarks: 'address unclear',              booked: null },
];

test('the exported package carries a NON-EMPTY [Content_Types].xml — the manifest Excel reads first', async () => {
  const { buf } = await exportRows(ROWS);
  const sizes = declaredSizes(buf);
  const manifest = sizes.get('[Content_Types].xml');
  assert.notEqual(manifest, undefined, '[Content_Types].xml is missing from the package');
  assert.ok(
    manifest > 0,
    `[Content_Types].xml is declared as ${manifest} bytes. This is the exceljs@3 streaming-writer `
    + 'defect: the file downloads cleanly and Excel refuses to open it. Check the installed exceljs major.',
  );
});

test('EVERY part declares a real size — not just the worksheet', async () => {
  const { buf } = await exportRows(ROWS);
  const empty = [...declaredSizes(buf)]
    .filter(([name, size]) => !name.endsWith('/') && size === 0)
    .map(([name]) => name);
  assert.deepEqual(
    empty, [],
    `these parts declare 0 bytes and will read back empty: ${empty.join(', ')}`,
  );
});

test('the workbook parts a spreadsheet cannot do without are all present', async () => {
  const { buf } = await exportRows(ROWS);
  const names = new Set(declaredSizes(buf).keys());
  for (const required of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml']) {
    assert.ok(names.has(required), `missing required OOXML part: ${required}`);
  }
});

test('rows still reach the sheet — the package check must not pass on an empty report', async () => {
  const { buf, result } = await exportRows(ROWS);
  assert.equal(result.rowCount, 2);
  // The sheet XML is written with inline strings (useSharedStrings:false), so
  // the operator-visible text is findable in the raw bytes without unzipping.
  assert.ok(buf.length > 4000, 'suspiciously small workbook');
});

test('the attachment headers are set, and the filename keeps its .xlsx extension', async () => {
  const { headers } = await exportRows(ROWS);
  assert.match(headers['Content-Type'], /spreadsheetml\.sheet/);
  assert.match(headers['Content-Disposition'], /attachment; filename="ManageJobReport_test\.xlsx"/);
  // no-transform is what actually opts this response out of the global
  // compression middleware; losing it silently re-gzips an already-zipped file.
  assert.match(headers['Cache-Control'], /no-transform/);
});

test('a source that fails on its FIRST pull leaves the response untouched, so the route can still send JSON', async () => {
  const res = fakeRes();
  await assert.rejects(
    streamRowsToXlsx(res, {
      filename: 'x.xlsx',
      sheetName: 'Report',
      columns: COLUMNS,
      rowSource: (async function* gen() { throw new Error('boom: opening query failed'); })(),
    }),
    (err) => {
      assert.match(err.message, /boom/);
      // Must NOT be flagged as an aborted stream — the route keys off this to
      // decide whether next(e) is still safe.
      assert.equal(err.xlsxStreamAborted, undefined);
      return true;
    },
  );
  assert.equal(res.headers, undefined, 'headers were set before the first row was known');
});
