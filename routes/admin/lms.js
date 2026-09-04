const router = require('express').Router();
const Joi = require('joi');
const multer = require('multer');
const crypto = require('crypto');

const validate = require('../../middleware/validate');
const requireAction = require('../../middleware/require-action');
const { buildRequestScope } = require('../../lib/scope');
const svc = require('../../services/lms.service');
const s3 = require('../../utils/s3-storage');
const { renderCertificatePdf } = require('../../utils/pdf-certificate');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');

/*
 * LMS admin API — courses, course content, assignment and the completion
 * report. Mounted at /api/admin/lms, so it inherits requireAuth,
 * role(['admin']) and maskMobile from routes/admin/index.js.
 *
 * WRITE GATE — `isLmsManage`, not a role name (changed 2026-08-21)
 *   Every write used to run `roleByName(['Admin'])`, an exact
 *   tbl_role.role_name match. But 2026-08-13-lms-foundation.sql seeds a
 *   `menu_action` row `isLmsManage` and grants it to role 2, and NOTHING
 *   read it — so the grant was decorative. A role holding `isLmsManage`
 *   got the LMS sidebar entry (menu_ids drives the sidebar) and then a 403
 *   from every button on it: permission granted, permission denied, no way
 *   for an operator to tell which was the truth. The seeded key is now the
 *   real gate, so granting it is what actually confers write access, and
 *   Manage Roles becomes the single place the answer lives.
 *
 *   For role 2 (Admin) this is a no-op — it already holds the grant. It
 *   stops being a no-op the moment a second LMS role exists, which is
 *   exactly what the action loop introduces.
 *
 *   Reads stay open to any admin-group user, matching the Notice Board
 *   precedent (routes/admin/notices.js): consuming a list is not authoring
 *   it. Row-level exposure on the two technician-grained reads is handled
 *   by city scope below, not by the action key.
 *
 * READ SCOPE — city, on the two technician-grained reads
 *   GET /assignments and GET /report list TECHNICIANS, so a geographically
 *   scoped user must see only their own cities' rows; they returned every
 *   city to every admin-group caller until 2026-08-21. Scope comes off the
 *   per-request object computed once in routes/admin/index.js and is passed
 *   into the service exactly as routes/admin/easyfixers.js does.
 *
 *   /courses and /courses/:id/videos are deliberately NOT scoped. A course
 *   is master data with no city, and inventing one would hide content from
 *   the very people who have to assign it.
 *
 * The training VIDEO catalogue is deliberately not served from here. Its CRUD
 * already lives at /api/admin/aux/training-videos and the technician app reads
 * the same table through /api/mobile/training-videos — adding a third list
 * endpoint for one table is the route duplication that makes two surfaces
 * drift. The Training Videos page and the course-content picker both call the
 * aux route, which was extended with search, paging and the reference counts
 * this feature needs.
 *
 * technician_mobile fields in the assignment and report responses are masked
 * on the way out by the inherited maskMobile middleware — no per-route work.
 */

/*
 * One factory call, reused on EVERY write in this file — courses, content,
 * documents, assessments and assignment alike. requireAction() returns a NAMED
 * function (`actionGuard`) and route tests locate the guard by `fn.name` —
 * see tests/easyfixer-lifecycle-route-auth.test.js — so it must never be wrapped
 * in an anonymous arrow.
 *
 * Documents and assessments deliberately do NOT get action keys of their own.
 * They are the same job as building a course, done by the same person, and a
 * second key would have to be seeded, granted and explained before anyone
 * could use a feature that is already gated correctly.
 */
const requireLmsManage = requireAction('isLmsManage');

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

const assignmentParams = Joi.object({
  courseId: Joi.number().integer().positive().required(),
  easyfixerId: Joi.number().integer().positive().required(),
});

