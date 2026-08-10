'use strict';

/*
 * Plivo Multi-Party Call (MPC) — ops conference calling.
 *
 * ─── WHY EVERY OPS CALL IS NOW A CONFERENCE ──────────────────────────────
 *
 * Ops needs to pull a second or third person into a LIVE call. Plivo cannot
 * promote a live <Dial> into a conference: <Dial> and MPC are different
 * objects with no conversion API. Starting plain and "upgrading" would mean
 * hang up and redial — exactly the experience the feature exists to remove.
 *
 * So every ops call starts as an MPC carrying ONE participant. Ops sees no
 * difference: click Call, it rings, they talk. The word "conference" never
 * appears until they add someone. Because the operator leg is already an MPC
 * participant, "add someone" is one POST away at any moment.
 *
 * Concretely, this replaces ONE line of the existing bridge. Today
 * routes/public/plivo-answer.js returns
 *     <Response><Dial callerId=…><Number>{customer}</Number></Dial></Response>
 * and instead it returns operatorAnswerXml(friendlyName) — the operator enters
 * the room, and the receiver is then ADDED to it via addParticipant().
 *
 * ─── A PARTICIPANT IS A CALL LEG, NOT A NEW KIND OF THING ────────────────
 *
 * There is ONE new table, tbl_job_conference, and it records the ROOM. The
 * participants live in tbl_plivo_call_log — the table that already records
 * every Plivo leg — carrying the SAME job_caller_info_id as the operator's leg
 * plus a conference_id and a participant_role. Consequences worth stating out
 * loud, because they are the point:
 *
 *   • tbl_job_caller_info still gets exactly ONE row per call. A conference is
 *     one call that gained people. Inflating that table would have inflated
 *     every existing call-count report on the platform.
 *   • Every surface that already reads tbl_plivo_call_log — the Calls list, the
 *     per-job call-history tooltip, recording playback, transcription, call
 *     analysis — sees conference legs by construction, labelled by role.
 *   • All leg SQL lives in services/plivo-call-log.service.js. This file owns
 *     the PROVIDER; that file owns the STORAGE.
 *
 * ─── NO FEATURE FLAG, AND NO CONFIGURABLE LIMITS ─────────────────────────
 *
 * conferenceEnabled() is the EXISTING `plivo.calling.enabled` property and no
 * property of its own. Off ⇒ calls route to Kaleyra, which is
 * post-call-report-only, has no live surface, and therefore no conferences.
 *
 * It ALSO requires the callback base + token secret to be configured. That is
 * not a second flag — it is a correctness gate on a room whose entire UI state
 * arrives over the status callback (see conferenceEnabled below). Nothing in
 * easyfix_properties turns it on or off.
 *
 * There are also NO `plivo.conference.max.*` cost knobs. An earlier draft had
 * three (duration / participants / concurrent) and sent two of them to Plivo on
 * every leg. They are gone — and gone does NOT mean unlimited: it means
 * PLIVO'S OWN DEFAULTS APPLY, which is the correct place for a provider ceiling
 * to live. What remains as the cost guard:
 *
 *   1. endMpcOnExit="true" on the operator's leg — the operator hanging up ends
 *      the room for everyone. This is the PRIMARY guard and it is a product
 *      decision, not a configurable limit.
 *   2. services/conference-reaper-cron.js — now the ONLY backstop for a room
 *      nobody hung up. Its ceiling is an INTERNAL constant in that file: a leak
 *      DETECTOR, deliberately not a property, because ops must not have to
 *      configure a safety net.
 *   3. ringTimeoutSec() — KEPT, and not a limit on the conference at all: it is
 *      how long an unanswered participant rings. Every dialler needs one.
 *
 * ─── SEPARATION ──────────────────────────────────────────────────────────
 *
 * Sibling to plivo.service.js, the way plivo-ai-call.service.js is: that file
 * is untouched, and this one reuses only its shared helpers
 * (normaliseIndianPhone, maskForDisplay, callingEnabled). DB rows are written
 * through an INJECTED pool so the whole module is testable against the
 * fake-pool harness without a database.
 *
 * ─── FAIL-SOFT / FAIL-LOUD ───────────────────────────────────────────────
 *
 * Nothing here throws at the caller. Every function returns a discriminated
 * result object ({ ok:true, … } | { ok:false, code, … }) so a conference
 * failure can never break the underlying call or 500 a request that already
 * committed a row. But every non-2xx from Plivo is logged with BOTH the HTTP
 * status AND the response body — a wrong wire shape must be obvious in the
 * logs on the first call, not a mystery three weeks later.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const logger = require('../logger');
const { getProperty } = require('./properties.service');
const { normaliseIndianPhone, maskForDisplay, callingEnabled } = require('./plivo.service');
const legs = require('./plivo-call-log.service');

/* ══════════════════════════════════════════════════════════════════════════
 * ⚠⚠  UNVERIFIED PLIVO MPC WIRE SHAPES — THE ONLY PLACE THEY LIVE  ⚠⚠
 * ══════════════════════════════════════════════════════════════════════════
 *
 * EVERYTHING in this block came from Plivo's DOCUMENTATION, not from a live
 * account. Nobody has run a real 3-leg conference on this Plivo account. No
 * other file in this repo may encode an MPC path, parameter name or response
 * key — if a shape turns out wrong, this block is the only edit.
 *
 * ── THE FIRST-SPIKE CHECKLIST ────────────────────────────────────────────
 * Run one throwaway 3-leg conference and confirm, in this order. Each item
 * names the constant below that encodes the assumption:
 *
 *  1. ADD-PARTICIPANT RESPONSE SHAPE  → RESP.memberId / RESP.callUuid
 *     Two different shapes appear in Plivo's own docs:
 *        { api_id, call_uuid, member_id, message }
 *        { api_id, calls: [{ to, from, call_uuid }], message, request_uuid }
 *     readAddParticipantResponse() below accepts BOTH and logs the raw body
 *     when it recognises NEITHER. Check the log line
 *     "Plivo MPC add-participant UNRECOGNISED RESPONSE SHAPE" on the first
 *     spike; if it fires, paste the body into RESP and delete the fallback.
 *
 *  2. `name_` PREFIX  → PATHS.*
 *     Plivo's docs are internally inconsistent: the per-participant Record
 *     endpoints omit the `name_` prefix while every other endpoint has it.
 *     We use `name_` everywhere (we do not call Record). Confirm a 404 does
 *     not come back from the plain participant endpoints.
 *
 *  3. `Participant/` vs `Member/`  → PATHS.participant / PATHS.participantOne
 *     Plivo's Play endpoint uses .../Member/{id}/ while mute/hold/kick use
 *     .../Participant/{id}/. We only use Participant/. Confirm DELETE
 *     .../Participant/{member_id}/ really returns 204.
 *
 *  4. member_id vs call_uuid  → conference_member_id vs call_uuid on the leg
 *     They are DIFFERENT identifiers, which is why tbl_plivo_call_log needed a
 *     column of its own for the member id. The member id is the one in the URL
 *     for update/remove. Confirm which one the ParticipantJoin webhook's
 *     MemberID carries, and that it matches what add-participant returned.
 *
 *  5. stayAlone  → XML.stayAlone
 *     ⚠ THE ONE MOST LIKELY TO BITE. Plivo's default is stayAlone=false,
 *     meaning a participant left ALONE in the room is REMOVED. Our operator
 *     is alone for the second or two between entering the room and the
 *     receiver being added — with the default they would be dropped instantly
 *     and every ops call would break. We send stayAlone="true". CONFIRM THE
 *     OPERATOR SURVIVES ALONE FOR 30 SECONDS before anyone else joins.
 *
 *  6. <MultiPartyCall> XML ATTRIBUTE CASING  → XML.*
 *     The REST API takes snake_case (end_mpc_on_exit); the XML element is
 *     documented in camelCase (endMpcOnExit). We encode both, separately,
 *     below. If the operator XML is rejected, Plivo hangs the call up SILENTLY
 *     (an unparseable <Response> behaves like an empty one) — so the symptom is
 *     "the call connects then dies", not an error. Test the XML before anything
 *     else.
 *
 *  7. IS AN MPC LEG BILLED LIKE A NORMAL LEG?  → not encoded here; ASK PLIVO.
 *     Load-bearing, because there is no feature flag: an MPC surcharge would
 *     apply to 100% of ops calls, not just the ones that become conferences.
 *     It is MORE load-bearing now that we send no max_duration of our own — see
 *     the ceiling note below.
 *
 *  8. friendly_name CHARSET/LENGTH  → newFriendlyName()
 *     We generate lowercase alphanumerics only, ≤32 chars. Plivo does not
 *     document the constraint. Confirm it accepts ours.
 *
 *  9. DELETE-then-read-back  → fetchConference()
 *     We prefer READING the conference back over trusting the 204, because
 *     this codebase has twice been burned by a 2xx that meant nothing (the
 *     <Dial record="true"> attribute that silently recorded nothing for
 *     months; the Plivo recording NULL). Confirm whether GET after DELETE
 *     returns the ended object or a 404 — we treat BOTH as ended.
 *
 * 10. ⚠ PLIVO'S OWN DEFAULT max_duration / max_participants → NOT SENT.
 *     We deliberately no longer send either, on the XML element or on an
 *     add-participant request, so the provider's account defaults apply. FIND
 *     OUT WHAT THEY ARE on the first spike and write them down — "the ceiling
 *     lives with the provider" is only a good decision if somebody knows what
 *     the provider's ceiling is. The reaper is the backstop either way.
 *
 * 11. WHAT WE COULD NOT VERIFY EVEN IN PRINCIPLE:
 *     • the MPC does not exist until the operator's answer XML is executed,
 *       so createConference() has NOTHING to read back. A conference row in
 *       status 'creating' is an assertion, not an observation. The reaper
 *       treats 'creating' as billable for exactly that reason.
 *     • whether a lost MPCStart webhook leaves Plivo's own view 'Active'
 *       while ours says 'creating' — reconcile via fetchConference().
 * ══════════════════════════════════════════════════════════════════════════
 */

