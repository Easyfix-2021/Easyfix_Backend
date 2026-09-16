/*
 * The issue reporter's page_path keeps the QUERY STRING (owner, 2026-09-16).
 *
 * It used to strip it — a privacy call, so the issue queue could not double as
 * a log of which jobs a user viewed. The owner reversed that: the query is the
 * reproduction (which tab, which modal, which job). This pins the new rule and
 * the two things that did NOT change: the fragment still goes, and the value
 * still fits the VARCHAR(255) column.
 *
 * Runner: `node --test`.
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');
const { readMigration } = require('./helpers/migration-file');
const { issueCreate, PAGE_PATH_MAX } = require('../validators/issue.validator');

/*
 * The insert must survive EITHER deploy order (this table has been bitten by
 * the other order before). Simulate a column still at 255: the fake answers
 * 1406 ER_DATA_TOO_LONG to any insert whose page_path is longer than that.
 */
const scenario = { columnWidth: 2048, failWith: null };
const fake = installFakePool([
  [/INFORMATION_SCHEMA/i, [{ n: 0 }]],
  [/SHOW COLUMNS/i, []],
  [/INSERT INTO tbl_crm_issue /, (sql, params) => {
    if (scenario.failWith) throw scenario.failWith;
    const pagePath = params[2];
    if (pagePath && pagePath.length > scenario.columnWidth) {
      const e = new Error("Data too long for column 'page_path' at row 1");
      e.code = 'ER_DATA_TOO_LONG'; e.errno = 1406;
      throw e;
    }
    return { insertId: 7 };
  }],
]);
const svc = require('../services/issue.service');
const inserts = () => fake.calls.filter((c) => /INSERT INTO tbl_crm_issue /.test(c.sql));
beforeEach(() => { fake.reset(); scenario.columnWidth = 2048; scenario.failWith = null; });
const LONG = '/jobs?clientId=' + Array.from({ length: 120 }, (_, i) => 1000 + i).join(',');

const body = (page_path) => ({ title: 'Reassign modal', description: 'Cancel button missing', page_path });

test('the query string survives — it is the reproduction', () => {
  const { error, value } = issueCreate.validate(body('/my-orders?tab=pending-start&action=reassign&jobId=509493'));
  assert.equal(error, undefined);
  assert.equal(value.page_path, '/my-orders?tab=pending-start&action=reassign&jobId=509493');
});

test('the fragment is still dropped, even one carrying its own query', () => {
  const { value } = issueCreate.validate(body('/jobs?tab=open#/detail?jobId=1'));
  assert.equal(value.page_path, '/jobs?tab=open');
});

test('a filter URL past the old 255 now survives whole — the column is 2048', () => {
  const long = '/jobs?clientId=' + Array.from({ length: 120 }, (_, i) => 1000 + i).join(',');
  assert.ok(long.length > 255 && long.length <= PAGE_PATH_MAX, 'positive control: past the old cap, inside the new one');
  const { error, value } = issueCreate.validate(body(long));
  assert.equal(error, undefined);
  assert.equal(value.page_path, long, 'nothing is cut any more below the column width');
});

test('the value is capped at the widened column width', () => {
  // Read through the helper, which finds the file in migrations/ OR executed/
  // — a path pinned to one directory breaks the day the file moves.
  const sql = readMigration('2026-09-16-widen-crm-issue-page-path.sql');
  assert.match(sql, /ALTER TABLE tbl_crm_issue MODIFY page_path VARCHAR\(2048\) NULL DEFAULT NULL;/);
  assert.equal(PAGE_PATH_MAX, 2048, 'the validator cap mirrors the migration');
  const huge = '/jobs?cityId=' + Array.from({ length: 600 }, (_, i) => 10000 + i).join(',');
  assert.ok(huge.length > PAGE_PATH_MAX, 'positive control: the input must exceed the cap');
  // Joi's max() refuses before the custom slice can run — a URL the column
  // cannot hold is a 400 with a field name, not a silent cut. Either answer is
  // acceptable here; what must not happen is a value longer than the column.
  const { error, value } = issueCreate.validate(body(huge));
  if (!error) assert.ok(value.page_path.length <= PAGE_PATH_MAX);
});

test('an empty page_path is still accepted (multipart posts "" for an untouched field)', () => {
  const { error, value } = issueCreate.validate(body(''));
  assert.equal(error, undefined);
  assert.equal(value.page_path, '');
});

// ─── createIssue on a column that has not been widened yet ───────────────

test('on the widened column a long page_path lands whole, first try', async () => {
  await svc.createIssue({ title: 'T', description: 'D', pagePath: LONG, screenshotKeys: [], userId: 41 });
  const ins = inserts();
  assert.equal(ins.length, 1, 'no retry when the column takes it');
  assert.equal(ins[0].params[2], LONG);
});

test('on a 255 column the insert is retried at 255 — old truncation, never a 500', async () => {
  scenario.columnWidth = 255;
  const r = await svc.createIssue({ title: 'T', description: 'D', pagePath: LONG, screenshotKeys: [], userId: 41 });
  assert.equal(r.id, 7, 'the report is created');
  const ins = inserts();
  assert.equal(ins.length, 2, 'exactly one retry');
  assert.equal(ins[0].params[2], LONG, 'the first attempt sends the full value');
  assert.equal(ins[1].params[2].length, 255, 'the retry is cut to the legacy width');
  assert.ok(LONG.startsWith(ins[1].params[2]));
});

test('a short page_path on a 255 column never retries', async () => {
  scenario.columnWidth = 255;
  await svc.createIssue({ title: 'T', description: 'D', pagePath: '/jobs?tab=open', screenshotKeys: [], userId: 41 });
  assert.equal(inserts().length, 1);
});

test('an unrelated insert failure still propagates — the retry is for 1406 only', async () => {
  const deadlock = new Error('deadlock'); deadlock.code = 'ER_LOCK_DEADLOCK';
  scenario.failWith = deadlock;
  await assert.rejects(
    () => svc.createIssue({ title: 'T', description: 'D', pagePath: LONG, screenshotKeys: [], userId: 41 }),
    (e) => e.code === 'ER_LOCK_DEADLOCK',
  );
  assert.equal(inserts().length, 1, 'no retry on a different error');
});
