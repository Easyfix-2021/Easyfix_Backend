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
 *   buildExportWhere(filters)             → {where, params, appliedDefaults}
 */

const { pool } = require('../db');
const logger = require('../logger');
/*
 * Job Stage Access. lib/job-stages.js is DB-free and requires nothing from
 * services/, so pulling it in here cannot create a require cycle. Using the
 * SAME helper services/job.service.js uses is the point: a second copy of the
 * stage → status map is a second place for the sheet to disagree with the
 * table.
 */
const { stageVisibleStatuses } = require('../lib/job-stages');
/*
 * ONE memoised probe for tbl_client.vertical_id, shared with list(). The
 * verticals RBAC scope is skipped when the column is absent — if this module
 * probed separately it could answer differently across a migration and scope
 * the sheet differently from the screen. job.service does NOT require this
 * module, so there is no cycle; routes/admin/jobs.js already loads both.
 */
const { hasClientVerticalIdColumn, MOBILE_MIN_DIGITS } = require('./job.service');

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
  { header: 'Job Id',                     key: 'jobId',                     type: 'id'      },
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
  { header: 'Current TX Id',              key: 'txId',                      type: 'id'      },
  { header: 'Previous TX Name',           key: 'preTxName',                 type: 'string' },
  { header: 'Previous TX Id',             key: 'preTxId',                   type: 'id'      },
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
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CRM UI's FILTER VOCABULARY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * THE BUG (operator report, 2026-08-20): "Manage Job → Export. With Closed Job
 * filter, downloaded Open orders data." That is not "the filter was ignored" —
 * it is the EXACT COMPLEMENT of what was asked for, and here is the mechanism.
 *
 * routes/admin/jobs.js validates /export.xlsx with the SAME `listQuery` schema
 * the jobs LIST uses and handed req.query straight to buildClauses(). But
 * buildClauses only ever spoke the LEGACY Java "Filter Job" panel's vocabulary
 * — clientIdFromUI, dateFrom, dateTo, custName, svcCatgId, and a `status` that
 * is a free-text TOKEN matched by SUBSTRING (see STATUS_TOKEN_CODES). The UI
 * speaks clientId, startDate, endDate, customerQ, categoryId, and NUMERIC
 * `statuses`. Nothing translated between them, so every UI filter arrived
 * `undefined`, no clause was emitted, and the no-filter guard at the bottom
 * substituted "open jobs created in the last 6 months" for the request. From
 * the production log, two consecutive lines:
 *
 *     GET /api/admin/jobs/export.xlsx?statuses=3%2C5&startDate=2026-08-01&endDate=2026-08-17
 *     Export jobs xlsx · status=- clientId=- from=Sat Aug 01 2026 05:30:00 …
 *
 * `statuses=3,5` on the wire, `status=-` in the handler. The guard's second
 * clause was `J.job_status NOT IN (3, 5, 6, 7)` — it excluded precisely the two
 * codes she asked for. Measured before this change, EVERY one of these produced
 * the identical WHERE:
 *
 *     buildExportWhere({ statuses:'3,5', startDate, endDate })  ┐
 *     buildExportWhere({ q:'ravi' })                            ├ all →
 *     buildExportWhere({ clientId:'12,34' })                    │
 *     buildExportWhere({ scope, allowedStages })                ┘
 *       WHERE J.created_date_time >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
 *         AND J.job_status NOT IN (3, 5, 6, 7)
 *
 * WHY BOTH VOCABULARIES SURVIVE. The legacy `status` is a free-text token
 * ('completed', 'unconfirmed', 'acknowledge') matched by substring, and it
 * carries behaviour numeric codes cannot express — most obviously the
 * acknowledge/scheduling technician predicate below, a documented legacy bug
 * reproduced on purpose. Reverse-mapping numeric codes into those tokens would
 * be lossy. So a NUMERIC status/statuses takes a direct J.job_status IN (…)
 * path that bypasses the token layer entirely, and a NON-numeric `status`
 * keeps today's legacy behaviour untouched.
 *
 * REACHABILITY, so nobody mis-reads the risk: middleware/validate.js runs Joi
 * with `stripUnknown: true`, so over HTTP only listQuery keys ever reach this
 * function. The legacy names are unreachable from the route today; they exist
 * for buildExportWhere()'s public contract and for direct callers. That is why
 * the UI path was ADDED rather than the legacy path REPLACED.
 *
 * THE REFERENCE IMPLEMENTATION for every UI-vocabulary predicate below is
 * services/job.service.js list(). The export is meant to be "the rows on
 * screen, minus the page boundary"; where this file and list() disagree about
 * what a filter MEANS, the sheet stops mirroring the table and nobody can see
 * it from the file. Each mirrored predicate names list() in its comment, and
 * tests/job-export-filters.test.js pins the pairs that matter.
 */

/*
 * `dateType` → the column startDate/endDate apply to. MUST STAY IDENTICAL to
 * DATE_TYPE_COLUMN in services/job.service.js (only the table alias differs:
 * `j` there, `J` here). If the two drift, the sheet covers a different window
 * than the table the operator was looking at. An unknown value falls back to
 * created_date_time exactly as list() does, so a stale bookmark still works.
 *
 * This is a DIFFERENT map from the legacy DATE_TYPE_COLUMN above, whose keys
 * are the legacy picker's tokens ('createddate', 'checkoutdatetime', …). The
 * two token sets are disjoint, so both can be consulted without ambiguity: the
 * legacy tokens pair with dateFrom/dateTo, these with startDate/endDate.
 */
const UI_DATE_TYPE_COLUMN = Object.freeze({
  booked:    'J.created_date_time',
  scheduled: 'J.scheduled_date_time',
  completed: 'J.checkout_date_time',
  ticket:    'J.ticket_created_date_time',
  requested: 'J.requested_date_time',
  /*
   * cancel_date_time is NULL on every job that was never cancelled, and
   * `NULL >= DATE(?)` is NULL → false. So a window on this column is also a
   * `job_status = 6` filter. Intended (see the fuller note on DATE_TYPE_COLUMN
   * in services/job.service.js), and identical on both sides — which is the
   * whole point of this map: the sheet must cover the same rows as the table.
   */
  cancelled: 'J.cancel_date_time',
});

/*
 * "The customer name ON THIS JOB" — job.service's JOB_CUSTOMER_NAME_EXPR with
 * this module's aliases. NOT imported: that constant has `j`/`cu` baked in, and
 * MySQL table-alias case sensitivity is platform-dependent (it follows
 * lower_case_table_names), so a fragment written for `j` cannot be trusted to
 * bind to `J`. The SHAPE must match, and the NULLIF/TRIM is the load-bearing
 * part — a plain COALESCE blanks the name for every job whose
 * job_customer_name is an empty string rather than NULL.
 */
const JOB_CUSTOMER_NAME_EXPR = `COALESCE(NULLIF(TRIM(J.job_customer_name), ''), C.customer_name)`;

/*
 * `q` — the free-text search, one placeholder per term, in list()'s order.
 * Same eleven terms, so a search that narrows the screen narrows the sheet by
 * the same rule. Changing one side without the other is the "export is wider
 * than the table" bug in its purest form.
 *
 * The owner term is an EXISTS rather than a join: FILTER_FROM deliberately
 * omits the ten tbl_user self-joins (see its docblock), and a self-contained
 * EXISTS keeps that promise — it introduces no outer alias and cannot fan a
 * job out into extra rows.
 */
