/*
 * The three UX defects a LIVE production run surfaced on job 523247
 * (2026-08-18), and what now prevents each of them.
 *
 * The run, from the log:
 *   21:20:09  button "Need a Reschdeule"  → handled
 *   21:20:34  text   "20th Aig"           → NOT parsed, customer re-asked
 *   21:21:06  text   "20th Aug"           → captured
 *   21:22:20  text   "6.30pm"             → confirmed, slot 6 PM–7 PM
 *
 *  1. "20th Aig" MUST BE UNDERSTOOD WITHOUT THE AI. An AI fallback was already
 *     wired at the reschedule step — and it has never run in production, because
 *     it needs AI_CONVERSATION_ENABLED='true' AND SOPHY_API_KEY_CONVERSATION,
 *     and 676k lines of production log across 8 days contain not one AI success,
 *     not one AI failure and not one mention of Sophy. So the DETERMINISTIC
 *     parser tolerates a one-character month typo itself, and the AI stays the
 *     last resort. The fuzziness is tiny on purpose: a wrongly-guessed month
 *     silently books the wrong day, which is far worse than a re-ask, so an
 *     AMBIGUOUS typo must return null rather than pick a side.
 *  2. THE DISABLED AI SAYS SO — ONCE. "Off" and "on but could not read it" used
 *     to be indistinguishable in the logs, which is what made defect 1 take a
 *     log-corpus sweep to find. One line per process, naming which condition
 *     failed; NOT one line per message (this flow takes ~14k inbound messages a
 *     week and the signal would drown in itself).
 *  3. THE PROMPTS ASK PROPERLY. The slot question listed all ten frames (ten
 *     lines nobody reads) — it now offers 3–5 as EXAMPLES while still accepting
 *     any time in the working day, which the same live run proves customers use
 *     ("6.30pm"). And the extras message opened "Two optional extras — feel free
 *     to ignore this message", so customers said "later" — outside the 24-hour
 *     WhatsApp session window, where free text stops working and the details
 *     never arrive. It now asks directly, in this session, while still letting
 *     the customer send nothing at all.
 *
 * No DB, no network: fake pool + stubbed senders, the same harness as
 * tests/whatsapp-conversation.test.js and tests/whatsapp-conversation-phrasing.test.js.
 * Runner: `node --test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeFakePool } = require('./helpers/fake-pool');

const convo = require('../services/whatsapp-conversation.service');
const gallabox = require('../services/gallabox.whatsapp.service');
const jml = require('../services/job-magic-link.service');
const logger = require('../logger');

// The same fixed instant the sibling test file uses: 2026-08-05 10:30 IST (Wed).
const NOW = Date.parse('2026-08-05T05:00:00Z');

// ── 1. Typo-tolerant month names (the "20th Aig" defect) ────────────────

test('an obvious month-name typo resolves WITHOUT the AI', () => {
  // The exact message from the live run. Before the fuzzy pass this was null,
  // the customer got "Sorry, I couldn’t read that date." and had to retype.
  assert.equal(convo.parseCustomerDate('20th Aig', NOW), '2026-08-20');
  assert.equal(convo.parseCustomerDate('20 aig 2026', NOW), '2026-08-20', 'an explicit year still wins');

  /*
   * ⚠ THE GATE, AND WHAT IT DELIBERATELY GIVES UP.
   *
   * A fuzzy month is accepted ONLY when the text is unmistakably a date — an
   * ordinal suffix ("20th") or an explicit year. Both live-run messages had
   * one. Bare "jly 5" has neither, so it no longer resolves fuzzily, and that
   * is the price of not booking "20 not possible" as 20 November.
   *
   * Distance alone cannot tell "aig" from "not": both sit one edit from exactly
   * one month, so no ambiguity guard can separate them. Context can.
   */
  assert.equal(convo.parseCustomerDate('jly 5', NOW), null,
    'no ordinal and no year — it re-asks, or the AI reads it once a key is set');
  assert.equal(convo.parseCustomerDate('jly 5 2027', NOW), '2027-07-05', 'with a year it resolves');
  assert.equal(convo.parseCustomerDate('5th jly', NOW), '2027-07-05', 'and with an ordinal');

  // These three already worked BEFORE the fuzzy pass — the old monthIndex does
  // slice(0,3), so "septmber"->"sep" and "augst"->"aug" are exact hits. Kept as
  // regression cover, not as evidence of the new behaviour.
  assert.equal(convo.parseCustomerDate('septmber 9', NOW), '2026-09-09', 'a dropped letter in a full month name');
  assert.equal(convo.parseCustomerDate('11 augst', NOW), '2026-08-11');
  assert.equal(convo.parseCustomerDate('marc 3 2027', NOW), '2027-03-03');
});

