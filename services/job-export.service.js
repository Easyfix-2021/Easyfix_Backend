/*
 * Manage Job → Export.
 *
 * A line-by-line port of the legacy Java CRM's "download manage job list"
 * report:
 *   EasyFix_CRM JobDaoImpl.getManageJobDownloadList  (query + RowMapper)
 *   EasyFix_CRM JobServiceImpl.getManageJobDownloadListReport
 *                              + createManageReportDataSource  (column order + cell values)
 *   EasyFix_CRM UtilityFunctions.getHomeJobStatusbyStatusId    (Job Status label)
 *                              .getJobCurrentStatusNew         (Bucket Status)
 *                              .getAgingDaysWithTime / .calculateAgingDays  (Aging)
 *
 * WHY A LINE-BY-LINE PORT AND NOT A REWRITE
 * The business signs off this migration by DIFFING the new sheet against the
 * legacy sheet, cell for cell. That makes legacy's quirks part of the spec:
 * the header typos ("Cancle By", "A & CO by"), the hard-coded placeholder
 * columns, the float32 rounding on Margin(%), the minute-truncated timestamps,
 * and a handful of outright Java bugs whose OUTPUT we have to keep. Every one
 * of those is called out below with a `LEGACY BUG:` comment saying what the bug
 * is and what it produces, so the next person does not "fix" it and break the
 * diff. Fix them in a follow-up, deliberately, with the business in the loop.
 *
 * WHAT WE DELIBERATELY DID **NOT** PORT
 *  - String-concatenated filter values (legacy interpolated every filter
 *    straight into the SQL — a live injection hole). Everything here is `?`.
 *  - `DATE_FORMAT(col,'%Y-%m-%d') BETWEEN …` — wrapping an indexed DATETIME in
 *    a function makes the predicate non-SARGable, so every date filter became a
 *    full scan of a 384k-row table. Replaced with half-open range comparisons
 *    on the raw column (`col >= ? AND col < ?`, end date + 1 day), which is
 *    exactly equivalent for a whole-day window and can use the index.
 *  - Unbounded fetch. Legacy pulled the entire result set into a Java List and
 *    then into a Jasper datasource — that is the thing that takes the box down.
 *    This module hands the caller ONE CHUNK at a time via keyset pagination on
 *    the primary key, so peak memory is O(chunkSize) no matter how big the
 *    export is.
 *  - Per-row logging (legacy logged ~6 lines PER ROW at info).
 *
 * INTERFACE (another module owns the route + the xlsx writer):
 *   EXPORT_COLUMNS                                    → frozen [{header,key,type}]
 *   fetchExportChunk({filters, afterJobId, chunkSize}) → Promise<rawRows[]>
 *   mapExportRow(rawRow, seqNumber)                    → plain object keyed by EXPORT_COLUMNS[].key
 *   buildExportWhere(filters)                          → {where, params}
 */

const { pool } = require('../db');
const logger = require('../logger');

// ─────────────────────────────────────────────────────────────────────────────
// Column spec
// ─────────────────────────────────────────────────────────────────────────────

/*
 * The sheet's columns, in order. 74 of them — legacy's 75 with the changes the
 * business agreed for this migration:
 *
 *   DROPPED "Job Created By"            (legacy `created_by.user_name AS createdBy`)
 *   DROPPED "Job Executed From New App" (legacy `is_job_from_new_app`)
 *   ADDED   "Job Owner"                 (tbl_job.job_primary_spoc)
 *   MOVED   Pincode / City / State up to sit immediately after Customer Address
 *   CHANGED Customer Address → tbl_address.building only (was building + landmark + address)
 *   RENAMED "JobClient Owner" → "Current OWNER"
 *           "Project Manager" → "Booked By"
 *           "Secondary SPOC"  → "Client Secondary SPOC"
 *
 * Dropping "Job Created By" loses NOTHING, and that is not an assumption:
 * legacy selected the SAME join twice — `created_by.user_name as project_manager`
 * AND `created_by.user_name as createdBy`, both off `tbl_user created_by ON
 * created_by.user_id = J.fk_created_by`. So the renamed "Booked By" column
 * already carries the identical value the dropped column carried.
 *
 * "Job Owner" is placed in the slot the dropped "Job Created By" occupied. It
 * belongs with the other people columns (Current OWNER / Booked By / Zonal
 * Manager) rather than tacked on at the end, and reusing the vacated slot keeps
 * the rest of the sheet's column positions identical to legacy — which is what
 * anyone diffing the two files will thank us for.
 *
 * Header text is VERBATIM legacy, typos included:
 *   "Cancle By", "A & CO by", "Scheduled Before original AppointmentAppointment",
 *   "EF share", "Ticket confirmation action", "First time scheduling date".
 * Do not tidy them; the sheet is consumed by downstream spreadsheets that key
 * off the header row.
 *
 * `type` tells the writer how to render the cell and mirrors legacy's
 * DynamicReports DataTypes:
 *   'number' → integerType/doubleType   'date' → dateType   'string' → stringType
 * Note Pincode and "Closed On App Hours Ago" are STRINGS in legacy too (both
 * had an integer variant that was commented out) — keep them strings, a pincode
 * with a leading zero must not become a number.
 */
const EXPORT_COLUMNS = Object.freeze([
  { header: 'No.',                        key: 'no',                        type: 'number' },
  { header: 'Job Id',                     key: 'jobId',                     type: 'number' },
  { header: 'Job Reference Id',           key: 'jobRefId',                  type: 'string' },
  { header: 'Branch Details',             key: 'branchDetails',             type: 'string' },
  { header: 'Customer Name',              key: 'customerName',              type: 'string' },
  { header: 'Customer Address',           key: 'customerAddress',           type: 'string' },
  { header: 'Pincode',                    key: 'pincode',                   type: 'string' },
  { header: 'City',                       key: 'city',                      type: 'string' },
  { header: 'State',                      key: 'state',                     type: 'string' },
  { header: 'Aging',                      key: 'aging',                     type: 'number' },
  { header: 'Visit Number',               key: 'visitNumber',               type: 'number' },
  { header: 'Job Status',                 key: 'status',                    type: 'string' },
  { header: 'Bucket Status',              key: 'currentStatus',             type: 'string' },
  { header: 'Client',                     key: 'client',                    type: 'string' },
  { header: 'Client Ref Id',              key: 'clientRefId',               type: 'string' },
  { header: 'Category',                   key: 'category',                  type: 'string' },
  { header: 'Client Spoc Name',           key: 'clientSpoc',                type: 'string' },
  { header: 'Tier',                       key: 'tier',                      type: 'string' },
  { header: 'Current OWNER',              key: 'jobClientOwner',            type: 'string' },
  { header: 'Booked By',                  key: 'projectManager',            type: 'string' },
  { header: 'Zonal Manager',              key: 'zonalManager',              type: 'string' },
  { header: 'Job Owner',                  key: 'jobOwner',                  type: 'string' },
  { header: 'Job Scheduled By',           key: 'scheduledBY',               type: 'string' },
  { header: 'A & CO by',                  key: 'auditBy',                   type: 'string' },
  { header: 'Ticket Created Date',        key: 'ticketCreatedDate',         type: 'date'   },
  { header: 'Booking Date',               key: 'bookingDate',               type: 'date'   },
  { header: 'Original Appointment Date',  key: 'originalAppointmentDate',   type: 'date'   },
  { header: 'Appointment Date',           key: 'appointmentDate',           type: 'date'   },
  { header: 'App CheckIn Date',           key: 'checkInDateTime',           type: 'date'   },
  { header: 'App Checkout Date',          key: 'appCheckoutDate',           type: 'date'   },
  { header: 'Audit & Checkout Date',      key: 'auditAndCheckout',          type: 'date'   },
  { header: 'Is Estimate Sent',           key: 'isEstimateSent',            type: 'number' },
  { header: 'Estimate Sent On',           key: 'estimateSentOnDate',        type: 'date'   },
  { header: 'Estimate Approved On',       key: 'estimateApprovedOnDate',    type: 'date'   },
  { header: 'Estimate Rejected On',       key: 'estimateRejectedOnDate',    type: 'date'   },
  { header: 'Estimate Status',            key: 'estimateStatus',            type: 'string' },
  { header: 'Estimate TAT',               key: 'estimateTAT',               type: 'number' },
  { header: 'Cancel Date',                key: 'cancelledDate',             type: 'date'   },
  { header: 'Cancel/Enquiry Comment',     key: 'cancelComment',             type: 'string' },
  { header: 'Cancel/Enquiry Reason',      key: 'cancelReason',              type: 'string' },
  { header: 'Cancle By',                  key: 'cancelBy',                  type: 'string' },
  { header: 'Job Description',            key: 'jobDesc',                   type: 'string' },
  { header: 'Job Type',                   key: 'jobType',                   type: 'string' },
  { header: 'Client Comment',             key: 'clientComment',             type: 'string' },
  { header: 'Current TX Name',            key: 'txName',                    type: 'string' },
  { header: 'Current TX Id',              key: 'txId',                      type: 'number' },
  { header: 'Previous TX Name',           key: 'preTxName',                 type: 'string' },
  { header: 'Previous TX Id',             key: 'preTxId',                   type: 'number' },
  { header: 'OTA',                        key: 'ota',                       type: 'number' },
  { header: 'Pre-Defined TAT',            key: 'preDefinedtat',             type: 'number' },
  { header: 'TAT Status',                 key: 'tatStatus',                 type: 'number' },
  { header: 'SDA Status',                 key: 'sdaStatus',                 type: 'number' },
  { header: 'Rating',                     key: 'rating',                    type: 'number' },
  { header: 'Customer Rating Comment',    key: 'customerRatingComment',     type: 'string' },
  { header: 'Total Charge',               key: 'totalCharge',               type: 'number' },
  { header: 'EF share',                   key: 'efShare',                   type: 'number' },
  { header: 'Margin(%)',                  key: 'margin',                    type: 'number' },
  { header: 'Client Owner',               key: 'clientOwner',               type: 'string' },
  { header: 'Pending Due To',             key: 'pendingDueTo',              type: 'string' },
  { header: 'Pending Reason',             key: 'pendingReason',             type: 'string' },
  { header: 'Pending Remarks',            key: 'pendingRemarks',            type: 'string' },
  { header: 'Ready For Billing',          key: 'readyForBilling',           type: 'string' },
  { header: 'Ticket confirmation action', key: 'confirmationAction',        type: 'number' },
  { header: 'Scheduled Before original AppointmentAppointment',
                                          key: 'scheduledBeforeApointment', type: 'number' },
  { header: 'Closed On App Hours Ago',    key: 'closedOnApp',               type: 'string' },
  { header: 'Aging Slab',                 key: 'agingSlab',                 type: 'string' },
  { header: 'Vertical Name',              key: 'verticalName',              type: 'string' },
  { header: 'Primary SPOC',               key: 'verticalhead',              type: 'string' },
  { header: 'Client Secondary SPOC',      key: 'verticalManager',           type: 'string' },
  { header: 'First time scheduling date', key: 'firstTimeSchedulingDate',   type: 'date'   },
  { header: 'First Scheduled by',         key: 'firstScheduleBY',           type: 'string' },
  { header: 'Is Escalated',               key: 'isEscalated',               type: 'number' },
  { header: 'First Escalated On',         key: 'firstEscalatedOnDate',      type: 'date'   },
  { header: 'Escalation TAT',             key: 'escalationTAT',             type: 'number' },
].map(Object.freeze));

