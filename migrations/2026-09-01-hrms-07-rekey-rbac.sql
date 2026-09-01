-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-01 — Admin Actions → Re-Key Encrypted Fields: the two action keys
--
-- Pairs with 2026-09-01-hrms-06-recovery-key-store.sql (the table),
-- services/field-rekey.service.js and routes/admin/field-rekey.js.
--
-- Seeds TWO menu_action keys on the EXISTING "Admin Action" hub leaf
-- (tbl_menu.url = 'adminAction'), granted to role_id 2 (Admin) ONLY:
--
--   isFieldRekeyRun        POST /api/admin/field-rekey/dry-run
--                          POST /api/admin/field-rekey/run
--   isRecoveryKeyManage    POST /api/admin/field-rekey/recovery-key
--                          GET  /api/admin/field-rekey/recovery-key
--
-- ── WHY NO NEW MENU LEAF, AND THEREFORE ONLY TWO ARTIFACTS ──────────────
-- The usual "four artifacts or the page is unreachable" checklist (leaf,
-- action key, role grants, new.crm.visible.menu.ids) applies to a page with
-- its own sidebar entry. This is not one: it is a CARD on the existing
-- /admin-actions hub, the same way Validate Flows, Build Skill Matrix and
-- Delete/Restore are. The 'adminAction' leaf is already seeded, already in
-- Admin's tbl_role.menu_ids CSV and already on the visible-menu allowlist, so
-- touching any of those here would be a no-op at best and a duplicate CSV
-- entry at worst. Only the two keys are new. The verification block still
-- CHECKS the leaf's reachability, because if it is not reachable the card
-- cannot be clicked no matter what these grants say.
--
-- ── WHY TWO KEYS AND NOT ONE ────────────────────────────────────────────
-- Running a re-key and registering a recovery key are different privileges
-- over different material:
--
--   isFieldRekeyRun      re-wraps every protected value's data key. On the
--                        `recover` and `reseal` paths the operator PASTES A
--                        RECOVERY PRIVATE KEY to do it. This is the most
--                        sensitive operation in the system.
--   isRecoveryKeyManage  registers the PUBLIC half of a NEW recovery keypair,
--                        which decides what future rows can be opened with in
--                        an emergency. Nothing secret passes, but whoever holds
--                        this key decides who holds the break-glass key — and
--                        that is a governance decision, not an operational one.
--
-- Granting them separately means the person who can rotate the operational key
-- need not be the person who can redirect the break-glass path, and the split
-- is visible in Manage Roles rather than implied.
--
-- ── WHY role_id 2 ONLY, AND WHY THE KEY IS NOT MERELY "role Admin" ──────
-- Narrow is recoverable; ops widen it in Manage Roles once they decide who
-- owns this. And an ACTION KEY rather than a bare role check, because
-- /api/admin/* already admits ten roles: a role-only gate would hand the most
-- sensitive endpoint in this backend to Business Development and Zonal Field
-- Team by default. requireAction() fails CLOSED — an action_name absent from
-- menu_action is indistinguishable from one that was revoked, with no Admin
-- bypass — so THESE ROWS are what make the endpoints reachable at all.
--
-- ── REVIVE THEN INSERT — NOT OPTIONAL ───────────────────────────────────
-- role_menu_action SOFT-deletes (isDeleted = 1). An insert-only migration
-- skips a previously revoked grant via its NOT EXISTS guard and leaves it
-- revoked forever, so a re-run after someone unticked the box in Manage Roles
-- would silently do nothing. The UPDATE before each INSERT is what fixes that.
-- Idiom copied verbatim from
-- migrations/executed/2026-07-09-seed-payout-requests-rbac.sql.
--
-- POST-APPLY
--   Operators must log out and back in — actionPermissions are resolved at
--   login, so a running session keeps the old set.
--
-- IDEMPOTENT. Every write is NOT EXISTS guarded; a second run is a no-op.
-- Steps 1 and 2 are read-only. Read them before running step 3 onward.
-- ─────────────────────────────────────────────────────────────────────


-- ─── 1. Dry run: the hub leaf these keys attach to (read-only) ───────
-- Expect exactly one row. ZERO rows means 'adminAction' is not seeded on this
-- host and steps 3-4 below will insert nothing — fix that first, or the card
-- has nowhere to live.
SELECT menu_id, menu_name, parent_menu, menu_depth, url, menu_status FROM tbl_menu WHERE url = 'adminAction';


-- ─── 2. Dry run: are the keys already here? Expect 0 rows first time ─
SELECT id, menu_id, action_name, name, status, delete_status FROM menu_action WHERE action_name IN ('isFieldRekeyRun', 'isRecoveryKeyManage');


-- ─── 3. The two action keys ──────────────────────────────────────────
-- Driven off tbl_menu rather than a scalar subquery, so a host missing the
-- 'adminAction' leaf inserts NOTHING instead of inserting a key with a NULL
-- menu_id that Manage Roles could never display.
INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isFieldRekeyRun', 'Re-Key Encrypted Fields (Rotate / Recover / Re-Seal)', 1, 0, NOW() FROM tbl_menu m WHERE m.url = 'adminAction' AND NOT EXISTS (SELECT 1 FROM menu_action ma WHERE ma.action_name = 'isFieldRekeyRun');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT m.menu_id, 'isRecoveryKeyManage', 'Manage the Field Encryption Recovery Key', 1, 0, NOW() FROM tbl_menu m WHERE m.url = 'adminAction' AND NOT EXISTS (SELECT 1 FROM menu_action ma WHERE ma.action_name = 'isRecoveryKeyManage');


-- ─── 4. Grant both to Admin (role_id 2) — revive, then insert ────────
UPDATE role_menu_action SET isDeleted = 0 WHERE role_id = 2 AND isDeleted = 1 AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name IN ('isFieldRekeyRun', 'isRecoveryKeyManage'));

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0 FROM menu_action ma WHERE ma.action_name IN ('isFieldRekeyRun', 'isRecoveryKeyManage') AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);


-- ─── 5. Verify ───────────────────────────────────────────────────────
-- Every `ok` must be as noted. A 0 on either grant row means the endpoints
-- return 403 to everybody, including Admin.
SELECT 'both action keys seeded (expect 2)' AS what, COUNT(*) AS ok FROM menu_action WHERE action_name IN ('isFieldRekeyRun', 'isRecoveryKeyManage')
UNION ALL SELECT 'keys hang off the adminAction leaf (expect 2)', COUNT(*) FROM menu_action ma JOIN tbl_menu m ON m.menu_id = ma.menu_id WHERE ma.action_name IN ('isFieldRekeyRun', 'isRecoveryKeyManage') AND m.url = 'adminAction'
UNION ALL SELECT 'admin holds both keys (expect 2)', COUNT(*) FROM role_menu_action rma JOIN menu_action ma ON ma.id = rma.menu_action_id WHERE rma.role_id = 2 AND rma.isDeleted = 0 AND ma.action_name IN ('isFieldRekeyRun', 'isRecoveryKeyManage')
UNION ALL SELECT 'nobody else holds them (expect 0)', COUNT(*) FROM role_menu_action rma JOIN menu_action ma ON ma.id = rma.menu_action_id WHERE rma.role_id <> 2 AND rma.isDeleted = 0 AND ma.action_name IN ('isFieldRekeyRun', 'isRecoveryKeyManage')
UNION ALL SELECT 'admin can reach the Admin Actions hub (expect 1)', COUNT(*) FROM tbl_role r JOIN tbl_menu m ON m.url = 'adminAction' WHERE r.role_id = 2 AND FIND_IN_SET(m.menu_id, COALESCE(r.menu_ids, '')) > 0;
