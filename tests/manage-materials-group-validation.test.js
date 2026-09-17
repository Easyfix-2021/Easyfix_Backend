/*
 * services/material.service.js::validateGroupsPayload — the server-side
 * enforcement of the FIXED/DYNAMIC group rules from the Manage Materials
 * contract, as amended by the QA-fixes round (Decision A: "No Brand"
 * pricing replaces the old "Not Applicable" system brand).
 *
 * validateGroupsPayload is pure now — it no longer looks up any system
 * brand — so this file needs no fake pool at all.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateGroupsPayload } = require('../services/material.service');

async function rejects422(promise, messageSubstr) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.status, 422, `expected 422, got ${e.status}: ${e.message}`);
    if (messageSubstr) assert.ok(e.message.includes(messageSubstr), `"${e.message}" should include "${messageSubstr}"`);
    return true;
  });
}

test('FIXED with zero groups is rejected', async () => {
  await rejects422(validateGroupsPayload('FIXED', []), 'at least one price group');
});

test('FIXED group with NULL price is rejected on a UI save (allowNullPrice=false)', async () => {
  await rejects422(
    validateGroupsPayload('FIXED', [{ price: null, brand_ids: [1], states: [] }]),
    'requires a price'
  );
});

test('FIXED group with NULL price is ALLOWED on import (allowNullPrice=true)', async () => {
  await assert.doesNotReject(
    validateGroupsPayload('FIXED', [{ price: null, brand_ids: [1], states: [] }], { allowNullPrice: true })
  );
});

test('a brand repeated across groups on the same material is rejected', async () => {
  await rejects422(
    validateGroupsPayload('FIXED', [
      { price: 100, brand_ids: [1], states: [] },
      { price: 200, brand_ids: [1, 2], states: [] },
    ]),
    'repeat across price groups'
  );
});

test('a brand repeated within one group is rejected', async () => {
  await rejects422(
    validateGroupsPayload('FIXED', [{ price: 100, brand_ids: [1, 1], states: [] }]),
    'repeat within one price group'
  );
});

test('DYNAMIC carrying groups is rejected', async () => {
  await rejects422(
    validateGroupsPayload('DYNAMIC', [{ price: 100, brand_ids: [1], states: [] }]),
    'cannot carry price groups'
  );
});

test('DYNAMIC with zero groups is ALLOWED', async () => {
  await assert.doesNotReject(validateGroupsPayload('DYNAMIC', []));
});

test('a state repeated inside one group (two entries) is rejected', async () => {
  await rejects422(
    validateGroupsPayload('FIXED', [{
      price: 100, brand_ids: [1],
      states: [
        { price: 10, state_ids: [5] },
        { price: 20, state_ids: [5] },
      ],
    }]),
    'state cannot repeat'
  );
});

test('a state repeated inside one state-price entry is rejected', async () => {
  await rejects422(
    validateGroupsPayload('FIXED', [{
      price: 100, brand_ids: [1],
      states: [{ price: 10, state_ids: [5, 5] }],
    }]),
    'state cannot repeat'
  );
});

test('a well-formed FIXED payload with state overrides passes', async () => {
  await assert.doesNotReject(validateGroupsPayload('FIXED', [{
    price: 100, brand_ids: [1, 2],
    states: [{ price: 120, state_ids: [5, 6] }],
  }]));
});

// ─── Decision A: "No Brand" mode ─────────────────────────────────────────

test('a No Brand group (brand_ids: []) as the SOLE group is ALLOWED with a price', async () => {
  await assert.doesNotReject(
    validateGroupsPayload('FIXED', [{ price: 455, brand_ids: [], states: [] }])
  );
});

test('a No Brand group as the sole group is ALLOWED with a NULL price on a UI save', async () => {
  await assert.doesNotReject(
    validateGroupsPayload('FIXED', [{ price: null, brand_ids: [], states: [] }])
  );
});

test('a negative No Brand price is still rejected even though NULL is allowed', async () => {
  await rejects422(
    validateGroupsPayload('FIXED', [{ price: -5, brand_ids: [], states: [] }]),
    '>= 0'
  );
});

test('a brand group (brand_ids: [n]) still requires a non-null price on a UI save', async () => {
  await rejects422(
    validateGroupsPayload('FIXED', [{ price: null, brand_ids: [1], states: [] }]),
    'requires a price'
  );
});

test('a No Brand group plus a brand group is rejected 422 with the mixing message', async () => {
  await rejects422(
    validateGroupsPayload('FIXED', [
      { price: 100, brand_ids: [], states: [] },
      { price: 200, brand_ids: [1], states: [] },
    ]),
    'cannot mix No Brand pricing with brand prices'
  );
});

test('a brand group plus a No Brand group (reverse order) is also rejected 422', async () => {
  await rejects422(
    validateGroupsPayload('FIXED', [
      { price: 200, brand_ids: [1], states: [] },
      { price: 100, brand_ids: [], states: [] },
    ]),
    'cannot mix No Brand pricing with brand prices'
  );
});

test('import may leave a No Brand group price NULL too (allowNullPrice=true, redundant but harmless)', async () => {
  await assert.doesNotReject(
    validateGroupsPayload('FIXED', [{ price: null, brand_ids: [], states: [] }], { allowNullPrice: true })
  );
});
