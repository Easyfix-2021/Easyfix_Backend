/*
 * Unit tests — Manage Pincodes, the LOCAL / TRAVEL ("Mapping") filter.
 *
 * The filter used to run in JS over the page LIMIT/OFFSET had ALREADY cut, and
 * `total` was counted before it ran. Both halves were wrong the same way: a
 * 50-row page could render 3 rows under a pager still reading "Showing 1–50 of
 * 1,864", and the only number on screen never moved — so the filter looked
 * like it did nothing at all. That is what was reported.
 *
 * What these tests guard, worst-first:
 *
 *   1. THE FILTER IS IN THE QUERY. Both the page query and the COUNT must carry
 *      it, with the same params. A filter on one and not the other is the
 *      original bug in a new place: rows and total describing different sets.
 *   2. NO POST-PAGINATION FILTERING SURVIVES. Every row the SQL returned must
 *      come back — dropping one here means the page is short of its page size
 *      and the pager is lying again.
 *   3. TRAVEL IS THE COMPLEMENT OF LOCAL, and "no coverage at all" resolves to
 *      nothing-is-LOCAL rather than to an empty IN () — which is a SQL syntax
 *      error, not an empty result.
 *   4. THE ROW'S OWN LABEL STILL AGREES WITH THE FILTER THAT SELECTED IT.
 *
 * No DB: the shared pool singleton is faked BEFORE the services load.
 *
 * Runner: `node --test`.
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { installFakePool } = require('./helpers/fake-pool');

const S = { pincodes: [], total: 0, home: [], csv: [], zones: [] };

const fake = installFakePool([
  // Coverage supply — what makes a pincode LOCAL.
  [/FROM tbl_easyfixer\s*\n\s*WHERE efr_pin_no/, () => S.home],
  [/FROM tbl_efr_serviceable_pincodes/, () => S.csv],
  // id → code resolution for the per-row LOCAL/TRAVEL label. Unaliased, so it
  // must be routed BEFORE the aliased list query below or it falls through and
  // every row silently labels TRAVEL.
  [/SELECT pincode_id, pincode FROM tbl_pincode/,
    () => S.pincodes.map((r) => ({ pincode_id: r.pincode_id, pincode: r.pincode }))],
  // The list's own two statements.
  [/SELECT COUNT\(\*\) AS total\s*\n\s*FROM tbl_pincode/, () => [{ total: S.total }]],
  [/FROM tbl_pincode\s+p/, () => S.pincodes],
  [/FROM tbl_zone_pincode_mapping/, () => S.zones],
  // hasPincodeCreatorCol() and any other probe: no rows = column absent.
]);
after(() => fake.restore());

const pin = require('../services/pincode.service');
const coverage = require('../services/pincode-coverage.service');

/** One tbl_pincode row as the list query projects it. */
const row = (pincode, over = {}) => ({
  pincode_id: Number(pincode), pincode, location: 'X', city_id: 1, city_name: 'C',
  district: 'D', state_name: 'S', pincode_status: 1, lat: null, lng: null,
  zonal_manager_name: null, created_by: null, created_by_type: null, created_by_name: null,
  ...over,
});

beforeEach(() => {
  fake.reset();
  coverage.invalidateCoverage();
  // 560001 is covered by a dispatchable technician; 560002 is not.
  S.home = [{ efr_id: 1, pin: '560001', efr_status: 1, is_technician_verified: 1 }];
  S.csv = [];
  S.pincodes = [row('560001'), row('560002')];
  S.total = 2;
  S.zones = [];
});

/** The list's page query and its COUNT, as the fake saw them. */
function listStatements() {
  const page = fake.calls.find((c) => /FROM tbl_pincode\s+p/.test(c.sql) && /LIMIT \? OFFSET \?/.test(c.sql));
  const count = fake.calls.find((c) => /SELECT COUNT\(\*\) AS total/.test(c.sql));
  return { page, count };
}

