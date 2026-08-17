-- =====================================================================
-- Manage-Jobs export — EXPLAIN pack + index recommendations
-- =====================================================================
--
-- The export runs as a DEFERRED JOIN, so there are two shapes to tune and
-- they have completely different cost profiles:
--
--   PHASE 1  SELECT J.job_id  ·  11 joins  ·  the filters  ·  ORDER BY job_id DESC LIMIT n
--            This is the one that matters. It runs once per chunk and it is
--            what decides whether the export walks an index or scans tbl_job.
--
--   PHASE 2  the full 31-join projection  ·  WHERE J.job_id IN (<=2000 ids)
--            Driven entirely by primary keys. If phase 1 is fast, this is fast.
--
-- Run everything below on a REPLICA or during a quiet window: EXPLAIN ANALYZE
-- actually executes the statement.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. WHAT INDEXES EXIST TODAY
--    Run this first — several recommendations below may already be in place.
-- ---------------------------------------------------------------------
SELECT TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, CARDINALITY
  FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME IN ('tbl_job','tbl_address','tbl_city','tbl_customer','tbl_easyfixer',
                      'tbl_job_offer','tbl_estimate_details','tbl_job_assignee_history',
                      'tbl_vertical_mapping','tbl_easyfixer_rating_by_customer')
 ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;

-- Table sizes, so the derived-table cost is a number rather than a guess.
SELECT TABLE_NAME, TABLE_ROWS,
       ROUND((DATA_LENGTH + INDEX_LENGTH)/1024/1024) AS mb
  FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME IN ('tbl_job','tbl_job_offer','tbl_estimate_details','tbl_job_assignee_history')
 ORDER BY TABLE_ROWS DESC;


-- ---------------------------------------------------------------------
-- 2. PHASE 1 — the query to tune
--    Representative worst case: one client, a one-month window, nothing else
--    narrowing it. Substitute your own client id / dates.
-- ---------------------------------------------------------------------
EXPLAIN ANALYZE
SELECT J.job_id
  FROM tbl_job J
  LEFT JOIN tbl_customer  C   ON C.customer_id   = J.fk_customer_id
  LEFT JOIN tbl_client    CL  ON CL.client_id    = J.fk_client_id
  LEFT JOIN tbl_easyfixer EFR ON EFR.efr_id      = J.fk_easyfixter_id
  LEFT JOIN tbl_easyfixer_rating_by_customer TERBC ON TERBC.job_id = J.job_id
  LEFT JOIN tbl_client_contacts contact ON contact.id = J.reporting_contact_id
  LEFT JOIN action_taken_reason atr ON atr.id =
    IF(J.cancel_date_time IS NOT NULL AND J.remarks_date_time IS NOT NULL,
       IF(TIMEDIFF(J.cancel_date_time, J.remarks_date_time) > 0, J.cancel_reason_id, J.enum_reason_id),
       IF(J.cancel_date_time IS NOT NULL AND J.remarks_date_time IS NULL, J.cancel_reason_id,
          IF(J.remarks_date_time IS NOT NULL AND J.cancel_date_time IS NULL, J.enum_reason_id, NULL)))
  LEFT JOIN user_type ut ON ut.id = atr.user_type
  LEFT JOIN tbl_address A ON A.customer_id = J.fk_customer_id AND A.address_id = J.fk_address_id
  LEFT JOIN tbl_city city ON city.city_id = A.city_id
  LEFT JOIN tbl_vertical_mapping TVM ON TVM.client_id = CL.client_id
  LEFT JOIN tbl_vertical V ON V.vertical_id = TVM.vertical_id
 WHERE J.fk_client_id = 239
   AND J.created_date_time >= '2026-07-01 00:00:00'
   AND J.created_date_time <  '2026-08-01 00:00:00'
 GROUP BY J.job_id
 ORDER BY J.job_id DESC
 LIMIT 2000;

-- The SECOND chunk onwards adds the keyset predicate. Check this too — it is
-- the shape that runs 49 times out of 50, and it should get cheaper, not
-- costlier, as the export progresses.
--   ... AND J.job_id < 527417
--   ORDER BY J.job_id DESC LIMIT 2000;


