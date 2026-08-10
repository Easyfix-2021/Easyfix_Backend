/*
 * QuickSight — Call Tracking service.
 *
 * Answers four questions off ONE call log:
 *   1. per JOB   — how much phoning did this job take, by whom, to whom, and at
 *                  which lifecycle step was each call made;
 *   2. per (DAY, USER) — how much calling did each CRM user do on each day, and
 *                  where in the job lifecycle was that effort mostly spent;
 *   3. per USER over the WHOLE window — the same effort collapsed to one row per
 *                  caller, plus the per-day efficiency averages (byUserCombined);
 *   4. per DAY   — a gap-filled volume/connect trend for the chart.
 * Plus a per-call drill-down behind every number, and a 3-sheet XLSX.
 *
 * ── Data rules (settled by the lead — do NOT re-litigate) ───────────────────
 * BASE TABLE is the LEGACY tbl_job_caller_info (alias jci), PK job_caller_info.
 * Its receiver columns are MISSPELLED in the schema — reciever, reciever_id,
 * reciever_name, reciever_status — and are used with the misspelling on purpose.
 *
 * jci.inserted_time is the call timestamp and the report is ALWAYS windowed on
 * it. The table carries ~940k rows dominated by null/legacy-provider history, so
 * an unwindowed scan is not an option; the window defaults to IST today.
 *
 * jci.duration (SECONDS) is the SINGLE duration source and is populated for BOTH
 * providers — Plivo writes it on hangup (routes/webhook/plivo.js), Kaleyra via
 * services/kaleyra-report-sync.service.js. tbl_plivo_call_log is NOT joined:
 * it exists only for Plivo, so joining it for duration would silently drop every
 * Kaleyra call.
 *
 * CONNECTED means jci.duration > 0. caller_status is not comparable across
 * providers ('answered' / 'hangup' / 'initiated' / Kaleyra's own vocabulary /
 * NULL on legacy rows), so a positive duration is the only signal that means the
 * same thing on every row.
 *
 * jci.job_status and jci.job_efr_id are a SNAPSHOT of the job AT CALL TIME —
 * that is what makes "at which step was this call made" real history rather than
 * a re-projection of today's status. They drive the per-call step and
 * assignedAtCall. The JOB-level chip (currentJobStatus / assigned on byJob) is a
 * deliberately DIFFERENT thing: tbl_job as it stands today.
 *
 * SCOPE is jci.caller_id IS NOT NULL — CRM-attributable calls only. Legacy and
 * public-bridge rows have no caller and cannot be credited to a user, and this
 * report is entirely about attribution.
 *
 * RECEIVER TYPE IS NOT STORED. It is derived by last-10-digit matching against
 * the job's parties in a fixed priority order (first match wins):
 *   Customer > Alternate > Client SPOC > Technician > 'Other'
 * mirroring resolveJobParties() + last10() in routes/admin/calls.js. Stored
 * numbers carry inconsistent +91 / space formatting, hence the
 * RIGHT(REPLACE(REPLACE(col,'+',''),' ',''),10) comparison key.
 *
 * PRIVACY: no response field carries a raw customer / technician mobile number.
 * The drill-down returns the receiver NAME plus the derived partyRole. The admin
 * router applies maskMobile / rejectMaskedMobile, and a report that emitted raw
 * numbers would route straight around that gate.
 *
 * Job-status LABELS come from the shared utils/job-status-label.js helper, always
 * with the assigned flag, so the BOOKED split (Pending App Ack vs Pending for
 * Scheduling) reads the same here as in the job modal, the jobs list, and every
 * other export.
 *
 * ── CONFERENCE CALLS (2026-08-04) ──────────────────────────────────────────
 *
 * An ops call can now gain people mid-call. A conference is ONE call that gained
 * participants, and the data model says so: tbl_job_caller_info still gets
 * exactly ONE row per call, while each LEG is a tbl_plivo_call_log row sharing
 * that call's job_caller_info_id plus a conference_id and a participant_role.
 *
 * ⚠ EVERY COUNT IN THIS REPORT IS THEREFORE UNCHANGED, BY CONSTRUCTION, AND
 * DELIBERATELY STAYS THAT WAY. buildScope reads tbl_job_caller_info only, so a
 * 3-party conference is ONE call in totals, byJob, byUser, byUserCombined and
 * byDay — which is the right answer, and the reason tbl_plivo_call_log must NOT
 * be joined into the scope. (Joining it would also drop every Kaleyra call, per
 * the note above, so there are two independent reasons not to.)
 *
 * WHAT DOES CHANGE is the per-call DRILL-DOWN (getCallDetails), which now
 * returns a nested `legs[]` per call: who else was on that call, labelled by
 * role. Nested, never flattened into extra top-level rows — the drill-down
 * reconciling with the count it was opened from is a hard invariant of this
 * file, and adding rows would break it.
 *
 * ⚠ KNOWN AND ACCEPTED GAP: `partyRole` (the filter, the `parties` breakdown and
 * the drill-down's own partyRole column) derives ONE counterparty from
 * jci.reciever — the number originally dialled. A technician CONFERENCED IN
 * later therefore does not make the call count as 'Technician', and the "Called
 * To" breakdown under-reports composition on conference calls. That is left
 * alone on purpose: making `parties` count LEGS would make it count a different
 * thing from `calls` beside it, and the two would stop reconciling. The legs are
 * visible in the drill-down instead, which is where composition belongs. If
 * "parties reached" is ever wanted as a number, it needs its own explicitly
 * labelled metric, not a redefinition of this one.
 */

const { pool } = require('../../db');
const logger = require('../../logger');
const plivoLog = require('../plivo-call-log.service');
const { buildInFilter, _dateHelpers } = require('./_shared');
const { istToday, fmt, addDays } = _dateHelpers;
const { jobStatusLabel } = require('../../utils/job-status-label');

// Row caps — named so the log line and the cap agree.
const ROW_CAP = 5000;      // byJob rows, and byUser (day × user) rows
const NESTED_CAP = 20000;  // breakdown rows stitched onto byJob / byUser
const DETAIL_CAP = 500;    // per-call drill-down
/*
 * Cap the daily trend so a very wide window cannot explode the chart. Set to a
 * QUARTER rather than the 31 days Offer Acceptance uses: time IS this report's
 * primary axis, so silently truncating a selected month/quarter would be a
 * bigger lie here than an over-long bar chart. Clamping is logged.
 */
const TREND_MAX_DAYS = 92;

/* The derived receiver types, in match-priority order. Exported so the route's
 * Joi enum and the derivation below cannot drift apart. */
const PARTY_ROLES = Object.freeze(['Customer', 'Alternate', 'Client SPOC', 'Technician', 'Other']);

/*
 * Conference LEG roles → display labels.
 *
 * Deliberately a SUPERSET of PARTY_ROLES, and deliberately NOT merged into it.
 * PARTY_ROLES is the FILTER enum: every value in it must be something the SQL
 * derivation above can actually match, and 'Operator' / 'Client Contact' are
 * not (the first is our own side of the call, the second is a
 * tbl_client_contacts row, which is a different thing from the job's
 * client_spoc). Legs are nested detail, never filtered or aggregated on, so
 * they can be labelled precisely without widening a filter that would then
 * return nothing.
 */
