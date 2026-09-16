'use strict';
/*
 * Screenshots on issue COMMENTS (owner, 2026-09-16: "users should be able to
 * add images in comments as well").
 *
 * ONE TABLE, NOT TWO. tbl_crm_issue_image gained a NULLABLE comment_id rather
 * than growing a parallel tbl_crm_issue_comment_image. Every consequence of
 * that choice is a thing this file has to pin, because each one fails SILENTLY:
 *
 *   · a reader that forgets `comment_id IS NULL` shows a reply's attachments in
 *     the REPORT's gallery and inflates screenshot_count with images nobody
 *     attached to the report;
 *   · a comment's rows must carry issue_id as WELL as comment_id, or the
 *     closed+1mo cleanup cron (which sweeps by issue) never collects them;
 *   · the presign path must be the same one, or a thread of ten comments ends
 *     up with a different TTL or a different failure behaviour than the report
 *     above it.
 *
 * Non-destructive: fake pool, no real DB, no S3. Runner: `node --test`.
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installFakePool } = require('./helpers/fake-pool');

const ISSUE = {
  id: 7, title: 'T', description: 'D', page_path: '/jobs', status: 'open',
  reported_by: 41, created_on: '2026-09-16 09:00:00', closed_by: null, closed_on: null, close_note: null,
};
const scenario = { imageRows: [], commentRows: [] };

const fake = installFakePool([
  [/INFORMATION_SCHEMA/i, [{ n: 0 }]],
  [/SHOW COLUMNS/i, []],
  // The real load joins tbl_user twice; match on the join, not a guessed WHERE.
  [/FROM tbl_crm_issue i\s+LEFT JOIN tbl_user ru/i, [ISSUE]],
  [/FROM tbl_crm_issue_comment c/i, () => scenario.commentRows],
  [/SELECT issue_id, s3_key FROM tbl_crm_issue_image/i, () => scenario.imageRows.filter((r) => r.comment_id == null)],
  [/SELECT comment_id, s3_key FROM tbl_crm_issue_image/i, () => scenario.imageRows.filter((r) => r.comment_id != null)],
  [/INSERT INTO tbl_crm_issue_comment/i, () => ({ insertId: 55 })],
  [/INSERT INTO tbl_crm_issue_image/i, () => ({ insertId: 900 })],
]);

const svc = require('../services/issue.service');
const ACTOR = { userId: 41, canManage: false };

beforeEach(() => { fake.reset(); scenario.imageRows = []; scenario.commentRows = []; });

const q = (re) => fake.calls.filter((c) => re.test(c.sql));

// ─── The split: whose screenshots are whose ─────────────────────────────

test("the report's gallery reads ONLY rows with no comment_id", () => {
  /*
   * The single most important line in the change. Without it every reply's
   * attachments join the report's own gallery, and screenshot_count starts
   * counting images the reporter never attached to the report.
   */
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'issue.service.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  assert.match(src, /SELECT issue_id, s3_key FROM tbl_crm_issue_image WHERE issue_id IN \(\?\) AND comment_id IS NULL/);
  // …and the queue's count, which is a separate query and would otherwise lie.
  assert.match(src, /SELECT COUNT\(\*\) FROM tbl_crm_issue_image\s+m WHERE m\.issue_id = i\.id AND m\.comment_id IS NULL/);
});

test("a comment's gallery reads ONLY rows that carry its comment_id", () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'issue.service.js'), 'utf8');
  assert.match(src, /SELECT comment_id, s3_key FROM tbl_crm_issue_image WHERE comment_id IN \(\?\)/);
});

// ─── The write ──────────────────────────────────────────────────────────

test('a comment attachment carries BOTH parents — issue_id and comment_id', async () => {
  await svc.addComment(7, { commentText: 'looks like this', screenshotKeys: ['Issues/a', 'Issues/b'] }, ACTOR);
  const ins = q(/INSERT INTO tbl_crm_issue_image/)[0];
  assert.ok(ins, 'the image rows must be written');
  assert.match(ins.sql, /\(issue_id, comment_id, s3_key, sort_order, created_on\)/);
  /*
   * issue_id is what the cleanup cron sweeps by — it joins image → issue and
   * knows nothing about comments. A row with only comment_id would never
   * expire.
   */
  assert.deepEqual(ins.params[0].map((row) => [row[0], row[1], row[2], row[3]]), [
    [7, 55, 'Issues/a', 0],
    [7, 55, 'Issues/b', 1],
  ]);
});

