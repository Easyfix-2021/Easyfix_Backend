/*
 * tbl_url_shortener.last_clicked_at is stamped with a BOUND Date, not SQL
 * NOW() (2026-09-16) — datetime column, same convention as every other
 * application timestamp in this repo (see tests/otp-attempt-cap.test.js).
 *
 * Runner: `node --test` (see npm test).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recordClick } = require('../services/url-shortener.service');

test('recordClick() stamps last_clicked_at with a bound Date, never NOW()', async () => {
  const calls = [];
  const fakePool = { query: async (sql, params) => { calls.push({ sql, params }); return [{}]; } };

  recordClick('abc123', fakePool);
  // recordClick fires the write inside setImmediate — let it run.
  await new Promise((r) => setImmediate(r));

  assert.equal(calls.length, 1, 'positive control: the update ran');
  assert.doesNotMatch(calls[0].sql, /NOW\(\)/);
  assert.ok(calls[0].params[0] instanceof Date, 'last_clicked_at is the first bound value');
  assert.ok(Math.abs(Date.now() - calls[0].params[0].getTime()) < 60_000, 'and it is now');
  assert.equal(calls[0].params[1], 'abc123');
});
