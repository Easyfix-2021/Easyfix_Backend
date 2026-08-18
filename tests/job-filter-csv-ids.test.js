/*
 * The multi-select filter CSV limit.
 *
 * THE BUG (2026-08-18). csvIds was `Joi.string().pattern(...).max(200)` — 200
 * CHARACTERS, not 200 ids. At ~4 chars per id ("123,") that rejected any
 * selection past roughly FORTY, against 398 clients and 11,108 cities in the
 * live schema. "Pending for Scheduling → Client → Select all → uncheck one"
 * produced a ~1,592 character CSV, Joi 400'd it, and the table did not change.
 *
 * WHY IT LOOKED LIKE "DATA NOT UPDATING" RATHER THAN AN ERROR, which is the
 * part worth remembering: the FE's useFetch deliberately keeps the previous
 * rows on error so a transient failure never blanks a populated table. A
 * rejected request therefore leaves the old rows on screen — and with every
 * client selected, the stale rows ARE every client, so nothing appears wrong
 * until you deselect one and the screen refuses to move.
 *
 * Runner: `node --test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { listQuery } = require('../validators/job.validator');

const csv = (n, start = 1) => Array.from({ length: n }, (_, i) => start + i).join(',');
const check = (clientId) => listQuery.validate({ clientId }, { allowUnknown: true });

test('a single id still validates — back-compat with single-select callers', () => {
  assert.equal(check('42').error, undefined);
  assert.equal(check(42).error, undefined);
});

test('the whole client list minus one is ACCEPTED — the reported case', () => {
  /*
   * 397 of 398 clients. Under the old character cap this was ~1,588 chars and
   * 400'd; it is the exact selection the bug report describes.
   */
  const { error } = check(csv(397));
  assert.equal(error, undefined, error && error.message);
});

test('a CSV far past the old 200-CHARACTER cap is accepted', () => {
  // 60 four-digit ids ≈ 300 chars — comfortably rejected before, fine now.
  assert.equal(check(csv(60, 1000)).error, undefined);
});

test('an absurd list is still refused, with a message that says what to do', () => {
  /*
   * The limit did not go away, it changed units. 11,108 cities must not become
   * an IN() list — and a caller who wants everything should send no filter,
   * which is what the message tells them.
   */
  const { error } = check(csv(501));
  assert.ok(error, 'past the id limit must still be rejected');
  assert.match(error.message, /500/, 'the message names the limit');
  assert.match(error.message, /clear the filter/i, 'and says what to do instead');
});

test('the boundary is exact — 500 in, 501 out', () => {
  assert.equal(check(csv(500)).error, undefined, '500 is allowed');
  assert.ok(check(csv(501)).error, '501 is not');
});

test('malformed CSVs are still rejected — the pattern did not loosen', () => {
  for (const bad of ['1,,2', '1,2,', 'abc', '1;2', '-1', '1, 2', '']) {
    assert.ok(check(bad).error, `"${bad}" must be rejected`);
  }
});
