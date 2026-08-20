/*
 * LMS chase log — who chased whom, when, how, and what happened.
 *
 * The spec's requirement is one sentence: "Every chase is logged — who
 * chased, when, how. So nobody says they were never told."
 *
 * That sentence cuts both ways, which is why a SKIPPED chase is logged too.
 * The bulk nudge silently drops anyone already chased inside the cooldown
 * window; a skip that leaves no trace is indistinguishable from a bug, and
 * the next person to ask "why didn't he get nudged?" has nothing to read.
 *
 * MODELLED ON services/easyfixer-sensitive-change.service.js
 * Three properties are copied deliberately from that file:
 *
 *   1. recordChase() NEVER THROWS into the caller's path. Losing an audit
 *      row is bad; failing a WhatsApp message that has already left the
 *      building because the note did not write is worse. A failure logs at
 *      error with everything needed to reconstruct the row by hand.
 *
 *   2. MASKING HAPPENS HERE, not at the call site. Callers pass the full
 *      number they dialled; this module stores only the masked form. A
 *      future caller cannot bypass it, because there is no parameter that
 *      accepts a pre-masked value.
 *
 *   3. actor_role_name is a SNAPSHOT. The log has to answer "did the
 *      training team chase, or did the field?" — resolving the role at read
 *      time would let a role rename, or a user moving teams, rewrite
 *      history.
 *
 * WHY THIS TABLE AND NOT AN EXISTING ONE
 * There is no generic audit helper in this repo. The three logs that exist
 * are all purpose-built and none of them can carry a chase:
 * tbl_easyfixer_sensitive_change_log is keyed to a technician FIELD change,
 * tbl_easyfixer_lifecycle_status_log to a status transition, and
 * dashboard_notification_log is the in-app inbox, not an audit trail.
 */

const crypto = require('crypto');

const { pool } = require('../db');
const logger = require('../logger');
const { maskMobile } = require('../utils/mask-mobile');
const properties = require('./properties.service');

/* Channels. VARCHAR in the schema, closed set here — see the migration
 * header for why a fourth channel must not need an ALTER. */
const CHANNEL_WHATSAPP = 'whatsapp';
const CHANNEL_CALL = 'call';
const CHANNEL_NUDGE = 'nudge';
const CHANNEL_MARK_CHASED = 'mark_chased';
const CHANNEL_HANDOFF = 'handoff';

const CHANNELS = Object.freeze([
  CHANNEL_WHATSAPP, CHANNEL_CALL, CHANNEL_NUDGE, CHANNEL_MARK_CHASED, CHANNEL_HANDOFF,
]);

/* Outcomes. 'skipped' is a first-class outcome, not an absence — see the
 * header. 'noted' is an off-platform contact the operator is recording. */
const OUTCOMES = Object.freeze(['sent', 'failed', 'skipped', 'queued', 'noted']);

const TARGET_TYPES = Object.freeze(['course', 'assignment', 'session', 'technician']);

const SOURCE_CRM = 'crm';
const SOURCE_CRON = 'cron';
const SOURCE_SYSTEM = 'system';

const DEFAULT_COOLDOWN_HOURS = 20;

/**
 * Cooldown window, in hours, before the same channel may chase the same
 * technician again.
 *
 * Default 20 rather than 24 so a team working to a daily rhythm is never
 * blocked by yesterday's chase running a few minutes late.
 *
 * `propNumber`-shaped guard: getProperty returns a raw string, and
 * Number('') is 0, not NaN — a missing or blank property must fall back,
 * not silently become "no cooldown at all". (Exactly the coercion that
 * disabled the rewards earn cycle in August.)
 */
function cooldownHours() {
  const raw = properties.getProperty('lms.chase.cooldown.hours');
  if (raw == null || String(raw).trim() === '') return DEFAULT_COOLDOWN_HOURS;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_COOLDOWN_HOURS;
}

/** Maximum technicians one bulk chase may touch. Mirrors the 500 ceiling the assign endpoint already enforces. */
function bulkMax() {
  const raw = properties.getProperty('lms.chase.bulk.max');
  if (raw == null || String(raw).trim() === '') return 500;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n > 0 ? n : 500;
}

/** A batch id shared by every row of one bulk action, so it can be read back as one event. */
function newBatchId() {
  return crypto.randomUUID();
}

/*
 * Normalise one entry into positional INSERT parameters.
 *
 * Split out from recordChase so the batch path produces byte-identical rows
 * to the single path — two hand-written parameter lists would drift, and the
 * drift would only ever show up in an audit nobody reads until it matters.
 */
function toRow(entry) {
  return [
    Number(entry.efrId),
    entry.channel,
    entry.outcome,
    entry.outcomeDetail ?? null,
    entry.providerMessageId ?? null,
    entry.targetType || 'technician',
    entry.courseId ?? null,
    entry.sessionId ?? null,
    entry.detectorKey ?? null,
    entry.batchId ?? null,
    entry.actor?.user_id ?? entry.actorUserId ?? null,
    entry.actorRoleName ?? null,
    entry.actorSource || SOURCE_CRM,
    // The one transformation that must not be skippable.
    entry.recipientMobile ? maskMobile(String(entry.recipientMobile)) : null,
    entry.templateName ?? null,
    entry.languageCode ?? null,
    new Date(),
  ];
}

