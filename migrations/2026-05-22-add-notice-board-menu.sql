-- =============================================================================
-- Seed the Notice Board sidebar entry + isNoticeManage action permission,
-- and grant both to the Admin role (role_id = 2).
--
-- Three mutations, all idempotent:
--   1. INSERT a top-level tbl_menu row "Notice Board" (url='noticeBoard').
--      A single leaf page — no sub-menus in v1.
--   2. INSERT a menu_action row 'isNoticeManage' under that menu.
--   3. Grant to Admin (role_id=2):
--      (a) append menu_id to tbl_role.menu_ids CSV (handles sidebar visibility)
--      (b) insert role_menu_action row (handles action-button visibility)
--
-- WHY: Sidebar.tsx is driven by me.permissions.menuIds (resolved from
-- tbl_role.menu_ids). Permission helpers (lib/permissions.ts::hasAction) read
-- me.permissions.actionPermissions, resolved from role_menu_action × menu_action.
-- Both arrays must be populated for the new Notice Board page to be visible
-- AND manageable by Admin. Other roles can be granted later via Manage Roles.
-- =============================================================================

-- ─── 1. tbl_menu row ──────────────────────────────────────────────────
-- parent_menu=0 (top-level), depth=1, leaf (has_child=0), url='noticeBoard'
-- which Sidebar.tsx URL_MAP resolves to '/notice-board'. action_name field
-- on tbl_menu is denormalised legacy metadata — we mirror the URL key
-- ('noticeBoard') matching the convention used by leaf rows like 'home'.
INSERT INTO tbl_menu (menu_name, parent_menu, menu_depth, has_child, url,
                      menu_status, sequence, icons, action_name)
SELECT 'Notice Board', 0, 1, 0, 'noticeBoard',
       1, 13.0000, 'fa-bullhorn', 'noticeBoard'
 WHERE NOT EXISTS (
   SELECT 1 FROM tbl_menu WHERE url = 'noticeBoard'
 );

SET @notice_board_menu_id := (
  SELECT menu_id FROM tbl_menu WHERE url = 'noticeBoard' LIMIT 1
);

SELECT IF(
  @notice_board_menu_id IS NULL,
  (SELECT 'ABORT: Notice Board menu row missing after insert' FROM dual WHERE 1=0),
  'OK'
) AS preflight_menu;

-- ─── 2. menu_action row ──────────────────────────────────────────────
-- Single permission key for v1. Maker-checker (separate isNoticeReview,
-- isNoticePublish) deferred to Phase 2 — the schema already reserves
-- the reviewed_by / published_by columns.
INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT @notice_board_menu_id,
       'isNoticeManage',
       'Manage Notice Board (Draft / Edit / Publish / Archive)',
       1, 0, NOW()
 WHERE NOT EXISTS (
   SELECT 1 FROM menu_action WHERE action_name = 'isNoticeManage'
 );

-- ─── 3a. Grant menu to Admin role (CSV append) ───────────────────────
-- tbl_role.menu_ids is a CSV legacy carry-over. FIND_IN_SET checks
-- whether the new id is already in the CSV; if absent, append with a
-- comma separator (handles both empty and non-empty starting values).
UPDATE tbl_role
   SET menu_ids = CASE
     WHEN menu_ids IS NULL OR menu_ids = '' THEN CAST(@notice_board_menu_id AS CHAR)
     WHEN FIND_IN_SET(@notice_board_menu_id, menu_ids) > 0 THEN menu_ids
     ELSE CONCAT(menu_ids, ',', @notice_board_menu_id)
   END
 WHERE role_id = 2;

-- ─── 3b. Grant action to Admin via role_menu_action ──────────────────
-- Restore soft-deleted rows first, then INSERT any never-created.
UPDATE role_menu_action
   SET isDeleted = 0
 WHERE role_id = 2
   AND isDeleted = 1
   AND menu_action_id IN (
     SELECT id FROM menu_action WHERE action_name = 'isNoticeManage'
   );

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0
  FROM menu_action ma
 WHERE ma.action_name = 'isNoticeManage'
   AND NOT EXISTS (
     SELECT 1 FROM role_menu_action rma
      WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id
   );

-- ─── 4. Verify ────────────────────────────────────────────────────────
SELECT 'tbl_menu'        AS what,
       (SELECT COUNT(*) FROM tbl_menu       WHERE url = 'noticeBoard')      AS rows_present
UNION ALL
SELECT 'menu_action',
       (SELECT COUNT(*) FROM menu_action    WHERE action_name = 'isNoticeManage')
UNION ALL
SELECT 'role_menu_action (admin)',
       (SELECT COUNT(*) FROM role_menu_action rma
         WHERE rma.role_id = 2 AND rma.isDeleted = 0
           AND rma.menu_action_id IN (
             SELECT id FROM menu_action WHERE action_name = 'isNoticeManage'
           ))
UNION ALL
SELECT 'admin role menu_ids has notice board',
       (SELECT FIND_IN_SET(@notice_board_menu_id, menu_ids) FROM tbl_role WHERE role_id = 2);
