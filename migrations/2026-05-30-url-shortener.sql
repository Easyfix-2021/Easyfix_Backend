-- ─────────────────────────────────────────────────────────────────────
-- 2026-05-30 — In-house URL shortener (`tbl_url_shortener`)
--
-- WHAT
--   • Introduces an EasyFix-owned table that maps short codes to long
--     URLs. Used initially by the Customer Magic-Link Completion flow
--     so the WhatsApp body variable {{3}} of the `confirm_order`
--     template carries a short URL instead of a 200+ char JWT URL.
--     Generalised — `purpose` column lets future flows reuse the same
--     surface (e.g. invoice links, escalations).
--
--   • Brand-new table, no legacy service touches it — explicit
--     carve-out per EasyFix_Backend/CLAUDE.md "no schema alteration
--     of shared tables" rule.
--
-- HOW TO APPLY
--   Run each statement below in order. Plain CREATE / INDEX — no
--   prepared statements, no @-variables, no PREPARE / EXECUTE.
--   Works in MySQL CLI, DataGrip, DBeaver, Workbench.
--
-- IDEMPOTENCY
--   NOT idempotent — re-running surfaces "Table already exists" /
--   "Duplicate key name" errors so you can see exactly which piece is
--   already in place. Stop only on errors you don't recognise.
--
-- COLUMN NOTES
--   short_code      VARCHAR(16) PK — generator emits 8-char base62 by
--                   default; 16-char headroom covers future namespacing
--                   (e.g. `bk_<8>` prefixed codes for bookings).
--   long_url        TEXT       — full destination (JWT magic-link URLs
--                   can easily exceed 255 chars, hence TEXT not VARCHAR).
--   purpose         VARCHAR(40) NULL — 'magic_link', 'manual', NULL for
--                   catch-all. Used for audit + future cleanup-by-purpose.
--   expires_at      DATETIME NULL — NULL = never expires. Checked in JS
--                   on resolve, not in SQL, so we don't need a CURRENT_
--                   TIMESTAMP-driven WHERE clause (which kills index use).
--   click_count     INT NOT NULL DEFAULT 0 — incremented fire-and-forget
--                   inside the redirect handler. Approximate is fine.
--   last_clicked_at DATETIME NULL — last redirect timestamp; for audit.
--   fk_created_by   INT NULL — loose FK to tbl_user.user_id. NOT enforced
--                   as a hard FK; the magic-link cron creates rows with
--                   fk_created_by = NULL (no user context in cron).
--
-- INDEXES
--   PK (short_code) covers the hot path: GET /s/:code → SELECT by PK.
--   idx_expires_at         — supports a future cleanup cron that
--                            DELETEs FROM tbl_url_shortener WHERE
--                            expires_at < NOW() - INTERVAL N DAY.
--   idx_purpose_created_at — supports audit queries like "all magic_
--                            link short URLs created in the last week".
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE tbl_url_shortener (
  short_code      VARCHAR(16)  NOT NULL,
  long_url        TEXT         NOT NULL,
  purpose         VARCHAR(40)  NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at      DATETIME     NULL,
  click_count     INT          NOT NULL DEFAULT 0,
  last_clicked_at DATETIME     NULL,
  fk_created_by   INT          NULL,
  PRIMARY KEY (short_code),
  INDEX idx_expires_at (expires_at),
  INDEX idx_purpose_created_at (purpose, created_at)
);
