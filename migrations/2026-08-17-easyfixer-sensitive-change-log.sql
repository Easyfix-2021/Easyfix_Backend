-- ─────────────────────────────────────────────────────────────────────
-- 2026-08-17 — Easyfixer SENSITIVE change log (mobile + bank)
--
-- WHAT
--   • ONE new EasyFix-owned table, `tbl_easyfixer_sensitive_change_log`,
--     that records every change to the two technician fields an attacker
--     would actually want: `tbl_easyfixer.efr_no` (which IS the login
--     identity — see services/tech-auth.service.js::resolveByEfrNo) and
--     the payout destination in `tbl_easyfixer_bank_details`.
--   • Seeds the isEasyfixerMobileUpdate + isEasyfixerBankUpdate menu_actions, granting
--     Admin (role 2) ONLY.
--
-- SHARED-DB RULE — THIS IS THE DOCUMENTED EXCEPTION
--   CLAUDE.md forbids altering the shared `easyfix_core` schema, because
--   five legacy services read it. The carve-out it names is an
--   EASYFIX-OWNED NEW TABLE THAT NO LEGACY SERVICE REFERENCES — the same
--   carve-out already used by `tbl_pincode` (2026-05-01), tbl_plivo_call_log
--   (2026-06-19), tbl_ai_call_session (2026-07-06), tbl_user_allowed_stages
--   (2026-07-29) and tbl_job_conference (2026-08-04). This table is written
--   ONLY by services/easyfixer-sensitive-change.service.js in this backend
--   and read by nothing legacy. NOTHING existing is altered by this file —
--   no ALTER on tbl_easyfixer, none on tbl_easyfixer_bank_details.
--
-- ══════════════════════════════════════════════════════════════════════
-- ACCOUNT NUMBERS ARE STORED MASKED. THAT IS THE WHOLE POINT.
-- ══════════════════════════════════════════════════════════════════════
--
-- `old_value` / `new_value` hold the LAST FOUR DIGITS ONLY for bank changes
-- (written as "••••1234" by the service; masking happens in recordChange(),
-- not at the call site, so a caller cannot bypass it by passing the full
-- number).
--
-- This log exists to answer ONE question — "who redirected this
-- technician's money, when, on whose authority, and did the technician
-- consent?" — and last-four answers it completely: an investigator can
-- match a log row against the account on the payout, and can see that the
-- destination changed at all. It is NOT a second copy of the payment
-- instructions. A full account number here would create a searchable,
-- append-only, never-purged ledger of every technician's bank account in a
-- table with no masking layer in front of it, on the losing side of every
-- trade-off: it would not make fraud any more detectable, and it would make
-- a single read of this one table worth more to an attacker than the
-- verified live row it audits (which at least sits behind the CRM's
-- permission model). Last-four is sufficient evidence; a full number is
-- only additional liability.
--
-- The MOBILE change type stores the number IN FULL, deliberately and
-- asymmetrically: recovering a hijacked login means proving which number
-- the account was moved FROM and TO, and a masked pair cannot do that.
--
-- TIMESTAMPS: `created_at` is written by the app as new Date(); the pool's
-- +05:30 session timezone (db.js) stores the IST wall clock verbatim. NO
-- DEFAULT CURRENT_TIMESTAMP — the server clock is UTC and would silently mix
-- two timezones into one column (same reasoning as
-- executed/2026-08-03-create-tbl-user-personal-details.sql and
-- executed/2026-08-04-create-tbl-job-conference.sql).
--
-- ── column notes ─────────────────────────────────────────────────────────
-- change_type        'mobile' | 'bank'. Plain VARCHAR, not ENUM — adding a
--                    third sensitive field later must not need an ALTER on a
--                    table the shared DB rule says we should stop touching.
-- old_value          Previous value; NULL when there was none (first-time
--                    bank addition). Masked for 'bank' (see above).
-- new_value          The value now stored. Masked for 'bank'.
-- changed_by_user_id tbl_user.user_id of the OPERATOR, when ops did it via
--                    the CRM. NULL for app-initiated changes, where the
--                    actor is the technician themselves (identified by
--                    efr_id) and there is no tbl_user row to point at.
-- changed_by_source  'crm' | 'app'. Kept even though changed_by_user_id
--                    already implies it: "NULL user" and "the technician did
--                    this from the app" are different claims, and only the
--                    explicit column can distinguish an app change from a CRM
--                    change whose actor was lost.
-- reason             The operator's mandatory free-text justification. This
--                    is a REAL control on the mobile path, not decoration:
--                    that flow has no OTP (see below), so the reason plus
--                    this row are what an audit reads.
-- verification_result The vendor's response summary for bank changes (the
--                    account-holder name aadhaarkyc.io returned, and the
--                    verified flag). NULL for mobile changes. Text, not
--                    JSON-typed — legacy MySQL compatibility, and nothing
--                    queries inside it.
-- otp_verified       1 when the technician passed the WhatsApp OTP before
--                    the change. ALWAYS 1 for bank changes (they are gated
--                    on it) and ALWAYS 0 for CRM mobile changes.
--
--                    ⚠ THE 0 ON MOBILE ROWS IS NOT A GAP. Ops changes a
--                    technician's number precisely BECAUSE the technician
--                    lost it: an OTP to the old number reaches a dead SIM,
--                    and an OTP to the new number proves only that whoever
--                    asked for the change is holding the phone they just
--                    named. Neither is consent. The controls on that path
--                    are the permission key, the mandatory reason, and this
--                    row. See the comment on PATCH /:id/mobile in
--                    routes/admin/easyfixers.js.
-- ip_address         req.ip of the operator. VARCHAR(64) fits IPv6 and
--                    v4-mapped forms.
--
-- INDEXES
--   (efr_id, created_at)      — "show me this technician's history", the
--                               per-technician audit panel and any
--                               investigation into one account.
--   (change_type, created_at) — "show me every bank change last week", the
--                               fraud sweep across all technicians.
--
-- HOW TO APPLY
--   Run each statement below in order. Plain CREATE / INSERT / UPDATE — no
--   prepared statements, no @-variables, no PREPARE/EXECUTE, nothing
--   MariaDB-specific. Works identically in MySQL CLI, DataGrip, DBeaver and
--   Workbench, and each statement passes or fails on its own.
--
-- IDEMPOTENCY
--   Fully re-runnable. The CREATE is IF NOT EXISTS; the permission seed uses
--   NOT EXISTS subqueries plus a soft-delete-reactivate, exactly as
--   executed/2026-06-11-easyfixer-profile-update-magic-link.sql does.
--
-- POST-APPLY
--   Any logged-in operator must log out and back in (or wait 60s for the
--   permissions cache in services/role.service.js to expire) before the new
--   grants take effect.
-- ─────────────────────────────────────────────────────────────────────