const LEG_ROLE_LABEL = Object.freeze({
  operator: 'Operator',
  customer: 'Customer',
  customer_alt: 'Alternate',
  technician: 'Technician',
  job_spoc: 'Client SPOC',
  client_contact: 'Client Contact',
  custom: 'Other',
});

// Legs per call are 2–5 in practice. Bounds the drill-down's leg read so a page
// of 500 conference calls cannot fan out unboundedly.
const LEGS_PER_CALL_BUDGET = 12;

/*
 * VOICE-PROVIDER filter values — deliberately NOT a plain list of jci.provider
 * column values, because that column cannot answer "which vendor placed this
 * call" for historical data. Measured on live data 2026-07-30:
 *
 *   provider IS NULL   941,968 rows   2021-07-26 → 2026-06-04   ← the OLD CRM
 *   'JIO'/'Vodafone'/'Airtel'/'IDEA'/'BSNL'/''  ~2,721 rows, all 2021
 *                                              (legacy stored the TELECOM
 *                                               CARRIER here, not the vendor)
 *   'plivo'                 33 rows   2026-06-19 → 2026-07-15
 *   'kaleyra'                2 rows   2026-06-18 → 2026-06-19
 *
 * The old CRM placed ALL of its calls through Kaleyra but never stamped the
 * column, so 369,747 of the ~369,782 calls since 2025 have provider NULL. A
 * filter offering a literal 'kaleyra' would therefore match TWO rows and hide
 * the entire Kaleyra history behind an option named after it — the exact
 * mis-answer this filter exists to avoid.
 *
 * Since only two voice vendors have ever existed, "not Plivo" IS "Kaleyra or
 * pre-stamping legacy", so:
 *   'plivo'   → jci.provider = 'plivo'                (explicitly stamped)
 *   'kaleyra' → everything else, NULL included        (Kaleyra + old-CRM history)
 * Default ('' / absent) applies NO provider predicate, so both tabs include
 * every call from both vendors — which is the behaviour ops relies on.
 */
const PROVIDERS = Object.freeze(['plivo', 'kaleyra']);
const PROVIDER_CLAUSE = Object.freeze({
  plivo: " AND jci.provider = 'plivo'",
  kaleyra: " AND (jci.provider IS NULL OR jci.provider <> 'plivo')",
});

const n = (v) => Number(v) || 0;
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

// 'YYYY-MM-DD' -> UTC-midnight Date (pairs with the UTC-based _dateHelpers, so
// no local-timezone drift).
function parseDay(s) { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); }

/*
 * The inserted_time window. BOTH edges default to IST TODAY — this report may
 * never run unwindowed (see the header note on table size), so there is no
 * "no date filter" branch anywhere below.
 *
 * `from` is ANCHORED TO `to` (same shape as the Offer Acceptance report), and a
 * caller-supplied inversion is collapsed to the single day `to`. The route makes
 * the two dates optional INDEPENDENTLY, so defaulting `from` to IST today on its
 * own turned a one-sided body like { dateTo: '2026-07-15' } into the
 * unsatisfiable window 2026-07-30 .. 2026-07-15: every query built off
 * buildScope returned zero, while trendDays() repaired the inversion for the
 * chart alone — a KPI band reading 0 Calls under a trend showing real bars, and
 * a drill-down that returned nothing for the bar you clicked. Clamping HERE
 * fixes all of them at once, because every query (including the drill-down)
 * reads this one function.
 */
function windowOf(filters) {
  const to = filters.dateTo || fmt(istToday());
  const from = filters.dateFrom || to;
  // Date-only 'YYYY-MM-DD' strings compare correctly lexicographically.
  return { from: from > to ? to : from, to };
}

// Inclusive day axis for the trend, clamped to TREND_MAX_DAYS (most recent).
function trendDays(filters) {
  const w = windowOf(filters);
  const end = parseDay(w.to);
  let start = parseDay(w.from);
  // Belt and braces — windowOf() already collapses an inverted range.
  if (end < start) start = end;
  const span = Math.round((end - start) / 86400000) + 1;
  if (span > TREND_MAX_DAYS) {
    logger.warn(`Call Tracking trend clamped from ${span} to the most recent ${TREND_MAX_DAYS} days`);
    start = addDays(end, -(TREND_MAX_DAYS - 1));
  }
  const days = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(fmt(d));
  return days;
}

/*
 * ── Party-role derivation, in SQL ──────────────────────────────────────────
 *
 * d10(col) is last10() from routes/admin/calls.js expressed as SQL: strip '+'
 * and spaces, take the last 10 digits, and yield NULL — never a short prefix —
 * when fewer than 10 remain. NULL is load-bearing: NULL = NULL is never true, so
 * a blank or malformed number matches NO party instead of colliding with another
 * short number.
 */
const d10 = (col) => `CASE WHEN CHAR_LENGTH(REPLACE(REPLACE(COALESCE(${col}, ''), '+', ''), ' ', '')) >= 10
             THEN RIGHT(REPLACE(REPLACE(COALESCE(${col}, ''), '+', ''), ' ', ''), 10) END`;

/*
 * The COUNTERPARTY leg — the non-operator side of the call. Mirrors the job-call
 * list in routes/admin/calls.js: on an OUT call the operator dialled out, so the
 * counterparty is reciever; on an IN call it is caller. Every CRM insert path
 * writes call_type 'OUT', so the IN arm is defensive rather than load-bearing,
 * but it keeps this identical to the canonical implementation.
 *
 * These read the INNER alias `k` because they are computed once inside
 * buildScope's derived table (see there) and then referenced downstream as the
 * plain columns jci.cp_d10 / jci.cp_name. Inlining them at every use site
 * instead produced a ~3 KB nested CASE per query, re-evaluated five times a row.
 */
const CP_NUM = `CASE WHEN UPPER(COALESCE(k.call_type, 'OUT')) = 'IN' THEN k.caller ELSE k.reciever END`;
const CP_NAME = `CASE WHEN UPPER(COALESCE(k.call_type, 'OUT')) = 'IN' THEN k.caller_name ELSE k.reciever_name END`;

/*
 * Receiver TYPE. The CASE arms are ordered Customer > Alternate > Client SPOC >
 * Technician, and a CASE stops at its first true arm — so the priority order IS
 * the arm order. Anything unmatched (a number since changed on the job, a QA
 * number, a blank) reads 'Other', which is the honest answer.
 */
const PARTY_ROLE = `CASE
        WHEN jci.cp_d10 IS NULL                          THEN 'Other'
        WHEN jci.cp_d10 = ${d10('cu.customer_mob_no')}   THEN 'Customer'
        WHEN jci.cp_d10 = ${d10('j.additional_number')}  THEN 'Alternate'
        WHEN jci.cp_d10 = ${d10('j.client_spoc')}        THEN 'Client SPOC'
        WHEN jci.cp_d10 = ${d10('ef.efr_no')}            THEN 'Technician'
        ELSE 'Other'
      END`;

/*
 * Receiver NAME for the drill-down — a NAME, never a number (see the privacy
 * note in the header). Prefers the party name off the job (same preference the
 * job-call list applies) and falls back to the name stamped on the audit row at
 * call time, which is all we have for an unmatched number.
 */
