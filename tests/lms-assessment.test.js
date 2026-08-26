const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * LMS assessments — the properties that are expensive to get wrong.
 *
 *   1. SCORING IS SERVER-SIDE. The request carries answers; the score is
 *      computed here. A client-supplied score would make the whole assessment
 *      decorative, and this endpoint is what stands between an untrained
 *      technician and being marked trained.
 *   2. easyfixer_courses.score holds the BEST attempt, never the latest. It is
 *      what the Training Report and the client-facing completion evidence
 *      render, and a curiosity retake must not erase a pass.
 *   3. ATTEMPTS ARE FINITE, and two rapid submits must not collide on
 *      uq_lms_attempt. The app retries requests whose response was lost.
 *   4. is_correct NEVER REACHES A TECHNICIAN. Not "is removed before it does" —
 *      is never selected. A client holding the answer key can score itself,
 *      which is precisely what scoring server-side exists to prevent.
 *   5. AN ID IN A URL IS NOT AN ENTITLEMENT. Every technician-facing read and
 *      write is scoped to the caller's own assignments, and the course an
 *      attempt is recorded against is resolved from them rather than taken
 *      from the body.
 *   6. FINISHING THE LAST ITEM ADVANCES THE TECHNICIAN, whatever KIND that
 *      item is. A document must settle completion exactly as a passing
 *      attempt and a 100% video ping do.
 */

let scenario = [];
const fake = installFakePool([[/.*/, (sql, params) => {
  for (const [re, rows] of scenario) {
    if (re.test(sql)) return typeof rows === 'function' ? rows(sql, params) : rows;
  }
  return [];
}]]);
const lms = require('../services/lms.service');

after(() => fake.restore());

const ASSESSMENT = /SELECT id, pass_percent, max_attempts\s+FROM lms_assessment/i;
const ANSWER_KEY = /o\.is_correct = 1/i;
const TALLY = /COALESCE\(MAX\(attempt_no\), 0\) AS last/i;
const INSERT_ATTEMPT = /INSERT INTO lms_assessment_attempt/i;
const SCORE_UPDATE = /UPDATE easyfixer_courses SET score/i;
const STAMP = /UPDATE easyfixer_courses ec\s+SET ec\.completion_date/i;
const TRAINING_COMPLETE = /FROM\s+easyfixer_courses ec\s+JOIN\s+lms_content/i;
// "which of the caller's assigned courses hold this item" — the scope gate in
// front of every technician-facing read and write.
const ASSIGNED = /SELECT DISTINCT lc\.course_id/i;
const ACK_LOOKUP = /FROM lms_content lc\s+JOIN easyfixer_courses ec/i;

// A three-question paper whose correct options are 11, 21 and 31.
const THREE_QUESTIONS = [
  { question_id: 1, option_id: 11 },
  { question_id: 2, option_id: 21 },
  { question_id: 3, option_id: 31 },
];

function baseScenario({
  passPercent = 70, maxAttempts = 3, used = 0, last = 0, key = THREE_QUESTIONS,
  assignedCourses = [4],
} = {}) {
  return [
    [ASSIGNED, assignedCourses.map((course_id) => ({ course_id }))],
    [ASSESSMENT, [{ id: 5, pass_percent: passPercent, max_attempts: maxAttempts }]],
    [ANSWER_KEY, key],
    [TALLY, [{ n: used, last }]],
    [INSERT_ATTEMPT, { affectedRows: 1, insertId: 900 }],
    [SCORE_UPDATE, { affectedRows: 1 }],
    [STAMP, { affectedRows: 0 }],
    [TRAINING_COMPLETE, [{ required: 4, done: 1 }]],
  ];
}

const call = (re) => fake.calls.find((c) => re.test(c.sql));
const callsMatching = (re) => fake.calls.filter((c) => re.test(c.sql));

// ─── Scoring ─────────────────────────────────────────────────────────

test('the score is computed from the answers, on the server', async () => {
  fake.reset();
  scenario = baseScenario();
  const out = await lms.submitAssessment(8379, 5, {
    courseId: 4,
    answers: [
      { questionId: 1, optionId: 11 },  // right
      { questionId: 2, optionId: 22 },  // wrong
      { questionId: 3, optionId: 31 },  // right
    ],
  });
  assert.equal(out.scorePct, 66.67, '2 of 3, to two decimals — the precision score_pct stores');
  assert.equal(out.passed, false, '66.67 is below the 70% pass mark');
  assert.equal(out.passPercent, 70);
});

