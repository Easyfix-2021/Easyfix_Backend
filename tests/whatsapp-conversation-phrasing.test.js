/*
 * The PHRASING layer of the WhatsApp confirmation flow: ai.service.composeMessage
 * (services/ai.service.js) and the `phrase()` seam that uses it
 * (services/whatsapp-conversation.service.js).
 *
 * ─── WHAT THIS FILE IS DEFENDING ──────────────────────────────────────────
 *
 * The state machine used to own every customer-facing word. It now hands the
 * QUESTION and the CONFIRMED FACTS to a model and sends what comes back. That
 * text goes to a customer over WhatsApp, in writing — so a model that invents an
 * appointment time, a price, a technician's name or a link has made a
 * commitment we then have to honour, or has sent someone to an address we do not
 * own. The boundary is therefore:
 *
 *     AI PHRASES. IT NEVER DECIDES, AND IT NEVER SUPPLIES FACTS.
 *
 * Every test here pins one half of that:
 *
 *  1. AI OFF ⇒ BYTE-IDENTICAL TO TODAY. This is the test that lets the feature
 *     ship. The deterministic copy is the PRODUCT, not an approximation of it,
 *     so the expected strings below are written out in full rather than
 *     rebuilt from the service's own helpers — a refactor that changes the copy
 *     must fail here and be a deliberate decision.
 *  2. JUNK GENERATION ⇒ FALLBACK, asserted PER CASE. Empty, absurdly long, a
 *     link we did not supply, a phone number / price / date we did not supply:
 *     each is a different way to mislead a customer, so each gets its own
 *     assertion rather than one "invalid output" test.
 *  3. SOPHY THROWING OR SLOW ⇒ FALLBACK, no throw, message still delivered. A
 *     customer's reply must never sit behind a model.
 *  4. THE FLOW IS PHRASING-INDEPENDENT. The same inbound is driven with
 *     generation on and off, and the step, the DB write and the next question
 *     are compared. If the state machine ever starts reading the generated text,
 *     this is what catches it.
 *  5. THE CONFIRMATION READS BACK THE ROW. Every fact in the closing message
 *     comes from the values just written, never from the model's memory.
 *
 * No DB, no network: fake pool + stubbed senders + a stubbed Sophy client, same
 * harness as tests/whatsapp-conversation.test.js.
 * Runner: `node --test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeFakePool } = require('./helpers/fake-pool');

const convo = require('../services/whatsapp-conversation.service');
const gallabox = require('../services/gallabox.whatsapp.service');
const jml = require('../services/job-magic-link.service');
const sophy = require('../services/sophy.service');

const MOBILE = '919876543210';
// Far-future so the past-appointment gate never turns this fixture into a
// reschedule prompt as the calendar moves.
const DATE = '2099-03-04';
const DATE_LABEL = convo.formatCustomerDateLabel(DATE);          // 'Wed, 04 Mar 2099'
const SLOT_LABEL = convo.slotForHour(16).label;                  // '4 PM–5 PM' (en dash)
/*
 * The slot question now offers a SHORTLIST, not all ten frames (product
 * feedback, 2026-08-18). This fixture's context carries no `offered_hour`, so
 * the shortlist is the fixed spread across the working day — written out
 * literally here, like every other expected string in this file.
 */
const SLOT_LIST = ['9 AM–10 AM', '12 PM–1 PM', '3 PM–4 PM', '6 PM–7 PM'].join('\n');

/* ── The copy as it stands today, written out in full ──────────────────────
 * Deliberately literal. Deriving these from the service would make the test
 * agree with whatever the service does, which is the opposite of the point.
 */
const TODAY = {
  slot: `Great — we’ll keep your visit on ${DATE_LABEL}.\n\n`
    + 'What time suits you best? Any 1-hour slot between 9 AM and 7 PM works — just reply with the start time (e.g. "10 AM" or "6.30 PM").\n\n'
    + `For example:\n${SLOT_LIST}`,
  slotRetry: 'Sorry, I couldn’t read that time.\n\n'
    + 'What time suits you best? Any 1-hour slot between 9 AM and 7 PM works — just reply with the start time (e.g. "10 AM" or "6.30 PM").\n\n'
    + `For example:\n${SLOT_LIST}`,
  reschedule: 'No problem — we’ll move your visit.\n\n'
    + 'Which date would you prefer? Please share a future date (e.g. "tomorrow", "5 Aug" or "05-08-2026").',
  cancelReason: 'Understood. May I know the reason? Please reply in your own words — it helps us improve.',
  confirmation: `Your visit is confirmed ✅\n\n🗓️ ${DATE_LABEL}\n⏰ ${SLOT_LABEL}\n\n`
    + 'Our technician will reach you within this 1-hour window. Thank you!',
};

