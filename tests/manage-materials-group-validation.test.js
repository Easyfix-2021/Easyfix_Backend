/*
 * services/material.service.js::validateGroupsPayload — the server-side
 * enforcement of the FIXED/DYNAMIC group rules from the Manage Materials
 * contract. The FE mirrors these for UX only; this function is the real
 * gate (called from createMaterial/updateMaterial before any write).
 *
 * Non-destructive: fake pool, no real DB. The only query this function
 * issues is the "Not Applicable" system-brand lookup.
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const NOT_APPLICABLE_ID = 999;
const fake = installFakePool([
  [/FROM tbl_brand_master WHERE is_system/i, [{ brand_id: NOT_APPLICABLE_ID }]],
]);

const { validateGroupsPayload } = require('../services/material.service');

beforeEach(() => fake.reset());

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

test('FIXED group with no brands is rejected', async () => {
  await rejects422(
    validateGroupsPayload('FIXED', [{ price: 100, brand_ids: [], states: [] }]),
    'at least one brand'
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

test('Not Applicable mixed with another brand in the same group is rejected', async () => {
  await rejects422(
    validateGroupsPayload('FIXED', [{ price: 0, brand_ids: [NOT_APPLICABLE_ID, 2], states: [] }]),
    'cannot be combined'
  );
});

test('Not Applicable alongside a SECOND group is rejected (must be sole group)', async () => {
  await rejects422(
    validateGroupsPayload('FIXED', [
      { price: 0, brand_ids: [NOT_APPLICABLE_ID], states: [] },
      { price: 50, brand_ids: [2], states: [] },
    ]),
    'sole brand of the sole price group'
  );
});

test('Not Applicable as the sole brand of the sole group is ALLOWED', async () => {
  await assert.doesNotReject(
    validateGroupsPayload('FIXED', [{ price: 0, brand_ids: [NOT_APPLICABLE_ID], states: [] }])
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
