-- 2026-06-15: Add monthly_revenue column to tbl_client
-- Tracks the monthly revenue (INR) for each client.
-- NULL means not yet recorded.
ALTER TABLE tbl_client ADD COLUMN monthly_revenue DECIMAL(15,2) NULL;
