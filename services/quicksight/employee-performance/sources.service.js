/*
 * QuickSight — Employee Performance: the LIVE DATABASE sources.
 *
 * compose() (./compose.js) turns normalised inputs into the dashboard object.
 * This module produces the JOB and CRM parts of those inputs, straight from
 * easyfix_core, and maps the people in them to employee keys. The uploaded
 * parts (emp detail, targets, TimeChamp, IVR) come from elsewhere.
 *
 * ─── OWNER DECISIONS THIS FILE IMPLEMENTS ──────────────────────────────────
 *
 * OPEN JOBS    every job currently in job_status IN (0,1,2,9,10,15,20,21),
 *              with NO date filter (Manage Jobs: Bucket Open + Job Status
 *              Select All). The set is DERIVED — every tbl_job status minus
 *              the terminal ones — never hand-typed a fourth time.
 * CLOSED JOBS  job_status IN (3,5) with checkout_date_time inside the window,
 *              the whole end day included, IST (Manage Jobs: Bucket Closed +
 *              Job Status Completed + Date Type Completed + Date Range).
 * BOTH are read THROUGH the Manage Jobs export (services/job-export.service.js):
 *              its filter builder, fetchExportChunk (keyset chunks, RBAC-free
 *              here — the report is global like the uploaded snapshot) and
 *              mapExportRow, so Aging, TAT, SDA, Margin, Pending Due To /
 *              Reason and the 'null' Zonal Manager are the SHEET's numbers, not
 *              a re-derivation. A default the builder imposes on its own (the
 *              6-month window) is refused loudly: the read must be exactly the
 *              owner's filter.
 * CRM DATA     Booked / Scheduled / Audit / Closed / Cancelled per user per
 *              IST day = the Employee Productivity report's own metrics query
 *              (getProductivityMetrics), half-open day windows.
 * WINDOW       the tab's Month / From-To; default the current IST month
 *              (1st .. today). See defaultWindow().
 * PRIMARY SPOC of a CLOSED job is FROZEN at first capture in tbl_qs_ep_job_spoc
 *              (captureSpocFreeze, run by the scheduler — never by a read).
 *              Reads use the frozen value when a row exists (a frozen NULL
 *              stays unattributed), else the CURRENT mapping via
 *              resolveClientPrimarySpoc (services/job.service.js), the one
 *              definition of that rule. No freeze table yet (migration not
 *              run) → every closed job uses the current mapping, silently.
 *              Open jobs always use the current mapping.
 * A & CO BY    tbl_job.fk_checkout_by.
 * PEOPLE       resolvePeople(): a user matches an employee by NAME — emp
 *              detail "CRM CURRENT NAME" plus build_data.py's canon_name
 *              aliases (Row Labels, EMPLOYE NAME; first claim wins) against
 *              tbl_user.user_name, trimmed and case-insensitive, internal
 *              non-technician users only — using THAT MONTH's emp detail.
 *              Nothing unmatched is dropped silently: it is reported as the
 *              "Unattributed" line.
 * WHO EXISTS   the uploaded emp detail, and nothing else (owner decision 6).
 *              A name shows for a month ONLY if that month's emp detail lists
 *              it: no employee is ever invented from a job SPOC or a CRM user,
 *              and a month with no emp detail uploaded has NO names at all — it
 *              does not inherit an earlier month's. Over a window of several
 *              months only the people on EVERY emp detail the window HAS are
 *              shown (owner decision 7), so nobody's figures are a half-window's
 *              of the months they cover; a month with no emp detail contributes
 *              no names and narrows nobody (owner, 2026-09-18).
 *              Everything a hidden or unrostered person did still counts: those
 *              rows go to the "Unattributed" line, which is why the totals
 *              always add up. Someone who has left stays visible in the past
 *              months whose emp detail listed them.
 *
 * GET PATHS NEVER WRITE. The only write in this file is captureSpocFreeze().
 */

'use strict';

const { pool } = require('../../../db');
const logger = require('../../../logger');
const jobService = require('../../job.service');
const jobExport = require('../../job-export.service');
const { INTERNAL_USER_TYPE_ID } = require('../../user.service');
const productivity = require('../quicksight-employee-productivity.service');
const { JOB_STATUS } = require('../_shared');
const { currentIstMonth, shiftMonth, shiftYmd, todayIst } = require('../../../utils/ist-calendar');
const { isAbsentAnswer } = require('../../../utils/schema-absent-error');
const { nameKey } = require('../../../utils/name-key');