const Q_TERMS = Object.freeze([
  'CAST(J.job_id AS CHAR) LIKE ?',
  'J.job_reference_id LIKE ?',
  'J.client_ref_id LIKE ?',
  `${JOB_CUSTOMER_NAME_EXPR} LIKE ?`,
  'C.customer_mob_no LIKE ?',
  'CL.client_name LIKE ?',
  'city.city_name LIKE ?',
  'EFR.efr_name LIKE ?',
  'EXISTS (SELECT 1 FROM tbl_user qow WHERE qow.user_id = J.job_owner AND qow.user_name LIKE ?)',
  'J.client_spoc_name LIKE ?',
  'J.client_spoc LIKE ?',
]);

/*
 * Normalise a filter that may arrive as a single number, a single-id string, a
 * CSV string ("12,34") or an array into a clean number[]. A local mirror of
 * `toIdArray` in services/job.service.js — that one is not exported. If you
 * change the parsing rule, change it in both.
 *
 * This is what `Number(clientIdFromUI) > 0` could not do: Number("12,34") is
 * NaN, so the legacy single-id test silently DROPPED every multi-select
 * filter instead of failing.
 */
function toIdArray(v) {
  if (v === null || v === undefined || v === '') return [];
  const raw = Array.isArray(v) ? v : String(v).split(',');
  return raw.map((s) => Number(String(s).trim())).filter((n) => Number.isFinite(n));
}