test('a perfect paper passes and every answer is checked against the stored key', async () => {
  fake.reset();
  scenario = baseScenario();
  const out = await lms.submitAssessment(8379, 5, {
    courseId: 4,
    answers: THREE_QUESTIONS.map((q) => ({ questionId: q.question_id, optionId: q.option_id })),
  });
  assert.equal(out.scorePct, 100);
  assert.equal(out.passed, true);
});

test('a score sent by the client is ignored — only the answers count', async () => {
  fake.reset();
  scenario = baseScenario();
  const out = await lms.submitAssessment(8379, 5, {
    courseId: 4,
    // What a tampered client would send: everything wrong, and a 100 alongside.
    scorePct: 100,
    passed: true,
    score: 100,
    answers: [
      { questionId: 1, optionId: 99 },
      { questionId: 2, optionId: 99 },
      { questionId: 3, optionId: 99 },
    ],
  });
  assert.equal(out.scorePct, 0, 'every answer was wrong, whatever the body claimed');
  assert.equal(out.passed, false);
  const insert = call(INSERT_ATTEMPT);
  assert.equal(insert.params[4], 0, 'the STORED score is the computed one');
  assert.equal(insert.params[5], 0, 'and the stored pass flag with it');
});

test('unanswered questions count against the score rather than shrinking the paper', async () => {
  fake.reset();
  scenario = baseScenario();
  const out = await lms.submitAssessment(8379, 5, {
    courseId: 4,
    answers: [{ questionId: 1, optionId: 11 }],
  });
  assert.equal(out.scorePct, 33.33,
    'the denominator is the paper, not the number of answers submitted');
});

test('an assessment with no questions is refused, never scored as 0 or as 100', async () => {
  fake.reset();
  scenario = baseScenario({ key: [] });
  await assert.rejects(
    () => lms.submitAssessment(8379, 5, { courseId: 4, answers: [{ questionId: 1, optionId: 11 }] }),
    (e) => e.status === 409,
  );
  assert.equal(call(INSERT_ATTEMPT), undefined, 'and nothing is recorded');
});

// ─── Best score, never latest ────────────────────────────────────────

test('easyfixer_courses.score keeps the BEST attempt, enforced in SQL', async () => {
  fake.reset();
  scenario = baseScenario();
  // A retake that went badly — 1 of 3 — after an earlier good result.
  await lms.submitAssessment(8379, 5, {
    courseId: 4,
    answers: [{ questionId: 1, optionId: 11 }],
  });
  const update = call(SCORE_UPDATE);
  assert.ok(update, 'the course score is written');
  assert.match(update.sql, /GREATEST\(COALESCE\(score, 0\), \?\)/,
    'a read-then-write would let a failed retake overwrite a pass under concurrency');
  assert.equal(update.params[0], 33.33, 'the new score is offered, not imposed');
  assert.equal(update.params[2], 8379);
  assert.equal(update.params[3], 4);
});

test('with no courseId the ONE assigned course holding the paper is used', async () => {
  fake.reset();
  scenario = baseScenario();
  const out = await lms.submitAssessment(8379, 5, { answers: [{ questionId: 1, optionId: 11 }] });
  assert.equal(out.scorePct, 33.33, 'the attempt is still scored and recorded');
  assert.equal(call(SCORE_UPDATE).params[3], 4,
    'there is exactly one candidate, so the app not naming it is not ambiguous');
  assert.equal(call(INSERT_ATTEMPT).params[2], 4, 'and the attempt records the same course');
});

test('with the paper in TWO assigned courses and no hint, neither is credited', async () => {
  fake.reset();
  scenario = baseScenario({ assignedCourses: [4, 6] });
  await lms.submitAssessment(8379, 5, { answers: [{ questionId: 1, optionId: 11 }] });
  assert.equal(call(SCORE_UPDATE), undefined,
    'only the app knows which course it was working through — guessing would '
    + 'write a score against a course the technician was not taking');
  assert.equal(call(INSERT_ATTEMPT).params[2], null, 'the attempt records no course rather than the wrong one');
});

// ─── Attempt allocation and exhaustion ───────────────────────────────

test('attempts are refused once the ceiling is reached', async () => {
  fake.reset();
  scenario = baseScenario({ used: 3, last: 3, maxAttempts: 3 });
  await assert.rejects(
    () => lms.submitAssessment(8379, 5, { courseId: 4, answers: [{ questionId: 1, optionId: 11 }] }),
    (e) => e.status === 409 && /no attempts remaining/i.test(e.message),
  );
  assert.equal(call(INSERT_ATTEMPT), undefined, 'a refused submit records nothing');
  assert.equal(call(SCORE_UPDATE), undefined, 'and cannot move the course score');
});