const BASE = (process.env.PLIVO_BASE_URL || 'https://api.plivo.com/v1').replace(/\/+$/, '');

// Same 8s ceiling plivo.service.js uses for its read paths. Applied to EVERY
// MPC call, including the writes: an add-participant that hangs would hold an
// ops request open while a leg is already being billed.
const MPC_HTTP_TIMEOUT_MS = 8000;

// ── URL paths. `name_{friendlyName}` is Plivo's "address me by my name, not
// by the uuid I have not told you yet" convention, and it is why we can build
// the operator's answer XML before the MPC exists.
const PATHS = {
  mpc: (authId, name) =>
    `${BASE}/Account/${encodeURIComponent(authId)}/MultiPartyCall/name_${encodeURIComponent(name)}/`,
  participants: (authId, name) =>
    `${BASE}/Account/${encodeURIComponent(authId)}/MultiPartyCall/name_${encodeURIComponent(name)}/Participant/`,
  participantOne: (authId, name, memberId) =>
    `${BASE}/Account/${encodeURIComponent(authId)}/MultiPartyCall/name_${encodeURIComponent(name)}/Participant/${encodeURIComponent(memberId)}/`,
};

// ── Request bodies. snake_case, per the REST API.
const REQ = {
  /*
   * POST .../Participant/  — dials a NEW leg into the room.
   *
   * ⚠ NEITHER max_duration NOR max_participants IS SENT. That is the owner
   * decision, not an oversight: PLIVO'S OWN DEFAULTS APPLY. The ceiling for a
   * provider belongs with the provider — duplicating it here meant two numbers
   * that could drift, and ops having to tune a spend cap they never asked for.
   * The guards that remain are end_mpc_on_exit on the operator (see below),
   * ring_timeout on each leg, and the reaper.
   */
  addParticipant: ({ role, from, to, callerName, endMpcOnExit, statusCallbackUrl, ringTimeoutSec }) => {
    const body = {
      role,                                   // agent | customer | supervisor  (IMMUTABLE once set)
      from,                                   // our Plivo DID
      to,                                     // the party being dialled
      ring_timeout: ringTimeoutSec,           // how long an unanswered leg rings — a DIALLER setting
      end_mpc_on_exit: !!endMpcOnExit,        // only ever true for the OPERATOR
      stay_alone: true,                       // see checklist item 5
      start_mpc_on_enter: true,
      create_mpc_with_single_participant: true,
    };
    /*
     * ⚠ CAPPED AT 50. Plivo documents caller_name as a SIP-endpoint display
     * name and its own SDK asserts 1-50 characters; we build this body by hand
     * and pass a PSTN callee's display name straight through, so an unusually
     * long receiver_name would come back as a 400 and mark a leg 'failed' for a
     * cosmetic reason. Truncating on the wire is the whole fix — the field is
     * what labels the added party, so it is not dropped.
     */
    if (callerName) body.caller_name = String(callerName).slice(0, 50);
    if (statusCallbackUrl) {
      body.status_callback_url = statusCallbackUrl;
      // DELIBERATE, and absent from Plivo's REST parameter list — do not delete
      // it on that evidence. Our webhook reads req.body; Plivo's default for a
      // status callback is GET, which carries no body at all, so dropping this
      // line silently reproduces exactly the "stuck on Dialling" failure.
      body.status_callback_method = 'POST';
      body.status_callback_events = STATUS_CALLBACK_EVENTS;
    }
    return body;
  },
};

// The event classes we subscribe to. Deliberately NOT the speak/digit/audio
// classes — they fire constantly and we have nothing to do with them.
const STATUS_CALLBACK_EVENTS = 'mpc-state-changes,participant-state-changes,add-participant-api-events';

// ── Response readers. Every assumption about what Plivo SENDS BACK is here.
const RESP = {
  // Both documented shapes, in preference order. Returns { memberId, callUuid }
  // with nulls for anything absent — never throws on a surprising body.
  addParticipant: (json) => {
    if (!json || typeof json !== 'object') return { memberId: null, callUuid: null, recognised: false };
    // Shape A: { api_id, call_uuid, member_id, message }
    if (json.member_id != null || json.call_uuid != null) {
      return {
        memberId: json.member_id != null ? String(json.member_id) : null,
        callUuid: json.call_uuid != null ? String(json.call_uuid) : null,
        recognised: true,
      };
    }
    // Shape B: { api_id, calls: [{ to, from, call_uuid }], message, request_uuid }
    if (Array.isArray(json.calls) && json.calls.length) {
      const c = json.calls[0] || {};
      return {
        memberId: c.member_id != null ? String(c.member_id) : null,
        callUuid: c.call_uuid != null ? String(c.call_uuid) : (json.request_uuid != null ? String(json.request_uuid) : null),
        recognised: true,
      };
    }
    return { memberId: null, callUuid: null, recognised: false };
  },
  // GET .../Participant/  — documented as { api_id, objects: [ … ] }. We also
  // accept a bare array and a `data` key, because a list endpoint returning a
  // differently-named collection is the single cheapest thing to get wrong.
  participantList: (json) => {
    if (Array.isArray(json)) return json;
    if (json && Array.isArray(json.objects)) return json.objects;
    if (json && Array.isArray(json.data)) return json.data;
    return [];
  },
  /*
   * One participant object out of that list. `member_id` / `call_uuid` per docs,
   * AND THOSE ARE THE ONLY TWO WE MATCH ON.
   *
   * ⚠ THERE WAS A THIRD, participantTo(), reading p.to ?? p.number ??
   * p.destination. A Plivo Participant object has NO such field — the reader
   * therefore returned '' for every participant, every read-back comparison
   * ''.endsWith(digits) was false, the member id was never recovered, and every
   * later Remove From Call 409'd member_id_unknown. Deleted 2026-08-07. Do not
   * re-add it: matching a room's legs on a phone number is also wrong on its own
   * terms, because QA redirects several targets to one test number.
   */
  participantMemberId: (p) => (p && (p.member_id != null ? String(p.member_id) : (p.memberId != null ? String(p.memberId) : null))),
  participantCallUuid: (p) => (p && (p.call_uuid != null ? String(p.call_uuid) : (p.callUuid != null ? String(p.callUuid) : null))),
  // GET .../MultiPartyCall/name_{x}/ — the conference object.
  conferenceUuid: (json) => (json && (json.mpc_uuid ?? json.multi_party_call_uuid ?? json.uuid)) || null,
  conferenceStatus: (json) => String((json && (json.status ?? json.mpc_status)) || '').toLowerCase() || null,
};

/*
 * ── The <MultiPartyCall> XML element. camelCase attributes, per the XML docs
 * (the REST API's snake_case above is a SEPARATE spelling of the same knobs —
 * checklist item 6). The MPC NAME is the element's TEXT CONTENT.
 *
 * ⚠ THERE IS NO maxDuration AND NO maxParticipants HERE. Removed on purpose so
 * Plivo's own defaults apply. endMpcOnExit is what replaced them as the primary
 * cost guard, and unlike them it is not a number anybody can tune to zero.
 */
const XML = {
  role: 'agent',
  stayAlone: 'true',            // checklist item 5 — non-negotiable for a lone operator
  startMpcOnEnter: 'true',
  endMpcOnExit: 'true',         // OPERATOR ONLY: the operator leaving ends the call for everyone
  enterSound: 'beep:1',         // audible when someone is added mid-call — deliberate, consent-adjacent
  exitSound: 'none',
  statusCallbackMethod: 'POST',
  statusCallbackEvents: STATUS_CALLBACK_EVENTS,
};

/* ═══════════════════════ end unverified block ═══════════════════════════ */

