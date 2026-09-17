/*
 * services/client-request.service.js — insertRequest() writes
 * tbl_job_comment.created_on (TIMESTAMP). Bound as a Date, never NOW(): the
 * pool is `timezone: '+05:30'`, so a JS Date serialises to the IST wall
 * clock the column expects, whereas NOW() resolves in the DB session zone.
 *
 * Runner: `node --test` (see npm test).
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([
  [/^\s*INSERT INTO tbl_job_comment/i, () => ({ insertId: 77 })],
]);
const { insertRequest } = require('../services/client-request.service');

after(() => fake.restore());

test('insertRequest binds created_on as a Date, not NOW()', async () => {
  const { pool } = require('../db');
  await insertRequest(pool, {
    jobId: 101, kind: 'cancel', jobStatus: 1, authorName: 'Priya', comment: 'please cancel', reasonId: 4,
  });
  const ins = fake.calls.find((c) => /^\s*INSERT INTO tbl_job_comment/i.test(c.sql));
  assert.ok(ins, 'the tbl_job_comment INSERT must run');
  assert.doesNotMatch(ins.sql, /NOW\(\)/, 'created_on must be a bound Date, not NOW()');
  const cols = ins.sql.replace(/^[\s\S]*INSERT INTO tbl_job_comment\s*\(/i, '').split(')')[0]
    .split(',').map((s) => s.trim());
  const idx = cols.indexOf('created_on');
  assert.ok(idx >= 0, 'created_on must be in the column list');
  assert.ok(ins.params[idx] instanceof Date, 'created_on must be a bound Date');
});
