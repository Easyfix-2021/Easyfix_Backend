const router = require('express').Router();
const { pool } = require('../../db');
const logger = require('../../logger');
const validate = require('../../middleware/validate');
const { modernOk, modernError } = require('../../utils/response');
const kaleyra = require('../../services/kaleyra.service');
const plivo = require('../../services/plivo.service');
const voice = require('../../services/voice.service');
const plivoLog = require('../../services/plivo-call-log.service');
const propertiesSvc = require('../../services/properties.service');

// Coarse "Call From Flow" when the FE doesn't send an explicit one — derived
// from which receiver identifier was used.
function coarseFlow(body) {
  if (body.flow) return String(body.flow).slice(0, 64);
  if (body.jobId) return 'job';
  if (body.customerId) return 'customer';
  if (body.efrId) return 'technician';
  if (body.reportingContactId) return 'spoc';
  return null;
}
const { getEffectivePermissions } = require('../../services/role.service');
const { clickToCallBody, callListQuery } = require('../../validators/calls.validator');

/*
 * /api/admin/calls — operator-driven outbound calls + call history.
 *
 * Endpoints:
 *   POST /click-to-call  → places an outbound Kaleyra call from the
 *                          operator's own mobile to the customer of a
 *                          job (or a customer directly). Permission-
 *                          gated by `isClickToCall`.
 *   GET  /               → paginated call history for the navbar's
 *                          Call Info modal. Joins agent/customer names +
 *                          job ref onto the raw tbl_job_caller_info row.
 *
 * Auth + role(['admin']) come from the parent router (routes/admin/index.js).
 */

/*
 * Permission gate middleware. Mirrors routes/admin/quicksight.js's pattern.
 * We don't pre-cache the permission list on req.user — getEffectivePermissions
 * has its own role/menu cache, so this is cheap.
 */
async function requireClickToCallAction(req, res, next) {
  try {
    const perms = await getEffectivePermissions(req.user.user_id);
    if (!perms.actionPermissions.includes('isClickToCall')) {
      return modernError(res, 403, 'You do not have permission to place outbound calls');
    }
    return next();
  } catch (e) { return next(e); }
}

// ─── GET /config ─────────────────────────────────────────────────────
// Tells the FE which calling mode the environment is in so it can render
// the right confirmation flow:
//   - promptForNumbers=true  → QA mode; FE shows two text inputs and the
//                              operator supplies both Call From and Call To.
//   - promptForNumbers=false → operator's real mobile + customer mobile go
//                              to Kaleyra (dev env vars or production).
// In QA mode also surfaces `qaDefaults` (env var values, UNMASKED — they're
// operator-managed config, not user PII) so the dialog can pre-fill.
// Permission-gated on isClickToCall so unauthorised operators can't probe.
router.get('/config', requireClickToCallAction, (req, res) => {
  const enabled = voice.enabledProviders();
  const def = voice.defaultProvider();

  // Per-provider QA config so the FE prompts for + pre-fills the SELECTED
  // provider's *_CALL_FROM / *_CALL_TO (not always Kaleyra's). qaDefaults are
  // exposed ONLY for a provider that's in its own QA mode — we never leak a
  // provider's dev-override numbers to a production FE.
  const providers = {};
  for (const name of enabled) {
    const qa = voice.customNumberMode(name);
    providers[name] = { promptForNumbers: qa, qaDefaults: qa ? voice.qaDefaults(name) : null };
  }

  // Top-level fields mirror the DEFAULT provider so any consumer that doesn't
  // read the per-provider `providers` map still behaves sensibly. The FE radio
  // shows when >1 provider is enabled; the QA dialog reads `providers[<chosen>]`.
  const dp = providers[def] || { promptForNumbers: false, qaDefaults: null };
  modernOk(res, {
    mode: dp.promptForNumbers ? 'qa' : 'prod',
    promptForNumbers: dp.promptForNumbers,
    qaDefaults: dp.qaDefaults,
    enabledProviders: enabled,
    defaultProvider: def,
    providers,
    // 'web' = operator talks from the browser (Plivo WebRTC); 'mobile' = phone
    // bridge (today's default). The FE branches its calling flow on this.
    callMode: voice.callMode(),
  });
});

