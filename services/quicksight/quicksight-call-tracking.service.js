/*
 * QuickSight — Call Tracking service.
 *
 * Answers five questions off ONE call log:
 *   1. per JOB   — how much phoning did this job take, by whom, to whom, and at
 *                  which lifecycle step was each call made;
 *   2. per (DAY, USER) — how much calling did each CRM user do on each day, and
 *                  where in the job lifecycle was that effort mostly spent;
 *   3. per USER over the WHOLE window — the same effort collapsed to one row per
 *                  caller, plus the per-day efficiency averages (byUserCombined);
 *   4. per DAY   — a gap-filled volume/connect trend for the chart;
 *   5. per (DAY, CALLER, DIRECTION) with NO JOB attached (byOther) — the calls
 *                  totals has always counted and no table could show. Two
 *                  populations share that bucket, which is why DIRECTION is part
 *                  of the grain: staff DIRECT calls (caller_id > 0, 'OUT',
 *                  placed from Manage EasyFixers / Customers with no job) and
 *                  legacy INBOUND calls (caller_id 0, 'IN'), the latter usually
 *                  the majority. Before it, "9 Total Calls" sat above a By Job
 *                  table of 2 rows with no route to the other 7.
 * Plus a per-call drill-down behind every number, and a 4-sheet XLSX.
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
 * visible in the drill-down instead, which is where composition belongs.
 *
 * ── PARTIES REACHED & CONFERENCE COST (2026-08-10) ─────────────────────────
 *
 * "Parties reached" IS now wanted as a number, and it arrived the way the note
 * above predicted it would have to: as its OWN explicitly labelled metric, NOT
 * as a redefinition of `parties`. Four fields on `totals`, produced by TWO
 * SEPARATE aggregate queries keyed off the SAME buildScope. buildScope itself is
 * untouched, so calls / connected / totalDurationSecs / byJob / byUser /
 * byUserCombined / byDay are identical to what they were before this section
 * existed — that is the acceptance property of the whole feature, and
 * tests/quicksight-call-tracking-conference.test.js pins it.
 *
 *   partiesReached        HOW MANY PEOPLE we actually got on the line, counting
 *                         everyone on a conference. Per call: the legs that
 *                         reached the room (participant_role <> 'operator' AND
 *                         status IN ('answered','completed')) — or, for a call
 *                         with NO legs at all (Kaleyra, or a Plivo row from
 *                         before conferencing existed), 1 when the call
 *                         connected. That fallback rides a LEFT JOIN, and the
 *                         direction is the Kaleyra guard: an INNER join would
 *                         drop an entire provider here for exactly the reason it
 *                         would in buildScope.
 *                         INVARIANT: partiesReached >= connected, for any filter
 *                         set. A 1:1 Plivo call has one non-operator leg, so it
 *                         equals connected; a conference exceeds it.
 *   conferenceCalls       scoped calls that were MULTI-party (more than one leg
 *                         reached the room). Every ops call is technically an
 *                         MPC (routes/admin/calls.js mints a room for each one),
 *                         so a 1:1 call is deliberately NOT a conference for
 *                         reporting purposes.
 *   conferenceBilledSecs  SUM(tbl_job_conference.billed_leg_seconds) over the
 *                         rooms whose job_caller_info_id is in scope — what
 *                         conferencing actually cost.
 *   conferenceBilledCalls how many of those rooms CONTRIBUTED a figure.
 *                         billed_leg_seconds is NULL until the MPCEnd webhook
 *                         lands, so a bare SUM silently under-reports; it
 *                         therefore never ships without its own coverage count.
 *                         A cost number without coverage is worse than no cost
 *                         number, because it looks authoritative.
 *
 *   conferenceRooms       every room in scope, billed or not — the DENOMINATOR
 *                         conferenceBilledCalls is read against.
 *
 * ⚠ conferenceBilledCalls counts ROOMS, and a room is minted for EVERY Plivo
 * call, so it is NOT bounded by conferenceCalls and the two must never be
 * rendered as a ratio of each other — that prints "3 of 2 rooms billed". Its
 * denominator is conferenceRooms, which exists for exactly this reason: coverage
 * has to be read over the same population the SUM was taken over. conferenceCalls
 * answers a different question ("how many calls actually gained people") and is
 * a smaller number over a different set.
 *
 * `partyRole` / `parties` are STILL not redefined, for the reason in the gap
 * note above: they count CALLS by their originally-dialled counterparty and they
 * reconcile with `calls`. partiesReached counts PEOPLE, under its own label.
 * Different units — never summed, never compared, never merged.
 *
 * NOT ADDED to byJob / byUser / byUserCombined / byDay, deliberately: the tiles
 * were the ask, and a per-row copy of a differently-grained number multiplies
 * both the query surface and the number of ways two figures on one screen can
 * disagree.
 *
 * FAIL-SOFT: both queries are wrapped, and a pre-migration environment (no
 * tbl_job_conference, no conference columns on tbl_plivo_call_log) logs a warn
 * and reports zeros. This report must never 500 over a metric that did not exist
 * last month.
 */

const { pool } = require('../../db');
const logger = require('../../logger');
const plivoLog = require('../plivo-call-log.service');
const { buildInFilter, _dateHelpers } = require('./_shared');
const { istToday, fmt, addDays } = _dateHelpers;
const { jobStatusLabel } = require('../../utils/job-status-label');


/*
 * ─── THE ROW CAPS ARE GONE (2026-08-26) ──────────────────────────────────
 *
 * ROW_CAP was 5000 on four grains and NESTED_CAP 20000 on the breakdowns
 * stitched onto them. On an eight-month window three grains hit it — byJob
 * alone wants 25,781 rows — and the truncation was SILENT: a warn in the log
 * nobody reads, and a table that simply stopped, with footers summing the rows
 * that survived. A report that quietly answers a smaller question than the one
 * asked is worse than a slow one.
 *
 * They are removed together, deliberately. Removing only ROW_CAP would have
 * moved the truncation rather than ended it: completeKeysOnly() dropped any key
 * whose breakdown rows were cut at NESTED_CAP, so more parent rows with the
 * same 20k nested budget means parents silently losing their To Whom and
 * Called By columns. The caps were a matched pair and had to fall as one.
 *
 * WHAT THIS COSTS, MEASURED. Two years selected returns ~135k byJob rows and
 * ~63k byUser rows in one response. That is a large payload and a very large
 * table, and it will be slow. That is the honest trade the removal buys: the
 * numbers are now complete at every window, and the cost is visible as
 * slowness rather than hidden as a wrong total.
 *
 * DETAIL_CAP stays. It bounds ONE dialog's rows, is disclosed in the UI via
 * `capped`, and is not a silent truncation of an aggregate.
 */
const DETAIL_CAP_ONLY_NOTE = true;
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
 *
 * ── THE DISPLAY MUST USE THE SAME RULE (fixed 2026-08-19) ──────────────────
 * The filter above knew all of this; the drill-down's Provider column did not.
 * It projected the raw column, so the seven calls on job 529116 from 18 Aug
 * 2026 rendered an EMPTY Provider cell — while filtering the very same report
 * by Kaleyra returned those same seven rows. One file, two beliefs: the filter
 * said "unstamped means Kaleyra" and the cell said "unstamped means nothing".
 *
 * So the rule is written ONCE, here, and BOTH the WHERE clause and the label
 * are derived from it. `isPlivo` is the whole rule; everything else in
 * PROVIDER_RULE is that one predicate re-used. Adding a second expression of
 * the same knowledge anywhere below is how this bug comes back.
 *
 * ⚠ `notPlivo` spells the IS NULL arm out instead of writing NOT (isPlivo)
 * because SQL is three-valued: NOT (NULL = 'plivo') is NULL, not TRUE, and the
 * 941,968 unstamped rows ARE the Kaleyra history — they must not fall out of
 * the Kaleyra tab. The two clauses PARTITION the rows (every row matches
 * exactly one), which tests/quicksight-call-tracking-provider.test.js pins.
 *
 * ⚠ NO DATE BOUNDARY. The rule buckets on the VALUE alone. "NULL means the old
 * CRM, which stopped 2026-06-04" is falsified by the very rows that were
 * reported — they are from 18 Aug 2026. A cutoff date would relabel them
 * 'Unknown' and reproduce the same contradiction with a different word in the
 * cell, and would rot again the moment one more legacy row lands.
 *
 * ⚠ THREE SPELLINGS OF "NOTHING WAS STAMPED". NULL, '' and whitespace-only
 * render identically but are NOT interchangeable to SQL — '' is invisible to
 * IS NULL, and the measured data above contains '' rows. Every place that
 * inspects the VALUE therefore reads `value` (NULLIF(TRIM(...), '')), so all
 * three collapse to one state. The label needs no such guard: all three fall to
 * the ELSE arm and come out 'Kaleyra' together.
 *
 * ⚠ INFERRED, NOT ASSERTED. `namedFlag` is 1 only when the column itself names
 * a vendor ('plivo' / 'kaleyra'); NULL, '', whitespace and the 2021 telecom
 * CARRIER values ('JIO', 'Airtel', …) are 0. The consumer emits that as
 * providerAssumed so a reader can tell a stamped vendor from a deduced one, and
 * the raw stored string is returned beside it rather than thrown away. The
 * carriers are never PRINTED as the vendor — 'JIO' in a Provider column is
 * simply wrong — but the fact that something was stored survives.
 *
 * ⚠ THIS RULE IS FOR DISPLAY AND FILTERING ONLY. The BEHAVIOURAL surfaces —
 * recording playback, re-analyse, hangup, and GET /admin/calls
 * (routes/admin/calls.js) — must keep reading the RAW column: an INFERRED
 * vendor cannot be dialled, hung up, or fetched a recording from. If one of
 * those ever wants a human label, it adds a NEW field beside the raw one. It
 * never replaces it.
 *
 * WHERE THE UNSTAMPED-BUT-RECENT ROWS COME FROM: not from this repo. All four
 * INSERT sites stamp a non-empty provider and no UPDATE can blank it; of those
 * four, only the two admin inserts (routes/admin/calls.js) set caller_id, and
 * buildScope's derived table requires caller_id IS NOT NULL. So within this
 * codebase the intersection of "visible in this report" and "provider
 * unstamped" is empty — those rows were written by something outside
 * EasyFix_Backend. Do not go looking for a write-side bug here.
 */
