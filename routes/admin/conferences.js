const router = require('express').Router();
const { pool } = require('../../db');
const logger = require('../../logger');
const validate = require('../../middleware/validate');
const requireAction = require('../../middleware/require-action');
const { rateLimit } = require('../../middleware/rate-limit');
const { modernOk, modernError } = require('../../utils/response');
const plivo = require('../../services/plivo.service');
const conference = require('../../services/plivo-conference.service');
const {
  startConferenceBody,
  conferenceParticipantBody,
  endConferenceBody,
} = require('../../validators/conference.validator');

/*
 * /api/admin/conferences — ops conference calling on Plivo Multi-Party Call.
 *
 * ─── WHAT THIS IS ────────────────────────────────────────────────────────
 *
 * Ops today click-to-call one person and, to bring a second person in, must
 * hang up and redial. Plivo cannot promote a live <Dial> into a conference —
 * <Dial> and MPC are different objects with no conversion API — so every ops
 * call now starts as an MPC carrying a single participant. Ops sees no
 * difference: click Call, it rings, they talk. The leg is simply already a
 * conference participant, so "add someone" is one API call away at any moment.
 *
 * This router is the operator-facing REST surface over that. The provider
 * mechanics, and EVERY unverified Plivo MPC wire shape, live in exactly one
 * place — services/plivo-conference.service.js. Nothing here encodes an MPC
 * path, parameter or response key, deliberately: if a shape turns out wrong,
 * that file is the only edit.
 *
 *   POST   /                                   start a conference (record it)
 *   GET    /:id                                conference + participants + roster
 *   POST   /:id/participants                   add one party mid-call
 *   DELETE /:id/participants/:participantId    drop one party
 *   POST   /:id/end                            end it for everyone
 *
 * Auth + role(['admin']) + maskMobile + rejectMaskedMobile come from the
 * parent router (routes/admin/index.js).
 *
 * ─── THERE IS NO FEATURE FLAG ────────────────────────────────────────────
 *
 * The operational switch is the EXISTING `plivo.calling.enabled` property, and
 * deliberately nothing else. Off ⇒ calls route to Kaleyra, which is
 * post-call-report-only, has no live surface, and therefore no conferences.
 * conference.conferenceEnabled() IS plivo.callingEnabled(); the service
 * refuses with code 'disabled' and this router maps that to 503.
 *
 * ─── AND NO CONFIGURABLE LIMITS ──────────────────────────────────────────
 *
 * There are no `plivo.conference.max.*` cost knobs and this router therefore
 * publishes no `limits` block. That is an owner decision, and "no limit here"
 * does NOT mean unlimited: PLIVO'S OWN DEFAULTS APPLY, which is where a
 * provider ceiling belongs. What guards spend instead:
 *
 *   1. endMpcOnExit="true" on the operator's leg — the operator hanging up ends
 *      the room for everyone. POST /:id/end is the same act, made explicit.
 *   2. services/conference-reaper-cron.js, whose ceiling is an INTERNAL
 *      constant (a leak detector, not a product limit, and not a property).
 *
 * Consequences for this file: no endpoint can refuse with 'max_participants' or
 * 'max_concurrent', and neither code appears in CODE_HTTP below.
 *
 * ─── PRIVACY: THE CUSTOMER'S NUMBER NEVER REACHES THE BROWSER ────────────
 *
 * Three independent mechanisms, all of which have to hold:
 *
 *   1. Requests carry IDENTIFIERS, never numbers (validators/conference.
 *      validator.js). The one exception is the custom-number arm, which has
 *      its own permission key, its own format check, its own rate limit and
 *      its own audit row.
 *   2. Numbers are resolved SERVER-SIDE, here, from the conference's own job.
 *   3. Responses are built from explicit DTOs (never a spread of a DB row) and
 *      carry `masked_number` only — the 9988•••••• form. `dialed_number` is
 *      not even selected by the service's public leg projection.
 *
 * ─── FAIL-SOFT ───────────────────────────────────────────────────────────
 *
 * Every service call returns a discriminated result object and never throws,
 * so a conference failure can never 500 a request that already committed a
 * row, and can never break the underlying call. Handlers translate `code` to
 * an HTTP status through ONE table (CODE_HTTP below) so the mapping cannot
 * drift between endpoints.
 */

