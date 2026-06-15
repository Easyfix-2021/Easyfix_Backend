/*
 * India Locations service — wraps the data.gov.in pincode-directory
 * seeder for HTTP invocation + provides paginated read helpers for the
 * Admin Actions "Seed India Locations" modal.
 *
 * Originally lived inline in scripts/seed-india-locations.js. The CLI
 * still calls the same `runSeed()` exported here so there is exactly
 * one implementation of the import logic; the route + the CLI both
 * dispatch through this module.
 *
 * EXPORTED SURFACE
 *   runSeed({ csvPath, force, dryRun, logger }) → stats
 *   listPincodesPaginated({ limit, offset })    → { items, total, seededAt }
 *   exportAllPincodes()                          → async generator of rows
 *   getSeededAt()                                → ISO string or null
 *
 * SCHEMA NOTES (mirrors the script comments — kept for callers reading
 * THIS file rather than the script):
 *   - tbl_pincode.pincode is UNIQUE; we INSERT IGNORE
 *   - tbl_city has BOTH state_id AND stateId; we write to both
 *   - "City" in the operator vocabulary maps to `districtname`
 *   - easyfix_properties.india_data_seeded='true' gates re-runs
 *   - easyfix_properties.india_data_seeded_at='<ISO timestamp>' marks
 *     the start of the most recent seed run; rows whose created_date
 *     is >= this timestamp are tagged "Added" in the modal table.
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const { pool } = require('../db');
const baseLogger = require('../logger');

const PROP_KEY_DONE     = 'india_data_seeded';
const PROP_KEY_SEEDED_AT = 'india_data_seeded_at';
/*
 * View-baseline timestamp (2026-06-10). Set explicitly via the new
 * `POST /seed/acknowledge` endpoint when the operator clicks Refresh.
 * Once set, the per-row Remark computation flips its reference point
 * from `seededAt` to `viewBaselineAt`:
 *   - row.created_date >= baseline → 'Added'   (inserted since baseline)
 *   - row.updated_date >= baseline AND
 *     row.created_date < baseline  → 'Updated' (modified-in-place)
 *   - otherwise                    → 'Existing'
 * Click sequence on Refresh: BE sets viewBaselineAt=now() then the FE
 * refetches the list — every row now reads as 'Existing' (its
 * created_date and updated_date both predate the new baseline).
 */
const PROP_KEY_VIEW_BASELINE_AT = 'india_data_view_baseline_at';
/*
 * Last-completed snapshot persistence key (2026-06-10). Holds the JSON
 * blob of the most recent completed seed job so the modal's "Last
 * Seeding Details" panel survives BE restarts (the in-memory `jobs`
 * Map is process-local and evaporates).
 */
const PROP_KEY_LAST_COMPLETED = 'india_data_last_completed_seed_job';
const BATCH = 500;

/* ─── Async job registry (in-memory, single-process) ───────────────
 * Tracks the in-flight + recent seed runs so the modal can poll for
 * progress and reattach after a refresh / close-reopen. Only one job
 * is allowed to run at a time; concurrent starts return 409.
 *
 * The map is module-scoped (process-local). On process restart all
 * job state is lost — acceptable for an operator action that is
 * almost always run from a single CRM tab.
 */
const jobs = new Map();
let currentJobId = null;

function snapshotJob(jobId) {
  const j = jobs.get(jobId);
  if (!j) return null;
  return {
    jobId,
    status: j.status,
    stats: j.stats,
    started_at: j.started_at,
    finished_at: j.finished_at,
    error: j.error,
    skipped: j.skipped || false,
    reason: j.reason || null,
    took_ms: j.took_ms || null,
  };
}

function getSeedJob(jobId) {
  return snapshotJob(jobId);
}

function getCurrentSeedJob() {
  if (!currentJobId) return { jobId: null };
  const snap = snapshotJob(currentJobId);
  return snap || { jobId: null };
}

function cancelSeedJob(jobId) {
  const j = jobs.get(jobId);
  if (!j) {
    const err = new Error('Seed job not found');
    err.status = 404;
    throw err;
  }
  if (j.status !== 'running') {
    return snapshotJob(jobId);
  }
  j.cancel();
  return snapshotJob(jobId);
}

/*
 * Persist a terminal job snapshot to easyfix_properties so the modal's
 * "Last Seeding Details" panel can render the last successful run even
 * after a BE restart. Stored as a JSON blob under PROP_KEY_LAST_COMPLETED.
 *
 * Best-effort: failure is logged but doesn't bubble up — the run itself
 * already succeeded by the time we get here.
 */
async function persistLastCompletedSnapshot(snap, logger) {
  try {
    await pool.query(
      `INSERT INTO easyfix_properties (property_key, property_value)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE property_value = VALUES(property_value)`,
      [PROP_KEY_LAST_COMPLETED, JSON.stringify(snap)],
    );
  } catch (e) {
    (logger || baseLogger).warn(
      { err: e },
      'india-seed: failed to persist last-completed snapshot (non-fatal)',
    );
  }
}

/*
 * getLastCompletedSeedJob (2026-06-10) — returns the snapshot of the most
 * recent successfully-completed seed run, or `null` if none exists.
 *
 * Source-of-truth priority:
 *   1. In-memory `jobs` map — iterate values, filter to status==='completed',
 *      sort by finished_at desc, take the first. Captures runs from THIS
 *      process before they were persisted, and is also fastest.
 *   2. easyfix_properties.india_data_last_completed_seed_job — the JSON
 *      blob written when a run reached terminal 'completed'. Survives BE
 *      restarts.
 *
 * Returns the same shape as snapshotJob() so the FE can render either
 * source uniformly.
 */
