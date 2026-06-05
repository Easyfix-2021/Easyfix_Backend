const { pool } = require('../db');
// Job-OTP generator — shared with the auth flow so we're not
// duplicating the cryptographically-safe 4-digit primitive. See
// utils/otp.js::generateOtp() for the implementation. Used at
// order-confirmation time (see create() + setStatus() below).
const { generateOtp } = require('../utils/otp');

/*
 * Job CRUD + status + assignment.
 *
 * Schema notes (tbl_job, 141 cols, ~384k rows as of 2026-04-17):
 *   - fk_easyfixter_id  ← legacy typo. Do NOT "fix" to easyfixer — 5 services depend on the spelling.
 *   - Efr_dis_travelled ← capital E, preserved.
 *   - source_type (varchar) is the human-readable source ("manual", "excel",
 *     "dashboard", "decathlon API"); `source` (tinyint) is legacy.
 *
 * Writes: create + assign + certain status transitions are multi-row and
 * wrapped in a transaction. Simple column updates (update, most status
 * changes) use the pool directly.
 */

// ─── Status glossary (blueprint §3) ─────────────────────────────────
/*
 * Canonical job_status codes (truth from legacy DB, documented 2026-04-20):
 *
 *   0  BOOKED          — default on create. Sub-states:
 *                         • fk_easyfixter_id IS NULL  → "Pending for Scheduling"
 *                         • fk_easyfixter_id NOT NULL → "Pending App Acknowledge"
 *   1  SCHEDULED       — accepted by tech on app, pending check-in
 *   2  IN_PROGRESS     — technician checked in on app
 *   3  COMPLETED       — closed (QA path)
 *   5  COMPLETED_ALT   — closed (legacy alternative completion)
 *   6  CANCELLED       — cancelled by ops
 *   7  ENQUIRY         — information request only (legacy; keep)
 *   9  UNCONFIRMED     — job booked from website / API / dashboard / bulk
 *                        upload, customer not yet confirmed
 *  10  CLOSED_FROM_APP — closed from tech app / estimate approved or rejected
 *  15  ESTIMATE_PENDING_APPROVAL — estimate sent, awaiting customer decision
 *  20  IN_PROGRESS_ALT — second IN_PROGRESS state used by some app paths
 *  21  ON_HOLD         — fulfilment on hold
 *
 * Kept existing NAMES (BOOKED / SCHEDULED / CALL_LATER / REVISIT) as aliases
 * so the 20+ files referencing STATUS.CALL_LATER / STATUS.REVISIT keep
 * compiling without a churn-wide rename. The new CANONICAL names live as
 * separate properties — prefer them in new code.
 */
const STATUS = {
  BOOKED: 0, SCHEDULED: 1, IN_PROGRESS: 2,
  COMPLETED: 3, COMPLETED_ALT: 5, CANCELLED: 6,
  ENQUIRY: 7, CALL_LATER: 9, REVISIT: 10,
  // Canonical additions (DB-truth per 2026-04-20):
  UNCONFIRMED: 9,                 // alias for CALL_LATER
  CLOSED_FROM_APP: 10,            // alias for REVISIT
  ESTIMATE_PENDING_APPROVAL: 15,
  IN_PROGRESS_ALT: 20,
  ON_HOLD: 21,
};
const ALL_STATUS_VALUES = new Set(Object.values(STATUS));
// Composite buckets for multi-status queries and UI tabs.
const CHECKED_IN_STATES = new Set([STATUS.IN_PROGRESS, STATUS.IN_PROGRESS_ALT]);
const CLOSED_STATES = new Set([STATUS.COMPLETED, STATUS.COMPLETED_ALT]);

// Terminal states — `setStatus` to these sets stamp timestamps
const COMPLETED_STATES = new Set([STATUS.COMPLETED, STATUS.COMPLETED_ALT]);

// ─── Projections ────────────────────────────────────────────────────
// Note: extra columns (ticket_created_date_time, time_slot, client_spoc*,
// remarks) are included on the LIST projection because the Unconfirmed
// tab on /jobs and /my-orders surfaces them in dedicated columns. All
// fields live on tbl_job — no extra JOINs needed. Kept on the default
// LIST to avoid having to split the projection per tab.
const LIST_COLUMNS = `
  j.job_id, j.job_reference_id, j.client_ref_id,
  j.job_status, j.job_type, j.source_type,
  LEFT(j.job_desc, 200) AS job_desc,
  j.created_date_time, j.requested_date_time, j.scheduled_date_time,
  j.checkin_date_time, j.checkout_date_time,
  j.ticket_created_date_time, j.time_slot,
  /*
   * last_update_time exposed on LIST (added 2026-05-28) so the FE can
   * derive a "Draft" indicator for Unconfirmed (status=9) rows whose
   * last_update_time is meaningfully later than created_date_time —
   * a sign that an operator clicked Save Draft on the Confirm modal.
   * No new column needed; just SELECTing an existing tbl_job column.
   */
  j.last_update_time,
  j.client_spoc, j.client_spoc_name,
  LEFT(j.remarks, 500) AS remarks,
  j.fk_customer_id, cu.customer_name, cu.customer_mob_no,
  j.fk_client_id, cl.client_name,
  j.fk_easyfixter_id, ef.efr_name AS easyfixer_name,
  j.job_owner, ow.user_name AS owner_name,
  j.fk_address_id, ci.city_name,
  /*
   * service_count — count of ACTIVE rows on tbl_job_services for this
   * job. Powers the FE "Booked but no services" pill (added
   * 2026-05-28), mirrors the existing Draft-pill pattern on
   * UnconfirmedJobsTable. Counts only job_service_status = 1 so a
   * job whose only services were soft-deleted is still flagged.
   *
   * Performance: correlated subquery on the indexed job_id column.
   * For a 384k-row tbl_job with typical per-job service rows (1-5),
   * adds ~2-3ms over the base list query — verified at QA. If this
   * ever becomes hot enough to dominate cost, swap to a LATERAL JOIN
   * or join-on-derived-table.
   */
  (SELECT COUNT(*) FROM tbl_job_services js
    WHERE js.job_id = j.job_id AND js.job_service_status = 1) AS service_count,
  /*
   * Customer Magic-Link Completion (added 2026-05-28) — drives the
   * three FE pills on the Unconfirmed Jobs list (Customer Submitted /
   * Link Sent / none) plus the Trigger / Retrigger action button.
   *
   *   customer_submitted_at      — non-null once the customer hits the
   *                                magic-link landing page and submits.
   *   magic_link_sent_at         — last time we dispatched the link.
   *   magic_link_send_count      — number of dispatches so far; the FE
   *                                uses this to label the button as
   *                                Trigger (0) vs Retrigger (>=1).
   *   magic_link_last_action     — short string (e.g. sent, viewed,
   *                                submitted) for tooltip / audit only.
   *
   * client_opted_in is derived via EXISTS on tbl_client_custom_properties
   * with c_prop_name = auto_process_unconfirmed_order and a truthy
   * (lowercase true) c_prop_values. Returned as 0/1 so the FE can gate
   * the action button without a second round-trip. Correlated subquery
   * on the indexed client_id column — cost is negligible.
   *
   * Schema note (2026-05-30): the live table uses the legacy c_prop_*
   * column names — c_prop_name, c_prop_values (plural), c_prop_mandatory,
   * plus status for soft-delete (1=active, 0=deleted). Earlier drafts of
   * this file referenced property_name/property_value which don't exist
   * on the schema — fixed in-place. (Note: no backticks in this comment
   * because the surrounding LIST_COLUMNS is itself a JS template literal,
   * so backticks would close the literal early and break parsing.)
   */
  j.customer_submitted_at,
  j.magic_link_sent_at,
  j.magic_link_send_count,
  j.magic_link_last_action,
  /*
   * magic_link_max_send_count — per-client configurable cap on how many
   * magic-link sends are allowed before the Trigger button locks for
   * non-Admin operators. Read from tbl_client_custom_properties under
   * c_prop_name='max_magic_link_send_count' (same shape pattern as the
   * auto_process_unconfirmed_order toggle). Defaults to 3 when the
   * client hasn't set a custom value.
   *
   * CAST UNSIGNED guards against ops storing the value as '3 ' or
   * 'three' — NULL bubbles to the COALESCE, keeping the default safe.
   */
  COALESCE(
    (SELECT CAST(NULLIF(ccp_max.c_prop_values, '') AS UNSIGNED)
       FROM tbl_client_custom_properties ccp_max
      WHERE ccp_max.client_id    = j.fk_client_id
        /*
         * Case-insensitive + underscore-tolerant comparison so the same
         * row matches whether c_prop_name was stored as legacy snake_case
         * ('max_magic_link_send_count'), lower-case-with-spaces
         * ('max magic-link send count'), or the new Title Case canonical
         * form ('Max Magic-Link Send Count'). Lets the FE rename rows
         * without coordinating a BE deploy.
         */
        AND LOWER(REPLACE(ccp_max.c_prop_name, '_', ' ')) = LOWER('Max Magic-Link Send Count')
        AND ccp_max.status       = 1
      LIMIT 1),
    3
  ) AS magic_link_max_send_count,
  (EXISTS (
     SELECT 1 FROM tbl_client_custom_properties ccp
      WHERE ccp.client_id = j.fk_client_id
        AND LOWER(REPLACE(ccp.c_prop_name, '_', ' ')) = LOWER('Auto Process Unconfirmed Order')
        AND LOWER(ccp.c_prop_values) = 'true'
        AND ccp.status = 1
   )) AS client_opted_in
`;

/*
 * Join map — the LIST data query pulls these for display columns. For COUNT
 * queries we include only the joins that the actual WHERE clause references,
 * which on a 384k-row table is the difference between a 6-way join full-scan
 * (~6s) and a single-table count over an indexed column (~50ms).
 */
const LIST_JOIN = `
  FROM tbl_job j
  LEFT JOIN tbl_customer    cu ON cu.customer_id = j.fk_customer_id
  LEFT JOIN tbl_address     ad ON ad.address_id  = j.fk_address_id
  LEFT JOIN tbl_city        ci ON ci.city_id     = ad.city_id
  LEFT JOIN tbl_client      cl ON cl.client_id   = j.fk_client_id
  LEFT JOIN tbl_easyfixer   ef ON ef.efr_id      = j.fk_easyfixter_id
  LEFT JOIN tbl_user        ow ON ow.user_id     = j.job_owner
`;

/*
 * `tbl_client.vertical_id` is referenced by the verticals-scope filter
 * below. Some DB instances don't have this column — the canonical
 * client↔vertical mapping there lives in `tbl_vertical_mapping`
 * instead. We probe at startup, cache the answer, and silently skip
 * the vertical filter when the column is absent rather than 500ing
 * the entire jobs list.
 *
 * If your DB uses tbl_vertical_mapping, vertical filtering for the
 * jobs list is unavailable until that JOIN is wired (separate
 * follow-up). Admin-group users bypass scope entirely so this
 * affects only operators with verticals = 'allow' in their RBAC
 * scope.
 */
/*
 * Column-probe for `tbl_job.otp` (verified legacy column — see
 * EasyFix_CRM JobDaoImpl.java:4418 `update tbl_job set otp =?`). The
 * Node BE generates a 4-digit OTP at order-confirmation time
 * (create() with BOOKED status, or setStatus() transitioning TO
 * BOOKED) so the technician can verify on check-in. Legacy generated
 * the OTP at check-in (saveCheckInJob), but ops moved the contract
 * forward to confirmation so the customer can be told the code
 * earlier in the cycle — see the 2026-05-28 ask.
 *
 * Column is present on every deploy verified so far, but we probe
 * (and cache) so a partially-migrated DB doesn't break booking.
 */
let _hasOtpColumn = null;
async function hasOtpColumn() {
  if (_hasOtpColumn !== null) return _hasOtpColumn;
  try {
    const [rows] = await pool.query("SHOW COLUMNS FROM tbl_job LIKE 'otp'");
    _hasOtpColumn = rows.length > 0;
  } catch {
    _hasOtpColumn = false;
  }
  return _hasOtpColumn;
}

/*
 * Probe for tbl_job_services.created_by / fk_created_by. Older deploys may
 * not have either column; we conditionally stamp the actor's user_id when
 * the column exists so audit fields are populated without breaking inserts
 * on un-migrated DBs. Returns the resolved column name or null.
 * Memoised once per process. Mirrors the hasOtpColumn pattern above.
 */
let _jobServicesCreatedByCol = undefined; // undefined=unprobed, null=absent
async function jobServicesCreatedByColumn() {
  if (_jobServicesCreatedByCol !== undefined) return _jobServicesCreatedByCol;
  try {
    const [rows] = await pool.query(
      "SHOW COLUMNS FROM tbl_job_services WHERE Field IN ('created_by', 'fk_created_by')"
    );
    if (rows.length === 0) { _jobServicesCreatedByCol = null; return null; }
    // Prefer fk_created_by when both exist (matches tbl_job convention).
    const names = rows.map((r) => r.Field);
    _jobServicesCreatedByCol = names.includes('fk_created_by') ? 'fk_created_by'
                              : names.includes('created_by')   ? 'created_by'
                              : null;
  } catch {
    _jobServicesCreatedByCol = null;
  }
  return _jobServicesCreatedByCol;
}

/*
 * IST timezone helpers (2026-06-04).
 *
 * Platform convention (CLAUDE.md "Coding rules" §7):
 *   "Dates stored as MySQL DATETIME, displayed IST on frontend."
 *
 * That means tbl_job.requested_date_time / original_appointment_date_time
 * must land as a NATIVE MySQL DATETIME literal — `'YYYY-MM-DD HH:MM:SS'`
 * — and the wall-clock time MUST be IST. Otherwise mysql2 default-binds a
 * JS Date as an ISO 8601 UTC string with a Z suffix
 * (e.g. `'2026-06-15T15:00:00.000Z'`) which (a) MySQL stores as the UTC
 * wall-clock not IST, and (b) breaks downstream legacy reports that parse
 * the column as the IST literal.
 *
 * IST is a fixed +05:30 offset (no DST), so we shift the parsed UTC
 * instant by +330 minutes and then read the resulting Date's UTC getters
 * (which now represent IST clock time). Bypasses JS Date's local-tz
 * sensitivity entirely — same output regardless of whether the server
 * runs in UTC, IST, or any other TZ.
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
function _toIstDate(d) {
  const date = (d instanceof Date) ? d : new Date(d);
  if (Number.isNaN(+date)) return null;
  return new Date(date.getTime() + IST_OFFSET_MS);
}
function _pad(n) { return String(n).padStart(2, '0'); }

/*
 * formatMysqlDateTimeIST(d) → 'YYYY-MM-DD HH:MM:SS' (IST clock time)
 * Returns null on falsy / unparseable input.
 */
function formatMysqlDateTimeIST(d) {
  if (!d) return null;
  const ist = _toIstDate(d);
  if (!ist) return null;
  return (
    ist.getUTCFullYear() + '-' +
    _pad(ist.getUTCMonth() + 1) + '-' +
    _pad(ist.getUTCDate()) + ' ' +
    _pad(ist.getUTCHours()) + ':' +
    _pad(ist.getUTCMinutes()) + ':' +
    _pad(ist.getUTCSeconds())
  );
}

/*
 * formatTimeIST(d) → 'HH:MM' (IST clock time)
 * Used for the legacy `requested_time` / `original_appointment_time`
 * columns which store the time portion separately from the DATETIME.
 */
