'use strict';

const { pool } = require('../db');
const logger = require('../logger');
const conf = require('./plivo-conference.service');
const legs = require('./plivo-call-log.service');

/*
 * Conference reaper — the COST BACKSTOP for Plivo Multi-Party Calls.
 *
 * ─── WHY THIS EXISTS ─────────────────────────────────────────────────────
 *
 * An orphaned conference bills EVERY leg until Plivo's own default ceiling
 * fires. Three things have to go wrong at once for that to happen — but all
 * three are live possibilities on day one:
 *
 *   1. `endMpcOnExit` on the operator leg is an UNVERIFIED wire shape (see the
 *      marked block in services/plivo-conference.service.js). If it is wrong,
 *      the operator hangs up and the room keeps running with the customer and
 *      the technician still connected. It is now the PRIMARY cost guard, which
 *      makes this sweep the only thing behind it.
 *   2. The MPCEnd webhook can be lost. Then the room may really be gone while
 *      our row still says 'live' — and ops's live panel reads that row.
 *   3. /api/admin/* is deliberately rate-limit-exempt, so a stuck UI can create
 *      conferences faster than anything else in this codebase can create cost.
 *
 * There is no feature flag on conferencing — conference is the DEFAULT shape of
 * every ops call — so this sweep protects 100% of ops calls, not a subset.
 *
 * ─── THE THREE PASSES ────────────────────────────────────────────────────
 *
 *   A. REAP    — force-end conferences past the leak-detector ceiling below.
 *   B. RECONCILE 'creating' — a row stuck in 'creating' means the MPCStart
 *                webhook never arrived, so ops is flying blind on the live
 *                panel and we cannot tell a room that never materialised from
 *                one that is quietly running. We ask Plivo what is actually
 *                true and either promote the row to 'live' or release it.
 *   C. RECONCILE stuck legs — legs still 'initiated'/'ringing' long past the
 *                ring timeout. Same story one level down: ops is shown a leg
 *                that is still connecting when it never will.
 *
 * ─── SAFETY POSTURE ──────────────────────────────────────────────────────
 *
 * Every pass is BOUNDED (hard LIMIT, like services/recording-backfill.service.js)
 * and iterates SEQUENTIALLY against the provider — a reaper that fans out is a
 * second incident, not a fix. Nothing throws: the whole run is try/caught and
 * returns a result object, per the cron convention.
 *
 * When in doubt the reaper errs towards KEEPING A ROW BILLABLE. A conference we
 * wrongly mark ended is a cost leak we have blinded ourselves to; a conference
 * we wrongly keep 'live' costs one more sweep. Hence: a provider read that
 * FAILS changes nothing, and a conference Plivo still reports as running is
 * never marked ended.
 *
 * ─── ⚠ TWO CLOCKS, TWO CORRECT ANSWERS ───────────────────────────────────
 *
 * A cutoff must be computed in the clock the COLUMN was written in, and the two
 * tables this sweep touches do not use the same one:
 *
 *   • tbl_job_conference (passes A and B) is written app-side — new Date() plus
 *     the pool's +05:30 session timezone (db.js) — so its columns hold the IST
 *     WALL CLOCK. NOW() is whatever zone the DB server runs in (UTC), so
 *     `NOW() - INTERVAL n SECOND` here would skew by 5.5 hours; on a
 *     minutes-wide window that means matching NOTHING, silently never reaping,
 *     and the cost leak going uncaught. These passes use an app-side JS Date,
 *     which mysql2 formats in the connection timezone — IST vs IST, exact.
 *   • tbl_plivo_call_log (pass C) is NOW()-written throughout, by its own
 *     convention since 2026-06-19. There, `NOW() - INTERVAL n SECOND` compares
 *     the server clock to itself and is exact by construction, while handing it
 *     an IST Date would introduce the very skew the first rule avoids.
 *
 * Both are therefore zone-independent, and neither depends on the two tables
 * agreeing about what time it is.
 */

/*
 * ══════════════════════════════════════════════════════════════════════════
 * THE CEILING. INTERNAL, ON PURPOSE.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * This is a LEAK DETECTOR, not a product limit. It is not the answer to "how
 * long may an ops call run" — that question has no answer we should be
 * enforcing, and the three `plivo.conference.max.*` properties that used to try
 * were deleted for exactly that reason. This number answers a different
 * question: "past what age is a room that is STILL MARKED LIVE almost certainly
 * a room nobody is in?"
 *
 * Six hours is deliberately far longer than any real ops call. That is the
 * point — a reap should mean something is BROKEN (endMpcOnExit not working, the
 * MPCEnd webhook lost), never that a long call was cut off. If this ever fires
 * on a genuine conversation, raise it; do not turn it into a property.
 *
 * It is deliberately NOT in easyfix_properties. A safety net ops has to
 * configure is a safety net that will one day be configured to zero, or to
 * 999999, by someone who thought it was a spend cap. The only ceiling in the
 * system lives here, in code, in one place, reviewed like code.
 *
 * WHAT IT IS NOT A SUBSTITUTE FOR: endMpcOnExit="true" on the operator's leg
 * ends the room the moment the operator hangs up, and Plivo's own account
 * defaults bound a leg regardless. This is the third line, not the first.
 */
