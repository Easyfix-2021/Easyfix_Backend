/*
 * QuickSight — Custom (dynamic) Reports.
 *
 * A report here is DATA, not code: an operator names it, defines typed columns
 * (text / number / date), downloads a blank template, fills it off-platform and
 * uploads it; everyone in the report's audience then views it read-only, sorts,
 * searches, charts and downloads it. The same idea as Employee Performance (an
 * uploaded snapshot, not a query), generalised to any column set.
 *
 * STORAGE. The DB holds definitions and upload METADATA only. Each upload's rows
 * are ONE gzipped JSON object `{ columns, rows }` (rows = array-of-arrays in
 * column order) in private S3 under QuickSight/DynamicReports/<reportId>/, or a
 * private directory on disk when S3 is not configured (local dev — does not
 * survive a redeploy). Object first, row second: a failed write can orphan an
 * object (harmless) but never leaves a row pointing at nothing.
 *
 * EVERY UPLOAD IS A COMPLETE SNAPSHOT. Append writes previous rows + new rows as
 * a NEW object, never a delta. So the current view, a historic view, a download
 * and the retention purge each touch exactly one object — deleting an old
 * upload can never break a newer one.
 *
 * EACH UPLOAD CARRIES ITS OWN COLUMN SET. Editing a report's columns changes
 * future templates and uploads only; an existing upload keeps rendering with
 * the columns it was uploaded with (detail.columnsChanged tells the UI).
 *
 * RETENTION (RETENTION_DAYS). purgeExpired() — run daily by the scheduler job
 * `dynamic-report-retention` — deletes uploads older than that, EXCEPT each
 * active report's current (latest) upload, which is kept however old so an
 * unrefreshed report never goes blank. An archived report's uploads all age out.
 *
 * ACCESS (three action keys, see KEYS):
 *   VIEW   — see reports whose audience is empty (everyone) or includes my role
 *   MANAGE — create; edit / upload / share / delete uploads of reports I OWN
 *   ADMIN  — owner-equivalent on every report, sees all. NOT transfer.
 * TRANSFERRING OWNERSHIP is the one capability outside RBAC: the report's
 * OWNER, or an email on the FEATURES.canTransferReportOwner allowlist. It has
 * to outlive a role change, because the case it exists for is an owner who
 * lost access — see canTransferOwner() and the route.
 * loadReport() is the one gate every per-report read and write goes through;
 * a report you may not see is a 404, never a 403, so its existence does not leak.
 * A public share link bypasses the audience on purpose — the owner published it.
 *
 * TIMESTAMPS are written as new Date() through the pool's '+05:30' (IST
 * wall-clock, like the rest of easyfix_core) and returned as IST strings via
 * DATE_FORMAT. Comparisons use a JS-computed cutoff, never NOW(): the DB
 * session's zone is not IST.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const ExcelJS = require('exceljs');

const { pool } = require('../../db');
const s3 = require('../../utils/s3-storage');
const { buildStyledWorkbook } = require('../../utils/xlsx-styled-export');
const { withMysqlNamedLock } = require('../mysql-named-lock.service');
const { FEATURES, emailAllowed } = require('../feature-access.service');
const { fileStamp } = require('./_shared');
const logger = require('../../logger');

const KEYS = Object.freeze({
  VIEW: 'isQuickSightDynamicReportView',
  MANAGE: 'isQuickSightDynamicReportManage',
  ADMIN: 'isQuickSightDynamicReportAdmin',
});

const RETENTION_DAYS = 30;
const MAX_COLUMNS = 100;
const MAX_ROWS = 50000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PAGE_SIZE = 500;
const MAX_CELL_CHARS = 2000;
const MAX_REPORTED_ERRORS = 5;
const HEADER_SCAN_ROWS = 10;       // a downloaded (styled) sheet has title/meta bands above the header
const CHART_TOP_N = 20;
// A gzip bomb must not be able to exhaust memory: cap what we inflate.
const MAX_INFLATED_BYTES = 200 * 1024 * 1024;
const COL_TYPES = ['text', 'number', 'date'];
const CHART_TYPES = ['bar', 'line', 'pie'];
const CHART_AGGS = ['sum', 'count', 'avg'];

const S3_PREFIX = 'QuickSight/DynamicReports';
const DATA_KEY_RE = /^QuickSight\/DynamicReports\/\d+\/[0-9a-f-]{36}\.json\.gz$/;
const SHARE_TOKEN_RE = /^[0-9a-f]{32}$/;
const TS = (col) => `DATE_FORMAT(${col}, '%Y-%m-%d %H:%i:%s')`;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// ─── access ─────────────────────────────────────────────────────────────

/** req.user (permissions already hydrated by requireQuickSight) → access. */
function accessOf(user) {
  const perms = (user && user.permissions && user.permissions.actionPermissions) || [];
  return {
    userId: Number(user && user.user_id),
    roleId: Number(user && user.user_role),
    isAdmin: perms.includes(KEYS.ADMIN),
    canManage: perms.includes(KEYS.MANAGE),
    // Email allowlist, NOT a role — see FEATURES.canTransferReportOwner.
    onOwnerAllowlist: emailAllowed(FEATURES.canTransferReportOwner, user && user.official_email),
  };
}

const isOwner = (report, access) => Number(report.created_by) === access.userId;

/*
 * Who may hand a report to a new owner: its OWNER, or a named operator on the
 * email allowlist. Deliberately NOT the Admin key — an admin can read, edit,
 * upload to and archive every report, but re-pointing ownership follows a
 * person, so it survives the role reshuffle that created the problem.
 * The list and detail payloads carry this as `canTransferOwner` so the CRM
 * shows the action to exactly the people the BE would accept it from.
 */
