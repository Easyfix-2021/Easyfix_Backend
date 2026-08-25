/*
 * easyfix_client_target — the writer.
 *
 * THE ASYMMETRY IS THE POINT. getTargets() deliberately FAILS SOFT: a missing
 * table, a bad row, any error at all resolves to the platform defaults, because
 * a Performance page that will not render is worse than one showing assumed
 * numbers. setTargets() must do the OPPOSITE. An operator who types "SLA 95%",
 * gets a success toast and finds nothing persisted is strictly worse off than
 * one who sees an error — so every write failure throws. If someone later
 * "makes the service consistent" by giving the writer the reader's try/catch,
 * these tests are what should stop them.
 *
 * The other property worth pinning is that DELETE is the ONLY route back to
 * `source: 'platform-default'`. Writing the default VALUES leaves the row in
 * place and getTargets() keeps reporting 'contracted' — so an accidental save
 * would mark a client as contracted forever if clearTargets() were dropped.
 *
 * ORDER MATTERS IN THIS FILE. `targetTableAvailable` is a module-level memo
 * that latches false the first time a 1146 is seen and never re-checks, so the
 * missing-table test runs LAST — before it, every other test would short-
 * circuit on the latched flag.
 *
 * Runner: `node --test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const CLIENT = 133;

let missingTable = false;
const fake = installFakePool([
  [/easyfix_client_target/i, (sql) => {
    if (missingTable) {
      const e = new Error("Table 'easyfix.easyfix_client_target' doesn't exist");
      e.errno = 1146;
      throw e;
    }
    if (/^DELETE/i.test(sql.trim())) return { affectedRows: 1 };
    if (/^INSERT/i.test(sql.trim())) return { affectedRows: 1 };
    return [];                     // SELECT → no contracted row
  }],
]);

const svc = require('../services/client-target.service');

const VALUES = {
  sla_pct: 95,
  ftfr_pct: 90,
  revisit_pct: 5,
  avg_age_days: 2,
  approval_response_hours: 12,
};

test('setTargets upserts rather than inserting — client_id is the PK', async () => {
  fake.reset();
  const saved = await svc.setTargets(CLIENT, VALUES, 7);

  const stmt = fake.calls.find((c) => /INSERT INTO easyfix_client_target/i.test(c.sql));
  assert.ok(stmt, 'a write must be attempted');
  assert.match(stmt.sql, /ON DUPLICATE KEY UPDATE/i,
    'two operators saving at once must not be able to create a duplicate row');
  assert.equal(saved.source, 'contracted',
    'the caller must be told the client is now contracted, without re-reading');
  assert.equal(saved.sla_pct, 95);
});

test('updated_at is bound as a Date, not SQL NOW()', async () => {
  fake.reset();
  await svc.setTargets(CLIENT, VALUES, 7);
  const stmt = fake.calls.find((c) => /INSERT INTO easyfix_client_target/i.test(c.sql));

  assert.doesNotMatch(stmt.sql, /NOW\(\)/i,
    'NOW() follows the MySQL session timezone; the pool runs +05:30 so a JS Date lands as IST verbatim');
  assert.ok(stmt.params.some((p) => p instanceof Date), 'updated_at must be a bound Date');
  assert.ok(stmt.params.includes(7), 'updated_by must carry the acting user');
});

test('a null actor is allowed — attribution is optional, the write is not', async () => {
  fake.reset();
  await svc.setTargets(CLIENT, VALUES, undefined);
  const stmt = fake.calls.find((c) => /INSERT INTO easyfix_client_target/i.test(c.sql));
  assert.ok(stmt.params.includes(null), 'updated_by is a nullable column');
});

test('clearTargets DELETEs the row — the only way back to platform-default', async () => {
  fake.reset();
  const removed = await svc.clearTargets(CLIENT);
  const stmt = fake.calls.find((c) => /^DELETE FROM easyfix_client_target/i.test(c.sql.trim()));
  assert.ok(stmt, 'writing the default VALUES would leave source = contracted, so it must be a DELETE');
  assert.equal(removed, true);
});

test('getTargets still FAILS SOFT to the platform defaults when nothing is configured', async () => {
  fake.reset();
  const t = await svc.getTargets(CLIENT);
  assert.equal(t.source, 'platform-default');
  assert.equal(t.sla_pct, svc.DEFAULT_TARGETS.sla_pct,
    'a client with no contracted row must still render a Performance page');
});

/* ── Keep last: this latches the module-level availability memo ─────────── */
test('a MISSING TABLE throws on write, even though the read swallows it', async () => {
  fake.reset();
  missingTable = true;

  const readBack = await svc.getTargets(CLIENT);
  assert.equal(readBack.source, 'platform-default',
    'the READ must keep degrading quietly — that behaviour is deliberate');

  await assert.rejects(
    () => svc.setTargets(CLIENT, VALUES, 7),
    (e) => e.status === 503,
    'the WRITE must not report success when nothing could be stored',
  );
  await assert.rejects(
    () => svc.clearTargets(CLIENT),
    (e) => e.status === 503,
  );
});
