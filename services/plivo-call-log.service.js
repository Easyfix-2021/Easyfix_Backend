const { pool } = require('../db');
const logger = require('../logger');

/*
 * services/plivo-call-log.service.js — writes the dedicated Plivo call-detail
 * log (tbl_plivo_call_log) ALONGSIDE the generic tbl_job_caller_info audit, so
 * Plivo calls can be reconciled/sliced on their own (count Plivo vs all, by
 * mode / flow / status / QA-redirect). EVERY function is FAIL-SOFT: a logging
 * error is swallowed (warn) and never propagates — call placement and the Plivo
 * callbacks must never break because of the log. Timestamps use SQL NOW() to
 * match tbl_job_caller_info's clock.
 *
 * Lifecycle: record() at start → markRinging/markAnswered on callbacks →
 * markTerminalByJci / markTerminalByCallUuid on hangup. Keyed off
 * job_caller_info_id (always known) or the Plivo CallUUID (web-hangup has no jci).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 2026-08-04 — THIS TABLE IS ALSO THE CONFERENCE PARTICIPANT MODEL
 * ══════════════════════════════════════════════════════════════════════════
 *
 * A conference participant leg IS a call leg, so it lives here rather than in a
 * parallel table of its own. Adding someone to a live Plivo Multi-Party Call
 * inserts ANOTHER tbl_plivo_call_log row carrying:
 *
 *    • the SAME job_caller_info_id as the operator's leg — a conference is ONE
 *      call that gained people, so tbl_job_caller_info still gets exactly one
 *      row per call and every existing call-COUNT report is untouched;
 *    • conference_id            — the room (tbl_job_conference.id);
 *    • participant_role         — operator | customer | customer_alt |
 *                                 technician | job_spoc | client_contact |
 *                                 custom. The per-leg label every call-history
 *                                 surface shows;
 *    • participant_target_id    — the id behind that role (NULL for 'custom');
 *    • conference_member_id     — Plivo's MPC member id, the path segment the
 *                                 mute/kick URLs need. NOT the same thing as
 *                                 call_uuid, which holds the leg's own uuid.
 *
 * ⚠ CONSEQUENCE, AND THE REASON EVERY jci-KEYED WRITER BELOW CHANGED:
 * job_caller_info_id is now genuinely 1:N. `UPDATE … WHERE job_caller_info_id
 * = ?` would hit EVERY leg — markAnswered() would mark the technician answered
 * because the customer did, and setRecording() would file one recording on
 * three rows. So every jci-keyed writer is scoped by primaryLegFilter() to the
 * PRIMARY leg: `conference_id IS NULL OR participant_role = 'operator'`. That
 * expression is true for every ordinary 1:1 call ever logged, so the behaviour
 * of a non-conference call is byte-for-byte what it was.
 *
 * ⚠ THE LEG STATUS VOCABULARY IS THIS TABLE'S OWN (LEG_STATUS below), not a
 * conference-specific one. A conference leg is stored as
 * initiated/ringing/answered/completed/no_answer/failed — exactly what every
 * other Plivo leg uses — so GET /api/admin/calls, the per-job call-history
 * tooltip and the Call Info modal render it without knowing conferences exist.
 * Storing 'joined'/'left' here would have made a conference leg unreadable to
 * every surface that already reads this table, which is the whole thing
 * decision 2 exists to avoid.
 */

const RECORD_COLS = [
  'job_caller_info_id', 'job_id', 'call_mode', 'call_flow', 'caller_user_id',
  'caller_name', 'receiver_name', 'receiver_number', 'dialed_number',
  'call_uuid', 'status',
];

/*
 * The leg lifecycle, expressed in THIS TABLE'S status vocabulary. Exported so
 * the conference service, the MPC webhook and the reaper never spell a status
 * as a string literal — one typo in one file would strand a leg in a status no
 * reader recognises.
 */
const LEG_STATUS = {
  DIALLING: 'initiated',
  RINGING: 'ringing',
  JOINED: 'answered',
  LEFT: 'completed',
  REMOVED: 'completed',
  NO_ANSWER: 'no_answer',
  FAILED: 'failed',
};

// Statuses in which a leg is still on the call — i.e. still costing money and
// still controllable. Used by the duplicate guard, the live roster and the
// reaper's stuck-leg sweep.
const ACTIVE_LEG_STATUSES = [LEG_STATUS.DIALLING, LEG_STATUS.RINGING, LEG_STATUS.JOINED];