test('the ceiling counts attempts, not the highest attempt number', async () => {
  fake.reset();
  // Two rows recorded, numbered 1 and 2 — a third is still owed.
  scenario = baseScenario({ used: 2, last: 2, maxAttempts: 3 });
  const out = await lms.submitAssessment(8379, 5, { courseId: 4, answers: [] });
  assert.equal(out.attemptNo, 3, 'the next number follows MAX(attempt_no)');
  assert.equal(out.attemptsRemaining, 0, 'and that was the last one');
});

test('two rapid submits do not collide on uq_lms_attempt', async () => {
  fake.reset();
  let inserts = 0;
  // One attempt on record. A concurrent submit is about to claim attempt 2.
  let taken = 1;
  scenario = [
    [ASSIGNED, [{ course_id: 4 }]],
    [ASSESSMENT, [{ id: 5, pass_percent: 70, max_attempts: 3 }]],
    [ANSWER_KEY, THREE_QUESTIONS],
    // The re-read after the duplicate sees the row the other writer committed.
    [TALLY, () => [{ n: taken, last: taken }]],
    [INSERT_ATTEMPT, (sql, params) => {
      inserts += 1;
      if (Number(params[3]) === 2) {
        // The other writer got there first and its row is now visible.
        taken = 2;
        const e = new Error("Duplicate entry '8379-5-2' for key 'uq_lms_attempt'");
        e.code = 'ER_DUP_ENTRY';
        throw e;
      }
      return { affectedRows: 1, insertId: 901 };
    }],
    [SCORE_UPDATE, { affectedRows: 1 }],
    [STAMP, { affectedRows: 0 }],
    [TRAINING_COMPLETE, [{ required: 4, done: 1 }]],
  ];
  const out = await lms.submitAssessment(8379, 5, {
    courseId: 4,
    answers: [{ questionId: 1, optionId: 11 }],
  });
  assert.equal(inserts, 2, 'the duplicate is retried, not surfaced as a 500');
  assert.equal(out.attemptNo, 3, 'the retry takes the next free number');
  const numbers = callsMatching(INSERT_ATTEMPT).map((c) => c.params[3]);
  assert.deepEqual(numbers, [2, 3]);
});

test('a duplicate that means the ceiling was reached refuses instead of retrying forever', async () => {
  fake.reset();
  scenario = [
    [ASSIGNED, [{ course_id: 4 }]],
    [ASSESSMENT, [{ id: 5, pass_percent: 70, max_attempts: 2 }]],
    [ANSWER_KEY, THREE_QUESTIONS],
    // First read: one attempt used. After the duplicate, the concurrent writer's
    // row makes it two — which is the ceiling.
    [TALLY, (() => { let n = 1; return () => [{ n, last: n++ }]; })()],
    [INSERT_ATTEMPT, () => {
      const e = new Error('Duplicate entry');
      e.code = 'ER_DUP_ENTRY';
      throw e;
    }],
  ];
  await assert.rejects(
    () => lms.submitAssessment(8379, 5, { courseId: 4, answers: [] }),
    (e) => e.status === 409,
  );
});

test('a non-duplicate database error is not swallowed by the retry loop', async () => {
  fake.reset();
  // The failing INSERT goes FIRST — the matcher takes the first regex that
  // hits, so appending it would be shadowed by baseScenario's happy path.
  scenario = [[INSERT_ATTEMPT, () => { throw new Error('table is read only'); }], ...baseScenario()];
  await assert.rejects(
    () => lms.submitAssessment(8379, 5, { courseId: 4, answers: [] }),
    /table is read only/,
  );
  assert.equal(callsMatching(INSERT_ATTEMPT).length, 1, 'and is not retried');
});

// ─── The answer key never leaves the server ──────────────────────────

/*
 * The fake deliberately returns is_correct on the technician-facing read too.
 * A projection that spread the row (`{ ...r }`) would pass a test whose fixture
 * omitted the column, and ship the answer key in production where the column
 * is really there. So the fixture HAS it, and the assertion is that the
 * response does not.
 */
const TECH_QUESTIONS = [
  { question_id: 1, question_text: 'Which wire is live?', option_id: 11, option_text: 'Red', is_correct: 1 },
  { question_id: 1, question_text: 'Which wire is live?', option_id: 12, option_text: 'Black', is_correct: 0 },
  { question_id: 2, question_text: 'Isolate before?', option_id: 21, option_text: 'Always', is_correct: 1 },
  { question_id: 2, question_text: 'Isolate before?', option_id: 22, option_text: 'Never', is_correct: 0 },
];