const PROVIDERS = Object.freeze(['plivo', 'kaleyra']);
const PROVIDER_COLUMN = 'jci.provider';
const PROVIDER_STAMP_PLIVO = 'plivo';
const PROVIDER_STAMP_KALEYRA = 'kaleyra';
// What a human reads in the Provider cell. Only two vendors have ever existed,
// so this list is closed and the label is never empty.
const PROVIDER_LABELS = Object.freeze({ plivo: 'Plivo', kaleyra: 'Kaleyra' });

// The one predicate. Compared against a literal on the RAW column, deliberately
// not the trimmed value: this exact text is what the Plivo filter has always
// used, and rewriting it as NULLIF(TRIM(...)) = 'plivo' would change which rows
// the filter returns for a leading-space value. The filter's row set is frozen.
const PROVIDER_IS_PLIVO = `${PROVIDER_COLUMN} = '${PROVIDER_STAMP_PLIVO}'`;
// The one normalisation, for the two places that read the VALUE rather than
// test it: NULL / '' / whitespace-only are the same state — nothing stamped.
const PROVIDER_VALUE = `NULLIF(TRIM(${PROVIDER_COLUMN}), '')`;

const PROVIDER_RULE = Object.freeze({
  isPlivo: PROVIDER_IS_PLIVO,
  /*
   * The exact complement of isPlivo, spelled out rather than written as
   * NOT (isPlivo): SQL three-valued logic makes NOT (NULL = 'plivo') itself
   * NULL, which would drop all 941,968 unstamped rows out of the Kaleyra tab —
   * the very rows the tab exists to include. Built from the SAME two constants
   * as isPlivo, so it cannot drift, but note it does NOT textually contain
   * isPlivo; the agreement table in the test is what proves this arm.
   */
  notPlivo: `(${PROVIDER_COLUMN} IS NULL OR ${PROVIDER_COLUMN} <> '${PROVIDER_STAMP_PLIVO}')`,
  value: PROVIDER_VALUE,
  // Never NULL: every row lands on one of the two arms, which is precisely what
  // stops the FE cell ({provider || '—'}) from blanking.
  label: `CASE WHEN ${PROVIDER_IS_PLIVO} THEN '${PROVIDER_LABELS.plivo}'`
    + ` ELSE '${PROVIDER_LABELS.kaleyra}' END`,
  // 1/0 rather than a bare boolean expression, for the same reason as
  // ASSIGNED_AT_CALL: the driver's typing of a 3-valued expression is not
  // something this file should depend on (NULL OR NULL is NULL, not 0).
  /*
   * ⚠ ONE NORMALISATION FOR THE VENDOR TEST, and it is the FILTER's.
   *
   * This arm read the RAW column for plivo and the TRIMMED value for kaleyra,
   * which put two beliefs about the same column inside the one rule that exists
   * to end exactly that. A row stamped ' plivo' (leading space) then tested
   * FALSE for plivo, fell to the ELSE, and was printed as **Kaleyra** — an
   * actively wrong vendor name, where the old blank-prone cell at least printed
   * the raw ' plivo' correctly.
   *
   * So both arms compare the raw column, the same way isPlivo/notPlivo do. The
   * invariant that matters is THE CELL NAMES THE TAB THE ROW APPEARS IN, and
   * that holds for every value only while the label and the filter share one
   * comparison. A whitespace-padded stamp therefore lands in the Kaleyra tab,
   * reads "Kaleyra", and is marked NOT stamped — which is the honest reading of
   * a value the filter itself does not recognise, and providerRaw carries the
   * ' plivo' through to the tooltip so no information is lost.
   *
   * PROVIDER_VALUE (trimmed) is kept for the RAW-VALUE passthrough only, never
   * for deciding a vendor.
   */
  namedFlag: `CASE WHEN ${PROVIDER_IS_PLIVO}`
    + ` OR ${PROVIDER_COLUMN} = '${PROVIDER_STAMP_KALEYRA}' THEN 1 ELSE 0 END`,
});

const PROVIDER_CLAUSE = Object.freeze({
  plivo: ` AND ${PROVIDER_RULE.isPlivo}`,
  kaleyra: ` AND ${PROVIDER_RULE.notPlivo}`,
});

/*
 * ── WHICH STACK PLACED THE CALL ────────────────────────────────────────────
 *
 * Not a heuristic. It is a structural property of the writers, verified in the
 * source of every stack that inserts into this table:
 *
 *   EasyFix_API                 entity/Contact.java:100   `provider` is @Transient
 *   API_AngularClientDashboard  domain/Contact.java       `provider` is @Transient
 *
 * A @Transient field is not in Hibernate's INSERT column list, so neither legacy
 * Java stack CAN write that column — not "does not", cannot. Both of them dial
 * Kaleyra (api-voice.kaleyra.com/v1 dial.click2call), and the vendor is
 * identifiable only from their code, never from the row they wrote. This
 * backend is the only writer that stamps it.
 *
 * So a stamped provider means the new stack wrote the row, and an unstamped one
 * means a legacy stack did. The QA data agrees from the other direction: every
 * one of the 369,745 unstamped rows uses an UPPERCASE caller_status vocabulary
 * with _LEG1/_LEG2 suffixes (ANSWER, NOANSWER_LEG2, IVR-ANSWER, OFF-HOUR) while
 * the stamped rows use lowercase snake_case (completed, hungup, no_answer), and
 * the two populations do not overlap in time.
 *
 * ⚠ Reads PROVIDER_VALUE (trimmed) rather than the raw column, unlike the
 * vendor test above. Those two disagree only for a whitespace-padded stamp such
 * as ' plivo', and they disagree CORRECTLY: something wrote that column, so the
 * row is ours, while the vendor filter's frozen row set still calls it Kaleyra.
 * The By Provider tab shows both facts side by side rather than reconciling
 * them, because they are answers to different questions.
 */
const STACK_NEW = 'New CRM';
const STACK_OLD = 'Old CRM';
const STACKS = Object.freeze([STACK_NEW, STACK_OLD]);
const STACK = `CASE WHEN ${PROVIDER_VALUE} IS NULL THEN '${STACK_OLD}' ELSE '${STACK_NEW}' END`;
/*
 * IS NULL / IS NOT NULL, never `= ''` or `<> ''`: PROVIDER_VALUE already folds
 * NULL, empty and whitespace-only into one state, and a definite null test is
 * the one comparison SQL's three-valued logic cannot turn into a silent NULL —
 * the trap that notPlivo above exists to document.
 */
const STACK_CLAUSE = Object.freeze({
  [STACK_NEW]: ` AND ${PROVIDER_VALUE} IS NOT NULL`,
  [STACK_OLD]: ` AND ${PROVIDER_VALUE} IS NULL`,
});

const n = (v) => Number(v) || 0;

/*
 * A caller id the CRM can actually drill on, or null.
 *
 * `jci.caller_id` is projected raw, and the column really does contain 0 for
 * calls with no attributed caller — a sentinel, not a tbl_user id. Passing it
 * through as 0 broke the CRM twice over: the drill-down guard tests
 * `userId == null`, which 0 slips past, so the count rendered as a link and
 * the request came back 400 ("selectedCallerId must be >= 1"); and the label
 * fallback rendered "User #0". Normalising here fixes every consumer at once
 * — both CRM tables, the XLSX export, and anything added later — instead of
 * asking each one to remember that 0 is special.
 */
