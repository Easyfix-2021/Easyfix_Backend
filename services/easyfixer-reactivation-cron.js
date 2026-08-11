const { pool } = require('../db');
const logger = require('../logger');
const lifecycle = require('./easyfixer-lifecycle.service');
const { getProperty } = require('./properties.service');
const { withMysqlNamedLock } = require('./mysql-named-lock.service');
const { drainBatches } = require('./bounded-batch-drain');

/*
 * Daily scheduled lifecycle lift. Candidate discovery is one bounded indexed
 * read; every actual SUSPENDED/PAUSED -> ACTIVE mutation then goes through the
 * same transactional lifecycle service as CRM, restoring ACTIVE or
 * UNDER_MASTER as appropriate and producing audit + post-commit
 * registration_status push. Permanent INACTIVE and BLACKLISTED rows are never
 * selected and can never pass the service's CRON transition policy.
 */

function istDateString(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}

function batchSize() {
  const configured = Number(getProperty('easyfixer.auto_reactivation.batch_size'));
  return Number.isFinite(configured)
    ? Math.min(Math.max(Math.trunc(configured), 1), 500)
    : 100;
}

function maxBatches() {
  const configured = Number(getProperty('easyfixer.auto_reactivation.max_batches_per_run'));
  return Number.isFinite(configured)
    ? Math.min(Math.max(Math.trunc(configured), 1), 100)
    : 100;
}

function maxRuntimeMs() {
  const configured = Number(getProperty('easyfixer.auto_reactivation.max_runtime_ms'));
  return Number.isFinite(configured)
    ? Math.min(Math.max(Math.trunc(configured), 1000), 900000)
    : 120000;
}

async function dueIds({ today, onlyEfrId = null, limit = null, cursor = null }) {
  const params = [];
  const clauses = [
    'efr_status = 0',
    'is_technician_verified = 1',
    "lifecycle_status IN ('SUSPENDED', 'PAUSED')",
    // The scheduled end date is single-sourced from scheduled_reactivation_date
    // (a PAUSED/SUSPENDED lifecycle transition writes the "until" there); there
    // is no separate lifecycle_until column.
    'scheduled_reactivation_date IS NOT NULL',
  ];
  if (onlyEfrId != null) {
    clauses.push('efr_id = ?');
    params.push(Number(onlyEfrId));
  } else {
    clauses.push('scheduled_reactivation_date <= ?');
    params.push(today);
    if (cursor) {
      clauses.push(`(scheduled_reactivation_date > ?
        OR (scheduled_reactivation_date = ? AND efr_id > ?))`);
      params.push(cursor.dueDate, cursor.dueDate, cursor.efrId);
    }
  }
  params.push(onlyEfrId != null ? 1 : (limit || batchSize()));
  const [rows] = await pool.query(
    `SELECT efr_id, scheduled_reactivation_date AS due_date
       FROM tbl_easyfixer
      WHERE ${clauses.join(' AND ')}
      ORDER BY scheduled_reactivation_date ASC, efr_id ASC
      LIMIT ?`,
    params,
  );
  return rows.map((row) => ({
    efrId: Number(row.efr_id),
    dueDate: row.due_date,
  }));
}

async function countDue(today) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS remaining
       FROM tbl_easyfixer
      WHERE efr_status = 0
        AND is_technician_verified = 1
        AND lifecycle_status IN ('SUSPENDED', 'PAUSED')
        AND scheduled_reactivation_date IS NOT NULL
        AND scheduled_reactivation_date <= ?`,
    [today],
  );
  return Number(row?.remaining) || 0;
}

async function processCandidates(candidates, today) {
  let reactivated = 0;
  let failed = 0;
  for (const { efrId } of candidates) {
    try {
      const result = await lifecycle.transition(efrId, {
        reasonCode: 'SCHEDULED_REACTIVATION',
        reason: 'Scheduled suspension completed',
        source: 'CRON',
        metadata: { job: 'easyfixer-auto-reactivation', dueDate: today },
        _resolveStatus: lifecycle.operationalStatusForManager,
        _awaitPostCommitSideEffects: true,
      });
      if (result.changed) reactivated += 1;
    } catch (error) {
      failed += 1;
      logger.warn({ efrId, err: error.message }, 'easyfixer reactivation transition failed');
    }
  }
  return {
    evaluated: candidates.length,
    transitioned: reactivated,
    reactivated,
    failed,
  };
}

async function reactivate({ today, onlyEfrId = null } = {}) {
  if (!(await lifecycle.hasLifecycleSchema())) {
    return { reactivated: 0, failed: 0, skipped: true, reason: 'lifecycle schema not installed' };
  }
  if (onlyEfrId != null) {
    const candidates = await dueIds({ today, onlyEfrId });
    const result = await processCandidates(candidates, today);
    return {
      eligible: candidates.length,
      reactivated: result.reactivated,
      failed: result.failed,
      skipped: false,
    };
  }

  let cursor = null;
  const drained = await drainBatches({
    batchSize: batchSize(),
    maxBatches: maxBatches(),
    maxRuntimeMs: maxRuntimeMs(),
    loadBatch: async (limit) => {
      const candidates = await dueIds({ today, limit, cursor });
      const last = candidates[candidates.length - 1];
      if (last) cursor = { dueDate: last.dueDate, efrId: last.efrId };
      return candidates;
    },
    processBatch: (candidates) => processCandidates(candidates, today),
    loadRemaining: () => countDue(today),
  });
  return {
    ...drained,
    eligible: drained.processed,
    reactivated: drained.transitioned,
    skipped: false,
  };
}

async function runDailyReactivationUnlocked() {
  const today = istDateString(0);
  try {
    const result = await reactivate({ today });
    logger.info(
      `Easyfixer auto-reactivation cron · date=${today} · eligible=${result.eligible || 0}`
      + ` · reactivated=${result.reactivated} · failed=${result.failed || 0}`,
    );
    return { date: today, ...result };
  } catch (error) {
    logger.warn({ err: error.message }, 'easyfixer-reactivation cron run failed');
    return { date: today, eligible: 0, reactivated: 0, failed: 1, skipped: true };
  }
}

async function runDailyReactivation() {
  const locked = await withMysqlNamedLock(
    'easyfix:lifecycle:reactivation',
    runDailyReactivationUnlocked,
  );
  if (!locked.acquired) {
    return {
      date: istDateString(0),
      eligible: 0,
      reactivated: 0,
      failed: 0,
      skipped: true,
      reason: 'another backend replica owns the lifecycle reactivation lock',
    };
  }
  return locked.result;
}

async function runTest({ sourceId } = {}) {
  const efrId = Number(sourceId);
  if (!Number.isInteger(efrId) || efrId <= 0) {
    return { ok: false, error: 'A valid Easyfixer ID (efr_id) is required.' };
  }
  try {
    const result = await reactivate({ today: istDateString(0), onlyEfrId: efrId });
    return {
      ok: true,
      efr_id: efrId,
      ...result,
      note: result.reactivated
        ? 'Technician reactivated through the audited lifecycle transition (master mapping preserved).'
        : 'No change — the technician is not a verified, scheduled SUSPENDED/PAUSED row.',
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = {
  runDailyReactivation,
  runTest,
  istDateString,
  _internals: {
    dueIds,
    countDue,
    batchSize,
    maxBatches,
    maxRuntimeMs,
    processCandidates,
    reactivate,
    runDailyReactivationUnlocked,
  },
};
