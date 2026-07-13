/*
 * Characterization test for the magic-link submit "degraded mode": optional
 * tbl_job columns (branch_details / building_name / product_code) are only
 * written when a one-time column probe says they exist; when the probe reports
 * the column missing, the field is silently DROPPED from the UPDATE (the payload
 * still lands in customer_submitted_payload JSON).
 *
 * MUST be a SEPARATE file from the column-present tests: the probe result is
 * memoized at module scope for the whole process, and `node --test` runs each
 * file in its own child process — giving this file a fresh, "columns missing"
 * probe state via throwing probe routes.
 *
 * Runner: `node --test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeFakePool } = require('./helpers/fake-pool');

const magic = require('../services/job-magic-link.service');

test('acceptSubmission DROPS optional columns whose probe reports them missing', async () => {
  const fake = makeFakePool(
    [
      [/SELECT fk_address_id, fk_customer_id, fk_client_id FROM tbl_job/, [{ fk_address_id: 10, fk_customer_id: 20, fk_client_id: 30 }]],
      // Column probes throw → treated as "column missing" → SET clause omits them.
      [/`branch_details`/, () => { throw new Error("Unknown column 'branch_details'"); }],
      [/`building_name`/, () => { throw new Error("Unknown column 'building_name'"); }],
      [/`product_code`/, () => { throw new Error("Unknown column 'product_code'"); }],
    ],
    { stopOn: /UPDATE tbl_job SET/ },
  );
  await assert.rejects(() => magic.acceptSubmission(42, { branch_details: 'B7', building_name: 'Tower', product_code: 'P1' }, fake.pool));
  const write = fake.calls.find((c) => /UPDATE tbl_job SET/.test(c.sql));
  assert.ok(write, 'an UPDATE tbl_job must still be issued (degraded, not failed)');
  assert.doesNotMatch(write.sql, /branch_details/, 'missing column is dropped from the write');
  assert.doesNotMatch(write.sql, /building_name/);
  assert.doesNotMatch(write.sql, /product_code/);
  // The submit itself still succeeds — the audit stamp is always written.
  assert.match(write.sql, /customer_submitted_at/);
});