// ─── GET /preview ────────────────────────────────────────────────────
// Returns the EXACT numbers that the BE WOULD dial right now if
// click-to-call were invoked with the supplied identifier. Both legs are
// masked to first-4-digits-then-bullets so the unmasked digits never
// cross the wire (same masking-everywhere convention as the rest of the
// CRM — see CallableMobile and ClickToCallTab on the FE).
//
// Returns mode alongside so the FE can label "Real numbers" vs "Dev
// override" vs "QA mode default" in the confirm dialog if it wants to.
//
// Permission-gated like every other /admin/calls route.
router.get('/preview', requireClickToCallAction, validate(callListQuery, 'query'), async (req, res, next) => {
  try {
    // Reuse the existing callListQuery validator since it already permits
    // jobId / customerId / efrId / reportingContactId / page / limit and
    // silently strips unknowns. /preview consumes whichever of the four
    // identifiers the FE supplied — matching the click-to-call branches.
    const { jobId, customerId, efrId, reportingContactId, useAlt, provider } = req.query;
    // Boolean coercion — query strings carry primitives as strings.
    // Accept '1' or 'true' (case-insensitive) so callers don't have to
    // remember which truthy shape we expect.
    const useAltFlag = String(useAlt || '').toLowerCase() === 'true' || String(useAlt) === '1';
    if (!jobId && !customerId && !efrId && !reportingContactId) {
      return modernError(res, 400, 'one of jobId/customerId/efrId/reportingContactId is required');
    }

    // Resolve receiver real-mobile via the same lookups the POST handler
    // uses (kept in sync deliberately — if you change one set of queries,
    // change both).
    let receiverReal = null;
    if (jobId) {
      // useAltFlag mirrors the POST handler's behaviour — the preview
      // must show what we'd ACTUALLY dial, so the column read switches
      // when the FE intends to dial the alternate. See the POST handler
      // for the rationale + the "kept in sync" contract.
      const [[job]] = await pool.query(
        `SELECT c.customer_mob_no, j.additional_number
           FROM tbl_job j
      LEFT JOIN tbl_customer c ON c.customer_id = j.fk_customer_id
          WHERE j.job_id = ?
          LIMIT 1`,
        [jobId]
      );
      if (!job) return modernError(res, 404, `Job ${jobId} not found`);
      receiverReal = useAltFlag ? (job.additional_number || null) : (job.customer_mob_no || null);
    } else if (customerId) {
      const [[cust]] = await pool.query(
        `SELECT customer_mob_no FROM tbl_customer WHERE customer_id = ? LIMIT 1`,
        [customerId]
      );
      if (!cust) return modernError(res, 404, `Customer ${customerId} not found`);
      receiverReal = cust.customer_mob_no || null;
    } else if (efrId) {
      const [[efr]] = await pool.query(
        `SELECT efr_no FROM tbl_easyfixer WHERE efr_id = ? LIMIT 1`,
        [efrId]
      );
      if (!efr) return modernError(res, 404, `Easyfixer ${efrId} not found`);
      receiverReal = efr.efr_no || null;
    } else {
      const [[ct]] = await pool.query(
        `SELECT contact_no FROM tbl_client_contacts WHERE id = ? LIMIT 1`,
        [reportingContactId]
      );
      if (!ct) return modernError(res, 404, `Contact ${reportingContactId} not found`);
      receiverReal = ct.contact_no || null;
    }

    // Resolve the EXACT masked legs we'd dial via the shared voice factory
    // (voice.previewCallLegs) — the SAME code path clickToCall uses — so this
    // preview can never drift from the real call. The factory resolves the
    // provider (honouring the optional ?provider= when enabled, else the
    // configured default) and delegates to that provider's previewCallLegs.
    // In QA mode (customNumberMode) we pass alwaysApplyEnvOverride so the
    // *_CALL_FROM/TO values the dialog pre-fills are reflected; dev/prod resolve
    // through the normal waterfall. previewCallLegs masks first-4-then-bullets
    // internally (same convention as before). The resolved provider is echoed
    // back so the FE can label which line will dial.
    // Per-provider mode: whether the chosen/resolved provider is in QA custom
    // mode decides if its *_CALL_FROM/TO override is reflected in the preview.
    const resolvedForPreview = voice.resolveProvider(provider);
    const mode = voice.customNumberMode(resolvedForPreview) ? 'qa' : 'prod';
    const preview = voice.previewCallLegs({
      provider,
      from: req.user.mobile_no,
      to:   receiverReal,
      alwaysApplyEnvOverride: mode === 'qa',
    });

    modernOk(res, { mode, dialFrom: preview.from, dialTo: preview.to, provider: preview.provider });
  } catch (e) { next(e); }
});

