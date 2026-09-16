/*
 * services/easyfixer-verification.service.js::replaceOptionMappings stamps
 * tbl_efr_deepskill_mapping's audit "when" column (dynamically resolved by
 * deepskillMappingAuditCols() via SHOW COLUMNS — QA information_schema confirms it
 * resolves to `insert_date`, DATETIME) with a bound Date, never SQL NOW()
 * (2026-09-16). db.js pool timezone '+05:30' stores a bound Date as the IST
 * wall clock regardless of host; NOW() takes the DB session's own (SYSTEM)
 * zone. Both the bulk-reactivate UPDATE and the bulk INSERT path use it.
 *
 * Runner: `node --test` (see npm test).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db');
const verification = require('../services/easyfixer-verification.service');

function fakeConn(queryImpl) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      return queryImpl(String(sql), params);
    },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
  };
}

test('replaceOptionMappings INSERT binds the resolved audit date column as a Date, never NOW()', async () => {
  const conn = fakeConn((sql) => {
    if (/SHOW COLUMNS FROM tbl_efr_deepskill_mapping/i.test(sql)) {
      return [[{ Field: 'insert_date' }, { Field: 'inserted_by' }]];
    }
    if (/SELECT id, category_id/i.test(sql)) return [[]]; // no existing mappings → pure INSERT
    return [[]];
  });
  const original = { getConnection: db.pool.getConnection, query: db.pool.query };
  db.pool.getConnection = async () => conn;
  // deepskillMappingAuditCols() runs SHOW COLUMNS on the bare pool, not the
  // transaction connection.
  db.pool.query = async (sql) => {
    if (/SHOW COLUMNS FROM tbl_efr_deepskill_mapping/i.test(String(sql))) {
      return [[{ Field: 'insert_date' }, { Field: 'inserted_by' }]];
    }
    return [[]];
  };
  try {
    await verification.replaceOptionMappings(4471, [
      { category_id: 1, service_type_id: 2, deep_skill_id: 3, option_id: 4 },
    ], { user_id: 9 });
  } finally {
    db.pool.getConnection = original.getConnection;
    db.pool.query = original.query;
  }

  const ins = conn.calls.find((c) => /INSERT INTO tbl_efr_deepskill_mapping/i.test(c.sql));
  assert.ok(ins, 'the bulk INSERT ran');
  assert.match(ins.sql, /`insert_date`/, 'audit.dateCol resolved to insert_date');
  assert.doesNotMatch(ins.sql, /NOW\(\)/, 'insert_date must not be SQL NOW()');
  // (easyfixer_id, category_id, service_type_id, parent_skill_id, deep_skill_id,
  //  is_repairing, `insert_date`, `inserted_by`) — insert_date is the 6th param.
  assert.ok(ins.params[5] instanceof Date, 'insert_date is the 6th bound value');
});
