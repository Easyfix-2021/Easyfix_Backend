const mysql = require('mysql2/promise');
const logger = require('./logger');

/*
 * MySQL connection pool.
 *
 * Why these knobs matter:
 *   connectionLimit  — hard ceiling on open sockets to MySQL. Too low = client queues;
 *                      too high = MySQL's own `max_connections` rejects. 20 → 30 → 100.
 *
 *                      THIS DEFAULT IS A FALLBACK, NOT WHAT PRODUCTION RUNS. The host
 *                      env (`/opt/easyfix/backend.env`) sets DB_CONNECTION_LIMIT and
 *                      wins; on 2026-09-09 `GET /api/health/db` reported limit 50 /
 *                      queueMax 100 there while this file said 30 and .env.example said
 *                      20. All three disagreed and every reader quoted the wrong one.
 *                      Ask the running process, never this line:
 *                        curl -s https://backend.easyfix.in/api/health/db
 *
 *                      Raised to 100 so a NEW environment — QA, local, the next
 *                      container — starts with headroom rather than silently running a
 *                      smaller pool than production. The budget against the server's
 *                      max_connections = 1000 (measured 2026-09-09):
 *                        EasyFix_Backend (this, 1 container)      50 live
 *                        EasyFix_API      (Dropwizard, default)  100
 *                        API_AngularClientDashboard (Hikari)      50
 *                        ACD_APIs         (Hikari default)        10
 *                        Webhook_2023     (2 × Sequelize max 15)  30
 *                        legacy CRM Tomcat JNDI                    ? (not in any repo)
 *                      = 240 known of 1000. Even doubling every Java service reaches
 *                      450, so headroom is not the constraint here.
 *
 *                      AND RAISING THIS DOES NOT BUY THROUGHPUT ON ITS OWN. Production
 *                      has `enqueued: 0` over 10,377 lifetime acquires — no request has
 *                      ever waited for a connection. The real ceiling is query fan-out:
 *                      Schedule & Assign takes ~16 acquires per open, so 50/16 ≈ 3
 *                      concurrent opens saturate regardless of the number. Fix the
 *                      fan-out (see the ranking bulkhead) before buying connections.
 *   queueLimit       — how many pending acquires we hold in memory before failing fast.
 *                      Unbounded (0) lets a traffic spike pile up requests that will
 *                      eventually time-out anyway; we prefer quick "pool saturated".
 *   maxIdle          — idle sockets we keep warm. Saves TCP+auth handshake on the next
 *                      request. Set <= connectionLimit.
 *   idleTimeout      — how long an idle socket lives before we close it. Keeps our
 *                      footprint small during quiet periods without being wasteful.
 *   keepAlive        — sends TCP keepalive pings so an idle socket doesn't silently
 *                      die behind a firewall / NAT. mysql2 doesn't accept an initial
 *                      delay option — the OS default is fine for our case.
 *   multipleStatements:false — SQL-injection defence in depth; stacked queries disabled.
 *   dateStrings      — MySQL DATETIME comes back as "YYYY-MM-DD HH:mm:ss" (IST here);
 *                      no timezone shenanigans on the driver side.
 *   typeCast         — coerce TINYINT(1) and BIT(1) to real booleans instead of
 *                      "1"/"0" strings or <Buffer 01>. Several tables rely on this —
 *                      don't remove (otp_details.is_expired, tbl_user.is_*, efr_status…).
 */

/*
 * ONE definition per knob, in db-pool-config.js. These were repeated as inline
 * `|| '30'` / `|| '50'` fallbacks at four call sites here plus a fifth in the
 * bulkhead test; raising the pool without finding all of them left the
 * saturation classifier judging a 150-deep queue against a limit of 50. A
 * default written down more than once is a default that will drift.
 */
const { poolLimit, poolQueueMax } = require('./db-pool-config');