const PARTY_NAME = `CASE
        WHEN jci.cp_d10 IS NULL                          THEN jci.cp_name
        WHEN jci.cp_d10 = ${d10('cu.customer_mob_no')}   THEN COALESCE(j.job_customer_name, cu.customer_name, jci.cp_name)
        WHEN jci.cp_d10 = ${d10('j.additional_number')}  THEN COALESCE(j.additional_name, j.job_customer_name, cu.customer_name, jci.cp_name)
        WHEN jci.cp_d10 = ${d10('j.client_spoc')}        THEN COALESCE(j.client_spoc_name, jci.cp_name)
        WHEN jci.cp_d10 = ${d10('ef.efr_no')}            THEN COALESCE(ef.efr_name, jci.cp_name)
        ELSE jci.cp_name
      END`;

// The snapshot assignment flag, emitted as 1/0 rather than relying on how the
// driver types a bare boolean expression.
const ASSIGNED_AT_CALL = `CASE WHEN jci.job_efr_id IS NOT NULL THEN 1 ELSE 0 END`;

// The IST calendar day of a call, as 'YYYY-MM-DD'. The pool session TZ is
// +05:30 and DATETIMEs are stored IST-verbatim, so this is already IST.
const DAY_EXPR = `DATE_FORMAT(jci.inserted_time, '%Y-%m-%d')`;

/*
 * ── buildScope(filters) ────────────────────────────────────────────────────
 * The shared FROM + WHERE + params for the call set matching the filters. Every
 * query below — including the drill-down — is built from this, so a detail list
 * can never disagree with the summary count it was opened from.
 *
 * The joins exist to serve the standard job filters (client / vertical / service
 * category) AND the party-role derivation, which needs the job's four
 * counterparty numbers. All LEFT: a call row with a missing/legacy job must not
 * vanish from a report about calls.
 *
 * The base table is wrapped in a derived table so the two counterparty
 * expressions are written ONCE and read downstream as ordinary columns
 * (jci.cp_d10 / jci.cp_name). The derived table also carries the two predicates
 * that every query needs regardless of filters — caller_id IS NOT NULL and the
 * inserted_time window — so the row set is narrowed before any join happens.
 *
 * ⚠ PARAM ORDER: the window placeholders now live in `from`, so every query MUST
 * interpolate `${from}` BEFORE `${where}` (they all do), and buildScope pushes
 * the window params FIRST.
 */
function buildScope(filters) {
  const params = [];
  // ALWAYS windowed. Lower bound at 00:00:00, inclusive upper bound via
  // DATE_ADD(+1 day) — the legacy idiom, and with the pool at +05:30 both edges
  // land on IST midnight. caller_id IS NOT NULL = CRM-attributable only (header).
  const w = windowOf(filters);
  const from = `
      FROM (
        SELECT k.*,
               ${d10(CP_NUM)} AS cp_d10,
               ${CP_NAME} AS cp_name
          FROM tbl_job_caller_info k
         WHERE k.caller_id IS NOT NULL
           AND k.inserted_time >= ?
           AND k.inserted_time < DATE_ADD(?, INTERVAL 1 DAY)
      ) jci
      LEFT JOIN tbl_job       j  ON j.job_id       = jci.job_id
      LEFT JOIN tbl_client    c  ON c.client_id    = j.fk_client_id
      LEFT JOIN tbl_customer  cu ON cu.customer_id = j.fk_customer_id
      LEFT JOIN tbl_easyfixer ef ON ef.efr_id      = j.fk_easyfixter_id`;
  params.push(w.from + ' 00:00:00');
  params.push(w.to);

  let where = ' WHERE 1=1';
  where += buildInFilter('j.fk_client_id', filters.clientId, params);
  where += buildInFilter('c.vertical_id', filters.verticalId, params);
  where += buildInFilter('j.fk_service_catg_id', filters.serviceCategoryId, params);
  // Who MADE the call — tbl_user ids on jci.caller_id.
  where += buildInFilter('jci.caller_id', filters.callerId, params);
  // Voice provider — see PROVIDER_CLAUSE for why 'kaleyra' is "not Plivo"
  // rather than a literal column match. No placeholder: the clause is a fixed
  // string chosen from a frozen allow-list, never interpolated user input.
  if (PROVIDER_CLAUSE[filters.provider]) where += PROVIDER_CLAUSE[filters.provider];
  // Receiver-type filter, applied through the SAME derivation the report
  // displays — a filter computed differently from the column it filters is how
  // reports start lying. Adds exactly one placeholder (the expression itself is
  // pure column comparisons).
  if (filters.partyRole) { where += ` AND (${PARTY_ROLE}) = ?`; params.push(filters.partyRole); }
  return { from, where, params };
}

/*
 * The volume / connect / talk-time aggregate reused by every grouping, so the
 * KPI tiles, the two tables, and the trend can never define a term differently.
 */
const CALL_AGG = `
      COUNT(*) AS calls,
      COUNT(CASE WHEN COALESCE(jci.duration, 0) > 0 THEN 1 END) AS connected,
      SUM(COALESCE(jci.duration, 0)) AS total_duration_secs,
      -- Average over CONNECTED calls only. Averaging the ring-outs in would
      -- report a talk time nobody had; NULL (nothing connected in this bucket)
      -- renders as a dash, which is the honest value — hence the nullable type.
      ROUND(AVG(CASE WHEN COALESCE(jci.duration, 0) > 0 THEN jci.duration END)) AS avg_duration_secs`;

/*
 * ── ACTIVE DAYS — the denominator of every "per day" average ────────────────
 *
 * The number of distinct IST calendar days on which this caller placed AT LEAST
 * ONE call. NOT the number of days in the selected range, and this distinction
 * is the whole point of the combined grain:
 *
 *   Dividing by RANGE days silently penalises weekends, leave, holidays and
 *   part-period joiners. A strong caller who worked 3 days of a 30-day window
 *   would read at 1/10th of their real intensity, and the column would end up
 *   ranking people by ATTENDANCE rather than by how hard they worked on the days
 *   they worked — which is the question "efficiency" is asking.
 *
 * It is COUNTED IN SQL, deliberately, and must stay that way: byUser is capped
 * at ROW_CAP day-rows, so deriving active days by counting a user's rows in that
 * array would UNDER-count the denominator the moment the cap bites and INFLATE
 * every average built on it. The cap can drop rows; COUNT(DISTINCT …) cannot.
 *
 * Expressed through DAY_EXPR — the same day expression the (day, user) grain
 * groups by — so the denominator counts exactly the days that grain would emit.
 * (Semantically identical to COUNT(DISTINCT DATE(jci.inserted_time)); written
 * this way so the two grains can never bucket a day differently.)
 */
const ACTIVE_DAYS = `COUNT(DISTINCT ${DAY_EXPR}) AS active_days`;

/*
 * A "per day" average over ACTIVE days.
 *
 * Returns null — never 0, NaN or Infinity — when there is no denominator, the
 * same convention avgDurationSecs already uses for "nothing connected". The FE
 * renders null as an em-dash: "we cannot divide" and "the answer is zero" are
 * different facts and must not print the same. activeDays is >= 1 for any user
 * who has a call at all, so the guard is defensive, but a silent Infinity in an
 * efficiency ranking is exactly the failure worth being defensive about.
 */
function perDay(total, activeDays, decimals = 0) {
  const days = n(activeDays);
  if (days <= 0) return null;
  const f = 10 ** decimals;
  return Math.round((n(total) / days) * f) / f;
}

