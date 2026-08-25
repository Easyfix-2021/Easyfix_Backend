/*
 * Live Technician Location — legacy `location` fallback (2026-08-25).
 *
 * The bug: the CRM popover said "Location unavailable" for EVERY technician.
 * getLatestByEfr read only tbl_job_location_track, which the NEW Expo app
 * writes and which has 0 rows — while essentially every technician is still on
 * the LEGACY Flutter app, whose GPS lands in `location` (~2.5M rows).
 *
 * The trap these tests exist to pin: `location.user_id` is `tbl_user.user_id`,
 * NOT `tbl_easyfixer.efr_id` (proven by the legacy writer, ACD_APIs
 * AddressServiceImpl:198). The two id spaces overlap numerically, so reading it
 * as an efr_id does not fail — it silently shows one technician's position
 * under another's name. Test 4 asserts on the SQL itself, because that defect
 * is invisible in the returned shape.
 *
 * Runner: `node --test tests/job-location-legacy-fallback.test.js`.
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { installFakePool } = require('./helpers/fake-pool');

// Per-test canned rows. The routes below close over these, so a test just
// reassigns them — installFakePool is called ONCE, before the service captures
// its `pool` reference.
let jobTrackRows = [];
let legacyRows = [];

const fake = installFakePool([
  [/FROM\s+tbl_job_location_track/i, () => jobTrackRows],
  [/JOIN\s+location\s+l/i, () => legacyRows],
]);

const jobLocation = require('../services/job-location.service');

const EFR_ID = 7;
after(() => fake.restore());

beforeEach(() => {
  jobTrackRows = [];
  legacyRows = [];
  fake.reset();
});

/* The SQL the fake saw for each table. */
const jobTrackCalls = () => fake.calls.filter((c) => /tbl_job_location_track/i.test(c.sql));
const legacyCalls = () => fake.calls.filter((c) => /\blocation\s+l\b/i.test(c.sql));

test('tbl_job_location_track wins when it has a row (source=job_track)', async () => {
  jobTrackRows = [{
    id: 91, job_id: 42, efr_id: EFR_ID,
    latitude: 12.9716, longitude: 77.5946, accuracy: 14.5,
    captured_at: '2026-08-25 11:30:00',
  }];
  // Seeded too, to prove precedence rather than absence.
  legacyRows = [{ id: 5, current_location: '28.6139,77.2090', user_id: 555 }];

  const out = await jobLocation.getLatestByEfr(EFR_ID);

  assert.equal(out.source, 'job_track');
  assert.equal(out.latitude, 12.9716);
  assert.equal(out.longitude, 77.5946);
  assert.equal(out.accuracy, 14.5);
  assert.equal(out.captured_at, '2026-08-25 11:30:00');
  assert.equal(out.capturedAt, '2026-08-25 11:30:00');
  assert.equal(out.job_id, 42);
  // The legacy table is 2.5M MyISAM rows and this endpoint polls every 15s —
  // a hit on the modern table must not also pay for it.
  assert.equal(legacyCalls().length, 0, 'legacy table must not be queried when job_track hits');
});

test('falls back to the legacy row (source=legacy, capturedAt null)', async () => {
  legacyRows = [{ id: 5, current_location: '28.6139,77.2090', user_id: 555 }];

  const out = await jobLocation.getLatestByEfr(EFR_ID);

  assert.equal(out.source, 'legacy');
  assert.equal(out.latitude, 28.6139);
  assert.equal(out.longitude, 77.209);
  assert.equal(out.efr_id, EFR_ID);
  assert.equal(out.job_id, null);
  assert.equal(out.accuracy, null, 'legacy rows carry no accuracy');
  // NOT NOW(). These rows have no timestamp column at all, so their age is
  // unknown; substituting a server clock would render a possibly months-old
  // position as "just now".
  assert.equal(out.capturedAt, null);
  assert.equal(out.captured_at, null);
  assert.equal(jobTrackCalls().length, 1, 'modern table is still tried first');
});

test('malformed current_location yields no location, never NaN coordinates', async () => {
  // Free-text VARCHAR written by a legacy app with no format validation.
  const junk = ['notalatlng', '', '1,2,3', '12.9,', ',77.5', ' , ', null, 'lat,lng'];

  for (const current_location of junk) {
    fake.reset();
    legacyRows = [{ id: 5, current_location, user_id: 555 }];
    const out = await jobLocation.getLatestByEfr(EFR_ID);
    assert.equal(out, null, 'expected no location for current_location=' + JSON.stringify(current_location));
  }

  // And a well-formed one still parses, so the guard isn't rejecting everything.
  fake.reset();
  legacyRows = [{ id: 5, current_location: ' 19.0760 , 72.8777 ', user_id: 555 }];
  const ok = await jobLocation.getLatestByEfr(EFR_ID);
  assert.equal(ok.latitude, 19.076);
  assert.equal(ok.longitude, 72.8777);
});

test('legacy lookup resolves through tbl_user.user_id, NOT efr_id', async () => {
  legacyRows = [{ id: 5, current_location: '28.6139,77.2090', user_id: 555 }];
  await jobLocation.getLatestByEfr(EFR_ID);

  const [call] = legacyCalls();
  assert.ok(call, 'a legacy query must have been issued');
  const sql = call.sql.replace(/\s+/g, ' ');

  // Resolved via the technician's tbl_user FK (tbl_easyfixer.user_id) …
  assert.match(sql, /FROM tbl_easyfixer e/i);
  assert.match(sql, /JOIN location l ON l\.user_id = e\.user_id/i);
  // … and the efr_id is bound ONLY to tbl_easyfixer.
  assert.match(sql, /WHERE e\.efr_id = \?/i);
  assert.deepEqual(call.params, [EFR_ID]);

  // The defect this guards: efr_id bound straight to location.user_id, which
  // returns a DIFFERENT technician's position instead of failing.
  assert.doesNotMatch(sql, /l\.user_id = \?/i);
  assert.doesNotMatch(sql, /l\.efr_id/i);
  assert.doesNotMatch(sql, /location l ON l\.user_id = e\.efr_id/i);

  // Newest-first by the auto-increment PK — the only ordering signal the
  // timestamp-less table has.
  assert.match(sql, /ORDER BY l\.id DESC/i);
});

test('both sources empty returns the same no-location shape as before', async () => {
  const out = await jobLocation.getLatestByEfr(EFR_ID);
  assert.equal(out, null);
  assert.equal(jobTrackCalls().length, 1);
  assert.equal(legacyCalls().length, 1);
});
