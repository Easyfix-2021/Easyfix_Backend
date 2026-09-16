'use strict';
/*
 * Issue screenshot retention — closed + 1 month (owner, 2026-09-16).
 *
 * The owner's decision was "manual cleanup for now, later a cron to clean it
 * for issues closed + 1 month". This is that cron. What matters here is not
 * that it deletes, but WHAT it refuses to delete and in WHICH ORDER, because
 * both failure modes are silent and irreversible:
 *   · an OPEN issue's screenshots must survive however long triage takes —
 *     which is the whole reason this is a job and not an S3 lifecycle rule;
 *   · the S3 object goes BEFORE its row, or a crash between the two strands
 *     bytes nothing points at any more.
 *
 * Non-destructive: fake pool + a stubbed S3, no real bucket, no real DB.
 * Runner: `node --test`.
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const s3 = require('../utils/s3-storage');
const cron = require('../services/issue-screenshot-cleanup-cron');

/* A fake runner: records every statement and answers the candidate SELECT. */
function makeRunner(rows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (/SELECT m\.id, m\.s3_key/.test(sql)) return [rows, []];
      if (/DELETE FROM tbl_crm_issue_image/.test(sql)) return [{ affectedRows: params[0].length }, []];
      return [[], []];
    },
  };
}

const realDelete = s3.deleteObject;
const deleted = [];
let deleteResult = () => ({ deleted: true });
beforeEach(() => {
  deleted.length = 0;
  deleteResult = () => ({ deleted: true });
  s3.deleteObject = async (key) => { deleted.push(key); return deleteResult(key); };
});
afterEach(() => { s3.deleteObject = realDelete; });

const IMG = (id, key) => ({ id, s3_key: key, issue_id: 7 });

// ─── The candidate set ──────────────────────────────────────────────────

test('only CLOSED issues, and only those closed longer ago than the retention', () => {
  const sql = cron._internals.CANDIDATE_SQL.replace(/\s+/g, ' ');
  assert.match(sql, /i\.status = 'closed'/, 'an open issue keeps its screenshots however long triage takes');
  assert.match(sql, /i\.closed_on IS NOT NULL/,
    'status and closed_on are both required — a row with one but not the other is a data fault to skip, not to guess at');
  // Clock rule: closed_on is bound as new Date() by issue.service.js's close
  // path, so the cutoff binds the app clock (a `?`) instead of reading NOW().
  assert.match(sql, /i\.closed_on < \(\? - INTERVAL \? MONTH\)/);
  assert.equal(cron.RETENTION_MONTHS, 1, "the owner's retention: closed + 1 month");
  // Bounded, so a first run against a bucket accumulating since 2026-09-10
  // drains over hours instead of one tick issuing thousands of deletes.
  assert.match(sql, /LIMIT \?/);
  assert.equal(cron.BATCH_LIMIT, 200);
});

test('it sweeps by ISSUE, so a comment\'s attachments are collected too', () => {
  // The join is issue → image with NO comment_id predicate. That is what makes
  // comment attachments (which carry the same issue_id) expire with the report
  // without this file knowing comments can have images at all.
  const sql = cron._internals.CANDIDATE_SQL.replace(/\s+/g, ' ');
  assert.match(sql, /FROM tbl_crm_issue_image m JOIN tbl_crm_issue i ON i\.id = m\.issue_id/);
  assert.doesNotMatch(sql, /comment_id/,
    'filtering to comment_id IS NULL here would leave every reply\'s screenshots behind forever');
});

// ─── The order, which is the part that cannot be got wrong ──────────────

test('the S3 object is deleted BEFORE its row', async () => {
  const runner = makeRunner([IMG(1, 'Issues/a'), IMG(2, 'Issues/b')]);
  const r = await cron.sweep(runner);
  assert.deepEqual(deleted, ['Issues/a', 'Issues/b']);
  const delAt = runner.calls.findIndex((c) => /DELETE FROM tbl_crm_issue_image/.test(c.sql));
  assert.ok(delAt > -1, 'the rows must be removed too — a row whose object is gone makes a purged issue look broken');
  assert.deepEqual(runner.calls[delAt].params[0], [1, 2]);
  assert.deepEqual(r, { eligible: 2, deleted: 2, failed: 0, rowsRemoved: 2 });
});