test('an AMBIGUOUS typo returns null rather than guessing a month', () => {
  /*
   * "man" is ONE edit from mar, may AND jan; "mac" from mar and may. Picking
   * one would book a visit weeks or months from the day the customer meant,
   * silently. A re-ask is the cheap failure; the wrong day is the expensive one.
   */
  assert.equal(convo.parseCustomerDate('20th Man', NOW), null);
  assert.equal(convo.parseCustomerDate('5 mac', NOW), null);
  assert.equal(convo.parseCustomerDate('mai 5', NOW), null, 'one edit from both may and mar');
});

test('a weekday is never "corrected" into a month', () => {
  // "sun" is exactly one edit from "jun". Turning Sunday into June would be the
  // same wrong-day failure the ambiguity guard exists to prevent.
  assert.equal(convo.parseCustomerDate('20 sun', NOW), '2026-08-09', 'the next Sunday, not 20 June');
  assert.equal(convo.parseCustomerDate('sunday', NOW), '2026-08-09');
  assert.equal(convo.parseCustomerDate('next monday', NOW), '2026-08-10');
});

test('real month names parse EXACTLY as before — the fuzzy pass is a fallback only', () => {
  assert.equal(convo.parseCustomerDate('11 Aug', NOW), '2026-08-11');
  assert.equal(convo.parseCustomerDate('11th August 2026', NOW), '2026-08-11');
  assert.equal(convo.parseCustomerDate('Aug 11', NOW), '2026-08-11');
  assert.equal(convo.parseCustomerDate('2 Jan', NOW), '2027-01-02', 'still rolls forward a passed date');
  assert.equal(convo.parseCustomerDate('tomorrow', NOW), '2026-08-06');
  assert.equal(convo.parseCustomerDate('11-08-2026', NOW), '2026-08-11');
  assert.equal(convo.parseCustomerDate('2026-08-11', NOW), '2026-08-11');
});

test('garbage is still garbage — the fuzzy pass must not invent a date', () => {
  assert.equal(convo.parseCustomerDate('sometime next week maybe', NOW), null);
  assert.equal(convo.parseCustomerDate('whenever you like', NOW), null);
  assert.equal(convo.parseCustomerDate('5 zzz', NOW), null);
  assert.equal(convo.parseCustomerDate('plot 7 sector 45', NOW), null, 'an address is not a date');

  /*
   * ⚠ THE CORPUS THAT ACTUALLY MATTERS. Nonsense like '5 zzz' passes whatever
   * the fuzzy pass does — it is not near any month. The fuzzy pass only ever
   * misfired on REAL WORDS, because almost every three-letter English word is
   * one edit from exactly one month abbreviation, so the cross-month ambiguity
   * guard never fires for them. Before the date-shape gate, ALL of these
   * resolved, were accepted (validateAppointment has no forward horizon), were
   * echoed back to the customer as a confirmed date, and were written to
   * tbl_job.requested_date_time on the next reply:
   */
  for (const [text, was] of [
    ['in 5 day',        '2027-05-05'],   // day ~ may
    ['20 not possible', '2026-11-20'],   // not ~ nov  — a customer DECLINING a date
    ['come at 5 now',   '2026-11-05'],   // now ~ nov
    ['15 can',          '2027-01-15'],   // can ~ jan
    ['5 opt',           '2026-10-05'],   // opt ~ oct
    ['5 out',           '2026-10-05'],   // out ~ oct
    ['flat no 5 apt 3', '2027-04-05'],   // apt ~ apr — an ADDRESS
    ['room 5 den',      '2026-12-05'],   // den ~ dec
    ['3 day',           '2027-05-03'],
    ['after 10 day',    '2027-05-10'],
  ]) {
    assert.equal(convo.parseCustomerDate(text, NOW), null,
      `"${text}" must not book a visit (it used to resolve to ${was})`);
  }

  /*
   * The property, not just the examples: sweep every three-letter token and
   * require that the only ones accepted are real date words. 743 of 17,576 were
   * accepted before the gate, 157 of them ordinary English.
   */
  const DATE_WORDS = new Set([
    'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
    'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',   // weekdays — the exact parser's
    'aaj', 'kal', 'tmr',                                // today / tomorrow, pre-existing
  ]);
  const a = 'abcdefghijklmnopqrstuvwxyz';
  const accepted = [];
  for (const x of a) for (const y of a) for (const z of a) {
    const t = x + y + z;
    if (convo.parseCustomerDate('5 ' + t, NOW)) accepted.push(t);
  }
  const strays = accepted.filter((t) => !DATE_WORDS.has(t));
  assert.deepEqual(strays, [],
    `these tokens resolve to a date but are not date words: ${strays.join(' ')}`);
  assert.equal(convo.parseCustomerDate('31 Feb', NOW), null, 'an impossible date must not roll over to March');
  assert.equal(convo.parseCustomerDate('31 Febuary', NOW), null, 'and not via the typo path either');
  assert.equal(convo.parseCustomerDate('', NOW), null);
  assert.equal(convo.parseCustomerDate(null, NOW), null);
});