/*
 * ONE RBAC key — the SAME one that already gates calling: `isClickToCall`.
 *
 * There were two conference-specific keys here (`isConferenceCall`,
 * `isConferenceCustomNumber`). Both are gone, per the owner: "if we already have
 * the RBAC for calling, the caller will have access to conference call as well.
 * Either no call access or any type of call access."
 *
 * That is right, and for `isConferenceCall` it was not merely redundant — it was
 * INCOHERENT. Every ops call is now a Multi-Party Call; there is no
 * non-conference call to hold the lesser permission. An operator with
 * isClickToCall but not isConferenceCall would have placed a call that IS a
 * conference and then been refused sight of its own participants. A permission
 * that can only ever produce a broken half-state is not a permission.
 *
 * ⚠ The custom-number arm is now open to anyone who can call. That is the
 * owner's explicit decision and it is a real widening: the roster keeps ops
 * dialling only people attached to a job, and a free-text number is what turns
 * the dialler into a general-purpose outbound line. What still constrains it:
 * the number must be a valid Indian mobile, the per-operator rate limit below
 * still applies, and every custom add records the actor AND the digits — for a
 * custom number the digits are the only record of what happened. To re-gate it,
 * reintroduce a key here and wrap the custom arm; nothing else needs to change.
 */
const ACTION_CONFERENCE = 'isClickToCall';

/*
 * Per-operator cap on the custom-number arm ONLY.
 *
 * /api/admin/* is deliberately rate-limit-exempt (server.js mounts limiters on
 * /api/integration, /api/mobile and /api/client only). That is fine for reads
 * and for 1:1 calls to people already in the database — it is NOT fine for a
 * control that dials arbitrary external numbers from a company line, so this
 * arm brings its own. Keyed on the user, not the IP: an office NATs to one
 * address, and the thing being bounded is an OPERATOR, not a network.
 *
 * Instantiated ONCE at module scope — rateLimit() closes over its own Map, so
 * building it per-request would reset the window on every call and cap nothing.
 */
const customNumberLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  key: (req) => `conf-custom:${req.user && req.user.user_id ? req.user.user_id : req.ip}`,
});

/*
 * Run `mw` only on the custom-number arm. Mounted AFTER validate(), so
 * req.body.customNumber is the validated value and a roster add is never
 * charged against the custom-number budget.
 */
function onlyForCustomNumber(mw) {
  return (req, res, next) => (req.body && req.body.customNumber ? mw(req, res, next) : next());
}

/*
 * The ONE place a service result code becomes an HTTP status. Every handler
 * routes its failures through failureFor() so two endpoints can never disagree
 * about what 'duplicate' means.
 */
const CODE_HTTP = {
  no_pool: 500,
  db_error: 500,
  disabled: 503,             // plivo.calling.enabled is off ⇒ no live surface
  not_configured: 503,       // PLIVO_AUTH_ID / PLIVO_CALLER_ID missing
  not_found: 404,
  invalid_number: 400,
  conference_not_live: 400,
  duplicate: 409,            // that party is already on the call
  member_id_unknown: 409,    // leg exists but has not joined yet — retry shortly
  provider_error: 502,
  network_error: 502,
  // No 'max_participants' / 'max_concurrent'. The service cannot produce them
  // any more (the three cost knobs are gone — see the header), so listing them
  // would be a mapping for a failure that can no longer happen.
};

function failureFor(res, result, fallbackMessage) {
  const status = CODE_HTTP[result && result.code] || 502;
  const message = (result && result.message) || fallbackMessage || 'Conference request failed';
  // httpStatus / body are the PROVIDER's, surfaced as details so an operator's
  // toast is generic while the network tab and the logs stay specific. The
  // service has already logged the status AND the body loudly.
  const details = {};
  if (result && result.code) details.code = result.code;
  if (result && result.httpStatus != null) details.providerStatus = result.httpStatus;
  return modernError(res, status, message, Object.keys(details).length ? details : undefined);
}

// Positive-integer path param, or null. Same inline guard as
// routes/admin/calls.js:parseRowId — no id-param validator exists for this
// route group, and inventing one for two integers would be ceremony.
function parseRowId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// requireAction() hydrates req.user.permissions once per request, so by the
// time a handler runs this is a memory read, not a second DB round trip.

