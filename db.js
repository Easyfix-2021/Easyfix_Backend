const mysql = require('mysql2/promise');
const logger = require('./logger');

/*
 * MySQL connection pool.
 *
 * Why these knobs matter:
 *   connectionLimit  — hard ceiling on open sockets to MySQL. Too low = client queues;
 *                      too high = MySQL's own `max_connections` rejects. Bumped 20 → 30
 *                      because this one process serves BOTH the CRM and the EasyFixer app
 *                      off the same pool, and a single dashboard load fans out ~15 parallel
 *                      queries (Promise.all in mobile-dashboard.service.js); at 20, two
 *                      concurrent dashboard loads alone could saturate the pool and queue
 *                      everything else. 30 gives headroom without approaching MySQL's
 *                      `max_connections`. Scale horizontally before raising further.
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

const pool = mysql.createPool({
  host:     process.env.DB_HOST || 'localhost',
  port:     parseInt(process.env.DB_PORT || '3306', 10),
  database: process.env.DB_NAME || 'easyfix_core',
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,

  connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || '30', 10),
  queueLimit:      parseInt(process.env.DB_QUEUE_LIMIT      || '50', 10),
  maxIdle:         parseInt(process.env.DB_MAX_IDLE         || '10', 10),
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

pool.on('connection', () => { stats.connected += 1; });
pool.on('acquire',    () => { stats.acquired  += 1; });
pool.on('release',    () => { stats.released  += 1; });
pool.on('enqueue',    () => {
  stats.enqueued += 1;
  // Only warn once per burst — every queued request would flood the log.
  if (stats.enqueued === 1 || stats.enqueued % 25 === 0) {
    logger.warn(`Database pool saturated — waiting for a free connection (queued so far: ${stats.enqueued})`);
  }
});

function getPoolStats() {
  const limit    = parseInt(process.env.DB_CONNECTION_LIMIT || '30', 10);
  const queueMax = parseInt(process.env.DB_QUEUE_LIMIT      || '50', 10);
  return {
    limit,
    queueMax,
    connected: stats.connected,
    acquired:  stats.acquired,
    released:  stats.released,
    enqueued:  stats.enqueued,
    inUse:     Math.max(0, stats.acquired - stats.released),
  };
}

async function testConnection() {
  const conn = await pool.getConnection();
  try {
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

module.exports = { pool, testConnection, closePool, getPoolStats };
