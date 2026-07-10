const router = require('express').Router();
const { pool } = require('../../db');
const logger = require('../../logger');
const validate = require('../../middleware/validate');
const { modernOk, modernError } = require('../../utils/response');
const kaleyra = require('../../services/kaleyra.service');
const plivo = require('../../services/plivo.service');
const voice = require('../../services/voice.service');
const plivoLog = require('../../services/plivo-call-log.service');
const callAnalysis = require('../../services/call-analysis.service');
const callerScorecard = require('../../services/caller-scorecard.service');
const propertiesSvc = require('../../services/properties.service');
const { requirePropertyAllowlist } = require('../../middleware/require-property-allowlist');
const { FEATURES } = require('../../services/feature-access.service');

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
  logger.info('Get calling config');
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
    // RAW stored value ('' = No Default | 'plivo' | 'kaleyra') so the Admin
    // toggle can show 'No Default' distinctly from an explicit pick.
    defaultProviderRaw: voice.rawDefaultProvider(),
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
    logger.info('Preview call legs · jobId=' + (jobId ?? '—') + ' · customerId=' + (customerId ?? '—') + ' · efrId=' + (efrId ?? '—') + ' · contactId=' + (reportingContactId ?? '—') + ' · provider=' + (provider || 'default'));
    // Boolean coercion — query strings carry primitives as strings.
    // Accept '1' or 'true' (case-insensitive) so callers don't have to
    // remember which truthy shape we expect.
    const useAltFlag = String(useAlt || '').toLowerCase() === 'true' || String(useAlt) === '1';
    if (!jobId && !customerId && !efrId && !reportingContactId) {
      logger.warn('Preview rejected · no receiver identifier supplied');
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
        `SELECT efr_no FROM tbl_easyfixer WHERE efr_id = ? AND NOT (tbl_easyfixer.efr_status <=> 3) LIMIT 1`,
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

    logger.info('Preview resolved · mode=' + mode + ' · provider=' + preview.provider);
    modernOk(res, { mode, dialFrom: preview.from, dialTo: preview.to, provider: preview.provider });
  } catch (e) { next(e); }
});

// Resolve the receiver (customer / technician / SPOC) identically for BOTH
// POST /click-to-call and POST /web-start — single source so the two never
// drift. The FE never supplies the customer mobile; it's always looked up
// server-side here. Returns { ok:true, receiverMobile, receiverName,
// receiverCustomerId, jobIdToStore, jobStatusSnapshot, jobEfrId } on success,
// or { ok:false, status, message } the caller turns into a modernError.
async function resolveReceiver({ jobId, customerId, efrId, reportingContactId, useAlt, jobContextId }) {
  logger.info('Resolve call receiver · jobId=' + (jobId ?? '—') + ' · customerId=' + (customerId ?? '—') + ' · efrId=' + (efrId ?? '—') + ' · contactId=' + (reportingContactId ?? '—') + ' · useAlt=' + !!useAlt);
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
    if (!job) logger.warn('Resolve receiver · job not found · jobId=' + jobId);
    if (!job) return { ok: false, status: 404, message: `Job ${jobId} not found` };
    let receiverMobile; let receiverName;
    if (useAlt) {
      if (!job.additional_number) logger.warn('Resolve receiver · no alternate number · jobId=' + jobId);
      if (!job.additional_number) return { ok: false, status: 400, message: `Job ${jobId} has no alternate number on file` };
      receiverMobile = job.additional_number;
      receiverName   = job.additional_name || job.customer_name || null;
    } else {
      if (!job.customer_mob_no) logger.warn('Resolve receiver · no customer mobile · jobId=' + jobId);
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
    if (!cust) logger.warn('Resolve receiver · customer not found · customerId=' + customerId);
    if (!cust) return { ok: false, status: 404, message: `Customer ${customerId} not found` };
    if (!cust.customer_mob_no) logger.warn('Resolve receiver · no customer mobile · customerId=' + customerId);
    if (!cust.customer_mob_no) return { ok: false, status: 400, message: `Customer ${customerId} has no mobile on file` };
    return { ok: true, receiverMobile: cust.customer_mob_no, receiverName: cust.customer_name || null, receiverCustomerId: cust.customer_id, jobIdToStore: jobContextId || null, jobStatusSnapshot: null, jobEfrId: null };
  }
  if (efrId) {
    const [[efr]] = await pool.query(
      `SELECT efr_id, efr_first_name, efr_last_name, efr_no FROM tbl_easyfixer WHERE efr_id = ? AND NOT (tbl_easyfixer.efr_status <=> 3) LIMIT 1`,
      [efrId]
    );
    if (!efr) logger.warn('Resolve receiver · easyfixer not found · efrId=' + efrId);
    if (!efr) return { ok: false, status: 404, message: `Easyfixer ${efrId} not found` };
    if (!efr.efr_no) logger.warn('Resolve receiver · no easyfixer mobile · efrId=' + efrId);
    if (!efr.efr_no) return { ok: false, status: 400, message: `Easyfixer ${efrId} has no mobile on file` };
    return { ok: true, receiverMobile: efr.efr_no, receiverName: [efr.efr_first_name, efr.efr_last_name].filter(Boolean).join(' ').trim() || null, receiverCustomerId: null, jobIdToStore: jobContextId || null, jobStatusSnapshot: null, jobEfrId: null };
  }
  const [[ct]] = await pool.query(
    `SELECT id, contact_name, contact_no FROM tbl_client_contacts WHERE id = ? LIMIT 1`,
    [reportingContactId]
  );
  if (!ct) logger.warn('Resolve receiver · contact not found · contactId=' + reportingContactId);
  if (!ct) return { ok: false, status: 404, message: `Contact ${reportingContactId} not found` };
  if (!ct.contact_no) logger.warn('Resolve receiver · no contact mobile · contactId=' + reportingContactId);
  if (!ct.contact_no) return { ok: false, status: 400, message: `Contact ${reportingContactId} has no mobile on file` };
  return { ok: true, receiverMobile: ct.contact_no, receiverName: ct.contact_name || null, receiverCustomerId: null, jobIdToStore: jobContextId || null, jobStatusSnapshot: null, jobEfrId: null };
}

