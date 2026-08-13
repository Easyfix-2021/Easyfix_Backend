const logger = require('../logger');

/*
 * services/ai.service.js — bounded NLU for the conversational WhatsApp
 * order-confirmation flow (services/whatsapp-conversation.service.js).
 *
 * Scope is deliberately narrow: this is NOT a generative chatbot. It takes a
 * short customer free-text reply at a known conversation STEP and returns a
 * STRUCTURED JSON intent/slots object. The state machine owns the flow and all
 * DB writes; the AI only interprets ambiguous free text (e.g. "tomorrow 3pm",
 * "next mon 2-4", "actually it's already done"). Deterministic button replies
 * never come here.
 *
 * Provider: SOPHY — Channelplay's central OpenAI-compatible LLM gateway, via
 * services/sophy.service.js. Routed through Sophy (rather than calling OpenAI
 * directly) so model, prompt, quota and cost stay centrally controlled: the
 * `mw_live_…` key carries that config and the model we send is ignored. This
 * follows the same PER-FEATURE-KEY pattern every other LLM consumer here uses
 * (ai-call-flows, ai-profile-extract, call-analysis, teleprompter …) — this flow
 * passes its OWN key so it gets its own model/prompt/quota/cost line, and there
 * is deliberately no cross-feature key fallback.
 *
 * Two Sophy quirks are handled inside sophy.service, so this file does not need
 * to: client `system` messages are folded into the user turn, and per-request
 * `response_format` is ignored (JSON is key-level config) so a JSON reply may
 * arrive fenced/wrapped and is recovered by parseJsonLoose. We still instruct
 * "return JSON only" in the prompt below.
 *
 * Gating: AI_CONVERSATION_ENABLED must be 'true' AND SOPHY_API_KEY_CONVERSATION
 * must be set; otherwise interpretReply returns { intent: 'unclear', disabled: true }
 * so the caller falls back to a re-prompt (never crashes the conversation).
 * sophy.chatJson returns null on ANY failure, which maps to the same safe
 * 'unclear' outcome — the conversation always degrades to a plain re-ask.
 *
 * ─── TWO EXPORTS, TWO VERY DIFFERENT POWERS ────────────────────────────────
 *
 * interpretReply INTERPRETS inbound text. composeMessage (added 2026-08-13)
 * PHRASES outbound text. The second one is the dangerous one, so the boundary
 * is stated once, here, and enforced in code below:
 *
 *   AI PHRASES. IT NEVER DECIDES, AND IT NEVER SUPPLIES FACTS.
 *
 * The state machine still chooses the next step and still owns every DB write.
 * composeMessage is handed the QUESTION to ask and the ALREADY-CONFIRMED facts,
 * is told to use nothing else, and its output is VALIDATED (non-empty,
 * length-bounded, no URL we did not supply, no digit-sequence absent from the
 * supplied facts) before it can reach a customer. Anything that fails returns
 * the caller's own deterministic copy instead. That matters because this text
 * goes to a customer over WhatsApp, in writing: an invented appointment time, a
 * price, a technician name or a link is a commitment we then have to honour.
 */

const sophy = require('./sophy.service');

// This feature's own Sophy key. No global fallback: a caller with no key is
// simply disabled rather than silently borrowing another feature's quota.
const conversationKey = () => process.env.SOPHY_API_KEY_CONVERSATION;

function aiEnabled() {
  return String(process.env.AI_CONVERSATION_ENABLED).toLowerCase() === 'true'
    && sophy.enabled(conversationKey());
}

// IST "today" context so the model can resolve relative dates ("tomorrow",
// "next monday"). new Date() is fine here (the Date restriction only applies to
// sandboxed Workflow scripts, not service code).
function istTodayContext() {
  const now = new Date();
  // Asia/Kolkata is UTC+5:30, no DST.
  const ist = new Date(now.getTime() + (5 * 60 + 30) * 60 * 1000);
  const yyyy = ist.getUTCFullYear();
  const mm = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(ist.getUTCDate()).padStart(2, '0');
  const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][ist.getUTCDay()];
  return { date: `${yyyy}-${mm}-${dd}`, weekday };
}

