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
  technician:      't.technician_name',
  course:          't.course_name',
  completion_pct:  'completion_pct',
  score:           't.score',
  assigned_on:     't.assigned_on',
  due_date:        't.due_date',
  completion_date: 't.completion_date',
});

// ─────────────────────────────────────────────────────────────────────
// Courses
// ─────────────────────────────────────────────────────────────────────

async function listCourses({
  q, includeInactive = false, mandatoryOnly = false,
  limit = 200, offset = 0,
  sortBy = 'name', sortDir = 'asc',
} = {}) {
  limit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  offset = Math.max(Number(offset) || 0, 0);

  logger.info('List courses · q=' + (q || '') + ' · includeInactive=' + includeInactive
    + ' · mandatoryOnly=' + mandatoryOnly
    + ' · limit=' + limit + ' · offset=' + offset + ' · sortBy=' + sortBy + ' · sortDir=' + sortDir);

  const sortExpr = SORTABLE_COLUMNS[sortBy] || SORTABLE_COLUMNS.name;
  const dir = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  const where = ['1=1'];
  const params = [];
  if (!includeInactive) where.push('c.status = 1');
  /*
   * Answers "what is every technician held to?" — the one question the course
   * list could not answer, and the one whose wrong answer is expensive.
   * A plain WHERE rather than a sort key: is_mandatory is two values, so
   * sorting by it just groups the list, while filtering removes the noise.
   */
  if (mandatoryOnly) where.push('c.is_mandatory = 1');
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
    `SELECT c.id, c.name, c.description, c.status, c.is_mandatory, c.created_at, c.updated_at,
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
    `SELECT id, name, description, status, is_mandatory, created_at, updated_at
       FROM courses WHERE id = ?`,
    [Number(id)],
  );
  if (!rows.length) throw mkErr(404, 'course not found');
  return rows[0];
}

async function createCourse({ name, description, is_mandatory = false }) {
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
    'INSERT INTO courses (name, description, status, is_mandatory, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)',
    [String(name).trim(), description || null, is_mandatory ? 1 : 0, now, now],
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
  /*
   * Marking a course mandatory changes who its videos gate, for everyone.
   * Writing the flag does NOT assign the course to anyone — assignment is a
   * separate, explicit action (assignCourseToAll), so an operator flipping
   * this cannot silently create thousands of assignment rows by accident.
   */
  if (patch.is_mandatory !== undefined) {
    sets.push('is_mandatory = ?');
    params.push(patch.is_mandatory ? 1 : 0);
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
  /*
   * video_url joins through the same legacy `document` row that listVideos
   * uses — training_videos has no url column of its own. It is here so the
   * course content editor can PREVIEW each video: curating a syllabus is
   * exactly when someone needs to check that entry three is the video they
   * think it is, and without the link they would have to leave the dialog
   * and go find it in the catalogue.
   */
  const [rows] = await pool.query(
    `SELECT cv.id, cv.video_id, cv.sequence,
            tv.title, tv.sub_title, tv.description,
            d.url AS video_url
       FROM course_videos cv
       LEFT JOIN training_videos tv ON tv.id = cv.video_id
       LEFT JOIN document d ON d.id = tv.training_video_id AND d.document_type_id = 2
      WHERE cv.course_id = ?
      ORDER BY cv.sequence ASC, cv.id ASC`,
    [Number(courseId)],
  );
  // Same legacy scheme/host repair the catalogue and the app apply.
  return rows.map((r) => ({ ...r, video_url: normalizeVideoUrl(r.video_url) || null }));
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
/*
 * Today's IST calendar date as YYYY-MM-DD.
 *
 * Deadlines are calendar facts, not instants: "due in 30 days" means a date an
 * operator in Bengaluru would name, so the arithmetic starts from the IST day
 * rather than the server's UTC day. Between 18:30 and midnight UTC those two
 * differ, and using the wrong one silently shifts every deadline created in
 * the evening by a day.
 */
function istToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

/*
 * Derive the due date from an operator's "X months, Y days".
 *
 * MONTHS FIRST, CLAMPED, THEN DAYS. The order matters and so does the clamp:
 * naive month arithmetic turns 31 Jan + 1 month into 3 March, because
 * Date.setMonth overflows a day that does not exist in the target month.
 * Clamping to the last valid day makes it 28 (or 29) February, which is what
 * anyone means by "a month from the 31st".
 *
 * The day step then runs in UTC purely as safe integer date arithmetic — the
 * value never leaves YYYY-MM-DD form, so no timezone can shift it.
 *
 * The BACKEND is authoritative. The CRM previews the same date with the same
 * rules so the operator sees what they are about to commit to, but the stored
 * value is computed here — a client-supplied date would be a deadline the
 * server never agreed to, and clock skew on one laptop would set it wrong.
 */
function dueDateFrom(months = 0, days = 0, from = istToday()) {
  const totalMonths = Number(months) || 0;
  const totalDays = Number(days) || 0;
  if (totalMonths <= 0 && totalDays <= 0) return null;

  const [y, m, d] = String(from).split('-').map(Number);
  const monthIndex = (m - 1) + totalMonths;
  const year = y + Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12;
  // Day 0 of the NEXT month is the last day of this one.
  const lastDayOfTargetMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDayOfTargetMonth);

  const result = new Date(Date.UTC(year, month, day));
  result.setUTCDate(result.getUTCDate() + totalDays);
  return result.toISOString().slice(0, 10);
}

async function assignCourse(courseId, easyfixerIds = [], options = {}) {
  const id = Number(courseId);
  await getCourseById(id);

  /*
   * A course with no videos cannot be assigned.
   *
   * Assigning one is not a harmless no-op — it is actively harmful. The
   * technician sees the course listed, has nothing to watch, and their
   * completion is pinned at 0% forever; the LMS lifecycle wire then never
   * advances them out of TRAINING_PENDING, and with a due date attached they
   * would eventually be restricted to training-only for a course that cannot
   * be finished. Refusing here is the only point where that is cheap to stop.
   */
  const [[{ n: videoCount }]] = await pool.query(
    'SELECT COUNT(*) AS n FROM course_videos WHERE course_id = ?',
    [id],
  );
  if (Number(videoCount) === 0) {
    throw mkErr(409, 'this course has no videos — add content before assigning it');
  }

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
  const durationMonths = Math.max(0, Number(options.durationMonths) || 0);
  const durationDays = Math.max(0, Number(options.durationDays) || 0);
  const dueDate = dueDateFrom(durationMonths, durationDays);
  logger.info('Assign course · due=' + (dueDate ?? 'none')
    + ' (' + durationMonths + 'm ' + durationDays + 'd)');

  let assigned = 0;
  for (const efrId of ids) {
    /*
     * Re-assigning REFRESHES the deadline but preserves the outcome.
     *
     * due_date is re-stated because re-assigning is one way an operator resets
     * a deadline. score and completion_date are deliberately absent from the
     * update list: a technician who already finished this course did finish
     * it, and a re-assign must not erase that or reset their result.
     *
     * Only the derived DATE is stored — see extendAssignment for why the
     * duration itself deliberately is not.
     */
    const [r] = await pool.query(
      `INSERT INTO easyfixer_courses
         (easyfixer_id, course_id, created_at, updated_at, due_date)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         updated_at = VALUES(updated_at),
         due_date = VALUES(due_date)`,
      [efrId, id, now, now, dueDate],
    );
    // affectedRows is 1 for a fresh insert, 2 for an update of an existing row.
    if (r.affectedRows === 1) assigned += 1;
  }
  /*
   * Close the assignment-time completion gap immediately — see
   * stampCompletionsForCourse. Anyone who had already watched this course's
   * content is marked complete now, rather than being counted as pending,
   * then overdue, and finally blocked from working for training they had
   * already done.
   *
   * Best-effort: a failure here must not fail the assignment the operator
   * just made. The worst case is the pre-existing behaviour.
   */
  let alreadyComplete = 0;
  try {
    ({ stamped: alreadyComplete } = await stampCompletionsForCourse(id, ids));
  } catch (e) {
    logger.warn({ err: e.message, courseId: id },
      'Assignment-time completion stamp failed — assignment stands; some technicians may show as pending despite having finished the content');
  }

  logger.info('Course assigned · courseId=' + id + ' · new=' + assigned + ' · alreadyHeld=' + (ids.length - assigned)
    + ' · alreadyComplete=' + alreadyComplete);
  return {
    requested: ids.length,
    assigned,
    alreadyAssigned: ids.length - assigned,
    alreadyComplete,
    due_date: dueDate,
  };
}

/*
 * Stamp completion_date on every assigned course this technician has now
 * finished. Idempotent — the WHERE only touches rows still NULL — so it is
 * safe to call on every completing progress ping.
 *
 * "Finished" is the same rule the report uses: the course HAS content, and no
 * video in it sits below COMPLETION_PERCENT. The `EXISTS` clause is what keeps
 * an empty course from being stamped complete the moment it is assigned —
 * vacuously true otherwise, since a course with no videos has no video below
 * the threshold.
 */
async function stampCourseCompletions(efrId) {
  const [r] = await pool.query(
    `UPDATE easyfixer_courses ec
        SET ec.completion_date = ?, ec.updated_at = ?
      WHERE ec.easyfixer_id = ?
        AND ec.completion_date IS NULL
        AND EXISTS (SELECT 1 FROM course_videos cv WHERE cv.course_id = ec.course_id)
        AND NOT EXISTS (
              SELECT 1
                FROM course_videos cv
                LEFT JOIN easyfixer_watched_video w
                       ON w.video_id = cv.video_id AND w.easyfixer_id = ec.easyfixer_id
               WHERE cv.course_id = ec.course_id
                 AND COALESCE(w.watched_percentage, 0) < ?
            )`,
    [new Date(), new Date(), Number(efrId), COMPLETION_PERCENT],
  );
  if (r.affectedRows > 0) {
    logger.info('Training completion stamped · efrId=' + efrId + ' · courses=' + r.affectedRows);
  }
  return { stamped: r.affectedRows };
}

/*
 * Stamp completion for ONE course across MANY technicians, in one statement.
 *
 * WHY THIS EXISTS — a real defect, not an optimisation.
 *
 * stampCourseCompletions() was reachable from exactly one place: the mobile
 * progress ping (mobile-profile-extra.service.js). So a course assigned to a
 * technician who had ALREADY watched every video in it was never stamped —
 * completion_date stayed NULL until he happened to re-watch something and
 * ping again, which he has no reason to do.
 *
 * That is not cosmetic. hasOverdueTraining() reads completion_date and runs on
 * every authenticated mobile request; once the due date passed, the technician
 * was blocked from receiving jobs, continuing jobs and marking attendance —
 * for training he had already completed. On this dataset that is not
 * hypothetical: 2,439 technicians have watched all three induction videos to
 * 100%, so assigning the induction course to any of them armed exactly that
 * trap.
 *
 * Same predicate as stampCourseCompletions, same idempotence (only rows still
 * NULL are touched), narrowed to one course and the technicians just assigned.
 */
/*
 * `easyfixerIds = null` means EVERY assignee of the course.
 *
 * The array form guards against an unbounded UPDATE, which is right when the
 * caller knows exactly who it just assigned. assignCourseToAll does not — it
 * inserts with INSERT..SELECT and never learns the ids — and calling this with
 * no argument silently did nothing at all, because the empty-array guard
 * returned before the UPDATE. That left the assignment-time completion gap
 * this function exists to close open on the one path that assigns thousands of
 * people at once.
 *
 * The all-assignees form is still bounded: the UPDATE is scoped by course_id
 * and only touches rows where completion_date IS NULL, so it is idempotent and
 * re-running it is free.
 */
async function stampCompletionsForCourse(courseId, easyfixerIds = []) {
  const all = easyfixerIds === null;
  const ids = all ? [] : [...new Set(easyfixerIds.map(Number).filter(Number.isFinite))];
  if (!all && !ids.length) return { stamped: 0 };
  const now = new Date();
  const [r] = await pool.query(
    `UPDATE easyfixer_courses ec
        SET ec.completion_date = ?, ec.updated_at = ?
      WHERE ec.course_id = ?
        ${all ? '' : `AND ec.easyfixer_id IN (${ids.map(() => '?').join(',')})`}
        AND ec.completion_date IS NULL
        AND EXISTS (SELECT 1 FROM course_videos cv WHERE cv.course_id = ec.course_id)
        AND NOT EXISTS (
              SELECT 1
                FROM course_videos cv
                LEFT JOIN easyfixer_watched_video w
                       ON w.video_id = cv.video_id AND w.easyfixer_id = ec.easyfixer_id
               WHERE cv.course_id = ec.course_id
                 AND COALESCE(w.watched_percentage, 0) < ?
            )`,
    [now, now, Number(courseId), ...ids, COMPLETION_PERCENT],
  );
  if (r.affectedRows > 0) {
    logger.info('Assignment-time completion stamped · courseId=' + courseId
      + ' · alreadyComplete=' + r.affectedRows);
  }
  return { stamped: r.affectedRows };
}

/*
 * Everything this technician still owes, with its deadline. Feeds the app's
 * open-on-launch prompt, the daily reminder push, and the overdue restriction.
 *
 * `overdue` is computed against the IST calendar day, and a NULL due_date is
 * never overdue — an assignment without a deadline is a legitimate state and
 * must not silently restrict anyone's app.
 */
async function pendingTraining(efrId) {
  const today = istToday();
  const [rows] = await pool.query(
    `SELECT ec.course_id, c.name AS course_name, ec.due_date,
            (SELECT COUNT(*) FROM course_videos cv WHERE cv.course_id = ec.course_id) AS videos_total,
            (SELECT COUNT(*)
               FROM course_videos cv
               JOIN easyfixer_watched_video w
                 ON w.video_id = cv.video_id AND w.easyfixer_id = ec.easyfixer_id
              WHERE cv.course_id = ec.course_id
                AND COALESCE(w.watched_percentage, 0) >= ?) AS videos_done
       FROM easyfixer_courses ec
       JOIN courses c ON c.id = ec.course_id
      WHERE ec.easyfixer_id = ?
        AND ec.completion_date IS NULL
      ORDER BY (ec.due_date IS NULL), ec.due_date ASC`,
    [COMPLETION_PERCENT, Number(efrId)],
  );

  const courses = rows
    // A course with no content cannot be owed — nothing to watch.
    .filter((r) => Number(r.videos_total) > 0)
    .map((r) => ({
      course_id: r.course_id,
      course_name: r.course_name,
      due_date: r.due_date,
      videos_total: Number(r.videos_total),
      videos_done: Number(r.videos_done),
      overdue: Boolean(r.due_date && String(r.due_date).slice(0, 10) < today),
    }));

  return {
    courses,
    pending: courses.length,
    overdue: courses.filter((c) => c.overdue).length,
    today,
  };
}

/*
 * Is this technician locked out of everything except training?
 *
 * Deliberately a COUNT and nothing else: it runs on the mobile hot path (every
 * authenticated request resolves lifecycle capabilities), so it must not pull
 * rows or join the video tables. idx_efr_course_due covers it exactly.
 */
async function hasOverdueTraining(efrId) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n
       FROM easyfixer_courses
      WHERE easyfixer_id = ?
        AND completion_date IS NULL
        AND due_date IS NOT NULL
        AND due_date < ?`,
    [Number(efrId), istToday()],
  );
  return Number(row.n) > 0;
}

