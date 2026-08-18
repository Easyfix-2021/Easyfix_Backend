/*
 * The hourly magic-link sweep must honour the CLIENT'S configured send cap.
 *
 * THE BUG (2026-08-17). The cron's eligibility query hardcoded
 * `AND j.magic_link_send_count < 3` and never read the client's
 * `Max Magic-Link Send Count` property. So a client configured for 2 still
 * received THREE automatic WhatsApp messages, while the manual Send button —
 * which DOES read the property — correctly refused the third. Two enforcement
 * points on the same counter column, disagreeing, with only one configurable.
 *
 * WHAT THESE PIN, and why the negative assertion carries the weight: the cron
 * must use the SHARED expression, and the literal `< 3` must be gone. Asserting
 * only "a subquery is present" would pass for a second, divergent copy — and a
 * copy is precisely the failure this expression has already suffered once
 * (matching '_' but not '-', so the cap "silently fell back to 3"). One
 * definition, imported by both callers, is the fix; these tests are what keep
 * it that way.
 *
 * No DB, no network: the fake pool returns zero eligible rows, so the sweep
 * captures its SQL and sends nothing.
 *
 * Runner: `node --test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

const svc = require('../services/job-magic-link.service');

const fake = installFakePool([
  // Eligibility SELECT → no rows, so the sweep does no work and sends nothing.
  [/FROM tbl_job j/i, []],
]);

const cron = require('../services/job-magic-link-cron');

test('maxSendCountSql resolves the client property, with 3 as the fallback', () => {
  const sql = svc.maxSendCountSql('j');

  assert.match(sql, /tbl_client_custom_properties/, 'the cap comes from the client property');
  assert.match(sql, /j\.fk_client_id/, "scoped to the JOB'S client");
  assert.match(sql, /COALESCE\(NULLIF\(/,
    'NULLIF(...,0) reproduces the manual path\'s `Number(x) || 3`: 0 and non-numeric fall back');
  assert.match(sql, /,\s*3\)\s*$/, 'default 3 when the client has not configured one');
  // The '_' vs '-' normalisation whose absence once made the cap silently 3.
  assert.match(sql, /REPLACE\(REPLACE\(ccp_max\.c_prop_name, '_', ' '\), '-', ' '\)/,
    'both snake_case and hyphenated property names must match');
  assert.match(sql, /status IS NULL OR ccp_max\.status = 1/,
    'a status=0 row is disabled and must not supply the cap');
});

test('maxSendCountSql honours the table alias it is given', () => {
  assert.match(svc.maxSendCountSql('jj'), /jj\.fk_client_id/);
  assert.match(svc.maxSendCountSql(), /j\.fk_client_id/, 'defaults to j');
});

test('the cron sweep no longer hardcodes 3 — it uses the shared cap', async () => {
  fake.reset();
  const result = await cron.runHourlySweep();
  assert.equal(result.eligible, 0, 'fixture returns no rows, so nothing was sent');

  const q = fake.calls.find((c) => /FROM tbl_job j/i.test(c.sql));
  assert.ok(q, 'the eligibility query must have run');

  assert.equal(/magic_link_send_count\s*<\s*3\b/.test(q.sql), false,
    'the hardcoded cap is the bug — a client set to 2 was still sent 3');
  assert.match(q.sql, /magic_link_send_count\s*<\s*COALESCE\(NULLIF\(/,
    'the cap must come from the shared per-client expression');
  assert.match(q.sql, /tbl_client_custom_properties ccp_max/,
    'and that expression must be the one the manual path uses');
});

test('the 24h cooldown is untouched — this is a per-day sweep, not per-hour', async () => {
  /*
   * The cron runs at :05 every hour, but a job is only re-eligible 24h after
   * its last send. That is what makes a cap of N mean "N days", not "N hours",
   * and changing the cap must not disturb it.
   */
  fake.reset();
  await cron.runHourlySweep();
  const q = fake.calls.find((c) => /FROM tbl_job j/i.test(c.sql));

  assert.match(q.sql, /magic_link_sent_at\s*<\s*NOW\(\)\s*-\s*INTERVAL 24 HOUR/,
    'the per-job daily cooldown must survive');
  assert.match(q.sql, /j\.job_status = 9/, 'still scoped to unconfirmed jobs');
});