async function techPaper() {
  fake.reset();
  scenario = [
    [ASSIGNED, [{ course_id: 4 }]],
    [/SELECT id, title, description, pass_percent, max_attempts\s+FROM lms_assessment/i,
      [{ id: 5, title: 'Electrical Safety', description: null, pass_percent: 70, max_attempts: 3 }]],
    [/FROM lms_question q\s+JOIN lms_question_option o/i, TECH_QUESTIONS],
    [/COUNT\(\*\) AS n FROM lms_assessment_attempt/i, [{ n: 1 }]],
  ];
  return lms.getAssessmentForTech(8379, 5);
}

test('the technician payload contains no is_correct, anywhere, at any depth', async () => {
  const paper = await techPaper();
  const serialised = JSON.stringify(paper);
  assert.doesNotMatch(serialised, /is_correct/i,
    'the answer key must not be serialised to a client that is about to be scored');
  assert.doesNotMatch(serialised, /"correct"/i);
  // And prove the payload is not empty — an assertion that passes because
  // nothing was returned would be worthless.
  assert.equal(paper.questions.length, 2);
  assert.equal(paper.questions[0].options.length, 2);
  assert.deepEqual(Object.keys(paper.questions[0].options[0]).sort(), ['id', 'option_text']);
});

test('the technician query never even SELECTs is_correct', async () => {
  await techPaper();
  const questions = call(/FROM lms_question q/i);
  assert.ok(questions, 'the paper was read');
  assert.doesNotMatch(questions.sql, /is_correct/i,
    'not selected-then-deleted — never selected, so no later edit can leak it');
});

test('the technician payload still carries what the app needs to render', async () => {
  const paper = await techPaper();
  assert.equal(paper.passPercent, 70);
  assert.equal(paper.maxAttempts, 3);
  assert.equal(paper.attemptsUsed, 1, 'so the app can say "attempt 2 of 3"');
});

/*
 * The counter-test. Without it, the two above could pass because
 * getAssessmentForTech returns nothing useful at all — this pins that the
 * answer key IS available on the admin projection, so the two really are
 * different reads rather than one read that lost a column.
 */
test('the ADMIN projection does include is_correct — the two are different reads', async () => {
  fake.reset();
  scenario = [
    [/SELECT id, title, description, pass_percent, max_attempts, status/i,
      [{ id: 5, title: 'Electrical Safety', pass_percent: 70, max_attempts: 3, status: 1 }]],
    [/FROM lms_question q\s+LEFT JOIN lms_question_option o/i, TECH_QUESTIONS.map((r) => ({
      ...r, question_sequence: 1, option_sequence: 1,
    }))],
  ];
  const paper = await lms.getAssessmentForAdmin(5);
  assert.equal(paper.questions[0].options[0].is_correct, true);
  assert.equal(paper.questions[0].options[1].is_correct, false);
});

// ─── Document acknowledgement ────────────────────────────────────────

test('only a document can be acknowledged', async () => {
  fake.reset();
  scenario = [[ACK_LOOKUP, [{ id: 7, kind: 'video', course_id: 4 }]]];
  await assert.rejects(
    () => lms.ackDocument(8379, 7),
    (e) => e.status === 400,
  );
  assert.equal(call(/INSERT INTO lms_document_ack/i), undefined);
});

test('acknowledging twice is acknowledging once, and keeps the first timestamp', async () => {
  fake.reset();
  scenario = [
    [ACK_LOOKUP, [{ id: 7, kind: 'document', course_id: 4 }]],
    [/INSERT INTO lms_document_ack/i, { affectedRows: 1 }],
    [STAMP, { affectedRows: 0 }],
    [TRAINING_COMPLETE, [{ required: 4, done: 1 }]],
  ];
  const out = await lms.ackDocument(8379, 7);
  assert.deepEqual(out, { ok: true });
  const insert = call(/INSERT INTO lms_document_ack/i);
  assert.match(insert.sql, /ON DUPLICATE KEY UPDATE content_id = VALUES\(content_id\)/,
    'the upsert re-states the row rather than moving acknowledged_at — the fact '
    + 'recorded is when they read it, not when they last tapped');
});

test('a content item of a course the technician was never assigned cannot be acknowledged', async () => {
  fake.reset();
  // The JOIN finds nothing: the item exists, but not in any of HIS courses.
  scenario = [[ACK_LOOKUP, []]];
  await assert.rejects(
    () => lms.ackDocument(8379, 7),
    (e) => e.status === 404,
  );
  assert.match(call(ACK_LOOKUP).sql, /ec\.easyfixer_id = \?/,
    'scoped by the JOIN, not by a check afterwards');
  assert.equal(call(/INSERT INTO lms_document_ack/i), undefined,
    'an id in a URL is a request, not an entitlement');
});