const pool = mysql.createPool({
  host:     process.env.DB_HOST || 'localhost',
  port:     parseInt(process.env.DB_PORT || '3306', 10),
  database: process.env.DB_NAME || 'easyfix_core',
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,

  connectionLimit: poolLimit(),
  queueLimit:      poolQueueMax(),
  // maxIdle stays well under connectionLimit: the limit is a CEILING for bursts,
  // while this is how many sockets we hold open when quiet. Raising the ceiling
  // should not raise the resting footprint.
  maxIdle:         parseInt(process.env.DB_MAX_IDLE         || '20', 10),
  idleTimeout:     parseInt(process.env.DB_IDLE_TIMEOUT     || '60000', 10),
  connectTimeout:  parseInt(process.env.DB_CONNECT_TIMEOUT  || '30000', 10),

  enableKeepAlive: true,
  waitForConnections: true,
  multipleStatements: false,

  dateStrings: true,
  timezone: '+05:30',

  typeCast(field, next) {
    // TINYINT(1) → boolean
    if (field.type === 'TINY' && field.length === 1) {
      const v = field.string();
      return v === null ? null : v === '1';
    }
    // BIT(1) → boolean (otherwise Buffer, e.g. <Buffer 01>).
    // otp_details.is_expired, tbl_user.is_*, and many flag columns use BIT(1).
    if (field.type === 'BIT' && field.length === 1) {
      const buf = field.buffer();
      if (buf === null) return null;
      return buf[0] === 1;
    }
    return next();
  },
});

// Lightweight counters for /api/health/db. Deltas matter more than absolutes —
// a growing "enqueued" with flat "released" means requests are piling up.
const stats = { connected: 0, acquired: 0, released: 0, enqueued: 0 };

/*
 * LIVE GAUGES vs LIFETIME COUNTERS — the distinction this whole block turns on.
 *
 * The counters below (`acquired`, `released`, `enqueued`) only ever grow. They
 * answer "how much has this process ever done", which is useless for "is the
 * pool in trouble RIGHT NOW" — the question that matters during an incident.
 *
 * `inUse` was previously derived as acquired - released, and that derivation is
 * WRONG in exactly the situation you need it: mysql2 evicts a connection that
 * hits a fatal/network fault (pool_connection.js `once('error')` →
 * _removeFromPool), and an evicted connection emits no 'release'. So every such
 * fault permanently inflates the derived gauge, and after a rough hour the
 * number reads "saturated" forever regardless of the truth.
 *
 * So the gauges are read from the pool itself. These are mysql2 internals
 * (`PromisePool.pool` → BasePool) and therefore an upgrade hazard — which is
 * why readLiveGauges() returns null rather than zeros when the shape is absent,
 * and why tests/pool-saturation.test.js asserts the shape exists. A probe that
 * silently reports 0 for "queued" is worse than no probe: it reads as healthy.
 */
function readLiveGauges() {
  const core = pool && pool.pool;
  // NOT Array.isArray — mysql2 v3 holds these in Denque instances, which expose
  // a numeric `length` but fail an array check. Guarding on Array.isArray made
  // this probe return null on every real pool while passing every reading of
  // the code; caught only by running it against a live pool. Duck-type on the
  // one property actually read, so a future container swap keeps working and a
  // genuine shape change still degrades to null rather than to a silent 0.
  const len = (d) => (d && typeof d.length === 'number' ? d.length : null);
  if (!core) return null;
  const open = len(core._allConnections);
  const free = len(core._freeConnections);
  const queued = len(core._connectionQueue);
  if (open === null || queued === null) return null;
  return { open, free: free ?? 0, inUse: Math.max(0, open - (free ?? 0)), queued };
}

/*
 * Saturation thresholds, as a FRACTION of the configured limits so they track
 * DB_CONNECTION_LIMIT / DB_QUEUE_LIMIT instead of needing to be re-tuned
 * whenever those move.
 *   busy      — every connection is checked out; requests are now waiting.
 *   saturated — the wait queue is deep enough that the NEXT burst hits
 *               "Queue limit reached.", i.e. this is the last warning.
 */