// Resolve the receiver (customer / technician / SPOC) identically for BOTH
// POST /click-to-call and POST /web-start — single source so the two never
// drift. The FE never supplies the customer mobile; it's always looked up
// server-side here. Returns { ok:true, receiverMobile, receiverName,
// receiverCustomerId, jobIdToStore, jobStatusSnapshot, jobEfrId } on success,
// or { ok:false, status, message } the caller turns into a modernError.
async function resolveReceiver({ jobId, customerId, efrId, reportingContactId, useAlt }) {
  if (jobId) {
    const [[job]] = await pool.query(
      `SELECT j.job_id, j.fk_customer_id, j.fk_easyfixter_id, j.job_status,
              COALESCE(j.job_customer_name, c.customer_name) AS customer_name,
              c.customer_mob_no, j.additional_name, j.additional_number
         FROM tbl_job j
    LEFT JOIN tbl_customer c ON c.customer_id = j.fk_customer_id
        WHERE j.job_id = ? LIMIT 1`,
      [jobId]
    );
    if (!job) return { ok: false, status: 404, message: `Job ${jobId} not found` };
    let receiverMobile; let receiverName;
    if (useAlt) {
      if (!job.additional_number) return { ok: false, status: 400, message: `Job ${jobId} has no alternate number on file` };
      receiverMobile = job.additional_number;
      receiverName   = job.additional_name || job.customer_name || null;
    } else {
      if (!job.customer_mob_no) return { ok: false, status: 400, message: `Job ${jobId} has no customer mobile on file` };
      receiverMobile = job.customer_mob_no;
      receiverName   = job.customer_name || null;
    }
    return {
      ok: true, receiverMobile, receiverName,
      receiverCustomerId: job.fk_customer_id || null,
      jobIdToStore: job.job_id, jobStatusSnapshot: job.job_status,
      jobEfrId: job.fk_easyfixter_id || null,
    };
  }
  if (customerId) {
    const [[cust]] = await pool.query(
      `SELECT customer_id, customer_name, customer_mob_no FROM tbl_customer WHERE customer_id = ? LIMIT 1`,
      [customerId]
    );
    if (!cust) return { ok: false, status: 404, message: `Customer ${customerId} not found` };
    if (!cust.customer_mob_no) return { ok: false, status: 400, message: `Customer ${customerId} has no mobile on file` };
    return { ok: true, receiverMobile: cust.customer_mob_no, receiverName: cust.customer_name || null, receiverCustomerId: cust.customer_id, jobIdToStore: null, jobStatusSnapshot: null, jobEfrId: null };
  }
  if (efrId) {
    const [[efr]] = await pool.query(
      `SELECT efr_id, efr_first_name, efr_last_name, efr_no FROM tbl_easyfixer WHERE efr_id = ? LIMIT 1`,
      [efrId]
    );
    if (!efr) return { ok: false, status: 404, message: `Easyfixer ${efrId} not found` };
    if (!efr.efr_no) return { ok: false, status: 400, message: `Easyfixer ${efrId} has no mobile on file` };
    return { ok: true, receiverMobile: efr.efr_no, receiverName: [efr.efr_first_name, efr.efr_last_name].filter(Boolean).join(' ').trim() || null, receiverCustomerId: null, jobIdToStore: null, jobStatusSnapshot: null, jobEfrId: null };
  }
  const [[ct]] = await pool.query(
    `SELECT id, contact_name, contact_no FROM tbl_client_contacts WHERE id = ? LIMIT 1`,
    [reportingContactId]
  );
  if (!ct) return { ok: false, status: 404, message: `Contact ${reportingContactId} not found` };
  if (!ct.contact_no) return { ok: false, status: 400, message: `Contact ${reportingContactId} has no mobile on file` };
  return { ok: true, receiverMobile: ct.contact_no, receiverName: ct.contact_name || null, receiverCustomerId: null, jobIdToStore: null, jobStatusSnapshot: null, jobEfrId: null };
}