function formatTimeIST(d) {
  if (!d) return null;
  const ist = _toIstDate(d);
  if (!ist) return null;
  return _pad(ist.getUTCHours()) + ':' + _pad(ist.getUTCMinutes());
}

/*
 * combineDateTime(dt, timeStr) → 'YYYY-MM-DD HH:MM:SS' (IST)
 *
 * Returns the IST-formatted MySQL DATETIME literal for `dt`.
 *
 * Bonus behaviour: if the parsed instant is UTC midnight (the common
 * "FE sent a date-only ISO" sentinel — e.g. `'2026-06-15T00:00:00.000Z'`
 * with the actual time-of-day shipped separately in `timeStr`), splice
 * the timeStr in as IST clock time. We pull the date portion from the
 * IST-shifted projection of `dt` and concatenate with the explicit
 * timeStr — bypasses any JS Date `setHours` (which is local-tz-dependent
 * and produces inconsistent results across server timezones).
 *
 * Used by create() to repair Book-New-Call payloads where
 * `requested_date_time` arrived without a real time portion and the
 * time was sent separately in `requested_time`.
 */
function combineDateTime(dt, timeStr) {
  if (!dt) return null;
  const d = (dt instanceof Date) ? dt : new Date(dt);
  if (Number.isNaN(+d)) return null;

  const isUtcMidnight =
    d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
  if (isUtcMidnight && timeStr && /^\d{1,2}:\d{2}/.test(timeStr)) {
    const ist = _toIstDate(d);
    const [hh, mm, ss = '0'] = String(timeStr).split(':');
    return (
      ist.getUTCFullYear() + '-' +
      _pad(ist.getUTCMonth() + 1) + '-' +
      _pad(ist.getUTCDate()) + ' ' +
      _pad(Number(hh) || 0) + ':' +
      _pad(Number(mm) || 0) + ':' +
      _pad(Number(ss) || 0)
    );
  }
  return formatMysqlDateTimeIST(d);
}

let _hasClientVerticalIdColumn = null;
async function hasClientVerticalIdColumn() {
  if (_hasClientVerticalIdColumn !== null) return _hasClientVerticalIdColumn;
  try {
    const [rows] = await pool.query("SHOW COLUMNS FROM tbl_client LIKE 'vertical_id'");
    _hasClientVerticalIdColumn = rows.length > 0;
  } catch (e) {
    // SHOW COLUMNS itself failed — be conservative and treat as missing.
    // eslint-disable-next-line no-console
    console.warn('[job.service] could not probe tbl_client.vertical_id:', e?.message);
    _hasClientVerticalIdColumn = false;
  }
  if (!_hasClientVerticalIdColumn) {
    // eslint-disable-next-line no-console
    console.warn('[job.service] tbl_client.vertical_id not present — verticals scope filter will be skipped on jobs list/count queries. Client→vertical mapping may live in tbl_vertical_mapping; wire that JOIN if vertical-based RBAC matters.');
  }
  return _hasClientVerticalIdColumn;
}

/*
 * Probe ONCE per process for the presence of `tbl_job_customer_request`.
 * That table only exists on deploys where migration
 * `2026-06-02-job-customer-requests.sql` has run. The LIST projection
 * surfaces the latest PENDING cancel/reschedule request per job via two
 * correlated subqueries; if those reference a non-existent table EVERY
 * unconfirmed-list query 500s. So we probe, memoise, and build the two
 * projection columns conditionally (NULL aliases when the table is absent),
 * making the feature a transparent no-op on un-migrated deploys.
 * Mirrors the hasOtpColumn / hasClientVerticalIdColumn probes above.
 */
let _hasCustomerRequestTable = null;
async function customerRequestTableExists() {
  if (_hasCustomerRequestTable !== null) return _hasCustomerRequestTable;
  try {
    await pool.query('SELECT 1 FROM tbl_job_customer_request LIMIT 1');
    _hasCustomerRequestTable = true;
  } catch {
    _hasCustomerRequestTable = false;
  }
  return _hasCustomerRequestTable;
}

// Same memoised existence probe for tbl_job_media — new EasyFix-owned table
// (videos shared via the conversational WhatsApp flow, see
// migrations/2026-06-03-whatsapp-conversation.sql). On deploys without that
// migration applied, getById() returns videos:[] silently so the CRM Confirm
// view doesn't 500.
let _hasJobMediaTable = null;
async function jobMediaTableExists() {
  if (_hasJobMediaTable !== null) return _hasJobMediaTable;
  try {
    await pool.query('SELECT 1 FROM tbl_job_media LIMIT 1');
    _hasJobMediaTable = true;
  } catch {
    _hasJobMediaTable = false;
  }
  return _hasJobMediaTable;
}

/*
 * Builds the two pending-customer-request projection columns for the LIST
 * query. When the table exists, emits correlated subqueries selecting the
 * latest PENDING request's type + reason; otherwise emits NULL aliases so
 * the column shape stays identical. Parameterised SQL — the literal
 * 'pending' is the only constant and it is bound as a parameter list the
 * caller appends, but since it's a fixed string we inline it safely (no
 * user input). Returns a leading-comma fragment ready to append after
 * client_opted_in.
 */
function pendingRequestColumns(tableExists) {
  if (!tableExists) {
    return `,
  NULL AS pending_request_type,
  NULL AS pending_request_reason`;
  }
  return `,
  (SELECT cr.request_type FROM tbl_job_customer_request cr
    WHERE cr.job_id = j.job_id AND cr.request_status = 'pending'
    ORDER BY cr.created_at DESC LIMIT 1) AS pending_request_type,
  (SELECT cr.reason FROM tbl_job_customer_request cr
    WHERE cr.job_id = j.job_id AND cr.request_status = 'pending'
    ORDER BY cr.created_at DESC LIMIT 1) AS pending_request_reason`;
}

// Kept for getById(), which does select these as part of the full detail payload.
const DETAIL_JOIN = LIST_JOIN + `
  LEFT JOIN tbl_user        cr ON cr.user_id     = j.fk_created_by
`;

// ─── List ───────────────────────────────────────────────────────────
// `scope` (optional) is the parsed RBAC scope from /auth/me:
//   { clients:{mode,ids}, cities:{mode,ids}, verticals:{mode,ids} }
// When supplied, the list is row-filtered to the caller's allowed
// clients + cities + verticals. mode='all' means no filter for that
// dimension; mode='none' returns zero rows; mode='allow' adds an
// IN(...) clause. See lib/scope.js. Admin/Finance bypass scope —
// the caller decides whether to pass it.
/*
 * `dateType` controls which column `startDate` / `endDate` are applied
 * to. Matches the legacy CRM's Date Type filter:
 *   booked    → j.created_date_time (default, backward-compat)
 *   scheduled → j.scheduled_date_time
 *   completed → j.checkout_date_time
 *   ticket    → j.ticket_created_date_time
 *   requested → j.requested_date_time
 * Unknown values silently fall back to `created_date_time` rather
 * than 400 — keeps URL bookmarks robust across vocab changes.
 */
const DATE_TYPE_COLUMN = {
  booked:    'j.created_date_time',
  scheduled: 'j.scheduled_date_time',
  completed: 'j.checkout_date_time',
  ticket:    'j.ticket_created_date_time',
  requested: 'j.requested_date_time',
};