/*
 * THE BUG THIS PINS. ackDocument stamped per-course completion and stopped —
 * it never asked whether ALL training was now complete, so a technician whose
 * LAST outstanding item happened to be a PPT had his course marked complete
 * and then sat in TRAINING_PENDING forever. The kind of content someone
 * finishes last must not decide whether they are advanced.
 */
test('acknowledging the LAST item advances the lifecycle, exactly as a video does', async () => {
  fake.reset();
  let advanced = 0;
  const lifecycle = require('../services/easyfixer-lifecycle.service');
  const original = lifecycle.finalizeTrainingCompletion;
  lifecycle.finalizeTrainingCompletion = async () => { advanced += 1; return { changed: true, transitionedFrom: 'TRAINING_PENDING' }; };
  scenario = [
    [ACK_LOOKUP, [{ id: 7, kind: 'document', course_id: 4 }]],
    [/INSERT INTO lms_document_ack/i, { affectedRows: 1 }],
    [STAMP, { affectedRows: 1 }],
    [TRAINING_COMPLETE, [{ required: 3, done: 3 }]],
  ];
  try {
    await lms.ackDocument(8379, 7);
  } finally {
    lifecycle.finalizeTrainingCompletion = original;
  }
  assert.ok(call(STAMP), 'step 1 — the course is stamped complete');
  assert.ok(call(TRAINING_COMPLETE), 'step 2 — and ALL training is probed');
  assert.equal(advanced, 1, 'step 3 — and the technician actually leaves TRAINING_PENDING');
});

test('a lifecycle failure never fails the acknowledgement itself', async () => {
  fake.reset();
  const lifecycle = require('../services/easyfixer-lifecycle.service');
  const original = lifecycle.finalizeTrainingCompletion;
  lifecycle.finalizeTrainingCompletion = async () => { throw new Error('lifecycle schema unavailable'); };
  scenario = [
    [ACK_LOOKUP, [{ id: 7, kind: 'document', course_id: 4 }]],
    [/INSERT INTO lms_document_ack/i, { affectedRows: 1 }],
    [STAMP, { affectedRows: 1 }],
    [TRAINING_COMPLETE, [{ required: 3, done: 3 }]],
  ];
  try {
    assert.deepEqual(await lms.ackDocument(8379, 7), { ok: true },
      'the ack is already committed — a failing tail must not become a 500 the app replays');
  } finally {
    lifecycle.finalizeTrainingCompletion = original;
  }
});

// ─── An id in a URL is not an entitlement ────────────────────────────

test('an assessment in no course of this technician 404s rather than being served', async () => {
  fake.reset();
  scenario = [[ASSIGNED, []]];
  await assert.rejects(
    () => lms.getAssessmentForTech(8379, 5),
    (e) => e.status === 404,
  );
  assert.equal(call(/FROM lms_question q/i), undefined, 'the paper is never even read');
});

test('a submit for an unassigned assessment records nothing', async () => {
  fake.reset();
  scenario = [[ASSIGNED, []], ...baseScenario()];
  await assert.rejects(
    () => lms.submitAssessment(8379, 5, { courseId: 4, answers: [{ questionId: 1, optionId: 11 }] }),
    (e) => e.status === 404,
  );
  assert.equal(call(INSERT_ATTEMPT), undefined,
    'otherwise any signed-in technician could bank a pass on any paper in the catalogue');
});

test('a body courseId the technician does not hold is not written through', async () => {
  fake.reset();
  // He is assigned course 4. The body claims 99.
  scenario = baseScenario({ assignedCourses: [4] });
  await lms.submitAssessment(8379, 5, { courseId: 99, answers: [{ questionId: 1, optionId: 11 }] });
  assert.equal(call(INSERT_ATTEMPT).params[2], 4,
    'the body is a hint, resolved against his assignments — never stored verbatim');
  assert.equal(call(SCORE_UPDATE).params[3], 4,
    'and the score cannot be written against a course he was never assigned');
});

// ─── The way out of an exhausted paper ───────────────────────────────

/*
 * Without a reset, exhaustion is terminal in the worst direction: the submit
 * 409s forever, completion needs a PASSING attempt so the course never stamps,
 * and the overdue restriction then withdraws work with no action available to
 * anybody. The remedy must clear the ROWS — attempt_no is allocated from a
 * fresh read against uq_lms_attempt, so a flag would leave the ceiling reached.
 */