// ─── POST /click-to-call ─────────────────────────────────────────────
router.post('/click-to-call', requireClickToCallAction, validate(clickToCallBody), async (req, res, next) => {
  try {
    const { jobId, customerId, efrId, reportingContactId, callFrom, callTo, useAlt, provider } = req.body;
    const agent = req.user;

    // Three-tier number-resolution waterfall:
    //   1. QA prompt mode → FE MUST supply both callFrom + callTo, BE uses them.
    //   2. Flag OFF + FE sent override numbers → 400 (anti-spoofing).
    //   3. Otherwise → resolve real numbers (req.user.mobile_no + customer lookup).
    // Custom-number (QA) mode is PER-PROVIDER: the operator's chosen provider
    // (resolved here, reused for the audit row below) decides whether the
    // FE-supplied callFrom/callTo are honoured — so a Plivo call reads
    // PLIVO_CALLING_CUSTOM_NUMBER, not the Kaleyra flag.
    const resolvedProvider = voice.resolveProvider(provider);
    const isCustomNumberMode = voice.customNumberMode(resolvedProvider);

    if (!isCustomNumberMode && (callFrom || callTo)) {
      // Defence in depth: even though the FE shouldn't send these when the
      // flag is off (it queries /config first), any user crafting their own
      // POST could try. Reject explicitly so privilege escalation isn't
      // silently accepted via stripUnknown.
      return modernError(res, 400, 'Custom caller/receiver numbers are not allowed in this environment.');
    }
    if (isCustomNumberMode && (!callFrom || !callTo)) {
      return modernError(res, 400, 'Both Call From and Call To are required in QA mode.');
    }

    // Agent mobile guard — only required when we're going to fall back to
    // it. In QA-prompt mode the FE-supplied callFrom takes the operator's
    // place, so an operator without a profile mobile can still place calls
    // in QA. Production / dev-env-override modes still require it.
    if (!isCustomNumberMode &&
        (!agent.mobile_no || String(agent.mobile_no).replace(/\D/g, '').length < 10)) {
      return modernError(res, 400, 'Your profile does not have a valid mobile number. Update your profile before placing calls.');
    }

    // ── Resolve receiver mobile + name + (optional) job context ──
    // Shared with POST /web-start via resolveReceiver() so the two paths can't
    // drift. FE never sends the customer mobile — always looked up server-side.
    const rr = await resolveReceiver({ jobId, customerId, efrId, reportingContactId, useAlt });
    if (!rr.ok) return modernError(res, rr.status, rr.message);
    const {
      receiverMobile, receiverName, receiverCustomerId,
      jobIdToStore, jobStatusSnapshot, jobEfrId,
    } = rr;

    // ── Resolve the dial legs ──
    // In QA mode the operator typed both numbers; everywhere else we use
    // the resolved real values. The service layer's env-var overrides
    // (per-provider *_CALL_FROM / *_CALL_TO) also fire — but only when that
    // provider's CUSTOM_NUMBER flag is OFF (the service short-circuits so the
    // FE-supplied values aren't clobbered).
    const dialFrom = isCustomNumberMode ? callFrom : agent.mobile_no;
    const dialTo   = isCustomNumberMode ? callTo   : receiverMobile;

    // ── Insert-first audit row ──
    // We persist BEFORE placing the call so a live provider (Plivo) whose
    // ring/answer/hangup callbacks may fire near-instantly has a row to update
    // by jobCallerInfoId (the signed call token carries this id). caller_status
    // starts at 'initiated' and unique_id is NULL until the provider returns a
    // call id. provider is the resolved provider (honours the optional request
    // value only when enabled, else the configured default). Column-name typos
    // `reciever*` preserved verbatim per backend CLAUDE.md. is_updated=0 → the
    // Kaleyra report cron will fill metadata (Plivo rows are excluded there).
    // resolvedProvider computed above (drives both the QA-mode check + this row).
    const [insertResult] = await pool.query(
      `INSERT INTO tbl_job_caller_info
         (job_id, unique_id, caller, caller_id, caller_name,
          reciever, reciever_id, reciever_name,
          job_status, job_efr_id, call_type, inserted_by, is_updated,
          provider, caller_status)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'OUT', ?, 0, ?, 'initiated')`,
      [
        jobIdToStore,
        kaleyra.normaliseIndianPhone(agent.mobile_no),
        agent.user_id,
        agent.user_name,
        kaleyra.normaliseIndianPhone(receiverMobile),
        receiverCustomerId,
        receiverName,
        jobStatusSnapshot,
        jobEfrId,
        agent.user_id,
        resolvedProvider,
      ]
    );
    const jci = insertResult.insertId;

    // ── Place the call via the provider factory ──
    // voice.clickToCall resolves the provider, stamps it on the result, and
    // (for Plivo) signs jobCallerInfoId into the callback token so the
    // webhooks can find this exact row.
    const callResult = await voice.clickToCall({
      provider,
      from: dialFrom,
      to:   dialTo,
      jobCallerInfoId: jci,
    });

    if (!callResult.delivered) {
      // Suppressed-mode dev convenience: still return 200 so the UI can
      // show "would have called" feedback. Distinct from real failures,
      // which bubble as 4xx/5xx below. We mark the row 'suppressed' so the
      // history reflects it was never actually dispatched.
      if (callResult.suppressed || callResult.disabled) {
        await pool.query(
          `UPDATE tbl_job_caller_info SET caller_status = 'suppressed' WHERE job_caller_info = ?`,
          [jci]
        );
        return modernOk(res, {
          delivered: false,
          suppressed: true,
          jobCallerInfoId: jci,
          provider: callResult.provider || resolvedProvider,
          message: 'Outbound calling is disabled in this environment (enable the provider via <provider>.calling.enabled=true).',
        });
      }

      // Real failure — mark the row 'failed' (stamp the resolved provider from
      // the result), then hand the FE the EXACT reason so the toast is
      // actionable. The service already classified the failure via `diagnostic`
      // so we don't re-parse strings here.
      //   - caller_equals_receiver  → 400 (config issue, caller can fix)
      //   - kaleyra_soft_fail_no_id → 502 (provider accepted HTTP, no leg)
      //   - kaleyra_http_error / plivo_http_error → 502 (non-2xx)
      //   - network_error           → 502 (couldn't reach provider)
      await pool.query(
        `UPDATE tbl_job_caller_info
            SET caller_status = 'failed', provider = ?
          WHERE job_caller_info = ?`,
        [callResult.provider || resolvedProvider, jci]
      );
      const status = callResult.diagnostic === 'caller_equals_receiver' ? 400 : 502;
      const baseMsg = callResult.error
        || callResult.providerError
        || `Provider rejected the call${callResult.providerStatus ? ` (status=${callResult.providerStatus})` : ''}`;
      return modernError(res, status, baseMsg, {
        diagnostic: callResult.diagnostic,
        providerStatus: callResult.providerStatus,
        providerError: callResult.providerError,
      });
    }

    // ── Stamp the placed call onto the row ──
    // unique_id = the provider's call id (Plivo request_uuid / Kaleyra
    // uniqueId); provider = the resolved provider; status flips to 'placed'.
    // Guard on caller_status='initiated' so we don't stomp a provider callback
    // that already advanced the row (a Plivo ring/answer webhook can land while
    // voice.clickToCall above is still awaiting). If a callback already moved it
    // to 'ringing'/'answered' (and set unique_id=CallUUID), this no-ops and the
    // live state is preserved.
    await pool.query(
      `UPDATE tbl_job_caller_info
          SET unique_id = ?, provider = ?, caller_status = 'placed'
        WHERE job_caller_info = ? AND caller_status = 'initiated'`,
      [callResult.callId || null, callResult.provider || resolvedProvider, jci]
    );

    // Dedicated Plivo call log (fail-soft) — bridge/mobile Plivo calls only.
    if ((callResult.provider || resolvedProvider) === 'plivo') {
      await plivoLog.record({
        job_caller_info_id: jci, job_id: jobIdToStore, call_mode: 'mobile', call_flow: coarseFlow(req.body),
        caller_user_id: agent.user_id, caller_name: agent.user_name, receiver_name: receiverName || null,
        receiver_number: kaleyra.normaliseIndianPhone(receiverMobile),
        dialed_number: kaleyra.normaliseIndianPhone(dialTo),
        is_qa_redirect: callResult.overridden ? 1 : 0,
        request_uuid: callResult.callId || null, status: 'placed',
      });
    }

    logger.info(`Click-to-call placed · agent=${agent.user_name}(#${agent.user_id}) → ${receiverName || receiverCustomerId || 'customer'} · row=${jci} · provider=${callResult.provider} · uniqueId=${callResult.callId || '—'}`);
    return modernOk(res, {
      delivered: true,
      jobCallerInfoId: jci,
      callId: callResult.callId || null,
      provider: callResult.provider,
      // supportsLiveStatus tells the FE whether to open the live status panel
      // (Plivo) or just toast (Kaleyra, post-call report only).
      supportsLiveStatus: !!callResult.supportsLiveStatus,
      // `overridden` is true when either *_CALL_FROM or *_CALL_TO substituted a
      // leg. Kept the `redirected` alias so any FE not yet updated still reads
      // truthy.
      overridden: callResult.overridden || false,
      redirected: callResult.overridden || false,
      message: callResult.overridden
        ? 'Dev override active — one or both legs routed to a *_CALL_* test number instead of the real participant.'
        : 'Calling — your phone will ring shortly.',
    });
  } catch (e) { next(e); }
});