/*
 * The public (MASKED) leg projection.
 *
 * ⚠ NEITHER dialed_number NOR receiver_number IS SELECTED. Only the first four
 * digits leave the database, as `number_prefix`; maskLeg() turns that into the
 * 9812•••••• form the browser sees. The customer's mobile is masked for staff,
 * and this projection is one of the places that has to stay true — do not add a
 * whole-number column here, and never `SELECT *` from this table into a DTO.
 *
 * Column aliases deliberately preserve the participant vocabulary the callers
 * already speak (target_kind / display_name / joined_at / …), so a leg reads the
 * same whether it came from here or from the participant table this replaced.
 */
/*
 * ⚠ THE OPERATOR'S LEG IS NOT A ROW ABOUT THE OPERATOR.
 *
 * Exactly ONE call-log row is written when a call is placed
 * (routes/admin/calls.js, both the web path and the mobile path), and it
 * describes the person being CALLED: receiver_name and dialed_number are the
 * CUSTOMER's, while the agent is recorded separately in caller_name /
 * caller_user_id. dialed_number is the receiver on both flows —
 * `dialTo = isCustomNumberMode ? callTo : receiverMobile` — never the agent's
 * own number.
 *
 * adoptOperatorLeg() then RETAGS that same row as participant_role='operator'.
 * So projecting receiver_name for every leg rendered the operator's leg as the
 * CUSTOMER; and because the customer is separately inserted as their own leg,
 * the roster showed the same human TWICE — once behind a headset icon, once
 * behind a person icon, sharing one masked number. Reported from a Web Call
 * panel listing "SAROJ MERANI 8080••••••" on two rows.
 *
 * So the operator takes their name from the column that actually holds it, and
 * shows NO number: on a web call the operator is in the browser with no dialled
 * number at all, and on a mobile call the only number on the row is the
 * customer's. Masked digits belonging to the wrong person are worse than a
 * blank — and one fewer place the customer's prefix is rendered.
 */
const LEG_PUBLIC_COLUMNS = `
       id,
       conference_id,
       job_caller_info_id,
       job_id,
       participant_role                  AS target_kind,
       participant_target_id             AS target_id,
       CASE WHEN participant_role = 'operator' THEN caller_name
            ELSE receiver_name END       AS display_name,
       CASE WHEN participant_role = 'operator' THEN NULL
            ELSE LEFT(RIGHT(dialed_number, 10), 4) END AS number_prefix,
       conference_member_id              AS member_id,
       call_uuid                         AS participant_uuid,
       caller_user_id                    AS added_by_user_id,
       status,
       hangup_cause,
       initiated_on                      AS created_on,
       answered_on                       AS joined_at,
       ended_on                          AS left_at,
       duration`;

/*
 * Cached probe: does tbl_plivo_call_log have the recording_requested column?
 * The migration adding it (2026-07-08) may still be pending on an env, and
 * record() builds a DYNAMIC insert — naming a missing column would fail-soft the
 * WHOLE row insert (losing the call log entirely). So we only INSERT the flag
 * once the column is confirmed present. Resolved once per process, then cached
 * (undefined = not yet probed).
 */
let _hasRecordingRequestedCol;
async function hasRecordingRequestedColumn() {
  if (_hasRecordingRequestedCol !== undefined) return _hasRecordingRequestedCol;
  try {
    const [rows] = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'tbl_plivo_call_log'
          AND column_name = 'recording_requested'
        LIMIT 1`,
    );
    _hasRecordingRequestedCol = rows.length > 0;
    return _hasRecordingRequestedCol;
  } catch (e) {
    // A failure is NOT cached. The success answer is frozen for the process because a column that exists does not vanish; a failure frozen the same way turns a two-second information_schema blip into a degraded mode that lasts until the container restarts, with nothing in the logs saying so.
    logger.warn('plivo-call-log: recording_requested probe failed · ' + e.message
      + ' — treating as absent for this call only');
    return false;
  }
}

/*
 * Same probe, for the conference columns added by
 * 2026-08-04-create-tbl-job-conference.sql. Two reasons it matters more than
 * the one above:
 *
 *   1. record() would lose the WHOLE row if it named a column that is not there
 *      yet, exactly as with recording_requested;
 *   2. primaryLegFilter() would put `conference_id IS NULL` into the WHERE of
 *      every existing jci-keyed UPDATE. On a pre-migration deploy that turns
 *      markRinging / markAnswered / markTerminal into silent no-ops — the call
 *      log would stop updating on ordinary calls, which is a far worse
 *      regression than not having conferences.
 *
 * So: pre-migration, the filter is EMPTY and every writer behaves exactly as it
 * did before this feature existed.
 */
let _hasConferenceCols;
async function hasConferenceColumns() {
  if (_hasConferenceCols !== undefined) return _hasConferenceCols;
  try {
    const [rows] = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'tbl_plivo_call_log'
          AND column_name = 'conference_id'
        LIMIT 1`,
    );
    _hasConferenceCols = rows.length > 0;
    return _hasConferenceCols;
  } catch (e) {
    // A failure is NOT cached. The success answer is frozen for the process because a column that exists does not vanish; a failure frozen the same way turns a two-second information_schema blip into a degraded mode that lasts until the container restarts, with nothing in the logs saying so.
    logger.warn('plivo-call-log: conference_id probe failed · ' + e.message
      + ' — treating as absent for this call only');
    return false;
  }
}

