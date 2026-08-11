const { pool } = require('../db');
const logger = require('../logger');
const lifecycle = require('./easyfixer-lifecycle.service');
const { withMysqlNamedLock } = require('./mysql-named-lock.service');
const { drainBatches } = require('./bounded-batch-drain');

/*
 * Bounded automatic lifecycle evaluator.
 *
 * It can only propose the two transitions allowed by the v5.1 document:
 * ACTIVE/UNDER_MASTER -> PAUSED or DORMANT. The lifecycle service enforces
 * that policy again inside a locked transaction, so this worker can never set
 * INACTIVE or BLACKLISTED even if a future query/configuration is wrong.
 *
 * Hot-path budget (default batch=100): one indexed keyset candidate query, five
 * set-based aggregate reads, and at most one short transaction per state change.
 * There is no per-row signal query/N+1 and no evaluation-cursor column write.
 *
 * The tuning knobs below were previously easyfix_properties. They are hardcoded
 * because this cron is opt-in (gated by easyfixer.lifecycle.evaluation.enabled,
 * read in server/scheduler.js) and bounded. Promote any single value back to a
 * property only if Ops ever needs to tune it live without a deploy.
 */

// Bounded-drain budget.
const EVALUATION_BATCH_SIZE = 100;
const EVALUATION_MAX_BATCHES = 100;
const EVALUATION_MAX_RUNTIME_MS = 120000;
// Policy thresholds (v5.1 specification).
const DORMANT_DAYS = 90;
const GRADE_MAX_AGE_DAYS = 7;
const ESCALATION_WINDOW_DAYS = 90;
const MARGIN_WINDOW_DAYS = 30;
const MARGIN_MIN_JOBS = 3;
const MARGIN_THRESHOLD_PERCENT = 15;
// The no-show rule stays inert. The v5.1 document never defined its denominator
// or window (the properties shipped blank), so it is fail-closed OFF; a future
// revision can re-enable it deliberately with a real denominator + window.
const NO_SHOW_ENABLED = false;
const NO_SHOW_WINDOW_DAYS = null;
const NO_SHOW_THRESHOLD_PERCENT = 5;
const NO_SHOW_MIN_RECORDS = 10;

function config() {
  return {
    batchSize: EVALUATION_BATCH_SIZE,
    maxBatches: EVALUATION_MAX_BATCHES,
    maxRuntimeMs: EVALUATION_MAX_RUNTIME_MS,
    dormantDays: DORMANT_DAYS,
    gradeMaxAgeDays: GRADE_MAX_AGE_DAYS,
    escalationWindowDays: ESCALATION_WINDOW_DAYS,
    marginWindowDays: MARGIN_WINDOW_DAYS,
    marginMinJobs: MARGIN_MIN_JOBS,
    marginThreshold: MARGIN_THRESHOLD_PERCENT,
    noShowEnabled: NO_SHOW_ENABLED,
    noShowWindowDays: NO_SHOW_WINDOW_DAYS,
    noShowThreshold: NO_SHOW_THRESHOLD_PERCENT,
    noShowMinRecords: NO_SHOW_MIN_RECORDS,
  };
}

// Deterministic efr_id keyset cursor (no lifecycle_evaluated_at column). Rows
// that transition out of ACTIVE/UNDER_MASTER leave the candidate set; rows that
// do not transition stay ACTIVE but sit at or below the advancing cursor, so
// each eligible technician is loaded at most once per bounded run.
async function loadCandidates(limit, afterEfrId = 0) {
  const [rows] = await pool.query(
    `SELECT efr_id, lifecycle_status, lifecycle_changed_at, current_balance,
            profile_activation_date_time, insert_date
       FROM tbl_easyfixer
      WHERE is_technician_verified = 1
        AND efr_status = 1
        AND lifecycle_status IN ('ACTIVE', 'UNDER_MASTER')
        AND efr_id > ?
      ORDER BY efr_id ASC
      LIMIT ?`,
    [Number(afterEfrId) || 0, limit],
  );
  return rows;
}

