-- Make technician training progress monotonic and concurrency-safe.
--
-- READ-ONLY baseline captured 2026-08-11:
--   engine=MyISAM, rows=9,461, unique technician/video pairs=7,224,
--   duplicate pairs=1,023, duplicate surplus rows=2,237, max rows/pair=23,
--   NULL technician keys=0, NULL video keys=0.
-- Existing indexes cover easyfixer_id and video_id independently, but no unique
-- pair exists. The service can use one atomic INSERT ... ON DUPLICATE KEY UPDATE
-- only after this migration lands.
--
-- MyISAM does not support transactional/online DDL. Run with ALL unified
-- backend and legacy Java training writers stopped/drained BEFORE deploying the
-- new service code. LOCK TABLES protects the snapshot and consolidation, but
-- MySQL may release an explicit table lock around ALTER TABLE; writer
-- quiescence is therefore a deployment precondition, not an optimization.
-- Keep writers stopped until the verification queries below confirm both zero
-- duplicate groups and the exact UNIQUE key.

-- The legacy Java writer may UPDATE an existing row after this migration. Its
-- read-then-save path must not lower progress already advanced by an offline
-- replay, so enforce the monotonic invariant in the shared database as well as
-- in the unified backend's atomic upsert.
DROP TRIGGER IF EXISTS trg_easyfixer_watched_video_monotonic;
CREATE TRIGGER trg_easyfixer_watched_video_monotonic
BEFORE UPDATE ON easyfixer_watched_video
FOR EACH ROW
SET NEW.watched_percentage = GREATEST(
  COALESCE(OLD.watched_percentage, 0),
  COALESCE(NEW.watched_percentage, 0)
);

LOCK TABLES easyfixer_watched_video WRITE;

DROP TEMPORARY TABLE IF EXISTS tmp_training_progress_dedupe;
CREATE TEMPORARY TABLE tmp_training_progress_dedupe AS
SELECT easyfixer_id,
       video_id,
       MAX(id) AS keep_id,
       MAX(COALESCE(watched_percentage, 0)) AS max_percentage,
       MAX(update_date) AS latest_update
  FROM easyfixer_watched_video
 WHERE easyfixer_id IS NOT NULL
   AND video_id IS NOT NULL
 GROUP BY easyfixer_id, video_id;

ALTER TABLE tmp_training_progress_dedupe
  ADD PRIMARY KEY (easyfixer_id, video_id),
  ADD UNIQUE KEY uq_training_progress_keep_id (keep_id);

-- Preserve the greatest observed progress and latest timestamp on the one row
-- retained for each technician/video pair.
-- Keep the locked table unaliased. With explicit table locks MySQL requires
-- statements to reference the table using the exact name (or exact alias)
-- declared by LOCK TABLES.
UPDATE easyfixer_watched_video
JOIN tmp_training_progress_dedupe
  ON tmp_training_progress_dedupe.keep_id = easyfixer_watched_video.id
   SET easyfixer_watched_video.watched_percentage =
         tmp_training_progress_dedupe.max_percentage,
       easyfixer_watched_video.update_date = COALESCE(
         tmp_training_progress_dedupe.latest_update,
         easyfixer_watched_video.update_date
       );

DELETE FROM easyfixer_watched_video
 WHERE easyfixer_id IS NOT NULL
   AND video_id IS NOT NULL
   AND id NOT IN (
     SELECT keep_id
       FROM tmp_training_progress_dedupe
   );

SET @has_training_progress_unique = (
  SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME = 'easyfixer_watched_video'
     AND INDEX_NAME = 'uq_easyfixer_watched_video'
);
SET @ddl_training_progress_unique = IF(
  @has_training_progress_unique = 0,
  'ALTER TABLE easyfixer_watched_video ADD UNIQUE KEY uq_easyfixer_watched_video (easyfixer_id, video_id)',
  'SELECT 1'
);
PREPARE stmt_training_progress_unique FROM @ddl_training_progress_unique;
EXECUTE stmt_training_progress_unique;
DEALLOCATE PREPARE stmt_training_progress_unique;

DROP TEMPORARY TABLE tmp_training_progress_dedupe;
UNLOCK TABLES;

-- Verification (read-only):
-- SELECT easyfixer_id, video_id, COUNT(*) n
--   FROM easyfixer_watched_video
--  GROUP BY easyfixer_id, video_id HAVING n > 1 LIMIT 1;
-- SHOW INDEX FROM easyfixer_watched_video
--  WHERE Key_name = 'uq_easyfixer_watched_video';
-- SHOW TRIGGERS WHERE `Table` = 'easyfixer_watched_video'
--   AND `Trigger` = 'trg_easyfixer_watched_video_monotonic';