// ─── GET /web-credentials — Plivo Browser SDK login (Web Call mode) ────
// Returns a PER-OPERATOR, short-lived Plivo access token (no shared endpoint
// password crosses the wire) + the caller-id the browser dials. The SDK logs in
// via client.loginWithAccessToken(). Gated by the click-to-call permission;
// served ONLY when Web mode is on, Plivo is enabled, and the endpoint is set.
router.get('/web-credentials', requireClickToCallAction, (req, res) => {
  if (voice.callMode() !== 'web') return modernError(res, 409, 'Web calling is not enabled (voice.call.mode != web).');
  if (!plivo.callingEnabled()) return modernError(res, 409, 'Plivo is not enabled.');
  const token = plivo.webAccessToken({ operatorId: req.user.user_id });
  if (!token) return modernError(res, 500, 'Plivo web calling is not configured (PLIVO_AUTH_ID/AUTH_TOKEN/ENDPOINT_USERNAME).');
  // callerId is the company DID the browser dials INTO (a valid phone number —
  // the SDK requires a real number as the destination); the answer URL ignores
  // it and bridges to the customer resolved from the X-PH-Dialid header.
  return modernOk(res, { token, callerId: process.env.PLIVO_CALLER_ID || null });
});

// ─── POST /web-start — begin a Web (browser WebRTC) call ───────────────
// Web mode: the operator's browser IS the first leg. We resolve the receiver
// server-side (masking preserved — the real number NEVER reaches the browser),
// insert the audit row, and return an OPAQUE one-time dialId. The FE calls
// client.call(dialId); /api/public/plivo/web-answer resolves the id → real
// number and bridges. Reuses resolveReceiver() so it can't drift from /click-to-call.
router.post('/web-start', requireClickToCallAction, validate(clickToCallBody), async (req, res, next) => {
  try {
    if (voice.callMode() !== 'web') return modernError(res, 409, 'Web calling is not enabled.');
    if (!plivo.callingEnabled()) return modernError(res, 409, 'Plivo is not enabled.');

    const { jobId, customerId, efrId, reportingContactId, useAlt } = req.body;
    const agent = req.user;

    const rr = await resolveReceiver({ jobId, customerId, efrId, reportingContactId, useAlt });
    if (!rr.ok) return modernError(res, rr.status, rr.message);

    const receiver = plivo.normaliseIndianPhone(rr.receiverMobile);
    if (!receiver) return modernError(res, 400, 'Receiver number is not a valid Indian mobile.');

    // QA SAFETY: in custom-number/QA mode the operator is PROMPTED for the number
    // to dial (the FE prefills it from PLIVO_CALL_TO) — we dial EXACTLY what they
    // supplied via callTo, NEVER the real customer. The audit/log row still
    // records the real intended customer. callTo is required in QA so a real
    // customer can't be reached even if the FE prompt is bypassed.
    let dialNumber = receiver;
    if (voice.customNumberMode('plivo')) {
      const supplied = plivo.normaliseIndianPhone(req.body.callTo);
      if (!supplied) return modernError(res, 400, 'QA mode: "Call To" (the number to dial) is required.');
      dialNumber = supplied;
      logger.test(`Web call QA · real=${plivo.maskForDisplay(receiver)} → operator-supplied ${plivo.maskForDisplay(dialNumber)}`);
    }

    // Insert-first audit row (provider=plivo; the browser endpoint is the caller).
    const [ins] = await pool.query(
      `INSERT INTO tbl_job_caller_info
         (job_id, unique_id, caller, caller_id, caller_name,
          reciever, reciever_id, reciever_name,
          job_status, job_efr_id, call_type, inserted_by, is_updated,
          provider, caller_status)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'OUT', ?, 0, 'plivo', 'initiated')`,
      [
        rr.jobIdToStore,
        plivo.normaliseIndianPhone(agent.mobile_no) || 'web',
        agent.user_id,
        agent.user_name,
        receiver,
        rr.receiverCustomerId,
        rr.receiverName,
        rr.jobStatusSnapshot,
        rr.jobEfrId,
        agent.user_id,
      ]
    );
    const jci = ins.insertId;

    // Opaque, one-time id the browser dials; the answer route maps it → number.
    // In QA this is the TEST number; the audit row above kept the real customer.
    const dialId = plivo.stashWebDial({ number: dialNumber, jci });

    // Dedicated Plivo call log (fail-soft) — for Plivo-only reconciliation.
    await plivoLog.record({
      job_caller_info_id: jci, job_id: rr.jobIdToStore, call_mode: 'web', call_flow: coarseFlow(req.body),
      caller_user_id: agent.user_id, caller_name: agent.user_name, receiver_name: rr.receiverName || null,
      receiver_number: receiver, dialed_number: dialNumber, is_qa_redirect: dialNumber !== receiver ? 1 : 0,
      status: 'initiated',
    });

    logger.info(`Web call started · agent=${agent.user_name}(#${agent.user_id}) → ${rr.receiverName || rr.receiverCustomerId || 'customer'} · row=${jci}`);
    return modernOk(res, {
      jobCallerInfoId: jci,
      dialId,
      toMasked: plivo.maskForDisplay(receiver),
      receiverName: rr.receiverName || null,
    });
  } catch (e) { next(e); }
});

