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

module.exports = { interpretReply, aiEnabled };