async function list({
  q, status, statuses, assigned, clientId, cityId, ownerId, easyfixerId,
  customerId,
  isEscalated,
  // New filter params (2026-05-19) — match the legacy CRM "Filter Job"
  // panel. See the validator + the FE filter card.
  customerQ,                 // text — separate from `q`, narrower scope
  clientRef,                 // text — LIKE on j.client_ref_id
  efrMobile,                 // text — LIKE on tbl_easyfixer.efr_no
  pin,                       // text — LIKE on tbl_address.pin_code
  stateId,                   // FK   — tbl_city.state_id
  categoryId,                // FK   — j.fk_service_catg_id
  verticalId,                // FK   — via EXISTS on tbl_vertical_mapping
  dateType,                  // enum — see DATE_TYPE_COLUMN above
  // Phase-2 filters (2026-05-19).
  rating,                    // 1..5 — tbl_easyfixer_rating_by_customer.customer_rating
  reopen,                    // bool — tbl_job.job_reopen_flag = 1
  dueTo,                     // enum — customer|client|easyfix|technician
  zonalId,                   // FK   — tbl_zone_master via tbl_zone_city_mapping
  // Dashboard AttentionSummary tile drill-downs (2026-05-22):
  quotationStatus,           // enum — 'approved' | 'rejected'
  requestedBefore,           // 'now' or ISO date — Running Late tile
  /*
   * `noServices` (2026-05-28) — Booked-No-Services tile drill-down.
   * When truthy, restricts the list to BOOKED rows that have zero
   * ACTIVE tbl_job_services entries. Mirrors the predicate used by
   * the attention-summary count + the LIST projection's service_count
   * subquery, so counts and rows agree by construction.
   */
  noServices,
  startDate, endDate,
  scope,
  limit = 50, offset = 0,
} = {}) {
  const clauses = [];
  const params = [];

  // Probe ONCE per process for tbl_client.vertical_id presence.
  // See declaration above for the rationale.
  const hasVerticalCol = await hasClientVerticalIdColumn();

  // Probe ONCE per process for tbl_job_customer_request presence, then build
  // the LIST projection with the pending-request columns appended (NULL
  // aliases when the table is absent). Keeps the unconfirmed list from 500ing
  // on un-migrated deploys. See pendingRequestColumns() above.
  const hasCustomerRequestTable = await customerRequestTableExists();
  const listColumns = LIST_COLUMNS + pendingRequestColumns(hasCustomerRequestTable);

  // Apply RBAC scope FIRST so any explicit clientId/cityId filter
  // narrows within the allowed set (caller can't widen scope by passing
  // a clientId outside their manage_clients).
  if (scope) {
    const c = scope.clients, ci = scope.cities, v = scope.verticals;
    if (c) {
      if (c.mode === 'none') { clauses.push('1=0'); }
      else if (c.mode === 'allow' && c.ids.length) {
        clauses.push(`j.fk_client_id IN (${c.ids.map(() => '?').join(',')})`);
        params.push(...c.ids);
      }
    }
    if (ci) {
      if (ci.mode === 'none') { clauses.push('1=0'); }
      else if (ci.mode === 'allow' && ci.ids.length) {
        clauses.push(`ad.city_id IN (${ci.ids.map(() => '?').join(',')})`);
        params.push(...ci.ids);
      }
    }
    if (v) {
      if (v.mode === 'none') { clauses.push('1=0'); }
      else if (v.mode === 'allow' && v.ids.length && hasVerticalCol) {
        // Vertical lives on tbl_client; LIST_JOIN already pulls
        // tbl_client cl, so cl.vertical_id is reachable. Only
        // applied when the column exists in this DB (see
        // hasClientVerticalIdColumn).
        clauses.push(`cl.vertical_id IN (${v.ids.map(() => '?').join(',')})`);
        params.push(...v.ids);
      }
    }
  }

  // `statuses` (array/CSV) takes priority over single `status` — supports UI
  // tabs that bucket multiple codes (e.g. "Pending to Close" = 2 OR 20,
  // "Audit & Complete" = 3 OR 5). Single `status` still works for backward
  // compat with existing callers.
  if (statuses != null) {
    const arr = Array.isArray(statuses)
      ? statuses
      : String(statuses).split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
    if (arr.length) {
      clauses.push(`j.job_status IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    }
  } else if (status != null) {
    clauses.push('j.job_status = ?');
    params.push(status);
  }
  /*
   * `assigned` splits BOOKED (and any other status) by whether a technician
   * is currently on the job. Used by the dashboard's Pending-for-Scheduling
   * (assigned=false) vs Pending-App-Acknowledge (assigned=true) cards.
   * Accepts boolean true/false or string "true"/"false" from query params.
   */
  if (assigned !== undefined && assigned !== null && assigned !== '') {
    const wantAssigned = assigned === true || assigned === 'true' || assigned === 1 || assigned === '1';
    clauses.push(wantAssigned ? 'j.fk_easyfixter_id IS NOT NULL' : 'j.fk_easyfixter_id IS NULL');
  }
  /*
   * Booked-No-Services filter (2026-05-28). Forces both job_status = 0
   * (so callers don't need to set status separately) AND an anti-join
   * against tbl_job_services. The implicit status pin matches the
   * attention-summary counter's predicate exactly — a deep-link from
   * the tile must produce the same set the tile counted, not a superset.
   */
  if (noServices === true || noServices === 'true' || noServices === 1 || noServices === '1') {
    clauses.push('j.job_status = 0');
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM tbl_job_services js
       WHERE js.job_id = j.job_id AND js.job_service_status = 1
    )`);
  }
  if (clientId != null)    { clauses.push('j.fk_client_id = ?');     params.push(clientId); }
  if (easyfixerId != null) { clauses.push('j.fk_easyfixter_id = ?'); params.push(easyfixerId); }
  if (ownerId != null)     { clauses.push('j.job_owner = ?');        params.push(ownerId); }
  if (cityId != null)      { clauses.push('ad.city_id = ?');         params.push(cityId); }
  if (customerId != null)  { clauses.push('j.fk_customer_id = ?');   params.push(customerId); }
  if (categoryId != null)  { clauses.push('j.fk_service_catg_id = ?'); params.push(categoryId); }
  if (stateId != null)     { clauses.push('ci.state_id = ?');        params.push(stateId); }
  // Vertical filter — tbl_vertical_mapping is many-to-many across
  // (client_id, vertical_id, [user_id]). EXISTS is cheaper than a
  // JOIN because it short-circuits on first match per row and avoids
  // row multiplication when a client maps to multiple verticals.
  if (verticalId != null) {
    clauses.push('EXISTS (SELECT 1 FROM tbl_vertical_mapping vm WHERE vm.client_id = j.fk_client_id AND vm.vertical_id = ?)');
    params.push(verticalId);
  }
  // Text LIKE filters — use the customary `%val%` wrap. Each adds its
  // referenced alias to the COUNT-join detection regex below via the
  // `ad.` / `ef.` / `cu.` literal in the SQL string.
  if (clientRef) {
    clauses.push('j.client_ref_id LIKE ?');
    params.push(`%${clientRef}%`);
  }
  if (efrMobile) {
    clauses.push('ef.efr_no LIKE ?');
    params.push(`%${efrMobile}%`);
  }
  if (pin) {
    clauses.push('ad.pin_code LIKE ?');
    params.push(`%${pin}%`);
  }
  if (customerQ) {
    clauses.push('(cu.customer_name LIKE ? OR cu.customer_mob_no LIKE ?)');
    params.push(`%${customerQ}%`, `%${customerQ}%`);
  }
  // Reopen — direct column on tbl_job, super cheap. Accepts boolean or
  // its URLSearchParams string form (matches `assigned`/`isEscalated`).
  if (reopen !== undefined && reopen !== '' && reopen !== null) {
    const wantReopen = reopen === true || reopen === 'true' || reopen === '1' || reopen === 1;
    clauses.push(wantReopen ? 'j.job_reopen_flag = 1' : '(j.job_reopen_flag = 0 OR j.job_reopen_flag IS NULL)');
  }
  // Rating — EXISTS keeps row cardinality stable (a job can have
  // multiple rating rows over its lifetime; we want jobs that ever
  // received the given rating, not duplicated rows). Restricts to
  // tbl_easyfixer_rating_by_customer.customer_rating exact match.
  if (rating != null) {
    clauses.push('EXISTS (SELECT 1 FROM tbl_easyfixer_rating_by_customer ercf WHERE ercf.job_id = j.job_id AND ercf.customer_rating = ?)');
    params.push(Number(rating));
  }
  // Zonal — the zone lives on the EASYFIXER, not on the address.
  // `tbl_easyfixer.efr_zone_city_id` FKs to
  // `tbl_zone_city_mapping.city_zone_id` (the PK of the mapping row,
  // confusingly named), and that row's `zone_id` is the actual zone.
  //
  // Why the address mapping is wrong: `tbl_zone_city_mapping` carries
  // 57,750 rows where every city is mapped to every zone (legacy data
  // bug — the earlier version of this filter used `city_id = ad.city_id`
  // and every zone returned all 453,656 jobs because the mapping is
  // effectively a cross-join). The real zone-of-record is the
  // technician's `efr_zone_city_id` — verified 2026-05-19: 3,004
  // easyfixers carry 1,016 distinct values.
  //
  // Trade-off: jobs WITHOUT an assigned technician (Pending for
  // Scheduling) won't match any zone filter — which is correct because
  // those jobs have no zone of record yet.
  if (zonalId != null) {
    clauses.push('EXISTS (SELECT 1 FROM tbl_zone_city_mapping zcm WHERE zcm.city_zone_id = ef.efr_zone_city_id AND zcm.zone_id = ?)');
    params.push(Number(zonalId));
  }
  /*
   * quotationStatus — drives the AttentionSummary tile drill-down.
   *   'approved' → EXISTS approved line item (status=1 + action_on set)
   *                AND job is still actionable (not executing/closed/cancelled)
   *   'rejected' → EXISTS rejected line item (status=0 + action_on set)
   *                AND job is not closed/cancelled
   * EXISTS keeps row cardinality stable when a job has multiple quotation
   * line items.
   */
  if (quotationStatus === 'approved') {
    clauses.push(
      'EXISTS (SELECT 1 FROM quotation_details qd WHERE qd.job_id = j.job_id AND qd.status = 1 AND qd.action_on IS NOT NULL)',
    );
    clauses.push('j.job_status NOT IN (2, 3, 5, 6)');
  } else if (quotationStatus === 'rejected') {
    clauses.push(
      'EXISTS (SELECT 1 FROM quotation_details qd WHERE qd.job_id = j.job_id AND qd.status = 0 AND qd.action_on IS NOT NULL)',
    );
    clauses.push('j.job_status NOT IN (3, 5, 6)');
  }
  // requestedBefore — Running Late tile filter.
  if (requestedBefore === 'now') {
    clauses.push('j.requested_date_time IS NOT NULL AND j.requested_date_time < NOW()');
  } else if (requestedBefore) {
    clauses.push('j.requested_date_time IS NOT NULL AND j.requested_date_time < ?');
    params.push(requestedBefore);
  }
  // Open Due To — accepts both shapes of remark:
  //   (a) Structured tag from the AddRemarks dialog:
  //       "[Unreachable · Pending Due To: Client · Reason: …] free text"
  //   (b) Loose legacy free-text: "… due to client said no …"
  // MySQL default collation is case-insensitive, so the LIKE comparison
  // matches "Due to Client" / "DUE TO CLIENT" / "due to client" alike.
  // The loose-match arm risks false positives ("due to customer issue"
  // for dueTo=customer) — acceptable given the legacy data has no
  // structured tag yet; tightening to brackets-only would zero-out the
  // filter entirely until the AddRemarks-dialog data lands.
  if (dueTo) {
    const lower = String(dueTo).toLowerCase();
    const label = lower === 'easyfix' ? 'EasyFix'
      : lower.charAt(0).toUpperCase() + lower.slice(1);
    clauses.push('(j.remarks LIKE ? OR j.remarks LIKE ?)');
    //   1st: structured tag exact ("Due To: Client")
    //   2nd: loose free-text ("due to client")
    params.push(`%Due To: ${label}%`, `%due to ${lower}%`);
  }
  // `isEscalated` migration note: I initially wired this to
  // `j.is_escalated`, but that column DOES NOT exist on `tbl_job`. The
  // legacy CRM had it commented out across JobDaoImpl.java; the real
  // escalation flag lives on `tbl_easyfixer_rating_by_customer.is_escalated`
  // joined by `job_id`. Implementing the proper join here would touch
  // the LIST projection too (we'd need to LEFT JOIN ratings just for
  // the filter) and the legacy CRM itself didn't actively use the
  // count — `escalatedJobs = jobService.getEscalatedJobsbyUser(...)`
  // was commented out in HomeAction.java.
  //
  // For now: accept the param to keep the URL contract stable but
  // emit no SQL clause. Returns the full unfiltered list, which is
  // worse than the legacy 0-row count behaviour but at least doesn't
  // 500. Wire the proper rating-table join in a focused follow-up.
  if (isEscalated !== undefined && isEscalated !== '') {
    // intentional no-op — see comment above
  }
  // `dateType` selects which date column the start/end range applies
  // to. Defaults to `created_date_time` for backward-compat with
  // callers that don't pass dateType.
  const dateCol = DATE_TYPE_COLUMN[String(dateType || '').toLowerCase()] || 'j.created_date_time';
  if (startDate)           { clauses.push(`${dateCol} >= ?`); params.push(startDate); }
  if (endDate)             { clauses.push(`${dateCol} <= ?`); params.push(endDate); }
  if (q) {
    clauses.push('(j.job_reference_id LIKE ? OR j.client_ref_id LIKE ? OR cu.customer_name LIKE ? OR cu.customer_mob_no LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  // Build a minimal join set for COUNT based on which aliases are referenced
  // in the WHERE clause. If the filter only hits tbl_job columns (the common
  // case: status tabs, no extra filter), we can count over tbl_job alone —
  // a single-table indexed scan vs. a full 6-way join.
  const needsCu = /\bcu\./.test(where);
  const needsAd = /\bad\./.test(where);
  const needsCl = /\bcl\./.test(where);
  const needsCi = /\bci\./.test(where);
  const needsEf = /\bef\./.test(where);
  const needsOw = /\bow\./.test(where);
  const countJoin = `
    FROM tbl_job j
    ${needsCu ? 'LEFT JOIN tbl_customer cu ON cu.customer_id = j.fk_customer_id' : ''}
    ${needsAd || needsCi ? 'LEFT JOIN tbl_address  ad ON ad.address_id  = j.fk_address_id' : ''}
    ${needsCi ? 'LEFT JOIN tbl_city     ci ON ci.city_id     = ad.city_id' : ''}
    ${needsCl ? 'LEFT JOIN tbl_client   cl ON cl.client_id   = j.fk_client_id' : ''}
    ${needsEf ? 'LEFT JOIN tbl_easyfixer ef ON ef.efr_id     = j.fk_easyfixter_id' : ''}
    ${needsOw ? 'LEFT JOIN tbl_user     ow ON ow.user_id     = j.job_owner' : ''}
  `;

  // Run COUNT and data query in parallel — they're independent, no reason to
  // serialize. Roughly halves wall-clock time on cold caches.
  const dataParams = [...params, Number(limit), Number(offset)];
  const [[[{ total }]], [rows]] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS total ${countJoin} ${where}`, params),
    pool.query(
      `SELECT ${listColumns} ${LIST_JOIN} ${where}
       ORDER BY j.job_id DESC LIMIT ? OFFSET ?`,
      dataParams
    ),
  ]);
  return { rows, total };
}

// ─── Detail ─────────────────────────────────────────────────────────
/*
 * Fetches job detail + services + images in parallel. Each query is independent;
 * running them serially wastes ~2× the wall-clock time for zero benefit. The
 * main detail query is still the expensive one (7-way join); the other two are
 * cheap child lookups on indexed job_id.
 *
 * Returns null if the job row doesn't exist (preserved from prior behaviour).
 * Services + images default to [] if the main row is missing — no point paying
 * for those lookups when we're about to 404.
 */
async function getById(jobId) {
  // Gate `cl.vertical_id` in the SELECT projection on column presence.
  // When the column isn't on this DB's tbl_client, fall back to a NULL
  // alias so the projection stays stable for downstream consumers
  // (image redirect endpoint reads `j.vertical_id` for scope assert).
  // Without this gate, getById() throws "Unknown column" and EVERY
  // job-detail-dependent flow (view modal, image redirect, etc.)
  // 500s for this DB.
  const hasVerticalCol = await hasClientVerticalIdColumn();
  const verticalSelect = hasVerticalCol ? 'cl.vertical_id' : 'NULL AS vertical_id';

  const [jobRows, services, images] = await Promise.all([
    pool.query(
      `SELECT j.*,
              cu.customer_name, cu.customer_mob_no, cu.customer_email,
              ad.address, ad.building, ad.landmark, ad.locality, ad.pin_code,
              ad.gps_location, ad.city_id, ci.city_name,
              cl.client_name, cl.client_email, ${verticalSelect},
              ef.efr_name AS easyfixer_name, ef.efr_no AS easyfixer_mobile,
              ow.user_name AS owner_name,
              cr.user_name AS created_by_name
       ${DETAIL_JOIN}
       WHERE j.job_id = ? LIMIT 1`,
      [jobId]
    ),
    pool.query(
      // Return ALL service rows including soft-deleted (status=0). The FE
      // hides them by default but exposes a "Show Inactive" toggle that
      // lets the operator restore a row they removed by mistake. Filtering
      // them out here would deny the restore path. (Updated 2026-05-26.)
      `SELECT js.job_service_id, js.service_id, js.quantity, js.total_charge,
              js.job_service_status, js.service_category_id, js.service_type_id,
              st.service_type_name, sc.service_catg_name,
              CR.crc_ratecard_name AS service_name
         FROM tbl_job_services js
         LEFT JOIN tbl_service_type st ON st.service_type_id = js.service_type_id
         LEFT JOIN tbl_service_catg sc ON sc.service_catg_id = js.service_category_id
         LEFT JOIN tbl_client_service   CS ON CS.client_service_id = js.service_id
         LEFT JOIN tbl_client_rate_card CR ON CR.crc_id = CS.rate_card_id
        WHERE js.job_id = ?
        ORDER BY js.job_service_id ASC`,
      [jobId]
    ),
    pool.query(
      `SELECT image_id, image, image_category, job_stage, created_date
         FROM tbl_job_image
        WHERE job_id = ?
        ORDER BY image_id ASC`,
      [jobId]
    ),
  ]);
  const job = jobRows[0][0];
  if (!job) return null;

  // Customer-shared videos (via the WhatsApp conversational order-confirmation
  // flow) live in tbl_job_media — a separate EasyFix-owned table because
  // tbl_job_image is image-only by convention. Probe-gated so a deploy without
  // the 2026-06-03 migration applied returns videos:[] silently. Same shape
  // the FE can render with a play icon next to the photos grid.
  let videos = [];
  if (await jobMediaTableExists()) {
    const [vRows] = await pool.query(
      `SELECT media_id, s3_key, content_type, source, created_at
         FROM tbl_job_media
        WHERE job_id = ?
        ORDER BY media_id ASC`,
      [jobId],
    );
    videos = vRows;
  }
  return { ...job, services: services[0], images: images[0], videos };
}

/*
 * Lightweight existence + status check. Used by setStatus / assign before they
 * mutate — skipping the 7-way join saves ~150-300ms per status change and
 * avoids loading services+images we don't use in those paths.
 */
/* `otp` is included here (added 2026-05-28) so setStatus() can decide
 * whether to mint a new OTP on the BOOKED transition without a second
 * round-trip. A NULL/empty existing value triggers generation; an
 * already-set value is preserved (idempotent re-confirm doesn't
 * change the code the customer was already told). */
async function getJobMeta(jobId) {
  // `otp` selection is wrapped in a probe-driven concat so older deploys
  // that lack the column don't break the meta read. The downstream
  // setStatus() only reads meta.otp when the probe says the column
  // exists, but explicitly emitting NULL keeps the shape stable.
  const otpCol = (await hasOtpColumn()) ? 'otp' : 'NULL AS otp';
  const [[row]] = await pool.query(
    `SELECT job_id, job_status, fk_easyfixter_id, fk_customer_id, fk_client_id, ${otpCol} FROM tbl_job WHERE job_id = ? LIMIT 1`,
    [jobId]
  );
  return row || null;
}

/*
 * Returns a single object with all status bucket totals + grand total, in ONE
 * DB round-trip. The dashboard used to make 6 separate /admin/jobs requests to
 * compute these — each of which ran a COUNT + data query in parallel server
 * side — causing ~12 concurrent pool connections for stats alone.
 *
 * Shape:
 *   { total, byStatus: { "0": 525, "1": 357, "2": 67, "3": 5702, "6": 65094, ... } }
 *
 * The grand total comes from the same query via a WITH ROLLUP or a small client
 * side sum — we use client-side sum because MySQL 5.7's WITH ROLLUP syntax is
 * fussy and the row count is always tiny (≤ 10 status codes).
 */
async function getStatusCounts({ ownerId, easyfixerId, scope } = {}) {
  /*
   * Two queries run in parallel:
   *   1. GROUP BY job_status — the raw count per code.
   *   2. BOOKED split by fk_easyfixter_id IS NULL — gives the dashboard the
   *      two derived buckets (Pending for Scheduling vs Pending App Ack) in
   *      one round-trip instead of a follow-up COUNT.
   *
   * `ownerId` scopes both queries to `job_owner = ?` (My Orders flow).
   * `scope`   row-filters by the caller's manage_clients × manage_cities
   *           × manage_verticals — drives the Dashboard cards so a PM only
   *           sees counts within their assigned scope (including downstream
   *           hierarchy when scope was built with buildRequestScopeWithHierarchy).
   * When scope is needed we LEFT JOIN tbl_address (for city) + tbl_client
   * (for vertical) — same join shape as LIST_JOIN.
   */
  const clauses = [];
  const params = [];

  // Probe tbl_client.vertical_id presence — same as list(). See the
  // declaration up top for the full rationale.
  const hasVerticalCol = await hasClientVerticalIdColumn();

  if (ownerId) { clauses.push('j.job_owner = ?'); params.push(ownerId); }
  // `easyfixerId` — scope counts to a single technician. Enables the
  // Mobile App's dashboard to reuse this exact counts engine (instead
  // of duplicating the SUM-CASE pattern in a tier-specific service).
  // Per the no-route-duplication / single-source-of-truth rule: one
  // status-counts implementation serves CRM dashboard, Mobile dashboard,
  // and any future surface that needs status tallies.
  if (easyfixerId != null) {
    clauses.push('j.fk_easyfixter_id = ?');
    params.push(easyfixerId);
  }
  if (scope) {
    const c = scope.clients, ci = scope.cities, st = scope.states, v = scope.verticals;
    if (
      (c  && c.mode  === 'none') ||
      (ci && ci.mode === 'none') ||
      (st && st.mode === 'none') ||
      (v  && v.mode  === 'none')
    ) {
      clauses.push('1=0');
    }
    if (c && c.mode === 'allow' && c.ids.length) {
      clauses.push(`j.fk_client_id IN (${c.ids.map(() => '?').join(',')})`);
      params.push(...c.ids);
    }
    if (ci && ci.mode === 'allow' && ci.ids.length) {
      clauses.push(`ad.city_id IN (${ci.ids.map(() => '?').join(',')})`);
      params.push(...ci.ids);
    }
    // States filter (2026-06-03) — previously dropped silently, which
    // meant operators with state-scoped permissions saw every job in
    // every state. Joins tbl_city via the address's city_id to read
    // its state_id. Only fires when scope.states is set + 'allow';
    // 'all' means the operator can see all states + no filter needed.
    if (st && st.mode === 'allow' && st.ids.length) {
      clauses.push(`ct.state_id IN (${st.ids.map(() => '?').join(',')})`);
      params.push(...st.ids);
    }
    if (v && v.mode === 'allow' && v.ids.length && hasVerticalCol) {
      clauses.push(`cl.vertical_id IN (${v.ids.map(() => '?').join(',')})`);
      params.push(...v.ids);
    }
  }

  // Only JOIN tables we actually filter against — cheap on the indexed FKs.
  // tbl_address is needed whenever cities OR states is restricted (states
  // joins through city → tbl_city). tbl_city is needed only for states.
  // tbl_client is needed only for verticals.
  const needsAd = scope?.cities?.mode === 'allow' || scope?.states?.mode === 'allow';
  const needsCt = scope?.states?.mode === 'allow';
  const needsCl = scope?.verticals?.mode === 'allow' && hasVerticalCol;
  const joins = [
    needsAd ? 'LEFT JOIN tbl_address ad ON ad.address_id = j.fk_address_id' : '',
    needsCt ? 'LEFT JOIN tbl_city    ct ON ct.city_id    = ad.city_id'      : '',
    needsCl ? 'LEFT JOIN tbl_client  cl ON cl.client_id  = j.fk_client_id'  : '',
  ].filter(Boolean).join(' ');

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const bookedWhere = clauses.length
    ? `WHERE j.job_status = ${STATUS.BOOKED} AND ${clauses.join(' AND ')}`
    : `WHERE j.job_status = ${STATUS.BOOKED}`;

  // Escalated count is intentionally NOT queried here. The legacy CRM
  // sourced this from `tbl_easyfixer_rating_by_customer.is_escalated`
  // joined by job_id — NOT from a `tbl_job.is_escalated` column (which
  // doesn't exist). The legacy header itself commented out the
  // getEscalatedJobsbyUser() call, so the badge was already a no-op
  // upstream. Returning `escalated: 0` keeps the navbar contract stable
  // (it conditionally hides the badge when count is 0) without forcing
  // an extra JOIN to a table that may not be reliably populated.
  // Wire the rating-table join in a focused follow-up when the
  // escalation workflow is actually re-activated.

  const [statusRows, bookedSplitRows] = await Promise.all([
    pool.query(`SELECT j.job_status, COUNT(*) AS c FROM tbl_job j ${joins} ${where} GROUP BY j.job_status`, params),
    pool.query(
      `SELECT j.fk_easyfixter_id IS NULL AS unassigned, COUNT(*) AS c
         FROM tbl_job j ${joins} ${bookedWhere}
        GROUP BY unassigned`,
      params
    ),
  ]);
  const byStatus = {};
  let total = 0;
  for (const r of statusRows[0]) {
    byStatus[String(r.job_status)] = Number(r.c);
    total += Number(r.c);
  }
  let bookedUnassigned = 0;
  let bookedAssigned = 0;
  for (const r of bookedSplitRows[0]) {
    // mysql2 returns the BIT(1) from `IS NULL` as 0/1 int here (no typeCast
    // needed since it's a computed boolean, not a BIT column).
    if (Number(r.unassigned) === 1) bookedUnassigned = Number(r.c);
    else bookedAssigned = Number(r.c);
  }
  // See comment above — escalated badge is stubbed to 0 until the
  // rating-table join lands.
  return { total, byStatus, bookedUnassigned, bookedAssigned, escalated: 0 };
}

/*
 * Attention summary — drives the dashboard's "Orders Needing Immediate
 * Attention" card (replaces the old Recent Jobs widget).
 *
 * Returns 5 operator-action counts in a single round-trip. Each sub-
 * query is run in parallel; a failure of one is logged + the metric
 * returns 0 so a single missing column or table doesn't break the card.
 *
 *   runningLate         booked/scheduled jobs past requested_date_time
 *   estimateApproved    quotations approved by SPOC, job not yet in
 *                       execution/done — ops should align a tx
 *   estimateRejected    quotations rejected by SPOC — ops follow-up
 *   pendingTechAccept   tech assigned but app-ack still pending
 *                       (proxy = bookedAssigned, status=0 + tech set)
 *   customerUnreachable status=9 CALL_LATER bucket
 *
 * All counts respect req.scope just like getStatusCounts. Bypass roles
 * (Admin/Finance) see the full count; scoped users see only their
 * hierarchy-unioned slice.
 */
async function getAttentionSummary({ scope } = {}) {
  const hasVerticalCol = await hasClientVerticalIdColumn();

  // Build the scope clauses + needed joins ONCE — reused across all
  // five queries so we don't double-scan tbl_address / tbl_client.
  function buildScopeFragment(jobAlias = 'j') {
    const clauses = [];
    const params = [];
    if (scope) {
      const c = scope.clients, ci = scope.cities, st = scope.states, v = scope.verticals;
      if (
        (c  && c.mode  === 'none') ||
        (ci && ci.mode === 'none') ||
        (st && st.mode === 'none') ||
        (v  && v.mode  === 'none')
      ) {
        clauses.push('1=0');
      }
      if (c && c.mode === 'allow' && c.ids.length) {
        clauses.push(`${jobAlias}.fk_client_id IN (${c.ids.map(() => '?').join(',')})`);
        params.push(...c.ids);
      }
      if (ci && ci.mode === 'allow' && ci.ids.length) {
        clauses.push(`ad.city_id IN (${ci.ids.map(() => '?').join(',')})`);
        params.push(...ci.ids);
      }
      // States filter (2026-06-03) — kept in sync with getStatusCounts.
      // Joins tbl_city via the address's city_id to read state_id.
      if (st && st.mode === 'allow' && st.ids.length) {
        clauses.push(`ct.state_id IN (${st.ids.map(() => '?').join(',')})`);
        params.push(...st.ids);
      }
      if (v && v.mode === 'allow' && v.ids.length && hasVerticalCol) {
        clauses.push(`cl.vertical_id IN (${v.ids.map(() => '?').join(',')})`);
        params.push(...v.ids);
      }
    }
    // Same JOIN strategy as getStatusCounts: tbl_address needed
    // whenever cities OR states filter is on; tbl_city only for states;
    // tbl_client only for verticals. Each is LEFT JOIN so missing FKs
    // don't drop the row from the count.
    const needsAd = scope?.cities?.mode === 'allow' || scope?.states?.mode === 'allow';
    const needsCt = scope?.states?.mode === 'allow';
    const needsCl = scope?.verticals?.mode === 'allow' && hasVerticalCol;
    const joins = [
      needsAd ? `LEFT JOIN tbl_address ad ON ad.address_id = ${jobAlias}.fk_address_id` : '',
      needsCt ? `LEFT JOIN tbl_city    ct ON ct.city_id    = ad.city_id`                : '',
      needsCl ? `LEFT JOIN tbl_client  cl ON cl.client_id  = ${jobAlias}.fk_client_id`  : '',
    ].filter(Boolean).join(' ');
    return { clauses, params, joins };
  }

  // Helper: run a count safely. On any error, log + return 0 so the
  // attention card stays usable even if a single sub-query misfires
  // (e.g. a column rename that hasn't been caught by tests yet).
  // Inline require — matches the existing convention in this file (the
  // module top doesn't import the logger; each call-site requires it
  // locally to keep the dependency surface explicit per-feature).
  const logger = require('../logger');
  async function safeCount(label, sql, params) {
    try {
      const [[row]] = await pool.query(sql, params);
      return Number(row?.c) || 0;
    } catch (e) {
      logger.warn({ err: e.message, metric: label }, 'attention-summary sub-query failed; returning 0');
      return 0;
    }
  }

  // 1. Running Late
  const runningLatePromise = (async () => {
    const f = buildScopeFragment('j');
    const where = ['j.requested_date_time IS NOT NULL',
                   'j.requested_date_time < NOW()',
                   'j.job_status IN (0, 1)',
                   ...f.clauses].join(' AND ');
    return safeCount(
      'runningLate',
      `SELECT COUNT(*) AS c FROM tbl_job j ${f.joins} WHERE ${where}`,
      f.params,
    );
  })();

  // 2. Estimate Approved (awaiting Tx)
  //    status=1 + action_on NOT NULL = SPOC-approved (vs default 0 on insert).
  //    job not yet in execution/closed/cancelled → ops should still act.
  const estimateApprovedPromise = (async () => {
    const f = buildScopeFragment('j');
    const where = ['qd.status = 1',
                   'qd.action_on IS NOT NULL',
                   'j.job_status NOT IN (2, 3, 5, 6)',
                   ...f.clauses].join(' AND ');
    return safeCount(
      'estimateApproved',
      `SELECT COUNT(DISTINCT qd.job_id) AS c
         FROM quotation_details qd
         JOIN tbl_job j ON j.job_id = qd.job_id
         ${f.joins}
        WHERE ${where}`,
      f.params,
    );
  })();

  // 3. Estimate Rejected — SPOC rejected (action_on set + status=0).
  //    Filtering out closed/cancelled jobs since those don't need action.
  const estimateRejectedPromise = (async () => {
    const f = buildScopeFragment('j');
    const where = ['qd.status = 0',
                   'qd.action_on IS NOT NULL',
                   'j.job_status NOT IN (3, 5, 6)',
                   ...f.clauses].join(' AND ');
    return safeCount(
      'estimateRejected',
      `SELECT COUNT(DISTINCT qd.job_id) AS c
         FROM quotation_details qd
         JOIN tbl_job j ON j.job_id = qd.job_id
         ${f.joins}
        WHERE ${where}`,
      f.params,
    );
  })();

  // 4. Pending Tech Acceptance — booked (status=0) with tech assigned.
  //    Proxy for "ack pending"; our schema doesn't have a separate
  //    accepted_at flag yet (per dashboard comment).
  const pendingTechAcceptPromise = (async () => {
    const f = buildScopeFragment('j');
    const where = ['j.job_status = 0',
                   'j.fk_easyfixter_id IS NOT NULL',
                   ...f.clauses].join(' AND ');
    return safeCount(
      'pendingTechAccept',
      `SELECT COUNT(*) AS c FROM tbl_job j ${f.joins} WHERE ${where}`,
      f.params,
    );
  })();

  // 5. Customer Unreachable / Call Later — status 9
  const customerUnreachablePromise = (async () => {
    const f = buildScopeFragment('j');
    const where = ['j.job_status = 9', ...f.clauses].join(' AND ');
    return safeCount(
      'customerUnreachable',
      `SELECT COUNT(*) AS c FROM tbl_job j ${f.joins} WHERE ${where}`,
      f.params,
    );
  })();

  /*
   * 6. Booked-No-Services (added 2026-05-28) — counts BOOKED jobs that
   * have ZERO active rows in tbl_job_services. Surfaces the legacy
   * data-quality gap (ref Job #482453) where ops promote an Unconfirmed
   * job to BOOKED before adding any service line items. Same predicate
   * as the FE "No Services" pill so the tile count matches what the
   * operator will see on /jobs.
   *
   * NOT EXISTS subquery is preferred over a LEFT JOIN + IS NULL
   * because tbl_job_services has indexes on job_id; MySQL's optimiser
   * resolves the anti-join cheaply.
   *
   * `job_service_status = 1` mirrors the LIST projection's
   * active-only restriction — soft-deleted rows don't mask the anomaly.
   */
  const bookedNoServicesPromise = (async () => {
    const f = buildScopeFragment('j');
    const where = [
      'j.job_status = 0',
      `NOT EXISTS (
        SELECT 1 FROM tbl_job_services js
         WHERE js.job_id = j.job_id AND js.job_service_status = 1
      )`,
      ...f.clauses,
    ].join(' AND ');
    return safeCount(
      'bookedNoServices',
      `SELECT COUNT(*) AS c FROM tbl_job j ${f.joins} WHERE ${where}`,
      f.params,
    );
  })();

  const [
    runningLate,
    estimateApproved,
    estimateRejected,
    pendingTechAccept,
    customerUnreachable,
    bookedNoServices,
  ] = await Promise.all([
    runningLatePromise,
    estimateApprovedPromise,
    estimateRejectedPromise,
    pendingTechAcceptPromise,
    customerUnreachablePromise,
    bookedNoServicesPromise,
  ]);

  return {
    runningLate,
    estimateApproved,
    estimateRejected,
    pendingTechAccept,
    customerUnreachable,
    bookedNoServices,
  };
}

// ─── Customer + Address helpers (used by create) ───────────────────
async function upsertCustomer(conn, { customer_id, customer_name, customer_mob_no, customer_email }, actor) {
  if (customer_id) {
    const [[found]] = await conn.query(
      'SELECT customer_id FROM tbl_customer WHERE customer_id = ? LIMIT 1',
      [customer_id]
    );
    if (!found) {
      const err = new Error(`customer_id ${customer_id} not found`);
      err.status = 400;
      throw err;
    }
    return customer_id;
  }
  // Lookup by mobile — reuse existing
  const [[existing]] = await conn.query(
    'SELECT customer_id FROM tbl_customer WHERE customer_mob_no = ? LIMIT 1',
    [customer_mob_no]
  );
  if (existing) return existing.customer_id;

  const [ins] = await conn.query(
    `INSERT INTO tbl_customer (customer_name, customer_mob_no, customer_email, is_active, created_by, insert_date, update_date)
     VALUES (?, ?, ?, 1, ?, ?, ?)`,
    [customer_name, customer_mob_no, customer_email || null, actor?.user_id || null, new Date(), new Date()]
  );
  return ins.insertId;
}

/*
 * composeRemarks — combines the operator's free-text remarks with the
 * two legacy Book-New-Call fields (product_code, building_name) into
 * a single string with named prefixes. Used because those two columns
 * don't exist on the production tbl_job schema (verified 2026-05-14
 * via INFORMATION_SCHEMA — only `branch_details` exists; the other
 * two return zero rows). `branch_details` has been promoted to a
 * dedicated INSERT column.
 *
 * Format:
 *   <user remarks>
 *   [Product Code] <product_code>
 *   [Building / Property] <building_name>
 */
function composeRemarks(input) {
  const parts = [];
  if (input.remarks) parts.push(String(input.remarks));
  if (input.product_code)   parts.push(`[Product Code] ${input.product_code}`);
  if (input.building_name)  parts.push(`[Building / Property] ${input.building_name}`);
  return parts.length ? parts.join('\n') : null;
}

/*
 * Rebuild tbl_job.client_services CSV from current ACTIVE tbl_job_services
 * rows. Called from every job-services mutator (create + update + magic-link
 * acceptSubmission) so the flat legacy column stays in sync with the
 * normalized table — legacy CRM reads + reports rely on it. Querying the
 * DB rather than computing from the input payload keeps the helper robust
 * against partial updates and soft-deleted rows.
 */
async function recomputeClientServicesCsv(conn, jobId) {
  if (!jobId) return;
  const [rows] = await conn.query(
    `SELECT service_id FROM tbl_job_services
      WHERE job_id = ? AND job_service_status = 1
      ORDER BY job_service_id ASC`,
    [jobId],
  );
  const ids = rows.map((r) => Number(r.service_id))
    .filter((n) => Number.isFinite(n) && n > 0);
  const csv = ids.length > 0 ? ids.join(',') : null;
  await conn.query(
    'UPDATE tbl_job SET client_services = ? WHERE job_id = ?',
    [csv, jobId],
  );
}

async function insertAddress(conn, customerId, addr, actor) {
  // Column-presence probe — production tbl_address may or may not carry
  // the `address_instruction` column depending on deploy. We branch the
  // INSERT shape so older DBs aren't broken by an unknown column.
  let hasInstruction = false;
  try {
    const [cols] = await conn.query(
      `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'tbl_address'
          AND COLUMN_NAME  = 'address_instruction'
        LIMIT 1`,
    );
    hasInstruction = cols.length > 0;
  } catch (_e) { /* defensively assume absent on probe failure */ }

  // is_instruction_added — legacy "does this address carry notes?" flag.
  //
  // 2026-06-03: per ops, this column must stay 0 even when
  // `address_instruction` is non-empty. Previously we kept it in sync
  // with the text content (1 when filled, 0 when blank), but that
  // collided with downstream legacy logic that uses the flag as a
  // gate (rule TBD). Persisting 0 unconditionally is the agreed
  // invariant; the actual text still lives in `address_instruction`
  // and is the canonical source for reads. We retain the `hasInstructionText`
  // local in case future flows need it — but it no longer drives the column.
  const hasInstructionText = addr.address_instruction != null
    && String(addr.address_instruction).trim() !== '';
  // Silence the unused-binding hint for the local — the comment above
  // documents why it's kept around for future readers.
  void hasInstructionText;

  let addressId;
  if (hasInstruction) {
    const [ins] = await conn.query(
      `INSERT INTO tbl_address
         (customer_id, address, building, landmark, locality, city_id, pin_code, gps_location,
          mobile_number, address_instruction, is_instruction_added,
          created_by, insert_date, update_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        customerId,
        addr.address, addr.building || null, addr.landmark || null, addr.locality || null,
        addr.city_id, addr.pin_code, addr.gps_location || null,
        addr.mobile_number || null, addr.address_instruction || null,
        // is_instruction_added pinned to 0 per ops (2026-06-03) —
        // see the docblock above hasInstructionText for the rationale.
        0,
        actor?.user_id || null,
        new Date(), new Date(),
      ]
    );
    addressId = ins.insertId;
  } else {
    // Fallback path (legacy DBs) — address_instruction silently dropped.
    const [ins] = await conn.query(
      `INSERT INTO tbl_address
         (customer_id, address, building, landmark, locality, city_id, pin_code, gps_location,
          mobile_number, created_by, insert_date, update_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        customerId,
        addr.address, addr.building || null, addr.landmark || null, addr.locality || null,
        addr.city_id, addr.pin_code, addr.gps_location || null,
        addr.mobile_number || null, actor?.user_id || null,
        new Date(), new Date(),
      ]
    );
    addressId = ins.insertId;
  }

  // Free-text instruction is persisted directly on tbl_address.address_instruction
  // via the column-probe branch above — no companion-table write needed
  // (2026-06-04 simplification: dropped the `address_instruction` legacy
  // table writes in favour of a single column on tbl_address).
  return addressId;
}

// ─── Create ─────────────────────────────────────────────────────────
async function create(input, actor) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const customerId = await upsertCustomer(conn, input.customer, actor);

    let addressId = input.address?.address_id;
    if (!addressId) {
      addressId = await insertAddress(conn, customerId, input.address, actor);
    }

    // service_type_ids: accept both the canonical name AND the
    // FE-legacy alias `fk_service_type_ids` (JobModal.tsx historically
    // sent that key). Whichever arrives, stringify as CSV for the
    // tbl_job CSV column.
    const rawServiceTypeIds = input.service_type_ids ?? input.fk_service_type_ids;
    const serviceTypeIds = Array.isArray(rawServiceTypeIds)
      ? rawServiceTypeIds.join(',')
      : (rawServiceTypeIds || null);

    // requested_time: legacy column stores the time portion as a
    // separate string. If FE didn't send it explicitly, derive from
    // requested_date_time so the column isn't NULL.
    //
    // IST-aware (2026-06-04). The previous implementation used
    // `new Date(...).toTimeString().slice(0,5)` which returns the
    // server's local-tz clock time — UTC inside our Docker
    // containers, which produced the wrong "HH:MM" (e.g. 15:00 instead
    // of the user-intended 20:30 IST). formatTimeIST() shifts to IST
    // first.
    const requestedTime = input.requested_time
      || (input.requested_date_time ? formatTimeIST(input.requested_date_time) : null);

    // requested_date_time + original_appointment_date_time time-repair
    // (2026-06-04). FE callers (Book-New-Call) sometimes send the date
    // portion as `YYYY-MM-DDT00:00:00.000Z` with the actual appointment
    // time-of-day in a separate `requested_time` field. Without this
    // combining step the DATETIME column lands as midnight which breaks
    // every downstream "running late" / scheduling calculation.
    // combineDateTime() only stitches the time in when the parsed date
    // is exactly local midnight (so an operator who DID send a real
    // time isn't silently overwritten).
    const requestedDateTime = combineDateTime(input.requested_date_time, requestedTime);

    // original_appointment_date_time/time: snapshot at create time so
    // future reschedules can preserve the original promise. Default to
    // the requested values when the operator hasn't overridden. Apply
    // the same time-repair so both columns carry the actual appointment
    // time, not midnight.
    const originalApptDt   = combineDateTime(
      input.original_appointment_date_time || input.requested_date_time || null,
      input.original_appointment_time || requestedTime,
    );
    const originalApptTime = input.original_appointment_time      || requestedTime || null;

    // collected_by: per-job preference. Integer enum (1=Easyfixer,
    // 2=Easyfix, 3=Client) — accept strings/numbers from FE and coerce.
    let collectedBy = null;
    if (input.collected_by != null && input.collected_by !== '') {
      const n = Number(input.collected_by);
      collectedBy = Number.isFinite(n) ? n : String(input.collected_by);
    }

    // Resolve the effective initial status once so the OTP gate below
    // and the eta_status default both branch off the same value.
    const effectiveStatus = [STATUS.ENQUIRY, STATUS.CALL_LATER].includes(Number(input.initial_status))
      ? Number(input.initial_status)
      : STATUS.BOOKED;

    // eta_status: legacy 2-char sentinel. Per JobDaoImpl#2387 "01" is
    // the unconfirmed default; once a job is promoted to BOOKED via
    // eta_status (reverted 2026-06-05 per ops): default to '01'
    // unconditionally across every create path. Book-New-Call,
    // C&S sibling fan-out, and direct-to-ENQUIRY all land as '01'
    // — the legacy default that the rest of the platform expects.
    // If a future flow needs to override (e.g. a "confirmed" sentinel
    // like '02' for a different lifecycle stage), the caller passes
    // input.eta_status explicitly; the BE no longer infers from status.
    const etaStatus = input.eta_status ?? '01';

    /*
     * Job OTP (2026-05-28). Legacy CRM (JobDaoImpl.java:4418) stamps
     * `tbl_job.otp` at check-in time via `saveCheckInJob`. Ops moved the
     * stamping forward to ORDER-CONFIRMATION so the customer can be
     * informed of the code earlier in the cycle. The technician then
     * verifies the code at start-of-job (check-in) as before.
     *
     * Rules:
     *   - Generate only when the job lands in BOOKED (status=0).
     *     Direct-to-ENQUIRY (7) / direct-to-CALL_LATER (9) bookings
     *     skip — those aren't confirmed orders yet.
     *   - 4-digit cryptographically-random (utils/otp.js::generateOtp),
     *     stored as STRING (legacy column is varchar-ish; we match).
     *   - Conditionally included in INSERT when the `otp` column
     *     exists on this deploy (column-probed, cached). Older DBs
     *     without it gracefully degrade — no OTP stored but the
     *     booking still lands.
     */
    const withOtpColumn = await hasOtpColumn();
    const shouldStampOtp = withOtpColumn && effectiveStatus === STATUS.BOOKED;
    const jobOtp = shouldStampOtp ? String(generateOtp()) : null;

    /*
     * job_client_owner auto-resolution (2026-06-04). When the caller
     * doesn't pass an explicit owner, we look up the client's Primary
     * SPOC from tbl_vertical_mapping (user_type=1 = Primary per the
     * legacy CRM convention). Doing this server-side rather than
     * forcing every caller (Book-New-Call, mobile, integration) to
     * fetch + send the same value keeps the rule in one place and
     * survives clients who don't know the SPOC model.
     *
     * status filter tolerates NULL (older mappings predate the column)
     * and 1 (active). Inactive mappings are skipped.
     */
    let resolvedJobClientOwner = input.job_client_owner;
    if ((resolvedJobClientOwner == null || resolvedJobClientOwner === '') && input.fk_client_id) {
      try {
        const [vmRows] = await conn.query(
          `SELECT user_id FROM tbl_vertical_mapping
            WHERE client_id = ? AND user_type = 1
              AND (status IS NULL OR status = 1)
            ORDER BY id ASC LIMIT 1`,
          [input.fk_client_id]
        );
        if (vmRows.length > 0) {
          const uid = Number(vmRows[0].user_id);
          if (Number.isFinite(uid) && uid > 0) resolvedJobClientOwner = uid;
        }
      } catch (e) {
        // Non-fatal — leave null and let the booking proceed.
        require('../logger').warn(
          { clientId: input.fk_client_id, err: e.message },
          'Primary-SPOC lookup failed for job_client_owner (continuing with null)',
        );
      }
    }

    /*
     * job_reference_id resolution (2026-06-04, format confirmed by ops:
     * `REF-{job_id}`).
     *
     * The legacy format embeds the AUTO_INCREMENT job_id, so the value
     * can only be computed AFTER the INSERT completes. The flow:
     *   1. Resolve a PRE-INSERT value here. If caller supplied an
     *      explicit `input.job_reference_id` OR opted into the legacy
     *      reuse-of-client_ref via `input.reuse_client_ref = true`,
     *      bind that value during the original INSERT and skip the
     *      post-INSERT formatter step.
     *   2. Otherwise bind NULL during INSERT, capture `jobId =
     *      ins.insertId`, then UPDATE the row with
     *      `formatJobReferenceId(jobId)` → `REF-{jobId}`. Both writes
     *      live inside the same open transaction so they commit
     *      atomically.
     */
    const { formatJobReferenceId } = require('../utils/job-reference');
    const callerProvidedRef =
      input.job_reference_id
      || (input.reuse_client_ref && input.client_ref_id ? input.client_ref_id : null);
    const jobReferenceId = callerProvidedRef ?? null; // INSERTed as-is; null → auto-fill below

    // Build INSERT shape — `otp` column is appended ONLY when present
    // on the deploy. Two paths to keep the column list + placeholder
    // count + values array perfectly aligned (mismatched lengths here
    // produced silent NULL writes pre-refactor in some legacy ports).
    const sharedCols = `
         job_desc, fk_customer_id, fk_address_id, fk_client_id,
         fk_service_type_id, fk_service_catg_id, service_type_ids,
         reporting_contact_id,
         requested_date_time, requested_time, time_slot, booking_cut_off_time_slot,
         created_date_time, ticket_created_date_time,
         fk_created_by, job_status, job_owner, job_client_owner,
         job_type, source_type, client_ref_id, job_reference_id,
         job_customer_name, client_spoc, client_spoc_name, client_spoc_email,
         additional_name, additional_number,
         collected_by, eta_status,
         original_appointment_date_time, original_appointment_time,
         helper_req, remarks, efr_special_notes, branch_details,
         custom_property,
         last_update_time
    `;
    const sharedValues = [
        input.job_desc || '', // job_desc is NOT NULL in tbl_job; default to empty string
        customerId, addressId, input.fk_client_id,
        input.fk_service_type_id || null, input.fk_service_catg_id || null, serviceTypeIds,
        input.reporting_contact_id || null,
        requestedDateTime, requestedTime, input.time_slot || null, input.booking_cut_off_time_slot || null,
        new Date(), new Date(),
        // fk_created_by (2026-06-04): explicit Number() coercion. JWT
        // claims encode `user_id` as a string (see CLAUDE.md "Auth
        // reality") and tbl_job.fk_created_by is INT. MySQL DOES
        // implicitly coerce numeric strings on INSERT, but if a
        // future JWT issuer accidentally ships a non-numeric subject
        // (or an integration caller passes `actor` from a different
        // identity shape) the implicit coercion silently writes 0 or
        // NULL. Number()-coerce + falsy guard makes the binding
        // explicit and matches the runtime intent.
        (() => { const n = Number(actor?.user_id); return Number.isFinite(n) && n > 0 ? n : null; })(),
        // initial_status — legacy footer-button parity. Defaults to
        // BOOKED (0); operators can pick ENQUIRY (7) or CALL_LATER (9)
        // at the booking modal's footer to route the new row to the
        // appropriate dashboard bucket without an extra status-change
        // call. Validation: only allow the three known codes; anything
        // else falls through to BOOKED so a typo can't accidentally
        // mark a job COMPLETED.
        effectiveStatus,
        input.job_owner || actor?.user_id || null,
        resolvedJobClientOwner ?? null,
        input.job_type || 'Installation', input.source_type || 'manual',
        // job_reference_id (2026-06-03 per ops): the legacy DB column
        // ops queries for the family-reference id. Falls back to
        // `client_ref_id` when the caller didn't send a dedicated
        // `job_reference_id` — the new-CRM FE sends `client_ref_id`
        // for the cross-job family tag, and ops want the same value
        // reflected here so existing reports stay coherent. When the
        // FE sends BOTH explicitly, the explicit `job_reference_id`
        // wins (preserves backwards-compat with any caller that
        // distinguishes them).
        input.client_ref_id || null,
        jobReferenceId,
        // job_customer_name (2026-06-04): prefer the top-level
        // `job_customer_name` when the caller explicitly supplies it,
        // falling back to the nested customer.customer_name.
        //
        // Why both: tbl_job.job_customer_name is a per-job override of
        // tbl_customer.customer_name (see UPDATE-flow comment at the
        // 'job_customer_name' entry in MUTABLE_COLUMNS). Some FE flows
        // pass the per-job name distinct from the customer-master
        // name; routing both through `customer.customer_name` would
        // silently overwrite the master. Accepting both shapes keeps
        // siblings created from Confirm & Schedule (which now sends
        // an explicit top-level job_customer_name) from landing as
        // NULL when the form state happens to clear customer.customer_name.
        input.job_customer_name ?? input.customer?.customer_name ?? null,
        input.client_spoc || null, input.client_spoc_name || null, input.client_spoc_email || null,
        input.additional_name || null, input.additional_number || null,
        collectedBy, etaStatus,
        originalApptDt, originalApptTime,
        input.helper_req ? 1 : 0,
        // remarks: still composed via composeRemarks because
        // product_code + building_name don't exist as columns
        // (only branch_details was verified). They get folded into
        // remarks with named prefixes.
        composeRemarks(input),
        // efr_special_notes: dedicated column for technician-facing
        // notes; optional at booking time, also writable via update.
        input.efr_special_notes || null,
        // branch_details: dedicated column on tbl_job.
        input.branch_details || null,
        // custom_property (2026-06-04): legacy varchar(510) column.
        // The schema carries a DEFAULT of the literal 4-char string
        // 'null' (a relic of legacy Java's `String.valueOf(null)` →
        // "null" stringification path). Omitting the column from the
        // INSERT lets that bad default land, producing the
        // operator-visible "null text instead of NULL" symptom. We
        // bind explicit SQL NULL here so mysql2 overrides the schema
        // default. Accept caller-supplied input.custom_property for
        // forwards-compat with any integration that legitimately uses
        // the field (none do today), still coercing falsy/string
        // "null" to real NULL.
        (input.custom_property && input.custom_property !== 'null')
          ? input.custom_property
          : null,
        new Date(),
    ];
    const insertSql = jobOtp != null
      ? `INSERT INTO tbl_job (${sharedCols.trim()}, otp)
         VALUES (${sharedValues.map(() => '?').join(', ')}, ?)`
      : `INSERT INTO tbl_job (${sharedCols.trim()})
         VALUES (${sharedValues.map(() => '?').join(', ')})`;
    const insertValues = jobOtp != null ? [...sharedValues, jobOtp] : sharedValues;
    const [ins] = await conn.query(insertSql, insertValues);
    const jobId = ins.insertId;

    /*
     * job_reference_id auto-fill (2026-06-04). When the caller didn't
     * supply an explicit ref AND didn't opt into reuse_client_ref, the
     * INSERT above bound NULL for job_reference_id. Now that we have
     * the AUTO_INCREMENT job_id, format the legacy `REF-{job_id}`
     * value and patch the row in the same open transaction. The two
     * statements commit atomically.
     */
    if (callerProvidedRef == null) {
      const autoRef = formatJobReferenceId(jobId);
      if (autoRef) {
        await conn.query(
          'UPDATE tbl_job SET job_reference_id = ? WHERE job_id = ?',
          [autoRef, jobId],
        );
      }
    }

    if (Array.isArray(input.services) && input.services.length > 0) {
      // Batch-load rate-card rows for all picked services in ONE query
      // (avoids N+1) — then compute the 5 charge columns per row via
      // the shared cascade helper. See utils/rate-card-calc.js for the
      // formula (sequential variable→fixed per layer; bundles overhead
      // into easyfix_charge to preserve sum-to-total invariant).
      const { loadRateCardRows, computeJobServiceCharges } = require('../utils/rate-card-calc');
      const rateCardById = await loadRateCardRows(conn, input.services.map((s) => s.service_id));

      /*
       * Stamp audit `created_by` (or legacy `fk_created_by`) on every
       * tbl_job_services row so post-mortems can trace who booked the
       * line item. Probed once per process — older deploys without
       * either column degrade gracefully to the unaugmented column set
       * (no failure, just no audit field).
       */
      const createdByCol = await jobServicesCreatedByColumn();
      const actorId = actor?.user_id || null;

      // Single multi-row INSERT instead of N sequential round-trips. Only wins
      // for jobs with 3+ services but costs nothing for smaller sets.
      const values = input.services.map((svc) => {
        const ch = computeJobServiceCharges(rateCardById.get(Number(svc.service_id)), svc.quantity || 1);
        const row = [
          jobId, svc.service_id, svc.quantity || 1,
          svc.service_type_id || null, svc.service_category_id || null, 1,
          ch.total_charge, ch.total_cost,
          ch.client_charge, ch.easyfix_charge, ch.easyfixer_charge,
        ];
        if (createdByCol) row.push(actorId);
        return row;
      });
      const insertCols = createdByCol
        ? `(job_id, service_id, quantity, service_type_id, service_category_id, job_service_status,
            total_charge, total_cost, client_charge, easyfix_charge, easyfixer_charge, ${createdByCol})`
        : `(job_id, service_id, quantity, service_type_id, service_category_id, job_service_status,
            total_charge, total_cost, client_charge, easyfix_charge, easyfixer_charge)`;
      await conn.query(
        `INSERT INTO tbl_job_services ${insertCols} VALUES ?`,
        [values]
      );
      // Mirror onto tbl_job.client_services CSV — single source of truth
      // via the helper so every services mutator stays in sync.
      await recomputeClientServicesCsv(conn, jobId);
    }

    /*
     * Optional booking-time image (LEGACY path).
     *
     * 2026-05-14 update: the canonical job-image upload moved to the
     * dedicated endpoint `POST /admin/jobs/:id/images` which writes
     * to S3 at Job_Images/<jobId>_<seq>. The frontend uses that
     * endpoint as a SECOND step after this create() commits.
     *
     * This inline branch stays in place ONLY for any caller still
     * sending the legacy `job_image_filename` field (e.g. shell
     * scripts, integration tests). The dedicated endpoint is the
     * supported path going forward; new code should not set this
     * field on the create payload.
     */
    if (input.job_image_filename && String(input.job_image_filename).trim()) {
      await conn.query(
        `INSERT INTO tbl_job_image (job_id, image, image_category, job_stage, created_date)
         VALUES (?, ?, ?, ?, NOW())`,
        [jobId, String(input.job_image_filename).trim(), 'booking', 0]
      );
    }

    await conn.commit();

    /*
     * Flag-based auto-assignment on job creation.
     *
     * Setting: tbl_autoallocation_setting.running_frequency (per-client via
     * tbl_client_setting). Values:
     *   'instant'  → run the 3-layer pipeline now, assign the top candidate
     *   'schedule' (default) → do nothing; a daily batch picks it up instead
     *
     * Fire-and-forget via setImmediate so the create API returns the new
     * job row immediately — auto-assign happens in the background and
     * the subsequent assign() call takes care of status bump + scheduling
     * history + TechAssigned webhook + FCM push to the chosen technician.
     *
     * Errors are logged, not bubbled: a failed auto-assign should never
     * roll back a successfully-created job.
     */
    setImmediate(() => {
      tryAutoAssignOnCreate(jobId, input.fk_client_id, actor).catch((err) => {
        const logger = require('../logger');
        logger.warn(`Auto-assign on create failed for job ${jobId}: ${err.message}`);
      });
    });

    return getById(jobId);
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// ─── Update ─────────────────────────────────────────────────────────
const MUTABLE_COLUMNS = [
  'job_desc', 'job_type', 'source_type',
  'requested_date_time', 'requested_time', 'time_slot', 'expected_date_time',
  'job_owner', 'job_client_owner',
  'fk_client_id', 'fk_service_type_id', 'fk_service_catg_id',
  // service_type_ids (2026-06-05): CSV column carrying every picked
  // service_type_id on a multi-pick job. Kept in sync with the
  // singular fk_service_type_id by FE call sites (Book-New-Call
  // basePayload, C&S sibling POST, C&S parent PATCH). Array input
  // is normalised to a comma-joined string inside the update() loop
  // — mirrors the create()-flow serviceTypeIds normalisation.
  'service_type_ids',
  'reporting_contact_id', 'client_spoc', 'client_spoc_name', 'client_spoc_email',
  'additional_name', 'additional_number',
  'collected_by',
  'original_appointment_date_time', 'original_appointment_time',
  'client_ref_id', 'job_reference_id',
  'helper_req', 'remarks', 'efr_special_notes',
  // job_customer_name — Confirm-mode edits write to this job-row
  // copy of the customer name instead of mutating the master
  // tbl_customer.customer_name. Lets the same mobile carry a
  // different per-job display name (legacy parity + the new bulk-
  // upload flow where the sheet supplies a name distinct from the
  // master record).
  'job_customer_name',
  'exp_tat', 'booking_cut_off_time', 'booking_cut_off_time_slot',
  // branch_details — verified to exist on tbl_job in prod
  // (INFORMATION_SCHEMA returned 1 row 2026-05-14, VARCHAR(255)
  // NULLABLE). Promoted off composeRemarks() to a dedicated column.
  // product_code / building_name DO NOT exist in prod; they're still
  // folded into the `remarks` column with named prefixes (see
  // composeRemarks above).
  'branch_details',
  /*
   * eta_status DELIBERATELY OMITTED — per direction 2026-05-25, the
   * BE writes '01' only on Book Call (the create flow). Update paths
   * must never touch it. Status transitions through the mobile /eta
   * endpoint use STATUS_EXTRAS_ALLOWLIST separately. If you find
   * yourself wanting to add eta_status here, talk to ops first.
   */
];

async function update(jobId, input, actor) {
  const existing = await getById(jobId);
  if (!existing) {
    const err = new Error('job not found'); err.status = 404; throw err;
  }
  const sets = [];
  const values = [];
  // Track which columns are actually being changed so we can decide
  // whether to bump `last_update_time` below. Comment-like fields
  // (remarks, efr_special_notes) are excluded from the bump — they're
  // narrative additions, not structural edits, and downstream consumers
  // like the FE "Draft" indicator on Unconfirmed jobs use the timestamp
  // to detect Save-Draft progress. If a remarks-only edit ticked the
  // timestamp, every Add-Remarks click would falsely mark the row as a
  // draft. Comments have their own audit trail in tbl_job_comment.
  const changedCols = [];
  /*
   * Date/time projection (2026-06-05). create() runs every datetime
   * input through combineDateTime() so the DATETIME columns land as
   * `'YYYY-MM-DD HH:MM:SS'` IST literals (not the JS-Date default of
   * UTC ISO with a `Z` suffix, which legacy MySQL reports parse as
   * the wrong wall-clock). PATCH must apply the same transform —
   * otherwise C&S confirms write the raw ISO into a DATETIME column
   * and the time portion is lost / mis-stored. Same helper set:
   *   - combineDateTime  → MySQL DATETIME string in IST
   *   - formatTimeIST    → "HH:MM" string in IST for the legacy
   *                         requested_time / original_appointment_time
   *                         text columns
   * `requested_time` is derived from `requested_date_time` when the
   * caller doesn't pass it explicitly (mirrors create()).
   */
  const DATETIME_COLS = new Set([
    'requested_date_time', 'expected_date_time', 'original_appointment_date_time',
  ]);
  const TIME_COLS = new Set([
    'requested_time', 'original_appointment_time',
  ]);
  // Derive requested_time from requested_date_time if FE didn't send it
  // alongside (legacy companion column). Only fills if requested_time
  // is undefined in input — never overwrites an explicit value.
  if (input.requested_date_time !== undefined && input.requested_time === undefined) {
    input.requested_time = formatTimeIST(input.requested_date_time);
  }
  for (const col of MUTABLE_COLUMNS) {
    if (input[col] !== undefined) {
      sets.push(`${col} = ?`);
      let v = input[col];
      if (DATETIME_COLS.has(col)) v = combineDateTime(v, null);
      else if (TIME_COLS.has(col)) v = formatTimeIST(v) ?? v;
      /*
       * CSV columns (2026-06-05): tbl_job.service_type_ids stores a
       * comma-separated list. FE callers may send it as either an
       * array OR an already-joined string — coerce to string here
       * so the SET clause binds a scalar VARCHAR. Empty array →
       * NULL (an empty CSV is meaningless). Mirrors the
       * `serviceTypeIds` normalisation inside create().
       */
      else if (col === 'service_type_ids') {
        if (Array.isArray(v)) v = v.length > 0 ? v.join(',') : null;
        else v = (v == null || v === '') ? null : String(v);
      }
      values.push(v);
      changedCols.push(col);
    }
  }

  const hasServicesEdit = Array.isArray(input.services);
  const hasCustomerEdit = input.customer && typeof input.customer === 'object' && Object.keys(input.customer).length > 0;
  const hasAddressEdit  = input.address  && typeof input.address  === 'object' && Object.keys(input.address).length  > 0;

  // Early-exit only when NOTHING is being touched.
  if (sets.length === 0 && !hasServicesEdit && !hasCustomerEdit && !hasAddressEdit) return existing;

  /*
   * Structural-change detector. Bumps last_update_time only when one of
   * the following is true:
   *   - At least one MUTABLE column other than `remarks`/`efr_special_notes`
   *   - Services were edited (add/remove rows)
   *   - Customer was edited
   *   - Address was edited
   * Remarks-only / efr_special_notes-only edits intentionally skip the
   * timestamp bump (rationale above). Service/customer/address edits
   * trigger their own timestamp bumps later in this function but the
   * scalar UPDATE branch needs the gate here.
   */
  const COMMENT_ONLY_COLS = new Set(['remarks', 'efr_special_notes']);
  const isStructuralEdit =
    changedCols.some((c) => !COMMENT_ONLY_COLS.has(c))
    || hasServicesEdit
    || hasCustomerEdit
    || hasAddressEdit;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    if (sets.length > 0) {
      if (isStructuralEdit) {
        sets.push('last_update_time = ?');
        const scalarValues = [...values, new Date(), jobId];
        await conn.query(`UPDATE tbl_job SET ${sets.join(', ')} WHERE job_id = ?`, scalarValues);
      } else {
        // Comment-only path — write the remarks/efr_special_notes without
        // touching last_update_time.
        const scalarValues = [...values, jobId];
        await conn.query(`UPDATE tbl_job SET ${sets.join(', ')} WHERE job_id = ?`, scalarValues);
      }
    }

    /*
     * job_reference_id back-fill on update (2026-06-06).
     *
     * Jobs created by the legacy Client Dashboard / bulk-upload /
     * integration callers landed without a `job_reference_id` (those
     * code paths predate the 2026-06-04 `REF-{job_id}` auto-gen
     * convention). When ops promotes such a row to BOOKED via the
     * Confirm & Schedule modal (the standard "Book Call" path), the
     * caller-supplied PATCH typically doesn't include job_reference_id
     * — so the column stays NULL forever.
     *
     * Fix: AFTER the scalar UPDATE lands, if the row's current
     * job_reference_id is NULL/empty AND the caller didn't supply
     * one in this PATCH, backfill `REF-{jobId}` in the same open
     * transaction. The conditional WHERE clause makes this safe to
     * run on already-populated rows (no-op).
     *
     * Skipped when the caller explicitly passed `job_reference_id`
     * in `input` — preserves backward-compat with integration
     * callers minting their own ref ids.
     */
    if (input.job_reference_id === undefined) {
      const existingRef = String(existing.job_reference_id || '').trim();
      if (!existingRef) {
        const { formatJobReferenceId } = require('../utils/job-reference');
        const autoRef = formatJobReferenceId(jobId);
        if (autoRef) {
          await conn.query(
            `UPDATE tbl_job
                SET job_reference_id = ?
              WHERE job_id = ?
                AND (job_reference_id IS NULL OR TRIM(job_reference_id) = '')`,
            [autoRef, jobId],
          );
        }
      }
    }

    /*
     * Customer update — resolves tbl_customer row from job.fk_customer_id.
     * Only the editable fields (name, email) are accepted; mobile is the
     * key and treated as immutable here (callers must use the dedicated
     * customer swap flow if they truly need a different number).
     */
    if (hasCustomerEdit && existing.fk_customer_id) {
      const custSets = [];
      const custVals = [];
      if (input.customer.customer_name  !== undefined) { custSets.push('customer_name = ?');  custVals.push(input.customer.customer_name); }
      if (input.customer.customer_email !== undefined) { custSets.push('customer_email = ?'); custVals.push(input.customer.customer_email || null); }
      if (custSets.length > 0) {
        custVals.push(existing.fk_customer_id);
        await conn.query(`UPDATE tbl_customer SET ${custSets.join(', ')} WHERE customer_id = ?`, custVals);
      }
    }

    /*
     * Address update — resolves tbl_address row from job.fk_address_id.
     * Full field set (line, building, landmark, city, pin, GPS). For the
     * Unconfirmed → Scheduled flow ops may clean up a bulk-imported address
     * before confirming, so every column is editable here.
     */
    if (hasAddressEdit && existing.fk_address_id) {
      const addrSets = [];
      const addrVals = [];
      if (input.address.address      !== undefined) { addrSets.push('address = ?');      addrVals.push(input.address.address); }
      if (input.address.building     !== undefined) { addrSets.push('building = ?');     addrVals.push(input.address.building || null); }
      if (input.address.landmark     !== undefined) { addrSets.push('landmark = ?');     addrVals.push(input.address.landmark || null); }
      if (input.address.city_id      !== undefined) { addrSets.push('city_id = ?');      addrVals.push(input.address.city_id); }
      if (input.address.pin_code     !== undefined) { addrSets.push('pin_code = ?');     addrVals.push(input.address.pin_code); }
      if (input.address.gps_location !== undefined) { addrSets.push('gps_location = ?'); addrVals.push(input.address.gps_location || null); }
      // address_instruction is column-probed per the matching guard in
      // insertAddress(). We skip the SET if the column doesn't exist on
      // the deploy so the UPDATE doesn't fail with Unknown column. When
      // the column IS present, we also flip is_instruction_added in lock-
      // step so the legacy "has notes?" flag stays in sync with the text
      // (legacy CRM views/reports filter on this flag).
      if (input.address.address_instruction !== undefined) {
        const [cols] = await conn.query(
          `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME   = 'tbl_address'
              AND COLUMN_NAME  = 'address_instruction'
            LIMIT 1`,
        );
        if (cols.length > 0) {
          // 2026-06-03: per ops, `is_instruction_added` must stay 0 even
          // when the text is non-empty (see insertAddress for full
          // rationale). We still WRITE the column on update so a row
          // that was previously flipped to 1 by older code resets to 0
          // — leaving stale 1s in place would defeat the invariant.
          addrSets.push('address_instruction = ?');
          addrVals.push(input.address.address_instruction || null);
          addrSets.push('is_instruction_added = ?');
          addrVals.push(0);
        }
      }
      if (addrSets.length > 0) {
        addrVals.push(existing.fk_address_id);
        await conn.query(`UPDATE tbl_address SET ${addrSets.join(', ')} WHERE address_id = ?`, addrVals);
      }
    }

    /*
     * Services reconciliation — SOFT-DELETE pattern (2026-05-25, per ops):
     *
     *   When services change on an update, we must NOT hard-delete the
     *   removed rows. Instead:
     *
     *     1. Mark every existing tbl_job_services row for this job_id
     *        as status=0 (soft-deleted).
     *     2. For each service in the new payload, look for an existing
     *        row matching (job_id, service_id) — including the just-
     *        soft-deleted ones — and UPDATE status back to 1, refreshing
     *        quantity / service_type_id / service_category_id.
     *     3. Insert any service_id from the payload that has no
     *        existing row.
     *
     *   Effect: removed services persist as status=0 (recoverable for
     *   audit / "re-add" flows); re-added services reactivate the same
     *   row (preserving any rate-card linkage); brand-new services land
     *   as fresh rows. Matches the legacy "re-submit the whole list"
     *   semantics but without losing history.
     */
    if (hasServicesEdit) {
      // 1. Snapshot existing rows so we know which ones to reactivate.
      const [existing] = await conn.query(
        'SELECT job_service_id, service_id FROM tbl_job_services WHERE job_id = ?',
        [jobId],
      );
      const existingByService = new Map();
      for (const r of existing) {
        // If multiple historical rows share the same service_id, keep
        // the highest job_service_id (most recent) — that's the one we
        // reactivate. Older duplicates stay status=0.
        if (!existingByService.has(r.service_id) ||
            r.job_service_id > existingByService.get(r.service_id)) {
          existingByService.set(r.service_id, r.job_service_id);
        }
      }
      // 2. Soft-delete all current rows for the job. Cheaper than a
      //    per-row diff and matches "remove == status=0".
      await conn.query(
        'UPDATE tbl_job_services SET job_service_status = 0 WHERE job_id = ?',
        [jobId],
      );
      // Batch-load rate cards once for the whole edit — same cascade
      // helper as create(). N+1-safe; see utils/rate-card-calc.js docs.
      const { loadRateCardRows, computeJobServiceCharges } = require('../utils/rate-card-calc');
      const rateCardById = await loadRateCardRows(conn, input.services.map((s) => s.service_id));

      // 3. Re-apply each service in the new payload — UPDATE existing
      //    row if it was previously known, else INSERT. Recompute the
      //    5 charge columns from the rate card so quantity changes pick
      //    up the new total_cost / shares.
      for (const svc of input.services) {
        const ch = computeJobServiceCharges(rateCardById.get(Number(svc.service_id)), svc.quantity || 1);
        const existingId = existingByService.get(svc.service_id);
        if (existingId) {
          await conn.query(
            `UPDATE tbl_job_services
                SET job_service_status = 1,
                    quantity = ?,
                    service_type_id = ?,
                    service_category_id = ?,
                    total_charge = ?,
                    total_cost = ?,
                    client_charge = ?,
                    easyfix_charge = ?,
                    easyfixer_charge = ?
              WHERE job_service_id = ?`,
            [
              svc.quantity || 1,
              svc.service_type_id || null,
              svc.service_category_id || null,
              ch.total_charge, ch.total_cost,
              ch.client_charge, ch.easyfix_charge, ch.easyfixer_charge,
              existingId,
            ],
          );
        } else {
          await conn.query(
            `INSERT INTO tbl_job_services
               (job_id, service_id, quantity, service_type_id, service_category_id, job_service_status,
                total_charge, total_cost, client_charge, easyfix_charge, easyfixer_charge)
             VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
            [
              jobId, svc.service_id, svc.quantity || 1,
              svc.service_type_id || null, svc.service_category_id || null,
              ch.total_charge, ch.total_cost,
              ch.client_charge, ch.easyfix_charge, ch.easyfixer_charge,
            ],
          );
        }
      }
      // Mirror onto tbl_job.client_services CSV — same helper as create() +
      // magic-link acceptSubmission so every services mutator stays in sync
      // with the normalized table. Legacy CRM reports read the flat column.
      await recomputeClientServicesCsv(conn, jobId);
    }

    // Touch last_update_time if only non-scalar edits happened (services,
    // customer, address). Downstream consumers (webhooks, audit) see the
    // nested edit as a meaningful change to the job record.
    if (sets.length === 0 && (hasServicesEdit || hasCustomerEdit || hasAddressEdit)) {
      await conn.query('UPDATE tbl_job SET last_update_time = ? WHERE job_id = ?', [new Date(), jobId]);
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return getById(jobId);
}

