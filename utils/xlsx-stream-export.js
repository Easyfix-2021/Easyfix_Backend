const ExcelJS = require('exceljs');
const logger = require('../logger');

/*
 * Constant-memory XLSX streamer.
 *
 * Companion to `utils/xlsx-styled-export.js`, NOT a replacement for it.
 * That module builds the whole workbook in memory first (brand band, KPI
 * cards, banding, data bars) — perfect for a 200-row QuickSight report,
 * fatal for a 74-column × 100k-row operational dump. This module trades
 * every optional flourish for a flat memory profile: rows arrive from an
 * async generator, each one is written and released, and nothing but the
 * current row is ever retained.
 *
 * Why the whole thing is shaped around commit():
 *   ExcelJS's WorkbookWriter only flushes a row to the zip stream when
 *   `row.commit()` is called. Skip it and the writer quietly accumulates
 *   every row in `worksheet._rows` — you get the streaming API's syntax
 *   with the buffered API's heap, which is the exact failure the legacy
 *   Java/POI exporter hit (three copies of the result set plus a
 *   non-streaming workbook). So: commit per row, commit the sheet, commit
 *   the workbook.
 *
 * Usage:
 *
 *   await streamRowsToXlsx(res, {
 *     filename : 'ManageJobReport_2026-08-17.xlsx',
 *     sheetName: 'Report',
 *     columns  : [{ header: 'Job ID', key: 'job_id', type: 'number' }, …],
 *     rowSource: (async function* () { … yield rowObject … })(),
 *     onFinish : ({ rowCount, elapsedMs }) => logger.info(…),
 *   });
 */

// Header-band styling. Deliberately modest: bold text, light-grey fill,
// hairline border. It is applied to ONE row (the header), never to data
// rows — see the note on styling below.
const HEADER_FILL   = 'FFF1F5F9'; // slate-100
const HEADER_TEXT   = 'FF111827'; // near-black
const BORDER_GREY   = 'FFE2E8F0';

// Matches the legacy Java report's `dd MMM yyyy hh:mm a` SimpleDateFormat.
// Excel's format language spells the same thing this way.
const DATE_NUM_FMT   = 'dd mmm yyyy hh:mm AM/PM';
const NUMBER_NUM_FMT = '#,##0';

const MIN_WIDTH = 10;
const MAX_WIDTH = 44;

// How often to check whether the response socket needs to drain. Every row
// would be needless syscall-adjacent churn; every 500 rows bounds the queue
// at a few hundred KB of overshoot.
const DRAIN_CHECK_EVERY = 500;

/**
 * Sanitise a filename for a Content-Disposition header. A quote, CR or LF
 * in this value is a response-splitting / header-injection vector, and the
 * filename is derived from request-adjacent data in some callers.
 */
function safeFilename(name) {
  const cleaned = String(name || 'export.xlsx').replace(/[^\w.\-]+/g, '_');
  return cleaned.endsWith('.xlsx') ? cleaned : `${cleaned}.xlsx`;
}

/**
 * A "the client is gone" error. Carries `xlsxStreamAborted` so the route
 * knows not to attempt a JSON response, and `clientAborted` so it can log it
 * as a disconnect rather than a server fault.
 */
function abortError(message) {
  const err = new Error(message);
  err.xlsxStreamAborted = true;
  err.clientAborted = true;
  return err;
}

function defaultWidth(col) {
  if (Number.isFinite(col.width)) return col.width;
  if (col.type === 'date') return 22;
  if (col.type === 'number') return 12;
  const byHeader = String(col.header || col.key || '').length + 4;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, byHeader));
}

/**
 * Coerce one cell value according to its declared column type.
 *
 * Returns `null` (empty cell) rather than '' for blanks — an empty cell is
 * smaller in the sheet XML than an empty inline string, and at 74 columns
 * × 100k rows that difference is real.
 */
