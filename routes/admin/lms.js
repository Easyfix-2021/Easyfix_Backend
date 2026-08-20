const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const requireAction = require('../../middleware/require-action');
const { buildRequestScope } = require('../../lib/scope');
const svc = require('../../services/lms.service');
const { modernOk } = require('../../utils/response');
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
 * One factory call, reused on all SEVEN writes. requireAction() returns a NAMED
 * function (`actionGuard`) and route tests locate the guard by `fn.name` —
 * see tests/easyfixer-lifecycle-route-auth.test.js — so it must never be wrapped
 * in an anonymous arrow.
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
