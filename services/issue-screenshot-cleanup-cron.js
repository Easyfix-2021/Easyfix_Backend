const { pool } = require('../db');
const logger = require('../logger');
const s3 = require('../utils/s3-storage');
/*
 * Called through the MODULE (properties.getProperty), not destructured. A
 * destructured binding is captured at require time and cannot be stubbed, which
 * made the gate's own test pass in both directions for the wrong reason — the
 * real getProperty returns undefined with no DB, so "disabled" was never
 * actually asserted. This is a delete job; its off-switch has to be provable.
 */
const properties = require('./properties.service');

/*
 * ─── ISSUE SCREENSHOT RETENTION — CLOSED + 1 MONTH ────────────────────────
 *
 * Screenshots attached to a bug report are pictures of whatever was on the
 * reporter's screen: other people's customers, their addresses, their phone
 * numbers. They accumulated in S3 under `Issues/` forever, and nothing deleted
 * them. v2 multiplied the volume by up to five (five attachments per report),
 * and the Capture Screen / auto-capture work on 2026-09-16 adds one more per
 * report opened.
 *
 * ─── WHY THIS IS A CRON AND NOT AN S3 LIFECYCLE RULE ──────────────────────
 *
 * migrations/2026-09-10-crm-issue-reporter-v2.sql says the objects "are
 * expired by lifecycle policy on the Issues/ prefix". No such policy was ever
 * created, and — more importantly — a lifecycle rule COULD NOT implement the
 * retention the owner asked for. A lifecycle rule expires an object by ITS OWN
 * AGE, which would delete the screenshots of an issue still open after thirty
 * days: precisely the ones triage needs most. The retention key here is
 * tbl_crm_issue.closed_on, a column S3 cannot see. Hence a job that joins.
 *
 * ─── WHAT IT DELETES ──────────────────────────────────────────────────────
 *
 * Every tbl_crm_issue_image row whose parent issue is CLOSED and was closed
 * more than RETENTION_MONTHS ago — the report's own attachments AND its
 * comments'. Comment attachments carry the same issue_id (see
 * migrations/2026-09-16-crm-issue-comment-images.sql for why one table holds
 * both), so sweeping by issue collects them without this file knowing that
 * comments can have images at all.
 *
 * It does NOT touch tbl_crm_issue or tbl_crm_issue_comment. The report, its
 * thread and its close note are the record of what happened and are small
 * text; only the bytes with someone else's customer in them expire.
 *
 * ─── ORDER MATTERS: S3 FIRST, ROW SECOND ──────────────────────────────────
 *
 * If the row went first and the S3 delete then failed, the object would be
 * orphaned forever with nothing left pointing at it — unreachable and
 * undeletable except by hand. Doing it the other way round, a failure between
 * the two leaves a row whose object is already gone, and the NEXT run deletes
 * the object again (S3 DELETE is idempotent — a missing key succeeds) and then
 * the row. Every interleaving converges; none strands bytes.
 *
 * ─── AND THE ROW GOES TOO, NOT JUST THE OBJECT ────────────────────────────
 *
 * getIssueDetail drops a key that fails to sign and the queue renders "Showing
 * 2 Of 3" from that gap. Leaving rows behind for deleted objects would make
 * every PURGED issue look like a BROKEN one, with no way to tell them apart.
 *
 * ─── TWO REPLICAS ARE SAFE, SO THERE IS NO LOCK ───────────────────────────
 *
 * scheduler.js guards re-entrancy within ONE process but has no cross-replica
 * leader election, and this backend can run more than one container. That is
 * fine here and deliberately not worked around: both halves of the work are
 * idempotent (a missing S3 key deletes successfully; `DELETE … WHERE id IN (…)`
 * on already-deleted rows affects zero). Two replicas racing the same batch
 * duplicate effort for one tick and converge on the same state. A named lock
 * would be new machinery guarding nothing.
 */

/** Opt-in, default OFF. This job DELETES: it must not start running merely
 *  because a deploy carried the code to an environment nobody expected it on. */
const FLAG = 'issue.screenshot_cleanup.enabled';

/** The owner's retention: one month after the issue was CLOSED. */
const RETENTION_MONTHS = 1;

/*
 * Rows per run. Bounds a first run against a bucket that has been accumulating
 * since 2026-09-10 — the job is hourly, so a backlog drains over a few hours
 * instead of one tick issuing thousands of S3 deletes and holding a pool
 * connection open across all of them.
 */
const BATCH_LIMIT = 200;

function cleanupEnabled() {
  return String(properties.getProperty(FLAG) || '').toLowerCase() === 'true';
}