test('LOCAL narrows BOTH the page query and the COUNT, with the same params', async () => {
  await pin.listPincodes({ status: 'LOCAL' });
  const { page, count } = listStatements();
  assert.ok(page && count, 'both statements must run');
  assert.match(page.sql, /TRIM\(p\.pincode\) IN \(\?\)/, 'the page must be narrowed in SQL, not in JS afterwards');
  assert.match(count.sql, /TRIM\(p\.pincode\) IN \(\?\)/, 'a total that ignores the filter is the original bug');
  // The page carries limit+offset after the filter params; the count carries the
  // filter params alone. The FILTER half of each must be identical.
  assert.deepEqual(count.params, ['560001']);
  assert.deepEqual(page.params.slice(0, count.params.length), count.params);
});

test('TRAVEL is the complement — NOT IN, same covered set', async () => {
  await pin.listPincodes({ status: 'TRAVEL' });
  const { page, count } = listStatements();
  assert.match(page.sql, /TRIM\(p\.pincode\) NOT IN \(\?\)/);
  assert.match(count.sql, /TRIM\(p\.pincode\) NOT IN \(\?\)/);
  assert.deepEqual(count.params, ['560001']);
});

test('no filter adds no predicate', async () => {
  await pin.listPincodes({});
  const { page, count } = listStatements();
  assert.doesNotMatch(page.sql, /TRIM\(p\.pincode\)/);
  assert.doesNotMatch(count.sql, /TRIM\(p\.pincode\)/);
});

test('the coverage supply is read ONCE per list, not once per asker', async () => {
  // Two consumers want it on a filtered list — the WHERE clause and the per-row
  // LOCAL/TRAVEL label. They share the coverage module's cache; a second read
  // here would mean the cache stopped working and every page pays twice.
  await pin.listPincodes({ status: 'LOCAL' });
  const supplyReads = fake.calls.filter((c) => /FROM tbl_efr_serviceable_pincodes/.test(c.sql)).length;
  assert.equal(supplyReads, 1, `coverage supply read ${supplyReads} times`);
});

test('every row the SQL returned is returned — nothing is dropped after pagination', async () => {
  // Deliberately inconsistent fixture: the SQL "matched" a pincode the coverage
  // set does not cover. A surviving JS filter would silently drop it and hand
  // back a short page under a full-page total.
  S.pincodes = [row('560001'), row('560002')];
  const out = await pin.listPincodes({ status: 'LOCAL' });
  assert.equal(out.items.length, 2, 'the page must not be re-filtered after LIMIT');
  assert.equal(out.total, 2);
});

test('the row label still agrees with the filter that selected it', async () => {
  const out = await pin.listPincodes({ status: 'LOCAL' });
  const byCode = new Map(out.items.map((i) => [i.pincode, i.status]));
  assert.equal(byCode.get('560001'), 'LOCAL', 'covered by a dispatchable technician');
  assert.equal(byCode.get('560002'), 'TRAVEL', 'not covered — the label is computed, not assumed from the filter');
});

test('an unverified or inactive technician grants no coverage — LOCAL then matches nothing', async () => {
  S.home = [{ efr_id: 1, pin: '560001', efr_status: 1, is_technician_verified: 0 }];
  await pin.listPincodes({ status: 'LOCAL' });
  const { page, count } = listStatements();
  // '1=0', never 'IN ()' — an empty IN list is a syntax error, not an empty set.
  assert.match(page.sql, /1=0/);
  assert.doesNotMatch(page.sql, /IN \(\)/);
  assert.match(count.sql, /1=0/);
});

test('with no coverage at all, TRAVEL still matches everything', async () => {
  S.home = [];
  S.csv = [];
  await pin.listPincodes({ status: 'TRAVEL' });
  const { page } = listStatements();
  assert.doesNotMatch(page.sql, /1=0/);
  assert.doesNotMatch(page.sql, /NOT IN/);
});