function coerce(value, type) {
  if (value === undefined || value === null || value === '') return null;
  if (type === 'date') {
    if (value instanceof Date) return Number.isNaN(+value) ? null : value;
    const d = new Date(value);
    return Number.isNaN(+d) ? null : d;
  }
  if (type === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return typeof value === 'string' ? value : String(value);
}

/**
 * Stream an async row source into the response as an .xlsx download.
 *
 * @param {import('http').ServerResponse} res
 * @param {Object} o
 * @param {string} o.filename              Download filename (.xlsx enforced).
 * @param {string} o.sheetName             Worksheet name (Excel caps at 31 chars).
 * @param {Array<{header:string,key:string,type?:'number'|'date'|'string',width?:number}>} o.columns
 * @param {AsyncGenerator<Object>|AsyncIterable<Object>} o.rowSource
 *        Yields plain row objects keyed by `column.key`. Anything it does
 *        NOT yield (paging, DB access, mapping) is the caller's business —
 *        this function only knows how to write what it is handed.
 * @param {function({rowCount:number,elapsedMs:number}):void=} o.onFinish
 *        Called once, after the workbook is fully committed.
 * @returns {Promise<{rowCount:number,elapsedMs:number}>}
 *
 * Failure contract — read this before wrapping the call:
 *   • If the source fails on its FIRST pull (bad filter, DB down, pool
 *     exhausted — by far the likeliest failure), nothing has been written
 *     and no headers have been set. The error is rethrown untouched and
 *     the caller can answer with a normal JSON error via next(e).
 *   • If it fails after that, the 200 and the attachment headers are
 *     already on the wire; there is no way to retract them and switch to
 *     JSON. The response is destroyed so the client sees a broken
 *     download, and the rethrown error carries `err.xlsxStreamAborted
 *     === true`. The caller MUST NOT call next(e) in that case — the
 *     response is already dead. Truncated-but-valid output was rejected
 *     deliberately: a short file that opens cleanly is silent data loss
 *     in an operational report, and the operator has no way to notice.
 *   • If the CLIENT disconnects, row production stops within one chunk,
 *     the source generator is closed (its `finally` runs, so it can free
 *     whatever it holds), and the same aborted error is thrown with
 *     `err.clientAborted === true` — logged as a warning, not a fault.
 */
async function streamRowsToXlsx(res, { filename, sheetName, columns, rowSource, onFinish }) {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error('streamRowsToXlsx: columns required');
  }
  if (!rowSource || typeof rowSource[Symbol.asyncIterator] !== 'function') {
    throw new Error('streamRowsToXlsx: rowSource must be an async iterable');
  }

  const startedAt = Date.now();
  const dl = safeFilename(filename);

  // Pull the first row BEFORE touching `res` at all. ExcelJS commits the
  // response the moment addWorksheet() runs — its constructor opens the
  // sheet's zip entry and starts writing ("start writing to stream now",
  // worksheet-writer.js) — so after that point no error can be reported as
  // JSON. Doing the first fetch up front means the common failure (the
  // opening query blowing up) still produces a clean 500 instead of a
  // corrupt download. Costs exactly one already-required round-trip.
  const iterator = rowSource[Symbol.asyncIterator]();
  let next = await iterator.next();

  // ─── Headers: every one of these must be set BEFORE the first byte ──────
  // Once ExcelJS writes into `res` the head is flushed and these are frozen.
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${dl}"`);

  // no-store: an operational export is a point-in-time snapshot, never cacheable.
  // no-transform: this is the opt-out that actually disables the global
  //   `compression({ threshold: 1024 })` mounted in server.js:27. An .xlsx is
  //   already a DEFLATE zip, so gzipping it burns CPU for ~0 bytes saved AND
  //   delays first-byte (compression buffers until the threshold is crossed),
  //   which is precisely what streaming exists to avoid. Note that
  //   Content-Encoding: identity alone does NOT stop the middleware — its
  //   "already encoded" bail-out treats identity as "not yet encoded"
  //   (compression/index.js: `getHeader('Content-Encoding') || 'identity'`,
  //   then `if (encoding !== 'identity')`). The Cache-Control no-transform
  //   check runs earlier and is the documented, reliable escape hatch.
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.setHeader('Content-Encoding', 'identity');

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: res,
    useStyles: true,
    // useSharedStrings:false is load-bearing, not a tuning knob. The shared
    // string table is a single document-wide dictionary that cannot be
    // flushed until the very last row is known, so enabling it would pin
    // every distinct string in the export in heap for the whole request —
    // i.e. it re-creates the buffered exporter we are replacing. Writing
    // inline strings costs some file size and buys constant memory.
    useSharedStrings: false,
  });

  const sheet = workbook.addWorksheet(String(sheetName || 'Report').slice(0, 31), {
    // Freeze the header so a 100k-row sheet stays navigable.
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  // Column definitions carry key + width + numFmt ONLY — no `header`, because
  // ExcelJS would then auto-write row 1 and we want to style that row
  // ourselves below. Number formats live HERE, on the column, so a date or a
  // count formats correctly without allocating a style object per cell.
  // Per-cell styling on data rows is what makes the buffered exporter
  // allocate millions of short-lived objects; it is intentionally absent.
  sheet.columns = columns.map((c) => ({
    key: c.key,
    width: defaultWidth(c),
    style:
      c.type === 'date'   ? { numFmt: DATE_NUM_FMT } :
      c.type === 'number' ? { numFmt: NUMBER_NUM_FMT } :
      undefined,
  }));

  // Header row — the one and only row that gets explicit cell styling.
  const headerRow = sheet.addRow(columns.map((c) => c.header ?? c.key));
  headerRow.font = { bold: true, color: { argb: HEADER_TEXT } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  headerRow.height = 22;
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.border = {
      top:    { style: 'thin', color: { argb: BORDER_GREY } },
      left:   { style: 'thin', color: { argb: BORDER_GREY } },
      bottom: { style: 'thin', color: { argb: BORDER_GREY } },
      right:  { style: 'thin', color: { argb: BORDER_GREY } },
    };
  });
  headerRow.commit();

  // If the client walks away mid-download there is no point paging another
  // 50k rows out of MySQL for a socket nobody is reading. The 'error'
  // listener is not optional: a client that hangs up mid-transfer makes the
  // next write emit EPIPE on `res`, and an unhandled 'error' event takes the
  // whole process down — a long-running export is exactly where that
  // happens.
  let clientGone = false;
  let signalGone = null;
  // Rejects the moment the client disappears. `writableEnded` is the
  // discriminator: on a normal finish 'close' also fires, but end() has
  // already been called by then, so a successful export never trips this.
  const clientGonePromise = new Promise((_resolve, reject) => { signalGone = reject; });
  clientGonePromise.catch(() => {}); // never an unhandled rejection
  const onClose = () => {
    clientGone = true;
    if (!res.writableEnded) signalGone(abortError('client disconnected mid-export'));
  };
  res.on('close', onClose);
  res.on('error', onClose);

  let rowCount = 0;
  let abandoned = false;
  try {
    while (!next.done) {
      if (clientGone || res.destroyed) {
        // Close the generator so its paging loop stops hitting the DB for a
        // socket nobody is reading — this runs the generator's `finally`,
        // releasing anything it holds (a `for await` break does this for
        // you; a manual iterator does not). The catch block logs it.
        if (typeof iterator.return === 'function') await iterator.return();
        abandoned = true;
        break;
      }
      const row = next.value;
      // Build the value array in declared column order. One short-lived
      // array per row, immediately garbage — no accumulation.
      const values = new Array(columns.length);
      for (let i = 0; i < columns.length; i += 1) {
        values[i] = coerce(row ? row[columns[i].key] : null, columns[i].type);
      }
      // commit() flushes this row to the zip stream and drops it. Without it
      // ExcelJS retains every row and the "streaming" export is a buffered
      // one wearing a costume.
      sheet.addRow(values).commit();
      rowCount += 1;

      // Backpressure. ExcelJS writes rows synchronously and never waits for
      // the socket, so a slow client (VPN, phone tether) pulling a 50MB
      // report would let the whole file pile up in the response's write
      // queue — constant memory on the producing side, unbounded memory on
      // the sending side. Pausing row production until the socket drains
      // stalls the DB paging too, which is precisely the intent.
      if (rowCount % DRAIN_CHECK_EVERY === 0 && res.writableNeedDrain) {
        await new Promise((resolve) => {
          const done = () => {
            res.off('drain', done); res.off('close', done); res.off('error', done);
            resolve();
          };
          res.on('drain', done); res.on('close', done); res.on('error', done);
        });
      }

      next = await iterator.next();
    }

    if (abandoned) throw abortError('client disconnected mid-export');

    sheet.commit();
    // Never await workbook.commit() unguarded: ExcelJS's _finalize() settles
    // on the response's 'finish' event, and a response the client already
    // killed will never emit one — the await then hangs FOREVER, pinning the
    // request handler and its DB connection. Verified, not theoretical.
    // Racing it against the disconnect signal turns that hang into an error.
    await Promise.race([workbook.commit(), clientGonePromise]);
  } catch (err) {
    res.off('close', onClose);
    // The 'error' listener stays attached on purpose — destroying a response
    // can emit one more 'error', and with no listener that is an uncaught
    // exception. It is released with the response.

    if (err && err.clientAborted) {
      // Not a server fault; the operator closed the tab or the link dropped.
      logger.warn('XLSX export abandoned after ' + rowCount + ' rows · ' + dl);
    } else {
      // Streaming already started: 200 OK and the attachment headers are sent
      // and unretractable. The only honest signal left is an aborted transfer.
      logger.error(
        'XLSX export failed mid-stream after ' + rowCount + ' rows · ' + dl + ' · ' + (err && err.message)
      );
    }
    // destroy() without an argument: passing the error would make the
    // response emit it again for no benefit — the client already sees a
    // truncated transfer, which is the whole point.
    if (!res.destroyed) res.destroy();
    err.xlsxStreamAborted = true;
    throw err;
  }

  res.off('close', onClose);
  res.off('error', onClose);

  const elapsedMs = Date.now() - startedAt;
  if (typeof onFinish === 'function') onFinish({ rowCount, elapsedMs });
  return { rowCount, elapsedMs };
}

module.exports = { streamRowsToXlsx };
