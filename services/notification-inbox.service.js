const { pool } = require('../db');
const logger = require('../logger');

/*
 * In-app notification inbox — dashboard_notification_log (user_id-scoped).
 * Distinct from the outbound SMS/email/WhatsApp/FCM services in Phase 1A;
 * this is the UI inbox that shows "you have 3 new notifications".
 */

async function create({ userId, jobId, title, desc, notifyTo }) {
  logger.info('Create inbox notification · userId=' + userId + ' jobId=' + (jobId || '-') + ' title=' + title);
  const [r] = await pool.query(
    `INSERT INTO dashboard_notification_log (user_id, job_id, n_title, n_desc, n_to, status, createdAt)
     VALUES (?, ?, ?, ?, ?, 'unread', NOW())`,
    [userId, jobId || null, title, desc || null, notifyTo || null]);
  logger.info('Inbox notification created · id=' + r.insertId);
  return r.insertId;
}

async function listByUser(userId, { limit = 50, offset = 0 } = {}) {
  logger.info('List inbox notifications · userId=' + userId + ' limit=' + limit + ' offset=' + offset);
  const [rows] = await pool.query(
    `SELECT id, user_id, job_id, n_title, n_desc, n_to, status, createdAt
       FROM dashboard_notification_log WHERE user_id = ?
       ORDER BY id DESC LIMIT ? OFFSET ?`,
    [userId, Number(limit), Number(offset)]);
  logger.info('Found ' + rows.length + ' notifications');
  return rows;
}

async function countUnread(userId) {
  logger.info('Count unread notifications · userId=' + userId);
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS n FROM dashboard_notification_log WHERE user_id = ? AND status = 'unread'`,
    [userId]);
  logger.info('Found ' + r.n + ' unread notifications');
  return r.n;
}

async function listByJob(jobId) {
  logger.info('List inbox notifications by job · jobId=' + jobId);
  const [rows] = await pool.query(
    'SELECT * FROM dashboard_notification_log WHERE job_id = ? ORDER BY id DESC', [jobId]);
  logger.info('Found ' + rows.length + ' notifications');
  return rows;
}

async function markRead(id) {
  logger.info('Mark notification read · id=' + id);
  await pool.query(`UPDATE dashboard_notification_log SET status = 'read', updateAt = NOW() WHERE id = ?`, [id]);
  logger.info('Notification updated · id=' + id);
}

async function markAllRead(userId) {
  logger.info('Mark all notifications read · userId=' + userId);
  await pool.query(
    `UPDATE dashboard_notification_log SET status = 'read', updateAt = NOW() WHERE user_id = ? AND status = 'unread'`,
    [userId]);
  logger.info('Notifications marked read · userId=' + userId);
}

async function templates() {
  logger.info('List notification templates');
  const [rows] = await pool.query(
    `SELECT id, job_stage, notification_title, notification_content FROM dashboard_notification_templates WHERE status = 1`);
  logger.info('Found ' + rows.length + ' templates');
  return rows;
}

module.exports = { create, listByUser, countUnread, listByJob, markRead, markAllRead, templates };
