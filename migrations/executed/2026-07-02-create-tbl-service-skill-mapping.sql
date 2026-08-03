-- 2026-07-02 — Job Skill Matrix.
--
-- Maps a SERVICE (identified by its service CATEGORY + rate-card name) to the
-- DEEP SKILL(s) it requires, so candidate-ranking can compare a JOB's required
-- deep skills against a TECHNICIAN's deep skills — finer than the current
-- category-only match. Populated by AI (services/service-skill-matrix.service.js),
-- triggered manually from the "Build Skill Matrix" Admin Action.
--
-- Keyed on CATEGORY (not service_type): verified on live data, deep skills and
-- client-service rate cards use DISJOINT service_type_id namespaces (0 overlap),
-- so category is the only shared axis (and jobs are matched by category too).
--
-- EasyFix-OWNED NEW table (no legacy service references it) — the allowed
-- exception to the never-add-tables rule (same as tbl_pincode).
-- `source`='ai' rows are wholesale-replaced on each build; 'manual' rows are
-- operator overrides and are preserved (the build uses INSERT IGNORE so it
-- never clobbers a manual mapping on the same (category, name, skill) triple).
CREATE TABLE tbl_service_skill_mapping (
  id INT AUTO_INCREMENT PRIMARY KEY,
  service_catg_id INT NOT NULL,
  service_name VARCHAR(255) NOT NULL,
  deep_skill_id INT NOT NULL,
  confidence DECIMAL(3,2) DEFAULT NULL,
  source VARCHAR(16) NOT NULL DEFAULT 'ai',
  status TINYINT NOT NULL DEFAULT 1,
  created_on DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_on DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ssm_catg_name_skill (service_catg_id, service_name, deep_skill_id),
  KEY idx_ssm_catg_name (service_catg_id, service_name),
  KEY idx_ssm_skill (deep_skill_id)
);
