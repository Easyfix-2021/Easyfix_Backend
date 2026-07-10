/*
 * Per-caller (ops agent) coaching-score rollup — "who is improving, who is not".
 * Aggregates the per-call coaching analyses (tbl_plivo_call_log.call_analysis,
 * produced by call-analysis.service via Sophy) plus the teleprompter coverage
 * score (tbl_teleprompter_session.coverage_json), grouped by caller, and upserts
 * tbl_caller_score_rollup. Surfaced on Settings → Call Analytics (Per-Caller
 * Scorecard tab). Best-effort throughout — never throws into a caller.
 *
 * Phase 1 stores the OVERALL row (call_flow = '') per caller; per-flow breakdown
 * is a trivial extension (GROUP BY call_flow on the same query).
 */

const { pool } = require('../db');
const logger = require('../logger');

function parseJson(s) { try { return s ? JSON.parse(s) : null; } catch { return null; } }
function avg(nums) { return nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : null; }

// Recompute + upsert the overall rollup for one caller. Bounded to the most
// recent 200 analysed calls so a prolific caller can't make this unbounded.
async function rollupForCaller(callerUserId) {
  if (!callerUserId) return;
  try {
    const [rows] = await pool.query(
      `SELECT call_analysis, ended_on, initiated_on
         FROM tbl_plivo_call_log
        WHERE caller_user_id = ? AND call_analysis IS NOT NULL
        ORDER BY id DESC LIMIT 200`, [callerUserId]);
    const analyses = rows
      .map((r) => ({ a: parseJson(r.call_analysis), when: r.ended_on || r.initiated_on }))
      .filter((x) => x.a);

    const overalls = analyses.map((x) => Number(x.a.overall_score)).filter((n) => !Number.isNaN(n));
    const avgOverall = avg(overalls);

    const dimSum = {}; const dimCnt = {};
    for (const { a } of analyses) {
      for (const d of (Array.isArray(a.dimensions) ? a.dimensions : [])) {
        const n = Number(d.score);
        if (Number.isNaN(n) || !d.name) continue;
        dimSum[d.name] = (dimSum[d.name] || 0) + n;
        dimCnt[d.name] = (dimCnt[d.name] || 0) + 1;
      }
    }
    const avgDims = {};
    for (const k of Object.keys(dimSum)) avgDims[k] = Number((dimSum[k] / dimCnt[k]).toFixed(2));

    // Oldest→newest last 20 for a trend sparkline.
    const trend = analyses.slice(0, 20).reverse()
      .map((x) => ({ score: Number.isNaN(Number(x.a.overall_score)) ? null : Number(x.a.overall_score), when: x.when }));

    const [cov] = await pool.query(
      `SELECT coverage_json FROM tbl_teleprompter_session
        WHERE caller_user_id = ? AND coverage_json IS NOT NULL
        ORDER BY created_on DESC LIMIT 200`, [callerUserId]);
    const covPcts = cov.map((r) => parseJson(r.coverage_json))
      .map((c) => (c ? Number(c.coverage_pct) : NaN)).filter((n) => !Number.isNaN(n));
    const avgCoverage = avg(covPcts);

    const lastCallOn = analyses.length ? analyses[0].when : null;

    await pool.query(
      `INSERT INTO tbl_caller_score_rollup
         (caller_user_id, call_flow, calls_count, avg_overall, avg_coverage, avg_dimensions_json, trend_json, last_call_on)
       VALUES (?, '', ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         calls_count = VALUES(calls_count), avg_overall = VALUES(avg_overall),
         avg_coverage = VALUES(avg_coverage), avg_dimensions_json = VALUES(avg_dimensions_json),
         trend_json = VALUES(trend_json), last_call_on = VALUES(last_call_on)`,
      [callerUserId, overalls.length,
        avgOverall != null ? Number(avgOverall.toFixed(2)) : null,
        avgCoverage != null ? Number(avgCoverage.toFixed(2)) : null,
        Object.keys(avgDims).length ? JSON.stringify(avgDims) : null,
        trend.length ? JSON.stringify(trend) : null,
        lastCallOn]);
  } catch (e) {
    logger.warn('caller scorecard rollup failed · caller=' + callerUserId + ' · ' + e.message);
  }
}

async function list({ limit = 50, offset = 0 } = {}) {
  try {
    const [rows] = await pool.query(
      `SELECT r.caller_user_id, r.calls_count, r.avg_overall, r.avg_coverage,
              r.avg_dimensions_json, r.trend_json, r.last_call_on, r.updated_on, u.user_name
         FROM tbl_caller_score_rollup r
         LEFT JOIN tbl_user u ON u.user_id = r.caller_user_id
        WHERE r.call_flow = ''
        ORDER BY r.updated_on DESC
        LIMIT ? OFFSET ?`, [Number(limit), Number(offset)]);
    return rows.map((r) => ({
      callerUserId: r.caller_user_id,
      callerName: r.user_name || ('User ' + r.caller_user_id),
      callsCount: r.calls_count,
      avgOverall: r.avg_overall != null ? Number(r.avg_overall) : null,
      avgCoverage: r.avg_coverage != null ? Number(r.avg_coverage) : null,
      dimensions: parseJson(r.avg_dimensions_json) || {},
      trend: parseJson(r.trend_json) || [],
      lastCallOn: r.last_call_on,
    }));
  } catch (e) {
    logger.warn('caller scorecard list failed · ' + e.message);
    return [];
  }
}

module.exports = { rollupForCaller, list };
