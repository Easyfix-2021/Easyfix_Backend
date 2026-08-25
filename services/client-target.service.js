/*
 * Per-client contracted performance targets.
 *
 * Backed by easyfix_client_target (see
 * migrations/2026-08-20-client-spoc-access.sql). Every number the Performance
 * book compares against lives here, so "84% SLA" can be rendered as "84% of a
 * contracted 90%" rather than as a bare figure nobody can judge.
 *
 * A MISSING ROW IS NORMAL. Most clients will never have a row until someone
 * configures one, so the platform defaults below are the fallback rather than
 * an error. That keeps Performance renderable on day one.
 */
const { pool } = require('../db');
const logger = require('../logger');

/*
 * Platform defaults. These are the numbers EasyFix holds itself to when a
 * client contract does not say otherwise — the same figures the Performance
 * prototype was designed against.
 *
 * Direction matters for judging a metric, and it is not the same for all four:
 * SLA and FTFR are "higher is better", revisit rate and age at close are
 * "lower is better". Storing `dir` beside each target keeps that knowledge in
 * one place instead of scattered across the frontend.
 */
const DEFAULT_TARGETS = {
  sla_pct: 90,
  ftfr_pct: 85,
  revisit_pct: 10,
  avg_age_days: 3,
  approval_response_hours: 24,
};

const TARGET_DIRECTION = {
  sla_pct: 'higher',
  ftfr_pct: 'higher',
  revisit_pct: 'lower',
  avg_age_days: 'lower',
  approval_response_hours: 'lower',
};

// Flipped false the first time the table turns out to be missing, so an
// un-migrated environment pays the error once rather than per request.
let targetTableAvailable = true;

/**
 * Targets for one client, always resolved. Returns the platform defaults when
 * no row exists, the table has not been migrated, or the lookup fails.
 *
 * `source` tells the caller which of those happened, so the UI can label a
 * target as contracted rather than assumed.
 */
async function getTargets(clientId, opts = {}) {
  /*
   * ─── withAudit IS OPT-IN, AND THAT IS A PRIVACY BOUNDARY ──────────────────
   *
   * updated_by is a tbl_user id — an EASYFIX STAFF MEMBER. This function is
   * shared: routes/client/index.js#/performance calls it and spreads the
   * result straight into the CLIENT PORTAL response. Returning the auditor's
   * name unconditionally would put an internal staff name in front of every
   * tenant, silently, the moment this function grew the column.
   *
   * So the default shape is BYTE-IDENTICAL to what it has always been, and the
   * two admin routes opt in. Fail-closed: a new caller gets no audit unless it
   * asks, rather than getting it and having to remember to strip it.
   */
  const withAudit = opts.withAudit === true;
  const fallback = { ...DEFAULT_TARGETS, source: 'platform-default' };
  if (withAudit) { fallback.updatedAt = null; fallback.updatedBy = null; }
  if (!targetTableAvailable) return fallback;
  try {
    const [[row]] = await pool.query(
      withAudit
        ? `SELECT t.sla_pct, t.ftfr_pct, t.revisit_pct, t.avg_age_days,
                  t.approval_response_hours, t.updated_at, t.updated_by,
                  u.user_name AS updated_by_name
             FROM easyfix_client_target t
             LEFT JOIN tbl_user u ON u.user_id = t.updated_by
            WHERE t.client_id = ? LIMIT 1`
        : `SELECT sla_pct, ftfr_pct, revisit_pct, avg_age_days, approval_response_hours
             FROM easyfix_client_target WHERE client_id = ? LIMIT 1`,
      [clientId]
    );
    if (!row) return fallback;
    const out = {
      sla_pct: Number(row.sla_pct),
      ftfr_pct: Number(row.ftfr_pct),
      revisit_pct: Number(row.revisit_pct),
      avg_age_days: Number(row.avg_age_days),
      approval_response_hours: Number(row.approval_response_hours),
      source: 'contracted',
    };
    if (withAudit) {
      /*
       * updated_at arrives as an IST wall-clock string ("YYYY-MM-DD HH:mm:ss")
       * because the pool runs dateStrings + timezone '+05:30'. Passed through
       * verbatim rather than re-parsed — every re-parse is a chance to shift it.
       * LEFT JOIN, so an updated_by pointing at a since-deleted user still
       * returns the id with a null name rather than dropping the row.
       */
      out.updatedAt = row.updated_at || null;
      out.updatedBy = row.updated_by
        ? { id: Number(row.updated_by), name: row.updated_by_name || null }
        : null;
    }
    return out;
  } catch (e) {
    if (e && e.errno === 1146) {
      targetTableAvailable = false;
      logger.warn('easyfix_client_target missing — using platform default targets until the 2026-08-20 migration is applied');
      return fallback;
    }
    logger.warn('getTargets failed (' + e.message + ') — using platform default targets');
    return fallback;
  }
}

