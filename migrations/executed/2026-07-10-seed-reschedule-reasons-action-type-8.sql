-- Seed the CRM "Reschedule" reason bucket (action_taken_reason, action_type = 8)
-- for the Schedule & Assign → Reschedule dialog (GET /api/admin/jobs/reschedule-reasons).
-- Idempotent (NOT EXISTS on action_type+action_desc), one-statement-per-line, no
-- @set / PREPARE / MariaDB IF NOT EXISTS.
--
-- action_type = 8 is the established "Reschedule" bucket (per the reason model;
-- distinct from the magic-link customer buckets 38/39). The endpoint does NOT
-- filter by user_type (the dialog has a single reason dropdown), so ALL rows
-- below surface; user_type still follows the legacy convention for future
-- filtering (reason-codes.js: 1=Customer, 2=Client, 3=EasyFix, 4=Technician).
--
-- Columns set: action_type, action_desc, user_type, status(=1 active). id is
-- AUTO_INCREMENT. If this DB's action_taken_reason has any additional NOT NULL
-- column without a default (e.g. is_new / created_on), add it to each INSERT.

INSERT INTO action_taken_reason (action_type, action_desc, user_type, status)
SELECT 8, 'Customer requested a different date/time', 1, 1
 WHERE NOT EXISTS (SELECT 1 FROM action_taken_reason WHERE action_type = 8 AND action_desc = 'Customer requested a different date/time');

INSERT INTO action_taken_reason (action_type, action_desc, user_type, status)
SELECT 8, 'Customer not reachable to confirm schedule', 1, 1
 WHERE NOT EXISTS (SELECT 1 FROM action_taken_reason WHERE action_type = 8 AND action_desc = 'Customer not reachable to confirm schedule');

INSERT INTO action_taken_reason (action_type, action_desc, user_type, status)
SELECT 8, 'Customer not available at scheduled time', 1, 1
 WHERE NOT EXISTS (SELECT 1 FROM action_taken_reason WHERE action_type = 8 AND action_desc = 'Customer not available at scheduled time');

INSERT INTO action_taken_reason (action_type, action_desc, user_type, status)
SELECT 8, 'Technician unavailable / reassigned', 4, 1
 WHERE NOT EXISTS (SELECT 1 FROM action_taken_reason WHERE action_type = 8 AND action_desc = 'Technician unavailable / reassigned');

INSERT INTO action_taken_reason (action_type, action_desc, user_type, status)
SELECT 8, 'Spare / parts not available', 3, 1
 WHERE NOT EXISTS (SELECT 1 FROM action_taken_reason WHERE action_type = 8 AND action_desc = 'Spare / parts not available');

INSERT INTO action_taken_reason (action_type, action_desc, user_type, status)
SELECT 8, 'Operational / scheduling delay', 3, 1
 WHERE NOT EXISTS (SELECT 1 FROM action_taken_reason WHERE action_type = 8 AND action_desc = 'Operational / scheduling delay');

-- Verify (read-only) — what the endpoint will return.
SELECT id, action_desc, user_type, status FROM action_taken_reason WHERE action_type = 8 AND (status IS NULL OR status = 1) ORDER BY id ASC;
