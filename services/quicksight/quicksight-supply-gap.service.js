/*
 * QuickSight — Supply Gap Analysis (legacy "Open City") — service layer.
 *
 *   registry slug : opencity
 *   legacy title  : "Supply Gap Dashboard"
 *
 * Faithful native port of the legacy API_AngularClientDashboard
 * OpenCityController / OpenCityServiceImpl / OpenCityRepository READ surface:
 *   - findAllOpenCities          (OpenCityServiceImpl:194-303) → list()
 *   - downloadExcelSupplyRequest (OpenCityServiceImpl:777-863) → exportRows()
 *   - findBySupplyID             (OpenCityServiceImpl:458-498) → detail()
 *   - getAllocatedTxList         (OpenCityServiceImpl:935-962) → allocations()
 *   - getActionHistory…         (OpenCityServiceImpl:603-640) → history()
 *   - getJobDetailById           (OpenCityServiceImpl:406-450) → jobDetail()
 *   - findTxdetailsById          (OpenCityServiceImpl:907-933) → txDetails()
 *   - getEasyfixerStatusByMobileNo / findNewSupplyStatus (lines 337-399)
 *                                                        → resolveSupplyStatus()
 *   - getActiveTxCountByCity…    (OpenCityRepository:272-281) → txCount()
 *
 * PARITY NOTES (do NOT "clean up" — see /tmp/qs/_registry.json decisions):
 *   - Plain COUNT(*) per-gap allocation count (NO DISTINCT) preserved via a
 *     correlated subquery (also keeps the projection GROUP BY-safe — legacy
 *     relied on loose ONLY_FULL_GROUP_BY for TOC.* survival).
 *   - Columns are aliased BY NAME (not TOC.*) to avoid the legacy positional
 *     Object[] drift that the spec flags.
 *   - +1-day inclusive end-date upper bound preserved (legacy added a day so
 *     `< endExclusive` includes the selected end day). Both list and COUNT
 *     use `< ?` here — the legacy COUNT used `<=` (off-by-one over-count);
 *     standardised to `<` per registry decision.
 *   - blank-PM / blank-anything rows shown via LEFT JOIN (legacy used the
 *     same LEFT JOINs).
 *   - admin sees ALL — no req.scope row filtering (legacy had none).
 *   - legacy typos preserved verbatim where they hit the schema:
 *     fk_easyfixter_id, tbl_service_catg, is_technician_Verified.
 *   - findNewSupplyStatus runs PER ROW (N+1) in legacy; here it is BATCHED
 *     into 3 grouped lookups per page but applies the EXACT same branch tree.
 *   - HIGH non-truncating safety LIMIT on the list/export with logger.warn()
 *     when hit (no silent truncation in practice).
 *   - WRITE workflow (saveOpenCity / actionOnSupplyRequest / addComment +
 *     WhatsApp + transferJobOwnershipToZM) is NOT ported here — the QuickSight
 *     rebuild is the READ/report surface; the full CRUD dashboard write flow
 *     with its orchestrator side-effects is out of scope (see openQuestions).
 */

const { pool } = require('../../db');
const logger = require('../../logger');

// High safety caps — far above realistic row counts. A hit is logged, never
// silently swallowed (registry decision: "no silent row drops").
const LIST_LIMIT = 50000;     // list / export (gap-level rows)
const GROUPED_LIMIT = 5000;   // sub-lists (allocations / history)

// ── Date formatting: legacy DateUtils.formatTimestampToDate = "dd MMM yyyy HH:mm"
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/*
 * fmtTs — render a MySQL DATETIME / Date as "dd MMM yyyy HH:mm" (legacy
 * DateUtils.formatTimestampToDate, DateUtils.java:159-171). Null → null.
 * mysql2 returns DATETIME as a JS Date in the server's local TZ; we format
 * from the local components (legacy formatted JVM-local too).
 */
