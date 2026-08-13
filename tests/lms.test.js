const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * LMS characterization tests.
 *
 * These pin the three behaviours that are easy to regress and expensive to
 * discover in production:
 *
 *   1. isTrainingComplete's treatment of "nothing assigned". It feeds a
 *      lifecycle transition, so a wrong `true` would advance every freshly
 *      registered technician out of TRAINING_PENDING without them watching
 *      anything.
 *   2. The completion -> lifecycle wire staying OFF the hot path. Progress
 *      pings arrive continuously during playback and the concurrency test
 *      next door asserts setTrainingPercentage issues exactly one query; a
 *      completion probe on every ping would break that and hammer the DB.
 *   3. Failures in the lifecycle advance never propagating back to progress
 *      recording, which is part of the offline-replay contract.
 */

const COMPLETION_QUERY = /FROM\s+easyfixer_courses ec\s+JOIN\s+course_videos/i;
const UPSERT = /^\s*INSERT INTO easyfixer_watched_video/i;

const fake = installFakePool([
  [UPSERT, { affectedRows: 1 }],
]);
const lms = require('../services/lms.service');
const profile = require('../services/mobile-profile-extra.service');
const lifecycle = require('../services/easyfixer-lifecycle.service');

after(() => fake.restore());

// ─── isTrainingComplete ──────────────────────────────────────────────

test('a technician with nothing assigned is NOT complete', async () => {
  fake.reset();
  // No assigned courses -> the aggregate returns required = 0.
  const restore = route([[COMPLETION_QUERY, [{ required: 0, done: 0 }]]]);
  const result = await lms.isTrainingComplete(8379);
  restore();
  assert.equal(result.complete, false,
    'zero required must not read as complete — it would advance untrained technicians');
  assert.equal(result.required, 0);
});

test('a partially watched course is NOT complete', async () => {
  fake.reset();
  const restore = route([[COMPLETION_QUERY, [{ required: 4, done: 3 }]]]);
  const result = await lms.isTrainingComplete(8379);
  restore();
  assert.equal(result.complete, false);
  assert.equal(result.done, 3);
});

test('every assigned video finished IS complete', async () => {
  fake.reset();
  const restore = route([[COMPLETION_QUERY, [{ required: 4, done: 4 }]]]);
  const result = await lms.isTrainingComplete(8379);
  restore();
  assert.equal(result.complete, true);
});

// ─── The hot path stays cheap ────────────────────────────────────────

test('an in-progress ping issues exactly one query and never probes completion', async () => {
  fake.reset();
  await profile.setTrainingPercentage(8379, 3, 80);
  assert.equal(fake.calls.length, 1,
    'a sub-threshold ping must not add a completion probe to the hot path');
  assert.match(fake.calls[0].sql, /ON DUPLICATE KEY UPDATE/i);
});

test('a ping one point below the threshold still does not probe', async () => {
  fake.reset();
  await profile.setTrainingPercentage(8379, 3, lms.COMPLETION_PERCENT - 1);
  assert.equal(fake.calls.length, 1);
});

test('a completing ping records progress first, then probes completion', async () => {
  fake.reset();
  const restore = route([
    [UPSERT, { affectedRows: 1 }],
    [COMPLETION_QUERY, [{ required: 4, done: 3 }]],
  ]);
  await profile.setTrainingPercentage(8379, 3, lms.COMPLETION_PERCENT);
  restore();
  assert.match(fake.calls[0].sql, /INSERT INTO easyfixer_watched_video/i,
    'progress is written before anything else can fail');
  assert.ok(fake.calls.length > 1, 'a 100% ping probes completion');
});

// ─── Fail-soft ───────────────────────────────────────────────────────

test('a lifecycle failure never fails progress recording', async () => {
  fake.reset();
  const original = lifecycle.finalizeTrainingCompletion;
  const restore = route([
    [UPSERT, { affectedRows: 1 }],
    [COMPLETION_QUERY, [{ required: 1, done: 1 }]],
  ]);
  lifecycle.finalizeTrainingCompletion = async () => {
    throw new Error('lifecycle schema unavailable');
  };
  try {
    const result = await profile.setTrainingPercentage(8379, 3, lms.COMPLETION_PERCENT);
    assert.deepEqual(result, { videoId: 3, watchedPercentage: lms.COMPLETION_PERCENT },
      'the technician still gets their progress saved');
  } finally {
    lifecycle.finalizeTrainingCompletion = original;
    restore();
  }
});