// Truthy across the three shapes a boolean-ish query param arrives in (real
// boolean, URLSearchParams string, numeric flag). Mirrors the assigned /
// reopen / noServices coercions in job.service list().
function isTrue(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

/*
 * The NUMERIC status selection, or [] when the caller is speaking the legacy
 * token vocabulary instead.
 *
 * `statuses` wins over `status` — the same precedence list() applies, so a UI
 * that pins both (the composite tabs do) cannot produce a different row set in
 * the sheet than on the screen.
 *
 * The /^\d+$/ test on `status` is the ONLY thing keeping the two vocabularies
 * apart: without it a legacy 'completed' would take the numeric path, and a UI
 * '3' would take the substring-token path — where it matches no token at all,
 * emits no status clause, and exports everything.
 */
function numericStatusCodes({ statuses, status }) {
  if (statuses !== null && statuses !== undefined && statuses !== '') {
    /*
     * SHORT-CIRCUIT, matching services/job.service.js list(): once `statuses`
     * is present it OWNS the status dimension, even when it parses to nothing.
     * Falling through to `status` on an empty list (an empty statuses[] array,
     * say) would emit a status clause the screen does not have, making the
     * sheet NARROWER than the table — the divergence this whole change exists
     * to close, reintroduced on an edge case.
     */
    return toIdArray(statuses);
  }
  const s = String(status ?? '').trim();
  if (/^\d+$/.test(s)) return [Number(s)];
  return [];
}

/*
 * ── THE listQuery COVERAGE LEDGER ────────────────────────────────────────────
 *
 * EVERY key validators/job.validator.js → listQuery accepts, and what this
 * module does with it. This map is not documentation ABOUT the code, it IS the
 * checked contract: tests/job-export-filters.test.js derives the key set from
 * `listQuery.describe().keys` and fails if the two disagree, so a filter added
 * to the schema tomorrow cannot be silently dropped here the way the whole UI
 * vocabulary was. The same test proves every 'filter' key actually emits a
 * predicate and every 'ignored' key emits none — a ledger that only claimed
 * coverage would rebuild the original bug inside its own regression test.
 *
 *   'filter'   → emits its own predicate
 *   'modifier' → changes another filter's predicate, emits none of its own
 *   'ignored'  → deliberately emits nothing; the note says why
 */
const FILTER_COVERAGE = Object.freeze({
  q:                ['filter',   'eleven-term OR, list()s columns — see Q_TERMS'],
  status:           ['filter',   'numeric → J.job_status IN (…); non-numeric → legacy tokens'],
  statuses:         ['filter',   'J.job_status IN (…); wins over status, as in list()'],
  assigned:         ['filter',   'J.fk_easyfixter_id IS [NOT] NULL'],
  noServices:       ['filter',   'job_status = 0 + NOT EXISTS an active tbl_job_services row'],
  clientId:         ['filter',   'J.fk_client_id IN (…) — csvIds, single id OR CSV'],
  cityId:           ['filter',   'A.city_id IN (…) — csvIds; the ADDRESS column, as in list()'],
  projectManagerId: ['filter',   'EXISTS tbl_vertical_mapping with user_type = 1'],
  zonalManagerId:   ['filter',   'city.state_user IN (…) — the citys zonal owner'],
  ownerId:          ['filter',   'J.job_owner = ? (shared name with the legacy vocabulary)'],
  easyfixerId:      ['filter',   'J.fk_easyfixter_id = ? (shared name)'],
  customerId:       ['filter',   'J.fk_customer_id = ?'],
  customerQ:        ['filter',   'job-customer-name / mobile LIKE %v%'],
  clientRef:        ['filter',   'J.client_ref_id LIKE %v%'],
  efrMobile:        ['filter',   'EFR.efr_no LIKE %v%'],
  pin:              ['filter',   'A.pin_code LIKE %v%'],
  stateId:          ['filter',   'city.state_id = ? (shared name)'],
  categoryId:       ['filter',   'J.fk_service_catg_id = ?'],
  verticalId:       ['filter',   'EXISTS tbl_vertical_mapping — independent of the verticals SCOPE'],
  sourceType:       ['filter',   'J.source_type = ?'],
  rating:           ['filter',   'TERBC.customer_rating (shared name; legacy predicate)'],
  reopen:           ['filter',   'J.job_reopen_flag'],
  dueTo:            ['filter',   'J.remarks LIKE — structured tag OR loose free text'],
  zonalId:          ['filter',   'city.state_user = ? — LEGACY reading, see ZONAL_ID_COLLISION'],
  startDate:        ['filter',   'dateCol >= DATE(?)'],
  endDate:          ['filter',   'dateCol < DATE(?) + INTERVAL 1 DAY'],
  quotationStatus:  ['filter',   'EXISTS quotation_details + list()s status carve-outs'],
  requestedBefore:  ['filter',   'J.requested_date_time < NOW() / < ?'],
  dateType:         ['modifier', 'picks the column startDate/endDate apply to'],
  /*
   * list() accepts isEscalated and deliberately emits NO clause (the flag is
   * not a tbl_job column — see the long note in list()). Matching that no-op
   * is what keeps export == table; "fixing" it here alone would break parity.
   */
  isEscalated:      ['ignored',  'list() emits no clause for it either'],
  /*
   * CANNOT SUPPORT. The canonical tri-state predicate (job.service
   * offerStateSql → offerRowScope) hard-codes the outer alias `j`; this
   * module's tbl_job alias is `J`, and MySQL table-alias case sensitivity
   * follows lower_case_table_names — so re-binding the fragment would
   * correlate correctly on one deploy and silently collapse to a self-join on
   * another. Re-implementing the tri-state by hand is the second
   * implementation this file exists to avoid. It only ever NARROWS the
   * Pending-for-Scheduling bucket, whose status/assigned pins ARE honoured, so
   * the sheet is a SUPERSET of the screen — never a leak. The route logs a
   * warning when it is supplied, so the drop is loud rather than silent.
   */
  offerState:       ['ignored',  'cannot bind list()s j-aliased fragment to alias J'],
  /*
   * CANNOT SUPPORT, and unlike offerState the failure mode would be a LEAK
   * rather than a superset — which is why it is not half-implemented.
   *
   * sectionPredicate() identifies a client-actioned job by enum_reason_id, and
   * those ids are ROWS: reasonIds() reads them from action_taken_reason at
   * runtime, because they differ per environment. This module's where() is
   * synchronous and holds no pool, so it cannot do that lookup. The service's
   * own no-ids fallback (`IN (0, 0)`) is safe where it lives — it makes the
   * conversation sections empty and lets every job fall through to a date
   * bucket — but here it would mean an operator exporting "Actioned By Client"
   * receives a sheet of jobs the client never actioned. Wrong rows, presented
   * as right ones.
   *
   * Dropping it instead yields every unconfirmed job matching the other
   * filters: a superset of the section, and the route logs the drop.
   */
  section:          ['ignored',  'needs reason ids from a DB read where() cannot do'],
  /*
   * Keyset pagination requires the sort key to BE the cursor, and the cursor
   * is J.job_id DESC (see fetchExportChunk). An arbitrary ORDER BY would skip
   * and duplicate rows across chunks — silently, which is worse than
   * unsorted. Sort the sheet in Excel.
   */
  sortBy:           ['ignored',  'the cursor IS the sort key; see fetchExportChunk'],
  sortDir:          ['ignored',  'as sortBy'],
  // The export streams the WHOLE result set in keyset chunks. A page boundary
  // is the one thing it must not inherit; that is not a dropped filter.
  limit:            ['ignored',  'the export is not paged'],
  offset:           ['ignored',  'the export is not paged'],
});

/*
 * The listQuery keys the operator can set that this endpoint cannot apply.
 * The route logs them when present, so "my filter did nothing" is answerable
 * from the log instead of from a code read — the original bug was invisible
 * precisely because nothing ever said a filter had been dropped.
 *
 * limit/offset are NOT here (dropping the page boundary is the export's job),
 * and neither is isEscalated (list() ignores it identically, so the sheet
 * still matches the screen). Derived from FILTER_COVERAGE so the list cannot
 * drift from the ledger.
 */
const UNAPPLIED_FILTERS = Object.freeze(
  Object.keys(FILTER_COVERAGE).filter(
    (k) => FILTER_COVERAGE[k][0] === 'ignored' && !['limit', 'offset', 'isEscalated'].includes(k),
  ),
);

/*
 * ZONAL_ID_COLLISION — `zonalId` means two different things in the two
 * vocabularies, and it is the one name they cannot share:
 *   legacy export UI  : the ZONAL MANAGER → tbl_city.state_user
 *   listQuery / list() : the ZONE          → tbl_zone_master via
 *                                            tbl_zone_city_mapping
 *
 * The LEGACY reading is kept, deliberately, because nothing reachable sends
 * the other one: Easyfix_CRM_UI's "Zonal" control was rewired on 2026-08-18 to
 * send `zonalManagerId` (its own comment: "Zonal MANAGERS, not zones"), and no
 * control writes filters.zonalId any more — the export URL builder still
 * forwards the field, but it is always ''. `zonalManagerId` carries the same
 * city.state_user predicate under the name listQuery gives it, so the
 * capability the UI actually uses is honoured either way.
 *
 * If a caller ever DOES send a zone id here it will be matched against user
 * ids and quietly return the wrong rows, so the route logs `zonalId` when it
 * is supplied. Revisit this the day a zone control ships.
 */

/*
 * ── KEEPING THE EXPORT BOUNDED ───────────────────────────────────────────────
 *
 * Legacy had one rule: "any filter at all lifts the cap" (its `flage` flag).
 * That rule is unsafe now that the UI's filters actually reach this function.
 * `reopen=false` ALONE would satisfy it and emit
 *   WHERE (J.job_reopen_flag = 0 OR J.job_reopen_flag IS NULL)
 * over ~450k rows with no date and no status bound — as would assigned=false,
 * sourceType, and a single-character `q` (listQuery allows length 1), which
 * becomes eleven leading-wildcard LIKEs across a full scan. Before this change
 * every export was capped, so shipping that would be a NEW production-load
 * incident wearing a bug fix's clothes.
 *
 * ONE RULE: only a filter that BOUNDS THE ROW COUNT BY ITSELF lifts the
 * default window, and there are exactly two kinds.
 *
 *   1. An EQUALITY on an identity column — one job, one customer, one
 *      technician, one client reference. Bounded by what the entity is.
 *   2. A COMPLETE date window (both ends). It replaces the default window
 *      with the operator's own.
 *
 * Everything else — sets, ranges, LIKEs, booleans and dimension FKs (client,
 * city, state, status, category, vertical, owner, PM, ZM, q) — NARROWS but
 * does not BOUND, so the default window stays on top of it. A half-open window
 * (startDate with no endDate, or the reverse) does not bound either; the
 * default floor stays and simply wins whenever it is the stricter of the two.
 *
 * RBAC NEVER LIFTS ANYTHING. A scope is the boundary of what an operator may
 * ever see, not a filter they chose; letting it lift the cap would mean a
 * scoped operator with no filters pulls their entire client's history.
 *
 * WHAT AN OPERATOR GETS WITH NO FILTERS AT ALL: jobs created in the last 6
 * months whose status is not one of 3/5/6/7 — i.e. exactly what every export
 * returned before this change. That default is unchanged on purpose; it is the
 * only reason the old exporter never took the box down a second time.
 */
const DEFAULT_WINDOW_MONTHS = 6;
// 3/5 completed, 6 cancelled, 7 enquiry — the terminal statuses, which carry
// years of history behind them.
const TERMINAL_STATUSES = Object.freeze([3, 5, 6, 7]);

/*
 * Build the WHERE clauses.
 *
 * Takes BOTH vocabularies (see the block above), plus the two RBAC inputs the
 * route attaches — `scope` and `allowedStages` — which are NOT query params
 * and must never be settable by one.
 */
function buildClauses(filters = {}) {
  const {
    // ── Legacy "Filter Job" panel vocabulary ────────────────────────────────
    jobsId, clientIdFromUI, easyfixerMobileNumber,
    status, svcCatgId, custName, clientReferenceId, pinCode,
    verticalIdentity, dateFrom, dateTo, dateType, bucketAgingRange, bucketStatus,
    openDueToReason,
    // ── Shared names: identical meaning in both vocabularies ────────────────
    easyfixerId, ownerId, cityId, stateId, zonalId, rating,
    // ── CRM UI / listQuery vocabulary (see FILTER_COVERAGE) ─────────────────
    q, statuses, assigned, noServices, clientId, projectManagerId, zonalManagerId,
    customerId, customerQ, clientRef, efrMobile, pin, categoryId, verticalId,
    sourceType, reopen, dueTo, startDate, endDate, quotationStatus, requestedBefore,
    // ── RBAC, attached by the route ─────────────────────────────────────────
    scope, allowedStages,
    /*
     * Whether tbl_client.vertical_id exists on this deploy. fetchExportChunk
     * passes job.service's memoised probe so the verticals SCOPE behaves
     * exactly as it does on the list. Defaults to TRUE for direct callers: if
     * the column is genuinely absent the query fails loudly with "Unknown
     * column", which is the failure mode we want — silently skipping an RBAC
     * predicate is the one outcome that must never happen by default.
     */
    hasClientVerticalCol = true,
  } = filters;

  const clauses = [];
  const params = [];
  const push = (sql, ...vals) => { clauses.push(sql); params.push(...vals); };

  /*
   * The two facts the bound is decided from. See "KEEPING THE EXPORT BOUNDED".
   * `pointIdentity` is set ONLY by equality-on-an-identity-column filters;
   * `explicitWindow` only by a window with BOTH ends.
   */
  let pointIdentity = false;
  let explicitWindow = false;
  // Whether the caller pinned job_status themselves (either vocabulary, or a
  // filter that implies a status). RBAC stage access does NOT count.
  let statusPinned = false;
  // Defaults this build imposed that the caller did not ask for — surfaced so a
  // short sheet is explicable rather than mysterious.
  const appliedDefaults = [];
  // The column the fallback window lands on — the operator's axis when they
  // chose one, so the default bound cannot contradict their own.
  let defaultDateCol = 'J.created_date_time';

  // ── RBAC ──────────────────────────────────────────────────────────────────
  /*
   * ⚠ THIS SECTION WAS ENTIRELY ABSENT UNTIL 2026-08-20. The route passed
   * req.scope and req.allowedStages and its own comment said "Drop either one
   * and the export silently leaks rows the operator cannot see in the table" —
   * and both WERE dropped: `grep allowedStages job-export.service.js` returned
   * nothing. A scope-restricted operator's sheet carried every client's rows.
   *
   * Mirrors services/job.service.js list() column for column, and it is
   * applied FIRST for the same reason list() does: an explicit clientId /
   * cityId filter then NARROWS WITHIN the allowed set. A caller cannot widen
   * their scope by naming a client outside it — the two predicates are ANDed,
   * so an out-of-scope clientId yields zero rows, never that client's rows.
   *
   * These predicates land in buildClauses(), which phase 1 of fetchExportChunk
   * uses to resolve job_ids. That is the only place they can work: phase 2
   * hydrates BY ID and re-filters nothing.
   */
  if (scope) {
    const c = scope.clients;
    const ci = scope.cities;
    const v = scope.verticals;
    if (c) {
      if (c.mode === 'none') push('1=0');
      else if (c.mode === 'allow' && c.ids.length) {
        push(`J.fk_client_id IN (${c.ids.map(() => '?').join(', ')})`, ...c.ids);
      }
    }
    if (ci) {
      if (ci.mode === 'none') push('1=0');
      else if (ci.mode === 'allow' && ci.ids.length) {
        /*
         * A.city_id — tbl_address, the SAME column list() scopes on (ad.city_id)
         * and the same one the cityId FILTER uses below. Two columns for one
         * concept inside one function is how a job whose address city has no
         * tbl_city row appears on screen and vanishes from the sheet; the
         * legacy code filtered cityId on city.city_id while the address is
         * where the value actually lives.
         *
         * NOTE the join asymmetry, which is deliberate and NOT changed here:
         * FILTER_FROM joins tbl_address with an extra `A.customer_id =
         * J.fk_customer_id` predicate that list()'s join does not have, and
         * EXPORT_SELECT's projection join carries the same predicate — so
         * phase 1 and phase 2 agree with each other. A job whose fk_address_id
         * points at another customer's address row therefore gets a NULL
         * address here and drops out of a city-scoped export while remaining
         * visible in the table. That direction is FAIL-SAFE (fewer rows, never
         * more); relaxing the join to match list() would widen a scoped
         * export, which is the one change that must not be made casually.
         */
        push(`A.city_id IN (${ci.ids.map(() => '?').join(', ')})`, ...ci.ids);
      }
    }
    if (v) {
      if (v.mode === 'none') push('1=0');
      else if (v.mode === 'allow' && v.ids.length && hasClientVerticalCol) {
        /*
         * CL.vertical_id — tbl_client's OWN vertical, which is what list()
         * scopes on (cl.vertical_id). NOT TVM.vertical_id: tbl_vertical_mapping
         * is MANY-TO-MANY and joined here without a user_type filter, so a
         * client whose own vertical is 5 but which carries a mapping row for
         * vertical 3 would be HIDDEN in the table and EXPORTED to an operator
         * scoped to vertical 3. An RBAC fix that widens is worse than no fix.
         */
        push(`CL.vertical_id IN (${v.ids.map(() => '?').join(', ')})`, ...v.ids);
      }
    }
  }

  /*
   * Job Stage Access — the union of statuses visible across the caller's
   * allowed stages, ANDed with (never replacing) any status filter below.
   * mode 'all' is unrestricted. An empty union means the caller may see no
   * stage at all, which is zero rows, not "everything". Same helper
   * (lib/job-stages.js) list() uses, so a stage's status set cannot mean one
   * thing on screen and another in the sheet.
   */
  if (allowedStages && allowedStages.mode === 'list') {
    const visible = [...stageVisibleStatuses(allowedStages.stages)];
    if (visible.length === 0) push('1=0');
    else push(`J.job_status IN (${visible.map(() => '?').join(', ')})`, ...visible);
    /*
     * ⚠ A STAGE GRANT PINS THE STATUS DIMENSION, so the default terminal-status
     * floor must NOT be ANDed on top of it.
     *
     * Without this the two predicates annihilate each other for any grant that
     * lives inside the terminal set. lib/job-stages.js gives 'audit-complete'
     * the visible set [3, 5] and 'cancelled' [6] — both entirely inside
     * TERMINAL_STATUSES — so the audit team's ordinary grant produced
     *
     *     J.job_status IN (3, 5) AND J.job_status NOT IN (3, 5, 6, 7)
     *
     * which is zero rows, always, with no error and no warning: a permanently
     * empty sheet for the people whose whole job is completed work. A MIXED
     * grant is worse, because the file looks plausible — ['unconfirmed',
     * 'audit-complete'] silently returned only the status-9 rows and dropped
     * every Audit & Complete row the operator can see on screen.
     *
     * Suppressing the floor here cannot widen anything: J.job_status IN (…) is
     * strictly narrower than no status predicate at all, and the DATE floor
     * below is untouched — that is what actually bounds the row count. The
     * status floor was only ever a default for "the caller said nothing about
     * status", and a stage grant is the caller's boundary saying exactly that.
     */
    statusPinned = true;
  }

  // ── Status ────────────────────────────────────────────────────────────────
  /*
   * A numeric selection takes the direct path and, critically, BLANKS the
   * legacy token string: the substring machinery below (and the status-driven
   * date-column pick, and the bucketStatus sub-filter) must not try to read
   * "3,5" as a token — it matches none of them, which is how a numeric status
   * used to mean "no status filter at all".
   */
  const uiStatusCodes = numericStatusCodes({ statuses, status });
  if (uiStatusCodes.length) {
    push(`J.job_status IN (${uiStatusCodes.map(() => '?').join(', ')})`, ...uiStatusCodes);
    statusPinned = true;
  }
  const statusStr = uiStatusCodes.length ? '' : String(status ?? '').trim();
  const statusLower = statusStr.toLowerCase();
  const hasToken = (t) => statusLower.includes(t);

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
      push(`J.job_status IN (${codes.map(() => '?').join(', ')})`, ...codes);
      statusPinned = true;
      if (requireEfr) clauses.push('J.fk_easyfixter_id IS NOT NULL');
    }
    /*
     * If the caller sends a status that matches no token at all, legacy
     * appended a bare " ) " and the query died with a syntax error — no sheet,
     * no error message the user could act on. We emit no status clause instead;
     * an unfiltered export beats a 500. (It is still BOUNDED: no status pin
     * means the default status floor below applies.)
     */
  }

  // ── Identity filters: the ones that BOUND the export by themselves ────────
  if (notEmpty(jobsId)) {
    // Legacy switched on the literal "REF" appearing in the value — the
    // reference ids look like "REF12345".
    if (String(jobsId).toUpperCase().includes('REF')) push('J.job_reference_id = ?', String(jobsId));
    else push('J.job_id = ?', Number(jobsId));
    pointIdentity = true;
  }

  if (notEmpty(easyfixerId)) { push('J.fk_easyfixter_id = ?', Number(easyfixerId)); pointIdentity = true; }

  /*
   * efr_no is a VARCHAR. Legacy inlined the mobile as a BARE NUMBER
   * (`EFR.efr_no = 9876543210`), which forces MySQL to numerically coerce the
   * whole column — non-SARGable, and it quietly matched rows with stray
   * whitespace. Binding a string keeps the index usable and is the comparison
   * that was actually intended. Deliberate, documented divergence.
   */
  if (notEmpty(easyfixerMobileNumber)) {
    push('EFR.efr_no = ?', String(easyfixerMobileNumber).trim());
    pointIdentity = true;
  }

  if (notEmpty(customerId)) { push('J.fk_customer_id = ?', Number(customerId)); pointIdentity = true; }

  if (notEmpty(custName)) {
    const v = String(custName).trim();
    // An all-digits value is a mobile number, anything else is a name. Legacy's
    // exact test was `customer.matches("[0-9]+")`. Only the mobile branch is an
    // identity match; `%name%` can select any number of rows.
    if (/^[0-9]+$/.test(v)) { push('C.customer_mob_no = ?', v); pointIdentity = true; }
    else push('C.customer_name LIKE ?', `%${v}%`);
  }

  if (notEmpty(clientReferenceId)) {
    // branch_details doubles as a client reference on some clients; the
    // `<> ''` guard stops an empty search term matching every blank row.
    const v = String(clientReferenceId).trim();
    push("(J.client_ref_id = ? OR (J.branch_details = ? AND J.branch_details <> ''))", v, v);
    pointIdentity = true;
  }

  // ── Dimension filters: they narrow, they do not bound ─────────────────────
  // clientId (csvIds: single id OR CSV) and the legacy single-id form. Both
  // land on J.fk_client_id, and both narrow WITHIN the clients scope above.
  const clientIdList = toIdArray(clientId);
  if (clientIdList.length) {
    push(`J.fk_client_id IN (${clientIdList.map(() => '?').join(', ')})`, ...clientIdList);
  }
  if (Number(clientIdFromUI) > 0) push('J.fk_client_id = ?', Number(clientIdFromUI));

  // cityId — csvIds. A.city_id, not city.city_id: see the cities-scope comment.
  const cityIdList = toIdArray(cityId);
  if (cityIdList.length) {
    push(`A.city_id IN (${cityIdList.map(() => '?').join(', ')})`, ...cityIdList);
  }

  if (Number(stateId) > 0) push('city.state_id = ?', Number(stateId));

  /*
   * zonalId is the ZONAL MANAGER (tbl_city.state_user) in THIS vocabulary —
   * NOT tbl_zone_master. See ZONAL_ID_COLLISION above before "correcting" it
   * to the zone-mapping table; list() reads the same name differently and the
   * route logs the param so the ambiguity is never silent.
   */
  if (Number(zonalId) > 0) push('city.state_user = ?', Number(zonalId));
  // zonalManagerId — listQuery's name for exactly the predicate above, and the
  // one the CRM's "Zonal" control actually sends. csvIds, as in list().
  const zmIdList = toIdArray(zonalManagerId);
  if (zmIdList.length) {
    push(`city.state_user IN (${zmIdList.map(() => '?').join(', ')})`, ...zmIdList);
  }

  if (Number(svcCatgId) > 0) push('J.fk_service_catg_id = ?', Number(svcCatgId));
  if (Number(categoryId) > 0) push('J.fk_service_catg_id = ?', Number(categoryId));
  if (Number(ownerId) > 0) push('J.job_owner = ?', Number(ownerId));

  // Prefix LIKE — still index-usable, so it stays exactly as legacy had it.
  if (notEmpty(pinCode)) push('A.pin_code LIKE ?', `${String(pinCode).trim()}%`);
  // listQuery's `pin` is list()'s CONTAINS form. Different name, different
  // wrap, both deliberate: the sheet must match the table for `pin`.
  if (notEmpty(pin)) push('A.pin_code LIKE ?', `%${String(pin).trim()}%`);

  // Legacy vertical filter: the mapping row reached through the FROM clause.
  if (Number(verticalIdentity) > 0) push('V.vertical_id = ?', Number(verticalIdentity));
  /*
   * listQuery's verticalId, mirroring list(): an EXISTS on the many-to-many
   * mapping, INDEPENDENT of the verticals SCOPE (which reads tbl_client). The
   * two must stay independent — a scope written against TVM and a filter
   * written against the V join can never both hold for different ids, and the
   * sheet comes back empty with nothing to explain it.
   */
  if (Number(verticalId) > 0) {
    push('EXISTS (SELECT 1 FROM tbl_vertical_mapping vm WHERE vm.client_id = J.fk_client_id AND vm.vertical_id = ?)', Number(verticalId));
  }
  // Project Manager — the user mapped to the job's client with user_type = 1.
  // Self-contained EXISTS, same shape as list().
  const pmIdList = toIdArray(projectManagerId);
  if (pmIdList.length) {
    push(
      `EXISTS (SELECT 1 FROM tbl_vertical_mapping vm WHERE vm.client_id = J.fk_client_id AND vm.user_type = 1 AND vm.user_id IN (${pmIdList.map(() => '?').join(', ')}))`,
      ...pmIdList,
    );
  }

  // Text CONTAINS filters — list()'s customary %v% wrap.
  if (notEmpty(clientRef)) push('J.client_ref_id LIKE ?', `%${String(clientRef).trim()}%`);
  if (notEmpty(efrMobile)) push('EFR.efr_no LIKE ?', `%${String(efrMobile).trim()}%`);
  if (notEmpty(customerQ)) {
    /*
     * Matches the name the ROW DISPLAYS (job-row name, master as fallback),
     * not the master name alone — same reason list() does: otherwise typing
     * the name visible on screen returns nothing for every job that overrides
     * it.
     */
    const v = `%${String(customerQ).trim()}%`;
    push(`(${JOB_CUSTOMER_NAME_EXPR} LIKE ? OR C.customer_mob_no LIKE ?)`, v, v);
  }

  if (notEmpty(sourceType)) push('J.source_type = ?', String(sourceType));

  if (assigned !== undefined && assigned !== null && assigned !== '') {
    // Pool-offered jobs stay job_status = 0 with fk_easyfixter_id NULL until a
    // tech ACCEPTS, so fk presence IS the accepted/assigned signal. Same rule
    // as list(); the Pending-for-Scheduling tab sends status=0 + assigned=false.
    clauses.push(isTrue(assigned) ? 'J.fk_easyfixter_id IS NOT NULL' : 'J.fk_easyfixter_id IS NULL');
  }

  if (isTrue(noServices)) {
    /*
     * Booked-No-Services drill-down. Pins job_status = 0 itself (so callers
     * need not set status separately) AND anti-joins tbl_job_services —
     * exactly the predicate the attention-summary counter uses, so the tile,
     * the table and the sheet agree by construction.
     */
    clauses.push('J.job_status = 0');
    clauses.push('NOT EXISTS (SELECT 1 FROM tbl_job_services js WHERE js.job_id = J.job_id AND js.job_service_status = 1)');
    statusPinned = true;
  }

  if (reopen !== undefined && reopen !== null && reopen !== '') {
    clauses.push(isTrue(reopen) ? 'J.job_reopen_flag = 1' : '(J.job_reopen_flag = 0 OR J.job_reopen_flag IS NULL)');
  }

  if (notEmpty(dueTo)) {
    /*
     * Accepts both shapes of remark, exactly as list() does:
     *   structured tag from the AddRemarks dialog ("Due To: Client"), and
     *   loose legacy free text ("… due to client said no …").
     * MySQL's default collation is case-insensitive, so casing is irrelevant.
     */
    const lower = String(dueTo).toLowerCase();
    const label = lower === 'easyfix' ? 'EasyFix' : lower.charAt(0).toUpperCase() + lower.slice(1);
    push('(J.remarks LIKE ? OR J.remarks LIKE ?)', `%Due To: ${label}%`, `%due to ${lower}%`);
  }

  if (quotationStatus === 'approved') {
    push('EXISTS (SELECT 1 FROM quotation_details qd WHERE qd.job_id = J.job_id AND qd.status = 1 AND qd.action_on IS NOT NULL)');
    clauses.push('J.job_status NOT IN (2, 3, 5, 6)');
    statusPinned = true;
  } else if (quotationStatus === 'rejected') {
    push('EXISTS (SELECT 1 FROM quotation_details qd WHERE qd.job_id = J.job_id AND qd.status = 0 AND qd.action_on IS NOT NULL)');
    clauses.push('J.job_status NOT IN (3, 5, 6)');
    statusPinned = true;
  }

  if (requestedBefore === 'now') {
    clauses.push('J.requested_date_time IS NOT NULL AND J.requested_date_time < NOW()');
  } else if (notEmpty(requestedBefore)) {
    push('J.requested_date_time IS NOT NULL AND J.requested_date_time < ?', requestedBefore);
  }

  if (notEmpty(q)) {
    const term = String(q).trim();
    /*
     * ── A DIGITS-ONLY TERM IS AN IDENTIFIER, NOT A NAME ─────────────────────
     * (2026-08-20. Ported from services/job.service.js list(), which carries the
     * full reasoning and the measurements; this file held an INDEPENDENT COPY of
     * the same eleven-term OR and therefore an independent copy of both bugs.)
     *
     * CORRECTNESS. Searching 530280 on the jobs list returned three jobs: the
     * one wanted, plus two matched on their PHONE NUMBERS mid-digit —
     * 98453028|06 and 93|530280|25. Any six-digit id has roughly five landing
     * spots inside a ten-digit mobile, so the false-match rate grows with how
     * many customers exist rather than with how unusual the term is. The export
     * would have put those same strangers in the operator's spreadsheet, where
     * they are harder to notice than on screen.
     *
     * SPEED. `C.customer_mob_no LIKE ?` names a column of the OUTER LEFT JOIN,
     * so sitting inside an OR with tbl_job predicates it forced MySQL to join
     * tbl_customer before it could rule any row out. Written as an uncorrelated
     * IN (…) the predicate becomes pure-`J`, the subquery runs ONCE as a range
     * scan on the mobile index, and the prefix anchor is what makes that range
     * possible — the correctness fix is what unlocks the speed fix.
     *
     * MOBILE_MIN_DIGITS is IMPORTED, not redeclared. Two copies of "how long is
     * a phone fragment" is precisely how this file ended up with a stale copy of
     * the clause in the first place.
     */
    if (/^\d+$/.test(term)) {
      const idTerms = ['J.job_id = ?', 'J.job_reference_id LIKE ?', 'J.client_ref_id LIKE ?'];
      const idParams = [Number(term), `%${term}%`, `%${term}%`];
      if (term.length >= MOBILE_MIN_DIGITS) {
        /*
         * ⚠ IN, never NOT IN. One NULL in a NOT IN subquery rejects EVERY row;
         * with IN a NULL fk_customer_id is simply UNKNOWN and OR-composes the
         * same way the old LIKE did on a NULL join.
         */
        idTerms.push(
          'J.fk_customer_id IN (SELECT qmob.customer_id FROM tbl_customer qmob WHERE qmob.customer_mob_no LIKE ?)'
        );
        idParams.push(`${term}%`);
      }
      push(`(${idTerms.join(' OR ')})`, ...idParams);
    } else {
      // Anything containing a non-digit keeps the original eleven-column search,
      // byte for byte. One bound value per term, in Q_TERMS order — eleven
      // placeholders, eleven params. A term added on one side and not the other
      // is a silent drift.
      const v = `%${term}%`;
      push(`(${Q_TERMS.join(' OR ')})`, ...Q_TERMS.map(() => v));
    }
  }

  // ── Date windows ──────────────────────────────────────────────────────────
  /*
   * listQuery's startDate/endDate, applied EXACTLY as list() applies them:
   * DATE() on the PARAMETER (never the column, so the index stays usable) and
   * an EXCLUSIVE next-day upper bound.
   *
   * ⚠ DO NOT "simplify" this to a plain `>= ? AND <= ?`. startDate/endDate are
   * Joi.date().iso(), so '2026-08-17' is a Date at UTC midnight and mysql2
   * serialises it at the pool's +05:30 — MySQL receives '2026-08-17 05:30:00'.
   * The raw comparison made start = end return NOTHING and skewed every other
   * range by 5.5 hours, in the table AND in this sheet. Measured, fixed in
   * list() on 2026-08-18, and mirrored here.
   */
  const uiDateCol = UI_DATE_TYPE_COLUMN[String(dateType || '').toLowerCase()] || 'J.created_date_time';
  if (notEmpty(startDate)) push(`${uiDateCol} >= DATE(?)`, startDate);
  if (notEmpty(endDate)) push(`${uiDateCol} < DATE(?) + INTERVAL 1 DAY`, endDate);
  /*
   * ⚠ NAMING A LIFECYCLE DATE AXIS IS ITSELF A STATEMENT ABOUT STATUS.
   *
   * checkout_date_time is populated ONLY on jobs that have checked out — i.e.
   * exactly statuses 3 and 5, which the terminal-status floor removes. So
   * "everything completed since 1 Aug" came back as
   *
   *     J.checkout_date_time >= DATE('2026-08-01')
   *     AND J.created_date_time >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
   *     AND J.job_status NOT IN (3, 5, 6, 7)
   *
   * — every completed job removed from a query whose whole subject was
   * completed jobs. Reachable in two clicks: both date inputs are optional and
   * independent, so a half-open window ships dateType without pinning status.
   *
   * An operator who picks a lifecycle column AND a date has named the part of
   * the lifecycle they mean; the floor's default no longer applies, and
   * `defaultDateCol` keeps the fallback window on the SAME axis so the two
   * bounds can never sit on different columns and cancel out.
   *
   * Gated on a date actually being supplied, because dateType is documented
   * as a MODIFIER that emits nothing on its own — it selects the column the
   * window applies to. Reading a status pin out of the modifier ALONE would
   * make an operator who merely switched the dropdown silently change which
   * jobs they get, which is the class of surprise this whole change exists
   * to remove.
   */
  const uiWindowGiven = notEmpty(startDate) || notEmpty(endDate);
  if (uiWindowGiven && uiDateCol !== 'J.created_date_time') statusPinned = true;
  if (uiWindowGiven) defaultDateCol = uiDateCol;
  if (notEmpty(startDate) && notEmpty(endDate)) explicitWindow = true;

  // Legacy dateFrom/dateTo. Its own picker tokens, its own status-driven
  // column choice; the two token sets are disjoint so they cannot collide.
  const from = normaliseDate(dateFrom);
  const to = normaliseDate(dateTo);
  // Legacy dereferenced dateType without a null check. The UI always sends it
  // and "All" is its default, so default to that rather than NPE.
  const dtRaw = String(dateType ?? 'All').trim();
  const isAll = dtRaw.toLowerCase() === 'all';

  if (from && to) {
    explicitWindow = true;
    if (statusStr && isAll) {
      // One status tab + "All" → the date column that tab is ABOUT.
      const col = STATUS_DATE_COLUMN[statusLower] || 'J.requested_date_time';
      const r = dayRange(col, from, to);
      push(r.sql, ...r.params);
    } else if (!statusStr && isAll) {
      // No status tab + "All" → "did ANY milestone land in this window".
      const parts = ALL_DATE_COLUMNS.map((c) => dayRange(c, from, to));
      push(
        `(${parts.map((p) => p.sql).join(' OR ')})`,
        ...parts.flatMap((p) => p.params),
      );
    } else if (!isAll) {
      const col = DATE_TYPE_COLUMN[dtRaw.toLowerCase()] || 'J.requested_date_time';
      const r = dayRange(col, from, to);
      push(r.sql, ...r.params);
      // Legacy pinned the completed statuses onto this one date type only.
      if (dtRaw.toLowerCase() === 'checkoutdatetime') {
        clauses.push('J.job_status IN (3, 5)');
        statusPinned = true;
      }
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
    if (bucketSql.length) push(`(${bucketSql.join(' OR ')})`);
  }

  // "Open due to" — user_type of the reason attached to the job. The LEGACY
  // filter; listQuery's `dueTo` above is a different column and a different
  // question, and both names are honoured under their own meaning.
  if (notEmpty(openDueToReason) && String(openDueToReason).toLowerCase() !== 'all') {
    push('ut.type = ?', String(openDueToReason));
  }

  /*
   * Rating 1..5 is a literal match; anything above 5 is the legacy UI's "not
   * rated" pseudo-option and means IS NULL (listQuery caps the value at 5, so
   * only a direct caller reaches that branch). list() expresses the same
   * filter as an EXISTS; the joined form here is equivalent because phase 1
   * GROUP BYs job_id, so a job with ANY matching rating row survives exactly
   * once.
   */
  if (Number(rating) > 0) {
    if (Number(rating) <= 5) push('TERBC.customer_rating = ?', Number(rating));
    else push('TERBC.customer_rating IS NULL');
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
   * ── THE BOUND ─────────────────────────────────────────────────────────────
   * One rule, one expression. See "KEEPING THE EXPORT BOUNDED" above for why
   * only these two things count, and why RBAC is not one of them.
   *
   * This REPLACES legacy's `flage` / `flag` pair. Those two booleans meant
   * "any filter was emitted" and "the first clause came from a flag-setting
   * filter", and the guards branching on them are gone with them — including
   * the `flage && completed && !flag` arm, which the previous comment already
   * recorded as unreachable. The legacy vocabulary therefore loses its old
   * cap-lifting behaviour too (clientIdFromUI no longer lifts the window on
   * its own, for instance).
   *
   * ⚠ MEASURED, NOT ASSUMED, because the first attempt at this change claimed
   * the legacy path was "byte-identical" and it was not. Running HEAD's module
   * against this one over 42 legacy filter combinations, 25 differ. Most gain a
   * default floor (a tightening). ONE WIDENS, and it is called out here rather
   * than left to be discovered:
   *
   *   { status:'completed', dateFrom, dateTo, dateType:'All' }
   *     HEAD: … AND J.created_date_time >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
   *     NOW : (no such clause)
   *
   * That clause came from a THIRD legacy guard — terminal statuses with no
   * city/state filter got a 6-month cap on created_date_time. It is gone
   * DELIBERATELY, because it was the same axis-mismatch bug this change fixes
   * elsewhere: it capped CREATED while the operator's window was on CHECKOUT,
   * so "completed jobs in Q1 2024" met a 6-month created floor and returned
   * nothing at all. A load guard that silently empties historical queries is
   * not a load guard, it is a second bug.
   *
   * What bounds that query now is the operator's own window, on their own
   * axis. The residual risk is a window of arbitrary LENGTH (2015→2026), which
   * is bounded only by EXPORT_ROW_CEILING; that is logged rather than clamped,
   * because silently narrowing a range an operator explicitly typed is the
   * exact behaviour this whole change exists to remove.
   *
   * The tightening applies to a path no HTTP caller can reach (validate.js runs
   * Joi with stripUnknown, so only listQuery keys arrive), and one
   * lifting rule for both vocabularies is the only version of this anyone can
   * reason about.
   */
  /*
   * ⚠ THE DEFAULT WINDOW IS THE LAST SILENT NARROWING IN THIS PATH, so it
   * reports itself. An operator whose sheet is shorter than their screen must
   * be able to find out why from the log — the original bug was invisible
   * precisely because nothing announced that a constraint had been swapped in.
   * The route logs this alongside the unapplied-filter warning.
   */
  const boundedByCaller = pointIdentity || explicitWindow;
  if (!boundedByCaller) {
    appliedDefaults.push(`window:${DEFAULT_WINDOW_MONTHS}mo on ${defaultDateCol}`);
    if (!statusPinned) appliedDefaults.push(`status:NOT IN (${TERMINAL_STATUSES.join(',')})`);
  }
  if (!boundedByCaller) {
    clauses.push(`${defaultDateCol} >= DATE_SUB(NOW(), INTERVAL ${DEFAULT_WINDOW_MONTHS} MONTH)`);
    if (!statusPinned) clauses.push(`J.job_status NOT IN (${TERMINAL_STATUSES.join(', ')})`);
  }

  return { clauses, params, appliedDefaults };
}

/*
 * Public form of the filter builder: a ready-to-splice `WHERE …` string (empty
 * string when there is nothing to filter on) plus its bind values, in order.
 */
function buildExportWhere(filters = {}) {
  const { clauses, params, appliedDefaults } = buildClauses(filters);
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params, appliedDefaults };
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
  /*
   * ─── Every derived table is scoped to THIS CHUNK's job_ids ──────────────
   *
   * Legacy ran one unbounded query, so materialising these three over the
   * whole of tbl_job_assignee_history / tbl_estimate_details / tbl_job_offer
   * cost one full scan each for the entire export. Chunking without this
   * filter would repeat that scan PER CHUNK — 50 chunks of 2,000 rows would
   * do 50× the work legacy did, which is how a memory fix turns into a
   * throughput regression.
   *
   * Each id-list placeholder below takes the ids phase 1 already resolved
   * (see fetchExportChunk), so a derived table sees at most chunkSize rows.
   *
   * NOTE: this comment is inside a template literal AND inside the SQL string.
   * No backticks (they close the literal) and no question marks — mysql2's
   * formatter scans for placeholders without skipping SQL comments, so a
   * stray one here would silently swallow a bound parameter.
   */
  LEFT JOIN (
    SELECT job_id, previous_efr,
           ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY id DESC) AS row_num
      FROM tbl_job_assignee_history
     WHERE job_id IN (?)
  ) TJA1 ON TJA1.job_id = J.job_id AND TJA1.row_num = 1
  LEFT JOIN tbl_easyfixer TEP ON TEP.efr_id = TJA1.previous_efr
  LEFT JOIN (
    SELECT TED.sent_on, TED.job_id, TED.action_on, TED.status
      FROM tbl_estimate_details TED
      INNER JOIN (SELECT job_id, MAX(id) AS max_id FROM tbl_estimate_details
                   WHERE job_id IN (?) GROUP BY job_id) AS maxTED
              ON TED.job_id = maxTED.job_id AND TED.id = maxTED.max_id
     WHERE TED.job_id IN (?)
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
     WHERE jo.job_id IN (?)
     GROUP BY jo.job_id
  ) JO ON JO.job_id = J.job_id
