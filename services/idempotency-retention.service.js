const { pool } = require('../db');
const logger = require('../logger');
const { withMysqlNamedLock } = require('./mysql-named-lock.service');

const DEFAULT_BATCH_SIZE = 1000;
const MAX_BATCH_SIZE = 5000;
const DEFAULT_MAX_ROWS_PER_RUN = 20_000;
const MAX_ROWS_PER_RUN = 50_000;
const DEFAULT_MAX_DURATION_MS = 2000;

/*
 * Delete one bounded expiry-indexed batch. drainExpired may issue several of
 * these statements, but caps both rows and wall time; no payload read or
 * per-row query is involved.
 */
async function deleteExpired({ limit = DEFAULT_BATCH_SIZE, database = pool } = {}) {
  const parsed = Number(limit);
  const boundedLimit = Number.isFinite(parsed)
    ? Math.min(Math.max(Math.trunc(parsed), 1), MAX_BATCH_SIZE)
    : DEFAULT_BATCH_SIZE;
  const [result] = await database.query(
    `DELETE FROM tbl_idempotency_key
      WHERE expires_at <= NOW()
      ORDER BY expires_at ASC
      LIMIT ?`,
    [boundedLimit],
  );
  const deleted = Number(result.affectedRows) || 0;
  return { deleted, limit: boundedLimit };
}

async function drainExpired({
  limit = DEFAULT_BATCH_SIZE,
  maxRows = DEFAULT_MAX_ROWS_PER_RUN,
  maxDurationMs = DEFAULT_MAX_DURATION_MS,
  database = pool,
  now = Date.now,
} = {}) {
  const boundedMaxRows = Math.min(
    Math.max(Math.trunc(Number(maxRows) || DEFAULT_MAX_ROWS_PER_RUN), 1),
    MAX_ROWS_PER_RUN,
  );
  const boundedDuration = Math.min(
    Math.max(Math.trunc(Number(maxDurationMs) || DEFAULT_MAX_DURATION_MS), 100),
    10_000,
  );
  const startedAt = now();
  let deleted = 0;
  let batches = 0;

  while (deleted < boundedMaxRows && now() - startedAt < boundedDuration) {
    const remaining = boundedMaxRows - deleted;
    const batch = await deleteExpired({ limit: Math.min(limit, remaining), database });
    deleted += batch.deleted;
    batches += 1;
    if (batch.deleted < batch.limit) break;
  }
  if (deleted > 0) logger.info({ deleted, batches }, 'Expired idempotency responses removed');
  return { deleted, batches, maxRows: boundedMaxRows, maxDurationMs: boundedDuration };
}

async function run(options = {}) {
  const { database = pool } = options;
  const locked = await withMysqlNamedLock(
    'easyfix:idempotency-retention',
    (connection) => drainExpired({ ...options, database: connection }),
    database,
  );
  if (!locked.acquired) return { deleted: 0, skipped: true, reason: 'another replica owns cleanup' };
  return { ...locked.result, skipped: false };
}

module.exports = {
  deleteExpired,
  drainExpired,
  run,
  DEFAULT_BATCH_SIZE,
  MAX_BATCH_SIZE,
  DEFAULT_MAX_ROWS_PER_RUN,
  MAX_ROWS_PER_RUN,
  DEFAULT_MAX_DURATION_MS,
};
