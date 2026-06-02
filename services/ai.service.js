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
 * Provider: OpenAI Chat Completions via plain fetch (no SDK dependency — every
 * other provider in this repo is called via fetch too). JSON mode + temp 0 for
 * stable, parseable output.
 *
 * Gating: AI_CONVERSATION_ENABLED must be 'true' AND OPENAI_API_KEY must be
 * set; otherwise interpretReply returns { intent: 'unclear', disabled: true }
 * so the caller falls back to a re-prompt (never crashes the conversation).
 */

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

function aiEnabled() {
  return String(process.env.AI_CONVERSATION_ENABLED).toLowerCase() === 'true'
    && !!process.env.OPENAI_API_KEY;
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
 * step      — conversation cursor ('awaiting_datetime' is the main free-text
 *             step; others mostly use buttons but may receive typed replies).
 * text      — the customer's raw message text.
 * timeSlots — the allowed human time-slot strings (so the model maps onto one).
 *
 * Returns (always an object, never throws):
 *   {
 *     intent: 'datetime' | 'no_service' | 'address' | 'affirm' | 'decline' | 'unclear',
 *     datetime?: 'YYYY-MM-DDTHH:mm' (IST wall-clock, no tz),
 *     time_slot?: <one of timeSlots>,
 *     reason?: 'self_assembly' | 'site_not_ready' | 'work_completed',
 *     address?: string,
 *     confidence?: number
 *   }
 */
async function interpretReply({ step, text, timeSlots = [] }) {
  const raw = String(text || '').trim();
  if (!raw) return { intent: 'unclear', confidence: 0 };
  if (!aiEnabled()) return { intent: 'unclear', disabled: true, confidence: 0 };

  const today = istTodayContext();
  const model = process.env.OPENAI_NLU_MODEL || 'gpt-4o-mini';

  const system = [
    'You are an NLU parser for an Indian home-services WhatsApp assistant.',
    'Extract structured data from a single short customer message and reply with ONLY a JSON object — no prose.',
    `Today is ${today.date} (${today.weekday}), timezone Asia/Kolkata (IST). Resolve relative dates ("tomorrow", "next monday", "this weekend") against this.`,
    'JSON schema:',
    '  intent: one of "datetime" | "no_service" | "address" | "affirm" | "decline" | "unclear"',
    '  datetime: "YYYY-MM-DDTHH:mm" IST wall-clock (omit if no date/time given). Never invent a date that already passed.',
    `  time_slot: choose the closest of these exact strings if a time/slot is implied: ${JSON.stringify(timeSlots)} (omit if none fits)`,
    '  reason: "self_assembly" | "site_not_ready" | "work_completed" — ONLY when the customer indicates they do NOT need the visit.',
    '  address: a postal address string if the message is clearly an address.',
    '  confidence: 0..1.',
    'Rules: "I don\'t need a service"/"already done"/"assembled it myself"/"site not ready" => intent "no_service" with the matching reason.',
    'A clear "yes/correct/ok" => "affirm"; "no/wrong" => "decline". If you cannot confidently extract anything, use intent "unclear".',
  ].join('\n');

  const userMsg = `Conversation step: ${step}\nCustomer message: """${raw}"""`;

  try {
    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 200,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userMsg },
        ],
      }),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      logger.warn(`AI NLU rejected · status=${res.status} · ${body}`);
      return { intent: 'unclear', error: `openai_http_${res.status}`, confidence: 0 };
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return { intent: 'unclear', confidence: 0 };
    let parsed;
    try { parsed = JSON.parse(content); } catch { return { intent: 'unclear', confidence: 0 }; }
    // Normalise: ensure a known intent + only keep a time_slot that's allowed.
    const ALLOWED = new Set(['datetime', 'no_service', 'address', 'affirm', 'decline', 'unclear']);
    if (!ALLOWED.has(parsed.intent)) parsed.intent = 'unclear';
    if (parsed.time_slot && timeSlots.length && !timeSlots.includes(parsed.time_slot)) delete parsed.time_slot;
    return parsed;
  } catch (err) {
    logger.warn(`AI NLU error · ${err.message}`);
    return { intent: 'unclear', error: 'network', confidence: 0 };
  }
}

module.exports = { interpretReply, aiEnabled };