const canTransferOwner = (report, access) => access.onOwnerAllowlist || isOwner(report, access);

function canSee(report, roleIds, access) {
  if (access.isAdmin || isOwner(report, access)) return true;
  return roleIds.length === 0 || roleIds.includes(access.roleId);
}

// Ownership needs the Manage key too: revoking it from an owner revokes editing.
function canEdit(report, access) {
  return access.isAdmin || (access.canManage && isOwner(report, access));
}

// ─── object storage (S3, or a private local directory when S3 is off) ───
// Copied from quicksight-employee-performance.service.js on purpose — that
// report is live and this keeps its code untouched.

function localDir() {
  return process.env.QS_DYNAMIC_REPORTS_DIR
    || path.join(__dirname, '..', '..', 'uploads', 'private', 'quicksight-dynamic-reports');
}

function localPath(key) {
  if (!DATA_KEY_RE.test(key)) throw new Error(`Refusing unexpected data key: ${key}`);
  return path.join(localDir(), key);
}

async function writeObject(key, buffer) {
  if (s3.isEnabled()) {
    await s3.putAtKey({ key, buffer, contentType: 'application/gzip' });
    return;
  }
  const target = localPath(key);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(`${target}.tmp`, buffer);
  fs.renameSync(`${target}.tmp`, target);
}

async function readObject(key) {
  if (s3.isEnabled()) return s3.getObjectBuffer(key);
  try {
    return fs.readFileSync(localPath(key));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/** true when the object is gone (deleted, or never existed); false on a real failure. */
async function removeObject(key) {
  if (s3.isEnabled()) {
    const r = await s3.deleteObject(key);
    return r.deleted || r.reason !== 'error';
  }
  try {
    fs.unlinkSync(localPath(key));
  } catch (e) {
    if (e.code !== 'ENOENT') return false;
  }
  return true;
}

// ─── definitions: columns + chart ───────────────────────────────────────

const normName = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();
const keyNum = (k) => Number(String(k).slice(1)) || 0;

/*
 * Input columns → stored columns with stable keys. A column that arrives with
 * a key the existing definition has keeps it (a rename keeps its data lineage);
 * anything else is new and gets the next unused cN. Keys are never reused.
 */
function normalizeColumns(input, existing = []) {
  if (!Array.isArray(input) || input.length === 0) throw httpError(400, 'Add at least one column');
  if (input.length > MAX_COLUMNS) throw httpError(400, `A report can have at most ${MAX_COLUMNS} columns`);
  const known = new Set(existing.map((c) => c.key));
  let next = Math.max(0, ...existing.map((c) => keyNum(c.key))) + 1;
  const seen = new Set();
  const used = new Set();
  return input.map((c, i) => {
    const name = String(c.name == null ? '' : c.name).trim().replace(/\s+/g, ' ');
    if (!name) throw httpError(400, `Column ${i + 1} needs a name`);
    if (seen.has(name.toLowerCase())) throw httpError(400, `Column "${name}" appears twice`);
    seen.add(name.toLowerCase());
    if (!COL_TYPES.includes(c.type)) throw httpError(400, `Column "${name}" has an unknown type`);
    let key = c.key && known.has(c.key) && !used.has(c.key) ? c.key : null;
    if (!key) key = `c${next++}`;
    used.add(key);
    return { key, name, type: c.type };
  });
}

function normalizeChart(chart, columns) {
  if (!chart) return null;
  const byKey = new Map(columns.map((c) => [c.key, c]));
  if (!CHART_TYPES.includes(chart.type)) throw httpError(400, 'Choose a chart type');
  if (!CHART_AGGS.includes(chart.agg)) throw httpError(400, 'Choose how the chart combines values');
  const x = byKey.get(chart.x);
  if (!x || x.type === 'number') throw httpError(400, 'The chart\'s X axis must be a Text or Date column');
  if (chart.agg === 'count') return { type: chart.type, x: x.key, y: [], agg: 'count' };
  const y = [...new Set(Array.isArray(chart.y) ? chart.y : [])];
  if (y.length === 0) throw httpError(400, 'Choose at least one Number column to chart');
  if (y.length > 4) throw httpError(400, 'A chart can show at most 4 Number columns');
  if (!y.every((k) => byKey.get(k) && byKey.get(k).type === 'number')) {
    throw httpError(400, 'Chart values must be Number columns of this report');
  }
  return { type: chart.type, x: x.key, y: chart.type === 'pie' ? y.slice(0, 1) : y, agg: chart.agg };
}

const sameColumns = (a, b) => JSON.stringify((a || []).map((c) => [c.key, c.name, c.type]))
  === JSON.stringify((b || []).map((c) => [c.key, c.name, c.type]));

// ─── parsing an upload ──────────────────────────────────────────────────

function cellValue(v) {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result);             // formula
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return cellValue(v.text);                  // hyperlink
    if ('error' in v) return null;                              // #N/A, #DIV/0!
    return null;
  }
  return v;
}

const pad2 = (n) => String(n).padStart(2, '0');
// ExcelJS hands date cells over as UTC midnight: read them with getUTC*, never local time.
const ymdUTC = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;

function validYmd(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
    ? `${y}-${pad2(m)}-${pad2(d)}` : null;
}

function toDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : ymdUTC(v);
  if (typeof v === 'number') {
    // An Excel serial in a cell formatted General (1900 system; 25569 = 1970-01-01).
    if (v < 1 || v > 2958465) return undefined;
    return ymdUTC(new Date(Math.round((v - 25569) * 86400000)));
  }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/.exec(s);
  if (m) return validYmd(+m[1], +m[2], +m[3]) || undefined;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);          // DD-MM-YYYY, DD/MM/YYYY
  if (m) return validYmd(+m[3], +m[2], +m[1]) || undefined;
  return undefined;
}

