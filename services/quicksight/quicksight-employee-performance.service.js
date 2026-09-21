/*
 * QuickSight — Employee Performance (uploaded snapshot).
 *
 * Unlike every other QuickSight report this one is NOT computed from
 * easyfix_core. MIS builds it off-platform: a raw workbook (Open/Close order,
 * targets, emp detail, TimeChamp, CRM counts, IVR) goes through build_data.py,
 * which writes `data.js` — a single `const D={...};` literal that the
 * dashboard page (assets/quicksight/employee-performance/dashboard.html)
 * renders. Half of those sources do not exist in the DB, so the report is a
 * snapshot that an authorised operator uploads, not a query.
 *
 * WHAT IS STORED. Never the uploaded file itself. The upload is parsed as
 * JSON (after stripping the `const D=` / `;` wrapper) and shape-checked, then
 * RE-SERIALISED — so the stored object is pure data, whatever the file held.
 * `<` is escaped as < on the way out, which keeps the JSON valid and
 * makes it impossible for a string inside it to close the <script> element the
 * dashboard is injected into. Stored gzipped: the JSON compresses ~10x.
 *
 * WHERE. Private S3 (`QuickSight/EmployeePerformance/`) — it attributes
 * revenue to named employees, so it must never sit under the public
 * /easydoc tree. When S3 is not configured (local dev) it falls back to a
 * private directory on disk; that copy does not survive a container redeploy.
 *
 * meta.json is written AFTER the data object and is what readers key on, so
 * a failed data write never advertises a snapshot that is not there.
 *
 * Each upload's data gets its OWN object (data-<uploadedAt>-<rand>.json.gz)
 * and meta.dataKey names it, so meta.json alone decides what is loaded. With
 * one shared data.json.gz, two overlapping uploads could interleave
 * (A data, B data, B meta, A meta): meta said A while the object held B, and
 * instances served different numbers. Now whichever meta lands last is
 * complete and points at its own data. Meta without dataKey (written before
 * this change) still reads data.json.gz.
 */

const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const zlib = require('node:zlib');

const gunzip = promisify(zlib.gunzip);
const crypto = require('node:crypto');

const s3 = require('../../utils/s3-storage');
const logger = require('../../logger');

const S3_PREFIX = 'QuickSight/EmployeePerformance';
const DATA_NAME = 'data.json.gz';   // legacy: meta without dataKey
const DATA_KEY_RE = /^data-[A-Za-z0-9-]+\.json\.gz$/;
const META_NAME = 'meta.json';

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'assets', 'quicksight', 'employee-performance', 'dashboard.html');
// The one line build_data.py's README says was changed in the original page.
const DATA_HOOK = '<script src="data.js"></script>';

// A gzip bomb must not be able to exhaust memory: cap what we inflate.
const MAX_INFLATED_BYTES = 200 * 1024 * 1024;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Top-level keys build_data.py emits and dashboard.html reads.
const SHAPE = {
  employees: isPlainObject,
  verticals: Array.isArray,
  months: Array.isArray,
  dates: Array.isArray,
  primarySpocs: Array.isArray,
  zonalManagers: Array.isArray,
  teamMembers: isPlainObject,
  displayNames: isPlainObject,
  txRows: Array.isArray,
  unassigned: Array.isArray,
  zmBreakdown: Array.isArray,
};

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function localDir() {
  return process.env.QS_EMPLOYEE_PERFORMANCE_DIR
    || path.join(__dirname, '..', '..', 'uploads', 'private', 'quicksight-employee-performance');
}

/*
 * Buffer (data.js / data.json, optionally gzipped) → { data, summary }.
 * Throws a 400-status error with an operator-readable message on anything
 * that is not a dashboard data file.
 */
