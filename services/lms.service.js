const { pool } = require('../db');
const logger = require('../logger');

/*
 * LMS — courses, course content, assignment and completion reporting.
 *
 * ─── The data model, and why it is split across two engines ──────────────
 *
 *   courses            InnoDB   the course itself (id, name, description, status)
 *   course_videos      InnoDB   NEW — which videos a course contains, ordered
 *   easyfixer_courses  InnoDB   which technician is assigned which course (+ score)
 *   training_videos    MyISAM   the video catalogue (legacy Java table)
 *   easyfixer_watched_video
 *                      MyISAM   per-technician, per-video watched_percentage
 *
 * The InnoDB half enforces its own referential integrity — course_videos and
 * easyfixer_courses both carry real foreign keys, so a deleted course cannot
 * strand content or assignments.
 *
 * The MyISAM half CANNOT. MySQL parses foreign keys on MyISAM tables and then
 * silently ignores them, so `video_id` references are guarded here in
 * application code instead. Any function in this file that accepts a video id
 * from a caller must prove the video exists before writing it — the database
 * will not do it for us. The same reason is why deleting a training video is
 * refused while progress rows point at it (routes/admin/auxiliary.js): five
 * such rows were already orphaned before that guard existed.
 *
 * MyISAM also cannot participate in a transaction. Nothing here wraps a
 * progress read in one; the only transactional block is setCourseVideos,
 * which touches InnoDB exclusively.
 */

function mkErr(status, message) { const e = new Error(message); e.status = status; return e; }

/*
 * What counts as "watched". Progress is monotonic (a BEFORE UPDATE trigger
 * plus a GREATEST() upsert mean it can never regress), so this compares
 * against the technician's high-water mark, not their latest ping.
 *
 * 100 is FIXED, not a tunable default — do not soften it to 90/95.
 *
 * The technician app's player does not allow scrubbing forward, so the only
 * way to reach 100 is to sit through the whole video. That makes the number
 * mean something specific: 100 is proof of end-to-end viewing, not a
 * progress estimate that might stall a point or two short. Lowering the
 * threshold would not be a leniency tweak — it would let a technician skip
 * the closing minutes of every video and still be advanced out of
 * TRAINING_PENDING by the lifecycle wire.
 *
 * Every completion calculation in this file and in the lifecycle wire reads
 * this constant, so the invariant holds in one place.
 */
const COMPLETION_PERCENT = 100;

/*
 * video_count and assigned_count are SELECT-list aliases over correlated
 * subqueries, not columns. MySQL resolves an alias in ORDER BY (it is
 * evaluated after the select list), so sorting by them needs no extra join —
 * which is the whole reason the counts are subqueries rather than a fan-out
 * JOIN + GROUP BY.
 */
const SORTABLE_COLUMNS = Object.freeze({
  id:             'c.id',
  name:           'c.name',
  status:         'c.status',
  video_count:    'video_count',
  assigned_count: 'assigned_count',
  created_at:     'c.created_at',
});

/*
 * These name columns of the OUTER query — the derived table `t` in
 * trainingReport — not of the inner SELECT. Sorting has to happen after
 * completion_pct is computed, and `t` is the only scope where it exists.
 */
const REPORT_SORTABLE_COLUMNS = Object.freeze({
  technician:     't.technician_name',
  course:         't.course_name',
  completion_pct: 'completion_pct',
  score:          't.score',
  assigned_on:    't.assigned_on',
});

// ─────────────────────────────────────────────────────────────────────
// Courses
// ─────────────────────────────────────────────────────────────────────