/* ═══ Constants ═════════════════════════════════════════════════════════════ */

const FREEZE_TABLE = 'tbl_qs_ep_job_spoc';
// The label a job / A&CO / CRM row carries when it belongs to no employee.
const UNATTRIBUTED = 'Unattributed';

// tbl_user roles that are not office staff: 19 Technician, 21 Client Dashboard
// User (CLAUDE.md role model). Their names collide with real employees'.
const NON_STAFF_ROLES = Object.freeze([19, 21]);

// Every tbl_job status minus the terminal four — Manage Jobs' Open bucket.
const OPEN_STATUSES = Object.freeze([...jobService.ALL_STATUS_VALUES]
  .filter((s) => !JOB_STATUS.TERMINAL_EXCLUSION.includes(s))
  .sort((a, b) => a - b));
const CLOSED_STATUSES = Object.freeze([...JOB_STATUS.COMPLETED]);

const EXPORT_CHUNK_SIZE = 2000;     // the Manage Jobs export route's own chunk
const CAPTURE_CHUNK_SIZE = 5000;    // ids only — the export's MAX_CHUNK_SIZE
const ROW_CEILING = 200000;         // the export route's safety ceiling
const MAX_WINDOW_DAYS = 366;
const SPOC_LOOKUP_CONCURRENCY = 8;
const USER_LOOKUP_BATCH = 1000;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ═══ Small helpers ═════════════════════════════════════════════════════════ */

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/** A real calendar 'YYYY-MM-DD' (2026-02-30 is not). */
function isYmd(s) {
  if (typeof s !== 'string' || !YMD_RE.test(s)) return false;
  try {
    return shiftYmd(s, 0) === s;
  } catch {
    return false;
  }
}

function trimmed(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function toId(v) {
  const n = Number(v);
  return v !== null && v !== undefined && Number.isInteger(n) && n > 0 ? n : null;
}

function getOrSet(map, key, make) {
  let v = map.get(key);
  if (v === undefined) {
    v = make();
    map.set(key, v);
  }
  return v;
}

/** build_data.py vertical_or_none(): blank or a numeric zero is "no own vertical". */
function verticalOrNone(v) {
  const s = trimmed(v);
  if (s === null) return null;
  return Number(s) === 0 ? null : s;
}

/** The current IST month, 1st .. today — the tab's default window. */
function defaultWindow(now = new Date()) {
  return { from: `${currentIstMonth(now)}-01`, to: todayIst(now) };
}

function checkWindow({ from, to } = {}, now = new Date()) {
  const def = defaultWindow(now);
  const f = from === undefined || from === null || from === '' ? def.from : from;
  const t = to === undefined || to === null || to === '' ? def.to : to;
  if (!isYmd(f) || !isYmd(t)) throw badRequest('from and to must be real dates as YYYY-MM-DD');
  if (f > t) throw badRequest('from must be on or before to');
  const days = Math.round((Date.parse(`${t}T00:00:00Z`) - Date.parse(`${f}T00:00:00Z`)) / 86400000) + 1;
  if (days > MAX_WINDOW_DAYS) throw badRequest(`the window may span at most ${MAX_WINDOW_DAYS} days`);
  return { from: f, to: t };
}

function monthsBetween(from, to) {
  const out = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = shiftMonth(m, 1)) out.push(m);
  return out;
}

/* ═══ Reading through the Manage Jobs export ════════════════════════════════ */

/** The filter object, refused if the export's builder would add a default the owner did not ask for. */
function exportFilters(filters) {
  const { appliedDefaults } = jobExport.buildExportWhere(filters);
  if (appliedDefaults && appliedDefaults.length) {
    throw new Error('Employee Performance: the Manage Jobs filter builder imposed '
      + `${appliedDefaults.join(' · ')} — the live read must be exactly the owner's filter`);
  }
  return filters;
}

/** Keyset-walk the export (newest job first), handing each raw chunk to onChunk. */
async function forEachExportChunk(filters, onChunk) {
  let afterJobId = null;
  let total = 0;
  for (;;) {
    const chunk = await jobExport.fetchExportChunk({ filters, afterJobId, chunkSize: EXPORT_CHUNK_SIZE });
    if (!Array.isArray(chunk) || chunk.length === 0) return total;
    total += chunk.length;
    if (total > ROW_CEILING) {
      const err = new Error(`more than ${ROW_CEILING} jobs match — narrow the date range`);
      err.status = 422;
      throw err;
    }
    await onChunk(chunk);
    if (chunk.length < EXPORT_CHUNK_SIZE) return total;
    afterJobId = chunk[chunk.length - 1].job_id;
  }
}