// ─── POST /mode — switch Web Call ⇄ Mobile Call (Setting → Admin Actions) ──
// Admin-only. Persists voice.call.mode in easyfix_properties + flushes the cache
// so it takes effect immediately (no restart). Web mode is Plivo-only, so it
// refuses to switch to 'web' unless Plivo is enabled.
router.post('/mode', requireClickToCallAction, async (req, res, next) => {
  try {
    if (Number(req.user.user_role) !== 2) {
      return modernError(res, 403, 'Only an Admin can change the calling mode.');
    }
    const mode = String(req.body.mode || '').toLowerCase();
    if (mode !== 'web' && mode !== 'mobile') {
      return modernError(res, 400, "mode must be 'web' or 'mobile'.");
    }
    if (mode === 'web' && !plivo.callingEnabled()) {
      return modernError(res, 409, 'Enable Plivo (plivo.calling.enabled=true) before switching to Web calling.');
    }
    await propertiesSvc.setProperty('voice.call.mode', mode);
    await propertiesSvc.flushCache();
    logger.info(`Calling mode set to '${mode}' by user #${req.user.user_id}`);
    return modernOk(res, { callMode: voice.callMode() });
  } catch (e) { next(e); }
});

// Terminal normalized statuses — once the row reaches one of these the FE can
// stop polling. Mirrors the webhook's CallStatus→status mapping (plus the
// operator-driven 'hungup'). Kept in sync with routes/webhook/plivo.js.
const TERMINAL_STATUSES = new Set(['completed', 'busy', 'no_answer', 'failed', 'hungup']);

