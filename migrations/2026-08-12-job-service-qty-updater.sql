-- Client app: editable Product quantity stepper on the order-detail Services list.
-- Adds standard audit columns to tbl_job_services so we can record WHO created /
-- last changed a service line and WHEN. The app uses updated_by / updated_on to
-- show "Updated by <name>". Editing the quantity is only allowed pre-audit
-- (New → Work Progress); the app hides Save once the job reaches Under Audit /
-- Completed.
--
-- All columns are nullable and additive — existing rows and the CRM Job
-- Transaction view are unaffected. Safe to run on QA then Production.

ALTER TABLE tbl_job_services
  ADD COLUMN inserted_by INT NULL      AFTER quantity,
  ADD COLUMN inserted_on DATETIME NULL AFTER inserted_by,
  ADD COLUMN updated_by  INT NULL      AFTER inserted_on,
  ADD COLUMN updated_on  DATETIME NULL AFTER updated_by;