// ─── Webhook + notification firing (fire-and-forget) ────────────────
// Lazy-require avoids circular dependency.
function fireWebhook(eventName, jobId) {
  try {
    const { dispatch } = require('./webhook.service');
    dispatch({ eventName, jobId }).catch((err) =>
      require('../logger').warn({ eventName, jobId, err: err.message }, 'webhook dispatch error'));
  } catch (err) {
    require('../logger').warn({ eventName, jobId, err: err.message }, 'webhook wiring error');
  }
  // Also fire the notification orchestrator (inbox + SMS/email/WA)
  fireNotification(eventName, jobId);
}

function fireNotification(eventName, jobId) {
  setImmediate(async () => {
    try {
      const job = await getById(jobId);
      if (!job) return;
      const { onJobEvent } = require('./notification-orchestrator.service');
      await onJobEvent(eventName, job);
    } catch (err) {
      require('../logger').warn({ eventName, jobId, err: err.message }, 'notification orchestrator wiring error');
    }
  });
}

function statusToEventName(prevStatus, newStatus) {
  // Map tbl_job.job_status transition → webhook event name.
  if (newStatus === STATUS.IN_PROGRESS)   return 'TechStart';
  if (COMPLETED_STATES.has(newStatus))    return 'TechVisitComplete';
  if (newStatus === STATUS.CANCELLED)     return 'CancelJob';
  if (newStatus === STATUS.REVISIT)       return 'TechVisitInComplete';
  // Unreachable outcome → CustomerNotReachable. Legacy CRM didn't
  // dispatch a webhook for this transition, but the same orchestrator
  // also gates the customer-facing SMS (CUSTOMER_NOT_REACHABLE
  // template). Returning a named event lets us hook either or both
  // from notification-orchestrator.service.js without forking the
  // dispatch path. Enquiry doesn't get an event because legacy CRM
  // doesn't notify the customer when an order is marked Enquiry.
  if (newStatus === STATUS.CALL_LATER)    return 'CustomerNotReachable';
  return null;
}