/* ───────────────────────────── DTOs ──────────────────────────────────────
 *
 * Explicit projections, never `{ ...row }`. Two reasons, both load-bearing:
 * a column added to either table later cannot leak by accident, and the FE
 * gets a contract that does not silently change shape when the schema does.
 *
 * Omitted ON PURPOSE:
 *   friendly_name, mpc_uuid, member_id, participant_uuid
 *       Provider handles. The browser has nothing to do with them and they
 *       only describe how to address our Plivo account.
 *   dialed_number / receiver_number
 *       The two columns holding a real number. The service's public leg
 *       projection does not even SELECT them; this is the second line of that
 *       defence.
 *
 * Also gone, with the limits (see the header):
 *   max_participants, max_duration_sec, peak_participants
 *       There are no caps to report, so publishing a ceiling here would be
 *       inventing one. `participant_count` stays and is DERIVED by the service
 *       from the legs it just loaded, so it cannot drift from them.
 */
function conferenceDto(c) {
  const live = conference.LIVE_CONFERENCE_STATUSES.includes(c.status);
  return {
    id: c.id,
    job_id: c.job_id ?? null,
    status: c.status,
    provider: c.provider || 'plivo',
    started_by_user_id: c.started_by_user_id ?? null,
    job_caller_info_id: c.job_caller_info_id ?? null,
    participant_count: c.participant_count ?? 0,
    started_on: c.started_on ?? null,
    ended_on: c.ended_on ?? null,
    duration: c.duration ?? null,
    end_reason: c.end_reason ?? null,
    error: c.error ?? null,
    created_on: c.created_on ?? null,
    live,
    // `terminal` lets the FE stop polling, mirroring GET /admin/calls/:id/status.
    terminal: !live,
  };
}

/*
 * A participant IS a call leg — a tbl_plivo_call_log row carrying the same
 * job_caller_info_id as the operator's, plus a conference_id and a
 * participant_role. So `status` here is that table's OWN leg vocabulary
 * (initiated / ringing / answered / completed / no_answer / failed), not a
 * conference-specific enum: the same row has to read correctly on every surface
 * that already renders a Plivo leg.
 *
 * Absent because the column never existed on the call log and nothing ever
 * wrote it: muted, on_hold, provider_error, attempt_no. The provider's refusal
 * reason lands in hangup_cause, which is where every other terminal reason on
 * that table lives.
 */
function participantDto(p) {
  const active = conference.ACTIVE_PARTICIPANT_STATUSES.includes(p.status);
  return {
    id: p.id,
    conference_id: p.conference_id,
    target_kind: p.target_kind,
    target_id: p.target_id ?? null,
    display_name: p.display_name ?? null,
    masked_number: p.masked_number ?? null,
    role: p.role,
    status: p.status,
    hangup_cause: p.hangup_cause ?? null,
    added_by_user_id: p.added_by_user_id ?? null,
    joined_at: p.joined_at ?? null,
    left_at: p.left_at ?? null,
    duration: p.duration ?? null,
    created_on: p.created_on ?? null,
    active,
    // The operator is excluded: their leg carries endMpcOnExit, so dropping
    // them would end the room for everyone. POST /:id/end is that action, and
    // it says so.
    can_remove: active && p.target_kind !== 'operator',
  };
}

/* ─────────────────────── the roster (server-side) ────────────────────────
 *
 * ⚠ THIS IS THE SECURITY BOUNDARY, and it is why a roster read exists rather
 * than a call to routes/admin/calls.js:resolveReceiver().
 *
 * resolveReceiver() answers "what number is behind this id?" — it will happily
 * resolve ANY efr id or ANY contact id, because on the 1:1 path the operator
 * chose that person directly. A conference participant is different: the
 * question is "is this person ON THIS JOB?", and the only honest way to answer
 * it is to derive the set of reachable parties FROM the job and check
 * membership. Deriving the set and resolving the digits in one read means the
 * allowed set and the dialled number can never disagree — a two-step
 * (resolve, then separately validate) can drift; this cannot.
 *
 * Refusing free text stops someone TYPING a number. Scoping to the job stops
 * someone ENUMERATING ids. Both are required; neither substitutes for the other.
 *
 * FOLLOW-UP (not in this change's file scope): §6.5 of the design asks for
 * resolveReceiver + resolveJobParties to be lifted out of routes/admin/calls.js
 * into services/call-party.service.js. When that lands, this roster read should
 * move there beside them so the job-scoped and target-scoped resolvers sit
 * together.
 */

// Roster row order is the order ops thinks in: the customer first, then the
// person on site, then the client side.
const ROSTER_ORDER = ['customer', 'customer_alt', 'technician', 'job_spoc', 'client_contact'];