function drillableUserId(raw) {
  const id = n(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/*
 * A job id the CRM can actually link to, or null. Same reasoning as
 * drillableUserId above and the same sentinel: jci.job_id holds 0 for a call
 * placed with no job context, and 0 is not a job. Everything derived from the
 * job link — the number, the status snapshot, the assignment flag — has to be
 * absent together, or the row describes a job that was never there.
 */
function drillableJobId(raw) {
  const id = n(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

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
 * The customer this row NAMES, confirmed by the number actually dialled.
 *
 * ─── WHY THE ID IS NOT ENOUGH, AND THIS IS THE THIRD TIME ─────────────────
 *
 * A direct call to a customer — placed from the Customers list with no job in
 * context — stores cust.customer_id in reciever_id (routes/admin/calls.js:277).
 * So an id lookup looks like the obvious, cheap answer.
 *
 * It is a trap. customer_id and efr_id are separate auto-increment sequences
 * and they collide numerically, so reading one as the other does not FAIL — it
 * returns a confident wrong row. Measured on live job-less calls since 2025:
 * of 9,685 whose reciever_id matches a tbl_customer row, 7,411 (77%) were
 * dialled on the number of the EASYFIXER with that same id, and only 473 (5%)
 * on the customer's. A bare `WHEN cu2.customer_id IS NOT NULL THEN 'Customer'`
 * would have relabelled 7,411 technician calls as customer calls.
 *
 * (The same overlap bit `location.user_id` — read as an efr_id it showed one
 * technician's position under another's name — and `caller_id`, which is why
 * CALLER_KIND exists. Three columns, one lesson.)
 *
 * So the id only PINS a candidate; the dialled number CONFIRMS it. A scalar
 * subquery on the primary key returns at most one row, so it cannot multiply
 * the aggregates that read PARTY_ROLE — the same property the technician arm
 * below relies on, and the reason neither is a join.
 */
const CUSTOMER_BY_ID_NUMBER = `(SELECT ${d10('cu2.customer_mob_no')}
          FROM tbl_customer cu2 WHERE cu2.customer_id = jci.reciever_id)`;

/*
 * Is this number a technician's, on a call with NO job to say so?
 *
 * ─── WHY A SEMI-JOIN AND NOT A JOIN ──────────────────────────────────────
 *
 * A direct call to a technician — placed from Manage EasyFixers with no job in
 * context — stores nothing that identifies them except the number dialled:
 * routes/admin/calls.js:298 leaves reciever_id and job_efr_id null. The `ef`
 * join cannot help, because it hangs off the JOB.
 *
 * So the match has to be on the number, and the number IS NOT UNIQUE. On live
 * data four numbers are shared and one placeholder — 1111111111 — sits on 28
 * easyfixer rows. PARTY_ROLE is evaluated inside buildScope, which four
 * COUNT(*) aggregates and the partyRole filter all read, so a join that matched
 * 28 rows would multiply one call into 28 across Total Calls, Connected and
 * every per-row count. Silently.
 *
 * `IN (subquery)` is a SEMI-join: one input row yields at most one output row
 * whatever the subquery returns, so multiplication is impossible by
 * construction rather than by my having deduplicated it correctly. It is also
 * uncorrelated, so MySQL materialises the 10k-row list once per query instead
 * of probing per row.
 *
 * This is the same call tests/call-tracking-caller-identity.test.js already
 * made for the CALLER lookup — "a scalar subquery cannot multiply rows whatever
 * the table's keys are" — applied to the counterparty. I first wrote it as a
 * GROUP BY derived table, which is also safe, and that test correctly refused
 * it: the guard is about not reasoning your way to a safe join when a shape
 * exists that cannot be unsafe.
 */
const EFR_NUMBERS = `(SELECT ${d10('ec2.efr_no')} FROM tbl_easyfixer ec2)`;

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
        /*
         * A technician reached on a call with NO job. Last among the matching
         * arms on purpose: when a job IS attached, its own parties decide the
         * answer, and this must never overrule them — a customer who happens to
         * share a number with some technician stays a Customer.
         */
        /*
         * Job-free arms. Below every job-derived arm, so a job's own parties
         * always decide; Customer above Technician, matching the priority the
         * job-derived arms already establish.
         */
        WHEN jci.cp_d10 IS NOT NULL
         AND jci.cp_d10 = ${CUSTOMER_BY_ID_NUMBER}        THEN 'Customer'
        WHEN jci.cp_d10 IN ${EFR_NUMBERS}                THEN 'Technician'
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
        /*
         * Correlated, and safe to be: PARTY_NAME is used at exactly ONE site,
         * the drill-down, which is capped — never in an aggregate. MIN() over
         * a shared number is arbitrary by necessity; showing one of 28 names as
         * if it were certain is the worse option.
         */
        WHEN jci.cp_d10 IS NOT NULL
         AND jci.cp_d10 = ${CUSTOMER_BY_ID_NUMBER}        THEN COALESCE(
          (SELECT cu4.customer_name FROM tbl_customer cu4 WHERE cu4.customer_id = jci.reciever_id),
          jci.cp_name)
        WHEN jci.cp_d10 IN ${EFR_NUMBERS}                THEN COALESCE(
          (SELECT MIN(ec3.efr_name) FROM tbl_easyfixer ec3 WHERE ${d10('ec3.efr_no')} = jci.cp_d10),
          jci.cp_name)
        ELSE jci.cp_name
      END`;

/*
 * ⚠ caller_id IS A FOREIGN KEY WITHOUT A DECLARED TABLE.
 *
 * Every query here joined it one way — LEFT JOIN tbl_user u ON u.user_id =
 * jci.caller_id — which is right for rows THIS backend writes (routes/admin/
 * calls.js stamps agent.user_id). It is wrong for rows the legacy CRM / mobile
 * backend writes, which put an efr_id there instead. The two namespaces do not
 * overlap in practice: tbl_user ids observed in production are two and three
 * digits (2, 102, 148…), while efr_ids run to 2,000,313.
 *
 * A LEFT JOIN is the quietest way to get that wrong. A miss is indistinguishable
 * from a legitimately absent name, so the COALESCE simply fell through to
 * whatever caller_name the other writer had stamped — and the drill-down then
 * rendered the unmatched id as "#352882" beside it, which ASSERTS a CRM user id
 * that does not exist. Reported as "Called By and To Whom are the same person"
 * on job 529116: the receiver was resolved correctly (PARTY_NAME matches the
 * dialled number against the job's parties) while the caller was not resolved at
 * all, so both cells ended up showing the same stamped string.
 *
 * The technician lookup is a SUBQUERY, deliberately, not a second LEFT JOIN.
 * Two of the four consumers below aggregate (COUNT(*), COUNT(DISTINCT …)) and
 * GROUP BY caller_id; a join that ever matched more than one row would silently
 * inflate those counts, and an operational report that quietly over-counts is
 * worse than one that leaves a name blank. A scalar subquery cannot multiply
 * rows whatever the table's keys turn out to be.
 *
 * ORDER IS LOAD-BEARING: tbl_user first, so behaviour is byte-identical for
 * every row this backend wrote, and the new lookup only ever fires where the old
 * one already returned nothing.
 */
const CALLER_NAME = `COALESCE(
        u.user_name,
        (SELECT ec.efr_name FROM tbl_easyfixer ec WHERE ec.efr_id = jci.caller_id),
        jci.caller_name)`;

/*
 * Which namespace actually answered — so a consumer can stop presenting an
 * unmatched id as a user id. 'unresolved' is the honest answer for a legacy row
 * whose caller matches neither table: we have a name stamped on the audit row
 * and nothing to link it to.
 */
const CALLER_KIND = `CASE
        WHEN u.user_id IS NOT NULL THEN 'user'
        WHEN EXISTS (SELECT 1 FROM tbl_easyfixer ek WHERE ek.efr_id = jci.caller_id) THEN 'technician'
        ELSE 'unresolved'
      END`;

// The snapshot assignment flag, emitted as 1/0 rather than relying on how the
// driver types a bare boolean expression.
const ASSIGNED_AT_CALL = `CASE WHEN jci.job_efr_id IS NOT NULL THEN 1 ELSE 0 END`;

// The IST calendar day of a call, as 'YYYY-MM-DD'. The pool session TZ is
// +05:30 and DATETIMEs are stored IST-verbatim, so this is already IST.
const DAY_EXPR = `DATE_FORMAT(jci.inserted_time, '%Y-%m-%d')`;

/*
 * OUT / IN, normalised to exactly those two strings.
 *
 * Read through the SAME UPPER(COALESCE(…, 'OUT')) shape CP_NUM/CP_NAME use to
 * pick the counterparty leg, so a row can never be counted as inbound here
 * while its OUTBOUND number is the one resolved there.
 *
 * It exists for the no-job grain, where direction is the difference between two
 * genuinely different populations sharing one bucket: staff DIRECT calls placed
 * from Manage EasyFixers / Customers with no job context (caller_id > 0, 'OUT'),
 * and INBOUND calls written by the legacy stack (caller_id 0, 'IN', often
 * caller_status 'OFF-HOUR'). On a sampled production day the inbound rows were 7
 * of 9, so a tab that did not split them would label the majority wrong.
 */
const DIRECTION = `CASE WHEN UPPER(COALESCE(jci.call_type, 'OUT')) = 'IN' THEN 'IN' ELSE 'OUT' END`;

/*
 * ⚠ caller_id IS A tbl_user ID ONLY ON AN OUTBOUND ROW.
 *
 * Measured on QA over 2025-01-01..2026-08-26, and the control is what makes it
 * unarguable:
 *
 *   OUTBOUND   309,575 calls ·    535 distinct caller_id · 99.5% resolve to tbl_user
 *   INBOUND     60,211 calls · 22,336 distinct caller_id ·   91% resolve to NEITHER
 *                                                            tbl_user NOR tbl_easyfixer
 *
 * 535 distinct ids is a staff roster. 22,336 is a customer base. The legacy
 * writer (EasyFix_API, the only place that stamps call_type 'IN') puts the
 * identifier of whoever RANG US into the same column, from a different id
 * space entirely.
 *
 * This is the FOURTH id-space collision in this codebase, and the most
 * expensive kind: customer_id, efr_id and user_id are separate autoincrement
 * sequences that overlap, so reading one as another returns a confident WRONG
 * row rather than an error. 2,568 of those inbound calls collide numerically
 * with a real tbl_user id and 4,436 with a technician — so before this, By User
 * and Top Callers credited 623 NAMED members of staff with calls they never
 * placed, and the name is exactly what made it look correct.
 *
 * The sentinel test the previous fix used (caller_id > 0) catches only the
 * 11,170 rows written with a literal 0. DIRECTION is the property that actually
 * decides it, so every surface that presents a caller identity reads these two
 * and never jci.caller_id raw.
 */
const OUTBOUND_ONLY = ` AND ${DIRECTION} <> 'IN'`;

/*
 * A CALLER, not a sentinel and not somebody who rang US. An inbound call has no
 * CRM user to attribute it to at all — those calls are the Inbound tab's whole
 * subject and are counted there, in totals, and in Missed Inbound.
 */
const REAL_CALLER = ` AND COALESCE(jci.caller_id, 0) > 0${OUTBOUND_ONLY}`;

/*
 * The caller id as anything downstream may READ it: NULL unless this row is an
 * outbound call placed by one of ours. Group by this rather than by
 * jci.caller_id and every inbound row collapses into one honest "nobody here
 * placed this" bucket instead of fanning out into thousands of phantom users.
 */
const CALLER_ID_EXPR = `CASE WHEN ${DIRECTION} = 'IN' THEN NULL ELSE NULLIF(jci.caller_id, 0) END`;

/*
 * NO JOB ATTACHED — the exact complement of the byJob grain's
 * `AND COALESCE(jci.job_id, 0) > 0`, written ONCE because three places need it:
 * the byOther grain, its parties breakdown, and the drill-down's `noJob`
 * selection. NULLIF folds the two spellings of "no job" into one state — a real
 * NULL (a CRM click-to-call placed with no job context) and the 0 sentinel the
 * legacy writer stores — which is why this is not `jci.job_id IS NULL`.
 *
 * Leading ' AND ': it is appended to a buildScope `where`, exactly like the
 * byJob clause it complements.
 */
const NO_JOB = ' AND NULLIF(jci.job_id, 0) IS NULL';

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
  /*
   * Who MADE the call. Filtered through CALLER_ID_EXPR, not the raw column:
   * caller_id is a tbl_user id only on an outbound row, so a filter on the raw
   * column also matches every inbound row whose foreign id collides with the
   * selected user's — measured at 2,568 such calls on QA.
   */
  where += buildInFilter(CALLER_ID_EXPR, filters.callerId, params);
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
 * at a row cap, so deriving active days by counting a user's rows in that
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
 * The nested breakdown queries keep their `ORDER BY <stitch key>`.
 *
 * The ordering was originally there so a LIMIT boundary fell BETWEEN keys
 * rather than through the middle of one. The LIMITs are gone, so nothing can
 * cut a key any more and the guard that dropped half-read keys
 * (completeKeysOnly) has been deleted with them — every stitch key is complete
 * by construction now. The ordering stays because groupBy() below walks the
 * rows in order, and it costs nothing.
 */

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

/*
 * ── The conference LEGS, aggregated to ONE ROW PER CALL ────────────────────
 *
 * The shape that lets a leg table be read WITHOUT multiplying the call it
 * belongs to: collapse the legs first, join the collapsed row second. Whatever
 * this returns, it returns at most one row per job_caller_info_id, so the LEFT
 * JOIN below cannot fan a call out — which is the same property buildScope
 * protects by not joining this table at all.
 *
 * `reached` counts the people who were ACTUALLY ON the call: not the operator
 * (that is our own side, and counting it would add one to every call), and only
 * legs whose status says they made it into the room. A leg that rang out or was
 * declined is someone we tried to reach and did not.
 *
 * conference_id IS NOT NULL is load-bearing, not decorative: a pre-conference
 * Plivo row has a call-log row with NO role and NO conference, and letting it
 * through would give the call `legs = 1, reached = 0` — scoring an ordinary
 * connected call as nobody reached, instead of letting it take the fallback.
 */
const LEG_REACH_SUBQUERY = `
        SELECT job_caller_info_id AS call_id,
               COUNT(*) AS legs,
               COUNT(CASE WHEN participant_role <> 'operator'
                           AND status IN ('answered', 'completed') THEN 1 END) AS reached
          FROM tbl_plivo_call_log
         WHERE conference_id IS NOT NULL
           AND job_caller_info_id IS NOT NULL
         GROUP BY job_caller_info_id`;

/*
 * PARTIES REACHED + CONFERENCE CALL COUNT — its OWN aggregate over the SAME
 * scope. It counts PEOPLE, not calls, and it is the only query in this file that
 * reads tbl_plivo_call_log for a number: every count remains a count of
 * tbl_job_caller_info rows.
 *
 * The LEFT JOIN direction is the whole design. A Kaleyra call has no row in
 * tbl_plivo_call_log at all, so it MUST still contribute — one party when it
 * connected, none when it rang out — rather than vanish. Same for any Plivo call
 * placed before conferencing shipped.
 *
 * Probe-gated the same way loadConferenceLegs is: on a pre-migration schema
 * `conference_id` does not exist, and issuing a query that is guaranteed to fail
 * on every request is not fail-soft, it is just noisy. The try/catch behind it
 * is the second net (a table lock, a permissions change, anything).
 */
/*
 * DEGRADE TO THE FALLBACK, NOT TO ZERO.
 *
 * When the conference columns are absent — or the leg query fails — the answer
 * is NOT "nobody was reached". Every metric this report already had still knows
 * that a connected call reached one party, and that branch needs no conference
 * table at all. Returning 0 would put "Parties Reached 0" beside a non-zero
 * Connected, which reads as a broken metric rather than an absent one, and an
 * operator who sees one tile contradict another stops trusting the page.
 *
 * So the degraded answer is exactly `connected`: true, complete for a
 * pre-conference world, and an understatement only of the thing that does not
 * exist yet. conferenceCalls stays 0, which is also simply true there.
 */
async function partiesFallback(filters) {
  try {
    const s = buildScope(filters);
    const [[r]] = await pool.query(
      `SELECT COUNT(CASE WHEN COALESCE(jci.duration, 0) > 0 THEN 1 END) AS parties_reached
         ${s.from} ${s.where}`,
      s.params,
    );
    return { partiesReached: n(r && r.parties_reached), conferenceCalls: 0 };
  } catch {
    return { partiesReached: 0, conferenceCalls: 0 };
  }
}

async function loadPartiesReached(filters) {
  if (!(await plivoLog.hasConferenceColumns())) return partiesFallback(filters);
  try {
    const s = buildScope(filters);
    const [[r]] = await pool.query(
      `SELECT SUM(CASE WHEN lg.call_id IS NULL
                       -- No legs: Kaleyra, or a pre-conference Plivo call. The
                       -- call itself is the only evidence of who was reached,
                       -- and a positive duration is what "connected" means
                       -- everywhere else in this report (see CALL_AGG).
                       THEN CASE WHEN COALESCE(jci.duration, 0) > 0 THEN 1 ELSE 0 END
                       ELSE lg.reached END)                            AS parties_reached,
              -- MULTI-party only. One reached leg is an ordinary 1:1 call that
              -- happens to be carried by an MPC, and calling that a conference
              -- would report the plumbing rather than what ops did.
              COUNT(CASE WHEN COALESCE(lg.reached, 0) > 1 THEN 1 END)  AS conference_calls
         ${s.from}
         LEFT JOIN (${LEG_REACH_SUBQUERY}) lg ON lg.call_id = jci.job_caller_info
         ${s.where}`,
      s.params,
    );
    return { partiesReached: n(r && r.parties_reached), conferenceCalls: n(r && r.conference_calls) };
  } catch (e) {
    logger.warn('Call Tracking parties-reached aggregate failed (falling back to connected-call count) · ' + e.message);
    return partiesFallback(filters);
  }
}

/*
 * CONFERENCE COST — billed seconds, and the coverage that makes them readable.
 *
 * billed_leg_seconds comes off the MPCEnd webhook (MPCBilledDuration) and is
 * NULL until that webhook arrives — for a live room, for a room whose webhook
 * was lost, and for every room on a provider that does not report it. So the SUM
 * is ALWAYS accompanied by COUNT(billed_leg_seconds), i.e. how many of the rooms
 * in scope actually contributed to it. Shipping the sum alone would present a
 * partial spend as the whole spend, with nothing on screen to say so.
 *
 * The INNER JOIN is correct HERE and is not the hazard buildScope guards
 * against: this query does not count calls, it selects rooms. Nothing about
 * totals.calls passes through it.
 */
/*
 * ⚠ THE DENOMINATOR IS `conferenceRooms`, NOT `conferenceCalls`. They count
 * different populations and mixing them prints impossible coverage.
 *
 * routes/admin/calls.js mints a tbl_job_conference room for EVERY Plivo ops
 * call, because a 1:1 call is a one-participant MPC — that is the whole reason
 * conferencing works at all (Plivo cannot promote a live <Dial>). So:
 *
 *   conferenceRooms  — every room in scope. The population the SUM is taken over,
 *                      and therefore the ONLY honest denominator for its coverage.
 *   conferenceCalls  — only the calls that actually GAINED people. A different,
 *                      smaller, and genuinely interesting number — but a coverage
 *                      ratio built on it reads "3 of 2 rooms billed".
 *
 * And the SUM stays over ALL rooms deliberately. Narrowing it to multi-party
 * rooms would under-report the exact spend this metric exists to expose: a 1:1
 * ops call is billed as an MPC too, so its seconds are real money.
 */
async function loadConferenceBilling(filters) {
  const zero = { conferenceBilledSecs: 0, conferenceBilledCalls: 0, conferenceRooms: 0 };
  try {
    const s = buildScope(filters);
    const [[r]] = await pool.query(
      `SELECT COALESCE(SUM(conf.billed_leg_seconds), 0) AS billed_secs,
              -- COUNT(col) skips NULLs — that is exactly the coverage figure.
              COUNT(conf.billed_leg_seconds)            AS billed_calls,
              -- COUNT(*) counts every room, billed or not: the denominator.
              COUNT(*)                                  AS rooms
         ${s.from}
         JOIN tbl_job_conference conf ON conf.job_caller_info_id = jci.job_caller_info
         ${s.where}`,
      s.params,
    );
    return {
      conferenceBilledSecs: n(r && r.billed_secs),
      conferenceBilledCalls: n(r && r.billed_calls),
      conferenceRooms: n(r && r.rooms),
    };
  } catch (e) {
    // Pre-migration there is no tbl_job_conference at all. Zeros, a warn, and a
    // report that still renders.
    logger.warn('Call Tracking conference-billing aggregate failed (tile reads 0) · ' + e.message);
    return zero;
  }
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
            /*
             * DISTINCT NULLIF(caller_id, 0), not DISTINCT caller_id: 0 is the
             * "nobody here placed this" sentinel on legacy inbound rows, not a
             * user id (see drillableUserId). Counting it added exactly one
             * phantom caller to the tile for every window containing inbound
             * traffic.
             */
            COUNT(DISTINCT ${CALLER_ID_EXPR}) AS unique_callers,
            /*
             * Inbound reach. MISSED is defined as duration = 0, NOT as
             * caller_status = 'OFF-HOUR' — see the header: caller_status is not
             * comparable across providers ('answered' / 'hangup' / Kaleyra's own
             * vocabulary / NULL on legacy rows), while a positive duration means
             * the same thing on every row and is already this report's
             * definition of CONNECTED. A metric built on the string would agree
             * with the tile beside it only by luck.
             *
             * These count somebody ringing US and nobody picking up — a number
             * no surface in this report has ever shown, and the likeliest place
             * in it to find lost work.
             */
            SUM(CASE WHEN ${DIRECTION} = 'IN' THEN 1 ELSE 0 END)                          AS inbound_calls,
            SUM(CASE WHEN ${DIRECTION} = 'IN' AND COALESCE(jci.duration, 0) = 0 THEN 1 ELSE 0 END) AS inbound_missed
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
      ORDER BY calls DESC, jci.job_id DESC`,
    sJ.params,
  );

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
            MAX(${CALLER_NAME}) AS userName,
            ${CALL_AGG},
            COUNT(DISTINCT NULLIF(jci.job_id, 0)) AS unique_jobs,
            MIN(jci.inserted_time) AS firstCallAt,
            MAX(jci.inserted_time) AS lastCallAt
       ${sU.from}
       LEFT JOIN tbl_user u ON u.user_id = jci.caller_id
       ${sU.where}${REAL_CALLER}
      GROUP BY ${DAY_EXPR}, jci.caller_id
      ORDER BY day DESC, calls DESC`,
    sU.params,
  );

  /*
   * ── Per-USER grain, WHOLE WINDOW ──
   * The SECOND aggregation grain of the By User tab: one row per caller for the
   * entire window, carrying the per-day efficiency averages. Same buildScope, so
   * it is scoped by the SAME filters as the daily grain and the two reconcile —
   * SUM(byUser.calls) === SUM(byUserCombined.calls) for any filter set (as long
   * as neither was truncated — the row caps are gone, see the header).
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
            MAX(${CALLER_NAME}) AS userName,
            ${ACTIVE_DAYS},
            ${CALL_AGG},
            COUNT(DISTINCT NULLIF(jci.job_id, 0)) AS unique_jobs,
            MIN(jci.inserted_time) AS firstCallAt,
            MAX(jci.inserted_time) AS lastCallAt
       ${sUC.from}
       LEFT JOIN tbl_user u ON u.user_id = jci.caller_id
       ${sUC.where}${REAL_CALLER}
      GROUP BY jci.caller_id
      ORDER BY calls DESC, jci.caller_id`,
    sUC.params,
  );

  /*
   * ── Per-(DAY × CALLER × DIRECTION) grain, NO JOB ATTACHED ──
   *
   * The calls that `totals` has always counted and NO table has ever shown. An
   * operator reading "9 Total Calls" over a By Job table with 2 rows had no way
   * to reach the other 7 — they were not missing from the report, they were
   * missing from every GRAIN in it, because byJob restricts to real job ids and
   * byUser is the same rows sliced a different way.
   *
   * DIRECTION IS PART OF THE GRAIN, not a column beside it: this bucket holds
   * two unrelated populations (see DIRECTION) and collapsing them would print
   * one row that is mostly legacy inbound traffic under a caller who placed
   * none of it.
   *
   * Same buildScope and same CALL_AGG as every grain above — the
   * ONLY addition is NO_JOB, so these rows are exactly `totals` minus `byJob`'s
   * population and nothing double-counts.
   */
  const sO = buildScope(filters);
  const [otherRows] = await pool.query(
    `SELECT ${DAY_EXPR} AS day,
            ${DIRECTION} AS direction,
            ${CALLER_ID_EXPR} AS userId,
            MAX(${CALLER_NAME}) AS userName,
            ${CALL_AGG},
            MIN(jci.inserted_time) AS firstCallAt,
            MAX(jci.inserted_time) AS lastCallAt
       ${sO.from}
       LEFT JOIN tbl_user u ON u.user_id = jci.caller_id
       ${sO.where}${NO_JOB}
      GROUP BY ${DAY_EXPR}, ${DIRECTION}, ${CALLER_ID_EXPR}
      ORDER BY day DESC, calls DESC`,
    sO.params,
  );

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
              ${CALLER_ID_EXPR} AS userId,
              MAX(CASE WHEN ${DIRECTION} = 'IN' THEN NULL ELSE ${CALLER_NAME} END) AS userName,
              COUNT(*) AS calls
         ${sC.from}
         LEFT JOIN tbl_user u ON u.user_id = jci.caller_id
         ${sC.where} AND jci.job_id IN (${jobIn})
        GROUP BY jci.job_id, ${CALLER_ID_EXPR}
        ORDER BY jci.job_id, calls DESC`,
      [...sC.params, ...jobIds],
    );
    callersByJob = groupBy(callerRows, jobKey, (r) => ({
      userId: drillableUserId(r.userId),
      // A NULL caller here is an INBOUND call on this job — somebody rang US
      // about it. Naming it for the column it lacks told an operator nothing.
      userName: r.userName || (drillableUserId(r.userId) == null ? 'Incoming call' : `User #${n(r.userId)}`),
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
        ORDER BY jci.job_id, calls DESC`,
      [...sP.params, ...jobIds],
    );
    partiesByJob = groupBy(partyRows, jobKey, (r) => ({ role: r.role || 'Other', calls: n(r.calls) }));

    // AT WHICH STEP, per job — from the SNAPSHOT columns, so this is history,
    // not a re-read of today's status.
    const sS = buildScope(filters);
    const [stepRows] = await pool.query(
      `SELECT jci.job_id AS jobId, jci.job_status AS status,
              ${ASSIGNED_AT_CALL} AS assignedFlag, COUNT(*) AS calls
         ${sS.from}
         ${sS.where} AND jci.job_id IN (${jobIn})
        GROUP BY jci.job_id, jci.job_status, ${ASSIGNED_AT_CALL}
        ORDER BY jci.job_id, calls DESC`,
      [...sS.params, ...jobIds],
    );
    const rawStepsByJob = groupBy(stepRows, jobKey, (r) => r);
    stepsByJob = new Map([...rawStepsByJob].map(([k, v]) => [k, foldSteps(v)]));
  }

  // Per-(day, user) breakdowns. Keyed 'YYYY-MM-DD|userId'. Restricting on the
  // caller ids alone is enough — the day axis is already the scope window — and
  // any (day,user) pair the capped grain above dropped simply goes unstitched.
  // These are ordered BY THAT KEY for the
  // reason documented there: a partial breakdown under a full count lies.
  let partiesByUser = new Map();
  let stepsByUser = new Map();
  const userKey = (r) => `${r.day}|${n(r.userId)}`;
  if (userIds.length > 0) {
    const sUP = buildScope(filters);
    const [upRows] = await pool.query(
      `SELECT ${DAY_EXPR} AS day, jci.caller_id AS userId, ${PARTY_ROLE} AS role, COUNT(*) AS calls
         ${sUP.from}
         ${sUP.where}${REAL_CALLER} AND jci.caller_id IN (${userIn})
        GROUP BY ${DAY_EXPR}, jci.caller_id, ${PARTY_ROLE}
        ORDER BY day, jci.caller_id, calls DESC`,
      [...sUP.params, ...userIds],
    );
    partiesByUser = groupBy(upRows, userKey, (r) => ({ role: r.role || 'Other', calls: n(r.calls) }));

    const sUS = buildScope(filters);
    const [usRows] = await pool.query(
      `SELECT ${DAY_EXPR} AS day, jci.caller_id AS userId, jci.job_status AS status,
              ${ASSIGNED_AT_CALL} AS assignedFlag, COUNT(*) AS calls
         ${sUS.from}
         ${sUS.where}${REAL_CALLER} AND jci.caller_id IN (${userIn})
        GROUP BY ${DAY_EXPR}, jci.caller_id, jci.job_status, ${ASSIGNED_AT_CALL}
        ORDER BY day, jci.caller_id, calls DESC`,
      [...sUS.params, ...userIds],
    );
    const rawStepsByUser = groupBy(usRows, userKey, (r) => r);
    stepsByUser = new Map([...rawStepsByUser].map(([k, v]) => [k, foldSteps(v)]));
  }

  /*
   * Per-USER (whole-window) breakdowns. Keyed on caller_id ALONE — the day is not
   * part of this grain. Same machinery as every other breakdown above: ONE
   * grouped query per breakdown, restricted to the caller ids this grain actually
   * returned, ordered BY THE STITCH KEY so
   * a hit cap drops whole keys instead of leaving a half-counted list beside a
   * full total.
   *
   * The ids come from combinedRows, NOT from the daily grain: if byUser hit
   * a row cap its caller set could be a strict subset, and stitching off it would
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
         ${sCP.where}${REAL_CALLER} AND jci.caller_id IN (${combIn})
        GROUP BY jci.caller_id, ${PARTY_ROLE}
        ORDER BY jci.caller_id, calls DESC`,
      [...sCP.params, ...combinedUserIds],
    );
    partiesByCaller = groupBy(cpRows, callerKey, (r) => ({ role: r.role || 'Other', calls: n(r.calls) }));

    const sCS = buildScope(filters);
    const [csRows] = await pool.query(
      `SELECT jci.caller_id AS userId, jci.job_status AS status,
              ${ASSIGNED_AT_CALL} AS assignedFlag, COUNT(*) AS calls
         ${sCS.from}
         ${sCS.where}${REAL_CALLER} AND jci.caller_id IN (${combIn})
        GROUP BY jci.caller_id, jci.job_status, ${ASSIGNED_AT_CALL}
        ORDER BY jci.caller_id, calls DESC`,
      [...sCS.params, ...combinedUserIds],
    );
    const rawStepsByCaller = groupBy(csRows, callerKey, (r) => r);
    stepsByCaller = new Map([...rawStepsByCaller].map(([k, v]) => [k, foldSteps(v)]));
  }

  /*
   * The no-job grain's `parties` breakdown — the SAME one grouped query,
   * ordered by the stitch key, that every
   * other breakdown above uses.
   *
   * NO `steps` counterpart, deliberately: jci.job_status is the snapshot of a
   * job, and these calls have no job. A steps list here would be one 'Unknown'
   * entry on every row.
   *
   * ⚠ TODAY THIS ANSWERS 'Other' FOR EVERY ROW, and that is the honest answer
   * rather than a bug: PARTY_ROLE matches the dialled number against the JOB's
   * parties (cu / j / ef), and with no job those joins are all NULL. It is left
   * as a real query instead of a hardcoded [{ role: 'Other' }] so that the day
   * PARTY_ROLE gains a job-independent arm — matching a technician straight off
   * tbl_easyfixer is the obvious next ask for a tab about staff direct calls —
   * this tab starts telling the truth without anyone remembering it exists.
   */
  /*
   * The key is (day, direction, CALLER_ID_EXPR) — the same three expressions the
   * grain above groups by, so a row and its breakdown cannot disagree about
   * which bucket they belong to. `n()` folds a NULL caller to 0 on BOTH sides.
   *
   * ⚠ NO `IN (...)` RESTRICTION, unlike the job-keyed breakdowns. The key is
   * NULLABLE now (every inbound row carries a NULL caller), and NULL never
   * satisfies IN — the whole inbound half of this tab would silently lose its
   * "To Whom" column. The restriction only ever existed to avoid fetching
   * breakdowns for rows a cap had dropped, and the caps are gone: this query is
   * scoped by exactly the same window and NO_JOB predicate as the grain, so it
   * returns those keys and no others.
   */
  let partiesByOther = new Map();
  const otherKey = (r) => `${r.day}|${r.direction}|${n(r.userId)}`;
  if (otherRows.length > 0) {
    const sOP = buildScope(filters);
    const [opRows] = await pool.query(
      `SELECT ${DAY_EXPR} AS day, ${DIRECTION} AS direction, ${CALLER_ID_EXPR} AS userId,
              ${PARTY_ROLE} AS role, COUNT(*) AS calls
         ${sOP.from}
         ${sOP.where}${NO_JOB}
        GROUP BY ${DAY_EXPR}, ${DIRECTION}, ${CALLER_ID_EXPR}, ${PARTY_ROLE}
        ORDER BY day, direction, userId, calls DESC`,
      sOP.params,
    );
    partiesByOther = groupBy(opRows, otherKey, (r) => ({ role: r.role || 'Other', calls: n(r.calls) }));
  }

  /*
   * ── Per-(VENDOR × STACK × DIRECTION) grain ──
   *
   * "How many calls went through Plivo and how many through Kaleyra, and how
   * many of each came from the new CRM versus the old one."
   *
   * At most eight rows, and several of them are structurally empty rather than
   * merely zero — which is the useful part. Plivo exists ONLY in this backend
   * (the legacy stacks dial Kaleyra and cannot stamp the column at all), so
   * Plivo × Old CRM can never be anything but absent, and every inbound row is
   * legacy by the same argument. A tab that shows those as blank cells tells an
   * operator more about the migration than one that hides them.
   *
   * Same buildScope and same CALL_AGG as every other grain, so it reconciles
   * with totals exactly: this is the whole window partitioned three ways, with
   * no predicate of its own.
   */
  const sPv = buildScope(filters);
  const [providerRows] = await pool.query(
    `SELECT ${PROVIDER_RULE.label} AS provider,
            /*
             * The FILTER key beside the display label, so the drill-down does
             * not have to map 'Plivo' back to 'plivo' in the browser. Derived
             * from the SAME isPlivo test the label is, so a row can never drill
             * into a vendor other than the one its cell names.
             */
            CASE WHEN ${PROVIDER_RULE.isPlivo} THEN '${PROVIDER_STAMP_PLIVO}' ELSE '${PROVIDER_STAMP_KALEYRA}' END AS providerKey,
            ${STACK} AS stack,
            ${DIRECTION} AS direction,
            ${CALL_AGG},
            COUNT(DISTINCT NULLIF(jci.job_id, 0)) AS unique_jobs,
            COUNT(DISTINCT ${CALLER_ID_EXPR}) AS unique_callers,
            MIN(jci.inserted_time) AS firstCallAt,
            MAX(jci.inserted_time) AS lastCallAt
       ${sPv.from} ${sPv.where}
      GROUP BY ${PROVIDER_RULE.label}, ${STACK}, ${DIRECTION}
      ORDER BY calls DESC`,
    sPv.params,
  );

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

  /*
   * ── Conference metrics — TILES ONLY ──
   * Two extra aggregates over the SAME scope, each self-contained and each
   * fail-soft. They are read AFTER every existing query and folded into
   * `totals` only: nothing above this line changes shape or value because of
   * them, and byJob / byUser / byUserCombined / byDay deliberately do not carry
   * per-row versions (see the header).
   */
  const reach = await loadPartiesReached(filters);
  const billing = await loadConferenceBilling(filters);

  const totals = {
    ...shapeAgg(tot),
    uniqueJobs: n(tot && tot.unique_jobs),
    uniqueCallers: n(tot && tot.unique_callers),
    inboundCalls: n(tot && tot.inbound_calls),
    inboundMissed: n(tot && tot.inbound_missed),
    /*
     * All four are ALWAYS numbers, never null. The null/em-dash convention this
     * report uses means "we cannot divide" — it belongs to averages. These are
     * counts and sums: zero here means zero, and a zero that means "could not
     * measure" is announced in the log by the warn its loader emitted.
     */
    partiesReached: reach.partiesReached,
    conferenceCalls: reach.conferenceCalls,
    conferenceBilledSecs: billing.conferenceBilledSecs,
    conferenceBilledCalls: billing.conferenceBilledCalls,
    // The denominator conferenceBilledCalls is read against. NOT conferenceCalls
    // — see the header: a room exists for every ops call, so the two count
    // different populations and a ratio of them prints "3 of 2".
    conferenceRooms: billing.conferenceRooms,
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
      userId: drillableUserId(r.userId),
      userName: r.userName || (drillableUserId(r.userId) == null ? 'Unattributed' : `User #${n(r.userId)}`),
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
      userName: r.userName || (drillableUserId(r.userId) == null ? 'Unattributed' : `User #${n(r.userId)}`),
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

  /*
   * The NO-JOB grain. Shares byUser's numeric block (shapeAgg over the same
   * CALL_AGG), so `calls` here means what `calls` means everywhere else.
   *
   * ⚠ userName is NOT byUser's expression verbatim, and the difference is
   * deliberate. CALLER_NAME's last resort is jci.caller_name, which on an
   * INBOUND row is the name of whoever CALLED IN — the customer. byUser never
   * meets that case (its rows are CRM-placed calls); this grain is half made of
   * it, and printing a customer's name in a column headed "User" credits them
   * with placing the call. So an unattributed row reads 'Unattributed', full
   * stop, and the stamped name is simply not promoted into a caller slot.
   */
  const byOther = otherRows.map((r) => {
    const id = drillableUserId(r.userId);
    return {
      day: r.day,
      direction: r.direction,
      userId: id,
      /*
       * Name the row for what it IS, not for what it lacks. "Unattributed"
       * described a missing caller_id — true, and useless to an operator: on an
       * INBOUND row there was never going to be one, because nobody here placed
       * the call. These are people ringing us.
       */
      userName: id == null
        ? (r.direction === 'IN' ? 'Incoming caller' : 'No caller recorded')
        : (r.userName || `User #${n(r.userId)}`),
      ...shapeAgg(r),
      parties: partiesByOther.get(otherKey(r)) || [],
      // RAW DB datetime strings, exactly as byJob / byUser return them — this
      // report formats no timestamp server-side.
      firstCallAt: r.firstCallAt || null,
      lastCallAt: r.lastCallAt || null,
    };
  });

  const byProvider = providerRows.map((r) => ({
    provider: r.provider,
    providerKey: r.providerKey,
    stack: r.stack,
    direction: r.direction,
    ...shapeAgg(r),
    uniqueJobs: n(r.unique_jobs),
    uniqueCallers: n(r.unique_callers),
    firstCallAt: r.firstCallAt || null,
    lastCallAt: r.lastCallAt || null,
  }));

  logger.info('Returning ' + byJob.length + ' job rows · ' + byUser.length + ' day-user rows · '
    + byUserCombined.length + ' combined user rows · '
    + byOther.length + ' no-job rows · ' + byProvider.length + ' provider rows · '
    + byDay.length + ' trend days · ' + totals.calls + ' calls · '
    + totals.partiesReached + ' parties reached across ' + totals.conferenceCalls + ' conference calls · '
    + totals.conferenceBilledSecs + ' billed conf secs from ' + totals.conferenceBilledCalls + ' rooms');
  return { totals, byJob, byUser, byUserCombined, byOther, byProvider, byDay };
}


