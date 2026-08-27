const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

/*
 * "Calls fail as Busy" has TWO invisible causes, and this covers the second.
 *
 * A Plivo account with no credit does not refuse anything: /Call/ returns, the
 * conference is created, the audit row is written, /web-start answers 200 in
 * 29ms, and the browser leg dies at signalling. Every log line is green. That
 * blocked calling on production on 2026-08-27 and was only found by opening the
 * Plivo console by hand.
 *
 * The balance is therefore read BEFORE dialling and reported through the same
 * `warnings` array the call panel already renders — no new UI path.
 *
 * The sharp edge is the DON'T-WARN case. An unreachable billing endpoint means
 * we do not know the balance, which is not the same as knowing it is low. A
 * banner that fires when Plivo is merely slow is one operators learn to ignore,
 * and then the real one does nothing.
 */

const plivo = require('../services/plivo.service');
const { clear } = require('../utils/ttl-cache');

const realFetch = global.fetch;
const scenario = { mode: 'ok', body: { cash_credits: '0.42' } };

global.fetch = async () => {
  if (scenario.mode === 'throw') throw new Error('ECONNRESET');
  if (scenario.mode === 'http-error') return { ok: false, status: 402 };
  return { ok: true, json: async () => scenario.body };
};

const savedId = process.env.PLIVO_AUTH_ID;
const savedTok = process.env.PLIVO_AUTH_TOKEN;
process.env.PLIVO_AUTH_ID = 'MA_TEST';
process.env.PLIVO_AUTH_TOKEN = 'tok';

after(() => {
  global.fetch = realFetch;
  if (savedId === undefined) delete process.env.PLIVO_AUTH_ID; else process.env.PLIVO_AUTH_ID = savedId;
  if (savedTok === undefined) delete process.env.PLIVO_AUTH_TOKEN; else process.env.PLIVO_AUTH_TOKEN = savedTok;
});
beforeEach(() => clear('plivo:account-balance'));

test('a real balance is read and parsed from the string Plivo sends', async () => {
  scenario.mode = 'ok'; scenario.body = { cash_credits: '12.3456' };
  const r = await plivo.accountBalance();
  assert.equal(r.ok, true);
  assert.equal(r.cashCredits, 12.3456);
});

test('an empty account reports zero, not "unknown"', async () => {
  scenario.mode = 'ok'; scenario.body = { cash_credits: '0.0000' };
  const r = await plivo.accountBalance();
  assert.deepEqual({ ok: r.ok, credits: r.cashCredits }, { ok: true, credits: 0 },
    'zero is a KNOWN balance and must warn — it is the case that blocked production');
});

test('an unreachable billing API is UNKNOWN, never zero', async () => {
  scenario.mode = 'throw';
  const r = await plivo.accountBalance();
  assert.equal(r.ok, false);
  assert.equal(r.cashCredits, undefined,
    'a network error must not be read as an empty account — that banner would '
    + 'fire on every Plivo hiccup and get ignored');
});

test('an HTTP error is UNKNOWN too', async () => {
  scenario.mode = 'http-error';
  const r = await plivo.accountBalance();
  assert.equal(r.ok, false);
  assert.equal(r.httpStatus, 402);
});

test('a missing cash_credits field is UNKNOWN, not NaN and not zero', async () => {
  scenario.mode = 'ok'; scenario.body = { something_else: 1 };
  const r = await plivo.accountBalance();
  assert.equal(r.ok, false, 'Number(undefined) is NaN — it must never reach the caller as a balance');
});

test('unconfigured credentials do not call out at all', async () => {
  const id = process.env.PLIVO_AUTH_ID;
  delete process.env.PLIVO_AUTH_ID;
  let called = false;
  const f = global.fetch;
  global.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  const r = await plivo.accountBalance();
  global.fetch = f;
  process.env.PLIVO_AUTH_ID = id;
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-configured');
  assert.equal(called, false, 'no point asking Plivo who we are without credentials');
});

test('the cached read hits the billing API once, not once per panel open', async () => {
  scenario.mode = 'ok'; scenario.body = { cash_credits: '7.00' };
  let calls = 0;
  const f = global.fetch;
  global.fetch = async () => { calls++; return { ok: true, json: async () => scenario.body }; };
  await plivo.accountBalanceCached();
  await plivo.accountBalanceCached();
  await plivo.accountBalanceCached();
  global.fetch = f;
  assert.equal(calls, 1, 'the panel fetches credentials every time it opens');
});
