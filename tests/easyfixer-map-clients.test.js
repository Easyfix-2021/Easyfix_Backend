/*
 * PUT /admin/easyfixers/:id/verification/map-clients →
 * services/easyfixer-verification.service.js::mapClients.
 *
 * tbl_client_easyfixer_mapping has seven columns and its only unique key is the
 * auto-increment mapping_id (QA information_schema, 2026-09-16). mapClients used
 * to write inserted_by / insert_date / updated_by — none exist, so every save
 * threw ER_BAD_FIELD_ERROR — and relied on ON DUPLICATE KEY, which with no
 * (client, easyfixer) key would have inserted a duplicate row on every save.
 * Rows are per service type and another screen disables them one type at a
 * time, so a disabled row must not be reactivated from here.
 *
 * Runner: `node --test` (see npm test).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../db');
const verification = require('../services/easyfixer-verification.service');

const COLUMNS = new Set(['mapping_id', 'client_id', 'easyfixer_id', 'service_type_id',
  'service_type_ids', 'mapping_status', 'update_date']);

async function run(clientIds, existingClientIds) {
  const calls = [];
  const conn = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (/SELECT DISTINCT client_id FROM tbl_client_easyfixer_mapping/i.test(sql)) {
        return [existingClientIds.map((client_id) => ({ client_id })), []];
      }
      return [{ affectedRows: 1 }, []];
    },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
  };
  const original = { getConnection: db.pool.getConnection, query: db.pool.query };
  db.pool.getConnection = async () => conn;
  db.pool.query = async () => [[], []];
  try {
    // The post-commit getVerificationPage read is not under test.
    await verification.mapClients(4471, clientIds).catch(() => {});
  } finally {
    db.pool.getConnection = original.getConnection;
    db.pool.query = original.query;
  }
  return calls.filter((c) => /tbl_client_easyfixer_mapping/i.test(c.sql));
}

test('names only columns the table has', async () => {
  const calls = await run([11, 12], [11]);
  assert.equal(calls.length, 3, 'disable, lookup, insert');
  for (const { sql } of calls) {
    for (const col of sql.match(/\b(inserted_by|insert_date|updated_by|[a-z_]+_(?:by|date|id|ids|status))\b/g) || []) {
      assert.ok(COLUMNS.has(col), `${col} is not a column of tbl_client_easyfixer_mapping`);
    }
    assert.doesNotMatch(sql, /ON DUPLICATE KEY|NOW\(\)/i);
  }
});

test('a client with an active row is left alone; only the unmapped one is inserted', async () => {
  const calls = await run([11, 12], [11]);
  assert.ok(!calls.some((c) => /SET mapping_status = 1/i.test(c.sql)),
    'no reactivation — that would undo per-service-type removals made elsewhere');
  const lookup = calls.find((c) => /SELECT DISTINCT client_id/i.test(c.sql));
  assert.match(lookup.sql, /mapping_status = 1/, 'only an ACTIVE row counts as mapped');

  const disable = calls[0];
  const insert = calls.find((c) => /INSERT INTO tbl_client_easyfixer_mapping/i.test(c.sql));
  const rows = insert.params[0];
  assert.deepEqual(rows.map((r) => r.slice(0, 3)), [[12, 4471, 1]], 'only the unmapped client is inserted');
  assert.ok(rows[0][3] instanceof Date, 'update_date is a bound Date');
  assert.equal(rows[0][3], disable.params[0], 'one clock for the whole save');
});

test('nothing is inserted when every client already has a row', async () => {
  const calls = await run([11], [11]);
  assert.ok(!calls.some((c) => /INSERT INTO/i.test(c.sql)));
});

test('an empty list only disables', async () => {
  const calls = await run([], []);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /SET mapping_status = 0, update_date = \?/);
  assert.deepEqual(calls[0].params.slice(1), [4471]);
});