// Shape one aggregate row into the response's shared numeric block.
function shapeAgg(r) {
  const calls = n(r && r.calls);
  const connected = n(r && r.connected);
  return {
    calls,
    connected,
    connectRate: pct(connected, calls),
    totalDurationSecs: n(r && r.total_duration_secs),
    avgDurationSecs: r && r.avg_duration_secs != null ? Number(r.avg_duration_secs) : null,
  };
}

/*
 * Fold (status, assignedAtCall) breakdown rows into one entry per LABEL.
 *
 * Grouping in SQL has to keep the snapshot assignment flag separate, because
 * status 0 splits into two different labels by it. Folding on the LABEL here
 * means a status whose label does NOT depend on the flag (every status except 0)
 * collapses back into a single entry, instead of appearing twice with identical
 * text. Sorted most-calls-first; the caller reads [0] as "majorly at".
 */
function foldSteps(rows) {
  const byLabel = new Map();
  for (const r of rows) {
    const status = r.status == null ? null : n(r.status);
    const label = jobStatusLabel(status, Number(r.assignedFlag) === 1) || 'Unknown';
    const hit = byLabel.get(label);
    if (hit) hit.calls += n(r.calls);
    else byLabel.set(label, { status, label, calls: n(r.calls) });
  }
  return [...byLabel.values()].sort((a, b) => b.calls - a.calls);
}

/*
 * Keep only breakdown rows whose stitch key is COMPLETE.
 *
 * The nested queries below are ORDER BY <stitch key> precisely so the LIMIT
 * boundary falls BETWEEN keys. With the old global `ORDER BY calls DESC` a hit
 * cap dropped the smallest counts spread across keys that were still on screen,
 * so steps[] / parties[] silently under-reported and no longer summed to the
 * row's own `calls` (and the XLSX printed a partial list beside a full total).
 * Ordering by the key leaves exactly ONE key that the limit can still cut in
 * half — the last one — so when the cap is hit its rows are dropped outright:
 * that row stitches nothing (the cell reads '—') instead of showing numbers that
 * contradict the count next to them.
 */
function completeKeysOnly(rows, keyOf, cap) {
  if (rows.length < cap) return rows;
  const lastKey = keyOf(rows[rows.length - 1]);
  let end = rows.length;
  while (end > 0 && keyOf(rows[end - 1]) === lastKey) end -= 1;
  return rows.slice(0, end);
}

// Group breakdown rows by a stitch key, mapping each row through `shape`.
function groupBy(rows, keyOf, shape) {
  return rows.reduce((m, r) => {
    const k = keyOf(r);
    const list = m.get(k) || [];
    list.push(shape(r));
    m.set(k, list);
    return m;
  }, new Map());
}