// ── 2. The slot shortlist ───────────────────────────────────────────────

test('shortlistSlots offers 3–5 frames, centred on the appointment when we know it', () => {
  assert.ok(convo.SLOT_SHORTLIST_SIZE >= 3 && convo.SLOT_SHORTLIST_SIZE <= 5,
    'product asked for 3–5 suggestions, not ten');
  assert.equal(convo.shortlistSlots(16).length, convo.SLOT_SHORTLIST_SIZE);
  assert.ok(convo.shortlistSlots(16).some((s) => s.hour === 16),
    'the hour the job is already booked for must be one of the suggestions');
  // Clamped at both ends of the working day — never a window running off the edge.
  assert.deepEqual(convo.shortlistSlots(9).map((s) => s.hour), [9, 10, 11, 12]);
  assert.deepEqual(convo.shortlistSlots(18).map((s) => s.hour), [15, 16, 17, 18]);
  // No usable hour → a spread across the day, NOT the first N (which would
  // always say 9 AM and make an evening customer scroll for nothing).
  assert.deepEqual(convo.shortlistSlots(null).map((s) => s.hour), [9, 12, 15, 18]);
  /*
   * The sentinel and working-day guards live in contextSlotHour, NOT here —
   * shortlistSlots takes a NUMBER. Asserting shortlistSlots('00:00') passed for
   * the wrong reason: Number('00:00') is NaN, so EVERY string returns the
   * spread, '16:00' included. Test the function that actually decides.
   */
  assert.equal(convo.contextSlotHour({ offered_hour: '00:00' }), null,
    'the legacy midnight sentinel is not an appointment hour');
  assert.equal(convo.contextSlotHour({ offered_hour: '16:00' }), 16, 'a real hour is read back');
  assert.equal(convo.contextSlotHour({}), null, 'a legacy row with no seeded hour falls to the spread');
  assert.equal(convo.contextSlotHour({ offered_hour: '23:00' }), null, 'outside the working day');
});

// ── Flow harness (shared by the prompt/extras tests) ────────────────────

const MOBILE = '919876543210';
// Far-future so the past-appointment gate never turns these fixtures into a
// reschedule prompt as the calendar moves.
const DATE = '2099-03-04';
const DATE_LABEL = convo.formatCustomerDateLabel(DATE);

function stubOutbound() {
  const sent = [];
  const writes = [];
  const originals = {
    sendText: gallabox.sendText,
    sendButtons: gallabox.sendButtons,
    sendLocationRequest: gallabox.sendLocationRequest,
    writeCustomerOrderDetails: jml.writeCustomerOrderDetails,
  };
  gallabox.sendText = async (args) => { sent.push({ kind: 'text', ...args }); return { delivered: true }; };
  gallabox.sendButtons = async (args) => { sent.push({ kind: 'buttons', ...args }); return { delivered: true }; };
  gallabox.sendLocationRequest = async (args) => { sent.push({ kind: 'location_request', ...args }); return { delivered: true }; };
  jml.writeCustomerOrderDetails = async (jobId, fields) => { writes.push({ jobId, fields }); return { ok: true }; };
  return {
    sent,
    writes,
    bodies: () => sent.map((s) => s.body),
    restore() {
      Object.assign(gallabox, originals);
      jml.writeCustomerOrderDetails = originals.writeCustomerOrderDetails;
    },
  };
}

