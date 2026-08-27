const { pool } = require('../db');
const logger = require('../logger');
const s3 = require('../utils/s3-storage');

/*
 * LMS — courses, course content, assignment and completion reporting.
 *
 * ─── The data model, and why it is split across two engines ──────────────
 *
 *   courses            InnoDB   the course itself (id, name, description, status)
 *   lms_content        InnoDB   the ORDERED CONTENT LIST — one row per item,
 *                               (course_id, kind, ref_id, sequence). Replaced
 *                               course_videos on 2026-08-26.
 *   lms_document       InnoDB   a PPT/PDF item (title + S3 file_key)
 *   lms_assessment     InnoDB   an MCQ item, with lms_question / lms_question_option
 *   lms_assessment_attempt
 *                      InnoDB   one row per attempt, never overwritten
 *   lms_document_ack   InnoDB   "I have read this" per (technician, CONTENT row)
 *   course_videos      InnoDB   LEGACY. Backfilled into lms_content and no longer
 *                               read or written anywhere. Left in place by the
 *                               migration as a rollback surface only.
 *   easyfixer_courses  InnoDB   which technician is assigned which course (+ score)
 *   training_videos    MyISAM   the video catalogue (legacy Java table)
 *   easyfixer_watched_video
 *                      MyISAM   per-technician, per-video watched_percentage
 *
 * The InnoDB half enforces its own referential integrity — lms_content and
 * easyfixer_courses both carry real keys, so a deleted course cannot
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
 * progress read in one; the only transactional blocks are setCourseContent and
 * setAssessmentQuestions, which touch InnoDB exclusively.
 */

function mkErr(status, message) { const e = new Error(message); e.status = status; return e; }

/*
 * ─── COLUMN PROBES: THE TWO FLAGS THAT ARRIVE BY ALTER ───────────────
 *
 * `courses.is_mandatory` and `training_videos.is_global` are added by
 * migrations/executed/2026-08-26-lms-mandatory-flags.sql. Everything else this
 * file reads arrives with its table, so a missing table is caught at boot by
 * scripts/schema-verify.js and the server refuses to start — the loud,
 * recoverable failure that file argues for, and the right severity for
 * lms_content, which gates earning.
 *
 * These two are different in kind. They are ALTERs on tables that already
 * exist and are already being read, so their absence does not stop the server
 * booting or the table resolving: it 500s exactly the requests whose SQL names
 * them. That is a real deploy on 2026-08-26 — the course list shipped ahead of
 * its migration and named c.is_mandatory in an unconditional SELECT, so the
 * Content page did not degrade, it errored.
 *
 * So the flags are probed and the SQL is built around the answer. A missing
 * flag reads as 0 everywhere: no course is mandatory, no video is global,
 * nothing gates, and every page still renders.
 *
 * ON PROBE FAILURE, ASSUME PRESENT. The opposite default (plivo-call-log's
 * hasRecordingRequestedColumn, which assumes false) is right there because a
 * false answer only skips writing an optional flag. Here a false answer
 * switches off mandatory training for everyone, so a transient
 * information_schema hiccup must not be able to do it. Absent is only ever
 * concluded from a query that actually came back and said so.
 *
 * PRIMED AT BOOT (server.js), so no REQUEST pays for it: services/
 * mobile-registration.service.js#getStatus runs to a bounded three-query budget
 * that tests/mobile-registration-status-overdue.test.js pins, and the
 * technician's status call is not the place to discover the schema.
 *
 * TTL, not resolve-once: the migration is expected to land WHILE the process
 * is running. A permanent negative would keep mandatory training off until
 * someone restarted the container, turning a five-minute lag into an outage
 * nobody thinks to look for. Positives are cached long because they never go
 * back; negatives are re-checked in a minute.
 */
const SCHEMA_POSITIVE_TTL_MS = 60 * 60 * 1000;
const SCHEMA_NEGATIVE_TTL_MS = 60 * 1000;

const LMS_FLAG_COLUMNS = Object.freeze([
  ['courses', 'is_mandatory'],
  ['training_videos', 'is_global'],
]);

let _flagCache = null;

async function lmsFlagColumns() {
  const now = Date.now();
  if (_flagCache) {
    const ttl = _flagCache.stable ? SCHEMA_POSITIVE_TTL_MS : SCHEMA_NEGATIVE_TTL_MS;
    if (now - _flagCache.checkedAt < ttl) return _flagCache.value;
  }

  // One round trip for both, not one per column: this sits in front of the
  // course list and the technician's training screen.
  const value = { courseMandatory: true, videoGlobal: true };
  try {
    const [rows] = await pool.query(
      `SELECT table_name AS t, column_name AS c
         FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND (${LMS_FLAG_COLUMNS.map(() => '(table_name = ? AND column_name = ?)').join(' OR ')})`,
      LMS_FLAG_COLUMNS.flat(),
    );
    // Column names come back upper- or lower-cased depending on the server's
    // lower_case_table_names / version, so match case-insensitively rather
    // than trusting the alias.
    const present = new Set(rows.map((r) => `${r.t}.${r.c}`.toLowerCase()));
    value.courseMandatory = present.has('courses.is_mandatory');
    value.videoGlobal = present.has('training_videos.is_global');
    const missing = LMS_FLAG_COLUMNS
      .filter(([t, c]) => !present.has(`${t}.${c}`))
      .map(([t, c]) => `${t}.${c}`);
    if (missing.length) {
      logger.warn('LMS schema probe · missing ' + missing.join(', ')
        + ' — treating the flag as 0 (run 2026-08-26-lms-mandatory-flags.sql)');
    }
    _flagCache = { value, checkedAt: now, stable: !missing.length };
  } catch (e) {
    /*
     * See above: a failed probe is not evidence of absence, so the VALUE stays
     * optimistic. The TTL does not — caching a guess for an hour would let one
     * hiccup at boot decide the schema until the next restart. Short TTL, so
     * the guess is re-tested a minute later.
     */
    logger.warn('LMS schema probe failed · ' + e.message + ' — assuming columns present');
    _flagCache = { value, checkedAt: now, stable: false };
  }
  return _flagCache.value;
}

// Tests and the QA refresh drop/rebuild tables under a live process.
function invalidateLmsSchemaCache() { _flagCache = null; }

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
 * ─── "IS THIS ITEM DONE?" — ONE DEFINITION, EVERY CALLER ─────────────
 *
 * A course is no longer a list of videos, so "complete" is no longer one
 * comparison. Each kind proves completion its own way:
 *
 *   video      easyfixer_watched_video.watched_percentage = COMPLETION_PERCENT
 *   assessment a PASSING row in lms_assessment_attempt
 *   document   a row in lms_document_ack for THIS CONTENT row
 *
 * Nothing stores a second copy of any of those — the legacy Java service also
 * writes easyfixer_watched_video, and a mirrored per-item progress table would
 * be a second truth that drifts from it.
 *
 * WHY ONE SHARED EXPRESSION AND NOT A PREDICATE PER CALL SITE. Six reads judge
 * completion — the two completion stamps, the pending list, the report, the
 * lifecycle probe and the mobile course list — and they gate EARNING: a
 * technician whose training reads incomplete stops receiving work, and one
 * that reads complete when it is not advances them out of TRAINING_PENDING
 * untrained. Two of those six disagreeing is exactly the outage class this
 * file already carries scar tissue for, so there is one expression and every
 * read composes it.
 *
 * `efr` is an SQL EXPRESSION, not a bound value — every caller already joins
 * easyfixer_courses and passes the column `ec.easyfixer_id`, so this
 * contributes ZERO placeholders. That is deliberate: the report and the stamps
 * build their parameter arrays positionally, and a fragment that silently
 * consumed a `?` would put every later parameter one slot out.
 *
 * COMPLETION_PERCENT is interpolated for the same reason. It is a module
 * constant with the value 100, never user input, and inlining it keeps this
 * fragment parameter-free.
 *
 * Yields 1 or 0, so it SUMs as a count and negates as a boolean.
 */
