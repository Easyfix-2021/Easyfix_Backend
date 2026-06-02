-- ─────────────────────────────────────────────────────────────────────
-- 2026-06-03 — Conversational WhatsApp Order Confirmation (Gallabox)
--
-- WHAT
--   • tbl_whatsapp_conversation — per-job state machine for the inbound,
--     AI-assisted WhatsApp conversation that collects date/time, media and
--     address/GPS from the customer (an alternative to the magic-link FORM).
--   • tbl_job_media — customer-shared VIDEOS for a job (photos keep using
--     the existing tbl_job_image; that table is image-centric, so videos
--     get their own EasyFix-owned table rather than overloading it).
--
--   Both are NEW EasyFix-owned tables that no legacy service references —
--   the explicit exception to the "never add tables" rule (same basis as
--   tbl_pincode / tbl_job_customer_request).
--
--   NOTE: the per-client channel selector lives in the existing
--   tbl_client_custom_properties table under the property name
--   "Order Confirmation Mode" (values 'form' | 'conversation'), read via
--   the same LOWER(REPLACE(c_prop_name,'_',' ')) lookup the magic-link
--   opt-in uses — no schema change needed for that.
--
-- HOW TO APPLY
--   Run each statement in order. Plain CREATE TABLE — no prepared
--   statements, no @-variables. A "Table already exists" error simply
--   means that piece is already applied; skip it and continue.
-- ─────────────────────────────────────────────────────────────────────


-- ─── 1. Conversation state machine ───────────────────────────────────
-- One row per (job) conversation. `status` drives lifecycle; `current_step`
-- is the state-machine cursor; `context` is a JSON scratchpad of collected
-- answers (datetime, time_slot, media_count, gps, address, reason). The
-- 24h customer-service window is tracked by `expires_at` — past it, only
-- template reminders may be sent (WhatsApp policy).

CREATE TABLE tbl_whatsapp_conversation (
  conversation_id     INT          NOT NULL AUTO_INCREMENT,
  job_id              INT          NOT NULL,
  customer_mob_no     VARCHAR(20)  NOT NULL,
  status              VARCHAR(20)  NOT NULL DEFAULT 'active',
  current_step        VARCHAR(40)  NOT NULL DEFAULT 'awaiting_datetime',
  context             JSON         NULL,
  last_inbound_msg_id VARCHAR(128) NULL,
  started_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_inbound_at     DATETIME     NULL,
  expires_at          DATETIME     NULL,
  created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (conversation_id),
  INDEX idx_wac_job (job_id),
  INDEX idx_wac_mob (customer_mob_no),
  INDEX idx_wac_status (status, expires_at)
);


-- ─── 2. Customer-shared videos ───────────────────────────────────────
-- Photos continue to land in tbl_job_image (image-only MIME, cap 5).
-- Videos shared in the WhatsApp chat are stored here, with the S3 key
-- (category "BookingVideo"), the original content type and a source tag.

CREATE TABLE tbl_job_media (
  media_id      INT          NOT NULL AUTO_INCREMENT,
  job_id        INT          NOT NULL,
  s3_key        VARCHAR(512) NOT NULL,
  content_type  VARCHAR(100) NULL,
  source        VARCHAR(40)  NOT NULL DEFAULT 'customer_whatsapp',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (media_id),
  INDEX idx_jm_job (job_id)
);


-- ─── 3. Verify (optional — read-only) ────────────────────────────────
SELECT TABLE_NAME
  FROM INFORMATION_SCHEMA.TABLES
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME IN ('tbl_whatsapp_conversation', 'tbl_job_media')
 ORDER BY TABLE_NAME;
