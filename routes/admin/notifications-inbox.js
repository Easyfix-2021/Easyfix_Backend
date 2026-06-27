const router = require('express').Router();
const logger = require('../../logger');
const inbox = require('../../services/notification-inbox.service');
const { modernOk } = require('../../utils/response');

// Mounted inside routes/admin/notifications.js — these are the INBOX endpoints
// (in-app dashboard notifications), distinct from the outbound /test endpoint.

router.get('/inbox', async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const offset = Number(req.query.offset) || 0;
    logger.info('List inbox notifications · limit=' + limit + ' offset=' + offset);
    const [items, unread] = await Promise.all([
      inbox.listByUser(req.user.user_id, { limit, offset }),
      inbox.countUnread(req.user.user_id),
    ]);
    logger.info('Returning ' + items.length + ' inbox notifications · unread=' + unread);
    modernOk(res, { items, unread });
  } catch (e) { next(e); }
});

router.get('/inbox/count', async (req, res, next) => {
  try { logger.info('Get inbox unread count'); modernOk(res, { unread: await inbox.countUnread(req.user.user_id) }); } catch (e) { next(e); }
});

router.get('/inbox/job/:jobId', async (req, res, next) => {
  try { logger.info('List inbox notifications for job · jobId=' + req.params.jobId); modernOk(res, await inbox.listByJob(Number(req.params.jobId))); } catch (e) { next(e); }
});

router.patch('/inbox/:id/read', async (req, res, next) => {
  try { logger.info('Mark inbox notification read · id=' + req.params.id); await inbox.markRead(Number(req.params.id)); modernOk(res, { read: true }); } catch (e) { next(e); }
});

router.patch('/inbox/read-all', async (req, res, next) => {
  try { logger.info('Mark all inbox notifications read'); await inbox.markAllRead(req.user.user_id); modernOk(res, { allRead: true }); } catch (e) { next(e); }
});

router.get('/templates', async (req, res, next) => {
  try { logger.info('List notification templates'); modernOk(res, await inbox.templates()); } catch (e) { next(e); }
});

module.exports = router;
