/*
 * The WhatsApp webhook's secret guard — and specifically, that its THREE
 * refusal causes stay distinguishable in the log.
 *
 * ─── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 *
 * The conversational job-completion flow stopped working, and every inbound
 * message logged exactly one line:
 *
 *     WhatsApp inbound webhook · bad secret, refused
 *
 * That single line covered three unrelated incidents needing three different
 * people to do three different things:
 *
 *   • GALLABOX_WEBHOOK_SECRET blank on OUR side — the guard then refuses EVERY
 *     inbound however perfectly the provider is configured, so the whole flow is
 *     inert. A deployment gap that the wording made look like an attacker.
 *   • The request carried no secret — the provider is not sending it, or is
 *     sending a differently-named header.
 *   • Both present and different — a bad paste.
 *
 * The log could not tell them apart, so neither could anyone reading it. These
 * tests pin the distinction. If a future refactor collapses the causes back into
 * one boolean, this file fails — which is the entire point, because the outage
 * it guards was cheap to fix and expensive to diagnose.
 *
 * They also pin the security property the diagnostics must not cost us: no
 * branch may put either secret into a log line. Asserted against captured
 * logger output, not by reading the code.
 *
 * Non-destructive: real router, real logger (captured), no DB, no network.
 * Runner: `node --test`.
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

// The route requires the pool at load; nothing here reaches a query, but the
// fake keeps the suite off any real database.
const fake = installFakePool([[/.*/, () => []]]);

const express = require('express');
const logger = require('../logger');
const whatsappRouter = require('../routes/webhook/whatsapp');

const SECRET = 'sup3r-secret-value';

let server;
let baseUrl;
let lines = [];
const realLog = {};

before(async () => {
  for (const lvl of ['info', 'warn', 'error']) {
    realLog[lvl] = logger[lvl];
    logger[lvl] = (...args) => { lines.push({ lvl, args }); };
  }

  const app = express();
  app.use(express.json());
  app.use('/webhook', whatsappRouter);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  for (const lvl of Object.keys(realLog)) logger[lvl] = realLog[lvl];
  if (server) await new Promise((r) => server.close(r));
  fake.restore();
});

beforeEach(() => { lines = []; });

/** Every captured log line flattened to one searchable string. */
const logText = () => lines
  .map((l) => l.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
  .join('\n');

const post = async (headers = {}) => {
  const res = await fetch(`${baseUrl}/webhook/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ payload: { from: '919812345678', text: { body: 'hi' } } }),
  });
  return res.status;
};

const withSecret = async (value, fn) => {
  const saved = process.env.GALLABOX_WEBHOOK_SECRET;
  if (value === undefined) delete process.env.GALLABOX_WEBHOOK_SECRET;
  else process.env.GALLABOX_WEBHOOK_SECRET = value;
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env.GALLABOX_WEBHOOK_SECRET;
    else process.env.GALLABOX_WEBHOOK_SECRET = saved;
  }
};

test('an UNSET secret is an ERROR that names the variable — not a generic refusal', async () => {
  /*
   * THE REPORTED OUTAGE. .env.example ships this key blank, so an environment
   * where nobody filled it in refuses every customer reply — and used to say so
   * at WARN in words that read like someone probing the endpoint.
   */
  await withSecret(undefined, async () => {
    assert.equal(await post({ 'x-webhook-secret': 'anything' }), 401);
    const t = logText();
    assert.match(t, /GALLABOX_WEBHOOK_SECRET is not set/,
      'the refusal must name the variable an operator has to go and set');
    assert.match(t, /EVERY inbound/, 'and say the blast radius is total, not one message');
    assert.equal(lines.some((l) => l.lvl === 'error'), true,
      'a dead integration is an ERROR — at WARN it sits unread beside real refusals');
  });
});

test('a request with NO secret reports the header we expect, and the ones we got', async () => {
  // The provider-side half of the same failure: we are configured, they are not
  // — or they are sending a header under a different name. The names received
  // are the fastest way to see which.
  await withSecret(SECRET, async () => {
    assert.equal(await post({ 'x-gallabox-signature': 'some-other-scheme' }), 401);
    const t = logText();
    assert.match(t, /x-webhook-secret/, 'names the header WE read');
    assert.match(t, /x-gallabox-signature/, 'and reports the header names actually received');
    assert.equal(/GALLABOX_WEBHOOK_SECRET is not set/.test(t), false,
      'this is NOT the unset case and must not be reported as one');
  });
});

test('a WRONG secret is reported as a mismatch, with the length RELATION as the hint', async () => {
  await withSecret(SECRET, async () => {
    // Same length, different value — a wrong secret, not a truncated one.
    assert.equal(await post({ 'x-webhook-secret': 'sup3r-secret-valve' }), 401);
    const t = logText();
    assert.match(t, /MISMATCH/);
    assert.match(t, /lengths match/, 'equal lengths point at a wrong value, not a clipped paste');
  });

  lines = [];
  await withSecret(SECRET, async () => {
    assert.equal(await post({ 'x-webhook-secret': 'sup3r-sec' }), 401);
    assert.match(logText(), /lengths differ/, 'a short value reads as truncation');
  });
});

test('NO refusal branch ever logs either secret', async () => {
  /*
   * The diagnostics above exist to make the cause obvious, and the one thing
   * they must not buy it with is the secret itself. Asserted against captured
   * output on every branch, because "we would never log that" is exactly the
   * belief that precedes logging it.
   */
  const attacker = 'attacker-supplied-value';
  await withSecret(undefined, () => post({ 'x-webhook-secret': attacker }));
  await withSecret(SECRET, () => post({}));
  await withSecret(SECRET, () => post({ 'x-webhook-secret': attacker }));

  const t = logText();
  assert.equal(t.includes(SECRET), false, 'our secret must never reach a log line');
  assert.equal(t.includes(attacker), false, 'nor the value the caller sent');
});

test('the correct secret is accepted — the guard still guards', async () => {
  // A test file about refusals has to prove the ACCEPT path survived, or it
  // would pass just as happily against a webhook that rejects everything.
  await withSecret(SECRET, async () => {
    assert.equal(await post({ 'x-webhook-secret': SECRET }), 200);
    assert.equal(/refused|MISMATCH|not set/.test(logText()), false);
  });
});

test('the ?secret= query form is still accepted — trailing whitespace and all', async () => {
  await withSecret(SECRET, async () => {
    const res = await fetch(`${baseUrl}/webhook/whatsapp?secret=${encodeURIComponent(SECRET + '  ')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { from: '919812345678', text: { body: 'hi' } } }),
    });
    assert.equal(res.status, 200, 'the trim on both sides is load-bearing — a pasted secret carries whitespace');
  });
});