async function getCallTracking(filters = {}) {
  const w = windowOf(filters);
  logger.info('Building Call Tracking report · window=' + w.from + '..' + w.to
    + ' · provider=' + (filters.provider || 'all')
    + ' · partyRole=' + (filters.partyRole || 'all'));

  // ── Totals (KPI band) ──
  const sT = buildScope(filters);
  const [[tot]] = await pool.query(
    `SELECT ${CALL_AGG},
            COUNT(DISTINCT NULLIF(jci.job_id, 0)) AS unique_jobs,
            COUNT(DISTINCT jci.caller_id)         AS unique_callers
       ${sT.from} ${sT.where}`,
    sT.params,
  );

  /*
   * ── Per-JOB grain ──
   * MAX() on the joined job/client display columns rather than widening the
   * GROUP BY: we group by jci.job_id, and ONLY_FULL_GROUP_BY does NOT infer
   * functional dependency THROUGH a join (it would only do so when grouping by
   * tbl_job's own PK). One job per group, so MAX is exact, not "pick any".
   *
   * Restricted to real job ids — a click-to-call placed with no job attached
   * (custom-number / QA mode) has nothing to say at this grain, and would
   * otherwise collapse into a phantom "job 0" row.
   */
  const sJ = buildScope(filters);
  const [jobRows] = await pool.query(
    `SELECT jci.job_id AS jobId,
            MAX(c.client_name)        AS clientName,
            MAX(j.job_status)         AS currentJobStatus,
            MAX(j.fk_easyfixter_id)   AS jobEfrId,
            ${CALL_AGG},
            MAX(jci.duration)         AS max_duration_secs,
            MIN(jci.inserted_time)    AS firstCallAt,
            MAX(jci.inserted_time)    AS lastCallAt
       ${sJ.from} ${sJ.where}
        AND COALESCE(jci.job_id, 0) > 0
      GROUP BY jci.job_id
      ORDER BY calls DESC, jci.job_id DESC
      LIMIT ${ROW_CAP}`,
    sJ.params,
  );
  if (jobRows.length >= ROW_CAP) logger.warn(`Call Tracking (by job) hit the ${ROW_CAP}-row cap`);

  /*
   * ── Per-(DAY, USER) grain ──
   * ONE ROW PER (day, user): "what did this person do on this day", which is the
   * grain a supervisor actually reviews. tbl_user is joined only here and only
   * for the display name; the callerId FILTER reads jci.caller_id straight off
   * the base table.
   */
  const sU = buildScope(filters);
  const [userRows] = await pool.query(
    `SELECT ${DAY_EXPR} AS day,
            jci.caller_id AS userId,
            MAX(COALESCE(u.user_name, jci.caller_name)) AS userName,
            ${CALL_AGG},
            COUNT(DISTINCT NULLIF(jci.job_id, 0)) AS unique_jobs,
            MIN(jci.inserted_time) AS firstCallAt,
            MAX(jci.inserted_time) AS lastCallAt
       ${sU.from}
       LEFT JOIN tbl_user u ON u.user_id = jci.caller_id
       ${sU.where}
      GROUP BY ${DAY_EXPR}, jci.caller_id
      ORDER BY day DESC, calls DESC
      LIMIT ${ROW_CAP}`,
    sU.params,
  );
  if (userRows.length >= ROW_CAP) logger.warn(`Call Tracking (daily by user) hit the ${ROW_CAP}-row cap`);

  /*
   * ── Per-USER grain, WHOLE WINDOW ──
   * The SECOND aggregation grain of the By User tab: one row per caller for the
   * entire window, carrying the per-day efficiency averages. Same buildScope, so
   * it is scoped by the SAME filters as the daily grain and the two reconcile —
   * SUM(byUser.calls) === SUM(byUserCombined.calls) for any filter set (as long
   * as neither hit ROW_CAP, which is logged when it happens).
   *
   * It is its OWN grouped query rather than a JS roll-up of byUser for two
   * reasons: byUser is row-capped (a roll-up of a truncated array under-reports),
   * and active_days / unique_jobs are DISTINCT counts that cannot be recovered by
   * summing day rows at all.
   *
   * Computed unconditionally, not only for multi-day windows: on a single-day
   * window the two grains are identical and the FE simply doesn't offer the
   * toggle, but a response whose SHAPE depends on the filters is a trap for every
   * later consumer (and for the XLSX, which always carries all three sheets).
   */
  const sUC = buildScope(filters);
  const [combinedRows] = await pool.query(
    `SELECT jci.caller_id AS userId,
            MAX(COALESCE(u.user_name, jci.caller_name)) AS userName,
            ${ACTIVE_DAYS},
            ${CALL_AGG},
            COUNT(DISTINCT NULLIF(jci.job_id, 0)) AS unique_jobs,
            MIN(jci.inserted_time) AS firstCallAt,
            MAX(jci.inserted_time) AS lastCallAt
       ${sUC.from}
       LEFT JOIN tbl_user u ON u.user_id = jci.caller_id
       ${sUC.where}
      GROUP BY jci.caller_id
      ORDER BY calls DESC, jci.caller_id
      LIMIT ${ROW_CAP}`,
    sUC.params,
  );
  if (combinedRows.length >= ROW_CAP) logger.warn(`Call Tracking (combined by user) hit the ${ROW_CAP}-row cap`);

  /*
   * ── Nested breakdowns ──
   * The callers / parties / steps arrays are built by a handful of GROUPED
   * queries and stitched in JS by key — never one query per row. Each is
   * restricted to exactly the keys the grain above returned, so a capped result
   * set does not drag along breakdowns for rows nobody can see.
   */
  const jobIds = jobRows.map((r) => n(r.jobId));
  const userIds = [...new Set(userRows.map((r) => (r.userId == null ? null : n(r.userId))).filter((v) => v != null))];
  const jobIn = jobIds.map(() => '?').join(',');
  const userIn = userIds.map(() => '?').join(',');

  // WHO called, per job.
  let callersByJob = new Map();
  let partiesByJob = new Map();
  let stepsByJob = new Map();
  const jobKey = (r) => n(r.jobId);
  if (jobIds.length > 0) {
    const sC = buildScope(filters);
    const [callerRows] = await pool.query(
      `SELECT jci.job_id AS jobId,
              jci.caller_id AS userId,
              MAX(COALESCE(u.user_name, jci.caller_name)) AS userName,
              COUNT(*) AS calls
         ${sC.from}
         LEFT JOIN tbl_user u ON u.user_id = jci.caller_id
         ${sC.where} AND jci.job_id IN (${jobIn})
        GROUP BY jci.job_id, jci.caller_id
        ORDER BY jci.job_id, calls DESC
        LIMIT ${NESTED_CAP}`,
      [...sC.params, ...jobIds],
    );
    if (callerRows.length >= NESTED_CAP) logger.warn(`Call Tracking (job callers) hit the ${NESTED_CAP}-row cap`);
    callersByJob = groupBy(completeKeysOnly(callerRows, jobKey, NESTED_CAP), jobKey, (r) => ({
      userId: r.userId == null ? null : n(r.userId),
      userName: r.userName || `User #${n(r.userId)}`,
      calls: n(r.calls),
    }));

    // TO WHOM, per job — the derived receiver type. The GROUP BY repeats the
    // derivation expression verbatim (it is one JS constant, so the two cannot
    // drift) rather than leaning on a select alias.
    const sP = buildScope(filters);
    const [partyRows] = await pool.query(
      `SELECT jci.job_id AS jobId, ${PARTY_ROLE} AS role, COUNT(*) AS calls
         ${sP.from}
         ${sP.where} AND jci.job_id IN (${jobIn})
        GROUP BY jci.job_id, ${PARTY_ROLE}
        ORDER BY jci.job_id, calls DESC
        LIMIT ${NESTED_CAP}`,
      [...sP.params, ...jobIds],
    );
    if (partyRows.length >= NESTED_CAP) logger.warn(`Call Tracking (job parties) hit the ${NESTED_CAP}-row cap`);
    partiesByJob = groupBy(completeKeysOnly(partyRows, jobKey, NESTED_CAP), jobKey, (r) => ({ role: r.role || 'Other', calls: n(r.calls) }));

    // AT WHICH STEP, per job — from the SNAPSHOT columns, so this is history,
    // not a re-read of today's status.
    const sS = buildScope(filters);
    const [stepRows] = await pool.query(
      `SELECT jci.job_id AS jobId, jci.job_status AS status,
              ${ASSIGNED_AT_CALL} AS assignedFlag, COUNT(*) AS calls
         ${sS.from}
         ${sS.where} AND jci.job_id IN (${jobIn})
        GROUP BY jci.job_id, jci.job_status, ${ASSIGNED_AT_CALL}
        ORDER BY jci.job_id, calls DESC
        LIMIT ${NESTED_CAP}`,
      [...sS.params, ...jobIds],
    );
    if (stepRows.length >= NESTED_CAP) logger.warn(`Call Tracking (job steps) hit the ${NESTED_CAP}-row cap`);
    const rawStepsByJob = groupBy(completeKeysOnly(stepRows, jobKey, NESTED_CAP), jobKey, (r) => r);
    stepsByJob = new Map([...rawStepsByJob].map(([k, v]) => [k, foldSteps(v)]));
  }

  // Per-(day, user) breakdowns. Keyed 'YYYY-MM-DD|userId'. Restricting on the
  // caller ids alone is enough — the day axis is already the scope window — and
  // any (day,user) pair the capped grain above dropped simply goes unstitched.
  // These are ordered BY THAT KEY and passed through completeKeysOnly for the
  // reason documented there: a partial breakdown under a full count lies.
  let partiesByUser = new Map();
  let stepsByUser = new Map();
  const userKey = (r) => `${r.day}|${n(r.userId)}`;
  if (userIds.length > 0) {
    const sUP = buildScope(filters);
    const [upRows] = await pool.query(
      `SELECT ${DAY_EXPR} AS day, jci.caller_id AS userId, ${PARTY_ROLE} AS role, COUNT(*) AS calls
         ${sUP.from}
         ${sUP.where} AND jci.caller_id IN (${userIn})
        GROUP BY ${DAY_EXPR}, jci.caller_id, ${PARTY_ROLE}
        ORDER BY day, jci.caller_id, calls DESC
        LIMIT ${NESTED_CAP}`,
      [...sUP.params, ...userIds],
    );
    if (upRows.length >= NESTED_CAP) logger.warn(`Call Tracking (user parties) hit the ${NESTED_CAP}-row cap`);
    partiesByUser = groupBy(completeKeysOnly(upRows, userKey, NESTED_CAP), userKey, (r) => ({ role: r.role || 'Other', calls: n(r.calls) }));

    const sUS = buildScope(filters);
    const [usRows] = await pool.query(
      `SELECT ${DAY_EXPR} AS day, jci.caller_id AS userId, jci.job_status AS status,
              ${ASSIGNED_AT_CALL} AS assignedFlag, COUNT(*) AS calls
         ${sUS.from}
         ${sUS.where} AND jci.caller_id IN (${userIn})
        GROUP BY ${DAY_EXPR}, jci.caller_id, jci.job_status, ${ASSIGNED_AT_CALL}
        ORDER BY day, jci.caller_id, calls DESC
        LIMIT ${NESTED_CAP}`,
      [...sUS.params, ...userIds],
    );
    if (usRows.length >= NESTED_CAP) logger.warn(`Call Tracking (user steps) hit the ${NESTED_CAP}-row cap`);
    const rawStepsByUser = groupBy(completeKeysOnly(usRows, userKey, NESTED_CAP), userKey, (r) => r);
    stepsByUser = new Map([...rawStepsByUser].map(([k, v]) => [k, foldSteps(v)]));
  }

  /*
   * Per-USER (whole-window) breakdowns. Keyed on caller_id ALONE — the day is not
   * part of this grain. Same machinery as every other breakdown above: ONE
   * grouped query per breakdown, restricted to the caller ids this grain actually
   * returned, ordered BY THE STITCH KEY and filtered through completeKeysOnly so
   * a hit cap drops whole keys instead of leaving a half-counted list beside a
   * full total.
   *
   * The ids come from combinedRows, NOT from the daily grain: if byUser hit
   * ROW_CAP its caller set can be a strict subset, and stitching off it would
   * leave the tail of the combined table with empty parties/steps.
   */
  const combinedUserIds = [...new Set(
    combinedRows.map((r) => (r.userId == null ? null : n(r.userId))).filter((v) => v != null),
  )];
  let partiesByCaller = new Map();
  let stepsByCaller = new Map();
  const callerKey = (r) => n(r.userId);
  if (combinedUserIds.length > 0) {
    const combIn = combinedUserIds.map(() => '?').join(',');

    const sCP = buildScope(filters);
    const [cpRows] = await pool.query(
      `SELECT jci.caller_id AS userId, ${PARTY_ROLE} AS role, COUNT(*) AS calls
         ${sCP.from}
         ${sCP.where} AND jci.caller_id IN (${combIn})
        GROUP BY jci.caller_id, ${PARTY_ROLE}
        ORDER BY jci.caller_id, calls DESC
        LIMIT ${NESTED_CAP}`,
      [...sCP.params, ...combinedUserIds],
    );
    if (cpRows.length >= NESTED_CAP) logger.warn(`Call Tracking (combined user parties) hit the ${NESTED_CAP}-row cap`);
    partiesByCaller = groupBy(completeKeysOnly(cpRows, callerKey, NESTED_CAP), callerKey, (r) => ({ role: r.role || 'Other', calls: n(r.calls) }));

    const sCS = buildScope(filters);
    const [csRows] = await pool.query(
      `SELECT jci.caller_id AS userId, jci.job_status AS status,
              ${ASSIGNED_AT_CALL} AS assignedFlag, COUNT(*) AS calls
         ${sCS.from}
         ${sCS.where} AND jci.caller_id IN (${combIn})
        GROUP BY jci.caller_id, jci.job_status, ${ASSIGNED_AT_CALL}
        ORDER BY jci.caller_id, calls DESC
        LIMIT ${NESTED_CAP}`,
      [...sCS.params, ...combinedUserIds],
    );
    if (csRows.length >= NESTED_CAP) logger.warn(`Call Tracking (combined user steps) hit the ${NESTED_CAP}-row cap`);
    const rawStepsByCaller = groupBy(completeKeysOnly(csRows, callerKey, NESTED_CAP), callerKey, (r) => r);
    stepsByCaller = new Map([...rawStepsByCaller].map(([k, v]) => [k, foldSteps(v)]));
  }

  /*
   * ── Daily trend, GAP-FILLED ──
   * A GROUP BY only returns days that had calls, so every day in the window is
   * materialised here and missing days read as zero. Same approach as the Offer
   * Acceptance trend; the axis comes from trendDays (clamped, see TREND_MAX_DAYS).
   */
  const days = trendDays(filters);
  const sD = buildScope({ ...filters, dateFrom: days[0], dateTo: days[days.length - 1] });
  const [dayRows] = await pool.query(
    `SELECT ${DAY_EXPR} AS day,
            COUNT(*) AS calls,
            COUNT(CASE WHEN COALESCE(jci.duration, 0) > 0 THEN 1 END) AS connected,
            COUNT(DISTINCT NULLIF(jci.job_id, 0)) AS unique_jobs
       ${sD.from} ${sD.where}
      GROUP BY ${DAY_EXPR}`,
    sD.params,
  );
  const dayMap = new Map(dayRows.map((r) => [r.day, r]));
  const byDay = days.map((day) => {
    const r = dayMap.get(day);
    return { day, calls: n(r && r.calls), connected: n(r && r.connected), uniqueJobs: n(r && r.unique_jobs) };
  });

  const totals = {
    ...shapeAgg(tot),
    uniqueJobs: n(tot && tot.unique_jobs),
    uniqueCallers: n(tot && tot.unique_callers),
  };

  const byJob = jobRows.map((r) => {
    const id = n(r.jobId);
    return {
      jobId: id,
      clientName: r.clientName || null,
      // TODAY's job status + assignment (tbl_job), which is what the chip shows.
      // Deliberately distinct from the per-call snapshot in `steps`.
      currentJobStatus: r.currentJobStatus == null ? null : n(r.currentJobStatus),
      assigned: r.jobEfrId != null,
      ...shapeAgg(r),
      maxDurationSecs: r.max_duration_secs == null ? null : Number(r.max_duration_secs),
      callers: callersByJob.get(id) || [],
      parties: partiesByJob.get(id) || [],
      steps: stepsByJob.get(id) || [],
      firstCallAt: r.firstCallAt || null,
      lastCallAt: r.lastCallAt || null,
    };
  });

  const byUser = userRows.map((r) => {
    const key = userKey(r);
    const steps = stepsByUser.get(key) || [];
    // "Majorly at which job status" — steps is already sorted most-calls-first.
    const top = steps[0] || null;
    return {
      day: r.day,
      userId: r.userId == null ? null : n(r.userId),
      userName: r.userName || `User #${n(r.userId)}`,
      ...shapeAgg(r),
      uniqueJobs: n(r.unique_jobs),
      topStatus: top ? top.status : null,
      topStatusLabel: top ? top.label : '',
      topStatusCalls: top ? top.calls : 0,
      steps,
      parties: partiesByUser.get(key) || [],
      firstCallAt: r.firstCallAt || null,
      lastCallAt: r.lastCallAt || null,
    };
  });

  /*
   * The COMBINED grain — one row per user for the whole window.
   *
   * Every "per day" figure divides by activeDays (this row's OWN count of days
   * with at least one call), never by the days in the range. activeDays is
   * emitted as a column of its own and sits BEFORE the averages on screen so an
   * operator can always see what the average was divided by: 5 calls/day over 2
   * active days and 5 calls/day over 20 are very different claims.
   *
   * avgDurationSecs (per CONNECTED call) comes from CALL_AGG untouched — a
   * ring-out must not drag down talk time — while avgDurationPerDaySecs divides
   * TOTAL talk time by active days, which is the "how much of the day was spent
   * on the phone" figure. The two answer different questions and are both here.
   */
  const byUserCombined = combinedRows.map((r) => {
    const id = r.userId == null ? null : n(r.userId);
    const steps = (id == null ? null : stepsByCaller.get(id)) || [];
    const top = steps[0] || null;
    const activeDays = n(r.active_days);
    const agg = shapeAgg(r);
    return {
      userId: id,
      userName: r.userName || `User #${n(r.userId)}`,
      activeDays,
      ...agg,
      uniqueJobs: n(r.unique_jobs),
      // One decimal — an efficiency figure, not a count; "12.4 calls/day".
      avgCallsPerDay: perDay(agg.calls, activeDays, 1),
      avgDurationPerDaySecs: perDay(agg.totalDurationSecs, activeDays),
      topStatus: top ? top.status : null,
      topStatusLabel: top ? top.label : '',
      topStatusCalls: top ? top.calls : 0,
      steps,
      parties: (id == null ? null : partiesByCaller.get(id)) || [],
      firstCallAt: r.firstCallAt || null,
      lastCallAt: r.lastCallAt || null,
    };
  });

  logger.info('Returning ' + byJob.length + ' job rows · ' + byUser.length + ' day-user rows · '
    + byUserCombined.length + ' combined user rows · '
    + byDay.length + ' trend days · ' + totals.calls + ' calls');
  return { totals, byJob, byUser, byUserCombined, byDay };
}

