/*
 * nameKey() is the ONE normaliser shared by brand.service, material.service
 * and the import services — every duplicate check and every `*_key` column
 * write goes through it. If it stops lowercasing or stops collapsing
 * whitespace, "Philips" / "PHILIPS" / "  Philips " silently stop colliding
 * and the 409 duplicate guards (and the UNIQUE indexes they front) go dark
 * on real-world casing variance. Pure function, no DB.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nameKey } = require('../utils/name-key');

test('nameKey lowercases', () => {
  assert.equal(nameKey('PHILIPS'), 'philips');
});

test('nameKey trims leading/trailing whitespace', () => {
  assert.equal(nameKey('  Philips  '), 'philips');
});

test('nameKey collapses internal whitespace runs to one space', () => {
  assert.equal(nameKey('Adapter   5A'), 'adapter 5a');
});

test('nameKey makes case + whitespace variants collide', () => {
  const variants = ['Philips', 'PHILIPS', '  philips ', 'PhIlIpS'];
  const keys = variants.map(nameKey);
  for (const k of keys) assert.equal(k, keys[0]);
});

test('nameKey handles null/undefined/number without throwing', () => {
  assert.equal(nameKey(null), '');
  assert.equal(nameKey(undefined), '');
  assert.equal(nameKey(5), '5');
});
