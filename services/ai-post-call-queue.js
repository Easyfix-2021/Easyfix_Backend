/*
 * Post-call processing queue for AI calling — a bounded, generic background runner.
 *
 * The DURING-call work (media relay + μ-law transcode) is latency-critical and
 * already offloaded. The POST-call work is I/O-bound and NOT time-critical:
 *   - transcript → Deep-Skill/pincode mapping (Sophy LLM + catalog + geocoding)
 *   - recording archival (download from Plivo + optional S3 upload)
 * Running these inline (or unbounded) means a burst of ending calls fires a burst
 * of concurrent LLM/DB/geocode/download calls that can saturate the DB pool (~20),
 * trip Sophy's RPM cap, and hammer the geocoder — degrading LIVE calls + the API.
 *
 * So ALL non-real-time AI-call work funnels through here and drains at a hard cap
 * (AI_POST_CALL_CONCURRENCY, default 4), off the live path, bounded in one place.
 */

const logger = require('../logger');
const { pool } = require('../db');
const aiSession = require('./ai-call-session.service');
const { resolveFlow, DEFAULT_FLOW } = require('./ai-call-flows');

const MAX = Math.max(1, parseInt(process.env.AI_POST_CALL_CONCURRENCY || '4', 10));
const queue = [];
let active = 0;

function pump() {
  while (active < MAX && queue.length) {
    const task = queue.shift();
    active += 1;
    Promise.resolve()
      .then(() => task.run())
      .catch((e) => logger.warn('AI post-call task failed · ' + task.label + ' · ' + (e && e.message)))
      .finally(() => { active -= 1; pump(); });
  }
}

// Generic: enqueue any bounded post-call task. `task = { label, run: async () => {} }`.
function enqueueTask(task) {
  queue.push(task);
  pump();
}

// Convenience: the transcript → mapping task (relay + boot recovery use this).
function enqueueMapping({ sessionId, flow, transcript }) {
  enqueueTask({
    label: 'map:' + sessionId,
    run: async () => {
      const f = flow || resolveFlow(DEFAULT_FLOW);
      try {
        const result = await f.mapResult(transcript, pool, { session: { sessionId } });
        await aiSession.saveResult(sessionId, result);
      } catch (e) {
        logger.warn('AI post-call mapping failed · session=' + sessionId + ' · ' + e.message);
        try { await aiSession.setStatus(sessionId, 'failed', { error: e.message }); } catch { /* noop */ }
      }
    },
  });
}

// Recover sessions left at 'mapping' by a restart mid-queue (the queue is in-memory).
async function recoverPending() {
  try {
    const [rows] = await pool.query(
      "SELECT session_id, flow, transcript FROM tbl_ai_call_session WHERE status = 'mapping' AND created_on > (NOW() - INTERVAL 1 DAY) ORDER BY created_on ASC LIMIT 500");
    for (const r of rows) {
      enqueueMapping({ sessionId: r.session_id, flow: resolveFlow(r.flow || DEFAULT_FLOW), transcript: r.transcript || '' });
    }
    if (rows.length) logger.info('AI post-call queue: recovered ' + rows.length + ' pending mapping session(s)');
  } catch (e) {
    logger.warn('AI post-call queue recovery skipped · ' + e.message);
  }
}

function stats() { return { queued: queue.length, active, max: MAX }; }

module.exports = { enqueueTask, enqueueMapping, recoverPending, stats };
