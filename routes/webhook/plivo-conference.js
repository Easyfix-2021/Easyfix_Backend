'use strict';

const router = require('express').Router();
const logger = require('../../logger');
const { pool } = require('../../db');
const conf = require('../../services/plivo-conference.service');
const { maskForDisplay } = require('../../services/plivo.service');

/*
 * Plivo Multi-Party Call (MPC) status callbacks (Plivo → us).
 * Mounted at /api/webhook/plivo-conference.
 *
 *   POST /status  ← the statusCallbackUrl minted by
 *                   services/plivo-conference.service.js::statusCallbackUrl()
 *
 * ─── AUTH: THE SIGNED `t`, EXACTLY AS routes/webhook/plivo.js DOES IT ─────
 *
 * There is no JWT/Basic check and no new auth scheme. The `t` query token —
 * minted per conference by signConferenceToken({ confId, friendlyName }) and
 * carrying kind:'conf' — IS the authorisation. It self-identifies WHICH
 * tbl_job_conference row a callback belongs to, so we never have to trust a
 * provider-supplied id to decide what to write. An invalid/expired token is a
 * 200 no-op (never a non-200) so Plivo does not retry-storm us.
 *
 * Body parsing: Plivo posts application/x-www-form-urlencoded; the global
 * express.urlencoded() in server.js already populates req.body for this group,
 * same as the sibling routes/webhook/plivo.js. No per-router parser.
 *
 * ─── FAIL-SOFT ───────────────────────────────────────────────────────────
 *
 * Every write is best-effort. A conference callback that cannot be applied
 * must never break a call that is already connected, and must never 500 —
 * everything is logged server-side and answered 200.
 *
 * ─── WHERE A PARTICIPANT LIVES, AND THE TWO CLOCKS ───────────────────────
 *
 * A conference participant is NOT a row in a table of its own — it is a LEG,
 * i.e. another tbl_plivo_call_log row carrying the same job_caller_info_id as
 * the operator's plus a conference_id and a participant_role. So every
 * participant write below goes through services/plivo-call-log.service.js
 * (re-exported as conf.legs), which owns that table's SQL. This file owns the
 * CALLBACK SHAPES and the tbl_job_conference row; it writes no leg SQL of its
 * own.
 *
 * Two consequences worth stating, because both used to be code here:
 *
 *   • THE LEG STATUSES ARE THE CALL LOG'S OWN — initiated / ringing / answered
 *     / completed / no_answer / failed, spelled through conf.LEG_STATUS and
 *     never as literals. Writing 'joined'/'left' would leave a conference leg
 *     unreadable to GET /api/admin/calls, the per-job call-history tooltip and
 *     every other surface that already renders a Plivo leg — which is the whole
 *     point of storing it there.
 *   • THERE IS NO participant_count TO MOVE. The live count is DERIVED from
 *     these very rows, so closing one IS the decrement; a counter that four
 *     writers incremented and decremented could disagree with the rows it
 *     counted, and now cannot exist to.
 *
 * ⚠ TWO CLOCKS. `now` below is an app-side Date and is used ONLY on
 * tbl_job_conference, whose columns are app-written and hold the IST wall clock
 * (the pool's +05:30 session timezone stores it verbatim). tbl_plivo_call_log is
 * NOW()-written throughout by its own 2026-06-19 convention, so the leg helpers
 * stamp their own timestamps in SQL and `now` is deliberately NOT passed to
 * them. Each column is compared and written in the clock it was written in.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * ⚠⚠  UNVERIFIED PLIVO MPC *CALLBACK* PAYLOAD SHAPES — THE ONLY PLACE  ⚠⚠
 * ═════════════════════════════════════════════════════════════════════════
 *
 * services/plivo-conference.service.js owns every OUTBOUND MPC wire shape
 * (paths, request bodies, response keys) in one marked block. This file owns
 * the other half — what Plivo POSTS BACK — and for the same reason: none of it
 * has been seen on a live account. It came from documentation. Keep every
 * assumption inside EVENTS / FIELD_PROBES / classifyEvent() below; no other
 * file may encode an MPC callback field name.
 *
 * ── FIRST-SPIKE CHECKLIST (run one real 3-leg conference, in this order) ──
 *
 *  1. EVENT NAMES → classifyEvent()
 *     We subscribe to STATUS_CALLBACK_EVENTS =
 *     'mpc-state-changes,participant-state-changes,add-participant-api-events'.
 *     The event names those classes actually emit are NOT confirmed. We
 *     classify on a CASE- AND PUNCTUATION-INSENSITIVE token match
 *     ('MPCStart' / 'mpc_start' / 'mpc-start' all land together) rather than an
 *     equality table, precisely because the spelling is the thing we don't know.
 *     Grep the logs for `event="…" → ignored` and `UNPARSEABLE` after the spike.
 *
 *  2. WHICH KEY CARRIES THE EVENT → FIELD_PROBES.event
 *     Plivo's other webhooks use `Event`; some use `CallStatus`/`Status`. We
 *     probe several, and fall back to inferring an MPC state change from
 *     MPCStatus when no event key exists at all.
 *
 *  3. MemberID vs ParticipantCallUUID → FIELD_PROBES.memberId / .callUuid
 *     They are DIFFERENT identifiers (see checklist item 4 in the service).
 *     member_id is the one the mute/kick URLs need. CONFIRM the join callback
 *     carries the SAME member id that add-participant returned — if it does
 *     not, participants added before their first webhook can never be dropped.
 *
 *  4. MPCName ROUND-TRIP → sameConference()
 *     We only write when the payload's MPCName matches the friendly_name on the
 *     token's row (after stripping a leading `name_`). If Plivo echoes the name
 *     in some other spelling, every callback will log
 *     "conference NAME MISMATCH" and write NOTHING — loud, not silently wrong.
 *
 *  5. DURATION / BILLING KEYS → FIELD_PROBES.mpcBilled / .duration
 *     MPCBilledDuration on the end event is the only cheap answer to "what did
 *     conferencing cost last month". If it never arrives, billed_leg_seconds
 *     stays NULL and finance has to re-derive it from leg timestamps.
 *
 *  6. WHETHER PLIVO CARES WHAT WE RETURN
 *     We answer 200 {ok:true} to everything, like the sibling ring/hangup
 *     handlers. If a status callback ever needs to return XML, this is the file.
 * ═════════════════════════════════════════════════════════════════════════
 */