const LEAK_DETECTOR_CEILING_SEC = 6 * 60 * 60; // 6 hours

// Bounds. One sweep can never fan out past these, whatever the DB says.
const REAP_LIMIT = 25;            // provider DELETE + read-back each — the expensive pass
const CREATING_LIMIT = 25;        // provider GET each
const PARTICIPANT_LIMIT = 100;    // DB-only

// How long a row may sit in 'creating' before we go ask Plivo about it. The
// operator leg has ring_timeout to answer and MPCStart should follow
// immediately, so anything past that plus two minutes is a lost webhook.
function creatingGraceSec() {
  return conf.ringTimeoutSec() + 120;
}

// How long a leg may sit 'initiated'/'ringing'. Generous on purpose: marking a
// leg no_answer that is actually connected would hide it from the roster.
function legGraceSec() {
  return conf.ringTimeoutSec() + 300;
}

// The ceiling, exposed as a function so the cron result and the ops Test button
// report the same number the sweep used.
function ceilingSec() {
  return LEAK_DETECTOR_CEILING_SEC;
}

function agoIst(seconds) {
  return new Date(Date.now() - seconds * 1000);
}

// Plivo's own status vocabulary for an MPC is UNVERIFIED (see the marked block
// in plivo-conference.service.js). Only an explicitly terminal-looking status
// counts as ended; ANYTHING ELSE we treat as still running, because that is the
// cost-safe direction.
function providerSaysEnded(status) {
  const s = String(status || '').toLowerCase();
  return /(^|[^a-z])(ended|completed|terminated|failed)([^a-z]|$)/.test(s);
}

async function safeQuery(what, sql, params) {
  try {
    const [r] = await pool.query(sql, params);
    return r || null;
  } catch (e) {
    logger.warn(`⚠ Conference reaper DB write failed (${what}) · ${e.message}`);
    return null;
  }
}

// ─── PASS A — force-end conferences past the ceiling ────────────────────

async function reapStale({ limit = REAP_LIMIT } = {}) {
  // The ceiling is passed IN. listStaleConferences() has no default and refuses
  // without one, precisely so a second competing ceiling can never appear.
  const found = await conf.listStaleConferences({ olderThanSec: LEAK_DETECTOR_CEILING_SEC, limit }, pool);
  if (!found.ok) return { ceilingSec: LEAK_DETECTOR_CEILING_SEC, scanned: 0, ended: 0, endFailed: 0, dbError: true };

  let ended = 0;
  let endFailed = 0;
  // SEQUENTIAL. Each iteration is a provider DELETE plus a read-back.
  for (const c of found.conferences) {
    const r = await conf.endConference({ conferenceId: c.id, reason: 'reaper' }, pool);
    if (r.ok) {
      ended += 1;
      // A reaped conference is a cost leak that was CAUGHT. Count these — a
      // rising count means endMpcOnExit or the MPCEnd webhook is not working.
      logger.warn(`🧹 Conference REAPED · id=${c.id} · name=${c.friendly_name} · status was '${c.status}'`
        + ` · started=${c.started_on || c.created_on} · ceiling=${found.ceilingSec}s (leak detector)`
        + (r.alreadyEnded ? ' (already ended)' : ` · verified=${r.verified}`));
    } else {
      endFailed += 1;
      // Deliberately still 'live' in the DB — endConference() does not mark a
      // failed teardown as ended, so the next sweep retries. Loud, because a
      // conference we cannot end is money we cannot stop.
      logger.error(`✗ Conference REAP FAILED · id=${c.id} · name=${c.friendly_name} · code=${r.code}`
        + ` · http=${r.httpStatus ?? '-'} · body=${r.body || '-'} — still billing, will retry next sweep`);
    }
  }
  return { ceilingSec: found.ceilingSec, scanned: found.conferences.length, ended, endFailed };
}

// ─── PASS B — reconcile rows stranded in 'creating' ─────────────────────