// ─── Report filtering happens in SQL ─────────────────────────────────

test('the complete/incomplete filter is applied in SQL, not after paging', async () => {
  fake.reset();
  const restore = route([
    [/SELECT COUNT\(\*\) AS total/i, [{ total: 7 }]],
    [/completion_pct/i, []],
  ]);
  await lms.trainingReport({ status: 'complete', limit: 10 });
  restore();
  const paged = fake.calls.find((c) => /LIMIT \? OFFSET \?/i.test(c.sql));
  assert.ok(paged, 'the page query ran');
  assert.match(paged.sql, /videos_done >= t\.videos_total/i,
    'filtering in JS after LIMIT would return a short page while total counted the dropped rows');
  const counted = fake.calls.find((c) => /COUNT\(\*\) AS total/i.test(c.sql));
  assert.match(counted.sql, /videos_done >= t\.videos_total/i,
    'the count must describe the same filtered set as the page');
});

// ─── YouTube link parsing ────────────────────────────────────────────

test('every accepted YouTube form canonicalises to the same watch URL', () => {
  const canonical = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  for (const input of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ?si=abcdef',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    '  https://www.youtube.com/watch?v=dQw4w9WgXcQ  ',
  ]) {
    assert.equal(lms.parseYouTubeUrl(input)?.url, canonical, `failed for ${input}`);
  }
});

test('non-YouTube and malformed links are rejected, not stored', () => {
  for (const input of [
    'https://vimeo.com/123456789',
    'https://example.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/watch?v=tooshort',
    'https://www.youtube.com/watch',
    'javascript:alert(1)',
    'not a url at all',
    '',
    null,
  ]) {
    assert.equal(lms.parseYouTubeUrl(input), null, `should reject ${input}`);
  }
});

// ─── TRAINING_PENDING entrance ───────────────────────────────────────

test('registration with outstanding training finalises to TRAINING_PENDING', () => {
  const gates = {
    personal_submitted: 1,
    adhaar_card_number: '123412341234',
    efr_profile_img: 'photo.jpg',
  };
  const withTraining = lifecycle._internals
    .gate1FinalizationDecision('REGISTRATION_INCOMPLETE', gates, true);
  assert.equal(withTraining.target, 'TRAINING_PENDING');
  assert.equal(withTraining.complete, true);
});

test('registration with nothing assigned still finalises to UNDER_VERIFICATION', () => {
  const gates = {
    personal_submitted: 1,
    adhaar_card_number: '123412341234',
    efr_profile_img: 'photo.jpg',
  };
  // Default argument — proves the pre-LMS behaviour is untouched for the
  // overwhelming majority of technicians, who have no course assigned at
  // registration time.
  assert.equal(
    lifecycle._internals.gate1FinalizationDecision('REGISTRATION_INCOMPLETE', gates).target,
    'UNDER_VERIFICATION',
  );
  assert.equal(
    lifecycle._internals.gate1FinalizationDecision('REGISTRATION_INCOMPLETE', gates, false).target,
    'UNDER_VERIFICATION',
  );
});

test('an incomplete gate is never diverted to TRAINING_PENDING', () => {
  // Missing profile image — the registration gate itself fails, and training
  // must not override that into a "progressed" state.
  const decision = lifecycle._internals.gate1FinalizationDecision(
    'REGISTRATION_INCOMPLETE',
    { personal_submitted: 1, adhaar_card_number: '123412341234', efr_profile_img: '' },
    true,
  );
  assert.equal(decision.complete, false);
  assert.equal(decision.target, 'REGISTRATION_INCOMPLETE');
});

/*
 * The fake installs one static route table at construction. These tests need
 * different canned rows per case, so this swaps the table in place and hands
 * back an undo — simpler than standing up a second fake per test and
 * re-requiring the services under it.
 */
function route(routes) {
  const db = require('../db');
  const previous = db.pool.query;
  db.pool.query = async (sql, params) => {
    const text = Array.isArray(sql) ? String(sql[0]) : String(sql);
    fake.calls.push({ sql: text, params });
    for (const [re, resp] of routes) {
      if (re.test(text)) return [typeof resp === 'function' ? resp(text, params) : resp, []];
    }
    return [[], []];
  };
  return () => { db.pool.query = previous; };
}