/*
 * Load the conference LEGS for one page of drill-down rows, in ONE query,
 * indexed by job_caller_info_id.
 *
 * This is the surface the owner called out: "the extra legs must be visible
 * where per-leg DETAIL is shown, labelled by role". Before this, a 3-party
 * conference showed here as ONE row with ONE receiverName and ONE partyRole, and
 * the other two legs were unreachable — there was no join, no id, nothing.
 *
 * ⚠ NO NUMBER IS SELECTED — not even a masked prefix. Every other surface masks;
 * this report's contract (see the PRIVACY note in the header) is stricter still,
 * because it feeds an export and a chart: it returns NAMES and derived ROLES
 * only, and playback goes through the authorised call-audio endpoint where that
 * permission check lives. Do not add dialed_number / receiver_number here.
 *
 * Fail-soft in both directions: a pre-migration environment has no conference_id
 * column (the probe short-circuits) and a query failure logs and returns no
 * legs. A drill-down that 500s because the composition detail was unavailable
 * would be worse than one without it.
 */
async function loadConferenceLegs(callIds) {
  const ids = [...new Set((callIds || []).map(Number).filter((v) => Number.isFinite(v) && v > 0))];
  if (!ids.length) return new Map();
  if (!(await plivoLog.hasConferenceColumns())) return new Map();
  const cap = Math.min(ids.length * LEGS_PER_CALL_BUDGET, 2000);
  let rows = [];
  try {
    [rows] = await pool.query(
      `SELECT job_caller_info_id AS callId,
              id                 AS legId,
              conference_id      AS conferenceId,
              participant_role   AS role,
              receiver_name      AS name,
              status,
              duration,
              answered_on        AS joinedAt,
              ended_on           AS leftAt
         FROM tbl_plivo_call_log
        WHERE conference_id IS NOT NULL
          AND job_caller_info_id IN (${ids.map(() => '?').join(',')})
        ORDER BY job_caller_info_id ASC, id ASC
        LIMIT ?`,
      [...ids, cap],
    );
  } catch (e) {
    logger.warn('Call Tracking conference legs load failed (drill-down renders without them) · ' + e.message);
    return new Map();
  }
  if (rows.length >= cap) logger.warn(`Call Tracking drill-down legs hit the ${cap}-row cap`);

  const byCall = new Map();
  for (const r of rows) {
    const key = n(r.callId);
    const list = byCall.get(key) || [];
    list.push({
      legId: n(r.legId),
      conferenceId: r.conferenceId == null ? null : n(r.conferenceId),
      role: r.role || null,
      // The label, in the same vocabulary the row's own partyRole uses wherever
      // the two overlap — so a reader is never shown 'Technician' on the row and
      // 'technician' on a leg.
      partyRole: LEG_ROLE_LABEL[r.role] || 'Other',
      name: (r.name && String(r.name).trim()) || null,
      status: r.status || null,
      durationSecs: r.duration == null ? null : Number(r.duration),
      connected: n(r.duration) > 0,
      joinedAt: r.joinedAt || null,
      leftAt: r.leftAt || null,
    });
    byCall.set(key, list);
  }
  return byCall;
}