// ─────────────────────────────────────────────────────────────────────────────
// Small primitives — JDBC / Java semantics reproduced in JS
// ─────────────────────────────────────────────────────────────────────────────

/*
 * ResultSet.getInt() semantics: SQL NULL reads back as 0, never null. A LOT of
 * legacy's branching leans on that (a job with no reporting contact gets
 * contact_approval = 0, which is the branch that says "Ticket created"), so
 * reproducing it is load-bearing, not defensive coding.
 *
 * Booleans are handled because db.js typeCasts TINYINT(1)/BIT(1) to real
 * booleans at the pool — JDBC would have handed those to getInt() as 1/0.
 */
function jdbcInt(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

// ResultSet.getBoolean(): NULL → false, 0 → false, anything else → true.
function jdbcBool(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (Buffer.isBuffer(v)) return v.length > 0 && v[0] !== 0;
  const n = Number(v);
  return Number.isFinite(n) ? n !== 0 : String(v).toLowerCase() === 'true';
}

// Non-empty string, mirroring org.apache.commons StringUtils.isNotEmpty.
function notEmpty(v) {
  return v !== null && v !== undefined && String(v) !== '';
}

/*
 * The pool runs `dateStrings: true` + `timezone: '+05:30'`, so a DATETIME
 * arrives as the literal IST wall-clock text "YYYY-MM-DD HH:mm:ss". We build a
 * Date from its LOCAL components, which means NO offset is applied in either
 * direction: the Date's local fields read back exactly the digits MySQL stored,
 * which is what the sheet must show. Never `new Date("2026-01-05 10:30:00")`
 * here — engines have historically treated that as UTC-ish and would shift
 * every cell by hours.
 */
function parseDbDateTime(s) {
  if (s === null || s === undefined) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s).trim());
  if (!m) return null;
  // MySQL's zero-date sentinel is not a date; legacy's SimpleDateFormat would
  // have rolled it into 0000-11-30. Treat it as absent instead.
  if (m[1] === '0000') return null;
  return new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0), 0,
  );
}

/*
 * Every date the legacy sheet contains was round-tripped through the string
 * format "dd MMM yyyy hh:mm a" before being re-parsed into the Jasper
 * datasource. That format has no seconds field, so legacy SILENTLY TRUNCATED
 * every timestamp to the minute. Keeping the seconds here would make every
 * single date cell differ from the legacy file, so we truncate too.
 */
function sheetDate(s) {
  const d = parseDbDateTime(s);
  if (!d) return null;
  d.setSeconds(0, 0);
  return d;
}

// ResultSet.getDate() drops the time entirely. Legacy compares SDA, the
// scheduled-before-appointment flag and the remarks selection at DATE
// granularity because of it. Comparing the "YYYY-MM-DD" prefixes as strings is
// exactly that comparison, with no timezone surface at all.
function datePart(s) {
  if (s === null || s === undefined) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(s).trim());
  return m && m[1] !== '0000-00-00' ? m[1] : null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/*
 * Java's `new SimpleDateFormat("dd MMM yyyy hh:mm a")` under the default (en)
 * locale → "05 Jan 2026 10:30 AM". Only ONE column still needs the STRING form:
 * Pending Remarks, which legacy builds as `remarksDateTime + " : " + remarks`.
 * Everything else emits a real Date. `hh` is 12-hour, so midnight prints as
 * "12 AM" and noon as "12 PM".
 */
function fmtDdMmmYyyyHhMmA(s) {
  const d = parseDbDateTime(s);
  if (!d) return null;
  const h24 = d.getHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()} `
       + `${String(h12).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} `
       + `${h24 < 12 ? 'AM' : 'PM'}`;
}

/*
 * UtilityFunctions.calculateAgingDays — "how many WHOLE days between these two
 * instants", where a whole day is 24 elapsed hours, not a calendar boundary.
 *
 *   hours = truncate((end - start) / 1h)      // Duration.toHours() truncates toward zero
 *   hours < 0   → truncate(hours / 24)        // negative ages are possible and are kept
 *   hours < 24  → 0
 *   otherwise   → truncate(hours / 24)
 *
 * Java integer division truncates toward zero for negatives too, so Math.trunc
 * (not Math.floor) is the faithful operator here.
 */
function calculateAgingDays(startDate, endDate) {
  if (!startDate || !endDate) return 0;
  const hours = Math.trunc((endDate.getTime() - startDate.getTime()) / 3600000);
  if (hours < 0) return Math.trunc(hours / 24);
  if (hours < 24) return 0;
  return Math.trunc(hours / 24);
}

/*
 * Margin(%) is computed in legacy with FLOAT (32-bit) arithmetic and then
 * stringified via Float.toString before being parsed back as a double:
 *
 *     float jobMargin = (float)(efCharge) * 100 / totalCharge;
 *     jobObj.setMargin("" + jobMargin);            // Float.toString → shortest round-trip
 *     ... Double.parseDouble(e.getMargin())        // that decimal, as a double
 *
 * So the cell holds e.g. 33.333332, NOT the double 33.333333333333336 that
 * plain JS arithmetic yields. Reproducing that is the difference between a
 * clean diff and every mixed-margin row lighting up red.
 *
 * Math.fround() gives us the float32 value; the loop then finds the shortest
 * decimal that still round-trips to that float — which is precisely what
 * Float.toString emits — and returns it parsed as a double.
 */
function javaFloatToDouble(f32) {
  if (!Number.isFinite(f32)) return f32;
  for (let p = 1; p <= 9; p += 1) {
    const candidate = Number(f32.toPrecision(p));
    if (Math.fround(candidate) === f32) return candidate;
  }
  return f32;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filters → WHERE
// ─────────────────────────────────────────────────────────────────────────────

/*
 * Which single date column a whole-day range applies to when the UI leaves
 * Date Type on "All" and picks exactly ONE status tab. Legacy matched the
 * status with equalsIgnoreCase (NOT contains), so a multi-token status falls
 * through to requested_date_time — reproduced by the exact-match lookup.
 */
const STATUS_DATE_COLUMN = {
  unconfirmed: 'J.created_date_time',
  scheduling:  'J.created_date_time',
  acknowledge: 'J.created_date_time',
  start:       'J.scheduled_date_time',
  close:       'J.checkin_date_time',
  audit:       'J.app_checkout_date_time',
  approval:    'J.approval_sent_on_date_time',
  fulfillment: 'J.full_fillment_time',
  completed:   'J.checkout_date_time',
  cancel:      'J.cancel_date_time',
};

// Explicit Date Type selections. Keys are the exact tokens the legacy UI sends.
const DATE_TYPE_COLUMN = {
  createddate:          'J.created_date_time',
  scheduleddate:        'J.scheduled_date_time',
  appcheckindate:       'J.checkin_date_time',
  checkoutdatetime:     'J.checkout_date_time',
  approvalsentondate:   'J.approval_sent_on_date_time',
  fullfillmentdate:     'J.full_fillment_time',
  canceldatetime:       'J.cancel_date_time',
  ticket_created_date:  'J.ticket_created_date_time',
};

// The 9 columns legacy ORs together when Date Type is "All" and NO status tab
// is selected ("show me anything that happened in this window").
const ALL_DATE_COLUMNS = [
  'J.created_date_time', 'J.scheduled_date_time', 'J.checkin_date_time',
  'J.checkout_date_time', 'J.approval_sent_on_date_time', 'J.full_fillment_time',
  'J.cancel_date_time', 'J.ticket_created_date_time', 'J.requested_date_time',
];

/*
 * Status tab token → job_status codes. Legacy tested with `status.contains(...)`
 * on the raw CSV, so we do substring matching on the same string rather than
 * splitting — "close" and "completed" etc. never collide, but a caller sending
 * a value legacy would have matched loosely keeps matching loosely.
 */
const STATUS_TOKEN_CODES = [
  ['unconfirmed', [9]],
  ['start',       [1]],
  ['close',       [2, 20]],
  ['audit',       [10]],
  ['approval',    [15]],
  ['fulfillment', [21]],
  ['completed',   [3, 5]],
  ['cancel',      [6]],
  ['enquiry',     [7]],
  ['scheduling',  [0]],
  ['acknowledge', [0]],
];

/*
 * Normalise whatever the UI sent into "YYYY-MM-DD".
 * Legacy only accepted its own picker format ("05 Jan, 2026") and NPE'd on
 * anything else; we take that plus plain ISO so the new CRM_UI can send the
 * sane form without a translation layer in the route.
 */
function normaliseDate(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*,?\s+(\d{4})$/.exec(s);
  if (m) {
    const mon = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
    if (mon >= 0) {
      return `${m[3]}-${String(mon + 1).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
    }
  }
  return null;
}

