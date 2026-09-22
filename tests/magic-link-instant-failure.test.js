/*
 * Instant (dispatch-time) magic-link failures are RECORDED, and the hourly
 * cron does not re-send a link that failed.
 *
 * THE BUG (found 2026-09-22). When WhatsApp refused a link on the spot — the
 * number fails our format check, or Gallabox rejects the recipient —
 * sendForJob released its reserved slot and returned without writing anything.
 * magic_link_sent_at stayed NULL, so the cron's 24h cooldown never applied and
 * it retried the same bad number EVERY HOUR, while the order looked untouched
 * and the failure could not be counted.
 *
 * THE RULE (ops, 2026-09-22): a failed link is not re-sent — the team calls.
 *
 * What these pin:
 *   - only CUSTOMER-side refusals are recorded; our own faults (creds,
 *     NOTIFICATIONS_DISABLE, provider 5xx/401/429) are not, or one outage would
 *     permanently stop the cron for every order it touched;
 *   - the record uses the SAME columns the late-failure webhook writes;
 *   - the cron skips failed / undelivered, and still sweeps on a deploy that
 *     lacks the delivery-status columns.
 *
 * No DB, no network. Runner: `node --test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { makeFakePool, installFakePool } = require('./helpers/fake-pool');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-magic-link';

// Outbound modules stubbed BEFORE the service loads (it captures them at load).
let nextResponse = { delivered: true, providerMessageId: 'stub-1' };
function stubModule(relPath, exports) {
  const full = require.resolve(path.join(__dirname, '..', relPath));
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
}
stubModule('services/gallabox.whatsapp.service', {
  async sendTemplate() { return nextResponse; },
});
stubModule('services/url-shortener.service', {
  async shortenUrl() { return { short_url: 'https://s.test/abc' }; },
});

const magic = require('../services/job-magic-link.service');

/* ── customerSideFailureReason: who is to blame ─────────────────────────── */

test('an invalid mobile is the customer\'s number — recorded', () => {
  assert.equal(
    magic.customerSideFailureReason({ delivered: false, error: 'invalid phone "12345"' }),
    'Invalid mobile number',
  );
  assert.equal(
    magic.customerSideFailureReason({ delivered: false, error: 'invalid phone "null"' }),
    'Invalid mobile number', 'no mobile on file reaches the wrapper as "null"',
  );
});

test('a Gallabox 4xx that names the recipient is the customer\'s number — recorded', () => {
  const r = magic.customerSideFailureReason({
    delivered: false, httpStatus: 400,
    providerResponse: '{"message":"Recipient phone number is not a valid WhatsApp user"}',
  });
  assert.match(r, /^WhatsApp rejected the number: /);
  assert.ok(r.length <= 255, 'fits magic_link_delivery_reason');
});

test('OUR faults are never blamed on the customer — nothing recorded', () => {
  const ours = [
    { delivered: true },
    { delivered: false, disabled: true },                                     // NOTIFICATIONS_DISABLE
    { delivered: false, error: 'GALLABOX_API_KEY / API_SECRET / CHANNEL_ID not configured' },
    { delivered: false, error: 'fetch failed' },                              // network
    { delivered: false, httpStatus: 500, providerResponse: 'phone service down' },
    { delivered: false, httpStatus: 401, providerResponse: 'invalid apiKey for number' },
    { delivered: false, httpStatus: 429, providerResponse: 'rate limited' },
    { delivered: false, httpStatus: 400, providerResponse: 'template confirm_order not approved' },
    null,
  ];
  for (const r of ours) {
    assert.equal(magic.customerSideFailureReason(r), null, JSON.stringify(r));
  }
});

/* ── sendForJob: the instant failure lands in the delivery-status columns ── */

const JOB_SELECT = /FROM tbl_job j\s+LEFT JOIN tbl_customer cu/i;
function sendRoutes() {
  return [
    [/SET magic_link_send_count = magic_link_send_count \+ 1/i, { affectedRows: 1 }],
    [/^UPDATE tbl_job/i, { affectedRows: 1 }],
    [JOB_SELECT, [{
      job_id: 4242, fk_client_id: 7, magic_link_sent_at: null, magic_link_send_count: 0,
      customer_name: 'Ravi', customer_mob_no: '12345', client_name: 'Acme', max_send_count: 3,
    }]],
  ];
}
const FAIL_STAMP = /SET magic_link_delivery_status = 'failed'/;

