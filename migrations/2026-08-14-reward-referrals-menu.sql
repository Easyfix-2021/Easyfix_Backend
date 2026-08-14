-- CRM Rewards > Referral Qualifications (read-only).
--
-- Apply after 2026-08-13-rewards-foundation.sql. The Rewards foundation owns
-- the top-level parent and sequences 15.0001-15.0003. This additive migration
-- creates the fourth leaf without changing or re-granting the write-capable
-- isRewardsManage action. Every write is idempotent and safely no-ops if the
-- expected Rewards parent has not yet been applied.

INSERT INTO tbl_menu (
  menu_name, parent_menu, menu_depth, has_child, url,
  menu_status, sequence, icons, action_name
)
SELECT 'Referral Qualifications', p.menu_id, 2, 0, 'rewardReferrals',
       1, 15.0004, 'fa-circle', 'rewardReferrals'
  FROM tbl_menu p
 WHERE p.menu_name = 'Rewards'
   AND p.parent_menu = 0
   AND NOT EXISTS (
     SELECT 1 FROM tbl_menu c WHERE c.url = 'rewardReferrals'
   );

-- Dedicated View permission: this audit page has no correction/override API.
INSERT INTO menu_action (
  menu_id, action_name, name, status, delete_status, created_on
)
SELECT m.menu_id, 'isRewardReferralsView', 'View Reward Referral Qualifications',
       1, 0, NOW()
  FROM tbl_menu m
 WHERE m.url = 'rewardReferrals'
   AND NOT EXISTS (
     SELECT 1 FROM menu_action ma
      WHERE ma.action_name = 'isRewardReferralsView'
   );

-- Admin (role_id=2) receives the new leaf and view action. CASE keeps a
-- repeated run byte-for-byte stable and safely handles NULL/empty CSV values.
UPDATE tbl_role r
  JOIN tbl_menu m ON m.url = 'rewardReferrals'
   SET r.menu_ids = CASE
     WHEN r.menu_ids IS NULL OR r.menu_ids = '' THEN CAST(m.menu_id AS CHAR)
     WHEN FIND_IN_SET(m.menu_id, r.menu_ids) > 0 THEN r.menu_ids
     ELSE CONCAT(r.menu_ids, ',', m.menu_id)
   END
 WHERE r.role_id = 2;

UPDATE role_menu_action
   SET isDeleted = 0
 WHERE role_id = 2
   AND isDeleted = 1
   AND menu_action_id IN (
     SELECT id FROM menu_action WHERE action_name = 'isRewardReferralsView'
   );

INSERT INTO role_menu_action (role_id, menu_action_id, isDeleted)
SELECT 2, ma.id, 0
  FROM menu_action ma
 WHERE ma.action_name = 'isRewardReferralsView'
   AND NOT EXISTS (
     SELECT 1 FROM role_menu_action rma
      WHERE rma.role_id = 2
        AND rma.menu_action_id = ma.id
   );

-- Verification: each count must be exactly 1 after either the first or any
-- repeated run. The last value confirms the Admin role can see the leaf.
SELECT 'rewardReferrals menu leaf' AS what, COUNT(*) AS present
  FROM tbl_menu WHERE url = 'rewardReferrals'
UNION ALL
SELECT 'isRewardReferralsView action', COUNT(*)
  FROM menu_action WHERE action_name = 'isRewardReferralsView'
UNION ALL
SELECT 'Admin rewardReferrals menu grant', COUNT(*)
  FROM tbl_role r
  JOIN tbl_menu m ON m.url = 'rewardReferrals'
 WHERE r.role_id = 2 AND FIND_IN_SET(m.menu_id, COALESCE(r.menu_ids, '')) > 0
UNION ALL
SELECT 'Admin referral view grant', COUNT(*)
  FROM role_menu_action rma
  JOIN menu_action ma ON ma.id = rma.menu_action_id
 WHERE rma.role_id = 2
   AND rma.isDeleted = 0
   AND ma.action_name = 'isRewardReferralsView';
