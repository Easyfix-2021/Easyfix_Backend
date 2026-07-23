-- Magic-link (job completion form) real WhatsApp delivery state.
-- HTTP-200 from Gallabox on send only means "queued/accepted" — NOT that the
-- customer received it (e.g. number not on WhatsApp). The true outcome arrives
-- asynchronously as a Gallabox message-status callback. These 3 columns let us
-- correlate that callback back to the job and persist the real state + reason:
--   provider_msg_id  — the WhatsApp/provider message id stamped at send time,
--                      matched by the status callback (routes/webhook/whatsapp.js).
--   delivery_status  — sent | delivered | read | failed | undelivered.
--   delivery_reason  — provider failure reason (shown on hover of the CRM chip).
-- All new, nullable, appended — the safe shared-DB (easyfix_core) exception; no
-- existing column is altered/dropped. Needs DBA sign-off before running.
ALTER TABLE tbl_job ADD COLUMN magic_link_provider_msg_id VARCHAR(128) NULL;
ALTER TABLE tbl_job ADD COLUMN magic_link_delivery_status VARCHAR(20) NULL;
ALTER TABLE tbl_job ADD COLUMN magic_link_delivery_reason VARCHAR(255) NULL;
ALTER TABLE tbl_job ADD INDEX idx_magic_link_provider_msg_id (magic_link_provider_msg_id);