/*
 * The columns both job kinds share, from the SHEET row (mapExportRow) with
 * build_data.py's blank rules made explicit as null: blank state / city stay
 * null (compose shows an em dash), and the export's legacy literal 'null'
 * Zonal Manager becomes null (compose shows 'Unassigned').
 */
function jobFields(m, raw) {
  const zm = trimmed(m.zonalManager);
  return {
    jobId: m.jobId,
    clientId: toId(raw.fk_client_id),
    vertical: trimmed(m.verticalName),
    state: trimmed(m.state),
    city: trimmed(m.city),
    client: trimmed(m.client),
    zm: zm === null || zm === 'null' ? null : zm,
    // Current TX Name is kept raw (build_data.py's sval_raw); only a blank is null.
    tx: m.txName === null || m.txName === undefined || m.txName === '' ? null : String(m.txName),
    txid: m.txId === null || m.txId === undefined ? null : String(m.txId),
  };
}

/* ═══ People lookups ════════════════════════════════════════════════════════ */

function primarySpocResolver() {
  const fn = jobService.resolveClientPrimarySpoc;
  if (typeof fn !== 'function') {
    throw new Error('services/job.service.js does not export resolveClientPrimarySpoc — Employee Performance '
      + 'resolves the Primary SPOC with that one rule and must not carry a copy of it');
  }
  return fn;
}

/**
 * client_id → current Primary SPOC user_id (or null), one resolveClientPrimarySpoc
 * call per distinct client, a few at a time. `memo` carries answers across calls.
 */
async function currentSpocByClient(clientIds, { db = pool, memo = new Map() } = {}) {
  const resolve = primarySpocResolver();
  const queue = [...new Set(clientIds.filter((id) => id !== null && id !== undefined && !memo.has(id)))];
  const worker = async () => {
    while (queue.length) {
      const clientId = queue.shift();
      memo.set(clientId, toId(await resolve(clientId, db)));
    }
  };
  await Promise.all(Array.from({ length: Math.min(SPOC_LOOKUP_CONCURRENCY, queue.length) }, worker));
  return memo;
}

/** user_id → { name, internal } for internal-staff matching. A deleted user is simply absent. */
async function loadUsers(userIds, db = pool) {
  const ids = [...new Set(userIds.map(toId).filter((id) => id !== null))];
  const users = new Map();
  for (let i = 0; i < ids.length; i += USER_LOOKUP_BATCH) {
    const [rows] = await db.query(
      'SELECT user_id, user_name, user_type_id, user_role FROM tbl_user WHERE user_id IN (?)',
      [ids.slice(i, i + USER_LOOKUP_BATCH)],
    );
    for (const r of rows) {
      users.set(Number(r.user_id), {
        name: trimmed(r.user_name),
        internal: Number(r.user_type_id) === INTERNAL_USER_TYPE_ID && !NON_STAFF_ROLES.includes(Number(r.user_role)),
      });
    }
  }
  return users;
}

function personOf(userId, users) {
  const u = userId === null ? undefined : users.get(userId);
  return { name: u ? u.name : null, internal: Boolean(u && u.internal) };
}

let freezeAbsentLogged = false;

/**
 * job_id → frozen spoc_user_id (null = frozen unattributed) for the ids that
 * have a row; null when the freeze table does not exist yet.
 */
async function readFrozenSpocs(jobIds, db = pool) {
  if (!jobIds.length) return new Map();
  try {
    const [rows] = await db.query(`SELECT job_id, spoc_user_id FROM ${FREEZE_TABLE} WHERE job_id IN (?)`, [jobIds]);
    return new Map(rows.map((r) => [Number(r.job_id), toId(r.spoc_user_id)]));
  } catch (e) {
    if (!isAbsentAnswer(e)) throw e;
    if (!freezeAbsentLogged) {
      freezeAbsentLogged = true;
      logger.info(`Employee Performance · ${FREEZE_TABLE} is not installed — closed jobs use the CURRENT Primary SPOC `
        + 'mapping until migrations/2026-09-16-create-qs-employee-performance-inputs.sql runs');
    }
    return null;
  }
}

/* ═══ 1. Open jobs ══════════════════════════════════════════════════════════ */

