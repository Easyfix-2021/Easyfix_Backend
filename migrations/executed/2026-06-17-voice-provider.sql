-- Voice provider selection (Kaleyra + Plivo).
-- Seeds the two easyfix_properties keys the voice-provider factory reads.
-- Plivo ships DISABLED — flip plivo.calling.enabled to 'true' only after the
-- PLIVO_* credentials + caller-ID number are configured.
-- `kaleyra.calling.enabled` already exists (2026-06-03-easyfix-properties.sql).
--
-- NOTE: tbl_job_caller_info.provider already exists (GET /api/admin/calls reads
-- jci.provider). No ALTER needed; the routes now set it at INSERT time.

INSERT INTO easyfix_properties (property_key, property_value) VALUES ('voice.default.provider', 'kaleyra');
INSERT INTO easyfix_properties (property_key, property_value) VALUES ('plivo.calling.enabled', 'false');
