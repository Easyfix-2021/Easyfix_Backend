-- Capture WHO put the offer out, on the tbl_job_offer row itself.
--   offered_by_user_id = tbl_user.user_id of the CRM user (or auto-assign actor)
--     who made / re-made this offer. NULL = a system/auto offer with no actor, OR a
--     PRE-MIGRATION offer — we intentionally do NOT backfill: old offers keep NULL
--     rather than being mis-attributed to the job owner. (The report-consuming team
--     is aware NULL means "unknown offerer" for historical rows.)
-- WHY: the QuickSight Offer Acceptance report previously attributed offers to
-- tbl_job.job_owner as a stand-in, but a job is offered by whoever runs Schedule &
-- Assign — often NOT the owner, and many people touch one job — so job_owner
-- over-credited owners. This column is the true, per-offer, re-offer-durable
-- attribution the report now groups by.
-- tbl_job_offer is EasyFix-owned (referenced by no legacy service), so adding a
-- column + index here is within the schema rules and non-destructive.
ALTER TABLE tbl_job_offer ADD COLUMN offered_by_user_id INT NULL;
ALTER TABLE tbl_job_offer ADD INDEX idx_job_offer_offered_by (offered_by_user_id);