/**
 * Every currently open job, newest first, as compose() openRows plus ids.
 * `now` is the instant Aging is measured to (default: the clock).
 *
 * Row: { jobId, clientId, vertical, state, city, client, zm, tx, txid, aging,
 *        dueTo, reason, spoc: null, spocUserId, spocName, spocInternal,
 *        spocSource: 'mapping' }  — resolvePeople() fills `spoc`.
 */
async function loadOpenJobs({ now = new Date() } = {}) {
  const started = Date.now();
  const filters = exportFilters({ statuses: OPEN_STATUSES.join(','), statusSnapshot: true });
  const rows = [];
  await forEachExportChunk(filters, (chunk) => {
    for (const raw of chunk) {
      const m = jobExport.mapExportRow(raw, rows.length + 1, { now });
      rows.push({
        ...jobFields(m, raw),
        aging: m.aging,
        dueTo: trimmed(m.pendingDueTo),
        reason: trimmed(m.pendingReason),
        spoc: null,
        spocUserId: null,
        spocName: null,
        spocInternal: false,
        spocSource: 'mapping',
      });
    }
  });

  const spocByClient = await currentSpocByClient(rows.map((r) => r.clientId));
  const users = await loadUsers([...spocByClient.values()]);
  for (const r of rows) {
    r.spocUserId = r.clientId === null ? null : spocByClient.get(r.clientId) ?? null;
    const p = personOf(r.spocUserId, users);
    r.spocName = p.name;
    r.spocInternal = p.internal;
  }
  logger.info(`Employee Performance open jobs · rows=${rows.length} · clients=${spocByClient.size} · ${Date.now() - started}ms`);
  return rows;
}

/* ═══ 2. Closed jobs ════════════════════════════════════════════════════════ */

/**
 * Closed jobs checked out in [from, to] (IST days, both inclusive; default the
 * current IST month), ordered checkout DESC then job_id DESC — the order of
 * the MIS workbook's Close order sheet, which compose's first-seen tables
 * follow.
 *
 * Row: { jobId, clientId, date, spoc: null, spocUserId, spocName, spocInternal,
 *        spocSource: 'frozen'|'mapping', charge, margin, client, tat, sda, zm,
 *        vertical, tx, txid, aco: null, acoUserId, acoName, acoInternal }
 */
async function loadClosedJobs({ from, to, now = new Date() } = {}) {
  const started = Date.now();
  const window = checkWindow({ from, to }, now);
  const filters = exportFilters({
    statuses: CLOSED_STATUSES.join(','), dateType: 'completed', startDate: window.from, endDate: window.to,
  });

  const entries = [];
  const frozen = new Map();
  let freezeInstalled = true;
  await forEachExportChunk(filters, async (chunk) => {
    if (freezeInstalled) {
      const got = await readFrozenSpocs(chunk.map((raw) => Number(raw.job_id)));
      if (got === null) freezeInstalled = false;
      else for (const [jobId, userId] of got) frozen.set(jobId, userId);
    }
    for (const raw of chunk) {
      const m = jobExport.mapExportRow(raw, entries.length + 1);
      const f = jobFields(m, raw);
      entries.push({
        checkoutAt: raw.checkout_date_time === null || raw.checkout_date_time === undefined ? '' : String(raw.checkout_date_time),
        row: {
          jobId: f.jobId,
          clientId: f.clientId,
          date: jobExport.datePart(raw.checkout_date_time),
          spoc: null,
          spocUserId: null,
          spocName: null,
          spocInternal: false,
          spocSource: 'mapping',
          charge: m.totalCharge,
          margin: m.margin,
          client: f.client,
          tat: m.tatStatus,
          sda: m.sdaStatus,
          zm: f.zm,
          vertical: f.vertical,
          tx: f.tx,
          txid: f.txid,
          aco: null,
          acoUserId: toId(raw.fk_checkout_by),
          acoName: null,
          acoInternal: false,
        },
      });
    }
  });

  const rows = entries
    .sort((a, b) => {
      if (a.checkoutAt !== b.checkoutAt) return a.checkoutAt < b.checkoutAt ? 1 : -1;
      return b.row.jobId - a.row.jobId;
    })
    .map((e) => e.row);

  const spocByClient = await currentSpocByClient(rows.filter((r) => !frozen.has(r.jobId)).map((r) => r.clientId));
  let frozenCount = 0;
  for (const r of rows) {
    if (frozen.has(r.jobId)) {
      r.spocUserId = frozen.get(r.jobId);
      r.spocSource = 'frozen';
      frozenCount += 1;
    } else {
      r.spocUserId = r.clientId === null ? null : spocByClient.get(r.clientId) ?? null;
    }
  }
  const users = await loadUsers([...rows.map((r) => r.spocUserId), ...rows.map((r) => r.acoUserId)]);
  let revenue = 0;
  for (const r of rows) {
    const s = personOf(r.spocUserId, users);
    r.spocName = s.name;
    r.spocInternal = s.internal;
    const a = personOf(r.acoUserId, users);
    r.acoName = a.name;
    r.acoInternal = a.internal;
    revenue += Number(r.charge) || 0;
  }
  logger.info(`Employee Performance closed jobs · ${window.from}..${window.to} · rows=${rows.length} · revenue=${revenue}`
    + ` · frozenSpoc=${frozenCount} · mappingSpoc=${rows.length - frozenCount}`
    + ` · freezeTable=${freezeInstalled ? 'present' : 'absent'} · ${Date.now() - started}ms`);
  return rows;
}