test('resetting attempts clears the rows for exactly one technician and one paper', async () => {
  fake.reset();
  scenario = [[/DELETE FROM lms_assessment_attempt/i, { affectedRows: 3 }]];
  const out = await lms.resetAssessmentAttempts(5, 8379);
  assert.deepEqual(out, { cleared: 3 });
  const del = call(/DELETE FROM lms_assessment_attempt/i);
  assert.deepEqual(del.params, [5, 8379], 'scoped to the pair, never to the whole assessment');
  assert.equal(call(SCORE_UPDATE), undefined,
    'the best score stands — a reset is a second chance, not an erasure of what happened');
});

// ─── Completion spans kinds ──────────────────────────────────────────

test('completion is judged per kind, in one shared expression', async () => {
  fake.reset();
  scenario = [[TRAINING_COMPLETE, [{ required: 3, done: 3 }]]];
  const result = await lms.isTrainingComplete(8379);
  assert.equal(result.complete, true);
  const probe = call(TRAINING_COMPLETE);
  assert.match(probe.sql, /WHEN 'video' THEN/, 'videos count watched_percentage');
  assert.match(probe.sql, /WHEN 'assessment' THEN EXISTS \(SELECT 1 FROM lms_assessment_attempt/,
    'assessments count a PASSING attempt');
  assert.match(probe.sql, /aa\.passed = 1/);
  assert.match(probe.sql, /WHEN 'document' THEN EXISTS \(SELECT 1 FROM lms_document_ack/,
    'documents count an acknowledgement of the CONTENT row');
  assert.match(probe.sql, /da\.content_id = lc\.id/,
    'keyed on the content row, so the same PDF in two courses is acknowledged for each');
});

test('a course whose videos are done but whose assessment is not is NOT complete', async () => {
  fake.reset();
  // Two videos watched, the assessment unpassed: 3 items required, 2 done.
  scenario = [[TRAINING_COMPLETE, [{ required: 3, done: 2 }]]];
  const result = await lms.isTrainingComplete(8379);
  assert.equal(result.complete, false,
    'watching the videos is no longer the whole course');
});

test('retired items do not gate — only active content is required', async () => {
  fake.reset();
  scenario = [[TRAINING_COMPLETE, [{ required: 0, done: 0 }]]];
  await lms.isTrainingComplete(8379);
  assert.match(call(TRAINING_COMPLETE).sql, /lc\.status = 1/,
    'an item removed from a course must stop holding technicians at incomplete');
});

// ─── Saving course content must not orphan acknowledgements ──────────

/*
 * lms_document_ack is keyed on the CONTENT row id. Delete-then-insert on save
 * would issue every surviving item a NEW id and silently discard every
 * technician's acknowledgement — moving people from complete back to
 * incomplete on a course they had finished, with the overdue restriction
 * waiting behind it. The upsert is what keeps the id, so it is pinned.
 */
function contentScenario() {
  return [
    [/FROM courses WHERE id/i, [{ id: 4, name: 'Induction', status: 1 }]],
    [/SELECT id AS id FROM training_videos/i, (sql, params) => params.map((id) => ({ id }))],
    [/FROM lms_document\s+WHERE id IN/i, (sql, params) => params.map((id) => ({ id }))],
    [/FROM lms_assessment\s+WHERE id IN/i, (sql, params) => params.map((id) => ({ id }))],
    [/INSERT INTO lms_content/i, { affectedRows: 1, insertId: 77 }],
    [/UPDATE lms_content SET status = 0/i, { affectedRows: 1 }],
    [/FROM lms_content lc/i, []],
  ];
}

test('saving course content UPSERTS, so a re-order keeps each item row id', async () => {
  fake.reset();
  scenario = contentScenario();
  await lms.setCourseContent(4, [
    { kind: 'document', ref_id: 9 },
    { kind: 'video', ref_id: 3 },
  ]);
  const insert = call(/INSERT INTO lms_content/i);
  assert.ok(insert, 'content is written');
  assert.match(insert.sql, /ON DUPLICATE KEY UPDATE/,
    'delete-then-insert would hand every surviving item a new id');
  assert.match(insert.sql, /id = LAST_INSERT_ID\(id\)/,
    'without this MySQL reports insertId 0 on the update branch and the retire '
    + 'step below would drop the row that was just kept');
  assert.equal(call(/DELETE FROM lms_content/i), undefined,
    'nothing is deleted — lms_document_ack points at these rows');
});

test('items dropped from a course are retired, not deleted', async () => {
  fake.reset();
  scenario = contentScenario();
  await lms.setCourseContent(4, [{ kind: 'video', ref_id: 3 }]);
  const retire = call(/UPDATE lms_content SET status = 0/i);
  assert.ok(retire, 'the survivors of the previous save are retired');
  assert.match(retire.sql, /id NOT IN/, 'everything not resubmitted');
  assert.match(retire.sql, /course_id = \? AND status = 1/,
    'scoped to this course, and idempotent — already-retired rows are untouched');
});

test('content order is array order, and a duplicated item is stored once', async () => {
  fake.reset();
  scenario = contentScenario();
  await lms.setCourseContent(4, [
    { kind: 'video', ref_id: 3 },
    { kind: 'assessment', ref_id: 5 },
    { kind: 'video', ref_id: 3 },
  ]);
  // params: [courseId, kind, ref_id, sequence, now, now]
  const written = callsMatching(/INSERT INTO lms_content/i).map((c) => c.params.slice(1, 4));
  assert.deepEqual(written, [['video', 3, 1], ['assessment', 5, 2]],
    'positions follow the array, and the repeated video is not stored twice');
});

test('an unknown ref id is refused before anything is written', async () => {
  fake.reset();
  scenario = [
    [/FROM courses WHERE id/i, [{ id: 4, name: 'Induction', status: 1 }]],
    [/FROM lms_document\s+WHERE id IN/i, []],
  ];
  await assert.rejects(
    () => lms.setCourseContent(4, [{ kind: 'document', ref_id: 404 }]),
    (e) => e.status === 400 && /unknown document id\(s\): 404/.test(e.message),
  );
  assert.equal(call(/INSERT INTO lms_content/i), undefined);
});

test('the video-only save leaves documents and assessments in place', async () => {
  fake.reset();
  scenario = [
    // What the course already holds besides videos.
    [/SELECT kind, ref_id FROM lms_content/i, [
      { kind: 'document', ref_id: 9 },
      { kind: 'assessment', ref_id: 5 },
    ]],
    ...contentScenario(),
  ];
  await lms.setCourseVideos(4, [3]);
  const written = callsMatching(/INSERT INTO lms_content/i).map((c) => c.params.slice(1, 4));
  assert.deepEqual(written, [['video', 3, 1], ['document', 9, 2], ['assessment', 5, 3]],
    'the legacy payload carries only videos, so it must not be read as "delete '
    + 'everything else" — they keep their relative order behind the videos');
});

// ─── Unfinishable content cannot be attached to a course ─────────────

/*
 * createAssessment makes the row before the paper is written, so a
 * question-less assessment is a normal intermediate state — but PUTTING one in
 * a course is the same trap assignCourse already refuses for an empty course:
 * submitAssessment 409s on a paper with no questions, so it can never be
 * passed, so the course can never complete, so the overdue restriction
 * eventually withdraws work the technician could not have unblocked.
 */
test('an assessment with no questions cannot be put in a course', async () => {
  fake.reset();
  scenario = [
    [/FROM lms_assessment a/i, [{ id: 5 }]],
    ...contentScenario(),
  ];
  await assert.rejects(
    () => lms.setCourseContent(4, [{ kind: 'video', ref_id: 3 }, { kind: 'assessment', ref_id: 5 }]),
    (e) => e.status === 400 && /no questions/i.test(e.message),
  );
  assert.equal(call(/INSERT INTO lms_content/i), undefined,
    'refused before anything is written, so the course is not left half-saved');
});

test('an assessment that HAS questions attaches normally', async () => {
  fake.reset();
  // The "which of these have no questions" probe comes back empty.
  scenario = [[/FROM lms_assessment a/i, []], ...contentScenario()];
  await lms.setCourseContent(4, [{ kind: 'assessment', ref_id: 5 }]);
  assert.ok(call(/INSERT INTO lms_content/i), 'the guard refuses empty papers, not assessments');
});

// ─── Retirement has ONE guarded path, whichever verb asks ────────────

/*
 * PATCH used to write `status` straight through, skipping the in-use check
 * that DELETE runs. Setting status = 0 on an assessment a live course holds
 * 404s the paper for every technician on that course and makes the course
 * permanently unfinishable — the exact outcome retireAssessment exists to
 * refuse.
 */
test('PATCH status=false is refused while a course still holds the assessment', async () => {
  fake.reset();
  scenario = [[/FROM lms_content WHERE kind = 'assessment'/i, [{ n: 2 }]]];
  await assert.rejects(
    () => lms.updateAssessment(5, { status: false }),
    (e) => e.status === 409 && /used by 2 courses/i.test(e.message),
  );
  assert.equal(call(/UPDATE lms_assessment SET/i), undefined, 'and nothing is written');
});

test('PATCH status=false on an unused assessment retires it through the guarded path', async () => {
  fake.reset();
  scenario = [
    [/FROM lms_content WHERE kind = 'assessment'/i, [{ n: 0 }]],
    [/UPDATE lms_assessment SET status = 0/i, { affectedRows: 1 }],
    [/SELECT id, title, description, pass_percent, max_attempts, status/i, [{ id: 5, title: 'Paper', status: 0 }]],
    [/FROM lms_question q/i, []],
  ];
  await lms.updateAssessment(5, { status: false });
  assert.ok(call(/FROM lms_content WHERE kind = 'assessment'/i), 'the in-use check ran');
  assert.ok(call(/UPDATE lms_assessment SET status = 0/i));
});

test('a field PATCH never writes status at all', async () => {
  fake.reset();
  scenario = [
    [/UPDATE lms_assessment SET/i, { affectedRows: 1 }],
    [/SELECT id, title, description, pass_percent, max_attempts, status/i, [{ id: 5, title: 'Paper', status: 1 }]],
    [/FROM lms_question q/i, []],
  ];
  await lms.updateAssessment(5, { title: 'Electrical Safety v2' });
  assert.doesNotMatch(call(/UPDATE lms_assessment SET/i).sql, /status/,
    'status has exactly one write path and this is not it');
});

// ─── The S3 key stays server-side ────────────────────────────────────

test('listDocuments hands out a URL, never the raw S3 key', async () => {
  fake.reset();
  scenario = [
    [/COUNT\(\*\) AS total/i, [{ total: 1 }]],
    [/FROM lms_document d/i, [{
      id: 1, title: 'Induction Deck', file_key: 'LmsDocuments/1756_ab12cd',
      mime_type: 'application/pdf', size_bytes: 91234, page_count: 40,
      created_at: null, created_by: 7, course_count: 2,
    }]],
  ];
  const out = await lms.listDocuments({});
  assert.equal(out.rows[0].title, 'Induction Deck', 'the row is really there');
  assert.doesNotMatch(JSON.stringify(out), /file_key|LmsDocuments/,
    'the key is what the presigned URL exists to avoid publishing');
});

// ─── The answer key is gated at the ROUTE, not in the CRM ────────────

/*
 * GET /admin/lms/assessments/:id serves is_correct. It inherited only
 * requireAuth + role(['admin']), so every admin-group user could fetch the
 * answers to the paper that decides whether a technician is marked trained —
 * the CRM merely hid the button, which is a UI preference, not a control:
 * anyone can GET a URL.
 *
 * Exercised through the real router stack rather than over HTTP, the house
 * pattern from lms-action-routes.test.js. requireAction closes over the key
 * and reports it in its own 403 body, so the assertion reads the same string
 * an operator would see.
 */
const adminRouter = require('../routes/admin/lms');

async function demandedKey(method, path) {
  const layer = adminRouter.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method],
  );
  assert.ok(layer, `${method.toUpperCase()} ${path} must exist`);
  const guard = layer.route.stack.find((h) => h.name === 'actionGuard');
  assert.ok(guard, `${method.toUpperCase()} ${path} must carry an action guard`);
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  await guard.handle(
    { user: { user_id: 1, permissions: { actionPermissions: [] } } },
    res,
    () => { throw new Error('guard passed a user with no grants'); },
  );
  assert.equal(res.statusCode, 403);
  return String(res.body.error).replace('Missing permission: ', '');
}

test('reading an assessment — the answer key — demands isLmsManage', async () => {
  assert.equal(await demandedKey('get', '/assessments/:id'), 'isLmsManage',
    'a plain admin-group read would hand the answers to anyone who can reach the LMS menu');
});

test('resetting a technician\'s attempts demands isLmsManage', async () => {
  assert.equal(await demandedKey('delete', '/assessments/:id/attempts/:easyfixerId'), 'isLmsManage',
    'giving attempts back is an operator decision, not something the list read confers');
});

test('the assessment LIST stays open to the admin group — only the key is gated', () => {
  const layer = adminRouter.stack.find(
    (l) => l.route && l.route.path === '/assessments' && l.route.methods.get,
  );
  assert.ok(layer);
  assert.equal(layer.route.stack.find((h) => h.name === 'actionGuard'), undefined,
    'consuming a list is not authoring it — the header rule, unchanged');
});
