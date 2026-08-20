-- Per-role screen access for client SPOC roles.
--
-- WHY THIS TABLE EXISTS. The four roles (Store SPOC, Regional Manager, Senior
-- Leader, Finance) had their screen sets hard-coded in
-- services/client-access.service.js, which meant "give Finance the performance
-- book" was a code change, a review and a deploy. Per-SPOC overrides already
-- existed in easyfix_client_spoc_access; what was missing was the DEFAULT each
-- role starts from.
--
-- The code defaults remain the seed and the fallback. A missing table, or a
-- role with no row, resolves to exactly the behaviour that shipped before this
-- migration — so this can be deployed ahead of the CRM screen safely, and the
-- rows below are the current constants written down rather than a new policy.
--
-- `surfaces` is a CSV of surface keys rather than a join table on purpose:
-- there are six surfaces, the whole set is read together on every request, and
-- a six-row join per SPOC lookup buys nothing. It is validated against the
-- SURFACES list in the service before it is written.

CREATE TABLE IF NOT EXISTS `easyfix_client_role_access` (
  `role_id`    TINYINT UNSIGNED NOT NULL,
  `surfaces`   VARCHAR(255) NOT NULL,
  `all_stores` TINYINT(1) NOT NULL DEFAULT 0,
  `updated_by` INT UNSIGNED NULL,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`role_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed = the constants that were in code, so applying this migration changes
-- no one's access. Role 0 ("No Role") is deliberately NOT seeded: it is the
-- absence of configuration, not a configurable role, and its behaviour is
-- governed by UNASSIGNED_FAILS_OPEN in the service.
INSERT INTO `easyfix_client_role_access` (`role_id`, `surfaces`, `all_stores`) VALUES
  (1, 'home,open,completed,actions', 0),
  (2, 'home,open,completed,actions', 0),
  (3, 'home,open,completed,actions,performance,invoicing', 1),
  (4, 'home,open,completed,invoicing', 1)
ON DUPLICATE KEY UPDATE `role_id` = `role_id`;