const listCoursesQuery = Joi.object({
  q: Joi.string().allow('', null).optional(),
  includeInactive: Joi.boolean().default(false),
  mandatoryOnly: Joi.boolean().default(false),
  limit: Joi.number().integer().min(1).max(1000).default(200),
  offset: Joi.number().integer().min(0).default(0),
  sortBy: Joi.string().valid(...Object.keys(svc.SORTABLE_COLUMNS)).default('name'),
  sortDir: Joi.string().lowercase().valid('asc', 'desc').default('asc'),
});

/*
 * reward_points accepts '' and null as well as a number — an operator clearing
 * the field sends the empty string, and rejecting it would leave a course that
 * cannot be un-paid. The service normalizes every non-positive input to NULL.
 * The 100000 ceiling is a fat-finger guard, not an economic limit: it is there
 * so a stray keypress cannot mint a fortune across thousands of enrolments in
 * one set-based INSERT.
 */
const rewardPoints = Joi.alternatives().try(
  Joi.number().integer().min(0).max(100000),
  Joi.string().valid(''),
  Joi.valid(null),
);

const createCourseBody = Joi.object({
  name: Joi.string().trim().min(2).max(150).required(),
  description: Joi.string().max(2000).allow('', null).optional(),
  is_mandatory: Joi.boolean().optional(),
  reward_points: rewardPoints.optional(),
  certificate_enabled: Joi.boolean().optional(),
});

const updateCourseBody = Joi.object({
  name: Joi.string().trim().min(2).max(150).optional(),
  description: Joi.string().max(2000).allow('', null).optional(),
  status: Joi.boolean().optional(),
  is_mandatory: Joi.boolean().optional(),
  reward_points: rewardPoints.optional(),
  certificate_enabled: Joi.boolean().optional(),
}).min(1);

/*
 * The content payload is the FULL ordered list, not a delta — the handler
 * replaces the course's content with exactly what arrives. An empty array is
 * explicitly allowed: clearing a course's content is a legitimate edit, and
 * rejecting it would leave an operator unable to undo a mistaken add.
 */
const setContentBody = Joi.object({
  video_ids: Joi.array().items(Joi.number().integer().positive()).max(100).required(),
});

/*
 * The kind-aware version of the same thing. ORDER IS ARRAY ORDER — the payload
 * carries no `sequence`, because two clients disagreeing about whether
 * sequence is 0- or 1-based is a bug that only shows up as a mis-ordered
 * course. The position in the array IS the position in the course.
 */
const setCourseContentBody = Joi.object({
  items: Joi.array().items(Joi.object({
    kind: Joi.string().valid(...svc.CONTENT_KINDS).required(),
    ref_id: Joi.number().integer().positive().required(),
  })).max(100).required(),
});

// ─── Documents ───────────────────────────────────────────────────────

/*
 * 25 MB, single file. Larger than the 10 MB image cap next door because this
 * is where a training deck actually lands — a 40-slide PPTX with photographs
 * clears 10 MB routinely, and an operator who has to compress it first will
 * instead email it round and skip the LMS entirely.
 */
const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
});

/*
 * PDF and PowerPoint only. Deliberately NOT images (a slide exported as a JPEG
 * has no page structure and cannot be read on a phone) and deliberately not
 * SVG or HTML, which execute script in a viewer.
 *
 * `application/octet-stream` is accepted because browsers genuinely send it for
 * .ppt/.pptx from some file pickers — the same allowance utils/file-storage
 * makes, and the reason the extension is checked alongside it below.
 */
/*
 * 5 MB, single file. Deliberately smaller than the 25 MB document cap: a
 * question image is a photo of a part or a wiring diagram viewed on a phone,
 * and anything above a few MB is an un-resized camera original that costs the
 * technician his data allowance to download mid-assessment.
 */
const questionImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

/*
 * Raster images only. No SVG — it executes script in a viewer, and this file is
 * rendered inside the technician app. Mirrors routes/admin/notices.js.
 */
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const DOCUMENT_MIME = new Set([
  'application/pdf',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/octet-stream',
]);
const DOCUMENT_EXT = /\.(pdf|ppt|pptx)$/i;

