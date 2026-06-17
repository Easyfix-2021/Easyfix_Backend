-- 2026-06-15 — geocoded centroid cache columns on tbl_pincode.
-- tbl_pincode is EasyFix-owned (migrations/2026-05-01-create-tbl-pincode.sql),
-- so adding columns is allowed under the shared-DB carve-out in CLAUDE.md.
-- Used by services/pincode-geocode.service.js as a cache-first store for the
-- pincode centroid (lat/lng) so the Schedule & Assign distance column avoids
-- repeat Google Geocoding calls. NULL = not yet geocoded.

ALTER TABLE tbl_pincode ADD COLUMN lat DECIMAL(10,7) NULL;
ALTER TABLE tbl_pincode ADD COLUMN lng DECIMAL(10,7) NULL;
