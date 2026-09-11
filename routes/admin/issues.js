const router = require('express').Router();
const multer = require('multer');

const logger        = require('../../logger');
const validate      = require('../../middleware/validate');
const requireAction = require('../../middleware/require-action');
const svc           = require('../../services/issue.service');
const s3            = require('../../utils/s3-storage');
const { modernOk, modernError } = require('../../utils/response');
const {
  issueIdParam,
  issueCreate,
  issueListQuery,
  issueCommentCreate,
  issueClose,
  issueReopen,
} = require('../../validators/issue.validator');

/*
 * In-app issue reporter — all mounted under /api/admin/issues.
 *
 * Gates inherited from routes/admin/index.js and NOT repeated here:
 * requireAuth, role(['admin']), maskMobile, rejectMaskedMobile, and the
 * per-request req.scope / req.allowedStages attach.
 *
 * `req.scope` is deliberately never read — an issue is about the CRM, not
 * about a job or a city. The reasoning is in services/issue.service.js and
 * belongs there because that is where the WHERE clauses live.
 *
 * ── AUTHORISATION ───────────────────────────────────────────────────────
 * Reporting, listing your own, reading your own, commenting on your own and
 * reopening your own need NO action key — every admin-group user may raise a
 * bug. Reading, commenting on or reopening someone else's, listing with
 * scope=all, and closing need `isIssueManage`.
 * The rule is enforced in the service, on the row it actually fetched, so a
 * future endpoint added here cannot forget it. requireAction below is a
 * fast-fail on the one route where the answer needs no row: it produces the
 * canonical `Missing permission:` body before a DB read, and the service
 * re-asserts anyway.
 *
 * ── WHY THE SCREENSHOT IS MULTIPART AND NOT BASE64 JSON ─────────────────
 * server.js mounts bodySizeLimit({ maxBytes: 2 MB }) on /api/admin, ahead of
 * the 10 MB global express.json(). That guard is scoped to
 * `application/json` and lets multipart through untouched — by design, so the
 * xlsx bulk uploads keep working. A base64 screenshot inflates ~33 % on the
 * wire, so a JSON payload would 413 on any screenshot over ~1.5 MB, which is
 * an ordinary full-page PNG. The comment on that mount says it outright:
 * "NO admin route accepts base64 payloads in JSON — every admin file upload is
 * multipart via multer". This route is not the exception.
 *
 * A create WITHOUT a screenshot may still be sent as plain JSON: multer's
 * .single() passes a non-multipart request straight through, leaving req.body
 * to the global parser. Both encodings therefore hit the same validator.
 */

/*
 * 5 MB cap PER FILE — a full-page screenshot at 2× DPI is comfortably under
 * it, and it is well below the 10 MB used for notice images because an issue
 * can be raised by any user of the CRM, not only by an author holding a manage
 * key.
 *
 * MAX_SCREENSHOTS is a real limit, not a formality: multer buffers every file
 * in memory (memoryStorage), so N × 5 MB is resident per concurrent report.
 * Five is what a person actually attaches — the broken screen, the console,
 * the network tab — and 25 MB of transient buffer is affordable on this
 * container. Raise the count and the memory ceiling moves with it.
 */
const MAX_SCREENSHOTS = 5;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: MAX_SCREENSHOTS },
});

/*
 * The Content-Type written onto the S3 object comes from this set and nothing
 * else. It must never fall through to the putAtKey default of
 * application/octet-stream: the object is served to the browser from a
 * presigned URL, where Content-Type is the only thing telling an <img> what it
 * received — the key carries no extension by ops convention — and
 * octet-stream renders as a broken tile or a download prompt.
 */
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/*
 * POST /api/admin/issues
 *   multipart/form-data (or JSON when there is no screenshot):
 *     title       required
 *     description required
 *     page_path   optional — stored as a PATHNAME, query string stripped
 *     screenshot  optional file
 *
 * The screenshots are uploaded BEFORE the row is written, so a failed PutObject
 * fails the whole request rather than leaving an issue pointing at a key that
 * does not exist. The reverse order would produce a row whose screenshot never
 * loads and no way to tell that from a presign error.
 */