// AI OFF for every flow test here: the deterministic copy IS the product, and
// these tests are about that copy. (It is also the production reality.)
function setAiOff() {
  const before = {
    enabled: process.env.AI_CONVERSATION_ENABLED,
    key: process.env.SOPHY_API_KEY_CONVERSATION,
  };
  process.env.AI_CONVERSATION_ENABLED = 'false';
  delete process.env.SOPHY_API_KEY_CONVERSATION;
  return () => {
    if (before.enabled === undefined) delete process.env.AI_CONVERSATION_ENABLED;
    else process.env.AI_CONVERSATION_ENABLED = before.enabled;
    if (before.key === undefined) delete process.env.SOPHY_API_KEY_CONVERSATION;
    else process.env.SOPHY_API_KEY_CONVERSATION = before.key;
  };
}

function fixture(over = {}, ctxOver = {}) {
  const row = {
    conversation_id: 900,
    job_id: 523247,
    customer_mob_no: MOBILE,
    status: 'active',
    current_step: convo.STEP.SLOT,
    context: JSON.stringify({
      offered_date: DATE,
      offered_date_label: DATE_LABEL,
      confirmed_date: DATE,
      branch: 'confirm',
      ...ctxOver,
    }),
    expires_at: new Date(Date.now() + 6 * 3600 * 1000),
    ...over,
  };
  return makeFakePool([
    [/SELECT \* FROM tbl_whatsapp_conversation/, [row]],
    [/UPDATE tbl_whatsapp_conversation/, { affectedRows: 1 }],
  ]);
}

const inbound = (over = {}) => ({ from: MOBILE, type: 'text', messageId: 'wamid.ux1', ...over });

// The slot labels that actually appear in a message body.
const listedSlots = (body) => convo.ONE_HOUR_SLOT_LABELS.filter((l) => String(body).includes(l));

// ── 3. The slot PROMPT narrows; the PARSER does not ─────────────────────

test('the slot prompt lists 3–5 slots, not all ten', async () => {
  const restoreEnv = setAiOff();
  const out = stubOutbound();
  try {
    const res = await convo.handleInbound(
      inbound({ type: 'button', buttonId: convo.BTN_PAYLOAD.CONFIRM }),
      fixture({ current_step: convo.STEP.CHOICE }).pool,
    );
    assert.equal(res.step, convo.STEP.SLOT);
    const body = out.bodies()[0];
    const listed = listedSlots(body);
    assert.ok(listed.length >= 3 && listed.length <= 5,
      `the prompt listed ${listed.length} slots: ${JSON.stringify(listed)}`);
    assert.ok(listed.length < convo.ONE_HOUR_SLOT_LABELS.length, 'ten lines is what product rejected');
  } finally { out.restore(); restoreEnv(); }
});

test('the slot prompt says the list is a SUGGESTION, never the whole menu', async () => {
  const restoreEnv = setAiOff();
  const out = stubOutbound();
  try {
    await convo.handleInbound(
      inbound({ type: 'button', buttonId: convo.BTN_PAYLOAD.CONFIRM }),
      fixture({ current_step: convo.STEP.CHOICE }).pool,
    );
    const body = out.bodies()[0];
    assert.match(body, /for example/i, 'the shortlist must be introduced as examples');
    assert.match(body, /any 1-hour slot between 9 AM and 7 PM/i,
      'the full accepted window must be stated, or the shortlist reads as the only choices');
    assert.doesNotMatch(body, /available slots/i, 'that phrasing presents the list as exhaustive');
    assert.doesNotMatch(body, /choose (one )?from|pick one of|must (choose|select)/i);
  } finally { out.restore(); restoreEnv(); }
});

test('the shortlist is CENTRED on the hour the job is already booked for', async () => {
  const restoreEnv = setAiOff();
  const out = stubOutbound();
  try {
    // The customer is confirming a 4 PM appointment, so 4 PM is the best
    // evidence of what suits them — mornings are not.
    await convo.handleInbound(
      inbound({ type: 'button', buttonId: convo.BTN_PAYLOAD.CONFIRM }),
      fixture({ current_step: convo.STEP.CHOICE }, { offered_hour: '16:00' }).pool,
    );
    const body = out.bodies()[0];
    assert.ok(body.includes('4 PM–5 PM'), 'their own hour must be offered');
    assert.ok(!body.includes('9 AM–10 AM'), 'a 4 PM customer should not be led with 9 AM');
  } finally { out.restore(); restoreEnv(); }
});

