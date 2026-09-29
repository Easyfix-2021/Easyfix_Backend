const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * THE REGISTERED QUEUE MUST NOT NAME A VIDEO ID.
 *
 * `easyfixer_watched_video.video_id` references `training_videos.id`. The
 * legacy mobile WIRE format spoke `training_videos.training_video_id` (1/2/3)
 * and a Java translator resolved it before persisting, so the two spaces were
 * never interchangeable — see
 * migrations/2026-09-07-canonicalise-watched-video-id-space.sql.
 *
 * The legacy CRM hardcoded 6 in its list query (a real training_videos.id) and
 * 3 in count/export (a wire id that matches nothing in storage). This port
 * unified on 3, the broken one. Measured on QA 2026-09-07: `video_id = 3`
 * matched 0 of 7,220 rows, so `watched_percentage` was NULL for all 4,055 rows
 * of the queue — "Pending Member Verification" and the early-activation
 * highlight could never fire.
 *
 * Any literal id is the same bug waiting to happen (a video is retired, a
 * course is added, the catalogue is reseeded), so these tests assert the
 * absence of the literal, not the presence of a better one.
 */

// Both LMS flag columns present — the real production shape after
// 2026-08-26-lms-mandatory-flags.sql. lms.lmsFlagColumns() caches its answer
// for an hour, so this file characterizes exactly one probe result.
const fake = installFakePool([
  [/FROM information_schema\.columns/i, [
    { t: 'courses', c: 'is_mandatory' },
    { t: 'training_videos', c: 'is_global' },
    { t: 'lms_assessment', c: 'created_by' },
    { t: 'courses', c: 'is_system' },
  ]],
  // listRegistered destructures `[[{ total }]]` and registeredStatusCounts
  // `[[row]]`, so a bare [] would throw before any assertion could run.
  [/AS pending_member_verification/i, [{ total: 0 }]],
  [/SELECT COUNT\(\*\)/i, [{ total: 0 }]],
  [/./, []],
]);
const svc = require('../services/easyfixer.service');
after(() => fake.restore());

const SCOPE = { cities: { mode: 'all', ids: [] } };

// The queue's own statements, keyed by which one they are.
async function queueSql(run) {
  fake.reset();
  await run();
  const hits = fake.calls
    .map((c) => c.sql)
    .filter((s) => /FROM tbl_easyfixer e\b/i.test(s));
  assert.ok(hits.length, 'no queue statement was captured');
  return hits;
}

const listSql = () => queueSql(() => svc.listRegistered({}, SCOPE));
const countsSql = () => queueSql(() => svc.registeredStatusCounts(SCOPE));

test('no statement in the queue names a video id', async () => {
  for (const sql of [...await listSql(), ...await countsSql()]) {
    assert.doesNotMatch(sql, /video_id\s*=\s*\d/,
      'a hardcoded video id is how this broke: the constant outlived the id '
      + 'space it was written in and silently matched nothing');
  }
});

test('training progress is the MINIMUM across the required set, not one video', async () => {
  for (const sql of [...await listSql(), ...await countsSql()]) {
    assert.match(sql, /MIN\(COALESCE\(w\.watched_percentage, 0\)\) AS watched_percentage/,
      'MIN is what makes 100 mean "all required videos done" — gating on any '
      + 'single video marks the whole section complete after the first one');
    assert.match(sql, /w\.video_id = m\.video_id/,
      'progress must be matched to the required video, not to a constant');
  }
});

// The arms of the derived pair list, one string each.
function requiredSetArms(sql) {
  const m = sql.match(/FROM \(([\s\S]*?)\n\s*\) m\b/);
  assert.ok(m, 'the required-set subquery is missing');
  return m[1].split(/\bUNION\b/i);
}

test('the required set is what the APP LISTS, not only the mandatory subset', async () => {
  /*
   * Mirrors lms.visibleVideoIdsSql(), which is the set GET
   * /api/mobile/training-videos returns and the set the app's Next button
   * gates on (every listed row at 100). The two must not diverge: the operator
   * acting on "Pending Member Verification" and the app deciding whether the
   * technician may work are answering the same question.
   *
   * Mirroring mandatoryVideoIdsSql() instead — a strict subset — is the defect
   * this replaced: a technician holding a NON-mandatory course with an
   * unwatched video is blocked by the app while this queue calls him complete,
   * so ops early-activate someone who cannot then work.
   *
   * `easyfixer_courses` (HELD) in both course arms: flagging a course mandatory
   * must not retro-gate technicians it was never assigned to.
   */
  for (const sql of [...await listSql(), ...await countsSql()]) {
    // Everyone's arm is lms.globalVideoIdsSql(): the system course's videos,
    // with is_global only as the pre-migration fallback (owner, 2026-09-29).
    assert.match(sql, /JOIN \(\s*SELECT tv\.id FROM training_videos tv\s+WHERE tv\.is_global = 1\s+AND NOT EXISTS \(SELECT 1 FROM courses sc WHERE sc\.is_system = 1/);
    assert.match(sql, /JOIN easyfixer_courses ec\s+ON ec\.course_id = c\.id/);
    assert.match(sql, /c\.is_mandatory = 1/);

    const arms = requiredSetArms(sql);
    assert.equal(arms.length, 4,
      'four arms, one per arm of visibleVideoIdsSql(): global catalogue '
      + '(legacy fallback + system course), mandatory courses held, ANY course held');
    const anyCourseArms = arms.filter(
      (a) => /easyfixer_courses/.test(a) && !/is_mandatory/.test(a));
    assert.equal(anyCourseArms.length, 1,
      'the third arm — held courses with NO is_mandatory predicate — is what '
      + 'makes this set equal the one the app lists; narrowing it back to '
      + 'mandatory-only re-opens the early-activation gap');
    assert.match(anyCourseArms[0], /lc2\.kind = 'video' AND lc2\.status = 1/,
      'video-only and live content only, exactly as visibleVideoIdsSql filters');
  }
});

test('the page query and its COUNT derive progress the same way', async () => {
  // Different definitions here put a row on the page that the total does not
  // count (or the reverse), which reads as a pagination bug forever.
  const [page, count] = await listSql();
  const block = (sql) => {
    const m = sql.match(/LEFT JOIN \(\s*SELECT m\.easyfixer_id[\s\S]*?\) wvd ON wvd\.easyfixer_id = e\.efr_id/);
    assert.ok(m, 'the derived training-progress join is missing');
    return m[0];
  };
  assert.equal(block(page), block(count));
});
