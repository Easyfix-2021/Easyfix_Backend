/*
 * Unit tests for the rate-card charge cascade.
 *
 * Locks the formula against the canonical example from the ops
 * screenshot (2026-06-05, "How RateCard calculations are being done")
 * so a future refactor can't silently change the math.
 *
 * Runner: Node's built-in `node --test`. Run via `npm run test:rate-card`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeJobServiceCharges } = require('../utils/rate-card-calc');

test('canonical screenshot example — qty 1 (Chair installation)', () => {
  const rateCard = {
    total_amount: 400,
    easyfix_direct_fixed: 200,
    easyfix_direct_variable: 10,   // 10%
    overhead_fixed: 10,
    overhead_variable: 20,         // 20%
    client_fixed: 0,
    client_variable: 0,
  };
  const out = computeJobServiceCharges(rateCard, 1);
  assert.equal(out.total_charge, 400);
  assert.equal(out.total_cost, 400);
  assert.equal(out.easyfix_charge, 282);   // efDirect 240 + Overhead 42
  assert.equal(out.client_charge, 0);
  assert.equal(out.easyfixer_charge, 118); // residual
  // sum-to-total invariant
  assert.equal(out.easyfix_charge + out.client_charge + out.easyfixer_charge, out.total_cost);
});

test('canonical screenshot example — qty 3 (cumulative cascade × qty)', () => {
  const rateCard = {
    total_amount: 400,
    easyfix_direct_fixed: 200,
    easyfix_direct_variable: 10,
    overhead_fixed: 10,
    overhead_variable: 20,
    client_fixed: 0,
    client_variable: 0,
  };
  const out = computeJobServiceCharges(rateCard, 3);
  assert.equal(out.total_charge, 400);       // still per-unit
  assert.equal(out.total_cost, 1200);
  assert.equal(out.easyfix_charge, 846);     // 282 × 3
  assert.equal(out.easyfixer_charge, 354);   // 118 × 3
  assert.equal(out.client_charge, 0);
  // sum-to-total invariant still holds
  assert.equal(out.easyfix_charge + out.client_charge + out.easyfixer_charge, out.total_cost);
});

test('per-layer breakdown surfaces correct per-unit values', () => {
  const rateCard = {
    total_amount: 400,
    easyfix_direct_fixed: 200,
    easyfix_direct_variable: 10,
    overhead_fixed: 10,
    overhead_variable: 20,
    client_fixed: 0,
    client_variable: 0,
  };
  const out = computeJobServiceCharges(rateCard, 1);
  assert.equal(out._breakdown.ef_direct_share_per_unit, 240);
  assert.equal(out._breakdown.overhead_share_per_unit, 42);
  assert.equal(out._breakdown.client_share_per_unit, 0);
  assert.equal(out._breakdown.easyfixer_share_per_unit, 118);
});

test('fixed-only mode (no variable rates) — common QA pattern', () => {
  // Mirrors the 31,010 rows where easyfix_direct_variable = 0.
  const rateCard = {
    total_amount: 500,
    easyfix_direct_fixed: 100,
    easyfix_direct_variable: 0,
    overhead_fixed: 0,
    overhead_variable: 0,
    client_fixed: 0,
    client_variable: 0,
  };
  const out = computeJobServiceCharges(rateCard, 2);
  assert.equal(out.total_charge, 500);
  assert.equal(out.total_cost, 1000);
  assert.equal(out.easyfix_charge, 200);   // 100 × 2
  assert.equal(out.easyfixer_charge, 800); // 400 × 2
  assert.equal(out.client_charge, 0);
});

test('variable-only mode (no fixed) — small but real bucket', () => {
  // Sample row 38157 from QA. Pure 20% Easyfix cut, no overhead/client.
  const rateCard = {
    total_amount: 300,
    easyfix_direct_fixed: 0,
    easyfix_direct_variable: 20,   // 20%
    overhead_fixed: 0,
    overhead_variable: 0,
    client_fixed: 0,
    client_variable: 0,
  };
  const out = computeJobServiceCharges(rateCard, 1);
  assert.equal(out.total_charge, 300);
  assert.equal(out.total_cost, 300);
  assert.equal(out.easyfix_charge, 60);    // 20% of 300
  assert.equal(out.easyfixer_charge, 240); // 80% of 300
});

test('client_share non-zero — full 4-way split', () => {
  const rateCard = {
    total_amount: 1000,
    easyfix_direct_fixed: 0,
    easyfix_direct_variable: 10,   // 10% of 1000 = 100
    overhead_fixed: 0,
    overhead_variable: 5,          // 5% of 900 = 45
    client_fixed: 50,              // 50 fixed
    client_variable: 10,           // 10% of (855-0) before fixed
  };
  const out = computeJobServiceCharges(rateCard, 1);
  // remaining trace: 1000 → 900 (after efVar 100) → 900 (no efFixed)
  //                  → 855 (after ohVar 45) → 855 (no ohFixed)
  //                  → 769.5 (after clVar 10% of 855 = 85.5) → 719.5 (after clFixed 50)
  // efDirect = 100, overhead = 45 → easyfix = 145
  // client = 85.5 + 50 = 135.5
  // easyfixer = 719.5
  assert.equal(out.total_cost, 1000);
  assert.equal(out.easyfix_charge, 145);
  assert.equal(out.client_charge, 135.5);
  assert.equal(out.easyfixer_charge, 719.5);
  // sum check
  assert.equal(
    out.easyfix_charge + out.client_charge + out.easyfixer_charge,
    out.total_cost,
  );
});

test('quantity defaults to 1 when falsy', () => {
  const rateCard = { total_amount: 100, easyfix_direct_fixed: 20 };
  const out = computeJobServiceCharges(rateCard, 0);
  assert.equal(out.total_cost, 100);
  out.easyfix_charge === 20;
});

test('missing rate-card fields default to 0 (degenerate but safe)', () => {
  // Defensive: if a rate-card row is missing optional columns, the
  // calc shouldn't NaN out. Easyfixer ends up getting the full amount.
  const out = computeJobServiceCharges({ total_amount: 500 }, 2);
  assert.equal(out.total_charge, 500);
  assert.equal(out.total_cost, 1000);
  assert.equal(out.easyfix_charge, 0);
  assert.equal(out.client_charge, 0);
  assert.equal(out.easyfixer_charge, 1000);
});

test('null rate-card row degenerates to zeros without throwing', () => {
  const out = computeJobServiceCharges(null, 5);
  assert.equal(out.total_charge, 0);
  assert.equal(out.total_cost, 0);
  assert.equal(out.easyfix_charge, 0);
  assert.equal(out.easyfixer_charge, 0);
  assert.equal(out.client_charge, 0);
});

test('4-decimal rounding kicks in on values that would have float drift', () => {
  // Trigger a calculation that naturally produces a long float tail.
  const rateCard = {
    total_amount: 333,
    easyfix_direct_variable: 7,    // 7% of 333 = 23.31
    overhead_variable: 11,         // 11% of 309.69 = 34.0659
  };
  const out = computeJobServiceCharges(rateCard, 1);
  // Each share rounded to 4 decimals — no 0.00000000001 tail.
  assert.equal(String(out.easyfix_charge), String(Math.round(out.easyfix_charge * 10000) / 10000));
  assert.equal(String(out.easyfixer_charge), String(Math.round(out.easyfixer_charge * 10000) / 10000));
});