const INSERT_COLUMNS = `
  (efr_id, channel, outcome, outcome_detail, provider_message_id,
   target_type, course_id, session_id, detector_key, batch_id,
   actor_user_id, actor_role_name, actor_source, recipient_masked,
   template_name, language_code, created_at)`;

const ONE_ROW_PLACEHOLDERS = '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

/**
 * Append one chase to the log.
 *
 * NEVER REJECTS. See the file header.
 *
 * @param {object} entry
 * @param {number} entry.efrId              technician chased
 * @param {string} entry.channel            whatsapp | call | nudge | mark_chased | handoff
 * @param {string} entry.outcome            sent | failed | skipped | queued | noted
 * @param {string|null} [entry.outcomeDetail]   provider error, 'cooldown', an operator note
 * @param {string|null} [entry.providerMessageId]
 * @param {string} [entry.targetType]       course | assignment | session | technician
 * @param {number|null} [entry.courseId]
 * @param {number|null} [entry.sessionId]
 * @param {string|null} [entry.detectorKey] which action-home row this came from
 * @param {string|null} [entry.batchId]     shared across one bulk action
 * @param {object|null} [entry.actor]       req.user
 * @param {string|null} [entry.actorRoleName]  snapshotted, not resolved later
 * @param {string} [entry.actorSource]      crm | cron | system
 * @param {string|null} [entry.recipientMobile]  FULL number in — MASKED here
 * @param {string|null} [entry.templateName]
 * @param {string|null} [entry.languageCode]
 * @param {object} [conn]                   optional mysql2 connection
 * @returns {Promise<{logged: boolean}>}
 */
async function recordChase(entry, conn) {
  const db = conn || pool;
  const row = toRow(entry);
  try {
    await db.query(
      `INSERT INTO lms_chase_log ${INSERT_COLUMNS} VALUES ${ONE_ROW_PLACEHOLDERS}`,
      row,
    );
    /* Best-effort: a chase is what moves a hand-off from open to chased, so
     * the field team never has to remember to tick anything. Deliberately
     * after the log write and separately guarded — failing to advance a
     * hand-off must not lose the audit row that proves the chase happened. */
    await advanceHandoff(entry, db);
    return { logged: true };
  } catch (err) {
    logger.error(
      {
        efrId: entry.efrId,
        channel: entry.channel,
        outcome: entry.outcome,
        courseId: entry.courseId ?? null,
        actorUserId: entry.actor?.user_id ?? entry.actorUserId ?? null,
        batchId: entry.batchId ?? null,
        err: err.message,
      },
      'CHASE LOG WRITE FAILED — the chase was attempted but is NOT recorded. '
      + 'Reconstruct this row in lms_chase_log by hand.',
    );
    return { logged: false };
  }
}

/**
 * Append many chases as ONE multi-row INSERT.
 *
 * A bulk nudge to 400 technicians must not be 400 round trips, and it must
 * not be 400 chances to half-write the audit trail.
 *
 * Same masking, same never-throws.
 */
async function recordChaseBatch(entries, conn) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (!list.length) return { logged: true, count: 0 };

  const db = conn || pool;
  const placeholders = list.map(() => ONE_ROW_PLACEHOLDERS).join(', ');
  const params = list.flatMap(toRow);

  try {
    await db.query(
      `INSERT INTO lms_chase_log ${INSERT_COLUMNS} VALUES ${placeholders}`,
      params,
    );
    logger.info('Chase batch logged · rows=' + list.length + ' · batchId=' + (list[0].batchId ?? '-'));
    for (const entry of list) {
      await advanceHandoff(entry, db);
    }
    return { logged: true, count: list.length };
  } catch (err) {
    logger.error(
      {
        count: list.length,
        batchId: list[0].batchId ?? null,
        channel: list[0].channel,
        efrIds: list.slice(0, 20).map((e) => e.efrId),
        err: err.message,
      },
      'CHASE BATCH LOG WRITE FAILED — chases were attempted but are NOT recorded.',
    );
    return { logged: false, count: 0 };
  }
}

/*
 * Move any open hand-off for this (technician, course) to 'chased'.
 *
 * Scoped to rows created BEFORE this chase: a hand-off issued after the
 * chase has not been actioned by it, and marking it chased would tell the
 * training team the field had responded to a request it has not yet seen.
 *
 * A hand-off write is not the point of recordChase, so this is best-effort
 * and swallows its own errors.
 */
