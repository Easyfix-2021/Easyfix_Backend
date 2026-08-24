/*
 * Sophy — Channelplay's central OpenAI-compatible LLM gateway (https://sophy.in/v1).
 * All EasyFix TEXT/LLM usage should route through here so model, prompt, quota and
 * cost stay centrally controlled (the `mw_live_…` key carries that config; the
 * `model` we send is ignored).
 *
 * Two Sophy quirks this client papers over so callers don't have to care:
 *  1. Client `system` messages are DROPPED unless the key is agent-mode. So we
 *     FOLD any system instructions into the single user message — works for any
 *     key mode. (If the operator later sets the key to agent-mode, the folded
 *     text simply rides along in the user turn; still correct.)
 *  2. Per-request `response_format` is ignored (JSON is a key-level config), so a
 *     JSON reply can arrive wrapped in prose / markdown fences — parseJsonLoose
 *     recovers it. Callers should still instruct "return JSON only".
 *
 * IMPORTANT: Sophy is TEXT-ONLY — no realtime / audio / STT / TTS. The live voice
 * leg of AI calling uses OpenAI Realtime DIRECTLY; this client is for the
 * post-call mapping and any other text reasoning. Returns null on ANY failure so
 * every caller degrades gracefully.
 *
 * PER-CALLER KEYS: each consuming feature passes its OWN `mw_live_…` key (so each
 * gets its own model/prompt/quota/cost line in Sophy). There is deliberately NO
 * global-key fallback — a caller with no key is simply disabled, never silently
 * borrowing another feature's key. Base URL is shared (SOPHY_BASE_URL).
 */

const logger = require('../logger');

const BASE = (process.env.SOPHY_BASE_URL || 'https://sophy.in/v1').replace(/\/+$/, '');

/*
 * Request timeouts. Text callers are background mappers, so they get a generous
 * bound — anything is an improvement on the unbounded default.
 *
 * VISION is deliberately TIGHTER, because it is the only synchronous,
 * user-blocking caller: the technician app abandons a multipart upload after
 * 30s (UPLOAD_TIMEOUT_MS in the app's src/lib/upload.ts), so a server bound
 * above that would keep holding the images after the client had already given
 * up and moved on.
 */
const TEXT_TIMEOUT_MS = 60000;
const VISION_TIMEOUT_MS = 25000;

// A caller is enabled when it has a key to pass. No cross-feature fallback.
function enabled(apiKey) {
  return !!apiKey;
}

// Sophy ignores per-request JSON mode, so a JSON reply may be fenced or prefaced.
function parseJsonLoose(s) {
  const str = s == null ? '' : String(s);
  if (!str.trim()) return null;
  try { return JSON.parse(str); } catch { /* fall through */ }
  const fenced = str.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch { /* fall through */ } }
  const first = str.indexOf('{');
  const last = str.lastIndexOf('}');
  if (first >= 0 && last > first) { try { return JSON.parse(str.slice(first, last + 1)); } catch { /* fall through */ } }
  return null;
}

// The one POST. `content` is either a plain string (chatText) or an array of
// OpenAI-style content parts (chatVision) — Sophy takes both on the same
// endpoint. Returns the assistant text, or null on ANY failure.
async function postChat(content, maxTokens, key, timeoutMs = TEXT_TIMEOUT_MS) {
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      // Node's global fetch has NO default timeout, so without this a stalled
      // gateway never returns: the Express handler hangs and every buffer the
      // request is holding (for vision, two multer buffers plus their base64)
      // stays on the heap until the socket dies. The catch below already turns
      // any throw into null, so a TimeoutError degrades to available:false free.
      signal: AbortSignal.timeout(timeoutMs),
      // model is ignored by Sophy (the key sets it); max_tokens is harmless if the
      // key overrides it. Single user turn — no system role (see header note 1).
      body: JSON.stringify({ model: 'sophy', max_tokens: maxTokens, messages: [{ role: 'user', content }] }),
    });
    if (!res.ok) {
      let body = '';
      try { body = (await res.text()).slice(0, 200); } catch { /* noop */ }
      logger.warn('Sophy http ' + res.status + ' · ' + body);
      return null;
    }
    const data = await res.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : null;
    return text || null;
  } catch (e) {
    logger.warn('Sophy request error · ' + e.message);
    return null;
  }
}

// Raw text completion through Sophy. `system` (if given) is folded into the user
// message. `apiKey` is the caller's own mw_live_… key. Returns the assistant
// text, or null on any failure (including no key).
async function chatText({ system, user, maxTokens = 1500, apiKey }) {
  const key = apiKey || null;
  if (!key) return null;
  const u = String(user == null ? '' : user);
  const content = system ? `${String(system).trim()}\n\n${u}` : u;
  return postChat(content, maxTokens, key);
}

/*
 * VISION completion — same gateway, same key rule, same "null on ANY failure"
 * discipline as chatText, but the user turn is a multimodal content ARRAY:
 * [{type:'text'}, {type:'image_url', image_url:{url:'data:image/jpeg;base64,…'}}].
 * `images` is [{ mimeType, base64 }]; entries without base64 are skipped and a
 * call with no usable image returns null rather than silently degrading to text.
 *
 * ⚠ OPERATIONAL UNKNOWN: whether the caller's mw_live_ key resolves to a
 * VISION-capable model is a Sophy-side configuration question, not something
 * this client can assert. If it does not, the gateway errors (or replies with
 * prose) and this returns null — so a caller MUST read null as "extraction
 * unavailable", never as a negative/empty result.
 */
async function chatVision({ system, user, images = [], maxTokens = 1500, apiKey }) {
  const key = apiKey || null;
  if (!key) return null;
  const u = String(user == null ? '' : user);
  const text = system ? `${String(system).trim()}\n\n${u}` : u;
  const parts = [{ type: 'text', text }];
  for (const img of Array.isArray(images) ? images : []) {
    if (!img || !img.base64) continue;
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType || 'image/jpeg'};base64,${img.base64}` },
    });
  }
  if (parts.length < 2) return null;
  return postChat(parts, maxTokens, key, VISION_TIMEOUT_MS);
}

// JSON completion through Sophy (lenient parse). Returns the parsed object or null.
async function chatJson({ system, user, maxTokens = 1500, apiKey }) {
  return parseJsonLoose(await chatText({ system, user, maxTokens, apiKey }));
}

module.exports = { enabled, chatText, chatVision, chatJson, parseJsonLoose, BASE };