async function loadJob(jobId) {
  const [[job]] = await pool.query(
    `SELECT j.job_id, j.job_status, j.fk_client_id, j.fk_customer_id, j.fk_easyfixter_id,
            j.additional_name, j.additional_number,
            j.client_spoc, j.client_spoc_name,
            COALESCE(j.job_customer_name, c.customer_name) AS customer_name,
            c.customer_mob_no,
            ef.efr_first_name, ef.efr_last_name, ef.efr_no
       FROM tbl_job j
  LEFT JOIN tbl_customer  c  ON c.customer_id = j.fk_customer_id
  LEFT JOIN tbl_easyfixer ef ON ef.efr_id = j.fk_easyfixter_id
      WHERE j.job_id = ?
      LIMIT 1`,
    [jobId],
  );
  return job || null;
}

/*
 * Every party reachable from a job, with the digits attached SERVER-SIDE.
 * The returned entries carry both `number` (never serialised — see rosterDto)
 * and `masked_number` (what the browser sees).
 *
 * A conference with no job returns an EMPTY roster, which is the correct and
 * deliberate outcome: with nothing to scope against, no roster target can be
 * proven to belong, so only the custom-number arm can add anyone.
 */
async function buildRoster(jobId, preloadedJob = null) {
  if (!jobId) return { job: null, entries: [] };
  // The start path has already read the job for its status snapshot; re-reading
  // it here would be a second identical query on the same request.
  const job = preloadedJob && Number(preloadedJob.job_id) === Number(jobId)
    ? preloadedJob
    : await loadJob(jobId);
  if (!job) return { job: null, entries: [] };

  const entries = [];
  const push = (targetKind, key, targetId, name, number, extra = {}) => {
    entries.push({
      target_kind: targetKind,
      key,                                   // the request-body key for this row
      target_id: targetId,
      name: name || null,
      number: number || null,                // SERVER-SIDE ONLY
      masked_number: plivo.maskForDisplay(number),
      ...extra,
    });
  };

  push('customer', 'jobId', job.job_id, job.customer_name, job.customer_mob_no, { label: 'Customer' });
  if (job.additional_number) {
    push('customer_alt', 'jobId', job.job_id, job.additional_name || job.customer_name, job.additional_number,
      { label: 'Customer (Alternate)', use_alt: true });
  }
  if (job.fk_easyfixter_id) {
    const techName = [job.efr_first_name, job.efr_last_name].filter(Boolean).join(' ').trim();
    push('technician', 'efrId', job.fk_easyfixter_id, techName, job.efr_no, { label: 'Assigned Technician' });
  }
  if (job.client_spoc) {
    // The SPOC has no id of its own — client_spoc is a plain string column on
    // the job — so the identifier IS the job id, exactly as on click-to-call's
    // spocJobId path.
    push('job_spoc', 'spocJobId', job.job_id, job.client_spoc_name, job.client_spoc, { label: 'Job SPOC' });
  }

  if (job.fk_client_id) {
    // Contacts of THIS JOB'S CLIENT. Bounded: a client with hundreds of
    // contacts must not turn a 2-second poll into a table scan, and a picker
    // nobody can read is not a picker.
    const [contacts] = await pool.query(
      `SELECT id, contact_name, contact_no
         FROM tbl_client_contacts
        WHERE client_id = ? AND status = 1 AND contact_no IS NOT NULL AND contact_no <> ''
        ORDER BY contact_name ASC
        LIMIT 50`,
      [job.fk_client_id],
    );
    for (const ct of contacts || []) {
      push('client_contact', 'reportingContactId', ct.id, ct.contact_name, ct.contact_no,
        { label: 'Client Contact' });
    }
  }

  entries.sort((a, b) => ROSTER_ORDER.indexOf(a.target_kind) - ROSTER_ORDER.indexOf(b.target_kind));
  return { job, entries };
}

/*
 * The wire form of a roster entry. `number` is dropped here and nowhere else —
 * this function is the only path from a roster entry to a response body.
 *
 * `request` is the exact body the FE should POST for this row, so the picker
 * never has to know the key-per-kind mapping (and cannot get it wrong).
 */
