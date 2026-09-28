/*
 * QA LOCATION DATA refresh from PRODUCTION — manual only (Trigger Now).
 *
 * QA's location master is raw post-office data (11k PINs spread over 11k
 * "cities" such as "Air Force Gurgaon"; Gurugram owns 2 PINs), so anything
 * city- or PIN-shaped behaves nothing like production there. The FULL refresh
 * (qa-db-refresh.service.js) would fix that but replaces the WHOLE database,
 * wiping QA's V3-only schema and its test data. This job replaces ONLY:
 *
 *   tbl_state → tbl_city → tbl_zone_master → tbl_pincode → tbl_zone_pincode_mapping
 *
 * All five come from ONE source in ONE snapshot, because the mapping points at
 * pincodes by pincode_id — mixing sources would silently re-point every row.
 *
 * SAFETY (production): the same guards as the full refresh (assertSafeToRun —
 * ENVIRONMENT must be 'qa', target ≠ source) run before any connection opens.
 * The source is the read REPLICA via the PROD_SLAVE_* read-only login, read in
 * a `WITH CONSISTENT SNAPSHOT, READ ONLY` transaction (MVCC, no locks).
 *
 * SAFETY (QA): preflight counts the replica first and refuses on an empty
 * table or a tbl_pincode below MIN_SOURCE_PINCODES; the same check runs again
 * on what was actually copied, before COMMIT. Everything on QA happens in ONE
 * InnoDB transaction — DELETE and INSERT are transactional, so QA readers keep
 * seeing the old rows until COMMIT and any failure rolls back to them. That is
 * why, unlike the full refresh, NO maintenance gate is raised.
 *
 * FOREIGN_KEY_CHECKS=0 is SESSION-scoped on a dedicated connection (never a
 * pooled one), so it cannot leak into app traffic; it is set back to 1 in a
 * finally anyway. With checks off, ON DELETE CASCADE does not fire, so
 * tbl_client / tbl_easyfixer rows are never touched — dangling references are
 * REPORTED afterwards, never auto-fixed.
 */

const mysql = require('mysql2/promise');

const logger = require('../logger');
const email = require('./email.service');
const { assertSafeToRun, src, dst, recipients } = require('./qa-db-refresh.service');

// Parents first — the INSERT order. DELETE runs this reversed.
const TABLES = ['tbl_state', 'tbl_city', 'tbl_zone_master', 'tbl_pincode', 'tbl_zone_pincode_mapping'];
// Production holds ~22k PINs; anything under this is a broken read, not data.
const MIN_SOURCE_PINCODES = 5000;
const BATCH = 2000;
// information_schema.COLUMNS.EXTRA for generated columns: MySQL 'VIRTUAL
// GENERATED' / 'STORED GENERATED', MariaDB also 'PERSISTENT'. MySQL 8's
// 'DEFAULT_GENERATED' (DEFAULT CURRENT_TIMESTAMP) is NOT generated — keep it.
const GENERATED = /\b(VIRTUAL|STORED|PERSISTENT)\b/i;
const q = mysql.escapeId;

let _run = null;   // { cancelled } while a run is in flight

function progress(text) {
  // Lazy require: scheduler → this service → scheduler would be a cycle.
  try { require('../server/scheduler').setJobProgress('qa-geo-refresh', text); } catch { /* unit tests */ }
}

function checkCancel() {
  if (_run?.cancelled) throw new Error('cancelled by operator');
}

async function columnsOf(conn, table) {
  const [rows] = await conn.query(
    'SELECT COLUMN_NAME AS name, EXTRA AS extra, COLUMN_KEY AS colKey FROM information_schema.COLUMNS '
    + 'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
    [table],
  );
  return rows;
}

/*
 * Copy only the INTERSECTION of both sides' non-generated columns: QA-only
 * columns (created_by_type, coords_geocoded_at, …) take their defaults,
 * replica-only columns are ignored.
 */
function planTable(table, srcCols, dstCols) {
  if (!srcCols.length) throw new Error(`${table} does not exist on the replica`);
  if (!dstCols.length) throw new Error(`${table} does not exist on QA`);
  const real = (cols) => cols.filter((c) => !GENERATED.test(c.extra || ''));
  const onQa = new Set(real(dstCols).map((c) => c.name));
  const columns = real(srcCols).map((c) => c.name).filter((n) => onQa.has(n));
  const pks = srcCols.filter((c) => c.colKey === 'PRI').map((c) => c.name);
  if (pks.length !== 1) throw new Error(`${table}: need a single-column primary key on the replica, found ${pks.length}`);
  if (!columns.includes(pks[0])) throw new Error(`${table}: primary key ${pks[0]} is not a column on QA`);
  return { table, pk: pks[0], columns };
}

