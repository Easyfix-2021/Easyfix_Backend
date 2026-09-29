const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * The server-side watch-time check on POST /api/mobile/training-videos/percentage
 * (mobile-profile-extra.service::setTrainingPercentage). A technician's credit
 * for a video is capped by how long ago they first reported on it, so an API
 * caller cannot post 100 for a video they never played. Cap, never reject.
 */

const PROBE = /information_schema\.columns/i;
const PRE_READ = /FROM training_videos tv\s+LEFT JOIN easyfixer_watched_video w/i;
const UPSERT = /^\s*INSERT INTO easyfixer_watched_video/i;
const BOTH = [
  { t: 'easyfixer_watched_video', c: 'first_watched_at' },
  { t: 'training_videos', c: 'duration_seconds' },
];

let probeRows = BOTH;
let preRead = null;
const fake = installFakePool([
  [PROBE, () => probeRows],
  [PRE_READ, () => {
    if (preRead instanceof Error) throw preRead;
    return [preRead];
  }],
  [UPSERT, { affectedRows: 1 }],
  [/^\s*(INSERT INTO|UPDATE) training_videos/i, { insertId: 42, affectedRows: 1 }],
]);
const profile = require('../services/mobile-profile-extra.service');
const lms = require('../services/lms.service');

after(() => fake.restore());
beforeEach(async () => {
  probeRows = BOTH;
  lms.invalidateLmsSchemaCache();
  await lms.lmsFlagColumns();
  fake.reset();
});

const upsert = () => fake.calls.find((c) => UPSERT.test(c.sql));

// ─── The arithmetic ──────────────────────────────────────────────────

const { allowedWatchPercent, WATCH_TOLERANCE_PCT } = profile;

test('watched for at least the whole duration: the request passes through', () => {
  assert.equal(allowedWatchPercent({ requested: 100, elapsedSeconds: 52, durationSeconds: 52, tolerancePct: 10 }), 100);
  assert.equal(allowedWatchPercent({ requested: 100, elapsedSeconds: 600, durationSeconds: 52, tolerancePct: 10 }), 100);
});

test('20 s into a 52 s video, 100% is credited as 38 + tolerance', () => {
  assert.equal(allowedWatchPercent({ requested: 100, elapsedSeconds: 20, durationSeconds: 52, tolerancePct: 10 }), 48);
  assert.equal(allowedWatchPercent({ requested: 100, elapsedSeconds: 20, durationSeconds: 52 }), 38 + WATCH_TOLERANCE_PCT);
});

test('a request under the allowance is credited as asked', () => {
  assert.equal(allowedWatchPercent({ requested: 25, elapsedSeconds: 20, durationSeconds: 52, tolerancePct: 10 }), 25);
});

test('no duration, or no known start: the request is unchanged', () => {
  for (const durationSeconds of [null, undefined, 0, -5]) {
    assert.equal(allowedWatchPercent({ requested: 100, elapsedSeconds: 1, durationSeconds, tolerancePct: 10 }), 100);
  }
  assert.equal(allowedWatchPercent({ requested: 100, elapsedSeconds: null, durationSeconds: 52, tolerancePct: 10 }), 100);
});

test('the allowance clamps to 0..100', () => {
  assert.equal(allowedWatchPercent({ requested: 40, elapsedSeconds: 0, durationSeconds: 52, tolerancePct: -20 }), 0);
  assert.equal(allowedWatchPercent({ requested: 40, elapsedSeconds: -30, durationSeconds: 52, tolerancePct: 0 }), 0);
  assert.equal(allowedWatchPercent({ requested: 150, elapsedSeconds: 5200, durationSeconds: 52, tolerancePct: 10 }), 100);
});

test('the tolerance covers the app\'s 25% head start (first checkpoint is at 25)', () => {
  // First report at the 25% checkpoint starts the clock; the 100% report comes
  // 75% of a duration later. It must be credited in full.
  assert.ok(WATCH_TOLERANCE_PCT >= 25);
  assert.equal(allowedWatchPercent({ requested: 100, elapsedSeconds: 75, durationSeconds: 100 }), 100);
});

// ─── The writer ──────────────────────────────────────────────────────

test('the first report sets first_watched_at to now and is capped to the tolerance', async () => {
  preRead = { duration_s: 52, row_id: null, pct: null, elapsed_s: null };
  const result = await profile.setTrainingPercentage(8379, 3, 100);
  const u = upsert();
  assert.match(u.sql, /\(easyfixer_id, video_id, watched_percentage, update_date, first_watched_at\)/);
  assert.equal(u.params[2], WATCH_TOLERANCE_PCT, 'an instant 100 is credited as the tolerance');
  assert.ok(u.params[4] instanceof Date);
  assert.equal(u.params[4].getTime(), u.params[3].getTime(), 'first_watched_at = now on INSERT');
  assert.deepEqual(result, { videoId: 3, watchedPercentage: WATCH_TOLERANCE_PCT });
  assert.equal(fake.calls.length, 2, 'pre-read + upsert; a capped 100 does not probe completion');
});

test('a later report never overwrites first_watched_at', async () => {
  preRead = { duration_s: 52, row_id: 11, pct: 50, elapsed_s: 40 };
  await profile.setTrainingPercentage(8379, 3, 75);
  const u = upsert();
  assert.match(u.sql, /ON DUPLICATE KEY UPDATE\s+first_watched_at = COALESCE\(first_watched_at, \?\)/i);
  assert.doesNotMatch(u.sql, /first_watched_at = (\?|VALUES\(first_watched_at\))/i);
});

