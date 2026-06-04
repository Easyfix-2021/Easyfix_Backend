const logger = require('../logger');
const { getProperty } = require('./properties.service');

/*
 * Kaleyra voice integration.
 * Mirrors the legacy EasyFix_API contract (UserResource.java::contactUsers
 * + ContactUserServiceImpl::getContactDetailsByuniqueId) verbatim:
 *
 *   click2call:
 *     GET https://api-voice.kaleyra.com/v1/?api_key=<KEY>
 *        &method=dial.click2call&format=json
 *        &caller=<FROM>&receiver=<TO>&return=1
 *     Response: { data: { id: "wamid…" }, status: "OK" }
 *
 *   callreports (polled by the 4-hour cron):
 *     GET https://api-voice.kaleyra.com/v1/?method=dial.callreports&format=json
 *        &api_key=<KEY>&id=<UNIQUE_ID>
 *     Response: { data: [{ status, billsec, recording, callstart, callend,
 *                           callerstate, location, provider, … }] }
 *
 * Phone numbers are always India domestic. The legacy sends 10 digits; the
 * normaliser here accepts either 10 or 91-prefixed and outputs 91-prefixed
 * (matches the SMS / WhatsApp pattern).
 *
 * Env-driven gates (distinct from notifications — voice calls are an
 * interactive bridge, NOT a notification):
 *
 *   KALEYRA_CALLING_ENABLED=true   → calls go through.
 *   KALEYRA_CALLING_ENABLED=false  → calls suppressed, log only, no HTTP.
 *   KALEYRA_CALLING_ENABLED=<unset>→ treated as FALSE (fail-closed).
 *
 *   KALEYRA_CALL_FROM=<number>     → DEV-ONLY override for the caller leg
 *   KALEYRA_CALL_TO=<number>       → DEV-ONLY override for the receiver leg
 *                                    Each is independent. If unset, the
 *                                    real value (operator's mobile_no /
 *                                    customer's customer_mob_no) is used.
 *                                    Production leaves BOTH unset so real
 *                                    operators dial real customers.
 *
 * Why TWO overrides instead of reusing TEST_MOBILE: Kaleyra click2call is
 * a two-leg BRIDGE (dial caller, wait for pickup, then dial receiver,
 * then join). If caller==receiver the second leg fails silently because
 * the only handset is already on the first leg's call. TEST_MOBILE was a
 * single value that redirected only the receiver, so any time the
 * operator's own mobile_no happened to equal TEST_MOBILE both legs
 * collapsed to the same number — that's exactly the production-look-alike
 * bug we hit on 2026-05-21. Voice gets its own dedicated overrides so
 * dev can set CALL_FROM=<my-phone> + CALL_TO=<colleague's-phone> and
 * verify BOTH legs ring independently.
 *
 * The fail-closed default on KALEYRA_CALLING_ENABLED exists because
 * previously this code keyed off NOTIFICATIONS_DISABLE — flipping that
 * flag to "false" (the natural production setting for marketing SMS /
 * OTP) would have silently switched voice calling ON as a side effect.
 * The dedicated flag forces a deliberate per-environment decision.
 */

const BASE = (process.env.KALEYRA_BASE_URL || 'https://api-voice.kaleyra.com/v1').replace(/\/+$/, '');

function callingEnabled() {
  // 2026-06-03 per ops: easyfix_properties is now the SOLE source of
  // truth — env fallback dropped. Missing key → calling stays off.
  const v = getProperty('kaleyra.calling.enabled');
  return String(v).toLowerCase() === 'true';
}

function normaliseIndianPhone(raw) {
  // Local copy rather than imported from meta.whatsapp — see the convention
  // documented there: "no cross-service imports" so each service stays
  // independently re-deployable.
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return '91' + digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  return null;
}