function itemCompleteSql(efr) {
  return `CASE lc.kind
            WHEN 'video' THEN COALESCE((SELECT MAX(w.watched_percentage)
                                          FROM easyfixer_watched_video w
                                         WHERE w.video_id = lc.ref_id
                                           AND w.easyfixer_id = ${efr}), 0) >= ${COMPLETION_PERCENT}
            WHEN 'assessment' THEN EXISTS (SELECT 1 FROM lms_assessment_attempt aa
                                            WHERE aa.assessment_id = lc.ref_id
                                              AND aa.easyfixer_id = ${efr}
                                              AND aa.passed = 1)
            WHEN 'document' THEN EXISTS (SELECT 1 FROM lms_document_ack da
                                          WHERE da.content_id = lc.id
                                            AND da.easyfixer_id = ${efr})
            ELSE 0
          END`;
}

/*
 * The course, from the perspective of a row of easyfixer_courses aliased `ec`.
 *
 * HAS_CONTENT is what stops an EMPTY course being vacuously complete: "no item
 * of this course is unfinished" is trivially true when it has no items, and
 * without this guard assigning a half-built course would stamp everyone
 * complete the moment it was assigned.
 *
 * Retired items (status = 0) are excluded from both. Removing an item from a
 * course must actually stop it gating — a retired item nobody can see would
 * otherwise hold a technician at "incomplete" with no action available to them.
 */
const COURSE_HAS_CONTENT = `EXISTS (
  SELECT 1 FROM lms_content lc WHERE lc.course_id = ec.course_id AND lc.status = 1)`;

const COURSE_HAS_UNFINISHED_ITEM = `EXISTS (
  SELECT 1 FROM lms_content lc
   WHERE lc.course_id = ec.course_id AND lc.status = 1
     AND NOT (${itemCompleteSql('ec.easyfixer_id')}))`;

// How many items a course holds / how many this technician has finished.
// Correlated on `ec`, so both are usable anywhere easyfixer_courses is joined.
const COURSE_ITEMS_TOTAL = `(
  SELECT COUNT(*) FROM lms_content lc WHERE lc.course_id = ec.course_id AND lc.status = 1)`;

const COURSE_ITEMS_DONE = `(
  SELECT COALESCE(SUM(${itemCompleteSql('ec.easyfixer_id')}), 0)
    FROM lms_content lc WHERE lc.course_id = ec.course_id AND lc.status = 1)`;