function rosterDto(entry, participants) {
  const onCall = (participants || []).find(
    (p) => p.target_kind === entry.target_kind
      && String(p.target_id ?? '') === String(entry.target_id ?? '')
      && conference.ACTIVE_PARTICIPANT_STATUSES.includes(p.status),
  );
  const request = { [entry.key]: entry.target_id };
  if (entry.use_alt) request.useAlt = true;
  return {
    target_kind: entry.target_kind,
    label: entry.label,
    name: entry.name,
    masked_number: entry.masked_number,
    available: !!entry.number,
    on_call: !!onCall,
    /*
     * The leg's ACTUAL status, not just the boolean above.
     *
     * `on_call` is true for every ACTIVE_PARTICIPANT_STATUSES value, which
     * includes 'initiated' — so the picker rendered a confident green "On Call"
     * chip for somebody whose phone was still ringing, while the panel directly
     * beneath it said "Dialling" for the same person. Two surfaces, one row,
     * contradicting each other, and the more prominent one was the wrong one.
     *
     * Keep `on_call` as-is: it answers a different and still-correct question —
     * "is this row already claimed, so should Add be greyed out?" — and a
     * duplicate-add guard should fire on a ringing leg. This field answers
     * "what is actually happening to them", which is what the operator reads.
     */
    status: onCall ? onCall.status : null,
    participant_id: onCall ? onCall.id : null,
    request,
  };
}

/*
 * Match a validated request body against the roster. Returns the entry whose
 * digits will be dialled, or null — and null is always a 400, never a 404:
 * "not on this job" and "does not exist" must be indistinguishable from
 * outside, or the endpoint becomes an id oracle.
 */
function matchRosterEntry(body, entries) {
  const { jobId, efrId, spocJobId, reportingContactId } = body;
  const useAlt = body.useAlt === true || body.useAlt === 1 || body.useAlt === '1' || body.useAlt === 'true';
  if (jobId) {
    const kind = useAlt ? 'customer_alt' : 'customer';
    return entries.find((e) => e.target_kind === kind && Number(e.target_id) === Number(jobId)) || null;
  }
  if (efrId) {
    return entries.find((e) => e.target_kind === 'technician' && Number(e.target_id) === Number(efrId)) || null;
  }
  if (spocJobId) {
    return entries.find((e) => e.target_kind === 'job_spoc' && Number(e.target_id) === Number(spocJobId)) || null;
  }
  if (reportingContactId) {
    return entries.find((e) => e.target_kind === 'client_contact' && Number(e.target_id) === Number(reportingContactId)) || null;
  }
  return null;
}

/* ────────────────────── shared request plumbing ───────────────────────── */

/*
 * Load a conference for a /:id request and authorise it. Returns the loaded
 * state, or null after having already responded.
 *
 * AuthZ mirrors GET /admin/calls/:id/status verbatim: the operator who started
 * it, or any Admin (role_id 2). Everyone else 403s — a conference is a live
 * conversation, not a report.
 */
async function loadForRequest(req, res) {
  const id = parseRowId(req.params.id);
  if (!id) {
    logger.warn('Conference request rejected · invalid conference id');
    modernError(res, 400, 'invalid conference id');
    return null;
  }
  const loaded = await conference.getConference(id, pool);
  if (!loaded.ok) {
    failureFor(res, loaded, 'Conference not found');
    return null;
  }
  const isOwner = loaded.conference.started_by_user_id != null
    && Number(loaded.conference.started_by_user_id) === Number(req.user.user_id);
  const isAdmin = Number(req.user.user_role) === 2; // role_id 2 = Admin (CLAUDE.md role model)
  if (!isOwner && !isAdmin) {
    logger.warn('Conference access denied · not owner/admin · conf=' + id + ' · user=' + req.user.user_id);
    modernError(res, 403, 'You can only manage conferences you started');
    return null;
  }
  return { id, conference: loaded.conference, participants: loaded.participants || [], live: loaded.live };
}

/* ═══════════════════ POST / — start a conference ════════════════════════
 *
 * DB-ONLY, and that is not an omission. The MPC does not exist until the
 * operator's leg answers and executes the <MultiPartyCall> answer XML — Plivo
 * materialises the room at that moment. So this writes the record, mints the
 * name Plivo will be addressed by, and hands both back; the operator leg is
 * placed through the EXISTING click-to-call path, whose answer_url returns
 * conference.operatorAnswerXml(friendlyName).
 *
 * Nothing here dials, so nothing here bills.
 */