const listDocumentsQuery = Joi.object({
  q: Joi.string().allow('', null).optional(),
  limit: Joi.number().integer().min(1).max(1000).default(200),
  offset: Joi.number().integer().min(0).default(0),
});

const updateDocumentBody = Joi.object({
  title: Joi.string().trim().min(2).max(255).required(),
});

// ─── Assessments ─────────────────────────────────────────────────────

const listAssessmentsQuery = listDocumentsQuery;

const createAssessmentBody = Joi.object({
  title: Joi.string().trim().min(2).max(255).required(),
  description: Joi.string().max(2000).allow('', null).optional(),
  pass_percent: Joi.number().integer().min(1).max(100).optional(),
  max_attempts: Joi.number().integer().min(1).max(20).optional(),
});

const updateAssessmentBody = Joi.object({
  title: Joi.string().trim().min(2).max(255).optional(),
  description: Joi.string().max(2000).allow('', null).optional(),
  pass_percent: Joi.number().integer().min(1).max(100).optional(),
  max_attempts: Joi.number().integer().min(1).max(20).optional(),
  status: Joi.boolean().optional(),
}).min(1);

/*
 * THE PAPER'S SHAPE IS ENFORCED HERE, AND ONLY HERE.
 *
 * A question with no correct option can never be answered right, so every
 * technician fails the assessment forever and — since a course containing it
 * can then never complete — is eventually restricted from working. A question
 * with two correct options is the same trap wearing a different hat: the
 * scorer picks one, and the other looks wrong to everyone who chose it. Both
 * are cheap to prevent at save time and expensive to discover in the field, so
 * "exactly one" is a hard validation rather than a warning in the CRM.
 *
 * Two options is the floor for the same reason a one-option question is not a
 * question.
 */
const setQuestionsBody = Joi.object({
  questions: Joi.array().min(1).max(100).items(Joi.object({
    question_text: Joi.string().trim().min(1).max(2000).required(),
    sequence: Joi.number().integer().min(0).optional(),
    /*
     * The S3 key returned by POST /assessments/images, round-tripped by the
     * CRM. '' and null both mean "no image" — an operator removing a picture
     * sends the empty string, and rejecting it would leave the image
     * un-removable. Length matches lms_question.image_key.
     */
    image_key: Joi.string().max(512).allow('', null).optional(),
    options: Joi.array().min(2).max(10).items(Joi.object({
      option_text: Joi.string().trim().min(1).max(500).required(),
      is_correct: Joi.boolean().default(false),
      sequence: Joi.number().integer().min(0).optional(),
    })).required().custom((options, helpers) => {
      const correct = options.filter((o) => o.is_correct).length;
      if (correct !== 1) {
        return helpers.message(
          `each question needs exactly one correct option (this one has ${correct})`,
        );
      }
      return options;
    }),
  })).required(),
});

/*
 * Duration is the operator's input; the DUE DATE is derived from it server
 * side (lms.service::dueDateFrom). The CRM previews the same date with the
 * same rules, but a client-supplied date is never accepted — it would be a
 * deadline the server never agreed to, and one skewed laptop clock would set
 * it wrong for a technician.
 *
 * At least one unit must be non-zero. An assignment with no deadline gets no
 * reminder push and can never restrict the app, so it would silently opt out
 * of the entire feature — better to reject it than to create one that looks
 * enforced and is not. Bounds are sanity rails, not policy: five years and a
 * year of days are both far past anything an operator means.
 */
