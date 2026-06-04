const router = require('express').Router();
const { pool } = require('../../db');
const logger = require('../../logger');
const validate = require('../../middleware/validate');
const { modernOk, modernError } = require('../../utils/response');
const kaleyra = require('../../services/kaleyra.service');
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

/* Resolve which mode the environment is in. Centralised so the constants
 * stay single-sourced across the route file. */
function callingMode() {
  if (String(process.env.KALEYRA_CALLING_CUSTOM_NUMBER).toLowerCase() === 'true') return 'qa';
  const f = (process.env.KALEYRA_CALL_FROM || '').trim();
  const t = (process.env.KALEYRA_CALL_TO   || '').trim();
  if (f && t) return 'dev';
  return 'prod';
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
  const mode = callingMode();
  const promptForNumbers = mode === 'qa';

  // qaDefaults is ONLY populated in QA mode (we don't want the dev-env
  // override values leaking to a production FE; in dev/prod the FE
  // already uses /preview to get masked previews instead).
  let qaDefaults = null;
  if (promptForNumbers) {
    const envFrom = (process.env.KALEYRA_CALL_FROM || '').trim();
    const envTo   = (process.env.KALEYRA_CALL_TO   || '').trim();
    if (envFrom || envTo) qaDefaults = { from: envFrom || null, to: envTo || null };
  }

  modernOk(res, { mode, promptForNumbers, qaDefaults });
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
    const { jobId, customerId, efrId, reportingContactId, useAlt } = req.query;
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

    // Resolve the EXACT masked legs we'd dial via the shared resolver
    // (kaleyra.previewCallLegs) — the SAME code path clickToCall uses — so this
    // preview can never drift from the real call. In QA mode (customNumberMode)
    // we pass alwaysApplyEnvOverride so the KALEYRA_CALL_FROM/TO values the
    // dialog pre-fills are reflected; dev/prod resolve through the normal
    // waterfall (dev substitutes env, prod passes through to real). previewCall-
    // Legs masks first-4-then-bullets internally (same convention as before).
    const mode = callingMode();
    const preview = kaleyra.previewCallLegs({
      from: req.user.mobile_no,
      to:   receiverReal,
      alwaysApplyEnvOverride: mode === 'qa',
    });

    modernOk(res, { mode, dialFrom: preview.from, dialTo: preview.to });
  } catch (e) { next(e); }
});