// ─── POST /click-to-call ─────────────────────────────────────────────
router.post('/click-to-call', requireClickToCallAction, validate(clickToCallBody), async (req, res, next) => {
  try {
    const { jobId, customerId, efrId, reportingContactId, callFrom, callTo, useAlt, provider, jobContextId } = req.body;
    const agent = req.user;
    logger.info('Click-to-call request · jobId=' + (jobId ?? '—') + ' · customerId=' + (customerId ?? '—') + ' · efrId=' + (efrId ?? '—') + ' · contactId=' + (reportingContactId ?? '—') + ' · provider=' + (provider || 'default') + ' · useAlt=' + !!useAlt);

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
      logger.warn('Click-to-call rejected · custom numbers not allowed in this environment');
      return modernError(res, 400, 'Custom caller/receiver numbers are not allowed in this environment.');
    }
    if (isCustomNumberMode && (!callFrom || !callTo)) {
      logger.warn('Click-to-call rejected · QA mode requires both Call From and Call To');
      return modernError(res, 400, 'Both Call From and Call To are required in QA mode.');
    }

    // Agent mobile guard — only required when we're going to fall back to
    // it. In QA-prompt mode the FE-supplied callFrom takes the operator's
    // place, so an operator without a profile mobile can still place calls
    // in QA. Production / dev-env-override modes still require it.
    if (!isCustomNumberMode &&
        (!agent.mobile_no || String(agent.mobile_no).replace(/\D/g, '').length < 10)) {
      logger.warn('Click-to-call rejected · agent has no valid profile mobile');
      return modernError(res, 400, 'Your profile does not have a valid mobile number. Update your profile before placing calls.');
    }

    // ── Resolve receiver mobile + name + (optional) job context ──
    // Shared with POST /web-start via resolveReceiver() so the two paths can't
    // drift. FE never sends the customer mobile — always looked up server-side.
    const rr = await resolveReceiver({ jobId, customerId, efrId, reportingContactId, useAlt, jobContextId });
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
    logger.info('Call audit row inserted · row=' + jci + ' · provider=' + resolvedProvider);

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
        logger.warn('Click-to-call suppressed · row=' + jci + ' · provider=' + (callResult.provider || resolvedProvider));
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
      logger.warn('Click-to-call failed · row=' + jci + ' · diagnostic=' + (callResult.diagnostic || '—') + ' · providerStatus=' + (callResult.providerStatus ?? '—'));
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
        status: 'placed',
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
  logger.info('Get Plivo web credentials');
  if (voice.callMode() !== 'web') logger.warn('Web credentials denied · web calling not enabled');
  if (voice.callMode() !== 'web') return modernError(res, 409, 'Web calling is not enabled (voice.call.mode != web).');
  if (!plivo.callingEnabled()) logger.warn('Web credentials denied · Plivo not enabled');
  if (!plivo.callingEnabled()) return modernError(res, 409, 'Plivo is not enabled.');
  const token = plivo.webAccessToken({ operatorId: req.user.user_id });
  if (!token) logger.error('Web credentials failed · Plivo web calling not configured');
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
    logger.info('Web call start request · jobId=' + (req.body.jobId ?? '—') + ' · customerId=' + (req.body.customerId ?? '—') + ' · efrId=' + (req.body.efrId ?? '—') + ' · contactId=' + (req.body.reportingContactId ?? '—'));
    if (voice.callMode() !== 'web') logger.warn('Web call rejected · web calling not enabled');
    if (voice.callMode() !== 'web') return modernError(res, 409, 'Web calling is not enabled.');
    if (!plivo.callingEnabled()) logger.warn('Web call rejected · Plivo not enabled');
    if (!plivo.callingEnabled()) return modernError(res, 409, 'Plivo is not enabled.');

    const { jobId, customerId, efrId, reportingContactId, useAlt, jobContextId } = req.body;
    const agent = req.user;

    const rr = await resolveReceiver({ jobId, customerId, efrId, reportingContactId, useAlt, jobContextId });
    if (!rr.ok) return modernError(res, rr.status, rr.message);

    const receiver = plivo.normaliseIndianPhone(rr.receiverMobile);
    if (!receiver) logger.warn('Web call rejected · receiver is not a valid Indian mobile');
    if (!receiver) return modernError(res, 400, 'Receiver number is not a valid Indian mobile.');

    // QA SAFETY: in custom-number/QA mode the operator is PROMPTED for the number
    // to dial (the FE prefills it from PLIVO_CALL_TO) — we dial EXACTLY what they
    // supplied via callTo, NEVER the real customer. The audit/log row still
    // records the real intended customer. callTo is required in QA so a real
    // customer can't be reached even if the FE prompt is bypassed.
    let dialNumber = receiver;
    if (voice.customNumberMode('plivo')) {
      const supplied = plivo.normaliseIndianPhone(req.body.callTo);
      if (!supplied) logger.warn('Web call rejected · QA mode requires Call To');
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
    logger.info('Web call audit row inserted · row=' + jci);

    // Opaque, one-time id the browser dials; the answer route maps it → number.
    // In QA this is the TEST number; the audit row above kept the real customer.
    // teleprompterSessionId (optional) rides along so web-answer can fork the call
    // audio to STT for a guided teleprompter call (additive; null ⇒ normal call).
    const dialId = plivo.stashWebDial({ number: dialNumber, jci, teleprompterSessionId: req.body.teleprompterSessionId || null });

    // Dedicated Plivo call log (fail-soft) — for Plivo-only reconciliation.
    await plivoLog.record({
      job_caller_info_id: jci, job_id: rr.jobIdToStore, call_mode: 'web', call_flow: coarseFlow(req.body),
      caller_user_id: agent.user_id, caller_name: agent.user_name, receiver_name: rr.receiverName || null,
      receiver_number: receiver, dialed_number: dialNumber,
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
router.post('/mode', requirePropertyAllowlist(FEATURES.canSwitchCallMode, { label: 'Switch Call Mode' }), async (req, res, next) => {
  try {
    const mode = String(req.body.mode || '').toLowerCase();
    logger.info('Set calling mode · mode=' + (mode || '—'));
    if (mode !== 'web' && mode !== 'mobile') {
      logger.warn('Set calling mode rejected · invalid mode');
      return modernError(res, 400, "mode must be 'web' or 'mobile'.");
    }
    if (mode === 'web' && !plivo.callingEnabled()) {
      logger.warn('Set calling mode rejected · Plivo not enabled for web');
      return modernError(res, 409, 'Enable Plivo (plivo.calling.enabled=true) before switching to Web calling.');
    }
    await propertiesSvc.setProperty('voice.call.mode', mode);
    await propertiesSvc.flushCache();
    logger.info(`Calling mode set to '${mode}' by user #${req.user.user_id}`);
    return modernOk(res, { callMode: voice.callMode() });
  } catch (e) { next(e); }
});

// ─── POST /default-provider — set voice.default.provider (Admin Action) ──────
// Admin-only. Mobile mode lets the admin choose Plivo / Kaleyra / No Default
// (blank). Web mode is Plivo-only so the FE doesn't expose this there.
// '' (No Default) is stored blank → defaultProvider() then resolves to the first
// enabled provider and the per-call radio drives the choice when >1 is enabled.
router.post('/default-provider', requirePropertyAllowlist(FEATURES.canSwitchCallMode, { label: 'Switch Call Mode' }), async (req, res, next) => {
  try {
    const provider = String(req.body.provider ?? '').toLowerCase().trim();
    logger.info('Set default provider · provider=' + (provider || '(none)'));
    if (provider !== '' && provider !== 'plivo' && provider !== 'kaleyra') {
      logger.warn('Set default provider rejected · invalid provider');
      return modernError(res, 400, "provider must be 'plivo', 'kaleyra', or '' (No Default).");
    }
    await propertiesSvc.setProperty('voice.default.provider', provider);
    await propertiesSvc.flushCache();
    logger.info(`voice.default.provider set to '${provider || '(none)'}' by user #${req.user.user_id}`);
    return modernOk(res, { defaultProvider: voice.defaultProvider(), defaultProviderRaw: voice.rawDefaultProvider() });
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
    if (!id) logger.warn('Call status rejected · invalid call id');
    if (!id) return modernError(res, 400, 'invalid call id');
    logger.info('Get call status · row=' + id);

    const [[row]] = await pool.query(
      `SELECT job_caller_info AS id, caller_id, caller_status,
              start_time, end_time, duration, provider
         FROM tbl_job_caller_info
        WHERE job_caller_info = ?
        LIMIT 1`,
      [id]
    );
    if (!row) logger.warn('Call status · row not found · row=' + id);
    if (!row) return modernError(res, 404, 'call not found');

    // Authorize: the operator who placed it, or an Admin. role group is on the
    // parent router (role(['admin'])); the Admin role_id is 2. Anyone else may
    // only read their own call rows.
    const isOwner = row.caller_id != null && Number(row.caller_id) === Number(req.user.user_id);
    const isAdmin = Number(req.user.user_role) === 2; // role_id 2 = Admin (CLAUDE.md role model)
    if (!isOwner && !isAdmin) {
      logger.warn('Call status denied · not owner/admin · row=' + id);
      return modernError(res, 403, 'You can only view the status of calls you placed');
    }

    const status = row.caller_status || null;
    logger.info('Call status · row=' + id + ' · status=' + (status || '—') + ' · terminal=' + (status ? TERMINAL_STATUSES.has(status) : false));
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

// Column-presence probe for the transcription columns on tbl_plivo_call_log
// (EasyFix-owned). Cached; lets the store step no-op until the
// 2026-07-06-add-plivo-transcription migration runs.
let _hasTranscriptionCol = null;
async function hasTranscriptionColumn() {
  if (_hasTranscriptionCol !== null) return _hasTranscriptionCol;
  try {
    const [rows] = await pool.query("SHOW COLUMNS FROM tbl_plivo_call_log LIKE 'transcription'");
    _hasTranscriptionCol = rows.length > 0;
  } catch (_e) { _hasTranscriptionCol = false; }
  return _hasTranscriptionCol;
}

// Probe for the call-analysis columns on tbl_plivo_call_log (2026-07-06-add-
// call-analysis migration). Cached; the analysis route no-ops until it runs.
let _hasAnalysisCol = null;
async function hasAnalysisColumn() {
  if (_hasAnalysisCol !== null) return _hasAnalysisCol;
  try {
    const [rows] = await pool.query("SHOW COLUMNS FROM tbl_plivo_call_log LIKE 'call_analysis'");
    _hasAnalysisCol = rows.length > 0;
  } catch (_e) { _hasAnalysisCol = false; }
  return _hasAnalysisCol;
}

// Probe for the Transcribe Call Analytics metric columns on tbl_plivo_call_log
// (2026-07-06-add-call-metrics migration). Cached.
let _hasMetricsCol = null;
async function hasMetricsColumn() {
  if (_hasMetricsCol !== null) return _hasMetricsCol;
  try {
    const [rows] = await pool.query("SHOW COLUMNS FROM tbl_plivo_call_log LIKE 'call_metrics'");
    _hasMetricsCol = rows.length > 0;
  } catch (_e) { _hasMetricsCol = false; }
  return _hasMetricsCol;
}

// Best-effort: pull the Plivo transcription for a recording and store it on the
// call's tbl_plivo_call_log row for later quality analysis. Gated by
// plivo.transcription.enabled + column presence; NEVER throws + never blocks the
// caller (recording playback must not wait on transcription).
async function storeTranscriptionBestEffort({ jobCallerInfoId, recordingId }) {
  try {
    if (!recordingId || !plivo.transcriptionEnabled()) return;
    if (!(await hasTranscriptionColumn())) return;
    const tx = await plivo.fetchTranscription({ recordingId });
    if (tx.ok && tx.text) {
      await pool.query(
        `UPDATE tbl_plivo_call_log
            SET transcription = ?, transcription_status = 'completed', transcription_fetched_at = NOW()
          WHERE job_caller_info_id = ?`,
        [tx.text, jobCallerInfoId]
      );
      logger.info('Call transcription stored · jci=' + jobCallerInfoId);
    } else {
      await pool.query(
        "UPDATE tbl_plivo_call_log SET transcription_status = 'not_available' WHERE job_caller_info_id = ?",
        [jobCallerInfoId]
      );
    }
  } catch (e) {
    logger.warn('Transcription store failed · jci=' + jobCallerInfoId + ' · ' + e.message);
  }
}

// On-demand transcript fetch for the analysis view: if the 30-min backfill cron
// hasn't reached this call yet, pull its transcript NOW (transcript only — the
// recording DOWNLOAD stays lazy) so the first "View Analysis" isn't blocked on
// the cron cadence. Best-effort: returns the text or null, never throws, and
// persists the result on the row so the next open is a cache hit.
async function fetchTranscriptOnDemand({ jobCallerInfoId, callUuid, currentStatus }) {
  try {
    if (!callUuid || !plivo.transcriptionEnabled()) return null;
    const meta = await plivo.fetchRecordingMeta({ callUuid });
    if (!meta.ok || !meta.recordingId) return null;
    const tx = await plivo.fetchTranscription({ recordingId: meta.recordingId });
    if (tx.ok && tx.text) {
      await pool.query(
        "UPDATE tbl_plivo_call_log SET transcription = ?, transcription_status = 'completed', transcription_fetched_at = NOW() WHERE job_caller_info_id = ?",
        [tx.text, jobCallerInfoId]
      );
      return tx.text;
    }
    // No transcript yet. If we've never requested one, REQUEST it now (Plivo
    // doesn't auto-transcribe) and mark 'processing' — it'll be retrieved on the
    // next View Analysis or by the backfill cron. Recording download stays lazy.
    // Already 'processing' → wait; 'not_available' → terminal, don't re-request.
    if (tx.ok && !currentStatus) {
      const created = await plivo.createTranscription({ recordingId: meta.recordingId });
      const status = created.notEnabled ? 'not_available' : 'processing';
      await pool.query(
        "UPDATE tbl_plivo_call_log SET transcription_status = ?, transcription_fetched_at = NOW() WHERE job_caller_info_id = ?",
        [status, jobCallerInfoId]
      );
    }
    return null;
  } catch (e) {
    logger.warn('On-demand transcript fetch failed · jci=' + jobCallerInfoId + ' · ' + e.message);
    return null;
  }
}

// ─── GET /:id/recording — lazy Plivo→S3 call-recording play URL ────────
// On first play we fetch the recording from Plivo (by CallUUID), store it once
// on our S3 under a stable key, persist that key on the row, and return a
// short-lived presigned URL. Every later play is a cheap S3 cache hit (no Plivo
// round-trip), so we only ever spend S3 on recordings someone actually listens
// to. Recording must be enabled on the Plivo side (plivo.recording.enabled) and
// only exists for calls placed AFTER that was turned on.
router.get('/:id/recording', requireClickToCallAction, async (req, res, next) => {
  try {
    const s3 = require('../../utils/s3-storage');
    const id = parseRowId(req.params.id);
    if (!id) return modernError(res, 400, 'invalid call id');
    logger.info('Get call recording · row=' + id);

    const [[row]] = await pool.query(
      `SELECT job_caller_info AS id, caller_id, provider, unique_id, recording
         FROM tbl_job_caller_info WHERE job_caller_info = ? LIMIT 1`,
      [id]
    );
    if (!row) return modernError(res, 404, 'call not found');

    // Authorize: the operator who placed it, or an Admin (role_id 2). Same rule
    // as GET /:id/status.
    const isOwner = row.caller_id != null && Number(row.caller_id) === Number(req.user.user_id);
    const isAdmin = Number(req.user.user_role) === 2;
    if (!isOwner && !isAdmin) {
      return modernError(res, 403, 'You can only listen to recordings of calls you placed');
    }

    // A Kaleyra row stores an https:// recording URL directly — hand it back.
    if (row.recording && /^https?:\/\//i.test(String(row.recording))) {
      return modernOk(res, { url: row.recording, source: 'external' });
    }

    if (!s3.isEnabled()) {
      logger.warn('Call recording · S3 not configured · row=' + id);
      return modernError(res, 409, 'Recording storage is not configured in this environment.');
    }

    // Cache hit: our S3 key already persisted → just re-presign (never cache the
    // presigned URL itself — 5-min TTL).
    if (row.recording && String(row.recording).startsWith('CallRecordings/') && await s3.exists(row.recording)) {
      return modernOk(res, { url: await s3.getPresignedUrl(row.recording), source: 's3' });
    }

    // Cache miss. PREFER the callback-PUSHED recording URL (stored on
    // tbl_plivo_call_log by the <Dial recordingCallbackUrl> callback) — robust
    // for web/WebRTC calls where the recording is filed under a different leg
    // than the stored call_uuid, which is why the lazy call_uuid lookup below
    // returned nothing. Fall back to that lookup. Column-probed via try/catch
    // so a pre-migration deploy still works via the legacy path.
    let meta = null;
    try {
      const [[plog]] = await pool.query(
        'SELECT recording_url, recording_id FROM tbl_plivo_call_log WHERE job_caller_info_id = ? AND recording_url IS NOT NULL ORDER BY id DESC LIMIT 1',
        [id],
      );
      if (plog && plog.recording_url) meta = { ok: true, url: plog.recording_url, recordingId: plog.recording_id };
    } catch (_e) { /* pre-migration: recording_url column absent — fall through */ }

    if (!meta) {
      if (row.provider !== 'plivo' || !row.unique_id) {
        return modernError(res, 404, 'No recording available for this call');
      }
      meta = await plivo.fetchRecordingMeta({ callUuid: row.unique_id });
    }
    if (!meta.ok || !meta.url) {
      // Plivo can lag a few seconds after hangup, or recording was off.
      return modernError(res, 404, 'No recording available yet — if the call just ended, try again shortly.');
    }
    const dl = await plivo.downloadRecording(meta.url);
    if (!dl.ok || !dl.buffer) {
      return modernError(res, 502, 'Failed to fetch the recording from the provider.');
    }
    const key = s3.buildCallRecordingKey(id);
    await s3.putAtKey({ key, buffer: dl.buffer, contentType: dl.contentType || 'audio/mpeg' });
    await pool.query(
      'UPDATE tbl_job_caller_info SET recording = ? WHERE job_caller_info = ?',
      [key, id]
    );
    logger.info('Call recording cached to S3 · row=' + id + ' · key=' + key);
    // Best-effort background: also pull + store the transcription for later
    // quality analysis. Fire-and-forget so playback isn't delayed.
    void storeTranscriptionBestEffort({ jobCallerInfoId: id, recordingId: meta.recordingId });
    return modernOk(res, { url: await s3.getPresignedUrl(key), source: 's3', fetched: true });
  } catch (e) { next(e); }
});

// ─── GET /:id/analysis — LLM coaching analysis of the call transcript ──
// On-demand (Call Analytics → View Analysis): returns the cached analysis, else
// generates it from the stored transcript + caches it. Needs an OpenAI key + the
// transcription/analysis columns (2026-07-06 migrations); degrades gracefully.
router.get('/:id/analysis', requireClickToCallAction, async (req, res, next) => {
  try {
    const id = parseRowId(req.params.id);
    if (!id) return modernError(res, 400, 'invalid call id');
    // Transcription columns are the base surface; analysis (LLM) + metrics
    // (Transcribe) are each conditionally present per their own migration.
    if (!(await hasTranscriptionColumn())) {
      return modernOk(res, { status: 'unavailable', reason: 'Call analytics is not enabled in this environment.' });
    }
    const hasAnalysis = await hasAnalysisColumn();
    const hasMetrics = await hasMetricsColumn();
    const analysisCol = hasAnalysis ? 'call_analysis' : 'NULL AS call_analysis';
    const metricsSelect = hasMetrics ? ', call_metrics, call_metrics_status' : '';
    const [[row]] = await pool.query(
      `SELECT transcription, transcription_status, call_uuid, ${analysisCol}${metricsSelect}
         FROM tbl_plivo_call_log WHERE job_caller_info_id = ? ORDER BY id DESC LIMIT 1`,
      [id]
    );

    // Objective metrics (Transcribe Call Analytics), precomputed by the
    // call-metrics cron. Attached to EVERY response so the modal can show the
    // metrics half even when the LLM coaching half isn't ready.
    let metrics = null;
    if (hasMetrics && row && row.call_metrics) {
      try { metrics = JSON.parse(row.call_metrics); } catch (_e) { metrics = null; }
    }
    const metricsStatus = (hasMetrics && row) ? (row.call_metrics_status || null) : null;
    const withMetrics = (obj) => ({ ...obj, metrics, metricsStatus });

    if (!row) return modernOk(res, withMetrics({ status: 'no_transcript' }));
    // Cache hit — return the stored coaching (parse-guarded).
    if (row.call_analysis) {
      try { return modernOk(res, withMetrics({ status: 'ready', analysis: JSON.parse(row.call_analysis) })); }
      catch (_e) { /* corrupt cache — fall through + regenerate */ }
    }
    // No stored transcript yet — try to fetch it on-demand (transcript only;
    // the recording download stays lazy) before giving up, so the cron's 30-min
    // cadence doesn't block the first View Analysis for this call.
    if ((!row.transcription || String(row.transcription).trim().length < 10) && row.call_uuid) {
      const fetched = await fetchTranscriptOnDemand({ jobCallerInfoId: id, callUuid: row.call_uuid, currentStatus: row.transcription_status });
      if (fetched) row.transcription = fetched;
    }
    if (!row.transcription || String(row.transcription).trim().length < 10) {
      return modernOk(res, withMetrics({ status: 'no_transcript' }));
    }
    if (!callAnalysis.llmEnabled()) {
      return modernOk(res, withMetrics({ status: 'llm_disabled', reason: 'Call-analysis AI is not configured in this environment.' }));
    }
    logger.info('Generate call analysis · row=' + id);
    const analysis = await callAnalysis.analyzeTranscript(row.transcription);
    if (!analysis) {
      if (hasAnalysis) await pool.query("UPDATE tbl_plivo_call_log SET call_analysis_status = 'failed' WHERE job_caller_info_id = ?", [id]);
      return modernOk(res, withMetrics({ status: 'failed', reason: 'Analysis could not be generated.' }));
    }
    if (hasAnalysis) {
      await pool.query(
        "UPDATE tbl_plivo_call_log SET call_analysis = ?, call_analysis_status = 'ready', call_analysis_generated_at = NOW() WHERE job_caller_info_id = ?",
        [JSON.stringify(analysis), id]
      );
    }
    return modernOk(res, withMetrics({ status: 'ready', analysis }));
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
    if (!id) logger.warn('Hangup rejected · invalid call id');
    if (!id) return modernError(res, 400, 'invalid call id');
    logger.info('Hangup call · row=' + id);

    const [[row]] = await pool.query(
      `SELECT job_caller_info AS id, caller_id, provider, unique_id, caller_status
         FROM tbl_job_caller_info
        WHERE job_caller_info = ?
        LIMIT 1`,
      [id]
    );
    if (!row) logger.warn('Hangup · row not found · row=' + id);
    if (!row) return modernError(res, 404, 'call not found');

    const isOwner = row.caller_id != null && Number(row.caller_id) === Number(req.user.user_id);
    const isAdmin = Number(req.user.user_role) === 2; // role_id 2 = Admin (CLAUDE.md role model)
    if (!isOwner && !isAdmin) {
      logger.warn('Hangup denied · not owner/admin · row=' + id);
      return modernError(res, 403, 'You can only hang up calls you placed');
    }

    // Already finished → idempotent success (the FE poll will reflect the real
    // terminal state anyway).
    const status = row.caller_status || null;
    if (status && TERMINAL_STATUSES.has(status)) {
      logger.info('Hangup no-op · already ended · row=' + id + ' · status=' + status);
      return modernOk(res, { success: true, alreadyEnded: true });
    }
    // Before a provider callback lands, `unique_id` is the call-request handle
    // (Plivo request_uuid), NOT the CallUUID the hangup API needs — firing
    // DELETE with it would 404. Refuse gracefully until ring/answer captures the
    // CallUUID. The FE surfaces this 409 inline; the operator retries in a beat.
    if (!status || status === 'initiated' || status === 'placed') {
      logger.warn('Hangup deferred · still connecting · row=' + id + ' · status=' + (status || '—'));
      return modernError(res, 409, 'Call is still connecting — please try hangup again in a moment.');
    }

    const r = await voice.hangup({ provider: row.provider, callUuid: row.unique_id });
    if (r.unsupported) {
      logger.warn('Hangup unsupported · row=' + id + ' · provider=' + row.provider);
      return modernError(res, 409, 'Provider does not support hangup');
    }
    if (!r.ok) {
      logger.warn('Hangup failed · row=' + id + ' · ' + (r.error || 'provider error'));
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

// Last-10-digits key for phone-number comparison — strips +91 / spaces /
// punctuation so the legacy-formatted `caller`/`reciever` columns compare
// cleanly against a job's stored party numbers. Empty string when < 10 digits.
function last10(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}

/*
 * resolveJobParties — for a single job, return every known counterparty the
 * operator might have called, keyed by last-10-digits, so a job-scoped call
 * list can label each row with WHO the call was with (Customer / Alternate /
 * Client SPOC / Technician). All numbers live on tbl_job (+ two joins), so
 * this is a single query. Priority order matters: the classifier keeps the
 * FIRST role a number matches, so Customer wins over a duplicate Alternate.
 */
async function resolveJobParties(jobId) {
  const [[j]] = await pool.query(
    `SELECT cu.customer_mob_no,
            COALESCE(j.job_customer_name, cu.customer_name) AS customer_name,
            j.additional_number, j.additional_name,
            j.client_spoc, j.client_spoc_name,
            ef.efr_no   AS technician_mob,
            ef.efr_name AS technician_name
       FROM tbl_job j
       LEFT JOIN tbl_customer  cu ON cu.customer_id = j.fk_customer_id
       LEFT JOIN tbl_easyfixer ef ON ef.efr_id      = j.fk_easyfixter_id
      WHERE j.job_id = ? LIMIT 1`,
    [jobId]
  );
  if (!j) return [];
  const parties = [];
  const push = (num, role, name) => {
    const d = last10(num);
    if (d) parties.push({ digits: d, role, name: name || null });
  };
  push(j.customer_mob_no,   'Customer',    j.customer_name);
  push(j.additional_number, 'Alternate',   j.additional_name || j.customer_name);
  push(j.client_spoc,       'Client SPOC', j.client_spoc_name);
  push(j.technician_mob,    'Technician',  j.technician_name);
  return parties;
}

// ─── GET / — paginated call history ───────────────────────────────────
router.get('/', validate(callListQuery, 'query'), async (req, res, next) => {
  try {
    const { jobId, customerId, dateFrom, dateTo, mobile, flow, callerId, minScore, page, limit } = req.query;
    const hasAnalysisFilter = /^(true|1)$/i.test(String(req.query.hasAnalysis || ''));
    logger.info('List call history · jobId=' + (jobId ?? '—') + ' · customerId=' + (customerId ?? '—') + ' · mobile=' + (mobile ? '***' : '—') + ' · flow=' + (flow || '—') + ' · callerId=' + (callerId ?? '—') + ' · from=' + (dateFrom || '—') + ' · to=' + (dateTo || '—') + ' · page=' + page + ' · limit=' + limit);
    const where = [];
    const params = [];
    if (jobId)      { where.push('jci.job_id = ?');      params.push(jobId); }
    if (customerId) { where.push('jci.reciever_id = ?'); params.push(customerId); }
    if (dateFrom)   { where.push('jci.inserted_time >= ?'); params.push(dateFrom); }
    if (dateTo)     { where.push('jci.inserted_time < ?');  params.push(dateTo); }
    // Number scope: match the last 10 digits against EITHER call leg (outbound
    // → reciever = customer; inbound → caller = customer), robust to the +91 /
    // space formatting variations stored in the legacy columns. Combined with
    // jobId this yields exactly "calls on THIS number for THIS job" and, by
    // construction, excludes calls on the same number for other jobs.
    if (mobile) {
      const digits = String(mobile).replace(/\D/g, '').slice(-10);
      if (digits.length === 10) {
        where.push("(RIGHT(REPLACE(REPLACE(jci.reciever, '+', ''), ' ', ''), 10) = ? OR RIGHT(REPLACE(REPLACE(jci.caller, '+', ''), ' ', ''), 10) = ?)");
        params.push(digits, digits);
      }
    }
    // Unified Call Analysis filters (all additive; call_flow is always present,
    // the analysis-based ones are guarded on the column existing).
    const hasTx = await hasTranscriptionColumn();
    const hasAna = await hasAnalysisColumn();
    if (flow)     { where.push('pcl.call_flow = ?');   params.push(flow); }
    if (callerId) { where.push('jci.caller_id = ?');   params.push(callerId); }
    if (hasAna && hasAnalysisFilter) where.push('pcl.call_analysis IS NOT NULL');
    if (hasAna && minScore) {
      where.push("CAST(JSON_UNQUOTE(JSON_EXTRACT(pcl.call_analysis, '$.overall_score')) AS UNSIGNED) >= ?");
      params.push(minScore);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (page - 1) * limit;

    // Call Analytics is Plivo-only: transcription + coaching analysis live in
    // tbl_plivo_call_log, so this list shows ONLY calls that have a Plivo log
    // row — the "relevant" set — not every row in the ~940k-row shared
    // caller-info audit table (dominated by null/legacy-provider rows). INNER
    // JOIN restricts BOTH the count and the page to those; 1:1 with the call via
    // job_caller_info_id. transcription_status is selected only when the
    // 2026-07-06 migration added the column (guarded for pre-migration envs).
    const txSelect = hasTx ? ',\n              pcl.transcription_status' : '';
    // Flow (always present) + coaching score (extracted from the cached analysis
    // JSON so the big blob isn't shipped per row) for the unified Call Analysis list.
    const flowSelect = ',\n              pcl.call_flow';
    const anaSelect = hasAna
      ? ",\n              pcl.call_analysis_status,\n              JSON_UNQUOTE(JSON_EXTRACT(pcl.call_analysis, '$.overall_score')) AS score"
      : '';
    const plivoJoin = 'JOIN tbl_plivo_call_log pcl ON pcl.job_caller_info_id = jci.job_caller_info';

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM tbl_job_caller_info jci ${plivoJoin} ${whereSql}`,
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
              jci.is_updated${txSelect}${flowSelect}${anaSelect}
         FROM tbl_job_caller_info jci
         ${plivoJoin}
         ${whereSql}
         ORDER BY jci.inserted_time DESC
         LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    // When scoped to ONE job, label each row with the party the operator was
    // on the call with. The counterparty is the non-operator leg: reciever on
    // OUT calls (operator dialled out), caller on IN calls. We match its last-10
    // digits against the job's known numbers so the UI can show "Customer" /
    // "Client SPOC" / "Technician" instead of a bare number. Falls back to the
    // name stamped on the row at call time, then 'Other' for anything unmatched
    // (e.g. a number that has since changed on the job).
    if (jobId && rows.length) {
      const byDigits = new Map();
      for (const p of await resolveJobParties(jobId)) {
        if (p.digits && !byDigits.has(p.digits)) byDigits.set(p.digits, p);
      }
      for (const r of rows) {
        const isOut = String(r.call_type || '').toUpperCase() === 'OUT';
        const counterparty = isOut ? r.receiver : r.caller;
        const hit = byDigits.get(last10(counterparty));
        r.party_role = hit ? hit.role : 'Other';
        r.party_name = hit ? hit.name : (isOut ? r.receiver_name : r.caller_name) || null;
      }
    }

    logger.info('Returning ' + rows.length + ' call history rows · total=' + total);
    return modernOk(res, { total, page, limit, items: rows });
  } catch (e) { next(e); }
});

// ─── GET /scorecard — per-caller (ops agent) coaching-score rollup ─────
// "Who is improving, who is not." Reads the pre-aggregated tbl_caller_score_rollup
// (refreshed after each analysed call). Same permission as View Analysis.
router.get('/scorecard', requireClickToCallAction, async (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
    const items = await callerScorecard.list({ limit, offset });
    return modernOk(res, { items });
  } catch (e) { next(e); }
});

module.exports = router;
