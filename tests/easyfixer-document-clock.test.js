/*
 * services/easyfixer-document.service.js::upsertEasyfixerDocuments stamps
 * tbl_easyfixer_document.created_date (TIMESTAMP, converted the same as a
 * DATETIME column — 2026-09-16) with a bound Date, never SQL NOW(). db.js
 * pool timezone '+05:30' stores a bound Date as the IST wall clock
 * regardless of host; NOW() takes the DB session's own (SYSTEM) zone.
 *
 * Runner: `node --test` (see npm test).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { upsertEasyfixerDocuments } = require('../services/easyfixer-document.service');

function fakeConn() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (/SELECT efr_doc_id/i.test(String(sql))) return [[]]; // no existing row → INSERT
      return [{ affectedRows: 1 }];
    },
  };
}

test('upsertEasyfixerDocuments INSERT binds created_date as a Date, never NOW()', async () => {
  const conn = fakeConn();
  await upsertEasyfixerDocuments(conn, 4471, [[7, 'easydoc/education.jpg']]);

  const ins = conn.calls.find((c) => /INSERT INTO tbl_easyfixer_document/i.test(c.sql));
  assert.ok(ins, 'the document INSERT ran');
  assert.doesNotMatch(ins.sql, /NOW\(\)/, 'created_date must not be SQL NOW()');
  // (efr_id, efr_doc_type_id, efr_document_name, created_date, created_by)
  assert.ok(ins.params[3] instanceof Date, 'created_date is the fourth bound value');
});
