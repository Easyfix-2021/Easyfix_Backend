-- =============================================================================
-- Rewards — points ledger, shop catalogue, claims, and referral codes.
--
-- All five tables are NEW and EasyFix-owned; no legacy service references any
-- of them (the sanctioned exception to the shared-database rule). Nothing
-- existing is altered.
--
-- ─── THE ONE RULE THAT SHAPES EVERYTHING ────────────────────────────────
--
-- POINTS ARE NOT MONEY. EasyFix already has a real wallet — advances,
-- withdrawals, payouts. Points live in their own ledger, are never convertible
-- to cash, and are never withdrawable. Blurring that line would turn a loyalty
-- scheme into a financial instrument with all the obligation that carries.
--
-- ─── WHY THE BALANCE IS NOT A COLUMN ────────────────────────────────────
--
-- There is deliberately no `points_balance` anywhere. The balance is
-- SUM(delta) over reward_points_ledger, always. A stored balance and a ledger
-- disagree the first time anything half-fails, and then nobody can say which
-- one is right — least of all the technician looking at it. Summing is cheap
-- at this scale (2,636 active technicians) and idx_ledger_efr covers it.
--
-- The ledger is APPEND-ONLY. A cancelled claim is refunded by a NEW credit
-- row, never by deleting the debit, so "why did my points change?" always has
-- a complete answer on screen.
--
-- HOW TO APPLY
--   Run statement-by-statement. On a re-run expect, and ignore:
--     "Table ... already exists" / "Duplicate entry" on the property seeds.
--
-- POST-APPLY
--   Admin users must log out and back in — menu_ids and actionPermissions are
--   resolved into the JWT at login.
--
--   Earning starts as soon as the backend restarts (rewards.earn.enabled is
--   seeded 'true'). There is NO BACKFILL and none is possible: the awarding
--   pass only ever looks at a short recent window, so the programme starts on
--   the day it goes live rather than paying out for 317,777 historical
--   ratings. That bound is structural, not a setting.
-- =============================================================================