function parseDashboardData(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw badRequest('The uploaded file is empty');

  let raw = buffer;
  if (raw[0] === 0x1f && raw[1] === 0x8b) {
    try {
      raw = zlib.gunzipSync(raw, { maxOutputLength: MAX_INFLATED_BYTES });
    } catch (e) {
      throw badRequest(e.code === 'ERR_BUFFER_TOO_LARGE' ? 'The uploaded file is too large' : 'The uploaded file is not a valid gzip archive');
    }
  }

  const text = raw.toString('utf8')
    .replace(/^﻿/, '')
    .trim()
    .replace(/^(?:(?:const|let|var)\s+D|window\.D)\s*=\s*/, '')
    .replace(/;\s*$/, '');

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw badRequest('This is not a dashboard data file. Upload the data.js written by update_dashboard.bat.');
  }
  if (!isPlainObject(data)) throw badRequest('This is not a dashboard data file. Upload the data.js written by update_dashboard.bat.');

  const problems = Object.entries(SHAPE)
    .filter(([key, check]) => !check(data[key]))
    .map(([key]) => key);
  if (problems.length) {
    throw badRequest(`The data file is missing or has invalid: ${problems.join(', ')}`);
  }
  if (data.dates.length === 0 || !data.dates.every((d) => typeof d === 'string' && DATE_RE.test(d))) {
    throw badRequest('The data file has no valid dates (expected YYYY-MM-DD)');
  }
  if (!data.months.every((m) => typeof m === 'string' && MONTH_RE.test(m))) {
    throw badRequest('The data file has invalid months (expected YYYY-MM)');
  }
  if (Object.keys(data.employees).length === 0) throw badRequest('The data file has no employees');

  return {
    data,
    summary: {
      dateFrom: data.dates[0],
      dateTo: data.dates[data.dates.length - 1],
      employeeCount: Object.keys(data.employees).length,
      spocCount: data.primarySpocs.length,
    },
  };
}

// JSON that is safe to place verbatim inside a <script> element.
function toScriptSafeJson(data) {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

// ─── storage (S3, or a private local directory when S3 is off) ──────────

async function writeObject(name, buffer, contentType) {
  if (s3.isEnabled()) {
    await s3.putAtKey({ key: `${S3_PREFIX}/${name}`, buffer, contentType });
    return;
  }
  const dir = localDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, target);
}

