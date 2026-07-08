/*
 * AI-calling session store + concurrency + token + config for the Validate-Flows
 * "AI Calling → Profile Update" TEST flow. Everything is gated + degrades to a
 * clean no-op when the property/keys/table are absent, so the shared backend is
 * never affected.
 *
 * - enabled(): property `ai.calling.enabled` = 'true' AND an OpenAI key present.
 * - Hard concurrency cap (MAX_CONCURRENT_AI_CALLS, default 50) — a global counter
 *   acquired at call-start and again at ws-connect (defence in depth).
 * - Durable session record in tbl_ai_call_session (cross-replica safe): the media
 *   ws runs on one replica; the poll endpoint (any replica) reads the DB.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const logger = require('../logger');
const { getProperty } = require('./properties.service');

// GA Realtime model (the beta `gpt-4o-realtime-preview` on the beta API is no
// longer supported). Override via OPENAI_REALTIME_MODEL.
const MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
const MAX_CONCURRENT = Math.max(1, parseInt(process.env.MAX_CONCURRENT_AI_CALLS || '50', 10));
const MAX_DURATION_MS = Math.max(30, parseInt(process.env.AI_CALL_MAX_DURATION_SEC || '300', 10)) * 1000;
const TOKEN_TTL_SEC = 15 * 60;

function propEnabled() {
  return String(getProperty('ai.calling.enabled')).trim().toLowerCase() === 'true';
}
function openaiKey() {
  return process.env.OPENAI_REALTIME_API_KEY || process.env.OPENAI_API_KEY || null;
}
// Feature on? Per-ENGINE key config is checked at POST /ai-calling/start against
// the selected engine (openai → OpenAI Realtime key; gemini → GEMINI_API_KEY).
function enabled() {
  return propEnabled();
}
// Record the streamed AI call? (property `ai.calling.record.enabled`, default false)
function recordEnabled() {
  return String(getProperty('ai.calling.record.enabled')).trim().toLowerCase() === 'true';
}

function tokenSecret() {
  return process.env.PLIVO_ANSWER_TOKEN_SECRET || process.env.JWT_SECRET;
}
function signToken(sid, extra = {}) {
  return jwt.sign({ sid, ...extra }, tokenSecret(), { expiresIn: TOKEN_TTL_SEC });
}
function verifyToken(t) {
  try { return jwt.verify(t, tokenSecret()); } catch { return null; }
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
  return 'ai_' + crypto.randomBytes(12).toString('hex');
}
async function createSession({ mobile, efrId, flow = 'profile_update', engine = 'gemini' }) {
  const sessionId = newSessionId();
  await pool.query(
    `INSERT INTO tbl_ai_call_session (session_id, flow, engine, status, mobile, efr_id)
     VALUES (?, ?, ?, 'calling', ?, ?)`,
    [sessionId, flow, engine, mobile || null, efrId || null],
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
    await pool.query(`UPDATE tbl_ai_call_session SET ${sets.join(', ')} WHERE session_id = ?`, vals);
  } catch (e) { logger.warn('ai-call setStatus failed · ' + e.message); }
}
async function saveTranscript(sessionId, transcript) {
  try {
    await pool.query('UPDATE tbl_ai_call_session SET transcript = ? WHERE session_id = ?',
      [transcript ? String(transcript).slice(0, 60000) : null, sessionId]);
  } catch (e) { logger.warn('ai-call saveTranscript failed · ' + e.message); }
}
async function saveResult(sessionId, resultObj) {
  try {
    await pool.query("UPDATE tbl_ai_call_session SET status = 'done', result_json = ? WHERE session_id = ?",
      [resultObj ? JSON.stringify(resultObj) : null, sessionId]);
  } catch (e) { logger.warn('ai-call saveResult failed · ' + e.message); }
}
const GET_COLS_FULL = 'session_id, flow, engine, status, mobile, efr_id, call_uuid, transcript, result_json, error, recording_url, recording_duration, created_on';
const GET_COLS_BASE = 'session_id, flow, engine, status, mobile, efr_id, call_uuid, transcript, result_json, error, created_on';
async function getSession(sessionId) {
  try {
    const [[row]] = await pool.query(
      `SELECT ${GET_COLS_FULL} FROM tbl_ai_call_session WHERE session_id = ? LIMIT 1`, [sessionId]);
    return row || null;
  } catch (e) {
    // Recording migration (2026-07-08-add-recording) not run yet → degrade to the
    // core columns so the poll still works (recording just unavailable until run).
    if (e && e.code === 'ER_BAD_FIELD_ERROR') {
      try {
        const [[row]] = await pool.query(
          `SELECT ${GET_COLS_BASE} FROM tbl_ai_call_session WHERE session_id = ? LIMIT 1`, [sessionId]);
        return row || null;
      } catch (e2) {
        logger.warn('ai-call getSession failed · ' + e2.message);
        return null;
      }
    }
    logger.warn('ai-call getSession failed (table present?) · ' + e.message);
    return null;
  }
}

// Persist a completed recording (from the Plivo recording callback).
async function saveRecording(sessionId, { url, duration } = {}) {
  try {
    await pool.query(
      'UPDATE tbl_ai_call_session SET recording_url = ?, recording_duration = ? WHERE session_id = ?',
      [url || null, duration != null ? Number(duration) : null, sessionId]);
  } catch (e) { logger.warn('ai-call saveRecording failed · ' + e.message); }
}

// Map a Plivo CallUUID → session_id (the recording callback carries CallUUID).
async function getSessionIdByCallUuid(callUuid) {
  try {
    const [[row]] = await pool.query(
      'SELECT session_id FROM tbl_ai_call_session WHERE call_uuid = ? ORDER BY created_on DESC LIMIT 1', [callUuid]);
    return row ? row.session_id : null;
  } catch { return null; }
}

// After a call is placed it sits at 'calling' until the media ws connects and the
// relay flips it to 'streaming'. If the stream NEVER connects (unanswered call, or
// Plivo can't reach ai-answer / open the wss), nothing would ever terminalize the
// session and the UI would poll forever. This backstop fails it after a timeout.
// DB-read so it's cross-replica-safe; unref'd so it can't hold the loop open.
const CONNECT_TIMEOUT_MS = Math.max(30, parseInt(process.env.AI_CALL_CONNECT_TIMEOUT_SEC || '90', 10)) * 1000;
function scheduleConnectReaper(sessionId) {
  const t = setTimeout(async () => {
    try {
      const s = await getSession(sessionId);
      if (s && s.status === 'calling') {
        logger.warn('AI voice: session ' + sessionId + ' never connected within '
          + (CONNECT_TIMEOUT_MS / 1000) + 's — marking failed');
        await setStatus(sessionId, 'failed', {
          error: 'Call did not connect — the media stream never started. Verify OPENAI_REALTIME_API_KEY is set and that PLIVO_CALLBACK_BASE_URL is publicly reachable over wss (Plivo must reach /api/public/plivo/ai-answer and open the /ai-voice-stream websocket).',
        });
      }
    } catch { /* best-effort backstop */ }
  }, CONNECT_TIMEOUT_MS);
  if (t && t.unref) t.unref();
}

module.exports = {
  enabled, propEnabled, recordEnabled, openaiKey, MODEL, MAX_CONCURRENT, MAX_DURATION_MS,
  signToken, verifyToken,
  activeCount, tryAcquire, release,
  createSession, setStatus, saveTranscript, saveResult, getSession,
  saveRecording, getSessionIdByCallUuid, scheduleConnectReaper,
};
