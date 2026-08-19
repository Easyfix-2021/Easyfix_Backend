/*
 * Characterization tests for services/pincode-coverage.service.js — the ONE
 * definition of "is this pincode serviceable", shared by Settings → Manage
 * Pincodes and the TAT engine's Local/Travel classification.
 *
 * The headline case is the SPACE BUG. Manage Pincodes previously ran
 * `FIND_IN_SET(p.pincode, sp.pincodes)` with no normalisation, so a CSV saved
 * as '560001, 560002' — typed the natural way — made FIND_IN_SET search for
 * ' 560002' WITH a leading space and find nothing. Every entry after the first
 * was invisible. Candidate ranking stripped the spaces; Manage Pincodes did
 * not, so the screen showed pincodes as Non-Serviceable that the allocation
 * engine was assigning work in.
 *
 * Uses the fake-pool seam — no DB.
 *
 * Runner: `node --test tests/pincode-coverage.test.js`
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

// Mutable scenario the fake answers from.
const scenario = { home: [], csv: [] };
let homeQueries = 0;
let csvQueries = 0;

// Route on the FIRST table each query reads. The serviceable query also
// mentions tbl_easyfixer (it joins for the status flags), so its route must be
// checked FIRST or it would be swallowed by the home-pincode route.
installFakePool([
  [/FROM\s+tbl_efr_serviceable_pincodes/i, () => { csvQueries += 1; return scenario.csv; }],
  [/FROM\s+tbl_easyfixer\b/i, () => { homeQueries += 1; return scenario.home; }],
]);

/* Rows come back with status flags now — the cache serves both the strict
 * (active + verified) and permissive questions from one read. */
const ACTIVE = { efr_status: 1, is_technician_verified: 1 };

const coverage = require('../services/pincode-coverage.service');

beforeEach(() => {
  scenario.home = [];
  scenario.csv = [];
  homeQueries = 0;
  csvQueries = 0;
  coverage.invalidateCoverage();
});

// ─── The space bug ───────────────────────────────────────────────────

test('a CSV with spaces after the commas covers EVERY entry, not just the first', async () => {
  scenario.csv = [{ efr_id: 1, pincodes: '560001, 560002, 560003', ...ACTIVE }];
  const covered = await coverage.getCoveredPincodes(['560001', '560002', '560003']);
  assert.equal(covered.size, 3, 'all three must be covered — this is the bug that hid entries 2..n');
  for (const p of ['560001', '560002', '560003']) {
    assert.ok(covered.has(p), `${p} must be covered`);
  }
});

test('internal and trailing spaces are stripped, matching REPLACE(csv, \' \', \'\')', async () => {
  scenario.csv = [{ efr_id: 1, pincodes: ' 56 0001 ,560002 ', ...ACTIVE }];
  const covered = await coverage.getCoveredPincodes(['560001', '560002']);
  assert.ok(covered.has('560001'), 'internal spaces are removed, exactly as REPLACE does');
  assert.ok(covered.has('560002'));
});

// ─── The two sources ─────────────────────────────────────────────────

test('a technician who LIVES in a pincode covers it, even with no serviceable list', async () => {
  // This is the half Manage Pincodes ignored entirely.
  scenario.home = [{ efr_id: 1, pin: '110001', ...ACTIVE }];
  const covered = await coverage.getCoveredPincodes(['110001']);
  assert.ok(covered.has('110001'));
});

test('a pincode with neither a resident nor a servicer is NOT covered', async () => {
  scenario.home = [{ efr_id: 1, pin: '110001', ...ACTIVE }];
  scenario.csv = [{ efr_id: 2, pincodes: '560001', ...ACTIVE }];
  const covered = await coverage.getCoveredPincodes(['999999']);
  assert.equal(covered.size, 0);
});

test('both sources are unioned, not intersected', async () => {
  scenario.home = [{ efr_id: 1, pin: '110001', ...ACTIVE }];
  scenario.csv = [{ efr_id: 2, pincodes: '560001', ...ACTIVE }];
  const covered = await coverage.getCoveredPincodes(['110001', '560001']);
  assert.equal(covered.size, 2);
});

// ─── Input hygiene ───────────────────────────────────────────────────

test('malformed pincodes are dropped, not reported as uncovered', async () => {
  // A 5-digit or null pincode is UNKNOWABLE, not un-serviced. Returning it as
  // "not covered" would silently classify those jobs as Travel.
  scenario.csv = [{ efr_id: 1, pincodes: '560001', ...ACTIVE }];
  const covered = await coverage.getCoveredPincodes([null, '', '5600', 'abcdef', '5600011', '560001']);
  assert.deepEqual([...covered], ['560001']);
});

