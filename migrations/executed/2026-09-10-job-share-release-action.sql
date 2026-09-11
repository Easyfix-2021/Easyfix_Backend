-- Ops release for a delegated job — its own action key.
--
-- WHY NOT REUSE isJobStatusChange. The release endpoint was first gated on it
-- because a new action that nobody has seeded denies EVERYONE, Admin included:
-- src/lib/permissions.ts in the CRM removed its Admin short-circuit on purpose,
-- so `hasAction` is false whenever the key is absent from menu_action. That is
-- how canManageJobCharges was invisible to every user for a month.
--
-- The answer is the seed, not a borrowed key. Reusing isJobStatusChange would
-- have meant anyone who can move a job's status can also seize a job a
-- technician has delegated — a different act, on a different person's work, and
-- the only way to break a share once the delegate has started. The CRM already
-- gates its button on `isJobShareRelease`; this makes the server agree.
--
-- Mirrors isJobStatusChange exactly: same menu (3, "Manage Jobs"), same grant
-- (role 2), so an operator who can change a job's status today can release a
-- share today, and the key can be narrowed later without a code change.
--
-- Re-runnable: every statement is guarded, so applying it twice is a no-op.

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT 3, 'isJobShareRelease', 'Release a delegated job back to its technician', 1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isJobShareRelease');

UPDATE role_menu_action SET isDeleted = 0 WHERE isDeleted = 1 AND role_id = 2 AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'isJobShareRelease');

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0
  FROM menu_action ma
 WHERE ma.action_name = 'isJobShareRelease'
   AND NOT EXISTS (SELECT 1 FROM role_menu_action r WHERE r.role_id = 2 AND r.menu_action_id = ma.id);