// The normalised event classes this handler acts on. Everything else is either
// deliberately ignored (speak/digit/floor chatter, which fires constantly) or
// unparseable (logged with its key paths).
const EVENTS = {
  MPC_START: 'mpc_start',
  MPC_END: 'mpc_end',
  P_RINGING: 'participant_ringing',
  P_JOIN: 'participant_join',
  P_LEAVE: 'participant_leave',
  P_FAIL: 'participant_fail',
  IGNORED: 'ignored',
};

/*
 * Field probes. Each is an ordered list of key spellings; first non-empty wins.
 * Plivo's voice callbacks are PascalCase form fields, but the MPC docs also
 * show snake_case in places, so both are probed. `pick()` is flat-then-nested
 * so a JSON envelope (body.data.MemberID) resolves too.
 */
const FIELD_PROBES = {
  event: ['Event', 'EventName', 'event', 'MPCEvent', 'CallbackEvent'],
  // ⚠ NO bare 'Name' here. Plivo sends MPCName; a generic key that early in an
  // ORDERED first-non-empty pick could win against some unrelated field and
  // make sameConference() fail on every callback — i.e. NAME MISMATCH logged,
  // nothing written, for a payload that was in fact ours.
  mpcName: ['MPCName', 'MPCname', 'mpc_name', 'ConferenceName'],
  mpcUuid: ['MPCUUID', 'MPCUuid', 'MPCUUId', 'mpc_uuid', 'MultiPartyCallUUID'],
  mpcStatus: ['MPCStatus', 'mpc_status', 'ConferenceStatus'],
  mpcDuration: ['MPCDuration', 'mpc_duration', 'ConferenceDuration'],
  mpcBilled: ['MPCBilledDuration', 'mpc_billed_duration', 'BilledDuration'],
  memberId: ['MemberID', 'MemberId', 'member_id', 'ParticipantMemberID', 'MemberUUID'],
  callUuid: ['ParticipantCallUUID', 'CallUUID', 'call_uuid', 'ParticipantUUID', 'participant_call_uuid'],
  // ⚠ `To` is a REAL PHONE NUMBER. It is read for row-matching only and is
  // never logged, never echoed and never stored by this file.
  to: ['To', 'ParticipantTo', 'to', 'Destination'],
  duration: ['ParticipantDuration', 'Duration', 'duration', 'ParticipantBilledDuration'],
  hangupCause: ['HangupCauseName', 'HangupCause', 'hangup_cause', 'Reason', 'ErrorMessage'],
  callStatus: ['CallStatus', 'Status', 'ParticipantStatus', 'status'],
};