// Keyset pagination — never holds a whole table (the mapping may be ~155k rows).
async function* readBatches(conn, { table, pk, columns }, batchSize = BATCH) {
  let last;
  for (;;) {
    checkCancel();
    const first = last === undefined;
    const [rows] = await conn.query(
      `SELECT ${columns.map(q).join(', ')} FROM ${q(table)}${first ? '' : ` WHERE ${q(pk)} > ?`} ORDER BY ${q(pk)} LIMIT ?`,
      first ? [batchSize] : [last, batchSize],
    );
    if (!rows.length) return;
    yield rows;
    if (rows.length < batchSize) return;
    last = rows[rows.length - 1][pk];
  }
}

// Refuse on any empty table or too few PINs. Used on the replica's counts
// (before QA is touched) and on the copied counts (before COMMIT).
function checkCounts(counts, label) {
  const empty = TABLES.filter((t) => !Number(counts[t]));
  if (empty.length) {
    throw new Error(`refusing: ${label} has 0 rows in ${empty.join(', ')} — a broken read must never wipe QA`);
  }
  if (Number(counts.tbl_pincode) < MIN_SOURCE_PINCODES) {
    throw new Error(`refusing: ${label} has only ${counts.tbl_pincode} rows in tbl_pincode (floor ${MIN_SOURCE_PINCODES})`);
  }
}

// DELETE children-first, INSERT parents-first, all in one QA transaction.
async function copyTables(source, target, plans) {
  const copied = {};
  await target.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    await target.beginTransaction();
    try {
      for (const p of [...plans].reverse()) await target.query(`DELETE FROM ${q(p.table)}`);
      for (const p of plans) {
        copied[p.table] = 0;
        const sql = `INSERT INTO ${q(p.table)} (${p.columns.map(q).join(', ')}) VALUES ?`;
        for await (const rows of readBatches(source, p)) {
          await target.query(sql, [rows.map((r) => p.columns.map((c) => r[c]))]);
          copied[p.table] += rows.length;
          progress(`Copying ${p.table} · ${copied[p.table]} rows`);
        }
      }
      checkCounts(copied, 'the copy');
      await target.commit();
    } catch (e) {
      await target.rollback().catch((re) => logger.error(`QA geo refresh · ROLLBACK failed · ${re.message}`));
      throw e;
    }
  } finally {
    await target.query('SET FOREIGN_KEY_CHECKS = 1')
      .catch((e) => logger.error(`QA geo refresh · could not restore FOREIGN_KEY_CHECKS · ${e.message}`));
  }
  return copied;
}

/*
 * Report-only. Serviceable PINs are checked EXACTLY, not with a rough
 * FIND_IN_SET: the CSV is split in JS with the same REPLACE(' ','') semantics
 * as pincode-coverage.service.js (one row per technician, cheap to read).
 * A city id of 0/NULL means "not set" and is not counted as dangling.
 */
async function danglingReport(conn) {
  const [[{ n: easyfixerCity }]] = await conn.query(
    'SELECT COUNT(*) AS n FROM tbl_easyfixer e WHERE e.efr_cityId IS NOT NULL AND e.efr_cityId <> 0 '
    + 'AND NOT EXISTS (SELECT 1 FROM tbl_city c WHERE c.city_id = e.efr_cityId)',
  );
  const [[{ n: clientCity }]] = await conn.query(
    'SELECT COUNT(*) AS n FROM tbl_client cl WHERE cl.client_city_id IS NOT NULL AND cl.client_city_id <> 0 '
    + 'AND NOT EXISTS (SELECT 1 FROM tbl_city c WHERE c.city_id = cl.client_city_id)',
  );
  const [pinRows] = await conn.query('SELECT pincode FROM tbl_pincode');
  const [spRows] = await conn.query(
    "SELECT pincodes FROM tbl_efr_serviceable_pincodes WHERE pincodes IS NOT NULL AND pincodes <> ''",
  );
  const known = new Set(pinRows.map((r) => String(r.pincode).trim()));
  const missing = new Set();
  for (const { pincodes } of spRows) {
    for (const pin of String(pincodes).replace(/ /g, '').split(',')) {
      if (pin && !known.has(pin)) missing.add(pin);
    }
  }
  return {
    easyfixerCityMissing: Number(easyfixerCity),
    clientCityMissing: Number(clientCity),
    serviceablePincodesMissing: missing.size,
  };
}

