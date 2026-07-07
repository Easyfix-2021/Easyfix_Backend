/*
 * AI-CALLING FLOW REGISTRY.
 *
 * The AI-calling ENGINE — telephony (Plivo place-call + <Stream>), the media
 * relay (Plivo ⇄ OpenAI Realtime), the session store, and the concurrency cap —
 * is entirely flow-agnostic. Each FLOW plugs in just two things:
 *
 *   buildInstructions({ lang, session }) -> string
 *       The OpenAI Realtime agent's system instructions for the LIVE call
 *       (the goal + persona + language handling for THIS flow).
 *
 *   mapResult(transcript, pool, { session }) -> object   (async, never throws)
 *       Post-call reasoning over the transcript — routed through Sophy (the
 *       central AI text gateway) — producing the DISPLAY-ONLY result object the
 *       UI shows. Returns whatever shape that flow's UI expects.
 *
 * To add a flow (e.g. booking_details, tech_reminder): add one entry here. No
 * relay / route / schema changes — tbl_ai_call_session.flow selects which runs,
 * and the start endpoint's validation is driven by listFlows().
 *
 * NOTE the split forced by Sophy being text-only: the LIVE conversation runs on
 * OpenAI Realtime directly (buildInstructions), while mapResult's text reasoning
 * runs on Sophy. Both are per-flow.
 */

const { mapTranscript: mapProfileUpdate } = require('./ai-profile-extract.service');

// ── profile_update ─────────────────────────────────────────────────────────
function profileUpdateInstructions({ lang } = {}) {
  const langLine = lang
    ? `The technician's preferred language is "${lang}". Greet and speak in that language by default, but immediately mirror whatever language they actually reply in.`
    : 'From their first reply, detect the language they speak (Hindi, Hinglish, English, or a regional Indian language) and speak that language. Mirror their language throughout.';
  return [
    'You are a warm, friendly human staff member at EasyFix, a home-services company, making a short phone call to one of our field technicians.',
    'Your only goal on this call is to find out two things: (1) what work and skills they can do, and (2) which areas or pincodes they can serve.',
    langLine,
    'Sound completely human and conversational — natural, relaxed, warm. NEVER say you are an AI, a bot, an assistant, or a system. Do not mention forms, mapping, or any technology.',
    'Keep your turns short — one or two sentences. Ask one thing at a time and acknowledge what they said before moving on.',
    'Open by greeting them, say you are calling from EasyFix to quickly update their work profile, and ask if this is a good time.',
    'Naturally find out which appliances or jobs they can handle and whether they install, repair, or service them, and which localities or pincodes they cover.',
    'If they give a vague area like "all of west Delhi", gently ask for the main localities or pincodes.',
    'Once you have both their skills and their service areas, thank them warmly, tell them someone will update it, and end the call politely.',
    'Never read out lists or mention any option codes. Just have a normal, friendly chat.',
  ].join(' ');
}

const FLOWS = {
  profile_update: {
    id: 'profile_update',
    label: 'Profile Update',
    // Each flow uses its OWN Sophy key (own model/prompt/quota/cost line) for the
    // post-call text reasoning. Name it here; mapResult passes it to the mapper.
    apiKeyEnv: 'SOPHY_API_KEY_AI_CALLING',
    buildInstructions: profileUpdateInstructions,
    mapResult: (transcript, pool) =>
      mapProfileUpdate(transcript, pool, { apiKey: process.env.SOPHY_API_KEY_AI_CALLING }),
  },

  /*
   * FUTURE FLOWS — add here, no engine changes. Give each its OWN Sophy key.
   *
   * booking_details: {
   *   id: 'booking_details', label: 'Booking Details',
   *   apiKeyEnv: 'SOPHY_API_KEY_BOOKING_DETAILS',
   *   buildInstructions: ({ lang }) => '...ask the customer for the issue, preferred slot, address...',
   *   mapResult: (transcript, pool) => require('./ai-booking-extract.service')
   *     .mapTranscript(transcript, pool, { apiKey: process.env.SOPHY_API_KEY_BOOKING_DETAILS }),
   * },
   * tech_reminder: {
   *   id: 'tech_reminder', label: 'Job Reminder',
   *   apiKeyEnv: 'SOPHY_API_KEY_TECH_REMINDER',
   *   buildInstructions: ({ lang, session }) => `...remind them about job ...; confirm they will attend...`,
   *   mapResult: (transcript) => require('./ai-reminder-extract.service')
   *     .summarize(transcript, { apiKey: process.env.SOPHY_API_KEY_TECH_REMINDER }),
   * },
   */
};

const DEFAULT_FLOW = 'profile_update';

function getFlow(flowId) {
  return FLOWS[flowId] || null;
}
// Resolve to a usable flow, always — falls back to the default so the engine
// never runs without a flow definition.
function resolveFlow(flowId) {
  return FLOWS[flowId] || FLOWS[DEFAULT_FLOW];
}
function listFlows() {
  return Object.values(FLOWS).map((f) => ({ id: f.id, label: f.label }));
}

module.exports = { getFlow, resolveFlow, listFlows, DEFAULT_FLOW };
