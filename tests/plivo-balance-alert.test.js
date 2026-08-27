const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

/*
 * The low-balance alert.
 *
 * An out-of-credit Plivo blocks calling INVISIBLY — the API accepts each call,
 * the server answers 200, and the leg dies at signalling. The panel warning
 * reaches whoever is already blocked; this reaches the people who can top the
 * account up, before that.
 *
 * Two failure modes matter more than the happy path, and both are about
 * CREDIBILITY. An alert that fires when Plivo is merely unreachable gets
 * filtered, and then the real one lands in the same folder. An alert that
 * repeats every three hours does the same thing more slowly.
 */

const props = require('../services/properties.service');
const plivo = require('../services/plivo.service');
const email = require('../services/email.service');
const cron = require('../services/plivo-balance-alert-cron');

const store = new Map();
const sent = [];
const scenario = { balance: { ok: true, cashCredits: 1, autoRecharge: false } };

props.getProperty = (k) => store.get(k);
props.setProperty = async (k, v) => { store.set(k, v); };
plivo.accountBalance = async () => scenario.balance;
plivo.lowBalanceThreshold = () => Number(store.get('plivo.balance.threshold') ?? 5);
email.send = async (msg) => { sent.push(msg); };

beforeEach(() => { store.clear(); sent.length = 0; scenario.balance = { ok: true, cashCredits: 1, autoRecharge: false }; });
after(() => {});

test('a low balance emails the configured people', async () => {
  store.set('plivo.balance.alert.recipients', 'a@x.com, b@y.com');
  const r = await cron.run();
  assert.equal(r.sent, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ['a@x.com', 'b@y.com']);
  assert.match(sent[0].subject, /Plivo credit low/);
  assert.match(sent[0].text, /top up the Plivo account/i);
  assert.match(sent[0].text, /"Busy"/, 'the mail must name the symptom they will actually be told about');
});

test('with no recipients configured it falls back to the two who asked for it', () => {
  assert.deepEqual(cron.recipients(), ['priyanka@easyfix.in', 'harshit@channelplay.in']);
});

test('an UNREADABLE balance never alerts', async () => {
  for (const bad of [
    { ok: false, reason: 'error' },
    { ok: false, httpStatus: 500 },
    { ok: false, reason: 'no-balance-field' },
    { ok: false, reason: 'not-configured' },
  ]) {
    store.clear(); sent.length = 0;
    scenario.balance = bad;
    const r = await cron.run();
    assert.equal(r.known, false);
    assert.equal(sent.length, 0,
      'not knowing the balance is not knowing it is low — mailing here would '
      + 'fire on every Plivo hiccup and get the real alert filtered');
  }
});

test('a healthy balance is silent', async () => {
  scenario.balance = { ok: true, cashCredits: 500 };
  const r = await cron.run();
  assert.equal(r.low, false);
  assert.equal(sent.length, 0);
});

test('zero is LOW, not unknown — it is the case that blocked production', async () => {
  scenario.balance = { ok: true, cashCredits: 0 };
  const r = await cron.run();
  assert.equal(r.sent, true);
});

test('it does not repeat inside the cooldown', async () => {
  await cron.run();
  assert.equal(sent.length, 1);
  await cron.run();
  assert.equal(sent.length, 1, 'a three-hourly repeat is how an alert becomes noise');
});

test('it repeats once the cooldown has passed', async () => {
  await cron.run();
  const old = new Date(Date.now() - 13 * 3600 * 1000).toISOString();
  store.set(cron.STATE_KEY, old);
  await cron.run();
  assert.equal(sent.length, 2, 'still low after the cadence — say so again');
});

test('recovery clears the stamp, so the NEXT dip alerts immediately', async () => {
  await cron.run();
  assert.ok(store.get(cron.STATE_KEY), 'stamped');

  scenario.balance = { ok: true, cashCredits: 500 };
  await cron.run();
  assert.equal(store.get(cron.STATE_KEY), '',
    'without this, a top-up followed by a fast drain would sit out a cooldown '
    + 'that started before the top-up');

  scenario.balance = { ok: true, cashCredits: 1 };
  await cron.run();
  assert.equal(sent.length, 2, 'the dip after a recovery is reported at once');
});

test('auto-recharge accounts are left alone', async () => {
  scenario.balance = { ok: true, cashCredits: 1, autoRecharge: true };
  const r = await cron.run();
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'auto-recharge');
});

test('a failed send is NOT stamped, so the next run retries', async () => {
  email.send = async () => { throw new Error('SMTP down'); };
  await assert.rejects(() => cron.run(), /SMTP down/);
  assert.equal(store.get(cron.STATE_KEY), undefined,
    'stamping before the send would swallow the one alert that mattered');
  email.send = async (msg) => { sent.push(msg); };
  await cron.run();
  assert.equal(sent.length, 1);
});

test('the repeat cadence is clamped against a mail loop', () => {
  store.set('plivo.balance.alert.repeat_hours', '0');
  assert.ok(cron.repeatHours() >= 1, '0 must not mean "every run"');
  store.set('plivo.balance.alert.repeat_hours', '100000');
  assert.ok(cron.repeatHours() <= 168, 'nor may it go quiet for a month');
});