-- ─── 1. The ledger ───────────────────────────────────────────────────
-- `delta` is signed: credits positive, debits negative.
--
-- uq_reward_award is the idempotency guarantee, and it is a DATABASE
-- constraint rather than a check in code precisely because the awarding cron
-- can run twice: one job can never pay rating points twice, one referral can
-- never qualify twice. MySQL permits repeated NULLs in a unique key, so
-- manual adjustments (ref_id NULL) are unconstrained by design.
CREATE TABLE reward_points_ledger (
  id INT NOT NULL AUTO_INCREMENT,
  easyfixer_id INT NOT NULL,
  delta INT NOT NULL,
  reason_code VARCHAR(40) NOT NULL,
  ref_type VARCHAR(20) NULL,
  ref_id INT NULL,
  note VARCHAR(255) NULL,
  created_by INT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reward_award (reason_code, ref_type, ref_id),
  KEY idx_ledger_efr (easyfixer_id, created_at),
  KEY idx_ledger_reason (reason_code, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── 2. The shop ─────────────────────────────────────────────────────
-- `sizes` is a CSV ('S,M,L,XL' / '7,8,9,10') or NULL for an item with no size.
-- A lookup table for four apparel sizes would be ceremony; the CSV is read
-- whole and never joined.
--
-- status retires rather than deletes: a claim from last month must keep
-- resolving to the item it was for.
CREATE TABLE reward_items (
  id INT NOT NULL AUTO_INCREMENT,
  name VARCHAR(150) NOT NULL,
  description VARCHAR(1000) NULL,
  image_key VARCHAR(255) NULL,
  points_cost INT NOT NULL,
  sizes VARCHAR(200) NULL,
  stock INT NOT NULL DEFAULT 0,
  status TINYINT NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_items_status (status, points_cost)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── 3. Claims ───────────────────────────────────────────────────────
-- The delivery address is COPIED IN, not joined to tbl_easyfixer. Where a
-- parcel was actually sent must not change when the technician later edits his
-- profile — otherwise a delivered claim silently rewrites its own history.
--
-- points_spent is likewise a snapshot: an item repriced next month must not
-- retroactively change what an old claim cost.
CREATE TABLE reward_claims (
  id INT NOT NULL AUTO_INCREMENT,
  easyfixer_id INT NOT NULL,
  item_id INT NOT NULL,
  item_name VARCHAR(150) NOT NULL,
  size VARCHAR(20) NULL,
  points_spent INT NOT NULL,
  address_line VARCHAR(500) NOT NULL,
  address_city VARCHAR(120) NULL,
  address_pincode VARCHAR(12) NULL,
  address_phone VARCHAR(20) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ORDERED',
  tracking_ref VARCHAR(120) NULL,
  reject_reason VARCHAR(255) NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_claims_efr (easyfixer_id, created_at),
  KEY idx_claims_status (status, created_at),
  CONSTRAINT fk_reward_claims_item FOREIGN KEY (item_id) REFERENCES reward_items (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── 4. Referral codes ───────────────────────────────────────────────
-- One permanent code per technician, generated on first use. Kept in its own
-- table rather than a column on tbl_easyfixer, which must not be altered.
CREATE TABLE reward_referral_codes (
  easyfixer_id INT NOT NULL,
  code VARCHAR(24) NOT NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (easyfixer_id),
  UNIQUE KEY uq_referral_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── 5. Referrals ────────────────────────────────────────────────────
-- referred_efr_id is UNIQUE: one referrer per technician, first wins,
-- immutable. Without it the code could be swapped after joining to whoever is
-- paying — and the constraint enforces it even if the app is talked into
-- sending a second attribution.
--
-- qualified_at is separate from joined_at because the award is deliberately
-- NOT paid at signup. It is paid when the referred technician completes their
-- complete profile — Skills, Identity and Work Area must all be complete.
-- This is late enough to reject install/signup spam while rewarding the
-- referrer at the milestone the technician was actually invited to finish.
CREATE TABLE reward_referrals (
  id INT NOT NULL AUTO_INCREMENT,
  referrer_efr_id INT NOT NULL,
  referred_efr_id INT NOT NULL,
  code VARCHAR(24) NOT NULL,
  joined_at DATETIME NOT NULL,
  qualified_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_referred_once (referred_efr_id),
  KEY idx_referrer (referrer_efr_id, qualified_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── 6. Configuration ────────────────────────────────────────────────
-- Only TWO properties, and neither sets a point value.
--
-- The earn rates (10 rating / 30 SDA / 200 referral) are FIXED IN CODE
-- (services/rewards.service.js :: POINTS). They are the programme's published
-- terms — a technician is told what a same-day appointment is worth and plans
-- around it, so a rate ops could retune mid-month would turn that promise into
-- a moving target and leave rows awarded at the old rate indistinguishable
-- from new ones. Ops sees them read-only at GET /api/admin/rewards/config and
-- on the Reward Items page; changing them is a deploy, deliberately.
--
-- There is likewise NO master on/off switch. Rewards are on. A flag that
-- silently stopped points accruing while the app kept showing a balance and a
-- shop would be worse than having no programme.
INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'rewards.earn.cron', '0 2 * * *'
WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'rewards.earn.cron');

-- Seeded 'true' — unlike the reminder crons, which are opt-in. Earning IS the
-- programme; a rewards system installed switched-off would show every
-- technician a permanent zero.
INSERT INTO easyfix_properties (property_key, property_value)
SELECT 'rewards.earn.enabled', 'true'
WHERE NOT EXISTS (SELECT 1 FROM easyfix_properties WHERE property_key = 'rewards.earn.enabled');

-- ─── 7. Menu tree ────────────────────────────────────────────────────
-- Top-level parent at sequence 15 (LMS holds 14). The sidebar is a hard
-- 2-level tree, so these three are leaves.
INSERT INTO tbl_menu (menu_name, parent_menu, menu_depth, has_child, url, menu_status, sequence, icons, action_name)
SELECT 'Rewards', 0, 1, 1, 'javascript:;', 1, 15.0000, 'fa-gift', 'rewards'
 WHERE NOT EXISTS (SELECT 1 FROM tbl_menu WHERE menu_name = 'Rewards' AND parent_menu = 0);

INSERT INTO tbl_menu (menu_name, parent_menu, menu_depth, has_child, url, menu_status, sequence, icons, action_name)
SELECT 'Reward Items', p.menu_id, 2, 0, 'rewardItems', 1, 15.0001, 'fa-circle', 'rewardItems'
  FROM tbl_menu p
 WHERE p.menu_name = 'Rewards' AND p.parent_menu = 0
   AND NOT EXISTS (SELECT 1 FROM tbl_menu c WHERE c.url = 'rewardItems');

INSERT INTO tbl_menu (menu_name, parent_menu, menu_depth, has_child, url, menu_status, sequence, icons, action_name)
SELECT 'Reward Claims', p.menu_id, 2, 0, 'rewardClaims', 1, 15.0002, 'fa-circle', 'rewardClaims'
  FROM tbl_menu p
 WHERE p.menu_name = 'Rewards' AND p.parent_menu = 0
   AND NOT EXISTS (SELECT 1 FROM tbl_menu c WHERE c.url = 'rewardClaims');

INSERT INTO tbl_menu (menu_name, parent_menu, menu_depth, has_child, url, menu_status, sequence, icons, action_name)
SELECT 'Points Ledger', p.menu_id, 2, 0, 'rewardLedger', 1, 15.0003, 'fa-circle', 'rewardLedger'
  FROM tbl_menu p
 WHERE p.menu_name = 'Rewards' AND p.parent_menu = 0
   AND NOT EXISTS (SELECT 1 FROM tbl_menu c WHERE c.url = 'rewardLedger');

-- ─── 8. Action permission ────────────────────────────────────────────
INSERT INTO menu_action (menu_id, action_name, name, status, delete_status, created_on)
SELECT p.menu_id, 'isRewardsManage', 'Manage Rewards (items, claims, point adjustments)', 1, 0, NOW()
  FROM tbl_menu p
 WHERE p.menu_name = 'Rewards' AND p.parent_menu = 0
   AND NOT EXISTS (SELECT 1 FROM menu_action WHERE action_name = 'isRewardsManage');

-- ─── 9. Grant to Admin (role_id = 2) ─────────────────────────────────
UPDATE tbl_role SET menu_ids = CONCAT(COALESCE(menu_ids, ''), IF(menu_ids IS NULL OR menu_ids = '', '', ','), (SELECT menu_id FROM tbl_menu WHERE menu_name = 'Rewards' AND parent_menu = 0)) WHERE role_id = 2 AND NOT FIND_IN_SET((SELECT menu_id FROM tbl_menu WHERE menu_name = 'Rewards' AND parent_menu = 0), COALESCE(menu_ids, ''));

UPDATE tbl_role SET menu_ids = CONCAT(COALESCE(menu_ids, ''), IF(menu_ids IS NULL OR menu_ids = '', '', ','), (SELECT menu_id FROM tbl_menu WHERE url = 'rewardItems')) WHERE role_id = 2 AND NOT FIND_IN_SET((SELECT menu_id FROM tbl_menu WHERE url = 'rewardItems'), COALESCE(menu_ids, ''));

UPDATE tbl_role SET menu_ids = CONCAT(COALESCE(menu_ids, ''), IF(menu_ids IS NULL OR menu_ids = '', '', ','), (SELECT menu_id FROM tbl_menu WHERE url = 'rewardClaims')) WHERE role_id = 2 AND NOT FIND_IN_SET((SELECT menu_id FROM tbl_menu WHERE url = 'rewardClaims'), COALESCE(menu_ids, ''));

UPDATE tbl_role SET menu_ids = CONCAT(COALESCE(menu_ids, ''), IF(menu_ids IS NULL OR menu_ids = '', '', ','), (SELECT menu_id FROM tbl_menu WHERE url = 'rewardLedger')) WHERE role_id = 2 AND NOT FIND_IN_SET((SELECT menu_id FROM tbl_menu WHERE url = 'rewardLedger'), COALESCE(menu_ids, ''));

UPDATE role_menu_action SET isDeleted = 0 WHERE role_id = 2 AND isDeleted = 1 AND menu_action_id IN (SELECT id FROM menu_action WHERE action_name = 'isRewardsManage');

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0
  FROM menu_action ma
 WHERE ma.action_name = 'isRewardsManage'
   AND NOT EXISTS (SELECT 1 FROM role_menu_action rma WHERE rma.role_id = 2 AND rma.menu_action_id = ma.id);

-- ─── 10. Verify ──────────────────────────────────────────────────────
SELECT 'reward_points_ledger' AS what, COUNT(*) AS present FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'reward_points_ledger'
UNION ALL
SELECT 'reward_items', COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'reward_items'
UNION ALL
SELECT 'reward_claims', COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'reward_claims'
UNION ALL
SELECT 'reward_referral_codes', COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'reward_referral_codes'
UNION ALL
SELECT 'reward_referrals', COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'reward_referrals'
UNION ALL
SELECT 'rewards properties (expect 2)', COUNT(*) FROM easyfix_properties WHERE property_key LIKE 'rewards.%'
UNION ALL
SELECT 'Rewards menu rows (expect 4)', COUNT(*) FROM tbl_menu WHERE (menu_name = 'Rewards' AND parent_menu = 0) OR url IN ('rewardItems', 'rewardClaims', 'rewardLedger')
UNION ALL
SELECT 'isRewardsManage action', COUNT(*) FROM menu_action WHERE action_name = 'isRewardsManage';