// ─── Status change ──────────────────────────────────────────────────
/*
 * Performance notes:
 *   - Use getJobMeta (single row, no joins) for the existence + prev-status
 *     check instead of the full getById. Saves one 7-way-join + services + images
 *     fetch per status change (the caller gets the fresh state below).
 *   - Webhook + notification dispatch is fire-and-forget via setImmediate inside
 *     fireWebhook, so the HTTP response returns as soon as UPDATE commits.
 */
/*
 * Whitelist of tier-specific columns the caller may stamp via the
 * `extras` map (see setStatus signature below). The whitelist is the
 * SQL-injection guard — only these column names ever interpolate into
 * the UPDATE statement. New entries land here only after confirming
 * the column exists on tbl_job + the write is genuinely a status-
 * transition side-effect (not unrelated mutation that should go
 * through a different endpoint).
 *
 * Use cases:
 *   - Mobile /jobs/:id/checkin   → checkin_gps_location, checkin_address,
 *                                  checkin_pincode, fk_checkin_by
 *   - Mobile /jobs/:id/checkout  → app_checkout_date_time
 *   - Mobile /jobs/:id/eta       → eta_status, eta_requested_time
 *   - Mobile /jobs/:id/reschedule → reschedule_reason_id, reschedule_remarks,
 *                                  reschedule_at_app, is_rescheduled_by_app
 */