/*
 * The WHERE fragment that keeps a jci-keyed write on the PRIMARY leg.
 *
 * `conference_id IS NULL` covers every 1:1 call (and every row written before
 * this migration); `participant_role = 'operator'` covers the operator's leg of
 * a conference. An ADDED participant matches neither, so a callback about the
 * whole call can never stamp a leg it is not about.
 */
async function primaryLegFilter() {
  return (await hasConferenceColumns())
    ? " AND (conference_id IS NULL OR participant_role = 'operator')"
    : '';
}

// Insert one row at call start (initiated_on = NOW()). Returns id or null.
async function record(fields = {}) {
  try {
    const cols = RECORD_COLS.filter((c) => fields[c] !== undefined);
    const params = cols.map((c) => fields[c]);
    // Stamp the recording decision at INSERT so the flag is correct even for
    // calls that are never answered — the answer callback is the only OTHER
    // writer and it fires only on answered calls, which is why so many rows had
    // recording_requested = NULL. Probe-gated: skipped when the column is still
    // pre-migration, so the row insert itself never fails.
    if (fields.recording_requested !== undefined && (await hasRecordingRequestedColumn())) {
      cols.push('recording_requested');
      params.push(fields.recording_requested ? 1 : 0);
    }
    /*
     * The conference columns, when the caller knows them at call-placement
     * time. routes/admin/calls.js mints the conference BEFORE it records the
     * log row, so it can pass conference_id + participant_role:'operator'
     * straight through here. If it does not, adoptOperatorLeg() below back-
     * fills the same two values the moment a second participant is added —
     * either path leaves the operator's leg correctly labelled.
     */
    if (await hasConferenceColumns()) {
      for (const c of ['conference_id', 'participant_role', 'participant_target_id']) {
        if (fields[c] !== undefined) { cols.push(c); params.push(fields[c]); }
      }
    }
    const sql = `INSERT INTO tbl_plivo_call_log (${cols.concat('initiated_on').join(', ')}) `
      + `VALUES (${cols.map(() => '?').concat('NOW()').join(', ')})`;
    const [r] = await pool.query(sql, params);
    logger.info('Plivo call-log row recorded · jci=' + fields.job_caller_info_id + ' · job=' + fields.job_id + ' · id=' + r.insertId);
    return r.insertId;
  } catch (e) {
    logger.warn({ err: e.message, jci: fields.job_caller_info_id }, 'plivo-call-log: record failed (non-fatal)');
    return null;
  }
}

async function markRinging(jci, callUuid) {
  if (jci == null) return;
  logger.info('Plivo call-log mark ringing · jci=' + jci);
  try {
    await pool.query(
      `UPDATE tbl_plivo_call_log
          SET status = 'ringing', call_uuid = COALESCE(?, call_uuid), updated_on = NOW()
        WHERE job_caller_info_id = ?${await primaryLegFilter()}`,
      [callUuid || null, jci],
    );
  } catch (e) { logger.warn({ err: e.message, jci }, 'plivo-call-log: markRinging failed (non-fatal)'); }
}