async function advanceHandoff(entry, db) {
  if (entry.channel === CHANNEL_HANDOFF) return;
  if (entry.outcome === 'skipped' || entry.outcome === 'failed') return;
  try {
    await db.query(
      `UPDATE lms_chase_assignment
          SET status = 'chased', first_chased_at = COALESCE(first_chased_at, ?)
        WHERE efr_id = ?
          AND status = 'open'
          AND created_at <= ?
          AND (course_id IS NULL OR course_id = ?)`,
      [new Date(), Number(entry.efrId), new Date(), entry.courseId ?? null],
    );
  } catch (err) {
    logger.warn(
      { efrId: entry.efrId, err: err.message },
      'Hand-off status advance failed — the chase IS logged; only the field-view status is stale.',
    );
  }
}

/**
 * Per-technician chase summary for a page of the drilldown.
 *
 * ONE grouped read over the page's efr_id set, never N reads — the row
 * count on B-02 is the page size, and a per-row query there is the
 * classic way a list screen becomes unusable at 50 rows.
 *
 * @returns {Promise<Map<number, {lastChasedAt: Date, count7d: number, lastChannel: string}>>}
 */
async function chaseSummaryFor(efrIds = []) {
  const ids = [...new Set(efrIds.map(Number).filter(Number.isFinite))];
  const summary = new Map();
  if (!ids.length) return summary;

  try {
    const [rows] = await pool.query(
      `SELECT efr_id,
              MAX(created_at) AS last_chased_at,
              SUM(created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS count_7d,
              SUBSTRING_INDEX(GROUP_CONCAT(channel ORDER BY created_at DESC), ',', 1) AS last_channel
         FROM lms_chase_log
        WHERE efr_id IN (${ids.map(() => '?').join(',')})
          AND outcome IN ('sent', 'noted', 'queued')
        GROUP BY efr_id`,
      ids,
    );
    for (const r of rows) {
      summary.set(Number(r.efr_id), {
        lastChasedAt: r.last_chased_at,
        count7d: Number(r.count_7d || 0),
        lastChannel: r.last_channel || null,
      });
    }
  } catch (err) {
    /* Fail soft: chase history is context, not correctness. A drilldown that
     * cannot show "last chased 2 days ago" is still a usable drilldown. */
    logger.warn({ err: err.message }, 'Chase summary read failed — rows render without chase history');
  }
  return summary;
}

/**
 * Which of these technicians were chased on this channel inside the cooldown?
 *
 * Returns the set to SKIP. The caller still logs each skip with
 * outcome 'skipped' / detail 'cooldown' — see the header.
 */
async function withinCooldown(efrIds = [], channel) {
  const ids = [...new Set(efrIds.map(Number).filter(Number.isFinite))];
  const skip = new Set();
  if (!ids.length) return skip;

  const hours = cooldownHours();
  if (hours <= 0) return skip;

  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT efr_id
         FROM lms_chase_log
        WHERE efr_id IN (${ids.map(() => '?').join(',')})
          AND channel = ?
          AND outcome IN ('sent', 'noted', 'queued')
          AND created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)`,
      [...ids, channel, hours],
    );
    for (const r of rows) skip.add(Number(r.efr_id));
  } catch (err) {
    /* Fail OPEN. A cooldown is a courtesy; refusing to chase because the
     * cooldown lookup broke would make a failed query look like a completed
     * chase, which is the one outcome this whole module exists to prevent. */
    logger.warn({ err: err.message, channel }, 'Cooldown lookup failed — proceeding without cooldown');
  }
  return skip;
}

/**
 * Chase history, newest first. Powers the per-technician panel and the export.
 */
async function listChases({ efrId, courseId, actorUserId, channel, batchId, limit = 100, offset = 0 } = {}) {
  const clauses = [];
  const params = [];
  if (efrId) { clauses.push('efr_id = ?'); params.push(Number(efrId)); }
  if (courseId) { clauses.push('course_id = ?'); params.push(Number(courseId)); }
  if (actorUserId) { clauses.push('actor_user_id = ?'); params.push(Number(actorUserId)); }
  if (channel) { clauses.push('channel = ?'); params.push(channel); }
  if (batchId) { clauses.push('batch_id = ?'); params.push(batchId); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const [rows] = await pool.query(
    `SELECT id, efr_id, channel, outcome, outcome_detail, target_type, course_id,
            detector_key, batch_id, actor_user_id, actor_role_name, actor_source,
            recipient_masked, template_name, language_code, created_at
       FROM lms_chase_log
       ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?`,
    [...params, Number(limit), Number(offset)],
  );
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM lms_chase_log ${where}`,
    params,
  );
  return { rows, total: Number(total) };
}

module.exports = {
  CHANNELS,
  OUTCOMES,
  TARGET_TYPES,
  CHANNEL_WHATSAPP,
  CHANNEL_CALL,
  CHANNEL_NUDGE,
  CHANNEL_MARK_CHASED,
  CHANNEL_HANDOFF,
  SOURCE_CRM,
  SOURCE_CRON,
  SOURCE_SYSTEM,
  cooldownHours,
  bulkMax,
  newBatchId,
  recordChase,
  recordChaseBatch,
  chaseSummaryFor,
  withinCooldown,
  listChases,
};