/*
 * Mask a phone for user-visible display: keep the first 4 digits, bullet the
 * rest. Mirrors the CRM convention (routes/admin/calls.js::maskFirstFour) so
 * the public "Need Help" preview reads the same as the operator click-to-call
 * confirm dialog. Operates on whatever digit string it's given (already
 * normalised 91-prefixed numbers included).
 */
function maskForDisplay(raw) {
  if (raw == null) return null;
  let d = String(raw).replace(/\D/g, '');
  if (!d) return null;
  // Drop the +91 country code before masking. The legs are normalised to
  // 91-prefixed (12 digits); showing them masked as-is ("9188••••••••") wastes
  // two of the four visible digits on the country code. Strip it so the user
  // sees the first 4 digits of the ACTUAL 10-digit number ("8801••••••").
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length <= 4) return d;
  return d.slice(0, 4) + '•'.repeat(d.length - 4);
}

/*
 * Pure resolver for the EFFECTIVE caller/receiver legs Kaleyra would dial for a
 * given (from, to) — applies the env-override waterfall + both hard guards, but
 * does NOT check KALEYRA_CALLING_ENABLED / api_key and never performs HTTP.
 * Single source of truth shared by clickToCall (which then places the call) and
 * the public masked-preview route (which only displays the legs for customer
 * visibility). Returns one of:
 *   { ok: false, error }                                   — invalid input number
 *   { ok: false, suppressed: true, diagnostic, real* }     — operator-less QA, no redirect
 *   { ok: false, sameNumber: true, error, diagnostic }     — bridge-to-self
 *   { ok: true, callerReal, receiverReal, caller, receiver, overridden }
 *
 * See the long-form rationale below for KALEYRA_CALL_FROM/TO, customNumberMode
 * and alwaysApplyEnvOverride.
 */
