const mysql = require('mysql2/promise');
const logger = require('./logger');
const { pool: primaryPool } = require('./db');

/*
 * READ POOL — an optional replica, wired to nothing yet.
 *
 * ─── The two failure modes this is shaped around ─────────────────────────
 *
 * 1. A replica outage must NOT blank the reports. If reads simply went to a
 *    second pool, the replica would become a new single point of failure for
 *    every report — strictly worse than the load problem it solves, because
 *    today a replica outage is invisible. So the replica is an OPTIMISATION,
 *    never a DEPENDENCY: a read that cannot reach it is retried on the
 *    primary, and the report renders.
 *
 * 2. A silent no-op is just as bad. If everything quietly falls back, the
 *    change "succeeds" and moves no load at all — and "the replica is
 *    unreachable" and "the replica is serving everything" look identical
 *    from the outside, because both produce a working system. That is why
 *    the counters below are not optional garnish: they are the only thing
 *    that distinguishes those two states. `reads.replica` staying at 0 under
 *    real traffic IS the alarm.
 *
 * ─── Not yet wired in ────────────────────────────────────────────────────
 *
 * Nothing calls readQuery() yet, deliberately. This module can be deployed,
 * observed on /api/health/db and proven against real traffic patterns before
 * a single flow depends on it. Integration is a separate, reviewable step.
 */

const CONFIGURED = !!process.env.DB_READ_HOST;

/*
 * Absent config means PRIMARY, silently and by design. A laptop, QA, or any
 * environment without a replica keeps working with no special-casing, which
 * makes the split opt-in per environment rather than a deployment
 * requirement. Falling back to the primary's own credentials lets an operator
 * point DB_READ_HOST at a replica without duplicating every secret.
 */
const readPool = CONFIGURED
  ? mysql.createPool({
    host:     process.env.DB_READ_HOST,
    port:     parseInt(process.env.DB_READ_PORT || process.env.DB_PORT || '3306', 10),
    database: process.env.DB_READ_NAME || process.env.DB_NAME || 'easyfix_core',
    user:     process.env.DB_READ_USER || process.env.DB_USER,
    password: process.env.DB_READ_PASSWORD || process.env.DB_PASSWORD,

    // Deliberately smaller than the primary's: the replica serves reports and
    // lookups, not the whole application, and a runaway report should exhaust
    // its own pool rather than the database's max_connections.
    connectionLimit: parseInt(process.env.DB_READ_CONNECTION_LIMIT || '10', 10),
    queueLimit:      parseInt(process.env.DB_QUEUE_LIMIT || '50', 10),
    maxIdle:         parseInt(process.env.DB_MAX_IDLE || '5', 10),
    idleTimeout:     parseInt(process.env.DB_IDLE_TIMEOUT || '60000', 10),
    // Shorter than the primary's 30s on purpose: this connect sits in front
    // of a fallback, so a slow replica must fail FAST or every report pays
    // the full timeout before recovering — which would make an outage feel
    // slower than having no replica at all.
    connectTimeout:  parseInt(process.env.DB_READ_CONNECT_TIMEOUT || '5000', 10),

    enableKeepAlive: true,
    waitForConnections: true,
    multipleStatements: false,

    // MUST match db.js exactly. A different dateStrings/timezone/typeCast
    // here would make the same row deserialize differently depending on which
    // pool answered — the subtlest possible bug, and one that would only
    // appear when the replica was healthy.
    dateStrings: true,
    timezone: '+05:30',
    typeCast(field, next) {
      if (field.type === 'TINY' && field.length === 1) {
        const v = field.string();
        return v === null ? null : v === '1';
      }
      if (field.type === 'BIT' && field.length === 1) {
        const buf = field.buffer();
        if (buf === null) return null;
        return buf[0] === 1;
      }
      return next();
    },
  })
  : null;

/*
 * Connection-level failures ONLY.
 *
 * The distinction is the whole safety property. A dead socket means "ask the
 * primary instead"; a bad column name means the query is broken, and running
 * it again on the primary just fails twice while doubling the load we are
 * trying to shed. Retrying a genuine SQL error would turn a small bug into an
 * outage on the very database we are protecting.
 */
const FALLBACK_CODES = new Set([
  'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET', 'EPIPE',
  'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_SEQUENCE_TIMEOUT', 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'ER_CON_COUNT_ERROR', 'POOL_CLOSED', 'POOL_ENQUEUELIMIT', 'ER_ACCESS_DENIED_ERROR',
]);

