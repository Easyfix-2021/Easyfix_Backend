-- Add the processed-by actor column to the technician withdrawal request table.
-- When finance PAYs or REJECTs a request (POST /api/admin/withdrawals/:id/process)
-- we stamp WHO acted, mirroring the tbl_service_payout audit columns
-- (ops_approved_by / fin_rejected_by). Nullable — historical rows and open
-- ('requested') rows have no processor yet. Stores tbl_user.user_id of the
-- finance operator. EasyFix-owned table (created 2026-07-09); no legacy service
-- references it, so this additive column is safe.

ALTER TABLE tbl_easyfixer_withdrawal_request ADD COLUMN processed_by INT NULL DEFAULT NULL;