router.post('/', requireAction(ACTION_CONFERENCE), validate(startConferenceBody), async (req, res, next) => {
  try {
    const { jobId } = req.body;
    const agent = req.user;
    logger.info('Start conference · jobId=' + (jobId ?? '—') + ' · by=' + agent.user_id);

    // Snapshot the job's state AT CONFERENCE TIME so "at which stage was this
    // escalated?" stays real history rather than a re-projection of today.
    let job = null;
    if (jobId) {
      job = await loadJob(jobId);
      if (!job) {
        logger.warn('Start conference rejected · job not found · jobId=' + jobId);
        return modernError(res, 404, `Job ${jobId} not found`);
      }
    }

    const result = await conference.createConference({
      jobId: job ? job.job_id : null,
      startedByUserId: agent.user_id,
      jobStatusSnap: job ? job.job_status : null,
      jobEfrIdSnap: job ? (job.fk_easyfixter_id || null) : null,
      // The operator's own leg is the tbl_plivo_call_log row the click-to-call
      // path already writes, so the service does NOT insert one here (that
      // would double-count it). These two are carried for the log line only,
      // and an operator without a profile mobile still gets a usable
      // conference.
      operatorNumber: agent.mobile_no || null,
      operatorName: agent.user_name || null,
    }, pool);

    if (!result.ok) {
      logger.warn('Start conference failed · code=' + result.code + ' · jobId=' + (jobId ?? '—'));
      return failureFor(res, result, 'Could not start the conference');
    }

    const roster = job ? await buildRoster(job.job_id, job) : { entries: [] };
    const participants = result.participants || [];
    logger.info('Conference started · id=' + result.conferenceId + ' · jobId=' + (jobId ?? '—') + ' · by=' + agent.user_id);

    return modernOk(res, {
      conferenceId: result.conferenceId,
      conference: result.conference ? conferenceDto(result.conference) : null,
      participants: participants.map(participantDto),
      roster: roster.entries.map((e) => rosterDto(e, participants)),
      // No `limits` block: there are no configurable caps (see the header).
      // Plivo's own account defaults are the provider ceiling, endMpcOnExit is
      // the product one, and neither is a number this API should publish as if
      // the FE could enforce it.
    });
  } catch (e) { next(e); }
});

/* ════════════════ GET /:id — live state (the poll target) ════════════════
 *
 * Serves the whole live panel: the conference, its legs, and the roster with
 * each row already flagged on_call — so the picker can grey out someone who is
 * already in the room instead of racing a duplicate add.
 *
 * Every number in this response is the masked 9988•••••• form. There is no
 * query parameter that unmasks it: `?unmasked=true` opts specific EDIT FORMS
 * out of the mobile mask elsewhere in the CRM, and a live call panel is not an
 * edit form.
 *
 * ─── THIS POLL IS NO LONGER DB-ONLY, AND THAT IS THE FIX ─────────────────
 *
 * It used to read only our own rows, which made the panel a mirror of the MPC
 * STATUS CALLBACK and nothing else. When a callback never arrived — an unset
 * callback base, a token Plivo could not reach, a dropped POST — every
 * participant sat on "Dialling" forever, through answer AND through hangup,
 * and no amount of polling could ever recover: nothing in the loop asked the
 * provider what was actually true. So each poll now reconciles against Plivo
 * first. The service self-throttles to at most one provider round-trip per
 * conference per 10s, so a 2-second poll is cheap by construction, and a
 * provider blip is logged and stepped over rather than 500ing the panel.
 */
router.get('/:id', requireAction(ACTION_CONFERENCE), async (req, res, next) => {
  try {
    let loaded = await loadForRequest(req, res);
    if (!loaded) return undefined;

    /*
     * AFTER authZ, never before: a reconcile is a provider round-trip, and a
     * caller who may not read this conference must not be able to spend one.
     * Re-read only when the reconcile actually MOVED something — `changed` is
     * exactly that signal, and a poll that changed nothing (the common case)
     * costs no second query.
     */
    try {
      const rec = await conference.reconcileParticipants(loaded.id, pool);
      if (rec && rec.changed) {
        const again = await conference.getConference(loaded.id, pool);
        if (again.ok) {
          loaded = {
            ...loaded,
            conference: again.conference,
            participants: again.participants || [],
            live: again.live,
          };
        }
      }
    } catch (e) {
      // Fail-soft, like every other provider touch in this router: stale DB
      // state is a worse panel, an unanswerable poll is a broken one.
      logger.warn('Conference reconcile skipped · conf=' + loaded.id + ' · ' + (e && e.message));
    }

    const roster = await buildRoster(loaded.conference.job_id);
    return modernOk(res, {
      conference: conferenceDto(loaded.conference),
      participants: loaded.participants.map(participantDto),
      roster: roster.entries.map((e) => rosterDto(e, loaded.participants)),
      // No `limits` — see POST / above and the header.
    });
  } catch (e) { next(e); }
});