// Nothing below this line is an MPC wire-shape assumption.

// The leg vocabulary is tbl_plivo_call_log's own, re-exported by the conference
// service so this file never spells a status as a literal.
const LEG = conf.LEG_STATUS;                             // DIALLING/RINGING/JOINED/LEFT/…
const ACTIVE_P = conf.ACTIVE_PARTICIPANT_STATUSES;       // initiated | ringing | answered
// All leg SQL lives in services/plivo-call-log.service.js. This is the handle.
const legs = conf.legs;

function pick(body, keys) {
  if (!body || typeof body !== 'object') return null;
  for (const k of keys) {
    const v = body[k];
    if (v != null && v !== '') return v;
  }
  // One level of envelope — a JSON POST may wrap the fields.
  for (const nestKey of ['data', 'payload', 'body', 'params']) {
    const nested = body[nestKey];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      for (const k of keys) {
        const v = nested[k];
        if (v != null && v !== '') return v;
      }
    }
  }
  return null;
}

function intOrNull(v) {
  if (v == null || v === '') return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}

// Lowercase alphanumerics only, so 'MPCStart', 'mpc_start', 'MPC-Start' and
// 'mpc start' are one token. This is the whole point: we are matching an event
// name nobody has confirmed the exact spelling of.
function tokenise(v) {
  return String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/*
 * Map a raw event name onto one of EVENTS. Returns null when nothing matches —
 * that is the signal to log the payload's key paths.
 *
 * ORDER IS LOAD-BEARING in two places:
 *   • 'noanswer' must be tested BEFORE 'answer', or ParticipantCallNoAnswer
 *     would classify as a JOIN and a leg that nobody picked up would be shown
 *     to ops as on the call.
 *   • the chatter classes ('speak', 'digit', 'floor') are tested FIRST, so a
 *     ParticipantSpeakStarted never falls through to the join/leave probes.
 */
function classifyEvent(rawEvent, body) {
  const e = tokenise(rawEvent);

  if (e) {
    // High-frequency chatter we subscribe to only as a side effect of the
    // event CLASSES. Recognised on purpose so it never looks unparseable.
    if (/(speak|digit|floor|audio|record|dtmf|mute|hold|coach)/.test(e)) return EVENTS.IGNORED;

    if (e.startsWith('mpc') || e.startsWith('conference') || e.startsWith('multiparty')) {
      if (/(end|complet|stop|terminat|hangup)/.test(e)) return EVENTS.MPC_END;
      if (/(start|creat|begin|active)/.test(e)) return EVENTS.MPC_START;
      // An MPC state change we can't name — fall through to the status probe.
    } else {
      if (/(noanswer|nonanswer|fail|reject|busy|error|timeout|unreachable|cancel)/.test(e)) return EVENTS.P_FAIL;
      if (/(hangup|left|leave|exit|disconnect|removed|kick)/.test(e)) return EVENTS.P_LEAVE;
      if (/(join|enter|answer|connect|bridge)/.test(e)) return EVENTS.P_JOIN;
      if (/(ring|initiat|dial|queued)/.test(e)) return EVENTS.P_RINGING;
    }
  }

  /*
   * No usable event name. Two documented-adjacent fallbacks before we give up:
   * a member id + a call status describes a PARTICIPANT transition, and a bare
   * MPCStatus describes a CONFERENCE one.
   */
  const memberish = pick(body, FIELD_PROBES.memberId) || pick(body, FIELD_PROBES.callUuid);
  const callStatus = tokenise(pick(body, FIELD_PROBES.callStatus));
  if (memberish && callStatus) {
    if (/(noanswer|fail|busy|reject|timeout|cancel)/.test(callStatus)) return EVENTS.P_FAIL;
    if (/(complet|hangup|left|end|disconnect)/.test(callStatus)) return EVENTS.P_LEAVE;
    if (/(inprogress|answer|join|active|connect)/.test(callStatus)) return EVENTS.P_JOIN;
    if (/(ring|initiat|dial)/.test(callStatus)) return EVENTS.P_RINGING;
  }
  const mpcStatus = tokenise(pick(body, FIELD_PROBES.mpcStatus));
  if (mpcStatus) {
    if (/(end|complet|terminat)/.test(mpcStatus)) return EVENTS.MPC_END;
    if (/(active|live|start|initial)/.test(mpcStatus)) return EVENTS.MPC_START;
  }
  return null;
}

/*
 * Terminal cause → the LEG status vocabulary. Deliberately the same shape as
 * mapPlivoStatus() in routes/webhook/plivo.js, and landing on
 * tbl_plivo_call_log's own enum (no_answer | failed) rather than a
 * conference-specific one — a leg that nobody picked up must read 'no_answer'
 * on the Calls list exactly like any other unanswered Plivo leg.
 */
function participantFailureStatus(body) {
  const cause = tokenise(pick(body, FIELD_PROBES.hangupCause));
  const status = tokenise(pick(body, FIELD_PROBES.callStatus));
  const both = `${cause} ${status}`;
  if (/(noanswer|nouserresponse|timeout|originatorcancel|cancel)/.test(both)) return LEG.NO_ANSWER;
  if (/busy/.test(both)) return LEG.NO_ANSWER;
  return LEG.FAILED;
}

/*
 * KEY PATHS, NEVER VALUES. Matches the shape() helper added to
 * routes/webhook/whatsapp.js for exactly this reason: when the envelope was
 * never confirmed against a real provider payload, "we could not parse it" is
 * useless and "here are the keys it actually had" is the answer. An MPC
 * callback carries `To` — a customer's mobile — so values must never be logged.
 */
function shape(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 2) return undefined;
  const out = {};
  for (const k of Object.keys(o).slice(0, 30)) {
    const v = o[k];
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? (shape(v, depth + 1) || '{…}') : typeof v;
  }
  return out;
}

