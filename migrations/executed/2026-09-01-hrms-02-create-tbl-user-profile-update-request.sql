-- ─────────────────────────────────────────────────────────────────────
-- 2026-09-01 — HR approval queue for self-service profile changes
--
-- WHAT: a CRM user can edit their own alternate number freely, but a change to
-- their mobile number, their date of birth (after the one free set) or their
-- payout bank details is a REQUEST that HR approves. This table is that queue.
--
-- WHY A NEW TABLE IS ALLOWED HERE: CLAUDE.md's rule is "never alter schema,
-- never add tables" — and its stated exception is an EasyFix-OWNED table that
-- NO legacy service references. This is squarely that: nothing in the five
-- services sharing easyfix_core (CRM, Dropwizard :8090, ACD_APIs,
-- API_AngularClientDashboard, Webhook_2023) knows this table exists or ever
-- will, because self-service profile approval is a NEW EasyFix surface with no
-- legacy counterpart. Same route already taken by tbl_pincode (2026-05-01),
-- tbl_user_allowed_stages (2026-07-29), tbl_user_entra_provisioning
-- (2026-07-30) and tbl_user_personal_details (2026-08-03).
--
-- The alternative — a pending_* column family on tbl_user — is exactly what the
-- rule forbids, and would also be wrong on its own terms: a request has a
-- lifecycle, an approver and remarks, none of which fit as columns beside the
-- live value.
--
-- ── ONE PENDING REQUEST PER USER, AND WHY NO UNIQUE INDEX ENFORCES IT ─────
-- A user has AT MOST ONE row with status='pending'. It is a DRAFT THAT
-- ACCUMULATES: a second submission MERGES into the open row — keys present
-- overwrite, keys absent are left alone — so "DOB on Monday, mobile on Tuesday"
-- ends as ONE request carrying both, and HR approves or rejects the whole thing
-- as a unit.
--
-- That invariant is enforced in the SERVICE, not by the schema, and the reason
-- is that MySQL cannot express it:
--
--   * MySQL has NO partial / filtered unique index. `UNIQUE (user_id) WHERE
--     status='pending'` is PostgreSQL and SQL Server syntax; there is no MySQL
--     equivalent, and a functional index on a CASE expression cannot be UNIQUE
--     over only a subset of rows either — NULLs are permitted repeatedly, which
--     is the standard trick, but it demands a generated column on a table we
--     would then have to keep migrating.
--   * A PLAIN `UNIQUE (user_id)` would enforce one row per user FOREVER, not
--     one PENDING row. The moment the first request is approved the user could
--     never file a second one — the historical row would block them
--     permanently. That is a worse bug than the one it prevents.
--   * A PLAIN `UNIQUE (user_id, status)` fails on the SECOND approval instead:
--     the user would be allowed exactly one approved and one rejected request
--     for the rest of their employment, and the third would be rejected by the
--     database with an opaque ER_DUP_ENTRY on a write HR just authorised.
--
-- So the service holds it, and the LOCK is the load-bearing part, not the
-- check: inside a transaction it does `SELECT … WHERE user_id = ? AND status =
-- 'pending' FOR UPDATE`, then merges-and-UPDATEs that row or INSERTs a new one.
-- A read-then-write WITHOUT `FOR UPDATE` lets two browser tabs both read "no
-- pending row" and both INSERT — two pending requests for one user, which is
-- the precise thing this model exists to prevent. idx_user_status below is what
-- makes that locking read an index lookup rather than a table scan.
--
-- ── Column notes ────────────────────────────────────────────────────────
-- request_id    Surrogate PK. Also the id in DELETE /api/profile/update-
--               requests/:id, which must additionally match on user_id — an id
--               in a URL is not proof of ownership.
-- user_id       tbl_user.user_id — the SUBJECT of the request, always
--               req.user.user_id, never a :userId from the path. No FK
--               constraint: the legacy schema does not use them here, and a
--               tbl_user write must never be blockable by this table.
-- changes       JSON text holding ONLY the keys being changed, e.g.
--                 {"mobile_no":"9876543210","date_of_birth":"1994-03-08",
--                  "bank":{"account_number":"…","ifsc":"…",
--                          "account_name":"…","bank_name":"…"}}
--               TEXT, not the native JSON type: the payload is small, is never
--               queried by key, and TEXT keeps the file replayable on the older
--               MySQL some legacy hosts still run. NOT NULL — a request with no
--               changes is not a request; the route rejects an empty object
--               before it ever reaches here.
-- old_values    The same keys as `changes`, holding the values as they stood
--               when each key FIRST entered the request — so the approver sees
--               a true before/after even after several merges. NULLABLE because
--               a first-time value has no "before" (a user with no DOB and no
--               bank details on file submits both as new).
-- status        'pending' | 'approved' | 'rejected'. VARCHAR rather than ENUM:
--               adding a state to an ENUM is an ALTER, and this table will
--               plausibly grow a 'withdrawn' state. Approval flips it with a
--               CONDITIONAL `UPDATE … WHERE status='pending'` so two approvers
--               racing produce one apply and one 409, not two applies.
-- requested_on  When the request was FIRST opened. Written by the app as
-- updated_on    `new Date()` so the pool's +05:30 session timezone stores the
-- processed_on  IST wall clock verbatim. NO `DEFAULT CURRENT_TIMESTAMP` on any
--               of the three, and no `ON UPDATE CURRENT_TIMESTAMP` on
--               updated_on: the server clock is UTC, so a DB-side default would
--               silently mix two timezones into one column and nothing would
--               report it. updated_on is NULL until the first merge — a request
--               submitted once and never added to has never been updated.
-- processed_by  tbl_user.user_id of the approver/rejector. NULL while pending.
-- remarks       HR's note, shown to the user. Most useful on a rejection, which
--               is why the process route takes it for both actions.
--
-- idx_status       drives the HR queue's default "pending" filter.
-- idx_user_status  drives the self-service read AND the `FOR UPDATE` lock read
--                  described above. Leading column user_id, so it also serves
--                  a plain per-user history lookup.
-- ─────────────────────────────────────────────────────────────────────

-- ── Dry run (read-only) — does this host already have the table? ──────
-- Zero rows = a fresh apply. One row = a re-run, and the CREATE below is a
-- no-op via IF NOT EXISTS.
SELECT table_name, engine, table_rows
  FROM information_schema.tables
 WHERE table_schema = DATABASE()
   AND table_name = 'tbl_user_profile_update_request';

CREATE TABLE IF NOT EXISTS tbl_user_profile_update_request (
  request_id   INT NOT NULL AUTO_INCREMENT,
  user_id      INT NOT NULL,
  changes      TEXT NOT NULL,
  old_values   TEXT NULL DEFAULT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'pending',
  requested_on DATETIME NOT NULL,
  updated_on   DATETIME NULL DEFAULT NULL,
  processed_on DATETIME NULL DEFAULT NULL,
  processed_by INT NULL DEFAULT NULL,
  remarks      VARCHAR(255) NULL DEFAULT NULL,
  PRIMARY KEY (request_id),
  KEY idx_status (status),
  KEY idx_user_status (user_id, status)
) ENGINE=InnoDB;

-- ── Read-only post-apply verification ─────────────────────────────────
-- Expect the ten columns above, then both secondary indexes.
SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = DATABASE()
   AND table_name = 'tbl_user_profile_update_request'
 ORDER BY ordinal_position;

SELECT index_name, seq_in_index, column_name, non_unique
  FROM information_schema.statistics
 WHERE table_schema = DATABASE()
   AND table_name = 'tbl_user_profile_update_request'
 ORDER BY index_name, seq_in_index;