/*
 * interpretReply({ step, text, timeSlots })
 *
 * step      — conversation cursor. The confirm-first flow
 *             (whatsapp-conversation.service.js, 2026-07-30) drives three
 *             free-text steps through here: 'awaiting_slot' (1-hour slot),
 *             'awaiting_reschedule_date' (date only) and
 *             'awaiting_cancel_reason' (reason classification). 'awaiting_choice'
 *             may also arrive when a customer types instead of tapping a
 *             template button. The superseded 'awaiting_datetime' step still
 *             routes here for in-flight conversations.
 * text      — the customer's raw message text.
 * timeSlots — the allowed human time-slot strings (so the model maps onto one).
 *
 * Returns (always an object, never throws):
 *   {
 *     intent: 'datetime' | 'no_service' | 'address' | 'affirm' | 'decline' | 'unclear',
 *     datetime?: 'YYYY-MM-DDTHH:mm' (IST wall-clock, no tz),
 *     date?: 'YYYY-MM-DD' (IST calendar day — when only a DATE was given),
 *     slot_start?: 'HH:MM' (24h start of the 1-HOUR frame the customer wants),
 *     time_slot?: <one of timeSlots>,
 *     reason?: 'self_assembly' | 'site_not_ready' | 'work_completed' | 'other',
 *     address?: string,
 *     confidence?: number
 *   }
 *
 * INTERPRETATION ONLY. The state machine decides what happens next, validates
 * every value (future-date gate, allowed slot list) and owns all DB writes — the
 * model never decides a write, and a malformed field is dropped below rather
 * than trusted.
 */