/*
 * The candidate set. `i.status = 'closed'` AND a non-null closed_on are both
 * required rather than either alone: status is the flag ops sets, closed_on is
 * the date the retention is measured from, and a row with one but not the other
 * is a data fault this job must skip rather than guess at.
 *
 * NOW() is correct here despite the project's usual "never NOW()" rule: that
 * rule is about STORING a timestamp (where NOW() reads the container clock and
 * mixes timezones into a column). This is a COMPARISON between two values that
 * are already in the same column's timezone, and there is nothing to write.
 */
const CANDIDATE_SQL = `
  SELECT m.id, m.s3_key, m.issue_id
    FROM tbl_crm_issue_image m
    JOIN tbl_crm_issue i ON i.id = m.issue_id
   WHERE i.status = 'closed'
     AND i.closed_on IS NOT NULL
     AND i.closed_on < (NOW() - INTERVAL ? MONTH)
   ORDER BY m.id
   LIMIT ?
`;

async function sweep(runner = pool, { dryRun = false } = {}) {
  const [rows] = await runner.query(CANDIDATE_SQL, [RETENTION_MONTHS, BATCH_LIMIT]);
  if (!rows.length) return { eligible: 0, deleted: 0, failed: 0, rowsRemoved: 0, dryRun };

  /*
   * DRY RUN — counts the candidate set and touches nothing. The one honest way
   * to answer "what would this delete on Production?" before switching a
   * destructive job on. It returns BEFORE the first s3.deleteObject rather than
   * branching inside the loop, so there is no ordering in which a dry run can
   * reach a delete.
   */
  if (dryRun) {
    logger.info('Issue screenshot cleanup DRY RUN · would delete ' + rows.length
      + ' image(s) across ' + new Set(rows.map((r) => r.issue_id)).size + ' closed issue(s)');
    return { eligible: rows.length, deleted: 0, failed: 0, rowsRemoved: 0, dryRun: true };
  }

  const purged = [];
  let failed = 0;
  for (const row of rows) {
    // deleteObject never throws — it answers { deleted, reason } and already
    // handles S3-disabled, an empty key, and a legacy bare filename.
    const res = await s3.deleteObject(row.s3_key);
    if (res.deleted || res.reason === 'not-s3' || res.reason === 'empty-key') {
      // 'not-s3' / 'empty-key' are rows that never had an object to begin with;
      // they still have to stop being counted as a screenshot.
      purged.push(row.id);
    } else if (res.reason === 'disabled') {
      // S3 unconfigured (local dev). Delete nothing, including the rows — the
      // objects may exist in the real bucket this environment cannot reach.
      logger.info('Issue screenshot cleanup skipped · S3 is not configured');
      return { eligible: rows.length, deleted: 0, failed: 0, rowsRemoved: 0, skipped: true, reason: 'S3 disabled' };
    } else {
      failed += 1;
    }
  }

  let rowsRemoved = 0;
  if (purged.length) {
    const [r] = await runner.query('DELETE FROM tbl_crm_issue_image WHERE id IN (?)', [purged]);
    rowsRemoved = r.affectedRows || 0;
  }
  return { eligible: rows.length, deleted: purged.length, failed, rowsRemoved };
}

/*
 * `manual` is true when an operator pressed Trigger Now on the Scheduled Jobs
 * page, false for the cron's own tick (server/scheduler.js passes the kind).
 *
 * WHILE THE JOB IS DISABLED, A MANUAL TRIGGER IS A DRY RUN. That is the whole
 * point of the distinction: the owner asked to watch one dry run before
 * switching this on, and a Trigger Now that merely answered "skipped" would
 * show nothing at all. The cron TICK stays a true no-op when disabled — a
 * disabled job must not do work on a schedule, not even read work.
 */
async function runCleanup({ manual = false } = {}) {
  if (!cleanupEnabled()) {
    if (manual) {
      logger.info(`Issue screenshot cleanup DRY RUN — ${FLAG} is not 'true', so nothing will be deleted`);
      return sweep(pool, { dryRun: true });
    }
    logger.info(`Issue screenshot cleanup skipped — ${FLAG} is not 'true'`);
    return { skipped: true, reason: `${FLAG} not true`, eligible: 0, deleted: 0, failed: 0, rowsRemoved: 0 };
  }
  return sweep(pool);
}

module.exports = {
  FLAG,
  RETENTION_MONTHS,
  BATCH_LIMIT,
  cleanupEnabled,
  runCleanup,
  // Exported for tests: sweep takes an injected runner so a fake pool can drive
  // it without monkeypatching require('../db').
  sweep,
  _internals: { CANDIDATE_SQL },
};