// Statuses that still cost money. The reaper keys off these, so they are
// defined once.
const LIVE_CONFERENCE_STATUSES = ['creating', 'live', 'ending'];

/*
 * The leg vocabulary is tbl_plivo_call_log's OWN
 * (initiated/ringing/answered/completed/no_answer/failed), re-exported here so
 * the routes and the MPC webhook have one import for the whole conference
 * vocabulary. It is NOT a conference-specific enum — that is the point: a
 * conference leg has to read like every other Plivo leg on every surface that
 * already reads that table.
 */
const LEG_STATUS = legs.LEG_STATUS;
const ACTIVE_PARTICIPANT_STATUSES = legs.ACTIVE_LEG_STATUSES;

/*
 * The room's own columns. No max_participants / max_duration_sec (no caps are
 * sent to Plivo any more, so there is nothing to snapshot) and no
 * participant_count / peak_participants (a stored counter four writers moved
 * and nothing needed — the live count is DERIVED from the legs, which cannot
 * drift from the legs it counts).
 */
const CONF_COLUMNS = [
  'id', 'job_id', 'friendly_name', 'mpc_uuid', 'provider', 'started_by_user_id',
  'job_caller_info_id', 'job_status_snap', 'job_efr_id_snap', 'status',
  'started_on', 'ended_on', 'duration', 'billed_leg_seconds', 'end_reason', 'error',
  'created_on', 'updated_on',
].join(', ');

// ───────────────────────────── config ──────────────────────────────────────

/*
 * THE operational switch is still `plivo.calling.enabled` and there is still no
 * conference property — plivo.callingEnabled() is reused verbatim rather than
 * read again, so the two can never drift.
 *
 * THE TWO ENV CHECKS BESIDE IT ARE NOT A FLAG, THEY ARE A CORRECTNESS GATE.
 * A conference is the only call shape here whose UI state comes back ENTIRELY
 * over the MPC status callback: without a reachable callback base and a secret
 * to sign the callback token with, we can mint a room, bill every leg in it, and
 * never learn a single thing about it — participants freeze on "Dialling"
 * through answer and through hangup, and the cost is unobservable. Refusing is
 * strictly better than that, because refusing is not a refusal to CALL: both
 * callers (routes/admin/calls.js /click-to-call and /web-start) already fail
 * soft here, log "falling back to the classic bridge", and leave conferenceName
 * null — the answer routes then take the untouched <Dial> path. So a
 * misconfigured deployment loses Add To Call and keeps ordinary calling, which
 * is the outcome we want and the opposite of what it had.
 */
let _gateReported = false;
function conferenceEnabled() {
  if (!callingEnabled()) return false;
  if (callbackBase() && tokenSecret()) return true;
  /*
   * ONCE PER PROCESS, and at ERROR. The callers' fail-soft is silent when the
   * gate is shut (their warn only fires when createConference REFUSES, and a
   * shut gate means it is never called), so without this line the whole feature
   * would just quietly not be there — which is the invisibility that turned one
   * unset variable into an incident. Latched, because this is read on every call
   * and a per-call error would be noise rather than a signal.
   */
  if (!_gateReported) {
    _gateReported = true;
    logger.error('✗ Conference calling is UNAVAILABLE despite plivo.calling.enabled — ops calls will use the'
      + ' classic bridge and Add To Call will do nothing.'
      + ` Missing: ${[!callbackBase() && 'PLIVO_CALLBACK_BASE_URL (or PUBLIC_API_BASE_URL)',
        !tokenSecret() && 'PLIVO_ANSWER_TOKEN_SECRET (or JWT_SECRET)'].filter(Boolean).join(' and ')}.`
      + ' A room we cannot be called back about is a room whose UI can never move and whose cost we cannot see.');
  }
  return false;
}

