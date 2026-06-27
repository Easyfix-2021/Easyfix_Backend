const { getProperty } = require('./properties.service');
const kaleyra = require('./kaleyra.service');
const plivo = require('./plivo.service');
const logger = require('../logger');

/*
 * Voice-provider factory (2026-06-17). Single branch point so routes never
 * import a concrete provider directly — they call voice.* and we resolve
 * which provider (Kaleyra / Plivo) actually places the call.
 *
 * Provider availability is settings-driven via easyfix_properties:
 *   <provider>.calling.enabled = 'true' | 'false'   (per-provider kill switch)
 *   voice.default.provider     = 'kaleyra' | 'plivo' (used when the caller
 *                                 doesn't specify, or specifies a disabled one)
 *
 * Both providers expose the SAME contract (clickToCall / previewCallLegs /
 * normaliseIndianPhone). Only Plivo implements hangupCall + live-status
 * callbacks — Kaleyra is post-call-report only (see kaleyra.service.js).
 */

const PROVIDERS = { kaleyra, plivo };

function isProviderEnabled(name) {
  return String(getProperty(`${name}.calling.enabled`)).toLowerCase() === 'true';
}

function defaultProvider() {
  const configured = String(getProperty('voice.default.provider') || '').toLowerCase();
  if (PROVIDERS[configured]) return configured;
  // Blank / invalid setting: prefer a currently-enabled provider so the default
  // never silently resolves to a DISABLED one (which would suppress every call —
  // exactly the bug when voice.default.provider='' fell back to a disabled Kaleyra).
  const [firstEnabled] = enabledProviders();
  return firstEnabled || 'kaleyra';
}

// Providers the operator may pick from. The FE shows the radio only when
// length > 1; with one enabled provider the call is one-click as before.
function enabledProviders() {
  return Object.keys(PROVIDERS).filter(isProviderEnabled);
}

/*
 * Pick the provider to actually use. Honour an explicit request ONLY when that
 * provider is enabled; otherwise fall back to the configured default. Never
 * dial through a disabled provider (defence in depth — the validator also
 * whitelists the value).
 */
function resolveProvider(requested) {
  const r = requested && String(requested).toLowerCase();
  if (r && PROVIDERS[r] && isProviderEnabled(r)) return r;
  // Requested is unset or points at a disabled provider. Use the configured
  // default if it's enabled; otherwise fall back to ANY enabled provider so we
  // never dial through a disabled one (the cause of the silent-suppression bug).
  const def = defaultProvider();
  if (isProviderEnabled(def)) return def;
  const [firstEnabled] = enabledProviders();
  return firstEnabled || def;
}

// Whether this provider can show live mid-call status + be hung up from the UI.
// Kaleyra is post-call only; Plivo is event-native. Drives the FE live panel.
function supportsLiveStatus(name) {
  return typeof PROVIDERS[name]?.hangupCall === 'function';
}

async function clickToCall({ provider, ...rest } = {}) {
  const name = resolveProvider(provider);
  logger.info('Placing click-to-call · requested=' + (provider || 'default') + ' · resolved=' + name);
  const result = await PROVIDERS[name].clickToCall(rest);
  logger.info('Click-to-call placed · provider=' + name + ' · liveStatus=' + supportsLiveStatus(name));
  // Stamp the resolved provider so the route records it on the audit row and
  // the FE knows whether to open the live panel (Plivo) or just toast (Kaleyra).
  return { ...result, provider: name, supportsLiveStatus: supportsLiveStatus(name) };
}

function previewCallLegs({ provider, ...rest } = {}) {
  const name = resolveProvider(provider);
  return { ...PROVIDERS[name].previewCallLegs(rest), provider: name };
}

async function hangup({ provider, callUuid }) {
  const name = (provider && String(provider).toLowerCase()) || defaultProvider();
  logger.info('Hanging up call · provider=' + name);
  const svc = PROVIDERS[name];
  if (!svc || typeof svc.hangupCall !== 'function') {
    logger.warn('Hangup unsupported · provider=' + name);
    return { ok: false, unsupported: true, error: `${name} does not support hangup` };
  }
  return svc.hangupCall({ callUuid });
}

// The RAW configured default — '' (No Default) | 'plivo' | 'kaleyra' — unlike
// defaultProvider() which RESOLVES '' to an enabled provider. The Admin
// Click-to-Call-Mode control needs the raw value to show 'No Default' vs an
// explicit pick.
function rawDefaultProvider() {
  return String(getProperty('voice.default.provider') || '').toLowerCase();
}

// Call topology toggle: 'web' = operator talks from the browser (Plivo WebRTC,
// customer dialled directly) · 'mobile' = phone bridge (operator's phone rung
// first, then customer — today's default). Runtime-switchable via the
// easyfix_properties key `voice.call.mode` (Setting → Admin Actions). Defaults
// to 'mobile' so nothing changes until an admin opts in. Web mode is Plivo-only.
function callMode() {
  return String(getProperty('voice.call.mode') || 'mobile').toLowerCase() === 'web' ? 'web' : 'mobile';
}

// ── Per-provider QA / dev env overrides ──────────────────────────────────────
// These read process.env LIVE (env vars — NOT the cached easyfix_properties
// store). `<PROVIDER>_CALLING_CUSTOM_NUMBER=true` puts THAT provider in QA mode
// (the FE prompts for both legs); `<PROVIDER>_CALL_FROM` / `<PROVIDER>_CALL_TO`
// are the dev/QA test numbers the prompt pre-fills with. Keyed per provider so a
// Kaleyra test pair never bleeds into a Plivo call (and vice-versa) — the bug
// where the Place-Call modal always pre-filled KALEYRA_CALL_FROM/TO.
function customNumberMode(name) {
  return String(process.env[`${String(name).toUpperCase()}_CALLING_CUSTOM_NUMBER`]).toLowerCase() === 'true';
}
function qaDefaults(name) {
  const u = String(name).toUpperCase();
  const from = (process.env[`${u}_CALL_FROM`] || '').trim();
  const to   = (process.env[`${u}_CALL_TO`]   || '').trim();
  return (from || to) ? { from: from || null, to: to || null } : null;
}

module.exports = {
  clickToCall,
  previewCallLegs,
  hangup,
  resolveProvider,
  defaultProvider,
  enabledProviders,
  isProviderEnabled,
  supportsLiveStatus,
  customNumberMode,
  qaDefaults,
  callMode,
  rawDefaultProvider,
};