router.post(
  '/',
  /*
   * .array on the SAME field name 'screenshot', not a new 'screenshots'
   * field. A CRM tab that was open across the deploy still posts a single
   * file under 'screenshot', and multer's .array accepts one file under that
   * name exactly as .single did — so the old client keeps working instead of
   * failing MulterError: Unexpected field, which would have surfaced to the
   * user as "could not report the issue" on the one screen whose whole job is
   * reporting that something does not work.
   */
  upload.array('screenshot', MAX_SCREENSHOTS),
  validate(issueCreate),
  async (req, res, next) => {
    try {
      const actor = await svc.resolveActor(req);

      const files = req.files || [];
      /*
       * MIME is checked for EVERY file BEFORE any upload starts. Rejecting
       * mid-loop would leave the accepted ones as orphaned S3 objects that no
       * row points at and nothing ever cleans up — the report fails and the
       * bucket keeps the bytes.
       */
      const bad = files.find((f) => !IMAGE_MIME.has(f.mimetype));
      if (bad) {
        logger.warn('Issue screenshot rejected · disallowed mime=' + bad.mimetype);
        return modernError(res, 400, `mimetype "${bad.mimetype}" is not allowed; use PNG/JPEG/WEBP/GIF`);
      }

      const screenshotKeys = [];
      if (files.length && !s3.isEnabled()) {
        // No local-disk fallback on purpose. A screenshot is the one part of
        // an issue that is genuinely optional, so dropping it beats failing
        // the report — and writing it to the container filesystem would put
        // it somewhere nothing ever serves or cleans up.
        logger.warn('Issue screenshots discarded · S3 is not configured · count=' + files.length);
      } else {
        for (const f of files) {
          screenshotKeys.push(await s3.putAtKey({
            key:          svc.buildScreenshotKey(),
            buffer:       f.buffer,
            contentType:  f.mimetype,
            originalName: f.originalname,
          }));
        }
      }

      const created = await svc.createIssue({
        title:       req.body.title,
        description: req.body.description,
        pagePath:    req.body.page_path || null,
        screenshotKeys,
        userId:      actor.userId,
      });
      res.status(201);
      return modernOk(res, created, 'Issue reported');
    } catch (e) {
      if (e.code === 'LIMIT_FILE_SIZE') {
        logger.warn('Issue screenshot upload failed · file exceeds 5MB');
        return modernError(res, 400, 'screenshot exceeds 5MB');
      }
      if (e.code === 'LIMIT_FILE_COUNT' || e.code === 'LIMIT_UNEXPECTED_FILE') {
        // multer's own message names neither the limit nor the field, and this
        // is the one screen whose user is already telling us something is
        // broken — it should not answer with "Unexpected field".
        logger.warn('Issue screenshot upload failed · ' + e.code);
        return modernError(res, 400, `attach at most ${MAX_SCREENSHOTS} screenshots`);
      }
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

/*
 * GET /api/admin/issues?scope=mine|all&status=open|closed&limit=&offset=
 *
 * Returns has_screenshot (boolean) and NEVER a key or a URL. The list is the
 * one response an unauthorised caller can reach for issues that are not
 * theirs — scope=mine is filtered by reporter — so it must not be able to
 * carry a presigned URL out. See services/issue.service.js.
 */
router.get('/', validate(issueListQuery, 'query'), async (req, res, next) => {
  try {
    const actor = await svc.resolveActor(req);
    const result = await svc.listIssues(req.query, actor);
    return modernOk(res, result);
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

/*
 * GET /api/admin/issues/:issueId
 *
 * Detail + the comment thread, plus a 900-second presigned screenshot URL —
 * minted here and only here, after the ownership check has passed.
 */
router.get('/:issueId', validate(issueIdParam, 'params'), async (req, res, next) => {
  try {
    const actor = await svc.resolveActor(req);
    const issue = await svc.getIssueDetail(req.params.issueId, actor);
    return modernOk(res, issue);
  } catch (e) {
    if (e.status) return modernError(res, e.status, e.message);
    next(e);
  }
});

/* POST /api/admin/issues/:issueId/comments — reporter or manager. */
router.post(
  '/:issueId/comments',
  validate(issueIdParam, 'params'),
  validate(issueCommentCreate),
  async (req, res, next) => {
    try {
      const actor = await svc.resolveActor(req);
      const created = await svc.addComment(
        req.params.issueId,
        { commentText: req.body.comment_text },
        actor,
      );
      res.status(201);
      return modernOk(res, created, 'Comment added');
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

/*
 * PATCH /api/admin/issues/:issueId/close — manager only; 409 if already
 * closed. requireAction fails fast with the canonical body; the service
 * re-asserts on the actor so the guard and the rule cannot drift apart.
 */
router.patch(
  '/:issueId/close',
  requireAction(svc.MANAGE_ACTION),
  validate(issueIdParam, 'params'),
  validate(issueClose),
  async (req, res, next) => {
    try {
      const actor = await svc.resolveActor(req);
      const result = await svc.closeIssue(
        req.params.issueId,
        { closeNote: req.body.close_note },
        actor,
      );
      return modernOk(res, result, 'Issue closed');
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

/*
 * PATCH /api/admin/issues/:issueId/reopen — reporter or manager; 409 if
 * already open. NO requireAction: the reporter holds no key, and the service
 * applies the read rule on the fetched row.
 */
router.patch(
  '/:issueId/reopen',
  validate(issueIdParam, 'params'),
  validate(issueReopen),
  async (req, res, next) => {
    try {
      const actor = await svc.resolveActor(req);
      const result = await svc.reopenIssue(
        req.params.issueId,
        { reopenNote: req.body.reopen_note },
        actor,
      );
      return modernOk(res, result, 'Issue reopened');
    } catch (e) {
      if (e.status) return modernError(res, e.status, e.message);
      next(e);
    }
  },
);

module.exports = router;