// A generated confirmation that plays by the rules: it states only supplied
// facts, so it is the CONTROL for every rejection case below — if this one were
// also fallback, the junk tests would prove nothing.
const GOOD_CONFIRMATION = `All set! 🎉 We’ve booked your visit for ${DATE_LABEL}, between ${SLOT_LABEL}. `
  + 'Our technician will reach you within that 1-hour window — thank you for confirming!';

/*
 * Every outbound seam, plus the two seams that must NOT be reached by phrasing:
 * jml.writeCustomerOrderDetails (the commit) is stubbed so the flow can be
 * driven without a DB, and its arguments are captured because "what was
 * written" is what the confirmation must read back.
 */
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
    // The message bodies in order — what the customer actually read.
    bodies: () => sent.map((s) => s.body),
    restore() { Object.assign(gallabox, originals); jml.writeCustomerOrderDetails = originals.writeCustomerOrderDetails; },
  };
}

/*
 * Sophy stand-in. `reply` may return a string (the model's text), throw, or
 * return a promise that never settles (the slow-model case). Every prompt is
 * captured so a test can assert on what the model was ALLOWED to see.
 */
function stubSophy(reply) {
  const prompts = [];
  const original = sophy.chatText;
  sophy.chatText = async (args) => { prompts.push(args); return await reply(args); };
  return { prompts, restore() { sophy.chatText = original; } };
}

