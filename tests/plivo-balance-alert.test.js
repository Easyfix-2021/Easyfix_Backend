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

test('a BLANK recipient list is the off switch — nothing is sent', async () => {
  /*
   * The list is also the on/off control, so there must be no built-in
   * fallback: with one, clearing the property would not turn the alert off and
   * the documented switch would silently do nothing.
   */
  store.set('plivo.balance.alert.recipients', '   ');
  const r = await cron.run();
  assert.deepEqual(cron.recipients(), []);
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'no-recipients');
  assert.equal(sent.length, 0);
});

test('a MISSING recipient key is off too, not a default', async () => {
  const r = await cron.run();
  assert.equal(r.sent, false);
  assert.equal(sent.length, 0,
    'the migration seeds the addresses; the code must not smuggle them back in, '
    + 'or blanking the property could never disable this');
});

test('it still notices the low balance while silenced', async () => {
  const r = await cron.run();
  assert.equal(r.low, true, 'off means "do not tell anyone", not "do not look"');
});

test('the repeat cadence is fixed at one hour, not configurable', () => {
  assert.equal(cron.REPEAT_HOURS, 1);
  store.set('plivo.balance.alert.repeat_hours', '99');
  assert.equal(cron.repeatHours(), 1,
    'a property here would only invite a value that makes the alert noise or silence');
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
  store.set('plivo.balance.alert.recipients', 'ops@x.com');
  scenario.balance = { ok: true, cashCredits: 0 };
  const r = await cron.run();
  assert.equal(r.sent, true);
});

test('it does not repeat inside the cooldown', async () => {
  store.set('plivo.balance.alert.recipients', 'ops@x.com');
  await cron.run();
  assert.equal(sent.length, 1);
  await cron.run();
  assert.equal(sent.length, 1, 'a three-hourly repeat is how an alert becomes noise');
});

test('it repeats once the cooldown has passed', async () => {
  store.set('plivo.balance.alert.recipients', 'ops@x.com');
  await cron.run();
  const old = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  store.set(cron.STATE_KEY, old);
  await cron.run();
  assert.equal(sent.length, 2, 'still low after the cadence — say so again');
});

test('recovery clears the stamp, so the NEXT dip alerts immediately', async () => {
  store.set('plivo.balance.alert.recipients', 'ops@x.com');
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
  store.set('plivo.balance.alert.recipients', 'ops@x.com');
  email.send = async () => { throw new Error('SMTP down'); };
  await assert.rejects(() => cron.run(), /SMTP down/);
  assert.equal(store.get(cron.STATE_KEY), undefined,
    'stamping before the send would swallow the one alert that mattered');
  email.send = async (msg) => { sent.push(msg); };
  await cron.run();
  assert.equal(sent.length, 1);
});


