const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/*
 * GET /api/shared/lookup/pincodes — the technician app's Work Area
 * city → PIN picker.
 *
 * Three things have to hold, and all three are contract, not style:
 *
 *  (a) cityId is validated. This route is a per-city page; without a required
 *      positive cityId it degenerates into a full-catalogue dump.
 *  (b) The projected row is EXACTLY what the app parses, and nothing else.
 *      ApiLookupService.getCityPincodes reads pincode / city_name / district /
 *      state_name and the top-level `total`; every admin column the underlying
 *      Manage-Pincodes service also computes (pincode_id, LOCAL/TRAVEL mapping,
 *      active_efr_count, zone_count, lat/lng, zonal_manager_name, the creator
 *      audit trio) must NOT reach a technician JWT.
 *  (c) Non-serviceable pincodes are excluded. The fake pool below answers the
 *      real WHERE clause: it hands back the inactive row ONLY if the SQL failed
 *      to constrain pincode_status, so this fails loudly if the route ever
 *      starts passing includeInactive.
 *
 * Route handlers are exercised directly off router.stack (the house pattern —
 * see lms-action-routes.test.js) so the `router.use(requireAuth)` JWT layer
 * stays out of the way; the real Joi middleware still runs.
 */

const CITY_ID = 42;

// Raw tbl_pincode rows as the list query returns them, admin columns included.
const ACTIVE_ROWS = [
  {
    pincode_id: 11, pincode: '560001', location: 'MG Road', city_id: CITY_ID,
    city_name: 'Bengaluru', district: 'Bengaluru Urban', state_name: 'Karnataka',
    pincode_status: 1, lat: '12.9716', lng: '77.5946',
    zonal_manager_name: 'Zonal Ops', created_by: 8379, created_by_type: 'technician',
    created_by_name: 'A Technician',
  },
  {
    pincode_id: 12, pincode: '560002', location: 'Chickpet', city_id: CITY_ID,
    city_name: 'Bengaluru', district: 'Bengaluru Urban', state_name: 'Karnataka',
    pincode_status: 1, lat: null, lng: null,
    zonal_manager_name: null, created_by: null, created_by_type: null,
    created_by_name: null,
  },
];
const INACTIVE_ROW = {
  pincode_id: 13, pincode: '560999', location: 'Retired Area', city_id: CITY_ID,
  city_name: 'Bengaluru', district: 'Bengaluru Urban', state_name: 'Karnataka',
  pincode_status: 0, lat: null, lng: null,
  zonal_manager_name: null, created_by: null, created_by_type: null,
  created_by_name: null,
};

const serviceableOnly = (sql) => /p\.pincode_status = 1/.test(sql);

const fake = installFakePool([
  // Creator-audit columns absent → exercises the un-migrated projection path.
  [/SHOW COLUMNS FROM tbl_pincode/, []],
  // COUNT must be matched before the main SELECT: both name tbl_pincode.
  [/COUNT\(\*\) AS total/, (sql) => [{ total: serviceableOnly(sql) ? 7 : 8 }]],
  [/FROM tbl_pincode\s+p\s+LEFT JOIN tbl_city/, (sql) => (
    serviceableOnly(sql) ? ACTIVE_ROWS : [...ACTIVE_ROWS, INACTIVE_ROW]
  )],
  [/.*/, []],
]);

// eslint-disable-next-line global-require
const router = require('../routes/shared/lookup');

after(() => fake.restore());

