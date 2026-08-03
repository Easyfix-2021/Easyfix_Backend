-- Index tbl_job_offer on (offered_at, offer_status) for the QuickSight Offer
-- Acceptance report, which scans a date window on offered_at and then buckets
-- rows by offer_status (COUNT(CASE WHEN offer_status = ...)). The composite lets
-- the range on offered_at drive the scan while keeping offer_status covered, so
-- the per-status counts need no row lookups. Also helps the offer-expiry cron's
-- `offer_status = 0 AND offered_at < NOW() - INTERVAL 30 MINUTE` sweep.
-- tbl_job_offer is EasyFix-owned (no legacy service references it), and an index
-- is non-destructive (no semantics change), so this is within the schema rules.
ALTER TABLE tbl_job_offer ADD INDEX idx_job_offer_offered_status (offered_at, offer_status);