const CONTENT_KINDS = Object.freeze(['video', 'document', 'assessment']);

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
  const { courseMandatory } = await lmsFlagColumns();
  // No column means no course is mandatory, so the filter must return nothing
  // rather than everything — `1=0`, not a dropped clause.
  if (mandatoryOnly) where.push(courseMandatory ? 'c.is_mandatory = 1' : '1=0');
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
   *
   * `video_count` now counts CONTENT ITEMS of every kind. The alias is kept
   * because it is the CRM's column key and its sort key (SORTABLE_COLUMNS);
   * renaming it would break the list page for a cosmetic gain, and the page
   * itself is now called Content.
   */
  const [rows] = await pool.query(
    `SELECT c.id, c.name, c.description, c.status,
            ${courseMandatory ? 'c.is_mandatory' : '0 AS is_mandatory'},
            c.created_at, c.updated_at,
            (SELECT COUNT(*) FROM lms_content lc WHERE lc.course_id = c.id AND lc.status = 1) AS video_count,
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
  const { courseMandatory } = await lmsFlagColumns();
  const [rows] = await pool.query(
    `SELECT id, name, description, status,
            ${courseMandatory ? 'is_mandatory' : '0 AS is_mandatory'},
            created_at, updated_at
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
  /*
   * Column and value are dropped TOGETHER. Naming a column that is not there
   * fails the whole INSERT, so pre-migration a course is still creatable — it
   * just cannot be marked mandatory, which is the flag's own default anyway.
   */
  const { courseMandatory } = await lmsFlagColumns();
  const [ins] = await pool.query(
    `INSERT INTO courses (name, description, status,
                          ${courseMandatory ? 'is_mandatory,' : ''} created_at, updated_at)
     VALUES (?, ?, 1, ${courseMandatory ? '?,' : ''} ?, ?)`,
    courseMandatory
      ? [String(name).trim(), description || null, is_mandatory ? 1 : 0, now, now]
      : [String(name).trim(), description || null, now, now],
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
  if (patch.is_mandatory !== undefined && (await lmsFlagColumns()).courseMandatory) {
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

/*
 * A course's ordered content, every kind, with just enough of each item's own
 * row to render and preview it in the CRM's content editor.
 *
 * The three kind tables are LEFT JOINed with the kind test in the ON clause
 * rather than queried per row: a course holds single digits of items, and one
 * statement that returns them in order beats N+1 lookups whose interleaving
 * the caller would then have to rebuild.
 *
 * video_url joins through the same legacy `document` row that listVideos uses
 * — training_videos has no url column of its own. It is here so the editor can
 * PREVIEW each video: curating a syllabus is exactly when someone needs to
 * check that entry three is the video they think it is.
 */
async function getCourseContent(courseId) {
  const [rows] = await pool.query(
    `SELECT lc.id, lc.kind, lc.ref_id, lc.sequence,
            tv.title AS video_title, tv.sub_title, tv.description,
            d.url AS video_url,
            doc.title AS document_title, doc.file_key, doc.mime_type, doc.page_count,
            a.title AS assessment_title, a.pass_percent, a.max_attempts,
            -- Guarded on kind, not just filtered on the way out: ref_id is a
            -- VIDEO id on a video row, and an unguarded count would happily
            -- report the questions of the assessment that happens to share it.
            (CASE WHEN lc.kind = 'assessment' THEN
              (SELECT COUNT(*) FROM lms_question q
                WHERE q.assessment_id = lc.ref_id AND q.status = 1) END) AS question_count
       FROM lms_content lc
       LEFT JOIN training_videos tv ON lc.kind = 'video' AND tv.id = lc.ref_id
       LEFT JOIN document d ON d.id = tv.training_video_id AND d.document_type_id = 2
       LEFT JOIN lms_document doc ON lc.kind = 'document' AND doc.id = lc.ref_id
       LEFT JOIN lms_assessment a ON lc.kind = 'assessment' AND a.id = lc.ref_id
      WHERE lc.course_id = ? AND lc.status = 1
      ORDER BY lc.sequence ASC, lc.id ASC`,
    [Number(courseId)],
  );

  return Promise.all(rows.map(async (r) => {
    const base = { id: r.id, kind: r.kind, ref_id: r.ref_id, sequence: r.sequence };
    if (r.kind === 'video') {
      return {
        ...base,
        title: r.video_title,
        sub_title: r.sub_title,
        description: r.description,
        // Same legacy scheme/host repair the catalogue and the app apply.
        video_url: normalizeVideoUrl(r.video_url) || null,
      };
    }
    if (r.kind === 'document') {
      return {
        ...base,
        title: r.document_title,
        mime_type: r.mime_type,
        page_count: r.page_count,
        url: await documentUrl(r.file_key),
      };
    }
    return {
      ...base,
      title: r.assessment_title,
      pass_percent: r.pass_percent,
      max_attempts: r.max_attempts,
      question_count: Number(r.question_count) || 0,
    };
  }));
}

/*
 * Every id in `items` must name a row that exists, per kind.
 *
 * For videos this is not belt-and-braces: lms_content cannot foreign-key to
 * training_videos because it is MyISAM, and MySQL parses the constraint and
 * silently ignores it — see the header note. Documents and assessments are
 * InnoDB and could carry a real FK, but they are checked here anyway so the
 * operator gets one 400 naming the bad id instead of a driver error naming a
 * constraint.
 */
async function assertRefsExist(items) {
  const checks = [
    ['video', 'training_videos', 'id', null],
    ['document', 'lms_document', 'id', 'status = 1'],
    ['assessment', 'lms_assessment', 'id', 'status = 1'],
  ];
  for (const [kind, table, idCol, extra] of checks) {
    const ids = [...new Set(items.filter((i) => i.kind === kind).map((i) => Number(i.ref_id)))];
    if (!ids.length) continue;
    const [found] = await pool.query(
      `SELECT ${idCol} AS id FROM ${table}
        WHERE ${idCol} IN (${ids.map(() => '?').join(',')})${extra ? ` AND ${extra}` : ''}`,
      ids,
    );
    const known = new Set(found.map((r) => Number(r.id)));
    const missing = ids.filter((v) => !known.has(v));
    if (missing.length) {
      // Kept verbatim for videos — the CRM matches on this message today.
      if (kind === 'video') throw mkErr(400, `unknown training video id(s): ${missing.join(', ')}`);
      throw mkErr(400, `unknown ${kind} id(s): ${missing.join(', ')}`);
    }
  }

  /*
   * AN ASSESSMENT WITH NO QUESTIONS IS NOT CONTENT.
   *
   * createAssessment makes the row before the paper is written, so a
   * question-less assessment is a normal intermediate state — but attaching
   * one to a course is exactly the trap assignCourse already refuses for an
   * empty course. submitAssessment 409s on a paper with no questions, so it
   * can never be passed; itemCompleteSql needs a PASSING attempt, so the
   * course never completes; and the overdue restriction eventually withdraws
   * work for training the technician had no way to finish.
   *
   * Checked here rather than in setCourseContent so the video-only save path
   * (setCourseVideos, which re-submits the course's existing items) is covered
   * by the same guard.
   */
  const assessmentIds = [...new Set(items.filter((i) => i.kind === 'assessment').map((i) => Number(i.ref_id)))];
  if (assessmentIds.length) {
    const [empty] = await pool.query(
      `SELECT a.id FROM lms_assessment a
        WHERE a.id IN (${assessmentIds.map(() => '?').join(',')})
          AND NOT EXISTS (SELECT 1 FROM lms_question q
                           WHERE q.assessment_id = a.id AND q.status = 1)`,
      assessmentIds,
    );
    if (empty.length) {
      const ids = empty.map((r) => Number(r.id)).join(', ');
      throw mkErr(400, `assessment id(s) ${ids} have no questions — add the questions before putting them in a course`);
    }
  }
}

/*
 * Replace a course's content with exactly `items`, in the order given.
 *
 * UPSERT-THEN-RETIRE, NOT DELETE-THEN-INSERT. The old video-only version
 * deleted every row and reinserted, which was harmless when the row held
 * nothing but a position. It is not harmless now: lms_document_ack is keyed on
 * the CONTENT row id, so deleting and reinserting a document item would issue
 * it a NEW id and orphan every technician's acknowledgement — silently moving
 * them from complete back to incomplete, on a course they had finished, with
 * the overdue restriction waiting behind it. The unique key
 * uq_lms_content_item (course_id, kind, ref_id) makes the upsert land on the
 * same row, so an item that survives a re-order keeps its id and its acks.
 *
 * Items dropped from the list are RETIRED (status = 0) rather than deleted,
 * for the same reason: re-adding one later restores the acknowledgements that
 * were true when it was made, instead of asking everyone to read it again.
 *
 * The whole thing is one transaction. Every table touched is InnoDB.
 */
async function setCourseContent(courseId, items = []) {
  const id = Number(courseId);
  await getCourseById(id);

  /*
   * De-duplicated on (kind, ref_id): the unique key would reject the second
   * copy mid-transaction anyway, and the honest reading of "this course
   * contains video 4 twice" is that it contains it once.
   */
  const seen = new Set();
  const list = [];
  for (const raw of items) {
    const kind = String(raw?.kind || '');
    const refId = Number(raw?.ref_id);
    if (!CONTENT_KINDS.includes(kind)) throw mkErr(400, `unknown content kind: ${kind}`);
    if (!Number.isInteger(refId) || refId <= 0) throw mkErr(400, 'content ref_id must be a positive integer');
    const key = `${kind}:${refId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ kind, ref_id: refId });
  }

  logger.info('Set course content · courseId=' + id + ' · items=' + list.length
    + ' · kinds=' + CONTENT_KINDS.map((k) => k + '=' + list.filter((i) => i.kind === k).length).join(','));

  await assertRefsExist(list);

  const now = new Date();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const keptIds = [];
    for (const [index, item] of list.entries()) {
      const [r] = await conn.query(
        `INSERT INTO lms_content (course_id, kind, ref_id, sequence, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)
         ON DUPLICATE KEY UPDATE
           sequence = VALUES(sequence), status = 1, updated_at = VALUES(updated_at), id = LAST_INSERT_ID(id)`,
        [id, item.kind, item.ref_id, index + 1, now, now],
      );
      // insertId is the existing row's id on the duplicate branch, because the
      // upsert re-states it through LAST_INSERT_ID() — without that MySQL
      // reports 0 for an update and the retire step below would drop the row
      // that was just kept.
      keptIds.push(r.insertId);
    }
    await conn.query(
      `UPDATE lms_content SET status = 0, updated_at = ?
        WHERE course_id = ? AND status = 1
          ${keptIds.length ? `AND id NOT IN (${keptIds.map(() => '?').join(',')})` : ''}`,
      [now, id, ...keptIds],
    );
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  logger.info('Course content saved · courseId=' + id);
  return getCourseContent(id);
}

async function getCourseVideos(courseId) {
  const items = await getCourseContent(courseId);
  // The legacy shape the CRM's video picker still reads: `video_id`, not
  // `ref_id`. Kept as a projection over the same rows rather than a second
  // query, so the two endpoints can never disagree about what a course holds.
  return items
    .filter((i) => i.kind === 'video')
    .map((i) => ({
      id: i.id,
      video_id: i.ref_id,
      sequence: i.sequence,
      title: i.title,
      sub_title: i.sub_title,
      description: i.description,
      video_url: i.video_url,
    }));
}

/*
 * The video-only editor's save, expressed over the full content list.
 *
 * PUT /courses/:id/videos carries only videos, so it cannot express where a
 * document or an assessment sits relative to them. Rather than inventing an
 * answer, the submitted videos take the head positions and every other kind
 * keeps its existing relative order behind them — nothing is dropped, which is
 * the property that matters, and the full-content endpoint is where
 * interleaving is actually decided.
 */
async function setCourseVideos(courseId, videoIds = []) {
  const id = Number(courseId);
  const ids = [...new Set(videoIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const [rest] = await pool.query(
    `SELECT kind, ref_id FROM lms_content
      WHERE course_id = ? AND status = 1 AND kind <> 'video'
      ORDER BY sequence ASC, id ASC`,
    [id],
  );
  await setCourseContent(id, [...ids.map((v) => ({ kind: 'video', ref_id: v })), ...rest]);
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
    "SELECT COUNT(*) AS n FROM lms_content WHERE kind = 'video' AND ref_id = ? AND status = 1",
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
            (SELECT COUNT(*) FROM lms_content lc
              WHERE lc.kind = 'video' AND lc.ref_id = tv.id AND lc.status = 1) AS course_count
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
   * A course with no content cannot be assigned.
   *
   * Assigning one is not a harmless no-op — it is actively harmful. The
   * technician sees the course listed, has nothing to do, and their completion
   * is pinned at 0% forever; the LMS lifecycle wire then never advances them
   * out of TRAINING_PENDING, and with a due date attached they would
   * eventually be restricted to training-only for a course that cannot be
   * finished. Refusing here is the only point where that is cheap to stop.
   *
   * Counts ITEMS, not videos: a course made of a PPT and an assessment is
   * perfectly assignable, and the old video-only count would have refused it.
   */
  const [[{ n: itemCount }]] = await pool.query(
    'SELECT COUNT(*) AS n FROM lms_content WHERE course_id = ? AND status = 1',
    [id],
  );
  if (Number(itemCount) === 0) {
    throw mkErr(409, 'this course has no content — add content before assigning it');
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
 * item of it is unfinished — judged per kind by itemCompleteSql, so a course
 * whose last item is an assessment stamps on the passing attempt, not on the
 * last video. The `EXISTS` clause is what keeps an empty course from being
 * stamped complete the moment it is assigned — vacuously true otherwise, since
 * a course with no items has no unfinished item.
 */
async function stampCourseCompletions(efrId) {
  const [r] = await pool.query(
    `UPDATE easyfixer_courses ec
        SET ec.completion_date = ?, ec.updated_at = ?
      WHERE ec.easyfixer_id = ?
        AND ec.completion_date IS NULL
        AND ${COURSE_HAS_CONTENT}
        AND NOT ${COURSE_HAS_UNFINISHED_ITEM}`,
    [new Date(), new Date(), Number(efrId)],
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
        AND ${COURSE_HAS_CONTENT}
        AND NOT ${COURSE_HAS_UNFINISHED_ITEM}`,
    [now, now, Number(courseId), ...ids],
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
  /*
   * videos_total / videos_done are now ITEM counts of every kind. The aliases
   * are kept because the technician app reads them by name and an installed
   * binary cannot be renamed alongside the server — the numbers still mean
   * "how much of this course is left", which is all the banner renders.
   */
  const [rows] = await pool.query(
    `SELECT ec.course_id, c.name AS course_name, ec.due_date,
            ${COURSE_ITEMS_TOTAL} AS videos_total,
            ${COURSE_ITEMS_DONE} AS videos_done
       FROM easyfixer_courses ec
       JOIN courses c ON c.id = ec.course_id
      WHERE ec.easyfixer_id = ?
        AND ec.completion_date IS NULL
      ORDER BY (ec.due_date IS NULL), ec.due_date ASC`,
    [Number(efrId)],
  );

  const courses = rows
    // A course with no content cannot be owed — nothing to do.
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
   * `params` no longer leads with COMPLETION_PERCENT: the completion rule is
   * a parameter-free SQL fragment (see itemCompleteSql), so the WHERE clause's
   * placeholders are the only ones and their order is simply clause order.
   * Scope goes in first so it matches the order of `where`.
   */
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
           ${COURSE_ITEMS_TOTAL} AS videos_total,
           ${COURSE_ITEMS_DONE} AS videos_done`;

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
 *   - a course with no content     → NOT complete, for the same reason.
 *   - otherwise                    → every ITEM of every assigned course must
 *     be complete, judged per kind: videos at COMPLETION_PERCENT, assessments
 *     passed, documents acknowledged. A course whose final item is an
 *     assessment is not finished by watching its videos.
 *
 * `required` and `done` count ITEMS, not videos, and the JOIN is the inner one
 * it always was — a course with no active content contributes no rows, so it
 * cannot make `required` non-zero and cannot be vacuously satisfied either.
 */
async function isTrainingComplete(efrId) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS required,
            SUM(${itemCompleteSql('ec.easyfixer_id')}) AS done
       FROM easyfixer_courses ec
       JOIN lms_content lc ON lc.course_id = ec.course_id AND lc.status = 1
      WHERE ec.easyfixer_id = ?`,
    [Number(efrId)],
  );
  const required = Number(row.required) || 0;
  const done = Number(row.done) || 0;
  return { complete: required > 0 && done >= required, required, done };
}

/*
 * ─── FINISHING AN ITEM: THE THREE STEPS, IN ONE PLACE ────────────────
 *
 * Every way a technician can finish a piece of content ends here — the 100%
 * video ping, a passing assessment attempt, and a document acknowledgement.
 * All three must do the SAME three things, in this order:
 *
 *   1. stamp per-COURSE completion   (finer grained; the report and the
 *                                     overdue restriction read completion_date)
 *   2. ask whether ALL training is now complete
 *   3. if it is, advance the lifecycle out of TRAINING_PENDING
 *
 * WHY THIS IS A FUNCTION AND NOT THREE CALLS AT THREE CALL SITES. It already
 * was three call sites, and one of them (ackDocument) only did step 1 — so a
 * technician whose LAST outstanding item was a PPT had his course stamped
 * complete and then sat in TRAINING_PENDING forever, because nothing asked
 * step 2. The kind of content someone happens to finish last must not decide
 * whether they are advanced.
 *
 * Idempotent throughout: the stamp only touches rows still NULL, and
 * finalizeTrainingCompletion resolves any non-TRAINING_PENDING status to
 * itself, which the lifecycle service turns into a protected no-op.
 *
 * THROWS. Callers decide how loud a failure is — each of the three is a
 * best-effort tail on work that is already committed, so all three swallow it
 * into a warning rather than turning a saved pass into a 500 the app retries.
 */
async function settleTrainingCompletion(efrId) {
  const efr = Number(efrId);
  await stampCourseCompletions(efr);
  const { complete, required, done } = await isTrainingComplete(efr);
  if (!complete) {
    logger.info('Training not yet complete · efrId=' + efr + ' · ' + done + '/' + required);
    return { complete: false, required, done, changed: false };
  }
  // Lazily required: easyfixer-lifecycle.service requires THIS module at its
  // top level, so a top-level require here would be a cycle.
  const result = await require('./easyfixer-lifecycle.service').finalizeTrainingCompletion(efr);
  if (result.changed) {
    logger.info('Training complete → lifecycle advanced · efrId=' + efr
      + ' · from=' + result.transitionedFrom);
  }
  return { complete: true, required, done, changed: !!result.changed };
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
 * catalogue (is_global = 1) and LMS course content owned by `lms_content`.
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
/*
 * A FUNCTION, not the constant this used to be, because both halves rest on a
 * probed column and the answer is only known after a query.
 *
 * THE ARITY IS PART OF THE CONTRACT. Callers bind positionally — the mobile
 * training screen passes the technician twice, the registration gate three
 * times — so a missing column may never remove a `?`. Both flags therefore
 * degrade by swapping the PREDICATE to `1=0`, which keeps each arm (and its
 * placeholder) exactly where it was and simply returns no rows from it. The
 * same rule itemCompleteSql states just above: a fragment that changes its
 * placeholder count puts every later parameter one slot out.
 *
 * Pre-migration the whole set is therefore EMPTY, and empty is already a case
 * every caller handles: services/mobile-registration.service.js treats a zero
 * mandatory set as NOT complete and says so loudly, which is the safe
 * direction — nobody is advanced out of training by a missing column.
 */
async function mandatoryVideoIdsSql() {
  const { courseMandatory, videoGlobal } = await lmsFlagColumns();
  return `
  SELECT tv.id FROM training_videos tv WHERE ${videoGlobal ? 'tv.is_global = 1' : '1=0'}
   UNION
  SELECT lc.ref_id FROM lms_content lc
    JOIN courses c ON c.id = lc.course_id
    JOIN easyfixer_courses ec ON ec.course_id = c.id
   WHERE lc.kind = 'video' AND lc.status = 1
     AND ${courseMandatory ? 'c.is_mandatory = 1' : '1=0'} AND c.status = 1 AND ec.easyfixer_id = ?`;
}

/*
 * What the technician may SEE: everything they must complete, plus the videos
 * of any course assigned to them (mandatory or not). Takes two `?` — the same
 * efr_id twice.
 *
 * BOTH halves stay VIDEO-ONLY (`kind = 'video'`). These feed
 * /api/mobile/training-videos, which returns rows of training_videos — a
 * document or an assessment has no row there and no id in that space, so
 * widening the filter would emit ids that resolve to the wrong video or to
 * nothing. The other kinds reach the app through /api/mobile/lms/courses,
 * which is content-aware.
 */
async function visibleVideoIdsSql() {
  return `
  ${await mandatoryVideoIdsSql()}
   UNION
  SELECT lc2.ref_id FROM lms_content lc2
    JOIN easyfixer_courses ec2 ON ec2.course_id = lc2.course_id
   WHERE lc2.kind = 'video' AND lc2.status = 1 AND ec2.easyfixer_id = ?`;
}

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
  /*
   * Guarded by the same ternary every other read uses rather than an early
   * return. Without the flag `1=0` matches no course, the INSERT..SELECT
   * inserts nothing and this still returns { assigned: 0 } — one code path
   * instead of two, and no occurrence of the column that the source guard in
   * tests/lms-schema-probe.test.js has to be taught to forgive.
   */
  const { courseMandatory } = await lmsFlagColumns();
  const now = new Date();
  const [res] = await pool.query(
    `INSERT INTO easyfixer_courses (easyfixer_id, course_id, created_at, updated_at, due_date)
     SELECT ?, c.id, ?, ?, NULL
       FROM courses c
      WHERE ${courseMandatory ? 'c.is_mandatory = 1' : '1=0'} AND c.status = 1
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

// ─────────────────────────────────────────────────────────────────────
// Documents (PPT / PDF)
// ─────────────────────────────────────────────────────────────────────

/*
 * A stored file_key resolved to something a browser or the app can open.
 *
 * The DB holds an S3 OBJECT KEY, never a URL — a stored URL either expires or
 * has to be public, and both are wrong for training material. So every read
 * mints a fresh presigned GET.
 *
 * Fails SOFT to null. This runs inside a list payload (the course editor, and
 * the technician's whole course list): one unreachable object must degrade to
 * one item without a link, not 500 the screen and hide the other nine.
 *
 * ONE HOUR, not the shared 5-minute default. Every caller here mints these
 * into a SCREEN payload, not into an <img> that renders immediately —
 * coursesForTech is the technician app's whole LMS screen in one call, and a
 * technician who scrolls to the third course and opens the PPT six minutes
 * later would otherwise get a dead link with no way to tell why. An hour is
 * the same TTL notice images already use (NOTICE_PRESIGN_TTL_SEC) and is
 * bounded by how long anyone keeps that screen open.
 */
const DOCUMENT_PRESIGN_TTL_SEC = Number(process.env.S3_LMS_PRESIGN_TTL_SEC) || 3600;

async function documentUrl(fileKey) {
  const key = String(fileKey || '').trim();
  if (!key) return null;
  // Local-dev rows written before S3 was configured hold a relative URL.
  if (key.startsWith('/') || /^https?:\/\//i.test(key)) return key;
  if (!s3.isEnabled()) return null;
  try {
    return await s3.getPresignedUrl(key, DOCUMENT_PRESIGN_TTL_SEC);
  } catch (e) {
    logger.warn('LMS document presign failed · key=' + key + ' · ' + e.message);
    return null;
  }
}

async function listDocuments({ q, limit = 200, offset = 0 } = {}) {
  limit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  offset = Math.max(Number(offset) || 0, 0);

  const where = ['d.status = 1'];
  const params = [];
  if (q && String(q).trim()) {
    where.push('d.title LIKE ?');
    params.push(`%${String(q).trim()}%`);
  }
  const whereSql = where.join(' AND ');

  const [rows] = await pool.query(
    `SELECT d.id, d.title, d.file_key, d.mime_type, d.size_bytes, d.page_count,
            d.created_at, d.created_by,
            (SELECT COUNT(*) FROM lms_content lc
              WHERE lc.kind = 'document' AND lc.ref_id = d.id AND lc.status = 1) AS course_count
       FROM lms_document d
      WHERE ${whereSql}
      ORDER BY d.id DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM lms_document d WHERE ${whereSql}`,
    params,
  );

  logger.info('Found ' + rows.length + ' LMS documents of ' + total);
  /*
   * NAMED PROJECTION, and file_key is not in it. The S3 object key never
   * leaves the server — the client gets a presigned URL, which is the whole
   * reason the column stores a key rather than a URL. A `...r` spread here
   * would ship the key to every admin-group caller and quietly contradict the
   * invariant coursesForTech states next door.
   */
  const withUrls = await Promise.all(rows.map(async (r) => ({
    id: r.id,
    title: r.title,
    mime_type: r.mime_type,
    size_bytes: r.size_bytes,
    page_count: r.page_count,
    created_at: r.created_at,
    created_by: r.created_by,
    course_count: r.course_count,
    url: await documentUrl(r.file_key),
  })));
  return { rows: withUrls, total, limit, offset };
}

async function createDocument({ title, fileKey, mimeType, sizeBytes = null, pageCount = null, createdBy = null }) {
  // created_at is written explicitly for the same reason createCourse does it:
  // the column carries no DEFAULT, so an omitted value stores NULL and the
  // list renders a blank "Added" column.
  const [ins] = await pool.query(
    `INSERT INTO lms_document (title, file_key, mime_type, size_bytes, page_count, status, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    [String(title).trim(), String(fileKey), String(mimeType), sizeBytes, pageCount, new Date(), createdBy],
  );
  logger.info('LMS document created · id=' + ins.insertId + ' · mime=' + mimeType);
  return { id: ins.insertId };
}

async function updateDocument(id, { title }) {
  const docId = Number(id);
  const [r] = await pool.query(
    'UPDATE lms_document SET title = ? WHERE id = ? AND status = 1',
    [String(title).trim(), docId],
  );
  if (r.affectedRows === 0) throw mkErr(404, 'document not found');
  logger.info('LMS document renamed · id=' + docId);
  return { ok: true };
}

/*
 * Retire, and REFUSE while a course still holds it.
 *
 * Not a soft warning: lms_document_ack rows point at the content row, and a
 * technician's completion is derived from them. Retiring a document out from
 * under a live course would make that course permanently unfinishable for
 * anyone who had not yet acknowledged it, which ends in the overdue
 * restriction. Empty the course of it first — that is a deliberate act with a
 * visible consequence, which is the point.
 */
async function retireDocument(id) {
  const docId = Number(id);
  const [[{ n }]] = await pool.query(
    "SELECT COUNT(*) AS n FROM lms_content WHERE kind = 'document' AND ref_id = ? AND status = 1",
    [docId],
  );
  if (Number(n) > 0) throw mkErr(409, `this document is used by ${n} course${n === 1 ? '' : 's'} — remove it from them first`);
  const [r] = await pool.query('UPDATE lms_document SET status = 0 WHERE id = ? AND status = 1', [docId]);
  if (r.affectedRows === 0) throw mkErr(404, 'document not found');
  logger.info('LMS document retired · id=' + docId);
  return { retired: true };
}

// ─────────────────────────────────────────────────────────────────────
// Assessments
// ─────────────────────────────────────────────────────────────────────

async function listAssessments({ q, limit = 200, offset = 0 } = {}) {
  limit = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  offset = Math.max(Number(offset) || 0, 0);

  const where = ['a.status = 1'];
  const params = [];
  if (q && String(q).trim()) {
    where.push('(a.title LIKE ? OR a.description LIKE ?)');
    const like = `%${String(q).trim()}%`;
    params.push(like, like);
  }
  const whereSql = where.join(' AND ');

  const [rows] = await pool.query(
    `SELECT a.id, a.title, a.description, a.pass_percent, a.max_attempts, a.status,
            a.created_at, a.updated_at,
            (SELECT COUNT(*) FROM lms_question q
              WHERE q.assessment_id = a.id AND q.status = 1) AS question_count,
            (SELECT COUNT(*) FROM lms_content lc
              WHERE lc.kind = 'assessment' AND lc.ref_id = a.id AND lc.status = 1) AS course_count
       FROM lms_assessment a
      WHERE ${whereSql}
      ORDER BY a.id DESC
      LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM lms_assessment a WHERE ${whereSql}`,
    params,
  );

  logger.info('Found ' + rows.length + ' assessments of ' + total);
  return { rows, total, limit, offset };
}

/*
 * The FULL assessment, is_correct INCLUDED. Admin only.
 *
 * This is the answer key. It is reachable exclusively through
 * /api/admin/lms/assessments/:id, which is behind requireAuth + the admin role
 * + isLmsManage. The technician-facing read is a SEPARATE function
 * (getAssessmentForTech) with its own projection — never this one with the
 * answers stripped afterwards, because a stripping step is one forgotten
 * `...spread` away from leaking the whole key.
 */
async function getAssessmentForAdmin(id) {
  const aid = Number(id);
  const [[assessment]] = await pool.query(
    `SELECT id, title, description, pass_percent, max_attempts, status, created_at, updated_at
       FROM lms_assessment WHERE id = ?`,
    [aid],
  );
  if (!assessment) throw mkErr(404, 'assessment not found');

  const [rows] = await pool.query(
    `SELECT q.id AS question_id, q.question_text, q.sequence AS question_sequence,
            o.id AS option_id, o.option_text, o.is_correct, o.sequence AS option_sequence
       FROM lms_question q
       LEFT JOIN lms_question_option o ON o.question_id = q.id
      WHERE q.assessment_id = ? AND q.status = 1
      ORDER BY q.sequence ASC, q.id ASC, o.sequence ASC, o.id ASC`,
    [aid],
  );

  const byQuestion = new Map();
  for (const r of rows) {
    if (!byQuestion.has(r.question_id)) {
      byQuestion.set(r.question_id, {
        id: r.question_id,
        question_text: r.question_text,
        sequence: r.question_sequence,
        options: [],
      });
    }
    if (r.option_id) {
      byQuestion.get(r.question_id).options.push({
        id: r.option_id,
        option_text: r.option_text,
        is_correct: Number(r.is_correct) === 1,
        sequence: r.option_sequence,
      });
    }
  }
  return { ...assessment, questions: [...byQuestion.values()] };
}

async function createAssessment({ title, description = null, pass_percent, max_attempts }) {
  const now = new Date();
  /*
   * pass_percent and max_attempts fall through to the COLUMN DEFAULTS (70 / 3)
   * when the operator does not state them, rather than being defaulted here.
   * One place holds the number, and it is the one the migration documents.
   */
  const cols = ['title', 'description', 'status', 'created_at', 'updated_at'];
  const vals = [String(title).trim(), description || null, 1, now, now];
  if (pass_percent !== undefined) { cols.push('pass_percent'); vals.push(Number(pass_percent)); }
  if (max_attempts !== undefined) { cols.push('max_attempts'); vals.push(Number(max_attempts)); }

  const [ins] = await pool.query(
    `INSERT INTO lms_assessment (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    vals,
  );
  logger.info('Assessment created · id=' + ins.insertId + ' · title=' + title);
  return { id: ins.insertId };
}

async function updateAssessment(id, patch = {}) {
  const aid = Number(id);

  /*
   * STATUS NEVER WRITES STRAIGHT THROUGH.
   *
   * retireAssessment is where the in-use 409 lives. A PATCH that set
   * status = 0 on an assessment a live course holds would skip it entirely:
   * getAssessmentForTech filters on status = 1, so the paper 404s for every
   * technician on that course, no passing attempt can ever be recorded, and
   * the course becomes permanently unfinishable — the exact outcome the
   * DELETE endpoint refuses to cause. Same guard, whichever verb asks.
   *
   * Reinstating (status = 1) needs no guard — it can only ever unblock.
   */
  if (patch.status !== undefined) {
    if (patch.status) {
      const [r] = await pool.query(
        'UPDATE lms_assessment SET status = 1, updated_at = ? WHERE id = ?',
        [new Date(), aid],
      );
      if (r.affectedRows === 0) throw mkErr(404, 'assessment not found');
      logger.info('Assessment reinstated · id=' + aid);
    } else {
      await retireAssessment(aid);
    }
  }

  const sets = [];
  const params = [];
  // Plain placeholders, never COALESCE(?, col): COALESCE guards NULL only, so
  // an empty description would read as a no-op while actually blanking it.
  if (patch.title !== undefined) { sets.push('title = ?'); params.push(String(patch.title).trim()); }
  if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description || null); }
  if (patch.pass_percent !== undefined) { sets.push('pass_percent = ?'); params.push(Number(patch.pass_percent)); }
  if (patch.max_attempts !== undefined) { sets.push('max_attempts = ?'); params.push(Number(patch.max_attempts)); }
  // No `status` here — see above.
  if (!sets.length) {
    if (patch.status !== undefined) return getAssessmentForAdmin(aid);
    throw mkErr(400, 'nothing to update');
  }

  sets.push('updated_at = ?');
  params.push(new Date());

  const [r] = await pool.query(`UPDATE lms_assessment SET ${sets.join(', ')} WHERE id = ?`, [...params, aid]);
  if (r.affectedRows === 0) throw mkErr(404, 'assessment not found');
  logger.info('Assessment updated · id=' + aid + ' · fields=' + sets.length);
  return getAssessmentForAdmin(aid);
}

/* Same refusal as retireDocument, and for the same reason — see there. */
async function retireAssessment(id) {
  const aid = Number(id);
  const [[{ n }]] = await pool.query(
    "SELECT COUNT(*) AS n FROM lms_content WHERE kind = 'assessment' AND ref_id = ? AND status = 1",
    [aid],
  );
  if (Number(n) > 0) throw mkErr(409, `this assessment is used by ${n} course${n === 1 ? '' : 's'} — remove it from them first`);
  const [r] = await pool.query('UPDATE lms_assessment SET status = 0, updated_at = ? WHERE id = ? AND status = 1', [new Date(), aid]);
  if (r.affectedRows === 0) throw mkErr(404, 'assessment not found');
  logger.info('Assessment retired · id=' + aid);
  return { retired: true };
}

/*
 * THE WAY OUT OF AN EXHAUSTED ASSESSMENT. Admin only.
 *
 * Without this, running out of attempts is terminal in the worst possible
 * direction: submitAssessment 409s forever, itemCompleteSql needs a PASSING
 * attempt so the course never stamps complete, and hasOverdueTraining then
 * restricts the technician out of receiving work — with no action available
 * to him OR to ops. Extending the deadline does not help; the paper is what
 * is blocked, not the clock.
 *
 * The alternative shape — letting exhaustion silently complete the course —
 * was rejected outright: it would mark someone trained for failing, which is
 * precisely what the pass mark exists to prevent. A human decides instead.
 *
 * DELETES the attempt rows rather than flagging them. attempt_no is allocated
 * from a fresh read against uq_lms_attempt, so leaving dead rows behind would
 * keep the ceiling reached; and the honest reading of "reset his attempts" is
 * that he has his attempts back.
 *
 * easyfixer_courses.score is deliberately LEFT ALONE. It holds the best score
 * ever achieved, and a reset is a second chance, not an erasure of what
 * happened.
 */
async function resetAssessmentAttempts(assessmentId, easyfixerId) {
  const aid = Number(assessmentId);
  const efr = Number(easyfixerId);
  const [r] = await pool.query(
    'DELETE FROM lms_assessment_attempt WHERE assessment_id = ? AND easyfixer_id = ?',
    [aid, efr],
  );
  logger.info('Assessment attempts reset · assessmentId=' + aid + ' · efrId=' + efr
    + ' · cleared=' + r.affectedRows);
  return { cleared: r.affectedRows };
}

/*
 * Replace an assessment's questions with exactly what arrives.
 *
 * DELETE-then-INSERT here, unlike course content: nothing references a
 * question or an option id after the fact. lms_assessment_attempt records the
 * SCORE, not the answers, precisely so that re-writing a paper cannot corrupt
 * the history of who passed it. Both tables are InnoDB, so the transaction is
 * real.
 *
 * The shape rules (at least one question, at least two options, exactly one
 * correct) are enforced by Joi at the route — the single trust boundary — and
 * not re-checked here.
 */
async function setAssessmentQuestions(assessmentId, questions = []) {
  const aid = Number(assessmentId);
  await getAssessmentForAdmin(aid);

  logger.info('Set assessment questions · assessmentId=' + aid + ' · questions=' + questions.length);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Options first — there is no ON DELETE CASCADE here, so dropping the
    // questions first would strand every option row.
    await conn.query(
      'DELETE o FROM lms_question_option o JOIN lms_question q ON q.id = o.question_id WHERE q.assessment_id = ?',
      [aid],
    );
    await conn.query('DELETE FROM lms_question WHERE assessment_id = ?', [aid]);

    for (const [qi, q] of questions.entries()) {
      const [qIns] = await conn.query(
        'INSERT INTO lms_question (assessment_id, question_text, sequence, status) VALUES (?, ?, ?, 1)',
        [aid, String(q.question_text), Number(q.sequence) || qi + 1],
      );
      for (const [oi, o] of (q.options || []).entries()) {
        await conn.query(
          'INSERT INTO lms_question_option (question_id, option_text, is_correct, sequence) VALUES (?, ?, ?, ?)',
          [qIns.insertId, String(o.option_text), o.is_correct ? 1 : 0, Number(o.sequence) || oi + 1],
        );
      }
    }
    await conn.query('UPDATE lms_assessment SET updated_at = ? WHERE id = ?', [new Date(), aid]);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  logger.info('Assessment questions saved · assessmentId=' + aid);
  return getAssessmentForAdmin(aid);
}

// ─────────────────────────────────────────────────────────────────────
// Taking an assessment (technician)
// ─────────────────────────────────────────────────────────────────────

/*
 * The paper as the technician sees it.
 *
 * *** is_correct IS NEVER SELECTED. ***
 *
 * Not "selected and then removed" — not selected at all. The projection below
 * names every column that leaves this function, so the answer key cannot ride
 * out inside an object spread, a `...row`, a debug log line or a future field
 * added to the query by someone reading the admin version next door. A client
 * that receives the answers can score itself, and the whole point of scoring
 * server-side is that it cannot.
 */
/*
 * WHICH OF THIS TECHNICIAN'S ASSIGNED COURSES CONTAIN THIS ITEM.
 *
 * Empty means he has no business with it: either nothing assigned to him holds
 * it, or the item was removed from the course that did. Every technician-facing
 * read and write below starts here — an id in a URL is a request, not an
 * entitlement, and without this any signed-in technician could pull down and
 * sit any assessment in the catalogue and have the pass counted.
 *
 * Returns course ids rather than a boolean because submitAssessment needs to
 * know WHICH course an attempt belongs to, and the same assessment can sit in
 * two.
 */
async function assignedCourseIdsFor(efrId, kind, refId) {
  const [rows] = await pool.query(
    `SELECT DISTINCT lc.course_id
       FROM lms_content lc
       JOIN easyfixer_courses ec ON ec.course_id = lc.course_id AND ec.easyfixer_id = ?
      WHERE lc.kind = ? AND lc.ref_id = ? AND lc.status = 1`,
    [Number(efrId), String(kind), Number(refId)],
  );
  return rows.map((r) => Number(r.course_id));
}

async function getAssessmentForTech(efrId, assessmentId) {
  const aid = Number(assessmentId);
  // 404 rather than 403: whether an assessment he was never assigned exists is
  // not a technician's question to have answered.
  if (!(await assignedCourseIdsFor(efrId, 'assessment', aid)).length) {
    throw mkErr(404, 'assessment not found');
  }
  const [[assessment]] = await pool.query(
    'SELECT id, title, description, pass_percent, max_attempts FROM lms_assessment WHERE id = ? AND status = 1',
    [aid],
  );
  if (!assessment) throw mkErr(404, 'assessment not found');

  const [rows] = await pool.query(
    `SELECT q.id AS question_id, q.question_text, o.id AS option_id, o.option_text
       FROM lms_question q
       JOIN lms_question_option o ON o.question_id = q.id
      WHERE q.assessment_id = ? AND q.status = 1
      ORDER BY q.sequence ASC, q.id ASC, o.sequence ASC, o.id ASC`,
    [aid],
  );

  const byQuestion = new Map();
  for (const r of rows) {
    if (!byQuestion.has(r.question_id)) {
      byQuestion.set(r.question_id, { id: r.question_id, question_text: r.question_text, options: [] });
    }
    byQuestion.get(r.question_id).options.push({ id: r.option_id, option_text: r.option_text });
  }

  const [[used]] = await pool.query(
    'SELECT COUNT(*) AS n FROM lms_assessment_attempt WHERE easyfixer_id = ? AND assessment_id = ?',
    [Number(efrId), aid],
  );

  return {
    id: assessment.id,
    title: assessment.title,
    description: assessment.description,
    passPercent: Number(assessment.pass_percent),
    maxAttempts: Number(assessment.max_attempts),
    attemptsUsed: Number(used?.n) || 0,
    questions: [...byQuestion.values()],
  };
}

/*
 * Score an attempt, record it, and return the outcome.
 *
 * SCORING HAPPENS HERE AND NOWHERE ELSE. The request carries the technician's
 * ANSWERS, never a score — a client-sent score would make the whole assessment
 * a formality, and this endpoint is what stands between an untrained
 * technician and being marked trained.
 *
 * ATTEMPT NUMBERING. uq_lms_attempt (easyfixer_id, assessment_id, attempt_no)
 * is the thing that makes "three attempts" mean three attempts, so the number
 * is allocated against a fresh read and the INSERT is retried on ER_DUP_ENTRY.
 * Two submits racing (a double tap, or the app retrying a request whose
 * response was lost) both read `last = 1`, both try attempt 2, and one of them
 * loses on the unique key — the loser re-reads, sees 2 taken, and either takes
 * 3 or is refused because the ceiling is now reached. Without the retry the
 * second submit would surface as a 500.
 */
async function submitAssessment(efrId, assessmentId, { courseId = null, answers = [] } = {}) {
  const efr = Number(efrId);
  const aid = Number(assessmentId);

  /*
   * THE COURSE IS RESOLVED, NEVER TRUSTED.
   *
   * The body's courseId used to be stored verbatim. It decides which
   * easyfixer_courses row gets the score, so an arbitrary number would write a
   * pass against a course this technician was never assigned — or against
   * someone else's course entirely. It is treated as a HINT: honoured only if
   * it is one of the assigned courses that actually contains this assessment,
   * and otherwise resolved (one candidate → that one; several → none, because
   * only the app knows which one it was working through).
   */
  const assignedCourseIds = await assignedCourseIdsFor(efr, 'assessment', aid);
  if (!assignedCourseIds.length) throw mkErr(404, 'assessment not found');
  const cid = assignedCourseIds.includes(Number(courseId))
    ? Number(courseId)
    : (assignedCourseIds.length === 1 ? assignedCourseIds[0] : null);

  const [[assessment]] = await pool.query(
    'SELECT id, pass_percent, max_attempts FROM lms_assessment WHERE id = ? AND status = 1',
    [aid],
  );
  if (!assessment) throw mkErr(404, 'assessment not found');
  const maxAttempts = Number(assessment.max_attempts);
  const passPercent = Number(assessment.pass_percent);

  /*
   * The answer key, read on the SERVER side of the wire. One row per question:
   * the write path guarantees exactly one correct option, and the Map collapses
   * any historical row that violated that rather than inflating the
   * denominator with a duplicate question.
   */
  const [correctRows] = await pool.query(
    `SELECT q.id AS question_id, o.id AS option_id
       FROM lms_question q
       JOIN lms_question_option o ON o.question_id = q.id AND o.is_correct = 1
      WHERE q.assessment_id = ? AND q.status = 1`,
    [aid],
  );
  const key = new Map();
  for (const r of correctRows) if (!key.has(Number(r.question_id))) key.set(Number(r.question_id), Number(r.option_id));
  if (!key.size) throw mkErr(409, 'this assessment has no questions yet');

  const given = new Map();
  for (const a of answers) given.set(Number(a.questionId), Number(a.optionId));

  let correct = 0;
  for (const [questionId, optionId] of key) if (given.get(questionId) === optionId) correct += 1;
  // Two decimals, matching score_pct DECIMAL(5,2) — rounding to an integer
  // here would make 2/3 read as 67 while the stored row says 66.67.
  const scorePct = Math.round((correct / key.size) * 10000) / 100;
  const passed = scorePct >= passPercent;

  const now = new Date();
  let attemptNo = 0;
  let attemptsUsed = 0;
  for (let attempt = 1; ; attempt += 1) {
    const [[tally]] = await pool.query(
      `SELECT COUNT(*) AS n, COALESCE(MAX(attempt_no), 0) AS last
         FROM lms_assessment_attempt WHERE easyfixer_id = ? AND assessment_id = ?`,
      [efr, aid],
    );
    attemptsUsed = Number(tally?.n) || 0;
    if (attemptsUsed >= maxAttempts) {
      logger.warn('Assessment attempt refused · efrId=' + efr + ' · assessmentId=' + aid
        + ' · used=' + attemptsUsed + '/' + maxAttempts);
      throw mkErr(409, `no attempts remaining — all ${maxAttempts} have been used`);
    }
    attemptNo = (Number(tally?.last) || 0) + 1;
    try {
      await pool.query(
        `INSERT INTO lms_assessment_attempt
           (easyfixer_id, assessment_id, course_id, attempt_no, score_pct, passed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [efr, aid, cid, attemptNo, scorePct, passed ? 1 : 0, now],
      );
      attemptsUsed += 1;
      break;
    } catch (e) {
      if (e?.code !== 'ER_DUP_ENTRY') throw e;
      if (attempt >= 3) throw mkErr(409, 'another attempt is already being recorded — try again');
      logger.warn('Attempt number ' + attemptNo + ' was taken by a concurrent submit · efrId=' + efr
        + ' · assessmentId=' + aid + ' · retrying');
    }
  }

  logger.info('Assessment submitted · efrId=' + efr + ' · assessmentId=' + aid
    + ' · attempt=' + attemptNo + ' · score=' + scorePct + '% · passed=' + passed);

  /*
   * BEST score, not latest, and GREATEST does it in the database.
   *
   * A read-then-write would let a failed retake overwrite a pass under
   * concurrency, and easyfixer_courses.score is what the Training Report and
   * the client-facing completion evidence render. A technician who scored 90
   * and then tried again out of curiosity has still scored 90.
   */
  if (cid) {
    await pool.query(
      `UPDATE easyfixer_courses SET score = GREATEST(COALESCE(score, 0), ?), updated_at = ?
        WHERE easyfixer_id = ? AND course_id = ?`,
      [scorePct, now, efr, cid],
    );
  }

  /*
   * A pass can be the last thing a course was waiting on, so completion is
   * settled here exactly as the 100% video ping settles it. Best-effort: the
   * attempt is already recorded and committed, and a stamping failure must not
   * turn a passed assessment into a 500 that the app retries — which would
   * burn a second attempt.
   */
  if (passed) {
    try {
      await settleTrainingCompletion(efr);
    } catch (e) {
      logger.warn('Post-pass completion handling failed · efrId=' + efr + ' · ' + e.message);
    }
  }

  return {
    scorePct,
    passed,
    attemptNo,
    attemptsRemaining: Math.max(0, maxAttempts - attemptsUsed),
    passPercent,
  };
}

/*
 * "I have read this." The document equivalent of watching a video to the end.
 *
 * Keyed on the CONTENT row, not the document: the same PDF in two courses must
 * be acknowledged for each, because a completion claim is about a course.
 *
 * Idempotent through uq_lms_doc_ack, and the first acknowledgement time is
 * KEPT (the upsert re-states the row rather than moving the timestamp) — the
 * fact being recorded is when they read it, not when they last tapped.
 */
async function ackDocument(efrId, contentId) {
  const cid = Number(contentId);
  /*
   * Scoped to the caller's own assignments by the JOIN, not by a check
   * afterwards: an acknowledgement is what makes a course complete, so an
   * unscoped content id would let any signed-in technician tick off an item of
   * a course he was never given.
   */
  const [[content]] = await pool.query(
    `SELECT lc.id, lc.kind, lc.course_id
       FROM lms_content lc
       JOIN easyfixer_courses ec ON ec.course_id = lc.course_id AND ec.easyfixer_id = ?
      WHERE lc.id = ? AND lc.status = 1`,
    [Number(efrId), cid],
  );
  if (!content) throw mkErr(404, 'content item not found');
  if (content.kind !== 'document') throw mkErr(400, 'only a document can be acknowledged');

  await pool.query(
    `INSERT INTO lms_document_ack (easyfixer_id, content_id, acknowledged_at)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE content_id = VALUES(content_id)`,
    [Number(efrId), cid, new Date()],
  );
  logger.info('Document acknowledged · efrId=' + efrId + ' · contentId=' + cid);

  /*
   * The SAME three steps a passing attempt and a 100% video ping take — not
   * just the per-course stamp. A technician whose last outstanding item is a
   * PPT is as finished as one whose last item is a video, and stamping the
   * course without asking whether ALL training is now complete left him in
   * TRAINING_PENDING forever. Best-effort — the ack itself is committed.
   */
  try {
    await settleTrainingCompletion(Number(efrId));
  } catch (e) {
    logger.warn('Post-ack completion handling failed · efrId=' + efrId + ' · ' + e.message);
  }
  return { ok: true };
}

/*
 * Every course assigned to this technician, with its ordered content and each
 * item's completion — the technician app's entire LMS screen in one call.
 *
 * TWO queries, not one per course and not one per item. The item query joins
 * easyfixer_courses so `ec.easyfixer_id` is in scope, which is what lets the
 * per-kind completion rule (itemCompleteSql) be the SAME expression the
 * gating reads use. An app that computed completion itself from a watched
 * percentage would be a fourth copy of the rule, and the one running on a
 * phone that has not been updated in six months.
 */
async function coursesForTech(efrId) {
  const efr = Number(efrId);
  // Probed: this is the technician's own LMS screen, and both the projection
  // and the ordering below name a column that arrives by ALTER.
  const { courseMandatory } = await lmsFlagColumns();
  const [courses] = await pool.query(
    `SELECT ec.course_id AS id, c.name, c.description,
            ${courseMandatory ? 'c.is_mandatory' : '0 AS is_mandatory'},
            ec.due_date, ec.completion_date, ec.score
       FROM easyfixer_courses ec
       JOIN courses c ON c.id = ec.course_id
      WHERE ec.easyfixer_id = ? AND c.status = 1
      /*
       * MANDATORY FIRST. These are the courses that gate a technician's work,
       * so they lead the screen regardless of due date — a required course
       * with no deadline sitting below an optional one with a near deadline
       * reads as the optional one mattering more, which is backwards.
       * Ordered here rather than in a client so every client agrees, and so a
       * technician on an older build gets the same priority.
       *
       * Without the column nothing is mandatory, so the leading sort key is
       * dropped rather than faked — the remaining due-date order is exactly
       * what this screen showed before the flag existed.
       */
      ORDER BY ${courseMandatory ? 'c.is_mandatory DESC, ' : ''}(ec.due_date IS NULL), ec.due_date ASC, c.name ASC`,
    [efr],
  );
  if (!courses.length) return { rows: [] };

  const [items] = await pool.query(
    `SELECT lc.id, lc.course_id, lc.kind, lc.ref_id, lc.sequence,
            tv.title AS video_title, d.url AS video_url,
            COALESCE((SELECT MAX(w.watched_percentage) FROM easyfixer_watched_video w
                       WHERE w.video_id = lc.ref_id AND w.easyfixer_id = ec.easyfixer_id), 0) AS watched_percentage,
            doc.title AS document_title, doc.file_key, doc.mime_type, doc.page_count,
            a.title AS assessment_title, a.pass_percent, a.max_attempts,
            (SELECT COUNT(*) FROM lms_assessment_attempt aa
              WHERE aa.assessment_id = lc.ref_id AND aa.easyfixer_id = ec.easyfixer_id) AS attempts_used,
            (SELECT MAX(aa.score_pct) FROM lms_assessment_attempt aa
              WHERE aa.assessment_id = lc.ref_id AND aa.easyfixer_id = ec.easyfixer_id) AS best_score,
            (${itemCompleteSql('ec.easyfixer_id')}) AS complete
       FROM easyfixer_courses ec
       JOIN lms_content lc ON lc.course_id = ec.course_id AND lc.status = 1
       LEFT JOIN training_videos tv ON lc.kind = 'video' AND tv.id = lc.ref_id
       LEFT JOIN document d ON d.id = tv.training_video_id AND d.document_type_id = 2
       LEFT JOIN lms_document doc ON lc.kind = 'document' AND doc.id = lc.ref_id
       LEFT JOIN lms_assessment a ON lc.kind = 'assessment' AND a.id = lc.ref_id
      WHERE ec.easyfixer_id = ?
      ORDER BY lc.course_id ASC, lc.sequence ASC, lc.id ASC`,
    [efr],
  );

  const byCourse = new Map(courses.map((c) => [c.id, { ...c, items: [] }]));
  for (const r of items) {
    const course = byCourse.get(r.course_id);
    // A retired course still has assignment rows; its items are skipped rather
    // than surfaced under a course the technician cannot see.
    if (!course) continue;
    const base = {
      id: r.id,
      kind: r.kind,
      ref_id: r.ref_id,
      sequence: r.sequence,
      complete: Number(r.complete) === 1,
    };
    if (r.kind === 'video') {
      course.items.push({
        ...base,
        title: r.video_title,
        url: normalizeVideoUrl(r.video_url) || null,
        watchedPercent: Number(r.watched_percentage) || 0,
      });
    } else if (r.kind === 'document') {
      // file_key deliberately stays server-side; the app gets a presigned URL.
      course.items.push({
        ...base,
        title: r.document_title,
        url: await documentUrl(r.file_key),
        mimeType: r.mime_type,
        pageCount: r.page_count,
      });
    } else {
      course.items.push({
        ...base,
        title: r.assessment_title,
        attemptsUsed: Number(r.attempts_used) || 0,
        maxAttempts: Number(r.max_attempts),
        passPercent: Number(r.pass_percent),
        bestScore: r.best_score === null ? null : Number(r.best_score),
      });
    }
  }

  const rows = [...byCourse.values()];
  logger.info('LMS courses for technician · efrId=' + efr + ' · courses=' + rows.length
    + ' · items=' + items.length);
  return { rows };
}

module.exports = {
  mandatoryVideoIdsSql,
  visibleVideoIdsSql,
  lmsFlagColumns,
  invalidateLmsSchemaCache,
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
  getCourseContent,
  setCourseContent,
  CONTENT_KINDS,
  listDocuments,
  createDocument,
  updateDocument,
  retireDocument,
  documentUrl,
  listAssessments,
  getAssessmentForAdmin,
  createAssessment,
  updateAssessment,
  retireAssessment,
  resetAssessmentAttempts,
  setAssessmentQuestions,
  getAssessmentForTech,
  submitAssessment,
  ackDocument,
  coursesForTech,
  listVideos,
  videoProgressCount,
  videoCourseCount,
  assignCourse,
  extendAssignment,
  unassignCourse,
  listAssignments,
  trainingReport,
  isTrainingComplete,
  settleTrainingCompletion,
};
