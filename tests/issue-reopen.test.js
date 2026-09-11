/*
 * REOPEN for the in-app issue reporter — services/issue.service.js reopenIssue,
 * validators/issue.validator.js issueReopen, and PATCH /:issueId/reopen in
 * routes/admin/issues.js through the real router.
 *
 * Pinned: the READ rule decides who may reopen (reporter OR manager, a stranger
 * is 403); only a closed issue reopens (409 otherwise); the UPDATE is guarded on
 * status='closed' and clears the three close fields; the old close details
 * survive as a comment carrying the reason; the UPDATE and the comment share
 * ONE transaction, so a lost race or a failed comment rolls back; the route
 * carries no requireAction, so a reporter without the key gets through.
 *
 * No DB: the fake-pool seam answers every statement. The transaction is seen by
 * swapping getConnection for a connection that records begin / commit /
 * rollback / release and which channel (pool or conn) each statement used —
 * helpers/fake-pool's own connection makes those no-ops, and "the UPDATE ran"
 * is not "the UPDATE ran inside the transaction".
 *
 * POSITIVE CONTROL: every refusal below asserts the exact status (403 / 409),
 * never merely that it threw, because an unmatched fixture 404s. The first test
 * runs the same fixture to a successful reopen, so a stale fixture fails there
 * first.
 *
 * Runner: `node --test` (see npm test).
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { installFakePool } = require('./helpers/fake-pool');

const REPORTER = 41;
const STRANGER = 88;
const MANAGER  = 99;

const S = {};
function reset() {
  Object.assign(S, {
    status: 'closed',
    closeNote: 'Deployed a fix.',
    closerName: 'Priyanka',
    updateAffected: 1,
    commentFails: false,
    perms: [],          // what role.service reports for the route test's caller
    userId: REPORTER,
  });
}
reset();

function issueRow() {
  return {
    id: 7,
    title: 'Jobs list crashes on page 2',
    description: 'Clicking page 2 shows a white screen.',
    page_path: '/jobs',
    status: S.status,
    reported_by: REPORTER,
    created_on: '2026-09-10 11:04:00',
    closed_by: S.status === 'closed' ? MANAGER : null,
    closed_on: S.status === 'closed' ? '2026-09-10 15:20:00' : null,
    close_note: S.status === 'closed' ? S.closeNote : null,
    reported_by_name: 'Ravi',
    closed_by_name: S.status === 'closed' ? S.closerName : null,
  };
}

const fake = installFakePool([
  [/FROM tbl_crm_issue i\b[\s\S]*WHERE i\.id = \?/, () => [issueRow()]],
  [/UPDATE tbl_crm_issue SET status/, () => ({ affectedRows: S.updateAffected })],
  [/INSERT INTO tbl_crm_issue_comment/, () => {
    if (S.commentFails) throw new Error('ER_LOCK_WAIT_TIMEOUT');
    return { insertId: 501 };
  }],
]);

/* One ordered log across both channels: ['pool'|'conn', sql] for statements,
 * ['begin'] / ['commit'] / ['rollback'] / ['release'] for the connection. */
const log = [];
const db = require('../db');
const fakeQuery = db.pool.query;
db.pool.query = (sql, params) => { log.push(['pool', String(sql)]); return fakeQuery(sql, params); };
db.pool.getConnection = async () => ({
  query: (sql, params) => { log.push(['conn', String(sql)]); return fakeQuery(sql, params); },
  beginTransaction: async () => { log.push(['begin']); },
  commit: async () => { log.push(['commit']); },
  rollback: async () => { log.push(['rollback']); },
  release: () => { log.push(['release']); },
});

// Stub role.service BEFORE the service and requireAction capture it.
const roleSvcPath = require.resolve(path.join(__dirname, '..', 'services/role.service'));
require.cache[roleSvcPath] = {
  id: roleSvcPath, filename: roleSvcPath, loaded: true,
  exports: { getEffectivePermissions: async () => ({ menuIds: [], actionPermissions: S.perms }) },
};

const svc = require('../services/issue.service');
const { issueReopen } = require('../validators/issue.validator');

