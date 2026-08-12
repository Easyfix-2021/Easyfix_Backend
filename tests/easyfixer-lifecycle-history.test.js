/* Lifecycle history pagination must preserve mysql2's [rows, fields] shape. */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const fake = installFakePool([
  [/FROM information_schema\.columns/i, [{ column_count: 6, history_count: 1 }]],
  [/SELECT 1 AS found FROM tbl_easyfixer/i, [{ found: 1 }]],
  [/SELECT COUNT\(\*\) AS total FROM tbl_easyfixer_lifecycle_status_log/i, [{ total: 7 }]],
  [/SELECT lifecycle_log_id, from_status, to_status/i, [{
    lifecycle_log_id: 91,
    from_status: 'ACTIVE',
    to_status: 'PAUSED',
    reason_code: 'MANUAL_PAUSE',
    reason: 'Training required',
    source: 'CRM',
    actor_user_id: 5,
    metadata: null,
    status_version: 2,
    created_at: '2026-08-10 10:00:00',
  }]],
]);

const lifecycle = require('../services/easyfixer-lifecycle.service');

after(() => fake.restore());

test('history returns the independent count row instead of coercing it to zero', async () => {
  lifecycle._internals.resetSchemaProbeForTests();
  const result = await lifecycle.getHistory(42, { limit: 20, offset: 0 });
  assert.equal(result.total, 7);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, 91);
});