/* ═══ 3. CRM data ═══════════════════════════════════════════════════════════ */

/**
 * Booked / Scheduled / Audit / Closed / Cancelled per user per IST day in
 * [from, to] (default the current IST month), from the Employee Productivity
 * report's metrics query. `userIds` narrows the users; omitted = every
 * internal user. Only (user, day) pairs with activity have a row.
 *
 * Row: { userId, userName, internal, date, booked, scheduled, audit, closed,
 *        cancelled, revenue }
 */
async function loadCrmCounts({ from, to, userIds = null, now = new Date() } = {}) {
  const window = checkWindow({ from, to }, now);
  const metrics = await productivity.getProductivityMetrics({
    from: window.from, to: window.to, userIds, groupByDay: true,
  });
  const users = await loadUsers(metrics.map((r) => r.userId));
  return metrics.map((r) => {
    const p = personOf(r.userId, users);
    return {
      userId: r.userId,
      userName: p.name,
      internal: p.internal,
      date: r.date,
      booked: r.booked,
      scheduled: r.scheduled,
      audit: r.audit,
      closed: r.closedCount,
      cancelled: r.cancelCount,
      revenue: r.revenue,
    };
  });
}

/* ═══ 4. People → employee keys ═════════════════════════════════════════════ */

function rosterList(rosterByMonth, month) {
  if (!rosterByMonth) return null;
  const list = rosterByMonth instanceof Map
    ? rosterByMonth.get(month)
    : (Object.prototype.hasOwnProperty.call(rosterByMonth, month) ? rosterByMonth[month] : undefined);
  return Array.isArray(list) && list.length ? list : null;
}

/**
 * One month's emp detail → { canon: nameKey → employee key, byKey: key → row }.
 * build_data.py's canon_name: rows in order, each claiming its CRM CURRENT
 * NAME, then Row Labels, then EMPLOYE NAME; the first claim of a name wins. A
 * repeated CRM name keeps its first position and its last row's data.
 */
function indexRoster(list) {
  const canon = new Map();
  const byKey = new Map();
  for (const row of list) {
    const key = trimmed(row && row.crmName);
    if (key === null) continue;
    byKey.set(key, row);
    for (const alias of [row.crmName, row.rowLabels ?? row.rowLabel, row.employeeName]) {
      if (trimmed(alias) === null) continue;
      const k = nameKey(alias);
      if (!canon.has(k)) canon.set(k, key);
    }
  }
  return { canon, byKey };
}