test('a time OUTSIDE the shortlist still books — the shortlist is a prompt, not a constraint', async () => {
  const restoreEnv = setAiOff();
  const out = stubOutbound();
  try {
    // Shortlist centred on a 9 AM booking → mornings only …
    await convo.handleInbound(
      inbound({ type: 'button', buttonId: convo.BTN_PAYLOAD.CONFIRM }),
      fixture({ current_step: convo.STEP.CHOICE }, { offered_hour: '09:00' }).pool,
    );
    const prompt = out.bodies()[0];
    assert.ok(!prompt.includes('6 PM–7 PM'), 'precondition: the evening frame was NOT offered');

    // … and the customer types the free time from the live run anyway.
    const res = await convo.handleInbound(
      inbound({ text: '6.30pm', messageId: 'wamid.ux2' }),
      fixture({ current_step: convo.STEP.SLOT }, { offered_hour: '09:00' }).pool,
    );
    assert.equal(res.confirmed, true);
    assert.equal(out.writes.length, 1);
    assert.equal(out.writes[0].fields.requested_date_time, `${DATE} 18:00:00`,
      'a time we never listed is still accepted and still written');
    assert.equal(out.writes[0].fields.requested_time, '18:00');
  } finally { out.restore(); restoreEnv(); }
});

// ── 4. The extras message ASKS; it does not offer ───────────────────────

async function extrasPromptBody() {
  const out = stubOutbound();
  try {
    await convo.handleInbound(inbound({ text: '4 pm', messageId: 'wamid.ux3' }), fixture().pool);
    const ask = out.sent.find((s) => s.kind === 'location_request');
    assert.ok(ask, 'the extras prompt is the location-request interactive message');
    return ask.body;
  } finally { out.restore(); }
}

test('the extras copy contains none of "optional", "ignore" or "later"', async () => {
  const restoreEnv = setAiOff();
  try {
    const body = await extrasPromptBody();
    /*
     * A customer told something is optional replies "later" — and later is
     * outside the 24-hour WhatsApp session window, where free-text replies stop
     * working and the photos/pin can no longer reach us at all. Getting them in
     * THIS session is the entire point of asking here.
     */
    assert.doesNotMatch(body, /optional/i);
    assert.doesNotMatch(body, /ignore/i);
    assert.doesNotMatch(body, /later/i);
    assert.doesNotMatch(body, /feel free/i);
  } finally { restoreEnv(); }
});

test('the extras copy asks for the pin and the photos, framed by what they buy', async () => {
  const restoreEnv = setAiOff();
  try {
    const body = await extrasPromptBody();
    assert.match(body, /location pin/i);
    assert.match(body, /photo/i);
    assert.match(body, /technician/i, 'the reason to send them is the technician arriving prepared');
    assert.match(body, /button below/i, 'the native location button is still what they tap');
  } finally { restoreEnv(); }
});

/*
 * NB: this exercises the "Done" path with no media attached. A customer who
 * sends NOTHING AT ALL is not a state-machine case at all — finaliseConfirmed
 * already committed the job via jml.writeCustomerOrderDetails BEFORE
 * sendExtrasPrompt runs, so the row simply rests at awaiting_extras until
 * expires_at (SESSION_HOURS = 24) and any later inbound routes to
 * reengageExpired. That is stated rather than asserted, because no test here
 * can observe it.
 */
test('asking directly does not TRAP the customer — "Done" with nothing attached still completes', async () => {
  const restoreEnv = setAiOff();
  const out = stubOutbound();
  try {
    const res = await convo.handleInbound(
      inbound({ text: 'Done', messageId: 'wamid.ux4' }),
      fixture({ current_step: convo.STEP.EXTRAS }, { finalised: true }).pool,
    );
    assert.equal(res.step, 'completed', 'the state machine still closes on "Done" with nothing sent');
    assert.match(out.bodies().join('\n'), /all set/i);
  } finally { out.restore(); restoreEnv(); }
});

// ── 5. A disabled AI announces itself — exactly once ────────────────────

