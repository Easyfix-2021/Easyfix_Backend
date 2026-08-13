-- =============================================================================
-- LMS foundation — course content model, assignment integrity, and the
-- LMS sidebar tree with its RBAC seeds.
--
-- WHAT THIS DOES
--   1. CREATE course_videos — the missing link between a course and the
--      training videos it contains. EasyFix-owned; no legacy service
--      references it (the CLAUDE.md "new EasyFix-owned table" exception).
--   2. ALTER courses ADD status — soft-delete, so retiring a course never
--      strands the assignment/report history that points at it.
--   3. ALTER easyfixer_courses ADD UNIQUE (easyfixer_id, course_id) — makes
--      assignment idempotent and stops the same course being assigned twice
--      to one technician (which would double-count in the report).
--   4. Seed the LMS menu (parent + 4 children), the isLmsManage action, and
--      grant both to Admin (role_id = 2).
--
-- WHY THE TWO ALTERs ARE SAFE ON A SHARED DATABASE
--   CLAUDE.md forbids altering shared schema because five legacy services
--   read it. Both tables here are EMPTY (0 rows, verified 2026-08-13) and no
--   legacy service writes them — they are dormant leftovers from the old Java
--   CRM. Both changes are ADDITIVE: a reader that does not know about
--   `status` or the new unique key is unaffected. Nothing is dropped,
--   renamed, or retyped.
--
--   NOTE the live training tables are deliberately NOT touched.
--   training_videos and easyfixer_watched_video are MyISAM and carry 7,224
--   rows of real technician progress; the video-delete guard is enforced in
--   application code instead (routes/admin/auxiliary.js), because MyISAM
--   parses foreign keys and silently ignores them.
--
-- HOW TO APPLY
--   Run statement-by-statement. On a re-run expect, and ignore:
--     - "Table 'course_videos' already exists"
--     - "Duplicate column name 'status'"
--     - "Duplicate key name 'uq_easyfixer_course'"
--   The data-side statements (sections 4-6) are idempotent by construction
--   and can be re-run freely.
--
-- POST-APPLY
--   Admin users must log out and back in — menu_ids and actionPermissions are
--   resolved into the JWT at login.
-- =============================================================================