async function interpretReply({ step, text, timeSlots = [] }) {
  const raw = String(text || '').trim();
  if (!raw) return { intent: 'unclear', confidence: 0 };
  if (!aiEnabled()) return { intent: 'unclear', disabled: true, confidence: 0 };

  const today = istTodayContext();
  // No model name logged: Sophy resolves the model from the key, so printing a
  // local guess here would be actively misleading about what actually ran.
  logger.info('Interpret reply via Sophy · step=' + step + ' · slots=' + timeSlots.length);

  const system = [
    'You are an NLU parser for an Indian home-services WhatsApp assistant.',
    'Extract structured data from a single short customer message and reply with ONLY a JSON object — no prose.',
    `Today is ${today.date} (${today.weekday}), timezone Asia/Kolkata (IST). Resolve relative dates ("tomorrow", "next monday", "this weekend") against this.`,
    'JSON schema:',
    '  intent: one of "datetime" | "no_service" | "address" | "affirm" | "decline" | "unclear"',
    '  datetime: "YYYY-MM-DDTHH:mm" IST wall-clock (omit if no date/time given). Never invent a date that already passed.',
    '  date: "YYYY-MM-DD" IST calendar day — use this when the customer gave a DATE but no time. Never a date that already passed.',
    '  slot_start: "HH:MM" 24-hour start of the ONE-HOUR window the customer wants, on the hour (e.g. "10:00", "16:00"). Use for a bare time like "4pm", and for a range like "3-4 pm" take the START ("15:00").',
    `  time_slot: choose the closest of these exact strings if a time/slot is implied: ${JSON.stringify(timeSlots)} (omit if none fits)`,
    '  reason: "self_assembly" | "site_not_ready" | "work_completed" | "other" — the customer\'s reason for NOT needing the visit. Use "other" when they give a real reason that fits none of the first three (e.g. returned the product, cost, changed their mind).',
    '  address: a postal address string if the message is clearly an address.',
    '  confidence: 0..1.',
    'Rules: "I don\'t need a service"/"already done"/"assembled it myself"/"site not ready" => intent "no_service" with the matching reason.',
    'A clear "yes/correct/ok" => "affirm"; "no/wrong" => "decline". If you cannot confidently extract anything, use intent "unclear".',
    'Step-specific: at "awaiting_slot" return slot_start. At "awaiting_reschedule_date" return date. At "awaiting_cancel_reason" ALWAYS return a reason (fall back to "other") — the customer has already said they do not need the visit, so never answer "unclear" there.',
  ].join('\n');

  const userMsg = `Conversation step: ${step}\nCustomer message: """${raw}"""`;

  try {
    /*
     * maxTokens is small on purpose: the reply is a one-line intent/slots object,
     * and a tight ceiling keeps a runaway generation from burning the flow's
     * quota. Sophy ignores any temperature/response_format we send (key-level
     * config), so they are not passed — the "JSON only" instruction in `system`
     * plus parseJsonLoose inside sophy.service is what guarantees a parse.
     */
    const parsed = await sophy.chatJson({
      system,
      user: userMsg,
      maxTokens: 200,
      apiKey: conversationKey(),
    });
    // null = any failure (HTTP, network, unparseable). Degrade to a re-ask.
    if (!parsed || typeof parsed !== 'object') {
      logger.warn('AI NLU unavailable or unparseable · step=' + step);
      return { intent: 'unclear', error: 'sophy_unavailable', confidence: 0 };
    }
    // Normalise: ensure a known intent + only keep fields the caller can trust.
    // Anything malformed is DROPPED rather than passed through — the state
    // machine must never receive a half-parsed date/slot/reason it might write.
    const ALLOWED = new Set(['datetime', 'no_service', 'address', 'affirm', 'decline', 'unclear']);
    if (!ALLOWED.has(parsed.intent)) parsed.intent = 'unclear';
    if (parsed.time_slot && timeSlots.length && !timeSlots.includes(parsed.time_slot)) delete parsed.time_slot;
    if (parsed.date && !/^\d{4}-\d{2}-\d{2}$/.test(String(parsed.date))) delete parsed.date;
    if (parsed.slot_start && !/^\d{1,2}:\d{2}$/.test(String(parsed.slot_start))) delete parsed.slot_start;
    const REASONS = new Set(['self_assembly', 'site_not_ready', 'work_completed', 'other']);
    if (parsed.reason && !REASONS.has(String(parsed.reason))) delete parsed.reason;
    logger.info('Interpreted reply · intent=' + parsed.intent);
    return parsed;
  } catch (err) {
    logger.warn(`AI NLU error · ${err.message}`);
    return { intent: 'unclear', error: 'network', confidence: 0 };
  }
}

// ── Outbound phrasing (composeMessage) ──────────────────────────────────

/*
 * A generated customer message is capped well under WhatsApp's 4096-char body
 * limit. The cap is a SAFETY bound, not a formatting preference: a model that
 * starts rambling (or echoes its own instructions back) must be rejected rather
 * than delivered, and every message this flow sends is 2–6 short lines.
 */
const GEN_MAX_CHARS = 700;

/*
 * Hard ceiling on how long a customer waits for phrasing. Read per call (not
 * captured at require time) so ops can retune it without a redeploy, and so
 * tests can shrink it.
 *
 * ⚠ This is a bound on OUR WAIT, not a cancellation: the underlying fetch keeps
 * running and its result is simply ignored. That is the correct trade here —
 * the customer's reply must never sit behind a slow model, and abandoning one
 * in-flight HTTP call costs nothing we care about.
 */
const genTimeoutMs = () => {
  const n = Number(process.env.AI_CONVERSATION_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 6000;
};

const TIMED_OUT = Symbol('sophy_timeout');

function withTimeout(promise, ms) {
  let timer = null;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    // Never hold the process open for a timer nobody is waiting on.
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, guard]).finally(() => { if (timer) clearTimeout(timer); });
}

