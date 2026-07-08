-- Build Skill Matrix (Admin Actions) — property-gated capability.
-- FEATURES.canBuildSkillMatrix maps to easyfix_properties key `skill.matrix.emails`
-- (CSV of official emails). Seeds the requester so the card + build endpoint are
-- usable immediately; add more operator emails via the Properties admin.
-- Idempotent: only inserts when the key is absent (never overwrites a live list).
INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'skill.matrix.emails', 'harshit@channelplay.in'
WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'skill.matrix.emails');
