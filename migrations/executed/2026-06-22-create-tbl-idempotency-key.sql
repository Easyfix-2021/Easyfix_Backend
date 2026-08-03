-- 2026-06-22 — Server-side idempotency ledger.
--
-- Backs the EasyFixer offline outbox: the mobile app queues writes while
-- offline and replays them on reconnect, often retrying the SAME request
-- (flaky cell network, app restart mid-flush). Each queued write carries a
-- client-generated Idempotency-Key header; this table records the first
-- execution per (actor, key) and lets every retry replay the stored response
-- instead of re-running the side-effect (double check-in, duplicate image
-- upload, etc.).
--
-- tbl_idempotency_key is EasyFix-owned and referenced by no legacy service,
-- so a new owned table is the sanctioned route under the CLAUDE.md shared-DB
-- carve-out (the same precedent as tbl_pincode / tbl_zone_pincode_mapping).
-- No existing table is altered.
--
-- Columns:
--   actor_type / actor_id  who issued the request ('efr'/<efr_id> for techs,
--                          'user'/<user_id> for CRM). Scopes keys per-actor so
--                          two actors can independently reuse the same key.
--   idempotency_key        the client-supplied Idempotency-Key header value.
--   method / path          request method + originalUrl (incl. querystring) —
--                          informational + aids debugging replays.
--   request_fingerprint    sha256(method + url + stable-stringified body). A
--                          replay with the SAME key but a DIFFERENT fingerprint
--                          is rejected 409 (key reuse with a different request).
--   response_status        captured HTTP status of the first execution.
--   response_json          captured response body, replayed verbatim on retry.
--   state                  'in_flight' while the first request runs, 'done'
--                          once the response is captured.
--   created_at / completed_at  audit + TTL-sweep anchor.

CREATE TABLE IF NOT EXISTS tbl_idempotency_key (
  id INT NOT NULL AUTO_INCREMENT,
  actor_type VARCHAR(16) NOT NULL,
  actor_id VARCHAR(64) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  method VARCHAR(8) NOT NULL,
  path VARCHAR(512) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  response_status SMALLINT NULL,
  response_json MEDIUMTEXT NULL,
  state VARCHAR(16) NOT NULL DEFAULT 'in_flight',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_actor_key (actor_type, actor_id, idempotency_key),
  KEY idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