/* ═════════ POST /:id/participants — add one party mid-call ═══════════════
 *
 * The endpoint the whole feature exists for, and the one with teeth.
 *
 * Order of checks is deliberate — cheapest and most authoritative first, so a
 * refusal never costs a provider round trip and never leaks which ids exist:
 *
 *   1. RBAC          isClickToCall (route middleware) — the same key as calling
 *   2. SCHEMA        exactly one target; a custom number is format-checked
 *   3. RATE LIMIT    custom arm only, per operator
 *   4. AuthZ         owner or Admin
 *   5. LIVE          a conference that has ended cannot gain a leg
 *   6. ROSTER        roster arm: the target must be ON THIS JOB
 *   7. the service   duplicate guard, insert-first leg row, then Plivo
 *
 * There is no participant CAP in that list any more, and its absence is the
 * only thing that changed: the duplicate guard remains, because it is a
 * CORRECTNESS guard (two clicks must not become two billed legs), not a limit.
 */
router.post(
  '/:id/participants',
  requireAction(ACTION_CONFERENCE),
  validate(conferenceParticipantBody),
  onlyForCustomNumber(customNumberLimiter),
  async (req, res, next) => {
    try {
      const loaded = await loadForRequest(req, res);
      if (!loaded) return undefined;
      const conf = loaded.conference;

      if (!loaded.live) {
        logger.warn('Add participant rejected · conference not live · conf=' + conf.id + ' · status=' + conf.status);
        return modernError(res, 400, `This call has already ended (${conf.status}).`);
      }

      let toNumber;
      let targetKind;
      let targetId = null;
      let displayName = null;

      if (req.body.customNumber) {
        // ── CUSTOM ARM ──────────────────────────────────────────────────
        // A second, higher-trust permission. Dialling someone already on the
        // job is ordinary ops work; dialling arbitrary digits from a company
        // line is not, so it is granted separately and to fewer people.
        toNumber = req.body.customNumber;
        targetKind = 'custom';
        displayName = req.body.displayName || 'Other Number';

        /*
         * AUDIT. For a roster add the target id is the record of what
         * happened; for a custom add the DIGITS are the only record, so the
         * leg row carries both dialed_number and caller_user_id (written by
         * the service, insert-first, BEFORE the leg is dialled).
         *
         * This log line is deliberately MASKED. The audit lives in the
         * database, where it is access-controlled; a full number in a log
         * stream would be the same leak this feature spends three mechanisms
         * preventing, just through a different pipe.
         */
        logger.info('Conference CUSTOM NUMBER add · conf=' + conf.id
          + ' · to=' + plivo.maskForDisplay(toNumber)
          + ' · by=' + req.user.user_id + '(' + (req.user.user_name || '?') + ')'
          + ' · job=' + (conf.job_id ?? '—'));
      } else {
        // ── ROSTER ARM ──────────────────────────────────────────────────
        if (!conf.job_id) {
          logger.warn('Roster add rejected · conference has no job · conf=' + conf.id);
          return modernError(res, 400, 'This call is not linked to a job, so there is no roster to add from.');
        }
        const roster = await buildRoster(conf.job_id);
        const entry = matchRosterEntry(req.body, roster.entries);
        if (!entry) {
          // 400, NOT 404, and the message names no id. "Not on this job" and
          // "does not exist" must look identical from outside or the endpoint
          // becomes a way to enumerate technicians and client contacts.
          logger.warn('Roster add rejected · target not on job · conf=' + conf.id + ' · job=' + conf.job_id
            + ' · body=' + JSON.stringify({ ...req.body, customNumber: undefined }));
          return modernError(res, 400, 'That person is not on this job — pick someone from the call roster.');
        }
        if (!entry.number) {
          return modernError(res, 400, `${entry.label} has no mobile number on file.`);
        }
        toNumber = entry.number;
        targetKind = entry.target_kind;
        targetId = entry.target_id;
        displayName = entry.name || entry.label;
      }

      const result = await conference.addParticipant({
        conferenceId: conf.id,
        toNumber,
        targetKind,
        targetId,
        addedByUserId: req.user.user_id,
        displayName,
        // Ties the leg back to the call-audit row the conference was started
        // from, so conference legs are joinable to job call history.
        jobCallerInfoId: conf.job_caller_info_id || null,
      }, pool);

      if (!result.ok) {
        logger.warn('Add participant failed · conf=' + conf.id + ' · kind=' + targetKind + ' · code=' + result.code);
        return failureFor(res, result, 'Could not add that person to the call');
      }

      logger.info('Conference participant added · conf=' + conf.id + ' · participant=' + result.participantId
        + ' · kind=' + targetKind + ' · by=' + req.user.user_id);
      return modernOk(res, {
        participantId: result.participantId,
        participant: result.participant ? participantDto(result.participant) : null,
        // The leg is DIALLING, not joined — the ring takes a few seconds and
        // the panel should poll GET /:id rather than assume success.
        message: `Calling ${displayName || 'them'} — they will join in a moment.`,
      });
    } catch (e) { next(e); }
  },
);