/**
 * Map the users on job and CRM rows to employee keys, month by month.
 *
 * @param {object} args
 * @param {{openRows?, closedRows?, crm?}} args.rows  loadOpenJobs / loadClosedJobs / loadCrmCounts output
 * @param {Object<string, Array>|Map} args.rosterByMonth  'YYYY-MM' → that month's emp detail rows:
 *        [{ crmName, employeeName, rowLabels, empId, vertical, team }]   (rowLabel is accepted too)
 *        ("CRM CURRENT NAME", "EMPLOYE NAME", "Row Labels", "EMP ID", "vertical",
 *        and that month's "Team Name"). Months outside the window are ignored:
 *        a window month's people are its OWN emp detail's, or none.
 * @param {{from: string, to: string}} args.window  the tab's window
 * @returns {{
 *   employees: Array<{key, display, vertical, teams}>,   compose inputs.employees — the VISIBLE people
 *   openRows, closedRows,   the input rows with `spoc` (and `aco`) = employee key or 'Unattributed'
 *   crm: Array<{key, date, booked, scheduled, audit, closed, cancelled}>,   matched rows only
 *   unattributed: {label, closedJobs, revenue, openJobs, acoJobs, acoRevenue,
 *                  crm: {rows, booked, scheduled, audit, closed, cancelled},
 *                  users: Array<{userId, name, reasons[], months[], closedJobs, revenue,
 *                                openJobs, acoJobs, acoRevenue, crmRows}>},
 *   months: Array<{month, rosterUploaded, employees, rosterSize}>,
 *   visibility: {mode: 'single'|'intersection', hidden: number, missingMonths: string[]},
 *   warnings: Array<{type, month, ...}>
 * }}
 *
 * months[].employees is how many names the window SHOWS for that month (0 with
 * no emp detail); months[].rosterSize is how many that month's emp detail lists.
 * They differ only when the intersection hides somebody, which
 * visibility.hidden counts.
 *
 * Open jobs belong to the window's LAST month (compose credits open jobs by
 * the latest month's roster); a closed job to its checkout month.
 */
