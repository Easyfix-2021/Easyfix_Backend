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

// Raw text completion through Sophy. `system` (if given) is folded into the user
// message. `apiKey` is the caller's own mw_live_… key. Returns the assistant
// text, or null on any failure (including no key).
async function chatText({ system, user, maxTokens = 1500, apiKey }) {
  const key = apiKey || null;
  if (!key) return null;
  const u = String(user == null ? '' : user);
  const content = system ? `${String(system).trim()}\n\n${u}` : u;
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
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

// JSON completion through Sophy (lenient parse). Returns the parsed object or null.
async function chatJson({ system, user, maxTokens = 1500, apiKey }) {
  return parseJsonLoose(await chatText({ system, user, maxTokens, apiKey }));
}

module.exports = { enabled, chatText, chatJson, parseJsonLoose, BASE };
