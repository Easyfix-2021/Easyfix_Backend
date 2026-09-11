'use strict';
/*
 * The CRM remarks table must read like the legacy one (EasyFix_CRM
 * src/main/webapp/pages/jobs/jobCommentList.vm, fed by the stored procedure
 * sp_ef_job_get_job_comments):
 *   Remarks For | Accountable | Reason | Remarks | Remark By | Date/Time
 *
 * The fake pool hands back the columns the joins produce for each kind of
 * writer; the legacy precedence that turns them into Remark By / Accountable
 * lives in shapeRow, which is what runs here. That the joins produce those
 * columns was proven separately against QA (legacy SP vs listComments, 4,370
 * rows, zero differences).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

let rows = [];
const fake = installFakePool([
  [/FROM tbl_job_comment c[\s\S]*WHERE c\.job_id = \?/, () => rows],
]);
const { pool } = require('../db');
const { listComments } = require('../services/job-comment.service');

test.after(async () => { fake.restore(); await pool.end(); });

// One raw row as the SELECT returns it; override per writer.
const raw = (o) => ({
  id: 1, job_id: 473627, comments: 'x', comment_on: 1, created_on: '2026-09-11 13:29:00',
  appointment_on: null, commented_by: null, enum_reason_id: null, efr_id: null,
  user_name: null, enum_desc: null, job_escalated_by: null, efr_name: null,
  reason_is_new: null, reason_user_type: null, ...o,
});
async function one(o) {
  rows = [raw(o)];
  const [r] = await listComments(473627);
  return r;
}

test('an escalation row (no commented_by) resolves the name legacy shows, not "Unknown"', async () => {
  // Shape of every QA comment_on=19 row: commented_by NULL, author NAME in job_escalated_by.
  const r = await one({ comment_on: 19, job_escalated_by: 'vijaya lakshmi', enum_reason_id: 312,
    enum_desc: 'Raise an Issue', reason_is_new: 1, reason_user_type: 'Customer' });
  assert.equal(r.remark_by, 'vijaya lakshmi');
  assert.equal(r.remarks_for, 'Escalated');
  assert.equal(r.accountable, 'Customer');
  assert.equal(r.enum_desc, 'Raise an Issue');
  assert.equal(r.user_name, null, 'user_name keeps its old meaning (tbl_user only)');
});

test('a CRM row resolves the tbl_user name, and it wins over job_escalated_by as in legacy', async () => {
  assert.equal((await one({ comment_on: 16, commented_by: 42, user_name: 'Neeraj', efr_id: 0 })).remark_by, 'Neeraj');
  assert.equal((await one({ commented_by: 42, user_name: 'Neeraj', job_escalated_by: 'Someone' })).remark_by, 'Neeraj');
  // vm:38 tests empName != '' — an empty name falls through to the escalated name.
  assert.equal((await one({ commented_by: 42, user_name: '', job_escalated_by: 'Pradeep' })).remark_by, 'Pradeep');
});

test('technician rows: the legacy app via tbl_user, the Node app via efr_id', async () => {
  // Legacy app wrote the tech's tbl_user id (role 19) into commented_by.
  assert.equal((await one({ comment_on: 9, commented_by: 7001, user_name: 'Zabi Ulla Khan P' })).remark_by,
    'Zabi Ulla Khan P');
  // Node writers leave commented_by NULL and put the tech in efr_id.
  const node = await one({ comment_on: 3, efr_id: 5226, efr_name: 'V Mahesh' });
  assert.equal(node.remark_by, 'V Mahesh');
  assert.equal(node.remarks_for, 'CheckOut');
});

test('a deleted CRM user is never replaced by the technician on the job', async () => {
  const r = await one({ comment_on: 2, commented_by: 99, user_name: null, efr_id: 5226, efr_name: 'V Mahesh' });
  assert.equal(r.remark_by, null);
});

test('a row with no resolvable writer yields null, not a crash', async () => {
  assert.equal((await one({})).remark_by, null);
  assert.equal((await one({ user_name: '', job_escalated_by: '', efr_name: '' })).remark_by, null);
});

test('Remarks For: every legacy label, blank for codes legacy never labelled', async () => {
  const LEGACY = { // jobCommentList.vm:15-28
    1: 'Scheduling', 2: 'CheckIn', 3: 'CheckOut', 4: 'Feedback', 6: 'Canceling', 8: 'TX Reschedule',
    9: 'TX cancelled', 15: 'Approval', 16: 'Unconfirmed', 17: 'Inquiry', 18: 'TX Rejected',
    19: 'Escalated', 20: 'Re-Opened Job', 21: 'ReScheduled',
  };
  for (const [code, label] of Object.entries(LEGACY)) {
    assert.equal((await one({ comment_on: Number(code) })).remarks_for, label, `comment_on=${code}`);
  }
  for (const code of [null, 0, 5, 7, 10]) {
    assert.equal((await one({ comment_on: code })).remarks_for, null, `comment_on=${code}`);
  }
});

test('Accountable: the reason\'s party only when the reason is_new = 1', async () => {
  for (const party of ['Easyfix', 'Customer', 'Client', 'Technician']) {
    assert.equal((await one({ reason_is_new: 1, reason_user_type: party })).accountable, party);
  }
  assert.equal((await one({ reason_is_new: true, reason_user_type: 'Client' })).accountable, 'Client',
    'a TINYINT(1)-typed deploy hands back a boolean');
  assert.equal((await one({ reason_is_new: 0, reason_user_type: 'Easyfix' })).accountable, null);
  assert.equal((await one({ reason_is_new: 1, reason_user_type: null })).accountable, null);
  assert.equal((await one({})).accountable, null, 'no reason at all');
});

test('every pre-existing field is still returned, in SQL order', async () => {
  rows = [raw({ id: 2, created_on: '2026-09-11 13:29:00' }), raw({ id: 1, created_on: '2026-09-11 13:28:00' })];
  const out = await listComments(473627);
  assert.deepEqual(out.map((r) => r.id), [2, 1]);
  for (const k of ['id', 'job_id', 'comments', 'comment_on', 'stage', 'created_on', 'appointment_on',
    'commented_by', 'user_name', 'efr_id', 'enum_reason_id', 'enum_desc']) {
    assert.ok(k in out[0], `${k} must survive`);
  }
});

test('the SELECT is parameterised, all-LEFT, and joins the columns legacy reads', async () => {
  fake.reset();
  rows = [];
  await listComments(473627);
  const call = fake.calls.find((c) => /FROM tbl_job_comment c/.test(c.sql));
  assert.ok(call, 'the listing query must have run');
  assert.deepEqual(call.params, [473627]);
  assert.doesNotMatch(call.sql, /473627/, 'the job id travels as a parameter');
  const joins = call.sql.match(/\bJOIN\b/g).length;
  assert.equal(call.sql.match(/\bLEFT JOIN\b/g).length, joins, 'a missing name must never drop a row');
  for (const re of [
    /LEFT JOIN tbl_user u ON u\.user_id = c\.commented_by/,
    /LEFT JOIN action_taken_reason atr ON atr\.id = c\.enum_reason_id/,
    /LEFT JOIN user_type ut ON ut\.id = atr\.user_type/,
    /LEFT JOIN tbl_easyfixer e ON e\.efr_id = c\.efr_id/,
    /c\.job_escalated_by/, /atr\.is_new AS reason_is_new/, /ut\.type AS reason_user_type/, /e\.efr_name/,
    /ORDER BY c\.created_on DESC, c\.comment_id DESC/,
  ]) assert.match(call.sql, re);
});
