/*
 * Characterization tests for the tbl_pincode centroid cache.
 *
 * THE BUG THESE PIN (2026-08-13). The cache treated "lat/lng IS NOT NULL" as
 * "we already resolved this", because the migration that added the columns
 * assumed nothing else ever wrote them. The legacy pincode master import HAD
 * written them, and its values are wrong by tens to hundreds of kilometres:
 *
 *     PIN     stored            Google (truth)     error
 *     413006  18.5571, 75.2560  17.6480, 75.9812   126.9 km
 *     413606  20.7167, 75.5500  17.8438, 76.6182   338.6 km
 *
 * 413006 → 413606 measured 242.1 km from the stored pair against 80.6 km of
 * real road. 10,889 of 11,024 populated rows carried those legacy values, and
 * the lazy backfill could never correct one because it only filled NULLs.
 *
 * WHY A PLAUSIBILITY CHECK CANNOT REPLACE PROVENANCE, and why the third test
 * matters most: both bad coordinates are valid latitudes and longitudes inside
 * India. A bounding box passes them. A range check passes them. Only the
 * question "did WE geocode this" separates them, which is what the
 * coords_geocoded_at stamp records.
 *
 * The distances asserted here are computed by the module under test, so a
 * regression in the haversine would surface too — though the haversine was
 * verified correct during the investigation (77.8 km straight-line for a pair
 * 80.6 km apart by road); the inputs were the fault, not the formula.
 *
 * Non-destructive: fake pool, stubbed fetch, no real DB and no Google calls.
 * The provenance probe is memoised per process, so each scenario re-requires
 * the service with a fresh module-registry entry (same technique as
 * tests/job-primary-spoc-head.test.js).
 *
 * Runner: `node --test`.
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const SVC_PATH = '../services/pincode-geocode.service';

const JOB_PIN = '413606';
const TECH_PIN = '413006';

// What the legacy import left in tbl_pincode.
const LEGACY = {
  413006: { lat: '18.5571000', lng: '75.2560000' },
  413606: { lat: '20.7167000', lng: '75.5500000' },
};
// What Google actually returns for the same PINs.
const TRUTH = {
  413006: { lat: 17.6480279, lng: 75.9811564 },
  413606: { lat: 17.8437533, lng: 76.6181655 },
};

const DEFAULTS = () => ({
  hasProvenanceColumn: true,
  stampedPins: new Set(),   // PINs whose coords_geocoded_at is set
  geocoded: [],             // PINs Google was asked for
  inFlight: 0,
  maxInFlight: 0,
  fetchRejects: null,       // when set, the stub throws this instead of answering
  sawSignal: false,         // did the caller pass an AbortSignal?
});
let scenario = DEFAULTS();

const fake = installFakePool([
  [/INFORMATION_SCHEMA\.COLUMNS/i, () => [{ n: scenario.hasProvenanceColumn ? 1 : 0 }]],
  [/SELECT pincode, lat, lng/i, (_sql, params) => (params || []).map((p) => {
    const row = { pincode: p, ...LEGACY[p] };
    // Only include the stamp column when the migration is "applied", so the
    // pre-migration case really does see a row without the field.
    if (scenario.hasProvenanceColumn) {
      row.coords_geocoded_at = scenario.stampedPins.has(p) ? new Date('2026-08-13T10:00:00+05:30') : null;
    }
    return row;
  })],
  [/UPDATE tbl_pincode SET lat/i, []],
]);

/*
 * getCentroids short-circuits every miss to null when GOOGLE_MAPS_API_KEY is
 * unset — no call, no error, just blank distances. Without this the suite
 * would "pass" the cache-miss tests for the wrong reason on any machine that
 * happens to lack the key.
 */
const realKey = process.env.GOOGLE_MAPS_API_KEY;
process.env.GOOGLE_MAPS_API_KEY = 'test-key-not-used-fetch-is-stubbed';

const realFetch = global.fetch;
global.fetch = async (url, init) => {
  // geocodeOne builds the components param through encodeURIComponent, so the
  // colon arrives as %3A. Match both forms rather than the pretty one.
  const pin = String(url).match(/postal_code(?::|%3A)(\d{6})/i)?.[1];
  assert.ok(pin, `stub could not read a pincode out of the geocode URL: ${url}`);
  scenario.sawSignal = !!init?.signal;
  scenario.geocoded.push(pin);
  if (scenario.fetchRejects) {
    // Stand-in for the AbortSignal firing: undici rejects the fetch promise.
    const e = new Error(scenario.fetchRejects);
    e.name = 'TimeoutError';
    throw e;
  }
  scenario.inFlight += 1;
  scenario.maxInFlight = Math.max(scenario.maxInFlight, scenario.inFlight);
  await new Promise((r) => setTimeout(r, 5)); // hold the slot so overlap is observable
  scenario.inFlight -= 1;
  return {
    json: async () => ({
      status: 'OK',
      results: [{ geometry: { location: TRUTH[pin] || { lat: 1, lng: 1 } } }],
    }),
  };
};

let geo = require(SVC_PATH);
function reloadSvc() {
  delete require.cache[require.resolve(SVC_PATH)];
  geo = require(SVC_PATH);
}

beforeEach(() => {
  scenario = DEFAULTS();
  fake.reset();
  reloadSvc();          // clears the memoised probe AND the in-process memo cache
});