function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean' || v instanceof Date) return undefined;
  const s = String(v).trim().replace(/[,\s₹]/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function toText(v) {
  if (v instanceof Date) return ymdUTC(v);
  const s = String(v).trim();
  return s.length > MAX_CELL_CHARS ? s.slice(0, MAX_CELL_CHARS) : s;
}

/** One cell → stored value, or undefined when it cannot be the column's type. */
function coerce(raw, type) {
  const v = cellValue(raw);
  if (v == null || (typeof v === 'string' && v.trim() === '')) return null;
  if (type === 'number') return toNumber(v);
  if (type === 'date') return toDate(v);
  return toText(v);
}

async function loadSheet(buffer, fileName) {
  const wb = new ExcelJS.Workbook();
  const isCsv = /\.csv$/i.test(fileName || '');
  try {
    if (isCsv) {
      let buf = buffer;
      if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.subarray(3);   // UTF-8 BOM
      // map: identity — ExcelJS's default map guesses numbers AND US-order dates (MM-DD-YYYY);
      // every CSV cell stays a string and the column's type decides.
      return await wb.csv.read(Readable.from([buf]), { map: (datum) => datum });
    }
    await wb.xlsx.load(buffer);
  } catch (err) {
    throw httpError(400, `Could not read the file as ${isCsv ? 'CSV' : 'an Excel .xlsx workbook'}`);
  }
  const ws = wb.worksheets.find((s) => s.state !== 'hidden') || wb.worksheets[0];
  if (!ws) throw httpError(400, 'The workbook has no sheets');
  return ws;
}

function rowCells(ws, r, width) {
  const row = ws.getRow(r);
  const out = [];
  for (let c = 1; c <= width; c += 1) out.push(row.getCell(c).value);
  return out;
}

/*
 * Buffer → { rows } (array-of-arrays in `columns` order), or a 400 whose
 * message an operator can act on. The header row is found in the first
 * HEADER_SCAN_ROWS rows (the one matching the most column names), so both the
 * blank template and a previously DOWNLOADED report (title bands above the
 * header) upload as-is. Header match ignores case, spacing and order.
 */
async function parseUpload(buffer, fileName, columns) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw httpError(400, 'The uploaded file is empty');
  const ws = await loadSheet(buffer, fileName);
  const width = Math.max(ws.columnCount || 0, columns.length);
  const wanted = new Map(columns.map((c) => [normName(c.name), c]));

  let headerRow = 0;
  let best = 0;
  for (let r = 1; r <= Math.min(HEADER_SCAN_ROWS, ws.rowCount); r += 1) {
    const hits = rowCells(ws, r, width).filter((v) => wanted.has(normName(cellValue(v)))).length;
    if (hits > best) { best = hits; headerRow = r; }
  }
  if (!headerRow) {
    throw httpError(400, `No header row found — the first row must hold the column names: ${columns.map((c) => c.name).join(', ')}`);
  }

  const header = rowCells(ws, headerRow, width).map((v) => normName(cellValue(v)));
  const indexOf = new Map();
  const extra = [];
  header.forEach((h, i) => {
    if (!h) return;
    if (!wanted.has(h)) { extra.push(String(cellValue(ws.getRow(headerRow).getCell(i + 1).value)).trim()); return; }
    if (indexOf.has(h)) throw httpError(400, `Column "${wanted.get(h).name}" appears twice in the file`);
    indexOf.set(h, i);
  });
  const missing = columns.filter((c) => !indexOf.has(normName(c.name))).map((c) => c.name);
  if (missing.length || extra.length) {
    const parts = [];
    if (missing.length) parts.push(`missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
    if (extra.length) parts.push(`unexpected column${extra.length > 1 ? 's' : ''}: ${extra.join(', ')}`);
    throw httpError(400, `The file's columns do not match this report — ${parts.join('; ')}. Download the template for the exact headers.`);
  }

  const idx = columns.map((c) => indexOf.get(normName(c.name)));
  const rows = [];
  const errors = [];
  let errorCount = 0;
  for (let r = headerRow + 1; r <= ws.rowCount; r += 1) {
    const cells = rowCells(ws, r, width);
    const picked = idx.map((i) => cells[i]);
    if (picked.every((v) => { const x = cellValue(v); return x == null || (typeof x === 'string' && x.trim() === ''); })) continue;
    if (rows.length >= MAX_ROWS) throw httpError(400, `The file has more than ${MAX_ROWS.toLocaleString('en-IN')} rows`);
    const out = picked.map((v, j) => {
      const val = coerce(v, columns[j].type);
      if (val === undefined) {
        errorCount += 1;
        if (errors.length < MAX_REPORTED_ERRORS) {
          const kind = columns[j].type === 'number' ? 'a number' : 'a date (YYYY-MM-DD or DD-MM-YYYY)';
          errors.push(`row ${r}, ${columns[j].name}: "${String(cellValue(v)).slice(0, 40)}" is not ${kind}`);
        }
        return null;
      }
      return val;
    });
    rows.push(out);
  }
  if (errorCount) {
    const more = errorCount > errors.length ? ` (and ${errorCount - errors.length} more)` : '';
    throw httpError(400, `Some cells do not match their column type — ${errors.join('; ')}${more}`);
  }
  if (rows.length === 0) throw httpError(400, 'The file has no data rows under the header');
  return { rows };
}

// ─── reading uploads (immutable → cached by upload id) ──────────────────

// ponytail: in-process LRU bounded by inflated bytes; per-instance, fine because uploads never change.
const CACHE_MAX_BYTES = 150 * 1024 * 1024;
const cache = new Map();   // uploadId → { data, bytes }
let cacheBytes = 0;

function cachePut(id, data, bytes) {
  cache.set(id, { data, bytes });
  cacheBytes += bytes;
  for (const [k, v] of cache) {
    if (cacheBytes <= CACHE_MAX_BYTES || cache.size <= 1) break;
    cache.delete(k);
    cacheBytes -= v.bytes;
  }
}

function cacheDrop(id) {
  const hit = cache.get(id);
  if (hit) { cache.delete(id); cacheBytes -= hit.bytes; }
}

async function readUploadData(upload) {
  const id = Number(upload.id);
  const hit = cache.get(id);
  if (hit) { cache.delete(id); cache.set(id, hit); return hit.data; }   // refresh LRU order
  const gz = await readObject(upload.data_key);
  if (!gz) throw httpError(404, 'This upload\'s data is no longer available');
  const json = zlib.gunzipSync(gz, { maxOutputLength: MAX_INFLATED_BYTES });
  const data = JSON.parse(json.toString('utf8'));
  cachePut(id, data, json.length);
  return data;
}

// ─── rows: search / sort / page ─────────────────────────────────────────

function compareCells(a, b, type) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (type === 'number') return a - b;
  if (type === 'date') return a < b ? -1 : a > b ? 1 : 0;
  return String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
}