const assignBody = Joi.object({
  course_id: Joi.number().integer().positive().required(),
  easyfixer_ids: Joi.array().items(Joi.number().integer().positive()).min(1).max(500).required(),
  duration_months: Joi.number().integer().min(0).max(60).default(0),
  duration_days: Joi.number().integer().min(0).max(365).default(0),
}).custom((value, helpers) => {
  if ((value.duration_months || 0) <= 0 && (value.duration_days || 0) <= 0) {
    return helpers.message('set a duration — an assignment with no due date is never reminded or enforced');
  }
  return value;
});

/* Same duration shape as assignment; at least one unit must move the date. */
const extendBody = Joi.object({
  duration_months: Joi.number().integer().min(0).max(60).default(0),
  duration_days: Joi.number().integer().min(0).max(365).default(0),
}).custom((value, helpers) => {
  if ((value.duration_months || 0) <= 0 && (value.duration_days || 0) <= 0) {
    return helpers.message('set how far to extend the deadline');
  }
  return value;
});

const listAssignmentsQuery = Joi.object({
  courseId: Joi.number().integer().positive().optional(),
  easyfixerId: Joi.number().integer().positive().optional(),
  q: Joi.string().allow('', null).optional(),
  limit: Joi.number().integer().min(1).max(1000).default(200),
  offset: Joi.number().integer().min(0).default(0),
});

const reportQuery = Joi.object({
  courseId: Joi.number().integer().positive().optional(),
  easyfixerId: Joi.number().integer().positive().optional(),
  q: Joi.string().allow('', null).optional(),
  // 'overdue' is evaluated in the same derived table as the other two, so the
  // count and the page always describe the same set — see trainingReport.
  status: Joi.string().valid('complete', 'incomplete', 'overdue').allow('', null).optional(),
  limit: Joi.number().integer().min(1).max(1000).default(200),
  offset: Joi.number().integer().min(0).default(0),
  sortBy: Joi.string().valid(...Object.keys(svc.REPORT_SORTABLE_COLUMNS)).default('technician'),
  sortDir: Joi.string().lowercase().valid('asc', 'desc').default('asc'),
});

// ─── Courses ─────────────────────────────────────────────────────────

router.get('/courses', validate(listCoursesQuery, 'query'), async (req, res, next) => {
  try {
    modernOk(res, await svc.listCourses(req.query));
  } catch (e) { next(e); }
});

router.get('/courses/:id', validate(idParam, 'params'), async (req, res, next) => {
  try {
    modernOk(res, await svc.getCourseById(req.params.id));
  } catch (e) { next(e); }
});

router.post('/courses', requireLmsManage, validate(createCourseBody), async (req, res, next) => {
  try {
    const created = await svc.createCourse(req.body);
    res.status(201);
    modernOk(res, created);
  } catch (e) { next(e); }
});

router.patch('/courses/:id', requireLmsManage, validate(idParam, 'params'), validate(updateCourseBody), async (req, res, next) => {
  try {
    modernOk(res, await svc.updateCourse(req.params.id, req.body));
  } catch (e) { next(e); }
});

/*
 * DELETE retires (status = 0); it never removes the row. Assignment and
 * progress history point at this course and must keep resolving — a
 * technician who completed a since-withdrawn course still completed it.
 */
router.delete('/courses/:id', requireLmsManage, validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Retire course · id=' + req.params.id);
    modernOk(res, await svc.retireCourse(req.params.id));
  } catch (e) { next(e); }
});

// ─── Course content ──────────────────────────────────────────────────

/*
 * Assign a course to every active technician, as one explicit action.
 *
 * Separate from PATCH /courses/:id on purpose. Marking a course mandatory
 * decides what FUTURE registrations must watch; back-filling it onto thousands
 * of existing technicians is a different decision with a different blast
 * radius, and the CRM asks before calling this. Idempotent, so answering the
 * prompt twice costs nothing and never disturbs an existing assignee's due
 * date, progress or score.
 */
