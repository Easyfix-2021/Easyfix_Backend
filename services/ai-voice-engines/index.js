/*
 * AI-calling ENGINE registry. An engine abstracts the voice PROVIDER behind a
 * uniform, μ-law-native interface so the relay stays provider-agnostic:
 *
 *   configured()                       → is this engine's key present?
 *   start(state, { instructions, callbacks }) → open the provider connection.
 *       callbacks: onReady() · onAudioToCaller(muLawB64) · onUserText(t)
 *                  · onAgentText(t) · onBargeIn() · onError(msg) · onClosed(reason)
 *   sendCallerAudio(state, muLawB64)   → caller audio from Plivo (μ-law 8k base64)
 *   heartbeat(state) → boolean         → liveness ping; false = dead
 *   close(state)                       → close the provider connection
 *
 * The relay ALWAYS deals in μ-law base64 (Plivo's format). Each engine converts
 * internally: OpenAI Realtime is μ-law-native (passthrough); Gemini transcodes
 * via the worker pool. See docs/AI_CALLING_ENGINES.md.
 */

const openai = require('./openai.engine');
const gemini = require('./gemini.engine');

const ENGINES = { openai, gemini };
const DEFAULT_ENGINE = 'gemini'; // cheaper; property `ai.calling.engine` can override

function getEngine(name) { return ENGINES[name] || null; }
// Always returns a usable engine (falls back to the product default).
function resolveEngine(name) { return ENGINES[name] || ENGINES[DEFAULT_ENGINE]; }
function engineConfigured(name) {
  const e = getEngine(name);
  return !!(e && e.configured());
}
function listEngines() {
  return [
    { id: 'gemini', label: 'Gemini (3.1 Flash Live)' },
    { id: 'openai', label: 'OpenAI (Realtime)' },
  ];
}

module.exports = { getEngine, resolveEngine, engineConfigured, listEngines, DEFAULT_ENGINE, ENGINE_NAMES: Object.keys(ENGINES) };
