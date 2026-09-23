'use strict';
/*
 * services/job-verification.service.js — EasyFix check, client QC, and the
 * ledger post that follows them (V3 plan 3.6 / 3.8 / 3.11).
 *
 * THE ORDER IS THE DESIGN (job.txt sheet 14 "Where is my money"):
 *   You finished → EasyFix checking (usually N h) → Client QC (usually N) → In wallet.
 * So verify() does NOT post the ledger; the money moves when the client passes
 * QC (approve) or their window lapses (the 15-minute auto-pass cron), through
 * postAfterQc().
 *
 * ONE ROW PER JOB in tbl_job_verification (PK job_id) is the idempotency rule:
 * a double-click on Pass Audit hits ER_DUP_ENTRY and gets the first row back.
 *
 * WHY posted_on AND NOT "THE LEDGER HAS A ROW". A job the CRM completed is
 * already posted by setStatus (job-ledger.service.js); postCompletionLedger's
 * own guards make a second call a no-op that says so, and this service then
 * stamps posted_on so the cron never looks at that job again.
 */
const { pool } = require('../db');
const logger = require('../logger');
const ledger = require('./job-ledger.service');
const jobLog = require('./job-log.service');
const { getProperty } = require('./properties.service');
const { withMysqlNamedLock } = require('./mysql-named-lock.service');

// Spec 3.8 defaults, used when a client has no tbl_client_qc_timing row and
// ops has set no property.
const DEFAULT_QC_HOURS = 24;
const DEFAULT_CHECK_HOURS = 2;
const PROP_QC_HOURS = 'job.qc.hours.default';
const PROP_CHECK_HOURS = 'job.check.hours.default';

const QC_DONE = new Set(['passed', 'auto']);
const COMPLETED = new Set([3, 5]);
const VERIFIABLE = new Set([3, 5, 10]);

// Spec: "bounded batch 200/run, one at a time".
const AUTO_PASS_BATCH = 200;
const AUTO_PASS_LOCK = 'easyfix:qc-auto-pass';

function httpError(status, message, code) {
  const e = new Error(message); e.status = status; if (code) e.code = code; return e;
}

async function logSoft(name, jobId, details, actor, at) {
  try {
    await jobLog[name](jobId, details, actor, at);
  } catch (e) {
    logger.warn(`Job log ${name} failed (non-fatal) · jobId=${jobId} · ${e.message}`);
  }
}