test('sort_order is the order they were sent — it is what the gallery renders', async () => {
  await svc.addComment(7, { commentText: 'x', screenshotKeys: ['a', 'b', 'c'] }, ACTOR);
  const rows = q(/INSERT INTO tbl_crm_issue_image/)[0].params[0];
  assert.deepEqual(rows.map((r) => r[3]), [0, 1, 2]);
});

test('a comment with no attachments writes no image row at all', async () => {
  await svc.addComment(7, { commentText: 'just words' }, ACTOR);
  assert.equal(q(/INSERT INTO tbl_crm_issue_image/).length, 0);
  assert.equal(q(/INSERT INTO tbl_crm_issue_comment/).length, 1, 'but the comment is still written');
});

test('the comment is written even when its images would fail — text is the point', () => {
  /*
   * Deliberately NOT in one transaction, for the same reason createIssue is
   * not: a comment whose image rows failed is still a reply worth having, and
   * losing the text because the second screenshot's row failed is strictly
   * worse for the person trying to tell us something is broken.
   */
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'issue.service.js'), 'utf8');
  const at = src.indexOf('async function addComment(');
  const fn = src.slice(at, src.indexOf('\n}\n', at));
  assert.ok(at > -1, 'positive control: addComment must be locatable');
  assert.doesNotMatch(fn, /beginTransaction|getConnection/,
    'wrapping the two writes in a transaction would throw the reply away with its images');
});

// ─── The read ───────────────────────────────────────────────────────────

test('every comment comes back with its own screenshot_urls array', async () => {
  scenario.commentRows = [{ id: 55, comment_text: 'a', commented_by: 41, created_on: 'x' },
    { id: 56, comment_text: 'b', commented_by: 41, created_on: 'y' }];
  scenario.imageRows = [
    { issue_id: 7, comment_id: null, s3_key: 'Issues/report' },
    { comment_id: 55, s3_key: 'Issues/c55' },
  ];
  const detail = await svc.getIssueDetail(7, ACTOR);
  assert.equal(detail.comments.length, 2);
  // S3 is not configured under test, so presigning yields [] — the SHAPE is
  // what matters here: every comment carries the key, empty or not, so the FE
  // never has to branch on its absence.
  for (const c of detail.comments) {
    assert.ok(Array.isArray(c.screenshot_urls), `comment ${c.id} must carry an array`);
    assert.equal(typeof c.screenshot_count, 'number');
  }
  assert.equal(detail.comments.find((c) => c.id === 55).screenshot_count, 1);
  assert.equal(detail.comments.find((c) => c.id === 56).screenshot_count, 0);
});

test('the thread costs ONE image query, not one per comment', async () => {
  scenario.commentRows = Array.from({ length: 6 }, (_, i) => ({
    id: 60 + i, comment_text: 't', commented_by: 41, created_on: 'x',
  }));
  await svc.getIssueDetail(7, ACTOR);
  assert.equal(q(/SELECT comment_id, s3_key FROM tbl_crm_issue_image/).length, 1,
    'an N+1 here would be a query per comment on the screen that always renders all of them');
});

// ─── The migration ──────────────────────────────────────────────────────

test('the column is NULLABLE, so every pre-existing row keeps its meaning', () => {
  const { readMigration } = require('./helpers/migration-file');
  const sql = readMigration('2026-09-16-crm-issue-comment-images.sql');
  assert.match(sql, /ADD COLUMN comment_id INT NULL DEFAULT NULL/,
    'NOT NULL would need a backfill and would break every existing report screenshot');
  assert.match(sql, /ADD KEY idx_crm_issue_image_comment \(comment_id\)/);
  // Cascades from the COMMENT as well as from the issue.
  assert.match(sql, /FOREIGN KEY \(comment_id\) REFERENCES tbl_crm_issue_comment \(id\) ON DELETE CASCADE/);
});

// ─── The route ──────────────────────────────────────────────────────────

test('the comment route accepts the same field, cap and uploader as create', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin', 'issues.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const at = src.indexOf("'/:issueId/comments'");
  assert.ok(at > -1, 'positive control: the comment route must be locatable');
  const route = src.slice(at, src.indexOf('});', at));
  assert.match(route, /upload\.array\('screenshot', MAX_SCREENSHOTS\)/,
    "singular 'screenshot' — a plural field name arrives as MulterError: Unexpected field");
  assert.match(route, /uploadScreenshots\(req\.files, 'Issue comment'\)/,
    'the SAME uploader as create, so MIME and the no-S3 fallback cannot answer differently');
  // Exactly one uploader in the file: two copies is how the two surfaces drift.
  assert.equal((src.match(/async function uploadScreenshots\(/g) || []).length, 1);
  assert.equal((src.match(/uploadScreenshots\(req\.files/g) || []).length, 2, 'create + comment, both through it');
});