/*
 * A URL in a customer message is a place we are sending them. The model may
 * never choose one — so ANY link-shaped token that is not present verbatim in
 * the supplied facts rejects the whole message.
 *
 * Deliberately over-broad (it matches bare "easyfix.in/xyz" and "www.…", not
 * just http(s)): a false positive costs us the deterministic fallback, while a
 * false negative sends a customer to an address a language model made up.
 */
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"')]+|\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:com|in|net|org|io|co|me|app|link|xyz)\b[^\s<>"')]*/gi;

// Digit runs, compared with leading zeros stripped so the '05' we supply in
// "Wed, 05 Aug 2026" also licenses a natural "5 Aug". Everything else must
// match a run we actually handed over.
function digitRuns(s) {
  return (String(s == null ? '' : s).match(/\d+/g) || []).map((d) => d.replace(/^0+(?=\d)/, ''));
}

/*
 * validateGenerated(text, { allowed, maxChars })
 *   → { ok: true, text } | { ok: false, reason }
 *
 * The gate every generated message passes before it can reach a customer.
 * `allowed` is the concatenation of everything the state machine SUPPLIED (the
 * instruction + the confirmed facts) — the model's entire permitted vocabulary
 * of links and numbers.
 *
 * Each rejection reason is a distinct way to mislead someone, which is why they
 * are reported separately rather than as one "invalid":
 *   empty            — nothing to send
 *   too_long         — a runaway generation, not a message
 *   unsupplied_url   — a link we never minted (phishing-shaped, at best a 404)
 *   unsupplied_number— a time, price, date or phone number we never confirmed
 */
function validateGenerated(text, { allowed, maxChars = GEN_MAX_CHARS } = {}) {
  // Models like to wrap a one-line answer in quotes; strip that one wrapper
  // before judging, since it is presentation noise rather than content.
  let out = String(text == null ? '' : text).trim();
  if (/^"[\s\S]+"$/.test(out) || /^'[\s\S]+'$/.test(out)) out = out.slice(1, -1).trim();
  if (!out) return { ok: false, reason: 'empty' };
  if (out.length > maxChars) return { ok: false, reason: 'too_long' };

  const allowedText = String(allowed == null ? '' : allowed);
  const allowedUrls = new Set((allowedText.match(URL_RE) || []).map((u) => u.toLowerCase()));
  for (const url of out.match(URL_RE) || []) {
    if (!allowedUrls.has(url.toLowerCase())) return { ok: false, reason: 'unsupplied_url' };
  }
  const allowedNums = new Set(digitRuns(allowedText));
  for (const n of digitRuns(out)) {
    if (!allowedNums.has(n)) return { ok: false, reason: 'unsupplied_number' };
  }
  return { ok: true, text: out };
}

/*
 * composeMessage({ kind, ask, facts, fallback, maxChars })
 *
 * PHRASING ONLY — the generative twin of interpretReply, on the same Sophy
 * client and the same per-feature key, with the same contract: it NEVER throws
 * and ALWAYS returns a normalised result.
 *
 * kind     — a short label for the message being written (logged, and given to
 *            the model as its purpose). Never a decision.
 * ask      — what the message must DO, decided by the state machine.
 * facts    — the ONLY facts the model may state. Values the state machine has
 *            already confirmed (and, for a confirmation message, values it has
 *            already WRITTEN). The model gets nothing else — no conversation
 *            history, no job row, no customer record.
 * fallback — the caller's deterministic copy. REQUIRED: without something safe
 *            to fall back to there is nothing to gain by trying, so we do not.
 *
 * Returns { text, generated, reason }:
 *   text      — what to send. The validated generation, or `fallback` verbatim.
 *   generated — true only when a model wrote the text that is being returned.
 *   reason    — why we fell back ('disabled' | 'no_fallback' | 'sophy_unavailable'
 *               | 'timeout' | 'network' | a validateGenerated reason).
 *
 * AI off / key missing / Sophy erroring / Sophy slow ⇒ `fallback`, byte for
 * byte. That is the whole safety story: the deterministic copy stays the
 * product, and generation is only ever allowed to improve on it.
 */
