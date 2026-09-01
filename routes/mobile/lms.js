const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const lms = require('../../services/lms.service');
const { modernOk } = require('../../utils/response');
const logger = require('../../logger');
const { renderCertificatePdf } = require('../../utils/pdf-certificate');

/*
 * LMS — technician API. Mounted at /api/mobile/lms, so every route here
 * already has a verified technician on req.tech (requireTechAuth runs on the
 * parent router).
 *
 * EVERY route scopes to req.tech.efr_id and NEVER takes a technician id from
 * the request. An assessment submission that trusted a body-supplied id would
 * let any signed-in technician record a pass for someone else, which is the
 * whole training gate in one request.
 *
 * ─── THE ONE THING THAT MUST NOT REGRESS ─────────────────────────────
 *
 * `is_correct` never leaves the server on this router. GET /lms/assessments/:id
 * is served by lms.service::getAssessmentForTech, whose SQL does not select the
 * column at all — as opposed to selecting it and deleting it afterwards, which
 * is one `...spread` away from shipping the answer key to the client that is
 * about to be scored on it. Scoring is likewise server-side only: POST /submit
 * accepts ANSWERS and never a score.
 *
 * Why a separate router rather than more routes on profile-extra.js: the video
 * watched-% endpoints there are the LEGACY video-only surface that the Flutter
 * app still calls, and they must keep working untouched. This is the
 * content-aware replacement the Expo app calls, and keeping them apart means
 * neither retirement has to wait for the other.
 */

const courseIdParam = Joi.object({
  courseId: Joi.number().integer().positive().required(),
});

const contentIdParam = Joi.object({
  contentId: Joi.number().integer().positive().required(),
});

const assessmentIdParam = Joi.object({
  assessmentId: Joi.number().integer().positive().required(),
});

/*
 * The answers, and nothing that looks like a result. `stripUnknown` in the
 * validate middleware means a client that helpfully posts `score` or `passed`
 * has those silently dropped rather than considered.
 *
 * courseId is optional because the same assessment can sit in two courses —
 * the attempt records which course it was taken for, and only the course the
 * app was working through can say.
 */
const submitBody = Joi.object({
  courseId: Joi.number().integer().positive().optional(),
  answers: Joi.array().min(1).max(200).items(Joi.object({
    questionId: Joi.number().integer().positive().required(),
    optionId: Joi.number().integer().positive().required(),
  })).required(),
});

/*
 * The whole LMS screen: assigned courses, ordered content, per-item completion.
 *
 * Completion is computed HERE, not in the app. A phone that decided for itself
 * whether a course was done would be a second copy of a rule that gates
 * earning, running on a build that may be months old.
 */
router.get('/courses', async (req, res, next) => {
  try {
    logger.info('LMS courses requested · efrId=' + req.tech.efr_id);
    modernOk(res, await lms.coursesForTech(req.tech.efr_id));
  } catch (e) { next(e); }
});

/*
 * "I have read this document." Idempotent — the app may replay it after an
 * offline stretch, and acknowledging twice is acknowledging once.
 */
router.post('/content/:contentId/ack', validate(contentIdParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Acknowledge document · efrId=' + req.tech.efr_id + ' · contentId=' + req.params.contentId);
    modernOk(res, await lms.ackDocument(req.tech.efr_id, req.params.contentId));
  } catch (e) { next(e); }
});

// The paper, WITHOUT the answers. See the header note.
router.get('/assessments/:assessmentId', validate(assessmentIdParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Assessment requested · efrId=' + req.tech.efr_id + ' · assessmentId=' + req.params.assessmentId);
    modernOk(res, await lms.getAssessmentForTech(req.tech.efr_id, req.params.assessmentId));
  } catch (e) { next(e); }
});

/*
 * The technician's own completion certificate, as a PDF.
 *
 * SELF-SCOPED BY CONSTRUCTION. The technician id comes from req.tech.efr_id and
 * the URL carries only the course — there is no request shape that could ask
 * for somebody else's certificate. That is the same rule as every other route
 * on this router, and it matters more here: a certificate is a named document
 * about a specific person.
 *
 * A 404 covers every "not yours / not earned" case without distinguishing
 * them, so this cannot be used to probe who completed what.
 *
 * NOT modernOk() — the body is the document. Errors before the first byte
 * become a normal JSON 404 via next(e); once the render begins the status line
 * is already sent, which is why the data is fetched completely first and the
 * render is the last statement.
 */
router.get('/courses/:courseId/certificate', validate(courseIdParam, 'params'), async (req, res, next) => {
  try {
    const efrId = req.tech.efr_id;
    const courseId = Number(req.params.courseId);
    logger.info('Certificate requested (technician) · efrId=' + efrId + ' · courseId=' + courseId);
    const row = await lms.certificateData(courseId, efrId);

    const safeName = String(row.course_name || 'course')
      .replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'course';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition',
      `attachment; filename="EasyFix-Certificate-${safeName}.pdf"`);

    renderCertificatePdf({
      technician: { efr_name: row.efr_name, efr_no: row.efr_no },
      course: { name: row.course_name },
      completedOn: row.completion_date,
      score: row.score,
      stream: res,
    });
    return undefined;
  } catch (e) {
    return next(e);
  }
});

/*
 * Scored server-side. Refuses with 409 once the attempt ceiling is reached —
 * an exhausted technician needs an operator to act, not another try. That
 * action exists: DELETE /api/admin/lms/assessments/:id/attempts/:easyfixerId
 * gives him his attempts back. Exhaustion must never silently COMPLETE the
 * course instead — that would mark someone trained for failing.
 */
router.post('/assessments/:assessmentId/submit', validate(assessmentIdParam, 'params'), validate(submitBody), async (req, res, next) => {
  try {
    logger.info('Assessment submitted · efrId=' + req.tech.efr_id
      + ' · assessmentId=' + req.params.assessmentId
      + ' · answers=' + req.body.answers.length);
    modernOk(res, await lms.submitAssessment(req.tech.efr_id, req.params.assessmentId, {
      courseId: req.body.courseId ?? null,
      answers: req.body.answers,
    }));
  } catch (e) { next(e); }
});

module.exports = router;
