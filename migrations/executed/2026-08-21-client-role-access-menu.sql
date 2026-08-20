-- CRM sidebar entry for Client Role Access (Easyfix_CRM_UI /clients/access-roles).
--
-- WHAT THIS SCREEN IS. The tier above Manage Clients → Contacts: Contacts sets
-- ONE SPOC's portal access, this sets what a ROLE grants by default, which is
-- what every SPOC holding that role inherits when they have no override. It
-- reads GET /api/admin/clients/contacts/access-roles and writes
-- PUT /api/admin/clients/contacts/access-roles/:roleId, both of which already
-- exist on routes/admin/clients.js and are guarded by requireClientEdit.
--
-- WHY NO NEW ACTION KEY. The screen is gated on `isClientEdit` — deliberately
-- the SAME key as the Contacts tab and the same key the PUT enforces, because
-- "may change one SPOC's access" and "may change the default every SPOC
-- inherits" are the same authority over the same data. `isClientEdit` was
-- seeded by migrations/executed/2026-05-25-add-client-write-actions.sql and is
-- already granted to Admin, so this migration adds the MENU row only. A user
-- who holds the menu but not isClientEdit gets the screen read-only.
--
-- Apply after 2026-08-21-client-role-surface-access.sql (which creates the
-- table the screen edits). Every statement is idempotent — a repeated run
-- changes nothing.

-- ── 1. The sidebar leaf ──────────────────────────────────────────────
--
-- Placed next to the existing Manage Clients row rather than at a hard-coded
-- parent id: `url = 'client'` is the row the CRM's URL_MAP resolves to
-- /clients, and prod and QA do not agree on menu ids. If that row is itself a
-- child (the usual shape: a "Clients" parent with leaves under it) the new leaf
-- becomes its SIBLING; if Clients is a top-level leaf, the new row becomes its
-- CHILD and step 2 marks it as a parent.
--
-- `sequence` is derived from the Manage Clients row (+0.0001) so the leaf sorts
-- immediately after it whatever that row's sequence happens to be. A tie, if
-- the column rounds, only affects ordering between two adjacent rows.
--
-- The anchor is matched on url FIRST and menu_name only as a fallback, because
-- the 2026-05-25 client-actions migration had to hedge the same way (prod and
-- QA have been seen with 'client', 'clients' and a 'Manage Clients' name).
-- Status is not filtered — a temporarily hidden Clients menu should still
-- position the leaf — but active rows are preferred when several match.
INSERT INTO tbl_menu (
  menu_name, parent_menu, menu_depth, has_child, url,
  menu_status, sequence, icons, action_name
)
SELECT 'Client Role Access',
       CASE WHEN c.parent_menu > 0 THEN c.parent_menu ELSE c.menu_id END,
       CASE WHEN c.parent_menu > 0 THEN c.menu_depth ELSE c.menu_depth + 1 END,
       0,
       'clientRoleAccess',
       1,
       COALESCE(c.sequence, 0) + 0.0001,
       'fa-circle',
       'clientRoleAccess'
  FROM tbl_menu c
 WHERE (c.url IN ('client', 'clients') OR c.menu_name IN ('Clients', 'Manage Client', 'Manage Clients'))
   AND NOT EXISTS (
     SELECT 1 FROM tbl_menu x WHERE x.url = 'clientRoleAccess'
   )
 ORDER BY (c.url IN ('client', 'clients')) DESC, c.menu_status DESC, c.menu_id ASC
 LIMIT 1;

-- ── 2. Keep the parent flagged as having children ────────────────────
-- Only matters in the second shape above (Clients was a top-level leaf and
-- has just acquired its first child). A no-op otherwise.
UPDATE tbl_menu p
  JOIN tbl_menu c ON c.url = 'clientRoleAccess' AND c.parent_menu = p.menu_id
   SET p.has_child = 1
 WHERE p.has_child <> 1;

-- ── 3. Grant the leaf to Admin (role_id = 2) ─────────────────────────
-- Same CASE-guarded CSV append the other menu migrations use: safe on NULL,
-- safe on empty, and byte-for-byte stable on a repeated run. Other roles are
-- granted from Settings → Manage Role, which is where menu grants belong.
UPDATE tbl_role r
  JOIN tbl_menu m ON m.url = 'clientRoleAccess'
   SET r.menu_ids = CASE
     WHEN r.menu_ids IS NULL OR r.menu_ids = '' THEN CAST(m.menu_id AS CHAR)
     WHEN FIND_IN_SET(m.menu_id, r.menu_ids) > 0 THEN r.menu_ids
     ELSE CONCAT(r.menu_ids, ',', m.menu_id)
   END
 WHERE r.role_id = 2;

-- ── 4. Verify ────────────────────────────────────────────────────────
-- Expected after either the first or any repeated run:
--   'clientRoleAccess menu leaf'      = 1  (0 means step 1 found no Clients row
--                                           to anchor to — check tbl_menu for
--                                           the row the CRM maps to /clients)
--   'Admin clientRoleAccess grant'    = 1
--   'isClientEdit action'             = 1  (seeded 2026-05-25 — 0 means that
--                                           migration has not run here and the
--                                           screen will be read-only for
--                                           everyone until it does)
--   'Admin isClientEdit grant'        = 1
SELECT 'clientRoleAccess menu leaf' AS what, COUNT(*) AS present
  FROM tbl_menu WHERE url = 'clientRoleAccess'
UNION ALL
SELECT 'Admin clientRoleAccess grant', COUNT(*)
  FROM tbl_role r
  JOIN tbl_menu m ON m.url = 'clientRoleAccess'
 WHERE r.role_id = 2 AND FIND_IN_SET(m.menu_id, COALESCE(r.menu_ids, '')) > 0
UNION ALL
SELECT 'isClientEdit action', COUNT(*)
  FROM menu_action WHERE action_name = 'isClientEdit'
UNION ALL
SELECT 'Admin isClientEdit grant', COUNT(*)
  FROM role_menu_action rma
  JOIN menu_action ma ON ma.id = rma.menu_action_id
 WHERE rma.role_id = 2
   AND rma.isDeleted = 0
   AND ma.action_name = 'isClientEdit';