async function getLastCompletedSeedJob() {
  let best = null;
  for (const [jobId, j] of jobs.entries()) {
    if (j.status !== 'completed') continue;
    if (!j.finished_at) continue;
    if (!best || j.finished_at > best.finished_at) {
      best = { jobId, ...j };
    }
  }
  if (best) {
    return {
      jobId: best.jobId,
      status: best.status,
      stats: best.stats,
      started_at: best.started_at,
      finished_at: best.finished_at,
      error: best.error,
      skipped: best.skipped || false,
      reason: best.reason || null,
      took_ms: best.took_ms || null,
    };
  }
  try {
    const [rows] = await pool.query(
      'SELECT property_value FROM easyfix_properties WHERE property_key = ? LIMIT 1',
      [PROP_KEY_LAST_COMPLETED],
    );
    if (!rows.length) return null;
    const raw = rows[0].property_value;
    if (!raw) return null;
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

class CancelledError extends Error {
  constructor() {
    super('Seed cancelled by operator');
    this.cancelled = true;
  }
}

/*
 * Map a raw internal error to a short, actionable, operator-facing
 * message for the Seed India Locations modal. The raw error is still
 * logged + stored on job.error_detail for engineers; this is only what
 * the non-technical operator sees in the UI. Keep messages calm and
 * action-oriented ("retry", "check X") — never leak Node/SQL internals.
 */
function friendlyJobError(e) {
  const raw = e && e.message ? e.message : String(e);
  if (/readline was closed|ERR_USE_AFTER_CLOSE/i.test(raw)) {
    return 'The seed file could not be read all the way through. Please retry — if it keeps happening, the source CSV may be malformed.';
  }
  if (/ECONNREFUSED|ETIMEDOUT|PROTOCOL_CONNECTION_LOST|ER_LOCK|ER_|Deadlock|pool|connection lost|connect ETIMEDOUT/i.test(raw)) {
    return 'Lost the database connection while seeding. Please check the database and retry.';
  }
  if (/Failed to fetch CSV|HTTP \d{3}|fetch failed|ENOTFOUND|getaddrinfo/i.test(raw)) {
    return 'Could not download the source pincode CSV. Check the network / source URL and retry.';
  }
  if (/ENOENT|no such file/i.test(raw)) {
    return 'The seed CSV file was not found at the configured path.';
  }
  return 'Seeding failed unexpectedly. Please retry; if it continues, share the time of this run with engineering.';
}

/*
 * `startSeedJob` (2026-06-10): now accepts `csvUrl` alongside the
 * existing buffer / path inputs. When neither buffer nor path is
 * supplied, runSeed itself falls through to the URL fetch (env
 * `INDIA_PINCODES_CSV_URL` or DEFAULT_INDIA_CSV_URL). This lets the
 * FE call with no body at all and "just work" — operator clicks
 * Start Seeding, BE fetches the public CSV from GitHub.
 */
function startSeedJob({
  csvBuffer = null,
  csvPath = null,
  csvUrl = null,
  force = false,
  logger = baseLogger,
} = {}) {
  if (currentJobId) {
    const cur = jobs.get(currentJobId);
    if (cur && cur.status === 'running') {
      const err = new Error('A seed job is already running');
      err.status = 409;
      err.jobId = currentJobId;
      throw err;
    }
  }
  // No upfront source check — runSeed will resolve URL → buffer
  // internally when nothing concrete is supplied.

  const jobId = randomUUID();
  let cancelled = false;
  const job = {
    status: 'running',
    stats: {
      rows_seen: 0,
      rows_invalid: 0,
      states_created: 0,
      cities_created: 0,
      pincodes_inserted: 0,
      pincodes_skipped_dupe: 0,
      batches_failed: 0,
      pincodes_failed: 0,
    },
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    skipped: false,
    reason: null,
    took_ms: null,
    cancel: () => { cancelled = true; },
  };
  jobs.set(jobId, job);
  currentJobId = jobId;

  // Fire-and-forget. setImmediate lets the route respond before the
  // long-running work begins.
  setImmediate(async () => {
    try {
      const result = await runSeed({
        csvBuffer,
        csvPath,
        csvUrl,
        force,
        dryRun: false,
        logger,
        onProgress: (stats) => {
          // Mutate in-place so polling sees live counts.
          Object.assign(job.stats, stats);
        },
        isCancelled: () => cancelled,
      });
      if (result.skipped) {
        job.skipped = true;
        job.reason = result.reason;
        job.status = 'completed';
      } else {
        job.stats = result.stats;
        job.took_ms = result.took_ms;
        job.status = cancelled ? 'cancelled' : 'completed';
      }
    } catch (e) {
      if (e && e.cancelled) {
        job.status = 'cancelled';
        job.error = e.message;
      } else {
        job.status = 'failed';
        // Operator-facing message (the modal renders job.error). The raw
        // technical error goes to the logs via error_detail + logger.error
        // so engineers can still diagnose, but ops sees something
        // actionable instead of e.g. "readline was closed".
        job.error = friendlyJobError(e);
        job.error_detail = e && e.message ? e.message : String(e);
        logger.error({ err: e, jobId }, 'india-seed: job failed');
      }
    } finally {
      job.finished_at = new Date().toISOString();
      if (currentJobId === jobId) currentJobId = null;
      // Persist on terminal 'completed' so the modal's Last Seeding
      // Details panel survives BE restarts. Cancelled/failed runs are
      // intentionally NOT persisted — operators care about the last
      // GOOD run for the summary panel.
      if (job.status === 'completed') {
        await persistLastCompletedSnapshot(snapshotJob(jobId), logger);
      }
    }
  });

  return jobId;
}

/* ─── runSeed: shared by CLI + HTTP ──────────────────────────────── */

/*
 * Default open-data India pincode CSV (2026-06-10 v2).
 *
 * `datameet/PinCode/data/IN.csv` — verified reachable, well-maintained
 * open-data repo by Data{Meet} (a respected Indian open-data community).
 * The previous candidate (nikhilkumarsingh/india-pincode-csv) returned
 * 404 — the file path didn't exist. This URL serves a 6-column GeoNames-
 * format CSV: `key, place_name, admin_name1, latitude, longitude, accuracy`
 * where `key` is `IN/<6-digit-pincode>` and `admin_name1` is the state.
 *
 * The parser detects the GeoNames header shape and adapts (see
 * `buildColMap` below). Override via `INDIA_PINCODES_CSV_URL` env if
 * your ops want a different source.
 */
const DEFAULT_INDIA_CSV_URL = 'https://raw.githubusercontent.com/datameet/PinCode/master/data/IN.csv';

/*
 * Resolve the effective CSV URL — honours the env override, falls back
 * to the hardcoded default. Exported so the new `GET /seed/source-url`
 * endpoint can surface what the BE is about to fetch before the
 * operator clicks Start Seeding.
 */
function getEffectiveCsvUrl() {
  return process.env.INDIA_PINCODES_CSV_URL || DEFAULT_INDIA_CSV_URL;
}

/*
 * In-process 24h CSV cache (2026-06-10). Re-running the seed within
 * the TTL window skips the GitHub HTTP round-trip — the ~10MB buffer
 * is reused from RAM. Cache is per-URL so an env override or explicit
 * csvUrl gets its own bucket. Evaporates on BE restart. Single-entry
 * Map keyed by URL — never grows.
 */
const CSV_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const csvCache = new Map(); // url → { buffer, at }

/*
 * Fetch the configured CSV URL into a Buffer. Used by `runSeed` when
 * the caller didn't supply csvBuffer / csvPath directly. Streams via
 * the global fetch API (Node 18+). Throws a 502-ish error if the URL
 * isn't reachable so the FE can surface a clear message.
 *
 * Cache: hits the 24h in-process cache when present + fresh.
 */
async function fetchCsvBufferFromUrl(url, logger) {
  const hit = csvCache.get(url);
  if (hit && Date.now() - hit.at < CSV_CACHE_TTL_MS) {
    logger.info(`india-locations: CSV cache HIT for ${url} (${(hit.buffer.length / (1024 * 1024)).toFixed(1)} MB, ${Math.floor((Date.now() - hit.at) / 60000)} min old)`);
    return hit.buffer;
  }
  logger.info(`india-locations: CSV cache MISS — fetching ${url}`);
  const resp = await fetch(url);
  if (!resp.ok) {
    const err = new Error(`Failed to fetch CSV from ${url} — HTTP ${resp.status} ${resp.statusText}`);
    err.status = 502;
    throw err;
  }
  const ab = await resp.arrayBuffer();
  const buf = Buffer.from(ab);
  logger.info(`india-locations: fetched ${(buf.length / (1024 * 1024)).toFixed(1)} MB`);
  csvCache.set(url, { buffer: buf, at: Date.now() });
  return buf;
}

async function runSeed({
  csvPath = null,
  csvBuffer = null,
  /*
   * URL of a publicly-accessible India pincode CSV. When set (and no
   * csvBuffer/csvPath provided), the seeder fetches this URL into a
   * Buffer and proceeds as if csvBuffer were supplied. Default points
   * at a well-known GitHub-hosted mirror of the data.gov.in dataset
   * (see DEFAULT_INDIA_CSV_URL above).
   */
  csvUrl = null,
  force = false,
  dryRun = false,
  logger = baseLogger,
  onProgress = () => {},
  isCancelled = () => false,
} = {}) {
  /*
   * Source-resolution priority: explicit buffer > path > url > env > default URL.
   * If none of the first three are supplied, fall through to the URL fetch
   * so the FE can call this with no args and "just work".
   */
  if (!csvBuffer && !csvPath && !csvUrl) {
    csvUrl = process.env.INDIA_PINCODES_CSV_URL || DEFAULT_INDIA_CSV_URL;
  }
  if (!csvBuffer && !csvPath && csvUrl) {
    csvBuffer = await fetchCsvBufferFromUrl(csvUrl, logger);
  }
  if (!csvBuffer && !csvPath) {
    const err = new Error('CSV source could not be resolved');
    err.status = 400;
    throw err;
  }
  if (csvPath && !csvBuffer && !fs.existsSync(csvPath)) {
    const err = new Error(`CSV file not found at ${path.resolve(csvPath)}`);
    err.status = 400;
    throw err;
  }

  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString().slice(0, 19).replace('T', ' ');

  // ─── Property gate ──────────────────────────────────────────────
  if (!force) {
    const [rows] = await pool.query(
      'SELECT property_value FROM easyfix_properties WHERE property_key = ? LIMIT 1',
      [PROP_KEY_DONE],
    );
    if (rows.length && String(rows[0].property_value).toLowerCase() === 'true') {
      return {
        skipped: true,
        reason: `Already seeded — easyfix_properties.${PROP_KEY_DONE} = 'true'. Pass force=true to re-run.`,
        stats: null,
        took_ms: 0,
      };
    }
  }

  // Persist the seed-start timestamp BEFORE the run so any concurrent
  // reader knows the in-flight cutoff. Even if the run fails mid-way,
  // the timestamp remains the marker for the partial set just inserted.
  if (!dryRun) {
    await pool.query(
      `INSERT INTO easyfix_properties (property_key, property_value)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE property_value = VALUES(property_value)`,
      [PROP_KEY_SEEDED_AT, startedAtIso],
    );
  }

  // ─── Country (India) ────────────────────────────────────────────
  const countryId = await ensureIndia();
  logger.info(`india-seed: country_id resolved (India / IN) → ${countryId}`);

  // ─── Preload dedupe caches ──────────────────────────────────────
  const stateCache = new Map();
  const cityCache  = new Map();
  await preloadStates(countryId, stateCache);
  await preloadCities(cityCache);
  logger.info(
    `india-seed: preloaded ${stateCache.size} state(s) + ${cityCache.size} city/state pairs`,
  );

  const stats = {
    rows_seen: 0,
    rows_invalid: 0,
    states_created: 0,
    cities_created: 0,
    pincodes_inserted: 0,
    pincodes_skipped_dupe: 0,
    batches_failed: 0,
    pincodes_failed: 0,
  };

  /*
   * In-memory line iteration (2026-06-12 fix for "readline was closed").
   *
   * Previously this streamed the CSV through `readline.createInterface`
   * + `for await (const line of rl)`. That async iterator races against
   * a fast, FINITE input: `Readable.from(csvBuffer)` pushes the whole
   * ~10MB in-memory buffer almost instantly, so the interface emits
   * 'close' while the slow per-row DB work (~30-50ms/row against the
   * remote DB) is still draining buffered lines. Node's readline async
   * iterator then rejects the next `.next()` with
   * `ERR_USE_AFTER_CLOSE: readline was closed`, surfacing as a spurious
   * "job failed" partway through a large seed (observed ~10k+ rows in).
   *
   * The CSV is ALREADY fully in RAM for the buffer/URL path (fetched
   * whole + 24h-cached), so streaming never bought the bounded-memory
   * benefit it implies. We split the full text into a line array and
   * iterate synchronously — no stream, no readline interface, no async
   * iterator to race. The CLI file path is read fully too (a pincode CSV
   * is ~10MB, same order as the URL buffer we already load whole),
   * keeping a single code path.
   */
  const csvText = csvBuffer
    ? csvBuffer.toString('utf-8')
    : await fs.promises.readFile(csvPath, 'utf-8');
  // Split on LF or CRLF — matches the old `crlfDelay: Infinity` line
  // boundaries. A trailing newline yields a final '' element, already
  // skipped by the blank-line guard below.
  const lines = csvText.split(/\r?\n/);

  let colMap = null;
  let pincodeBuffer = [];
  let lineNo = 0;

  const checkCancel = () => {
    if (isCancelled()) throw new CancelledError();
  };

  /*
   * Batch-isolation (2026-06-12). A single bad batch (a transient DB
   * deadlock, one malformed pincode tripping a constraint, etc.) used to
   * throw straight out of the loop and fail the ENTIRE multi-minute seed,
   * losing all progress. Now each flush is isolated: a failed batch is
   * logged + counted (stats.batches_failed / pincodes_failed) and the
   * seed continues with the next batch. The operator gets a completed run
   * with a non-zero failed count rather than an all-or-nothing abort.
   * Cancellation (CancelledError) is NOT swallowed here — it has its own
   * path via checkCancel() and must still abort.
   */
  const flushBatchSafely = async (buf) => {
    if (dryRun) { stats.pincodes_inserted += buf.length; return; }
    try {
      await flushPincodes(buf, stats);
    } catch (err) {
      stats.batches_failed += 1;
      stats.pincodes_failed += buf.length;
      logger.warn(
        { err: err && err.message, batchSize: buf.length, rows_seen: stats.rows_seen },
        'india-seed: batch flush failed — skipping this batch, continuing seed',
      );
    }
  };

  for (const rawLine of lines) {
    /*
     * Cancel-responsiveness (2026-06-10). Each row takes ~30-50ms
     * (state/city ensure + cache lookups), so we check `isCancelled()`
     * every 100 rows at the TOP of the loop — cancellation drains
     * within ~3-5s of the Stop click. Cheap (1 boolean check per call).
     */
    if (lineNo > 0 && stats.rows_seen % 100 === 0) checkCancel();
    lineNo += 1;
    if (lineNo === 1) {
      colMap = buildColMap(rawLine.replace(/^﻿/, ''));
      validateColMap(colMap);
      logger.info(`india-seed: column map resolved ${JSON.stringify(colMap)}`);
      continue;
    }
    if (!rawLine.trim()) continue;
    stats.rows_seen += 1;
    const cells = parseCsvLine(rawLine);
    let row;
    if (colMap.geonames) {
      /*
       * GeoNames format adapter (2026-06-10 v2). `key` looks like
       * "IN/110001"; strip the "IN/" prefix to get the pincode. The
       * CSV has no separate district column — we reuse `place_name`
       * as both office_name AND district so the city/district cells
       * land somewhere meaningful (operators see neighbourhood names
       * like "Connaught Place" rather than blanks).
       */
      const rawKey = colMap.key != null ? (cells[colMap.key] || '').trim() : '';
      const place  = colMap.place_name != null ? (cells[colMap.place_name] || '').trim() : '';
      const state  = colMap.admin_name1 != null ? (cells[colMap.admin_name1] || '').trim() : '';
      const m = rawKey.match(/^IN\/(\d{6})$/);
      row = {
        pincode:     m ? m[1] : '',
        office_name: place || null,
        district:    place || null,
        state_name:  state,
        ...parseLatLng(cells, colMap),
      };
    } else {
      row = {
        pincode:     (cells[colMap.pincode]     || '').trim(),
        office_name: colMap.office_name != null ? (cells[colMap.office_name] || '').trim() : null,
        district:    colMap.district    != null ? (cells[colMap.district]    || '').trim() : null,
        state_name:  (cells[colMap.state_name] || '').trim(),
        ...parseLatLng(cells, colMap),
      };
    }
    if (!isValidRow(row)) { stats.rows_invalid += 1; continue; }

    const stateId = await ensureState(row.state_name, countryId, stateCache, stats, dryRun);
    const cityName = row.district || row.state_name;
    const cityId = await ensureCity(cityName, stateId, row.district || null, cityCache, stats, dryRun);

    pincodeBuffer.push([
      row.pincode,
      row.office_name || null,
      cityId,
      row.district || null,
      1,
      row.lat,
      row.lng,
    ]);
    if (pincodeBuffer.length >= BATCH) {
      checkCancel();
      await flushBatchSafely(pincodeBuffer);
      pincodeBuffer = [];
      onProgress({ ...stats });
    }
    if (stats.rows_seen % 1000 === 0) {
      // Live progress for the modal — every 1000 rows is granular
      // enough to feel responsive without spamming setState.
      onProgress({ ...stats });
    }
    if (stats.rows_seen % 10_000 === 0) {
      logger.info(`india-seed: ${stats.rows_seen.toLocaleString('en-IN')} rows processed`);
    }
  }
  if (pincodeBuffer.length) {
    checkCancel();
    await flushBatchSafely(pincodeBuffer);
    pincodeBuffer = [];
    onProgress({ ...stats });
  }

  // Flip the "done" gate on real success.
  if (!dryRun) {
    await pool.query(
      `INSERT INTO easyfix_properties (property_key, property_value)
         VALUES (?, 'true')
         ON DUPLICATE KEY UPDATE property_value = 'true'`,
      [PROP_KEY_DONE],
    );
  }

  const tookMs = Date.now() - startedAtMs;
  return { skipped: false, stats, took_ms: tookMs, started_at: startedAtIso };
}

/* ─── Paginated list (for the modal table) ─────────────────────── */

/*
 * Sort-by whitelist (2026-06-10). Maps the FE-supplied `sortBy` token to
 * the actual SQL expression to ORDER BY. Lookup-only — never concatenate
 * raw user input into SQL. 'remark' resolves to a computed CASE
 * expression on the baseline timestamp.
 */
const SORT_COLUMN_MAP = {
  pincode_id:   'p.pincode_id',
  pincode:      'p.pincode',
  location:     'p.location',
  city_name:    'c.city_name',
  state_name:   's.state_name',
  country_name: 'co.country_name',
  // 'remark' is special — handled inline with the active baseline.
};

async function listPincodesPaginated({
  limit = 50,
  offset = 0,
  sortBy = 'pincode_id',
  sortOrder = 'DESC',
} = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);

  const [seededAt, viewBaselineAt] = await Promise.all([
    getSeededAt(),
    getViewBaselineAt(),
  ]);
  const baseline = viewBaselineAt || seededAt || null;

  // Whitelist + safe interpolation for the ORDER BY clause.
  const dir = String(sortOrder).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const sortKey = String(sortBy || '');
  let orderSql;
  const orderParams = [];
  if (sortKey === 'remark') {
    // Reproduce computeRemark's tri-state logic in SQL so the page-by-page
    // sort is consistent with the in-cell label.
    if (baseline) {
      orderSql = `ORDER BY CASE
          WHEN p.created_date >= ? THEN 'Added'
          WHEN p.updated_date >= ? AND p.created_date < ? THEN 'Updated'
          ELSE 'Existing'
        END ${dir}, p.pincode_id DESC`;
      orderParams.push(baseline, baseline, baseline);
    } else {
      // No baseline → every row is 'Existing'; fall back to pincode_id.
      orderSql = `ORDER BY p.pincode_id ${dir}`;
    }
  } else if (SORT_COLUMN_MAP[sortKey]) {
    orderSql = `ORDER BY ${SORT_COLUMN_MAP[sortKey]} ${dir}, p.pincode_id DESC`;
  } else {
    // Unknown / missing — preserve the legacy default.
    orderSql = 'ORDER BY p.pincode_id DESC';
  }

  const [rows] = await pool.query(
    `SELECT
        p.pincode_id,
        p.pincode,
        p.location,
        p.city_id,
        c.city_name,
        c.state_id  AS state_id,
        s.state_name,
        s.country_id,
        co.country_name,
        p.pincode_status,
        p.created_date,
        p.updated_date
       FROM tbl_pincode    p
       LEFT JOIN tbl_city    c  ON c.city_id    = p.city_id
       LEFT JOIN tbl_state   s  ON s.state_id   = c.state_id
       LEFT JOIN tbl_country co ON co.country_id = s.country_id
      ${orderSql}
      LIMIT ? OFFSET ?`,
    [...orderParams, lim, off],
  );

  const [[{ total }]] = await pool.query(
    'SELECT COUNT(*) AS total FROM tbl_pincode',
  );

  const items = rows.map((r) => ({
    pincode_id:     Number(r.pincode_id),
    pincode:        String(r.pincode || ''),
    location:       r.location || null,
    city_id:        r.city_id != null ? Number(r.city_id) : null,
    city_name:      r.city_name || null,
    state_id:       r.state_id != null ? Number(r.state_id) : null,
    state_name:     r.state_name || null,
    country_id:     r.country_id != null ? Number(r.country_id) : null,
    country_name:   r.country_name || null,
    pincode_status: Number(r.pincode_status) || 0,
    created_date:   r.created_date instanceof Date
      ? r.created_date.toISOString()
      : (r.created_date || null),
    remark: computeRemark(r.created_date, seededAt, r.updated_date, viewBaselineAt),
  }));

  return {
    items,
    total: Number(total) || 0,
    limit: lim,
    offset: off,
    seededAt,
    viewBaselineAt,
  };
}

/* ─── Stream every row (for the XLSX download) ─────────────────── */

async function* exportAllPincodes() {
  const [seededAt, viewBaselineAt] = await Promise.all([
    getSeededAt(),
    getViewBaselineAt(),
  ]);

  // Paginate internally so we never hold the whole 155k-row result set
  // in memory at once. 5k rows per chunk is comfortably under any
  // typical MySQL max_allowed_packet ceiling for a SELECT result.
  const CHUNK = 5000;
  let offset = 0;
  for (;;) {
    const [rows] = await pool.query(
      `SELECT
          p.pincode_id,
          p.pincode,
          p.location,
          p.city_id,
          c.city_name,
          c.state_id  AS state_id,
          s.state_name,
          s.country_id,
          co.country_name,
          p.pincode_status,
          p.created_date,
          p.updated_date
         FROM tbl_pincode    p
         LEFT JOIN tbl_city    c  ON c.city_id    = p.city_id
         LEFT JOIN tbl_state   s  ON s.state_id   = c.state_id
         LEFT JOIN tbl_country co ON co.country_id = s.country_id
        ORDER BY p.pincode_id ASC
        LIMIT ? OFFSET ?`,
      [CHUNK, offset],
    );
    if (!rows.length) return;
    for (const r of rows) {
      yield {
        pincode_id:     Number(r.pincode_id),
        pincode:        String(r.pincode || ''),
        location:       r.location || null,
        city_id:        r.city_id,
        city_name:      r.city_name || null,
        state_id:       r.state_id,
        state_name:     r.state_name || null,
        country_id:     r.country_id,
        country_name:   r.country_name || null,
        pincode_status: Number(r.pincode_status) || 0,
        created_date:   r.created_date,
        remark:         computeRemark(r.created_date, seededAt, r.updated_date, viewBaselineAt),
      };
    }
    if (rows.length < CHUNK) return;
    offset += CHUNK;
  }
}

/*
 * `getSeededAt` (2026-06-10 v2). Returns the seed-start timestamp ONLY
 * when there's actual pincode data to show for it.
 *
 * Earlier this just returned the `india_data_seeded_at` property
 * verbatim, which was set at the START of every seed run. If the
 * operator cancelled mid-flight (before any pincode rows landed),
 * the timestamp persisted but the table was empty — modal showed a
 * confusing "Already Seeded At …" banner alongside the "No Pincodes
 * Yet" empty-state.
 *
 * Per user feedback: the seed flow inserts pincodes LAST. So a
 * non-zero pincode count is the canonical "this was a real seed
 * run" signal. We gate the timestamp return on that count.
 *
 * Implementation: cheap COUNT(*) on tbl_pincode (indexed PK, ~155k
 * rows post-seed → sub-millisecond). On zero, return null → modal
 * treats as first-run.
 */
async function getSeededAt() {
  const [propRows] = await pool.query(
    'SELECT property_value FROM easyfix_properties WHERE property_key = ? LIMIT 1',
    [PROP_KEY_SEEDED_AT],
  );
  if (!propRows.length) return null;
  // Gate on actual pincode data — if the cancelled run never reached
  // the pincode-insert stage, treat as never-seeded.
  const [pinRows] = await pool.query('SELECT COUNT(*) AS c FROM tbl_pincode LIMIT 1');
  if (!pinRows.length || Number(pinRows[0].c) === 0) return null;
  return String(propRows[0].property_value);
}

/*
 * getViewBaselineAt (2026-06-10). Returns the persisted view-baseline
 * timestamp as an ISO string (or null if never set). Source-of-truth
 * for the tri-state Remark column.
 */
async function getViewBaselineAt() {
  const [rows] = await pool.query(
    'SELECT property_value FROM easyfix_properties WHERE property_key = ? LIMIT 1',
    [PROP_KEY_VIEW_BASELINE_AT],
  );
  if (!rows.length) return null;
  const v = rows[0].property_value;
  return v ? String(v) : null;
}

/*
 * setViewBaselineAt (2026-06-10). Upserts the view-baseline property to
 * the supplied Date (defaults to now). Called by the Refresh button via
 * `POST /seed/acknowledge` — after this fires + the FE refetches the
 * list, every row should render as 'Existing'.
 */
async function setViewBaselineAt(now = new Date()) {
  const iso = now.toISOString();
  await pool.query(
    `INSERT INTO easyfix_properties (property_key, property_value)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE property_value = VALUES(property_value)`,
    [PROP_KEY_VIEW_BASELINE_AT, iso],
  );
  return iso;
}

async function isSeeded() {
  const [rows] = await pool.query(
    'SELECT property_value FROM easyfix_properties WHERE property_key = ? LIMIT 1',
    [PROP_KEY_DONE],
  );
  return rows.length && String(rows[0].property_value).toLowerCase() === 'true';
}

/* ─── Helpers (extracted verbatim from the original CLI script) ─── */

/*
 * computeRemark (2026-06-10, tri-state). Baseline resolution:
 *   baseline = viewBaselineAt || seededAt
 *
 * Behaviour:
 *   - !baseline                                           → 'Existing'
 *   - created_date >= baseline                             → 'Added'
 *   - updated_date >= baseline AND created_date < baseline → 'Updated'
 *   - otherwise                                            → 'Existing'
 *
 * The viewBaselineAt arg is OPTIONAL — older callers (CLI scripts that
 * don't carry the property) get seededAt-only behaviour automatically.
 */
function computeRemark(createdDate, seededAt, updatedDate = null, viewBaselineAt = null) {
  const baselineRaw = viewBaselineAt || seededAt;
  if (!baselineRaw) return 'Existing';
  // Both DATETIME columns and the ISO-string baseline parse cleanly via Date().
  const baselineMs = new Date(String(baselineRaw).replace(' ', 'T')).getTime();
  if (!Number.isFinite(baselineMs)) return 'Existing';

  const toMs = (d) => {
    if (!d) return NaN;
    return d instanceof Date ? d.getTime() : new Date(String(d).replace(' ', 'T')).getTime();
  };
  const createdMs = toMs(createdDate);
  const updatedMs = toMs(updatedDate);

  if (Number.isFinite(createdMs) && createdMs >= baselineMs) return 'Added';
  if (
    Number.isFinite(updatedMs) && updatedMs >= baselineMs
    && Number.isFinite(createdMs) && createdMs < baselineMs
  ) {
    return 'Updated';
  }
  return 'Existing';
}

/*
 * Two header schemes are supported (2026-06-10 v2):
 *
 *   A) data.gov.in directory format (older default):
 *      `officename, pincode, ..., districtname, statename`
 *      → straightforward 1:1 column lookup.
 *
 *   B) GeoNames format (the new datameet/PinCode/data/IN.csv default):
 *      `key, place_name, admin_name1, latitude, longitude, accuracy`
 *      where `key` is `IN/<6-digit-pincode>`. We flag `geonames: true`
 *      so the row mapper strips the `IN/` prefix and re-uses
 *      `place_name` as both office_name AND district (since this CSV
 *      doesn't carry a district column). `admin_name1` is the state.
 */
/*
 * Parse latitude/longitude cells into finite numbers (or null). India lat
 * is ~6–37, lng ~68–97 — we accept any finite value and let bad rows fall
 * to null rather than rejecting (lat/lng is optional metadata, never the
 * reason to skip a pincode). Returns { lat, lng }.
 */
function parseLatLng(cells, colMap) {
  const lat = colMap.latitude  != null ? parseFloat(cells[colMap.latitude])  : NaN;
  const lng = colMap.longitude != null ? parseFloat(cells[colMap.longitude]) : NaN;
  return {
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
  };
}

function buildColMap(headerLine) {
  const headers = parseCsvLine(headerLine).map(
    (h) => h.trim().toLowerCase().replace(/[^a-z]/g, ''),
  );
  const map = {};
  for (let i = 0; i < headers.length; i += 1) {
    const h = headers[i];
    if (map.pincode == null && (h === 'pincode' || h === 'pin')) map.pincode = i;
    else if (map.office_name == null && (h === 'officename' || h === 'office')) map.office_name = i;
    else if (map.district == null && (h === 'district' || h === 'districtname')) map.district = i;
    else if (map.state_name == null && (h === 'state' || h === 'statename')) map.state_name = i;
    // GeoNames columns
    else if (map.key == null && h === 'key') map.key = i;
    else if (map.place_name == null && (h === 'placename' || h === 'place')) map.place_name = i;
    else if (map.admin_name1 == null && (h === 'adminname' || h === 'adminname')) map.admin_name1 = i;
    // Geo coordinates (GeoNames CSV ships `latitude`,`longitude`; some
    // other sources use lat/lng/lon). Captured to populate tbl_pincode
    // lat/lng for the Schedule & Assign distance feature — no Google
    // geocoding needed for seeded pincodes.
    else if (map.latitude == null && (h === 'latitude' || h === 'lat')) map.latitude = i;
    else if (map.longitude == null && (h === 'longitude' || h === 'lng' || h === 'lon' || h === 'long')) map.longitude = i;
  }
  // Be tolerant of `admin_name1` (with the digit) — `replace(/[^a-z]/g, '')`
  // strips the trailing 1, so the literal lookup is already covered above.
  for (let i = 0; i < headers.length; i += 1) {
    if (map.admin_name1 == null && headers[i] === 'adminname') map.admin_name1 = i;
  }
  // GeoNames detection — when `key` + `place_name` + `admin_name1` are
  // present, flip the format flag so the row mapper knows to strip the
  // "IN/" prefix.
  map.geonames = map.key != null && map.admin_name1 != null;
  return map;
}

function validateColMap(map) {
  // GeoNames format: needs `key` (carries pincode) + `admin_name1` (state).
  if (map.geonames) {
    const missing = [];
    if (map.key == null)         missing.push('key');
    if (map.admin_name1 == null) missing.push('admin_name1');
    if (missing.length) {
      const err = new Error(`CSV (GeoNames format) missing required column(s): ${missing.join(', ')}`);
      err.status = 400;
      throw err;
    }
    return;
  }
  // Directory format: needs `pincode` + `statename`.
  const missing = [];
  if (map.pincode == null)    missing.push('pincode');
  if (map.state_name == null) missing.push('state / statename');
  if (missing.length) {
    const err = new Error(`CSV is missing required column(s): ${missing.join(', ')}`);
    err.status = 400;
    throw err;
  }
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function isValidRow(row) {
  if (!row.pincode || !/^\d{6}$/.test(row.pincode)) return false;
  if (!row.state_name) return false;
  return true;
}

async function ensureIndia() {
  const [rows] = await pool.query(
    "SELECT country_id FROM tbl_country WHERE country_code = 'IN' LIMIT 1",
  );
  if (rows.length) return rows[0].country_id;
  const [r] = await pool.query(
    "INSERT INTO tbl_country (country_code, country_name, country_phone_code) VALUES ('IN', 'India', 91)",
  );
  return r.insertId;
}

async function preloadStates(countryId, cache) {
  const [rows] = await pool.query(
    'SELECT state_id, state_name FROM tbl_state WHERE country_id = ?',
    [countryId],
  );
  for (const r of rows) cache.set(String(r.state_name).toLowerCase().trim(), r.state_id);
}

async function preloadCities(cache) {
  /*
   * Preload BOTH a state-keyed AND a name-only index (2026-06-11). The
   * state-keyed index is the primary lookup; the name-only index is a
   * fallback used by ensureCity() so legacy rows with NULL / 0 state_id
   * still match when the seed CSV maps the city to its real state.
   * Without this fallback we saw duplicates like Mirzapur(city_id=318,
   * state_id=NULL) + Mirzapur(city_id=319, state_id=34) — both inserted
   * because the state-keyed lookup missed on the legacy row.
   *
   * ORDER BY city_id ASC + "if (!cache.has(nameKey))" ensures the
   * smallest (oldest) city_id wins for the name-only index — matches
   * the dedup script's "keep smallest id" rule.
   */
  const [rows] = await pool.query('SELECT city_id, city_name, state_id FROM tbl_city ORDER BY city_id ASC');
  for (const r of rows) {
    const normName = String(r.city_name || '').toLowerCase().trim();
    if (!normName) continue;
    const stateKey = `${r.state_id}|${normName}`;
    cache.set(stateKey, r.city_id);
    const nameKey = `name|${normName}`;
    if (!cache.has(nameKey)) cache.set(nameKey, r.city_id);
  }
}

async function ensureState(name, countryId, cache, stats, dryRun) {
  const norm = name.toLowerCase().trim();
  if (cache.has(norm)) return cache.get(norm);
  if (dryRun) {
    const placeholder = -(stats.states_created + 1);
    cache.set(norm, placeholder);
    stats.states_created += 1;
    return placeholder;
  }
  const [r] = await pool.query(
    'INSERT INTO tbl_state (state_name, country_id) VALUES (?, ?)',
    [name, countryId],
  );
  cache.set(norm, r.insertId);
  stats.states_created += 1;
  return r.insertId;
}

async function ensureCity(name, stateId, district, cache, stats, dryRun) {
  const normName = String(name || '').toLowerCase().trim();
  if (!normName) {
    return ensureCity('Unknown', stateId, district, cache, stats, dryRun);
  }
  const stateKey = `${stateId}|${normName}`;
  if (cache.has(stateKey)) return cache.get(stateKey);
  /*
   * Name-only fallback (2026-06-11). Handles the legacy-row case where
   * an existing tbl_city row has a different state_id (often NULL / 0)
   * but the same case-insensitive name. Without this fallback the
   * state-keyed cache misses and a duplicate row gets inserted.
   * preloadCities seeded the smallest matching city_id into this index.
   */
  const nameKey = `name|${normName}`;
  if (cache.has(nameKey)) {
    const id = cache.get(nameKey);
    cache.set(stateKey, id);
    // Fill-blank UPDATE on the existing row (2026-06-11). If the
    // legacy row has a NULL/0 state_id or empty district but the
    // current CSV row provides values, write them through. Existing
    // values stay untouched (IF(... IS NULL OR ... = 0/'', new, old)).
    // Skip in dryRun; skip when there's nothing useful to write.
    if (!dryRun && (stateId || district)) {
      await pool.query(
        `UPDATE tbl_city
            SET state_id = IF(state_id IS NULL OR state_id = 0, ?, state_id),
                stateId  = IF(stateId  IS NULL OR stateId  = 0, ?, stateId),
                district = IF(district IS NULL OR district = '', ?, district)
          WHERE city_id = ?`,
        [stateId || 0, stateId || 0, district || '', id],
      );
    }
    return id;
  }
  if (dryRun) {
    const placeholder = -(stats.cities_created + 1);
    cache.set(stateKey, placeholder);
    cache.set(nameKey, placeholder);
    stats.cities_created += 1;
    return placeholder;
  }
  /*
   * Last-chance live DB probe — covers concurrent inserts and any
   * tbl_city rows added between preloadCities() and the current line.
   * Indexed by city_name + case-insensitive collation; a single-row
   * lookup is cheap. Apply the same fill-blank UPDATE on hit.
   */
  const [existing] = await pool.query(
    'SELECT city_id FROM tbl_city WHERE LOWER(TRIM(city_name)) = ? ORDER BY city_id ASC LIMIT 1',
    [normName],
  );
  if (existing.length > 0) {
    const id = existing[0].city_id;
    cache.set(stateKey, id);
    cache.set(nameKey, id);
    if (stateId || district) {
      await pool.query(
        `UPDATE tbl_city
            SET state_id = IF(state_id IS NULL OR state_id = 0, ?, state_id),
                stateId  = IF(stateId  IS NULL OR stateId  = 0, ?, stateId),
                district = IF(district IS NULL OR district = '', ?, district)
          WHERE city_id = ?`,
        [stateId || 0, stateId || 0, district || '', id],
      );
    }
    return id;
  }
  const [r] = await pool.query(
    `INSERT INTO tbl_city (city_name, state_id, stateId, district, city_status, display)
     VALUES (?, ?, ?, ?, 1, 0)`,
    [name, stateId, stateId, district || null],
  );
  cache.set(stateKey, r.insertId);
  cache.set(nameKey, r.insertId);
  stats.cities_created += 1;
  return r.insertId;
}

async function flushPincodes(buf, stats) {
  /*
   * INSERT … ON DUPLICATE KEY UPDATE with fill-blank semantics
   * (2026-06-11). Old behaviour: INSERT IGNORE — duplicates were
   * silently skipped, so legacy tbl_pincode rows with NULL location /
   * city_id / district stayed empty even when the seed CSV had values.
   * New behaviour: write incoming values ONLY into columns that are
   * currently blank; existing non-null/non-empty values are preserved
   * (operators may have hand-edited a row and we shouldn't clobber).
   *
   * Stats derivation from mysql affectedRows + changedRows:
   *   - new INSERT contributes 1 to affectedRows
   *   - UPDATE with at least one column changed contributes 2
   *   - matched no-op duplicate contributes 0
   *   - changedRows = number of UPDATEs that actually changed columns
   * So: updates = changedRows, inserts = affectedRows - 2*updates,
   *     unchanged_dupes = buf.length - inserts - updates.
   */
  const placeholders = buf.map(() => '(?,?,?,?,?,?,?)').join(',');
  const flat = [];
  for (const r of buf) flat.push(...r);
  const [r] = await pool.query(
    `INSERT INTO tbl_pincode (pincode, location, city_id, district, pincode_status, lat, lng)
       VALUES ${placeholders}
     ON DUPLICATE KEY UPDATE
       location = IF(COALESCE(tbl_pincode.location, '') = '', VALUES(location), tbl_pincode.location),
       city_id  = IF(COALESCE(tbl_pincode.city_id,  0)  = 0,   VALUES(city_id),  tbl_pincode.city_id),
       district = IF(COALESCE(tbl_pincode.district, '') = '', VALUES(district), tbl_pincode.district),
       lat      = IF(tbl_pincode.lat IS NULL, VALUES(lat), tbl_pincode.lat),
       lng      = IF(tbl_pincode.lng IS NULL, VALUES(lng), tbl_pincode.lng)`,
    flat,
  );
  /*
   * Stats accounting (2026-06-11, fixed). mysql2's `changedRows` is
   * not reliably populated across driver versions — when undefined it
   * falls through to 0, which makes the earlier formula
   * `inserts = affectedRows - 2 * changedRows` mis-attribute updated
   * dupes (each contributing 2 to affectedRows) to fresh inserts.
   * That's exactly the bug the user hit: existing pincodes showing up
   * in "Pincodes Inserted" instead of "Pincodes Skipped (Dupe)".
   *
   * Source-of-truth: parse the `info` string. mysql ALWAYS emits it
   * for multi-row INSERT in the form:
   *   "Records: 500  Duplicates: 200  Warnings: 0"
   * Records = N (total rows attempted), Duplicates = rows where the
   * ON DUPLICATE KEY UPDATE fired (whether or not values changed).
   * From there:
   *   inserts   = N - dupes              (rows that didn't exist before)
   *   updates   = min(dupes, changedRows || 0)  (dupes with column changes)
   *   unchanged = dupes - updates         (dupes that matched as-is)
   * If `info` is missing for some reason, fall back to the conservative
   * affectedRows-based formula so the run still completes.
   */
  const N = buf.length;
  const info = String(r.info || '');
  const dupeMatch = /Duplicates:\s*(\d+)/.exec(info);
  let dupes;
  if (dupeMatch) {
    dupes = Number(dupeMatch[1]);
  } else {
    // Fallback: each insert = 1 affected, each update-with-change = 2.
    // Conservative cap at N so we never report negative dupes.
    dupes = Math.min(N, Math.max(0, r.affectedRows - N) + (r.changedRows || 0));
  }
  const inserts = Math.max(0, N - dupes);
  const updates = Math.min(dupes, r.changedRows || 0);
  const unchanged = Math.max(0, dupes - updates);
  stats.pincodes_inserted += inserts;
  stats.pincodes_updated = (stats.pincodes_updated || 0) + updates;
  stats.pincodes_skipped_dupe += unchanged;
}

module.exports = {
  runSeed,
  startSeedJob,
  getSeedJob,
  getCurrentSeedJob,
  getLastCompletedSeedJob,
  cancelSeedJob,
  listPincodesPaginated,
  exportAllPincodes,
  getSeededAt,
  getViewBaselineAt,
  setViewBaselineAt,
  getEffectiveCsvUrl,
  isSeeded,
  PROP_KEY_DONE,
  PROP_KEY_SEEDED_AT,
  PROP_KEY_VIEW_BASELINE_AT,
};