function fmtTs(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const dd = String(d.getDate()).padStart(2, '0');
  const mon = MONTHS[d.getMonth()];
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${dd} ${mon} ${yyyy} ${hh}:${mi}`;
}

/*
 * addOneDay — legacy endAt.plusDays(1) on a 'YYYY-MM-DD' string. Returns
 * 'YYYY-MM-DD'. Pure calendar arithmetic (no TZ math).
 */
function addOneDay(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/*
 * nullIfZero — legacy OpenCityServiceImpl.nullIfZero (lines 402-404):
 * value == 0 → null (= "All"). Also treats null/undefined/'' as null.
 */
function nullIfZero(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return null;
  return n;
}

/*
 * buildFilters — assemble the shared WHERE predicates for list/COUNT/export.
 * Returns { where, params }. `endExclusive` is already +1-day when present.
 * Every value bound via ? (parameterised house rule). The (? IS NULL OR …)
 * sentinel is preserved from legacy so an unset filter emits no restriction;
 * each sentinel binds its value twice (mysql2 positional placeholders).
 */
function buildFilters({ status, search, zonalManager, requestFor, start, endExclusive }) {
  const params = [];
  let where = '';

  // status: 5/'All' already normalised to null by the caller; 0 is real.
  where += ' AND (? IS NULL OR TOC.status = ?)';
  params.push(status, status);

  // 6-way free-text search (id / pin / reference_id exact; city / state /
  // service_catg_name LIKE %x%), all UPPER-cased — verbatim legacy.
  where +=
    ' AND (? IS NULL OR (' +
    'CAST(TOC.id AS CHAR) = ? ' +
    'OR CAST(TOC.pin AS CHAR) = ? ' +
    'OR TOC.reference_id = ? ' +
    "OR UPPER(TOC.city) LIKE UPPER(CONCAT('%', ?, '%')) " +
    "OR UPPER(TOC.state) LIKE UPPER(CONCAT('%', ?, '%')) " +
    "OR UPPER(TSC.service_catg_name) LIKE UPPER(CONCAT('%', ?, '%'))" +
    '))';
  params.push(search, search, search, search, search, search, search);

  where += ' AND (? IS NULL OR TOC.state_user = ?)';
  params.push(zonalManager, zonalManager);

  where += ' AND (? IS NULL OR TOC.request_for = ?)';
  params.push(requestFor, requestFor);

  where += ' AND (? IS NULL OR TOC.inserted_on >= ?)';
  params.push(start, start);

  // FIX legacy <= inconsistency → < (the +1-day end keeps the selected day inclusive).
  where += ' AND (? IS NULL OR TOC.inserted_on < ?)';
  params.push(endExclusive, endExclusive);

  return { where, params };
}

/*
 * normaliseFilters — turn the validated query into the bound filter values,
 * reproducing the exact legacy service-layer transforms.
 */
function normaliseFilters(q, { exportDefaults = false } = {}) {
  // supplyStatus==5 → null ("All"); else exact incl. 0. NOT nullIfZero.
  const rawStatus = q.supplyStatus;
  const status = rawStatus === 5 || rawStatus === null || rawStatus === undefined ? null : Number(rawStatus);

  const zonalManager = nullIfZero(q.zonalManager);
  const requestFor = nullIfZero(q.requestFor);

  const startStr = q.startDate ? String(q.startDate).slice(0, 10) : null;
  const endStr = q.endDate ? String(q.endDate).slice(0, 10) : null;

  let start;
  let endExclusive;
  if (exportDefaults) {
    // Excel: start defaults to 2000-01-01, end defaults to now+1day so blank
    // dates export ALL rows (OpenCityServiceImpl:807-808).
    start = startStr || '2000-01-01';
    const todayUtc = new Date();
    const ymd = `${todayUtc.getFullYear()}-${String(todayUtc.getMonth() + 1).padStart(2, '0')}-${String(todayUtc.getDate()).padStart(2, '0')}`;
    endExclusive = endStr ? addOneDay(endStr) : addOneDay(ymd);
  } else {
    start = startStr || null;
    endExclusive = endStr ? addOneDay(endStr) : null;
  }

  const search = q.searchText && String(q.searchText).trim() ? String(q.searchText).trim() : null;

  return { status, search, zonalManager, requestFor, start, endExclusive };
}

// ── Derived gapAge (findGapAge, OpenCityServiceImpl:305-335) ──────────────
/*
 * findGapAge(status, initiatedDate, closeDate):
 *   initiatedDate == null → 0
 *   status in (0,1,2)     → end = NOW()
 *   status in (3,4) && closeDate != null → end = closeDate
 *   else → 0
 *   result = ceil(hoursBetween / 24)  (any portion of 24h counts as a day)
 */
function findGapAge(status, initiatedDate, closeDate) {
  if (initiatedDate == null) return 0;
  const start = initiatedDate instanceof Date ? initiatedDate : new Date(initiatedDate);
  let end = null;
  if (status === 0 || status === 1 || status === 2) {
    end = new Date();
  } else if ((status === 3 || status === 4) && closeDate != null) {
    end = closeDate instanceof Date ? closeDate : new Date(closeDate);
  } else {
    return 0;
  }
  const hours = (end.getTime() - start.getTime()) / (1000 * 60 * 60);
  return Math.ceil(hours / 24.0);
}

// ── findNewSupplyStatus (OpenCityServiceImpl:337-399) — BATCHED ───────────
/*
 * resolveSupplyStatusBatch(mobileNumbers) → Map<mobile, label>.
 *
 * Legacy resolves ONE mobile per call (N+1). We collect distinct mobiles and
 * run 3 grouped lookups, then apply the EXACT branch tree per mobile:
 *   user = tbl_user WHERE mobile_no=? AND user_type_id=4
 *   IF user == null:
 *     efr = tbl_easyfixer WHERE efr_no=?  → null ⇒ 'Invite Sent' else 'Idle'
 *   ELSE:
 *     efr = tbl_easyfixer WHERE user_id=user.user_id
 *     efr == null ⇒ 'Easyfixer details not found'
 *     ... full city/userName/pinCode/isPersonalDetailFilled/
 *         personalDetailFilledVerifiedByCrm + is_technician_Verified /
 *         is_identity_details_verified_by_crm / status branch tree.
 *
 * tbl_easyfixer is_*_verified columns are BIT(1)/tinyint → mysql2 returns
 * Buffer/number; we coerce via truthy/null checks mirroring the legacy
 * Boolean/Integer comparisons (null vs 1 vs 2 vs TRUE/FALSE).
 */
function asBitNull(v) {
  // BIT(1) → Buffer<00|01>; tinyint → 0/1; null → null. Returns 0/1/null.
  if (v == null) return null;
  if (Buffer.isBuffer(v)) return v[0] ? 1 : 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return Number(v);
}

function resolveLabelForEfr(efr) {
  if (!efr) return 'Easyfixer details not found';

  const hasCity = efr.city != null && efr.city !== '';
  const hasName = efr.user_name != null && efr.user_name !== '';
  const hasPin = efr.pin_code != null && efr.pin_code !== '';
  const isPersonalFilled = asBitNull(efr.is_personal_detail_filled); // 1 TRUE / 0 FALSE / null
  const verifiedByCrm = efr.personal_detail_filled_verified_by_crm; // Integer: null/1/2
  const isTechVerified = asBitNull(efr.is_technician_Verified);     // legacy typo column
  const identityVerifiedByCrm = efr.is_identity_details_verified_by_crm; // Integer: null/1/2
  const efrStatus = asBitNull(efr.status); // active flag

  // New Lead: all present + filled TRUE + not yet CRM-reviewed.
  if (hasCity && hasName && hasPin && isPersonalFilled === 1 && verifiedByCrm == null) {
    return 'New Lead';
  }
  // Details Not Available: any required field missing / not filled.
  if (!hasCity || !hasName || !hasPin || isPersonalFilled === 0) {
    return 'Details Not Available';
  }
  if (verifiedByCrm === 2) return 'Not Eligible';
  if (
    verifiedByCrm === 1 &&
    isTechVerified == null &&
    (identityVerifiedByCrm == null || identityVerifiedByCrm === 1)
  ) {
    return 'Self Registration In Progress';
  }
  if (verifiedByCrm === 1 && identityVerifiedByCrm === 2) return 'Not Suitable';
  if (efrStatus === 1 && isTechVerified === 1) return 'Active';
  if (efrStatus === 0 && isTechVerified === 1) return 'In-active';
  return 'NA';
}

async function resolveSupplyStatusBatch(mobileNumbers) {
  const result = new Map();
  const distinct = [...new Set(
    (mobileNumbers || [])
      .filter((m) => m != null && String(m).trim() !== '')
      .map((m) => String(m).trim()),
  )];
  if (distinct.length === 0) return result;

  const ph = distinct.map(() => '?').join(',');

  // 1) tbl_user (user_type_id = 4) keyed by mobile_no.
  const [users] = await pool.query(
    `SELECT user_id, mobile_no FROM tbl_user WHERE mobile_no IN (${ph}) AND user_type_id = 4`,
    distinct,
  );
  const userByMobile = new Map();
  const userIds = [];
  for (const u of users) {
    userByMobile.set(String(u.mobile_no), u);
    if (u.user_id != null) userIds.push(u.user_id);
  }

  // 2) tbl_easyfixer keyed by efr_no (for the no-user "Invite Sent / Idle" branch).
  const [efrsByNo] = await pool.query(
    `SELECT efr_no FROM tbl_easyfixer WHERE efr_no IN (${ph}) AND NOT (tbl_easyfixer.efr_status <=> 3)`,
    distinct,
  );
  const efrNoSet = new Set(efrsByNo.map((e) => String(e.efr_no)));

  // 3) tbl_easyfixer keyed by user_id (for the resolved-user branch).
  const efrByUserId = new Map();
  if (userIds.length > 0) {
    const uph = userIds.map(() => '?').join(',');
    const [efrsByUser] = await pool.query(
      `SELECT user_id, city, user_name, pin_code, is_personal_detail_filled,
              personal_detail_filled_verified_by_crm, is_technician_Verified,
              is_identity_details_verified_by_crm, status
         FROM tbl_easyfixer WHERE user_id IN (${uph}) AND NOT (tbl_easyfixer.efr_status <=> 3)`,
      userIds,
    );
    for (const e of efrsByUser) efrByUserId.set(e.user_id, e);
  }

  for (const mobile of distinct) {
    const user = userByMobile.get(mobile);
    let label;
    if (!user) {
      label = efrNoSet.has(mobile) ? 'Idle' : 'Invite Sent';
    } else {
      label = resolveLabelForEfr(efrByUserId.get(user.user_id));
    }
    result.set(mobile, label);
  }
  return result;
}

/*
 * resolveSupplyStatus(mobileNo) — single-mobile convenience for the
 * tx-status endpoint and history enrichment. Returns the label or null.
 */
async function resolveSupplyStatus(mobileNo) {
  if (mobileNo == null || String(mobileNo).trim() === '') return null;
  const m = await resolveSupplyStatusBatch([mobileNo]);
  return m.get(String(mobileNo).trim()) || null;
}

// ── 1) list() — primary report endpoint (paginated) ───────────────────────
async function list(q) {
  const page = q.page;
  const pageSize = q.pageSize;
  const offset = (page - 1) * pageSize;
  const f = normaliseFilters(q);

  // COUNT(*) over the same predicates (only TSC join needed for the search).
  const countF = buildFilters(f);
  const countSql = `
    SELECT COUNT(*) AS total
    FROM tbl_open_city TOC
    LEFT JOIN tbl_service_catg TSC ON (TSC.service_catg_id = TOC.category_id)
    WHERE 1=1${countF.where}
  `;
  const [countRows] = await pool.query(countSql, countF.params);
  const totalRecords = countRows[0] ? countRows[0].total : 0;

  // List — columns aliased by NAME; correlated subquery for allocationCount.
  const listF = buildFilters(f);
  const listSql = `
    SELECT
      TOC.id              AS openCityId,
      TOC.pin             AS pinCode,
      TOC.city            AS cityName,
      TOC.district        AS districtName,
      TOC.state           AS stateName,
      TSC.service_catg_name AS category,
      TU.user_name        AS zonalManager,
      TOC.reference_id    AS refId,
      TOC.comments        AS comments,
      TOC.status          AS status,
      TOC.old_supply_id   AS oldSupplyId,
      TOC.new_supply_number AS newSupplyNumber,
      TOC.new_supply_name AS newSupplyName,
      TOC.action_remarks  AS actionRemarks,
      TOC.action_on       AS actionOn,
      TOC.inserted_on     AS initiatedOn,
      TOC.request_for     AS requestFor,
      TOC.closed_on       AS closeOn,
      TU1.user_name       AS initiatedBy,
      TU2.user_name       AS actionBy,
      TU3.user_name       AS closeBy,
      (SELECT COUNT(*) FROM tbl_supply_request_allocation SRA WHERE SRA.sr_id = TOC.id) AS allocationCount
    FROM tbl_open_city TOC
    LEFT JOIN tbl_user TU  ON TU.user_id  = TOC.state_user
    LEFT JOIN tbl_user TU1 ON TU1.user_id = TOC.inserted_by
    LEFT JOIN tbl_user TU2 ON TU2.user_id = TOC.action_by
    LEFT JOIN tbl_user TU3 ON TU3.user_id = TOC.closed_by
    LEFT JOIN tbl_service_catg TSC ON TSC.service_catg_id = TOC.category_id
    WHERE 1=1${listF.where}
    ORDER BY TOC.id DESC
    LIMIT ? OFFSET ?
  `;
  listF.params.push(pageSize, offset);
  const [rows] = await pool.query(listSql, listF.params);

  if (rows.length >= LIST_LIMIT) {
    logger.warn(
      `QuickSight Supply Gap list page returned ${rows.length} rows (>= ${LIST_LIMIT} cap) — unexpected for a paginated query`,
    );
  }

  // Batch-resolve supplyStatus for rows that have a newSupplyNumber.
  const statusMap = await resolveSupplyStatusBatch(
    rows.filter((r) => r.newSupplyNumber != null).map((r) => r.newSupplyNumber),
  );

  const data = rows.map((r) => ({
    openCityId: r.openCityId,
    pinCode: r.pinCode,
    cityName: r.cityName,
    districtName: r.districtName,
    stateName: r.stateName,
    category: r.category,
    zonalManager: r.zonalManager,
    refId: r.refId,
    comments: r.comments,
    status: r.status,
    oldSupplyId: r.oldSupplyId,
    newSupplyNumber: r.newSupplyNumber,
    newSupplyName: r.newSupplyName,
    actionRemarks: r.actionRemarks,
    actionOn: fmtTs(r.actionOn),
    actionBy: r.actionBy,
    initiatedBy: r.initiatedBy,
    initiatedOn: fmtTs(r.initiatedOn),
    closeBy: r.closeBy,
    closeOn: fmtTs(r.closeOn),
    requestFor: r.requestFor,
    allocationCount: r.allocationCount || 0,
    gapAge: findGapAge(r.status, r.initiatedOn, r.closeOn),
    supplyStatus:
      r.newSupplyNumber != null ? statusMap.get(String(r.newSupplyNumber).trim()) || null : null,
  }));

  return {
    data,
    pageNumber: page,
    pageSize,
    totalRecords,
    totalPages: pageSize > 0 ? Math.ceil(totalRecords / pageSize) : 0,
  };
}

// ── Excel status / requestFor label maps (legacy Excel writer, DIFFER from screen) ──
const EXCEL_STATUS_LABEL = {
  0: 'Opened',
  1: 'Assigned',
  2: 'Added',
  3: 'Cancelled',
  4: 'Completed',
  9: 'Remarks Added',
};
const EXCEL_REQUEST_FOR_LABEL = { 1: 'jobId', 2: 'newCity' };

// XLSX columns — the 23 legacy "Supply Requests" sheet headers (verbatim,
// incl. the "ActionnBy" typo). Order preserved.
const XLSX_COLUMNS = [
  { key: 'gapId', header: 'GapId' },
  { key: 'gapDays', header: 'Gap Days' },
  { key: 'gapFor', header: 'Gap For' },
  { key: 'jobId', header: 'Job Id' },
  { key: 'gapStatus', header: 'Gap Status' },
  { key: 'addedCount', header: 'Added Count' },
  { key: 'supplies', header: 'Supplies', width: 28 },
  { key: 'pinCode', header: 'PinCode' },
  { key: 'city', header: 'City', width: 18 },
  { key: 'district', header: 'District', width: 18 },
  { key: 'state', header: 'State', width: 18 },
  { key: 'zonalManager', header: 'Zonal Manager', width: 22 },
  { key: 'category', header: 'Category', width: 22 },
  { key: 'openRemarks', header: 'Open Remarks', width: 28 },
  { key: 'openBy', header: 'Open By', width: 20 },
  { key: 'openOn', header: 'Open On', width: 18 },
  { key: 'txDetails', header: 'Tx Details', width: 26 },
  { key: 'actionRemarks', header: 'Action Remarks', width: 28 },
  { key: 'actionnBy', header: 'ActionnBy', width: 20 },
  { key: 'actionOn', header: 'Action On', width: 18 },
  { key: 'closedRemarks', header: 'Closed Remarks', width: 28 },
  { key: 'closedBy', header: 'Closed By', width: 20 },
  { key: 'closedOn', header: 'Closed On', width: 18 },
];

/*
 * exportRows(q) — the Excel variant. DIFFERS from list(): adds the
 * GROUP_CONCAT(supply_name::supply_no) allocated-supply string, full result
 * set (no LIMIT below the safety cap), and unconditional date bounds via the
 * 2000-01-01 / now+1 defaults. Returns plain row objects shaped to
 * XLSX_COLUMNS (consumed by utils/xlsx-export.sendXlsx).
 *
 * DECISION (registry / openQuestions): legacy left the "Supplies" column
 * ALWAYS empty (a known bug) despite SELECTing allocated_supply. We POPULATE
 * it from the GROUP_CONCAT data (the recommended fix) — the data is fetched
 * anyway and an empty column is pure data loss.
 */
async function exportRows(q) {
  const f = normaliseFilters(q, { exportDefaults: true });
  const ef = buildFilters(f);

  const sql = `
    SELECT
      TOC.id              AS openCityId,
      TOC.pin             AS pinCode,
      TOC.city            AS cityName,
      TOC.district        AS districtName,
      TOC.state           AS stateName,
      TSC.service_catg_name AS category,
      TU.user_name        AS zonalManager,
      TOC.reference_id    AS refId,
      TOC.comments        AS comments,
      TOC.status          AS status,
      TOC.old_supply_id   AS oldSupplyId,
      TOC.new_supply_number AS newSupplyNumber,
      TOC.new_supply_name AS newSupplyName,
      TOC.action_remarks  AS actionRemarks,
      TOC.action_on       AS actionOn,
      TOC.inserted_on     AS initiatedOn,
      TOC.request_for     AS requestFor,
      TOC.closed_on       AS closeOn,
      TOC.comments        AS openRemarks,
      TU1.user_name       AS initiatedBy,
      TU2.user_name       AS actionBy,
      TU3.user_name       AS closeBy,
      COUNT(SRA.sr_id)    AS allocationCount,
      GROUP_CONCAT(CONCAT(SRA.supply_name, '::', SRA.supply_no) SEPARATOR ', ') AS allocatedSupplies
    FROM tbl_open_city TOC
    LEFT JOIN tbl_user TU  ON TU.user_id  = TOC.state_user
    LEFT JOIN tbl_user TU1 ON TU1.user_id = TOC.inserted_by
    LEFT JOIN tbl_user TU2 ON TU2.user_id = TOC.action_by
    LEFT JOIN tbl_user TU3 ON TU3.user_id = TOC.closed_by
    LEFT JOIN tbl_service_catg TSC ON TSC.service_catg_id = TOC.category_id
    LEFT JOIN tbl_supply_request_allocation SRA ON SRA.sr_id = TOC.id
    WHERE 1=1${ef.where}
    GROUP BY TOC.id
    ORDER BY TOC.id DESC
    LIMIT ${LIST_LIMIT}
  `;
  const [rows] = await pool.query(sql, ef.params);

  if (rows.length >= LIST_LIMIT) {
    logger.warn(
      `QuickSight Supply Gap export hit the ${LIST_LIMIT}-row safety cap — result may be truncated`,
    );
  }

  return rows.map((r) => {
    // Tx Details (legacy col16): newSupplyName/Number joined by ' - ', else
    // String(oldSupplyId), else ''.
    let txDetails = '';
    if (r.newSupplyName != null || r.newSupplyNumber != null) {
      txDetails = [r.newSupplyName, r.newSupplyNumber].filter((x) => x != null && x !== '').join(' - ');
    } else if (r.oldSupplyId != null) {
      txDetails = String(r.oldSupplyId);
    }

    return {
      gapId: r.openCityId,
      gapDays: findGapAge(r.status, r.initiatedOn, r.closeOn),
      gapFor: EXCEL_REQUEST_FOR_LABEL[r.requestFor] || '',
      jobId: r.refId,
      gapStatus: EXCEL_STATUS_LABEL[r.status] != null ? EXCEL_STATUS_LABEL[r.status] : '',
      addedCount: r.allocationCount || 0,
      supplies: r.allocatedSupplies || '',
      pinCode: r.pinCode,
      city: r.cityName,
      district: r.districtName,
      state: r.stateName,
      zonalManager: r.zonalManager,
      category: r.category,
      openRemarks: r.openRemarks,
      openBy: r.initiatedBy,
      openOn: fmtTs(r.initiatedOn),
      txDetails,
      actionRemarks: r.actionRemarks,
      actionnBy: r.actionBy,
      actionOn: fmtTs(r.actionOn),
      closedRemarks: r.comments, // legacy "Closed Remarks" reads comments
      closedBy: r.closeBy,
      closedOn: fmtTs(r.closeOn),
    };
  });
}

// ── 2) detail() — findBySupplyID (eye-icon modal) ─────────────────────────
async function detail(openCityId) {
  const sql = `
    SELECT DISTINCT
      TC.client_name,
      TU.user_name  AS zonal_user,
      TSC.service_catg_name,
      TOC.*,
      TU1.user_name AS action_user,
      TU2.user_name AS open_user,
      TU3.user_name AS close_user,
      RC.is_escalated,
      TJ.job_status AS job_current_status
    FROM tbl_open_city TOC
    LEFT JOIN tbl_client TC ON (TC.client_id = TOC.client_id)
    LEFT JOIN tbl_user TU ON (TU.user_id = TOC.state_user)
    LEFT JOIN tbl_service_catg TSC ON TSC.service_catg_id = TOC.category_id
    LEFT JOIN tbl_user TU1 ON TU1.user_id = TOC.action_by
    LEFT JOIN tbl_user TU2 ON TU2.user_id = TOC.inserted_by
    LEFT JOIN tbl_user TU3 ON TU3.user_id = TOC.closed_by
    LEFT JOIN tbl_easyfixer_rating_by_customer RC ON RC.job_id = TOC.reference_id
    LEFT JOIN tbl_job TJ ON TJ.job_id = TOC.reference_id AND TOC.request_for = 1
    WHERE TOC.id = ?
  `;
  const [rows] = await pool.query(sql, [openCityId]);
  if (rows.length === 0) {
    const e = new Error('Supply gap not found');
    e.status = 404;
    throw e;
  }
  const r = rows[0];
  return {
    id: r.id,
    clientName: r.client_name,
    stateUserName: r.zonal_user,
    catgName: r.service_catg_name,
    pin: r.pin,
    cityName: r.city,
    districtName: r.district,
    stateName: r.state,
    stateUser: r.state_user,
    catgId: r.category_id,
    comments: r.comments,
    referenceId: r.reference_id,
    status: r.status,
    oldSupplyId: r.old_supply_id,
    newSupplyNumber: r.new_supply_number,
    newSupplyName: r.new_supply_name,
    actionDate: fmtTs(r.action_on),
    actionRemarks: r.action_remarks,
    initiatedOn: fmtTs(r.inserted_on),
    requestFor: r.request_for,
    closedOn: fmtTs(r.closed_on),
    closedComments: r.comments,
    actionUserName: r.action_user,
    initiatedByUser: r.open_user,
    closedByUser: r.close_user,
    isJobEscalated: asBitNull(r.is_escalated) || 0,
    jobStatus: r.job_current_status,
  };
}

// ── 3) allocations() — getAllocatedTxList ("Added Tx :N" popup) ───────────
async function allocations(srId) {
  const sql = `
    SELECT TU.user_name, SRA.*
    FROM tbl_supply_request_allocation SRA
    LEFT JOIN tbl_user TU ON (TU.user_id = SRA.insert_by)
    WHERE (? IS NULL OR SRA.sr_id = ?)
    ORDER BY SRA.insert_date DESC
    LIMIT ${GROUPED_LIMIT}
  `;
  const [rows] = await pool.query(sql, [srId, srId]);

  const statusMap = await resolveSupplyStatusBatch(rows.map((r) => r.supply_no));

  return rows.map((r) => ({
    supplyId: r.id,
    supplyName: r.supply_name,
    supplyNo: r.supply_no,
    remarks: r.remarks,
    supplyStatus: r.supply_no != null ? statusMap.get(String(r.supply_no).trim()) || null : null,
    createdOn: fmtTs(r.insert_date),
    createdBy: r.user_name,
    actionType: r.supply_type === 1 ? 'New' : r.supply_type === 2 ? 'Existing' : 'N/A',
  }));
}

// ── 4) history() — getActionHistoryBySupplyRequestID (detail-modal timeline) ──
async function history(srId) {
  const sql = `
    SELECT SRL.*, TU.user_name
    FROM supply_request_log SRL
    LEFT JOIN tbl_user TU ON (TU.user_id = SRL.user_id)
    WHERE SRL.sr_id = ?
    ORDER BY insert_time ASC
    LIMIT ${GROUPED_LIMIT}
  `;
  const [rows] = await pool.query(sql, [srId]);

  // Enrich efrCurrentStatus when tx_details encodes "name_mobile".
  const mobiles = [];
  for (const r of rows) {
    if (r.tx_details && String(r.tx_details).includes('_')) {
      const parts = String(r.tx_details).split('_');
      if (parts.length === 2) mobiles.push(parts[1].trim());
    }
  }
  const statusMap = await resolveSupplyStatusBatch(mobiles);

  return rows.map((r) => {
    let efrCurrentStatus = null;
    if (r.tx_details && String(r.tx_details).includes('_')) {
      const parts = String(r.tx_details).split('_');
      if (parts.length === 2) efrCurrentStatus = statusMap.get(parts[1].trim()) || null;
    }
    return {
      commentId: r.id,
      srId: r.sr_id,
      comment: r.comment,
      actionType: r.action_type,
      userId: r.user_id,
      userName: r.user_name,
      insertOn: fmtTs(r.insert_time),
      txDetails: r.tx_details,
      efrCurrentStatus,
    };
  });
}

// ── 5) jobDetail() — getJobDetailById ("New Supply Request (Job ID)" prefill) ──
async function jobDetail(jobId) {
  // Pre-check: an open request for this job already exists → short-circuit.
  const [openRows] = await pool.query(
    `SELECT TOC.id FROM tbl_open_city TOC
       WHERE TOC.reference_id = ? AND TOC.status IN (0,1,2)
       ORDER BY TOC.id DESC LIMIT 1`,
    [jobId],
  );
  if (openRows.length > 0) {
    return {
      id: openRows[0].id,
      referenceId: jobId,
      comments: `A request for this job is already open. Request ID: ${openRows[0].id}`,
    };
  }

  const sql = `
    SELECT
      TJ.job_id, TCL.client_name,
      TA.pin_code, TC.city_name, TC.district, TS.state_name,
      TU.user_name, TSC.service_catg_name,
      CASE
        WHEN TJ.job_status = 9 THEN 'Unconfirmed'
        WHEN TJ.job_status = 0 AND TJ.fk_easyfixter_id IS NULL THEN 'Unallocated'
        WHEN TJ.job_status = 0 AND TJ.fk_easyfixter_id IS NOT NULL THEN 'Pending App Ack'
        WHEN TJ.job_status = 1 THEN 'Pending to Start'
        WHEN TJ.job_status IN (2, 20) THEN 'Open on App'
        WHEN TJ.job_status IN (3, 5) THEN 'Completed'
        WHEN TJ.job_status = 7 THEN 'Enquiry'
        WHEN TJ.job_status = 6 THEN 'Cancelled'
        WHEN TJ.job_status = 10 THEN 'Under Audit'
        WHEN TJ.job_status = 15 THEN 'Estimate Approval Pending'
        WHEN TJ.job_status = 21 THEN 'FOH'
        ELSE 'NA'
      END AS job_status_description,
      CASE
        WHEN TJ.job_status IN (3, 5) THEN FLOOR(TIMESTAMPDIFF(MINUTE, TJ.ticket_created_date_time, TJ.checkout_date_time) / 1440.0)
        WHEN TJ.job_status = 6 THEN FLOOR(TIMESTAMPDIFF(MINUTE, TJ.ticket_created_date_time, TJ.cancel_date_time) / 1440.0)
        WHEN TJ.job_status = 7 THEN FLOOR(TIMESTAMPDIFF(MINUTE, TJ.ticket_created_date_time, TJ.enquiry_date_time) / 1440.0)
        ELSE FLOOR(TIMESTAMPDIFF(MINUTE, TJ.ticket_created_date_time, NOW()) / 1440.0)
      END AS job_age,
      TJ.job_desc, TJ.fk_service_catg_id,
      TC.city_id, TC.state_user,
      TJ.job_status
    FROM tbl_job TJ
    LEFT JOIN tbl_address TA ON (TJ.fk_address_id = TA.address_id)
    LEFT JOIN tbl_city TC ON (TC.city_id = TA.city_id)
    LEFT JOIN tbl_state TS ON (TS.state_id = TC.state_id)
    LEFT JOIN tbl_user TU ON (TU.user_id = TC.state_user)
    LEFT JOIN tbl_service_catg TSC ON (TSC.service_catg_id = TJ.fk_service_catg_id)
    LEFT JOIN tbl_client TCL ON TCL.client_id = TJ.fk_client_id
    WHERE TJ.job_id = ?
  `;
  const [rows] = await pool.query(sql, [jobId]);
  if (rows.length === 0) {
    const e = new Error('This job ID does not exist.');
    e.status = 404;
    throw e;
  }
  const r = rows[0];
  // Reject closed / cancelled / completed / enquiry jobs.
  if ([3, 5, 6, 7].includes(r.job_status)) {
    return { comments: 'This Job is either closed or cancelled' };
  }
  return {
    referenceId: r.job_id,
    clientName: r.client_name,
    pin: r.pin_code,
    cityName: r.city_name,
    districtName: r.district,
    stateName: r.state_name,
    stateUserName: r.user_name,
    catgName: r.service_catg_name,
    jobStatus: r.job_status_description,
    jobAge: r.job_age,
    comments: r.job_desc,
    catgId: r.fk_service_catg_id,
    cityId: r.city_id,
    stateUser: r.state_user,
  };
}

// ── 6) txDetails() — getAllocateTxDetails ("Add Existing Technician" checklist) ──
async function txDetails(efrId, catgId) {
  const sql = `
    SELECT
      TE.efr_id AS efr_id,
      TE.efr_name, TE.efr_no,
      TCI.city_name,
      COUNT(DISTINCT TJ.job_id) AS total_jobs,
      EXISTS (
        SELECT 1 FROM easyfixer_service_type EST
         WHERE EST.easyfixer_id = TE.efr_id AND EST.service_category_id = ?
      ) AS category_match,
      TE.efr_status,
      TE.is_technician_verified
    FROM tbl_easyfixer TE
    LEFT JOIN tbl_job TJ ON TJ.fk_easyfixter_id = TE.efr_id
    LEFT JOIN tbl_city TCI ON TCI.city_id = TE.efr_cityId
    WHERE TE.efr_id = ? AND NOT (TE.efr_status <=> 3)
    GROUP BY TE.efr_id, TE.efr_name, TCI.city_name, TE.efr_status, TE.is_technician_verified
  `;
  const [rows] = await pool.query(sql, [catgId, efrId]);
  if (rows.length === 0) {
    const e = new Error('No record found.');
    e.status = 404;
    throw e;
  }
  const r = rows[0];
  return {
    efrName: r.efr_name,
    efrId: r.efr_id,
    efrNo: r.efr_no,
    cityName: r.city_name,
    supplyStatus: asBitNull(r.is_technician_verified) === 1 ? 'Active' : 'Not Active',
    txOrderCount: r.total_jobs || 0,
    categoryMatch: Number(r.category_match) === 1,
  };
}

// ── 7) txStatus() — getEasyfixerStatusByMobileNo ──────────────────────────
async function txStatus(mobileNo) {
  return resolveSupplyStatus(mobileNo);
}

// ── 8) txCount() — getActiveTxCountByCityAndCategory ──────────────────────
async function txCount(cityId, catgId) {
  const sql = `
    SELECT COUNT(DISTINCT(easyfixer_id)) AS cnt
    FROM easyfixer_service_type EST
    LEFT JOIN tbl_easyfixer TE ON (TE.efr_id = EST.easyfixer_id)
    WHERE EST.service_category_id = ?
      AND TE.efr_cityId = ?
      AND TE.efr_status = 1
      AND TE.is_technician_verified IS NOT NULL
  `;
  const [rows] = await pool.query(sql, [catgId, cityId]);
  return rows[0] ? rows[0].cnt || 0 : 0;
}

module.exports = {
  list,
  exportRows,
  detail,
  allocations,
  history,
  jobDetail,
  txDetails,
  txStatus,
  txCount,
  XLSX_COLUMNS,
  // Exposed for reuse/tests.
  _internals: { findGapAge, resolveSupplyStatus, resolveSupplyStatusBatch, normaliseFilters },
};