async function reconcileCreating({ limit = CREATING_LIMIT } = {}) {
  const cutoff = agoIst(creatingGraceSec());
  let rows = [];
  try {
    const [r] = await pool.query(
      `SELECT id, friendly_name, status, created_on, started_on
         FROM tbl_job_conference
        WHERE status = 'creating' AND created_on < ?
        ORDER BY id ASC
        LIMIT ?`,
      [cutoff, Math.min(Math.max(Number(limit) || CREATING_LIMIT, 1), 100)],
    );
    rows = r || [];
  } catch (e) {
    logger.warn('⚠ Conference reaper: creating-sweep failed · ' + e.message);
    return { scanned: 0, promoted: 0, released: 0, unresolved: 0, dbError: true };
  }

  let promoted = 0;      // MPCStart was lost — Plivo says it IS running
  let released = 0;      // the MPC never materialised — close the record out
  let unresolved = 0;    // Plivo unreachable — change NOTHING, retry next sweep

  for (const c of rows) {
    const back = await conf.fetchConference(c.friendly_name);
    const now = new Date();

    if (!back.ok) {
      // Cannot read the provider. Leave the row exactly as it is: guessing
      // 'ended' here would hide a live conference from pass A.
      unresolved += 1;
      logger.warn(`⚠ Conference stuck in 'creating' and Plivo could not be read · id=${c.id}`
        + ` · name=${c.friendly_name} · http=${back.httpStatus ?? '-'} — unchanged, retrying next sweep`);
      continue;
    }

    if (back.found && !providerSaysEnded(back.status)) {
      await safeQuery('promote creating → live',
        `UPDATE tbl_job_conference
            SET status = 'live',
                mpc_uuid = COALESCE(?, mpc_uuid),
                started_on = COALESCE(started_on, ?),
                updated_on = ?
          WHERE id = ? AND status = 'creating'`,
        [back.mpcUuid || null, now, now, c.id]);
      promoted += 1;
      // If this fires at all, the MPCStart webhook is not reaching us — which
      // also means ops is flying blind on the live panel.
      logger.warn(`⚠ Conference was 'creating' but Plivo reports '${back.status || 'active'}' · id=${c.id}`
        + ` · name=${c.friendly_name} — promoted to live; the MPCStart webhook appears to be LOST`);
      continue;
    }

    /*
     * Plivo has no such conference (404) or reports it terminal. The MPC never
     * materialised — the operator never answered, or the answer XML was
     * rejected (an unparseable <Response> makes Plivo hang up SILENTLY, which
     * is exactly what this looks like from here).
     *
     * Mark 'failed', not 'ended': nothing ever ran. Its legs are closed as
     * 'failed' too, so the live panel stops showing legs that are connecting to
     * a room that does not exist.
     */
    await safeQuery('release stranded creating',
      `UPDATE tbl_job_conference
          SET status = 'failed',
              ended_on = COALESCE(ended_on, ?),
              end_reason = COALESCE(end_reason, 'error'),
              error = COALESCE(error, ?),
              updated_on = ?
        WHERE id = ? AND status = 'creating'`,
      [now, `reaper: MPC never materialised (provider http=${back.httpStatus ?? '-'})`.slice(0, 255), now, c.id]);
    await legs.closeConferenceLegs(c.id, { status: legs.LEG_STATUS.FAILED }, pool);
    released += 1;
    logger.warn(`🧹 Conference stranded in 'creating' RELEASED · id=${c.id} · name=${c.friendly_name}`
      + ` · Plivo ${back.found ? `reports '${back.status}'` : 'has no such conference'}`
      + ' — the MPC never materialised (check the operator answer XML, UNVERIFIED checklist item 6)');
  }

  return { scanned: rows.length, promoted, released, unresolved, graceSec: creatingGraceSec() };
}

// ─── PASS C — reconcile legs stuck dialling/ringing ─────────────────────

/*
 * Legs live in tbl_plivo_call_log now, so this pass reads and writes through
 * services/plivo-call-log.service.js. Two things follow from that and both are
 * improvements rather than compromises:
 *
 *   • the window is NOW()-relative, because that column is NOW()-written (see
 *     the two-clocks note at the top);
 *   • there is no participant_count to decrement. The live count is derived
 *     from these very rows, so closing one IS the decrement — the class of bug
 *     where a counter and the rows it counts disagree cannot occur.
 */
async function reconcileParticipants({ limit = PARTICIPANT_LIMIT } = {}) {
  const rows = await legs.listStuckConferenceLegs({ olderThanSec: legGraceSec(), limit }, pool);
  if (rows === null) return { scanned: 0, closed: 0, dbError: true };

  let closed = 0;
  for (const p of rows) {
    const confLive = conf.LIVE_CONFERENCE_STATUSES.includes(p.conf_status);
    /*
     * On a conference that has already ended, the leg simply went with it —
     * 'completed'. On a still-live one, a leg cannot still be ringing minutes
     * past ring_timeout, so nobody picked up: 'no_answer'. Either way this is a
     * webhook we never received, not a state we observed — so it is a WARN.
     */
    const terminal = confLive ? legs.LEG_STATUS.NO_ANSWER : legs.LEG_STATUS.LEFT;
    const n = await legs.markConferenceLegStatus(p.id, {
      status: terminal,
      from: [legs.LEG_STATUS.DIALLING, legs.LEG_STATUS.RINGING],
      endedOn: true,
      hangupCause: confLive ? 'reaper_no_answer' : 'reaper_conference_ended',
    }, pool);
    if (!n) continue;
    closed += 1;
    logger.warn(`🧹 Conference leg stuck in '${p.status}' closed as '${terminal}' · conf=${p.conference_id}`
      + ` · leg=${p.id} · kind=${p.target_kind} · ${p.masked_number || '-'}`
      + ' — its status webhook was never received');
  }
  return { scanned: rows.length, closed, graceSec: legGraceSec() };
}

