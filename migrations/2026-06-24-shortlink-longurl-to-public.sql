-- 2026-06-24 — Repoint already-shortened magic-link long_urls to /public/*
--
-- The public flows moved under /public/* (booking → /public/job-completion,
-- profile-update → /public/profile-update). Short links already issued (rows in
-- tbl_url_shortener) still store their long_url at the OLD root paths
-- (/job-completion/<jwt>, /profile-update/<jwt>). Those already-sent short codes
-- still resolve via the next.config back-compat redirects, but repointing them
-- here makes them land DIRECTLY on /public (no redirect hop) and lets the legacy
-- redirects be retired sooner.
--
-- tbl_url_shortener is an EasyFix-owned table. Idempotent: the NOT LIKE guard
-- skips rows already on /public. Style: plain one-statement-per-line.
-- The WhatsApp message TEXT already sent (crm.easyfix.in/book/<code>) is frozen
-- and unaffected — this only changes where each stored code RESOLVES to.

UPDATE tbl_url_shortener
   SET long_url = REPLACE(long_url, '/profile-update/', '/public/profile-update/')
 WHERE long_url LIKE '%/profile-update/%' AND long_url NOT LIKE '%/public/profile-update/%';

UPDATE tbl_url_shortener
   SET long_url = REPLACE(long_url, '/job-completion/', '/public/job-completion/')
 WHERE long_url LIKE '%/job-completion/%' AND long_url NOT LIKE '%/public/job-completion/%';

-- Verify (expected: 0 rows still on a non-/public path).
SELECT COUNT(*) AS remaining_non_public
  FROM tbl_url_shortener
 WHERE (long_url LIKE '%/profile-update/%' OR long_url LIKE '%/job-completion/%')
   AND long_url NOT LIKE '%/public/%';
