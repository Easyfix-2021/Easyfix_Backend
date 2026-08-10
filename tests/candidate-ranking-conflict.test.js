/*
 * The BOOKING-CONFLICT hard filter in the candidate-ranking pipeline.
 *
 * This is the query that decides whether a technician is silently dropped from
 * the Schedule & Assign Top-10, so its exact predicate matters:
 *
 *   BEFORE  AND DATE(requested_date_time) = ? AND time_slot = ?
 *           — string equality on a 3-to-5-HOUR band, across ~12 incompatible
 *             free-text vocabularies. A technician with a 9 AM job was excluded
 *             from an 11 AM job; 'Morning 9 to 2' never matched '9AM to 12PM'.
 *   AFTER   a real 1-HOUR OVERLAP on requested_date_time, with the 00:00
 *           midnight sentinel excluded on BOTH sides.
 *
 * The semantics of the window itself are pinned in tests/time-slot.test.js
 * (conflictFrame / sameConflictFrame — the SQL binds that exact frame). What is
 * pinned HERE is that the pipeline actually issues that query, with those
 * params, and that the retired band equality is gone from every ranking path.
 *
 * Non-destructive: fake pool, no real DB. Runner: `node --test`.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installFakePool } = require('./helpers/fake-pool');
const properties = require('../services/properties.service');

// One eligible technician, so statsForCandidates actually runs its batch
// (it short-circuits to an empty Map when the eligible set is empty).
const EFR = { efr_id: 101, efr_name: 'Tester', efr_no: '9999999999', current_balance: 0 };

const fake = installFakePool([
  [/INFORMATION_SCHEMA/i, [{ n: 0 }]],
  [/SHOW COLUMNS/i, []],
  [/FROM tbl_easyfixer e/, [EFR]],
]);

const ranking = require('../services/candidate-ranking.service');

beforeEach(() => { fake.reset(); });

// The conflict query is the only one carrying the sentinel guard.
const CONFLICT_RE = /TIME\(requested_date_time\) <> '00:00:00'/;

async function rankWith(requestedDateTime, extra = {}) {
  const job = {
    job_id: 42,
    fk_client_id: 30,
    fk_easyfixter_id: null,
    requested_date_time: requestedDateTime,
    city_id: 5,
    pin_code: '122003',
    ...extra,
  };
  // The pipeline fans out ~15 queries; every unrouted one returns []. We only
  // care about which statements were ISSUED, so a downstream throw is fine.
  try {
    await ranking.rankCandidatesForJob(42, { preloadedJob: job, limit: 10 });
  } catch { /* the fake pool cannot satisfy the whole pipeline — irrelevant here */ }
  return fake.calls.find((c) => CONFLICT_RE.test(c.sql)) || null;
}

test('the conflict query binds the proposed 1-HOUR FRAME and excludes the job itself', async () => {
  const q = await rankWith('2026-08-05 15:00:00');
  assert.ok(q, 'the booking-conflict query must be issued for a scheduled job');
  /*
   * FRAME equality, not a sliding window. The owner's rule is "same 1-hour
   * slot" — so the predicate compares the DAY and the HOUR, and a job in the
   * neighbouring hour is simply a different frame.
   */
  assert.match(q.sql, /DATE\(requested_date_time\) = \?/);
  assert.match(q.sql, /HOUR\(requested_date_time\) = \?/);
  assert.doesNotMatch(q.sql, /requested_date_time [<>]/, 'no range bounds — the frame is not a window');
  assert.ok(q.params.includes('2026-08-05'), 'binds the appointment DATE');
  assert.ok(q.params.includes(15), 'binds the appointment HOUR');
  assert.ok(q.params.includes(42), 'the job must not count as a clash with itself');
  assert.match(q.sql, /job_status IN \(0, 1, 2\)/, 'still scoped to ACTIVE jobs only');
});

test('the conflict query no longer touches time_slot at all', async () => {
  const q = await rankWith('2026-08-05 15:00:00');
  assert.ok(q);
  assert.doesNotMatch(q.sql, /time_slot/, 'the slot STRING plays no part in conflict detection');
});

/*
 * THE TRAP. A proposed job sitting on the 00:00 sentinel ("no appointment time
 * captured") has no hour to compare. Running the window anyway would make it
 * collide with every other sentinel row — hard-filtering technicians far more
 * aggressively than the band equality this replaces. The filter must stand down.
 */
test('a midnight-sentinel job issues NO conflict query at all', async () => {
  assert.equal(await rankWith('2026-08-05 00:00:00'), null);
});

test('an unscheduled job issues no conflict query', async () => {
  assert.equal(await rankWith(null), null);
});

/*
 * The Best-Slot recommender passes a DATE-ONLY jobDate on purpose: with no
 * proposed hour the ranking pass's own conflict filter stands down, and
 * per-window occupancy comes from its separate busy map instead.
 */
test('a date-only proposal issues no conflict query', async () => {
  assert.equal(await rankWith('2026-08-05'), null);
});

/*
 * Both ranking paths had the same defect. Auto-assign's legacy ranker
 * (services/auto-assign.service.js, still serving
 * GET /api/admin/auto-assign/:jobId/candidates) carried its own copy of the
 * band equality. A source-level sweep is the honest guard here: it catches a
 * reintroduction anywhere in either file, including in a path these fake-pool
 * tests do not walk.
 */
test('NO ranking path compares time_slot with an equality predicate any more', () => {
  for (const file of ['candidate-ranking.service.js', 'auto-assign.service.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', file), 'utf8');
    // Strip block + line comments so the historical notes explaining the old
    // predicate don't trip the guard.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /time_slot\s*=\s*\?/, `${file} still binds a time_slot equality`);
    assert.match(code, /TIME\(requested_date_time\) <> '00:00:00'/,
      `${file} must guard the midnight sentinel in its conflict query`);
  }
});

/*
 * ── THE SLOT RECOMMENDER MUST AGREE WITH THE HARD FILTER ─────────────
 *
 * recommendSlotsForJob's occupancy map used to bucket each committed job into
 * its 3-to-4-hour BAND, while the filter it claims to mirror is 1-HOUR exact —
 * so the two disagreed in both directions (a 14:30 job made a technician "free"
 * for 3PM-7PM that the Top-10 then rejected at 15:00; three technicians each
 * holding one 18:00 job made the whole 3PM-7PM window read "unstaffable" while
 * the Top-10 for 15:00 listed all three).
 *
 * It also fed MIDNIGHT-SENTINEL rows back in through their time_slot label —
 * resurrecting as occupancy exactly the rows the conflict filter deliberately
 * ignores, and doing it only for the digit-leading labels normaliseSlotLabel
 * happens to read ('Morning 9 to 2', the most common legacy value, returns
 * null). Occupancy is now derived from requested_date_time alone.
 */
test('the slot recommender reads NO slot label — occupancy is the appointment hour', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'candidate-ranking.service.js'), 'utf8');
  const body = src.slice(src.indexOf('async function recommendSlotsForJob'));
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /normaliseSlotLabel/,
    'a sentinel row must not be resurrected as occupancy through its label');
  assert.doesNotMatch(code, /SELECT DISTINCT[^`]*time_slot/,
    'the occupancy query must not even project time_slot');
  assert.match(code, /sameConflictFrame/,
    'occupancy must be decided by the same 1-hour FRAME the SQL filter uses');
});
