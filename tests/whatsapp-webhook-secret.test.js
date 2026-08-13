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

beforeEach(() => {
  lines = [];
  // The breaker is module-scoped on purpose, so every test in this file shares
  // its counter. Without this reset the refusal tests above would bleed into
  // the breaker tests below and the thresholds would be met by accident.
  whatsappRouter.__test.authBreaker.__state.clear();
});

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

/* ═════════════ the circuit breaker on repeated refusals ═════════════════ */

const MAX_FAILURES = 20;

test('repeated refusals open the circuit — 429 with Retry-After, not another 401', async () => {
  /*
   * The reported incident: twelve refusals in fifteen seconds, and nothing ever
   * told the provider to stop. A 401 is not a backoff signal; 429 + Retry-After
   * is, so a well-behaved sender reduces the load at its source instead of us
   * absorbing it indefinitely.
   */
  await withSecret(SECRET, async () => {
    for (let i = 0; i < MAX_FAILURES; i++) {
      assert.equal(await post({ 'x-webhook-secret': 'wrong' }), 401, `attempt ${i + 1} should still be a plain refusal`);
    }
    const res = await fetch(`${baseUrl}/webhook/whatsapp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': 'wrong' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 429, 'the breaker is open');
    assert.ok(Number(res.headers.get('retry-after')) > 0, 'and says for how long');
  });
});

test('opening the circuit logs ONCE, not once per request', async () => {
  // Log volume is half the damage: a WARN per attempt, indefinitely, buries
  // every other line in the file. Suppression is the feature, not a side effect.
  await withSecret(SECRET, async () => {
    for (let i = 0; i < MAX_FAILURES + 15; i++) await post({ 'x-webhook-secret': 'wrong' });
    const opens = lines.filter((l) => /CIRCUIT OPEN/.test(
      l.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
    ));
    assert.equal(opens.length, 1, `expected exactly one CIRCUIT OPEN line, saw ${opens.length}`);
    assert.equal(opens[0].lvl, 'error', 'a dead integration is an ERROR');
  });
});

test('the refusal CAUSE is still logged on the request that opens the circuit', async () => {
  // Ordering guard. If recordFailure ran before the cause was logged, the very
  // request that trips the breaker would say only "429" and the diagnosis would
  // vanish with it — which is the failure mode this whole change exists to end.
  await withSecret(SECRET, async () => {
    for (let i = 0; i < MAX_FAILURES; i++) await post({ 'x-webhook-secret': 'wrong' });
    const t = logText();
    assert.match(t, /MISMATCH/, 'the cause survives alongside the breaker line');
    assert.match(t, /CIRCUIT OPEN/);
  });
});

test('ONE authenticated request clears the budget in full', async () => {
  /*
   * THE PROPERTY THAT MAKES THIS SAFE TO LEAVE ON. The instant the provider's
   * header is fixed, the queued backlog of real customer replies must not be
   * throttled for the misconfiguration that preceded it. A decrement would make
   * a correctly-configured sender serve out a penalty it no longer deserves.
   */
  await withSecret(SECRET, async () => {
    for (let i = 0; i < MAX_FAILURES - 1; i++) await post({ 'x-webhook-secret': 'wrong' });
    assert.equal(await post({ 'x-webhook-secret': SECRET }), 200, 'a good request gets through');

    // Budget restored in full: another MAX_FAILURES-1 refusals must NOT open it.
    for (let i = 0; i < MAX_FAILURES - 1; i++) {
      assert.equal(await post({ 'x-webhook-secret': 'wrong' }), 401, 'still refusing, not breaking');
    }
  });
});

test('correct traffic NEVER trips the breaker, however much of it there is', async () => {
  // A plain rate limiter would drop this. The thing being bounded is failure,
  // not volume — a busy hour of genuine customer replies is exactly the traffic
  // this endpoint exists to accept.
  await withSecret(SECRET, async () => {
    for (let i = 0; i < MAX_FAILURES * 3; i++) {
      assert.equal(await post({ 'x-webhook-secret': SECRET }), 200, `good request ${i + 1} must not be throttled`);
    }
  });
});

/* ═════════ delivery receipts must not read as unparseable ══════════════ */

const postBody = async (body) => {
  const res = await fetch(`${baseUrl}/webhook/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-secret': SECRET },
    body: JSON.stringify(body),
  });
  return res.status;
};

/* The exact envelope shape seen in production, from the logged bodyShape. */
const receipt = (status) => ({
  id: '6a7d6520ed7340bf133953a1',
  status,
  timestamp: '1786599311',
  errors: {},
  message: { recipient_id: '919812345678' },
  recipient_id: '919812345678',
});

test('a sent/delivered/read receipt is acknowledged QUIETLY, never as UNPARSEABLE', async () => {
  /*
   * These fire for EVERY message we send, so roughly half the webhook log was a
   * WARN saying "normaliseInbound found no actionable fields … widen the probes"
   * — advice that is simply wrong, about traffic that is entirely normal. The
   * cost was not CPU: it was that UNPARSEABLE stopped meaning anything, and it
   * exists to say a CUSTOMER sent something we could not read.
   */
  await withSecret(SECRET, async () => {
    for (const st of ['sent', 'delivered', 'read']) {
      lines = [];
      assert.equal(await postBody(receipt(st)), 200, `${st} receipt is accepted`);
      const t = logText();
      assert.equal(/UNPARSEABLE/.test(t), false, `a "${st}" receipt must not be called unparseable`);
      assert.equal(lines.some((l) => l.lvl === 'warn'), false, `and must not WARN — it is routine`);
    }
  });
});

test('a FAILED receipt is still acted on — the quiet path must not swallow the one that matters', async () => {
  // The whole reason receipts are read at all is the "Delivery Failed" chip.
  // Quietening the routine ones must not quieten this one.
  await withSecret(SECRET, async () => {
    assert.equal(await postBody({ ...receipt('failed'), errors: [{ message: 'number not on WhatsApp' }] }), 200);
    assert.match(logText(), /status callback · status=failed/i,
      'a failure is still logged and still drives the DB update');
  });
});

test('a real customer message still parses — the receipt guard must not eat inbound', async () => {
  // The narrow risk of identifying receipts by shape is that a real message
  // gets classified as one. This is the regression guard for that.
  await withSecret(SECRET, async () => {
    lines = [];
    assert.equal(await postBody({ payload: { from: '919812345678', text: { body: 'yes please' } } }), 200);
    assert.match(logText(), /WhatsApp inbound · type=text/, 'still recognised as a customer message');
  });
});

test('a sender with NO readable content is reported with its shape, so the probe gap is findable', async () => {
  /*
   * type=unknown means a real customer sent something and normaliseInbound could
   * not tell what. That is a probe gap, and it used to be invisible: the body
   * shape was logged only on the fully-unparseable path, so the one case that
   * could reveal where their reply lives was the one case that never printed it.
   */
  await withSecret(SECRET, async () => {
    lines = [];
    assert.equal(await postBody({ payload: { from: '919812345678', someNewShape: { body: 'yes' } } }), 200);
    const t = logText();
    assert.match(t, /CONTENT NOT FOUND/, 'the gap is named');
    assert.match(t, /someNewShape/, 'and the key path where their reply actually is, is printed');
    assert.equal(t.includes('yes'), false, 'keys only — never the words the customer typed');
  });
});

/* ═══════ the nested `message` key must not shadow the envelope ═════════ */

test('a top-level sender + text is found even when a nested `message` key exists', async () => {
  /*
   * THE REPORTED INCIDENT, reproduced. Job 523247 had a conversation row that
   * was `active`, at `awaiting_choice`, expiring two days out — and
   * `last_inbound_at` was NULL: not one reply had ever matched it. Meanwhile
   * every inbound logged `type=unknown` and `no_active_conversation`.
   *
   * Cause: `const p = body.payload || body.message || body.data || body`. The
   * real Gallabox envelope carries a `message` key, so it won the chain and
   * every field was then read out of an object that does not hold them — the
   * sender resolved to something other than the customer's number, and their
   * words were at no probed path.
   *
   * The SAME defect sat in normaliseStatus and had silently broken delivery
   * receipts for as long as they had existed. One idiom, two functions, two
   * outages: an `||` chain over candidate envelopes asserts that the first
   * non-null one is correct, and is silent when it is not.
   */
  await withSecret(SECRET, async () => {
    lines = [];
    const status = await postBody({
      from: '919812345678',
      id: 'wamid.TEST123',
      type: 'text',
      text: { body: 'Yes, confirm' },
      // Present on the real envelope, and holds none of the above.
      message: { recipient_id: '918888888888' },
    });
    assert.equal(status, 200);
    const t = logText();
    assert.match(t, /WhatsApp inbound · type=text/, 'the reply is read as text, not "unknown"');
    assert.equal(/CONTENT NOT FOUND/.test(t), false, 'and its content is found');
    assert.match(t, /messageId=wamid\.TEST123/, 'the id comes from the OUTER envelope, not the nested one');
  });
});

test('a button reply nested one level deeper is still routed', async () => {
  // Quick replies are the whole confirm/reschedule/not-required flow; the
  // buttonId IS the routing key, so losing it to the same shadowing would send
  // a confirming customer nowhere.
  await withSecret(SECRET, async () => {
    lines = [];
    assert.equal(await postBody({
      id: 'wamid.BTN',
      payload: { from: '919812345678', interactive: { button_reply: { id: 'confirm_order' } } },
      message: { recipient_id: '918888888888' },
    }), 200);
    const t = logText();
    assert.match(t, /type=button/);
    assert.match(t, /buttonId="confirm_order"/);
  });
});