router.post('/courses/:id/assign-all', requireLmsManage, validate(idParam, 'params'),
  validate(Joi.object({ due_date: Joi.date().allow(null).optional() })), async (req, res, next) => {
    try {
      const result = await svc.assignCourseToAll(req.params.id, { dueDate: req.body.due_date ?? null });
      modernOk(res, result);
    } catch (e) { next(e); }
  });

router.get('/courses/:id/videos', validate(idParam, 'params'), async (req, res, next) => {
  try {
    modernOk(res, await svc.getCourseVideos(req.params.id));
  } catch (e) { next(e); }
});

router.put('/courses/:id/videos', requireLmsManage, validate(idParam, 'params'), validate(setContentBody), async (req, res, next) => {
  try {
    modernOk(res, await svc.setCourseVideos(req.params.id, req.body.video_ids));
  } catch (e) { next(e); }
});

/*
 * The kind-aware content list. GET/PUT /videos above are the same course seen
 * through a video-only lens and are kept working for the existing CRM screen;
 * these two are what the Content page uses.
 *
 * There is no third table behind them — both pairs read and write lms_content,
 * so an operator cannot end up with a course that looks different depending on
 * which screen opened it.
 */
router.get('/courses/:id/content', validate(idParam, 'params'), async (req, res, next) => {
  try {
    modernOk(res, await svc.getCourseContent(req.params.id));
  } catch (e) { next(e); }
});

router.put('/courses/:id/content', requireLmsManage, validate(idParam, 'params'), validate(setCourseContentBody), async (req, res, next) => {
  try {
    modernOk(res, await svc.setCourseContent(req.params.id, req.body.items));
  } catch (e) { next(e); }
});

// ─── Documents ───────────────────────────────────────────────────────

router.get('/documents', validate(listDocumentsQuery, 'query'), async (req, res, next) => {
  try {
    modernOk(res, await svc.listDocuments(req.query));
  } catch (e) { next(e); }
});

/*
 * Upload a training document.
 *
 * multipart, because the alternative — a base64 body — inflates a 25 MB deck
 * to 34 MB and would have to clear the JSON body limit that exists to stop
 * exactly that.
 *
 * S3 IS REQUIRED, and its absence is a 503 rather than a local-disk fallback.
 * The notice-image upload does fall back, because a missing decoration is
 * cosmetic; a training document a technician cannot open is a course they
 * cannot complete, and a file written to one container's ephemeral disk is
 * unreadable from the next one. Better to refuse loudly at upload time than to
 * accept a document that will 404 for its audience.
 *
 * The stored value is the OBJECT KEY, never a URL — see lms.service::documentUrl.
 */
/*
 * Upload one question image and return its S3 key. Nothing is written to the
 * database here.
 *
 * WHY THE UPLOAD IS SEPARATE FROM THE SAVE. Questions are saved as a FULL
 * REPLACE — every row deleted and re-inserted — so question ids do not survive
 * an edit and a key derived from one would orphan its object on every save.
 * The operator uploads first, the CRM holds the returned key in the draft, and
 * the key round-trips unchanged on each save. A retried save re-sends the same
 * key and produces the same rows.
 *
 * THE ORPHAN, STATED PLAINLY. Replacing or removing a question's image leaves
 * the old object in S3 — the same trade retireDocument already makes (it flips
 * status and never deletes). Diffing old-against-new key sets inside the
 * replace transaction is exactly the bookkeeping that DELETE-then-INSERT
 * exists to avoid, for a few KB per orphan. s3.deleteObject is there if a
 * cleanup cron is ever actually wanted.
 *
 * S3 is REQUIRED — 503 rather than a local-disk fallback, for the same reason
 * as documents below: a file on one container's ephemeral disk 404s from the
 * next one, and an assessment whose image will not load is worse than one that
 * refused to accept it.
 */