function resolveCallLegs({ from, to, alwaysApplyEnvOverride = false }) {
  const callerReal   = normaliseIndianPhone(from);
  const receiverReal = normaliseIndianPhone(to);
  if (!callerReal)   return { ok: false, error: `invalid caller phone "${from}"` };
  if (!receiverReal) return { ok: false, error: `invalid receiver phone "${to}"` };

  // ── DEV-ONLY LEG OVERRIDES (env vars) ──
  // Each leg can be independently substituted via env. Three-tier waterfall:
  //   1. KALEYRA_CALLING_CUSTOM_NUMBER=true → QA mode. The admin route handler
  //      has ALREADY substituted from/to with the FE-supplied values, so this
  //      resolver must NOT clobber those with env vars — short-circuited unless
  //      alwaysApplyEnvOverride is set.
  //   2. KALEYRA_CALL_FROM / KALEYRA_CALL_TO set → dev mode. Substitute.
  //   3. Neither set → production. Pass through.
  // `alwaysApplyEnvOverride` (2026-06-02): the OPERATOR-LESS public magic-link
  // bridge resolves the REAL customer + SPOC numbers server-side, so in QA it
  // would dial real people regardless of customNumberMode. Callers on that path
  // pass true so the KALEYRA_CALL_FROM/TO test-redirect ALWAYS applies in
  // non-prod (in prod those env vars are unset → passes through to real).
  let caller   = callerReal;
  let receiver = receiverReal;
  const overrides = [];
  const customNumberMode =
    String(process.env.KALEYRA_CALLING_CUSTOM_NUMBER).toLowerCase() === 'true';

  if (!customNumberMode || alwaysApplyEnvOverride) {
    const envFrom = process.env.KALEYRA_CALL_FROM;
    if (envFrom && envFrom.trim()) {
      const v = normaliseIndianPhone(envFrom);
      if (v) { caller = v; overrides.push(`from=${callerReal}→${caller} (KALEYRA_CALL_FROM)`); }
      else   logger.warn(`KALEYRA_CALL_FROM='${envFrom}' is not a valid Indian phone — ignored, using real caller.`);
    }
    const envTo = process.env.KALEYRA_CALL_TO;
    if (envTo && envTo.trim()) {
      const v = normaliseIndianPhone(envTo);
      if (v) { receiver = v; overrides.push(`to=${receiverReal}→${receiver} (KALEYRA_CALL_TO)`); }
      else   logger.warn(`KALEYRA_CALL_TO='${envTo}' is not a valid Indian phone — ignored, using real receiver.`);
    }
    if (overrides.length) {
      logger.test(`Kaleyra dev-override · ${overrides.join(' · ')}`);
    }
  }

  // ── OPERATOR-LESS QA SAFETY GUARD ──
  // The PUBLIC magic-link bridge passes alwaysApplyEnvOverride:true precisely
  // because it has NO operator to hand-enter test numbers. In QA mode the ONLY
  // safe non-prod source is the KALEYRA_CALL_FROM/TO env redirect applied just
  // above. If either leg is still a REAL number (env blank/invalid/partial) we
  // must NOT dial it (the 2026-06-02 real-customer-dialed bug). Suppress.
  // Production (customNumberMode=false, env unset) is untouched.
  if (alwaysApplyEnvOverride && customNumberMode) {
    const fromStillReal = caller   === callerReal;
    const toStillReal    = receiver === receiverReal;
    if (fromStillReal || toStillReal) {
      const which = [fromStillReal && 'KALEYRA_CALL_FROM', toStillReal && 'KALEYRA_CALL_TO']
        .filter(Boolean).join(' and ');
      logger.test(
        `Kaleyra click2call suppressed (operator-less QA, no valid test redirect) · ` +
        `set ${which} to a valid test number to enable calls in this environment.`
      );
      return { ok: false, suppressed: true, diagnostic: 'qa_missing_test_redirect', callerReal, receiverReal };
    }
  }

  // ── HARD GUARD: caller == receiver ──
  // Kaleyra bridges by dialling `caller`, then `receiver`. Identical numbers
  // silently fail the second leg — refuse loudly with a remediation message.
  if (caller === receiver) {
    const fromOverridden = caller   !== callerReal;
    const toOverridden   = receiver !== receiverReal;
    let reason;
    if (fromOverridden && toOverridden) {
      reason = `KALEYRA_CALL_FROM and KALEYRA_CALL_TO both resolved to ${caller}. Set them to two DIFFERENT numbers (one phone you can answer for the operator leg, another for the receiver leg).`;
    } else if (fromOverridden) {
      reason = `KALEYRA_CALL_FROM (${caller}) equals the real customer mobile (${receiverReal}). Pick a different override or clear KALEYRA_CALL_FROM.`;
    } else if (toOverridden) {
      reason = `KALEYRA_CALL_TO (${receiver}) equals the operator's mobile (${callerReal}). Pick a different override or clear KALEYRA_CALL_TO.`;
    } else {
      reason = `caller and receiver are the same number (${caller}). Kaleyra cannot bridge a line to itself.`;
    }
    logger.warn(`Kaleyra click2call refused — caller==receiver. ${reason}`);
    return { ok: false, sameNumber: true, error: `Cannot place call — ${reason}`, diagnostic: 'caller_equals_receiver', callerReal, receiverReal };
  }

  return {
    ok: true,
    callerReal, receiverReal, caller, receiver,
    overridden: caller !== callerReal || receiver !== receiverReal,
  };
}

/*
 * Compute the masked from→to a bridge WOULD dial, for user-visible display
 * (the public "Need Help" confirm + the operator click-to-call dialog parity).
 * Never performs HTTP. Returns { from, to, overridden, suppressed?, sameNumber? }
 * with both legs masked first-4-then-bullets. On suppressed/same-number it
 * masks the REAL legs so the customer still sees who would be involved.
 */