// ─── the cron entry point ───────────────────────────────────────────────

/*
 * One sweep. Never throws — a cron tick that throws is a tick that silently
 * stops the next one. Returns a flat result object the Scheduled Jobs admin
 * page renders under "Last Run".
 */
async function run({ limit = REAP_LIMIT } = {}) {
  const t0 = Date.now();
  try {
    const reaped = await reapStale({ limit });
    const creating = await reconcileCreating({});
    const stuck = await reconcileParticipants({});
    const result = {
      ceilingSec: reaped.ceilingSec,
      scanned: reaped.scanned,
      ended: reaped.ended,
      endFailed: reaped.endFailed,
      creatingScanned: creating.scanned,
      creatingPromoted: creating.promoted,
      creatingReleased: creating.released,
      creatingUnresolved: creating.unresolved,
      legsScanned: stuck.scanned,
      legsClosed: stuck.closed,
      ms: Date.now() - t0,
    };
    // Quiet on a clean sweep (this runs every 5 minutes); loud the moment
    // anything was actually wrong.
    if (result.ended || result.endFailed || result.creatingReleased || result.creatingPromoted || result.legsClosed) {
      logger.warn('Conference reaper · ' + JSON.stringify(result));
    }
    return result;
  } catch (e) {
    logger.error('✗ Conference reaper sweep failed · ' + e.message);
    return { ok: false, error: e.message, ms: Date.now() - t0 };
  }
}

/*
 * Manual "Test" from the Scheduled Jobs admin page.
 *
 *  - NO sourceId → DRY RUN. Reports exactly what the next sweep would touch
 *    without writing or calling Plivo, so ops can look before they leap.
 *  - sourceId    → force-end THAT conference id right now (reason 'reaper').
 *    ⚠ This really does hang up a live call. It exists because "does the Plivo
 *    DELETE actually work on our account" is an UNVERIFIED wire shape and the
 *    only honest way to answer it is to try it once, deliberately.
 */
async function runTest({ sourceId } = {}) {
  const raw = String(sourceId ?? '').trim();
  if (!raw) {
    const stale = await conf.listStaleConferences({ olderThanSec: LEAK_DETECTOR_CEILING_SEC, limit: REAP_LIMIT }, pool);
    let creatingCount = 0;
    let legCount = 0;
    try {
      const [[c]] = await pool.query(
        `SELECT COUNT(*) AS n FROM tbl_job_conference WHERE status = 'creating' AND created_on < ?`,
        [agoIst(creatingGraceSec())],
      );
      creatingCount = Number(c && c.n) || 0;
      legCount = await legs.countStuckConferenceLegs({ olderThanSec: legGraceSec() }, pool);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    return {
      ok: true,
      dryRun: true,
      ceilingSec: LEAK_DETECTOR_CEILING_SEC,
      wouldForceEnd: (stale.conferences || []).map((c) => ({
        id: c.id, name: c.friendly_name, status: c.status, startedOn: c.started_on || c.created_on,
      })),
      wouldReconcileCreating: creatingCount,
      wouldCloseStuckLegs: legCount,
      note: 'Dry run — nothing was written and Plivo was not called. The ceiling is a LEAK DETECTOR '
        + '(an internal constant, not a property): a reap means something is broken, not that a long call was cut off. '
        + 'Enter a conference ID to force-end that conference for real.',
    };
  }

  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, error: 'Enter a valid conference ID (tbl_job_conference.id), or leave it blank for a dry run.' };
  }
  const r = await conf.endConference({ conferenceId: id, reason: 'reaper' }, pool);
  return r.ok
    ? { ok: true, conferenceId: id, ended: true, alreadyEnded: !!r.alreadyEnded, verified: r.verified ?? null, duration: r.duration ?? null }
    : { ok: false, conferenceId: id, error: r.message, code: r.code, httpStatus: r.httpStatus ?? null, body: r.body || null };
}

module.exports = {
  run,
  runTest,
  reapStale,
  reconcileCreating,
  reconcileParticipants,
  creatingGraceSec,
  legGraceSec,
  ceilingSec,
  LEAK_DETECTOR_CEILING_SEC,
};