/*
 * Stream one technician's completion certificate as a PDF.
 *
 * NOT modernOk(): the body is the document itself. Content-Disposition makes
 * the browser save it with a readable name rather than "certificate".
 *
 * no-store, deliberately. The URL is stable and the document contains a named
 * individual; a cached copy sitting in a shared-machine browser cache is a
 * small privacy leak for no benefit, since regenerating costs one query and a
 * few KB of pdfkit.
 *
 * Errors BEFORE the first byte become a normal JSON 404 via next(e). Once
 * renderCertificatePdf has started piping, the status line is already sent —
 * so nothing between here and doc.end() may throw a response. That is why the
 * data is fetched completely first and the render is the last statement.
 */
/*
 * assignmentParams, NOT idParam. validate() runs Joi with stripUnknown and then
 * assigns the result back over req.params — so validating a two-parameter route
 * against a one-key schema does not merely fail to check the second parameter,
 * it DELETES it, and the handler reads undefined. Reusing the schema that
 * already names both is the only correct option here.
 */
router.get('/courses/:courseId/certificate/:easyfixerId', requireLmsManage,
  validate(assignmentParams, 'params'),
  async (req, res, next) => {
    try {
      const courseId = Number(req.params.courseId);
      const efrId = Number(req.params.easyfixerId);
      logger.info('Certificate requested · courseId=' + courseId + ' · efrId=' + efrId);
      const row = await svc.certificateData(courseId, efrId);

      const safeName = String(row.course_name || 'course')
        .replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'course';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Disposition',
        `attachment; filename="EasyFix-Certificate-${safeName}-${efrId}.pdf"`);

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

router.post('/assessments/images', requireLmsManage, questionImageUpload.single('file'), async (req, res, next) => {
  try {
    logger.info('Upload question image · mime=' + (req.file?.mimetype || 'none')
      + ' size=' + (req.file?.size ?? 0));
    if (!req.file) return modernError(res, 400, 'missing "file" upload');
    if (!IMAGE_MIME.has(req.file.mimetype)) {
      logger.warn('Question image rejected · mime=' + req.file.mimetype);
      return modernError(res, 400, 'only PNG, JPEG, WebP and GIF images are accepted');
    }
    if (!s3.isEnabled()) {
      return modernError(res, 503, 'image storage is not configured (S3_BUCKET_NAME unset)');
    }
    const key = `LmsQuestions/${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    await s3.putAtKey({
      key,
      buffer: req.file.buffer,
      contentType: req.file.mimetype,
      originalName: req.file.originalname,
    });
    logger.info('Question image stored · key=' + key);
    res.status(201);
    return modernOk(res, { key }, 'image uploaded');
  } catch (e) {
    if (e.code === 'LIMIT_FILE_SIZE') {
      logger.warn('Question image upload failed · file exceeds 5MB');
      return modernError(res, 400, 'image exceeds 5MB');
    }
    return next(e);
  }
});

router.post('/documents', requireLmsManage, documentUpload.single('file'), async (req, res, next) => {
  try {
    logger.info('Upload LMS document · mime=' + (req.file?.mimetype || 'none') + ' size=' + (req.file?.size ?? 0));
    if (!req.file) return modernError(res, 400, 'missing "file" upload');
    const title = String(req.body?.title || '').trim();
    if (title.length < 2) return modernError(res, 400, 'title is required');

    // MIME and extension together: browsers under-report .pptx as
    // application/octet-stream, and octet-stream alone would accept anything.
    const mimeOk = DOCUMENT_MIME.has(req.file.mimetype);
    const extOk = DOCUMENT_EXT.test(req.file.originalname || '');
    if (!mimeOk || !extOk) {
      logger.warn('LMS document rejected · mime=' + req.file.mimetype + ' name=' + req.file.originalname);
      return modernError(res, 400, 'only PDF and PowerPoint files are accepted');
    }
    if (!s3.isEnabled()) {
      return modernError(res, 503, 'document storage is not configured (S3_BUCKET_NAME unset)');
    }

    const key = `LmsDocuments/${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    await s3.putAtKey({
      key,
      buffer: req.file.buffer,
      contentType: req.file.mimetype,
      originalName: req.file.originalname,
    });
    const created = await svc.createDocument({
      title,
      fileKey: key,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size ?? null,
      createdBy: req.user?.user_id ?? null,
    });
    logger.info('LMS document stored · id=' + created.id + ' · key=' + key);
    res.status(201);
    return modernOk(res, created, 'document uploaded');
  } catch (e) {
    if (e.code === 'LIMIT_FILE_SIZE') {
      logger.warn('LMS document upload failed · file exceeds 25MB');
      return modernError(res, 400, 'file exceeds 25MB');
    }
    return next(e);
  }
});

router.patch('/documents/:id', requireLmsManage, validate(idParam, 'params'), validate(updateDocumentBody), async (req, res, next) => {
  try {
    modernOk(res, await svc.updateDocument(req.params.id, req.body));
  } catch (e) { next(e); }
});

/*
 * Retires (status = 0), and refuses with 409 while a course still holds it.
 * The S3 object is deliberately left in place: an attempt or an
 * acknowledgement recorded against this document is evidence, and evidence
 * whose subject has been deleted is not evidence.
 */
router.delete('/documents/:id', requireLmsManage, validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Retire LMS document · id=' + req.params.id);
    modernOk(res, await svc.retireDocument(req.params.id));
  } catch (e) { next(e); }
});

// ─── Assessments ─────────────────────────────────────────────────────

router.get('/assessments', validate(listAssessmentsQuery, 'query'), async (req, res, next) => {
  try {
    modernOk(res, await svc.listAssessments(req.query));
  } catch (e) { next(e); }
});

/*
 * Includes is_correct — this is the answer key, and it is the ONLY endpoint
 * that serves it. The technician-facing read is a different route on a
 * different router built from a different projection
 * (lms.service::getAssessmentForTech), never this response with the answers
 * filtered out.
 *
 * requireLmsManage, EVEN THOUGH IT IS A READ — the one exception to the
 * "reads stay open to any admin-group user" rule in the header. That rule is
 * about consuming a list; this response is the answers to a paper that gates
 * whether a technician is marked trained. Without the key here, the route
 * inherits only requireAuth + role(['admin']), so every admin-group user —
 * including geographically scoped operators who can also see technicians'
 * names — could fetch it. The CRM hides the button, which is not a control:
 * the URL is guessable and the response is the whole key.
 */
router.get('/assessments/:id', requireLmsManage, validate(idParam, 'params'), async (req, res, next) => {
  try {
    modernOk(res, await svc.getAssessmentForAdmin(req.params.id));
  } catch (e) { next(e); }
});

router.post('/assessments', requireLmsManage, validate(createAssessmentBody), async (req, res, next) => {
  try {
    // Same source as the document upload's createdBy one route file over:
    // the acting operator's tbl_user id, or NULL when the token carries none.
    const created = await svc.createAssessment({ ...req.body, createdBy: req.user?.user_id ?? null });
    res.status(201);
    modernOk(res, created);
  } catch (e) { next(e); }
});

router.patch('/assessments/:id', requireLmsManage, validate(idParam, 'params'), validate(updateAssessmentBody), async (req, res, next) => {
  try {
    modernOk(res, await svc.updateAssessment(req.params.id, req.body));
  } catch (e) { next(e); }
});

/*
 * FULL replace of the paper. Not a per-question CRUD, because the shape rules
 * ("at least one question", "exactly one correct option") are properties of
 * the WHOLE paper: a per-question endpoint can only ever validate the question
 * in front of it, and would happily leave an assessment with zero questions
 * between two calls.
 */
router.put('/assessments/:id/questions', requireLmsManage, validate(idParam, 'params'), validate(setQuestionsBody), async (req, res, next) => {
  try {
    modernOk(res, await svc.setAssessmentQuestions(req.params.id, req.body.questions));
  } catch (e) { next(e); }
});

router.delete('/assessments/:id', requireLmsManage, validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Retire assessment · id=' + req.params.id);
    modernOk(res, await svc.retireAssessment(req.params.id));
  } catch (e) { next(e); }
});