/** Pure: never mutates `rows` (it is the shared cached array). */
function pageRows(rows, columns, { page = 1, pageSize = 50, sortBy = '', sortDir = 'asc', q = '' } = {}) {
  let out = rows;
  const needle = String(q || '').trim().toLowerCase();
  if (needle) out = out.filter((r) => r.some((v) => v != null && String(v).toLowerCase().includes(needle)));
  const si = sortBy ? columns.findIndex((c) => c.key === sortBy) : -1;
  if (si !== -1) {
    const dir = sortDir === 'desc' ? -1 : 1;
    const type = columns[si].type;
    // Blanks sort last in BOTH directions.
    out = [...out].sort((a, b) => {
      if (a[si] == null || b[si] == null) return compareCells(a[si], b[si], type);
      return dir * compareCells(a[si], b[si], type);
    });
  }
  const size = Math.min(Math.max(1, pageSize), MAX_PAGE_SIZE);
  const start = (Math.max(1, page) - 1) * size;
  return {
    total: out.length,
    page: Math.max(1, page),
    pageSize: size,
    rows: out.slice(start, start + size).map((r) => Object.fromEntries(columns.map((c, i) => [c.key, r[i] ?? null]))),
  };
}

// ─── chart ──────────────────────────────────────────────────────────────

const round2 = (n) => Math.round(n * 100) / 100;

/*
 * Group by the X column and aggregate. Date X → ascending, every date; text X
 * → top CHART_TOP_N by the first series, the rest folded into "Others" (sums
 * and counts are folded, so an "Others" average is the true weighted one).
 * A chart whose columns are not in this upload's column set renders empty.
 */
function chartData(rows, columns, chart) {
  if (!chart) return { chart: null, series: [], points: [] };
  const col = new Map(columns.map((c, i) => [c.key, { ...c, i }]));
  const x = col.get(chart.x);
  const ys = chart.agg === 'count' ? [] : chart.y.map((k) => col.get(k));
  const series = chart.agg === 'count'
    ? [{ key: 'count', name: 'Count' }]
    : chart.y.map((k) => ({ key: k, name: (col.get(k) || {}).name || k }));
  if (!x || ys.some((c) => !c)) return { chart, series, points: [] };

  const groups = new Map();   // label → { n, sums[], ns[] }
  for (const r of rows) {
    const label = r[x.i] == null ? '(Blank)' : String(r[x.i]);
    let g = groups.get(label);
    if (!g) { g = { n: 0, sums: ys.map(() => 0), ns: ys.map(() => 0) }; groups.set(label, g); }
    g.n += 1;
    ys.forEach((c, j) => { const v = r[c.i]; if (typeof v === 'number') { g.sums[j] += v; g.ns[j] += 1; } });
  }
  const valueOf = (g, j) => {
    if (chart.agg === 'count') return g.n;
    if (chart.agg === 'avg') return g.ns[j] ? round2(g.sums[j] / g.ns[j]) : 0;
    return round2(g.sums[j]);
  };
  let entries = [...groups.entries()];
  if (x.type === 'date') {
    entries.sort(([a], [b]) => (a === '(Blank)') - (b === '(Blank)') || (a < b ? -1 : a > b ? 1 : 0));
  } else {
    entries.sort(([, a], [, b]) => valueOf(b, 0) - valueOf(a, 0));
    if (entries.length > CHART_TOP_N) {
      const rest = entries.slice(CHART_TOP_N - 1);
      const others = { n: 0, sums: ys.map(() => 0), ns: ys.map(() => 0) };
      rest.forEach(([, g]) => { others.n += g.n; g.sums.forEach((s, j) => { others.sums[j] += s; others.ns[j] += g.ns[j]; }); });
      entries = [...entries.slice(0, CHART_TOP_N - 1), ['Others', others]];
    }
  }
  const points = entries.map(([label, g]) => {
    const p = { x: label };
    series.forEach((s, j) => { p[s.key] = valueOf(g, j); });
    return p;
  });
  return { chart, series, points };
}

// ─── workbooks ──────────────────────────────────────────────────────────