async function readObject(name) {
  if (s3.isEnabled()) return s3.getObjectBuffer(`${S3_PREFIX}/${name}`);
  try {
    return fs.readFileSync(path.join(localDir(), name));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// ─── parsed-snapshot cache ──────────────────────────────────────────────

/*
 * The native Employee tab asks for options, summary, open jobs, technicians and
 * member detail, each over the whole D (~6.5 MB of JSON, tens of MB parsed).
 * Inflating and parsing that per request would dominate every call, so the
 * parsed object is kept — ONE entry, keyed on meta.uploadedAt.
 *
 * meta.json is still read on every call and is what decides: a different
 * uploadedAt (a newer upload, from this instance or another one sharing S3)
 * replaces the entry. Concurrent first requests share one load. `generation`
 * moves on every saveSnapshot, so a load that started before an upload can
 * never overwrite the entry that upload primed.
 *
 * The cached object is shared by every request: callers must treat it as
 * read-only (aggregate.js never mutates D).
 */
let snapshotCache = null;   // { uploadedAt, data }
let snapshotLoad = null;    // { uploadedAt, generation, promise }
let generation = 0;

// The data object a meta describes. The pattern keeps a hand-edited meta from
// naming a path outside the prefix / private directory.
function dataNameOf(meta) {
  return typeof meta.dataKey === 'string' && DATA_KEY_RE.test(meta.dataKey) ? meta.dataKey : DATA_NAME;
}

async function loadSnapshotData(meta) {
  const gz = await readObject(dataNameOf(meta));
  if (!gz) return null;
  const raw = await gunzip(gz, { maxOutputLength: MAX_INFLATED_BYTES });
  return JSON.parse(raw.toString('utf8'));
}

// The stored dashboard data object D, or null when nothing is uploaded.
async function getSnapshotD() {
  const meta = await getMeta();
  if (!meta) return null;
  const { uploadedAt } = meta;

  if (snapshotCache && snapshotCache.uploadedAt === uploadedAt) return snapshotCache.data;
  if (snapshotLoad && snapshotLoad.uploadedAt === uploadedAt && snapshotLoad.generation === generation) {
    return snapshotLoad.promise;
  }

  const startedAt = generation;
  const promise = loadSnapshotData(meta);
  const load = { uploadedAt, generation: startedAt, promise };
  snapshotLoad = load;
  try {
    const data = await promise;
    if (data && generation === startedAt) snapshotCache = { uploadedAt, data };
    return data;
  } finally {
    if (snapshotLoad === load) snapshotLoad = null;
  }
}

// ─── public API ─────────────────────────────────────────────────────────

async function saveSnapshot({ buffer, originalName, user }) {
  const { data, summary } = parseDashboardData(buffer);
  const json = toScriptSafeJson(data);

  if (!s3.isEnabled()) {
    logger.warn('Employee Performance snapshot stored on local disk (S3 disabled) — it will not survive a redeploy', { dir: localDir() });
  }

  // From here the stored data may no longer match the cached entry.
  generation += 1;
  snapshotCache = null;
  snapshotLoad = null;

  const uploadedAt = new Date().toISOString();
  // Same-millisecond uploads on two instances must still get two objects.
  const dataKey = `data-${uploadedAt.replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}.json.gz`;
  // ponytail: superseded data objects are kept (~0.6 MB each); deleting the
  // previous one can race a reader still loading it. Add an S3 lifecycle rule
  // on the prefix if the count ever matters.
  await writeObject(dataKey, zlib.gzipSync(json), 'application/gzip');

  const meta = {
    ...summary,
    uploadedAt,
    dataKey,
    uploadedBy: { userId: user?.user_id ?? null, name: user?.user_name || null },
    originalName: originalName ? String(originalName).slice(0, 200) : null,
    sizeBytes: Buffer.byteLength(json),
  };
  await writeObject(META_NAME, Buffer.from(JSON.stringify(meta)), 'application/json');
  // Prime: `data` is exactly what the stored JSON parses back to (it came from
  // JSON.parse, and toScriptSafeJson's escape of '<' parses back to '<').
  generation += 1;
  snapshotCache = { uploadedAt: meta.uploadedAt, data };
  return meta;
}

async function getMeta() {
  const buf = await readObject(META_NAME);
  return buf ? JSON.parse(buf.toString('utf8')) : null;
}

let templateCache = null;
function dashboardTemplate() {
  if (templateCache) return templateCache;
  const html = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  if (!html.includes(DATA_HOOK)) {
    throw new Error(`Employee Performance template has no ${DATA_HOOK} line to inject data into`);
  }
  templateCache = html;
  return html;
}

/*
 * The composed page is ~6.5 MB, which the browser needs seconds to parse and
 * paint. The iframe's own `load` event fires BEFORE that paint, so the CRM
 * cannot use it to know when to reveal the frame — it showed a blank white box
 * instead. This script is the frame saying "I am drawn". Sandboxed frames have
 * an opaque origin, so it posts to '*' and the CRM matches on the message value
 * alone (revealing a frame is all the message can do).
 *
 * Two animation frames after load is the accurate "first paint has happened"
 * signal, but requestAnimationFrame is SUSPENDED while the window is hidden —
 * a background tab would then never reveal its frame, which is how this was
 * first seen. The timer is therefore not a nicety: whichever fires first wins,
 * and `sent` keeps it to one message.
 */
const READY_MESSAGE = 'ef-employee-performance-ready';
const READY_SIGNAL = '<script>(function(){var sent=false;'
  + `var send=function(){if(sent){return;}sent=true;try{parent.postMessage('${READY_MESSAGE}','*');}catch(e){}};`
  + 'var after=function(){if(typeof requestAnimationFrame==="function"){'
  + 'requestAnimationFrame(function(){requestAnimationFrame(send);});}setTimeout(send,150);};'
  + 'if(document.readyState==="complete"){after();}else{window.addEventListener("load",after);}})();</script>';

// Template with the stored data inlined, or null when nothing is uploaded.
async function getDashboardHtml() {
  const meta = await getMeta();
  if (!meta) return null;
  const gz = await readObject(dataNameOf(meta));
  if (!gz) return null;
  const json = zlib.gunzipSync(gz).toString('utf8');
  // Function replacers throughout: a string replacement would expand
  // `$&`-style patterns occurring inside the data.
  const html = dashboardTemplate().replace(DATA_HOOK, () => `<script>const D=${json};</script>`);
  return html.includes('</body>')
    ? html.replace('</body>', () => `${READY_SIGNAL}</body>`)
    : html + READY_SIGNAL;
}

module.exports = {
  parseDashboardData,
  saveSnapshot,
  getMeta,
  getDashboardHtml,
  getSnapshotD,
  READY_MESSAGE,
  _internals: { toScriptSafeJson, dashboardTemplate, DATA_HOOK },
};