// End date + 1 day, so a whole-day window becomes the half-open [from, to+1).
function nextDay(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
}

/*
 * The SARGable replacement for legacy's `DATE_FORMAT(col,'%Y-%m-%d') BETWEEN a AND b`.
 * Same rows (a whole-day inclusive window), but the raw column is compared
 * directly so MySQL can still use its index instead of evaluating a function
 * for every one of ~384k rows.
 */
function dayRange(col, from, to) {
  return { sql: `(${col} >= ? AND ${col} < ?)`, params: [`${from} 00:00:00`, `${nextDay(to)} 00:00:00`] };
}

/*
 * Build the WHERE clauses.
 *
 * `flage` / `flag` are legacy's two booleans, reproduced by name because the
 * two implicit guards at the bottom BRANCH ON THEM and the difference is
 * subtle: every filter sets `flage` (= "a WHERE exists"), but `flag` is only
 * set by the filter that emitted the FIRST clause, and stateId / openDueToReason
 * / rating never set it at all. Modelling both keeps the guards behaving
 * identically if the filter order is ever touched.
 */
function buildClauses(filters = {}) {
  const {
    jobsId, clientIdFromUI, easyfixerId, easyfixerMobileNumber, cityId, zonalId,
    status, stateId, svcCatgId, ownerId, custName, clientReferenceId, pinCode,
    verticalIdentity, dateFrom, dateTo, dateType, bucketAgingRange, bucketStatus,
    openDueToReason, rating,
  } = filters;

  const clauses = [];
  const params = [];
  let flage = false;   // legacy: "a WHERE clause has been emitted"
  let flag = false;    // legacy: "the FIRST clause came from a filter that sets flag"

  // `push` marks flage; `pushPrimary` marks both, matching which legacy branch
  // assigned which boolean.
  const push = (sql, ...vals) => { clauses.push(sql); params.push(...vals); flage = true; };
  const pushPrimary = (sql, ...vals) => { if (!flage) flag = true; push(sql, ...vals); };

  // Legacy called status.contains()/equalsIgnoreCase() on a possibly-null
  // String further down and NPE'd; normalise once instead.
  const statusStr = String(status ?? '').trim();
  const statusLower = statusStr.toLowerCase();
  const hasToken = (t) => statusLower.includes(t);

  if (notEmpty(jobsId)) {
    // Legacy switched on the literal "REF" appearing in the value — the
    // reference ids look like "REF12345".
    if (String(jobsId).toUpperCase().includes('REF')) {
      pushPrimary('J.job_reference_id = ?', String(jobsId));
    } else {
      pushPrimary('J.job_id = ?', Number(jobsId));
    }
  }

  if (Number(clientIdFromUI) > 0)  pushPrimary('J.fk_client_id = ?', Number(clientIdFromUI));
  if (notEmpty(easyfixerId))       pushPrimary('J.fk_easyfixter_id = ?', Number(easyfixerId));

  /*
   * efr_no is a VARCHAR. Legacy inlined the mobile as a BARE NUMBER
   * (`EFR.efr_no = 9876543210`), which forces MySQL to numerically coerce the
   * whole column — non-SARGable, and it quietly matched rows with stray
   * whitespace. Binding a string keeps the index usable and is the comparison
   * that was actually intended. Deliberate, documented divergence.
   */
  if (notEmpty(easyfixerMobileNumber)) {
    pushPrimary('EFR.efr_no = ?', String(easyfixerMobileNumber).trim());
  }

  if (Number(cityId) > 0)  pushPrimary('city.city_id = ?', Number(cityId));
  // zonalId is the ZONAL MANAGER (tbl_city.state_user), which is what legacy's
  // `zonalManager` param filtered on — NOT tbl_zone_master. Same name the
  // export UI sends; do not "correct" it to the zone-mapping table.
  if (Number(zonalId) > 0) pushPrimary('city.state_user = ?', Number(zonalId));

  if (statusStr) {
    const codes = [];
    for (const [token, tokenCodes] of STATUS_TOKEN_CODES) {
      if (hasToken(token)) for (const c of tokenCodes) if (!codes.includes(c)) codes.push(c);
    }
    /*
     * The "acknowledge" tab means "status 0 AND a technician is already
     * attached". Legacy assembled that by string surgery, which produced two
     * behaviours worth spelling out:
     *   - acknowledge + scheduling → the `fk_easyfixter_id IS NOT NULL` half is
     *     DROPPED entirely (the branch just closes the paren), so the pair
     *     means plain "status 0".
     *   - acknowledge + any OTHER tab → the technician predicate is appended
     *     OUTSIDE the IN(...) and therefore constrains EVERY selected status,
     *     not just 0. LEGACY BUG: picking "Completed + Acknowledge" silently
     *     hides completed jobs with no technician. Reproduced on purpose.
     */
    const requireEfr = hasToken('acknowledge') && !hasToken('scheduling');
    if (codes.length) {
      pushPrimary(`J.job_status IN (${codes.map(() => '?').join(', ')})`, ...codes);
      if (requireEfr) clauses.push('J.fk_easyfixter_id IS NOT NULL');
    }
    /*
     * If the caller sends a status that matches no token at all, legacy
     * appended a bare " ) " and the query died with a syntax error — no sheet,
     * no error message the user could act on. We emit no status clause instead;
     * an unfiltered export beats a 500.
     */
  }

  // stateId is the one filter that sets `flage` but NOT `flag` — see the guard
  // block at the bottom of this function.
  if (Number(stateId) > 0)   push('city.state_id = ?', Number(stateId));
  if (Number(svcCatgId) > 0) pushPrimary('J.fk_service_catg_id = ?', Number(svcCatgId));
  if (Number(ownerId) > 0)   pushPrimary('J.job_owner = ?', Number(ownerId));

  if (notEmpty(custName)) {
    const v = String(custName).trim();
    // An all-digits value is a mobile number, anything else is a name. Legacy's
    // exact test was `customer.matches("[0-9]+")`.
    if (/^[0-9]+$/.test(v)) pushPrimary('C.customer_mob_no = ?', v);
    else                    pushPrimary('C.customer_name LIKE ?', `%${v}%`);
  }

  if (notEmpty(clientReferenceId)) {
    // branch_details doubles as a client reference on some clients; the
    // `<> ''` guard stops an empty search term matching every blank row.
    const v = String(clientReferenceId).trim();
    pushPrimary("(J.client_ref_id = ? OR (J.branch_details = ? AND J.branch_details <> ''))", v, v);
  }

  // Prefix LIKE — still index-usable, so it stays exactly as legacy had it.
  if (notEmpty(pinCode)) pushPrimary('A.pin_code LIKE ?', `${String(pinCode).trim()}%`);

  if (Number(verticalIdentity) > 0) pushPrimary('V.vertical_id = ?', Number(verticalIdentity));

  // ── Date window ───────────────────────────────────────────────────────────
  const from = normaliseDate(dateFrom);
  const to = normaliseDate(dateTo);
  // Legacy dereferenced dateType without a null check. The UI always sends it
  // and "All" is its default, so default to that rather than NPE.
  const dtRaw = String(dateType ?? 'All').trim();
  const isAll = dtRaw.toLowerCase() === 'all';

  if (from && to) {
    if (statusStr && isAll) {
      // One status tab + "All" → the date column that tab is ABOUT.
      const col = STATUS_DATE_COLUMN[statusLower] || 'J.requested_date_time';
      const r = dayRange(col, from, to);
      pushPrimary(r.sql, ...r.params);
    } else if (!statusStr && isAll) {
      // No status tab + "All" → "did ANY milestone land in this window".
      const parts = ALL_DATE_COLUMNS.map((c) => dayRange(c, from, to));
      pushPrimary(
        `(${parts.map((p) => p.sql).join(' OR ')})`,
        ...parts.flatMap((p) => p.params),
      );
    } else if (!isAll) {
      const col = DATE_TYPE_COLUMN[dtRaw.toLowerCase()] || 'J.requested_date_time';
      const r = dayRange(col, from, to);
      pushPrimary(r.sql, ...r.params);
      // Legacy pinned the completed statuses onto this one date type only.
      if (dtRaw.toLowerCase() === 'checkoutdatetime') clauses.push('J.job_status IN (3, 5)');
    }
  }

  /*
   * Aging buckets, measured against the ORIGINAL appointment and only for
   * appointments already in the past:
   *   1 → 0-24h ago   2 → 24-48h ago   3 → 48-72h ago   4 → older than 72h
   *
   * These wrap NOW(), not the column, so they stay SARGable — that part of
   * legacy was fine and is kept verbatim.
   *
   * LEGACY BUG: legacy opened a paren per selected bucket but only ever closed
   * one, so selecting three or more buckets produced unbalanced parentheses and
   * a hard SQL error. We emit one balanced OR group, which is what the
   * one- and two-bucket cases already evaluated to.
   */
  const buckets = String(bucketAgingRange ?? '');
  if (buckets) {
    const OADT = 'J.original_appointment_date_time';
    const bucketSql = [];
    if (buckets.includes('1')) bucketSql.push(`(DATE_SUB(NOW(), INTERVAL 24 HOUR) <= ${OADT} AND ${OADT} <= NOW())`);
    if (buckets.includes('2')) bucketSql.push(`(DATE_SUB(NOW(), INTERVAL 48 HOUR) <= ${OADT} AND DATE_SUB(NOW(), INTERVAL 24 HOUR) >= ${OADT} AND ${OADT} <= NOW())`);
    if (buckets.includes('3')) bucketSql.push(`(DATE_SUB(NOW(), INTERVAL 72 HOUR) <= ${OADT} AND DATE_SUB(NOW(), INTERVAL 48 HOUR) >= ${OADT} AND ${OADT} <= NOW())`);
    if (buckets.includes('4')) bucketSql.push(`(DATE_SUB(NOW(), INTERVAL 72 HOUR) >= ${OADT} AND ${OADT} <= NOW())`);
    if (bucketSql.length) pushPrimary(`(${bucketSql.join(' OR ')})`);
  }

  // "Open due to" — user_type of the reason attached to the job.
  if (notEmpty(openDueToReason) && String(openDueToReason).toLowerCase() !== 'all') {
    push('ut.type = ?', String(openDueToReason));
  }

  // Rating 1..5 is a literal match; anything above 5 is the UI's "not rated"
  // pseudo-option and means IS NULL.
  if (Number(rating) > 0) {
    if (Number(rating) <= 5) push('TERBC.customer_rating = ?', Number(rating));
    else                     push('TERBC.customer_rating IS NULL');
  }

  // Bucket-status sub-filter — legacy only honoured it on the Unconfirmed tab.
  // "Unreachable" is deliberately a no-op: it had no SQL in legacy either.
  if (statusLower === 'unconfirmed') {
    const bs = String(bucketStatus ?? '').trim().toLowerCase();
    if (bs === 'pending client authorization') {
      push('(J.approved_by_client = 0 OR J.approved_by_client = 2)');
    } else if (bs === 'pending ef acknowledgement') {
      push('((J.approved_by_client <> 0 AND J.approved_by_client <> 2) OR J.approved_by_client IS NULL)');
    } else if (bs !== 'unreachable') {
      push('(J.approved_by_client = 0 OR J.approved_by_client = 2 OR J.approved_by_client = 1 OR J.approved_by_client IS NULL)');
    }
  }

  /*
   * Implicit guards. Without them an unfiltered export means "every job ever",
   * which is the query that takes the database down.
   *
   * The second guard (`flage && completed && !flag`) is UNREACHABLE with the
   * current filter order — every filter evaluated before `status` also sets
   * `flag`, so `flag` cannot be false while a status is present. It is kept
   * because it is legacy's rule and because it becomes reachable again the
   * moment someone reorders the filters above.
   */
  if (!flage) {
    clauses.push('J.created_date_time >= DATE_SUB(NOW(), INTERVAL 6 MONTH)');
    clauses.push('J.job_status NOT IN (3, 5, 6, 7)');
  } else if (hasToken('completed') && !flag) {
    clauses.push('J.created_date_time >= DATE_SUB(NOW(), INTERVAL 6 MONTH)');
    clauses.push('J.job_status IN (3, 5)');
  }

  // Terminal statuses have years of history behind them; without a geography
  // filter to narrow the scan, cap them at 6 months.
  if ((hasToken('cancel') || hasToken('enquiry') || hasToken('completed'))
      && !(Number(cityId) > 0) && !(Number(stateId) > 0)) {
    clauses.push('J.created_date_time >= DATE_SUB(NOW(), INTERVAL 6 MONTH)');
  }

  return { clauses, params };
}