test('the cap is applied when the video has a duration', async () => {
  preRead = { duration_s: 52, row_id: 11, pct: 25, elapsed_s: 20 };
  const result = await profile.setTrainingPercentage(8379, 3, 100);
  assert.equal(upsert().params[2], 38 + WATCH_TOLERANCE_PCT);
  assert.equal(result.watchedPercentage, 38 + WATCH_TOLERANCE_PCT);
});

test('an honest viewer is credited in full', async () => {
  preRead = { duration_s: 52, row_id: 11, pct: 75, elapsed_s: 40 };
  await profile.setTrainingPercentage(8379, 3, 99);
  assert.equal(upsert().params[2], 99);
});

test('no cap without a duration', async () => {
  preRead = { duration_s: null, row_id: null, pct: null, elapsed_s: null };
  const result = await profile.setTrainingPercentage(8379, 3, 90);
  assert.equal(upsert().params[2], 90);
  assert.equal(result.watchedPercentage, 90);
  assert.match(upsert().sql, /first_watched_at/, 'the start is still recorded for when a duration arrives');
});

test('a row from before the column is backdated by the progress it already holds', async () => {
  preRead = { duration_s: 100, row_id: 11, pct: 70, elapsed_s: null };
  await profile.setTrainingPercentage(8379, 3, 100);
  const u = upsert();
  assert.equal(u.params[2], 100, '70% held + tolerance covers the remaining 30%');
  assert.equal(u.params[3].getTime() - u.params[4].getTime(), 70 * 1000, 'first_watched_at = now - 70% x 100 s');
  assert.equal(u.params[4].getTime(), u.params[5].getTime(), 'INSERT and COALESCE bind the same instant');
});

test('a failed pre-read records the progress uncapped', async () => {
  preRead = new Error('Unknown column');
  await profile.setTrainingPercentage(8379, 3, 90);
  assert.equal(upsert().params[2], 90);
});

test('columns not migrated: the old single upsert, no first_watched_at', async () => {
  probeRows = [];
  lms.invalidateLmsSchemaCache();
  await lms.lmsFlagColumns();
  fake.reset();
  preRead = { duration_s: 52, row_id: null, pct: null, elapsed_s: null };
  await profile.setTrainingPercentage(8379, 3, 80);
  assert.equal(fake.calls.length, 1);
  assert.doesNotMatch(fake.calls[0].sql, /first_watched_at/);
  assert.deepEqual(fake.calls[0].params.slice(0, 3), [8379, 3, 80]);
  assert.equal(fake.calls[0].params.length, 5);
});

test('a failed probe assumes the columns ABSENT (the upsert must not name a missing column)', async () => {
  lms.invalidateLmsSchemaCache();
  const db = require('../db');
  const q = db.pool.query;
  db.pool.query = async (sql, params) => {
    if (PROBE.test(String(sql))) throw new Error('information_schema hiccup');
    return q(sql, params);
  };
  try {
    const flags = await lms.lmsFlagColumns();
    assert.equal(flags.watchFirstAt, false);
    assert.equal(flags.videoDuration, false);
  } finally {
    db.pool.query = q;
    lms.invalidateLmsSchemaCache();
  }
});

// ─── The CRM's admin route stores the duration ───────────────────────

async function aux(method, path, body) {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/aux', require('../routes/admin/auxiliary'));
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/aux${path}`, {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return res.status;
  } finally {
    srv.close();
  }
}
const tvWrite = () => fake.calls.find((c) => /^\s*(INSERT INTO|UPDATE) training_videos/i.test(c.sql));

test('POST /aux/training-videos stores duration_seconds', async () => {
  assert.equal(await aux('POST', '/training-videos', { title: 'Safety', duration_seconds: 52 }), 201);
  assert.match(tvWrite().sql, /duration_seconds/);
  assert.equal(tvWrite().params.at(-1), 52);
});

test('PATCH /aux/training-videos/:id can set or clear only the duration', async () => {
  assert.equal(await aux('PATCH', '/training-videos/3', { duration_seconds: 90 }), 200);
  assert.match(tvWrite().sql, /SET duration_seconds = \? WHERE id = \?/);
  assert.deepEqual(tvWrite().params, [90, 3]);
  fake.reset();
  assert.equal(await aux('PATCH', '/training-videos/3', { duration_seconds: null }), 200);
  assert.deepEqual(tvWrite().params, [null, 3]);
});

test('a zero or fractional duration is rejected', async () => {
  assert.equal(await aux('POST', '/training-videos', { title: 'Safety', duration_seconds: 0 }), 400);
  assert.equal(await aux('PATCH', '/training-videos/3', { duration_seconds: 1.5 }), 400);
  assert.equal(tvWrite(), undefined);
});

test('pre-migration, the admin INSERT does not name duration_seconds', async () => {
  probeRows = [];
  lms.invalidateLmsSchemaCache();
  assert.equal(await aux('POST', '/training-videos', { title: 'Safety', duration_seconds: 52 }), 201);
  assert.doesNotMatch(tvWrite().sql, /duration_seconds/);
});