function connectOpts(c) {
  return {
    host: c.host, port: Number(c.port), user: c.user, password: c.password, database: c.database,
    connectTimeout: 15000,
    // Copy values verbatim: no Date/JSON/number conversion on the way through.
    dateStrings: true, jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true,
  };
}

async function notify(result) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const envLabel = process.env.ENVIRONMENT || 'qa';
  const subject = result.ok
    ? `✅ QA location data refreshed from production (${envLabel})`
    : `⚠ QA location data refresh FAILED (${envLabel})`;
  const rows = [
    ...Object.entries(result.tables || {}).map(([t, n]) => [t, `${n} rows copied`]),
    ...Object.entries(result.dangling || {}).map(([k, v]) => [`Dangling · ${k}`, v]),
    ['Duration', `${Math.round((result.durationMs || 0) / 1000)}s`],
  ];
  const html = `
    <p><strong>${result.ok ? 'QA location tables were replaced with production\'s.' : 'The QA location refresh did not complete. QA was rolled back and still holds its previous location data.'}</strong></p>
    <table cellpadding="4" style="border-collapse:collapse;font-family:sans-serif;font-size:13px">
      ${rows.map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`).join('')}
    </table>
    ${result.error ? `<p style="color:#b91c1c"><b>Reason:</b> ${esc(result.error)}</p>` : ''}`;
  // Same bypass as the full refresh's notify(): an ops alert to a fixed
  // internal allowlist must not be swallowed by QA's NOTIFICATIONS_DISABLE.
  const saved = process.env.NOTIFICATIONS_DISABLE;
  try {
    process.env.NOTIFICATIONS_DISABLE = 'false';
    return await email.send({ to: await recipients(), subject, html, category: 'transactional' });
  } catch (e) {
    logger.error(`QA geo refresh · outcome email failed · ${e.message}`);
    return null;
  } finally {
    if (saved === undefined) delete process.env.NOTIFICATIONS_DISABLE;
    else process.env.NOTIFICATIONS_DISABLE = saved;
  }
}

/*
 * The whole run. Never throws — always resolves { ok, tables, dangling,
 * durationMs, error? } and always emails. `connect` is a test seam.
 */
async function runQaGeoRefresh({ connect = (opts) => mysql.createConnection(opts) } = {}) {
  if (_run) return { ok: false, tables: {}, dangling: null, durationMs: 0, error: 'a location refresh is already in progress' };
  _run = { cancelled: false };
  const startedAt = Date.now();
  const result = { ok: false, tables: {}, dangling: null, durationMs: null };
  let source = null;
  let target = null;
  try {
    assertSafeToRun();   // before any connection opens

    progress('Reading the production replica');
    source = await connect(connectOpts(src()));
    target = await connect(connectOpts(dst()));
    // TIMESTAMP columns round-trip in UTC on both sessions; DATETIME is verbatim.
    await source.query("SET time_zone = '+00:00'");
    await target.query("SET time_zone = '+00:00'");
    // One snapshot for all five tables, so pincode_ids in the mapping match.
    await source.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');

    const plans = [];
    const counts = {};
    for (const t of TABLES) {
      plans.push(planTable(t, await columnsOf(source, t), await columnsOf(target, t)));
      const [[{ n }]] = await source.query(`SELECT COUNT(*) AS n FROM ${q(t)}`);
      counts[t] = Number(n);
    }
    checkCounts(counts, 'the replica');
    logger.info(`QA geo refresh · preflight ok · ${JSON.stringify(counts)}`);
    checkCancel();

    result.tables = await copyTables(source, target, plans);
    progress('Checking for dangling references');
    try {
      result.dangling = await danglingReport(target);
    } catch (e) {
      result.dangling = { error: e.message };   // report-only: never fails a committed copy
    }
    result.ok = true;
    logger.ready(`QA geo refresh complete · ${JSON.stringify(result.tables)} · dangling ${JSON.stringify(result.dangling)}`);
  } catch (err) {
    result.error = err?.message || String(err);
    logger.error(`QA geo refresh FAILED · ${result.error}`);
  } finally {
    for (const c of [source, target]) await c?.end().catch(() => { /* already closed */ });
    _run = null;
  }
  result.durationMs = Date.now() - startedAt;
  await notify(result);
  return result;
}

// Cooperative: checked before each batch. A stop mid-copy rolls QA back.
function cancelRun() {
  if (!_run) return { cancelled: false, reason: 'nothing is running' };
  _run.cancelled = true;
  return { cancelled: true };
}

module.exports = {
  runQaGeoRefresh, cancelRun,
  // exported for tests
  TABLES, MIN_SOURCE_PINCODES, planTable, readBatches, checkCounts, copyTables, danglingReport,
};
