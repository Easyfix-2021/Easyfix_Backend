/*
 * AI Teleprompter session store + concurrency + token + config.
 *
 * The teleprompter is a HUMAN-led, AI-assisted guided call: Ops runs a browser
 * Plivo web-call, a Plivo <Stream> forks the audio to this backend, an OSS STT
 * sidecar transcribes it, and an LLM (Sophy) moves the on-screen "next question"
 * highlight. This module is the durable, cross-replica session record + the
 * concurrency cap + the JWT for the media websocket. Everything degrades to a
 * clean no-op when the property/flag/table is absent, so the shared backend is
 * never affected.
 *
 *  - enabled(): property `teleprompter.enabled` = 'true' (master flag). OFF ⇒ no
 *    new code path is reachable (routes 403, webAnswer never appends <Stream>).
 *  - Hard concurrency cap (MAX_CONCURRENT_TELEPROMPTER, default 50) — a global
 *    counter acquired at the ws upgrade; released once on relay teardown.
 *  - Own token/cap (shares the JWT secret with ai-call-session, but a separate
 *    flag + counter so the two features fail independently).
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const logger = require('../logger');
const { getProperty } = require('./properties.service');

const MAX_CONCURRENT = Math.max(1, parseInt(process.env.MAX_CONCURRENT_TELEPROMPTER || '50', 10));
const MAX_DURATION_MS = Math.max(60, parseInt(process.env.TELEPROMPTER_MAX_DURATION_SEC || '1200', 10)) * 1000;
const TOKEN_TTL_SEC = 30 * 60;
const DEFAULT_FLOW = 'guided_verification';

function enabled() {
  return String(getProperty('teleprompter.enabled')).trim().toLowerCase() === 'true';
}
// STT provider (real-time). Blank/absent ⇒ no live STT ⇒ manual/sequential mode.
function sttProvider() {
  return String(getProperty('stt.provider') || '').trim().toLowerCase() || null;
}

function tokenSecret() {
  return process.env.PLIVO_ANSWER_TOKEN_SECRET || process.env.JWT_SECRET;
}
function signToken(sid, extra = {}) {
  return jwt.sign({ sid, kind: 'tp', ...extra }, tokenSecret(), { expiresIn: TOKEN_TTL_SEC });
}
function verifyToken(t) {
  try {
    const c = jwt.verify(t, tokenSecret());
    return c && c.kind === 'tp' ? c : null;
  } catch { return null; }
}

// ── Hard concurrency cap ──
let _active = 0;
function activeCount() { return _active; }
function tryAcquire() {
  if (_active >= MAX_CONCURRENT) return false;
  _active += 1;
  return true;
}
function release() {
  if (_active > 0) _active -= 1;
}

// ── Durable session record (all writes best-effort; table is OPTIONAL) ──
function newSessionId() {
  return 'tp_' + crypto.randomBytes(12).toString('hex');
}
async function createSession({ flow = DEFAULT_FLOW, targetType = null, targetId = null, callerUserId = null, questionList = null }) {
  const sessionId = newSessionId();
  await pool.query(
    `INSERT INTO tbl_teleprompter_session
       (session_id, flow, target_type, target_id, caller_user_id, status, question_list_json)
     VALUES (?, ?, ?, ?, ?, 'calling', ?)`,
    [sessionId, flow, targetType, targetId != null ? Number(targetId) : null,
      callerUserId != null ? Number(callerUserId) : null,
      questionList ? JSON.stringify(questionList).slice(0, 4000000) : null],
  );
  return sessionId;
}

async function setStatus(sessionId, status, extra = {}) {
  try {
    const sets = ['status = ?'];
    const vals = [status];
    if (extra.callUuid !== undefined) { sets.push('call_uuid = ?'); vals.push(extra.callUuid); }
    if (extra.error !== undefined) { sets.push('error = ?'); vals.push(String(extra.error || '').slice(0, 250)); }
    vals.push(sessionId);
    await pool.query(`UPDATE tbl_teleprompter_session SET ${sets.join(', ')} WHERE session_id = ?`, vals);
  } catch (e) { logger.warn('teleprompter setStatus failed · ' + e.message); }
}

async function saveTranscript(sessionId, transcript) {
  try {
    await pool.query('UPDATE tbl_teleprompter_session SET transcript = ? WHERE session_id = ?',
      [transcript ? String(transcript).slice(0, 200000) : null, sessionId]);
  } catch (e) { logger.warn('teleprompter saveTranscript failed · ' + e.message); }
}

// Live: the AI's suggested NEXT question (never the current one — the UI locks that).
async function saveNextQuestion(sessionId, nextQuestionId) {
  try {
    await pool.query('UPDATE tbl_teleprompter_session SET next_question_id = ? WHERE session_id = ?',
      [nextQuestionId != null ? String(nextQuestionId).slice(0, 64) : null, sessionId]);
  } catch (e) { logger.warn('teleprompter saveNextQuestion failed · ' + e.message); }
}

// Promotion (browser VAD → ops started reading): lock current + append the asked step.
async function promote(sessionId, questionId, askedSequence) {
  try {
    await pool.query(
      'UPDATE tbl_teleprompter_session SET current_question_id = ?, asked_sequence_json = ? WHERE session_id = ?',
      [questionId != null ? String(questionId).slice(0, 64) : null,
        askedSequence ? JSON.stringify(askedSequence).slice(0, 4000000) : null,
        sessionId]);
  } catch (e) { logger.warn('teleprompter promote failed · ' + e.message); }
}

async function saveResult(sessionId, { result, coverage } = {}) {
  try {
    await pool.query(
      "UPDATE tbl_teleprompter_session SET status = 'done', captured_result_json = ?, coverage_json = ? WHERE session_id = ?",
      [result ? JSON.stringify(result).slice(0, 4000000) : null,
        coverage ? JSON.stringify(coverage).slice(0, 200000) : null,
        sessionId]);
  } catch (e) { logger.warn('teleprompter saveResult failed · ' + e.message); }
}

const GET_COLS = 'session_id, flow, target_type, target_id, caller_user_id, call_uuid, status, '
  + 'current_question_id, next_question_id, question_list_json, asked_sequence_json, transcript, '
  + 'captured_result_json, coverage_json, error, created_on, updated_on';
async function getSession(sessionId) {
  try {
    const [[row]] = await pool.query(
      `SELECT ${GET_COLS} FROM tbl_teleprompter_session WHERE session_id = ? LIMIT 1`, [sessionId]);
    return row || null;
  } catch (e) {
    logger.warn('teleprompter getSession failed (table present?) · ' + e.message);
    return null;
  }
}

// Coverage: how much of the planned question list the caller actually asked.
// askedSequence = [{ id, ts }]; questionList = [{ id, required }].
function computeCoverage(askedSequence, questionList) {
  const asked = new Set((Array.isArray(askedSequence) ? askedSequence : []).map((a) => a && a.id).filter(Boolean));
  const list = Array.isArray(questionList) ? questionList : [];
  const required = list.filter((q) => q && q.required !== false);
  const total = required.length || list.length || 0;
  const askedRequired = required.filter((q) => asked.has(q.id)).length;
  const missed = required.filter((q) => !asked.has(q.id)).map((q) => ({ id: q.id, text: q.text }));
  const pct = total > 0 ? Math.round((askedRequired / total) * 100) : null;
  return { asked_count: asked.size, required_total: total, covered: askedRequired, coverage_pct: pct, missed };
}

// Backstop: a session placed but whose media stream never connected would poll
// forever. Fail it after a timeout. DB-read (cross-replica) + unref'd.
const CONNECT_TIMEOUT_MS = Math.max(30, parseInt(process.env.TELEPROMPTER_CONNECT_TIMEOUT_SEC || '120', 10)) * 1000;
function scheduleConnectReaper(sessionId) {
  const t = setTimeout(async () => {
    try {
      const s = await getSession(sessionId);
      if (s && s.status === 'calling') {
        logger.warn('Teleprompter: session ' + sessionId + ' never connected within '
          + (CONNECT_TIMEOUT_MS / 1000) + 's — marking failed');
        await setStatus(sessionId, 'failed', {
          error: 'Call did not connect — the media stream never started (check teleprompter.enabled, the web-call answered, and PLIVO_CALLBACK_BASE_URL is reachable over wss).',
        });
      }
    } catch { /* best-effort backstop */ }
  }, CONNECT_TIMEOUT_MS);
  if (t && t.unref) t.unref();
}

module.exports = {
  enabled, sttProvider, DEFAULT_FLOW, MAX_CONCURRENT, MAX_DURATION_MS,
  signToken, verifyToken,
  activeCount, tryAcquire, release,
  createSession, setStatus, saveTranscript, saveNextQuestion, promote, saveResult, getSession,
  computeCoverage, scheduleConnectReaper,
};
