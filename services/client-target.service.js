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
async function getTargets(clientId) {
  const fallback = { ...DEFAULT_TARGETS, source: 'platform-default' };
  if (!targetTableAvailable) return fallback;
  try {
    const [[row]] = await pool.query(
      `SELECT sla_pct, ftfr_pct, revisit_pct, avg_age_days, approval_response_hours
         FROM easyfix_client_target WHERE client_id = ? LIMIT 1`,
      [clientId]
    );
    if (!row) return fallback;
    return {
      sla_pct: Number(row.sla_pct),
      ftfr_pct: Number(row.ftfr_pct),
      revisit_pct: Number(row.revisit_pct),
      avg_age_days: Number(row.avg_age_days),
      approval_response_hours: Number(row.approval_response_hours),
      source: 'contracted',
    };
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

module.exports = { DEFAULT_TARGETS, TARGET_DIRECTION, getTargets, judge, judgeAgainst };
