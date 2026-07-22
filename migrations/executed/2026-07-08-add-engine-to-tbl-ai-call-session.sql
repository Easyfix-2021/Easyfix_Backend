-- AI-calling: which ENGINE (voice provider) powered a call. EasyFix-owned table
-- (tbl_ai_call_session, created 2026-07-06). Additive column + a default-engine
-- property. Gemini is the default (≈5-10x cheaper audio; see docs/AI_CALLING_ENGINES.md);
-- switchable from Admin Actions via easyfix_properties + the Validate-Flows dropdown.

ALTER TABLE tbl_ai_call_session ADD COLUMN engine VARCHAR(16) NOT NULL DEFAULT 'gemini';

INSERT INTO easyfix_properties (property_key, property_value) VALUES ('ai.calling.engine', 'gemini') ON DUPLICATE KEY UPDATE property_value = property_value;
