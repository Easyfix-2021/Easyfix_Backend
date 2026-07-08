ALTER TABLE tbl_pincode ADD COLUMN created_by_type VARCHAR(20) NULL;
ALTER TABLE tbl_city ADD COLUMN created_by INT NULL;
ALTER TABLE tbl_city ADD COLUMN created_by_type VARCHAR(20) NULL;
ALTER TABLE tbl_city ADD COLUMN created_date DATETIME NULL;
