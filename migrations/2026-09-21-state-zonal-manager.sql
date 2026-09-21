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
--   to tbl_state and keeps tbl_city.state_user as the value everything reads:
--   saving a state's manager rewrites it on every city in that state, and every
--   city creation / state change / approval copies it from the state. None of
--   the ~20 readers of tbl_city.state_user change.
--
-- WHAT IT ADDS
--   tbl_state.state_user    the state's zonal manager (tbl_user.user_id).
--                           NULL only until someone assigns one — the States
--                           tab shows those rows as "Needs a manager".
--   tbl_state.state_status  1 active / 0 inactive. No UI toggle by decision
--                           (2026-09-21: EasyFix serves PAN India, every state
--                           stays active); kept for the future.
--   tbl_state.updated_by    tbl_user.user_id of the last person to change the
--                           row. NULL with a non-NULL updated_on = the backfill.
--   tbl_state.updated_on    when.
--   menu_action isStateEdit add / edit a state, assign or re-sync its manager.
--
-- LEGACY SAFETY
--   The five legacy services select tbl_state by named columns (state_id,
--   state_name, state_code, country_id). Four nullable / defaulted columns are
--   invisible to them. Same precedent as the tbl_city audit columns in
--   migrations/executed/2026-09-09-city-approval-flow.sql.
--
-- HOW TO APPLY
--   Run each statement in order. Plain ALTER / UPDATE / INSERT — no prepared
--   statements, no @-variables. Section 1 is NOT idempotent (MySQL has no ADD
--   COLUMN IF NOT EXISTS); re-running it errors with ER_DUP_FIELDNAME, which is
--   safe — skip it. Sections 2–4 are idempotent.
--
-- POST-APPLY
--   1. RESTART THE BACKEND. services/state.service.js memoises a SHOW COLUMNS
--      probe for tbl_state.state_user. A process started before this migration
--      has cached "absent": the States tab shows no managers and city creation
--      keeps the old majority guess, silently, until restart.
--   2. Users in roles 2 / 13 / 15 log out and back in so isStateEdit is read.
--   3. Open Manage Cities → States. Rows whose "Cities in sync" is not green
--      had cities split between managers before today; review and Re-sync.
--
-- APPLIED
--   QA: —
--   Production: —
-- ─────────────────────────────────────────────────────────────────────


-- ─── 1. Columns ──────────────────────────────────────────────────────

ALTER TABLE tbl_state ADD COLUMN state_user INT NULL;
ALTER TABLE tbl_state ADD COLUMN state_status TINYINT NOT NULL DEFAULT 1;
ALTER TABLE tbl_state ADD COLUMN updated_by INT NULL;
ALTER TABLE tbl_state ADD COLUMN updated_on DATETIME NULL;


-- ─── 2. Backfill the state's manager from its cities ─────────────────
-- For each state, the manager most of its cities already carry (ties broken by
-- the lower user_id, so a re-run picks the same one). Inactive cities do not
-- vote; active and pending do. This writes tbl_state ONLY — no city changes
-- here. Cities that disagree with their state keep their current manager until
-- someone saves or re-syncs that state, so nothing moves on release day.
-- Idempotent: only fills states that have no manager yet.

UPDATE tbl_state s SET s.state_user = (SELECT c.state_user FROM tbl_city c WHERE c.state_id = s.state_id AND c.state_user IS NOT NULL AND (c.city_status IS NULL OR c.city_status IN (1, 2)) GROUP BY c.state_user ORDER BY COUNT(*) DESC, c.state_user ASC LIMIT 1), s.updated_on = NOW() WHERE s.state_user IS NULL AND EXISTS (SELECT 1 FROM tbl_city c2 WHERE c2.state_id = s.state_id AND c2.state_user IS NOT NULL AND (c2.city_status IS NULL OR c2.city_status IN (1, 2)));


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
-- Expected: state_cols_present = 4; granted_roles = 3.
-- The third query is the review list: every state with how many of its cities
-- already match the backfilled manager. states_without_manager should be the
-- handful with no assigned city at all.

SELECT COUNT(*) AS state_cols_present FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_state' AND COLUMN_NAME IN ('state_user', 'state_status', 'updated_by', 'updated_on');

SELECT ma.id, ma.action_name, ma.menu_id, (SELECT COUNT(*) FROM role_menu_action rma WHERE rma.menu_action_id = ma.id AND rma.role_id IN (2, 13, 15) AND rma.isDeleted = 0) AS granted_roles FROM menu_action ma WHERE ma.action_name = 'isStateEdit';

SELECT s.state_id, s.state_name, u.user_name AS zonal_manager, (SELECT COUNT(*) FROM tbl_city c WHERE c.state_id = s.state_id) AS cities, (SELECT COUNT(*) FROM tbl_city c WHERE c.state_id = s.state_id AND c.state_user <=> s.state_user) AS cities_in_sync FROM tbl_state s LEFT JOIN tbl_user u ON u.user_id = s.state_user ORDER BY (s.state_user IS NULL) DESC, s.state_name;

SELECT COUNT(*) AS states_without_manager FROM tbl_state WHERE state_user IS NULL;