function isConnectionFailure(err) {
  return !!err && (FALLBACK_CODES.has(err.code) || err.fatal === true);
}

/*
 * Circuit breaker.
 *
 * Without one, a dead replica makes reports SLOWER than they are today:
 * every read pays the connect timeout before falling back. After
 * BREAKER_THRESHOLD consecutive connection failures the breaker opens and
 * reads go straight to the primary; after BREAKER_COOLDOWN_MS one request is
 * allowed through to probe, and a success closes it again.
 */
const BREAKER_THRESHOLD = parseInt(process.env.DB_READ_BREAKER_THRESHOLD || '3', 10);
const BREAKER_COOLDOWN_MS = parseInt(process.env.DB_READ_BREAKER_COOLDOWN_MS || '30000', 10);

const state = {
  consecutiveFailures: 0,
  openedAt: null,
  reads: { replica: 0, primary: 0 },
  fallbacks: 0,
  lastFallbackAt: null,
  lastFallbackCode: null,
  probes: 0,
  serverId: null,
  hostname: null,
  distinctFromPrimary: null,
};

function breakerOpen() {
  if (state.openedAt === null) return false;
  if (Date.now() - state.openedAt >= BREAKER_COOLDOWN_MS) return false; // probe window
  return true;
}

/*
 * Open (or RE-open) the breaker once the failure threshold is met.
 *
 * The re-arm is the important half. `openedAt` is only cleared by a SUCCESS,
 * so a guard of `openedAt === null` opens the breaker exactly once in the
 * lifetime of the process: after the first cooldown lapses, breakerOpen()
 * returns false, the next attempt fails, and nothing re-opens it — so every
 * call from then on pays the full connect timeout. Stamping openedAt on every
 * past-threshold failure keeps the cooldown rolling while the replica is down,
 * and logs only on the transition so a long outage stays one line.
 */
function openBreaker(code) {
  const wasOpen = breakerOpen();
  state.openedAt = Date.now();
  if (!wasOpen) {
    logger.warn(
      `DB read replica unreachable (${code}) after ${state.consecutiveFailures} `
      + `attempts — serving reads from the PRIMARY for the next ${Math.round(BREAKER_COOLDOWN_MS / 1000)}s`,
    );
  }
}

/*
 * A PROBE failure — /api/health/db or startup verification, not a real read.
 *
 * Deliberately does NOT touch `fallbacks`: that counter answers "how many
 * reads fell back to the primary", and inflating it with health checks would
 * destroy the one signal that says whether the replica is carrying traffic.
 * It does feed the breaker, because otherwise nothing does while the read pool
 * is unwired — which is exactly how /api/health/db came to pay a 5s timeout on
 * every single call in production.
 */
function recordProbeFailure(err) {
  state.consecutiveFailures += 1;
  state.lastProbeAt = new Date();
  state.lastProbeCode = err && err.code ? err.code : 'UNKNOWN';
  if (state.consecutiveFailures >= BREAKER_THRESHOLD) openBreaker(state.lastProbeCode);
}

function recordFailure(err) {
  state.consecutiveFailures += 1;
  state.fallbacks += 1;
  state.lastFallbackAt = new Date();
  state.lastFallbackCode = err && err.code ? err.code : 'UNKNOWN';
  if (state.consecutiveFailures >= BREAKER_THRESHOLD) {
    openBreaker(state.lastFallbackCode);
  } else if (state.fallbacks === 1 || state.fallbacks % 50 === 0) {
    // Rate-limited: one line per burst, not one per query.
    logger.warn(`DB read fell back to primary (${state.lastFallbackCode}) · total fallbacks: ${state.fallbacks}`);
  }
}

function recordSuccess() {
  if (state.openedAt !== null) {
    logger.db(`DB read replica recovered after ${state.fallbacks} fallback(s) — resuming replica reads`);
  }
  state.consecutiveFailures = 0;
  state.openedAt = null;
}

/**
 * Run a READ-ONLY query, preferring the replica.
 *
 * Safe to retry by construction: only reads come through here, so a fallback
 * can never duplicate a write. Never pass an INSERT/UPDATE/DELETE — use the
 * primary `pool` directly for those, and note that a transaction must ALWAYS
 * use a primary connection, since its reads must see its own writes.
 */