// AI_CONVERSATION_ENABLED + SOPHY_API_KEY_CONVERSATION are the existing gate
// (ai.service.aiEnabled). Phrasing reuses it and its fail-closed posture, so
// the tests drive the real env rather than a parallel switch.
function setAi(on) {
  const before = {
    enabled: process.env.AI_CONVERSATION_ENABLED,
    key: process.env.SOPHY_API_KEY_CONVERSATION,
    timeout: process.env.AI_CONVERSATION_TIMEOUT_MS,
  };
  if (on) {
    process.env.AI_CONVERSATION_ENABLED = 'true';
    process.env.SOPHY_API_KEY_CONVERSATION = 'mw_live_test_key';
  } else {
    process.env.AI_CONVERSATION_ENABLED = 'false';
    delete process.env.SOPHY_API_KEY_CONVERSATION;
  }
  return () => {
    for (const [k, v] of [
      ['AI_CONVERSATION_ENABLED', before.enabled],
      ['SOPHY_API_KEY_CONVERSATION', before.key],
      ['AI_CONVERSATION_TIMEOUT_MS', before.timeout],
    ]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

// An ACTIVE conversation row, as getActiveByMobile projects it.
function convoRow(over = {}) {
  return {
    conversation_id: 900,
    job_id: 42,
    customer_mob_no: MOBILE,
    status: 'active',
    current_step: convo.STEP.SLOT,
    context: JSON.stringify({ offered_date: DATE, offered_date_label: DATE_LABEL, confirmed_date: DATE, branch: 'confirm' }),
    expires_at: new Date(Date.now() + 6 * 3600 * 1000),
    ...over,
  };
}

function fixture(over) {
  return makeFakePool([
    [/SELECT \* FROM tbl_whatsapp_conversation/, [convoRow(over)]],
    [/UPDATE tbl_whatsapp_conversation/, { affectedRows: 1 }],
  ]);
}

const inbound = (over = {}) => ({ from: MOBILE, type: 'text', messageId: 'wamid.p1', ...over });

// ── 1. AI OFF ⇒ the current product, byte for byte ──────────────────────

test('AI disabled — the CONFIRMATION is exactly the message we send today', async () => {
  const restoreEnv = setAi(false);
  const out = stubOutbound();
  const ai = stubSophy(async () => 'this must never be reached');
  try {
    const res = await convo.handleInbound(inbound({ text: '4 pm' }), fixture().pool);
    assert.equal(res.step, convo.STEP.EXTRAS);
    assert.equal(res.confirmed, true);
    assert.equal(out.bodies()[0], TODAY.confirmation);
    assert.deepEqual(ai.prompts, [], 'the gate is fail-closed: no key, no call');
  } finally { ai.restore(); out.restore(); restoreEnv(); }
});

test('AI disabled — the SLOT question is exactly the message we send today', async () => {
  const restoreEnv = setAi(false);
  const out = stubOutbound();
  try {
    // Tapping "Yes, Confirm" at the choice step is what asks for a slot.
    const fake = fixture({ current_step: convo.STEP.CHOICE });
    const res = await convo.handleInbound(inbound({ type: 'button', buttonId: convo.BTN_PAYLOAD.CONFIRM }), fake.pool);
    assert.equal(res.step, convo.STEP.SLOT);
    assert.equal(out.bodies()[0], TODAY.slot);
  } finally { out.restore(); restoreEnv(); }
});

test('AI disabled — the slot RE-ASK is exactly the message we send today', async () => {
  const restoreEnv = setAi(false);
  const out = stubOutbound();
  try {
    const res = await convo.handleInbound(inbound({ text: 'whenever you like really' }), fixture().pool);
    assert.equal(res.step, convo.STEP.SLOT, 'unreadable time keeps us on the slot step');
    assert.equal(out.bodies()[0], TODAY.slotRetry);
  } finally { out.restore(); restoreEnv(); }
});

test('AI disabled — the RESCHEDULE and CANCEL-REASON questions are unchanged too', async () => {
  const restoreEnv = setAi(false);
  const out = stubOutbound();
  try {
    const resched = await convo.handleInbound(
      inbound({ type: 'button', buttonId: convo.BTN_PAYLOAD.RESCHEDULE }),
      fixture({ current_step: convo.STEP.CHOICE }).pool,
    );
    assert.equal(resched.step, convo.STEP.RESCHED_DATE);
    assert.equal(out.bodies()[0], TODAY.reschedule);

    const cancel = await convo.handleInbound(
      inbound({ type: 'button', buttonId: convo.BTN_PAYLOAD.NOT_REQUIRED, messageId: 'wamid.p2' }),
      fixture({ current_step: convo.STEP.CHOICE }).pool,
    );
    assert.equal(cancel.step, convo.STEP.CANCEL_REASON);
    assert.equal(out.bodies()[1], TODAY.cancelReason);
  } finally { out.restore(); restoreEnv(); }
});

// ── 2. Generation is allowed to help — and only that ────────────────────

test('a well-behaved generation IS used — the control for every rejection below', async () => {
  const restoreEnv = setAi(true);
  const out = stubOutbound();
  const ai = stubSophy(async () => GOOD_CONFIRMATION);
  try {
    await convo.handleInbound(inbound({ text: '4 pm' }), fixture().pool);
    assert.equal(out.bodies()[0], GOOD_CONFIRMATION);
    assert.notEqual(out.bodies()[0], TODAY.confirmation, 'if this were the fallback, the junk tests would prove nothing');
  } finally { ai.restore(); out.restore(); restoreEnv(); }
});

test('the model is handed the QUESTION and the FACTS — and told to use nothing else', async () => {
  const restoreEnv = setAi(true);
  const out = stubOutbound();
  const ai = stubSophy(async () => GOOD_CONFIRMATION);
  try {
    await convo.handleInbound(inbound({ text: '4 pm' }), fixture().pool);
    assert.equal(ai.prompts.length, 1);
    const { system, user } = ai.prompts[0];
    assert.match(user, /Confirmed facts/, 'the facts are supplied explicitly, not implied');
    assert.match(system, /Use ONLY the facts/i);
    assert.match(system, /NEVER invent/i);
    assert.match(system, /Do not include any URL/i);
    // The model gets the confirmed values and nothing that would let it invent
    // more: no job row, no customer record, no conversation transcript.
    assert.ok(user.includes(DATE_LABEL) && user.includes(SLOT_LABEL));
    assert.ok(!user.includes(MOBILE), 'the customer\'s phone number is not a fact this message needs');
  } finally { ai.restore(); out.restore(); restoreEnv(); }
});

// ── 3. Junk generation ⇒ the deterministic copy, asserted per case ──────

test('junk generation falls back — one assertion per way of misleading a customer', async () => {
  const cases = [
    ['empty', '  '],
    ['whitespace-only newlines', '\n\n'],
    ['absurdly long', `Thanks for confirming. ${'we are delighted to help you today. '.repeat(60)}`],
    ['a URL we did not supply', `Your visit on ${DATE_LABEL} is booked. Manage it here: https://easyfix-confirm.xyz/j/42`],
    ['a bare domain we did not supply', `Booked for ${DATE_LABEL}. More at easyfix-offers.com`],
    ['a phone number we did not supply', `Booked for ${DATE_LABEL}. Call the technician on 9812345678 if needed.`],
    ['a price we did not supply', `Booked for ${DATE_LABEL}. The visit charge is Rs 499.`],
    ['a date we did not supply', 'Your visit is confirmed for 9 September, between 7 PM and 8 PM.'],
    ['a time we did not supply', `Confirmed for ${DATE_LABEL}. The technician will arrive at 6 PM sharp.`],
  ];
  for (const [label, generated] of cases) {
    const restoreEnv = setAi(true);
    const out = stubOutbound();
    const ai = stubSophy(async () => generated);
    try {
      const res = await convo.handleInbound(inbound({ text: '4 pm' }), fixture().pool);
      assert.equal(out.bodies()[0], TODAY.confirmation,
        `${label}: the customer must get the deterministic copy instead`);
      assert.equal(res.confirmed, true, `${label}: and the booking still stands`);
    } finally { ai.restore(); out.restore(); restoreEnv(); }
  }
});

test('the validator names WHICH rule was broken', () => {
  // Reported separately because they are separate failures: a rambling model is
  // an operational problem, an invented link or amount is a customer-facing one.
  const ai = require('../services/ai.service');
  const allowed = `arrive within this 1-hour window\n- visit date: ${DATE_LABEL}\n- time window: ${SLOT_LABEL}`;
  const v = (text) => ai.validateGenerated(text, { allowed, maxChars: 700 });

  assert.equal(v('').reason, 'empty');
  assert.equal(v('x'.repeat(701)).reason, 'too_long');
  assert.equal(v('tap https://not-ours.example/x').reason, 'unsupplied_url');
  assert.equal(v('call 9812345678').reason, 'unsupplied_number');
  assert.equal(v(`See you ${DATE_LABEL}, ${SLOT_LABEL} — within the 1-hour window.`).ok, true);
  // '04' was supplied, so a natural '4 Mar' is not an invention. Leading zeros
  // are the only normalisation; nothing else is forgiven.
  assert.equal(v('See you on 4 Mar 2099.').ok, true);
  // A model wrapping its one-line answer in quotes is presentation noise, not
  // content — unwrapped rather than rejected.
  assert.equal(v(`"See you ${DATE_LABEL}."`).text, `See you ${DATE_LABEL}.`);
});

// ── 4. Sophy failing or slow ⇒ fallback, and the message still goes ─────

test('Sophy THROWING never reaches the customer or the webhook', async () => {
  const restoreEnv = setAi(true);
  const out = stubOutbound();
  const ai = stubSophy(async () => { throw new Error('ECONNRESET talking to Sophy'); });
  try {
    const res = await convo.handleInbound(inbound({ text: '4 pm' }), fixture().pool);
    assert.equal(out.bodies()[0], TODAY.confirmation);
    assert.equal(res.confirmed, true, 'the confirmation was still written and still sent');
  } finally { ai.restore(); out.restore(); restoreEnv(); }
});

test('Sophy returning nothing degrades to the deterministic copy', async () => {
  const restoreEnv = setAi(true);
  const out = stubOutbound();
  const ai = stubSophy(async () => null); // sophy.chatText returns null on ANY failure
  try {
    await convo.handleInbound(inbound({ text: '4 pm' }), fixture().pool);
    assert.equal(out.bodies()[0], TODAY.confirmation);
  } finally { ai.restore(); out.restore(); restoreEnv(); }
});

test('a SLOW model is abandoned — the customer never waits on it', async () => {
  const restoreEnv = setAi(true);
  process.env.AI_CONVERSATION_TIMEOUT_MS = '25';
  const out = stubOutbound();
  // Never settles: the bound has to come from our side, not the model's.
  const ai = stubSophy(() => new Promise(() => {}));
  try {
    const started = Date.now();
    const res = await convo.handleInbound(inbound({ text: '4 pm' }), fixture().pool);
    assert.ok(Date.now() - started < 2000, 'the reply must not sit behind a hung model');
    assert.equal(out.bodies()[0], TODAY.confirmation);
    assert.equal(res.confirmed, true);
  } finally { ai.restore(); out.restore(); restoreEnv(); }
});

// ── 5. The flow does not depend on the phrasing ─────────────────────────

test('the state machine advances IDENTICALLY whether the text was generated or fallback', async () => {
  /*
   * The whole safety argument rests on this: phrasing is the LAST thing that
   * happens, after the step and the write are already decided. So the same
   * inbound is driven twice — once with AI off, once with a generation that is
   * accepted — and everything except the words is compared.
   */
  async function drive({ ai: aiOn }) {
    const restoreEnv = setAi(aiOn);
    const out = stubOutbound();
    const ai = stubSophy(async () => GOOD_CONFIRMATION);
    try {
      const fake = fixture();
      const res = await convo.handleInbound(inbound({ text: '4 pm' }), fake.pool);
      return {
        res,
        writes: out.writes,
        bodies: out.bodies(),
        kinds: out.sent.map((s) => s.kind),
        // `last_inbound_at` binds a fresh Date, so params are compared with
        // Dates flattened to their type — the SQL and the VALUES are the claim,
        // not the wall clock.
        sql: fake.calls.map((c) => ({
          sql: c.sql.replace(/\s+/g, ' ').trim(),
          params: (c.params || []).map((p) => (p instanceof Date ? '<Date>' : p)),
        })),
      };
    } finally { ai.restore(); out.restore(); restoreEnv(); }
  }

  const off = await drive({ ai: false });
  const on = await drive({ ai: true });

  assert.deepEqual(on.res, off.res, 'same outcome and same next step');
  assert.deepEqual(on.writes, off.writes, 'same row written — the model touches no value we persist');
  assert.deepEqual(on.sql, off.sql, 'same statements, same bound params, same order');
  assert.deepEqual(on.kinds, off.kinds, 'same messages in the same order (confirmation, then the extras prompt)');
  // …and the ONLY difference is the words.
  assert.notEqual(on.bodies[0], off.bodies[0]);
  assert.equal(on.bodies.length, off.bodies.length);
});

// ── 6. The confirmation reads back the ROW, not the conversation ────────

test('the confirmation states the values actually written to the row', async () => {
  const restoreEnv = setAi(false);
  const out = stubOutbound();
  try {
    await convo.handleInbound(inbound({ text: '4 pm' }), fixture().pool);

    assert.equal(out.writes.length, 1, 'one commit');
    const { fields } = out.writes[0];
    assert.equal(fields.requested_date_time, `${DATE} 16:00:00`);
    assert.equal(fields.requested_time, '16:00');
    assert.equal(fields.payload.slot_label, SLOT_LABEL);

    // The customer is read back THOSE values — the appointment date derived from
    // what we stored, and the frame they picked. A confirmation that agrees with
    // the chat but not with the row is the failure mode worth pinning.
    const body = out.bodies()[0];
    assert.ok(body.includes(convo.formatCustomerDateLabel(fields.requested_date_time.slice(0, 10))));
    assert.ok(body.includes(fields.payload.slot_label));
  } finally { out.restore(); restoreEnv(); }
});

test('generation is given the WRITTEN values as its only facts', async () => {
  const restoreEnv = setAi(true);
  const out = stubOutbound();
  const ai = stubSophy(async () => GOOD_CONFIRMATION);
  try {
    await convo.handleInbound(inbound({ text: '4 pm' }), fixture().pool);

    const { fields } = out.writes[0];
    const { user } = ai.prompts[0];
    // Facts flow row → prompt → message. Anything the model says that is not
    // traceable to this prompt is, by construction, invented — which is what the
    // validator exists to catch.
    assert.ok(user.includes(convo.formatCustomerDateLabel(fields.requested_date_time.slice(0, 10))));
    assert.ok(user.includes(fields.payload.slot_label));
    assert.ok(out.bodies()[0].includes(fields.payload.slot_label),
      'and the delivered message still carries the booked window');
  } finally { ai.restore(); out.restore(); restoreEnv(); }
});
