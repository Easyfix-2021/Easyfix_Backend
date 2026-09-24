/*
 * tests/v4-revisit-pricing.test.js — additional work priced on a REVISIT
 * (V3 Phase 4, 4.3).
 *
 * A checkout with additional work still pending closes as a revisit (10): the
 * technician has left. Two rules make that job movable, and each fails
 * silently:
 *   1. The desk can PRICE it at 10. Without that the claim sat at "pricing"
 *      forever and visit 2 could never be scheduled.
 *   2. A client REJECTION returns it to 10, not to 2. Both reject paths
 *      hard-coded 2 ("back to the technician on site") — right for every
 *      estimate before this, wrong for one priced after he left. Every OTHER
 *      job must still reject to 2: that is the half a careless fix breaks.
 */
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const scenario = { pre: null };
const fake = installFakePool([
  [/pre_material|material_review/i, () => (scenario.pre == null ? [] : [{ status: scenario.pre, pre_material_status: scenario.pre, pre_status: scenario.pre }])],
]);
const approval = require('../services/job-estimate-approval');
const store = require('../services/material-review-store');

after(() => fake.restore());
beforeEach(() => { fake.calls.length = 0; scenario.pre = null; });

test('an estimate priced from a revisit (10) is rejected back to 10', async () => {
  const orig = store.getPreMaterialStatus;
  store.getPreMaterialStatus = async () => 10;
  try { assert.equal(await approval.estimateRejectStatus(42, null), 10); }
  finally { store.getPreMaterialStatus = orig; }
});

test('every other estimate still rejects to 2 — the existing behaviour', async () => {
  const orig = store.getPreMaterialStatus;
  try {
    for (const pre of [1, 2, 20, 16, null, undefined]) {
      store.getPreMaterialStatus = async () => pre;
      assert.equal(await approval.estimateRejectStatus(42, null), 2, 'pre=' + pre);
    }
  } finally { store.getPreMaterialStatus = orig; }
});

test('both reject paths ask the shared rule instead of hard-coding 2', () => {
  const fs = require('node:fs');
  for (const f of ['routes/client/index.js', 'routes/public/estimate.js']) {
    const src = fs.readFileSync(require('node:path').join(__dirname, '..', f), 'utf8');
    assert.match(src, /estimateRejectStatus\(/, f + ' no longer asks estimateRejectStatus');
    assert.doesNotMatch(src, /setStatus\([^)]*\{ status: 2 \}[^)]*\{ conn \}\)/, f + ' hard-codes the reject status again');
  }
});

test('the desk may price a revisit, and a priced revisit records where it came from', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'services/ops-desk.service.js'), 'utf8');
  assert.match(src, /const PRICEABLE_STATUSES = new Set\(\[[^\]]*\b10\b[^\]]*\]\)/, '10 is not priceable');
  assert.match(src, /const ENTERS_ESTIMATE = new Set\(\[[^\]]*\b10\b[^\]]*\]\)/,
    '10 does not store its pre-estimate status, so a rejection cannot find its way back');
});