/*
 * Give one technician his attempts back on one assessment.
 *
 * THE ONLY WAY OUT of an exhausted paper. Running out of attempts is otherwise
 * terminal: the submit 409s forever, the course can never stamp complete
 * because completion needs a PASSING attempt, and the overdue restriction then
 * withdraws work — with nothing the technician or the operator can do about
 * it. Extending the deadline does not help; what is blocked is the paper.
 *
 * Deliberately NOT a bulk reset and not part of PATCH: it is one person, one
 * paper, one decision, and it should read that way in the audit log.
 */
router.delete('/assessments/:id/attempts/:easyfixerId', requireLmsManage,
  validate(Joi.object({
    id: Joi.number().integer().positive().required(),
    easyfixerId: Joi.number().integer().positive().required(),
  }), 'params'), async (req, res, next) => {
    try {
      logger.info('Reset assessment attempts · assessmentId=' + req.params.id
        + ' · efrId=' + req.params.easyfixerId + ' · by=' + (req.user?.user_id ?? 'unknown'));
      modernOk(res, await svc.resetAssessmentAttempts(req.params.id, req.params.easyfixerId));
    } catch (e) { next(e); }
  });

// ─── Assignment ──────────────────────────────────────────────────────

// City-scoped: this lists TECHNICIANS. See the scope note in the header.
router.get('/assignments', validate(listAssignmentsQuery, 'query'), async (req, res, next) => {
  try {
    const scope = buildRequestScope(req);
    modernOk(res, await svc.listAssignments({ ...req.query, scope }));
  } catch (e) { next(e); }
});

