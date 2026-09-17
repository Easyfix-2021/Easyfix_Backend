/*
 * "Save the reschedule remark the same way Add Remarks does" — VERIFIED, not
 * assumed, and pinned here so it stays true.
 *
 * THE QUESTION. PATCH /admin/jobs/:id/reschedule takes a reason and a remark.
 * Add Remarks (POST /admin/jobs/:id/comments) takes a reason and a remark. If
 * the two wrote tbl_job_comment differently, the job's history would render two
 * kinds of row for one kind of event, and every report keyed on
 * (comment_on, job_stage) would see them as different things.
 *
 * THE ANSWER, as of this file: they are already the same. Both go through the
 * ONE writer (job-comment.service.addComment), both send comment_on = 1, both
 * set commented_by to the acting CRM user, both pass the chosen reason as
 * enum_reason_id, and NEITHER sends job_stage — the CRM's AddRemarksDialog does
 * not send one either, so both rows store NULL there. Nothing was changed.
 *
 * THE ONE DIFFERENCE IS DELIBERATE AND IS NOT A DIVERGENCE: reschedule also
 * sets appointment_on to the new promised time. Add Remarks has no appointment
 * to record, so it leaves that column null. A remark about a job is not a
 * promise about a date; only one of these two events makes one.
 *
 * Non-destructive: fake pool, no real DB. Runner: `node --test`.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

// The reschedule tail fires a webhook + notifications; both are fail-soft and
// fed by this fake pool, but the kill switch is set so a run can never reach a
// real outbound endpoint.
process.env.WEBHOOK_OUTBOUND_ENABLED = 'false';

const EXISTING = {
  job_id: 42, fk_easyfixter_id: null, time_slot: null,
  scheduled_date_time: '2026-09-15 09:00:00', fk_scheduled_by: 9,
};

const fake = installFakePool([
  [/INFORMATION_SCHEMA/i, [{ n: 0 }]],
  [/SHOW COLUMNS FROM tbl_job_comment LIKE 'job_stage'/i, [{ Field: 'job_stage' }]],
  [/SHOW COLUMNS/i, []],
  [/SELECT job_id, fk_easyfixter_id, time_slot/i, [EXISTING]],
  [/INSERT INTO tbl_job_comment/i, () => ({ insertId: 555, affectedRows: 1 })],
  // addComment reads the row back and shapes it before returning; without this
  // the read comes back empty and the shaper throws on undefined.
  [/SELECT c\.comment_id AS id/i, [{ id: 555, job_id: 42, comments: 'x', comment_on: 1 }]],
  [/FROM tbl_job_offer/i, []],
  [/SELECT 1 FROM tbl_job_offer LIMIT 1/i, [{ 1: 1 }]],
  [/FROM easyfix_properties/i, []],
]);

const jobSvc = require('../services/job.service');
const jobComments = require('../services/job-comment.service');

const ACTOR = { user_id: 77, user_name: 'Sonam Patel' };
const REASON_ID = 296;              // a real action_type 29 row ("CX want to reschedule")
const NEW_TIME = '2026-09-20 14:30';
// reschedule() canonicalises the appointment to a full IST wall-clock literal
// before it reaches the comment — seconds included. That normalisation is the
// service's, not this test's, so the expectation follows it rather than the input.
const NEW_TIME_STORED = '2026-09-20 14:30:00';

beforeEach(() => { fake.reset(); });

const commentInsert = () => fake.calls.find((c) => /INSERT INTO tbl_job_comment/i.test(c.sql));

/* ── What reschedule hands the shared writer ─────────────────────────────── */