function propHours(key, fallback) {
  const raw = getProperty(key);
  const n = Number(raw);
  return raw != null && raw !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * The client's QC and check windows: their tbl_client_qc_timing row, else the
 * properties, else the code defaults. getProperty is the in-memory cache, so
 * this is one indexed PK read at most.
 */
async function timingsForClient(clientId, conn = pool) {
  const [[row]] = await conn.query(
    'SELECT qc_hours, check_hours FROM tbl_client_qc_timing WHERE client_id = ?', [clientId],
  );
  return {
    qcHours: row && row.qc_hours != null ? Number(row.qc_hours) : propHours(PROP_QC_HOURS, DEFAULT_QC_HOURS),
    checkHours: row && row.check_hours != null ? Number(row.check_hours) : propHours(PROP_CHECK_HOURS, DEFAULT_CHECK_HOURS),
  };
}

function shapeVerification(v) {
  if (!v) return null;
  return {
    jobId: Number(v.job_id),
    verifiedOn: v.verified_on || null,
    verifiedBy: v.verified_by == null ? null : Number(v.verified_by),
    qcDueOn: v.qc_due_on || null,
    qcStatus: v.qc_status || null,
    qcOn: v.qc_on || null,
    postedOn: v.posted_on || null,
    postError: v.post_error || null,
  };
}

async function readVerification(jobId, conn = pool) {
  const [[v]] = await conn.query(
    `SELECT job_id, verified_on, verified_by, qc_due_on, qc_status, qc_on, qc_by_contact_id,
            qc_note, posted_on, post_error
       FROM tbl_job_verification WHERE job_id = ?`,
    [jobId],
  );
  return v || null;
}

/**
 * POST /admin/jobs/:id/verify — "Pass audit" (renderDesk deskQC: "Audit passed —
 * sent to client QC"). Starts the client's QC clock; posts nothing.
 */
async function verifyJob(j, actor, { now = new Date() } = {}) {
  if (!VERIFIABLE.has(Number(j.job_status))) {
    throw httpError(409, `Only a completed or revisit job can be verified (this one is in status ${j.job_status})`, 'NOT_VERIFIABLE');
  }
  const { qcHours } = await timingsForClient(j.fk_client_id);
  const due = new Date(now.getTime() + qcHours * 3600 * 1000);
  try {
    await pool.query(
      `INSERT INTO tbl_job_verification (job_id, verified_on, verified_by, qc_due_on, qc_status)
       VALUES (?, ?, ?, ?, 'pending')`,
      [j.job_id, now, actor.user_id, due],
    );
  } catch (e) {
    if (e.code !== 'ER_DUP_ENTRY') throw e;
    // Already verified (a double-click, or a second operator): same answer.
    return { ...shapeVerification(await readVerification(j.job_id)), already: true };
  }
  await logSoft('logJobVerified', j.job_id, {}, actor, now);
  logger.info(`Job verified · jobId=${j.job_id} · qc due in ${qcHours}h`);
  return { ...shapeVerification(await readVerification(j.job_id)), already: false };
}

/**
 * Post the completion ledger once QC is done. NEVER throws: a failure is
 * recorded on the row (post_error) and returned, so the client's QC click and
 * the cron both finish.
 *
 * The call is the backfill's (scripts/backfill-completion-ledger.js apply):
 * inLedgerTransaction + postCompletionLedger, jobTransactionAt = the job's
 * checkout time so the technician's earnings stay grouped under the day he did
 * the work, not the day the client clicked. crmUserId = verified_by, the person
 * who passed the audit. A job at 10 (revisit) is NOT posted: posting is
 * one-shot per job (the technician-ledger row is the key), so posting visit 1
 * would lock visit 2's money out forever.
 */
async function postAfterQc(jobId, { now = new Date() } = {}) {
  const v = await readVerification(jobId);
  if (!v) return { posted: false, reason: 'not verified' };
  if (v.posted_on) return { posted: true, already: true };
  if (!QC_DONE.has(v.qc_status)) return { posted: false, reason: `QC is ${v.qc_status || 'not started'}` };

  let outcome;
  try {
    outcome = await ledger.inLedgerTransaction(async (conn) => {
      const [[j]] = await conn.query(
        'SELECT job_status, checkout_date_time FROM tbl_job WHERE job_id = ? FOR UPDATE', [jobId],
      );
      if (!j) return { unpostable: true, reason: 'job not found' };
      if (!COMPLETED.has(Number(j.job_status))) {
        return { unpostable: true, reason: `job is in status ${j.job_status}, not completed — it posts when it completes` };
      }
      return ledger.postCompletionLedger(conn, {
        jobId: Number(jobId),
        fromStatus: Number(j.job_status),
        crmUserId: v.verified_by,
        at: now,
        jobTransactionAt: j.checkout_date_time || now,
      });
    });
  } catch (e) {
    outcome = { unpostable: true, reason: e.message || 'ledger post failed' };
  }

  if (outcome.unpostable) {
    await pool.query(
      'UPDATE tbl_job_verification SET post_error = ? WHERE job_id = ? AND posted_on IS NULL',
      [String(outcome.reason).slice(0, 255), jobId],
    ).catch((e) => logger.warn(`post_error write failed · jobId=${jobId} · ${e.message}`));
    logger.warn(`Ledger not posted after QC · jobId=${jobId} · ${outcome.reason}`);
    return { posted: false, reason: outcome.reason };
  }
  // Posted now, or already posted by the CRM's completion: either way this job
  // is done with the ledger, so the cron must never pick it up again.
  await pool.query(
    'UPDATE tbl_job_verification SET posted_on = ?, post_error = NULL WHERE job_id = ? AND posted_on IS NULL',
    [now, jobId],
  );
  if (outcome.ledgers || outcome.jobTransaction) {
    await logSoft('logLedgerPosted', jobId, {}, { user_id: v.verified_by }, now);
  }
  return { posted: true, ledgers: Boolean(outcome.ledgers), reason: outcome.reason || null };
}

/*
 * The client's decision on QC. Guarded UPDATE on qc_status = 'pending': a second
 * click (or an approve racing the auto-pass) changes nothing and is told the
 * current state; an approve that finds the row already passed / auto-passed is
 * an idempotent 200, anything else is a 409.
 */
async function clientQcDecide(jobId, { outcome, contactId, note = null, actor = null }, { now = new Date() } = {}) {
  const status = outcome === 'passed' ? 'passed' : 'disputed';
  const [upd] = await pool.query(
    `UPDATE tbl_job_verification SET qc_status = ?, qc_on = ?, qc_by_contact_id = ?, qc_note = ?
      WHERE job_id = ? AND qc_status = 'pending'`,
    [status, now, contactId, note, jobId],
  );
  if (!upd.affectedRows) {
    const v = await readVerification(jobId);
    if (!v) throw httpError(409, 'This job is not waiting for your quality check', 'QC_NOT_PENDING');
    if (status === 'passed' && QC_DONE.has(v.qc_status)) return { ...shapeVerification(v), already: true };
    throw httpError(409, `Quality check is already ${v.qc_status || 'not started'} on this job`, 'QC_NOT_PENDING');
  }
  await logSoft('logClientQc', jobId, { outcome: status }, actor, now);
  const post = status === 'passed' ? await postAfterQc(jobId, { now }) : null;
  return { ...shapeVerification(await readVerification(jobId)), already: false, post };
}

/**
 * GET /client/qc — this client's jobs waiting on their QC, soonest auto-pass
 * first. `scopeIds` is routes/client hierarchyFilter's answer (undefined = the
 * whole client, an array = those booking SPOCs only).
 */
async function clientQcList({ clientId, scopeIds, limit = 50, offset = 0 }) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  const params = [clientId];
  let mine = '';
  if (Array.isArray(scopeIds)) {
    if (!scopeIds.length) return { items: [], total: 0 };
    mine = 'AND j.reporting_contact_id IN (?)';
    params.push(scopeIds);
  }
  const from = `FROM tbl_job_verification v
       JOIN tbl_job j ON j.job_id = v.job_id
      WHERE v.qc_status = 'pending' AND j.fk_client_id = ? ${mine}`;
  // Service and technician ride on the same row (two PK lookups per page row,
  // no extra round trip): a client judging QUALITY needs to know what was done
  // and by whom without opening every job. Same columns the ops desk's
  // jobHeader reads, so the two surfaces cannot name a job differently.
  const [rows] = await pool.query(
    `SELECT v.job_id, v.qc_due_on, v.verified_on, j.job_reference_id, j.client_ref_id,
            j.checkout_date_time, j.job_status, e.efr_name, sc.service_catg_name
       ${from.replace('JOIN tbl_job j ON j.job_id = v.job_id', `JOIN tbl_job j ON j.job_id = v.job_id
       LEFT JOIN tbl_easyfixer    e  ON e.efr_id          = j.fk_easyfixter_id
       LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = j.fk_service_catg_id`)}
      ORDER BY v.qc_due_on, v.job_id
      LIMIT ? OFFSET ?`,
    [...params, lim, off],
  );
  const [[count]] = await pool.query(`SELECT COUNT(*) AS n ${from}`, params);
  return {
    items: rows.map((r) => ({
      jobId: Number(r.job_id),
      reference: r.job_reference_id || r.client_ref_id || null,
      jobStatus: Number(r.job_status),
      service: r.service_catg_name || null,
      technician: r.efr_name || null,
      finishedOn: r.checkout_date_time || null,
      verifiedOn: r.verified_on || null,
      dueOn: r.qc_due_on || null,   // "auto-approves on <time>"
    })),
    total: Number(count && count.n) || 0,
  };
}

