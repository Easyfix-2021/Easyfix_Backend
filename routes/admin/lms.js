const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const { roleByName } = require('../../middleware/role');
const svc = require('../../services/lms.service');
const { modernOk } = require('../../utils/response');
const logger = require('../../logger');

/*
 * LMS admin API — courses, course content, assignment and the completion
 * report. Mounted at /api/admin/lms, so it inherits requireAuth,
 * role(['admin']) and maskMobile from routes/admin/index.js; writes narrow
 * further to roleByName(['Admin']) exactly as the other master-data routes do.
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

const idParam = Joi.object({ id: Joi.number().integer().positive().required() });

const assignmentParams = Joi.object({
  courseId: Joi.number().integer().positive().required(),
  easyfixerId: Joi.number().integer().positive().required(),
});

const listCoursesQuery = Joi.object({
  q: Joi.string().allow('', null).optional(),
  includeInactive: Joi.boolean().default(false),
  limit: Joi.number().integer().min(1).max(1000).default(200),
  offset: Joi.number().integer().min(0).default(0),
  sortBy: Joi.string().valid(...Object.keys(svc.SORTABLE_COLUMNS)).default('name'),
  sortDir: Joi.string().lowercase().valid('asc', 'desc').default('asc'),
});

const createCourseBody = Joi.object({
  name: Joi.string().trim().min(2).max(150).required(),
  description: Joi.string().max(2000).allow('', null).optional(),
});

const updateCourseBody = Joi.object({
  name: Joi.string().trim().min(2).max(150).optional(),
  description: Joi.string().max(2000).allow('', null).optional(),
  status: Joi.boolean().optional(),
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

const assignBody = Joi.object({
  course_id: Joi.number().integer().positive().required(),
  easyfixer_ids: Joi.array().items(Joi.number().integer().positive()).min(1).max(500).required(),
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
  status: Joi.string().valid('complete', 'incomplete').allow('', null).optional(),
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

router.post('/courses', roleByName(['Admin']), validate(createCourseBody), async (req, res, next) => {
  try {
    const created = await svc.createCourse(req.body);
    res.status(201);
    modernOk(res, created);
  } catch (e) { next(e); }
});

router.patch('/courses/:id', roleByName(['Admin']), validate(idParam, 'params'), validate(updateCourseBody), async (req, res, next) => {
  try {
    modernOk(res, await svc.updateCourse(req.params.id, req.body));
  } catch (e) { next(e); }
});

/*
 * DELETE retires (status = 0); it never removes the row. Assignment and
 * progress history point at this course and must keep resolving — a
 * technician who completed a since-withdrawn course still completed it.
 */
router.delete('/courses/:id', roleByName(['Admin']), validate(idParam, 'params'), async (req, res, next) => {
  try {
    logger.info('Retire course · id=' + req.params.id);
    modernOk(res, await svc.retireCourse(req.params.id));
  } catch (e) { next(e); }
});

// ─── Course content ──────────────────────────────────────────────────

router.get('/courses/:id/videos', validate(idParam, 'params'), async (req, res, next) => {
  try {
    modernOk(res, await svc.getCourseVideos(req.params.id));
  } catch (e) { next(e); }
});

router.put('/courses/:id/videos', roleByName(['Admin']), validate(idParam, 'params'), validate(setContentBody), async (req, res, next) => {
  try {
    modernOk(res, await svc.setCourseVideos(req.params.id, req.body.video_ids));
  } catch (e) { next(e); }
});

// ─── Assignment ──────────────────────────────────────────────────────

router.get('/assignments', validate(listAssignmentsQuery, 'query'), async (req, res, next) => {
  try {
    modernOk(res, await svc.listAssignments(req.query));
  } catch (e) { next(e); }
});

/*
 * Assign one course to many technicians in a single call. The response
 * separates `assigned` from `alreadyAssigned` so the CRM can say "3 assigned,
 * 2 already held it" instead of silently reporting five successes — repeat
 * assignment is a no-op by design (the unique key makes it an upsert that
 * leaves any existing score untouched).
 */
router.post('/assignments', roleByName(['Admin']), validate(assignBody), async (req, res, next) => {
  try {
    modernOk(res, await svc.assignCourse(req.body.course_id, req.body.easyfixer_ids));
  } catch (e) { next(e); }
});

router.delete('/assignments/:courseId/:easyfixerId', roleByName(['Admin']), validate(assignmentParams, 'params'), async (req, res, next) => {
  try {
    modernOk(res, await svc.unassignCourse(req.params.courseId, req.params.easyfixerId));
  } catch (e) { next(e); }
});

// ─── Report ──────────────────────────────────────────────────────────

router.get('/report', validate(reportQuery, 'query'), async (req, res, next) => {
  try {
    modernOk(res, await svc.trainingReport(req.query));
  } catch (e) { next(e); }
});

module.exports = router;
