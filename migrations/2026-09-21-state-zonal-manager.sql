-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-21 — Zonal manager owned by the STATE (Manage Cities → States)
--
-- WHY
--   A city's zonal manager is tbl_city.state_user, and every consumer reads it
--   there: the jobs zonalManagerId filter, eight QuickSight reports, Manage
--   Pincodes, technician-registration scoping and LMS action ownership. But it
--   was set city by city — by hand, or by services/pincode.service.js GUESSING
--   the majority manager of nearby cities when a city was created
--   automatically. Manage Cities' own Add City set nothing at all.
--
--   The business rule is one zonal manager per state. This moves the control
--   to tbl_state while tbl_city.state_user stays the value everything reads:
--   assigning a state's manager on the States tab rewrites it on every city of
--   that state, and every city creation / state change / approval copies it
--   from the state. None of the ~20 readers of tbl_city.state_user change.
--
-- DECIDED 2026-09-22 (Priyanka)
--   * Every state starts with zonal manager 121. Operators then pick states on
--     the States tab and assign the real manager; only then do that state's
--     cities change. Nothing is copied onto cities by this file.
--   * State rows were cleaned up by hand beforehand. This file does NOT move,
--     merge or rename anything.
--   * Active / inactive is set directly on tbl_state.state_status (1 / 0). The
--     app works with ACTIVE states only: the States tab, every state picker and
--     manager assignment.
--
-- WHAT IT ADDS
--   tbl_state.state_user    the state's zonal manager (tbl_user.user_id).
--                           DEFAULT 121 — existing rows are filled with 121 by
--                           the ALTER itself, and so is any state a legacy
--                           service or automatic path inserts later.
--   tbl_state.state_status  1 active / 0 inactive, DEFAULT 1.
--   tbl_state.updated_by    tbl_user.user_id of the last person to change the
--                           row. NULL = never changed by a person.
--   tbl_state.updated_on    when.
--   tbl_state.state_type    'State' or 'UT', shown under the name on the States
--                           tab. Filled for the 36 official names; any other
--                           row stays NULL until someone sets it.
--   menu_action isStateEdit add / edit a state, assign or re-sync its manager.
--
-- LEGACY SAFETY
--   The five legacy services select tbl_state by named columns (state_id,
--   state_name, state_code, country_id). New nullable / defaulted columns are
--   invisible to them. Same precedent as the tbl_city audit columns in
--   migrations/executed/2026-09-09-city-approval-flow.sql.
--
-- HOW TO APPLY
--   Run each statement in order. Section 1 is NOT idempotent (MySQL has no ADD
--   COLUMN IF NOT EXISTS); re-running it errors with ER_DUP_FIELDNAME, which is
--   safe — skip it. Sections 2–4 are idempotent.
--
-- POST-APPLY
--   1. RESTART THE BACKEND. services/state.service.js memoises SHOW COLUMNS
--      probes for these columns. A process started before this migration has
--      cached "absent" and keeps the States tab read-only until restart.
--   2. Users in roles 2 / 13 / 15 log out and back in so isStateEdit is read.
--   3. Set state_status = 0 on any state that should be hidden.
--
-- APPLIED
--   QA: —
--   Production: —
-- ─────────────────────────────────────────────────────────────────────


-- ─── 0. Check first (read-only) ──────────────────────────────────────
-- User 121 becomes every state's zonal manager. Expect ONE row with
-- user_status = 1 and an internal role (2, 3, 5, 7, 11, 12, 13, 15, 17, 18).
-- If not, the States tab flags every state "Left organisation" until reassigned.

SELECT u.user_id, u.user_name, u.user_status, u.user_role, r.role_name
  FROM tbl_user u LEFT JOIN tbl_role r ON r.role_id = u.user_role
 WHERE u.user_id = 121;


-- ─── 1. Columns ──────────────────────────────────────────────────────

ALTER TABLE tbl_state ADD COLUMN state_user INT NULL DEFAULT 121;
ALTER TABLE tbl_state ADD COLUMN state_status TINYINT NOT NULL DEFAULT 1;
ALTER TABLE tbl_state ADD COLUMN updated_by INT NULL;
ALTER TABLE tbl_state ADD COLUMN updated_on DATETIME NULL;
ALTER TABLE tbl_state ADD COLUMN state_type VARCHAR(5) NULL;


-- ─── 2. State or UT — by official name ───────────────────────────────
-- 28 States and 8 Union Territories. Only rows spelled exactly like the
-- official name are typed; anything else stays NULL (set it on the States tab).

UPDATE tbl_state SET state_type = 'UT'
 WHERE TRIM(state_name) IN ('Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu',
                            'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry');

UPDATE tbl_state SET state_type = 'State'
 WHERE TRIM(state_name) IN ('Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat',
                            'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh',
                            'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab',
                            'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh',
                            'Uttarakhand', 'West Bengal');


-- ─── 3. The permission ───────────────────────────────────────────────
-- Under the Manage Cities menu, looked up by url exactly as isCityApprove was
-- (never hard-code the menu_id).

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on) SELECT (SELECT menu_id FROM tbl_menu WHERE url = 'city' AND menu_status = 1 ORDER BY menu_id ASC LIMIT 1), 'isStateEdit', 'Add / Edit State and Zonal Manager', 1, 0, NOW() WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isStateEdit');


-- ─── 4. Grants: the isCityApprove set ────────────────────────────────
-- Decided 2026-09-21: whoever approves cities assigns state managers — Admin
-- (2), Project Manager (13), Admin Supply (15). Change later via Manage Role.

UPDATE role_menu_action SET isDeleted = 0 WHERE role_id IN (2, 13, 15) AND isDeleted = 1 AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'isStateEdit');

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted) SELECT r.role_id, ma.id, 0 FROM (SELECT 2 AS role_id UNION ALL SELECT 13 UNION ALL SELECT 15) r JOIN menu_action ma ON ma.action_name = 'isStateEdit' WHERE NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = r.role_id AND rma.menu_action_id = ma.id);


-- ─── 5. Verify (read-only) ───────────────────────────────────────────
-- Expected: state_cols_present = 5; granted_roles = 3; every state shows
-- zonal_manager_id 121 and a type (or NULL for a non-official spelling).

SELECT COUNT(*) AS state_cols_present FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_state' AND COLUMN_NAME IN ('state_user', 'state_status', 'updated_by', 'updated_on', 'state_type');

SELECT ma.id, ma.action_name, ma.menu_id, (SELECT COUNT(*) FROM role_menu_action rma WHERE rma.menu_action_id = ma.id AND rma.role_id IN (2, 13, 15) AND rma.isDeleted = 0) AS granted_roles FROM menu_action ma WHERE ma.action_name = 'isStateEdit';

SELECT s.state_id, s.state_name, s.state_type, s.state_status, s.state_user AS zonal_manager_id, u.user_name AS zonal_manager,
       (SELECT COUNT(*) FROM tbl_city c WHERE c.state_id = s.state_id) AS cities
  FROM tbl_state s LEFT JOIN tbl_user u ON u.user_id = s.state_user
 ORDER BY s.state_status DESC, s.state_type, s.state_name;
