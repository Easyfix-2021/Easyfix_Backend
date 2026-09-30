/*
 * "A reschedule is its own event, and it records the stage it happened in" —
 * VERIFIED, not assumed, and pinned here so it stays true.
 *
 * THIS FILE USED TO PIN THE OPPOSITE. Its original premise was that a
 * reschedule and an Add Remarks are one kind of event, so their tbl_job_comment
 * rows should be identical apart from appointment_on — same comment_on = 1,
 * neither supplying job_stage. That was reversed on 2026-09-30 per ops, and the
 * reasoning is worth keeping because it is the whole point of the file:
 *
 *   A reschedule MOVES THE APPOINTMENT. A remark says something about the job.
 *   Filing both under comment_on = 1 made every reschedule render as a generic
 *   "Scheduling" row in the CRM's Comments tab, indistinguishable from someone
 *   typing a note — so an operator scanning a job could not see that it had
 *   been rescheduled at all.
 *
 * Legacy had this right: 70,347 rows under comment_on = 21 ('ReScheduled' in
 * REMARKS_FOR), every one of them carrying appointment_on, stopping dead on
 * 2026-04-29 — the day the Node backend took over and started writing 1.
 * So 21 is a RESTORATION, not an invention.
 *
 * WHAT IS PINNED NOW:
 *   1. reschedule still goes through the ONE writer (job-comment.addComment) —
 *      never a private INSERT. Unchanged, and the reason this file exists.
 *   2. It sends comment_on = 21, so the row is identifiable as a reschedule.
 *   3. It sends job_stage = the job's status AT THE MOMENT OF THE RESCHEDULE,
 *      which is what answers "it was rescheduled while in Pending to Close".
 *   4. Everything ELSE still matches Add Remarks exactly (commented_by, the
 *      reason, the text) — the two paths must not drift on any other axis.
 *
 * THE ACCEPTED COST: reports grouping on comment_on = 1 no longer see
 * reschedules in that bucket. That is the intended behaviour change.
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
  // job_status 20 = Pending to Close on App — the bucket ops reported this
  // against, and what the audit row must now record as job_stage.
  job_id: 42, job_status: 20, fk_easyfixter_id: null, time_slot: null,
  scheduled_date_time: '2026-09-15 09:00:00', fk_scheduled_by: 9,
};

const fake = installFakePool([
  [/INFORMATION_SCHEMA/i, [{ n: 0 }]],
  [/SHOW COLUMNS FROM tbl_job_comment LIKE 'job_stage'/i, [{ Field: 'job_stage' }]],
  [/SHOW COLUMNS/i, []],
  // Tolerant of added columns on purpose: this matcher broke when job_status
  // joined the SELECT, and the failure mode was a silent 'job not found'
  // rather than anything pointing at the fake.
  [/SELECT job_id,.*fk_easyfixter_id, time_slot/i, [EXISTING]],
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
  assert.equal(payload.comment_on, 21, "the legacy 'ReScheduled' bucket — NOT the generic 1");
  assert.equal(payload.commented_by, 77, 'the acting CRM user, not the technician');
  assert.equal(payload.enum_reason_id, REASON_ID, 'the reason the operator picked, verbatim');
  // The one deliberate addition: the new promise. Add Remarks has none.
  assert.equal(payload.appointment_on, NEW_TIME_STORED);
  // The stage the job was rescheduled FROM. reschedule()'s UPDATE never
  // touches job_status, so reading it off `existing` before the write is
  // correct, not a race.
  assert.equal(payload.job_stage, 20, 'the status it was rescheduled FROM (Pending to Close on App)');
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

test('the two rows differ in EXACTLY the three ways a reschedule is different', async () => {
  /*
   * The reschedule payload is what the test above captured off the service.
   * The Add Remarks payload is what the route builds: the dialog's body
   * (comments + comment_on + the reason) plus commented_by from req.user —
   * routes/admin/jobs.js spreads `...req.body` and stamps the actor. The CRM's
   * AddRemarksDialog sends no job_stage and has no appointment, so that side is
   * unchanged by any of this.
   *
   * The POINT of asserting the difference set exactly, rather than just the
   * three fields: it still catches the two paths drifting apart on any OTHER
   * axis (the actor, the reason, the text), which was the original reason this
   * file was written and is still worth keeping.
   */
  const rescheduleRow = await storedRow({
    comments: 'Customer asked for Saturday',
    comment_on: 21,
    commented_by: ACTOR.user_id,
    appointment_on: NEW_TIME_STORED,
    enum_reason_id: REASON_ID,
    job_stage: 20,
  });
  const addRemarksRow = await storedRow({
    comments: 'Customer asked for Saturday',
    comment_on: 1,
    commented_by: ACTOR.user_id,
    enum_reason_id: REASON_ID,
  });

  const differing = Object.keys(rescheduleRow)
    .filter((k) => String(rescheduleRow[k]) !== String(addRemarksRow[k]))
    .sort();
  assert.deepEqual(differing, ['appointment_on', 'comment_on', 'job_stage'].sort(),
    'a reschedule differs by its bucket, its promise and its stage — and nothing else');

  assert.equal(rescheduleRow.comment_on, 21, "the 'ReScheduled' bucket");
  assert.equal(addRemarksRow.comment_on, 1, 'an ordinary remark stays in the generic bucket');
  assert.equal(rescheduleRow.appointment_on, NEW_TIME_STORED);
  assert.equal(addRemarksRow.appointment_on, null, 'a remark makes no promise about a date');
});

test('the reschedule row carries the stage; an Add Remarks row still does not', async () => {
  // The asymmetry is the feature. "Which stage was this rescheduled in" is a
  // question only the reschedule can answer — the CRM's Add Remarks dialog
  // sends no job_stage and is untouched by this change.
  const rescheduleRow = await storedRow({
    comments: 'x', comment_on: 21, commented_by: 77,
    enum_reason_id: REASON_ID, job_stage: 20,
  });
  assert.match(commentInsert().sql, /job_stage/, 'the column IS written when the deploy has it');
  assert.equal(rescheduleRow.job_stage, 20, 'the status the job was rescheduled from');

  const addRemarksRow = await storedRow({ comments: 'x', comment_on: 1, commented_by: 77, enum_reason_id: REASON_ID });
  assert.equal(addRemarksRow.job_stage, null, 'nobody supplied one, so it stays NULL');
});

test('addComment ACCEPTS 21 — without it the audit row vanishes silently', async () => {
  /*
   * The trap this guards. addComment rejects any comment_on outside STAGES with
   * a 400, and reschedule() calls it inside a non-fatal try/catch. So if 21 were
   * ever dropped from STAGES, nothing would throw, nothing would go red — the
   * reschedule would simply stop writing its comment row, which is the exact
   * defect this whole change set out to fix.
   */
  const { STAGES } = jobComments;
  assert.ok(STAGES[21], 'STAGES must know 21, or the non-fatal catch swallows every reschedule audit');
  const row = await storedRow({ comments: 'x', comment_on: 21, commented_by: 77 });
  assert.equal(row.comment_on, 21);
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
