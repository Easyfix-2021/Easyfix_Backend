-- =============================================================================
-- LMS action permissions — the two action keys the LMS action loop is gated on.
--
-- WHAT THIS DOES
--   1. Seed menu_action `isLmsAction`       — view + chase the action lists.
--   2. Seed menu_action `isLmsChaseHandoff` — hand a chase list to the state
--      managers who own those cities.
--   3. Grant both to Admin (role_id = 2) and `isLmsAction` to Zonal Field Team
--      (role_id = 12), which is the role a state manager holds.
--
-- WHY TWO KEYS AND NOT ONE
--   Chasing is something a state manager does for their own cities; handing a
--   list OFF to state managers is something only the training team does. One
--   key would mean a state manager could re-assign work to their peers, which
--   is not a permission anyone intended to grant — it is just the permission
--   they would inherit. Splitting them costs one row and makes the difference
--   expressible in Manage Roles.
--
-- WHY THERE IS NO MENU LEAF HERE
--   Deliberate. The pages these keys gate ship in a later slice, and a sidebar
--   leaf whose URL 404s is worse than no leaf: an operator reads it as a broken
--   feature rather than an unbuilt one. The leaf + its tbl_role.menu_ids CSV
--   append land with the pages. The keys go in first because the ROUTES land
--   first, and a route gated on an action_name that does not exist is
--   indistinguishable from one whose grant was revoked — it fails closed even
--   for Admin. That exact confusion is why scripts/migration-status.js exists.
--
--   Consequence while this is the only applied half: both keys are grantable in
--   Manage Roles and enforced by the API, and nothing in the sidebar references
--   them yet. That is the intended intermediate state.
--
-- ROLE IDS
--   2  = Admin            (the training team)
--   12 = Zonal Field Team (the state manager — see CLAUDE.md's role table)
--   The state manager is NOT a new role. Their geographic reach comes from
--   tbl_user.manage_states, which buildRequestScopeWithHierarchy already
--   expands live to cities; a second representation of "which cities does this
--   user own" would only drift from the first.
--
-- HOW TO APPLY
--   Run statement-by-statement. Every statement is idempotent by construction
--   (INSERT … SELECT … WHERE NOT EXISTS, and a revive-then-insert on the
--   grants), so a re-run is a no-op and produces no errors to ignore.
--
-- POST-APPLY
--   Affected users must log out and back in — menu_ids and actionPermissions
--   are resolved into the JWT at login, so a grant made now is invisible to a
--   session that started before it.
-- =============================================================================

-- ─── 1. Action permissions ───────────────────────────────────────────
-- Both hang off the existing LMS parent seeded by
-- 2026-08-13-lms-foundation.sql. The parent is looked up by
-- (menu_name, parent_menu) and never by a hard-coded menu_id: menu_id is
-- AUTO_INCREMENT and differs between QA and production, so an id baked in here
-- would attach these actions to whatever unrelated menu happened to hold that
-- number in the other environment.
INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT p.menu_id, 'isLmsAction', 'View and chase LMS actions', 1, 0, NOW()
  FROM tbl_menu p
 WHERE p.menu_name = 'LMS' AND p.parent_menu = 0
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isLmsAction');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT p.menu_id, 'isLmsChaseHandoff', 'Send chase lists to state managers', 1, 0, NOW()
  FROM tbl_menu p
 WHERE p.menu_name = 'LMS' AND p.parent_menu = 0
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isLmsChaseHandoff');

-- ─── 2. Grant to Admin (role_id = 2) ─────────────────────────────────
-- Revive first, then insert. role_menu_action soft-deletes (isDeleted = 1)
-- rather than removing the row, so a grant that was once revoked still SATISFIES
-- the NOT EXISTS guard — insert-only would leave it revoked forever and the
-- migration would report success. The UPDATE is the half that actually restores
-- a previously-revoked grant; the INSERT is the half that creates a new one.
UPDATE role_menu_action SET isDeleted = 0 WHERE role_id = 2 AND isDeleted = 1 AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'isLmsAction');

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0
  FROM menu_action ma
 WHERE ma.action_name = 'isLmsAction'
   AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);

UPDATE role_menu_action SET isDeleted = 0 WHERE role_id = 2 AND isDeleted = 1 AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'isLmsChaseHandoff');

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0
  FROM menu_action ma
 WHERE ma.action_name = 'isLmsChaseHandoff'
   AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);

-- ─── 3. Grant isLmsAction to Zonal Field Team (role_id = 12) ─────────
-- isLmsChaseHandoff is deliberately NOT granted here — see the two-key note in
-- the header. A state manager chases their own cities; they do not hand work to
-- their peers.
UPDATE role_menu_action SET isDeleted = 0 WHERE role_id = 12 AND isDeleted = 1 AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'isLmsAction');

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 12, ma.id, 0
  FROM menu_action ma
 WHERE ma.action_name = 'isLmsAction'
   AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 12 AND rma.menu_action_id = ma.id);

-- ─── 4. Verify ───────────────────────────────────────────────────────
-- Expect: 1, 1, 1, 1, 1.
SELECT 'isLmsAction action' AS what, COUNT(*) AS present FROM menu_action WHERE action_name = 'isLmsAction'
UNION ALL
SELECT 'isLmsChaseHandoff action', COUNT(*) FROM menu_action WHERE action_name = 'isLmsChaseHandoff'
UNION ALL
SELECT 'admin grant · isLmsAction', COUNT(*) FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.isDeleted = 0 AND rma.menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'isLmsAction')
UNION ALL
SELECT 'admin grant · isLmsChaseHandoff', COUNT(*) FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.isDeleted = 0 AND rma.menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'isLmsChaseHandoff')
UNION ALL
SELECT 'zonal grant · isLmsAction', COUNT(*) FROM role_menu_action rma WHERE rma.role_id = 12 AND rma.isDeleted = 0 AND rma.menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'isLmsAction');