function responseDouble() {
  const res = { statusCode: 200, body: null, locals: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

/** Run the real GET /pincodes chain (Joi middleware + handler) for one query. */
async function call(query) {
  const layer = router.stack.find(
    (l) => l.route && l.route.path === '/pincodes' && l.route.methods.get,
  );
  assert.ok(layer, 'GET /pincodes must be registered');
  const req = { method: 'GET', originalUrl: '/api/shared/lookup/pincodes', query };
  const res = responseDouble();
  for (const h of layer.route.stack) {
    let advanced = false;
    let failure = null;
    // eslint-disable-next-line no-await-in-loop
    await h.handle(req, res, (e) => { if (e) failure = e; else advanced = true; });
    if (failure) throw failure;
    if (!advanced) break;
  }
  return res;
}

// ─── (a) cityId is validated ─────────────────────────────────────────
for (const [label, query] of [
  ['missing',      {}],
  ['non-numeric',  { cityId: 'bengaluru' }],
  ['zero',         { cityId: 0 }],
  ['negative',     { cityId: -1 }],
  // The app clamps to CITY_PINCODE_PAGE_MAX = 50 before it sends; a larger
  // limit is a drifted client, not a page we should serve.
  ['over-limit',   { cityId: CITY_ID, limit: 500 }],
  ['negative offset', { cityId: CITY_ID, offset: -1 }],
]) {
  test(`(a) rejects ${label} cityId/bounds with 400`, async () => {
    const res = await call(query);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error, 'Validation failed');
  });
}

test('(a) applies the app defaults when only cityId is sent', async () => {
  const res = await call({ cityId: String(CITY_ID) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.limit, 50);
  assert.equal(res.body.data.offset, 0);
});

// ─── (b) projected shape matches what the app parses ─────────────────
const ADMIN_ONLY = [
  'pincode_id', 'location', 'is_active', 'status', 'active_efr_count',
  'zone_count', 'lat', 'lng', 'zonal_manager_name',
  'created_by', 'created_by_type', 'created_by_name',
];

test('(b) returns the five catalogue fields and no admin columns', async () => {
  const res = await call({ cityId: CITY_ID, limit: 2, offset: 0 });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);

  const { items, total, limit, offset } = res.body.data;
  assert.equal(total, 7);
  assert.equal(limit, 2);
  assert.equal(offset, 0);
  assert.equal(items.length, 2);

  for (const item of items) {
    assert.deepEqual(
      Object.keys(item).sort(),
      ['city_id', 'city_name', 'district', 'pincode', 'state_name'],
    );
    for (const leaked of ADMIN_ONLY) {
      assert.ok(!(leaked in item), `admin column "${leaked}" must not reach a technician`);
    }
  }
});

test('(b) survives the app parser: PINs, city, and the Load-more maths', async () => {
  const res = await call({ cityId: CITY_ID, limit: 2, offset: 0 });
  const raw = res.body.data;

  // Mirrors ApiLookupService.getCityPincodes: listOf() → raw.items, then
  // pick() across the accepted aliases, then the /^\d{6}$/ filter.
  const pick = (o, keys) => keys.map((k) => o[k]).find((v) => v !== undefined && v !== null && v !== '');
  const parsed = (Array.isArray(raw) ? raw : raw.items ?? raw.data ?? raw.rows ?? [])
    .map((o) => ({
      pincode: String(pick(o, ['pincode', 'pin_code', 'pinCode']) ?? ''),
      city: String(pick(o, ['city_name', 'cityName', 'city']) ?? ''),
      district: pick(o, ['district', 'district_name', 'districtName']) ?? null,
      state: pick(o, ['state', 'state_name', 'stateName']) ?? null,
    }))
    .filter((i) => /^\d{6}$/.test(i.pincode));

  assert.deepEqual(parsed.map((i) => i.pincode), ['560001', '560002']);
  assert.equal(parsed[0].city, 'Bengaluru');
  assert.equal(parsed[0].state, 'Karnataka');
  assert.equal(parsed[0].district, 'Bengaluru Urban');

  // The picker's hasMore: it reads the TOTAL off the envelope, not the page.
  const parsedTotal = Math.max(parsed.length, Number(pick(raw, ['total', 'count']) ?? parsed.length));
  assert.equal(parsedTotal, 7);
  assert.ok(parsed.length < parsedTotal, 'Load more must stay reachable');
});

// ─── (c) non-serviceable pincodes are excluded ───────────────────────
test('(c) excludes non-serviceable pincodes', async () => {
  fake.reset();
  const res = await call({ cityId: CITY_ID, limit: 50, offset: 0 });
  const codes = res.body.data.items.map((i) => i.pincode);

  assert.ok(!codes.includes('560999'), 'a non-serviceable PIN must never be offered as work area');
  assert.deepEqual(codes, ['560001', '560002']);

  const listSql = fake.calls
    .map((c) => c.sql)
    .find((sql) => /FROM tbl_pincode\s+p\s+LEFT JOIN tbl_city/.test(sql) && !/COUNT\(\*\)/.test(sql));
  assert.ok(listSql, 'the list query must have run');
  assert.match(listSql, /p\.pincode_status = 1/);
  // The count the picker pages against must carry the same filter.
  const countSql = fake.calls.map((c) => c.sql).find((sql) => /COUNT\(\*\) AS total/.test(sql));
  assert.match(countSql, /p\.pincode_status = 1/);
});
