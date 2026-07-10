/*
 * STT engine REGISTRY. The teleprompter relay is STT-provider-agnostic; it calls
 * resolveEngine(provider).{start,sendAudio,heartbeat,close}. All supported OSS
 * providers are self-hosted behind the sidecar (see sidecar.engine.js) — free,
 * no account, no paid vendor. Provider selected by easyfix_properties `stt.provider`.
 *
 * PROVIDERS:
 *   indicconformer — AI4Bharat IndicConformer (MIT) — DEFAULT. Best Indic + code-switch.
 *   vosk           — Vosk (Apache-2.0) — ultra-light CPU fallback, lower accuracy.
 * Both are the same sidecar client with a different model hint. Add a new OSS
 * provider by adding one entry here (and teaching the sidecar to load it).
 */

const sidecar = require('./sidecar.engine');

const ENGINES = {
  indicconformer: sidecar.create('indicconformer'),
  vosk: sidecar.create('vosk'),
};
const DEFAULT_PROVIDER = 'indicconformer';

function resolveEngine(provider) {
  const p = String(provider || '').trim().toLowerCase();
  return ENGINES[p] || ENGINES[DEFAULT_PROVIDER];
}
// A live-STT engine is USABLE only if a provider is selected AND the sidecar URL
// is configured. Otherwise the teleprompter runs in manual/sequential mode.
function sttUsable(provider) {
  const e = provider ? ENGINES[String(provider).trim().toLowerCase()] : null;
  return !!(e && e.configured());
}

module.exports = { resolveEngine, sttUsable, DEFAULT_PROVIDER, ENGINE_NAMES: Object.keys(ENGINES) };