test('a row whose S3 delete FAILED keeps its row, so the next run retries it', async () => {
  deleteResult = (key) => (key === 'Issues/b' ? { deleted: false, reason: 'error' } : { deleted: true });
  const runner = makeRunner([IMG(1, 'Issues/a'), IMG(2, 'Issues/b'), IMG(3, 'Issues/c')]);
  const r = await cron.sweep(runner);
  const del = runner.calls.find((c) => /DELETE FROM tbl_crm_issue_image/.test(c.sql));
  assert.deepEqual(del.params[0], [1, 3], 'only the two that actually left S3');
  assert.equal(r.failed, 1);
  assert.equal(r.deleted, 2);
});

test('rows that never had an object still stop being counted as screenshots', async () => {
  // 'not-s3' is a legacy bare filename, 'empty-key' a row with nothing in it.
  // Neither has bytes to remove, but both would otherwise inflate
  // screenshot_count forever.
  deleteResult = () => ({ deleted: false, reason: 'not-s3' });
  const runner = makeRunner([IMG(1, 'legacy.png')]);
  const r = await cron.sweep(runner);
  assert.equal(r.deleted, 1);
  assert.equal(r.failed, 0);
});

test('with S3 unconfigured it deletes NOTHING — not even the rows', async () => {
  /*
   * The objects may exist in a bucket this environment simply cannot reach
   * (local dev against a shared DB). Dropping the rows here would orphan them
   * in the real bucket with nothing left pointing at them.
   */
  deleteResult = () => ({ deleted: false, reason: 'disabled' });
  const runner = makeRunner([IMG(1, 'Issues/a'), IMG(2, 'Issues/b')]);
  const r = await cron.sweep(runner);
  assert.equal(r.skipped, true);
  assert.equal(r.rowsRemoved, 0);
  assert.ok(!runner.calls.some((c) => /DELETE FROM/.test(c.sql)), 'no row may be removed');
});

test('an empty candidate set issues no delete at all', async () => {
  const runner = makeRunner([]);
  const r = await cron.sweep(runner);
  // dryRun rides on every sweep result since the Trigger-Now dry run was added,
  // so the empty-set shape carries it too — false here, this being a real sweep.
  assert.deepEqual(r, { eligible: 0, deleted: 0, failed: 0, rowsRemoved: 0, dryRun: false });
  assert.equal(deleted.length, 0);
  assert.ok(!runner.calls.some((c) => /DELETE FROM/.test(c.sql)));
});

// ─── The gate ───────────────────────────────────────────────────────────

test('it is OFF unless the property says exactly true — it deletes irreversibly', async () => {
  const props = require('../services/properties.service');
  const real = props.getProperty;
  try {
    for (const v of [undefined, null, '', 'false', 'TRUE ', '1', 'yes']) {
      props.getProperty = () => v;
      assert.equal(cron.cleanupEnabled(), false, `${JSON.stringify(v)} must not enable a delete job`);
    }
    props.getProperty = () => 'true';
    assert.equal(cron.cleanupEnabled(), true);
    props.getProperty = () => 'TRUE';
    assert.equal(cron.cleanupEnabled(), true, 'case-insensitive, like every other cron flag');
  } finally {
    props.getProperty = real;
  }
});

test('runCleanup short-circuits when disabled — no query, no delete', async () => {
  const props = require('../services/properties.service');
  const real = props.getProperty;
  props.getProperty = () => 'false';
  try {
    const r = await cron.runCleanup();
    assert.equal(r.skipped, true);
    assert.equal(r.deleted, 0);
    assert.equal(deleted.length, 0);
  } finally {
    props.getProperty = real;
  }
});

// ─── Dry run: Trigger Now on a disabled job ─────────────────────────────

