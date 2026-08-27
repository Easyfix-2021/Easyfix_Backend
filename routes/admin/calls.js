const router = require('express').Router();
const { pool } = require('../../db');
const logger = require('../../logger');
const validate = require('../../middleware/validate');
const { modernOk, modernError } = require('../../utils/response');
const { assertEntityInScope } = require('../../lib/scope');
const kaleyra = require('../../services/kaleyra.service');
const plivo = require('../../services/plivo.service');
const voice = require('../../services/voice.service');
const plivoLog = require('../../services/plivo-call-log.service');
const conference = require('../../services/plivo-conference.service');
const recordingBackfill = require('../../services/recording-backfill.service');
// The route layer talks ONLY to the mode service: it owns the transcript-vs-
// recording branch, the provider clients behind each, and the provenance stamp.
const analysisMode = require('../../services/call-analysis-mode.service');
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
  // Both SPOC shapes report the same flow — analytics cares that the operator
  // called a client contact, not which table the number was read from.
  if (body.reportingContactId) return 'spoc';
  if (body.spocJobId) return 'spoc';
  return null;
}
const { getEffectivePermissions } = require('../../services/role.service');
const { clickToCallBody, callListQuery, webCallFailedBody } = require('../../validators/calls.validator');

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
    const { jobId, customerId, efrId, reportingContactId, spocJobId, useAlt, provider } = req.query;
    logger.info('Preview call legs · jobId=' + (jobId ?? '—') + ' · customerId=' + (customerId ?? '—') + ' · efrId=' + (efrId ?? '—') + ' · contactId=' + (reportingContactId ?? '—') + ' · spocJobId=' + (spocJobId ?? '—') + ' · provider=' + (provider || 'default'));
    // Boolean coercion — query strings carry primitives as strings.
    // Accept '1' or 'true' (case-insensitive) so callers don't have to
    // remember which truthy shape we expect.
    const useAltFlag = String(useAlt || '').toLowerCase() === 'true' || String(useAlt) === '1';
    if (!jobId && !customerId && !efrId && !reportingContactId && !spocJobId) {
      logger.warn('Preview rejected · no receiver identifier supplied');
      return modernError(res, 400, 'one of jobId/customerId/efrId/reportingContactId/spocJobId is required');
    }

    /*
     * Resolve the receiver through resolveReceiver — the SAME function both
     * POST handlers use.
     *
     * This used to be a second, hand-maintained copy of all five lookups,
     * with a comment asking the next editor to "change both". That contract
     * failed exactly as such contracts do: when the efrId branch gained an
     * RBAC city-scope check on 2026-08-21, the copy here did not, and
     * GET /preview quietly became the remaining way for a city-scoped user to
     * confirm that a technician in someone else's region exists — 404 versus
     * 200 is an existence oracle even though the number itself comes back
     * masked.
     *
     * One code path removes the leak and the class of bug that produced it.
     *
     * TWO ERROR SHAPES, DELIBERATELY TREATED DIFFERENTLY:
     *
     *   404 (not found / out of scope) — surfaced unchanged. resolveReceiver's
     *   messages are already byte-identical to the ones this route used, so
     *   nothing observable moves.
     *
     *   400 ("has no mobile on file") — swallowed, and the preview renders
     *   with an empty receiver, which is what it did before. That is not
     *   laziness: the preview's job is to show what WOULD be dialled, and a
     *   dialog that refuses to open teaches the operator nothing about why.
     *   The POST still refuses the call, so nobody dials a blank number.
     */
    const rr = await resolveReceiver(req, {
      jobId, customerId, efrId, reportingContactId, spocJobId, useAlt: useAltFlag,
    });
    if (!rr.ok && rr.status !== 400) return modernError(res, rr.status, rr.message);
    const receiverReal = rr.ok ? rr.receiverMobile : null;

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
//
// `req` is taken so the efrId branch can run the RBAC city-scope check.
// Both call sites already have it; passing it beats reaching for a global.
async function resolveReceiver(req, { jobId, customerId, efrId, reportingContactId, spocJobId, useAlt, jobContextId }) {
  logger.info('Resolve call receiver · jobId=' + (jobId ?? '—') + ' · customerId=' + (customerId ?? '—') + ' · efrId=' + (efrId ?? '—') + ' · contactId=' + (reportingContactId ?? '—') + ' · spocJobId=' + (spocJobId ?? '—') + ' · useAlt=' + !!useAlt);
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
  if (spocJobId) {
    const [[job]] = await pool.query(
      `SELECT job_id, job_status, fk_easyfixter_id, client_spoc, client_spoc_name
         FROM tbl_job WHERE job_id = ? LIMIT 1`,
      [spocJobId]
    );
    if (!job) logger.warn('Resolve receiver · job not found · spocJobId=' + spocJobId);
    if (!job) return { ok: false, status: 404, message: `Job ${spocJobId} not found` };
    if (!job.client_spoc) logger.warn('Resolve receiver · no client SPOC mobile · spocJobId=' + spocJobId);
    if (!job.client_spoc) return { ok: false, status: 400, message: `Job ${spocJobId} has no client SPOC mobile on file` };
    // receiverCustomerId stays NULL even though we know the job's customer:
    // reciever_id holds a CUSTOMER id (GET / filters `customerId` straight onto
    // it), and a client SPOC is not the customer — stamping it would surface
    // this call under the customer's history. Matches the efr/contact paths.
    // jobIdToStore is the job itself (jobContextId is ignored here, as on the
    // jobId path): the SPOC is reached THROUGH a job, so the call belongs to
    // that job's history, where resolveJobParties already labels a
    // client_spoc-matching leg as 'Client SPOC'.
    return {
      ok: true,
      receiverMobile: job.client_spoc,
      receiverName: job.client_spoc_name || null,
      receiverCustomerId: null,
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
      `SELECT efr_id, efr_first_name, efr_last_name, efr_no, efr_cityId FROM tbl_easyfixer WHERE efr_id = ? AND NOT (tbl_easyfixer.efr_status <=> 3) LIMIT 1`,
      [efrId]
    );
    if (!efr) logger.warn('Resolve receiver · easyfixer not found · efrId=' + efrId);
    if (!efr) return { ok: false, status: 404, message: `Easyfixer ${efrId} not found` };
    // RBAC city scope. Until 2026-08-21 ANY efrId resolved for ANY admin-group
    // caller, so a city-scoped user could dial — and, via the audit row, learn
    // the name of — a technician in someone else's region by guessing an id.
    // 404 with the SAME message as "not found", never 403: the two answers must
    // be indistinguishable or the response itself confirms the id exists. This
    // is the convention lib/scope.js documents and routes/admin/easyfixers.js
    // follows on every per-row route.
    const guard = assertEntityInScope(req, { city_id: efr.efr_cityId });
    if (!guard.ok) logger.warn('Resolve receiver · easyfixer out of scope · efrId=' + efrId + ' · ' + guard.reason);
    if (!guard.ok) return { ok: false, status: 404, message: `Easyfixer ${efrId} not found` };
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
    const { jobId, customerId, efrId, reportingContactId, spocJobId, callFrom, callTo, useAlt, provider, jobContextId } = req.body;
    const agent = req.user;
    logger.info('Click-to-call request · jobId=' + (jobId ?? '—') + ' · customerId=' + (customerId ?? '—') + ' · efrId=' + (efrId ?? '—') + ' · contactId=' + (reportingContactId ?? '—') + ' · spocJobId=' + (spocJobId ?? '—') + ' · provider=' + (provider || 'default') + ' · useAlt=' + !!useAlt);

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
    const rr = await resolveReceiver(req, { jobId, customerId, efrId, reportingContactId, spocJobId, useAlt, jobContextId });
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

    /*
     * ── EVERY PLIVO CALL STARTS AS A ONE-PARTICIPANT CONFERENCE ──────────────
     *
     * Ops sees no difference: they click Call, it rings, they talk. But because
     * the operator's leg is already a Multi-Party Call participant, a second or
     * third person can be added MID-CALL. Plivo has no API to promote a live
     * <Dial> into a conference, so a call that does not start this way can never
     * gain one — the only recovery is hang up and redial, which is exactly the
     * experience this feature exists to remove.
     *
     * Cost is unchanged: the same two legs (operator + receiver) as the classic
     * bridge, so the same per-minute billing and the same concurrency slots.
     *
     * DB-only — createConference never calls Plivo. The room does not exist
     * until the operator's answer XML joins it, which is why the friendly name
     * has to be minted here, before the call is placed.
     *
     * FAIL-SOFT, DELIBERATELY. If the conference cannot be created (Plivo
     * disabled, concurrency ceiling, DB error) the call still goes out on the
     * classic <Dial> bridge. Ops loses the ability to add a participant to THAT
     * call; they do not lose the call. Kaleyra has no live surface at all, so it
     * never takes this path.
     */
    /*
     * Which ROLE the receiver plays, derived from the identifier the caller
     * supplied — resolveReceiver returns digits and a name but not a kind, and
     * widening it would touch the web-call path that shares it. The participant
     * row records this so the panel can label the leg ("technician", not just a
     * number) and so an audit reads as people rather than digits.
     */
    const receiverKind = efrId ? 'technician'
      : reportingContactId ? 'client_contact'
      : spocJobId ? 'job_spoc'
      : (jobId && useAlt) ? 'customer_alt'
      : 'customer';

    let conferenceId = null;
    let conferenceName = null;
    if (resolvedProvider === 'plivo' && conference.conferenceEnabled()) {
      const conf = await conference.createConference({
        jobId: jobIdToStore,
        startedByUserId: agent.user_id,
        jobCallerInfoId: jci,
        jobStatusSnap: jobStatusSnapshot,
        jobEfrIdSnap: jobEfrId,
        operatorNumber: dialFrom,
        operatorName: agent.user_name,
      }, pool);
      if (conf.ok) {
        conferenceId = conf.conferenceId;
        conferenceName = conf.friendlyName;
        logger.info('Conference created · row=' + jci + ' · confId=' + conferenceId + ' · name=' + conferenceName);
      } else {
        logger.warn('Conference NOT created · row=' + jci + ' · ' + conf.code + ' · ' + conf.message
          + ' — falling back to the classic bridge (this call cannot gain participants)');
      }
    }

    // ── Place the call via the provider factory ──
    // voice.clickToCall resolves the provider, stamps it on the result, and
    // (for Plivo) signs jobCallerInfoId into the callback token so the
    // webhooks can find this exact row. When a conference was minted above, its
    // name rides the same token and the answer XML joins the MPC instead of
    // dialling — see routes/public/plivo-answer.js.
    const callResult = await voice.clickToCall({
      provider,
      from: dialFrom,
      to:   dialTo,
      jobCallerInfoId: jci,
      conferenceName,
      conferenceId,
      receiverKind,
      receiverName,
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
        recording_requested: plivo.recordingEnabled() ? 1 : 0,
      });
    }

    logger.info(`Click-to-call placed · agent=${agent.user_name}(#${agent.user_id}) → ${receiverName || receiverCustomerId || 'customer'} · row=${jci} · provider=${callResult.provider} · uniqueId=${callResult.callId || '—'}`);
    return modernOk(res, {
      delivered: true,
      jobCallerInfoId: jci,
      callId: callResult.callId || null,
      provider: callResult.provider,
      // The conference this leg joined, or null when it fell back to the classic
      // bridge. The FE opens the participant section on this — a null means the
      // call works but cannot gain participants, which is worth showing.
      conferenceId,
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

/*
 * Warn below this much Plivo credit. Deliberately not zero: at zero the calls
 * are already failing, and the point of the banner is to arrive BEFORE that.
 * A minute of Indian voice is cents, so single digits is roughly "today".
 * Tune with PLIVO_LOW_BALANCE_WARN without a deploy.
 */
const LOW_BALANCE_WARN = Number(process.env.PLIVO_LOW_BALANCE_WARN || 5);

// ─── GET /web-credentials — Plivo Browser SDK login (Web Call mode) ────
// Returns a PER-OPERATOR, short-lived Plivo access token (no shared endpoint
// password crosses the wire) + the caller-id the browser dials. The SDK logs in
// via client.loginWithAccessToken(). Gated by the click-to-call permission;
// served ONLY when Web mode is on, Plivo is enabled, and the endpoint is set.
router.get('/web-credentials', requireClickToCallAction, async (req, res) => {
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
  /*
   * PLIVO_WEB_APP_ID IS NOT VALIDATED ABOVE, AND ITS ABSENCE IS INVISIBLE.
   *
   * webAccessToken() sets the token's `app` claim only when this env var is
   * present, and simply omits it when it is not. So an unset value produces a
   * perfectly valid token, a successful SDK login, and then EVERY outgoing call
   * failing at signalling — because Plivo has no Voice Application to route the
   * browser leg to, and therefore never fetches our /web-answer URL. From the
   * server's side that is indistinguishable from silence: no request, no log,
   * nothing to debug against.
   *
   * Reported, NOT enforced. A hard 500 here would take web calling down in any
   * environment that works today by way of an application assigned to the
   * endpoint itself rather than pinned on the token — which is a legitimate
   * Plivo setup. So: ERROR in the logs, and a `warnings` array on the payload so
   * the operator's own screen can say what is missing instead of showing "Busy".
   */
  const warnings = [];
  if (!(process.env.PLIVO_WEB_APP_ID || '').trim()) {
    warnings.push('PLIVO_WEB_APP_ID is not set — the access token carries no `app` claim, so Plivo '
      + 'has no Voice Application to route the browser leg to. Outgoing calls typically fail as '
      + '"Busy" and /api/public/plivo/web-answer is never called.');
  }
  if (!(process.env.PLIVO_CALLER_ID || '').trim()) {
    warnings.push('PLIVO_CALLER_ID is not set — the browser has no destination to dial.');
  }
  /*
   * Read the env directly rather than calling plivo.callbackBase(): that helper
   * exists but is NOT exported, so `plivo.callbackBase()` would throw a
   * TypeError and take this endpoint — and with it all web calling — down
   * completely. Worth recording because `no-undef` does NOT catch this: a
   * property access on an imported object is valid to the linter, and only
   * executing the line finds it. Same lesson as the 500 that started this.
   */
  if (!(process.env.PLIVO_CALLBACK_BASE_URL || process.env.PUBLIC_API_BASE_URL || '').trim()) {
    warnings.push('PLIVO_CALLBACK_BASE_URL / PUBLIC_API_BASE_URL is not set — Plivo cannot reach '
      + 'our callbacks even once the application routes the call.');
  }
  /*
   * BALANCE, not just configuration.
   *
   * An out-of-credit Plivo account produces the SAME symptom as a missing
   * PLIVO_WEB_APP_ID and gives the operator even less to go on: the API accepts
   * the call, the conference is created, our audit row is written, /web-start
   * returns 200 in 29ms, and the browser leg dies at signalling with "Busy".
   * Every log line is green. That is what blocked calling on production on
   * 2026-08-27, and the only way anyone found out was by checking the Plivo
   * console by hand.
   *
   * Reported through the same array the panel already renders, so no new UI
   * path — and reported as its OWN sentence, because "top up the account" and
   * "set an environment variable" go to different people.
   *
   * Only when we actually KNOW. accountBalanceCached() returns ok:false for an
   * unreachable or unparseable billing response, and that produces no warning:
   * not knowing the balance is not the same as knowing it is low, and a banner
   * that cries wolf is one operators learn to scroll past.
   */
  try {
    const balance = await plivo.accountBalanceCached();
    if (balance.ok && balance.cashCredits <= LOW_BALANCE_WARN && !balance.autoRecharge) {
      warnings.push(
        `Plivo account credit is ${balance.cashCredits.toFixed(2)} — outgoing calls fail as `
        + '"Busy" once it runs out, with no error anywhere. Top up the Plivo account.',
      );
    }
  } catch (e) {
    // Never let a billing lookup break the credentials the panel needs to log in.
    logger.warn('Plivo balance check skipped · ' + e.message);
  }

  for (const w of warnings) logger.error('Web calling misconfigured · ' + w);

  return modernOk(res, {
    token,
    callerId: process.env.PLIVO_CALLER_ID || null,
    // Empty on a healthy environment. Non-empty means the browser will get a
    // token it can log in with and calls that cannot complete.
    warnings,
  });
});

/* ─── GET /web-diagnostics — ask PLIVO what it thinks our setup is ────────
 *
 * ⚠ ON-DEMAND ONLY. This makes live provider calls; nothing polls it.
 *
 * WHY THIS EXISTS. Web calling failed for days with the browser SDK reporting
 * "Busy" and our server logging NOTHING — because when Plivo cannot route the
 * browser leg to a Voice Application it never fetches our answer URL, so there
 * is no request to log. Every check we owned came back clean: the token was
 * issued, the env vars were set, `warnings` was empty. All of which is true and
 * none of which is the question. The question is what PLIVO has stored, and the
 * only honest way to answer it is to ask Plivo.
 *
 * `warnings` on /web-credentials can only tell you a variable is UNSET. It
 * cannot tell you the app id is set to an application that was deleted, or
 * disabled, or whose Answer URL still points at last quarter's host. Those look
 * identical from here and are the failures that survive a config review.
 *
 * Reports, never enforces, and never throws: this is the endpoint you open when
 * calling is already broken, so it must not be capable of breaking anything.
 * Secrets stay out of the response — an answer URL and an app name are
 * configuration, not credentials, and the auth token is never echoed.
 */
router.get('/web-diagnostics', requireClickToCallAction, async (req, res) => {
  logger.info('Plivo web diagnostics requested · by=' + req.user.user_id);
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  const authId = (process.env.PLIVO_AUTH_ID || '').trim();
  const authToken = (process.env.PLIVO_AUTH_TOKEN || '').trim();
  const appId = (process.env.PLIVO_WEB_APP_ID || '').trim();
  const endpointUser = (process.env.PLIVO_ENDPOINT_USERNAME || '').trim();
  const base = (process.env.PLIVO_CALLBACK_BASE_URL || process.env.PUBLIC_API_BASE_URL || '').replace(/\/+$/, '');
  const expectedAnswerUrl = base ? `${base}/api/public/plivo/web-answer` : null;

  if (!authId || !authToken) {
    add('Plivo credentials', false, 'PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN are not set — nothing else can be checked.');
    return modernOk(res, { checks, expectedAnswerUrl });
  }

  const auth = 'Basic ' + Buffer.from(`${authId}:${authToken}`).toString('base64');
  const get = async (path) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(`https://api.plivo.com/v1/Account/${encodeURIComponent(authId)}${path}`,
        { method: 'GET', headers: { Authorization: auth }, signal: ctrl.signal });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* non-JSON body */ }
      return { httpStatus: r.status, ok: r.status >= 200 && r.status < 300, json, text };
    } catch (e) {
      return { httpStatus: 0, ok: false, json: null, text: String(e && e.message) };
    } finally { clearTimeout(t); }
  };

  // ── The application the browser token pins the call to.
  let appAnswerUrl = null;
  if (!appId) {
    add('PLIVO_WEB_APP_ID', false,
      'Not set. The access token carries no `app` claim, so Plivo has no Voice Application '
      + 'to route the browser leg to and never calls our answer URL.');
  } else {
    const r = await get(`/Application/${encodeURIComponent(appId)}/`);
    if (r.httpStatus === 404) {
      add('Voice Application', false, `Plivo has no application with id ${appId}. PLIVO_WEB_APP_ID points at something that does not exist.`);
    } else if (!r.ok) {
      add('Voice Application', false, `Could not read application ${appId} from Plivo (http=${r.httpStatus}).`);
    } else {
      const a = r.json || {};
      appAnswerUrl = a.answer_url || null;
      add('Voice Application', true, `"${a.app_name || '(unnamed)'}" (${appId})`);
      // `enabled` is a real field and a disabled app routes nothing.
      if (a.enabled === false) add('Application enabled', false, 'This application is DISABLED in Plivo.');
      if (!appAnswerUrl) {
        add('Answer URL', false, 'This application has NO answer URL, so Plivo has nothing to fetch when the browser leg connects.');
      } else if (expectedAnswerUrl && appAnswerUrl.replace(/\/+$/, '') !== expectedAnswerUrl) {
        add('Answer URL', false,
          `Plivo will fetch ${appAnswerUrl} — this server expects ${expectedAnswerUrl}. `
          + 'A call routed to a different host will never reach our conference code.');
      } else {
        add('Answer URL', true, appAnswerUrl + (a.answer_method ? ` (${a.answer_method})` : ''));
      }
      if (!a.hangup_url) {
        add('Hangup URL', false, 'Not set — a leg that dies at Plivo is never reported back, so its row stays open until the reaper.');
      }
    }
  }

  // ── The endpoint the browser logs in as, and which application it carries.
  if (!endpointUser) {
    add('PLIVO_ENDPOINT_USERNAME', false, 'Not set — no browser endpoint to log in as.');
  } else {
    const r = await get('/Endpoint/');
    const list = (r.json && (Array.isArray(r.json.objects) ? r.json.objects : [])) || [];
    if (!r.ok) {
      add('Browser endpoint', false, `Could not list endpoints from Plivo (http=${r.httpStatus}).`);
    } else {
      const mine = list.find((e) => String(e.username || '') === endpointUser);
      if (!mine) {
        add('Browser endpoint', false,
          `No endpoint named "${endpointUser}" on this account (${list.length} exist). Note Plivo APPENDS a `
          + '12-digit suffix at creation — PLIVO_ENDPOINT_USERNAME must be the full generated username.');
      } else {
        add('Browser endpoint', true, `"${endpointUser}" exists.`);
        /*
         * An endpoint carries its OWN application, and it is the fallback when
         * the token pins none. Reporting a disagreement matters: an endpoint
         * pointing at a different app than PLIVO_WEB_APP_ID is a setup that
         * works until someone edits the app they think is in use.
         */
        const attached = String(mine.application || '');
        if (!attached) {
          add('Endpoint application', false, 'No application attached to this endpoint — routing depends entirely on the token\'s `app` claim.');
        } else if (appId && !attached.includes(appId)) {
          add('Endpoint application', false, `The endpoint is attached to ${attached}, which is NOT PLIVO_WEB_APP_ID (${appId}).`);
        } else {
          add('Endpoint application', true, attached);
        }
      }
    }
  }

  if (!base) {
    add('Callback base', false, 'PLIVO_CALLBACK_BASE_URL / PUBLIC_API_BASE_URL is not set — conference status callbacks are disabled.');
  }

  const failing = checks.filter((c) => !c.ok);
  for (const c of failing) logger.error(`Plivo web diagnostics · ${c.name} · ${c.detail}`);
  logger.info(`Plivo web diagnostics · ${checks.length - failing.length}/${checks.length} checks passed`);
  return modernOk(res, { checks, expectedAnswerUrl, healthy: failing.length === 0 });
});