/*
 * Public form of the filter builder: a ready-to-splice `WHERE …` string (empty
 * string when there is nothing to filter on) plus its bind values, in order.
 */
function buildExportWhere(filters = {}) {
  const { clauses, params } = buildClauses(filters);
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

// ─────────────────────────────────────────────────────────────────────────────
// The query
// ─────────────────────────────────────────────────────────────────────────────

/*
 * FROM / JOIN block — legacy's, unchanged in shape.
 *
 * Two things in here look wrong and are not:
 *  - The `atr` join's IF/IF/IF picks the reason belonging to whichever of
 *    cancel_date_time / remarks_date_time is the LATER one, falling back to
 *    whichever exists. That is the "Pending Reason" column's source.
 *  - `TJA1` is a ROW_NUMBER() derived table rather than a correlated subquery
 *    precisely so the previous-technician lookup does not run per row.
 *
 * The two correlated subqueries in the SELECT list (first estimate sent, first
 * escalation) are legacy's and are kept: with an index on `job_id` each is a
 * cheap point lookup, and they are bounded by the chunk size rather than by the
 * whole result set the way legacy's were.
 *
 * Joined columns the mapper reads are given DISTINCT aliases. `J.*` drags in
 * all 141 tbl_job columns, and mysql2 collapses duplicate field names to
 * last-one-wins — so an un-aliased `ut.type` or `TERBC.comment` would silently
 * take or lose a value depending on what tbl_job happens to be called. Aliasing
 * removes the ambiguity without changing which rows come back.
 */
const EXPORT_SELECT = `
  SELECT
    TJA1.previous_efr        AS previousEfrId,
    TEP.efr_name             AS previousEfrName,
    J.*,
    ESTST.status             AS estimate_status,
    ESTST.action_on          AS estimate_action,
    (SELECT TED1.sent_on FROM tbl_estimate_details TED1
      WHERE TED1.job_id = J.job_id ORDER BY TED1.id ASC LIMIT 1)                       AS estimate_sent_on,
    (SELECT TJEI1.escalation_time FROM tbl_job_escalation_info TJEI1
      WHERE TJEI1.job_id = J.job_id ORDER BY TJEI1.escalation_info_id ASC LIMIT 1)     AS escalated_on,
    A.pin_code,
    A.building,
    A.landmark,
    A.address_id,
    A.address,
    S.state_name,
    city.city_name,
    city.tier,
    jt.total_charge,
    jt.ef_charge             AS easyfix_charge,
    jt.efr_charge            AS easyfixer_charge,
    jt.client_charge         AS client_charge,
    C.customer_name,
    CL.client_name,
    EFR.efr_name,
    EFR.efr_no,
    EFR.efr_id,
    EFR.efr_manager_id,
    EFR.efr_status,
    TERBC.escalated_time,
    TERBC.escalated_by,
    TERBC.customer_rating,
    TERBC.review_comment,
    TERBC.comment            AS rating_comment,
    TERBC.is_escalated,
    contact.approval_by_client AS contact_approval,
    UO.user_name             AS owner_user,
    ut.type                  AS due_to_type,
    atr.action_desc          AS pending_reason_desc,
    atr.action_type          AS pending_action_type,
    TECR.action              AS call_record_action,
    TSC.service_catg_name,
    created_by.user_name     AS project_manager,
    stateUser.user_name      AS zonal_manager,
    scheduledBy.user_name    AS scheduled_by,
    checkoutBy.user_name     AS checkout_by,
    V.vertical_name,
    atr2.action_desc         AS cancelReason2,
    atr3.action_desc         AS enquiryReason,
    GROUP_CONCAT(DISTINCT(TU.user_name))  AS verticaHead,
    GROUP_CONCAT(DISTINCT(TU1.user_name)) AS verticalManager,
    cancelBy.user_name       AS cancel_by_user,
    TBU.user_name            AS firstScheduleBY,
    JO.offer_total, JO.offer_pending, JO.offer_accepted,
    JO.offer_rejected, JO.offer_expired, JO.accepted_tx
  FROM tbl_job J
  LEFT JOIN tbl_customer  C   ON C.customer_id   = J.fk_customer_id
  LEFT JOIN tbl_client    CL  ON CL.client_id    = J.fk_client_id
  LEFT JOIN tbl_easyfixer EFR ON EFR.efr_id      = J.fk_easyfixter_id
  LEFT JOIN tbl_user      UO  ON UO.user_id      = J.job_client_owner
  LEFT JOIN tbl_easyfixer_rating_by_customer TERBC ON TERBC.job_id = J.job_id
  LEFT JOIN tbl_client_contacts contact ON contact.id = J.reporting_contact_id
  LEFT JOIN action_taken_reason atr ON atr.id =
    IF(J.cancel_date_time IS NOT NULL AND J.remarks_date_time IS NOT NULL,
       IF(TIMEDIFF(J.cancel_date_time, J.remarks_date_time) > 0, J.cancel_reason_id, J.enum_reason_id),
       IF(J.cancel_date_time IS NOT NULL AND J.remarks_date_time IS NULL, J.cancel_reason_id,
          IF(J.remarks_date_time IS NOT NULL AND J.cancel_date_time IS NULL, J.enum_reason_id, NULL)))
  LEFT JOIN tbl_easyfixer_call_record TECR ON TECR.job_id = J.job_id
  LEFT JOIN user_type ut ON ut.id = atr.user_type
  LEFT JOIN tbl_user created_by ON created_by.user_id = J.fk_created_by
  LEFT JOIN tbl_address A ON A.customer_id = J.fk_customer_id AND A.address_id = J.fk_address_id
  LEFT JOIN tbl_city city ON city.city_id = A.city_id
  LEFT JOIN tbl_user stateUser ON city.state_user = stateUser.user_id
  LEFT JOIN tbl_state S ON city.state_id = S.state_id
  LEFT JOIN tbl_job_transaction jt ON jt.fk_job_id = J.job_id
  LEFT JOIN tbl_service_catg TSC ON TSC.service_catg_id = J.fk_service_catg_id
  LEFT JOIN tbl_user scheduledBy ON scheduledBy.user_id = J.fk_scheduled_by
  LEFT JOIN tbl_user checkoutBy  ON checkoutBy.user_id  = J.fk_checkout_by
  LEFT JOIN tbl_vertical_mapping TVM ON TVM.client_id = CL.client_id
  LEFT JOIN tbl_vertical V ON V.vertical_id = TVM.vertical_id
  LEFT JOIN action_taken_reason atr2 ON atr2.id = J.cancel_reason_id
  LEFT JOIN tbl_user TU  ON TU.user_id  = TVM.user_id AND TVM.user_type = 1
  LEFT JOIN tbl_user TU1 ON TU1.user_id = TVM.user_id AND TVM.user_type = 2
  LEFT JOIN action_taken_reason atr3 ON atr3.id = J.enquiry_reason_id
  LEFT JOIN tbl_user TBU ON TBU.user_id = J.first_scheduled_by
  LEFT JOIN tbl_user cancelBy ON cancelBy.user_id = J.cancel_by
  LEFT JOIN (
    SELECT job_id, previous_efr,
           ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY id DESC) AS row_num
      FROM tbl_job_assignee_history
  ) TJA1 ON TJA1.job_id = J.job_id AND TJA1.row_num = 1
  LEFT JOIN tbl_easyfixer TEP ON TEP.efr_id = TJA1.previous_efr
  LEFT JOIN (
    SELECT TED.sent_on, TED.job_id, TED.action_on, TED.status
      FROM tbl_estimate_details TED
      INNER JOIN (SELECT job_id, MAX(id) AS max_id FROM tbl_estimate_details GROUP BY job_id) AS maxTED
              ON TED.job_id = maxTED.job_id AND TED.id = maxTED.max_id
  ) ESTST ON ESTST.job_id = J.job_id
  LEFT JOIN (
    SELECT jo.job_id,
           COUNT(*)                 AS offer_total,
           SUM(jo.offer_status = 0) AS offer_pending,
           SUM(jo.offer_status = 1) AS offer_accepted,
           SUM(jo.offer_status = 2) AS offer_rejected,
           SUM(jo.offer_status = 3) AS offer_expired,
           MAX(CASE WHEN jo.offer_status = 1 THEN jo.fk_easyfixter_id END) AS accepted_tx
      FROM tbl_job_offer jo
     GROUP BY jo.job_id
  ) JO ON JO.job_id = J.job_id
`;

const DEFAULT_CHUNK_SIZE = 1000;
const MAX_CHUNK_SIZE = 5000;

/*
 * Fetch ONE page of raw rows, newest job first.
 *
 * KEYSET, not OFFSET. `LIMIT ?, ?` re-walks and discards every row before the
 * offset, so page N costs O(N × pageSize) and the last page of a 200k-row
 * export costs more than the whole rest of it combined. Seeking on the primary
 * key instead (`J.job_id < ?`) makes every page cost the same. The `LIMIT ?`
 * here is the page SIZE — there is no offset argument, which is the part that
 * had to go.
 *
 * The caller loops: start with `afterJobId` undefined, then pass the last row's
 * `job_id` each time, and stop when fewer than `chunkSize` rows come back.
 *
 * ORDER BY job_id DESC replaces legacy's "order by whichever date column the
 * status tab is about". Keyset pagination REQUIRES the sort key to be the
 * cursor, those date columns are nullable (so they can't order a cursor at
 * all), and job_id DESC is newest-first either way — the same reading order the
 * operator expects.
 *
 * GROUP BY J.job_id is legacy's and is required, not cosmetic: the vertical
 * mapping / job-transaction / call-record joins each fan a job out into several
 * rows, and the two GROUP_CONCAT columns (Primary SPOC, Client Secondary SPOC)
 * are built from that fan-out.
 */
async function fetchExportChunk({ filters = {}, afterJobId = null, chunkSize = DEFAULT_CHUNK_SIZE } = {}) {
  const size = Math.min(Math.max(Number(chunkSize) || DEFAULT_CHUNK_SIZE, 1), MAX_CHUNK_SIZE);
  const { clauses, params } = buildClauses(filters);

  const allClauses = clauses.slice();
  const allParams = params.slice();
  if (afterJobId !== null && afterJobId !== undefined && afterJobId !== '') {
    allClauses.push('J.job_id < ?');
    allParams.push(Number(afterJobId));
  }

  const sql = `${EXPORT_SELECT}
    ${allClauses.length ? `WHERE ${allClauses.join(' AND ')}` : ''}
    GROUP BY J.job_id
    ORDER BY J.job_id DESC
    LIMIT ?`;

  const started = Date.now();
  const [rows] = await pool.query(sql, [...allParams, size]);
  logger.info(
    `Manage-Job export chunk · rows=${rows.length} · afterJobId=${afterJobId ?? 'start'} · ${Date.now() - started}ms`,
  );
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived fields (the RowMapper, ported)
// ─────────────────────────────────────────────────────────────────────────────

/*
 * "Job Status" — UtilityFunctions.getHomeJobStatusbyStatusId. This is the
 * COARSE bucket name (the CRM tab), not the fine-grained status below it.
 * Anything unmapped renders as an empty string, exactly as legacy did.
 */
function homeJobStatus(jobStatus, efrId, subJobId) {
  if (jobStatus === 0 && efrId >= 0) return 'Pending for scheduling';
  if ((jobStatus === 3 || jobStatus === 5) && subJobId > 0) return 'Visit Completed';
  switch (jobStatus) {
    case 1:  return 'Pending to start';
    case 2:
    case 20: return 'Pending to close on app';
    case 10: return 'Audit & complete';
    case 3:
    case 5:  return 'Completed';
    case 6:  return 'Failed Orders';
    case 7:  return 'Failed Orders';
    case 9:  return 'Unconfirmed';
    case 15: return 'Orders in Follow UP';
    case 21: return 'Orders in Follow UP';
    case 100: return 'UnKnown Reciever';
    default: return '';
  }
}

// status 9 — UtilityFunctions.getUnconfirmedBucketCurrentStatus.
// contactApproval is 0 whenever the job has no reporting contact (getInt on
// NULL), which is why so many unconfirmed jobs read "Ticket created".
function unconfirmedBucketStatus(r) {
  const callLater = jdbcBool(r.call_later);
  const contactApproval = jdbcInt(r.contact_approval);
  const approvedByClient = jdbcInt(r.approved_by_client);
  if (callLater) return 'Call Later';
  if ((contactApproval === 0 || contactApproval === 2 || approvedByClient === 1) && !callLater) return 'Ticket created';
  if (contactApproval === 1 && (approvedByClient === 0 || approvedByClient === 2) && !callLater) return 'Ticket Auth pending';
  return 'Undefined';
}

/*
 * status 1 — UtilityFunctions.getPendingToStartBucketCurrentStatus.
 *
 * The appointment instant only exists when `requested_time` is populated:
 * legacy formatted `requested_date_time` down to "dd MMM yyyy", appended the
 * time, and parsed the result with the pattern "dd MMM yyyy HH:mm:ss". With no
 * requested_time that parse threw, the exception was swallowed, and the
 * appointment stayed null — so "Running Late" simply never fires for those
 * jobs. Reproduced by only computing the instant when both parts are present.
 *
 * LEGACY BUG: the third branch tests `isRescheduledByApp`, a field this
 * RowMapper never populates (it only sets `rescheduleReasonByApp`). It is
 * therefore always null and "Reschedule before start" is DEAD — a job
 * rescheduled from the app reports "Cancelled from App" or "Undefined"
 * instead. Left dead on purpose.
 */
function pendingToStartBucketStatus(r) {
  const requestedTime = notEmpty(r.requested_time) ? String(r.requested_time) : null;
  const reqDay = datePart(r.requested_date_time);
  const appointmentDt = (requestedTime && reqDay) ? parseDbDateTime(`${reqDay} ${requestedTime}`) : null;

  const now = new Date();
  // Duration.between(now, appointment).toMinutes() — positive while the
  // appointment is still ahead of us. Truncates toward zero.
  const duration = appointmentDt ? Math.trunc((appointmentDt.getTime() - now.getTime()) / 60000) : 0;

  const etaStatus = r.eta_status === null || r.eta_status === undefined ? null : String(r.eta_status);
  const cancelByApp = jdbcInt(r.job_cancel_reason_id_by_easyfixer);
  const rescheduleByApp = jdbcInt(r.reschedule_reason_id);
  const efrId = jdbcInt(r.fk_easyfixter_id);

  if (appointmentDt && now.getTime() > appointmentDt.getTime()) return 'Running Late';
  if (etaStatus === '11') return 'ETA Sent';
  // (dead `isRescheduledByApp` branch — see the note above)
  if (cancelByApp !== 0) return 'Cancelled from App';
  if (efrId !== 0 && duration >= 120 && etaStatus === '01' && (rescheduleByApp === 0 || cancelByApp === 0)) return 'On-Track';
  if (efrId !== 0 && duration > 0 && duration < 120 && etaStatus === '01' && (rescheduleByApp === 0 || cancelByApp === 0)) return 'close loop';
  return 'Undefined';
}

/*
 * status 10 — UtilityFunctions.getAuditAndCompleteBucketCurrentStatus.
 *
 * Reads the RAW DB strings, not the pretty-printed ones: the RowMapper formats
 * approved_on / approval_reject early, then OVERWRITES both with the raw column
 * values a few lines before this is called. So the "yyyy-MM-dd HH:mm:ss.S"
 * parse inside it lines up, and full second precision is in play here (unlike
 * the sheet's date cells).
 *
 * Whenever a date needed for a comparison won't parse, legacy's catch left the
 * status variable at its incoming value — null — and returned that. Same here.
 */
function auditAndCompleteBucketStatus(r) {
  const approved = notEmpty(r.approved_on_date_time) ? parseDbDateTime(r.approved_on_date_time) : null;
  const rejected = notEmpty(r.approval_reject_date_time) ? parseDbDateTime(r.approval_reject_date_time) : null;
  const ffReason = r.full_fillment_reason === null || r.full_fillment_reason === undefined ? null : r.full_fillment_reason;
  const ffCreated = parseDbDateTime(r.full_fillment_created_time);
  const revisit = jdbcInt(r.revisit_reason_id);

  const hasApproved = notEmpty(r.approved_on_date_time);
  const hasRejected = notEmpty(r.approval_reject_date_time);
  const hasFf = ffReason !== null;

  if (revisit > 0 && !hasRejected && !hasApproved && !hasFf) return 'Completed with next visit';
  if (revisit === 0 && !hasRejected && !hasApproved && !hasFf) return 'Completed with all work';
  if (hasRejected && !hasApproved && !hasFf) return 'Estimate Rejected';
  if (!hasRejected && hasApproved && !hasFf) return 'Estimate Approved';
  if (hasRejected && hasApproved && !hasFf) {
    if (!approved || !rejected) return null;
    return approved.getTime() > rejected.getTime() ? 'Estimate Approved' : 'Estimate Rejected';
  }
  if (!hasRejected && !hasApproved && hasFf) return 'Ready For Fulfillment';
  if (!hasRejected && hasApproved && hasFf) {
    if (!approved || !ffCreated) return null;
    return approved.getTime() > ffCreated.getTime() ? 'Estimate Approved' : 'Ready For Fulfillment';
  }
  if (hasRejected && !hasApproved && hasFf) {
    if (!rejected || !ffCreated) return null;
    return rejected.getTime() > ffCreated.getTime() ? 'Estimate Rejected' : 'Ready For Fulfillment';
  }
  if (hasRejected && hasApproved && hasFf) {
    if (!approved || !rejected || !ffCreated) return null;
    const a = approved.getTime(); const j = rejected.getTime(); const f = ffCreated.getTime();
    if (a > j && a > f) return 'Estimate Approved';
    if (j > a && j > f) return 'Estimate Rejected';
    return 'Ready For Fulfillment';
  }
  return 'Ready For Fulfillment';
}

/*
 * status 0 — UtilityFunctions.getPendingToScheduleBucketCurrentStatusNew.
 * THE OFFER MODEL: with no tbl_job_offer rows the job was hard-assigned the old
 * way, so the answer comes from the technician + scheduled date; with offer rows
 * the answer comes from the mix of offer_status values.
 */
function pendingToScheduleBucketStatus(r) {
  const offerTotal = jdbcInt(r.offer_total);
  if (offerTotal === 0) {
    if (jdbcInt(r.fk_easyfixter_id) > 0) return 'Pending App Ack';
    return notEmpty(r.scheduled_date_time) ? 'Rejected by TX on App' : 'Unallocated';
  }
  if (jdbcInt(r.offer_accepted) > 0) return 'Allocated';
  if (jdbcInt(r.offer_pending) > 0) return 'Offered To Tx';
  if (jdbcInt(r.offer_rejected) === offerTotal) return 'Offer Rejected';
  if (jdbcInt(r.offer_expired) === offerTotal) return 'Offer Expired';
  return 'Expired';   // a mix of rejected + expired
}

/*
 * status 3 / 5 — UtilityFunctions.getBillingBucketStatusNew.
 *
 * LEGACY BUG: the first branch returns "Reopned Job" when jobReopenFlag == 1,
 * but this RowMapper NEVER CALLS setJobReopenFlag — the field sits at Java's
 * int default of 0 even though `job_reopen_flag` is right there in `J.*`. So
 * "Reopned Job" can never appear in this export and reopened jobs are labelled
 * as if they were not. Reproduced (flag hard-read as 0), not fixed.
 *
 * Note the deliberate NULL fallthrough: a completed job that is neither ready
 * nor pending for billing gets an EMPTY Bucket Status cell.
 */
function billingBucketStatus(r) {
  const jobReopenFlag = 0; // see LEGACY BUG above
  if (jobReopenFlag === 1) return 'Reopned Job';
  const status = jdbcInt(r.job_status);
  const subJob = jdbcInt(r.sub_job_id);
  const ready = r.ready_for_billing === null || r.ready_for_billing === undefined ? '' : String(r.ready_for_billing);
  const readyYes = ready.toLowerCase() === 'yes';
  const readyNo = ready.toLowerCase() === 'no';
  if (status === 3 && readyYes) return 'Ready For billing-Feedback Pending';
  if (status === 5 && readyYes) return 'Ready for Billing';
  if (status === 3 && readyNo && subJob > 0) return 'Pending For Billing-Feedback Pending';
  if (status === 5 && readyNo && subJob > 0) return 'Pending for Billing';
  return null;
}

// "Bucket Status" — UtilityFunctions.getJobCurrentStatusNew.
function jobCurrentStatus(r) {
  const status = jdbcInt(r.job_status);
  switch (status) {
    case 20: return jdbcInt(r.tx_selfie_id) > 0 ? 'Started Inspection' : 'Started With OTP';
    case 2:  return 'Work In Progress';
    case 0:  return pendingToScheduleBucketStatus(r);
    case 1:  return pendingToStartBucketStatus(r);
    case 9:  return unconfirmedBucketStatus(r);
    case 10: return auditAndCompleteBucketStatus(r);
    case 6:  return 'Cancelled';
    case 3:
    case 5:  return billingBucketStatus(r);
    case 7:  return 'Enquiry';
    case 21: return 'Fulfillment On Hold';
    case 15: return 'Pending for Approval';
    default: return `Undefined : ${status}`;
  }
}

/*
 * "Aging" — UtilityFunctions.getAgingDaysWithTime. Whole 24-hour periods from
 * the TICKET CREATED instant to the job's own end point:
 *   open buckets (9,1,0,2,20,10,15,21) → now
 *   completed    (3,5)                 → checkout_date_time
 *   cancelled    (6)                   → cancel_date_time
 *   enquiry      (7)                   → enquiry_date_time
 * Anything else, or a missing end point, or a missing ticket date → 0.
 *
 * Both endpoints go through the minute-truncating format first (legacy fed this
 * function its already-formatted "dd MMM yyyy hh:mm a" strings), so we use
 * sheetDate() here rather than the raw parse — dropped seconds can move the
 * hour count across a 24h boundary on borderline rows.
 */
function agingDaysWithTime(r) {
  const ticketDt = sheetDate(r.ticket_created_date_time);
  if (!ticketDt) return 0;
  const status = jdbcInt(r.job_status);

  if ([9, 1, 0, 2, 20, 10, 15, 21].includes(status)) return calculateAgingDays(ticketDt, new Date());
  if (status === 3 || status === 5) {
    const end = sheetDate(r.checkout_date_time);
    return end ? calculateAgingDays(ticketDt, end) : 0;
  }
  if (status === 6) {
    const end = sheetDate(r.cancel_date_time);
    return end ? calculateAgingDays(ticketDt, end) : 0;
  }
  if (status === 7) {
    const end = sheetDate(r.enquiry_date_time);
    return end ? calculateAgingDays(ticketDt, end) : 0;
  }
  return 0;
}

/*
 * "Pre-Defined TAT" — the promised turnaround in days, from a hand-maintained
 * service-category × city-tier matrix (JobDaoImpl 8010-8060). Kept as a literal
 * table because that is what it is: a business decision list, not a formula.
 *
 * Anything not in the matrix — including every job with no category or no city
 * tier, i.e. unconfirmed / enquiry / cancelled orders — falls back to 3 days.
 * (The legacy comments mislabel a couple of the category ids; the NUMBERS are
 * what the query keys on, so they are reproduced as-is.)
 */
const PREDEFINED_TAT = {
  1:  { 1: '3', 2: '3', 3: '5' },   // electrician
  5:  { 1: '3', 2: '3', 3: '5' },   // carpentry
  15: { 1: '3', 2: '5', 3: '7' },   // mason
  21: { 1: '3', 2: '3', 3: '5' },   // cycle & fitness
  12: { 1: '3', 2: '3', 3: '5' },   // plumbing
};

function preDefinedTat(r) {
  const category = r.fk_service_catg_id === null || r.fk_service_catg_id === undefined ? '' : String(r.fk_service_catg_id);
  const tier = r.tier === null || r.tier === undefined ? '' : String(r.tier);
  if (!category || !tier) return '3';
  const row = PREDEFINED_TAT[category];
  if (!row) return '3';
  return row[tier] ?? '3';   // an unknown tier keeps the default, as in legacy
}

/*
 * "OTA" (On Time Arrival) — did the technician check in on time?
 *
 * Both instants are minute-precision because legacy compared the two
 * "dd MMM yyyy - hh:mm a" strings it had already formatted.
 *
 *   same calendar day + checked in before the appointment   → Yes
 *   same calendar day + within 15 minutes after             → Yes
 *   same calendar day + more than 15 minutes after          → No
 *   different day     + checked in before the appointment   → Yes
 *   different day     + otherwise                           → No
 *   either instant missing                                  → null (blank cell)
 *
 * The appointment instant is `requested_date_time`'s DAY plus `requested_time`
 * when the latter exists, otherwise requested_date_time's own time-of-day.
 */
function otaValue(r) {
  const reqDay = datePart(r.requested_date_time);
  const requestedTime = notEmpty(r.requested_time) ? String(r.requested_time) : null;
  let requestedDt = null;
  if (requestedTime && reqDay) requestedDt = sheetDate(`${reqDay} ${requestedTime}`);
  else if (reqDay) requestedDt = sheetDate(r.requested_date_time);

  const checkinDt = sheetDate(r.checkin_date_time);
  if (!requestedDt || !checkinDt) return null;

  const sameDay = requestedDt.getFullYear() === checkinDt.getFullYear()
    && requestedDt.getMonth() === checkinDt.getMonth()
    && requestedDt.getDate() === checkinDt.getDate();

  if (sameDay) {
    if (checkinDt.getTime() < requestedDt.getTime()) return 'Yes';
    // DateUtils.calculateDateDiff floors to whole minutes and clamps at 0.
    const mins = Math.max(0, Math.floor((checkinDt.getTime() - requestedDt.getTime()) / 60000));
    return mins > 15 ? 'No' : 'Yes';
  }
  return checkinDt.getTime() < requestedDt.getTime() ? 'Yes' : 'No';
}

/*
 * "Pending Remarks" source text. Five branches, and the third/fourth compare
 * the two timestamps at DATE granularity only (legacy used ResultSet.getDate,
 * which discards the time) — so two events on the same day tie, and the tie
 * goes to `remarks`.
 *
 * Branch four is legacy's and reads oddly on purpose: for an ENQUIRY whose
 * enquiry date is later than its remarks date, it takes `cancel_comment` —
 * a cancel field on a non-cancelled job. Preserved.
 */
function remarksText(r) {
  const status = jdbcInt(r.job_status);
  const remarksDay = datePart(r.remarks_date_time);
  const cancelDay = datePart(r.cancel_date_time);
  const enquiryDay = datePart(r.enquiry_date_time);

  if (status === 6 && remarksDay && !cancelDay) return r.remarks ?? null;
  if (status === 6 && cancelDay && !remarksDay) return r.cancel_comment ?? null;
  if (status === 6 && cancelDay && remarksDay) {
    return cancelDay > remarksDay ? (r.cancel_comment ?? null) : (r.remarks ?? null);
  }
  if (status === 7 && enquiryDay && remarksDay) {
    return enquiryDay > remarksDay ? (r.cancel_comment ?? null) : (r.remarks ?? null);
  }
  if (status !== 6 && status !== 7) return r.remarks ?? null;
  return null;   // status 6 with neither date, or status 7 missing one
}

// ─────────────────────────────────────────────────────────────────────────────
// Row → sheet row
// ─────────────────────────────────────────────────────────────────────────────

/*
 * Turn one raw DB row into one sheet row, keyed by EXPORT_COLUMNS[].key.
 * `seqNumber` is the 1-based running row number the "No." column shows —
 * legacy's Jasper reportRowNumberColumn. The caller owns it because it spans
 * chunks.
 */
function mapExportRow(r, seqNumber) {
  const jobStatus = jdbcInt(r.job_status);
  const efrId = jdbcInt(r.fk_easyfixter_id);
  const subJobId = jdbcInt(r.sub_job_id);
  const previousEfrId = jdbcInt(r.previousEfrId);

  // ── Aging + TAT ───────────────────────────────────────────────────────────
  const aging = agingDaysWithTime(r);
  const tat = preDefinedTat(r);
  // In TAT (1) or out of TAT (0). Both inputs are always present here, so the
  // NumberFormatException branch that yielded null in legacy is unreachable.
  const tatStatus = aging <= Number(tat) ? 1 : 0;

  /*
   * SDA ("Same Day Arrival") and Estimate TAT are only computed for jobs that
   * have reached the field — statuses 2, 20, 10, 21, 15, 3, 5. Every other job
   * leaves both cells blank.
   */
  const sdaEligible = [2, 20, 10, 21, 15, 3, 5].includes(jobStatus);
  let sdaStatus = null;
  let estimateTAT = null;
  if (sdaEligible) {
    const checkinDay = datePart(r.checkin_date_time);
    const apptDay = datePart(r.original_appointment_date_time);
    if (checkinDay && apptDay) sdaStatus = checkinDay <= apptDay ? 1 : 0;

    if (notEmpty(r.estimate_sent_on)) {
      /*
       * Note the argument order — this measures from CHECKOUT to ESTIMATE SENT,
       * so an estimate raised before checkout produces a negative TAT. That is
       * legacy's order and the numbers in the existing sheets reflect it.
       *
       * Legacy dereferenced app_checkout_date_time without a null check here;
       * on a job with an estimate but no app checkout it threw an NPE inside
       * the RowMapper, which aborted the ENTIRE export and returned an empty
       * file with nothing but a stack trace in the log. We leave the cell blank
       * instead — a missing value in one row must not cost the whole report.
       */
      const checkoutDt = parseDbDateTime(r.app_checkout_date_time);
      const sentDt = parseDbDateTime(r.estimate_sent_on);
      estimateTAT = (checkoutDt && sentDt) ? calculateAgingDays(checkoutDt, sentDt) : null;
    }
  }

  // Escalation TAT — escalation → checkout, completed jobs only. Same NPE
  // guard as above (legacy read escalated_on / checkout_date_time unchecked).
  let escalationTAT = null;
  if ((jobStatus === 3 || jobStatus === 5) && jdbcInt(r.is_escalated) === 1) {
    const escalatedDt = parseDbDateTime(r.escalated_on);
    const checkoutDt = parseDbDateTime(r.checkout_date_time);
    escalationTAT = (escalatedDt && checkoutDt) ? calculateAgingDays(escalatedDt, checkoutDt) : null;
  }

  // ── Margin ────────────────────────────────────────────────────────────────
  const totalCharge = jdbcInt(r.total_charge);
  const efCharge = jdbcInt(r.easyfix_charge);
  let margin = null;
  if (totalCharge > 0) {
    const f32 = Math.fround(Math.fround(efCharge * 100) / totalCharge);
    const asDouble = javaFloatToDouble(f32);
    // Legacy floors any non-positive margin to 0 rather than showing it.
    margin = asDouble > 0 ? asDouble : 0;
  }

  // ── Estimate status trio ──────────────────────────────────────────────────
  // The SENT date comes from the FIRST estimate row, the STATUS from the LAST
  // one — legacy selected them from two different sources and we keep that.
  const estimateSentOnDate = notEmpty(r.estimate_sent_on) ? sheetDate(r.estimate_sent_on) : null;
  const estimateStatusCode = jdbcInt(r.estimate_status);
  let estimateStatus = null;
  let estimateApprovedOnDate = null;
  let estimateRejectedOnDate = null;
  if (estimateSentOnDate) {
    if (estimateStatusCode === 0) {
      estimateStatus = 'Sent';
    } else if (estimateStatusCode === 1) {
      estimateStatus = 'Approved';
      estimateApprovedOnDate = sheetDate(r.estimate_action);
    } else if (estimateStatusCode === 2) {
      estimateStatus = 'Rejected';
      estimateRejectedOnDate = sheetDate(r.estimate_action);
    }
    // Any other code leaves all three blank, as in legacy.
  }

  // ── Appointment instants ──────────────────────────────────────────────────
  // Both are a DATE column's day plus a separate TIME column. If the time part
  // is missing, the Original Appointment cell stays blank (legacy only built it
  // when both halves existed) while the Appointment cell falls back to the
  // date column's own time-of-day.
  const origApptDay = datePart(r.original_appointment_date_time);
  const origApptTime = notEmpty(r.original_appointment_time) ? String(r.original_appointment_time) : null;
  const originalAppointmentDate = (origApptDay && origApptTime)
    ? sheetDate(`${origApptDay} ${origApptTime}`)
    : null;

  const reqDay = datePart(r.requested_date_time);
  const reqTime = notEmpty(r.requested_time) ? String(r.requested_time) : null;
  const appointmentDate = (reqDay && reqTime)
    ? sheetDate(`${reqDay} ${reqTime}`)
    : sheetDate(r.requested_date_time);

  // ── Cancel / Enquiry trio ─────────────────────────────────────────────────
  // One physical set of columns serves two different lifecycle ends, so each
  // value is prefixed with which one it is. A job that is neither cancelled nor
  // an enquiry leaves all three blank.
  const cancelDateVal = sheetDate(r.cancel_date_time)
    ?? (jobStatus === 7 ? sheetDate(r.enquiry_date_time) : null);

  let cancelComment = null;
  if (jobStatus === 6) cancelComment = notEmpty(r.cancel_comment) ? `Cancel - :${r.cancel_comment}` : null;
  else if (jobStatus === 7) cancelComment = notEmpty(r.enquiry_comment) ? `Enquiry - :${r.enquiry_comment}` : null;

  let cancelReason = null;
  if (jobStatus === 6) cancelReason = notEmpty(r.cancelReason2) ? `Cancel - :${r.cancelReason2}` : null;
  else if (jobStatus === 7) cancelReason = notEmpty(r.enquiryReason) ? `Enquiry - :${r.enquiryReason}` : null;

  const cancelBy = (jobStatus === 6 || jobStatus === 7)
    ? (r.cancel_by_user !== null && r.cancel_by_user !== undefined ? String(r.cancel_by_user) : null)
    : null;

  // ── Pending Remarks ───────────────────────────────────────────────────────
  // LEGACY BUG: the value is `remarksDateTime + " : " + remarks` with no null
  // check on the date half, so a job carrying remarks but no remarks_date_time
  // exports the literal "null : <remarks>". Reproduced.
  const remarks = remarksText(r);
  const pendingRemarks = remarks !== null && remarks !== undefined
    ? `${fmtDdMmmYyyyHhMmA(r.remarks_date_time) ?? 'null'} : ${remarks}`
    : null;

  // ── Scheduled-before-appointment ──────────────────────────────────────────
  // DATE-granularity comparison (legacy used getDate on both). Null-vs-null,
  // or either side missing, renders as 0 rather than blank — the column is a
  // 1/0 flag and legacy's `!= null && equalsIgnoreCase("yes") ? 1 : 0` makes
  // "unknown" indistinguishable from "no".
  const schedDay = datePart(r.scheduled_date_time);
  const apptDayForFlag = datePart(r.original_appointment_date_time);
  let scheduledBefore = null;
  if (schedDay && apptDayForFlag) scheduledBefore = schedDay > apptDayForFlag ? 'No' : 'Yes';

  const ota = otaValue(r);

  /*
   * Owner columns. `owner_user` is tbl_user.user_name joined off
   * J.job_client_owner, and legacy piped it into TWO different columns —
   * "Current OWNER" (renamed from "JobClient Owner") and "Client Owner" —
   * with an empty string, not null, when the user is missing.
   */
  const ownerUser = r.owner_user !== null && r.owner_user !== undefined ? String(r.owner_user) : '';

  return {
    no: seqNumber,
    jobId: jdbcInt(r.job_id),
    jobRefId: r.job_reference_id ?? null,
    branchDetails: r.branch_details ?? null,
    // The per-job customer name wins over the customer master's; some flows
    // book under a name that differs from the master record on purpose.
    customerName: r.job_customer_name ?? r.customer_name ?? null,
    // Building ONLY. Legacy concatenated building + ", " + landmark + ", " +
    // address, which produced ", , " noise on the many rows with only one part
    // filled in. Changed by agreement for this migration.
    customerAddress: r.building ?? null,
    pincode: r.pin_code !== null && r.pin_code !== undefined ? String(r.pin_code).trim() : null,
    city: r.city_name !== null && r.city_name !== undefined ? String(r.city_name) : '',
    state: r.state_name !== null && r.state_name !== undefined ? String(r.state_name) : '',
    aging,
    visitNumber: jdbcInt(r.visit_number),
    status: homeJobStatus(jobStatus, efrId, subJobId),
    currentStatus: jobCurrentStatus(r),
    client: r.client_name !== null && r.client_name !== undefined ? String(r.client_name) : '',
    clientRefId: r.client_ref_id ?? null,
    category: r.service_catg_name !== null && r.service_catg_name !== undefined ? String(r.service_catg_name) : '',
    clientSpoc: r.client_spoc_name ?? null,
    tier: r.tier !== null && r.tier !== undefined ? `Tier - ${r.tier}` : '',
    jobClientOwner: ownerUser,
    projectManager: r.project_manager !== null && r.project_manager !== undefined ? String(r.project_manager) : '',
    /*
     * LEGACY BUG: written as `"" + e.getZonalManager() != null ? "" + ... : ""`.
     * `+` binds tighter than `!=`, so the test is `("" + value) != null`, which
     * is ALWAYS true, and the "" fallback is unreachable. A city with no zonal
     * user therefore exports the four-character string "null", not a blank.
     */
    zonalManager: r.zonal_manager === null || r.zonal_manager === undefined ? 'null' : String(r.zonal_manager),
    /*
     * NEW column. tbl_job.job_primary_spoc — verified to exist
     * (migrations/executed/2026-07-03-add-job-primary-spoc.sql,
     * `VARCHAR(100) NULL`), so it is sourced from there rather than the
     * J.job_owner fallback.
     *
     * Read off `J.*` on purpose instead of naming the column in the SELECT:
     * it is a PROD-only column absent on some DBs (see the probe in
     * services/job.service.js::hasJobPrimarySpocColumn), and naming it would
     * make the whole export 500 there. Via `J.*` it simply arrives undefined
     * and the cell is blank.
     *
     * It holds a tbl_user.user_id — a snapshot of who the client's primary SPOC
     * was the day the job was booked — kept as a string because the column is a
     * VARCHAR and pre-2026 rows are not guaranteed numeric.
     */
    jobOwner: r.job_primary_spoc !== null && r.job_primary_spoc !== undefined ? String(r.job_primary_spoc) : null,
    scheduledBY: r.scheduled_by !== null && r.scheduled_by !== undefined ? String(r.scheduled_by) : '',
    auditBy: r.checkout_by !== null && r.checkout_by !== undefined ? String(r.checkout_by) : '',
    ticketCreatedDate: sheetDate(r.ticket_created_date_time),
    bookingDate: sheetDate(r.created_date_time),
    originalAppointmentDate,
    appointmentDate,
    checkInDateTime: sheetDate(r.checkin_date_time),
    appCheckoutDate: sheetDate(r.app_checkout_date_time),
    auditAndCheckout: sheetDate(r.checkout_date_time),
    // "Was an estimate ever shared" is inferred from the approval timestamp,
    // not from tbl_estimate_details — legacy's definition, kept.
    isEstimateSent: notEmpty(r.approval_sent_on_date_time) ? 1 : 0,
    estimateSentOnDate,
    estimateApprovedOnDate,
    estimateRejectedOnDate,
    estimateStatus,
    estimateTAT,
    cancelledDate: cancelDateVal,
    cancelComment,
    cancelReason,
    cancelBy,
    /*
     * LEGACY BUG: written as a bare `"" + e.getJobDesc()` with no null check at
     * all, so a job with no description exports the string "null".
     */
    jobDesc: r.job_desc === null || r.job_desc === undefined ? 'null' : String(r.job_desc),
    /*
     * LEGACY BUG (different shape from the one above): `"" + e.getJobType() !=
     * null ? e.getJobType() : ""` — the guard is always true because of operator
     * precedence, so the "" fallback is DEAD and the raw null passes straight
     * through. The cell ends up genuinely blank rather than "" — same visual
     * result in a spreadsheet, different value on the wire. Kept as null.
     */
    jobType: r.job_type ?? null,
    /*
     * LEGACY BUG: bare `"" + e.getEfrSpecialNote()`, same as Job Description —
     * a job with no technician note exports the string "null".
     * (The column is called "Client Comment" but its source is
     * tbl_job.efr_special_notes. Legacy's naming; not a mapping mistake.)
     */
    clientComment: r.efr_special_notes === null || r.efr_special_notes === undefined ? 'null' : String(r.efr_special_notes),
    /*
     * LEGACY BUG (same precedence trap as Job Type): the "" fallback is
     * unreachable for both TX name columns, so an unassigned job leaves them
     * null instead of empty.
     */
    txName: r.efr_name ?? null,
    txId: efrId > 0 ? efrId : null,
    preTxName: r.previousEfrName ?? null,
    preTxId: previousEfrId > 0 ? previousEfrId : null,
    ota: ota === null ? null : (ota.toLowerCase() === 'yes' ? 1 : 0),
    preDefinedtat: Number(tat),
    tatStatus,
    sdaStatus,
    rating: jdbcInt(r.customer_rating) > 0 ? jdbcInt(r.customer_rating) : null,
    customerRatingComment: r.rating_comment ?? null,
    // `>= 0` in legacy, i.e. always true for a getInt result — a job with no
    // tbl_job_transaction row exports 0, not a blank.
    totalCharge,
    efShare: efCharge > 0 ? efCharge : null,
    margin,
    clientOwner: ownerUser,
    pendingDueTo: r.due_to_type ?? null,
    pendingReason: r.pending_reason_desc ?? null,
    pendingRemarks,
    readyForBilling: r.ready_for_billing ?? null,
    /*
     * Hard-coded null. `confirmationAction` is never populated by the legacy
     * RowMapper, so the column has always been empty; it is kept so the sheet's
     * column count and downstream cell references do not shift.
     */
    confirmationAction: null,
    scheduledBeforeApointment: scheduledBefore === 'Yes' ? 1 : 0,
    // Hard-coded constants in legacy — the real calculations were commented out
    // (JobDaoImpl 7956-8038) and never re-enabled. Kept verbatim so the columns
    // stay in place.
    closedOnApp: 'N/A',
    agingSlab: 'Not in use',
    verticalName: r.vertical_name ?? null,
    verticalhead: r.verticaHead ?? null,
    verticalManager: r.verticalManager ?? null,
    firstTimeSchedulingDate: sheetDate(r.original_scheduling_date_time),
    firstScheduleBY: r.firstScheduleBY !== null && r.firstScheduleBY !== undefined ? String(r.firstScheduleBY) : '',
    isEscalated: jdbcInt(r.is_escalated),
    firstEscalatedOnDate: notEmpty(r.escalated_on) ? sheetDate(r.escalated_on) : null,
    escalationTAT,
  };
}

module.exports = { EXPORT_COLUMNS, fetchExportChunk, mapExportRow, buildExportWhere };