-- ─── 1. The audit table ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tbl_easyfixer_sensitive_change_log (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  efr_id              INT          NOT NULL,
  change_type         VARCHAR(32)  NOT NULL,
  old_value           TEXT         NULL,
  new_value           TEXT         NULL,
  changed_by_user_id  INT          NULL,
  changed_by_source   VARCHAR(16)  NOT NULL,
  reason              VARCHAR(500) NULL,
  verification_result TEXT         NULL,
  otp_verified        TINYINT(1)   NOT NULL DEFAULT 0,
  ip_address          VARCHAR(64)  NULL,
  created_at          DATETIME     NOT NULL,
  KEY idx_efr_sensitive_efr_created (efr_id, created_at),
  KEY idx_efr_sensitive_type_created (change_type, created_at)
);


-- ─── 2. Permission seeds: isEasyfixerMobileUpdate + isEasyfixerBankUpdate ──
-- NEW, DISTINCT action keys — deliberately NOT `isEdit`.
--
-- `isEdit` on Manage Easyfixers is broad and widely granted (it covers name,
-- address, skills, activation). These endpoints are account takeover and
-- payment redirection: changing efr_no moves who can log in as this
-- technician, and changing the bank row moves where their money lands.
-- Folding them into `isEdit` would silently hand that to every role that can
-- correct a spelling mistake.
--
-- TWO keys rather than one combined key, because the two capabilities are not
-- the same job. Finance may need to correct a payout account without ever
-- being able to change who logs in as a technician; a support operator may
-- need the reverse. One key forces an all-or-nothing grant, which pushes ops
-- toward over-granting exactly where over-granting is most expensive.
--
-- Both granted to Admin (role 2) ONLY. Finance (7) and Admin Supply (15) are
-- the plausible additions; add them through Manage Roles (or a follow-up
-- migration) if ops asks — starting narrow is recoverable, starting broad is
-- not.

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM tbl_menu
         WHERE url = 'easyfixer' AND menu_status = 1
         ORDER BY menu_id ASC LIMIT 1),
       'isEasyfixerMobileUpdate',
       'Update Easyfixer Mobile Number',
       1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isEasyfixerMobileUpdate');

INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT (SELECT menu_id FROM tbl_menu
         WHERE url = 'easyfixer' AND menu_status = 1
         ORDER BY menu_id ASC LIMIT 1),
       'isEasyfixerBankUpdate',
       'Update Easyfixer Bank Details',
       1, 0, NOW()
 WHERE NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isEasyfixerBankUpdate');

UPDATE role_menu_action
   SET isDeleted = 0
 WHERE role_id IN (2)
   AND isDeleted = 1
   AND menu_action_id IN (
     SELECT id FROM menu_action
      WHERE action_name IN ('isEasyfixerMobileUpdate', 'isEasyfixerBankUpdate')
   );

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT r.role_id, ma.id, 0
  FROM (SELECT 2 AS role_id) r
  JOIN menu_action ma
    ON ma.action_name IN ('isEasyfixerMobileUpdate', 'isEasyfixerBankUpdate')
 WHERE NOT EXISTS (
   SELECT 1 FROM role_menu_action rma
    WHERE rma.role_id = r.role_id AND rma.menu_action_id = ma.id
 );


-- ─── 3. Hand verification (read-only) ────────────────────────────────
--
-- 1. The table exists with both indexes:
-- SHOW CREATE TABLE tbl_easyfixer_sensitive_change_log;
--
-- 2. The action seeded and is granted to exactly one role:
-- SELECT ma.id, ma.action_name, ma.name, (SELECT COUNT(*) FROM role_menu_action rma WHERE rma.menu_action_id = ma.id AND rma.isDeleted = 0) AS granted_roles FROM menu_action ma WHERE ma.action_name IN ('isEasyfixerMobileUpdate', 'isEasyfixerBankUpdate');
--
-- 3. NOTHING legacy changed — these two must read exactly as they did before:
-- SHOW CREATE TABLE tbl_easyfixer_bank_details;
-- SELECT COUNT(*) FROM tbl_easyfixer;
--
-- 4. After the first CRM bank change, the masking must hold. This must show
--    "••••" values in old_value/new_value — if a full account number ever
--    appears here, recordChange() has been bypassed and that is a defect:
-- SELECT id, efr_id, change_type, old_value, new_value, changed_by_user_id, changed_by_source, otp_verified, created_at FROM tbl_easyfixer_sensitive_change_log WHERE change_type = 'bank' ORDER BY id DESC LIMIT 20;
--
-- 5. The fraud sweep this table exists for — every sensitive change, newest
--    first, with the operator named:
-- SELECT l.created_at, l.change_type, l.efr_id, u.user_name AS changed_by, l.changed_by_source, l.otp_verified, l.reason FROM tbl_easyfixer_sensitive_change_log l LEFT JOIN tbl_user u ON u.user_id = l.changed_by_user_id ORDER BY l.id DESC LIMIT 50;
