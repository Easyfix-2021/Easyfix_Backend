'use strict';
/*
 * Image-based assessment questions (lms_question.image_key).
 *
 * The load-bearing test here is the LEAK test: the technician's paper must
 * carry a presigned imageUrl and never the S3 key. It sits beside the existing
 * is_correct discipline for the same reason — that projection names everything
 * that leaves the function precisely so an internal value cannot ride out in a
 * spread or a field somebody adds later while reading the admin version next
 * door.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const ASSESSMENT = { id: 5, title: 'Safety', description: null, pass_percent: 70, max_attempts: 3, status: 1 };
const QROW = (extra = {}) => ({
  question_id: 11, question_text: 'Which part is faulty?', question_sequence: 1,
  image_key: 'LmsQuestions/1756_abc123',
  option_id: 21, option_text: 'The capacitor', is_correct: 1, option_sequence: 1,
  ...extra,
});

/*
 * getAssessmentForTech gates on ENTITLEMENT before it reads anything — an
 * assessment the technician was never assigned 404s rather than 403s. The fake
 * has to satisfy that first, or every technician-side test fails as
 * "assessment not found" and proves nothing about the payload.
 */
const fake = installFakePool([
  [/DISTINCT lc\.course_id/i, [{ course_id: 3 }]],
  [/FROM lms_assessment WHERE id/i, [ASSESSMENT]],
  [/FROM lms_question q/i, [QROW()]],
  [/COUNT\(\*\) AS n FROM lms_assessment_attempt/i, [{ n: 0 }]],
  [/./, []],
]);
after(() => fake.restore());

const svc = require('../services/lms.service');

const sqlOf = (re) => fake.calls.map((c) => c.sql).filter((s) => re.test(s)).join('\n');

test("the TECHNICIAN's paper carries imageUrl and NEVER the storage key", async () => {
  fake.reset();
  const paper = await svc.getAssessmentForTech(9, 5);
  const q = paper.questions[0];
  assert.ok('imageUrl' in q, 'the app needs a resolvable URL');
  assert.equal('image_key' in q, false,
    'the S3 key must be deleted from the payload, not merely unselected');
  assert.equal(JSON.stringify(paper).includes('LmsQuestions/'), false,
    'no storage key anywhere in the serialized response');
});

test("the technician's paper still never carries the answer key", async () => {
  fake.reset();
  const paper = await svc.getAssessmentForTech(9, 5);
  assert.equal(JSON.stringify(paper).includes('is_correct'), false);
});

test('the ADMIN gets both the key and the URL', async () => {
  fake.reset();
  const paper = await svc.getAssessmentForAdmin(5);
  const q = paper.questions[0];
  assert.equal(q.image_key, 'LmsQuestions/1756_abc123',
    'without the key the next full-replace save would drop every image');
  assert.ok('imageUrl' in q);
});

test('a question with no image reports null, not an empty key', async () => {
  fake.reset();
  const f2 = installFakePool([
    [/DISTINCT lc\.course_id/i, [{ course_id: 3 }]],
    [/FROM lms_assessment WHERE id/i, [ASSESSMENT]],
    [/FROM lms_question q/i, [QROW({ image_key: null })]],
    [/COUNT\(\*\) AS n FROM lms_assessment_attempt/i, [{ n: 0 }]],
    [/./, []],
  ]);
  try {
    const paper = await svc.getAssessmentForAdmin(5);
    assert.equal(paper.questions[0].image_key, null);
    assert.equal(paper.questions[0].imageUrl, null);
  } finally { f2.restore(); }
});

test('both projections actually SELECT the column', async () => {
  fake.reset();
  await svc.getAssessmentForTech(9, 5);
  await svc.getAssessmentForAdmin(5);
  const sql = sqlOf(/FROM lms_question q/i);
  assert.equal((sql.match(/q\.image_key/g) || []).length, 2,
    'a projection that forgets the column renders every question image-less');
});

test('the save round-trips the key into the INSERT', async () => {
  fake.reset();
  await svc.setAssessmentQuestions(5, [{
    question_text: 'Which part is faulty?',
    image_key: 'LmsQuestions/1756_abc123',
    options: [
      { option_text: 'A', is_correct: true },
      { option_text: 'B', is_correct: false },
    ],
  }]);
  const ins = fake.calls.find((c) => /INSERT INTO lms_question\b/i.test(c.sql));
  assert.ok(ins, 'the question INSERT must run');
  assert.match(ins.sql, /image_key/);
  assert.ok(ins.params.includes('LmsQuestions/1756_abc123'),
    'the key the operator uploaded must reach the row');
});

test("an emptied image sends '' and must store NULL", async () => {
  fake.reset();
  await svc.setAssessmentQuestions(5, [{
    question_text: 'Text only now',
    image_key: '',
    options: [
      { option_text: 'A', is_correct: true },
      { option_text: 'B', is_correct: false },
    ],
  }]);
  const ins = fake.calls.find((c) => /INSERT INTO lms_question\b/i.test(c.sql));
  assert.equal(ins.params[ins.params.length - 1], null,
    "'' is a storable VARCHAR — it would presign to a broken URL instead of "
    + 'rendering as "no image"');
});

test('an absent image_key is also NULL, not undefined', async () => {
  fake.reset();
  await svc.setAssessmentQuestions(5, [{
    question_text: 'Never had an image',
    options: [
      { option_text: 'A', is_correct: true },
      { option_text: 'B', is_correct: false },
    ],
  }]);
  const ins = fake.calls.find((c) => /INSERT INTO lms_question\b/i.test(c.sql));
  assert.equal(ins.params[ins.params.length - 1], null);
});

test('an unassigned assessment 404s before any payload is built', async () => {
  const f3 = installFakePool([
    [/DISTINCT lc\.course_id/i, []],
    [/FROM lms_assessment WHERE id/i, [ASSESSMENT]],
    [/FROM lms_question q/i, [QROW()]],
    [/./, []],
  ]);
  try {
    await assert.rejects(() => svc.getAssessmentForTech(9, 5), /assessment not found/);
  } finally { f3.restore(); }
});