-- WHAT TO LOOK FOR IN THE OUTPUT
--   GOOD  "Index range scan on J using <idx>"  +  a small "rows=" estimate
--   BAD   "Table scan on J"                    →  no usable index
--   BAD   "Sort: J.job_id DESC"                →  the ORDER BY is not being
--                                                 satisfied by the index, so
--                                                 MySQL materialises the whole
--                                                 filtered set before LIMIT.
--                                                 THIS is what makes a chunked
--                                                 export quadratic.
--   BAD   "Using temporary"                    →  usually the GROUP BY; see §4.


-- ---------------------------------------------------------------------
-- 3. RECOMMENDED INDEXES
--
-- The shape that matters is (equality columns …, range column, job_id).
-- Trailing job_id lets InnoDB satisfy `ORDER BY job_id DESC LIMIT n` from the
-- index and stop early, instead of sorting every matching row per chunk.
--
-- Add them one at a time and re-run §2. Each is ONLINE in MySQL 8
-- (ALGORITHM=INPLACE, LOCK=NONE) but still costs IO on a large tbl_job — run
-- in a maintenance window.
-- ---------------------------------------------------------------------

-- 3a. The most common export: one client over a booking-date window.
ALTER TABLE tbl_job ADD INDEX idx_export_client_created (fk_client_id, created_date_time, job_id);

-- 3b. Status-filtered exports (the status tabs), same window.
ALTER TABLE tbl_job ADD INDEX idx_export_status_created (job_status, created_date_time, job_id);

-- 3c. dateType switches the range column. These four are the ones the UI can
--     actually select; add only those your operators use.
ALTER TABLE tbl_job ADD INDEX idx_export_requested  (requested_date_time, job_id);
ALTER TABLE tbl_job ADD INDEX idx_export_scheduled  (scheduled_date_time, job_id);
ALTER TABLE tbl_job ADD INDEX idx_export_checkout   (checkout_date_time,  job_id);
ALTER TABLE tbl_job ADD INDEX idx_export_cancelled  (cancel_date_time,    job_id);

-- 3d. The address join is on a COMPOSITE (customer_id, address_id) — a
--     single-column index on either side will not serve it.
ALTER TABLE tbl_address ADD INDEX idx_addr_customer_address (customer_id, address_id);

-- 3e. Filter targets outside tbl_job.
ALTER TABLE tbl_address  ADD INDEX idx_addr_pincode (pin_code);
ALTER TABLE tbl_easyfixer ADD INDEX idx_efr_no      (efr_no);
ALTER TABLE tbl_customer  ADD INDEX idx_cust_mobile (customer_mob_no);

-- 3f. Phase 2's derived tables. Each is now bounded by IN (<chunk ids>), so a
--     job_id index turns a full scan into a point lookup per chunk. If these
--     are missing, the deferred join gains far less than it should.
ALTER TABLE tbl_job_offer             ADD INDEX idx_jo_job  (job_id);
ALTER TABLE tbl_estimate_details      ADD INDEX idx_ted_job (job_id, id);
ALTER TABLE tbl_job_assignee_history  ADD INDEX idx_jah_job (job_id, id);


-- ---------------------------------------------------------------------
-- 4. IF "Using temporary" PERSISTS
--
-- Phase 1 carries GROUP BY J.job_id purely to de-duplicate the fan-out from
-- tbl_vertical_mapping (a client can map to several verticals) and from
-- tbl_easyfixer_rating_by_customer. Legacy did the same.
--
-- If EXPLAIN shows the GROUP BY forcing a temporary table on large result
-- sets, DISTINCT is equivalent here — phase 1 selects a single column — and
-- the optimiser can sometimes satisfy it from the index instead:
--     SELECT DISTINCT J.job_id ...   (drop the GROUP BY)
-- Measure both before changing the code; on an indexed plan they are usually
-- identical.
-- ---------------------------------------------------------------------


-- ---------------------------------------------------------------------
-- 5. PHASE 2 — sanity check only
--    Substitute real ids. This should be all "eq_ref"/"const" on primary keys.
--    If anything here shows a table scan, it is a MISSING INDEX on that
--    table's job_id, not a problem with the export.
-- ---------------------------------------------------------------------
-- EXPLAIN ANALYZE <the EXPORT_SELECT from services/job-export.service.js>
--   WHERE J.job_id IN (527714, 527417, ...)
--   GROUP BY J.job_id ORDER BY J.job_id DESC;