test('sendForJob records a customer-side refusal as failed, with attempt time', async () => {
  nextResponse = { delivered: false, error: 'invalid phone "12345"' };
  const fake = makeFakePool(sendRoutes());
  const out = await magic.sendForJob(4242, { action: 'first' }, fake.pool);
  assert.equal(out.delivered, false);

  assert.ok(fake.calls.some((c) => /magic_link_send_count - 1/.test(c.sql)),
    'the reserved slot is still released — an operator re-send after fixing the number needs it');
  const stamp = fake.calls.find((c) => FAIL_STAMP.test(c.sql));
  assert.ok(stamp, 'the failure must be written — this was the bug');
  assert.match(stamp.sql, /magic_link_delivery_reason = \?/);
  assert.match(stamp.sql, /magic_link_sent_at = \?/, 'attempt time, so it counts in today\'s links');
  assert.match(stamp.sql, /magic_link_provider_msg_id = NULL/, 'a stale callback can never match it');
  assert.equal(stamp.params[0], 'Invalid mobile number');
  assert.ok(stamp.params[1] instanceof Date, 'bound as a JS Date (IST pool clock rule), not NOW()');
  assert.equal(stamp.params[3], 4242);
});

test('sendForJob leaves OUR faults unstamped, so the next sweep retries', async () => {
  nextResponse = { delivered: false, httpStatus: 503, providerResponse: 'upstream unavailable' };
  const fake = makeFakePool(sendRoutes());
  await magic.sendForJob(4242, { action: 'first' }, fake.pool);
  assert.equal(fake.calls.some((c) => FAIL_STAMP.test(c.sql)), false);
});

test('a successful send still resets a previous failure to sent', async () => {
  nextResponse = { delivered: true, providerMessageId: 'wamid-9' };
  const fake = makeFakePool(sendRoutes());
  await magic.sendForJob(4242, { action: 'resend' }, fake.pool);
  const ok = fake.calls.find((c) => /magic_link_delivery_status = 'sent'/.test(c.sql));
  assert.ok(ok, 'operator fixed the number and re-sent → the job is no longer "failed"');
  assert.match(ok.sql, /magic_link_delivery_reason = NULL/);
});

test('recording a failure never throws, even on an un-migrated deploy', async () => {
  const bad = { query: async () => { const e = new Error('no col'); e.code = 'ER_BAD_FIELD_ERROR'; throw e; } };
  await magic.markInstantFailure(bad, 1, { reason: 'x', action: 'first', at: new Date() });
  const down = { query: async () => { throw new Error('connection lost'); } };
  await magic.markInstantFailure(down, 1, { reason: 'x', action: 'first', at: new Date() });
});

/* ── the hourly cron skips failed links ─────────────────────────────────── */

test('the cron does not re-send a failed or undelivered link', async () => {
  const fake = installFakePool([[/FROM tbl_job j/i, []]]);
  try {
    const cron = require('../services/job-magic-link-cron');
    await cron.runHourlySweep();
    const q = fake.calls.find((c) => /FROM tbl_job j/i.test(c.sql));
    assert.ok(q, 'the eligibility query ran');
    assert.match(q.sql,
      /magic_link_delivery_status IS NULL\s+OR j\.magic_link_delivery_status NOT IN \('failed', 'undelivered'\)/,
      'a failed link is called, not re-sent (ops rule 2026-09-22)');
    assert.match(q.sql, /magic_link_sent_at\s*<\s*\?\s*-\s*INTERVAL 24 HOUR/, 'daily cooldown untouched');
  } finally {
    fake.restore();
  }
});

test('the cron still sweeps when the delivery-status columns are absent', async () => {
  const seen = [];
  const fake = installFakePool([[/FROM tbl_job j/i, (sql) => {
    seen.push(sql);
    if (/magic_link_delivery_status/.test(sql)) {
      const e = new Error("Unknown column 'j.magic_link_delivery_status'"); e.code = 'ER_BAD_FIELD_ERROR'; throw e;
    }
    return [];
  }]]);
  try {
    const cron = require('../services/job-magic-link-cron');
    const out = await cron.runHourlySweep();
    assert.equal(out.error, undefined, 'must not fail the whole sweep');
    assert.equal(seen.length, 2, 'retried once without the clause');
    assert.doesNotMatch(seen[1], /magic_link_delivery_status/);
  } finally {
    fake.restore();
  }
});