async function composeMessage({ kind, ask, facts = {}, fallback, maxChars = GEN_MAX_CHARS } = {}) {
  const safe = typeof fallback === 'string' ? fallback : '';
  if (!safe.trim()) return { text: safe, generated: false, reason: 'no_fallback' };
  if (!aiEnabled()) return { text: safe, generated: false, reason: 'disabled' };

  // Only non-empty facts are offered — a "date: null" line invites the model to
  // fill the blank, which is precisely what it must not do.
  const factLines = Object.entries(facts || {})
    .filter(([, v]) => v != null && String(v).trim() !== '')
    .map(([k, v]) => `- ${k}: ${String(v).trim()}`);
  const askText = String(ask || '').trim();

  const system = [
    'You are a customer-support agent for an Indian home-services company, writing ONE short WhatsApp message to a customer.',
    'Write only the message itself — no preamble, no explanation, no surrounding quotes, no markdown headings.',
    'Use ONLY the facts listed below. You know nothing else about this customer, this booking or this company.',
    'NEVER invent or change a date, a time, a price, an amount, a name, a phone number, an address or a link. If a detail is not in the facts, do not mention it.',
    'Do not include any URL, web address or phone number.',
    'Do not promise anything the facts do not state — no discounts, no technician names, no arrival guarantees beyond what is given.',
    `Keep it under ${maxChars} characters. Warm, plain, human English. A little emoji is fine. Line breaks are fine.`,
    'Reply with the message text only.',
  ].join('\n');

  const user = [
    `Purpose: ${kind || 'message'}`,
    `What this message must do: ${askText}`,
    factLines.length
      ? `Confirmed facts (the ONLY facts you may state):\n${factLines.join('\n')}`
      : 'Confirmed facts: none — state no specifics at all.',
  ].join('\n');

  // The model's entire permitted vocabulary of links and numbers: what we asked
  // for, plus what we supplied. Nothing else may appear in the output.
  const allowed = `${askText}\n${factLines.join('\n')}`;

  try {
    /*
     * chatText, not chatJson — this is prose, and chatJson is just chatText plus
     * a parse, so there is ONE HTTP path either way (sophy.chatText).
     *
     * A key configured JSON-mode at the Sophy end will still wrap the answer
     * ({"message": "…"}), so the loose parser is tried on the way out and the
     * `message` field unwrapped when present. A plain-prose reply parses to null
     * and is used as-is — both key modes therefore work without a config here.
     */
    const raw = await withTimeout(
      sophy.chatText({ system, user, maxTokens: 320, apiKey: conversationKey() }),
      genTimeoutMs(),
    );
    if (raw === TIMED_OUT) {
      logger.warn('AI phrasing timed out · kind=' + kind + ' — sending the deterministic copy');
      return { text: safe, generated: false, reason: 'timeout' };
    }
    if (!raw) {
      logger.warn('AI phrasing unavailable · kind=' + kind);
      return { text: safe, generated: false, reason: 'sophy_unavailable' };
    }
    const wrapped = sophy.parseJsonLoose(raw);
    const candidate = wrapped && typeof wrapped.message === 'string' ? wrapped.message : raw;

    const check = validateGenerated(candidate, { allowed, maxChars });
    if (!check.ok) {
      // WARN, not INFO: a rejection means the model tried to tell a customer
      // something we never gave it, and that is worth seeing in the logs.
      logger.warn('AI phrasing REJECTED · kind=' + kind + ' · reason=' + check.reason + ' — sending the deterministic copy');
      return { text: safe, generated: false, reason: check.reason };
    }
    logger.info('AI phrased message · kind=' + kind + ' · chars=' + check.text.length);
    return { text: check.text, generated: true };
  } catch (err) {
    logger.warn('AI phrasing error · ' + (err && err.message));
    return { text: safe, generated: false, reason: 'network' };
  }
}

module.exports = {
  interpretReply,
  composeMessage,
  aiEnabled,
  // Exported for the phrasing tests — the validator is the safety property, so
  // it is exercised directly as well as through composeMessage.
  validateGenerated,
};