async function safeQuery(what, sql, params) {
  try {
    const [r] = await pool.query(sql, params);
    return r || null;
  } catch (e) {
    logger.warn(`⚠ Conference webhook DB write failed (${what}) · ${e.message}`);
    return null;
  }
}

/*
 * Does this payload actually belong to the conference the token authorised?
 * Tolerant of the `name_` prefix Plivo uses in its own URLs, and of casing.
 * A payload with NO name is accepted — the token is the authorisation, the
 * name is only the cross-check.
 */
function sameConference(payloadName, friendlyName) {
  const a = String(payloadName || '').trim().toLowerCase().replace(/^name_/, '');
  if (!a) return true;
  return a === String(friendlyName || '').trim().toLowerCase();
}

/*
 * Find the LEG a callback is about, WITHIN the authorised conference.
 *
 * The three probes (conference_member_id → call_uuid → dialled-digits tail,
 * most-specific first) live in services/plivo-call-log.service.js, because that
 * is where the table's SQL lives and the digits probe reads a server-side-only
 * column. This is the thin adapter from the callback's field names to that
 * function's, so the ONE thing this file owns about the lookup is which payload
 * key carries which id.
 *
 * The returned row is MASKED (`masked_number`, never the digits), which is what
 * makes it safe for the log lines below.
 */
