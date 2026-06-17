-- 2026-06-10 — EasyFix-owned per-easyfixer serviceable pincodes.
-- One row per easyfixer; pincodes stored as comma-separated TEXT for
-- simplicity. NOT referenced by any legacy service; safe under shared-DB
-- carve-out in CLAUDE.md.

CREATE TABLE IF NOT EXISTS tbl_efr_serviceable_pincodes (
  easyfixer_id  INT          NOT NULL,
  pincodes      TEXT         NULL,
  created_by    INT          NULL,
  created_date  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by    INT          NULL,
  updated_date  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (easyfixer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