after(() => {
  delete require.cache[require.resolve(SVC_PATH)];
  global.fetch = realFetch;
  if (realKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
  else process.env.GOOGLE_MAPS_API_KEY = realKey;
  fake.restore();
});

/* ═══ the fix ═══════════════════════════════════════════════════════════ */

test('an UNSTAMPED row is a cache MISS — legacy coordinates are never served', async () => {
  const m = await geo.getCentroids([TECH_PIN, JOB_PIN]);

  assert.deepEqual(scenario.geocoded.sort(), [TECH_PIN, JOB_PIN].sort(),
    'both legacy rows must be re-geocoded, not trusted');
  // The returned value is Google's, not the import's.
  assert.equal(m.get(TECH_PIN).lat, TRUTH[TECH_PIN].lat);
  assert.equal(m.get(JOB_PIN).lat, TRUTH[JOB_PIN].lat);

  const km = geo.haversineKm(m.get(TECH_PIN), m.get(JOB_PIN));
  assert.ok(km > 60 && km < 90,
    `413006→413606 should land near the 80.6 km road distance, got ${km.toFixed(1)}`);
  // And emphatically NOT the number the bug produced.
  assert.ok(km < 150, `must not reproduce the 242 km legacy answer, got ${km.toFixed(1)}`);
});

test('the corrected value is written back WITH its provenance stamp', async () => {
  await geo.getCentroids([TECH_PIN]);

  const write = fake.calls.find((c) => /UPDATE tbl_pincode SET lat/i.test(c.sql));
  assert.ok(write, 'the resolved centroid must be persisted');
  assert.match(write.sql, /coords_geocoded_at = \?/,
    'writing the coordinate without the stamp would re-geocode this PIN forever');
  assert.ok(write.params.some((p) => p instanceof Date),
    'the stamp is a JS Date so the pool serialises it as IST wall-clock, not NOW()');
});

test('a STAMPED row is served from cache — no Google call', async () => {
  scenario.stampedPins = new Set([TECH_PIN, JOB_PIN]);

  const m = await geo.getCentroids([TECH_PIN, JOB_PIN]);

  assert.deepEqual(scenario.geocoded, [], 'a self-geocoded row must not be re-fetched');
  assert.equal(Number(m.get(TECH_PIN).lat), Number(LEGACY[TECH_PIN].lat),
    'stamped rows are trusted verbatim — that is what makes this a cache');
});

/* ═══ the safe fallback ═════════════════════════════════════════════════ */

test('PRE-MIGRATION the behaviour is unchanged — legacy coords still trusted', async () => {
  /*
   * This one is deliberately asserting the OLD, WRONG answer.
   *
   * Deploy order must not matter. If the code shipped before the migration and
   * treated every row as a miss, it would geocode every pincode on every render
   * AND fail to persist (no column to stamp) — an unbounded Google bill, to fix
   * a number that is merely wrong. Degrading to today's behaviour is the lesser
   * failure, so the fix switches on when the migration lands, not before.
   */
  scenario.hasProvenanceColumn = false;
  reloadSvc();

  const m = await geo.getCentroids([TECH_PIN, JOB_PIN]);

  assert.deepEqual(scenario.geocoded, [], 'no column means no new behaviour, and no new spend');
  const km = geo.haversineKm(m.get(TECH_PIN), m.get(JOB_PIN));
  assert.ok(km > 200, `pre-migration still shows the legacy answer, got ${km.toFixed(1)}`);
});

/* ═══ the real-time path must stay bounded ══════════════════════════════ */

test('the geocode call carries an abort signal — a hanging Google cannot hold the render', async () => {
  await geo.getCentroids([TECH_PIN]);
  assert.ok(scenario.sawSignal,
    'fetch must be given an AbortSignal; node has no useful default request timeout, '
    + 'and this now runs inline on the Schedule & Assign render');
});

test('a timed-out geocode yields NO distance rather than a wrong one', async () => {
  /*
   * The whole point of the provenance change is to stop showing confident
   * wrong numbers. A failed lookup must therefore produce null — which the UI
   * renders as '—' — and must NOT fall back to the legacy coordinate it just
   * refused to trust, or write anything to the row.
   */
  scenario.fetchRejects = 'The operation was aborted due to timeout';

  const m = await geo.getCentroids([TECH_PIN, JOB_PIN]);

  assert.equal(m.get(TECH_PIN), null, 'a timeout is a missing distance, not a legacy one');
  assert.equal(m.get(JOB_PIN), null);
  assert.equal(geo.haversineKm(m.get(TECH_PIN), m.get(JOB_PIN)), null,
    'haversine of a null point is null, so the column renders blank');
  assert.equal(fake.calls.filter((c) => /UPDATE tbl_pincode SET lat/i.test(c.sql)).length, 0,
    'nothing may be persisted or stamped when the lookup failed');
});

/* ═══ cold-start blast radius ═══════════════════════════════════════════ */

test('the geocode fan-out is bounded — a wide candidate list cannot storm Google', async () => {
  /*
   * Provenance-gating changes the cold-start shape: until a PIN is resolved
   * once, EVERY distinct reference pincode in a candidate list is a miss. The
   * old unbounded Promise.all would open one connection per technician at once
   * and risk OVER_QUERY_LIMIT — which fails soft to null, i.e. blank distances
   * instead of wrong ones. Better, but still not the answer.
   */
  const pins = Array.from({ length: 40 }, (_, i) => String(400001 + i));

  const m = await geo.getCentroids(pins);

  assert.equal(m.size, 40, 'every PIN still resolves');
  assert.equal(scenario.geocoded.length, 40);
  assert.ok(scenario.maxInFlight <= 8,
    `at most 8 concurrent Google calls, saw ${scenario.maxInFlight}`);
  assert.ok(scenario.maxInFlight > 1, 'but still concurrent — a serial warm-up would be glacial');
});