async function findParticipant(confId, { memberId, callUuid, to }) {
  return legs.findConferenceLeg(confId, { memberId, callUuid, toNumber: to }, pool);
}

// ─── POST /status — every MPC state + participant callback ─────────────
router.post('/status', async (req, res) => {
  /*
   * ONE UNCONDITIONAL LINE, BEFORE THE TOKEN CHECK, AT INFO.
   *
   * Everything downstream is conditional: an unreadable token warns, an
   * unparseable body warns, a name mismatch warns — and "Plivo never called us
   * at all" is SILENCE. Those four cases are the entire diagnostic space of
   * this endpoint, and until this line existed, three of them looked different
   * and the fourth looked like nothing, so the only way to tell "no callbacks"
   * from "callbacks we dropped" was to reason about absence. Now one grep for
   * this message answers it: no lines ⇒ Plivo is not calling us (start with
   * statusCallbackUrl() and the callback base); lines ⇒ it is, and the warn
   * that follows says what we then did with the payload.
   *
   * KEY NAMES ONLY. This payload carries `To` — a customer's mobile — so not
   * one value may be logged, here or anywhere in this file.
   */
  logger.info({ bodyKeys: Object.keys(req.body || {}).slice(0, 40) },
    'Plivo conference webhook · POST /status received');

  const claims = conf.verifyConferenceToken(req.query.t);
  if (!claims) {
    logger.warn('Plivo conference webhook · invalid/expired token, no-op');
    return res.json({ ok: true });
  }
  const confId = Number.parseInt(claims.confId, 10);
  if (!Number.isFinite(confId) || confId <= 0) {
    logger.warn('Plivo conference webhook · token carries no usable confId, no-op');
    return res.json({ ok: true });
  }

  const body = req.body || {};
  const rawEvent = pick(body, FIELD_PROBES.event);
  const kind = classifyEvent(rawEvent, body);

  if (!kind) {
    /*
     * UNPARSEABLE. Log the KEY PATHS (keys only — the payload carries `To`,
     * a customer's mobile) so the next callback is the answer rather than
     * another silent nothing. Still 200: a non-200 buys us a retry storm of
     * payloads we equally cannot read.
     */
    logger.warn({ bodyShape: shape(body) },
      'Plivo conference webhook · UNPARSEABLE — classifyEvent() recognised nothing. conf=' + confId
      + ' · compare the key paths above with FIELD_PROBES / classifyEvent in routes/webhook/plivo-conference.js '
      + 'and widen the probes (UNVERIFIED checklist items 1–2).');
    return res.json({ ok: true, handled: false });
  }

  if (kind === EVENTS.IGNORED) {
    // INFO, not debug. Debug never reaches production, which made "every
    // callback arrived and was classified as chatter" indistinguishable from
    // "no callbacks arrived" — the exact ambiguity the entry log above exists
    // to remove. Chatter is frequent but one line per callback is the price of
    // being able to tell those two apart.
    logger.info(`Plivo conference webhook · conf=${confId} · event="${rawEvent}" → ignored (chatter class)`);
    return res.json({ ok: true, handled: false, ignored: true });
  }

  // Load the row the TOKEN authorised. Never the row the payload names.
  const loaded = await conf.getConferenceByFriendlyName(String(claims.conf || ''), pool);
  let conference = loaded.ok ? loaded.conference : null;
  if (conference && Number(conference.id) !== confId) conference = null;
  if (!conference) {
    const g = await conf.getConference(confId, pool);
    conference = g.ok ? g.conference : null;
  }
  if (!conference) {
    logger.warn(`Plivo conference webhook · conf=${confId} not found (event="${rawEvent}"), no-op`);
    return res.json({ ok: true, handled: false });
  }

  const payloadName = pick(body, FIELD_PROBES.mpcName);
  if (!sameConference(payloadName, conference.friendly_name)) {
    // Fail LOUD rather than stamp the wrong row. If this line is common, the
    // name round-trip is wrong — UNVERIFIED checklist item 4.
    logger.warn(`⚠ Plivo conference webhook · conference NAME MISMATCH · conf=${confId} `
      + `· token name="${conference.friendly_name}" · payload name="${String(payloadName).slice(0, 64)}" `
      + `· event="${rawEvent}" — nothing written`);
    return res.json({ ok: true, handled: false });
  }

  const now = new Date();   // pool TZ +05:30 stores the IST wall clock verbatim
  const mpcUuid = pick(body, FIELD_PROBES.mpcUuid);

  try {
    if (kind === EVENTS.MPC_START) {
      /*
       * The MPC materialised. 'creating' was an assertion; this is the
       * observation. Guarded to the pre-terminal statuses so a late/duplicate
       * start can never resurrect an ended conference.
       */
      await safeQuery('conference live',
        `UPDATE tbl_job_conference
            SET status = 'live',
                mpc_uuid = COALESCE(?, mpc_uuid),
                started_on = COALESCE(started_on, ?),
                updated_on = ?
          WHERE id = ? AND status IN ('creating', 'live')`,
        [mpcUuid ? String(mpcUuid) : null, now, now, conference.id]);
      logger.info(`🧾 Conference LIVE · id=${conference.id} · name=${conference.friendly_name} · mpcUuid=${mpcUuid || '-'}`);
      return res.json({ ok: true, handled: true, event: kind });
    }

    if (kind === EVENTS.MPC_END) {
      const billed = intOrNull(pick(body, FIELD_PROBES.mpcBilled));
      const dur = intOrNull(pick(body, FIELD_PROBES.mpcDuration));
      /*
       * WHO ended it. 'ending' means WE asked (endConference is mid-flight, or
       * the reaper is), so the reason it already wrote must win — hence
       * COALESCE(end_reason, ?). Otherwise the room emptied on its own, which
       * on our config means the operator hung up (endMpcOnExit="true").
       */
      const reason = conference.status === 'ending' ? 'api' : 'last_left';
      await safeQuery('conference ended',
        `UPDATE tbl_job_conference
            SET status = 'ended',
                ended_on = COALESCE(ended_on, ?),
                duration = COALESCE(duration, ?),
                billed_leg_seconds = COALESCE(?, billed_leg_seconds),
                end_reason = COALESCE(end_reason, ?),
                mpc_uuid = COALESCE(?, mpc_uuid),
                updated_on = ?
          WHERE id = ? AND status IN ('creating', 'live', 'ending')`,
        [now, dur, billed, reason, mpcUuid ? String(mpcUuid) : null, now, conference.id]);
      /*
       * The room ended, so every leg still on it did too. Closed as 'completed'
       * (LEG.LEFT) through the call-log service, and with SQL NOW() rather than
       * the IST `now` above — different table, different clock.
       *
       * There is no participant_count to zero: the live count is derived from
       * these rows, so closing them IS the reset.
       */
      await legs.closeConferenceLegs(conference.id, { status: LEG.LEFT }, pool);
      logger.info(`🧾 Conference ENDED (webhook) · id=${conference.id} · name=${conference.friendly_name}`
        + ` · reason=${reason} · duration=${dur ?? '-'}s · billedLegSec=${billed ?? '-'}`);
      return res.json({ ok: true, handled: true, event: kind });
    }

    // ── participant events from here down ────────────────────────────────
    const memberId = pick(body, FIELD_PROBES.memberId);
    const callUuid = pick(body, FIELD_PROBES.callUuid);
    const to = pick(body, FIELD_PROBES.to);
    const p = await findParticipant(conference.id, { memberId, callUuid, to });
    if (!p) {
      // Not fatal — but it means a leg is being billed that we cannot control
      // or attribute. Say so, with the masked number only.
      logger.warn(`⚠ Plivo conference webhook · no participant row matched · conf=${conference.id}`
        + ` · event="${rawEvent}" · member=${memberId || '-'} · to=${maskForDisplay(to) || '-'}`
        + ' — UNVERIFIED checklist item 3 (MemberID round-trip)');
      return res.json({ ok: true, handled: false });
    }

    /*
     * The provider ids ride on EVERY leg transition below, COALESCEd by the
     * service so a later, better-informed callback never blanks what an earlier
     * one supplied. The member id in particular is the ONLY thing that makes a
     * later mute/drop possible, so landing it is the load-bearing half of each
     * of these events.
     */
    const ids = { memberId: memberId ? String(memberId) : null, callUuid: callUuid ? String(callUuid) : null };

    if (kind === EVENTS.P_RINGING) {
      // Guarded to the ONE status it may move from, so a late ring callback
      // cannot pull an already-answered leg backwards.
      await legs.markConferenceLegStatus(p.id, { status: LEG.RINGING, from: LEG.DIALLING, ...ids }, pool);
      logger.info(`📡 Conference participant ringing · conf=${conference.id} · participant=${p.id} · ${p.masked_number || '-'}`);
      return res.json({ ok: true, handled: true, event: kind });
    }

    if (kind === EVENTS.P_JOIN) {
      /*
       * Moves the leg to 'answered' and stamps answered_on (COALESCEd, so a
       * duplicate join does not move the clock). Nothing is counted here: the
       * live participant count is DERIVED from these rows, so there is no
       * counter that could be incremented twice by a repeated callback.
       */
      await legs.markConferenceLegStatus(p.id, {
        status: LEG.JOINED,
        from: ACTIVE_P,
        answeredOn: true,
        ...ids,
      }, pool);
      logger.info(`📡 Conference participant JOINED · conf=${conference.id} · participant=${p.id}`
        + ` · kind=${p.target_kind} · ${p.masked_number || '-'} · member=${memberId || p.member_id || '-'}`);
      return res.json({ ok: true, handled: true, event: kind });
    }

    // P_LEAVE / P_FAIL — the two terminal leg transitions.
    const terminal = kind === EVENTS.P_FAIL ? participantFailureStatus(body) : LEG.LEFT;
    const dur = intOrNull(pick(body, FIELD_PROBES.duration));
    const cause = pick(body, FIELD_PROBES.hangupCause);
    /*
     * Guarded to the active statuses, so a duplicate or late callback cannot
     * resurrect a leg that has already hung up. The returned affectedRows says
     * whether THIS callback is the one that moved the row — nothing depends on
     * it any more (there is no seat to free), but it is logged so a flood of
     * no-op callbacks is visible rather than silent.
     */
    const moved = await legs.markConferenceLegStatus(p.id, {
      status: terminal,
      from: ACTIVE_P,
      endedOn: true,
      duration: dur,
      hangupCause: cause,
      ...ids,
    }, pool);

    logger.info(`📡 Conference participant ${String(terminal).toUpperCase()} · conf=${conference.id} · participant=${p.id}`
      + ` · ${p.masked_number || '-'} · duration=${dur ?? '-'}s · cause=${cause || '-'}`
      + (moved ? '' : ' (already terminal — duplicate/late callback, no-op)'));
    return res.json({ ok: true, handled: true, event: kind, status: terminal });
  } catch (err) {
    // Belt and braces — safeQuery already swallows DB errors, so reaching here
    // means something else threw. Never a non-200.
    logger.error({ err: err && err.message }, 'plivo conference webhook failed');
    return res.json({ ok: true, handled: false, error: 'internal' });
  }
});

module.exports = router;
module.exports.__test = { classifyEvent, participantFailureStatus, sameConference, pick, shape, EVENTS, FIELD_PROBES };