const STATUS_EXTRAS_ALLOWLIST = new Set([
  // Check-in stamps (mobile /checkin path)
  'checkin_gps_location', 'checkin_address', 'checkin_pincode', 'fk_checkin_by',
  // Check-out stamps (mobile /checkout path)
  'app_checkout_date_time',
  // ETA stamps
  'eta_status', 'eta_requested_time',
  // Reschedule-from-app stamps
  'reschedule_reason_id', 'reschedule_remarks', 'reschedule_at_app',
  'is_rescheduled_by_app', 'resch_job_count',
  // Tech-side reassignment trigger
  'requested_date_time',
]);

/*
 * Cached probe for `tbl_job.send_back_to_tx` column existence. The
 * column is referenced by the Mobile App's "Action Required" lifecycle
 * (CRM sets `send_back_to_tx=1` + `job_status=2`; tech re-closes →
 * resets to 0). It doesn't appear elsewhere in this codebase — likely
 * a legacy column from the pre-migration CRM. We probe once on first
 * setStatus call + cache the result so the UPDATE conditionally
 * includes the reset clause only when the column actually exists.
 *
 * When the column lands (or is confirmed already-present), the reset
 * happens automatically on the IN_PROGRESS → COMPLETED transition with
 * no further code change.
 */
let _sendBackColumnExists = null;
async function hasSendBackToTxColumn() {
  if (_sendBackColumnExists != null) return _sendBackColumnExists;
  try {
    const [rows] = await pool.query(
      `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'tbl_job'
          AND COLUMN_NAME  = 'send_back_to_tx'
        LIMIT 1`,
    );
    _sendBackColumnExists = rows.length > 0;
  } catch {
    _sendBackColumnExists = false;
  }
  return _sendBackColumnExists;
}