`;

/*
 * The join set the FILTERS can reference — nothing else.
 *
 * Phase 1 of fetchExportChunk resolves this chunk's job_ids and needs only
 * the tables a WHERE clause can touch. Leaving out the three derived tables,
 * the ten tbl_user self-joins, tbl_job_transaction, tbl_service_catg,
 * tbl_state and the GROUP_CONCAT joins is the whole point: the id scan walks
 * an index instead of building aggregates it will never select.
 *
 * MUST stay in sync with buildClauses(). If a new filter references an alias
 * that is not joined here, phase 1 throws "Unknown column" — loudly, on the
 * first request, which is the failure mode we want rather than a silently
 * wrong row set.
 */
const FILTER_FROM = `
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
  /*
   * Resolve the tbl_client.vertical_id probe ONCE per chunk (it is memoised
   * per process after the first call) and hand the answer to buildClauses, so
   * the verticals RBAC scope is applied here on exactly the condition list()
   * applies it on. Awaiting a cached boolean costs nothing; guessing it costs
   * an RBAC divergence between the sheet and the screen.
   */
  const { clauses, params } = buildClauses({
    ...filters,
    hasClientVerticalCol: await hasClientVerticalIdColumn(),
  });

  const allClauses = clauses.slice();
  const allParams = params.slice();
  if (afterJobId !== null && afterJobId !== undefined && afterJobId !== '') {
    allClauses.push('J.job_id < ?');
    allParams.push(Number(afterJobId));
  }

  const started = Date.now();

  /*
   * ─── PHASE 1 — resolve this chunk's ids, and nothing else ───────────────
   *
   * A "deferred join": narrow first on the cheap join set, then hydrate. The
   * naive alternative — running the full 21-join projection with the filters
   * inline — makes MySQL build the three derived-table aggregates before it
   * knows which 2,000 rows it wants, so the expensive work scales with the
   * whole table rather than with the chunk.
   */
  const idSql = `SELECT J.job_id ${FILTER_FROM}
    ${allClauses.length ? `WHERE ${allClauses.join(' AND ')}` : ''}
    GROUP BY J.job_id
    ORDER BY J.job_id DESC
    LIMIT ?`;
  const [idRows] = await pool.query(idSql, [...allParams, size]);
  if (idRows.length === 0) return [];
  const ids = idRows.map((r) => Number(r.job_id));

  /*
   * ─── PHASE 2 — hydrate exactly those ids ────────────────────────────────
   *
   * The filters are NOT repeated here: phase 1 already applied them, and the
   * id list is the authority. Re-running them would be redundant work and a
   * second place for the two paths to disagree.
   *
   * Four `?` take the same id array — one per derived table (TJA1, ESTST's
   * inner maxTED, ESTST's outer, JO) plus the driving IN. mysql2 expands an
   * array into a placeholder list for `pool.query`, so each stays a single
   * bound parameter rather than string-built SQL.
   */
  const sql = `${EXPORT_SELECT}
    WHERE J.job_id IN (?)
    GROUP BY J.job_id
    ORDER BY J.job_id DESC`;
  const [rows] = await pool.query(sql, [ids, ids, ids, ids, ids]);
  await attachJobOwnerNames(rows);

  logger.info(
    `Manage-Job export chunk · rows=${rows.length} · afterJobId=${afterJobId ?? 'start'} · ${Date.now() - started}ms`,
  );
  return rows;
}

