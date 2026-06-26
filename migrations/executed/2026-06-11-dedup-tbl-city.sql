-- 2026-06-11 — Deduplicate tbl_city by case-insensitive name.
--
-- KEEP RULE: for each set of rows with the same LOWER(TRIM(city_name)),
-- keep the row with the smallest city_id (= oldest record). Remap
-- every known FK reference to point at the kept id, then DELETE the
-- duplicates.
--
-- ⚠️ REVIEW BEFORE APPLYING. Run preview SELECT (Step 1) first and
-- confirm the merge set looks correct. Run the whole script in a
-- transaction in dev/staging first. Common gotcha: any table with a
-- city_id / efr_cityId / cityId FK that's NOT in the UPDATE list below
-- will get an orphan reference if its row pointed at a dupe. The list
-- here covers every reference grep'd from this repo's services/*.js;
-- audit other repos (legacy CRM, mobile, client UI) before applying.

-- ─── Step 1: preview ────────────────────────────────────────────────
-- Run this SELECT alone first. It shows every dup group + the IDs
-- being merged. If any row looks wrong (e.g. two distinct cities
-- spelt the same), abort.
--
-- SELECT LOWER(TRIM(city_name)) AS norm,
--        COUNT(*)              AS dupes,
--        MIN(city_id)          AS keep_id,
--        GROUP_CONCAT(city_id ORDER BY city_id) AS all_ids
--   FROM tbl_city
--  GROUP BY norm
-- HAVING COUNT(*) > 1
--  ORDER BY dupes DESC, norm;

-- ─── Step 2: build the remap table ──────────────────────────────────
CREATE TEMPORARY TABLE _city_remap (
  dupe_city_id INT NOT NULL,
  kept_city_id INT NOT NULL,
  PRIMARY KEY (dupe_city_id),
  KEY idx_kept (kept_city_id)
) ENGINE=InnoDB;

INSERT INTO _city_remap (dupe_city_id, kept_city_id)
SELECT c.city_id, k.kept_city_id
  FROM tbl_city c
  JOIN (
    SELECT LOWER(TRIM(city_name)) AS norm, MIN(city_id) AS kept_city_id
      FROM tbl_city
     GROUP BY norm
    HAVING COUNT(*) > 1
  ) k
    ON LOWER(TRIM(c.city_name)) = k.norm
 WHERE c.city_id <> k.kept_city_id;

-- ─── Step 3: remap every known FK ───────────────────────────────────
-- Tables grep'd from EasyFix_Backend services/*.js. Add UPDATEs for
-- any other tables you discover before running.

UPDATE tbl_pincode p
  JOIN _city_remap r ON r.dupe_city_id = p.city_id
   SET p.city_id = r.kept_city_id;

UPDATE tbl_easyfixer e
  JOIN _city_remap r ON r.dupe_city_id = e.efr_cityId
   SET e.efr_cityId = r.kept_city_id;

UPDATE tbl_client cl
  JOIN _city_remap r ON r.dupe_city_id = cl.city_id
   SET cl.city_id = r.kept_city_id;

UPDATE tbl_zone_city_mapping zcm
  JOIN _city_remap r ON r.dupe_city_id = zcm.city_id
   SET zcm.city_id = r.kept_city_id;

UPDATE tbl_zone_master zm
  JOIN _city_remap r ON r.dupe_city_id = zm.city_id
   SET zm.city_id = r.kept_city_id;

-- ─── Step 4: delete the duplicate city rows ─────────────────────────
DELETE c
  FROM tbl_city c
  JOIN _city_remap r ON r.dupe_city_id = c.city_id;

DROP TEMPORARY TABLE _city_remap;

-- ─── Step 5: post-check ─────────────────────────────────────────────
-- Run this — should return zero rows.
--
-- SELECT LOWER(TRIM(city_name)) AS norm, COUNT(*) AS n
--   FROM tbl_city
--  GROUP BY norm
-- HAVING COUNT(*) > 1;