let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { user_id: S.userId, official_email: 'ravi@easyfix.in' }; next(); });
  app.use('/api/admin/issues', require('../routes/admin/issues'));
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/api/admin/issues`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  fake.restore();
});
beforeEach(() => { reset(); fake.reset(); log.length = 0; });

const kinds = () => log.map((e) => (e.length === 1 ? e[0] : `${e[0]}:${e[1].split(' ').slice(0, 3).join(' ')}`));
const updateCall = () => fake.calls.find((c) => /UPDATE tbl_crm_issue SET status/.test(c.sql));
const commentCall = () => fake.calls.find((c) => /INSERT INTO tbl_crm_issue_comment/.test(c.sql));
const writes = () => fake.calls.filter((c) => /^\s*(UPDATE|INSERT)/.test(c.sql));

async function rejectsWith(fn, status, label) {
  let caught = null;
  try { await fn(); } catch (e) { caught = e; }
  assert.ok(caught, `${label}: expected a rejection, got a successful return`);
  assert.equal(caught.status, status, `${label}: expected ${status}, got ${caught.status} (${caught.message})`);
  return caught;
}

// ─── POSITIVE CONTROL + THE WHOLE WRITE ──────────────────────────────────
test('reporter reopens own closed issue: guarded UPDATE + history comment, in one transaction', async () => {
  const r = await svc.reopenIssue(7, { reopenNote: 'Still blank on page 3.' }, { userId: REPORTER, canManage: false });
  assert.deepEqual(r, { id: 7, status: 'open' });

  const upd = updateCall();
  assert.ok(upd, 'expected the UPDATE to have been issued');
  assert.match(upd.sql, /closed_by = NULL, closed_on = NULL, close_note = NULL/, 'the single close slot is cleared');
  assert.match(upd.sql, /WHERE id = \? AND status = \? AND closed_on <=> \?$/, 'guarded on the status AND the close being undone');
  assert.deepEqual(upd.params, ['open', 7, 'closed', '2026-09-10 15:20:00'],
    'status -> open, only if it is still closed by the SAME close the comment describes');

  const ins = commentCall();
  assert.ok(ins, 'expected the history comment to have been inserted');
  const [issueId, text, by, createdOn] = ins.params;
  assert.equal(issueId, 7);
  assert.equal(by, REPORTER, 'the comment is written by the reopener');
  assert.ok(createdOn instanceof Date, 'created_on is a JS Date (IST verbatim), never NOW()');
  assert.ok(!/NOW\(\)/.test(ins.sql));
  assert.equal(text,
    'Reopened: Still blank on page 3.\n\nPreviously closed by Priyanka on 10-09-2026 15:20. Close note: Deployed a fix.');

  assert.deepEqual(kinds(), [
    'pool:SELECT i.id, i.title,',
    'begin',
    'conn:UPDATE tbl_crm_issue SET',
    'conn:INSERT INTO tbl_crm_issue_comment',
    'commit',
    'release',
  ], 'read on the pool, then both writes on the transaction connection, then commit');
});

test('a manager reopens an issue someone else reported; no close note, no "Close note:"', async () => {
  S.closeNote = null;
  const r = await svc.reopenIssue(7, { reopenNote: 'Reproduced again.' }, { userId: MANAGER, canManage: true });
  assert.equal(r.status, 'open');
  const [, text, by] = commentCall().params;
  assert.equal(by, MANAGER);
  assert.equal(text, 'Reopened: Reproduced again.\n\nPreviously closed by Priyanka on 10-09-2026 15:20.');
  assert.ok(kinds().includes('commit'));
});

test('worst case lengths: the close record the UPDATE erases always survives in full, within VARCHAR(2000)', async () => {
  S.closerName = 'N'.repeat(255);                     // tbl_user.user_name varchar(255)
  S.closeNote = 'C'.repeat(999) + 'Z';                // close_note varchar(1000); Z marks its END
  await svc.reopenIssue(7, { reopenNote: 'R'.repeat(600) }, { userId: REPORTER, canManage: false });
  const text = commentCall().params[1];
  assert.ok(text.length <= 2000, `fits the column, got ${text.length}`);
  assert.ok(text.startsWith('Reopened: ' + 'R'.repeat(600) + '\n\n'), 'the whole 600-char reason (the validator max) is kept');
  assert.ok(text.endsWith(' Close note: ' + 'C'.repeat(999) + 'Z'), 'the whole close note is kept');
  assert.ok(text.includes('Previously closed by ' + 'N'.repeat(255) + ' on 10-09-2026 15:20.'));

  // Past the validator (a direct service call): the REASON is cut, never the close record.
  reset(); fake.reset(); log.length = 0; S.closeNote = 'C'.repeat(999) + 'Z';
  await svc.reopenIssue(7, { reopenNote: 'R'.repeat(1990) }, { userId: REPORTER, canManage: false });
  const cut = commentCall().params[1];
  assert.equal(cut.length, 2000);
  assert.ok(cut.endsWith('C'.repeat(999) + 'Z'), 'the close note is intact');
});

test('a reopen racing a newer close (reopened + re-closed since the read) is 409, not an erased close', async () => {
  S.updateAffected = 0;                               // closed_on no longer matches what we read
  const e = await rejectsWith(
    () => svc.reopenIssue(7, { reopenNote: 'x' }, { userId: REPORTER, canManage: false }),
    409, 'stale close',
  );
  assert.match(e.message, /changed since you opened it/);
  assert.equal(updateCall().params[3], '2026-09-10 15:20:00', 'the guard carries the close we read');
  assert.equal(commentCall(), undefined);
});

// ─── REFUSALS — no write, no connection ──────────────────────────────────
test('a non-reporter without the key is refused (403) and nothing is written', async () => {
  await rejectsWith(
    () => svc.reopenIssue(7, { reopenNote: 'me too' }, { userId: STRANGER, canManage: false }),
    403, 'stranger reopening',
  );
  assert.equal(writes().length, 0);
  assert.ok(!kinds().includes('begin'), 'no transaction is even opened');
});

test('an open issue is 409 and nothing is written', async () => {
  S.status = 'open';
  const e = await rejectsWith(
    () => svc.reopenIssue(7, { reopenNote: 'x' }, { userId: REPORTER, canManage: false }),
    409, 'reopening an open issue',
  );
  assert.equal(e.message, 'Issue is already open');
  assert.equal(writes().length, 0);
  assert.ok(!kinds().includes('begin'));
});

// ─── THE TRANSACTION EARNS ITS PLACE ─────────────────────────────────────
test('lost race: the guarded UPDATE matches nothing -> 409, ROLLBACK, no comment', async () => {
  S.updateAffected = 0;
  await rejectsWith(
    () => svc.reopenIssue(7, { reopenNote: 'x' }, { userId: REPORTER, canManage: false }),
    409, 'second reopener',
  );
  assert.equal(commentCall(), undefined, 'the loser must not add a second history comment');
  const k = kinds();
  assert.ok(k.includes('rollback'), 'rolled back');
  assert.ok(!k.includes('commit'), 'never committed');
  assert.equal(k[k.length - 1], 'release', 'connection released');
});

test('a failed comment INSERT rolls the reopen back', async () => {
  S.commentFails = true;
  await assert.rejects(
    () => svc.reopenIssue(7, { reopenNote: 'x' }, { userId: REPORTER, canManage: false }),
    /ER_LOCK_WAIT_TIMEOUT/,
  );
  const k = kinds();
  assert.ok(k.indexOf('conn:UPDATE tbl_crm_issue SET') < k.indexOf('rollback'), 'the UPDATE is undone');
  assert.ok(!k.includes('commit'));
  assert.equal(k[k.length - 1], 'release');
});

// ─── VALIDATOR ───────────────────────────────────────────────────────────
test('issueReopen requires a non-blank reason, trimmed, within comment_text', () => {
  for (const body of [{}, { reopen_note: '' }, { reopen_note: '   ' }]) {
    const { error } = issueReopen.validate(body, { convert: true });
    assert.ok(error, `${JSON.stringify(body)} must be rejected`);
    assert.equal(error.details[0].message, 'Tell us what is still wrong');
  }
  assert.ok(issueReopen.validate({ reopen_note: 'x'.repeat(601) }).error, 'over 600 is rejected');
  assert.equal(issueReopen.validate({ reopen_note: 'x'.repeat(600) }).error, undefined, '600 is accepted');
  const { value, error } = issueReopen.validate({ reopen_note: '  still broken  ' }, { convert: true });
  assert.equal(error, undefined);
  assert.equal(value.reopen_note, 'still broken');
});

// ─── THROUGH THE REAL ROUTER ─────────────────────────────────────────────
const patch = async (p, body) => {
  const r = await fetch(base + p, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

test('route: a reporter holding NO action key reopens their own issue (no requireAction)', async () => {
  S.perms = [];
  const r = await patch('/7/reopen', { reopen_note: '  Still blank.  ' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data, { id: 7, status: 'open' });
  assert.match(commentCall().params[1], /^Reopened: Still blank\.\n/, 'the validated, trimmed reason reaches the service');
});

test('route: a stranger is 403 and a blank reason is 400, neither writes', async () => {
  S.userId = STRANGER;
  const denied = await patch('/7/reopen', { reopen_note: 'me too' });
  assert.equal(denied.status, 403);
  S.userId = REPORTER;
  const blank = await patch('/7/reopen', { reopen_note: '   ' });
  assert.equal(blank.status, 400);
  assert.equal(writes().length, 0);
});
