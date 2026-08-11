-- Technician authentication hot-path indexes.
--
-- Live index inventory on 2026-08-11 confirmed no equivalent left-prefix on
-- any table: tbl_easyfixer and otp_details had only their PK/FK indexes, while
-- tbl_user had user_role alone. These three lookups execute on every OTP send
-- and/or verification; without them MySQL scanned roughly 9.4k easyfixers and
-- 6.9k technician-role users per request in the measured database.
--
-- Guard each ALTER through INFORMATION_SCHEMA so re-running this file is
-- idempotent. The two InnoDB tables pin LOCK=NONE. otp_details is a legacy
-- MyISAM table, where online DDL is unavailable; it is only ~0.75 MB / 10.9k
-- rows in the measured database, but its final ALTER should still run in a
-- low-traffic window because it takes a brief table lock.

SET @has_idx_tech_auth = (
  SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
      FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_easyfixer'
     GROUP BY INDEX_NAME
    HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)
             IN ('efr_no,is_technician_verified,efr_status,efr_id')
        OR GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)
             LIKE 'efr_no,is_technician_verified,efr_status,efr_id,%'
  ) equivalent_index
);
SET @ddl_tech_auth = IF(
  @has_idx_tech_auth = 0,
  'ALTER TABLE tbl_easyfixer ADD INDEX idx_easyfixer_mobile_auth (efr_no, is_technician_verified, efr_status, efr_id), ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);
PREPARE stmt_tech_auth FROM @ddl_tech_auth;
EXECUTE stmt_tech_auth;
DEALLOCATE PREPARE stmt_tech_auth;

SET @has_idx_user_auth = (
  SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
      FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tbl_user'
     GROUP BY INDEX_NAME
    HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)
             IN ('mobile_no,user_role,user_id')
        OR GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)
             LIKE 'mobile_no,user_role,user_id,%'
  ) equivalent_index
);
SET @ddl_user_auth = IF(
  @has_idx_user_auth = 0,
  'ALTER TABLE tbl_user ADD INDEX idx_user_mobile_role_auth (mobile_no, user_role, user_id), ALGORITHM=INPLACE, LOCK=NONE',
  'SELECT 1'
);
PREPARE stmt_user_auth FROM @ddl_user_auth;
EXECUTE stmt_user_auth;
DEALLOCATE PREPARE stmt_user_auth;

SET @has_idx_otp_auth = (
  SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
      FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'otp_details'
     GROUP BY INDEX_NAME
    HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)
             IN ('user_mobile_no,otp_type,id')
        OR GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)
             LIKE 'user_mobile_no,otp_type,id,%'
  ) equivalent_index
);
SET @ddl_otp_auth = IF(
  @has_idx_otp_auth = 0,
  'ALTER TABLE otp_details ADD INDEX idx_otp_mobile_type_latest (user_mobile_no, otp_type, id)',
  'SELECT 1'
);
PREPARE stmt_otp_auth FROM @ddl_otp_auth;
EXECUTE stmt_otp_auth;
DEALLOCATE PREPARE stmt_otp_auth;