/*
 * ── GRAPHICAL VIEW, SCOPED TO THE ACTIVE TAB ───────────────────────────────
 *
 * The charts used to be derived in the browser from `byUser`, which meant they
 * described ONE population — every call with a real caller — no matter which
 * table was on screen. An operator on the Inbound tab read a donut and a trend
 * built mostly out of outbound job calls, and the KPI tiles above them counted
 * the whole window. The picture and the rows under it were answering different
 * questions.
 *
 * These are the SAME aggregates, computed server-side over the tab's own
 * population. Server-side and not a client filter for one reason that matters:
 * `parties` and `steps` are per-CALL derivations (PARTY_ROLE compares numbers,
 * the step is a per-row snapshot), and the response only carries them
 * pre-summed against grains that no longer match the tab. Re-slicing them in
 * the browser would mean re-deriving them from data that isn't there.
 *
 * ⚠ THIS IS A SEPARATE, LIGHT ENDPOINT — deliberately not a field on /summary.
 * The row caps are gone (see the header), so /summary is now a very large
 * response; refetching it on every tab click to move a donut would be a
 * multi-megabyte round trip per click. These five queries are pure aggregates
 * and return a few kilobytes whatever the window.
 *
 * Every one of them is built from the SAME buildScope as the tables, so a chart
 * and the rows beneath it can never disagree about what the filters mean.
 */