/*
 * getCallDetails(filters, selection) — the individual calls behind ONE number.
 *
 * It reuses buildScope, so the detail list carries the EXACT SAME filters as the
 * summary that produced the number. That is the whole point: a drill-down that
 * ignored the report's window / client / provider / party filters could show 3
 * rows under a count of 1, and the operator would rightly stop trusting the
 * report. (Same reason this does not reuse GET /admin/calls — that endpoint
 * answers "every call on this job, ever", a different question.)
 *
 * `selection` narrows to the clicked cell:
 *   jobId            — a By Job row
 *   selectedCallerId — a By User row's user (or a caller chip)
 *   day              — a Date Wise row's day, or a trend bar
 *
 * The keys are INDEPENDENT and each is applied only when present, so
 * selectedCallerId WITHOUT a day is a supported combination and is exactly what
 * the Combined grain drills on: one user across the whole scope window. No
 * change was needed for it — the window predicate always comes from buildScope,
 * and `day` only ever NARROWS within that window.
 */
async function getCallDetails(filters = {}, selection = {}) {
  const s = buildScope(filters);
  let where = s.where;
  const params = [...s.params];

  if (selection.jobId != null) { where += ' AND jci.job_id = ?'; params.push(Number(selection.jobId)); }
  if (selection.selectedCallerId != null) { where += ' AND jci.caller_id = ?'; params.push(Number(selection.selectedCallerId)); }
  if (selection.day) {
    // Narrows WITHIN the scope window (never widens it) — a single IST day.
    where += ' AND jci.inserted_time >= ?';
    params.push(selection.day + ' 00:00:00');
    where += ' AND jci.inserted_time < DATE_ADD(?, INTERVAL 1 DAY)';
    params.push(selection.day);
  }

  const [rows] = await pool.query(
    `SELECT jci.job_caller_info AS id,
            jci.job_id          AS jobId,
            jci.inserted_time   AS callAt,
            jci.caller_id       AS callerUserId,
            COALESCE(u.user_name, jci.caller_name) AS callerName,
            ${PARTY_NAME}       AS receiverName,
            ${PARTY_ROLE}       AS partyRole,
            jci.job_status      AS jobStatusAtCall,
            ${ASSIGNED_AT_CALL} AS assignedFlag,
            jci.duration        AS durationSecs,
            jci.provider        AS provider,
            jci.caller_status   AS callerStatus,
            -- Whether a recording key was ever stored. The key itself is NOT
            -- returned: playback goes through the existing authorised call-audio
            -- endpoint, which is where that permission check lives.
            CASE WHEN jci.recording IS NOT NULL AND TRIM(jci.recording) <> '' THEN 1 ELSE 0 END AS recordingFlag
       ${s.from}
       LEFT JOIN tbl_user u ON u.user_id = jci.caller_id
       ${where}
      ORDER BY jci.inserted_time DESC, jci.job_caller_info DESC
      LIMIT ${DETAIL_CAP}`,
    params,
  );
  const capped = rows.length >= DETAIL_CAP;
  if (capped) logger.warn(`Call Tracking drill-down hit the ${DETAIL_CAP}-row cap`);

  /*
   * ONE extra query, and only when the page contains a conference. The rows
   * above are UNCHANGED in number — a conference is still exactly one of them,
   * which is what keeps this list reconciling with the count it was opened
   * from. `legs` is detail hung off that row, not additional rows.
   */
  const legsByCall = await loadConferenceLegs(rows.map((r) => n(r.id)));
  const conferences = [...legsByCall.keys()].length;
  logger.info('Returning ' + rows.length + ' call detail rows' + (capped ? ' (capped)' : '')
    + (conferences ? ` · ${conferences} of them conference calls` : ''));

  return {
    items: rows.map((r) => {
      const legs = legsByCall.get(n(r.id)) || [];
      return {
      id: n(r.id),
      jobId: r.jobId == null ? null : n(r.jobId),
      callAt: r.callAt || null,
      callerUserId: r.callerUserId == null ? null : n(r.callerUserId),
      callerName: r.callerName || `User #${n(r.callerUserId)}`,
      // NAME only — never the number (see the privacy note in the header).
      receiverName: (r.receiverName && String(r.receiverName).trim()) || null,
      partyRole: r.partyRole || 'Other',
      jobStatusAtCall: r.jobStatusAtCall == null ? null : n(r.jobStatusAtCall),
      assignedAtCall: Number(r.assignedFlag) === 1,
      durationSecs: r.durationSecs == null ? null : Number(r.durationSecs),
      connected: n(r.durationSecs) > 0,
      provider: r.provider || null,
      callerStatus: r.callerStatus || null,
      /*
       * The recording is the ROOM's, not a leg's — a Multi-Party Call produces
       * ONE recording, filed on the primary leg by
       * plivo-call-log.service::setRecording (which is scoped to that leg for
       * exactly this reason). So this flag stays a property of the CALL, and
       * `legs` deliberately carries no recording of its own: offering the same
       * audio three times would be worse than offering it once.
       */
      recordingAvailable: Number(r.recordingFlag) === 1,
      /*
       * ── Conference composition (decision 3) ──
       * Empty array, never null, on an ordinary 1:1 call — so a consumer
       * branches on `isConference` and never on shape. `partyRole` above is
       * still the call's ONE original counterparty (see the header's known-gap
       * note); these are everyone who was actually on it.
       */
      conferenceId: legs.length ? legs[0].conferenceId : null,
      isConference: legs.length > 1,
      legCount: legs.length,
      legs,
      };
    }),
    capped,
  };
}