async function markAnswered(jci, callUuid, recordRequested = null) {
  if (jci == null) return;
  logger.info('Plivo call-log mark answered · jci=' + jci
    + (recordRequested == null ? '' : ' · recording=' + (recordRequested ? 'on' : 'off')));
  try {
    await pool.query(
      `UPDATE tbl_plivo_call_log
          SET status = 'answered', answered_on = NOW(),
              call_uuid = COALESCE(?, call_uuid), updated_on = NOW()
        WHERE job_caller_info_id = ?${await primaryLegFilter()}`,
      [callUuid || null, jci],
    );
  } catch (e) { logger.warn({ err: e.message, jci }, 'plivo-call-log: markAnswered failed (non-fatal)'); }
  // Persist the recording decision SEPARATELY + fail-soft: on a deploy where the
  // recording_requested column isn't migrated yet, this no-ops with a warn and
  // the status write above is unaffected.
  if (recordRequested != null) await setRecordingRequested(jci, recordRequested);
}

/*
 * Persist the recording URL/id PUSHED by Plivo's recordingCallbackUrl callback
 * (keyed by jci, so it's robust to whichever leg's call_uuid the recording is
 * filed under). Best-effort — the columns are added by
 * 2026-07-08-add-recording-url-to-plivo-call-log.sql; a pre-migration deploy
 * no-ops and the Play endpoint falls back to the call_uuid lookup.
 *
 * ⚠ SCOPED TO THE PRIMARY LEG. A Multi-Party Call has ONE recording of the
 * room, not one per participant, and it belongs on the operator's leg — the row
 * every existing playback / transcription / call-analysis surface already reads
 * for this jci. Without the filter one recording would be filed on all three
 * legs and the Calls list would offer the same audio three times.
 */
async function setRecording(jci, { url, id, duration } = {}) {
  if (jci == null || !url) return;
  try {
    await pool.query(
      `UPDATE tbl_plivo_call_log
          SET recording_url = ?, recording_id = ?, recording_duration = ?, updated_on = NOW()
        WHERE job_caller_info_id = ?${await primaryLegFilter()}`,
      [String(url), id || null, duration != null ? Number(duration) : null, jci],
    );
    logger.info('Plivo call-log recording stored · jci=' + jci + ' · id=' + (id || '?'));
  } catch (e) { logger.warn({ err: e.message, jci }, 'plivo-call-log: setRecording failed (non-fatal — columns may be pre-migration)'); }
}

// Record whether Plivo was asked to record this call (1/0). Best-effort — the
// column is added by 2026-07-08-add-recording-requested-to-plivo-call-log.sql.
async function setRecordingRequested(jci, on) {
  if (jci == null) return;
  try {
    await pool.query(
      `UPDATE tbl_plivo_call_log SET recording_requested = ?, updated_on = NOW() WHERE job_caller_info_id = ?${await primaryLegFilter()}`,
      [on ? 1 : 0, jci],
    );
  } catch (e) { logger.warn({ err: e.message, jci }, 'plivo-call-log: setRecordingRequested failed (non-fatal — column may be pre-migration)'); }
}

async function markTerminalByJci(jci, { status, duration = null, hangupCause = null, callUuid = null } = {}) {
  if (jci == null) return;
  logger.info('Plivo call-log mark terminal by jci · jci=' + jci + ' · status=' + status + ' · duration=' + duration);
  try {
    await pool.query(
      `UPDATE tbl_plivo_call_log
          SET status = ?, ended_on = NOW(), duration = ?, hangup_cause = ?,
              call_uuid = COALESCE(?, call_uuid), updated_on = NOW()
        WHERE job_caller_info_id = ?${await primaryLegFilter()}`,
      [status, duration, hangupCause, callUuid, jci],
    );
  } catch (e) { logger.warn({ err: e.message, jci }, 'plivo-call-log: markTerminalByJci failed (non-fatal)'); }
}

// call_uuid identifies ONE leg, so this needs no primary-leg filter — it is
// already as precise as it can be, conference or not.
async function markTerminalByCallUuid(callUuid, { status, duration = null, hangupCause = null } = {}) {
  if (!callUuid) return;
  logger.info('Plivo call-log mark terminal by CallUUID · status=' + status + ' · duration=' + duration);
  try {
    await pool.query(
      `UPDATE tbl_plivo_call_log
          SET status = ?, ended_on = NOW(), duration = ?, hangup_cause = ?, updated_on = NOW()
        WHERE call_uuid = ?`,
      [status, duration, hangupCause, callUuid],
    );
  } catch (e) { logger.warn({ err: e.message, callUuid }, 'plivo-call-log: markTerminalByCallUuid failed (non-fatal)'); }
}