test('reschedule writes its remark through addComment, not a private INSERT', async () => {
  const real = jobComments.addComment;
  const calls = [];
  jobComments.addComment = async (jobId, payload) => { calls.push({ jobId, payload }); return { comment_id: 1 }; };
  try {
    await jobSvc.reschedule(42, {
      requestedDateTime: NEW_TIME, reasonId: REASON_ID, rescheduleReason: 'CX want to reschedule',
      remarks: 'Customer asked for Saturday',
    }, ACTOR);
  } finally {
    jobComments.addComment = real;
  }

  assert.equal(calls.length, 1, 'exactly one comment per reschedule');
  const { jobId, payload } = calls[0];
  assert.equal(jobId, 42);
  assert.equal(payload.comments, 'Customer asked for Saturday');
  assert.equal(payload.comment_on, 1, 'the same legacy stage code AddRemarksDialog sends');
  assert.equal(payload.commented_by, 77, 'the acting CRM user, not the technician');
  assert.equal(payload.enum_reason_id, REASON_ID, 'the reason the operator picked, verbatim');
  // The one deliberate addition: the new promise. Add Remarks has none.
  assert.equal(payload.appointment_on, NEW_TIME_STORED);
  // And the one thing it must NOT invent — see the parity test below.
  assert.equal(payload.job_stage, undefined, 'reschedule sends no job_stage, exactly as Add Remarks does not');
});

/* ── The rows the two paths actually store ───────────────────────────────── */

/* Run one payload through the REAL writer and return the stored row. */
async function storedRow(payload) {
  fake.reset();
  await jobComments.addComment(42, payload);
  const ins = commentInsert();
  assert.ok(ins, 'addComment must have written a row');
  const cols = /\(([^)]+)\)\s*VALUES/i.exec(ins.sql)[1].split(',').map((s) => s.trim());
  return Object.fromEntries(cols.map((c, i) => [c, ins.params[i]]));
}

test('the reschedule row and the Add Remarks row differ ONLY in appointment_on', async () => {
  /*
   * The reschedule payload is what the test above captured off the service.
   * The Add Remarks payload is what the route builds: the dialog's body
   * (comments + comment_on + the reason) plus commented_by from req.user —
   * routes/admin/jobs.js spreads `...req.body` and stamps the actor. The CRM's
   * AddRemarksDialog sends NO job_stage, which is why both rows store NULL.
   */
  const rescheduleRow = await storedRow({
    comments: 'Customer asked for Saturday',
    comment_on: 1,
    commented_by: ACTOR.user_id,
    appointment_on: NEW_TIME_STORED,
    enum_reason_id: REASON_ID,
  });
  const addRemarksRow = await storedRow({
    comments: 'Customer asked for Saturday',
    comment_on: 1,
    commented_by: ACTOR.user_id,
    enum_reason_id: REASON_ID,
  });

  const differing = Object.keys(rescheduleRow)
    .filter((k) => String(rescheduleRow[k]) !== String(addRemarksRow[k]));
  assert.deepEqual(differing, ['appointment_on'],
    'the two paths must store identical rows apart from the appointment reschedule promises');
  assert.equal(addRemarksRow.appointment_on, null, 'a remark makes no promise about a date');
  assert.equal(rescheduleRow.appointment_on, NEW_TIME_STORED);
});

test('both rows leave job_stage NULL — neither path supplies one', async () => {
  // Not an oversight to "fix": the CRM's own Add Remarks dialog sends no
  // job_stage, so stamping one on the reschedule side alone would make the two
  // rows differ on the very axis reports group by.
  const row = await storedRow({ comments: 'x', comment_on: 1, commented_by: 77, enum_reason_id: REASON_ID });
  assert.match(commentInsert().sql, /job_stage/, 'the column IS written when the deploy has it');
  assert.equal(row.job_stage, null, 'and the value is NULL, because nobody supplied one');
});

test('the reason id is stored as given — the action TYPE is only implied by it', async () => {
  /*
   * tbl_job_comment has no action-type column. A comment's action type is
   * reachable ONLY through enum_reason_id → action_taken_reason.action_type,
   * which is exactly why moving the reschedule dialog to bucket 29 needed no
   * schema change: the right reason id IS the record of the right bucket.
   */
  const row = await storedRow({ comments: 'x', comment_on: 1, commented_by: 77, enum_reason_id: REASON_ID });
  assert.equal(row.enum_reason_id, REASON_ID);
  const cols = Object.keys(row);
  assert.ok(!cols.some((c) => /action_type/i.test(c)),
    'no action-type column exists to write — the reason id carries it');
});