// Parse + validate a positive-integer :id path param. Returns null on a bad
// shape so the handler can 400 cleanly (no dedicated id-param validator
// exists for /admin/calls — same inline guard pattern as job-completion.js).
function parseRowId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ─── GET /:id/status — live status of one call (FE polling) ────────────
// Returns the normalized caller_status + timestamps so the FE live panel can
// poll a Plivo call to completion. Authorised to the operator who placed it
// (caller_id match) OR any Admin-group user (kept simple). `terminal` lets the
// FE stop polling. answered_at = start_time, ended_at = end_time.
router.get('/:id/status', requireClickToCallAction, async (req, res, next) => {
  try {
    const id = parseRowId(req.params.id);
    if (!id) return modernError(res, 400, 'invalid call id');

    const [[row]] = await pool.query(
      `SELECT job_caller_info AS id, caller_id, caller_status,
              start_time, end_time, duration, provider
         FROM tbl_job_caller_info
        WHERE job_caller_info = ?
        LIMIT 1`,
      [id]
    );
    if (!row) return modernError(res, 404, 'call not found');

    // Authorize: the operator who placed it, or an Admin. role group is on the
    // parent router (role(['admin'])); the Admin role_id is 2. Anyone else may
    // only read their own call rows.
    const isOwner = row.caller_id != null && Number(row.caller_id) === Number(req.user.user_id);
    const isAdmin = Number(req.user.user_role) === 2; // role_id 2 = Admin (CLAUDE.md role model)
    if (!isOwner && !isAdmin) {
      return modernError(res, 403, 'You can only view the status of calls you placed');
    }

    const status = row.caller_status || null;
    return modernOk(res, {
      status,
      ringing_at: null,                 // Plivo ring callback only flips status;
                                        // no dedicated column — surface via status.
      answered_at: row.start_time || null,
      ended_at: row.end_time || null,
      duration: row.duration ?? null,
      terminal: status ? TERMINAL_STATUSES.has(status) : false,
      provider: row.provider || null,
    });
  } catch (e) { next(e); }
});

