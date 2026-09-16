/*
 * WHY THIS FILE EXISTS.
 *
 * attachOfferEfrs (services/job.service.js) feeds the Manage Jobs "Tx name" cell
 * for a job with no fk_easyfixter_id. It first returned OFFERED *and* ACCEPTED
 * rows, and the CRM let an accepted row win. But acceptOffer sets
 * fk_easyfixter_id in the same transaction, so a live accept never reaches that
 * cell — the only ACCEPTED row on a technician-less job is stale: a reassign
 * (releaseOwnedJobForReoffer → applyUnassignLocked) clears fk_easyfixter_id and
 * moves only OFFERED rows, leaving the old accepter's row ACCEPTED. The cell
 * then named a technician who no longer held the job and hid the live
 * "Offered to Tx" chip (pre-Production review, 2026-09-15).
 *
 * Source-shape guard: the query must select OFFERED rows only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'services/job.service.js'), 'utf8');
const fn = (src.match(/async function attachOfferEfrs\(rows\) \{[\s\S]*?\n\}/) || [''])[0];

test('attachOfferEfrs exists and is still called from list()', () => {
  assert.ok(fn, 'attachOfferEfrs must exist');
  assert.match(src, /await attachOfferEfrs\(rows\);/);
});

test('attachOfferEfrs selects OFFERED rows only — never ACCEPTED', () => {
  assert.match(fn, /AND jo\.offer_status = \$\{OFFER_STATUS\.OFFERED\}/);
  assert.doesNotMatch(fn, /OFFER_STATUS\.ACCEPTED/, 'an ACCEPTED row on a technician-less job is stale');
});

test('the lookup stays one batched, parameterised query per page', () => {
  assert.match(fn, /WHERE jo\.job_id IN \(\$\{ids\.map\(\(\) => '\?'\)\.join\(','\)\}\)/);
  assert.equal((fn.match(/pool\.query\(/g) || []).length, 1);
});