/*
 * Column-presence probe for the ENQUIRY enrichment trio on tbl_job:
 *   enquiry_reason_id, enquiry_comment, enquiry_date_time.
 *
 * Cached in module-scope after the first hit. Probes all three at once
 * (single SELECT) and returns true only if ALL three are present —
 * partial-deploy state would cause SQL "Unknown column" errors mid-
 * UPDATE, so it's safer to treat any missing one as the legacy shape.
 */
let _enquiryColumnsExist = null;
async function hasEnquiryColumns() {
  if (_enquiryColumnsExist != null) return _enquiryColumnsExist;
  try {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'tbl_job'
          AND COLUMN_NAME IN ('enquiry_reason_id', 'enquiry_comment', 'enquiry_date_time')`,
    );
    _enquiryColumnsExist = rows[0].n === 3;
  } catch {
    _enquiryColumnsExist = false;
  }
  return _enquiryColumnsExist;
}

/*
 * Column-presence probe for `tbl_job.call_later` — flag set to 1 when
 * the Unreachable outcome transition lands. Legacy CRM persisted this
 * flag for downstream reports; new deploys may not have the column
 * yet, in which case we still transition the status but skip the flag.
 */
let _callLaterColumnExists = null;
async function hasCallLaterColumn() {
  if (_callLaterColumnExists != null) return _callLaterColumnExists;
  try {
    const [rows] = await pool.query(
      `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = 'tbl_job'
          AND COLUMN_NAME  = 'call_later'
        LIMIT 1`,
    );
    _callLaterColumnExists = rows.length > 0;
  } catch {
    _callLaterColumnExists = false;
  }
  return _callLaterColumnExists;
}

async function setStatus(jobId, { status, reasonId, comment, extras }, actor) {
  if (!ALL_STATUS_VALUES.has(Number(status))) {
    const err = new Error(`invalid status ${status}; allowed: ${[...ALL_STATUS_VALUES].join(',')}`);
    err.status = 400; throw err;
  }
  const existing = await getJobMeta(jobId);
  if (!existing) {
    const err = new Error('job not found'); err.status = 404; throw err;
  }

  const sets = ['job_status = ?', 'last_update_time = ?'];
  const values = [status, new Date()];
  const actorId = actor?.user_id || null;

  if (Number(status) === STATUS.CANCELLED) {
    sets.push('cancel_date_time = ?', 'cancel_reason_id = ?', 'cancel_comment = ?', 'cancel_by = ?');
    values.push(new Date(), reasonId || null, comment || null, actorId);
  } else if (Number(status) === STATUS.CALL_LATER) {
    // UNREACHABLE / CALL_LATER outcome — set the call_later flag (if
    // the column exists) and stamp `cancel_by` so the audit trail
    // captures WHO marked it. Legacy CRM also persisted reason +
    // comment, but only on tbl_job_comment (comment_on=16) — no
    // dedicated tbl_job columns for unreachable in the legacy schema.
    if (await hasCallLaterColumn()) {
      sets.push('call_later = ?');
      values.push(1);
    }
    sets.push('cancel_by = ?');
    values.push(actorId);
  } else if (Number(status) === STATUS.ENQUIRY) {
    // ENQUIRY stamps a parallel set of columns to CANCELLED:
    //   enquiry_date_time = NOW()
    //   enquiry_reason_id  = action_taken_reason.id picked in the dialog
    //   enquiry_comment    = the prefix string the FE built
    //   cancel_by          = actor (same column reused — legacy ops use it
    //                        as a generic "who actioned this" stamp for
    //                        both ENQUIRY and CANCELLED transitions)
    //
    // Column-probe at runtime: enquiry_* columns may not exist on every
    // deploy (legacy DBs without the 2024 ENQUIRY enrichment). Only
    // append a SET when the column is actually present so the UPDATE
    // doesn't fail with "Unknown column" — the status itself still
    // lands even on older deploys.
    if (await hasEnquiryColumns()) {
      sets.push('enquiry_date_time = ?', 'enquiry_reason_id = ?', 'enquiry_comment = ?', 'cancel_by = ?');
      values.push(new Date(), reasonId || null, comment || null, actorId);
    } else {
      // Older deploy: at minimum stamp `cancel_by` (the column is
      // documented on every deploy) so audit trail still records WHO
      // did the ENQUIRY transition.
      sets.push('cancel_by = ?');
      values.push(actorId);
    }
  } else if (Number(status) === STATUS.BOOKED) {
    /*
     * BOOKED transition = order confirmation. Stamp a 4-digit OTP so
     * the technician can verify on check-in. Legacy CRM did this at
     * check-in (JobDaoImpl.java:4418); ops moved the contract forward
     * to confirmation so the customer learns the code earlier.
     *
     * Idempotency: only stamp when `existing.otp` is null/empty. A
     * re-confirm (e.g. operator promotes Unconfirmed → Booked → CANCELLED
     * → Booked) keeps the original code rather than churning. This
     * matches the customer's mental model — the code they were told
     * doesn't change unless ops explicitly clears it (manual ops path,
     * not currently exposed via API).
     *
     * Column-probed: skip silently on deploys without `tbl_job.otp`.
     */
    if (await hasOtpColumn()) {
      const hasExistingOtp =
        existing.otp != null && String(existing.otp).trim() !== '';
      if (!hasExistingOtp) {
        sets.push('otp = ?');
        values.push(String(generateOtp()));
      }
    }
  } else if (COMPLETED_STATES.has(Number(status))) {
    sets.push('checkout_date_time = COALESCE(checkout_date_time, ?)', 'fk_checkout_by = COALESCE(fk_checkout_by, ?)');
    values.push(new Date(), actorId);
    // Sent-back lifecycle (mobile app spec): when a tech re-closes a
    // job that was sent back from the CRM, reset the flag so the
    // "Action Required" tile stops counting it. Conditionally
    // included — see hasSendBackToTxColumn() rationale.
    if (await hasSendBackToTxColumn()) {
      sets.push('send_back_to_tx = 0');
    }
  }

  // Tier-specific extras — caller passes a map of column→value pairs
  // for transition side-effects that don't generalise (mobile GPS
  // checkin, app_checkout_date_time, etc.). Whitelisted to prevent
  // SQL injection via the column name; values bind parameterised.
  if (extras && typeof extras === 'object') {
    for (const [col, val] of Object.entries(extras)) {
      if (!STATUS_EXTRAS_ALLOWLIST.has(col)) {
        // Non-whitelisted column — silently skip (defence against
        // accidentally-passed unrelated fields). Logged at debug
        // level via an inline require so we don't add a module-scope
        // logger import just for this one safety message.
        try { require('../logger').debug?.({ col, jobId }, 'setStatus: ignoring non-whitelisted extras column'); } catch {}
        continue;
      }
      sets.push(`${col} = ?`);
      values.push(val);
    }
  }

  values.push(jobId);
  await pool.query(`UPDATE tbl_job SET ${sets.join(', ')} WHERE job_id = ?`, values);

  const eventName = statusToEventName(existing.job_status, Number(status));
  if (eventName) fireWebhook(eventName, jobId);

  return getById(jobId);
}

// ─── Assign / Reassign technician ───────────────────────────────────
async function assign(jobId, { easyfixerId, reasonId, rescheduleReason }, actor) {
  // Check tech + job in parallel — they're independent lookups. Fails either
  // way with the right 400/404, same as before, but cuts one round-trip.
  const [[[tech]], existing] = await Promise.all([
    pool.query(
      'SELECT efr_id, efr_status FROM tbl_easyfixer WHERE efr_id = ? LIMIT 1',
      [easyfixerId]
    ),
    getJobMeta(jobId),
  ]);
  if (!tech) {
    const err = new Error(`easyfixer ${easyfixerId} not found`); err.status = 400; throw err;
  }
  if (!tech.efr_status) {
    const err = new Error(`easyfixer ${easyfixerId} is inactive`); err.status = 400; throw err;
  }
  if (!existing) {
    const err = new Error('job not found'); err.status = 404; throw err;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const isReassign = existing.fk_easyfixter_id && existing.fk_easyfixter_id !== easyfixerId;
    const now = new Date();

    await conn.query(
      `UPDATE tbl_job
          SET fk_easyfixter_id = ?, scheduled_date_time = ?, fk_scheduled_by = ?,
              job_status = CASE WHEN job_status = ${STATUS.BOOKED} THEN ${STATUS.SCHEDULED} ELSE job_status END,
              first_scheduled_by = COALESCE(first_scheduled_by, ?),
              last_update_time = ?
        WHERE job_id = ?`,
      [easyfixerId, now, actor?.user_id || null, actor?.user_id || null, now, jobId]
    );

    await conn.query(
      `INSERT INTO scheduling_history (job_id, easyfixer_id, schedule_time, reason_id, reschedule_reason)
       VALUES (?, ?, ?, ?, ?)`,
      [jobId, easyfixerId, now,
       isReassign ? (reasonId || null) : null,
       isReassign ? (rescheduleReason || null) : null]
    );

    await conn.commit();

    fireWebhook(isReassign ? 'RescheduleTech' : 'TechAssigned', jobId);

    return getById(jobId);
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// ─── Unassign technician (mobile reject path) ───────────────────────
/*
 * Reverses an assign: clears `fk_easyfixter_id`, drops the job back to
 * BOOKED, records the reason in `scheduling_history`. Used when the
 * technician rejects an assigned job from the app — the job has to
 * become re-claimable by ops + the auto-assign engine.
 *
 * Distinct from `setStatus()` (which mutates the status column +
 * stamps audit fields per the transition map). Distinct from
 * `assign()` (which sets the tech). Distinct from `changeOwner()`
 * (which mutates `job_owner`, not `fk_easyfixter_id`).
 *
 * Why a dedicated function rather than reusing `setStatus()` with
 * extras: this write spans two tables (UPDATE tbl_job + INSERT
 * scheduling_history) in a transaction, AND clears fk_easyfixter_id
 * which isn't a tier-side-effect column — it's the assignment FK
 * itself. Keeping it as its own canonical function means CRM can
 * later expose an admin /unassign endpoint that flows through the
 * same code path (e.g. for "tech is sick — reset this job") without
 * duplicating the transactional logic.
 *
 *   jobId  : the job to unassign
 *   reason : free-text reason (required — written to scheduling_history.reschedule_reason)
 *   actor  : { user_id?: number | null } — stamps `fk_scheduled_by` audit
 *
 * Fires the `RescheduleTech` webhook (same as a re-assignment) so
 * client integrations downstream see the job leave the tech's queue.
 * Returns the full getById() payload so callers can use it for
 * response immediately.
 */
async function unassign(jobId, { reason }, actor) {
  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    const err = new Error('reason is required to unassign a job'); err.status = 400; throw err;
  }
  const existing = await getJobMeta(jobId);
  if (!existing) {
    const err = new Error('job not found'); err.status = 404; throw err;
  }
  if (!existing.fk_easyfixter_id) {
    // Nothing to unassign — treat as a soft no-op rather than an
    // error so retries are idempotent.
    return getById(jobId);
  }
  const techIdAtUnassign = existing.fk_easyfixter_id;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `UPDATE tbl_job
          SET fk_easyfixter_id = NULL,
              scheduled_date_time = NULL,
              job_status = ${STATUS.BOOKED},
              last_update_time = ?
        WHERE job_id = ?`,
      [new Date(), jobId],
    );
    // scheduling_history row records the unassignment with the reason.
    // `easyfixer_id` here is the tech who's being REMOVED (so the
    // audit trail keeps the per-tech timeline coherent).
    await conn.query(
      `INSERT INTO scheduling_history (job_id, easyfixer_id, schedule_time, reason_id, reschedule_reason)
       VALUES (?, ?, ?, NULL, ?)`,
      [jobId, techIdAtUnassign, new Date(), reason.trim()],
    );
    await conn.commit();

    // Reschedule-shaped event (job is leaving the tech's queue).
    // Clients that already received a TechAssigned for this job will
    // get a RescheduleTech to invalidate downstream state.
    fireWebhook('RescheduleTech', jobId);

    return getById(jobId);
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// ─── Change job owner (PM reassignment) ─────────────────────────────
// Distinct from /assign (which sets fk_easyfixter_id — the technician).
// This endpoint changes job_owner (the internal PM/user who runs the job).
// Always captures reason + timestamp + actor for the audit trail.
async function changeOwner(jobId, { newOwnerId, reason }, actor) {
  // Skip the full detail load — we only need job_owner for the no-op check.
  const [[existing]] = await pool.query(
    'SELECT job_id, job_owner FROM tbl_job WHERE job_id = ? LIMIT 1',
    [jobId]
  );
  if (!existing) {
    const err = new Error('job not found'); err.status = 404; throw err;
  }
  if (existing.job_owner === newOwnerId) {
    const err = new Error(`job ${jobId} is already owned by user ${newOwnerId}`);
    err.status = 400; throw err;
  }

  // Validate target user exists, is active, and is an admin-group user.
  // (A client SPOC or technician can't own a CRM job.)
  const { classifyRoleIdSync } = require('./role.service');
  const [[target]] = await pool.query(
    `SELECT user_id, user_name, user_role, user_status FROM tbl_user WHERE user_id = ? LIMIT 1`,
    [newOwnerId]
  );
  if (!target) {
    const err = new Error(`target user ${newOwnerId} not found`); err.status = 400; throw err;
  }
  if (!target.user_status) {
    const err = new Error(`target user ${newOwnerId} is inactive`); err.status = 400; throw err;
  }
  const targetGroup = classifyRoleIdSync(target.user_role);
  if (targetGroup !== 'admin') {
    const err = new Error(`target user ${newOwnerId} is not in admin group (got "${targetGroup}")`);
    err.status = 400; throw err;
  }

  await pool.query(
    `UPDATE tbl_job
        SET job_owner = ?,
            job_owner_change_by = ?,
            owner_change_reason = ?,
            owner_change_date = ?,
            last_update_time = ?
      WHERE job_id = ?`,
    [newOwnerId, actor?.user_id || null, reason, new Date(), new Date(), jobId]
  );

  return getById(jobId);
}

/*
 * Invoked from create() via setImmediate when a new job is committed.
 * Reads tbl_autoallocation_setting.running_frequency (with per-client override
 * in tbl_client_setting) and, if 'instant', runs the auto-assign pipeline.
 * The actual assignment (including TechAssigned webhook + FCM push to the
 * chosen tech) is handled by auto-assign.service.js::assignTopCandidate(),
 * which calls our assign() above — so the full lifecycle (status bump,
 * scheduling_history row, notification fan-out) fires identically to a manual
 * assign by a human operator.
 */
async function tryAutoAssignOnCreate(jobId, clientId, actor) {
  const logger = require('../logger');
  const { getClientSetting } = require('./settings.service');
  const freq = await getClientSetting(clientId, 'running_frequency');
  if (freq !== 'instant') {
    logger.debug(`Auto-assign skipped for job ${jobId} — running_frequency=${freq ?? 'unset'}`);
    return;
  }
  const { assignTopCandidate } = require('./auto-assign.service');
  try {
    const result = await assignTopCandidate(jobId, actor);
    // A truthy `result.chosen` means `jobService.assign()` already committed
    // the transaction, so the job + scheduling_history row are safely persisted.
    // No email needed — downstream fan-out (webhook + FCM) is fire-and-forget
    // and has its own retry/DLQ plumbing. Per product: "Once auto assigned in
    // DB and status is saved, it's fine."
    if (result?.chosen) {
      logger.ready(`Auto-assigned job ${jobId} → ${result.chosen.efr_name} (efr_id=${result.chosen.efr_id}, score=${result.chosen.score})`);
      return;
    }
    // Defensive branch — assignTopCandidate should throw 422 on no-candidates
    // rather than return an empty result, but belt-and-braces.
    logger.warn(`Auto-assign found no eligible candidates for job ${jobId} — manual assignment required`);
    await notifyAutoAssignFailure(jobId, clientId, 'No eligible technician was found for this job.');
  } catch (err) {
    /*
     * Classify failures so the ops email conveys WHY nothing got assigned.
     * Categories we surface:
     *   422 → No eligible candidate (L1/L2 rejected everyone).
     *   404 → Job vanished between create + auto-assign (extremely rare).
     *   409 → Someone else assigned the job in the interval (manual operator
     *          won the race). This is NOT a failure — just log and skip email.
     *   other → DB save error, inactive efr, unexpected exception. Ops need
     *           to act because the job is still BOOKED with no tech.
     */
    if (err.status === 409) {
      logger.info(`Auto-assign skipped for job ${jobId} — already assigned (likely manual race): ${err.message}`);
      return;
    }
    const reason =
      err.status === 422 ? 'No eligible technician was found for this job.' :
      err.status === 404 ? `Job could not be resolved (${err.message}).` :
      `Auto-assignment errored before the technician could be saved: ${err.message}`;
    logger.warn(`Auto-assign failed for job ${jobId}: ${err.message} (status=${err.status ?? 'unknown'})`);
    await notifyAutoAssignFailure(jobId, clientId, reason);
  }
}

/*
 * Sends an ops-style email when auto-assignment couldn't fulfil a job so a
 * human can pick up the slack. Email recipient is a configurable setting
 * (auto_assign_failure_email) with per-client override — same EAV plumbing
 * as running_frequency. If no email is configured, the notification is
 * silently skipped (ops can always check the job list for unassigned BOOKED
 * rows). Never throws — failure email failures are just logged.
 */
async function notifyAutoAssignFailure(jobId, clientId, reason) {
  const logger = require('../logger');
  try {
    const { getClientSetting } = require('./settings.service');
    const to = await getClientSetting(clientId, 'auto_assign_failure_email');
    if (!to) { logger.debug(`Auto-assign failure notification skipped — no email configured (job ${jobId})`); return; }

    const job = await getById(jobId);
    const lines = [
      `Auto-assignment did not complete for job #${jobId} — the job has NOT been assigned to a technician.`,
      `Reason: ${reason}`,
      '',
      `Client: ${job?.client_name ?? 'unknown'}`,
      `Customer: ${job?.customer_name ?? 'unknown'} · ${job?.customer_mob_no ?? ''}`,
      `City: ${job?.city_name ?? 'unknown'}`,
      `Type: ${job?.job_type ?? ''}`,
      `Requested: ${job?.requested_date_time ?? ''}`,
      '',
      `The job is currently in BOOKED status and needs manual assignment.`,
    ].join('\n');

    const { send } = require('./email.service');
    await send({
      to,
      subject: `[Auto-assign] Job #${jobId} not assigned — manual action needed`,
      text: lines,
      category: 'transactional',
    });
    logger.info(`Auto-assign failure notification sent to ${to} for job ${jobId}`);
  } catch (err) {
    logger.warn(`Failed to send auto-assign failure email for job ${jobId}: ${err.message}`);
  }
}

module.exports = {
  STATUS, ALL_STATUS_VALUES, MUTABLE_COLUMNS,
  // Cross-service helper — used by job-magic-link.service.js to keep the
  // tbl_job.client_services CSV in sync after the customer's self-submit
  // mutates tbl_job_services. Single source of truth, one helper.
  recomputeClientServicesCsv,
  list, getById, getStatusCounts, getAttentionSummary, create, update, setStatus, assign, unassign, changeOwner,
  tryAutoAssignOnCreate,
  fireWebhook, statusToEventName,
  hasClientVerticalIdColumn,
};
