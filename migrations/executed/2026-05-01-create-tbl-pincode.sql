/*
 * Manage Pincodes — generic pincode catalog (NOT client-specific).
 *
 * Why a new table:
 *   pincode_firefox_city_mapping is firefox-client-specific data and must
 *   not be touched. EasyFix's generic pincode-management UI (Settings →
 *   Manage Pincodes) needs its own catalog, FK-linked to tbl_city for
 *   integrity, with first-class columns for the user-spec fields
 *   (location, district override, audit metadata).
 *
 * Schema-rule exception:
 *   CLAUDE.md says "never add tables" — that rule exists to protect the
 *   five legacy services (CRM, Dropwizard :8090, ACD_APIs, etc.) that
 *   share `easyfix_core`. A NEW EasyFix-owned table that no legacy
 *   service references is an explicit exception, authorized for this
 *   feature.
 *
 * Columns:
 *   pincode_id      surrogate PK (auto-increment) — required because
 *                   `pincode` itself is a 6-char string used as a join key
 *                   downstream; a numeric PK keeps row references compact
 *                   and lets us version updates by id.
 *   pincode         the 6-digit India PIN. UNIQUE — only one row per PIN.
 *   location        free-form area label ("Sector 18", "Andheri East").
 *                   Optional; the legacy firefox table has no equivalent.
 *   city_id         FK-style reference to tbl_city. Plain INDEX, not a
 *                   true FK, because tbl_city has historical orphan rows
 *                   that would block FK creation. App-layer validates.
 *   district        per-pincode override of tbl_city.district. Optional —
 *                   most pincodes inherit the city's district; the column
 *                   exists only for the rare cases where a pincode spans
 *                   a different administrative district.
 *   pincode_status  0/1 active flag (NOT the Local/Travel UI label, which
 *                   is computed from technician availability at read time).
 *                   Soft-delete preserves historical job → pincode links.
 *   created_by      tbl_user.user_id of the operator who added the row.
 *                   Nullable for bulk-imported rows where attribution is
 *                   "the import script" rather than a person.
 *   created_date    server-side default CURRENT_TIMESTAMP.
 *   updated_by      most-recent editor's user_id. Nullable.
 *   updated_date    auto-updated on every UPDATE.
 *
 * Indexes:
 *   uniq_pincode    enforces "one row per PIN" — the user-meaningful key.
 *   idx_city_id     fast lookup for "all pincodes in a city" used by zone
 *                   editor + auto-assign join chain.
 *   idx_status      fast filter on active rows; the UI hides inactive ones
 *                   by default but supports an "include inactive" toggle
 *                   for ops review.
 *
 * Status semantics (UI):
 *   LOCAL    pincode active AND ≥1 active+verified easyfixer in a zone
 *            covering this pincode's city.
 *   TRAVEL   pincode active but no qualifying tech.
 *   UNZONED  pincode missing from this table — detected at job creation
 *            time, fires PM alert. Doesn't appear in Manage Pincodes.
 */

CREATE TABLE IF NOT EXISTS tbl_pincode (
  pincode_id      INT NOT NULL AUTO_INCREMENT,
  pincode         VARCHAR(6) NOT NULL,
  location        VARCHAR(255) DEFAULT NULL,
  city_id         INT NOT NULL,
  district        VARCHAR(100) DEFAULT NULL,
  pincode_status  TINYINT NOT NULL DEFAULT 1,
  created_by      INT DEFAULT NULL,
  created_date    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_by      INT DEFAULT NULL,
  updated_date    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (pincode_id),
  UNIQUE KEY uniq_pincode (pincode),
  KEY idx_city_id (city_id),
  KEY idx_status  (pincode_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='EasyFix-owned pincode catalog (separate from firefox-client mapping)';