/**
 * Judge a measured value against its target.
 * Returns 'ok' | 'watch' | 'risk' — the three states the Performance table
 * renders as On Track / Watch / At Risk.
 *
 * `watch` is the band within 10% (relative) of the target on the wrong side.
 * Anything worse is `risk`. One rule for both directions so a metric cannot be
 * judged generously just because lower happens to be better for it.
 */
function judge(metric, value) {
  const target = DEFAULT_TARGETS[metric];
  return judgeAgainst(metric, value, target);
}

function judgeAgainst(metric, value, target) {
  if (value == null || target == null) return 'ok';
  const higherIsBetter = TARGET_DIRECTION[metric] !== 'lower';
  const met = higherIsBetter ? value >= target : value <= target;
  if (met) return 'ok';
  const slack = Math.abs(target) * 0.1;
  const missedBy = higherIsBetter ? target - value : value - target;
  return missedBy <= slack ? 'watch' : 'risk';
}

/*
 * ─── WRITES ────────────────────────────────────────────────────────────────
 *
 * A WRITE MUST NOT FAIL SOFT. getTargets() deliberately swallows a missing
 * table and returns the platform defaults, because a Performance page that
 * cannot render is worse than one showing assumed numbers. The opposite is
 * true here: an operator who types "SLA 95%", sees a success toast and gets
 * nothing persisted is strictly worse off than one who sees an error. So
 * every failure path below THROWS.
 */

/** Tag an error so the route layer can map it to a status. */
function unavailable() {
  return Object.assign(
    new Error('Client targets storage is not provisioned on this environment '
      + '(run migrations/executed/2026-08-20-client-spoc-access.sql)'),
    { status: 503 },
  );
}

/**
 * Upsert one client's contracted targets.
 *
 * client_id is the PRIMARY KEY, so ON DUPLICATE KEY UPDATE is the whole
 * concurrency story — two operators saving at once cannot create a duplicate
 * row, and the later write wins cleanly.
 *
 * `updated_at` is bound as a JS Date rather than SQL NOW(): the pool runs with
 * timezone '+05:30' + dateStrings, so a Date lands as IST verbatim, whereas
 * NOW() would follow whatever the MySQL session is set to. See the
 * DATETIME-IST convention used by the OTP writers.
 *
 * Returns the row as it now stands, in the same shape getTargets() returns, so
 * a caller never has to re-read to know what was stored.
 */
async function setTargets(clientId, values, actorId) {
  logger.info('Set client targets · clientId=' + clientId);
  if (!targetTableAvailable) throw unavailable();
  const row = {
    sla_pct: Number(values.sla_pct),
    ftfr_pct: Number(values.ftfr_pct),
    revisit_pct: Number(values.revisit_pct),
    avg_age_days: Number(values.avg_age_days),
    approval_response_hours: Number(values.approval_response_hours),
  };
  try {
    await pool.query(
      `INSERT INTO easyfix_client_target
         (client_id, sla_pct, ftfr_pct, revisit_pct, avg_age_days,
          approval_response_hours, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         sla_pct = VALUES(sla_pct),
         ftfr_pct = VALUES(ftfr_pct),
         revisit_pct = VALUES(revisit_pct),
         avg_age_days = VALUES(avg_age_days),
         approval_response_hours = VALUES(approval_response_hours),
         updated_by = VALUES(updated_by),
         updated_at = VALUES(updated_at)`,
      [
        clientId, row.sla_pct, row.ftfr_pct, row.revisit_pct,
        row.avg_age_days, row.approval_response_hours,
        actorId ?? null, new Date(),
      ],
    );
  } catch (e) {
    if (e && e.errno === 1146) {
      targetTableAvailable = false;
      throw unavailable();
    }
    throw e;
  }
  logger.info('Client targets saved · clientId=' + clientId);
  return { ...row, source: 'contracted' };
}

/**
 * Drop a client's contracted row, returning them to the platform defaults.
 *
 * WHY THIS EXISTS AT ALL. getTargets() reports `source` as 'contracted' vs
 * 'platform-default', and the UI leans on that distinction hard — a default
 * shown as a commitment is the sentence nobody wants read back to them in a
 * QBR. Without a delete there is no way BACK to 'platform-default' once
 * anybody saves, so the first accidental save would permanently mark a client
 * as contracted. Setting the fields to the default VALUES would not do it:
 * the row would still exist, and `source` would still say 'contracted'.
 *
 * Returns true when a row was actually removed.
 */
async function clearTargets(clientId) {
  logger.info('Clear client targets · clientId=' + clientId);
  if (!targetTableAvailable) throw unavailable();
  try {
    const [r] = await pool.query(
      'DELETE FROM easyfix_client_target WHERE client_id = ?', [clientId],
    );
    logger.info('Client targets cleared · clientId=' + clientId + ' affected=' + r.affectedRows);
    return r.affectedRows > 0;
  } catch (e) {
    if (e && e.errno === 1146) {
      targetTableAvailable = false;
      throw unavailable();
    }
    throw e;
  }
}

module.exports = {
  DEFAULT_TARGETS, TARGET_DIRECTION, getTargets, judge, judgeAgainst,
  setTargets, clearTargets,
};
