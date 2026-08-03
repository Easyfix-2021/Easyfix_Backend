-- Job Stage Access — per-user, server-enforced restriction to a subset of the
-- job lifecycle STAGES. A user with rows here only SEES jobs whose status falls
-- in one of their allowed stages, and may only perform status transitions INTO
-- those stages. NO rows for a user = UNRESTRICTED (the default). Admin/Finance
-- bypass this entirely (see lib/scope.js bypassesScope).
--
-- stage_key is one of the 9 canonical stage keys defined in lib/job-stages.js
-- (unconfirmed, pending-scheduling, pending-start, pending-close,
-- audit-complete, pending-feedback, onhold, estimate-pending, cancelled).
-- We intentionally store the stable KEY (not the numeric statuses) so the
-- status→stage mapping can evolve in code without a data migration.
--
-- ONE extra reserved value: '__none__' (lib/job-stages NO_ACCESS_KEY) — a
-- sentinel row meaning the admin explicitly granted NO stages. It exists
-- because zero rows already means UNRESTRICTED (the never-configured default,
-- which is what keeps every pre-existing user out of a lockout), so "no access"
-- needs a row of its own to be representable. It is never a real grant: it
-- matches no status and is stripped from the permission object on read.
--
-- Schema-rule exception (CLAUDE.md "never add tables"): this is a NEW
-- EasyFix-owned table that no legacy service references — the same explicit
-- exception used for tbl_pincode. Non-destructive, additive only.
--
-- uniq_user_stage prevents a duplicate (user, stage) grant and makes the
-- reconcile-on-save DELETE+INSERT idempotent. idx_user powers the per-request
-- loadAllowedStages() point-lookup.
CREATE TABLE IF NOT EXISTS tbl_user_allowed_stages (
  id           INT NOT NULL AUTO_INCREMENT,
  user_id      INT NOT NULL,
  stage_key    VARCHAR(40) NOT NULL,
  created_by   INT NULL,
  created_date DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_user_stage (user_id, stage_key),
  KEY idx_user (user_id)
);
