-- Default User (role_id = 1) had isEscalatedJob / isCallInfo / isBookNewCall /
-- ef-QuickSight granted in role_menu_action (legacy/manual data — no migration
-- ever granted these to role 1; only Admin/role 2 was seeded with them). The
-- CRM already HIDES these buttons unless hasAction() is true, so the buttons
-- showed for Default User AND the BE endpoints (admin-scoped) denied the click
-- → "insufficient permissions". Soft-revoke the four grants so the buttons
-- hide for Default User. Soft-delete (isDeleted=1) matches applyMenuActionIds'
-- upsert/restore semantics; safe to re-run. 60s permission cache, so effect is
-- near-immediate without a restart.
UPDATE role_menu_action SET isDeleted = 1 WHERE role_id = 1 AND isDeleted = 0 AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'isEscalatedJob');
UPDATE role_menu_action SET isDeleted = 1 WHERE role_id = 1 AND isDeleted = 0 AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'isCallInfo');
UPDATE role_menu_action SET isDeleted = 1 WHERE role_id = 1 AND isDeleted = 0 AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'isBookNewCall');
UPDATE role_menu_action SET isDeleted = 1 WHERE role_id = 1 AND isDeleted = 0 AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'ef-QuickSight');