const fileSlug = (name) => String(name || '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'report';
const colWidth = (c) => Math.min(40, Math.max(12, c.name.length + 4));

function reportWorkbook(name, columns, rows, meta) {
  const dateKeys = new Set(columns.filter((c) => c.type === 'date').map((c) => c.key));
  return buildStyledWorkbook({
    title: name,
    meta,
    sheetName: 'Data',
    columns: columns.map((c) => ({
      header: c.name,
      key: c.key,
      width: colWidth(c),
      align: c.type === 'number' ? 'right' : 'left',
      ...(c.type === 'date' ? { numFmt: 'yyyy-mm-dd' } : {}),
    })),
    // Dates go out as real Excel dates (UTC midnight — what ExcelJS reads back as the same day).
    rows: rows.map((r) => Object.fromEntries(columns.map((c, i) => {
      const v = r[i] ?? null;
      if (v != null && dateKeys.has(c.key)) {
        const [y, m, d] = v.split('-').map(Number);
        return [c.key, new Date(Date.UTC(y, m - 1, d))];
      }
      return [c.key, v];
    }))),
    emptyMessage: 'No rows.',
  });
}

function templateWorkbook(columns) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'EasyFix CRM';
  const ws = wb.addWorksheet('Data', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({
    header: c.name,
    key: c.key,
    width: colWidth(c),
    ...(c.type === 'date' ? { style: { numFmt: 'yyyy-mm-dd' } } : {}),
  }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
  columns.forEach((c, i) => {
    head.getCell(i + 1).note = c.type === 'number' ? 'Number' : c.type === 'date' ? 'Date (YYYY-MM-DD or DD-MM-YYYY)' : 'Text';
  });
  return wb;
}

const csvCell = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
// BOM so Excel opens non-ASCII headers as UTF-8.
const templateCsv = (columns) => `﻿${columns.map((c) => csvCell(c.name)).join(',')}\r\n`;

// ─── DB reads ───────────────────────────────────────────────────────────

const REPORT_SELECT = `
  SELECT r.id, r.name, r.columns_json, r.chart_json, r.share_token, r.created_by,
         u.user_name AS owner_name, ${TS('r.created_at')} AS created_at, ${TS('r.updated_at')} AS updated_at
    FROM tbl_qs_dynamic_report r
    LEFT JOIN tbl_user u ON u.user_id = r.created_by`;

const UPLOAD_SELECT = `
  SELECT up.id, up.report_id, up.mode, up.columns_json, up.row_count, up.added_rows, up.data_key,
         up.original_name, up.size_bytes, up.uploaded_by, u.user_name AS uploaded_by_name,
         ${TS('up.uploaded_at')} AS uploaded_at
    FROM tbl_qs_dynamic_report_upload up
    LEFT JOIN tbl_user u ON u.user_id = up.uploaded_by`;

const cutoffDate = (now = new Date()) => new Date(now.getTime() - RETENTION_DAYS * 86400000);

async function roleIdsFor(reportIds) {
  const map = new Map(reportIds.map((id) => [Number(id), []]));
  if (reportIds.length === 0) return map;
  const [rows] = await pool.query(
    'SELECT report_id, role_id FROM tbl_qs_dynamic_report_role WHERE report_id IN (?)', [reportIds],
  );
  rows.forEach((r) => map.get(Number(r.report_id)).push(Number(r.role_id)));
  return map;
}

async function currentUploads(reportIds) {
  if (reportIds.length === 0) return new Map();
  const [rows] = await pool.query(
    `${UPLOAD_SELECT}
      WHERE up.id IN (SELECT MAX(id) FROM tbl_qs_dynamic_report_upload WHERE report_id IN (?) GROUP BY report_id)`,
    [reportIds],
  );
  return new Map(rows.map((r) => [Number(r.report_id), r]));
}

function uploadDto(u, currentId, { publicView = false } = {}) {
  if (!u) return null;
  const dto = {
    id: Number(u.id),
    mode: u.mode,
    rowCount: Number(u.row_count),
    addedRows: Number(u.added_rows),
    originalName: u.original_name,
    sizeBytes: u.size_bytes == null ? null : Number(u.size_bytes),
    uploadedAt: u.uploaded_at,
    uploadedBy: Number(u.uploaded_by),
    uploadedByName: u.uploaded_by_name || null,
    isCurrent: Number(u.id) === Number(currentId),
  };
  if (publicView) { delete dto.uploadedBy; delete dto.uploadedByName; }
  return dto;
}

/*
 * THE gate. → { report, roleIds }. 404 when missing, archived or not visible
 * to this user; 403 when visible but `write` is asked and not allowed.
 */
async function loadReport(access, id, { write = false } = {}) {
  const [[report]] = await pool.query(`${REPORT_SELECT} WHERE r.id = ? AND r.is_active = 1`, [id]);
  if (!report) throw httpError(404, 'Report not found');
  const roleIds = (await roleIdsFor([report.id])).get(Number(report.id));
  if (!canSee(report, roleIds, access)) throw httpError(404, 'Report not found');
  if (write && !canEdit(report, access)) throw httpError(403, 'Only this report\'s owner can change it');
  return { report, roleIds };
}

async function findUpload(reportId, uploadId) {
  if (uploadId) {
    const [[u]] = await pool.query(`${UPLOAD_SELECT} WHERE up.id = ? AND up.report_id = ?`, [uploadId, reportId]);
    if (!u) throw httpError(404, 'Upload not found');
    return u;
  }
  return (await currentUploads([reportId])).get(Number(reportId)) || null;
}

// ─── public API ─────────────────────────────────────────────────────────

async function list(access) {
  const [reports] = await pool.query(`${REPORT_SELECT} WHERE r.is_active = 1 ORDER BY r.name`);
  const ids = reports.map((r) => Number(r.id));
  const [roles, current] = await Promise.all([roleIdsFor(ids), currentUploads(ids)]);
  return {
    canCreate: access.canManage || access.isAdmin,
    isAdmin: access.isAdmin,
    reports: reports
      .filter((r) => canSee(r, roles.get(Number(r.id)), access))
      .map((r) => {
        const cur = current.get(Number(r.id));
        return {
          id: Number(r.id),
          name: r.name,
          ownerId: Number(r.created_by),
          ownerName: r.owner_name || null,
          columnCount: JSON.parse(r.columns_json).length,
          hasChart: !!r.chart_json,
          restricted: roles.get(Number(r.id)).length > 0,
          shareEnabled: !!r.share_token,
          /*
           * The TOKEN only for someone who may edit the report — the same
           * rule detail() applies. It is the secret in the public URL, so a
           * viewer who merely sees the row gets `shareEnabled` (the chip)
           * but nothing to hand on. With it, the list can offer Copy Link
           * without a round trip.
           */
          shareToken: canEdit(r, access) ? (r.share_token || null) : null,
          current: uploadDto(cur, cur && cur.id),
          canEdit: canEdit(r, access),
          canTransferOwner: canTransferOwner(r, access),
          updatedAt: r.updated_at,
        };
      }),
  };
}

async function detail(access, id) {
  const { report, roleIds } = await loadReport(access, id);
  const current = await findUpload(report.id, null);
  const [uploads] = await pool.query(
    `${UPLOAD_SELECT} WHERE up.report_id = ? AND (up.uploaded_at >= ? OR up.id = ?) ORDER BY up.id DESC`,
    [report.id, cutoffDate(), current ? current.id : 0],
  );
  const columns = JSON.parse(report.columns_json);
  const edit = canEdit(report, access);
  return {
    id: Number(report.id),
    name: report.name,
    columns,
    chart: report.chart_json ? JSON.parse(report.chart_json) : null,
    roleIds,
    ownerId: Number(report.created_by),
    ownerName: report.owner_name || null,
    shareToken: edit ? report.share_token : (report.share_token ? '' : null),
    canEdit: edit,
    canTransferOwner: canTransferOwner(report, access),
    isAdmin: access.isAdmin,
    columnsChanged: !!current && !sameColumns(JSON.parse(current.columns_json), columns),
    current: uploadDto(current, current && current.id),
    uploads: uploads.map((u) => uploadDto(u, current && current.id)),
    retentionDays: RETENTION_DAYS,
    createdAt: report.created_at,
    updatedAt: report.updated_at,
  };
}

async function validRoleIds(roleIds) {
  const ids = [...new Set((roleIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (ids.length === 0) return [];
  const [rows] = await pool.query('SELECT role_id FROM tbl_role WHERE role_id IN (?)', [ids]);
  const found = new Set(rows.map((r) => Number(r.role_id)));
  const unknown = ids.filter((i) => !found.has(i));
  if (unknown.length) throw httpError(400, `Unknown role id(s): ${unknown.join(', ')}`);
  return ids;
}

async function replaceRoles(conn, reportId, roleIds) {
  await conn.query('DELETE FROM tbl_qs_dynamic_report_role WHERE report_id = ?', [reportId]);
  if (roleIds.length) {
    await conn.query('INSERT INTO tbl_qs_dynamic_report_role (report_id, role_id) VALUES ?', [roleIds.map((r) => [reportId, r])]);
  }
}

async function inTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

async function create(access, body) {
  if (!access.canManage && !access.isAdmin) throw httpError(403, 'You cannot create custom reports');
  const columns = normalizeColumns(body.columns);
  const chart = normalizeChart(body.chart, columns);
  const roleIds = await validRoleIds(body.roleIds);
  const now = new Date();
  const id = await inTransaction(async (conn) => {
    const [res] = await conn.query(
      `INSERT INTO tbl_qs_dynamic_report (name, columns_json, chart_json, created_by, created_at, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [body.name.trim(), JSON.stringify(columns), chart ? JSON.stringify(chart) : null, access.userId, now, access.userId, now],
    );
    await replaceRoles(conn, res.insertId, roleIds);
    return res.insertId;
  });
  logger.info('Custom report created', { reportId: id, userId: access.userId, columns: columns.length });
  return detail(access, id);
}

async function update(access, id, body) {
  const { report } = await loadReport(access, id, { write: true });
  const columns = normalizeColumns(body.columns, JSON.parse(report.columns_json));
  const chart = normalizeChart(body.chart, columns);
  const roleIds = await validRoleIds(body.roleIds);
  await inTransaction(async (conn) => {
    await conn.query(
      'UPDATE tbl_qs_dynamic_report SET name = ?, columns_json = ?, chart_json = ?, updated_by = ?, updated_at = ? WHERE id = ?',
      [body.name.trim(), JSON.stringify(columns), chart ? JSON.stringify(chart) : null, access.userId, new Date(), report.id],
    );
    await replaceRoles(conn, report.id, roleIds);
  });
  return detail(access, id);
}

// Uploads are left for the retention purge (an archived report's current upload ages out too).
async function archive(access, id) {
  const { report } = await loadReport(access, id, { write: true });
  await pool.query(
    'UPDATE tbl_qs_dynamic_report SET is_active = 0, share_token = NULL, updated_by = ?, updated_at = ? WHERE id = ?',
    [access.userId, new Date(), report.id],
  );
  logger.info('Custom report archived', { reportId: report.id, userId: access.userId });
  return { archived: true };
}

/*
 * Re-point a report at a new owner.
 *
 * AUTHORISATION LIVES ON THE ROUTE (requirePropertyAllowlist on the email
 * allowlist FEATURES.canTransferReportOwner) — not here, and deliberately NOT
 * the Admin key. This function must therefore NOT run the audience check the
 * other per-report calls run: the whole point is to rescue a report whose
 * owner lost access, and the operator doing the rescue may not be in that
 * report's audience, which loadReport() would answer with a 404. It still
 * refuses an archived or missing report, and a user id that does not exist.
 */
async function transferOwner(access, id, userId) {
  const [[report]] = await pool.query(
    'SELECT id, created_by FROM tbl_qs_dynamic_report WHERE id = ? AND is_active = 1', [id],
  );
  if (!report) throw httpError(404, 'Report not found');
  if (!canTransferOwner(report, access)) {
    throw httpError(403, 'Only this report\'s owner, or an operator on the Custom Reports owner list, can transfer it');
  }
  const [[user]] = await pool.query('SELECT user_id FROM tbl_user WHERE user_id = ?', [userId]);
  if (!user) throw httpError(400, 'That user does not exist');
  await pool.query(
    'UPDATE tbl_qs_dynamic_report SET created_by = ?, updated_by = ?, updated_at = ? WHERE id = ?',
    [userId, access.userId, new Date(), report.id],
  );
  logger.info('Custom report ownership transferred', { reportId: report.id, from: report.created_by, to: userId, by: access.userId });
  /*
   * A CONFIRMATION, not detail(). detail() re-applies the audience check, so
   * returning it here would 404 an allowlisted operator who is not in the
   * report's audience — AFTER their transfer had already been written, which
   * reads as a failure that actually succeeded. Callers re-fetch the list.
   */
  return { transferred: true, ownerId: Number(userId) };
}

/*
 * Parse → (append: merge onto the current snapshot) → object → row. One upload
 * per report at a time (named lock), or two overlapping appends would each
 * build on the same "current" and the first one's rows would vanish.
 */
async function upload(access, id, { buffer, originalName, mode }) {
  const { report } = await loadReport(access, id, { write: true });
  const columns = JSON.parse(report.columns_json);
  const parsed = await parseUpload(buffer, originalName, columns);

  const { acquired, result } = await withMysqlNamedLock(`qs-dynrep-upload-${report.id}`, async () => {
    let rows = parsed.rows;
    if (mode === 'append') {
      const current = await findUpload(report.id, null);
      if (!current) throw httpError(400, 'There is no data to append to yet — use Replace for the first upload');
      if (!sameColumns(JSON.parse(current.columns_json), columns)) {
        throw httpError(400, 'The columns changed since the last upload — use Replace');
      }
      rows = (await readUploadData(current)).rows.concat(rows);
      if (rows.length > MAX_ROWS) {
        throw httpError(400, `Appending would make ${rows.length.toLocaleString('en-IN')} rows — the limit is ${MAX_ROWS.toLocaleString('en-IN')}. Use Replace.`);
      }
    }
    const key = `${S3_PREFIX}/${report.id}/${crypto.randomUUID()}.json.gz`;
    await writeObject(key, zlib.gzipSync(JSON.stringify({ columns, rows })));
    const [res] = await pool.query(
      `INSERT INTO tbl_qs_dynamic_report_upload
         (report_id, mode, columns_json, row_count, added_rows, data_key, original_name, size_bytes, uploaded_by, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [report.id, mode, JSON.stringify(columns), rows.length, parsed.rows.length, key,
        String(originalName || '').slice(0, 255), buffer.length, access.userId, new Date()],
    );
    return { uploadId: res.insertId, rowCount: rows.length };
  }, pool, { timeoutSeconds: 10 });
  if (!acquired) throw httpError(409, 'Another upload to this report is in progress — try again in a moment');

  logger.info('Custom report uploaded', {
    reportId: report.id, uploadId: result.uploadId, mode, rows: result.rowCount, added: parsed.rows.length, userId: access.userId,
  });
  return detail(access, id);
}

async function deleteUpload(access, id, uploadId) {
  const { report } = await loadReport(access, id, { write: true });
  const u = await findUpload(report.id, uploadId);
  await pool.query('DELETE FROM tbl_qs_dynamic_report_upload WHERE id = ?', [u.id]);
  cacheDrop(Number(u.id));
  if (!(await removeObject(u.data_key))) logger.warn('Custom report: upload row deleted but its object was not', { key: u.data_key });
  logger.info('Custom report upload deleted', { reportId: report.id, uploadId: u.id, userId: access.userId });
  return detail(access, id);
}

/** The rows/chart/download reads, shared by the admin and public routes. */
async function uploadData(reportId, uploadId) {
  const u = await findUpload(reportId, uploadId);
  if (!u) return { upload: null, columns: [], rows: [] };
  const data = await readUploadData(u);
  return { upload: u, columns: data.columns, rows: data.rows };
}

async function rows(access, id, query) {
  const { report } = await loadReport(access, id);
  return rowsOf(report, query.uploadId, query);
}

async function rowsOf(report, uploadId, query) {
  const { upload: u, columns, rows: all } = await uploadData(report.id, uploadId);
  return { uploadId: u ? Number(u.id) : null, columns, ...pageRows(all, columns, query) };
}

async function chart(access, id, uploadId) {
  const { report } = await loadReport(access, id);
  return chartOf(report, uploadId);
}

async function chartOf(report, uploadId) {
  const cfg = report.chart_json ? JSON.parse(report.chart_json) : null;
  if (!cfg) return chartData([], [], null);
  const { columns, rows: all } = await uploadData(report.id, uploadId);
  return chartData(all, columns, cfg);
}

async function download(access, id, uploadId) {
  const { report } = await loadReport(access, id);
  return downloadOf(report, uploadId);
}

async function downloadOf(report, uploadId) {
  const { upload: u, columns, rows: all } = await uploadData(report.id, uploadId);
  const cols = u ? columns : JSON.parse(report.columns_json);
  const meta = u
    ? `Uploaded ${u.uploaded_at}${u.uploaded_by_name ? ` by ${u.uploaded_by_name}` : ''} · ${all.length} rows`
    : 'No data uploaded yet';
  const stamp = u ? u.uploaded_at.slice(0, 10) : fileStamp();
  return { filename: `${fileSlug(report.name)}-${stamp}.xlsx`, workbook: reportWorkbook(report.name, cols, all, meta) };
}

async function template(access, id, format) {
  const { report } = await loadReport(access, id, { write: true });
  const columns = JSON.parse(report.columns_json);
  const base = `${fileSlug(report.name)}-template`;
  if (format === 'csv') return { filename: `${base}.csv`, csv: templateCsv(columns) };
  return { filename: `${base}.xlsx`, workbook: templateWorkbook(columns) };
}

async function setShare(access, id, on) {
  const { report } = await loadReport(access, id, { write: true });
  const token = on ? crypto.randomBytes(16).toString('hex') : null;
  await pool.query('UPDATE tbl_qs_dynamic_report SET share_token = ?, updated_by = ?, updated_at = ? WHERE id = ?',
    [token, access.userId, new Date(), report.id]);
  logger.info(`Custom report public link ${on ? 'enabled' : 'disabled'}`, { reportId: report.id, userId: access.userId });
  return { shareToken: token };
}

// ─── public link ────────────────────────────────────────────────────────

async function reportByToken(token) {
  if (!SHARE_TOKEN_RE.test(String(token || ''))) throw httpError(404, 'This report link is not available');
  const [[report]] = await pool.query(`${REPORT_SELECT} WHERE r.share_token = ? AND r.is_active = 1`, [token]);
  if (!report) throw httpError(404, 'This report link is not available');
  return report;
}

async function publicSummary(token) {
  const report = await reportByToken(token);
  const current = await findUpload(report.id, null);
  return {
    name: report.name,
    columns: current ? JSON.parse(current.columns_json) : JSON.parse(report.columns_json),
    chart: report.chart_json ? JSON.parse(report.chart_json) : null,
    current: uploadDto(current, current && current.id, { publicView: true }),
    retentionDays: RETENTION_DAYS,
  };
}

const publicRows = async (token, query) => rowsOf(await reportByToken(token), null, query);
const publicChart = async (token) => chartOf(await reportByToken(token), null);
const publicDownload = async (token) => downloadOf(await reportByToken(token), null);

// ─── retention ──────────────────────────────────────────────────────────

/*
 * Uploads eligible for deletion: older than the cutoff AND not the current
 * upload of an ACTIVE report. Pure (SQL + params) so the latest-upload guard
 * is testable without a database.
 */
function purgeQuery(cutoff, limit) {
  return {
    sql: `SELECT up.id, up.data_key
            FROM tbl_qs_dynamic_report_upload up
            JOIN tbl_qs_dynamic_report r ON r.id = up.report_id
           WHERE up.uploaded_at < ?
             AND (r.is_active = 0
                  OR up.id <> (SELECT MAX(u2.id) FROM tbl_qs_dynamic_report_upload u2 WHERE u2.report_id = up.report_id))
           ORDER BY up.id
           LIMIT ?`,
    params: [cutoff, limit],
  };
}

const PURGE_BATCH = 200;
const PURGE_MAX_BATCHES = 25;

async function purgeUnlocked() {
  const cutoff = cutoffDate();
  let expired = 0;
  let deleted = 0;
  let failed = 0;
  for (let b = 0; b < PURGE_MAX_BATCHES; b += 1) {
    const { sql, params } = purgeQuery(cutoff, PURGE_BATCH);
    const [batch] = await pool.query(sql, params);
    expired += batch.length;
    const gone = [];
    for (const u of batch) {
      // A failed object delete keeps the row, so the next run retries it.
      if (await removeObject(u.data_key)) { gone.push(u.id); cacheDrop(Number(u.id)); } else failed += 1;
    }
    if (gone.length) {
      await pool.query('DELETE FROM tbl_qs_dynamic_report_upload WHERE id IN (?)', [gone]);
      deleted += gone.length;
    }
    if (batch.length < PURGE_BATCH || gone.length === 0) break;
  }
  return { expired, deleted, failed, retentionDays: RETENTION_DAYS };
}

async function purgeExpired() {
  const { acquired, result } = await withMysqlNamedLock('qs-dynamic-report-retention', purgeUnlocked);
  return acquired ? result : { skipped: true, reason: 'another instance is running it' };
}

module.exports = {
  KEYS,
  RETENTION_DAYS,
  MAX_FILE_BYTES,
  MAX_PAGE_SIZE,
  accessOf,
  list,
  detail,
  create,
  update,
  archive,
  transferOwner,
  upload,
  deleteUpload,
  rows,
  chart,
  download,
  template,
  setShare,
  publicSummary,
  publicRows,
  publicChart,
  publicDownload,
  purgeExpired,
  // Pure helpers, exported for tests.
  _internal: {
    normalizeColumns, normalizeChart, parseUpload, pageRows, chartData, purgeQuery,
    canSee, canEdit, canTransferOwner, sameColumns, coerce, templateWorkbook, reportWorkbook,
  },
};