async function listCourses({
  q, includeInactive = false,
  limit = 200, offset = 0,
  sortBy = 'name', sortDir = 'asc',
} = {}) {
  limit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  offset = Math.max(Number(offset) || 0, 0);

  logger.info('List courses · q=' + (q || '') + ' · includeInactive=' + includeInactive
    + ' · limit=' + limit + ' · offset=' + offset + ' · sortBy=' + sortBy + ' · sortDir=' + sortDir);

  const sortExpr = SORTABLE_COLUMNS[sortBy] || SORTABLE_COLUMNS.name;
  const dir = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  const where = ['1=1'];
  const params = [];
  if (!includeInactive) where.push('c.status = 1');
  if (q && String(q).trim()) {
    where.push('(c.name LIKE ? OR c.description LIKE ?)');
    params.push(`%${String(q).trim()}%`, `%${String(q).trim()}%`);
  }
  const whereSql = where.join(' AND ');

  /*
   * video_count and assigned_count come from correlated subqueries rather
   * than JOIN + GROUP BY. Two independent one-to-many joins on the same row
   * would multiply out (a course with 3 videos and 4 assignees would report
   * 12 of each), and the fix — COUNT(DISTINCT …) over a fan-out — reads worse
   * and scans more than two indexed counts.
   */
  const [rows] = await pool.query(
    `SELECT c.id, c.name, c.description, c.status, c.created_at, c.updated_at,
            (SELECT COUNT(*) FROM course_videos cv WHERE cv.course_id = c.id) AS video_count,
            (SELECT COUNT(*) FROM easyfixer_courses ec WHERE ec.course_id = c.id) AS assigned_count
       FROM courses c
      WHERE ${whereSql}
      ORDER BY ${sortExpr} ${dir}, c.id ASC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM courses c WHERE ${whereSql}`,
    params,
  );

  logger.info('Found ' + rows.length + ' courses of ' + total);
  return { rows, total, limit, offset };
}

async function getCourseById(id) {
  const [rows] = await pool.query(
    `SELECT id, name, description, status, created_at, updated_at
       FROM courses WHERE id = ?`,
    [Number(id)],
  );
  if (!rows.length) throw mkErr(404, 'course not found');
  return rows[0];
}

async function createCourse({ name, description }) {
  logger.info('Create course · name=' + name);
  const [dupe] = await pool.query(
    'SELECT id FROM courses WHERE name = ? AND status = 1',
    [String(name).trim()],
  );
  if (dupe.length) throw mkErr(409, 'a course with this name already exists');

  /*
   * created_at / updated_at are written EXPLICITLY. Both columns are plain
   * nullable TIMESTAMPs with no DEFAULT CURRENT_TIMESTAMP and no ON UPDATE
   * clause (verified against information_schema), so an INSERT that omits
   * them stores NULL — which surfaced as a blank "Created" column the first
   * time a course was made.
   *
   * `new Date()` as a bound parameter, never NOW(): the pool runs with
   * timezone '+05:30' and dateStrings, so the driver converts the JS instant
   * to IST wall-clock on the way in and hands it back verbatim. NOW() would
   * take the database server's own clock and bypass that conversion.
   */
  const now = new Date();
  const [ins] = await pool.query(
    'INSERT INTO courses (name, description, status, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
    [String(name).trim(), description || null, now, now],
  );
  logger.info('Course created · id=' + ins.insertId);
  return { id: ins.insertId };
}

async function updateCourse(id, patch = {}) {
  const courseId = Number(id);
  await getCourseById(courseId);

  const sets = [];
  const params = [];
  if (patch.name !== undefined) {
    const [dupe] = await pool.query(
      'SELECT id FROM courses WHERE name = ? AND status = 1 AND id <> ?',
      [String(patch.name).trim(), courseId],
    );
    if (dupe.length) throw mkErr(409, 'a course with this name already exists');
    sets.push('name = ?');
    params.push(String(patch.name).trim());
  }
  /*
   * description is written with a plain placeholder, NOT COALESCE(?, description).
   * COALESCE only guards NULL — an empty string passes straight through it and
   * would look like a no-op while actually blanking the column. Clearing the
   * description is a legitimate edit, so it is accepted literally.
   */
  if (patch.description !== undefined) {
    sets.push('description = ?');
    params.push(patch.description || null);
  }
  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status ? 1 : 0);
  }
  if (!sets.length) throw mkErr(400, 'nothing to update');

  // No ON UPDATE CURRENT_TIMESTAMP on this column — stamp it by hand, in IST,
  // for the same reason createCourse does.
  sets.push('updated_at = ?');
  params.push(new Date());

  await pool.query(
    `UPDATE courses SET ${sets.join(', ')} WHERE id = ?`,
    [...params, courseId],
  );
  logger.info('Course updated · id=' + courseId + ' · fields=' + sets.length);
  return getCourseById(courseId);
}

/*
 * Retire, never DELETE. The assignment and progress history that points at a
 * course outlives the course's usefulness — a technician who completed
 * "Induction 2025" still completed it after the course is withdrawn, and the
 * Training Report has to keep saying so.
 */