/* ═══ DELETE /:id/participants/:participantId — drop one party ════════════
 *
 * Kicks one leg and leaves the room running. Refuses the operator's own leg:
 * that leg carries endMpcOnExit, so dropping it would end the call for
 * everyone — POST /:id/end is that action, and it is named for what it does.
 */
router.delete('/:id/participants/:participantId', requireAction(ACTION_CONFERENCE), async (req, res, next) => {
  try {
    const loaded = await loadForRequest(req, res);
    if (!loaded) return undefined;

    const participantId = parseRowId(req.params.participantId);
    if (!participantId) {
      logger.warn('Drop participant rejected · invalid participant id');
      return modernError(res, 400, 'invalid participant id');
    }

    const target = loaded.participants.find((p) => Number(p.id) === Number(participantId));
    if (!target) {
      logger.warn('Drop participant rejected · not on this conference · conf=' + loaded.id + ' · participant=' + participantId);
      return modernError(res, 404, 'Participant not found on this call');
    }
    if (target.target_kind === 'operator') {
      return modernError(res, 400, 'You cannot drop your own leg — use End Call, which ends the conference for everyone.');
    }

    const result = await conference.removeParticipant({
      conferenceId: loaded.id,
      participantId,
    }, pool);

    if (!result.ok) {
      logger.warn('Drop participant failed · conf=' + loaded.id + ' · participant=' + participantId + ' · code=' + result.code);
      return failureFor(res, result, 'Could not drop that person from the call');
    }

    logger.info('Conference participant dropped · conf=' + loaded.id + ' · participant=' + participantId
      + ' · by=' + req.user.user_id + (result.alreadyGone ? ' (already gone)' : ''));
    return modernOk(res, {
      participantId,
      removed: true,
      alreadyGone: !!result.alreadyGone,
      message: result.alreadyGone ? 'They had already left the call.' : 'Removed from the call.',
    });
  } catch (e) { next(e); }
});

/* ══════════════ POST /:id/end — end it for everyone ══════════════════════
 *
 * The cost-safety endpoint an operator can reach. The service issues the
 * teardown and then READS THE CONFERENCE BACK rather than trusting the 2xx —
 * an orphaned conference bills every leg until PLIVO's own default ceiling
 * fires (we send none of our own), and "Plivo said 204" is not evidence it
 * stopped. If Plivo still reports the room, the row
 * stays live on purpose so the reaper retries, and this returns 502: telling
 * an operator "ended" while legs are still billing is the exact failure the
 * teardown exists to prevent.
 */
router.post('/:id/end', requireAction(ACTION_CONFERENCE), validate(endConferenceBody), async (req, res, next) => {
  try {
    const loaded = await loadForRequest(req, res);
    if (!loaded) return undefined;

    const result = await conference.endConference({
      conferenceId: loaded.id,
      // 'operator' is the only reason this route can honestly claim. The
      // others (reaper, last_left, api, error) are produced by the reaper and
      // the webhook, and 'reaper' in particular is the metric that says a cost
      // leak was caught — it must never be settable from outside.
      reason: 'operator',
    }, pool);

    if (!result.ok) {
      logger.warn('End conference failed · conf=' + loaded.id + ' · code=' + result.code);
      return failureFor(res, result, 'Could not end the conference');
    }

    logger.info('Conference ended by operator · conf=' + loaded.id + ' · by=' + req.user.user_id
      + ' · alreadyEnded=' + !!result.alreadyEnded + ' · verified=' + !!result.verified);
    return modernOk(res, {
      conferenceId: loaded.id,
      ended: true,
      alreadyEnded: !!result.alreadyEnded,
      // `verified` false means Plivo accepted the teardown but we could not
      // confirm the room is gone. Surfaced rather than hidden — the reaper will
      // try again, and ops deserves to know the difference.
      verified: result.verified !== false,
      duration: result.duration ?? null,
      message: result.alreadyEnded ? 'This call had already ended.' : 'Call ended for everyone.',
    });
  } catch (e) { next(e); }
});

module.exports = router;