/*
 * Resolve the "Job Owner" column from a user id to a user NAME.
 *
 * `job_primary_spoc` holds a tbl_user.user_id, and the export was writing that
 * id straight into a column headed "Job Owner" — so the sheet showed 4471 where
 * it should say a person.
 *
 * It CANNOT be joined in the main SELECT. The column is PROD-only (absent on
 * some DBs — see the note in mapExportRow), which is exactly why it is read off
 * `J.*` rather than named; naming it in a JOIN condition would 500 the whole
 * export wherever it is missing. So the lookup happens here, per chunk, against
 * whatever ids actually arrived: no column name in SQL, and a DB without the
 * column simply yields no ids and no query.
 *
 * Bounded by chunkSize, so this is one small extra query per chunk. Fails soft —
 * a lookup error leaves the raw id rather than losing the export.
 */
async function attachJobOwnerNames(rows) {
  const ids = [...new Set(
    rows.map((r) => r.job_primary_spoc)
      .filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
      // Pre-2026 rows are not guaranteed numeric (the column is a VARCHAR), so
      // only genuine ids are looked up; anything else falls through unchanged.
      .filter((v) => /^[0-9]+$/.test(String(v).trim()))
      .map((v) => Number(String(v).trim())),
  )];
  if (!ids.length) return rows;
  try {
    const [users] = await pool.query(
      `SELECT user_id, user_name FROM tbl_user WHERE user_id IN (${ids.map(() => '?').join(',')})`,
      ids,
    );
    const byId = new Map(users.map((u) => [Number(u.user_id), u.user_name]));
    for (const r of rows) {
      const raw = r.job_primary_spoc;
      if (raw === null || raw === undefined) continue;
      r.job_primary_spoc_name = byId.get(Number(String(raw).trim())) ?? null;
    }
  } catch (e) {
    logger.warn('Job-owner name lookup failed — exporting the raw id · ' + e.message);
  }
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
     * was the day the job was booked. The NAME is resolved per chunk by
     * attachJobOwnerNames (it cannot be joined in the SELECT without naming the
     * PROD-only column). Falls back to the raw id if the user row is gone or
     * the value was never numeric, so the cell is never silently emptied.
     */
    jobOwner: r.job_primary_spoc_name
      ?? (r.job_primary_spoc !== null && r.job_primary_spoc !== undefined ? String(r.job_primary_spoc) : null),
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

module.exports = {
  EXPORT_COLUMNS, fetchExportChunk, mapExportRow, buildExportWhere,
  /*
   * The listQuery coverage ledger and the subset of it the route logs.
   * Exported so tests/job-export-filters.test.js can derive its checks from
   * the SAME structure the code reads — a hand-typed copy of this list in the
   * test would let a new listQuery key be dropped in silence with the suite
   * green, which is the original bug rebuilt inside its own regression test.
   */
  FILTER_COVERAGE, UNAPPLIED_FILTERS,
};