// ─── POST /:id/hangup — terminate a live call from the UI ──────────────
// Only meaningful for providers that support hangup (Plivo). Loads the row,
// asks the provider factory to terminate by stored unique_id (CallUUID), and
// on success stamps caller_status='hungup' + end_time=NOW(). Kaleyra returns
// unsupported → 409.
router.post('/:id/hangup', requireClickToCallAction, async (req, res, next) => {
  try {
    const id = parseRowId(req.params.id);
    if (!id) return modernError(res, 400, 'invalid call id');

    const [[row]] = await pool.query(
      `SELECT job_caller_info AS id, caller_id, provider, unique_id, caller_status
         FROM tbl_job_caller_info
        WHERE job_caller_info = ?
        LIMIT 1`,
      [id]
    );
    if (!row) return modernError(res, 404, 'call not found');

    const isOwner = row.caller_id != null && Number(row.caller_id) === Number(req.user.user_id);
    const isAdmin = Number(req.user.user_role) === 2; // role_id 2 = Admin (CLAUDE.md role model)
    if (!isOwner && !isAdmin) {
      return modernError(res, 403, 'You can only hang up calls you placed');
    }

    // Already finished → idempotent success (the FE poll will reflect the real
    // terminal state anyway).
    const status = row.caller_status || null;
    if (status && TERMINAL_STATUSES.has(status)) {
      return modernOk(res, { success: true, alreadyEnded: true });
    }
    // Before a provider callback lands, `unique_id` is the call-request handle
    // (Plivo request_uuid), NOT the CallUUID the hangup API needs — firing
    // DELETE with it would 404. Refuse gracefully until ring/answer captures the
    // CallUUID. The FE surfaces this 409 inline; the operator retries in a beat.
    if (!status || status === 'initiated' || status === 'placed') {
      return modernError(res, 409, 'Call is still connecting — please try hangup again in a moment.');
    }

    const r = await voice.hangup({ provider: row.provider, callUuid: row.unique_id });
    if (r.unsupported) {
      return modernError(res, 409, 'Provider does not support hangup');
    }
    if (!r.ok) {
      return modernError(res, 502, r.error || 'Failed to hang up the call');
    }

    await pool.query(
      `UPDATE tbl_job_caller_info
          SET caller_status = 'hungup', end_time = NOW(), is_updated = 1
        WHERE job_caller_info = ?`,
      [id]
    );
    logger.info(`Click-to-call hung up · row=${id} · provider=${row.provider} · by=${req.user.user_id}`);
    return modernOk(res, { success: true });
  } catch (e) { next(e); }
});

// ─── GET / — paginated call history ───────────────────────────────────
router.get('/', validate(callListQuery, 'query'), async (req, res, next) => {
  try {
    const { jobId, customerId, dateFrom, dateTo, page, limit } = req.query;
    const where = [];
    const params = [];
    if (jobId)      { where.push('jci.job_id = ?');      params.push(jobId); }
    if (customerId) { where.push('jci.reciever_id = ?'); params.push(customerId); }
    if (dateFrom)   { where.push('jci.inserted_time >= ?'); params.push(dateFrom); }
    if (dateTo)     { where.push('jci.inserted_time < ?');  params.push(dateTo); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM tbl_job_caller_info jci ${whereSql}`,
      params
    );
    const [rows] = await pool.query(
      `SELECT jci.job_caller_info AS id,
              jci.job_id,
              jci.unique_id,
              jci.caller,
              jci.caller_id,
              jci.caller_name,
              jci.reciever      AS receiver,
              jci.reciever_id   AS receiver_id,
              jci.reciever_name AS receiver_name,
              jci.call_type,
              jci.start_time,
              jci.end_time,
              jci.duration,
              jci.caller_status,
              jci.reciever_status AS receiver_status,
              jci.recording,
              jci.location,
              jci.provider,
              jci.inserted_time,
              jci.is_updated
         FROM tbl_job_caller_info jci
         ${whereSql}
         ORDER BY jci.inserted_time DESC
         LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return modernOk(res, { total, page, limit, items: rows });
  } catch (e) { next(e); }
});

module.exports = router;
