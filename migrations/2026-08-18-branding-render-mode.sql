-- ============================================================================
-- 2026-08-18 — Theme & Branding: ornament RENDER MODE
--
-- WHAT THIS DOES
--   Adds ONE column to easyfix_theme_variant:
--
--     render_mode VARCHAR(16) NOT NULL DEFAULT 'overlay'
--
--   and repairs any out-of-vocabulary value already sitting in it.
--
-- WHY IT EXISTS
--   Until now a festival ornament could only ever be composited OVER the
--   official EasyFix lockup. Design also needs the other option: a designer
--   supplies a COMPLETE festive lockup as a single asset, and for that window
--   it should be the only brand mark on the page — no official lockup beneath
--   it, nothing to collide with. That is a per-variant editorial decision, so
--   it belongs on the variant row, not in a global property.
--
--     'overlay'  the uploaded ornament is drawn OVER the EasyFix lockup.
--                Exactly what every existing row does today.
--     'replace'  the uploaded asset IS the brand mark for that window; the
--                lockup is not drawn underneath it.
--
-- ─── THE DEFAULT IS LOAD-BEARING ────────────────────────────────────────────
--   DEFAULT 'overlay' is the entire reason this migration is behaviour-
--   preserving. Every row that exists right now, and every row written by an
--   older build that does not know the column, keeps rendering BYTE-FOR-BYTE
--   as it does today, with no backfill and no operator action. Flipping this
--   default to 'replace' would silently strip the EasyFix lockup off the login
--   page of every environment on the next deploy. Do not change it.
--
-- WHY VARCHAR(16) AND NOT ENUM
--   ENUM turns "add a third mode" into an ALTER on a table the unauthenticated
--   login page reads, and MySQL's ENUM error behaviour differs between strict
--   and non-strict SQL modes. The vocabulary is enforced in exactly two places
--   that are cheap to change — the Joi schema on the write path and
--   normalizeRenderMode() in services/branding.service.js on EVERY read path,
--   which fails any unknown value safely back to 'overlay'.
--
-- WHY A SEPARATE FILE
--   migrations/2026-08-18-settings-branding.sql creates easyfix_theme_variant
--   and is already applied on QA. Editing an applied migration means the
--   environments that ran it would never receive this column. This file is
--   purely additive and stands alone.
--   PREREQUISITE: apply 2026-08-18-settings-branding.sql first.
--
-- ─── HOW TO APPLY ───────────────────────────────────────────────────────────
--   Run STATEMENT BY STATEMENT, in order, against easyfix_core.
--
--   Section 1 is a read-only INFORMATION_SCHEMA preflight that tells you
--   whether section 2 still needs to run. Section 2 is a plain ALTER — it is
--   deliberately NOT wrapped in a `SET @sql := … PREPARE … EXECUTE` guard.
--   That pattern was banned in this repo on 2026-05-30: run statement-by-
--   statement in a GUI client the column-add appears to execute but its effect
--   is not visible to the next statement in the same prepared pipeline, which
--   surfaced as ER_KEY_COLUMN_DOESNT_EXIST 1072 on a live apply. MySQL has no
--   `ADD COLUMN IF NOT EXISTS` (that is MariaDB-only), so the honest idempotent
--   apply here is: read the preflight, then run or skip the ALTER.
--
--   ON A RE-RUN, expect and ignore, if you run section 2 anyway:
--     ERROR 1060 (42S21): Duplicate column name 'render_mode'
--   Nothing else in this file errors on a re-run — section 3 is a guarded
--   UPDATE and section 4 is read-only.
--
-- IDEMPOTENCY
--   1. Preflight  read-only, always safe.
--   2. ALTER      guarded by the preflight; re-running errors 1060 and changes
--                 nothing.
--   3. UPDATE     WHERE-guarded to out-of-vocabulary values only; a second run
--                 matches 0 rows.
--   4. Verify     read-only.
--
-- POST-APPLY
--   Deploy the backend that knows the column. Order matters: the branding
--   read path SELECTs render_mode by name, so apply this migration BEFORE the
--   code that reads it. No restart, no cache flush, no re-login — this is a
--   table column, not an easyfix_properties key or a JWT permission.
-- ============================================================================

-- ─── 1. Preflight — does the column already exist? ──────────────────────────
-- 0 = run section 2. 1 = section 2 is already applied, skip straight to 3.
SELECT COUNT(*) AS render_mode_present,
       IF(COUNT(*) = 0, 'RUN section 2', 'SKIP section 2 — already applied') AS next_step
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'easyfix_theme_variant'
   AND COLUMN_NAME = 'render_mode';

-- ─── 2. The column ──────────────────────────────────────────────────────────
-- NOT NULL + DEFAULT 'overlay': existing rows are backfilled by MySQL as part
-- of the ALTER, so there is no window in which a row reads as NULL and no
-- separate backfill statement to forget. See "THE DEFAULT IS LOAD-BEARING".
ALTER TABLE easyfix_theme_variant ADD COLUMN render_mode VARCHAR(16) NOT NULL DEFAULT 'overlay';

-- ─── 3. Repair any out-of-vocabulary value ──────────────────────────────────
-- Belt and braces for rows written by hand, by a support script or by a future
-- import — none of which pass through Joi. Matches nothing on a fresh apply and
-- nothing on a re-run, so it is safe to leave in the file permanently. The
-- service normalizes on read as well; this keeps the stored value honest so the
-- admin screen's mode selector shows an operator what is really set.
UPDATE easyfix_theme_variant
   SET render_mode = 'overlay'
 WHERE render_mode IS NULL
    OR LOWER(TRIM(render_mode)) NOT IN ('overlay', 'replace');

-- ─── 4. Verification ────────────────────────────────────────────────────────
-- Expect exactly one row: render_mode / varchar(16) / NO / overlay.
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'easyfix_theme_variant'
   AND COLUMN_NAME = 'render_mode';

-- Every variant must now report a mode inside the vocabulary.
-- `out_of_vocabulary` must be 0.
SELECT COUNT(*) AS total_variants,
       SUM(render_mode = 'overlay') AS overlay_variants,
       SUM(render_mode = 'replace') AS replace_variants,
       SUM(render_mode NOT IN ('overlay', 'replace')) AS out_of_vocabulary
  FROM easyfix_theme_variant;