async function readQuery(sql, params) {
  if (!readPool || breakerOpen()) {
    state.reads.primary += 1;
    return primaryPool.query(sql, params);
  }
  const probing = state.openedAt !== null;
  if (probing) state.probes += 1;
  try {
    const out = await readPool.query(sql, params);
    state.reads.replica += 1;
    recordSuccess();
    return out;
  } catch (err) {
    if (!isConnectionFailure(err)) throw err; // a real SQL error — do not double-run it
    recordFailure(err);
    state.reads.primary += 1;
    return primaryPool.query(sql, params);
  }
}

/**
 * Identify the replica and prove it is a DIFFERENT server from the primary.
 *
 * Comparing @@server_id is the point. A replica pointed at the primary under
 * a second DNS name would pass every reachability check, serve every query
 * correctly, and shed exactly zero load — the silent no-op this whole module
 * is designed to make visible. Called at startup and by /api/health/db.
 */
async function identify() {
  if (!readPool) return null;
  let replica;
  try {
    ([[replica]] = await readPool.query(
      'SELECT @@server_id AS serverId, @@hostname AS hostname, @@read_only AS readOnly',
    ));
    recordSuccess();
  } catch (err) {
    // Feed the breaker, then rethrow so the caller still reports the reason.
    if (isConnectionFailure(err)) recordProbeFailure(err);
    throw err;
  }
  let primaryServerId = null;
  try {
    const [[primary]] = await primaryPool.query('SELECT @@server_id AS serverId');
    primaryServerId = primary.serverId;
  } catch (_e) { /* primary probed elsewhere; identity is still useful without it */ }

  state.serverId = replica.serverId;
  state.hostname = replica.hostname;
  state.distinctFromPrimary = primaryServerId === null ? null : replica.serverId !== primaryServerId;
  return { ...replica, primaryServerId, distinctFromPrimary: state.distinctFromPrimary };
}

/** Snapshot for /api/health/db. */
function getReadPoolStats() {
  if (!readPool) {
    return { configured: false, note: 'DB_READ_HOST unset — all reads use the primary' };
  }
  return {
    configured: true,
    host: process.env.DB_READ_HOST,
    serverId: state.serverId,
    hostname: state.hostname,
    // null until identify() has run against both hosts.
    distinctFromPrimary: state.distinctFromPrimary,
    breaker: breakerOpen() ? 'open' : (state.openedAt !== null ? 'half-open' : 'closed'),
    reads: { ...state.reads },
    fallbacks: state.fallbacks,
    lastFallbackAt: state.lastFallbackAt,
    lastFallbackCode: state.lastFallbackCode,
    probes: state.probes,
    connectionLimit: parseInt(process.env.DB_READ_CONNECTION_LIMIT || '10', 10),
  };
}

/**
 * Startup announcement. Logged loudly BECAUSE the failure mode is silence:
 * an unset DB_READ_HOST and a misconfigured one both leave the app working.
 */
async function verifyReadPool() {
  if (!readPool) {
    logger.db('DB read replica not configured (DB_READ_HOST unset) — all reads use the primary');
    return false;
  }
  try {
    const id = await identify();
    const distinct = id.distinctFromPrimary === false
      ? ' · ⚠ SAME server_id as the primary — this will shed NO load'
      : (id.distinctFromPrimary ? ' · DISTINCT from primary ✓' : '');
    logger.db(
      `DB read replica → ${process.env.DB_READ_HOST} `
      + `(server_id=${id.serverId}, hostname=${id.hostname}, read_only=${id.readOnly})${distinct}`,
    );
    if (id.distinctFromPrimary === false) {
      logger.warn('DB_READ_HOST resolves to the same MySQL server as the primary — check the host');
    }
    return true;
  } catch (err) {
    // NOT fatal: refusing to boot would reintroduce the dependency this whole
    // module exists to avoid. Loud, visible, and still serving.
    logger.warn(`DB read replica unreachable at startup (${err.code || err.message}) — reads will use the primary`);
    return false;
  }
}

async function closeReadPool() {
  if (!readPool) return;
  await readPool.end();
  logger.db('Database read pool closed');
}

module.exports = {
  readPool, readQuery, getReadPoolStats, verifyReadPool, closeReadPool, identify,
  breakerOpen,
  isConnectionFailure, isConfigured: () => CONFIGURED,
};
