const { getProperty } = require('./properties.service');
const kaleyra = require('./kaleyra.service');
const plivo = require('./plivo.service');

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
  const p = String(getProperty('voice.default.provider') || 'kaleyra').toLowerCase();
  return PROVIDERS[p] ? p : 'kaleyra';
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
  return defaultProvider();
}

// Whether this provider can show live mid-call status + be hung up from the UI.
// Kaleyra is post-call only; Plivo is event-native. Drives the FE live panel.
function supportsLiveStatus(name) {
  return typeof PROVIDERS[name]?.hangupCall === 'function';
}

async function clickToCall({ provider, ...rest } = {}) {
  const name = resolveProvider(provider);
  const result = await PROVIDERS[name].clickToCall(rest);
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
  const svc = PROVIDERS[name];
  if (!svc || typeof svc.hangupCall !== 'function') {
    return { ok: false, unsupported: true, error: `${name} does not support hangup` };
  }
  return svc.hangupCall({ callUuid });
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
};