/*
 * Move an existing assignment's deadline — the CRM's "extend" action, and the
 * same operation as "correct a deadline". There is no separate correct-vs-
 * extend endpoint because there is no separate outcome: both set a new
 * due_date on a row that already exists.
 *
 * ─── Where the extension counts FROM ─────────────────────────────────────
 *
 * From `max(today, current due_date)`, which is the only rule that behaves
 * correctly in both directions:
 *
 *   already overdue (due < today)  → counts from TODAY, so "+7 days" really
 *     does give seven days and the technician is unblocked immediately.
 *     Counting from the lapsed date could land the new deadline still in the
 *     past, leaving them restricted by an action named "extend".
 *   not yet due (due >= today)     → counts from the EXISTING due date, so
 *     "+1 month" adds a month to the deadline. Counting from today here would
 *     SHORTEN a deadline that was three months out — an extension that
 *     silently takes time away.
 *
 * A row with no deadline counts from today; there is nothing to extend, so
 * this sets a first one.
 *
 * The duration is not persisted. It describes this one adjustment, not the
 * row: after two extensions a stored "1 month" would be true of neither the
 * original assignment nor the current deadline. due_date is the fact.
 */
async function extendAssignment(courseId, easyfixerId, { months = 0, days = 0 } = {}) {
  const [[row]] = await pool.query(
    `SELECT ec.due_date, ec.completion_date, c.name AS course_name
       FROM easyfixer_courses ec
       JOIN courses c ON c.id = ec.course_id
      WHERE ec.course_id = ? AND ec.easyfixer_id = ?`,
    [Number(courseId), Number(easyfixerId)],
  );
  if (!row) throw mkErr(404, 'assignment not found');

  const today = istToday();
  const current = row.due_date ? String(row.due_date).slice(0, 10) : null;
  const anchor = current && current > today ? current : today;

  const newDue = dueDateFrom(months, days, anchor);
  if (!newDue) throw mkErr(400, 'set a duration to extend by');

  await pool.query(
    'UPDATE easyfixer_courses SET due_date = ?, updated_at = ? WHERE course_id = ? AND easyfixer_id = ?',
    [newDue, new Date(), Number(courseId), Number(easyfixerId)],
  );
  logger.info('Assignment deadline moved · courseId=' + courseId + ' · efrId=' + easyfixerId
    + ' · ' + (current ?? 'none') + ' → ' + newDue);

  return {
    course_id: Number(courseId),
    easyfixer_id: Number(easyfixerId),
    previous_due_date: current,
    due_date: newDue,
    /* True when this actually lifted a restriction, so the CRM can say so. */
    unblocked: Boolean(current && current < today && !row.completion_date),
  };
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

/*
 * RBAC city scope, shared by listAssignments and trainingReport.
 *
 * Both are TECHNICIAN-grained, so the dimension is CITY (tbl_easyfixer
 * .efr_cityId) — never state. `scope.states` is already expanded to the
 * equivalent city list by buildRequestScopeWithHierarchy, so cities is the
 * only dimension either read has to consult.
 *
 * It mutates the caller's `where`/`params` in place rather than returning a
 * fragment, because BOTH functions build one WHERE string and then hand it to
 * a page query AND a COUNT query. A scope clause that reaches only one of the
 * two is worse than none: the rows would be filtered and the total would not,
 * so pagination would page over a set that does not exist. Applied FIRST, so
 * any explicit courseId/easyfixerId/q filter narrows within the allowed set.
 *
 * Copies the canonical shape from services/easyfixer.service.js::list.
 * `undefined` scope (bypass roles — Admin/Finance) adds nothing.
 */
function applyCityScope(where, params, scope) {
  if (!scope?.cities) return;
  const ci = scope.cities;
  if (ci.mode === 'none') where.push('1=0');
  else if (ci.mode === 'allow' && ci.ids.length) {
    where.push(`e.efr_cityId IN (${ci.ids.map(() => '?').join(',')})`);
    params.push(...ci.ids);
  }
}

async function listAssignments({ courseId, easyfixerId, q, scope, limit = 200, offset = 0 } = {}) {
  limit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  offset = Math.max(Number(offset) || 0, 0);

  const where = ['1=1'];
  const params = [];
  applyCityScope(where, params, scope);
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
            ec.due_date, ec.completion_date,
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
   *
   * It also reuses the SAME `whereSql` and the SAME `params` array, which is
   * what makes the city-scope clause land on both halves automatically — the
   * scope filter and the total can never describe different sets.
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
 *
 * City-scoped via applyCityScope: the report names technicians, so a
 * region-scoped user must not read another region's roster out of it.
 */
async function trainingReport({
  courseId, easyfixerId, q, status, scope,
  limit = 200, offset = 0,
  sortBy = 'technician', sortDir = 'asc',
} = {}) {
  limit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  offset = Math.max(Number(offset) || 0, 0);

  const sortExpr = REPORT_SORTABLE_COLUMNS[sortBy] || REPORT_SORTABLE_COLUMNS.technician;
  const dir = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  /*
   * `params` leads with COMPLETION_PERCENT because the derived table's SELECT
   * binds it (the videos_done subquery) BEFORE the WHERE binds anything.
   * Scope goes in first among the WHERE params so the placeholder order
   * matches the clause order in `where`.
   */
  const where = ['1=1'];
  const params = [COMPLETION_PERCENT];
  applyCityScope(where, params, scope);
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
           ec.due_date, ec.completion_date,
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
   *
   * The city-scope clause lives INSIDE that derived table (it is part of
   * `whereSql`, hence of `base`), so it is structurally impossible for the
   * page to be scoped and the total not to be.
   */
  const completeExpr = 't.videos_total > 0 AND t.videos_done >= t.videos_total';
  /*
   * 'overdue' judges the STAMPED completion, not the video maths.
   *
   * The two can legitimately disagree for a moment — a technician finishes the
   * last video and `videos_done >= videos_total` before the next progress ping
   * stamps completion_date — but the deadline is a contract about the recorded
   * fact, and completion_date is that fact. Judging overdue on the video count
   * would also mean a course whose CONTENT later grew retroactively made
   * someone overdue for training they had already been told they finished.
   *
   * A NULL due_date is never overdue: an assignment without a deadline is a
   * legitimate state and must not restrict anyone's app.
   */
  const overdueExpr = 't.completion_date IS NULL AND t.due_date IS NOT NULL AND t.due_date < ?';
  const statusParams = [];
  let statusCond = '1=1';
  if (status === 'complete') {
    statusCond = `(${completeExpr})`;
  } else if (status === 'incomplete') {
    statusCond = `NOT (${completeExpr})`;
  } else if (status === 'overdue') {
    statusCond = `(${overdueExpr})`;
    statusParams.push(istToday());
  }

  const derived = `(${select} ${base}) t`;

  const [rows] = await pool.query(
    `SELECT t.*,
            CASE WHEN t.videos_total = 0 THEN 0
                 ELSE ROUND(t.videos_done * 100 / t.videos_total, 1) END AS completion_pct
       FROM ${derived}
      WHERE ${statusCond}
      ORDER BY ${sortExpr} ${dir}, t.id ASC
      LIMIT ? OFFSET ?`,
    [...params, ...statusParams, limit, offset],
  );

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM ${derived} WHERE ${statusCond}`,
    [...params, ...statusParams],
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

/*
 * WHICH VIDEOS A TECHNICIAN MUST WATCH, AND WHICH THEY MAY SEE.
 *
 * `training_videos` holds two different things: the pre-LMS registration
 * catalogue (is_global = 1) and LMS course content owned by `course_videos`.
 * Nothing distinguished them until 2026-08-26, which is why adding one
 * YouTube video locked earning platform-wide and why the mobile list served
 * one technician's assigned course to everyone.
 *
 * MANDATORY = the global catalogue, plus every video of a course flagged
 * mandatory. This is the set the registration gate counts.
 *
 * VISIBLE = mandatory, plus the videos of courses assigned to THIS
 * technician. This is the set the mobile list may return.
 */
/*
 * Assign a course to every technician who can hold work.
 *
 * This is the action behind the CRM's "assign to existing technicians too?"
 * prompt. It is deliberately SEPARATE from writing is_mandatory: flipping a
 * flag should not silently create thousands of assignment rows, and an
 * operator who only wanted future registrations to get the course must be
 * able to have exactly that.
 *
 * INSERT ... SELECT with a NOT EXISTS guard rather than a read-then-write:
 * re-running it is a no-op, so the prompt is safe to answer "yes" to twice,
 * and an existing assignee keeps their due date, progress and score.
 */
async function assignCourseToAll(courseId, { dueDate = null } = {}) {
  const id = Number(courseId);
  await getCourseById(id);
  const now = new Date();
  const [res] = await pool.query(
    `INSERT INTO easyfixer_courses (easyfixer_id, course_id, created_at, updated_at, due_date)
     SELECT e.efr_id, ?, ?, ?, ?
       FROM tbl_easyfixer e
      WHERE e.efr_status = 1
        AND NOT EXISTS (
          SELECT 1 FROM easyfixer_courses ec
           WHERE ec.easyfixer_id = e.efr_id AND ec.course_id = ?)`,
    [id, now, now, dueDate, id],
  );
  /*
   * Same completion gap the single assignment closes: anyone who had already
   * watched this content is stamped complete now, rather than counted pending,
   * then overdue, and finally blocked from working for training they had done.
   * Best-effort — a failure here must not fail an assignment that succeeded.
   */
  let alreadyComplete = 0;
  try {
    // null = every assignee: this path never learns which ids it inserted.
    ({ stamped: alreadyComplete } = await stampCompletionsForCourse(id, null));
  } catch (e) {
    logger.warn({ err: e.message, courseId: id }, 'assignCourseToAll: completion stamp failed');
  }

  /*
   * Counted AFTER the insert, not before.
   *
   * `requested` is the pool this action considered — every active technician.
   * Counting afterwards keeps `assigned <= requested` true even if someone
   * registered mid-flight: the insert would have picked them up, and the count
   * then includes them. Counting first could report more assigned than
   * requested, which reads as a bug in a toast.
   *
   * Reported as the same shape assignCourse returns, so a caller does not have
   * to special-case which endpoint it called.
   */
  const [[pool_]] = await pool.query(
    'SELECT COUNT(*) AS n FROM tbl_easyfixer WHERE efr_status = 1',
  );
  const requested = Number(pool_?.n || 0);
  const assigned = res.affectedRows;
  logger.info('Course assigned to all · courseId=' + id + ' · new=' + assigned
    + ' · alreadyHeld=' + Math.max(0, requested - assigned)
    + ' · alreadyComplete=' + alreadyComplete);
  return {
    requested,
    assigned,
    alreadyAssigned: Math.max(0, requested - assigned),
    alreadyComplete,
    due_date: dueDate,
  };
}

/*
 * GATING FOLLOWS ASSIGNMENT, NOT THE FLAG.
 *
 * The first cut of this counted every mandatory course's videos for every
 * technician. That reproduced the outage it was written to fix, with a
 * checkbox in front of it: ticking Mandatory would raise `total` for all
 * ~2,600 technicians at once and lock earning until each of them watched a
 * course they had never been given.
 *
 * So `is_mandatory` means "assign this to technicians", and what a technician
 * must complete is what they actually HOLD. New registrations get mandatory
 * courses assigned as part of finishing registration; existing technicians get
 * them only when an operator answers the CRM's prompt. A course flagged
 * mandatory and assigned to nobody gates nobody, which is the safe direction
 * for a flag to fail in.
 *
 * `c.status = 1` matters: retiring a course must actually stop it gating.
 * Without it a retired-but-mandatory course keeps blocking work while being
 * hidden from the operator who retired it precisely to stop that.
 *
 * Takes one `?` — the technician's efr_id.
 */
const MANDATORY_VIDEO_IDS_SQL = `
  SELECT tv.id FROM training_videos tv WHERE tv.is_global = 1
   UNION
  SELECT cv.video_id FROM course_videos cv
    JOIN courses c ON c.id = cv.course_id
    JOIN easyfixer_courses ec ON ec.course_id = c.id
   WHERE c.is_mandatory = 1 AND c.status = 1 AND ec.easyfixer_id = ?`;

/*
 * What the technician may SEE: everything they must complete, plus the videos
 * of any course assigned to them (mandatory or not). Takes two `?` — the same
 * efr_id twice.
 */
const VISIBLE_VIDEO_IDS_SQL = `
  ${MANDATORY_VIDEO_IDS_SQL}
   UNION
  SELECT cv2.video_id FROM course_videos cv2
    JOIN easyfixer_courses ec2 ON ec2.course_id = cv2.course_id
   WHERE ec2.easyfixer_id = ?`;

/*
 * Give a technician every mandatory course they do not already hold.
 *
 * Called when registration completes, so a new technician is gated on the
 * mandatory catalogue as it stands on the day they join. Same INSERT..SELECT
 * NOT EXISTS shape as assignCourseToAll, so it is idempotent and never
 * disturbs an existing assignment.
 */
async function assignMandatoryCourses(efrId) {
  const id = Number(efrId);
  if (!id) return { assigned: 0 };
  const now = new Date();
  const [res] = await pool.query(
    `INSERT INTO easyfixer_courses (easyfixer_id, course_id, created_at, updated_at, due_date)
     SELECT ?, c.id, ?, ?, NULL
       FROM courses c
      WHERE c.is_mandatory = 1 AND c.status = 1
        AND NOT EXISTS (
          SELECT 1 FROM easyfixer_courses ec
           WHERE ec.easyfixer_id = ? AND ec.course_id = c.id)`,
    [id, now, now, id],
  );
  if (res.affectedRows) {
    logger.info('Mandatory courses assigned · efrId=' + id + ' count=' + res.affectedRows);
  }
  return { assigned: res.affectedRows };
}

module.exports = {
  MANDATORY_VIDEO_IDS_SQL,
  VISIBLE_VIDEO_IDS_SQL,
  assignCourseToAll,
  assignMandatoryCourses,
  COMPLETION_PERCENT,
  istToday,
  dueDateFrom,
  stampCourseCompletions,
  stampCompletionsForCourse,
  pendingTraining,
  hasOverdueTraining,
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
  extendAssignment,
  unassignCourse,
  listAssignments,
  trainingReport,
  isTrainingComplete,
};