function resolvePeople({ rows = {}, rosterByMonth = {}, window } = {}) {
  if (!window || !isYmd(window.from) || !isYmd(window.to) || window.from > window.to) {
    throw new TypeError('resolvePeople: window needs from <= to as YYYY-MM-DD');
  }
  const openIn = Array.isArray(rows.openRows) ? rows.openRows : [];
  const closedIn = Array.isArray(rows.closedRows) ? rows.closedRows : [];
  const crmIn = Array.isArray(rows.crm) ? rows.crm : [];
  const months = monthsBetween(window.from, window.to);
  const openMonth = months[months.length - 1];
  const monthOfDate = (d) => (isYmd(d) ? d.slice(0, 7) : openMonth);
  const warnings = [];

  // Each WINDOW month's own emp detail, indexed once. A month without one has
  // no roster at all: months outside the window lend it nothing, and nobody is
  // invented for it from the jobs or the CRM (owner decision 6).
  const info = new Map(months.map((M) => {
    const list = rosterList(rosterByMonth, M);
    return [M, list ? { uploaded: true, ...indexRoster(list) } : { uploaded: false, canon: null, byKey: null }];
  }));

  // ── Who the window shows (owner decision 7) ────────────────────────────────
  // One month: the people on its emp detail. Several: only the people on EVERY
  // emp detail the window HAS, so a name's figure is never a half-window's
  // across the months it covers. A month with no emp detail names nobody and
  // narrows nobody (owner, 2026-09-18): it simply contributes no names, its own
  // rows go to the Unattributed line, and visibility.missingMonths /
  // months[].rosterUploaded lets the tab say which months the names cover.
  // No emp detail anywhere in the window → no names at all. Hiding someone
  // never loses their work: resolve() below sends their rows to Unattributed.
  const rosteredMonths = months.filter((M) => info.get(M).uploaded);
  const everyone = new Set();
  for (const M of rosteredMonths) for (const key of info.get(M).byKey.keys()) everyone.add(key);
  const visible = new Set([...everyone]
    .filter((key) => rosteredMonths.every((M) => info.get(M).byKey.has(key))));

  // ── Resolution ─────────────────────────────────────────────────────────────
  const matchedUsers = new Map();   // month → key → Set(userId)
  const resolve = (userIdRaw, name, internal, M) => {
    const userId = toId(userIdRaw);
    if (userId === null) return { key: null, reason: 'no-user' };
    const m = info.get(M);
    if (!m) return { key: null, reason: 'outside-window' };
    if (!m.uploaded) return { key: null, reason: 'roster-not-uploaded' };
    if (trimmed(name) === null) return { key: null, reason: 'unknown-user' };
    if (!internal) return { key: null, reason: 'not-internal' };
    const key = m.canon.get(nameKey(name));
    if (!key) return { key: null, reason: 'not-on-roster' };
    // On THIS month's emp detail but not on every month of the window that has
    // one — showing them would be a part-window figure under a full-window head.
    if (!visible.has(key)) return { key: null, reason: 'not-on-every-roster' };
    getOrSet(getOrSet(matchedUsers, M, () => new Map()), key, () => new Set()).add(userId);
    return { key };
  };

  const crmZero = () => ({ rows: 0, booked: 0, scheduled: 0, audit: 0, closed: 0, cancelled: 0 });
  const totals = { closedJobs: 0, revenue: 0, openJobs: 0, acoJobs: 0, acoRevenue: 0, crm: crmZero() };
  const unUsers = new Map();
  const miss = (userIdRaw, name, reason, M) => {
    const userId = toId(userIdRaw);
    const u = getOrSet(unUsers, userId === null ? 'none' : String(userId), () => ({
      userId, name: trimmed(name), reasons: new Set(), months: new Set(),
      closedJobs: 0, revenue: 0, openJobs: 0, acoJobs: 0, acoRevenue: 0, crmRows: 0,
    }));
    u.reasons.add(reason);
    u.months.add(M);
    return u;
  };

  const closedRows = closedIn.map((r) => {
    const M = monthOfDate(r.date);
    const charge = Number(r.charge) || 0;
    const s = resolve(r.spocUserId, r.spocName, r.spocInternal, M);
    if (!s.key) {
      const u = miss(r.spocUserId, r.spocName, s.reason, M);
      u.closedJobs += 1;
      u.revenue += charge;
      totals.closedJobs += 1;
      totals.revenue += charge;
    }
    const a = resolve(r.acoUserId, r.acoName, r.acoInternal, M);
    if (!a.key) {
      const u = miss(r.acoUserId, r.acoName, a.reason, M);
      u.acoJobs += 1;
      u.acoRevenue += charge;
      totals.acoJobs += 1;
      totals.acoRevenue += charge;
    }
    return { ...r, spoc: s.key || UNATTRIBUTED, aco: a.key || UNATTRIBUTED };
  });

  const openRows = openIn.map((r) => {
    const s = resolve(r.spocUserId, r.spocName, r.spocInternal, openMonth);
    if (!s.key) {
      miss(r.spocUserId, r.spocName, s.reason, openMonth).openJobs += 1;
      totals.openJobs += 1;
    }
    return { ...r, spoc: s.key || UNATTRIBUTED };
  });

  const crm = [];
  for (const r of crmIn) {
    const M = monthOfDate(r.date);
    const res = resolve(r.userId, r.userName, r.internal, M);
    if (res.key) {
      crm.push({ key: res.key, date: r.date, booked: r.booked, scheduled: r.scheduled, audit: r.audit,
        closed: r.closed, cancelled: r.cancelled });
      continue;
    }
    miss(r.userId, r.userName, res.reason, M).crmRows += 1;
    totals.crm.rows += 1;
    for (const f of ['booked', 'scheduled', 'audit', 'closed', 'cancelled']) totals.crm[f] += Number(r[f]) || 0;
  }

  for (const [M, byKey] of matchedUsers) {
    for (const [key, ids] of byKey) {
      if (ids.size > 1) warnings.push({ type: 'shared-name', month: M, key, userIds: [...ids].sort((a, b) => a - b) });
    }
  }

  // ── compose() employees ────────────────────────────────────────────────────
  // Months ascend, so a person's display name and vertical are their latest
  // month's; teams carries one entry per month they are on (all of them, since
  // the visible are on every month).
  const employees = new Map();
  const monthSummary = [];
  for (const M of months) {
    const m = info.get(M);
    if (m.uploaded) {
      for (const [key, row] of m.byKey) {
        if (!visible.has(key)) continue;
        const e = getOrSet(employees, key, () => ({ key, display: '', vertical: null, teams: {} }));
        e.teams[M] = trimmed(row.team) ?? '';
        e.display = trimmed(row.employeeName) ?? '';
        e.vertical = verticalOrNone(row.vertical);
      }
    }
    monthSummary.push({
      month: M,
      rosterUploaded: m.uploaded,
      employees: m.uploaded ? visible.size : 0,
      rosterSize: m.uploaded ? m.byKey.size : 0,
    });
  }

  const users = [...unUsers.values()]
    .map((u) => ({ ...u, reasons: [...u.reasons].sort(), months: [...u.months].sort() }))
    .sort((a, b) => (b.revenue - a.revenue) || (b.openJobs - a.openJobs) || ((a.userId ?? 0) - (b.userId ?? 0)));

  return {
    employees: [...employees.values()],
    openRows,
    closedRows,
    crm,
    unattributed: { label: UNATTRIBUTED, ...totals, users },
    months: monthSummary,
    visibility: {
      // 'intersection' only when more than one month actually HAS an emp detail
      // — that is the only case where being absent from one narrows the list.
      mode: rosteredMonths.length > 1 ? 'intersection' : 'single',
      hidden: everyone.size - visible.size,
      // The window months with no emp detail: nobody is named for them and
      // their rows are Unattributed, so the tab can name them in its note. The
      // months the names DO cover are months[] minus these, so they are not
      // repeated here.
      missingMonths: months.filter((M) => !info.get(M).uploaded),
    },
    warnings,
  };
}