test('an empty request short-circuits without touching the DB', async () => {
  const covered = await coverage.getCoveredPincodes([]);
  assert.equal(covered.size, 0);
  assert.equal(homeQueries + csvQueries, 0, 'no query may run for an empty ask');
});

// ─── The performance property ────────────────────────────────────────

test('cost is TWO queries regardless of how many pincodes are asked about', async () => {
  // The whole point of the rewrite. The previous shape correlated an EXISTS on
  // each pincode, so 500 uncovered pincodes meant 500 full scans of a ~30k-row
  // table. Here the supply side is read once and intersected in JS.
  scenario.csv = [{ efr_id: 1, pincodes: '560001,560002', ...ACTIVE }];
  const many = Array.from({ length: 500 }, (_, i) => String(500000 + i));
  await coverage.getCoveredPincodes([...many, '560001']);
  assert.equal(homeQueries, 1, 'one flat pass for resident technicians');
  assert.equal(csvQueries, 1, 'one flat pass for serviceable lists');
});

test('a second call inside the TTL is served from cache — no extra queries', async () => {
  scenario.csv = [{ efr_id: 1, pincodes: '560001', ...ACTIVE }];
  await coverage.getCoveredPincodes(['560001']);
  await coverage.getCoveredPincodes(['560002']);
  assert.equal(homeQueries, 1, 'the supply side is not re-read for a second question');
  assert.equal(csvQueries, 1);
});

test('invalidateCoverage forces a re-read — a new technician shows up immediately', async () => {
  scenario.csv = [{ pincodes: '560001' }];
  await coverage.getCoveredPincodes(['560001']);
  scenario.csv = [{ efr_id: 1, pincodes: '560001,560002', ...ACTIVE }];

  let covered = await coverage.getCoveredPincodes(['560002']);
  assert.equal(covered.size, 0, 'still cached, so the new pincode is not visible yet');

  coverage.invalidateCoverage();
  covered = await coverage.getCoveredPincodes(['560002']);
  assert.equal(covered.size, 1, 'after invalidation the new coverage is picked up');
});

// ─── isCovered convenience ───────────────────────────────────────────

test('isCovered answers the single-pincode question off the same cache', async () => {
  scenario.csv = [{ efr_id: 1, pincodes: '560001', ...ACTIVE }];
  assert.equal(await coverage.isCovered('560001'), true);
  assert.equal(await coverage.isCovered('999999'), false);
  assert.equal(homeQueries, 1, 'both answers came from one read');
});

// ─── Technician-level answers (zone.service's question) ──────────────

test('getTechnicianIdsForPincodes returns WHO covers, not just whether', async () => {
  scenario.home = [{ efr_id: 10, pin: '110001', ...ACTIVE }];
  scenario.csv = [
    { efr_id: 20, pincodes: '110001, 110002', ...ACTIVE },
    { efr_id: 30, pincodes: '560001', ...ACTIVE },
  ];
  const ids = await coverage.getTechnicianIdsForPincodes(['110001']);
  assert.deepEqual([...ids].sort((a, b) => a - b), [10, 20],
    'both the resident and the servicer — and NOT the one covering a different pincode');
});

test('an inactive or unverified technician does not make a pincode serviceable', async () => {
  scenario.csv = [
    { efr_id: 40, pincodes: '700001', efr_status: 0, is_technician_verified: 1 },
    { efr_id: 41, pincodes: '700001', efr_status: 1, is_technician_verified: 0 },
  ];
  assert.equal((await coverage.getCoveredPincodes(['700001'])).size, 0,
    'serviceable must mean DISPATCHABLE');
  assert.equal((await coverage.getTechnicianIdsForPincodes(['700001'])).size, 0);
});

test('activeOnly:false includes everyone — the zone-membership opt-out', async () => {
  scenario.csv = [{ efr_id: 40, pincodes: '700001', efr_status: 0, is_technician_verified: 0 }];
  const strict = await coverage.getTechnicianIdsForPincodes(['700001']);
  const loose = await coverage.getTechnicianIdsForPincodes(['700001'], { activeOnly: false });
  assert.equal(strict.size, 0);
  assert.deepEqual([...loose], [40]);
  assert.equal(homeQueries, 1, 'both questions answered from ONE cached read');
});

test('a technician is counted once even when several of their pincodes match', async () => {
  scenario.csv = [{ efr_id: 50, pincodes: '560001,560002,560003', ...ACTIVE }];
  const ids = await coverage.getTechnicianIdsForPincodes(['560001', '560002', '560003']);
  assert.deepEqual([...ids], [50]);
});
