-- ─────────────────────────────────────────────────────────────────────
-- 2026-08-04 — Ops conference calling on Plivo (Multi-Party Call)
--
-- WHAT: ONE new EasyFix-owned table for the ROOM (tbl_job_conference), plus
-- two-and-a-bit columns on the EXISTING tbl_plivo_call_log so a conference
-- PARTICIPANT is just what it actually is — another call leg.
--
-- WHY THIS EXISTS AT ALL: ops today click-to-call ONE person and, to bring a
-- second person in, must hang up and redial. Plivo cannot promote a live
-- <Dial> into a conference — <Dial> and MPC are different objects with no
-- conversion API — so EVERY ops call now starts as an MPC carrying a single
-- participant. Ops sees no difference (click Call, it rings, they talk); the
-- leg is simply already a conference participant, so "add someone" is one API
-- call away at any moment.
--
-- ══════════════════════════════════════════════════════════════════════
-- ONE TABLE, NOT TWO — PARTICIPANTS ARE CALL-LOG ROWS
-- ══════════════════════════════════════════════════════════════════════
--
-- An earlier draft of this migration created a second table,
-- tbl_job_conference_participant. It is GONE, deliberately, and the reasoning
-- is load-bearing:
--
--   tbl_plivo_call_log (EasyFix-owned, executed/2026-06-19-plivo-call-log.sql)
--   already carries essentially every column a participant leg needs —
--   job_caller_info_id, job_id, call_mode, call_flow, caller_user_id,
--   caller_name, receiver_name, receiver_number, dialed_number, call_uuid,
--   status, hangup_cause, initiated_on, answered_on, ended_on, duration,
--   recording_url, recording_id.
--
--   A CONFERENCE PARTICIPANT LEG *IS* A CALL LEG. A second, parallel model of
--   the same thing would have to be kept in sync with this one forever, and
--   every existing call surface (GET /api/admin/calls, the per-job call-history
--   tooltip, the Call Info modal, recording playback, transcription, call
--   analysis) would have to learn about a table it has never heard of. Modelled
--   as call-log rows, most of those surfaces work BY CONSTRUCTION.
--
--   The structural permission for this already exists: job_caller_info_id on
--   tbl_plivo_call_log is a plain `KEY idx_plivo_log_jci`, NOT UNIQUE — several
--   legs per call have always been allowed by the schema. (Verify for yourself:
--   `SHOW CREATE TABLE tbl_plivo_call_log;` — the key must be KEY, not UNIQUE.)
--
-- ⚠ ONE tbl_job_caller_info ROW PER CALL, EXACTLY AS TODAY. Adding a person to
-- a live call does NOT insert an extra tbl_job_caller_info audit row. A
-- conference is ONE call that gained people; inflating tbl_job_caller_info
-- would silently inflate every existing call-count report (QuickSight Call
-- Tracking, the Click To Call tab, per-user call volumes). Added participants
-- get their own tbl_plivo_call_log row carrying the SAME job_caller_info_id
-- plus the new conference_id.
--
-- SHARED-DB RULE: tbl_job_conference is a new table NO legacy service
-- references — the same EasyFix-owned carve-out used by tbl_plivo_call_log
-- (2026-06-19), tbl_ai_call_session (2026-07-06), tbl_teleprompter_session
-- (2026-07-09), tbl_user_allowed_stages (2026-07-29) and
-- tbl_user_personal_details (2026-08-03). tbl_plivo_call_log is likewise
-- EasyFix-owned and has been ALTERed before — see
-- executed/2026-07-08-add-recording-url-to-plivo-call-log.sql for the precedent
-- and the exact style. NOTHING legacy is touched.
--
-- ══════════════════════════════════════════════════════════════════════
-- THERE ARE NO CONFIGURABLE LIMITS. PLIVO'S OWN DEFAULTS APPLY.
-- ══════════════════════════════════════════════════════════════════════
--
-- An earlier draft seeded three easyfix_properties cost knobs
-- (plivo.conference.max.duration.sec / .max.participants / .max.concurrent)
-- and snapshotted two of them onto every conference row. All five are GONE.
--
-- Removing them does NOT mean "unlimited". It means PLIVO'S OWN DEFAULTS
-- APPLY — the provider ceiling now lives where a provider ceiling belongs,
-- with the provider, instead of being duplicated (and drifting) here. We no
-- longer send maxDuration / maxParticipants on the <MultiPartyCall> element or
-- max_duration / max_participants on an add-participant request, so Plivo
-- applies whatever its account defaults are.
--
-- WHAT REMAINS AS THE COST GUARD, and it must keep working:
--
--   1. endMpcOnExit="true" on the OPERATOR's leg. The operator hanging up ends
--      the room for everyone. This is the PRIMARY guard, it is a product
--      decision, and it is NOT a configurable limit.
--   2. The reaper (services/conference-reaper-cron.js), now the ONLY backstop
--      for a room nobody hung up. Its ceiling is an INTERNAL constant in that
--      file, commented as a LEAK DETECTOR rather than a product limit, and
--      deliberately NOT a property: ops must not have to configure a safety
--      net, and a safety net someone can turn off is not one.
--   3. ring_timeout on each dialled leg — KEPT, and not a conference limit at
--      all: it is how long an unanswered participant rings. Every dialler needs
--      one. It reads `plivo.conference.ring.timeout.sec` (default 45s), which
--      is a DIALLER setting, not a spend cap.
--
-- ⚠ THERE IS ALSO NO `plivo.conference.enabled` FLAG. Conference is the DEFAULT
-- shape of every ops call, and the operational switch is the EXISTING
-- `plivo.calling.enabled` key (off ⇒ calls route to Kaleyra, which has no live
-- surface and therefore no conferences).
--
-- TIMESTAMPS: tbl_job_conference columns are written by the app as new Date();
-- the pool's +05:30 session timezone (db.js) stores the IST wall clock
-- verbatim. No DEFAULT CURRENT_TIMESTAMP — the server clock is UTC and would
-- silently mix two timezones into these columns (per
-- 2026-08-03-create-tbl-user-personal-details.sql).
-- ⚠ tbl_plivo_call_log keeps its OWN clock (SQL NOW(), per its 2026-06-19
-- header) for every column, conference legs included — a leg must read on the
-- existing call surfaces exactly like every other leg. The two clocks are
-- therefore different, which is why services/conference-reaper-cron.js sweeps
-- tbl_job_conference with an APP-SIDE Date cutoff and tbl_plivo_call_log with
-- NOW()-relative arithmetic. Each side is compared in its own clock; neither
-- comparison depends on the two agreeing.
--
-- ── tbl_job_conference — column notes ────────────────────────────────────
-- job_id            NULLABLE on purpose. A conference normally hangs off a job,
--                   but an ad-hoc ops call (customer lookup, callback) has no
--                   job and must still be recorded and reaped.
-- friendly_name     The Plivo MPC name. It is the API KEY for every MPC call:
--                   every endpoint is .../MultiPartyCall/name_{friendly_name}/.
--                   Generated app-side BEFORE the row is inserted (so it is
--                   stable and can be baked into the operator's answer XML) and
--                   UNIQUE, because two live conferences sharing a name would
--                   silently merge into one Plivo room.
-- mpc_uuid          Plivo's own MPCUUID. NULL until a status webhook or a
--                   read-back tells us — the MPC does not exist until the
--                   operator leg answers and enters it.
-- job_caller_info_id
--                   The ONE tbl_job_caller_info row this whole call is audited
--                   under. Every leg in tbl_plivo_call_log shares it. This is
--                   what makes a 3-party conference read as ONE call wherever a
--                   count is shown, and as three LEGS wherever detail is shown.
-- status            creating | live | ending | ended | failed.
--                   'creating' = row written, operator leg dialling, MPC not
--                   yet materialised. The reaper treats creating AND live as
--                   billable, because a stranded 'creating' row means the
--                   MPCStart webhook was lost, not that nothing is running.
-- job_status_snap / job_efr_id_snap
--                   tbl_job.job_status and the assigned technician AT
--                   CONFERENCE TIME. Mirrors the tbl_job_caller_info snapshot
--                   columns so "at which stage was this escalated?" is real
--                   history, not a re-projection of today's state.
-- billed_leg_seconds  From MPCBilledDuration on the MPCEnd webhook — the only
--                   way to answer "what did conferencing cost last month"
--                   without re-deriving it from leg timestamps. KEPT precisely
--                   BECAUSE the configurable caps are gone: with no ceiling of
--                   our own, the recorded spend is how we find out what
--                   conferencing actually costs.
-- end_reason        operator | last_left | reaper | max_duration | api | error.
--                   'reaper' is the one that matters: it means a conference
--                   outlived the leak-detector ceiling and was force-ended,
--                   i.e. a cost leak was caught. Count these.
--
-- DELIBERATELY ABSENT (all removed with the limits):
--   max_participants, max_duration_sec  — no caps are sent to Plivo any more,
--                   so there is nothing to snapshot.
--   participant_count, peak_participants — a stored counter that four writers
--                   incremented and decremented, and that nothing needed:
--                   it existed to feed the per-conference cap, which is gone.
--                   The live count is now DERIVED from tbl_plivo_call_log
--                   (services/plivo-call-log.service.js::countActiveConferenceLegs),
--                   which cannot drift from the legs it counts.
--
-- Indexes are sized to the hot readers: the reaper sweeps (status, created_on);
-- the live-status poll and the webhooks look a room up by id or friendly_name.
--
-- ── tbl_plivo_call_log — the three added columns ─────────────────────────
-- conference_id           The room this leg belongs to (tbl_job_conference.id).
--                         NULL for every ordinary 1:1 call, which is what makes
--                         "the operator/primary leg" expressible as
--                         `conference_id IS NULL OR participant_role='operator'`
--                         on the existing jci-keyed writers.
-- participant_role        operator | customer | customer_alt | technician |
--                         job_spoc | client_contact | custom. The same target
--                         vocabulary the existing click-to-call resolver
--                         speaks, so a roster add sends an IDENTIFIER and the
--                         SERVER resolves the digits — the operator never
--                         possesses the number. It is also the label every
--                         call-history surface shows per leg, so a conference
--                         reads as people rather than as three identical rows.
-- participant_target_id   The id behind participant_role (job_id / efr_id /
--                         client-contact id). NULL for 'custom', where the
--                         digits in dialed_number ARE the only record of what
--                         happened. Needed because the live panel has to answer
--                         "is this roster row already on the call?", and
--                         answering it by comparing phone numbers would mean
--                         loading phone numbers to answer a UI question.
-- conference_member_id    Plivo's MPC member id. A DIFFERENT identifier from
--                         call_uuid (which this table already has, and which
--                         holds the leg's ParticipantCallUUID): member_id is
--                         the path segment for update (mute/hold) and remove
--                         (kick). A leg without it can be observed but not
--                         controlled, so it cannot be folded into call_uuid.
--
-- Everything else a leg needs was already there:
--   display name  → receiver_name        who added the leg → caller_user_id
--   dialled digits→ dialed_number        joined at         → answered_on
--   leg uuid      → call_uuid            left at           → ended_on
--   leg status    → status               hangup reason     → hangup_cause
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tbl_job_conference (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  job_id              INT          NULL,
  friendly_name       VARCHAR(64)  NOT NULL,
  mpc_uuid            VARCHAR(64)  NULL,
  provider            VARCHAR(16)  NOT NULL DEFAULT 'plivo',
  started_by_user_id  INT          NULL,
  job_caller_info_id  INT          NULL,
  job_status_snap     INT          NULL,
  job_efr_id_snap     INT          NULL,
  status              VARCHAR(24)  NOT NULL,
  started_on          DATETIME     NULL,
  ended_on            DATETIME     NULL,
  duration            INT          NULL,
  billed_leg_seconds  INT          NULL,
  end_reason          VARCHAR(32)  NULL,
  error               VARCHAR(255) NULL,
  created_on          DATETIME     NOT NULL,
  updated_on          DATETIME     NULL,
  UNIQUE KEY uq_conf_friendly_name (friendly_name),
  KEY idx_conf_job (job_id),
  KEY idx_conf_status_created (status, created_on),
  KEY idx_conf_mpc_uuid (mpc_uuid),
  KEY idx_conf_started_by (started_by_user_id),
  KEY idx_conf_jci (job_caller_info_id)
);

ALTER TABLE tbl_plivo_call_log ADD COLUMN conference_id INT NULL;
ALTER TABLE tbl_plivo_call_log ADD COLUMN participant_role VARCHAR(24) NULL;
ALTER TABLE tbl_plivo_call_log ADD COLUMN participant_target_id INT NULL;
ALTER TABLE tbl_plivo_call_log ADD COLUMN conference_member_id VARCHAR(64) NULL;
ALTER TABLE tbl_plivo_call_log ADD KEY idx_plivo_log_conference (conference_id);

-- NO PROPERTY CLEANUP. An earlier draft of this file seeded three cost-knob
-- properties and this migration carried DELETEs for them — but the draft was
-- never executed anywhere, so those DELETEs removed rows that have never
-- existed. Confirmed with ops 2026-08-04.
--
-- Dropped rather than kept "just in case": a DELETE for a key that was never
-- created reads to the next person as evidence the key once existed and might
-- still be out there. It would send someone hunting for a setting that has no
-- history. The absence of the key IS the state; nothing has to be undone.

-- ── Hand verification ────────────────────────────────────────────────────
-- 1. The room table exists, and carries NO limit columns and NO counters:
-- SHOW CREATE TABLE tbl_job_conference;
--
-- 2. There is NO participant table. This must return ZERO rows — if it ever
--    returns one, the two-table model has been re-introduced:
-- SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'tbl_job_conference_participant';
--
-- 3. The four leg columns landed on the call log, and job_caller_info_id is
--    still a plain KEY (NOT UNIQUE) — several legs per call depend on that:
-- SHOW CREATE TABLE tbl_plivo_call_log;
--
-- 4. There must be NO conference properties at all — no feature flag and no
--    cost knobs. This must return ZERO rows:
-- SELECT property_key, property_value FROM easyfix_properties WHERE property_key LIKE 'plivo.conference.max.%' OR property_key = 'plivo.conference.enabled';
--
-- 5. The dialler setting that REMAINS (this one is expected to be present or
--    absent-with-a-45s-default; it is a ring timeout, not a spend cap):
-- SELECT property_key, property_value FROM easyfix_properties WHERE property_key = 'plivo.conference.ring.timeout.sec';
--
-- 6. After the first live 3-party call: ONE room, ONE tbl_job_caller_info row,
--    THREE tbl_plivo_call_log legs sharing that job_caller_info_id.
-- SELECT id, job_id, friendly_name, mpc_uuid, status, job_caller_info_id, started_on, ended_on, end_reason FROM tbl_job_conference ORDER BY id DESC LIMIT 5;
-- SELECT id, conference_id, participant_role, participant_target_id, receiver_name, status, conference_member_id, call_uuid, initiated_on, answered_on, ended_on, duration FROM tbl_plivo_call_log WHERE conference_id IS NOT NULL ORDER BY id DESC LIMIT 10;
--
-- 7. THE COUNT CHECK, and the one that proves decision 2 worked. For that same
--    call this must print exactly ONE row (one call, three legs) — if it prints
--    three, an extra audit row was inserted per participant and every existing
--    call-count report has been inflated:
-- SELECT jci.job_caller_info, COUNT(*) AS legs FROM tbl_job_caller_info jci JOIN tbl_plivo_call_log pcl ON pcl.job_caller_info_id = jci.job_caller_info WHERE pcl.conference_id IS NOT NULL GROUP BY jci.job_caller_info ORDER BY jci.job_caller_info DESC LIMIT 5;
--
-- 8. The cost-leak check ops should run daily. Anything still 'creating' or
--    'live' from hours ago means the reaper is not doing its job. Deliberately
--    NOT written as `< NOW() - INTERVAL 6 HOUR`: these columns hold the IST
--    wall clock while NOW() is whatever zone the DB server runs in, so this
--    prints the timestamps and lets a human judge rather than quietly returning
--    nothing on a UTC server:
-- SELECT id, friendly_name, status, created_on, started_on FROM tbl_job_conference WHERE status IN ('creating','live') ORDER BY COALESCE(started_on, created_on) ASC LIMIT 50;
--
-- 9. Nothing legacy changed:
-- SHOW CREATE TABLE tbl_job_caller_info;