function intProperty(key, fallback, min, max) {
  const raw = getProperty(key);
  const n = Number.parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/*
 * How long an UNANSWERED participant rings before Plivo gives up on that leg.
 *
 * This is the one dialler setting that survived the removal of the cost knobs,
 * and it is not a limit on the conference: it bounds a RINGING phone, not a
 * running room. Every dialler in this codebase has one.
 */
function ringTimeoutSec() {
  return intProperty('plivo.conference.ring.timeout.sec', 45, 15, 120);
}

function authHeader() {
  const id = process.env.PLIVO_AUTH_ID;
  const token = process.env.PLIVO_AUTH_TOKEN;
  if (!id || !token) return null;
  return 'Basic ' + Buffer.from(`${id}:${token}`).toString('base64');
}

function callbackBase() {
  return (process.env.PLIVO_CALLBACK_BASE_URL || process.env.PUBLIC_API_BASE_URL || '').replace(/\/+$/, '');
}

function tokenSecret() {
  return process.env.PLIVO_ANSWER_TOKEN_SECRET || process.env.JWT_SECRET;
}

// ───────────────────────── callback tokens ─────────────────────────────────

const CONF_TOKEN_TTL_SEC = 6 * 60 * 60; // a long call may still be reporting hours later

/*
 * The signed `t` IS the authorisation on the conference webhooks, exactly as
 * it is on the existing /api/webhook/plivo/* routes. It carries the conference
 * id so a callback self-identifies its row without us trusting a provider id
 * we were handed. `kind:'conf'` mirrors the existing `kind:'rec'` recording
 * token so a token minted for one purpose cannot be replayed at another.
 */
function signConferenceToken({ confId, friendlyName }) {
  return jwt.sign({ kind: 'conf', confId, conf: friendlyName }, tokenSecret(), { expiresIn: CONF_TOKEN_TTL_SEC });
}

function verifyConferenceToken(t) {
  try {
    const claims = jwt.verify(t, tokenSecret());
    return claims && claims.kind === 'conf' ? claims : null;
  } catch {
    return null;
  }
}

/*
 * Returns null rather than throwing when the callback base or the token secret
 * is unset. A misconfigured deployment must lose STATUS UPDATES, not the call:
 * an exception here would propagate out of addParticipant() and break a leg
 * that was about to connect fine.
 *
 * BUT IT SAYS SO AT ERROR, LOUDLY, ON BOTH BRANCHES. The missing-base branch
 * used to return null in silence, and silence is what turned a one-line env
 * omission into an incident: the room was created, the legs were dialled and
 * billed, and every participant sat on "Dialling" forever because no status
 * ever came back. conferenceEnabled() now refuses the room outright for the
 * same reason — this log is what tells whoever is reading the logs WHY.
 */
function statusCallbackUrl({ confId, friendlyName }) {
  const base = callbackBase();
  if (!base) {
    logger.error('✗ Conference status callbacks CANNOT WORK — no public callback base is configured'
      + ' (set PLIVO_CALLBACK_BASE_URL, or PUBLIC_API_BASE_URL, to this backend\'s public https URL).'
      + ' Consequence: Plivo has nowhere to report participant state, so every participant freezes at'
      + ' "Dialling" through answer AND through hangup, and the room bills unobserved.');
    return null;
  }
  if (!tokenSecret()) {
    logger.warn('⚠ Conference status callback disabled — neither PLIVO_ANSWER_TOKEN_SECRET nor JWT_SECRET is set');
    return null;
  }
  try {
    const t = signConferenceToken({ confId, friendlyName });
    return `${base}/api/webhook/plivo-conference/status?t=${encodeURIComponent(t)}`;
  } catch (e) {
    logger.warn('⚠ Conference status callback token could not be signed · ' + e.message);
    return null;
  }
}

// ───────────────────────────── helpers ─────────────────────────────────────

// Lowercase alphanumerics only, ≤32 chars — safe in a URL path segment and in
// whatever charset Plivo turns out to accept (checklist item 8). Generated
// BEFORE the row is inserted so the name can be baked into the operator's
// answer XML, which has to exist before the MPC does.
function newFriendlyName() {
  return 'efxc' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function xmlAttr(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function xmlText(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function nowIst() {
  // tbl_job_conference columns only. The pool's +05:30 session timezone stores
  // this wall clock verbatim. Never NOW() here — that is the UTC server clock
  // and would mix two timezones into one column. (tbl_plivo_call_log is the
  // mirror image: it is NOW()-written throughout, and the leg helpers keep it
  // that way — see the clock note in plivo-call-log.service.js.)
  return new Date();
}

function shortBody(text) {
  return String(text || '').slice(0, 500).replace(/\s+/g, ' ');
}

// Plivo MPC roles are immutable once set, so the mapping is fixed here rather
// than left to callers.
function roleForTargetKind(kind) {
  return (kind === 'customer' || kind === 'customer_alt') ? 'customer' : 'agent';
}

// ───────────────────────── the HTTP chokepoint ─────────────────────────────

/*
 * EVERY MPC request goes through here, so there is exactly one place that
 * knows how a Plivo failure looks and exactly one place that logs it.
 *
 * Logs BOTH the status and the body on any non-2xx — the fail-loud precedent
 * from plivo.service.js:306-308. A wrong wire shape must be obvious in the
 * logs on the first call.
 */
async function mpcRequest(op, method, url, body, { expect404 = false } = {}) {
  const auth = authHeader();
  if (!auth || !process.env.PLIVO_AUTH_ID) {
    logger.warn(`✗ Plivo MPC ${op} SKIPPED · PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN not configured`);
    return { ok: false, code: 'not_configured', httpStatus: 0, text: '', json: null, error: 'PLIVO_AUTH_ID / PLIVO_AUTH_TOKEN not configured' };
  }
  const init = {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(MPC_HTTP_TIMEOUT_MS),
  };
  if (body !== undefined && body !== null) init.body = JSON.stringify(body);

  let res;
  let text = '';
  try {
    res = await fetch(url, init);
    text = await res.text();
  } catch (e) {
    // Network / timeout. Loud, and specific about which operation died.
    logger.error(`✗ Plivo MPC ${op} NETWORK ERROR · ${method} ${url} · ${e.message}`);
    return { ok: false, code: 'network_error', httpStatus: 0, text: '', json: null, error: e.message };
  }

  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave null — logged below if it mattered */ }

  const ok = res.status >= 200 && res.status < 300;
  // A 404 on a teardown means "already gone", which is the outcome we wanted.
  // Logging it as a FAIL would train ops to ignore the one line that matters.
  const expected404 = expect404 && res.status === 404;
  if (!ok && !expected404) {
    // status AND body, always. This is the line that turns an unverified wire
    // shape into a five-minute diagnosis instead of a three-week mystery.
    logger.warn(`✗ Plivo MPC ${op} FAIL · http=${res.status} · ${method} ${url} · body=${shortBody(text)}`);
  } else if (expected404) {
    logger.debug(`Plivo MPC ${op} · 404 (already gone) · ${method} ${url}`);
  } else {
    logger.debug(`Plivo MPC ${op} ok · http=${res.status} · body=${shortBody(text)}`);
  }
  return { ok, code: ok ? null : 'provider_error', httpStatus: res.status, text, json, error: ok ? null : `HTTP ${res.status}` };
}

// ───────────────────────── provider read-backs ─────────────────────────────

/*
 * Read the conference back from Plivo. PREFERRED over inferring state from a
 * 2xx: this codebase has been burned twice by an acknowledgement that meant
 * nothing (<Dial record="true"> silently recording nothing for months, and the
 * Plivo recording NULL). A 404 here means the MPC is gone, which for our
 * purposes is the same as ended.
 */
async function fetchConference(friendlyName) {
  const url = PATHS.mpc(process.env.PLIVO_AUTH_ID, friendlyName);
  const r = await mpcRequest('get-conference', 'GET', url, undefined, { expect404: true });
  if (r.httpStatus === 404) return { ok: true, found: false, mpcUuid: null, status: 'ended', httpStatus: 404 };
  if (!r.ok) return { ok: false, found: false, code: r.code, httpStatus: r.httpStatus, body: shortBody(r.text) };
  return {
    ok: true,
    found: true,
    mpcUuid: RESP.conferenceUuid(r.json),
    status: RESP.conferenceStatus(r.json),
    httpStatus: r.httpStatus,
    raw: r.json,
  };
}

/*
 * List the live participants Plivo thinks are in the room. Two uses:
 *   1. the member-id fallback when add-participant's response shape surprises
 *      us (checklist item 1) — READ the id rather than guess it;
 *   2. reconciliation when a status webhook is lost.
 */
async function listParticipants(friendlyName) {
  const url = PATHS.participants(process.env.PLIVO_AUTH_ID, friendlyName);
  const r = await mpcRequest('list-participants', 'GET', url);
  if (!r.ok) return { ok: false, code: r.code, httpStatus: r.httpStatus, body: shortBody(r.text), participants: [] };
  return { ok: true, httpStatus: r.httpStatus, participants: RESP.participantList(r.json) };
}

// ───────────────────────── the operator's XML ──────────────────────────────

/*
 * The call-control XML the OPERATOR's leg gets when they answer. This is the
 * one line that replaces <Dial> in routes/public/plivo-answer.js.
 *
 * endMpcOnExit="true" IS THE PRIMARY COST GUARD, and it is a deliberate PRODUCT
 * decision rather than a technicality: the operator leaving ends the conference
 * for everyone. The alternative — a conference with no one running it, billing
 * every remaining leg — is the worst failure mode this feature has. The UI must
 * say so out loud.
 *
 * It matters MORE now than it did in the first draft, because there is no
 * maxDuration attribute beside it any more: Plivo's own default is the
 * provider-side ceiling, this attribute is the product-side one, and the reaper
 * is the backstop for a room that somehow outlives both.
 *
 * `opts` is optional so the documented one-argument call still works.
 */
function operatorAnswerXml(friendlyName, opts = {}) {
  const name = String(friendlyName || '').trim();
  const attrs = [
    `role="${xmlAttr(opts.role || XML.role)}"`,
    `stayAlone="${xmlAttr(XML.stayAlone)}"`,
    `startMpcOnEnter="${xmlAttr(XML.startMpcOnEnter)}"`,
    `endMpcOnExit="${xmlAttr(opts.endMpcOnExit === false ? 'false' : XML.endMpcOnExit)}"`,
    `enterSound="${xmlAttr(opts.enterSound || XML.enterSound)}"`,
    `exitSound="${xmlAttr(opts.exitSound || XML.exitSound)}"`,
  ];
  const cbUrl = opts.statusCallbackUrl
    || (opts.confId ? statusCallbackUrl({ confId: opts.confId, friendlyName: name }) : null);
  if (cbUrl) {
    attrs.push(`statusCallbackUrl="${xmlAttr(cbUrl)}"`);
    // DELIBERATE. Plivo documents statusCallbackMethod as defaulting to GET on
    // this element, and the webhook that consumes it reads req.body — a GET
    // callback would arrive empty and every participant would freeze mid-dial.
    // It is a documented default, not a redundant attribute: do not remove it.
    attrs.push(`statusCallbackMethod="${xmlAttr(XML.statusCallbackMethod)}"`);
    attrs.push(`statusCallbackEvents="${xmlAttr(XML.statusCallbackEvents)}"`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response><MultiPartyCall ${attrs.join(' ')}>${xmlText(name)}</MultiPartyCall></Response>`;
}

// ─────────────────────────── DB: create ────────────────────────────────────

/*
 * createConference({ jobId, startedByUserId, … }, pool)
 *
 * DB-ONLY, and that is the important part: the MPC does not exist yet. Plivo
 * materialises it when the operator's leg answers and executes
 * operatorAnswerXml(). So this writes the room row, mints the name, and hands
 * both back — the caller then places the operator leg through the EXISTING
 * plivo.clickToCall() path with an answer_url that returns our XML.
 *
 * ⚠ IT DOES NOT WRITE A PARTICIPANT ROW. The operator's leg is a
 * tbl_plivo_call_log row written by the click-to-call path itself
 * (plivoLog.record), so writing one here would DUPLICATE it. The caller should
 * pass `conference_id` + `participant_role: 'operator'` into that record()
 * call; if it does not, adoptOperatorLeg() labels the same row the first time a
 * second participant is added. `operatorNumber` / `operatorName` are still
 * accepted so the existing call signature keeps working, and are used only for
 * the log line.
 *
 * There is NO concurrency cap any more — the three cost knobs are gone (see the
 * module header). What stops a runaway is endMpcOnExit plus the reaper.
 *
 * Consequence, stated plainly because it is a real gap: there is nothing to
 * read back here. A row in status 'creating' is an assertion, not an
 * observation, which is exactly why the reaper treats 'creating' as billable.
 *
 * Returns { ok:true, conferenceId, friendlyName, conference, participants }
 *       | { ok:false, code, message }.
 */
async function createConference({
  jobId = null,
  startedByUserId = null,
  jobCallerInfoId = null,
  jobStatusSnap = null,
  jobEfrIdSnap = null,
  /*
   * Accepted and deliberately UNUSED. It stopped being needed when the operator
   * stopped getting a participant row of their own here — their leg is written
   * by the answer route, so writing one at create time double-counted them.
   * Kept in the signature (underscored so lint agrees it is intentional) because
   * both callers still pass it and dropping it would be a silent contract change
   * on a call site nobody would re-check.
   */
  operatorNumber: _operatorNumber = null,
  operatorName = null,
} = {}, pool) {
  if (!pool) return { ok: false, code: 'no_pool', message: 'createConference requires a pool' };
  if (!conferenceEnabled()) {
    // The message no longer names only the property: the gate is also shut when
    // we have no callback base or token secret, and the caller logs this string.
    return { ok: false, code: 'disabled', message: 'conference calling is not available (see conferenceEnabled)' };
  }

  const friendlyName = newFriendlyName();
  const now = nowIst();

  let conferenceId;
  try {
    const [res] = await pool.query(
      `INSERT INTO tbl_job_conference
         (job_id, friendly_name, provider, started_by_user_id, job_caller_info_id,
          job_status_snap, job_efr_id_snap, status, created_on)
       VALUES (?, ?, 'plivo', ?, ?, ?, ?, 'creating', ?)`,
      [jobId, friendlyName, startedByUserId, jobCallerInfoId, jobStatusSnap, jobEfrIdSnap, now],
    );
    conferenceId = res && res.insertId;
  } catch (e) {
    logger.error('✗ Conference row insert failed · ' + e.message);
    return { ok: false, code: 'db_error', message: 'Could not create the conference record' };
  }

  /*
   * Label the operator's own call-log leg, IF it exists yet. On the normal
   * click-to-call path it does not (the conference is minted before the log row
   * is written), so this is a no-op and the caller's record() carries the two
   * columns instead. It is here so the ORDER of those two writes stops
   * mattering — a caller that logs first is labelled immediately, a caller that
   * logs after is labelled by the first addParticipant().
   */
  if (jobCallerInfoId != null) await legs.adoptOperatorLeg(conferenceId, jobCallerInfoId, pool);

  logger.info(`🧾 Conference created · id=${conferenceId} · name=${friendlyName} · job=${jobId ?? '-'}`
    + ` · by=${startedByUserId ?? '-'}${operatorName ? ' (' + operatorName + ')' : ''}`
    + ` · jci=${jobCallerInfoId ?? '-'} · ceiling=Plivo defaults + endMpcOnExit + reaper`);
  const loaded = await getConference(conferenceId, pool);
  return {
    ok: true,
    conferenceId,
    friendlyName,
    conference: loaded.ok ? loaded.conference : null,
    participants: loaded.ok ? loaded.participants : [],
  };
}

// ───────────────────────── DB + Plivo: add ─────────────────────────────────

/*
 * addParticipant({ conferenceId, toNumber, targetKind, targetId, addedByUserId }, pool)
 *
 * `toNumber` is the SERVER-RESOLVED destination. The caller resolves a target
 * IDENTIFIER to digits (routes/admin/calls.js:resolveReceiver) and passes them
 * here; the browser never sends and never receives them.
 *
 * INSERT-FIRST, exactly like POST /click-to-call: the leg's tbl_plivo_call_log
 * row exists before the leg is dialled, so a leg can never be billed without a
 * row naming who caused it. On a provider failure the row is stamped 'failed' —
 * it is not deleted, because "we tried to dial this person and Plivo refused"
 * is the interesting fact.
 *
 * The new leg carries the SAME job_caller_info_id as the operator's, so a
 * 3-party conference is ONE call with THREE legs — one row in
 * tbl_job_caller_info, three in tbl_plivo_call_log. Nothing that counts calls
 * changes; everything that shows leg detail gains two rows.
 *
 * There is NO participant cap. The duplicate guard remains (it is a
 * correctness guard, not a limit — two clicks must not become two billed legs).
 *
 * Returns { ok:true, participant } | { ok:false, code, message, httpStatus?, body? }.
 * Codes: no_pool | disabled | not_found | conference_not_live | invalid_number
 *      | duplicate | not_configured | db_error | provider_error | network_error
 */
async function addParticipant({
  conferenceId,
  toNumber,
  targetKind,
  targetId = null,
  addedByUserId = null,
  displayName = null,
  role = null,
  jobCallerInfoId = null,
} = {}, pool) {
  if (!pool) return { ok: false, code: 'no_pool', message: 'addParticipant requires a pool' };
  if (!conferenceEnabled()) return { ok: false, code: 'disabled', message: 'conference calling is not available (see conferenceEnabled)' };
  if (!process.env.PLIVO_CALLER_ID) return { ok: false, code: 'not_configured', message: 'PLIVO_CALLER_ID not configured' };

  const digits = normaliseIndianPhone(toNumber);
  if (!digits) return { ok: false, code: 'invalid_number', message: `invalid destination phone "${toNumber}"` };

  const conf = await loadConferenceRow(conferenceId, pool);
  if (!conf) return { ok: false, code: 'not_found', message: 'Conference not found' };
  if (!LIVE_CONFERENCE_STATUSES.includes(conf.status)) {
    return { ok: false, code: 'conference_not_live', message: `Conference is ${conf.status}` };
  }
  if (conf.status === 'creating') {
    // Allowed, not refused: 'live' depends on the MPCStart webhook arriving,
    // and refusing here would make add-participant unusable whenever one is
    // lost. But say so, because if this line is common the webhook is broken.
    logger.warn(`⚠ Adding a participant to conference ${conf.id} still in 'creating' — MPCStart may not have arrived`);
  }

  // Make sure the operator's own leg is labelled before we add a second one, so
  // the roster and every call-history surface show a complete room rather than
  // one anonymous leg and one technician.
  const jci = jobCallerInfoId != null ? jobCallerInfoId : (conf.job_caller_info_id || null);
  if (jci != null) await legs.adoptOperatorLeg(conf.id, jci, pool);

  const plivoRole = role || roleForTargetKind(targetKind);

  /*
   * INSERT-FIRST, with the duplicate guard INSIDE the statement. Two
   * simultaneous clicks both reach here; the NOT EXISTS lets exactly one row
   * through and the loser gets a clean 'duplicate' instead of a second BILLED
   * leg. A deliberate re-add after someone dropped is allowed, because their
   * previous row is terminal.
   */
  const ins = await legs.insertConferenceLeg({
    conferenceId: conf.id,
    jobCallerInfoId: jci,
    jobId: conf.job_id || null,
    role: targetKind,
    targetId,
    displayName,
    dialedNumber: digits,
    receiverNumber: digits,
    /*
     * WHO caused this leg. routes/public/plivo-answer.js adds the receiver
     * without an addedByUserId (it is a provider callback, not a user request),
     * so fall back to whoever started the room — otherwise the leg that IS the
     * call would be the only one in the Calls list with no operator against it.
     */
    callerUserId: addedByUserId != null ? addedByUserId : (conf.started_by_user_id || null),
    callFlow: 'conference',
  }, pool);

  if (!ins.ok) {
    if (ins.code === 'duplicate') {
      return { ok: false, code: 'duplicate', message: 'That person is already on this call.' };
    }
    return { ok: false, code: 'db_error', message: 'Could not record the participant' };
  }
  const participantId = ins.id;

  // ── Now dial. Everything above this line is reversible; below it, money.
  const body = REQ.addParticipant({
    role: plivoRole,
    from: process.env.PLIVO_CALLER_ID,
    to: digits,
    callerName: displayName || undefined,
    ringTimeoutSec: ringTimeoutSec(),
    endMpcOnExit: false,                       // ONLY the operator ends the room
    statusCallbackUrl: statusCallbackUrl({ confId: conf.id, friendlyName: conf.friendly_name }),
  });

  const masked = maskForDisplay(digits);
  logger.info(`📡 Conference add-participant · conf=${conf.id} · kind=${targetKind} · to=${masked} · role=${plivoRole} · by=${addedByUserId ?? '-'}`);
  const r = await mpcRequest('add-participant', 'POST', PATHS.participants(process.env.PLIVO_AUTH_ID, conf.friendly_name), body);

  if (!r.ok) {
    await legs.markConferenceLegFailed(participantId, `http=${r.httpStatus} ${shortBody(r.text)}`, pool);
    return { ok: false, code: r.code || 'provider_error', message: 'The provider refused this participant', httpStatus: r.httpStatus, body: shortBody(r.text), participantId };
  }

  // 2xx is NOT the end state. Pull the ids out of whichever documented shape
  // arrived; if NEITHER matched, say so loudly and READ the room back rather
  // than shrug — an add we cannot identify is an add we cannot later kick.
  let { memberId, callUuid, recognised } = RESP.addParticipant(r.json);
  if (!recognised) {
    logger.warn(`⚠ Plivo MPC add-participant UNRECOGNISED RESPONSE SHAPE · conf=${conf.id} · http=${r.httpStatus} · body=${shortBody(r.text)} — see the UNVERIFIED block in services/plivo-conference.service.js, checklist item 1`);
  }
  if (!memberId) {
    /*
     * Read the room back and find OUR leg BY call_uuid — the only identifier
     * both sides hold. (This used to compare the participant's `to` number,
     * which the Participant object does not have, so it matched nothing ever.)
     * With no call_uuid either, there is nothing to correlate on and we wait for
     * ParticipantJoin or for reconcileParticipants() to catch it.
     */
    const list = callUuid ? await listParticipants(conf.friendly_name) : { ok: false, participants: [] };
    if (list.ok) {
      const match = list.participants.find((p) => RESP.participantCallUuid(p) === String(callUuid));
      if (match) {
        memberId = RESP.participantMemberId(match) || memberId;
        logger.info(`Conference member id recovered by read-back · conf=${conf.id} · member=${memberId}`);
      } else {
        logger.warn(`⚠ Conference read-back found no leg for ${masked} · conf=${conf.id} · participants=${list.participants.length}`);
      }
    }
  }
  if (!memberId) {
    // Not a failure — the leg IS dialling — but it cannot be muted or kicked
    // until a ParticipantJoin webhook supplies the id. Name it.
    logger.warn(`⚠ Participant ${participantId} has no member_id yet · conf=${conf.id} — mute/drop unavailable until ParticipantJoin arrives`);
  }

  await legs.stampConferenceLegIds(participantId, { memberId, callUuid }, pool);

  const participant = await legs.getConferenceLeg(participantId, pool);
  return {
    ok: true,
    participantId,
    memberId: memberId || null,
    callUuid: callUuid || null,
    participant: participant ? decorateLeg(participant) : null,
    httpStatus: r.httpStatus,
  };
}

// ───────────────────────── DB + Plivo: remove ──────────────────────────────

/*
 * removeParticipant({ conferenceId, participantId }, pool)
 *
 * Kicks ONE leg. `participantId` is a tbl_plivo_call_log.id — the leg row.
 * DELETE .../Participant/{member_id}/ is documented as 204. A 404 means Plivo
 * has already lost the member — which is the outcome we wanted, so it is
 * treated as success rather than retried forever.
 *
 * Returns { ok:true, alreadyGone? } | { ok:false, code, … }.
 * Codes: no_pool | not_found | member_id_unknown | not_configured
 *      | provider_error | network_error | db_error
 */
async function removeParticipant({ conferenceId, participantId } = {}, pool) {
  if (!pool) return { ok: false, code: 'no_pool', message: 'removeParticipant requires a pool' };

  const conf = await loadConferenceRow(conferenceId, pool);
  if (!conf) return { ok: false, code: 'not_found', message: 'Conference not found' };

  const p = await legs.loadConferenceLegForControl(participantId, conf.id, pool);
  if (!p) return { ok: false, code: 'not_found', message: 'Participant not found on this conference' };
  if (!ACTIVE_PARTICIPANT_STATUSES.includes(p.status)) {
    return { ok: true, alreadyGone: true, message: `Participant is already ${p.status}` };
  }

  let memberId = p.member_id;
  if (!memberId) {
    /*
     * Prefer READING the id over failing: the ParticipantJoin webhook may not
     * have arrived, but Plivo still knows who is in the room. Correlate on
     * call_uuid — the leg's own id, and the only field the Participant object
     * shares with our row. (Matching on the dialled number, which is what this
     * did until 2026-08-07, could not work: see RESP.participantMemberId.)
     * loadConferenceLegForControl does not project call_uuid, so take it from
     * the masked public projection, which aliases it as participant_uuid.
     */
    const own = await legs.getConferenceLeg(p.id, pool);
    const uuid = own && own.participant_uuid ? String(own.participant_uuid) : null;
    if (uuid) {
      const list = await listParticipants(conf.friendly_name);
      if (list.ok) {
        const match = list.participants.find((x) => RESP.participantCallUuid(x) === uuid);
        if (match) memberId = RESP.participantMemberId(match);
      }
    }
    if (memberId) await legs.stampConferenceLegIds(p.id, { memberId }, pool);
  }
  if (!memberId) {
    logger.warn(`⚠ Cannot drop participant ${p.id} · conf=${conf.id} · no member_id and read-back found none`);
    return { ok: false, code: 'member_id_unknown', message: 'This participant cannot be dropped yet — they have not fully joined.' };
  }

  const r = await mpcRequest('remove-participant', 'DELETE', PATHS.participantOne(process.env.PLIVO_AUTH_ID, conf.friendly_name, memberId), undefined, { expect404: true });
  const gone = r.ok || r.httpStatus === 404;
  if (!gone) {
    return { ok: false, code: r.code || 'provider_error', message: 'The provider refused to drop this participant', httpStatus: r.httpStatus, body: shortBody(r.text) };
  }

  await legs.markConferenceLegStatus(p.id, {
    status: LEG_STATUS.REMOVED,
    endedOn: true,
    hangupCause: 'removed_by_operator',
  }, pool);

  logger.info(`📡 Conference participant dropped · conf=${conf.id} · participant=${p.id} · member=${memberId}${r.httpStatus === 404 ? ' (already gone)' : ''}`);
  return { ok: true, alreadyGone: r.httpStatus === 404, httpStatus: r.httpStatus };
}

// ───────────────────────── DB + Plivo: end ─────────────────────────────────

/*
 * endConference({ conferenceId, reason }, pool)
 *
 * The cost-safety endpoint. DELETE .../MultiPartyCall/name_{x}/ is documented
 * as 204; we then READ THE CONFERENCE BACK rather than trust it, because an
 * orphaned conference bills every leg and "Plivo said 204" is not evidence it
 * stopped.
 *
 * CRITICAL: on a provider failure the row is NOT marked ended. It stays live
 * so the reaper tries again. Marking it ended on a failed teardown would hide
 * exactly the leak this function exists to stop.
 *
 * `reason` ∈ operator | last_left | reaper | max_duration | api | error.
 * Returns { ok:true, alreadyEnded? } | { ok:false, code, … }.
 */
async function endConference({ conferenceId, reason = 'api' } = {}, pool) {
  if (!pool) return { ok: false, code: 'no_pool', message: 'endConference requires a pool' };

  const conf = await loadConferenceRow(conferenceId, pool);
  if (!conf) return { ok: false, code: 'not_found', message: 'Conference not found' };
  if (!LIVE_CONFERENCE_STATUSES.includes(conf.status)) {
    return { ok: true, alreadyEnded: true, message: `Conference is already ${conf.status}` };
  }

  await safeQuery(pool, 'mark conference ending',
    `UPDATE tbl_job_conference SET status = 'ending', updated_on = ? WHERE id = ? AND status IN (?, ?)`,
    [nowIst(), conf.id, 'creating', 'live']);

  const r = await mpcRequest('end-conference', 'DELETE', PATHS.mpc(process.env.PLIVO_AUTH_ID, conf.friendly_name));

  // A 404 means the MPC is already gone — the desired end state, reached
  // without us. Anything else non-2xx, we verify by reading rather than guess.
  let torndown = r.ok || r.httpStatus === 404;
  let verified = r.httpStatus === 404;
  if (r.ok) {
    const back = await fetchConference(conf.friendly_name);
    if (back.ok && (!back.found || back.status === 'ended' || back.status === 'completed')) {
      verified = true;
    } else if (back.ok && back.found) {
      // Plivo accepted the DELETE but still reports the room. Do NOT declare
      // victory — leave it live for the reaper and say so.
      logger.warn(`⚠ Conference ${conf.id} still reported as '${back.status}' by Plivo AFTER a 2xx DELETE · name=${conf.friendly_name} — see UNVERIFIED checklist item 9`);
      torndown = false;
    }
  }

  if (!torndown) {
    await safeQuery(pool, 'revert conference to live',
      `UPDATE tbl_job_conference SET status = 'live', error = ?, updated_on = ? WHERE id = ? AND status = 'ending'`,
      [`end failed http=${r.httpStatus}`.slice(0, 255), nowIst(), conf.id]);
    return { ok: false, code: r.code || 'provider_error', message: 'The provider did not end this conference', httpStatus: r.httpStatus, body: shortBody(r.text) };
  }

  const now = nowIst();
  const startedAt = conf.started_on ? new Date(conf.started_on) : (conf.created_on ? new Date(conf.created_on) : null);
  const duration = startedAt ? Math.max(0, Math.round((now.getTime() - startedAt.getTime()) / 1000)) : null;

  await safeQuery(pool, 'mark conference ended',
    `UPDATE tbl_job_conference
        SET status = 'ended', ended_on = ?, duration = COALESCE(duration, ?), end_reason = COALESCE(end_reason, ?),
            updated_on = ?
      WHERE id = ?`,
    [now, duration, reason, now, conf.id]);
  await legs.closeConferenceLegs(conf.id, { status: LEG_STATUS.LEFT }, pool);

  logger.info(`🧾 Conference ended · id=${conf.id} · name=${conf.friendly_name} · reason=${reason} · duration=${duration ?? '-'}s · verified=${verified}`);
  return { ok: true, verified, httpStatus: r.httpStatus, duration, endReason: reason };
}

// ────────────────────── reconciliation (webhook-free) ──────────────────────

/*
 * Plivo's own word for a room that is still running. We only close legs Plivo
 * omits while it says this — an 'ended' or absent MPC tells us the room is over,
 * not which leg left, and endConference()/the reaper already own that path.
 */
const PROVIDER_RUNNING_STATUSES = ['active', 'live'];

/*
 * ONE provider round-trip per conference per 10 seconds, and this is
 * LOAD-BEARING rather than tidy: the live-state poll behind the call panel runs
 * about every 2 seconds, per open viewer. Unthrottled, one watched call would
 * put ~60 MPC reads a minute onto Plivo and a second viewer would double it.
 * The throttle is the only thing between a polling UI and a rate limiter.
 */
const RECONCILE_MIN_INTERVAL_MS = 10000;
const _lastReconcileMs = new Map();

/*
 * How long a room Plivo does not have is given the benefit of the doubt when we
 * have no terminal leg to judge by. Only reached when the conference row has no
 * legs at all (its leg write failed) — the ordinary path decides on leg state,
 * not the clock. Comfortably longer than a browser leg takes to connect.
 */
const ABSENT_ROOM_GRACE_MS = 20000;

/*
 * reconcileParticipants(conferenceId, pool) → { ok, changed, code? }
 *
 * ⚠ THIS IS WHAT MAKES PARTICIPANT STATUS CORRECT WHEN THE WEBHOOK NEVER COMES,
 * which is the situation this feature actually shipped into. The status callback
 * is the fast path and the ONLY path we had: statusCallbackUrl() returned null
 * in silence on a missing callback base, both consumers dropped the field just
 * as silently, and the live poll read nothing but our own database — so a
 * callback that never arrived could never be recovered from, and every
 * participant stayed on "Dialling" through answer and through hangup. Reading
 * Plivo back is the recovery: a lost callback now costs one poll of latency
 * instead of the whole call's UI.
 *
 * Deliberately NOT a repair of everything. It promotes legs Plivo still reports
 * in the room, closes active legs Plivo no longer reports, and fills in provider
 * ids we are missing (which is also what un-breaks Remove From Call). It does
 * not end rooms and it does not touch tbl_job_conference — the reaper owns the
 * room's own lifecycle, and two writers on one state machine is how this kind of
 * thing starts drifting.
 *
 * NEVER THROWS. Every failure is a code: no_pool | not_found | throttled
 *   | provider_error | network_error | error.
 */
async function reconcileParticipants(conferenceId, pool) {
  if (!pool) return { ok: false, changed: 0, code: 'no_pool' };
  try {
    const conf = await loadConferenceRow(conferenceId, pool);
    if (!conf) return { ok: false, changed: 0, code: 'not_found' };
    // A terminal room has nothing left to reconcile — whoever ended it closed
    // its legs in the same breath.
    if (!LIVE_CONFERENCE_STATUSES.includes(conf.status)) return { ok: true, changed: 0 };

    const key = String(conf.id);
    const now = Date.now();
    // Bound the map: a long-lived process must not accumulate one entry per
    // conference it has ever seen. Anything a full sweep-window old is dead.
    for (const [k, ts] of _lastReconcileMs) {
      if (now - ts > RECONCILE_MIN_INTERVAL_MS * 10) _lastReconcileMs.delete(k);
    }
    const last = _lastReconcileMs.get(key);
    if (last != null && now - last < RECONCILE_MIN_INTERVAL_MS) {
      return { ok: true, changed: 0, code: 'throttled' };
    }
    _lastReconcileMs.set(key, now);

    const room = await fetchConference(conf.friendly_name);
    if (!room.ok) return { ok: false, changed: 0, code: room.code || 'provider_error' };

    /*
     * ── THE ROOM IS NOT THERE ────────────────────────────────────────────
     *
     * fetchConference maps a 404 to found:false. Two things follow, and the
     * first version of this function did neither.
     *
     * 1. DO NOT LIST ITS PARTICIPANTS. A room Plivo has never heard of has no
     *    roster, so the call is guaranteed to 404 as well — and because it is a
     *    write-path helper it logs that 404 at WARN. Off a 2-second poll behind
     *    a panel nobody closed, that produced a permanent pair of provider
     *    round-trips and a WARN every ten seconds, for a room that will never
     *    exist. The 404 already told us everything the roster could.
     *
     * 2. IT MAY BE AUTHORITATIVE, and if it is, say so. The MPC is materialised
     *    by the OPERATOR's answer XML — so when the operator's leg dies at
     *    signalling (Plivo never routed it, no answer_url, no room), our row
     *    sits in 'creating' forever while the panel reports a live call with
     *    nobody on it and offers to end a conference that was never born.
     *
     * The safe reading of a 404 is "not yet OR never", and the discriminator is
     * our own legs: while ANY leg is still active something may yet arrive, so
     * we leave it alone. Once every leg is terminal and the room is absent,
     * there is nothing left that could create it.
     *
     * The extra clause is for the empty case — a conference row whose leg write
     * failed has no legs at all, and "zero active" is trivially true from the
     * first millisecond. Requiring either an observed terminal leg or a little
     * age keeps a brand-new room from being retired out from under a browser
     * that is still dialling.
     *
     * This DOES write tbl_job_conference, which the header above reserves to the
     * reaper, and that narrowing is deliberate: the reaper sweeps every 5
     * minutes behind a grace of ring-timeout + 300s, so it would be six to
     * eleven minutes before it agreed — with the panel asserting a live call
     * throughout. One writer for the lifecycle is a good rule; a UI that lies
     * for ten minutes is a worse outcome than the exception.
     */
    if (!room.found) {
      const allLegs = await legs.listConferenceLegs(conf.id, pool);
      const active = allLegs.filter((l) => ACTIVE_PARTICIPANT_STATUSES.includes(l.status));
      const sawTerminalLeg = allLegs.length > active.length;
      const ageMs = conf.created_on ? (Date.now() - new Date(conf.created_on).getTime()) : Infinity;
      if (active.length || !(sawTerminalLeg || ageMs > ABSENT_ROOM_GRACE_MS)) {
        return { ok: true, changed: 0, code: 'room_absent' };
      }
      const now = nowIst();
      await safeQuery(pool, 'retire a conference the provider never had',
        `UPDATE tbl_job_conference
            SET status = 'ended', ended_on = COALESCE(ended_on, ?),
                end_reason = COALESCE(end_reason, ?), updated_on = ?
          WHERE id = ? AND status IN (?, ?, ?)`,
        [now, 'never_materialised', now, conf.id, ...LIVE_CONFERENCE_STATUSES]);
      logger.info(`🧾 Conference retired — Plivo has no such room and every leg is terminal · id=${conf.id}`
        + ` · name=${conf.friendly_name} · legs=${allLegs.length}`
        + ' — the operator leg almost certainly never reached the answer URL');
      return { ok: true, changed: 1, code: 'never_materialised' };
    }

    const list = await listParticipants(conf.friendly_name);
    if (!list.ok) return { ok: false, changed: 0, code: list.code || 'provider_error' };

    /*
     * Index Plivo's view by BOTH ids, and match on those two ONLY. Never on the
     * phone number: the Participant object has no number field to match against
     * (see RESP.participantMemberId), and in QA several targets redirect to one
     * test number, so a digits match would confuse two legs for each other.
     */
    const byUuid = new Map();
    const byMember = new Map();
    for (const p of list.participants) {
      const u = RESP.participantCallUuid(p);
      if (u) byUuid.set(u, p);
      const m = RESP.participantMemberId(p);
      if (m) byMember.set(m, p);
    }
    const roomRunning = room.found && PROVIDER_RUNNING_STATUSES.includes(String(room.status || ''));

    let changed = 0;
    for (const leg of await legs.listConferenceLegs(conf.id, pool)) {
      if (!ACTIVE_PARTICIPANT_STATUSES.includes(leg.status)) continue;
      const uuid = leg.participant_uuid ? String(leg.participant_uuid) : null;
      const member = leg.member_id ? String(leg.member_id) : null;
      const inRoom = (uuid && byUuid.get(uuid)) || (member && byMember.get(member)) || null;

      if (inRoom) {
        /*
         * Fill ONLY what we are missing. markConferenceLegStatus writes these
         * through COALESCE(?, col), which guards a NULL column and not a NULL
         * parameter — passing an id we already hold would overwrite it, so a
         * gap-fill has to be an explicit null when there is no gap.
         */
        const fillMember = member ? null : RESP.participantMemberId(inRoom);
        const fillUuid = uuid ? null : RESP.participantCallUuid(inRoom);
        if (leg.status !== LEG_STATUS.JOINED) {
          changed += await legs.markConferenceLegStatus(leg.id, {
            status: LEG_STATUS.JOINED,
            from: [LEG_STATUS.DIALLING, LEG_STATUS.RINGING],
            answeredOn: true,
            memberId: fillMember,
            callUuid: fillUuid,
          }, pool);
        } else if (fillMember || fillUuid) {
          // Answered, but short of the member id the kick URL is built from —
          // the exact state that made Remove From Call 409. Same status in and
          // out; this write exists purely to land the id.
          changed += await legs.markConferenceLegStatus(leg.id, {
            status: leg.status,
            from: [leg.status],
            memberId: fillMember,
            callUuid: fillUuid,
          }, pool);
        }
        continue;
      }

      // Absent from Plivo's roster. Only meaningful while the room is RUNNING.
      if (!roomRunning) continue;
      /*
       * And only for a leg Plivo has acknowledged at least once. A leg with
       * neither id may simply have been inserted a moment ago and not yet be
       * dialling — closing it here would be inventing a hangup. The reaper's
       * stuck-leg sweep is what eventually retires one that never got an id.
       */
      if (!uuid && !member) continue;
      changed += await legs.markConferenceLegStatus(leg.id, {
        status: LEG_STATUS.LEFT,
        from: ACTIVE_PARTICIPANT_STATUSES,
        endedOn: true,
        hangupCause: 'reconciled_absent',
      }, pool);
    }

    // Log ONLY when something moved. This runs off a 2-second poll; a line per
    // no-op run would bury the one line that means anything.
    if (changed) {
      logger.info(`🔁 Conference reconciled against Plivo · conf=${conf.id} · legs updated=${changed}`
        + ` · mpc=${room.found ? (room.status || '?') : 'gone'} · reported=${list.participants.length}`);
    }
    return { ok: true, changed };
  } catch (e) {
    logger.warn(`⚠ Conference reconcile failed · conf=${conferenceId} · ${e.message}`);
    return { ok: false, changed: 0, code: 'error' };
  }
}

// ───────────────────────────── DB: read ────────────────────────────────────

async function loadConferenceRow(conferenceId, pool) {
  const id = Number.parseInt(conferenceId, 10);
  if (!Number.isFinite(id) || id <= 0) return null;
  try {
    const [rows] = await pool.query(`SELECT ${CONF_COLUMNS} FROM tbl_job_conference WHERE id = ? LIMIT 1`, [id]);
    return (rows && rows[0]) || null;
  } catch (e) {
    logger.warn('⚠ Conference load failed · id=' + conferenceId + ' · ' + e.message);
    return null;
  }
}

/*
 * Add the two derived fields a leg row cannot store: the Plivo `role` (fixed by
 * the target kind, never chosen by a caller) and `active`. Everything else the
 * callers read is already aliased into the participant vocabulary by
 * plivo-call-log.service.js::LEG_PUBLIC_COLUMNS.
 */
function decorateLeg(leg) {
  if (!leg) return leg;
  return {
    ...leg,
    role: roleForTargetKind(leg.target_kind),
    active: ACTIVE_PARTICIPANT_STATUSES.includes(leg.status),
  };
}

/*
 * getConference(conferenceId, pool) — the poll target.
 *
 * ⚠ NUMBERS ARE MASKED, STRUCTURALLY. The leg projection selects neither
 * `dialed_number` nor `receiver_number`; only the first four digits leave the
 * database, and `masked_number` (9812••••••) is rebuilt from them. The
 * customer's mobile is masked for staff and this is one of the places that has
 * to stay true — do not add a whole-number column to LEG_PUBLIC_COLUMNS.
 *
 * `participant_count` is DERIVED here from the legs just loaded, not stored. A
 * counter column that four writers incremented and decremented was a counter
 * that drifted; counting the rows we are already returning cannot.
 *
 * Returns { ok:true, conference, participants, live } | { ok:false, code }.
 */
async function getConference(conferenceId, pool) {
  if (!pool) return { ok: false, code: 'no_pool', message: 'getConference requires a pool' };
  const row = await loadConferenceRow(conferenceId, pool);
  if (!row) return { ok: false, code: 'not_found', message: 'Conference not found' };
  const participants = (await legs.listConferenceLegs(row.id, pool)).map(decorateLeg);
  const conference = { ...row, participant_count: participants.filter((p) => p.active).length };
  return { ok: true, conference, participants, live: LIVE_CONFERENCE_STATUSES.includes(row.status) };
}

/*
 * Resolve a conference by the name Plivo knows it by. The status webhooks
 * carry MPCName, so this is how a callback finds its row when the signed
 * token is the authorisation but the name is the correlation.
 */
async function getConferenceByFriendlyName(friendlyName, pool) {
  if (!pool) return { ok: false, code: 'no_pool' };
  try {
    const [rows] = await pool.query(
      `SELECT ${CONF_COLUMNS} FROM tbl_job_conference WHERE friendly_name = ? LIMIT 1`,
      [String(friendlyName || '')],
    );
    const conference = (rows && rows[0]) || null;
    return conference ? { ok: true, conference } : { ok: false, code: 'not_found' };
  } catch (e) {
    logger.warn('⚠ Conference lookup by name failed · ' + e.message);
    return { ok: false, code: 'db_error' };
  }
}

/*
 * The reaper's query. Conferences that are still billable and started longer
 * ago than the caller's ceiling.
 *
 * ⚠ THE CEILING IS THE CALLER'S, AND THERE IS NO DEFAULT. It used to be derived
 * from a `plivo.conference.max.duration.sec` property; that property is gone,
 * and the only ceiling left in the system is the LEAK-DETECTOR constant inside
 * services/conference-reaper-cron.js. Falling back to a number invented here
 * would quietly re-create a second, competing ceiling — the exact drift the
 * property removal was meant to end. So an absent or nonsensical ceiling is a
 * refusal, loudly.
 *
 * COALESCE(started_on, created_on) is deliberate: 'creating' rows have no
 * started_on because the MPCStart webhook never arrived, and those are exactly
 * the ones most likely to be leaking. Bounded by a hard LIMIT, like
 * recording-backfill, so one sweep can never fan out unboundedly.
 *
 * ⚠ THE CUTOFF IS COMPUTED IN JS, NOT AS `NOW() - INTERVAL n SECOND`. These
 * columns hold the IST wall clock (app-written new Date() + the pool's +05:30
 * session timezone), while NOW() is whatever zone the DB server is in. A JS-side
 * Date compares IST to IST verbatim and depends on no server clock zone at all.
 * (The opposite rule applies to the LEG sweep, whose column is NOW()-written —
 * see listStuckConferenceLegs in plivo-call-log.service.js. The clock a
 * comparison uses must be the clock the column was written in.)
 */
async function listStaleConferences({ olderThanSec, limit = 50 } = {}, pool) {
  if (!pool) return { ok: false, code: 'no_pool', conferences: [] };
  const ceiling = Number(olderThanSec);
  if (!Number.isFinite(ceiling) || ceiling <= 0) {
    logger.warn('⚠ listStaleConferences called with no ceiling — refusing to invent one'
      + ' (the only ceiling is the leak-detector constant in services/conference-reaper-cron.js)');
    return { ok: false, code: 'no_ceiling', conferences: [] };
  }
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const cutoff = new Date(Date.now() - ceiling * 1000);
  try {
    const [rows] = await pool.query(
      `SELECT ${CONF_COLUMNS} FROM tbl_job_conference
        WHERE status IN (?, ?, ?)
          AND COALESCE(started_on, created_on) < ?
        ORDER BY id ASC
        LIMIT ?`,
      [...LIVE_CONFERENCE_STATUSES, cutoff, lim],
    );
    return { ok: true, ceilingSec: ceiling, cutoff, conferences: rows || [] };
  } catch (e) {
    logger.warn('⚠ Stale-conference sweep failed · ' + e.message);
    return { ok: false, code: 'db_error', conferences: [] };
  }
}

// Fire-and-forget DB write. Every status stamp in this module is best-effort:
// a failed UPDATE must never break a call that is already connected.
async function safeQuery(pool, what, sql, params) {
  try {
    await pool.query(sql, params);
    return true;
  } catch (e) {
    logger.warn(`⚠ Conference DB write failed (${what}) · ${e.message}`);
    return false;
  }
}

module.exports = {
  // gate (the EXISTING plivo.calling.enabled + a callback we can be reached on
  // — there is no conference flag, and the env checks are not one)
  conferenceEnabled,
  // the one dialler setting that survived (NOT a conference limit)
  ringTimeoutSec,
  // lifecycle
  createConference,
  addParticipant,
  removeParticipant,
  endConference,
  // reads
  getConference,
  getConferenceByFriendlyName,
  listStaleConferences,
  // call control
  operatorAnswerXml,
  // provider read-backs (reconciliation)
  fetchConference,
  listParticipants,
  reconcileParticipants,
  // webhook auth
  signConferenceToken,
  verifyConferenceToken,
  statusCallbackUrl,
  // leg storage — re-exported so callers have ONE import for the vocabulary
  legs,
  decorateLeg,
  // exported for tests / callers that need the vocabulary
  newFriendlyName,
  roleForTargetKind,
  LIVE_CONFERENCE_STATUSES,
  ACTIVE_PARTICIPANT_STATUSES,
  LEG_STATUS,
  STATUS_CALLBACK_EVENTS,
};