// ─── POST /click-to-call ─────────────────────────────────────────────
router.post('/click-to-call', requireClickToCallAction, validate(clickToCallBody), async (req, res, next) => {
  try {
    const { jobId, customerId, efrId, reportingContactId, callFrom, callTo, useAlt } = req.body;
    const agent = req.user;

    // Three-tier number-resolution waterfall:
    //   1. QA prompt mode → FE MUST supply both callFrom + callTo, BE uses them.
    //   2. Flag OFF + FE sent override numbers → 400 (anti-spoofing).
    //   3. Otherwise → resolve real numbers (req.user.mobile_no + customer lookup).
    const isCustomNumberMode =
      String(process.env.KALEYRA_CALLING_CUSTOM_NUMBER).toLowerCase() === 'true';

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
    // FE never sends the customer mobile — we always look it up server-side
    // (even in QA mode, we still record the canonical customer ref in
    // tbl_job_caller_info; the Call To the FE supplied is only used as the
    // actual dial target, not as the persisted "this is who we called"
    // value).
    let receiverMobile;
    let receiverName;
    let receiverCustomerId = null;
    let jobIdToStore       = null;
    let jobStatusSnapshot  = null;
    let jobEfrId           = null;

    if (jobId) {
      // Customer mobile lives ONLY on tbl_customer; tbl_job does not have a
      // mobile column. tbl_job DOES carry an optional job_customer_name
      // override (set during bulk uploads), which we honour over the
      // canonical tbl_customer.customer_name when present — same precedence
      // the JobModal display uses.
      //
      // useAlt branch (2026-06-03): when set, dial the per-job alternate
      // contact (tbl_job.additional_number + .additional_name) instead of
      // the customer master mobile. Same audit trail (job + customer ids
      // still recorded); only the receiver number/name change. Rejects
      // when additional_number is empty so a "no alt on file" misclick is
      // a clear 400, not a silent fallthrough.
      const [[job]] = await pool.query(
        `SELECT j.job_id, j.fk_customer_id, j.fk_easyfixter_id, j.job_status,
                COALESCE(j.job_customer_name, c.customer_name) AS customer_name,
                c.customer_mob_no,
                j.additional_name, j.additional_number
           FROM tbl_job j
      LEFT JOIN tbl_customer c ON c.customer_id = j.fk_customer_id
          WHERE j.job_id = ?
          LIMIT 1`,
        [jobId]
      );
      if (!job) return modernError(res, 404, `Job ${jobId} not found`);
      if (useAlt) {
        if (!job.additional_number) return modernError(res, 400, `Job ${jobId} has no alternate number on file`);
        receiverMobile = job.additional_number;
        receiverName   = job.additional_name || job.customer_name || null;
      } else {
        if (!job.customer_mob_no) return modernError(res, 400, `Job ${jobId} has no customer mobile on file`);
        receiverMobile = job.customer_mob_no;
        receiverName   = job.customer_name || null;
      }
      receiverCustomerId  = job.fk_customer_id || null;
      jobIdToStore        = job.job_id;
      jobStatusSnapshot   = job.job_status;
      jobEfrId            = job.fk_easyfixter_id || null;
    } else if (customerId) {
      // customerId path — customer-only call, no associated job row
      const [[cust]] = await pool.query(
        `SELECT customer_id, customer_name, customer_mob_no
           FROM tbl_customer WHERE customer_id = ? LIMIT 1`,
        [customerId]
      );
      if (!cust) return modernError(res, 404, `Customer ${customerId} not found`);
      if (!cust.customer_mob_no) return modernError(res, 400, `Customer ${customerId} has no mobile on file`);
      receiverMobile     = cust.customer_mob_no;
      receiverName       = cust.customer_name || null;
      receiverCustomerId = cust.customer_id;
    } else if (efrId) {
      // Technician dial. efr_no is the canonical mobile column on
      // tbl_easyfixer (despite the field name — see backend CLAUDE.md
      // "tbl_easyfixer glossary"). receiverCustomerId stays null since
      // a tech is not a customer; the audit row's reciever_id will
      // capture the efr_id-as-int instead via the persistence layer.
      const [[efr]] = await pool.query(
        `SELECT efr_id, efr_first_name, efr_last_name, efr_no
           FROM tbl_easyfixer WHERE efr_id = ? LIMIT 1`,
        [efrId]
      );
      if (!efr) return modernError(res, 404, `Easyfixer ${efrId} not found`);
      if (!efr.efr_no) return modernError(res, 400, `Easyfixer ${efrId} has no mobile on file`);
      receiverMobile     = efr.efr_no;
      receiverName       = [efr.efr_first_name, efr.efr_last_name].filter(Boolean).join(' ').trim() || null;
      receiverCustomerId = null;
    } else {
      // reportingContactId path — call a client SPOC directly. Resolves
      // mobile from tbl_client_contacts (the canonical SPOC table). The
      // legacy tbl_job.client_spoc text column duplicates this number but
      // we prefer the FK source for accuracy.
      const [[ct]] = await pool.query(
        `SELECT id, contact_name, contact_no
           FROM tbl_client_contacts WHERE id = ? LIMIT 1`,
        [reportingContactId]
      );
      if (!ct) return modernError(res, 404, `Contact ${reportingContactId} not found`);
      if (!ct.contact_no) return modernError(res, 400, `Contact ${reportingContactId} has no mobile on file`);
      receiverMobile     = ct.contact_no;
      receiverName       = ct.contact_name || null;
      receiverCustomerId = null;
    }

    // ── Place the Kaleyra call ──
    // In QA mode the operator typed both numbers; everywhere else we use
    // the resolved real values. The service layer's env-var overrides
    // (KALEYRA_CALL_FROM / KALEYRA_CALL_TO) also fire here — but only
    // when KALEYRA_CALLING_CUSTOM_NUMBER is OFF (the service has its own
    // short-circuit so the FE-supplied values aren't clobbered).
    const dialFrom = isCustomNumberMode ? callFrom : agent.mobile_no;
    const dialTo   = isCustomNumberMode ? callTo   : receiverMobile;
    const callResult = await kaleyra.clickToCall({
      from: dialFrom,
      to:   dialTo,
    });

    if (!callResult.delivered) {
      // Suppressed-mode dev convenience: still return 200 so the UI can
      // show "would have called" feedback. Distinct from real failures,
      // which bubble as 4xx/5xx below.
      if (callResult.suppressed || callResult.disabled) {
        return modernOk(res, {
          delivered: false,
          suppressed: true,
          message: 'Outbound calling is disabled in this environment (set KALEYRA_CALLING_ENABLED=true to enable).',
        });
      }

      // Hand the FE the EXACT reason so the toast is actionable. The
      // service layer already classified the failure via the
      // `diagnostic` field so we don't have to re-parse strings here.
      //   - caller_equals_receiver  → 400 (config issue, caller can fix
      //                                    by changing TEST_MOBILE)
      //   - kaleyra_soft_fail_no_id → 502 (provider accepted HTTP but
      //                                    didn't dispatch a call leg)
      //   - kaleyra_http_error      → 502 (provider returned non-2xx)
      //   - network_error           → 502 (couldn't reach Kaleyra)
      const status = callResult.diagnostic === 'caller_equals_receiver' ? 400 : 502;
      const baseMsg = callResult.error
        || callResult.providerError
        || `Kaleyra rejected the call${callResult.providerStatus ? ` (status=${callResult.providerStatus})` : ''}`;
      return modernError(res, status, baseMsg, {
        diagnostic: callResult.diagnostic,
        providerStatus: callResult.providerStatus,
        providerError: callResult.providerError,
      });
    }

    // ── Persist to tbl_job_caller_info ──
    // Column-name typos `reciever*` preserved verbatim per backend CLAUDE.md.
    // is_updated=0 → flagged for the cron to fill in metadata.
    const [insertResult] = await pool.query(
      `INSERT INTO tbl_job_caller_info
         (job_id, unique_id, caller, caller_id, caller_name,
          reciever, reciever_id, reciever_name,
          job_status, job_efr_id, call_type, inserted_by, is_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OUT', ?, 0)`,
      [
        jobIdToStore,
        callResult.callId || null,
        kaleyra.normaliseIndianPhone(agent.mobile_no),
        agent.user_id,
        agent.user_name,
        kaleyra.normaliseIndianPhone(receiverMobile),
        receiverCustomerId,
        receiverName,
        jobStatusSnapshot,
        jobEfrId,
        agent.user_id,
      ]
    );

    logger.info(`Click-to-call placed · agent=${agent.user_name}(#${agent.user_id}) → ${receiverName || receiverCustomerId || 'customer'} · row=${insertResult.insertId} · uniqueId=${callResult.callId || '—'}`);
    return modernOk(res, {
      delivered: true,
      jobCallerInfoId: insertResult.insertId,
      callId: callResult.callId || null,
      // `overridden` is the new field — true when either KALEYRA_CALL_FROM
      // or KALEYRA_CALL_TO substituted a leg. Kept the `redirected` alias
      // so any FE that hadn't been updated yet still reads truthy.
      overridden: callResult.overridden || false,
      redirected: callResult.overridden || false,
      message: callResult.overridden
        ? 'Dev override active — one or both legs routed to a KALEYRA_CALL_* test number instead of the real participant.'
        : 'Calling — your phone will ring shortly.',
    });
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