/* ══════════════════════════════════════════════════════════════════════════
 * CONFERENCE LEGS
 *
 * Everything below reads and writes the SAME table through the conference
 * columns. services/plivo-conference.service.js orchestrates (it owns the Plivo
 * wire shapes); this file owns the SQL, so there is exactly one place that
 * knows how a leg is stored.
 *
 * Every function takes an OPTIONAL pool so the conference service can keep
 * injecting one (which is what makes it testable against the fake-pool harness
 * without a database). Defaulting to the module pool keeps the existing callers
 * unchanged.
 * ══════════════════════════════════════════════════════════════════════════ */

// The 9812•••••• form, rebuilt from the four digits the projection returned.
// Mirrors plivo.service.js::maskForDisplay for a normalised Indian number
// without importing it — this module must stay loadable on its own.
function maskLeg(row) {
  if (!row) return row;
  const prefix = row.number_prefix == null ? null : String(row.number_prefix);
  const out = { ...row, masked_number: prefix ? prefix + '••••••' : null };
  delete out.number_prefix;
  return out;
}

/*
 * Back-fill conference_id + participant_role on the operator's OWN leg.
 *
 * routes/admin/calls.js mints the conference BEFORE it writes the call-log row,
 * so it can (and should) pass both straight into record(). This exists so the
 * labelling does not DEPEND on that ordering: the conference service calls it
 * the first time a second participant is added, and it stamps whichever row for
 * this jci is not yet attached to a room.
 *
 * Idempotent by construction — after the first run the row has a conference_id,
 * so `conference_id IS NULL` matches nothing.
 */
async function adoptOperatorLeg(conferenceId, jci, db = pool) {
  if (conferenceId == null || jci == null) return 0;
  if (!(await hasConferenceColumns())) return 0;
  try {
    const [r] = await db.query(
      `UPDATE tbl_plivo_call_log
          SET conference_id = ?, participant_role = 'operator', updated_on = NOW()
        WHERE job_caller_info_id = ? AND conference_id IS NULL`,
      [conferenceId, jci],
    );
    const n = (r && r.affectedRows) || 0;
    if (n) logger.info('Plivo call-log operator leg attached to conference · jci=' + jci + ' · conf=' + conferenceId);
    return n;
  } catch (e) {
    logger.warn({ err: e.message, jci }, 'plivo-call-log: adoptOperatorLeg failed (non-fatal)');
    return 0;
  }
}

/*
 * Insert a dialled conference leg, INSERT-FIRST — the audit row exists before
 * Plivo is asked to dial, so a leg can never be billed without a row naming who
 * caused it.
 *
 * THE DUPLICATE GUARD IS THE `NOT EXISTS`, AND IT IS ONE STATEMENT ON PURPOSE.
 * Two simultaneous clicks on "add the technician" must cost one billed leg, not
 * two, and a SELECT-then-INSERT loses that race. Keying on
 * (conference_id, participant_role, last-10 digits) rather than on the digits
 * alone is deliberate: in QA several targets can redirect to one test number,
 * and a digits-only key would falsely refuse a legitimate multi-party test.
 * A re-add AFTER someone drops is allowed — their old row is terminal, so
 * NOT EXISTS passes.
 *
 * Returns { ok:true, id } | { ok:false, code:'duplicate' | 'db_error' }.
 */
async function insertConferenceLeg({
  conferenceId,
  jobCallerInfoId = null,
  jobId = null,
  role,
  targetId = null,
  displayName = null,
  dialedNumber,
  receiverNumber = null,
  callerUserId = null,
  callerName = null,
  callMode = 'web',
  callFlow = 'conference',
} = {}, db = pool) {
  const tail = String(dialedNumber || '').replace(/\D/g, '').slice(-10);
  try {
    const [r] = await db.query(
      `INSERT INTO tbl_plivo_call_log
         (conference_id, participant_role, participant_target_id, job_caller_info_id, job_id,
          call_mode, call_flow, caller_user_id, caller_name, receiver_name,
          receiver_number, dialed_number, status, initiated_on)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW()
         FROM DUAL
        WHERE NOT EXISTS (
          SELECT 1 FROM tbl_plivo_call_log x
           WHERE x.conference_id = ?
             AND x.participant_role = ?
             AND RIGHT(x.dialed_number, 10) = ?
             AND x.status IN (?, ?, ?)
        )`,
      [conferenceId, role, targetId, jobCallerInfoId, jobId,
        callMode, callFlow, callerUserId, callerName, displayName,
        receiverNumber || dialedNumber, dialedNumber, LEG_STATUS.DIALLING,
        conferenceId, role, tail, ...ACTIVE_LEG_STATUSES],
    );
    if (!r || !r.affectedRows) return { ok: false, code: 'duplicate' };
    return { ok: true, id: r.insertId };
  } catch (e) {
    logger.error('✗ Conference leg insert failed · conf=' + conferenceId + ' · ' + e.message);
    return { ok: false, code: 'db_error' };
  }
}

