-- Per-caller (ops agent) coaching-score rollup — "who is improving, who is not".
-- Aggregates the per-call coaching scores (tbl_plivo_call_log.call_analysis) plus
-- the teleprompter coverage score, grouped by caller_user_id + call_flow, upserted
-- on each completed guided call. EasyFix-owned; surfaced on the existing
-- Settings -> Call Analytics page (Per-Caller Scorecard tab, reusing the
-- isCallAnalyticsView RBAC). Empty PK on call_flow uses '' for the all-flows row.

CREATE TABLE IF NOT EXISTS tbl_caller_score_rollup (
  caller_user_id      INT          NOT NULL,
  call_flow           VARCHAR(32)  NOT NULL DEFAULT '',
  calls_count         INT          NOT NULL DEFAULT 0,
  avg_overall         DECIMAL(4,2) NULL,
  avg_coverage        DECIMAL(5,2) NULL,
  avg_dimensions_json MEDIUMTEXT   NULL,
  trend_json          MEDIUMTEXT   NULL,
  last_call_on        DATETIME     NULL,
  updated_on          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (caller_user_id, call_flow)
);