/*
 * Assign one course to many technicians in a single call. The response
 * separates `assigned` from `alreadyAssigned` so the CRM can say "3 assigned,
 * 2 already held it" instead of silently reporting five successes — repeat
 * assignment is a no-op by design (the unique key makes it an upsert that
 * leaves any existing score untouched).
 */
router.post('/assignments', requireLmsManage, validate(assignBody), async (req, res, next) => {
  try {
    modernOk(res, await svc.assignCourse(req.body.course_id, req.body.easyfixer_ids, {
      durationMonths: req.body.duration_months,
      durationDays: req.body.duration_days,
    }));
  } catch (e) { next(e); }
});

/*
 * Move an assignment's deadline. This is BOTH "extend to unblock a technician"
 * and "correct a wrong deadline" — one row, one column, one outcome, so one
 * endpoint. The service anchors the new date at max(today, current due date),
 * which is what makes an extension work in both directions; see
 * lms.service::extendAssignment.
 */
router.patch('/assignments/:courseId/:easyfixerId', requireLmsManage, validate(assignmentParams, 'params'), validate(extendBody), async (req, res, next) => {
  try {
    modernOk(res, await svc.extendAssignment(req.params.courseId, req.params.easyfixerId, {
      months: req.body.duration_months,
      days: req.body.duration_days,
    }));
  } catch (e) { next(e); }
});

router.delete('/assignments/:courseId/:easyfixerId', requireLmsManage, validate(assignmentParams, 'params'), async (req, res, next) => {
  try {
    modernOk(res, await svc.unassignCourse(req.params.courseId, req.params.easyfixerId));
  } catch (e) { next(e); }
});

// ─── Report ──────────────────────────────────────────────────────────

// City-scoped: one row per (technician, course). See the header scope note.
router.get('/report', validate(reportQuery, 'query'), async (req, res, next) => {
  try {
    const scope = buildRequestScope(req);
    modernOk(res, await svc.trainingReport({ ...req.query, scope }));
  } catch (e) { next(e); }
});

module.exports = router;