/*
 * Find the leg a Plivo callback is about, WITHIN one conference. Three probes,
 * most-specific first:
 *   1. conference_member_id — the id the mute/kick URLs use
 *   2. call_uuid            — the leg's own uuid
 *   3. dialed_number tail   — last resort, and only among still-active legs,
 *                             newest first (a re-add after a drop is the one
 *                             Plivo means)
 *
 * The digits probe reads a server-side-only column; nothing derived from it is
 * logged or returned. It exists because the first two ids can BOTH be missing
 * on the very first callback for a leg.
 */
async function findConferenceLeg(conferenceId, { memberId, callUuid, toNumber } = {}, db = pool) {
  const sel = `SELECT id, status, conference_member_id AS member_id, call_uuid AS participant_uuid,
                      participant_role AS target_kind,
                      LEFT(RIGHT(dialed_number, 10), 4) AS number_prefix
                 FROM tbl_plivo_call_log`;
  try {
    if (memberId) {
      const [rows] = await db.query(
        `${sel} WHERE conference_id = ? AND conference_member_id = ? LIMIT 1`,
        [conferenceId, String(memberId)],
      );
      if (rows && rows[0]) return maskLeg(rows[0]);
    }
    if (callUuid) {
      const [rows] = await db.query(
        `${sel} WHERE conference_id = ? AND call_uuid = ? LIMIT 1`,
        [conferenceId, String(callUuid)],
      );
      if (rows && rows[0]) return maskLeg(rows[0]);
    }
    const tail = String(toNumber || '').replace(/\D/g, '').slice(-10);
    if (tail.length === 10) {
      const [rows] = await db.query(
        `${sel} WHERE conference_id = ? AND RIGHT(dialed_number, 10) = ? AND status IN (?, ?, ?)
          ORDER BY id DESC LIMIT 1`,
        [conferenceId, tail, ...ACTIVE_LEG_STATUSES],
      );
      if (rows && rows[0]) return maskLeg(rows[0]);
    }
  } catch (e) {
    logger.warn(`⚠ Conference leg lookup failed · conf=${conferenceId} · ${e.message}`);
  }
  return null;
}

// Every leg of a room, MASKED, oldest first (the operator's leg leads).
async function listConferenceLegs(conferenceId, db = pool) {
  try {
    const [rows] = await db.query(
      `SELECT ${LEG_PUBLIC_COLUMNS} FROM tbl_plivo_call_log WHERE conference_id = ? ORDER BY id ASC`,
      [conferenceId],
    );
    return (rows || []).map(maskLeg);
  } catch (e) {
    logger.warn('⚠ Conference legs load failed · conf=' + conferenceId + ' · ' + e.message);
    return [];
  }
}

// One leg, MASKED — what an add-participant response echoes back.
async function getConferenceLeg(legId, db = pool) {
  try {
    const [rows] = await db.query(
      `SELECT ${LEG_PUBLIC_COLUMNS} FROM tbl_plivo_call_log WHERE id = ? LIMIT 1`,
      [legId],
    );
    return rows && rows[0] ? maskLeg(rows[0]) : null;
  } catch {
    return null;
  }
}

/*
 * One leg WITH its dialled digits. SERVER-SIDE ONLY — the digits are needed to
 * recover a member id by reading the room back from Plivo when a callback never
 * arrived. This is the only read in this file that loads a whole number, and
 * nothing it returns may be spread into a response.
 */
async function loadConferenceLegForControl(legId, conferenceId, db = pool) {
  try {
    const [rows] = await db.query(
      `SELECT id, conference_id, conference_member_id AS member_id, dialed_number, status,
              participant_role AS target_kind,
              LEFT(RIGHT(dialed_number, 10), 4) AS number_prefix
         FROM tbl_plivo_call_log
        WHERE id = ? AND conference_id = ? LIMIT 1`,
      [legId, conferenceId],
    );
    return (rows && rows[0]) || null;
  } catch (e) {
    logger.warn('⚠ Conference leg load failed · leg=' + legId + ' · ' + e.message);
    return null;
  }
}