function previewCallLegs({ from, to, alwaysApplyEnvOverride = false }) {
  const legs = resolveCallLegs({ from, to, alwaysApplyEnvOverride });
  if (legs.ok) {
    return {
      from: maskForDisplay(legs.caller),
      to: maskForDisplay(legs.receiver),
      overridden: legs.overridden,
    };
  }
  // Non-ok: still surface masked real legs where we have them, plus the flag.
  return {
    from: maskForDisplay(legs.callerReal),
    to: maskForDisplay(legs.receiverReal),
    suppressed: !!legs.suppressed,
    sameNumber: !!legs.sameNumber,
    diagnostic: legs.diagnostic || null,
    error: legs.error || null,
  };
}

async function clickToCall({ from, to, alwaysApplyEnvOverride = false }) {
  const callerReal   = normaliseIndianPhone(from);
  const receiverReal = normaliseIndianPhone(to);
  if (!callerReal)   return { delivered: false, error: `invalid caller phone "${from}"` };
  if (!receiverReal) return { delivered: false, error: `invalid receiver phone "${to}"` };

  if (!callingEnabled()) {
    logger.test(`Kaleyra click2call suppressed (KALEYRA_CALLING_ENABLED!='true') · from=${callerReal} · to=${receiverReal}`);
    // `suppressed:true` is the canonical signal the route handler reads.
    // Kept the legacy `disabled` alias on the same payload so any stray
    // consumer that hadn't been updated yet still works.
    return { delivered: false, suppressed: true, disabled: true };
  }

  const apiKey = process.env.KALEYRA_API_KEY;
  if (!apiKey) return { delivered: false, error: 'KALEYRA_API_KEY not configured' };

  // Resolve the effective legs (override waterfall + QA-suppress + same-number
  // guards) via the shared resolver so the public preview can't drift from what
  // we actually dial. Ordering preserves the original: enabled + api_key checks
  // above already ran, so a disabled env still short-circuits to `suppressed`
  // before we touch the override logic.
  const legs = resolveCallLegs({ from, to, alwaysApplyEnvOverride });
  if (legs.suppressed) return { delivered: false, suppressed: true, diagnostic: legs.diagnostic };
  if (legs.sameNumber) return { delivered: false, error: legs.error, diagnostic: legs.diagnostic };
  if (!legs.ok)        return { delivered: false, error: legs.error };
  const { caller, receiver } = legs;

  // Build URL with explicit URLSearchParams — handles encoding cleanly.
  const params = new URLSearchParams({
    api_key:  apiKey,
    method:   'dial.click2call',
    format:   'json',
    caller,
    receiver,
    return:   '1',
  });
  // Legacy URL has `?` followed by params directly under /v1/. URLSearchParams
  // doesn't preserve the trailing slash before `?`, so build it explicitly.
  const url = `${BASE}/?${params.toString()}`;

  // ── DIAGNOSTIC LOG (pre-flight) ──
  // Capture EXACTLY what we're about to send to Kaleyra so a future
  // "the receiver didn't ring" report can be triaged in one log line.
  // API key is redacted (`api_key=***`) but every other param is in
  // clear so we can spot a mis-normalised phone, wrong method, missing
  // return flag, etc. Mobile is shown in full — log file lives behind
  // ops auth, not in user-visible artifacts.
  const safeUrl = url.replace(/api_key=[^&]+/, 'api_key=***');
  logger.info(`Kaleyra REQ · ${safeUrl}`);

  try {
    const res = await fetch(url, { method: 'GET' });
    const text = await res.text();
    const httpOk = res.ok;
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON — leave null */ }

    // Kaleyra is notorious for returning HTTP 200 with a `status` field
    // that actually reports the call outcome. `data.id` present + no
    // `error` field = the request was accepted and a call leg WILL be
    // attempted. Treat absent id as a soft failure even on 2xx.
    //
    // CAVEAT: Kaleyra sets `message: "OK"` / `status: "OK"` on a
    // SUCCESSFUL response. Treating "OK" as an error string causes the
    // FE to surface a toast that just says "OK" (which is what triggered
    // this fix). Filter it out so success-shaped messages don't masquerade
    // as errors.
    const callId   = parsed?.data?.id;
    const apiStatus = parsed?.status || parsed?.data?.status;
    const rawError  = parsed?.error || parsed?.message || parsed?.data?.message;
    const apiError  = (rawError && String(rawError).trim().toUpperCase() !== 'OK')
      ? rawError
      : null;
    const accepted = httpOk && !!callId && !apiError;

    // ── DIAGNOSTIC LOG (full response body, capped) ──
    // The pre-existing log was `id=?` only — useless for diagnosing a
    // half-failed call. Dump the parsed payload (or raw text) so a
    // future "caller rang but receiver didn't" report carries the
    // exact Kaleyra response in the same log line as the request.
    // Annotate each leg with "(real X)" when a KALEYRA_CALL_* override
    // is in effect so the log line reads unambiguously.
    const fromForLog = caller   !== callerReal   ? `${caller} (override; real ${callerReal})`     : caller;
    const toForLog   = receiver !== receiverReal ? `${receiver} (override; real ${receiverReal})` : receiver;
    const bodyForLog = (text || '').slice(0, 500).replace(/\s+/g, ' ');
    if (accepted) {
      logger.info(`📞 Kaleyra ACCEPTED · from=${fromForLog} · to=${toForLog} · id=${callId} · status=${apiStatus ?? '—'} · body=${bodyForLog}`);
    } else if (httpOk) {
      // 2xx but no call id → Kaleyra accepted the HTTP request but the
      // call itself didn't dispatch. This is the most-confusing failure
      // mode and the one most likely behind a "caller rang, receiver
      // didn't" report.
      logger.warn(`⚠ Kaleyra soft-fail (HTTP ${res.status}, no call id) · from=${fromForLog} · to=${toForLog} · status=${apiStatus ?? '—'} · error=${apiError ?? '—'} · body=${bodyForLog}`);
    } else {
      logger.warn(`✗ Kaleyra HARD-FAIL · from=${fromForLog} · to=${toForLog} · http=${res.status} · body=${bodyForLog}`);
    }
    return {
      delivered: accepted,
      callId,
      providerResponse: text,
      providerStatus: apiStatus,
      providerError: apiError,
      httpStatus: res.status,
      // True if either leg was substituted from env (dev only). Helps
      // ops audit logs distinguish prod-real calls from dev test calls.
      overridden: caller !== callerReal || receiver !== receiverReal,
      intendedCaller:   caller   !== callerReal   ? callerReal   : undefined,
      intendedReceiver: receiver !== receiverReal ? receiverReal : undefined,
      // Diagnostic hint passed to the route so the FE toast can be
      // specific instead of generic.
      diagnostic: accepted
        ? null
        : httpOk
          ? 'kaleyra_soft_fail_no_id'
          : 'kaleyra_http_error',
    };
  } catch (err) {
    logger.error(`Kaleyra click2call network error · from=${caller} · to=${receiver} · ${err.message}`);
    return { delivered: false, error: err.message, diagnostic: 'network_error' };
  }
}

async function getCallReport({ uniqueId }) {
  if (!uniqueId) return { ok: false, error: 'uniqueId required' };
  const apiKey = process.env.KALEYRA_API_KEY;
  if (!apiKey) return { ok: false, error: 'KALEYRA_API_KEY not configured' };

  const params = new URLSearchParams({
    method:  'dial.callreports',
    format:  'json',
    api_key: apiKey,
    id:      String(uniqueId),
  });
  const url = `${BASE}/?${params.toString()}`;

  try {
    const res = await fetch(url, { method: 'GET' });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { /* leave undefined */ }
    return {
      ok: res.ok,
      httpStatus: res.status,
      // Kaleyra wraps reports in `data[]`. Caller picks the first entry
      // (there's only ever one for a click2call session).
      report: parsed?.data?.[0] || null,
      raw: text,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { clickToCall, previewCallLegs, resolveCallLegs, getCallReport, normaliseIndianPhone };