/* ═══ 5. The SPOC freeze (scheduled job — the only write here) ══════════════ */

/**
 * Freeze the Primary SPOC of every closed job checked out since `since`
 * ('YYYY-MM-DD'; default the 1st of the previous IST month) that has no
 * tbl_qs_ep_job_spoc row yet, using the CURRENT mapping rule
 * (resolveClientPrimarySpoc). First capture wins forever: the insert is a
 * no-op for a job another run already captured. A job whose client has no
 * Primary SPOC is frozen as NULL (unattributed).
 *
 * Candidates are selected through the Manage Jobs export's own filter builder
 * (the same statuses / checkout window loadClosedJobs reads), ids only.
 * `db` carries the freeze-table and tbl_job reads and the insert.
 *
 * Returns { skipped, reason?, since, to, scanned, alreadyFrozen, captured,
 *           capturedWithoutSpoc, ms }. Skips cleanly when the table is absent.
 */
async function captureSpocFreeze({ since, db = pool, now = new Date() } = {}) {
  const started = Date.now();
  const to = todayIst(now);
  const from = since === undefined || since === null || since === '' ? `${shiftMonth(currentIstMonth(now), -1)}-01` : since;
  if (!isYmd(from) || from > to) throw badRequest('since must be a real date as YYYY-MM-DD, not after today (IST)');
  const result = { skipped: false, since: from, to, scanned: 0, alreadyFrozen: 0, captured: 0, capturedWithoutSpoc: 0, ms: 0 };

  try {
    await db.query(`SELECT job_id FROM ${FREEZE_TABLE} LIMIT 1`);
  } catch (e) {
    if (!isAbsentAnswer(e)) throw e;
    return { ...result, skipped: true, reason: `${FREEZE_TABLE} does not exist — run migrations/2026-09-16-create-qs-employee-performance-inputs.sql`, ms: Date.now() - started };
  }

  const filters = exportFilters({
    statuses: CLOSED_STATUSES.join(','), dateType: 'completed', startDate: from, endDate: to,
  });
  const memo = new Map();
  let afterJobId = null;
  for (;;) {
    const ids = await jobExport.fetchExportJobIds({ filters, afterJobId, chunkSize: CAPTURE_CHUNK_SIZE });
    if (ids.length === 0) break;
    result.scanned += ids.length;

    const [have] = await db.query(`SELECT job_id FROM ${FREEZE_TABLE} WHERE job_id IN (?)`, [ids]);
    const haveSet = new Set(have.map((r) => Number(r.job_id)));
    result.alreadyFrozen += haveSet.size;
    const missing = ids.filter((id) => !haveSet.has(id));
    if (missing.length) {
      const [jobs] = await db.query('SELECT job_id, fk_client_id FROM tbl_job WHERE job_id IN (?)', [missing]);
      const spocByClient = await currentSpocByClient(jobs.map((j) => toId(j.fk_client_id)), { db, memo });
      const capturedOn = new Date();
      const values = jobs.map((j) => {
        const clientId = toId(j.fk_client_id);
        return [Number(j.job_id), clientId === null ? null : spocByClient.get(clientId) ?? null, capturedOn];
      });
      if (values.length) {
        const [res] = await db.query(
          `INSERT INTO ${FREEZE_TABLE} (job_id, spoc_user_id, captured_on) VALUES ? ON DUPLICATE KEY UPDATE job_id = job_id`,
          [values],
        );
        const inserted = res && Number.isFinite(Number(res.affectedRows)) ? Number(res.affectedRows) : values.length;
        result.captured += inserted;
        result.capturedWithoutSpoc += values.filter((v) => v[1] === null).length;
      }
    }
    if (ids.length < CAPTURE_CHUNK_SIZE) break;
    afterJobId = ids[ids.length - 1];
  }
  result.ms = Date.now() - started;
  return result;
}

module.exports = {
  OPEN_STATUSES,
  CLOSED_STATUSES,
  UNATTRIBUTED,
  FREEZE_TABLE,
  defaultWindow,
  loadOpenJobs,
  loadClosedJobs,
  loadCrmCounts,
  resolvePeople,
  captureSpocFreeze,
};
