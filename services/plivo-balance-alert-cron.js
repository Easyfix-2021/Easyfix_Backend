const logger = require('../logger');
const plivo = require('./plivo.service');
const email = require('./email.service');
/*
 * The MODULE, not destructured functions. Destructuring captures the reference
 * at require time, which makes this untestable without a live database — and
 * worse, a test that stubs it gets a green run against the REAL pool instead of
 * a failure. One of the tests below was passing vacuously that way before this
 * changed.
 */
const props = require('./properties.service');
const { withMysqlNamedLock } = require('./mysql-named-lock.service');

/*
 * Tell somebody the Plivo account is running out, BEFORE it blocks calling.
 *
 * On 2026-08-27 calling was dead on production for an unknown period. Nothing
 * failed: the API accepted every call, conferences were created, audit rows
 * were written, /web-start returned 200 in 29ms, and the browser legs died at
 * signalling. Operators saw "Busy". The account was simply empty, and the only
 * way anyone found out was by opening the Plivo console by hand.
 *
 * The call panel now warns whoever opens it (routes/admin/calls.js), but that
 * only reaches someone already trying to call — i.e. someone already blocked.
 * This is the half that reaches the people who can top it up, while there is
 * still credit to work with.
 *
 * EVERYTHING IS CONFIGURED FROM easyfix_properties, so ops can change who is
 * told and how loudly without a deploy:
 *
 *   plivo.balance.alert.enabled       'true' to register the job at boot
 *   plivo.balance.alert.recipients    CSV; defaults to the two people who
 *                                     asked for it
 *   plivo.balance.threshold           shared with the operator's banner, so the
 *                                     two cannot disagree about "low"
 *   plivo.balance.alert.repeat_hours  re-send cadence while it stays low
 *   plivo.balance.alert.last_sent_at  STATE, written by this job — not a knob
 */

const DEFAULT_RECIPIENTS = 'priyanka@easyfix.in,harshit@channelplay.in';
const STATE_KEY = 'plivo.balance.alert.last_sent_at';

function recipients() {
  const raw = String(props.getProperty('plivo.balance.alert.recipients') ?? '').trim()
    || DEFAULT_RECIPIENTS;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function repeatHours() {
  const n = Number(props.getProperty('plivo.balance.alert.repeat_hours'));
  // Floor of 1h so a misconfigured 0 cannot turn this into a mail loop; ceiling
  // of a week so it cannot go quiet for a month either.
  return Number.isFinite(n) && n > 0 ? Math.min(Math.max(n, 1), 168) : 12;
}

/*
 * Have we already told them recently?
 *
 * Kept in easyfix_properties rather than in memory on purpose: the app runs
 * several replicas and restarts on deploy, and an in-memory stamp would let
 * every replica send its own copy and start again after each restart. The
 * named lock below stops two replicas racing to write it.
 */
function sentWithinCooldown(nowMs) {
  const raw = String(props.getProperty(STATE_KEY) ?? '').trim();
  if (!raw) return false;
  const last = Date.parse(raw);
  if (!Number.isFinite(last)) return false;
  return nowMs - last < repeatHours() * 3600 * 1000;
}

function body({ credits, threshold }) {
  const lines = [
    `Plivo account credit is ${credits.toFixed(2)}, at or below the alert threshold of ${threshold}.`,
    '',
    'What happens when it reaches zero: outgoing calls keep being ACCEPTED by the',
    'API and then fail at signalling. The CRM shows "Busy", every server log line',
    'stays green, and nothing reports an error. Calling simply stops working with',
    'no visible cause.',
    '',
    'Action: top up the Plivo account.',
    '',
    `This alert repeats every ${repeatHours()}h while the balance stays low, and resets`,
    'once it recovers.',
  ];
  return lines.join('\n');
}

/*
 * Returns a small report rather than throwing, so the scheduler's log line can
 * say what happened and a test can assert on it.
 */
async function run() {
  const threshold = plivo.lowBalanceThreshold();
  const balance = await plivo.accountBalance();

  /*
   * NOT KNOWING IS NOT AN ALERT. An unreachable billing endpoint, an HTTP
   * error, or a response without cash_credits all mean we could not read the
   * balance — which is different from reading a low one. Mailing on those would
   * fire on every Plivo hiccup and train the recipients to filter this away,
   * and then the one that matters lands in the same folder.
   */
  if (!balance.ok) {
    logger.warn('Plivo balance alert · balance unknown (' + (balance.reason || balance.httpStatus) + ') — not alerting');
    return { checked: true, known: false, sent: false };
  }

  const credits = balance.cashCredits;

  if (credits > threshold) {
    /*
     * Recovered. Clearing the stamp means the NEXT dip alerts immediately
     * instead of waiting out a cooldown that started before the top-up.
     */
    if (String(props.getProperty(STATE_KEY) ?? '').trim()) {
      await props.setProperty(STATE_KEY, '');
      logger.info('Plivo balance recovered · credits=' + credits.toFixed(2) + ' — alert state cleared');
    }
    return { checked: true, known: true, credits, low: false, sent: false };
  }

  if (balance.autoRecharge) {
    logger.info('Plivo balance low but auto-recharge is ON · credits=' + credits.toFixed(2));
    return { checked: true, known: true, credits, low: true, sent: false, reason: 'auto-recharge' };
  }

  const now = Date.now();
  if (sentWithinCooldown(now)) {
    logger.info('Plivo balance still low · credits=' + credits.toFixed(2) + ' — inside the alert cooldown');
    return { checked: true, known: true, credits, low: true, sent: false, reason: 'cooldown' };
  }

  const to = recipients();
  if (!to.length) {
    logger.warn('Plivo balance low but no recipients configured (plivo.balance.alert.recipients)');
    return { checked: true, known: true, credits, low: true, sent: false, reason: 'no-recipients' };
  }

  await email.send({
    to,
    subject: `EasyFix · Plivo credit low (${credits.toFixed(2)}) — calling will stop`,
    text: body({ credits, threshold }),
    category: 'plivo-balance-alert',
  });
  /*
   * Stamped AFTER a successful send. If the mail throws, the stamp is not
   * written and the next run tries again — the failure mode is a retry, never
   * a silent skip of the one alert that mattered.
   */
  await props.setProperty(STATE_KEY, new Date().toISOString());
  logger.info('Plivo balance alert SENT · credits=' + credits.toFixed(2) + ' · to=' + to.join(', '));
  return { checked: true, known: true, credits, low: true, sent: true, to };
}

/* Scheduler entry point — one replica sends, not all of them. */
async function runOnce() {
  const { acquired, result } = await withMysqlNamedLock('plivo-balance-alert', run);
  if (!acquired) {
    logger.info('Plivo balance alert skipped — another replica holds the lock');
    return { checked: false, skipped: 'lock' };
  }
  return result;
}

module.exports = { run, runOnce, recipients, repeatHours, sentWithinCooldown, STATE_KEY, DEFAULT_RECIPIENTS };
