-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-29 — Move the Team Roster menu under HRMS (owner request).
--
-- 02 seeded it top-level (parent_menu 0). This re-parents the SAME row under
-- HRMS (menu_id 11), depth 2, sorted after every existing HRMS child. The
-- menu_id does not change, so role grants (tbl_role.menu_ids,
-- role_menu_action) and new.crm.visible.menu.ids keep working untouched.
-- A role must also hold HRMS (11) in menu_ids for the child to show — Admin does.
--
-- Idempotent: the WHERE matches only while the row is still top-level.
-- The MAX is read through a derived table (JOIN) — a plain subquery on the
-- UPDATE target is MySQL error 1093.
-- ─────────────────────────────────────────────────────────────────────

UPDATE tbl_menu m JOIN (SELECT COALESCE(MAX(sequence), 8) AS mx FROM tbl_menu WHERE parent_menu = 11) s SET m.parent_menu = 11, m.menu_depth = 2, m.sequence = s.mx + 0.0001, m.icons = 'fa-circle' WHERE m.url = 'teamRoster' AND m.parent_menu = 0;

SELECT 'Team Roster is a depth-2 child of HRMS (11)' AS what, COUNT(*) AS ok FROM tbl_menu WHERE url = 'teamRoster' AND parent_menu = 11 AND menu_depth = 2
UNION ALL SELECT 'sorts after every other HRMS child', COUNT(*) FROM tbl_menu n WHERE n.url = 'teamRoster' AND n.sequence > (SELECT MAX(x.sequence) FROM (SELECT sequence, url FROM tbl_menu WHERE parent_menu = 11) x WHERE x.url <> 'teamRoster');