async function countRemaining(afterEfrId = 0) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS remaining
       FROM tbl_easyfixer
      WHERE is_technician_verified = 1
        AND efr_status = 1
        AND lifecycle_status IN ('ACTIVE', 'UNDER_MASTER')
        AND efr_id > ?`,
    [Number(afterEfrId) || 0],
  );
  return Number(row?.remaining) || 0;
}

function mapById(rows, idColumn = 'efr_id') {
  return new Map(rows.map((row) => [Number(row[idColumn]), row]));
}

async function loadSignals(candidates, cfg) {
  const ids = candidates.map((row) => Number(row.efr_id));
  if (!ids.length) return {};
  const placeholders = ids.map(() => '?').join(',');

  const noShowPromise = cfg.noShowEnabled
    ? pool.query(
      `SELECT easyfixer_id AS efr_id,
              COUNT(*) AS denominator,
              SUM(CASE
                    WHEN COALESCE(morning_slot, 0) = 0
                     AND COALESCE(evening_slot, 0) = 0
                     AND COALESCE(is_leave_marked, 0) = 0
                    THEN 1 ELSE 0 END) AS no_shows
         FROM tbl_easyfixer_attendance
        WHERE easyfixer_id IN (${placeholders})
          AND created_on >= DATE_SUB(NOW(), INTERVAL ? DAY)
        GROUP BY easyfixer_id`,
      [...ids, cfg.noShowWindowDays],
    )
    : Promise.resolve([[]]);

  const [attendanceResult, jobsResult, gradesResult, escalationsResult,
    marginResult, noShowResult] = await Promise.all([
    pool.query(
      `SELECT easyfixer_id AS efr_id, MAX(created_on) AS last_attendance
         FROM tbl_easyfixer_attendance
        WHERE easyfixer_id IN (${placeholders})
        GROUP BY easyfixer_id`,
      ids,
    ),
    pool.query(
      `SELECT fk_easyfixter_id AS efr_id,
              MAX(COALESCE(checkout_date_time, checkin_date_time,
                           scheduled_date_time, created_date_time)) AS last_job
         FROM tbl_job
        WHERE fk_easyfixter_id IN (${placeholders})
        GROUP BY fk_easyfixter_id`,
      ids,
    ),
    pool.query(
      `SELECT efr_id, grade, computed_at FROM tbl_efr_grade_snapshot
        WHERE efr_id IN (${placeholders})`,
      ids,
    ),
    pool.query(
      `WITH ranked AS (
         SELECT easyfixer_id AS efr_id, is_escalated,
                ROW_NUMBER() OVER (
                  PARTITION BY easyfixer_id
                  ORDER BY insert_date_time DESC, table_id DESC
                ) AS rn
          FROM tbl_easyfixer_rating_by_customer
          WHERE easyfixer_id IN (${placeholders})
            AND insert_date_time >= DATE_SUB(NOW(), INTERVAL ? DAY)
       )
       SELECT efr_id, COUNT(*) AS sample_size,
              SUM(CASE WHEN is_escalated = 1 THEN 1 ELSE 0 END) AS escalated_count
         FROM ranked
        WHERE rn <= 2
        GROUP BY efr_id`,
      [...ids, cfg.escalationWindowDays],
    ),
    pool.query(
      `SELECT j.fk_easyfixter_id AS efr_id,
              COUNT(DISTINCT j.job_id) AS job_count,
              COALESCE(SUM(t.total_charge), 0) AS revenue,
              COALESCE(SUM(t.efr_charge), 0) AS technician_share
         FROM tbl_job j
         JOIN tbl_job_transaction t ON t.fk_job_id = j.job_id
        WHERE j.fk_easyfixter_id IN (${placeholders})
          AND j.job_status IN (3, 5)
          AND COALESCE(j.checkout_date_time, j.created_date_time)
              >= DATE_SUB(NOW(), INTERVAL ? DAY)
        GROUP BY j.fk_easyfixter_id`,
      [...ids, cfg.marginWindowDays],
    ),
    noShowPromise,
  ]);

  return {
    attendance: mapById(attendanceResult[0]),
    jobs: mapById(jobsResult[0]),
    grades: mapById(gradesResult[0]),
    escalations: mapById(escalationsResult[0]),
    margins: mapById(marginResult[0]),
    noShows: mapById(noShowResult[0]),
  };
}

function dateMs(value) {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  const raw = String(value);
  const normalized = raw.includes('T')
    ? raw
    : `${raw.replace(' ', 'T')}+05:30`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function decide(candidate, signals, cfg, now = Date.now()) {
  const id = Number(candidate.efr_id);
  const balance = Number(candidate.current_balance || 0);
  if (balance < 0) {
    return {
      status: 'DORMANT',
      reasonCode: 'WALLET_BELOW_ZERO',
      reason: `Wallet balance is below zero (${balance.toFixed(2)})`,
      metadata: { walletBalance: balance },
    };
  }

  const baseline = Math.max(
    dateMs(candidate.profile_activation_date_time) || 0,
    dateMs(candidate.insert_date) || 0,
    dateMs(candidate.lifecycle_changed_at) || 0,
    dateMs(signals.attendance?.get(id)?.last_attendance) || 0,
    dateMs(signals.jobs?.get(id)?.last_job) || 0,
  );
  const dormantCutoff = now - cfg.dormantDays * 24 * 60 * 60 * 1000;
  if (baseline > 0 && baseline < dormantCutoff) {
    return {
      status: 'DORMANT',
      reasonCode: 'NO_ATTENDANCE_OR_JOB_ACTIVITY',
      reason: `No attendance or job activity for ${cfg.dormantDays} days`,
      metadata: { dormantDays: cfg.dormantDays },
    };
  }

  const gradeRow = signals.grades?.get(id);
  const grade = String(gradeRow?.grade || '').toUpperCase();
  const gradeAgeMs = gradeRow?.computed_at
    ? now - (dateMs(gradeRow.computed_at) || 0)
    : Number.POSITIVE_INFINITY;
  if ((grade === 'D' || grade === 'E')
      && gradeAgeMs >= 0
      && gradeAgeMs <= cfg.gradeMaxAgeDays * 24 * 60 * 60 * 1000) {
    return {
      status: 'PAUSED',
      reasonCode: 'LOW_PERFORMANCE_GRADE',
      reason: `Performance grade ${grade} requires remediation`,
      metadata: { grade, snapshotComputedAt: gradeRow.computed_at },
    };
  }

  const escalation = signals.escalations?.get(id);
  if (Number(escalation?.sample_size) >= 2
      && Number(escalation?.escalated_count) >= 2) {
    return {
      status: 'PAUSED',
      reasonCode: 'CONSECUTIVE_ESCALATIONS',
      reason: 'Two consecutive customer escalations require remediation',
      metadata: { consecutiveEscalations: 2 },
    };
  }

  const margin = signals.margins?.get(id);
  const revenue = Number(margin?.revenue || 0);
  const marginPercent = revenue > 0
    ? ((revenue - Number(margin?.technician_share || 0)) / revenue) * 100
    : null;
  if (Number(margin?.job_count || 0) >= cfg.marginMinJobs
      && marginPercent != null
      && marginPercent < cfg.marginThreshold) {
    return {
      status: 'PAUSED',
      reasonCode: 'LOW_MARGIN',
      reason: `Margin ${marginPercent.toFixed(1)}% is below ${cfg.marginThreshold}%`,
      metadata: {
        marginPercent: Number(marginPercent.toFixed(2)),
        windowDays: cfg.marginWindowDays,
        jobCount: Number(margin.job_count),
      },
    };
  }

  if (cfg.noShowEnabled) {
    const noShow = signals.noShows?.get(id);
    const denominator = Number(noShow?.denominator || 0);
    const rate = denominator > 0
      ? (Number(noShow?.no_shows || 0) / denominator) * 100
      : null;
    if (denominator >= cfg.noShowMinRecords
        && rate != null
        && rate > cfg.noShowThreshold) {
      return {
        status: 'PAUSED',
        reasonCode: 'NO_SHOW_RATE',
        reason: `No-show rate ${rate.toFixed(1)}% exceeds ${cfg.noShowThreshold}%`,
        metadata: {
          noShowRate: Number(rate.toFixed(2)),
          denominator: 'attendance_records',
          denominatorCount: denominator,
          windowDays: cfg.noShowWindowDays,
        },
      };
    }
  }
  return null;
}

async function evaluateBatch(candidates, cfg) {
  const signals = await loadSignals(candidates, cfg);
  let transitioned = 0;
  let failed = 0;
  const byStatus = { PAUSED: 0, DORMANT: 0 };
  for (const candidate of candidates) {
    const decision = decide(candidate, signals, cfg);
    if (!decision) continue;
    try {
      const result = await lifecycle.transition(candidate.efr_id, {
        ...decision,
        source: 'CRON',
        metadata: { ...decision.metadata, job: 'easyfixer-lifecycle-evaluation' },
        // Keep push/token IO inside this sequential bounded batch. Detached
        // fan-out would escape max-runtime accounting and saturate the pool.
        _awaitPostCommitSideEffects: true,
      });
      if (result.changed) {
        transitioned += 1;
        byStatus[result.lifecycle.status] = (byStatus[result.lifecycle.status] || 0) + 1;
      }
    } catch (error) {
      failed += 1;
      logger.warn(
        { efrId: candidate.efr_id, status: decision.status, err: error.message },
        'lifecycle evaluation transition failed',
      );
    }
  }
  return {
    evaluated: candidates.length,
    transitioned,
    paused: byStatus.PAUSED,
    dormant: byStatus.DORMANT,
    failed,
  };
}

async function runDailyEvaluationUnlocked() {
  if (!(await lifecycle.hasLifecycleSchema())) {
    return {
      evaluated: 0,
      processed: 0,
      remaining: null,
      transitioned: 0,
      failed: 0,
      batches: 0,
      skipped: true,
      reason: 'lifecycle schema not installed',
    };
  }
  const cfg = config();
  // efr_id keyset cursor: each batch advances past the highest id it loaded, so
  // every eligible technician is processed at most once per bounded run.
  let cursor = 0;
  const result = await drainBatches({
    batchSize: cfg.batchSize,
    maxBatches: cfg.maxBatches,
    maxRuntimeMs: cfg.maxRuntimeMs,
    loadBatch: async (limit) => {
      const candidates = await loadCandidates(limit, cursor);
      const last = candidates[candidates.length - 1];
      if (last) cursor = Number(last.efr_id);
      return candidates;
    },
    processBatch: (candidates) => evaluateBatch(candidates, cfg),
    loadRemaining: () => countRemaining(cursor),
  });
  const observable = {
    ...result,
    skipped: false,
    noShowEnabled: cfg.noShowEnabled,
    batchSize: cfg.batchSize,
    maxBatches: cfg.maxBatches,
    maxRuntimeMs: cfg.maxRuntimeMs,
  };
  logger.info({ ...observable }, 'technician lifecycle evaluation completed');
  return observable;
}

async function runDailyEvaluation() {
  const locked = await withMysqlNamedLock(
    'easyfix:lifecycle:evaluation',
    runDailyEvaluationUnlocked,
  );
  if (!locked.acquired) {
    return {
      evaluated: 0,
      transitioned: 0,
      failed: 0,
      skipped: true,
      reason: 'another backend replica owns the lifecycle evaluation lock',
    };
  }
  return locked.result;
}

module.exports = {
  runDailyEvaluation,
  _internals: {
    config, decide, dateMs, loadCandidates, countRemaining, loadSignals,
    evaluateBatch, drainBatches, runDailyEvaluationUnlocked,
  },
};