// Land the provider ids on a leg that is still dialling. COALESCE so a later,
// better-informed callback never blanks what an earlier one supplied.
async function stampConferenceLegIds(legId, { memberId = null, callUuid = null } = {}, db = pool) {
  try {
    await db.query(
      `UPDATE tbl_plivo_call_log
          SET conference_member_id = COALESCE(?, conference_member_id),
              call_uuid = COALESCE(?, call_uuid),
              updated_on = NOW()
        WHERE id = ? AND status = ?`,
      [memberId || null, callUuid || null, legId, LEG_STATUS.DIALLING],
    );
    return true;
  } catch (e) {
    logger.warn('⚠ Conference leg id stamp failed · leg=' + legId + ' · ' + e.message);
    return false;
  }
}

/*
 * Move ONE leg's status. `from` guards the transition so a duplicate or late
 * callback cannot resurrect a leg that has already hung up — the returned
 * affectedRows is what the callers use to decide whether THIS callback is the
 * one that actually moved the row.
 */
async function markConferenceLegStatus(legId, {
  status,
  from = ACTIVE_LEG_STATUSES,
  answeredOn = false,
  endedOn = false,
  duration = null,
  hangupCause = null,
  memberId = null,
  callUuid = null,
} = {}, db = pool) {
  const froms = Array.isArray(from) ? from : [from];
  const sets = [
    'status = ?',
    'conference_member_id = COALESCE(?, conference_member_id)',
    'call_uuid = COALESCE(?, call_uuid)',
    'updated_on = NOW()',
  ];
  const params = [status, memberId || null, callUuid || null];
  if (answeredOn) sets.splice(1, 0, 'answered_on = COALESCE(answered_on, NOW())');
  if (endedOn) sets.splice(1, 0, 'ended_on = COALESCE(ended_on, NOW())');
  if (duration != null) { sets.push('duration = COALESCE(?, duration)'); params.push(duration); }
  if (hangupCause != null) { sets.push('hangup_cause = COALESCE(?, hangup_cause)'); params.push(String(hangupCause).slice(0, 64)); }
  try {
    const [r] = await db.query(
      `UPDATE tbl_plivo_call_log SET ${sets.join(', ')}
        WHERE id = ? AND status IN (${froms.map(() => '?').join(', ')})`,
      [...params, legId, ...froms],
    );
    return (r && r.affectedRows) || 0;
  } catch (e) {
    logger.warn('⚠ Conference leg status write failed · leg=' + legId + ' · ' + e.message);
    return 0;
  }
}

/*
 * Record that the PROVIDER refused this leg. Not deleted, stamped: "we tried to
 * dial this person and Plivo said no" is the interesting fact, and the row is
 * already the audit of who asked for it.
 *
 * The detail lands in hangup_cause (VARCHAR(64)) because that is where every
 * other terminal reason on this table lives. The FULL provider body is logged
 * loudly by the service's HTTP chokepoint — this column is the breadcrumb, the
 * log is the diagnosis.
 */
async function markConferenceLegFailed(legId, detail, db = pool) {
  try {
    await db.query(
      `UPDATE tbl_plivo_call_log
          SET status = ?, ended_on = COALESCE(ended_on, NOW()),
              hangup_cause = COALESCE(hangup_cause, ?), updated_on = NOW()
        WHERE id = ?`,
      [LEG_STATUS.FAILED, String(detail || 'provider refused').slice(0, 64), legId],
    );
    return true;
  } catch (e) {
    logger.warn('⚠ Conference leg failure stamp failed · leg=' + legId + ' · ' + e.message);
    return false;
  }
}

// Close every still-active leg of a room — the room ended, so they all did.
async function closeConferenceLegs(conferenceId, { status = LEG_STATUS.LEFT } = {}, db = pool) {
  try {
    const [r] = await db.query(
      `UPDATE tbl_plivo_call_log
          SET status = ?, ended_on = COALESCE(ended_on, NOW()), updated_on = NOW()
        WHERE conference_id = ? AND status IN (?, ?, ?)`,
      [status, conferenceId, ...ACTIVE_LEG_STATUSES],
    );
    return (r && r.affectedRows) || 0;
  } catch (e) {
    logger.warn('⚠ Conference legs close failed · conf=' + conferenceId + ' · ' + e.message);
    return 0;
  }
}