async function retireCourse(id) {
  const courseId = Number(id);
  await getCourseById(courseId);
  await pool.query('UPDATE courses SET status = 0 WHERE id = ?', [courseId]);
  logger.info('Course retired · id=' + courseId);
  return { retired: true };
}

// ─────────────────────────────────────────────────────────────────────
// Course content
// ─────────────────────────────────────────────────────────────────────

async function getCourseVideos(courseId) {
  const [rows] = await pool.query(
    `SELECT cv.id, cv.video_id, cv.sequence,
            tv.title, tv.sub_title, tv.description
       FROM course_videos cv
       LEFT JOIN training_videos tv ON tv.id = cv.video_id
      WHERE cv.course_id = ?
      ORDER BY cv.sequence ASC, cv.id ASC`,
    [Number(courseId)],
  );
  return rows;
}

/*
 * Replace a course's content with exactly `videoIds`, in the order given.
 *
 * Delete-then-insert inside a transaction rather than a diff: the content of
 * a course is small (single digits), the ordering is positional, and a diff
 * would have to reconcile sequence numbers anyway. Both tables touched here
 * are InnoDB, so the transaction is real.
 *
 * Every id is validated against training_videos FIRST, because course_videos
 * cannot foreign-key to a MyISAM table — see the header note.
 */