/*
 * A fresh module instance per test: the "have we warned yet" flag is
 * module-scope BY DESIGN (that is the whole once-per-process mechanism), so the
 * only honest way to exercise it twice is to load the module twice. The
 * original instance is restored in require.cache afterwards so the rest of this
 * file keeps talking to the same ai.service the conversation service holds.
 */
function withFreshAi(run) {
  const id = require.resolve('../services/ai.service');
  const original = require.cache[id];
  delete require.cache[id];
  const fresh = require('../services/ai.service');
  const warnings = [];
  const originalWarn = logger.warn;
  logger.warn = (...args) => { warnings.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  return Promise.resolve()
    .then(() => run(fresh, warnings))
    .finally(() => {
      logger.warn = originalWarn;
      require.cache[id] = original;
    });
}

function setAiEnv({ flag, key }) {
  const before = {
    flag: process.env.AI_CONVERSATION_ENABLED,
    key: process.env.SOPHY_API_KEY_CONVERSATION,
  };
  if (flag === undefined) delete process.env.AI_CONVERSATION_ENABLED;
  else process.env.AI_CONVERSATION_ENABLED = flag;
  if (key === undefined) delete process.env.SOPHY_API_KEY_CONVERSATION;
  else process.env.SOPHY_API_KEY_CONVERSATION = key;
  return () => {
    if (before.flag === undefined) delete process.env.AI_CONVERSATION_ENABLED;
    else process.env.AI_CONVERSATION_ENABLED = before.flag;
    if (before.key === undefined) delete process.env.SOPHY_API_KEY_CONVERSATION;
    else process.env.SOPHY_API_KEY_CONVERSATION = before.key;
  };
}

test('a disabled AI logs ONCE per process, naming BOTH failing conditions', async () => {
  const restoreEnv = setAiEnv({ flag: 'false', key: undefined });
  try {
    await withFreshAi(async (ai, warnings) => {
      const first = await ai.interpretReply({ step: 'awaiting_reschedule_date', text: '20th Aig' });
      // The RETURN VALUE is unchanged — the caller still degrades to a re-ask.
      assert.deepEqual(first, { intent: 'unclear', disabled: true, confidence: 0 });

      const disabledLines = warnings.filter((w) => /AI NLU is DISABLED/.test(w));
      assert.equal(disabledLines.length, 1);
      assert.match(disabledLines[0], /AI_CONVERSATION_ENABLED/, 'name the flag');
      assert.match(disabledLines[0], /SOPHY_API_KEY_CONVERSATION/, 'and the key — not "the AI is off"');
      assert.match(disabledLines[0], /awaiting_reschedule_date/, 'and where it was first hit');

      // ~14,000 inbound messages a week: a per-message line would bury the
      // signal it exists to give.
      for (let i = 0; i < 5; i++) await ai.interpretReply({ step: 'awaiting_slot', text: 'morning' });
      assert.equal(warnings.filter((w) => /AI NLU is DISABLED/.test(w)).length, 1,
        'once per PROCESS, not once per message');
    });
  } finally { restoreEnv(); }
});

test('the warning names only the condition that actually failed', async () => {
  // Flag on, key missing: a reader must not have to go and diff two env vars.
  const restoreEnv = setAiEnv({ flag: 'true', key: undefined });
  try {
    await withFreshAi(async (ai, warnings) => {
      await ai.interpretReply({ step: 'awaiting_slot', text: 'anytime' });
      const line = warnings.find((w) => /AI NLU is DISABLED/.test(w));
      assert.ok(line);
      assert.match(line, /SOPHY_API_KEY_CONVERSATION is not set/);
      assert.doesNotMatch(line, /AI_CONVERSATION_ENABLED is not/, 'the flag is fine — do not blame it');
    });
  } finally { restoreEnv(); }
});

test('an ENABLED AI logs no disabled warning at all', async () => {
  const restoreEnv = setAiEnv({ flag: 'true', key: 'mw_live_test_key' });
  try {
    await withFreshAi(async (ai, warnings) => {
      // aiEnabled() is the gate under test; no network call is made here
      // because we never reach Sophy — the assertion is about the log line.
      assert.equal(ai.aiEnabled(), true);
      assert.equal(warnings.filter((w) => /AI NLU is DISABLED/.test(w)).length, 0);
    });
  } finally { restoreEnv(); }
});