test('a MANUAL trigger while disabled is a DRY RUN — it reads, deletes nothing', async () => {
  /*
   * The owner asked to watch one dry run before switching this on. A Trigger
   * Now that merely answered "skipped" would show nothing at all, so a manual
   * trigger on a DISABLED job reports what it WOULD delete.
   */
  const props = require('../services/properties.service');
  const real = props.getProperty;
  props.getProperty = () => 'false';
  const runner = makeRunner([IMG(1, 'Issues/a'), IMG(2, 'Issues/b')]);
  try {
    const r = await cron.sweep(runner, { dryRun: true });
    assert.equal(r.dryRun, true);
    assert.equal(r.eligible, 2, 'it must report the real candidate count');
    assert.equal(r.deleted, 0);
    assert.equal(r.rowsRemoved, 0);
    assert.equal(deleted.length, 0, 'not one S3 object may be touched');
    assert.ok(!runner.calls.some((c) => /DELETE FROM/.test(c.sql)), 'and not one row');
  } finally {
    props.getProperty = real;
  }
});

test('the dry run returns BEFORE the first delete, not inside the loop', () => {
  /*
   * Structural, because it is the property that makes the dry run safe under
   * every future edit: there is no interleaving in which a dryRun sweep can
   * reach s3.deleteObject, because it has already returned.
   */
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'issue-screenshot-cleanup-cron.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const at = src.indexOf('async function sweep(');
  const fn = src.slice(at, src.indexOf('\nasync function runCleanup', at));
  const guardAt = fn.indexOf('if (dryRun)');
  const deleteAt = fn.indexOf('s3.deleteObject');
  assert.ok(guardAt > -1 && deleteAt > -1, 'positive control: both must be locatable');
  assert.ok(guardAt < deleteAt, 'the dry-run return must precede the delete loop');
});

test('the CRON TICK stays a true no-op when disabled — it does not even read', async () => {
  // A disabled job must not do work on a schedule, not even read work. Only an
  // operator pressing Trigger Now gets the dry run.
  const props = require('../services/properties.service');
  const real = props.getProperty;
  props.getProperty = () => 'false';
  try {
    const r = await cron.runCleanup();               // no { manual: true }
    assert.equal(r.skipped, true);
    assert.equal(r.dryRun, undefined, 'a scheduled tick is not a dry run');
    assert.equal(deleted.length, 0);
  } finally {
    props.getProperty = real;
  }
});

test('the scheduler passes the trigger kind, and the runner asks for it', () => {
  const sched = fs.readFileSync(path.join(__dirname, '..', 'server', 'scheduler.js'), 'utf8');
  // invokeJob must hand the kind down, or `manual` is always false and the dry
  // run is unreachable from the UI.
  assert.match(sched, /const result = await job\.runner\(kind\);/);
  assert.match(sched, /runner: async \(kind\) => \{[\s\S]{0,400}?runCleanup\(\{ manual: kind === 'manual' \}\)/);
});

// ─── Registration + the seed ────────────────────────────────────────────

test('the scheduler registers it default-OFF, behind this exact flag', () => {
  // Source-scanned: requiring server/scheduler.js runs its registrations
  // against a live database, which is why every cron test here reads it as text.
  const sched = fs.readFileSync(path.join(__dirname, '..', 'server', 'scheduler.js'), 'utf8');
  assert.match(sched, /id: 'issue-screenshot-cleanup',/);
  assert.match(sched, /issueScreenshotCleanup\.cleanupEnabled\(\)/);
  assert.match(sched, /issueScreenshotCleanupJob\.skipReason = /,
    'default-OFF: a job that deletes must not start because a deploy carried it somewhere');
  assert.match(sched, /timezone: TZ/);
  assert.equal(cron.FLAG, 'issue.screenshot_cleanup.enabled');
});

test('the flag is seeded false, in the shape verify:migrations can probe', () => {
  const { readMigration } = require('./helpers/migration-file');
  const sql = readMigration('2026-09-16-seed-issue-screenshot-cleanup-flag.sql');
  assert.match(sql, /'issue\.screenshot_cleanup\.enabled', 'false'/, 'seeded OFF');
  // NOT EXISTS rather than ON DUPLICATE KEY: equally idempotent, and the only
  // form scripts/migration-status.js can read a property key out of.
  assert.match(sql, /WHERE NOT EXISTS \(SELECT 1 FROM easyfix_properties WHERE property_key = 'issue\.screenshot_cleanup\.enabled'\)/);
  const { artifactsOf } = require('../scripts/migration-status.js');
  assert.deepEqual(artifactsOf(sql), [{ kind: 'property', property: 'issue.screenshot_cleanup.enabled' }],
    'a seed the tooling cannot probe reports UNKNOWN forever');
});