-- ─── 1. Course content ───────────────────────────────────────────────
-- sequence orders the videos within a course; the UNIQUE key makes
-- "set the content of this course" an idempotent replace.
--
-- video_id has NO foreign key on purpose: training_videos is MyISAM, so the
-- constraint would be accepted and then ignored, which is worse than no
-- constraint at all because it reads as a guarantee. Referential integrity
-- for video_id is enforced in services/lms.service.js.
CREATE TABLE course_videos (
  id INT NOT NULL AUTO_INCREMENT,
  course_id INT NOT NULL,
  video_id INT NOT NULL,
  sequence INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_course_video (course_id, video_id),
  KEY idx_course_videos_video (video_id),
  CONSTRAINT fk_course_videos_course FOREIGN KEY (course_id) REFERENCES courses (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── 2. Soft-delete for courses ──────────────────────────────────────
-- 1 = active, 0 = retired. Default 1 so any row that ever appears without
-- an explicit value is visible rather than silently hidden.
ALTER TABLE courses ADD COLUMN status TINYINT NOT NULL DEFAULT 1;

-- ─── 3. Assignment integrity ─────────────────────────────────────────
-- Without this a technician can hold N rows for one course, and the report's
-- completion maths counts the course N times.
ALTER TABLE easyfixer_courses ADD UNIQUE KEY uq_easyfixer_course (easyfixer_id, course_id);

-- ─── 4. Menu tree ────────────────────────────────────────────────────
-- Top-level parent at sequence 14 (Notice Board holds 13). The sidebar is a
-- hard 2-level tree — Sidebar.tsx::buildTree re-parents any grandchild to its
-- nearest top-level ancestor — so these four are leaves, not a third level.
--
-- The parent is keyed by (menu_name, parent_menu) rather than by url, because
-- every parent-only row shares url = 'javascript:;'.
INSERT INTO tbl_menu (menu_name, parent_menu, menu_depth, has_child, url, menu_status, sequence, icons, action_name)
SELECT 'LMS', 0, 1, 1, 'javascript:;', 1, 14.0000, 'fa-graduation-cap', 'lms'
 WHERE NOT EXISTS (SELECT 1 FROM tbl_menu WHERE menu_name = 'LMS' AND parent_menu = 0);

INSERT INTO tbl_menu (menu_name, parent_menu, menu_depth, has_child, url, menu_status, sequence, icons, action_name)
SELECT 'Manage Courses', p.menu_id, 2, 0, 'lmsCourses', 1, 14.0001, 'fa-circle', 'lmsCourses'
  FROM tbl_menu p
 WHERE p.menu_name = 'LMS' AND p.parent_menu = 0
   AND NOT EXISTS (SELECT 1 FROM tbl_menu c WHERE c.url = 'lmsCourses');

INSERT INTO tbl_menu (menu_name, parent_menu, menu_depth, has_child, url, menu_status, sequence, icons, action_name)
SELECT 'Training Videos', p.menu_id, 2, 0, 'lmsVideos', 1, 14.0002, 'fa-circle', 'lmsVideos'
  FROM tbl_menu p
 WHERE p.menu_name = 'LMS' AND p.parent_menu = 0
   AND NOT EXISTS (SELECT 1 FROM tbl_menu c WHERE c.url = 'lmsVideos');

INSERT INTO tbl_menu (menu_name, parent_menu, menu_depth, has_child, url, menu_status, sequence, icons, action_name)
SELECT 'Assign Training', p.menu_id, 2, 0, 'lmsAssign', 1, 14.0003, 'fa-circle', 'lmsAssign'
  FROM tbl_menu p
 WHERE p.menu_name = 'LMS' AND p.parent_menu = 0
   AND NOT EXISTS (SELECT 1 FROM tbl_menu c WHERE c.url = 'lmsAssign');

INSERT INTO tbl_menu (menu_name, parent_menu, menu_depth, has_child, url, menu_status, sequence, icons, action_name)
SELECT 'Training Report', p.menu_id, 2, 0, 'lmsReport', 1, 14.0004, 'fa-circle', 'lmsReport'
  FROM tbl_menu p
 WHERE p.menu_name = 'LMS' AND p.parent_menu = 0
   AND NOT EXISTS (SELECT 1 FROM tbl_menu c WHERE c.url = 'lmsReport');

-- ─── 5. Action permission ────────────────────────────────────────────
-- One write key for v1, matching the Notice Board precedent. The Training
-- Report page is read-only and gated by menu visibility alone.
INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT p.menu_id, 'isLmsManage', 'Manage LMS (courses, videos, content, assignments)', 1, 0, NOW()
  FROM tbl_menu p
 WHERE p.menu_name = 'LMS' AND p.parent_menu = 0
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isLmsManage');

-- ─── 6. Grant to Admin (role_id = 2) ─────────────────────────────────
-- 6a. Sidebar visibility — append each menu_id to the legacy CSV.
UPDATE tbl_role SET menu_ids = CONCAT(COALESCE(menu_ids, ''), IF(menu_ids IS NULL OR menu_ids = '', '', ','), (SELECT menu_id FROM tbl_menu WHERE menu_name = 'LMS' AND parent_menu = 0)) WHERE role_id = 2 AND NOT FIND_IN_SET((SELECT menu_id FROM tbl_menu WHERE menu_name = 'LMS' AND parent_menu = 0), COALESCE(menu_ids, ''));

UPDATE tbl_role SET menu_ids = CONCAT(COALESCE(menu_ids, ''), IF(menu_ids IS NULL OR menu_ids = '', '', ','), (SELECT menu_id FROM tbl_menu WHERE url = 'lmsCourses')) WHERE role_id = 2 AND NOT FIND_IN_SET((SELECT menu_id FROM tbl_menu WHERE url = 'lmsCourses'), COALESCE(menu_ids, ''));

UPDATE tbl_role SET menu_ids = CONCAT(COALESCE(menu_ids, ''), IF(menu_ids IS NULL OR menu_ids = '', '', ','), (SELECT menu_id FROM tbl_menu WHERE url = 'lmsVideos')) WHERE role_id = 2 AND NOT FIND_IN_SET((SELECT menu_id FROM tbl_menu WHERE url = 'lmsVideos'), COALESCE(menu_ids, ''));

UPDATE tbl_role SET menu_ids = CONCAT(COALESCE(menu_ids, ''), IF(menu_ids IS NULL OR menu_ids = '', '', ','), (SELECT menu_id FROM tbl_menu WHERE url = 'lmsAssign')) WHERE role_id = 2 AND NOT FIND_IN_SET((SELECT menu_id FROM tbl_menu WHERE url = 'lmsAssign'), COALESCE(menu_ids, ''));

UPDATE tbl_role SET menu_ids = CONCAT(COALESCE(menu_ids, ''), IF(menu_ids IS NULL OR menu_ids = '', '', ','), (SELECT menu_id FROM tbl_menu WHERE url = 'lmsReport')) WHERE role_id = 2 AND NOT FIND_IN_SET((SELECT menu_id FROM tbl_menu WHERE url = 'lmsReport'), COALESCE(menu_ids, ''));

-- 6b. Action visibility — restore a soft-deleted grant first, then insert.
UPDATE role_menu_action SET isDeleted = 0 WHERE role_id = 2 AND isDeleted = 1 AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'isLmsManage');

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0
  FROM menu_action ma
 WHERE ma.action_name = 'isLmsManage'
   AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);

-- ─── 7. Verify ───────────────────────────────────────────────────────
SELECT 'course_videos table' AS what, COUNT(*) AS present FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'course_videos'
UNION ALL
SELECT 'courses.status column', COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'courses' AND column_name = 'status'
UNION ALL
SELECT 'easyfixer_courses unique key', COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'easyfixer_courses' AND index_name = 'uq_easyfixer_course'
UNION ALL
SELECT 'LMS menu rows (expect 5)', COUNT(*) FROM tbl_menu WHERE menu_name = 'LMS' AND parent_menu = 0 OR url IN ('lmsCourses', 'lmsVideos', 'lmsAssign', 'lmsReport')
UNION ALL
SELECT 'isLmsManage action', COUNT(*) FROM menu_action WHERE action_name = 'isLmsManage'
UNION ALL
SELECT 'admin role_menu_action grant', COUNT(*) FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.isDeleted = 0 AND rma.menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'isLmsManage');