async function setCourseVideos(courseId, videoIds = []) {
  const id = Number(courseId);
  await getCourseById(id);

  const ids = [...new Set(videoIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  logger.info('Set course content · courseId=' + id + ' · videos=' + ids.length);

  if (ids.length) {
    const [found] = await pool.query(
      `SELECT id FROM training_videos WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids,
    );
    const known = new Set(found.map((r) => r.id));
    const missing = ids.filter((v) => !known.has(v));
    if (missing.length) {
      throw mkErr(400, `unknown training video id(s): ${missing.join(', ')}`);
    }
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM course_videos WHERE course_id = ?', [id]);
    for (const [index, videoId] of ids.entries()) {
      await conn.query(
        'INSERT INTO course_videos (course_id, video_id, sequence) VALUES (?, ?, ?)',
        [id, videoId, index + 1],
      );
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  logger.info('Course content saved · courseId=' + id);
  return getCourseVideos(id);
}

// ─────────────────────────────────────────────────────────────────────
// Videos
// ─────────────────────────────────────────────────────────────────────

/*
 * How many technicians hold progress against a video. This is the number the
 * delete guard refuses on, and the number the Training Videos page shows so
 * an operator can see WHY a delete would be refused before they attempt it.
 */
async function videoProgressCount(videoId) {
  const [[row]] = await pool.query(
    'SELECT COUNT(*) AS n FROM easyfixer_watched_video WHERE video_id = ?',
    [Number(videoId)],
  );
  return Number(row.n) || 0;
}

/*
 * Does this video id actually exist?
 *
 * The technician app posts watched-progress keyed by video id, and until now
 * the only validation was Joi's "a positive integer". That is how the five
 * bad rows in easyfixer_watched_video were written: they carry
 * `training_video_id` values (1, 2, 3 — the FK into the legacy document
 * table) instead of `training_videos.id` values (4, 5, 6). Two id spaces,
 * one column, and MyISAM will not enforce the difference because it parses
 * foreign keys and ignores them.
 *
 * Caching shape matters here. The catalogue is three rows and progress pings
 * arrive continuously, so a positive lookup is served from a short-TTL set.
 * A MISS always falls through to a real query before rejecting: that makes a
 * false NEGATIVE impossible — a video added seconds ago is still accepted —
 * and the only staleness left is a false positive for a video deleted within
 * the TTL, which the delete guard already makes near-impossible.
 */
const VIDEO_ID_CACHE_TTL_MS = 5 * 60 * 1000;
let videoIdCache = { ids: null, at: 0 };

async function isKnownVideo(videoId) {
  const id = Number(videoId);
  if (!Number.isInteger(id) || id <= 0) return false;

  const fresh = videoIdCache.ids && (Date.now() - videoIdCache.at) < VIDEO_ID_CACHE_TTL_MS;
  if (fresh && videoIdCache.ids.has(id)) return true;

  // Cache miss, stale, or cold — ask the database before saying no.
  const [rows] = await pool.query('SELECT id FROM training_videos');
  videoIdCache = { ids: new Set(rows.map((r) => Number(r.id))), at: Date.now() };
  return videoIdCache.ids.has(id);
}

// Called after any write to the catalogue so a delete cannot leave a stale
// positive behind for the rest of the TTL.
function invalidateVideoIdCache() {
  videoIdCache = { ids: null, at: 0 };
}

async function videoCourseCount(videoId) {
  const [[row]] = await pool.query(
    'SELECT COUNT(*) AS n FROM course_videos WHERE video_id = ?',
    [Number(videoId)],
  );
  return Number(row.n) || 0;
}

/*
 * The video catalogue, enriched with the two counts the CRM needs: how many
 * technicians have progress against it, and how many courses include it.
 *
 * Both are correlated subqueries for the same fan-out reason as listCourses.
 */
async function listVideos({ q, limit = 200, offset = 0 } = {}) {
  limit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  offset = Math.max(Number(offset) || 0, 0);

  const where = ['1=1'];
  const params = [];
  if (q && String(q).trim()) {
    where.push('(tv.title LIKE ? OR tv.sub_title LIKE ? OR tv.description LIKE ?)');
    const like = `%${String(q).trim()}%`;
    params.push(like, like, like);
  }
  const whereSql = where.join(' AND ');

  /*
   * video_url comes from the legacy `document` table, not from a column on
   * training_videos — there has never been a url column here. The link lives
   * at document.url and training_videos.training_video_id is the FK to it
   * (document_type_id = 2 is "Video / Training Videos"; note a DIFFERENT
   * table, tbl_document_type, uses 2 for Ration Card — do not confuse them).
   *
   * document_type_id is kept in the JOIN ON as a guard rather than in WHERE,
   * so a row whose document is missing or mistyped still returns with a null
   * url instead of vanishing from the catalogue.
   */
  const [rows] = await pool.query(
    `SELECT tv.id, tv.title, tv.description, tv.sub_title, tv.sub_description,
            tv.training_video_id, d.url AS video_url,
            (SELECT COUNT(*) FROM easyfixer_watched_video w WHERE w.video_id = tv.id) AS progress_count,
            (SELECT COUNT(*) FROM course_videos cv WHERE cv.video_id = tv.id) AS course_count
       FROM training_videos tv
       LEFT JOIN document d ON d.id = tv.training_video_id AND d.document_type_id = 2
      WHERE ${whereSql}
      ORDER BY tv.id DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM training_videos tv WHERE ${whereSql}`,
    params,
  );

  logger.info('Found ' + rows.length + ' training videos of ' + total);
  // Repair legacy links on the way out so every consumer — the CRM preview and
  // the technician app alike — receives something it can actually play.
  const playable = rows.map((r) => ({ ...r, video_url: normalizeVideoUrl(r.video_url) || null }));
  return { rows: playable, total, limit, offset };
}

// ─────────────────────────────────────────────────────────────────────
// Assignment
// ─────────────────────────────────────────────────────────────────────

/*
 * Assign one course to N technicians, idempotently.
 *
 * The upsert leans on uq_easyfixer_course (easyfixer_id, course_id), added by
 * the LMS migration. Without that key a re-assign would insert a second row
 * and the report would count the course twice for that technician.
 *
 * `score` is deliberately NOT touched on a repeat assign — re-assigning a
 * course a technician has already been scored on must not wipe their result.
 */
async function assignCourse(courseId, easyfixerIds = []) {
  const id = Number(courseId);
  await getCourseById(id);

  const ids = [...new Set(easyfixerIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) throw mkErr(400, 'select at least one technician');

  const [found] = await pool.query(
    `SELECT efr_id FROM tbl_easyfixer WHERE efr_id IN (${ids.map(() => '?').join(',')})`,
    ids,
  );
  const known = new Set(found.map((r) => r.efr_id));
  const missing = ids.filter((v) => !known.has(v));
  if (missing.length) throw mkErr(400, `unknown technician id(s): ${missing.join(', ')}`);

  logger.info('Assign course · courseId=' + id + ' · technicians=' + ids.length);
  // Same story as createCourse: these TIMESTAMPs carry no defaults, and
  // created_at is what the Assign page and the report render as "Assigned On".
  // Left implicit it would be NULL on every new assignment.
  const now = new Date();
  let assigned = 0;
  for (const efrId of ids) {
    const [r] = await pool.query(
      `INSERT INTO easyfixer_courses (easyfixer_id, course_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE updated_at = VALUES(updated_at)`,
      [efrId, id, now, now],
    );
    // affectedRows is 1 for a fresh insert, 2 for an update of an existing row.
    if (r.affectedRows === 1) assigned += 1;
  }
  logger.info('Course assigned · courseId=' + id + ' · new=' + assigned + ' · alreadyHeld=' + (ids.length - assigned));
  return { requested: ids.length, assigned, alreadyAssigned: ids.length - assigned };
}

async function unassignCourse(courseId, easyfixerId) {
  const [r] = await pool.query(
    'DELETE FROM easyfixer_courses WHERE course_id = ? AND easyfixer_id = ?',
    [Number(courseId), Number(easyfixerId)],
  );
  if (r.affectedRows === 0) throw mkErr(404, 'assignment not found');
  logger.info('Course unassigned · courseId=' + courseId + ' · efrId=' + easyfixerId);
  return { unassigned: true };
}

async function listAssignments({ courseId, easyfixerId, q, limit = 200, offset = 0 } = {}) {
  limit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  offset = Math.max(Number(offset) || 0, 0);

  const where = ['1=1'];
  const params = [];
  if (courseId) { where.push('ec.course_id = ?'); params.push(Number(courseId)); }
  if (easyfixerId) { where.push('ec.easyfixer_id = ?'); params.push(Number(easyfixerId)); }
  if (q && String(q).trim()) {
    where.push('(e.efr_name LIKE ? OR e.efr_no LIKE ? OR c.name LIKE ?)');
    const like = `%${String(q).trim()}%`;
    params.push(like, like, like);
  }
  const whereSql = where.join(' AND ');

  const [rows] = await pool.query(
    `SELECT ec.id, ec.easyfixer_id, ec.course_id, ec.score,
            ec.created_at AS assigned_on,
            e.efr_name AS technician_name, e.efr_no AS technician_mobile,
            c.name AS course_name
       FROM easyfixer_courses ec
       JOIN courses c ON c.id = ec.course_id
       LEFT JOIN tbl_easyfixer e ON e.efr_id = ec.easyfixer_id
      WHERE ${whereSql}
      ORDER BY ec.created_at DESC, ec.id DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  /*
   * The COUNT repeats the SAME joins as the main query, not a bare
   * COUNT(*) FROM easyfixer_courses. The WHERE clause references aliases
   * `e` and `c`, so dropping their joins turns the count into an
   * "Unknown column" 500 the moment anyone filters by name.
   */
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total
       FROM easyfixer_courses ec
       JOIN courses c ON c.id = ec.course_id
       LEFT JOIN tbl_easyfixer e ON e.efr_id = ec.easyfixer_id
      WHERE ${whereSql}`,
    params,
  );

  return { rows, total, limit, offset };
}

// ─────────────────────────────────────────────────────────────────────
// Completion + reporting
// ─────────────────────────────────────────────────────────────────────

/*
 * The completion report: one row per (technician, assigned course).
 *
 * videos_total counts the course's content; videos_done counts how many of
 * those the technician has taken to COMPLETION_PERCENT. Both are computed in
 * SQL so paging and sorting stay server-side.
 *
 * A course with NO videos yet reports 0/0 and a completion_pct of 0 rather
 * than dividing by zero — an empty course is "not complete", which is the
 * honest answer while an operator is still building it.
 */
async function trainingReport({
  courseId, easyfixerId, q, status,
  limit = 200, offset = 0,
  sortBy = 'technician', sortDir = 'asc',
} = {}) {
  limit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  offset = Math.max(Number(offset) || 0, 0);

  const sortExpr = REPORT_SORTABLE_COLUMNS[sortBy] || REPORT_SORTABLE_COLUMNS.technician;
  const dir = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  const where = ['1=1'];
  const params = [COMPLETION_PERCENT];
  if (courseId) { where.push('ec.course_id = ?'); params.push(Number(courseId)); }
  if (easyfixerId) { where.push('ec.easyfixer_id = ?'); params.push(Number(easyfixerId)); }
  if (q && String(q).trim()) {
    where.push('(e.efr_name LIKE ? OR e.efr_no LIKE ? OR c.name LIKE ?)');
    const like = `%${String(q).trim()}%`;
    params.push(like, like, like);
  }
  const whereSql = where.join(' AND ');

  const base = `
       FROM easyfixer_courses ec
       JOIN courses c ON c.id = ec.course_id
       LEFT JOIN tbl_easyfixer e ON e.efr_id = ec.easyfixer_id
      WHERE ${whereSql}`;

  const select = `
    SELECT ec.id, ec.easyfixer_id, ec.course_id, ec.score,
           ec.created_at AS assigned_on,
           e.efr_name AS technician_name, e.efr_no AS technician_mobile,
           c.name AS course_name,
           (SELECT COUNT(*) FROM course_videos cv WHERE cv.course_id = ec.course_id) AS videos_total,
           (SELECT COUNT(*)
              FROM course_videos cv
              JOIN easyfixer_watched_video w
                ON w.video_id = cv.video_id AND w.easyfixer_id = ec.easyfixer_id
             WHERE cv.course_id = ec.course_id
               AND COALESCE(w.watched_percentage, 0) >= ?) AS videos_done`;

  /*
   * The complete/incomplete filter is applied in SQL against the derived
   * table, NOT in JS after the query. Filtering the returned page in
   * JavaScript would drop rows the LIMIT had already selected, so the page
   * would come back short while `total` still counted them — pagination that
   * disagrees with its own rows. Both queries below wrap the same derived
   * table so the count and the page always describe the same set.
   */
  const completeExpr = 't.videos_total > 0 AND t.videos_done >= t.videos_total';
  const statusCond = status === 'complete' ? `(${completeExpr})`
    : status === 'incomplete' ? `NOT (${completeExpr})`
      : '1=1';

  const derived = `(${select} ${base}) t`;

  const [rows] = await pool.query(
    `SELECT t.*,
            CASE WHEN t.videos_total = 0 THEN 0
                 ELSE ROUND(t.videos_done * 100 / t.videos_total, 1) END AS completion_pct
       FROM ${derived}
      WHERE ${statusCond}
      ORDER BY ${sortExpr} ${dir}, t.id ASC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM ${derived} WHERE ${statusCond}`,
    params,
  );

  logger.info('Training report · rows=' + rows.length + ' of ' + total);
  return { rows, total, limit, offset, completionPercent: COMPLETION_PERCENT };
}

/*
 * Has this technician finished everything assigned to them?
 *
 * Used by the lifecycle wire, so the semantics matter more than usual:
 *
 *   - no assigned courses          → NOT complete. An unassigned technician
 *     has not "finished training"; they have not started it. Returning true
 *     here would advance every newly registered technician the instant they
 *     watched nothing at all.
 *   - a course with no videos      → NOT complete, for the same reason.
 *   - otherwise                    → every video of every assigned course
 *     must be at COMPLETION_PERCENT.
 */
async function isTrainingComplete(efrId) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS required,
            SUM(CASE WHEN COALESCE(w.watched_percentage, 0) >= ? THEN 1 ELSE 0 END) AS done
       FROM easyfixer_courses ec
       JOIN course_videos cv ON cv.course_id = ec.course_id
       LEFT JOIN easyfixer_watched_video w
              ON w.video_id = cv.video_id AND w.easyfixer_id = ec.easyfixer_id
      WHERE ec.easyfixer_id = ?`,
    [COMPLETION_PERCENT, Number(efrId)],
  );
  const required = Number(row.required) || 0;
  const done = Number(row.done) || 0;
  return { complete: required > 0 && done >= required, required, done };
}

/*
 * ─── Video link ──────────────────────────────────────────────────────
 *
 * YouTube only, by product decision. The canonical form stored is the
 * standard watch URL, rebuilt from the extracted id so every accepted
 * variant (youtu.be short link, /embed/, /shorts/, extra tracking query
 * params, an `si=` share token) lands in the table as one shape. Storing
 * whatever the operator pasted would leave the same video looking like four
 * different links and defeat any future de-duplication.
 *
 * Returns null when the input is not a YouTube URL — the caller turns that
 * into a 400 rather than silently storing an arbitrary link. The technician
 * app's player is the reason for the restriction: it plays a direct media
 * source, so an arbitrary page URL would fail at playback rather than at
 * save time, where nobody would see it.
 */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

function parseYouTubeUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  let id = null;

  if (host === 'youtu.be') {
    id = parsed.pathname.slice(1).split('/')[0];
  } else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (parsed.pathname === '/watch') {
      id = parsed.searchParams.get('v');
    } else {
      // /embed/<id>, /shorts/<id>, /live/<id> and /v/<id> all put the id first.
      const [, segment, candidate] = parsed.pathname.split('/');
      if (['embed', 'shorts', 'live', 'v'].includes(segment)) id = candidate;
    }
  }

  if (!id || !YOUTUBE_ID.test(id)) return null;
  return { id, url: `https://www.youtube.com/watch?v=${id}` };
}

/*
 * Make a stored link actually playable.
 *
 * Historic rows predate the YouTube-only rule and hold legacy files served
 * from the Dropwizard static host. Two things are wrong with them as stored:
 * the scheme is cleartext `http://` (blocked by Android's New Architecture,
 * and mixed-content-blocked by a browser on an https CRM), and some carry a
 * malformed host — `core.easyfix_core.in`, which does not resolve at all.
 * Both are repaired by anchoring on the `/easydoc` path and rebuilding.
 *
 * This lived inside routes/mobile/index.js, where only the technician app
 * benefited. The CRM now plays the same videos in its own preview, so it must
 * apply the same repair or the three legacy rows are unplayable there —
 * hence one shared implementation rather than a second copy that drifts.
 *
 * A YouTube link has no `/easydoc` segment and is already https, so it falls
 * through the last line unchanged.
 */
const TRAINING_VIDEO_HOST = 'https://core.easyfix.in';

function normalizeVideoUrl(raw) {
  if (!raw) return '';
  const value = String(raw).trim();
  const index = value.indexOf('/easydoc');
  if (index >= 0) return TRAINING_VIDEO_HOST + value.slice(index);
  return value.replace(/^http:\/\//i, 'https://');
}

/*
 * Point a training video at a YouTube link.
 *
 * Writes through the legacy `document` row rather than adding a url column to
 * training_videos, because the technician app and the legacy Java reader BOTH
 * already resolve the link that way. Reusing the existing path means the link
 * plumbing needs no change on either reader — only YouTube PLAYBACK itself
 * needs app work, since a watch URL is a page, not a media file.
 *
 * Updates the existing document in place when one is already linked, so
 * re-editing a link does not leave a trail of orphaned document rows.
 * Passing an empty url clears the association.
 */
async function setVideoLink(videoId, rawUrl, actorUserId = null) {
  const id = Number(videoId);
  const [[video]] = await pool.query(
    'SELECT id, training_video_id FROM training_videos WHERE id = ?',
    [id],
  );
  if (!video) throw mkErr(404, 'video not found');

  if (!String(rawUrl || '').trim()) {
    await pool.query('UPDATE training_videos SET training_video_id = NULL WHERE id = ?', [id]);
    logger.info('Training video link cleared · id=' + id);
    return { video_url: null };
  }

  const parsed = parseYouTubeUrl(rawUrl);
  if (!parsed) throw mkErr(400, 'video link must be a YouTube URL');

  const [[existingDoc]] = await pool.query(
    'SELECT id FROM document WHERE id = ? AND document_type_id = 2',
    [video.training_video_id || 0],
  );

  if (existingDoc) {
    await pool.query(
      'UPDATE document SET url = ?, updated_by = ?, updated_on = NOW() WHERE id = ?',
      [parsed.url, actorUserId, existingDoc.id],
    );
    logger.info('Training video link updated · id=' + id + ' · doc=' + existingDoc.id);
    return { video_url: parsed.url };
  }

  const [ins] = await pool.query(
    `INSERT INTO document (file_name, url, document_type_id, created_by, created_on)
     VALUES (?, ?, 2, ?, NOW())`,
    [`youtube:${parsed.id}`, parsed.url, actorUserId],
  );
  await pool.query('UPDATE training_videos SET training_video_id = ? WHERE id = ?', [ins.insertId, id]);
  logger.info('Training video link created · id=' + id + ' · doc=' + ins.insertId);
  return { video_url: parsed.url };
}

module.exports = {
  COMPLETION_PERCENT,
  parseYouTubeUrl,
  normalizeVideoUrl,
  setVideoLink,
  isKnownVideo,
  invalidateVideoIdCache,
  SORTABLE_COLUMNS,
  REPORT_SORTABLE_COLUMNS,
  listCourses,
  getCourseById,
  createCourse,
  updateCourse,
  retireCourse,
  getCourseVideos,
  setCourseVideos,
  listVideos,
  videoProgressCount,
  videoCourseCount,
  assignCourse,
  unassignCourse,
  listAssignments,
  trainingReport,
  isTrainingComplete,
};