const GRAIN_SCOPE = Object.freeze({
  // The By Job table: calls that carry a real job id.
  job: ' AND COALESCE(jci.job_id, 0) > 0',
  // The By User table: every call SOMEBODY HERE placed, job or not. Its rows are
  // exactly the ones REAL_CALLER admits, which is why it is that clause.
  user: REAL_CALLER,
  // The two halves of the no-job bucket, split the way the tabs split them.
  direct: `${NO_JOB} AND ${DIRECTION} = 'OUT'`,
  inbound: `${NO_JOB} AND ${DIRECTION} = 'IN'`,
  /*
   * The By Provider tab REGROUPS the window rather than narrowing it, so its
   * scope is the empty string — every call, exactly like totals. It is listed
   * here anyway rather than special-cased at the call site: the enum the route
   * validates against is generated from these keys, so a tab missing from this
   * object is a tab whose charts 400.
   */
  provider: '',
});
const CHART_GRAINS = Object.freeze(Object.keys(GRAIN_SCOPE));

/* Bars and slices stop being readable past ~10 categories. */
const CHART_TOP_N = 10;

async function getCallTrackingCharts(filters = {}, grain = 'job') {
  const scope = GRAIN_SCOPE[grain];
  // The route's Joi enum is generated from CHART_GRAINS, so this is a backstop
  // for a direct caller — never a path a request can take.
  if (scope == null) throw Object.assign(new Error(`Unknown chart grain '${grain}'`), { status: 400 });
  logger.info('Call Tracking charts · grain=' + grain);

  /*
   * ⚠ unique_callers counts DISTINCT NULLIF(caller_id, 0), not DISTINCT
   * caller_id. 0 is the "nobody here placed this" sentinel the legacy inbound
   * writer stores (see drillableUserId) — counting it credits a whole window
   * with one extra caller who does not exist, and on the Inbound grain, where
   * every row carries it, it would print "1 caller" for calls nobody placed.
   */
  const sT = buildScope(filters);
  const [[tot]] = await pool.query(
    `SELECT ${CALL_AGG},
            COUNT(DISTINCT NULLIF(jci.job_id, 0))    AS unique_jobs,
            COUNT(DISTINCT ${CALLER_ID_EXPR}) AS unique_callers
       ${sT.from} ${sT.where}${scope}`,
    sT.params,
  );

  // Trend — gap-filled exactly like the summary's, over the same clamped axis.
  const days = trendDays(filters);
  const sD = buildScope({ ...filters, dateFrom: days[0], dateTo: days[days.length - 1] });
  const [dayRows] = await pool.query(
    `SELECT ${DAY_EXPR} AS day,
            COUNT(*) AS calls,
            COUNT(CASE WHEN COALESCE(jci.duration, 0) > 0 THEN 1 END) AS connected,
            COUNT(DISTINCT NULLIF(jci.job_id, 0)) AS unique_jobs
       ${sD.from} ${sD.where}${scope}
      GROUP BY ${DAY_EXPR}`,
    sD.params,
  );
  const dayMap = new Map(dayRows.map((r) => [r.day, r]));
  const byDay = days.map((day) => {
    const r = dayMap.get(day);
    return { day, calls: n(r && r.calls), connected: n(r && r.connected), uniqueJobs: n(r && r.unique_jobs) };
  });

  // To whom — the same PARTY_ROLE the tables and the filter use.
  const sP = buildScope(filters);
  const [partyRows] = await pool.query(
    `SELECT ${PARTY_ROLE} AS role, COUNT(*) AS calls
       ${sP.from} ${sP.where}${scope}
      GROUP BY ${PARTY_ROLE}
      ORDER BY calls DESC`,
    sP.params,
  );

  /*
   * At which step — RESTRICTED TO CALLS THAT HAVE A JOB, on every grain.
   *
   * "Which step of the job lifecycle" is undefined for a call with no job: the
   * snapshot column is NULL and jobStatusLabel folds it to 'Unknown'. The
   * browser-side version had no such restriction, so its chart carried an
   * 'Unknown' bar that was really "these calls had no job" — a bar labelled for
   * our ignorance rather than for what it counted. On the two no-job grains
   * this returns nothing and the chart correctly does not render.
   */
  const sS = buildScope(filters);
  const [stepRows] = await pool.query(
    `SELECT jci.job_status AS status,
            ${ASSIGNED_AT_CALL} AS assignedFlag,
            COUNT(*) AS calls
       ${sS.from} ${sS.where}${scope}
        AND COALESCE(jci.job_id, 0) > 0
      GROUP BY jci.job_status, ${ASSIGNED_AT_CALL}
      ORDER BY calls DESC`,
    sS.params,
  );

  /*
   * Top callers — people who PLACED calls, so REAL_CALLER always applies.
   * (Redundant on the 'user' grain, which IS that clause; a repeated AND of the
   * same predicate costs nothing and keeps the rule stated in one place rather
   * than implied by which grain you happen to be on.) On the Inbound grain it
   * correctly yields nothing: we placed none of those calls.
   *
   * LIMIT is a module constant, never interpolated input.
   */
  const sC = buildScope(filters);
  const [callerRows] = await pool.query(
    `SELECT ${CALLER_ID_EXPR} AS userId,
            MAX(${CALLER_NAME}) AS userName,
            COUNT(*) AS calls,
            COUNT(CASE WHEN COALESCE(jci.duration, 0) > 0 THEN 1 END) AS connected
       ${sC.from}
       LEFT JOIN tbl_user u ON u.user_id = jci.caller_id
       ${sC.where}${scope}${REAL_CALLER}
      GROUP BY ${CALLER_ID_EXPR}
      ORDER BY calls DESC
      LIMIT ${CHART_TOP_N}`,
    sC.params,
  );

  const out = {
    grain,
    totals: {
      ...shapeAgg(tot),
      uniqueJobs: n(tot && tot.unique_jobs),
      uniqueCallers: n(tot && tot.unique_callers),
    },
    byDay,
    // `value`, not `calls` — the donut's valueKey. Zero-call roles are dropped
    // so the legend never describes a slice that isn't drawn.
    parties: partyRows.map((r) => ({ name: r.role || 'Other', value: n(r.calls) })).filter((d) => d.value > 0),
    // foldSteps collapses the (status, assignedFlag) split back to one entry per
    // LABEL and sorts most-calls-first — the same fold the tables use.
    steps: foldSteps(stepRows).slice(0, CHART_TOP_N).map((s) => ({ name: s.label, calls: s.calls })),
    callers: callerRows.map((r) => ({
      name: r.userName || `User #${n(r.userId)}`,
      calls: n(r.calls),
      connected: n(r.connected),
    })),
  };
  logger.info('Call Tracking charts · grain=' + grain + ' · ' + out.totals.calls + ' calls · '
    + out.byDay.length + ' trend days · ' + out.parties.length + ' party roles · '
    + out.steps.length + ' steps · ' + out.callers.length + ' callers');
  return out;
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
  if (selection.selectedCallerId != null) {
    // CALLER_ID_EXPR, not the raw column — the count this drill was opened from
    // is derived that way, and a list that disagrees with its own number is the
    // one thing this endpoint exists to prevent.
    where += ` AND ${CALLER_ID_EXPR} = ?`;
    params.push(Number(selection.selectedCallerId));
  }
  /*
   * The Other Calls tab's counts, made clickable. The SAME predicate the
   * byOther grain is built on (NO_JOB), which is the whole reason the numbers
   * reconcile. Independent of the keys around it: `noJob` + `day` is a cell in
   * that tab, `noJob` + `selectedCallerId` is one caller's direct calls.
   *
   * `direction` and `unattributed` complete the grain.
   *
   * WITHOUT BOTH, THIS TAB BREAKS THE REPORT'S ONE HARD INVARIANT: that a
   * drill-down list reconciles with the count it was opened from (see the route
   * header). A byOther row is keyed on (day × caller × direction), so a drill
   * carrying only `noJob` + `day` returns every job-less call that day from
   * every caller in both directions. On the day this tab was built for —
   * 7 unattributed inbound plus 2 staff-direct outbound — clicking the 7 opened
   * a list of 9, and it broke on precisely the row the feature exists to show.
   *
   * `unattributed` is how a caller-less row selects itself. It cannot use
   * selectedCallerId: that is min(1) on purpose, because 0 is a sentinel and
   * not a user id, and relaxing it would let a 0 through on every other tab.
   */
  if (selection.noJob) where += NO_JOB;
  if (selection.direction === 'IN' || selection.direction === 'OUT') {
    where += ` AND ${DIRECTION} = ?`;
    params.push(selection.direction);
  }
  if (selection.unattributed) where += ` AND ${CALLER_ID_EXPR} IS NULL`;
  // Which STACK wrote the row — the By Provider tab's third dimension. Read off
  // a frozen allow-list, so nothing user-supplied reaches the SQL.
  if (STACK_CLAUSE[selection.stack]) where += STACK_CLAUSE[selection.stack];
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
            /*
             * Direction-aware, like every other caller surface: on an INBOUND
             * row caller_id is the id of whoever rang US, from a different id
             * space, and CALLER_NAME would resolve it against tbl_user /
             * tbl_easyfixer and print a colleague's name beside a call they had
             * nothing to do with. The row still shows WHO rang in — that is
             * receiverName, derived from the number, which is the one
             * identification on an inbound row we can actually stand behind.
             */
            ${CALLER_ID_EXPR}   AS callerUserId,
            CASE WHEN ${DIRECTION} = 'IN' THEN NULL ELSE ${CALLER_NAME} END AS callerName,
            CASE WHEN ${DIRECTION} = 'IN' THEN 'inbound' ELSE ${CALLER_KIND} END AS callerKind,
            ${DIRECTION}        AS direction,
            ${PARTY_NAME}       AS receiverName,
            ${PARTY_ROLE}       AS partyRole,
            jci.job_status      AS jobStatusAtCall,
            ${ASSIGNED_AT_CALL} AS assignedFlag,
            jci.duration        AS durationSecs,
            /*
             * The vendor, through the SAME rule the provider FILTER uses (see
             * PROVIDER_RULE): the never-NULL label the cell prints, whether the
             * column actually named that vendor, and the raw stored string with
             * NULL / empty / whitespace normalised to NULL. The raw column is
             * deliberately no longer projected under the name provider: an
             * unstamped row IS a Kaleyra row, and printing nothing for it is
             * what the filter had already decided was wrong.
             */
            ${PROVIDER_RULE.label}     AS providerLabel,
            ${PROVIDER_RULE.namedFlag} AS providerNamedFlag,
            ${PROVIDER_RULE.value}     AS providerRaw,
            jci.caller_status   AS callerStatus,
            /*
             * Whether the ▶ button should be OFFERED — i.e. whether
             * GET /admin/calls/:id/recording can actually answer. The key itself
             * is never returned: playback goes through that authorised endpoint,
             * which is where the permission check lives.
             *
             * ⚠ THIS IS NOT "the recording column is non-empty", which is what it
             * used to be, and the difference was visible to operators as a play
             * button that answered "No recording available for this call". The
             * endpoint needs an https URL, one of OUR S3 keys, or a Plivo call it
             * can lazily pull by uuid — a Kaleyra row whose recording column
             * holds anything else 404s. It was wrong in the other direction too:
             * a Plivo row with an empty column but a live unique_id says "No"
             * while the endpoint would have pulled the file happily.
             *
             * The one case SQL cannot settle is an S3 key whose object has since
             * gone; the endpoint falls through to a 404 there, and the button
             * turns itself into "No" when that happens (see ListenButton).
             *
             * Deliberately does NOT probe tbl_plivo_call_log.recording_url. That
             * column is behind a migration the endpoint guards with try/catch,
             * and a hard reference here would 500 the whole drill-down on a
             * pre-migration deploy. Nothing is lost: a row with a pushed URL is a
             * Plivo call, so it already has a unique_id and matches the arm below.
             */
            CASE
              WHEN jci.recording LIKE 'http%' THEN 1
              WHEN jci.recording LIKE 'CallRecordings/%' THEN 1
              WHEN ${PROVIDER_IS_PLIVO} AND NULLIF(TRIM(jci.unique_id), '') IS NOT NULL THEN 1
              ELSE 0
            END AS recordingFlag
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
      /*
       * NULL when there is no job, not 0. jci.job_id carries a literal 0 for a
       * call placed with no job context, and passing it through rendered a red
       * "#0" that looked like a job link to a job that does not exist. Same
       * sentinel-as-data mistake drillableUserId exists to prevent.
       */
      jobId: drillableJobId(r.jobId),
      callAt: r.callAt || null,
      callerUserId: r.callerUserId == null ? null : n(r.callerUserId),
      /*
       * 'Incoming call' when there is no caller of OURS — an inbound row. The
       * previous fallback printed "User #0" there, inventing a user id for a
       * call nobody here placed.
       */
      callerName: r.callerName
        || (r.callerUserId == null ? 'Incoming call' : `User #${n(r.callerUserId)}`),
      // 'IN' | 'OUT' — the property that decides whether callerUserId means
      // anything at all, carried so a consumer never has to infer it.
      direction: r.direction === 'IN' ? 'IN' : 'OUT',
      /*
       * WHICH table answered — 'user' | 'technician' | 'unresolved'. The id
       * alone cannot say: caller_id holds a tbl_user id on rows this backend
       * writes and an efr_id on rows the legacy CRM writes. A consumer that
       * renders the raw id has to know which, or it asserts a CRM user that
       * does not exist. See CALLER_NAME above.
       */
      callerKind: r.callerKind || 'unresolved',
      // NAME only — never the number (see the privacy note in the header).
      receiverName: (r.receiverName && String(r.receiverName).trim()) || null,
      partyRole: r.partyRole || 'Other',
      /*
       * ⚠ A CALL WITH NO JOB HAS NO LIFECYCLE STATUS, and this is the guard
       * that says so.
       *
       * jci.job_status is a SNAPSHOT column, but only on rows that snapshot
       * something. On a job-less call it holds the column default. Measured on
       * QA over 2025: of 28,848 job-less calls, 28,203 carry job_status = 0,
       * 642 carry 100, and 3 are NULL. Nothing wrote those — they are what an
       * INSERT that never mentioned the column leaves behind.
       *
       * Passed through, 0 became a REAL-LOOKING CHIP. Worse than a wrong number:
       * jci.job_efr_id is also a leftover on these rows, so ASSIGNED_AT_CALL
       * read 1, and the 0-with-a-tech branch renders "Pending App Ack" — a
       * status the legacy flow no longer produces at all. Thousands of Direct
       * and Inbound rows displayed a retired lifecycle stage, derived from two
       * columns that were never written, beside a job number of #0. And 100
       * printed as the literal "Status 100".
       *
       * assignedAtCall is nulled with it for exactly the same reason: it
       * describes the JOB's technician, and there is no job.
       */
      jobStatusAtCall: drillableJobId(r.jobId) == null || r.jobStatusAtCall == null
        ? null
        : n(r.jobStatusAtCall),
      assignedAtCall: drillableJobId(r.jobId) != null && Number(r.assignedFlag) === 1,
      durationSecs: r.durationSecs == null ? null : Number(r.durationSecs),
      connected: n(r.durationSecs) > 0,
      /*
       * NEVER NULL — the existing Provider cell renders {provider || '—'} and
       * an em-dash beside a Kaleyra-only filter result is the reported bug. The
       * `||` is a belt-and-braces fallback: PROVIDER_RULE.label has no NULL arm,
       * so this can only fire if the column disappears from the projection, and
       * defaulting to the inferred vendor is the same answer the filter gives.
       */
      provider: r.providerLabel || PROVIDER_LABELS.kaleyra,
      /*
       * ADDITIVE, and true for the overwhelming majority of rows: the column did
       * not name a vendor, we DEDUCED one from "only two vendors have ever
       * existed". A consumer can mark it '(assumed)'; the current FE ignores it.
       */
      providerAssumed: Number(r.providerNamedFlag) !== 1,
      /*
       * What was actually stored, or null when nothing was — including the 2021
       * telecom-CARRIER values, which belong in a tooltip and never in the
       * Provider cell itself ('JIO' is not a voice vendor).
       */
      providerRaw: (r.providerRaw && String(r.providerRaw).trim()) || null,
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
 * XLSX payload — FOUR sheets mirroring the on-screen grains (By Job, the daily
 * By User table, its combined per-user sub-view, and Other Calls), so the
 * download carries everything the report can show. The route walks `sheets` and
 * hands each to buildStyledWorkbook with a shared workbook.
 *
 * The nested arrays are flattened into readable single cells ('Priya (3), Amit
 * (1)') — a spreadsheet cell cannot hold a list, and an operator reading the
 * export should not have to go back to the CRM to see who called.
 *
 * ⚠ THE CONFERENCE TOTALS ARE NOT COLUMNS HERE, and that is a decision, not an
 * omission. `sheets` is per-ROW material at three grains, and partiesReached /
 * conferenceCalls / conferenceBilledSecs / conferenceBilledCalls are
 * WINDOW-level figures with no per-row version (see the header on why per-row
 * versions were not built). Repeating a window total on every row is how an
 * export starts getting summed by whoever opens it. They ride the KPI band and
 * the meta line of the first sheet instead — the export's existing home for
 * window-level numbers — which the route assembles from `totals`.
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
      /*
       * The calls with NO job attached — the population the other three sheets
       * cannot show at all (By Job restricts to real job ids; the two By User
       * sheets are the same rows regrouped). Without it the workbook's KPI band
       * counts calls that appear on none of its rows, which is the on-screen
       * complaint this tab exists to answer, exported.
       *
       * Direction is a COLUMN here and part of the GRAIN in the service — it is
       * what separates a staff direct call from a legacy inbound one, and the
       * two are most of this sheet.
       *
       * No 'At Job Step' column: there is no job, so no snapshot status.
       */
      {
        name: 'Other Calls',
        columns: [
          { key: 'day', header: 'Date', width: 14 },
          { key: 'direction', header: 'Direction', width: 12 },
          { key: 'userName', header: 'User', width: 26 },
          ...SHARED_COLS,
          { key: 'partiesLabel', header: 'Called To', width: 30 },
          { key: 'firstCallAt', header: 'First Call', width: 20 },
          { key: 'lastCallAt', header: 'Last Call', width: 20 },
        ],
        rows: (data.byOther || []).map((r) => ({
          ...r,
          avgDurationSecs: r.avgDurationSecs == null ? 0 : r.avgDurationSecs,
          partiesLabel: flatten(r.parties, (x) => x.role),
        })),
      },
      {
        /*
         * By Provider — vendor x stack x direction. At most eight rows, and the
         * absences are the point: Plivo x Old CRM cannot exist (the legacy Java
         * stacks dial Kaleyra and their provider field is @Transient), and every
         * inbound row is legacy for the same reason.
         */
        name: 'By Provider',
        columns: [
          { key: 'provider', header: 'Provider', width: 14 },
          { key: 'stack', header: 'Placed From', width: 14 },
          { key: 'direction', header: 'Direction', width: 11 },
          ...SHARED_COLS,
          { key: 'uniqueJobs', header: 'Jobs', width: 10 },
          { key: 'uniqueCallers', header: 'Callers', width: 10 },
          { key: 'firstCallAt', header: 'First Call', width: 20 },
          { key: 'lastCallAt', header: 'Last Call', width: 20 },
        ],
        rows: (data.byProvider || []).map((r) => ({
          ...r,
          avgDurationSecs: r.avgDurationSecs == null ? 0 : r.avgDurationSecs,
        })),
      },
    ],
  };
}

module.exports = {
  getCallTracking,
  getCallTrackingCharts,
  getCallDetails,
  toXlsx,
  // Exposed so the route's Joi enums stay in lockstep with the derivation above.
  PARTY_ROLES,
  PROVIDERS,
  // The By Provider tab's stack dimension — the route's Joi enum reads this.
  STACKS,
  // The Graphical View's tab scopes — the route's Joi enum reads this so a new
  // tab cannot be accepted by validation before the SQL scope for it exists.
  CHART_GRAINS,
  /*
   * Test seam — the pure averaging helper and the SQL fragment that produces its
   * denominator, plus the voice-vendor rule and the clauses derived from it, so
   * a test can prove the FILTER and the LABEL still agree without a DB.
   */
  _test: { perDay, ACTIVE_DAYS, DAY_EXPR, PROVIDER_RULE, PROVIDER_CLAUSE, PROVIDER_LABELS },
};