const SATURATION_QUEUE_FRACTION = 0.5;

function classifySaturation(live, limit, queueMax) {
  if (!live) return { status: 'unknown', reason: 'mysql2 pool internals not readable — see readLiveGauges()' };
  if (live.queued >= queueMax * SATURATION_QUEUE_FRACTION) return { status: 'saturated', ...live };
  if (live.queued > 0 || live.inUse >= limit) return { status: 'busy', ...live };
  return { status: 'ok', ...live };
}

function poolSaturation() {
  return classifySaturation(
    readLiveGauges(),
    poolLimit(),
    poolQueueMax(),
  );
}

/*
 * Burst-scoped log throttle.
 *
 * The previous rule was `enqueued === 1 || enqueued % 25 === 0` against the
 * LIFETIME counter. That logs the first-ever queue event loudly and then, for
 * the rest of the process's life, at most every 25th — so the SECOND incident
 * of the day is quieter than the first and a long saturation reports a number
 * ("queued so far: 4113") that describes history rather than the present.
 *
 * Scoping the throttle to a time window instead means every distinct burst gets
 * its own loud line carrying the LIVE depth, which is the number an operator
 * (or an alert rule reading the logs) actually needs.
 */
const ENQUEUE_LOG_WINDOW_MS = 60_000;
let lastEnqueueLogAt = 0;

pool.on('connection', () => { stats.connected += 1; });
pool.on('acquire',    () => { stats.acquired  += 1; });
pool.on('release',    () => { stats.released  += 1; });
pool.on('enqueue',    () => {
  stats.enqueued += 1;
  const now = Date.now();
  if (now - lastEnqueueLogAt < ENQUEUE_LOG_WINDOW_MS) return;
  lastEnqueueLogAt = now;
  const s = poolSaturation();
  const limit = poolLimit();
  const queueMax = poolQueueMax();
  const detail = s.status === 'unknown'
    ? '(live depth unavailable)'
    : `inUse=${s.inUse}/${limit} queued=${s.queued}/${queueMax}`;
  const msg = `Database pool ${s.status.toUpperCase()} — requests are waiting for a connection · ${detail}`;
  // `saturated` is the last warning before mysql2 throws "Queue limit reached."
  // and every in-flight request starts failing, so it goes out at ERROR level:
  // that is the line an alert rule should key on.
  if (s.status === 'saturated') logger.error(msg); else logger.warn(msg);
});

function getPoolStats() {
  const limit    = poolLimit();
  const queueMax = poolQueueMax();
  const live     = readLiveGauges();
  return {
    limit,
    queueMax,
    // Lifetime — trend/among-restarts context only. NEVER alert on these.
    connected: stats.connected,
    acquired:  stats.acquired,
    released:  stats.released,
    enqueued:  stats.enqueued,
    // Live — this is what an alert rule reads.
    saturation: poolSaturation(),
    open:   live ? live.open   : null,
    free:   live ? live.free   : null,
    inUse:  live ? live.inUse  : null,
    queued: live ? live.queued : null,
  };
}

async function testConnection() {
  const conn = await pool.getConnection();
  try {
    // eslint-disable-next-line no-restricted-syntax -- reports the DB server's own clock on purpose
    const [rows] = await conn.query('SELECT 1 AS ok, DATABASE() AS db, NOW() AS ts');
    logger.db(`Connected to "${rows[0].db}" at ${process.env.DB_HOST}:${process.env.DB_PORT || 3306} — server time ${rows[0].ts}`);
    return true;
  } finally {
    conn.release();
  }
}

async function closePool() {
  await pool.end();
  logger.db('Database connection pool closed');
}

module.exports = { pool, testConnection, closePool, getPoolStats, poolSaturation, _readLiveGauges: readLiveGauges, _classifySaturation: classifySaturation,  };