/*
 * XLSX payload — THREE sheets mirroring the on-screen grains (By Job, the daily
 * By User table, and its combined per-user sub-view), so the download carries
 * everything the report can show. The route walks `sheets` and hands each to
 * buildStyledWorkbook with a shared workbook.
 *
 * The nested arrays are flattened into readable single cells ('Priya (3), Amit
 * (1)') — a spreadsheet cell cannot hold a list, and an operator reading the
 * export should not have to go back to the CRM to see who called.
 */
function flatten(list, labelOf) {
  return (list || []).map((x) => `${labelOf(x)} (${x.calls})`).join(', ');
}

function toXlsx(data) {
  const SHARED_COLS = [
    { key: 'calls', header: 'Calls', width: 10 },
    { key: 'connected', header: 'Connected', width: 12 },
    { key: 'connectRate', header: 'Connect %', width: 12 },
    { key: 'totalDurationSecs', header: 'Talk Time (Sec)', width: 16 },
    { key: 'avgDurationSecs', header: 'Avg Talk (Sec)', width: 15 },
  ];

  return {
    sheets: [
      {
        name: 'By Job',
        columns: [
          { key: 'jobId', header: 'Job #', width: 12 },
          { key: 'clientName', header: 'Client', width: 26 },
          { key: 'jobStatusLabel', header: 'Job Status (Today)', width: 20 },
          ...SHARED_COLS,
          { key: 'maxDurationSecs', header: 'Longest Call (Sec)', width: 18 },
          { key: 'callersLabel', header: 'Called By', width: 34 },
          { key: 'partiesLabel', header: 'Called To', width: 30 },
          { key: 'stepsLabel', header: 'At Job Step', width: 40 },
          { key: 'firstCallAt', header: 'First Call', width: 20 },
          { key: 'lastCallAt', header: 'Last Call', width: 20 },
        ],
        rows: data.byJob.map((r) => ({
          ...r,
          // Same label the on-screen chip shows, with `assigned` passed so the
          // BOOKED sub-split matches the chip and the job modal.
          jobStatusLabel: jobStatusLabel(r.currentJobStatus, r.assigned),
          avgDurationSecs: r.avgDurationSecs == null ? 0 : r.avgDurationSecs,
          maxDurationSecs: r.maxDurationSecs == null ? 0 : r.maxDurationSecs,
          callersLabel: flatten(r.callers, (x) => x.userName),
          partiesLabel: flatten(r.parties, (x) => x.role),
          stepsLabel: flatten(r.steps, (x) => x.label),
        })),
      },
      {
        name: 'Daily By User',
        columns: [
          { key: 'day', header: 'Date', width: 14 },
          { key: 'userName', header: 'User', width: 26 },
          ...SHARED_COLS,
          { key: 'uniqueJobs', header: 'Jobs Touched', width: 14 },
          { key: 'topStatusLabel', header: 'Majorly At', width: 20 },
          { key: 'topStatusCalls', header: 'Calls At That Step', width: 18 },
          { key: 'stepsLabel', header: 'At Job Step', width: 40 },
          { key: 'partiesLabel', header: 'Called To', width: 30 },
          { key: 'firstCallAt', header: 'First Call', width: 20 },
          { key: 'lastCallAt', header: 'Last Call', width: 20 },
        ],
        rows: data.byUser.map((r) => ({
          ...r,
          avgDurationSecs: r.avgDurationSecs == null ? 0 : r.avgDurationSecs,
          stepsLabel: flatten(r.steps, (x) => x.label),
          partiesLabel: flatten(r.parties, (x) => x.role),
        })),
      },
      /*
       * The SECOND grain of the By User tab — one row per user for the whole
       * window. 'Active Days' is carried NEXT TO the averages on purpose: an
       * average per day is unreadable without the denominator it used, and this
       * sheet is the one an operator sorts by "Avg Calls / Day".
       */
      {
        name: 'By User (Combined)',
        columns: [
          { key: 'userName', header: 'User', width: 26 },
          { key: 'activeDays', header: 'Active Days', width: 13 },
          ...SHARED_COLS,
          { key: 'uniqueJobs', header: 'Jobs Touched', width: 14 },
          { key: 'avgCallsPerDay', header: 'Avg Calls / Day', width: 16 },
          { key: 'avgDurationPerDaySecs', header: 'Avg Talk / Day (Sec)', width: 20 },
          { key: 'topStatusLabel', header: 'Majorly At', width: 20 },
          { key: 'topStatusCalls', header: 'Calls At That Step', width: 18 },
          { key: 'stepsLabel', header: 'At Job Step', width: 40 },
          { key: 'partiesLabel', header: 'Called To', width: 30 },
          { key: 'firstCallAt', header: 'First Call', width: 20 },
          { key: 'lastCallAt', header: 'Last Call', width: 20 },
        ],
        rows: (data.byUserCombined || []).map((r) => ({
          ...r,
          // A spreadsheet cell has no em-dash convention; the on-screen '—' for
          // "nothing to average" lands as 0 here, exactly as the existing sheets
          // already do for avgDurationSecs.
          avgDurationSecs: r.avgDurationSecs == null ? 0 : r.avgDurationSecs,
          avgCallsPerDay: r.avgCallsPerDay == null ? 0 : r.avgCallsPerDay,
          avgDurationPerDaySecs: r.avgDurationPerDaySecs == null ? 0 : r.avgDurationPerDaySecs,
          stepsLabel: flatten(r.steps, (x) => x.label),
          partiesLabel: flatten(r.parties, (x) => x.role),
        })),
      },
    ],
  };
}

module.exports = {
  getCallTracking,
  getCallDetails,
  toXlsx,
  // Exposed so the route's Joi enums stay in lockstep with the derivation above.
  PARTY_ROLES,
  PROVIDERS,
  /*
   * Test seam — the pure averaging helper and the SQL fragment that produces its
   * denominator, so tests can pin "per day means per ACTIVE day" without a DB.
   */
  _test: { perDay, ACTIVE_DAYS, DAY_EXPR },
};