/*
 * THE 15-MINUTE CRON (server/scheduler.js 'job-qc-auto-pass').
 *   1. Auto-pass: pending rows whose window has lapsed → 'auto' (sheet 14:
 *      "auto-approves on their timer"). Oldest due first, ≤200.
 *   2. Post: QC-done rows with no posted_on — the ones just auto-passed, a
 *      client approve whose post failed or never ran (process death between the
 *      click and the post). Clean rows before errored ones, ≤200.
 * Sequential, one job at a time: every post takes THE ledger lock
 * (job-ledger.service.js), so parallelism would only queue on it. Idempotent:
 * a posted row is never selected, and a re-run of a half-done batch repeats
 * nothing. One replica at a time via a MySQL named lock.
 * Step 2's posted_on IS NULL filter is served by idx_jv_post (qc_status,
 * posted_on) in the Phase 3 migration, so it does not walk history.
 */
async function runQcAutoPass({ now = new Date(), batch = AUTO_PASS_BATCH } = {}) {
  try {
    const { acquired, result } = await withMysqlNamedLock(AUTO_PASS_LOCK, async () => {
      const tally = { due: 0, autoPassed: 0, postAttempts: 0, posted: 0, notPosted: 0 };
      const [due] = await pool.query(
        `SELECT job_id FROM tbl_job_verification
          WHERE qc_status = 'pending' AND qc_due_on <= ?
          ORDER BY qc_due_on LIMIT ?`,
        [now, batch],
      );
      tally.due = due.length;
      for (const { job_id: jobId } of due) {
        const [upd] = await pool.query(
          `UPDATE tbl_job_verification SET qc_status = 'auto', qc_on = ?
            WHERE job_id = ? AND qc_status = 'pending'`,
          [now, jobId],
        );
        if (!upd.affectedRows) continue;   // the client decided in between
        tally.autoPassed += 1;
        await logSoft('logClientQc', jobId, { outcome: 'auto' }, null, now);
      }
      const [toPost] = await pool.query(
        `SELECT job_id FROM tbl_job_verification
          WHERE qc_status IN ('passed', 'auto') AND posted_on IS NULL
          ORDER BY (post_error IS NOT NULL), qc_on, job_id LIMIT ?`,
        [batch],
      );
      for (const { job_id: jobId } of toPost) {
        tally.postAttempts += 1;
        const r = await postAfterQc(jobId, { now });
        if (r.posted) tally.posted += 1; else tally.notPosted += 1;
      }
      return tally;
    });
    if (!acquired) return { skipped: true, reason: 'another replica is running it' };
    return result;
  } catch (e) {
    // Deployed before its migration: say so instead of a stack every 15 min.
    if (e.code === 'ER_NO_SUCH_TABLE') return { skipped: true, reason: 'tbl_job_verification missing — apply migrations/2026-09-24-v3-phase3-tables.sql' };
    throw e;
  }
}

module.exports = {
  timingsForClient,
  readVerification,
  shapeVerification,
  verifyJob,
  postAfterQc,
  clientQcDecide,
  clientQcList,
  runQcAutoPass,
  AUTO_PASS_BATCH,
  DEFAULT_QC_HOURS,
  DEFAULT_CHECK_HOURS,
  PROP_QC_HOURS,
  PROP_CHECK_HOURS,
};