// ─── POST /web-start — begin a Web (browser WebRTC) call ───────────────
// Web mode: the operator's browser IS the first leg. We resolve the receiver
// server-side (masking preserved — the real number NEVER reaches the browser),
// insert the audit row, and return an OPAQUE one-time dialId. The FE calls
// client.call(dialId); /api/public/plivo/web-answer resolves the id → real
// number and bridges. Reuses resolveReceiver() so it can't drift from /click-to-call.
router.post('/web-start', requireClickToCallAction, validate(clickToCallBody), async (req, res, next) => {
  try {
    logger.info('Web call start request · jobId=' + (req.body.jobId ?? '—') + ' · customerId=' + (req.body.customerId ?? '—') + ' · efrId=' + (req.body.efrId ?? '—') + ' · contactId=' + (req.body.reportingContactId ?? '—') + ' · spocJobId=' + (req.body.spocJobId ?? '—'));
    if (voice.callMode() !== 'web') logger.warn('Web call rejected · web calling not enabled');
    if (voice.callMode() !== 'web') return modernError(res, 409, 'Web calling is not enabled.');
    if (!plivo.callingEnabled()) logger.warn('Web call rejected · Plivo not enabled');
    if (!plivo.callingEnabled()) return modernError(res, 409, 'Plivo is not enabled.');

    const { jobId, customerId, efrId, reportingContactId, spocJobId, useAlt, jobContextId } = req.body;
    const agent = req.user;

    const rr = await resolveReceiver(req, { jobId, customerId, efrId, reportingContactId, spocJobId, useAlt, jobContextId });
    // Same role derivation as /click-to-call — the participant row records WHO,
    // not just digits, so the panel can label the leg and an audit reads as people.
    const webReceiverKind = efrId ? 'technician'
      : reportingContactId ? 'client_contact'
      : spocJobId ? 'job_spoc'
      : (jobId && useAlt) ? 'customer_alt'
      : 'customer';
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
    /*
     * EVERY WEB CALL STARTS AS A ONE-PARTICIPANT CONFERENCE TOO.
     *
     * The twin of the block in /click-to-call. Conferencing must not depend on
     * which dialling mode ops happens to be in — voice.call.mode is an operator
     * ergonomics setting (ring my phone vs ring my browser), and nobody would
     * expect it to decide whether a call can gain a third person. Plivo cannot
     * upgrade a live <Dial>, so if this is skipped here, web-mode calls are
     * permanently un-conferenceable.
     *
     * Same fail-soft rule: no conference ⇒ the call still goes out on the
     * classic bridge, it simply cannot gain participants.
     */
    let webConferenceId = null;
    let webConferenceName = null;
    /*
     * No provider check here, unlike /click-to-call. The web path IS Plivo by
     * definition — it is the Plivo Browser SDK, guarded above by
     * voice.callMode() !== 'web', and it calls plivo.* directly throughout.
     * (Copying the mobile block's `resolvedProvider === 'plivo' &&` verbatim is
     * what 500'd this route: that variable exists in /click-to-call, which has a
     * provider to resolve, and does not exist here.)
     */
    if (conference.conferenceEnabled()) {
      const conf = await conference.createConference({
        jobId: rr.jobIdToStore,
        startedByUserId: agent.user_id,
        jobCallerInfoId: jci,
        jobStatusSnap: rr.jobStatusSnapshot,
        jobEfrIdSnap: rr.jobEfrId,
        operatorNumber: agent.mobile_no || null,
        operatorName: agent.user_name,
      }, pool);
      if (conf.ok) {
        webConferenceId = conf.conferenceId;
        webConferenceName = conf.friendlyName;
        logger.info('Conference created (web) · row=' + jci + ' · confId=' + webConferenceId + ' · name=' + webConferenceName);
      } else {
        logger.warn('Conference NOT created (web) · row=' + jci + ' · ' + conf.code + ' · ' + conf.message
          + ' — falling back to the classic bridge (this call cannot gain participants)');
      }
    }

    const dialId = plivo.stashWebDial({
      number: dialNumber, jci,
      teleprompterSessionId: req.body.teleprompterSessionId || null,
      conferenceName: webConferenceName,
      conferenceId: webConferenceId,
      receiverKind: webReceiverKind,
      receiverName: rr.receiverName || null,
    });

    // Dedicated Plivo call log (fail-soft) — for Plivo-only reconciliation.
    await plivoLog.record({
      job_caller_info_id: jci, job_id: rr.jobIdToStore, call_mode: 'web', call_flow: coarseFlow(req.body),
      caller_user_id: agent.user_id, caller_name: agent.user_name, receiver_name: rr.receiverName || null,
      receiver_number: receiver, dialed_number: dialNumber,
      status: 'initiated',
      recording_requested: plivo.recordingEnabled() ? 1 : 0,
    });

    logger.info(`Web call started · agent=${agent.user_name}(#${agent.user_id}) → ${rr.receiverName || rr.receiverCustomerId || 'customer'} · row=${jci}`);
    return modernOk(res, {
      jobCallerInfoId: jci,
      // null when the conference could not be minted — the FE shows the
      // "this call can't add participants" notice on exactly this.
      conferenceId: webConferenceId,
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

// ─── GET /analysis-mode — global call-analysis input mode + availability ─────
// Which input the coaching analysis runs over by default: the Plivo TRANSCRIPT
// (Sophy) or the RECORDING audio (Gemini direct). `modeAvailable.recording` is
// false without GEMINI_API_KEY so the FE disables the option rather than offering
// one that would only fall back. Same gate as View Analysis. Declared before the
// '/:id/*' routes, alongside the other global-setting endpoints.
router.get('/analysis-mode', requireClickToCallAction, (req, res) => {
  logger.info('Get call-analysis mode');
  return modernOk(res, { mode: analysisMode.globalMode(), modeAvailable: analysisMode.modeAvailable() });
});

// ─── POST /analysis-mode — set call.analysis.mode (Admin Action) ─────────────
// Mirrors POST /default-provider: persists to easyfix_properties + flushes the
// cache so it takes effect immediately (no restart). Refuses 'recording' when
// Gemini isn't configured — storing a mode that can only fall back would be a
// lie to every later reader.
router.post('/analysis-mode', requirePropertyAllowlist(FEATURES.canSwitchCallMode, { label: 'Switch Call Mode' }), async (req, res, next) => {
  try {
    const mode = analysisMode.normaliseMode(req.body.mode);
    logger.info('Set call-analysis mode · mode=' + (mode || '—'));
    if (!analysisMode.isValidMode(mode)) {
      logger.warn('Set call-analysis mode rejected · invalid mode');
      return modernError(res, 400, "mode must be 'transcript' or 'recording'.");
    }
    if (mode === analysisMode.MODE_RECORDING && !analysisMode.modeAvailable().recording) {
      logger.warn('Set call-analysis mode rejected · Gemini not configured');
      return modernError(res, 409, 'Recording analysis needs GEMINI_API_KEY configured in this environment.');
    }
    await propertiesSvc.setProperty('call.analysis.mode', mode);
    await propertiesSvc.flushCache();
    logger.info(`call.analysis.mode set to '${mode}' by user #${req.user.user_id}`);
    return modernOk(res, { mode: analysisMode.globalMode(), modeAvailable: analysisMode.modeAvailable() });
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

// ─── POST /recordings/backfill — recover missing recording URLs (admin) ───────
// The Plivo push callback (<Dial recordingCallbackUrl>) never populated
// recording_url (observed has_url=0). This sweeps rows that requested recording
// but have no URL and PULLS each from the Plivo Recording API by call_uuid,
// persisting it via setRecording. Request-triggered, so it runs even when
// CRON_DISABLED (QA). ?limit (default 50, max 200) — sweep is sequential.
// Declared BEFORE the '/:id/*' routes so ':id' can't capture 'recordings'.
router.post('/recordings/backfill', requireClickToCallAction, async (req, res, next) => {
  try {
    const result = await recordingBackfill.backfillMissingRecordings({ limit: req.query.limit });
    logger.info('Recording backfill (manual) · ' + JSON.stringify(result));
    return modernOk(res, result);
  } catch (e) { next(e); }
});

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
    } else if (tx.ok) {
      // No transcript yet. Plivo does NOT auto-transcribe, so REQUEST one
      // (phase 1) and mark 'processing' — the text is retrieved on a later cron
      // / on-demand run (phase 2). Only when we've never requested (status still
      // NULL) so a replay doesn't re-hit Plivo. Add-on missing → notEnabled →
      // 'not_available' (correct terminal). BUG FIX: this branch previously set
      // 'not_available' WITHOUT requesting, permanently poisoning the row — the
      // cron and on-demand paths both skip 'not_available', so it never recovered.
      const [[cur]] = await pool.query(
        'SELECT transcription_status AS s FROM tbl_plivo_call_log WHERE job_caller_info_id = ? LIMIT 1',
        [jobCallerInfoId]
      );
      if (!cur || cur.s == null) {
        const created = await plivo.createTranscription({ recordingId });
        const status = created.notEnabled ? 'not_available' : 'processing';
        await pool.query(
          "UPDATE tbl_plivo_call_log SET transcription_status = ?, transcription_fetched_at = NOW() WHERE job_caller_info_id = ?",
          [status, jobCallerInfoId]
        );
      }
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

// Refresh the per-caller scorecard for the caller of ONE call. The Scorecard tab
// reads ONLY the pre-aggregated tbl_caller_score_rollup, so an analysis that is
// never rolled up is invisible there no matter what the call row says. Keyed on
// tbl_plivo_call_log.caller_user_id — the exact column rollupForCaller aggregates
// on; tbl_job_caller_info.caller_id is the fallback for a log row that never got
// the operator stamped. Unresolvable → skip silently: a rollup we can't attribute
// to a caller is worse than none. Never throws — same idiom as
// teleprompter-postcall.service.js's step 3.
async function rollupCallerBestEffort(jobCallerInfoId, callerUserIdFromLog) {
  try {
    let callerUserId = callerUserIdFromLog || null;
    if (!callerUserId) {
      const [[jci]] = await pool.query(
        'SELECT caller_id FROM tbl_job_caller_info WHERE job_caller_info = ? LIMIT 1',
        [jobCallerInfoId]
      );
      callerUserId = (jci && jci.caller_id) || null;
    }
    if (!callerUserId) {
      logger.warn('Caller scorecard write-through skipped · no caller resolved · jci=' + jobCallerInfoId);
      return;
    }
    await callerScorecard.rollupForCaller(callerUserId);
  } catch (e) {
    logger.warn('Caller scorecard write-through failed · jci=' + jobCallerInfoId + ' · ' + e.message);
  }
}

/*
 * Analyse → cache → roll up. Shared by GET /:id/analysis (first view) and
 * POST /:id/reanalyse (forced refresh), and the ONLY analysis-persistence path
 * for BOTH modes: what produced the JSON changes, what happens to it afterwards
 * never does. The mode branch itself lives in ONE place upstream
 * (call-analysis-mode.service.analyzeCall) — this function only stores.
 *
 * The rollup runs ONLY on a fresh generate; a cache hit would recompute identical
 * numbers on every page view. `analysis_mode` provenance is already stamped in the
 * JSON by the dispatcher — stored inside the existing column, no schema change,
 * and inert for the scorecard (which reads only overall_score + dimensions).
 *
 * Returns the dispatcher result with `analysis` replaced by the STORED object.
 */
async function runAndStoreAnalysis({ id, transcript, mode, hasAnalysis, callerUserId }) {
  logger.info('Generate call analysis · row=' + id + ' · mode=' + (mode || 'default'));
  const out = await analysisMode.analyzeCall({ jobCallerInfoId: id, transcript, mode });
  if (!out.analysis) {
    // Only a real LLM failure marks the row failed — "no transcript yet" and
    // "AI not configured" are environment states, not a failed generation.
    if (out.reason === 'analysis_failed' && hasAnalysis) {
      await pool.query("UPDATE tbl_plivo_call_log SET call_analysis_status = 'failed' WHERE job_caller_info_id = ?", [id]);
    }
    return out;
  }
  if (hasAnalysis) {
    await pool.query(
      "UPDATE tbl_plivo_call_log SET call_analysis = ?, call_analysis_status = 'ready', call_analysis_generated_at = NOW() WHERE job_caller_info_id = ?",
      [JSON.stringify(out.analysis), id]
    );
    // Only meaningful once the analysis is actually STORED — rollupForCaller
    // re-reads call_analysis off the table, so an unstored one aggregates nothing.
    await rollupCallerBestEffort(id, callerUserId);
  }
  return out;
}

/*
 * Parse the OPTIONAL per-call mode override off a request (?mode= on the read,
 * body.mode on the re-analyse). Returns { override, invalid } — absent is fine
 * (the global default then applies), but a value we don't recognise is a caller
 * bug and 400s rather than silently resolving to something else.
 */
function readModeOverride(raw) {
  if (raw == null || String(raw).trim() === '') return { override: null, invalid: false };
  if (!analysisMode.isValidMode(raw)) return { override: null, invalid: true };
  return { override: analysisMode.normaliseMode(raw), invalid: false };
}

/*
 * Map a dispatcher reason code to the FE's status contract. Both handlers share
 * it so the same failure never reads differently on the read and re-analyse paths.
 */
function statusForReason(reason) {
  if (reason === 'no_transcript') return { status: 'no_transcript' };
  if (reason === 'llm_disabled') {
    return { status: 'llm_disabled', reason: 'Call-analysis AI is not configured in this environment.' };
  }
  return { status: 'failed', reason: 'Analysis could not be generated.' };
}

// Re-analyse only: drop THIS row's cached transcript so the shared acquisition
// path (fetchTranscriptOnDemand, and the backfill cron behind it) sees a
// never-fetched row and re-requests from the provider — the point of Re-analyse
// is a better transcript, not just a re-run of the LLM over the old text.
// Clearing the TEXT (not just the status) is required, not incidental: the
// backfill cron's WHERE excludes rows that already have text, so a status-only
// reset would strip 'not_available' and still never re-fetch. Safe because the
// provider holds the transcript and this column is only a cache of it. Scoped to
// the one requested job_caller_info_id — never a status-wide sweep.
async function resetTranscriptForRefetch(jobCallerInfoId) {
  await pool.query(
    `UPDATE tbl_plivo_call_log
        SET transcription = NULL, transcription_status = NULL, transcription_fetched_at = NULL
      WHERE job_caller_info_id = ?`,
    [jobCallerInfoId]
  );
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
    let pulled = false;
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
      pulled = true;
    }
    if (!meta.ok || !meta.url) {
      // Plivo can lag a few seconds after hangup, or recording was off.
      return modernError(res, 404, 'No recording available yet — if the call just ended, try again shortly.');
    }
    // Backfill tbl_plivo_call_log.recording_url from this fresh PULL — the Plivo
    // push callback (<Dial recordingCallbackUrl>) has proven unreliable (never
    // populated the column), so playing a call self-heals its log row and clears
    // it from the "missing recordings" report. Best-effort (setRecording is
    // fail-soft). Only when we actually pulled (skip when meta came from the log).
    if (pulled) await plivoLog.setRecording(id, { url: meta.url, id: meta.recordingId, duration: meta.duration });
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

// ─── GET /:id/analysis — LLM coaching analysis of the call ─────────────
// On-demand (Call Analytics → View Analysis): returns the cached analysis, else
// generates one and caches it. Needs the transcription/analysis columns
// (2026-07-06 migrations) + a configured LLM; degrades gracefully.
//
// ?mode=transcript|recording is an OPTIONAL per-call override of the global
// `call.analysis.mode`. Every response reports `mode` (what ACTUALLY produced the
// analysis) + `modeAvailable` (what this environment can run) so the FE never
// mislabels an analysis or offers an option that would only fall back.
router.get('/:id/analysis', requireClickToCallAction, async (req, res, next) => {
  try {
    const id = parseRowId(req.params.id);
    if (!id) return modernError(res, 400, 'invalid call id');
    const { override, invalid } = readModeOverride(req.query.mode);
    if (invalid) {
      logger.warn('Get call analysis rejected · invalid mode · row=' + id);
      return modernError(res, 400, "mode must be 'transcript' or 'recording'.");
    }
    const modeAvailable = analysisMode.modeAvailable();
    const resolved = analysisMode.resolveMode(override);

    // Transcription columns are the base surface; analysis (LLM) + metrics
    // (Transcribe) are each conditionally present per their own migration.
    if (!(await hasTranscriptionColumn())) {
      return modernOk(res, {
        status: 'unavailable', reason: 'Call analytics is not enabled in this environment.',
        mode: resolved.mode, modeAvailable,
      });
    }
    const hasAnalysis = await hasAnalysisColumn();
    const hasMetrics = await hasMetricsColumn();
    const analysisCol = hasAnalysis ? 'call_analysis' : 'NULL AS call_analysis';
    const metricsSelect = hasMetrics ? ', call_metrics, call_metrics_status' : '';
    const [[row]] = await pool.query(
      `SELECT transcription, transcription_status, call_uuid, caller_user_id, ${analysisCol}${metricsSelect}
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
    const envelope = (obj, { mode = resolved.mode, fallbackReason = null } = {}) => ({
      ...obj, metrics, metricsStatus, mode, modeAvailable,
      ...(fallbackReason ? { modeFallbackReason: fallbackReason } : {}),
    });

    if (!row) return modernOk(res, envelope({ status: 'no_transcript' }));
    // Cache hit — return the stored coaching (parse-guarded). An EXPLICIT ?mode=
    // is a request for THAT mode, so a cache produced the other way is bypassed
    // and regenerated; compared against the RESOLVED mode so asking for an
    // unavailable recording doesn't re-generate the same transcript every view.
    if (row.call_analysis) {
      try {
        const cached = JSON.parse(row.call_analysis);
        const cachedMode = analysisMode.analysisModeOf(cached);
        if (!override || resolved.mode === cachedMode) {
          return modernOk(res, envelope({ status: 'ready', analysis: cached }, { mode: cachedMode }));
        }
      } catch (_e) { /* corrupt cache — fall through + regenerate */ }
    }

    // Transcript acquisition is LAZY: recording mode reads the audio and needs no
    // transcript at all, so the thunk only runs if the transcript path is what
    // actually executes. If the 30-min backfill cron hasn't reached this call, it
    // pulls the transcript NOW (transcript only — the recording download stays
    // lazy elsewhere) so the cron cadence doesn't block the first View Analysis.
    const transcript = async () => {
      if ((!row.transcription || String(row.transcription).trim().length < analysisMode.MIN_TRANSCRIPT_CHARS) && row.call_uuid) {
        const fetched = await fetchTranscriptOnDemand({ jobCallerInfoId: id, callUuid: row.call_uuid, currentStatus: row.transcription_status });
        if (fetched) row.transcription = fetched;
      }
      return row.transcription;
    };

    const out = await runAndStoreAnalysis({
      id, transcript, mode: override, hasAnalysis, callerUserId: row.caller_user_id,
    });
    const opts = { mode: out.mode, fallbackReason: out.fallbackReason };
    if (!out.analysis) return modernOk(res, envelope(statusForReason(out.reason), opts));
    return modernOk(res, envelope({ status: 'ready', analysis: out.analysis }, opts));
  } catch (e) { next(e); }
});

// ─── POST /:id/reanalyse — force a fresh transcript + fresh coaching ───
// View Analysis is a CACHE on both halves: once call_analysis_status='ready' it
// never regenerates, and a transcript in a TERMINAL state ('completed' /
// 'not_available') is never re-requested. Both are right for the read path and
// wrong when the TRANSCRIPT itself improves (a better STT provider re-run over
// the same audio yields a better score). This is the explicit escape hatch —
// reset this one row's transcript cache, then fall through the SAME acquisition
// + analysis path the read uses.
//
// body.mode is the same OPTIONAL per-call override as the read's ?mode=. In
// recording mode the transcript reset is skipped when the audio carries the
// analysis — the audio is immutable, so there is nothing to re-request; the
// reset only happens on the transcript leg that actually needs it.
router.post('/:id/reanalyse', requireClickToCallAction, async (req, res, next) => {
  try {
    const id = parseRowId(req.params.id);
    if (!id) return modernError(res, 400, 'invalid call id');
    const { override, invalid } = readModeOverride(req.body && req.body.mode);
    if (invalid) {
      logger.warn('Re-analyse rejected · invalid mode · row=' + id);
      return modernError(res, 400, "mode must be 'transcript' or 'recording'.");
    }
    const modeAvailable = analysisMode.modeAvailable();
    const resolved = analysisMode.resolveMode(override);
    if (!(await hasTranscriptionColumn())) {
      return modernOk(res, {
        status: 'unavailable', reason: 'Call analytics is not enabled in this environment.',
        mode: resolved.mode, modeAvailable,
      });
    }

    const [[jci]] = await pool.query(
      'SELECT caller_id FROM tbl_job_caller_info WHERE job_caller_info = ? LIMIT 1',
      [id]
    );
    if (!jci) return modernError(res, 404, 'call not found');
    // Stronger gate than the read: this re-requests a PAID transcription, spends
    // an LLM round-trip and rewrites the caller's rollup score. Same owner-or-admin
    // rule the other per-call actions (/:id/recording, /:id/hangup) already use.
    const isOwner = jci.caller_id != null && Number(jci.caller_id) === Number(req.user.user_id);
    const isAdmin = Number(req.user.user_role) === 2;
    if (!isOwner && !isAdmin) {
      return modernError(res, 403, 'You can only re-analyse calls you placed');
    }

    const hasAnalysis = await hasAnalysisColumn();
    const [[row]] = await pool.query(
      `SELECT call_uuid, caller_user_id
         FROM tbl_plivo_call_log WHERE job_caller_info_id = ? ORDER BY id DESC LIMIT 1`,
      [id]
    );
    const envelope = (obj, { mode = resolved.mode, fallbackReason = null } = {}) => ({
      ...obj, mode, modeAvailable,
      ...(fallbackReason ? { modeFallbackReason: fallbackReason } : {}),
    });
    if (!row) return modernOk(res, envelope({ status: 'no_transcript' }));
    logger.info('Re-analyse call · row=' + id + ' · mode=' + (override || 'default'));

    // Lazy, and only on the transcript leg: recording mode re-runs the model over
    // the SAME immutable audio, so resetting the transcript cache there would
    // spend a paid re-transcription nobody reads.
    const transcript = async () => {
      await resetTranscriptForRefetch(id);
      return row.call_uuid
        ? fetchTranscriptOnDemand({ jobCallerInfoId: id, callUuid: row.call_uuid, currentStatus: null })
        : null;
    };

    // Cache bypass is a READ-path difference, not a destructive write: we simply
    // never consult call_analysis here, and only overwrite it on a successful
    // generate — so a failed re-analyse leaves the previous analysis intact rather
    // than blanking a row the operator still needs.
    const out = await runAndStoreAnalysis({
      id, transcript, mode: override, hasAnalysis, callerUserId: row.caller_user_id,
    });
    const opts = { mode: out.mode, fallbackReason: out.fallbackReason };
    if (out.analysis) return modernOk(res, envelope({ status: 'ready', analysis: out.analysis }, opts));
    if (out.reason === 'no_transcript') {
      // Provider has nothing ready yet — the reset above left the row 'processing',
      // so the backfill cron lands the text and a second Re-analyse picks it up.
      return modernOk(res, envelope({ status: 'transcript_pending', reason: 'A fresh transcript has been requested — try Re-analyse again in a few minutes.' }, opts));
    }
    return modernOk(res, envelope(statusForReason(out.reason), opts));
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

/* ─── POST /:jobCallerInfoId/web-failed — the browser leg never came up ─────
 *
 * ─── WHY THIS ROUTE EXISTS ────────────────────────────────────────────────
 *
 * In Web mode the operator's browser IS the first leg, which means its failures
 * happen entirely OUTSIDE this server. When Plivo has no Voice Application to
 * route that leg to (an unset PLIVO_WEB_APP_ID — see GET /web-credentials), the
 * SDK gets an instant SIP 486 "Busy", /api/public/plivo/web-answer is never
 * fetched, the receiver is never dialled, and NOT ONE REQUEST reaches us. The
 * diagnostic existed only in the operator's browser console, so on the server
 * side a totally broken configuration and a customer who simply did not pick up
 * were the same row: 'initiated', forever. That is why the root cause took as
 * long as it did to find, and this route is the fix for that specific blindness
 * — it is a REPORT, not a control: it changes no call, it only records one.
 *
 * OWNERSHIP IS STRICTER HERE THAN ON /:id/hangup, deliberately. Hangup is an
 * ACT on a call, so an Admin may perform it on someone else's. This is a
 * first-person account of what one browser did — only the operator whose leg it
 * was has one, and an Admin reporting a failure on a leg they never held would
 * be writing hearsay into the audit trail. So: the starter, or 403.
 */
router.post(
  '/:jobCallerInfoId/web-failed',
  requireClickToCallAction,
  validate(webCallFailedBody),
  async (req, res, next) => {
    try {
      const id = parseRowId(req.params.jobCallerInfoId);
      if (!id) logger.warn('Web call failure report rejected · invalid call id');
      if (!id) return modernError(res, 400, 'invalid call id');
      const reason = req.body.reason;

      // Same row resolution as /:id/status and /:id/hangup — one call is one
      // tbl_job_caller_info row, and caller_id is who started it.
      const [[row]] = await pool.query(
        `SELECT job_caller_info AS id, caller_id, caller_status
           FROM tbl_job_caller_info
          WHERE job_caller_info = ?
          LIMIT 1`,
        [id]
      );
      if (!row) logger.warn('Web call failure report · row not found · row=' + id);
      if (!row) return modernError(res, 404, 'call not found');

      const isOwner = row.caller_id != null && Number(row.caller_id) === Number(req.user.user_id);
      if (!isOwner) {
        logger.warn('Web call failure report denied · not the operator who started this leg · row=' + id
          + ' · by=' + req.user.user_id);
        return modernError(res, 403, 'You can only report failures on calls you started');
      }

      /*
       * THE LINE THIS ROUTE IS FOR. `error`, not warn: a browser leg that never
       * came up is an outage of the calling feature for that operator, and it
       * has to be as loud as any other 5xx-class event in this file, because
       * for months it was as quiet as nothing at all.
       */
      logger.error('Web call leg failed · row=' + id + ' · reason=' + reason
        + ' · by=' + req.user.user_id + ' · status=' + (row.caller_status || '—'));

      /*
       * IDEMPOTENT, TWICE OVER. The FE can report the same failure more than
       * once (a retry, a re-mounted panel, two SDK error events for one call),
       * and a second report must be a clean 200 that changes nothing:
       *
       *   • the read below decides what we TELL the caller, and
       *   • the UPDATE's own NOT IN guard — the same list routes/webhook/
       *     plivo.js:136 uses — decides what we WRITE, so even two concurrent
       *     reports cannot overwrite a terminal row or double-stamp end_time.
       *
       * The guard is against TERMINAL statuses only, not against 'answered':
       * whatever a call did before, the operator's own leg reporting failure
       * ends it, and a row left 'initiated' forever is the bug being fixed.
       */
      const alreadyTerminal = row.caller_status ? TERMINAL_STATUSES.has(row.caller_status) : false;
      if (!alreadyTerminal) {
        await pool.query(
          `UPDATE tbl_job_caller_info
              SET caller_status = 'failed', end_time = COALESCE(end_time, NOW()), is_updated = 1
            WHERE job_caller_info = ?
              AND caller_status NOT IN ('completed','busy','no_answer','failed','hungup')`,
          [id]
        );
        // The leg row through the service that owns this table's SQL — the
        // reason lands in hangup_cause, where every other terminal reason on
        // tbl_plivo_call_log already lives, so the Calls list reads it without
        // knowing web calls exist.
        await plivoLog.markTerminalByJci(id, {
          status: plivoLog.LEG_STATUS.FAILED,
          hangupCause: reason,
        });
      }

      return modernOk(res, {
        jobCallerInfoId: id,
        recorded: true,
        // The FE shows the same "call failed" state either way; this only says
        // whether THIS report is the one that moved the row.
        alreadyTerminal,
      });
    } catch (e) { next(e); }
  },
);

// Last-10-digits key for phone-number comparison — strips +91 / spaces /
// punctuation so the legacy-formatted `caller`/`reciever` columns compare
// cleanly against a job's stored party numbers. Empty string when < 10 digits.
function last10(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}

/*
 * ═══════════════════════════════════════════════════════════════════════════
 * CONFERENCE LEGS ON THE CALL-HISTORY SURFACES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Since 2026-08-04 an ops call can gain people mid-call. A conference is ONE
 * call that gained participants, and the data model says so exactly:
 *
 *   • tbl_job_caller_info  — still exactly ONE row per call. Nothing that
 *                            counts calls changes, here or in any report.
 *   • tbl_plivo_call_log   — one row per LEG, all sharing that call's
 *                            job_caller_info_id, each carrying conference_id +
 *                            participant_role.
 *
 * That makes job_caller_info_id genuinely 1:N, which has one consequence this
 * endpoint has to handle deliberately: the INNER JOIN below would FAN OUT and a
 * 3-party conference would read as three calls — three near-identical rows all
 * carrying the same jci id, and a `total` of 3. So the join is restricted to the
 * PRIMARY leg and the extra legs are returned as NESTED DETAIL instead:
 *
 *   ONE row per call, exactly as before  ⇒  every count is unchanged.
 *   legs[] on that row, labelled by role ⇒  the detail is not lost.
 *
 * `conference_id IS NULL` is true for every ordinary 1:1 call and for every row
 * written before this feature existed, so for all historical data the restricted
 * join selects precisely the rows the unrestricted one did. This is not a count
 * change dressed up as a fix — it is the absence of one.
 */

// Leg role → the SAME human labels resolveJobParties() already produces, so a
// leg and a top-level row never describe the same person two different ways.
// 'custom' is an arbitrary number the operator typed: it is on the call, but it
// is not one of the job's parties, so 'Other' is the honest label.
const LEG_ROLE_LABEL = Object.freeze({
  operator: 'Operator',
  customer: 'Customer',
  customer_alt: 'Alternate',
  technician: 'Technician',
  job_spoc: 'Client SPOC',
  client_contact: 'Client Contact',
  custom: 'Other',
});

// Legs per conference are 2–5 in practice. This bounds the batch read so a page
// full of conferences can never fan out unboundedly; a hit cap is logged and
// drops WHOLE conferences off the tail (the ORDER BY makes the cut fall between
// rooms), never half a room's legs beside a full leg_count.
const LEGS_PER_CONFERENCE_BUDGET = 12;

/*
 * Load every leg of the conferences appearing on ONE page of call history, in
 * ONE query, and index them by conference_id.
 *
 * ⚠ NUMBERS ARE MASKED STRUCTURALLY, exactly as the live conference panel does
 * it: neither dialed_number nor receiver_number is SELECTED — only the first
 * four digits leave the database, as `number_prefix`, and the 9812•••••• form is
 * rebuilt from them. Do not widen this projection.
 *
 * Fail-soft: a pre-migration environment has no conference_id column, so the
 * probe short-circuits and every call simply renders with no legs — which is
 * what it looked like before conferences existed.
 */
async function loadConferenceLegs(conferenceIds) {
  const ids = [...new Set((conferenceIds || []).filter((v) => v != null).map(Number))];
  if (!ids.length) return new Map();
  if (!(await plivoLog.hasConferenceColumns())) return new Map();
  const cap = Math.min(ids.length * LEGS_PER_CONFERENCE_BUDGET, 2000);
  let rows = [];
  try {
    [rows] = await pool.query(
      `SELECT id,
              conference_id,
              job_caller_info_id,
              participant_role,
              receiver_name AS display_name,
              LEFT(RIGHT(dialed_number, 10), 4) AS number_prefix,
              status,
              hangup_cause,
              call_flow,
              initiated_on,
              answered_on,
              ended_on,
              duration
         FROM tbl_plivo_call_log
        WHERE conference_id IN (${ids.map(() => '?').join(',')})
        ORDER BY conference_id ASC, id ASC
        LIMIT ?`,
      [...ids, cap],
    );
  } catch (e) {
    // A call list that 500s because the conference detail could not be loaded
    // would be a worse outcome than a call list without the detail.
    logger.warn('Conference legs load failed (call history renders without them) · ' + e.message);
    return new Map();
  }
  if (rows.length >= cap) logger.warn(`Call history conference legs hit the ${cap}-row cap`);

  const byConference = new Map();
  for (const r of rows) {
    const list = byConference.get(Number(r.conference_id)) || [];
    list.push({
      id: r.id,
      conference_id: Number(r.conference_id),
      job_caller_info_id: r.job_caller_info_id ?? null,
      participant_role: r.participant_role || null,
      /*
       * ⚠ THE PARTICIPANT VOCABULARY IS THE CONTRACT — emit it here too.
       *
       * Every other leg projection (LEG_PUBLIC_COLUMNS and the conference
       * roster queries) speaks target_kind / joined_at / left_at / created_on,
       * and the shared FE contract — lib/call-legs.ts `CallLeg` — reads exactly
       * those. This loader emitted only the raw column names, so call HISTORY
       * legs arrived with `target_kind` undefined. Consequences, all of which
       * ops saw at once on an ordinary 1:1 call:
       *   - callLegRoleLabel(undefined) fell through to "Participant", so EVERY
       *     leg was captioned "Participant" instead of Ops Agent / Customer;
       *   - counterpartyLegs() filters `target_kind !== 'operator'`, and
       *     undefined passes it, so the operator's own leg was listed as a
       *     counterparty. That row carries the RECEIVER's name in
       *     receiver_name, so the called party appeared TWICE under one name;
       *   - the resulting 2-leg count made a plain 1:1 call render as
       *     "Conference · 2 People".
       * `created_on` being absent also silently disabled sortCallLegs' ordering.
       *
       * The raw keys are kept alongside so any existing consumer of this
       * endpoint keeps working — this adds vocabulary, it does not rename.
       */
      target_kind: r.participant_role || null,
      joined_at: r.answered_on || null,
      left_at: r.ended_on || null,
      created_on: r.initiated_on || null,
      // The label the UI shows. `party_role` is named to match the top-level
      // row's own field, so a tooltip can render both with one code path.
      party_role: LEG_ROLE_LABEL[r.participant_role] || 'Other',
      display_name: r.display_name || null,
      masked_number: r.number_prefix ? `${r.number_prefix}••••••` : null,
      status: r.status || null,
      hangup_cause: r.hangup_cause || null,
      call_flow: r.call_flow || null,
      initiated_on: r.initiated_on || null,
      answered_on: r.answered_on || null,
      ended_on: r.ended_on || null,
      duration: r.duration ?? null,
    });
    byConference.set(Number(r.conference_id), list);
  }
  return byConference;
}

/*
 * Attach the conference detail to a page of call-history rows.
 *
 * A row that is not a conference gets `legs: []` and `leg_count: 0` rather than
 * nulls, so the FE never has to branch on shape — only on `is_conference`.
 *
 * `is_primary` marks the leg that IS this row (the operator's), so a consumer
 * can render "and 2 others" without double-counting the call it is already
 * showing. That flag is why the operator's leg is included at all: dropping it
 * would make the array read as the whole room when it is the room minus one.
 */
async function attachConferenceLegs(rows) {
  const legsByConference = await loadConferenceLegs(rows.map((r) => r.conference_id));
  for (const r of rows) {
    const legs = (r.conference_id != null && legsByConference.get(Number(r.conference_id))) || [];
    r.is_conference = legs.length > 1;
    r.leg_count = legs.length;
    r.legs = legs.map((l) => ({ ...l, is_primary: Number(l.id) === Number(r.leg_id) }));
  }
  return rows;
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
    // Flow (always present) + coaching score and its PROVENANCE (both extracted
    // from the cached analysis JSON so the big blob isn't shipped per row) for the
    // unified Call Analysis list.
    //
    // A stored analysis with NO `analysis_mode` marker is NOT unknown provenance:
    // analyzeCall() stamps every analysis it produces, so an unstamped row can
    // only predate recording mode — i.e. it was transcript-produced by
    // construction. We therefore resolve it to 'transcript' here, matching
    // call-analysis-mode.service.js's analysisModeOf(). Without this the SAME row
    // read "no chip" in the list and "Transcript" in the modal.
    // NULL is reserved for its one honest meaning: no analysis at all ⇒ no chip.
    const flowSelect = ',\n              pcl.call_flow';
    const anaSelect = hasAna
      ? ",\n              pcl.call_analysis_status,\n              JSON_UNQUOTE(JSON_EXTRACT(pcl.call_analysis, '$.overall_score')) AS score"
        + ",\n              CASE WHEN pcl.call_analysis IS NULL THEN NULL"
        + "\n                   ELSE COALESCE(JSON_UNQUOTE(JSON_EXTRACT(pcl.call_analysis, '$.analysis_mode')), 'transcript')"
        + "\n              END AS analysis_mode"
      : '';
    /*
     * ⚠ THE PRIMARY-LEG RESTRICTION — see the CONFERENCE LEGS block above.
     *
     * Without it a conference fans this INNER JOIN out into one row per leg and
     * `total` counts a 3-party call as three. With it, ONE row per call, and the
     * extra legs come back as nested detail from attachConferenceLegs().
     *
     * It lives in the ON clause rather than the WHERE so `whereSql` (which the
     * COUNT and the page share) stays exactly what the caller's filters built.
     * Probe-gated: pre-migration the columns do not exist, the predicate is
     * empty, and this query is byte-for-byte the one that shipped before.
     *
     * NOT COUNT(DISTINCT jci.job_caller_info), deliberately: the page and the
     * count must select the same rows. A DISTINCT count with a fan-out page
     * would print "1 call" above three rows, which is a different lie.
     */
    const hasConfCols = await plivoLog.hasConferenceColumns();
    const primaryLegOnly = hasConfCols
      ? " AND (pcl.conference_id IS NULL OR pcl.participant_role = 'operator')"
      : '';
    const plivoJoin = `JOIN tbl_plivo_call_log pcl ON pcl.job_caller_info_id = jci.job_caller_info${primaryLegOnly}`;
    // leg_id identifies WHICH tbl_plivo_call_log row this call-history row came
    // from, so attachConferenceLegs() can flag it `is_primary` among the legs.
    const confSelect = hasConfCols
      ? ',\n              pcl.id            AS leg_id,\n              pcl.conference_id,\n              pcl.participant_role'
      : '';

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
              jci.is_updated${txSelect}${flowSelect}${anaSelect}${confSelect}
         FROM tbl_job_caller_info jci
         ${plivoJoin}
         ${whereSql}
         ORDER BY jci.inserted_time DESC
         LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    /*
     * ── The conference detail (decision 3) ──
     *
     * ONE extra query, and only when the page actually contains a conference.
     * Each row gains legs[] — every party who was on that call, labelled by
     * role, MASKED — plus leg_count and is_conference. `total` above is
     * untouched: this is detail added, never a count changed.
     *
     * This is what the per-job call-history tooltip (the ⓘ on Job #) renders,
     * and it is also why the technician who was conferenced in is no longer
     * invisible there: the leg carries its OWN participant_role and
     * receiver_name, rather than inheriting the original receiver stamped on
     * tbl_job_caller_info at click-to-call time (which is identical for every
     * leg and would label the whole room 'Customer').
     */
    if (rows.length) await attachConferenceLegs(rows);

    /*
     * When scoped to ONE job, label each row with the party the operator was
     * on the call with. The counterparty is the non-operator leg: reciever on
     * OUT calls (operator dialled out), caller on IN calls. We match its last-10
     * digits against the job's known numbers so the UI can show "Customer" /
     * "Client SPOC" / "Technician" instead of a bare number. Falls back to the
     * name stamped on the row at call time, then 'Other' for anything unmatched
     * (e.g. a number that has since changed on the job).
     *
     * ⚠ TWO CLASSIFIERS, AND EACH IS RIGHT FOR ITS OWN LEVEL — this is the part
     * that is easy to get backwards:
     *
     *   • the ROW is the CALL, so its party is derived from jci.reciever, the
     *     number the operator originally dialled. participant_role on the
     *     primary leg is 'operator', which describes the LEG, not the person on
     *     the other end — using it here would label every call "Operator".
     *   • each LEG carries its OWN participant_role and receiver_name, so
     *     legs[].party_role is derived from those (in loadConferenceLegs) and
     *     never from jci.reciever, which is identical on every leg of the call
     *     and would label the whole room "Customer".
     */
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
