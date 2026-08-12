const { pool } = require('../db');
const logger = require('../logger');

/*
 * Run one bounded scheduled job per database, not per Node replica.
 * MySQL named locks are connection-scoped, so the dedicated connection is held
 * only for the duration of the cron and RELEASE_LOCK always runs in finally.
 * timeout=0 is deliberate: a second Azure replica skips immediately instead of
 * occupying a pool slot while the first replica evaluates the batch.
 */
async function withMysqlNamedLock(name, task, dbPool = pool, { timeoutSeconds = 0 } = {}) {
  const lockName = String(name || '').trim();
  if (!lockName || lockName.length > 64) throw new Error('invalid MySQL named lock name');
  const timeout = Math.min(Math.max(Number(timeoutSeconds) || 0, 0), 30);
  const conn = await dbPool.getConnection();
  let acquired = false;
  try {
    const [[row]] = await conn.query('SELECT GET_LOCK(?, ?) AS acquired', [lockName, timeout]);
    acquired = Number(row?.acquired) === 1;
    if (!acquired) return { acquired: false, result: null };
    // Passing the pinned connection is additive: existing zero-argument cron
    // callbacks ignore it; request flows can keep their lock-protected reads
    // and writes on the same session without acquiring a second pool slot.
    return { acquired: true, result: await task(conn) };
  } finally {
    if (acquired) {
      try {
        await conn.query('SELECT RELEASE_LOCK(?) AS released', [lockName]);
      } catch (error) {
        logger.warn({ lockName, err: error.message }, 'MySQL named lock release failed');
      }
    }
    conn.release();
  }
}

module.exports = { withMysqlNamedLock };
