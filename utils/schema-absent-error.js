/*
 * Is this database error the ANSWER "it is not there", or a real failure?
 *
 * Two probe styles exist in this codebase and they need opposite handling:
 *
 *   METADATA PROBE — `SELECT … FROM information_schema…` or `SHOW COLUMNS`.
 *     Absence comes back as zero rows. Any ERROR is a genuine fault, so its
 *     verdict must never be cached: freezing it would disable a feature until
 *     the container restarts.
 *
 *   TRY-THE-QUERY — `SELECT 1 FROM tbl_x LIMIT 1`. Absence comes back AS an
 *     error, so the error IS the answer and caching it is correct and cheap.
 *     Not caching it would re-probe on every hot-path call forever.
 *
 * This tells the two apart, so a try-the-query probe can cache the answer and
 * still refuse to cache a connection blip or a lock timeout.
 *
 * Matched on both `code` and `errno`: mysql2 sets the string code, but a driver
 * error surfaced through a pool wrapper sometimes carries only the number.
 */

const ABSENT_CODES = new Set([
  'ER_NO_SUCH_TABLE',   // 1146 — the table is not there
  'ER_BAD_FIELD_ERROR', // 1054 — the column is not there
  'ER_BAD_DB_ERROR',    // 1049 — the schema is not there
]);
const ABSENT_ERRNOS = new Set([1146, 1054, 1049]);

function isAbsentAnswer(err) {
  if (!err) return false;
  return ABSENT_CODES.has(err.code) || ABSENT_ERRNOS.has(Number(err.errno));
}

module.exports = { isAbsentAnswer, ABSENT_CODES, ABSENT_ERRNOS };
