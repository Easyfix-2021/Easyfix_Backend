'use strict';
/*
 * In-job chat (V3 3.4, design sheet 15): one thread per job, both sides.
 *
 * "It is not a general inbox: there is no thread here that is not this job."
 * So there is no conversation table and no inbox query — a message is keyed by
 * job_id and nothing else, and every read is `WHERE job_id = ?`.
 *
 * Callers own authorisation: the mobile route checks he owns the job, the
 * admin route runs its scopedJob guard. This module trusts the job id it is
 * handed, exactly like job-log.service.
 *
 * PHONE RETRIES. The app sends a clientMsgId with every line; the UNIQUE
 * (job_id, client_msg_id) index turns a retried send into ER_DUP_ENTRY, and
 * post() returns the row that already landed. A desk reply carries no id and
 * NULLs never collide, so the desk is never deduped against itself.
 */

const { pool } = require('../db');
const logger = require('../logger');

const LIST_LIMIT_DEFAULT = 100;
const LIST_LIMIT_MAX = 100;
const BODY_MAX = 500;
const SENDER = Object.freeze({ TX: 'tx', DESK: 'desk' });

const shape = (r) => ({
  id: Number(r.id),
  senderKind: r.sender_kind,
  efrId: r.efr_id == null ? null : Number(r.efr_id),
  userId: r.user_id == null ? null : Number(r.user_id),
  body: r.body,
  sentOn: r.sent_on,
});

const COLUMNS = 'id, sender_kind, efr_id, user_id, body, sent_on';

/**
 * Messages after `after` (an id), oldest first, at most 100. The poller passes
 * the last id it holds, so a steady-state poll reads zero or one row off the
 * (job_id, id) index instead of re-reading the thread.
 */
async function list(jobId, { after = 0, limit = LIST_LIMIT_DEFAULT } = {}) {
  const since = Number.isSafeInteger(Number(after)) && Number(after) > 0 ? Number(after) : 0;
  const cap = Math.min(Math.max(Number(limit) || LIST_LIMIT_DEFAULT, 1), LIST_LIMIT_MAX);
  const [rows] = await pool.query(
    `SELECT ${COLUMNS} FROM tbl_job_chat
      WHERE job_id = ? AND id > ?
      ORDER BY id ASC
      LIMIT ?`,
    [Number(jobId), since, cap],
  );
  return rows.map(shape);
}

async function byClientMsgId(jobId, clientMsgId) {
  const [[row]] = await pool.query(
    `SELECT ${COLUMNS} FROM tbl_job_chat WHERE job_id = ? AND client_msg_id = ? LIMIT 1`,
    [Number(jobId), clientMsgId],
  );
  return row ? shape(row) : null;
}

/**
 * Post one line. Returns the row — the existing one when clientMsgId repeats.
 * Throws 400 for an empty or over-long body, so the admin and mobile routes
 * cannot disagree on what a valid message is.
 */
async function post(jobId, { senderKind, efrId = null, userId = null, body, clientMsgId = null }) {
  const text = String(body == null ? '' : body).trim();
  if (!text || text.length > BODY_MAX) {
    const e = new Error(`message must be 1 to ${BODY_MAX} characters`); e.status = 400; throw e;
  }
  if (senderKind !== SENDER.TX && senderKind !== SENDER.DESK) {
    const e = new Error('senderKind must be tx or desk'); e.status = 400; throw e;
  }
  const msgId = clientMsgId == null || String(clientMsgId).trim() === '' ? null : String(clientMsgId).trim().slice(0, 64);
  const sentOn = new Date();
  try {
    // new Date() + the pool's +05:30 session = IST verbatim. Never NOW().
    const [ins] = await pool.query(
      `INSERT INTO tbl_job_chat (job_id, sender_kind, efr_id, user_id, body, client_msg_id, sent_on)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [Number(jobId), senderKind, efrId, userId, text, msgId, sentOn],
    );
    logger.info('Job chat line · job=' + jobId + ' · from=' + senderKind + ' · id=' + ins.insertId);
    const [[row]] = await pool.query(`SELECT ${COLUMNS} FROM tbl_job_chat WHERE id = ? LIMIT 1`, [ins.insertId]);
    return shape(row);
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY' && msgId) {
      const existing = await byClientMsgId(jobId, msgId);
      if (existing) return existing;
    }
    throw e;
  }
}

module.exports = { list, post, SENDER, BODY_MAX, LIST_LIMIT_MAX };
