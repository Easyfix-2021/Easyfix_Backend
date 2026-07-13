/*
 * Characterization tests for the magic-link customer-submit WRITE path
 * (job-magic-link.service acceptSubmission + writeCustomerOrderDetails), in the
 * COLUMN-PRESENT scenario (default fake resolves probes → columns present).
 *
 * THE load-bearing invariant: this path writes via its OWN UPDATE tbl_job and
 * deliberately does NOT go through setStatus / touch job_status — Ops reviews the
 * submission before the status/notification machinery fires. This test is the
 * regression tripwire that keeps that bypass intact.
 *
 * These functions take an INJECTED pool, so we hand them the fake directly — no
 * monkeypatch. They wrap non-status errors, so we assert on fake.calls (which is
 * recorded before the STOP throw) rather than the thrown error's shape.
 * Runner: `node --test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeFakePool } = require('./helpers/fake-pool');

const magic = require('../services/job-magic-link.service');

test('acceptSubmission writes via its own UPDATE tbl_job — never setStatus / job_status', async () => {
  const fake = makeFakePool(
    [[/SELECT fk_address_id, fk_customer_id, fk_client_id FROM tbl_job/, [{ fk_address_id: 10, fk_customer_id: 20, fk_client_id: 30 }]]],
    { stopOn: /UPDATE tbl_job SET/ },
  );
  await assert.rejects(() => magic.acceptSubmission(42, {}, fake.pool));
  const write = fake.calls.find((c) => /UPDATE tbl_job SET/.test(c.sql));
  assert.ok(write, 'an UPDATE tbl_job must be issued');
  assert.doesNotMatch(write.sql, /job_status/, 'must NOT transition status (intentional setStatus bypass)');
  assert.match(write.sql, /customer_submitted_at/, 'stamps the submission audit column');
});

test('acceptSubmission includes the optional columns when they are present', async () => {
  const fake = makeFakePool(
    [[/SELECT fk_address_id, fk_customer_id, fk_client_id FROM tbl_job/, [{ fk_address_id: 10, fk_customer_id: 20, fk_client_id: 30 }]]],
    { stopOn: /UPDATE tbl_job SET/ },
  );
  await assert.rejects(() => magic.acceptSubmission(42, { branch_details: 'B7', building_name: 'Tower', product_code: 'P1' }, fake.pool));
  const write = fake.calls.find((c) => /UPDATE tbl_job SET/.test(c.sql));
  assert.ok(write);
  // Column probes resolve (present) in this file, so the optional cols are written.
  assert.match(write.sql, /branch_details/);
  assert.match(write.sql, /building_name/);
  assert.match(write.sql, /product_code/);
});

test('writeCustomerOrderDetails writes tbl_job directly, no status transition', async () => {
  const fake = makeFakePool(
    [[/SELECT fk_address_id FROM tbl_job/, [{ fk_address_id: 10 }]]],
    { stopOn: /UPDATE tbl_job SET/ },
  );
  await assert.rejects(() => magic.writeCustomerOrderDetails(42, {}, fake.pool));
  const write = fake.calls.find((c) => /UPDATE tbl_job SET/.test(c.sql));
  assert.ok(write, 'an UPDATE tbl_job must be issued');
  assert.doesNotMatch(write.sql, /job_status/, 'must NOT transition status');
  assert.match(write.sql, /customer_submitted_at/);
});
