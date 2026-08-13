/*
 * Characterization tests for suggestZonesForLocation's use of pincode
 * coordinates.
 *
 * THE BUG THESE PIN (2026-08-13, same root cause as
 * tests/pincode-centroid-provenance.test.js). tbl_pincode.lat/lng is 98.5%
 * legacy-import data, wrong by tens to hundreds of km. This function read
 * those columns DIRECTLY, in two places:
 *
 *   1. the SQL prefilter — a ±1.5° bounding box on p.lat/p.lng, which decides
 *      WHICH zones are even considered;
 *   2. the ranking — haversine from the new pincode to each zone's nearest
 *      mapped pincode, which decides the ORDER they come back in.
 *
 * So a zone could be recalled because the import misplaced its pincodes into
 * the box, or missed because the import misplaced them out of it — and then
 * ordered by a distance computed from the same bad numbers. The operator sees
 * a confident "12.4 km" next to the wrong zone.
 *
 * The reference point is NOT affected: the Manage Pincodes add flow geocodes
 * the new pincode fresh and passes it in. Only the stored side was wrong,
 * which is why every assertion here is about the STORED pincodes.
 *
 * Non-destructive: fake pool, no real DB, no Google calls (the resolver is
 * stubbed at the module boundary).
 *
 * Runner: `node --test`.
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const SVC_PATH = '../services/pincode.service';
const GEO_PATH = '../services/pincode-geocode.service';

// The new pincode being added — freshly geocoded by the caller, so correct.
const POINT = { lat: 17.8437533, lng: 76.6181655 }; // 413606, Omerga

// Zone 1's mapped pincode is genuinely ~71 km away; zone 2's is ~300 km away.
// The legacy import has them the other way round, which is the whole point.
const TRUTH = {
  413006: { lat: 17.6480279, lng: 75.9811564 }, // near   (~71 km)
  411001: { lat: 18.5204303, lng: 73.8567437 }, // far    (~300 km, Pune)
};

const DEFAULTS = () => ({
  hasStamp: true,
  rows: [
    { zone_id: 1, zone_name: 'Solapur Zone', p_city_id: 9, pincode: '413006' },
    { zone_id: 2, zone_name: 'Pune Zone', p_city_id: 4, pincode: '411001' },
  ],
  lastSql: '',
  resolved: [],   // pincodes handed to the resolver
});
let scenario = DEFAULTS();

const fake = installFakePool([
  [/FROM tbl_zone_master z/i, (sql) => { scenario.lastSql = sql; return scenario.rows; }],
  [/FROM tbl_zone_master\s*\n?\s*WHERE zone_status/i, []],   // the random-fill pad
  [/ORDER BY RAND/i, []],
]);

// Stub the resolver at the module boundary — these tests are about whether the
// service ASKS it, not about the resolver's own behaviour (covered separately).
const geo = require(GEO_PATH);
const realGetCentroids = geo.getCentroids;
const realHasProvenance = geo.hasProvenanceColumn;
geo.getCentroids = async (pinsArg) => {
  scenario.resolved = [...pinsArg];
  return new Map(pinsArg.map((p) => [String(p), TRUTH[p] ?? null]));
};
geo.hasProvenanceColumn = async () => scenario.hasStamp;

const svc = require(SVC_PATH);

beforeEach(() => { scenario = DEFAULTS(); fake.reset(); });

after(() => {
  geo.getCentroids = realGetCentroids;
  geo.hasProvenanceColumn = realHasProvenance;
  fake.restore();
});

/* ═══ the ranking ═══════════════════════════════════════════════════════ */

test('distances come from the RESOLVER, not from the row the query returned', async () => {
  const out = await svc.suggestZonesForLocation({ lat: POINT.lat, lng: POINT.lng, limit: 2 });

  assert.deepEqual(scenario.resolved.sort(), ['411001', '413006'],
    'every candidate pincode must be resolved, not read off the row');

  const solapur = out.find((z) => z.zone_id === 1);
  const pune = out.find((z) => z.zone_id === 2);
  assert.ok(solapur.distance_km > 60 && solapur.distance_km < 85,
    `nearest zone should be ~71 km, got ${solapur.distance_km}`);
  assert.ok(pune.distance_km > 250, `far zone should be ~300 km, got ${pune.distance_km}`);
  assert.equal(out[0].zone_id, 1, 'and the nearer zone must rank first');
});

test('the query no longer SELECTs the untrusted coordinate columns', async () => {
  await svc.suggestZonesForLocation({ lat: POINT.lat, lng: POINT.lng });

  assert.match(scenario.lastSql, /p\.pincode/,
    'it selects the pincode so the resolver can be asked');
  assert.equal(/SELECT[^]*?p\.lat[^]*?FROM/i.test(scenario.lastSql), false,
    'p.lat must not be projected for ranking any more');
});

test('an unresolvable pincode yields NO distance — never the legacy fallback', async () => {
  scenario.rows = [{ zone_id: 3, zone_name: 'Mystery Zone', p_city_id: 9, pincode: '999999' }];

  const out = await svc.suggestZonesForLocation({ lat: POINT.lat, lng: POINT.lng, limit: 1 });

  assert.equal(out[0].distance_km, null,
    'a zone we cannot measure reports no distance rather than a made-up one');
});

/* ═══ the prefilter ═════════════════════════════════════════════════════ */

test('the bounding-box prefilter only matches coordinates we resolved ourselves', async () => {
  await svc.suggestZonesForLocation({ lat: POINT.lat, lng: POINT.lng });

  assert.match(scenario.lastSql, /coords_geocoded_at IS NOT NULL/,
    'recalling a zone via an unstamped row ranks it by where the legacy import '
    + 'THOUGHT its pincodes were — and can exclude a genuinely near zone just as easily');
});

test('PRE-MIGRATION the prefilter is unchanged — deploy order stays free', async () => {
  scenario.hasStamp = false;

  await svc.suggestZonesForLocation({ lat: POINT.lat, lng: POINT.lng });

  assert.equal(/coords_geocoded_at/.test(scenario.lastSql), false,
    'without the column there is nothing to filter on, and the SQL must still be valid');
  assert.match(scenario.lastSql, /p\.lat BETWEEN/, 'the box itself still applies');
});

/* ═══ the coordinate-free half must not regress ═════════════════════════ */

test('same-city ranking never needed coordinates and still does not', async () => {
  /*
   * This is the half that was always correct: city_id is an integer join, not
   * a coordinate. Worth pinning because the obvious refactor — "route
   * everything through the resolver" — would have made a city-only suggestion
   * depend on a geocode call it does not need.
   */
  const out = await svc.suggestZonesForLocation({ cityId: 9, limit: 2 });

  assert.deepEqual(scenario.resolved, [],
    'a city-only suggestion must not geocode anything');
  assert.equal(out[0].zone_id, 1);
  assert.equal(out[0].reason, 'same_city');
  assert.equal(out[0].distance_km, null, 'no point supplied means no distance to report');
});
