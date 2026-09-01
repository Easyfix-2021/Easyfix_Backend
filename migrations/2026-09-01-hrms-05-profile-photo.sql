-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-01 — HRMS profile: self-service profile photo
--
-- ONE column, on the SIDE table. tbl_user is NOT touched: CLAUDE.md forbids
-- altering it (five legacy services share it), and tbl_user_personal_details
-- (2026-08-03) exists precisely so the next per-user field is an ADD COLUMN
-- here rather than a new side table keyed on the same user_id. Additive only.
--
-- Sibling migration, same day: 2026-09-01-hrms-01-extend-user-personal-details
-- adds date_of_birth + the bank_* family to this same table. The two are
-- deliberately SEPARATE FILES and can be applied in either order — each ADD is
-- independently probed, and none of them positions itself relative to a column
-- another file adds (see the AFTER note below).
--
-- ── Column notes ────────────────────────────────────────────────────────
-- profile_image_key  VARCHAR(255) NULL. An S3 OBJECT KEY, not a URL and not
--                    image bytes. Shape: `ProfilePhotos/u<userId>_<ts>_<rand8>`
--                    — the same timestamp+random shape as the Notices/ and
--                    ClientDocs/ prefixes already in utils/s3-storage.js.
--
--                    ⚠ THE KEY CARRIES NO FILE EXTENSION. That is the standing
--                    repo convention (utils/s3-storage.js header, 2026-05-15):
--                    the MIME type rides on the object's Content-Type header at
--                    PutObject time and the original filename is stashed in
--                    object metadata. A reader that appends '.jpg' to this value
--                    will 404.
--
--                    NULL means "no photo", and that is the ONLY way to say it —
--                    the DELETE endpoint writes NULL rather than an empty
--                    string, so a reader never has to treat '' and NULL alike.
--
--                    255 is the ceiling every other S3-key column in this schema
--                    uses; the generated key is ~40 characters, so this is
--                    headroom rather than a measurement.
--
--                    NOT indexed. Nothing looks a user up BY their photo key —
--                    every read is `WHERE user_id = ?` on the primary key, and
--                    the values are unique-by-construction anyway.
--
--                    NULLABLE with no DEFAULT, like every other column on this
--                    table: ~7.5k existing users have no photo and a NOT NULL
--                    would mean back-filling all of them before anyone could be
--                    edited.
--
-- ── WHY NO `AFTER <column>` ─────────────────────────────────────────────
-- hrms-01 chains its six ADDs with `AFTER`, each naming the column the previous
-- one added. This file must NOT join that chain: it would then only apply
-- cleanly on a host where hrms-01 has already run, turning two independent
-- migrations into an ordered pair for a purely cosmetic column position. The
-- column lands last; ordinal position is not a contract anything reads.
--
-- The ADD is wrapped in an information_schema.columns existence probe (the
-- idiom from hrms-01 and 2026-08-13-ensure-easyfixer-withdrawal-storage.sql), so
-- re-running this file is a no-op rather than an ER_DUP_FIELDNAME.
-- `ALTER TABLE … ADD COLUMN IF NOT EXISTS` is NOT used: MariaDB-only syntax,
-- and this is MySQL.
--
-- The procedure name is unique to this file (`_ensure_hrms_profile_photo_column`)
-- so applying it alongside hrms-01 — which defines and DROPs its own
-- `_ensure_hrms_personal_detail_columns` — cannot have one file drop the other's
-- procedure mid-run.
-- ─────────────────────────────────────────────────────────────────────

-- ── Dry run (read-only) — what does this host have BEFORE the write? ──
-- Expect NO profile_image_key on a host that has never had this applied;
-- expect exactly one row for it on a re-run.
SELECT column_name, data_type, character_maximum_length, is_nullable
  FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND table_name = 'tbl_user_personal_details'
 ORDER BY ordinal_position;

DELIMITER $$

DROP PROCEDURE IF EXISTS _ensure_hrms_profile_photo_column$$
CREATE PROCEDURE _ensure_hrms_profile_photo_column()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = 'tbl_user_personal_details'
       AND column_name = 'profile_image_key'
  ) THEN
    ALTER TABLE tbl_user_personal_details
      ADD COLUMN profile_image_key VARCHAR(255) NULL DEFAULT NULL;
  END IF;
END$$

DELIMITER ;

CALL _ensure_hrms_profile_photo_column();
DROP PROCEDURE _ensure_hrms_profile_photo_column;

-- ── Read-only post-apply verification ─────────────────────────────────
-- Must list profile_image_key as varchar(255), nullable.
SELECT column_name, data_type, character_maximum_length, is_nullable
  FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND table_name = 'tbl_user_personal_details'
   AND column_name = 'profile_image_key';

-- Every stored value must be a `ProfilePhotos/` key with NO file extension.
-- A row here with a '.' in the tail, an 'http' prefix, or a '/easydoc/' path is
-- a write that bypassed services/profile-photo.service.js — a defect, not a
-- variant, because the read path presigns the value as an S3 key verbatim.
SELECT user_id, profile_image_key
  FROM tbl_user_personal_details
 WHERE profile_image_key IS NOT NULL
   AND profile_image_key NOT LIKE 'ProfilePhotos/%'
 ORDER BY user_id
 LIMIT 20;
