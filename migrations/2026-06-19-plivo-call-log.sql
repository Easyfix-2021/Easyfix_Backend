-- Dedicated Plivo call-detail log (EasyFix-owned; NO legacy service references it,
-- so it's allowed under the shared-DB carve-out). Sits ALONGSIDE the generic
-- tbl_job_caller_info audit — every Plivo call writes a row here too, linked by
-- job_caller_info_id, so you can reconcile "of all calls in tbl_job_caller_info,
-- how many were Plivo" (and slice Plivo calls by mode / flow / status / QA-redirect).
-- Written fail-soft by services/plivo-call-log.service.js — a logging failure
-- never breaks a call.
CREATE TABLE IF NOT EXISTS tbl_plivo_call_log (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  job_caller_info_id INT NULL,                 -- link to tbl_job_caller_info.job_caller_info
  job_id             INT NULL,
  call_mode          VARCHAR(10) NULL,         -- 'web' | 'mobile'
  call_flow          VARCHAR(64) NULL,         -- which screen/flow started it
  caller_user_id     INT NULL,                 -- operator (tbl_user.user_id)
  caller_name        VARCHAR(255) NULL,
  receiver_name      VARCHAR(255) NULL,
  receiver_number    VARCHAR(20) NULL,         -- the REAL intended customer number
  dialed_number      VARCHAR(20) NULL,         -- what was actually dialed (test number in QA)
  is_qa_redirect     TINYINT(1) NOT NULL DEFAULT 0,
  request_uuid       VARCHAR(64) NULL,         -- Plivo request_uuid (create handle)
  call_uuid          VARCHAR(64) NULL,         -- Plivo CallUUID (callbacks)
  status             VARCHAR(16) NULL,         -- initiated/placed/ringing/answered/completed/busy/no_answer/failed/hungup/suppressed
  hangup_cause       VARCHAR(64) NULL,
  initiated_on       DATETIME NULL,
  answered_on        DATETIME NULL,
  ended_on           DATETIME NULL,
  duration           INT NULL,
  provider           VARCHAR(16) NOT NULL DEFAULT 'plivo',
  created_on         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_on         DATETIME NULL,
  KEY idx_plivo_log_jci (job_caller_info_id),
  KEY idx_plivo_log_uuid (call_uuid),
  KEY idx_plivo_log_initiated (initiated_on)
);