// How many legs are still on the call. DERIVED, never stored: a counter column
// that four writers incremented and decremented is a counter that drifts.
async function countActiveConferenceLegs(conferenceId, db = pool) {
  try {
    const [rows] = await db.query(
      `SELECT COUNT(*) AS n FROM tbl_plivo_call_log
        WHERE conference_id = ? AND status IN (?, ?, ?)`,
      [conferenceId, ...ACTIVE_LEG_STATUSES],
    );
    return Number(rows && rows[0] && rows[0].n) || 0;
  } catch (e) {
    logger.warn('⚠ Conference leg count failed · conf=' + conferenceId + ' · ' + e.message);
    return null;
  }
}

/*
 * The reaper's stuck-leg sweep: legs still dialling/ringing long past the ring
 * timeout, with their room's state alongside so the caller can tell "nobody
 * picked up" from "the room ended under them".
 *
 * ⚠ THE WINDOW IS `NOW() - INTERVAL ? SECOND`, AND THAT IS CORRECT HERE — the
 * opposite of the rule that applies to tbl_job_conference. The clock a
 * comparison must use is the clock the COLUMN was written in:
 *   • tbl_job_conference.created_on is written app-side (new Date() + the pool's
 *     +05:30 session timezone), i.e. the IST wall clock. NOW() is the DB
 *     server's zone, so comparing the two would skew by hours — that sweep must
 *     use an app-side Date, and it does.
 *   • tbl_plivo_call_log.initiated_on is written with SQL NOW() (this table's
 *     own convention since 2026-06-19). NOW()-relative arithmetic compares the
 *     server clock to itself and is exact by construction; handing it an IST
 *     Date would introduce the very skew the other rule exists to avoid.
 * Both sweeps are therefore zone-independent. Neither depends on the two tables
 * agreeing about what time it is.
 *
 * `pcl.conference_id IS NOT NULL` is redundant against the INNER JOIN and is
 * there for the OPTIMISER: tbl_plivo_call_log is a ~940k-row table and this
 * runs every five minutes, so the sweep must enter through
 * idx_plivo_log_conference rather than scan the table looking for two statuses.
 */
async function listStuckConferenceLegs({ olderThanSec, limit = 100 } = {}, db = pool) {
  const secs = Number(olderThanSec);
  if (!Number.isFinite(secs) || secs <= 0) return [];
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  try {
    const [rows] = await db.query(
      `SELECT pcl.id, pcl.conference_id, pcl.status, pcl.participant_role AS target_kind,
              LEFT(RIGHT(pcl.dialed_number, 10), 4) AS number_prefix,
              c.status AS conf_status, c.ended_on AS conf_ended_on
         FROM tbl_plivo_call_log pcl
         JOIN tbl_job_conference c ON c.id = pcl.conference_id
        WHERE pcl.conference_id IS NOT NULL
          AND pcl.status IN (?, ?)
          AND pcl.initiated_on < NOW() - INTERVAL ? SECOND
        ORDER BY pcl.id ASC
        LIMIT ?`,
      [LEG_STATUS.DIALLING, LEG_STATUS.RINGING, secs, lim],
    );
    return (rows || []).map(maskLeg);
  } catch (e) {
    logger.warn('⚠ Conference stuck-leg sweep failed · ' + e.message);
    return null;
  }
}

// Count only — the reaper's dry run reports what it WOULD close without writing.
async function countStuckConferenceLegs({ olderThanSec } = {}, db = pool) {
  const secs = Number(olderThanSec);
  if (!Number.isFinite(secs) || secs <= 0) return 0;
  const [rows] = await db.query(
    `SELECT COUNT(*) AS n FROM tbl_plivo_call_log
      WHERE conference_id IS NOT NULL AND status IN (?, ?)
        AND initiated_on < NOW() - INTERVAL ? SECOND`,
    [LEG_STATUS.DIALLING, LEG_STATUS.RINGING, secs],
  );
  return Number(rows && rows[0] && rows[0].n) || 0;
}

module.exports = {
  record,
  markRinging,
  markAnswered,
  setRecordingRequested,
  setRecording,
  markTerminalByJci,
  markTerminalByCallUuid,
  // conference legs
  LEG_STATUS,
  ACTIVE_LEG_STATUSES,
  adoptOperatorLeg,
  insertConferenceLeg,
  findConferenceLeg,
  listConferenceLegs,
  getConferenceLeg,
  loadConferenceLegForControl,
  stampConferenceLegIds,
  markConferenceLegStatus,
  markConferenceLegFailed,
  closeConferenceLegs,
  countActiveConferenceLegs,
  listStuckConferenceLegs,
  countStuckConferenceLegs,
  hasConferenceColumns,
};
