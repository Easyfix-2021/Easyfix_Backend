const { pool } = require('../db');
const logger = require('../logger');
const attendancePref = require('./attendance-preference.service');
const holidays = require('./holiday.service');
const { getProperty } = require('./properties.service');
const { todayIst, shiftYmd, shiftMonth, currentIstMonth, monthBounds } = require('../utils/ist-calendar');

/*
 * Team Roster — per-date overrides of a CRM user's weekly working days.
 *
 * THE ONE RULE everything reads through (resolveDays): for (user, date),
 *   1. a tbl_employee_roster row wins                → source 'ROSTER'
 *   2. else the weekday column of the preference     → source 'WEEKLY'
 *   3. no preference row at all = 7 working days     → never an invented WO
 * There is no "on roster" flag: a user is on the roster for a date exactly when
 * a row exists for it. Holidays are display-only (ops works holidays).
 *
 * Writers: saveCells (GRID), fillPattern (PATTERN), resetRange
 * (delete → back to weekly). Each is ONE transaction: action-log row, the row
 * writes, then one change-log row per value that really changed.
 */

const DAY_TYPES = attendancePref.DAY_TYPES;
const MAX_RANGE_DAYS = 62;
const MAX_CELLS = 5000;
const DEFAULT_HORIZON_MONTHS = 3;
const ACTION_SOURCE = Object.freeze({ SAVE_GRID: 'GRID', FILL_PATTERN: 'PATTERN', COPY_MONTH: 'COPY', RESET: 'RESET' });

function mkErr(status, message) { const e = new Error(message); e.status = status; return e; }

const YMD_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
function assertYmd(v, name) {
  if (!YMD_RE.test(String(v || ''))) throw mkErr(400, `${name} must be YYYY-MM-DD`);
  return String(v);
}

/** Inclusive list of 'YYYY-MM-DD' from..to. */
function listDates(from, to) {
  const out = [];
  for (let d = from; d <= to; d = shiftYmd(d, 1)) out.push(d);
  return out;
}

/** 0 = Monday … 6 = Sunday, matching DAY_KEYS and the Fill From Pattern chips. */
function weekdayIndex(ymd) { return attendancePref.DAY_KEYS.indexOf(attendancePref.dayKeyOfDate(ymd)); }

/*
 * Editable dates. From TOMORROW (IST) — a same-day change goes through a roster
 * admin (isRosterAdmin), who may also edit today. Up to the last day of the Nth
 * calendar month after this one (N = easyfix_properties roster.horizon.months,
 * default 3): on 29 Sep → 31 Dec. Past dates are locked for everyone.
 */
function editWindow({ canEditToday = false, now = new Date() } = {}) {
  const today = todayIst(now);
  const n = Number(getProperty('roster.horizon.months'));
  const horizon = Number.isInteger(n) && n >= 1 && n <= 12 ? n : DEFAULT_HORIZON_MONTHS;
  const editTo = shiftYmd(monthBounds(shiftMonth(currentIstMonth(now), horizon)).end, -1);
  return { today, editFrom: canEditToday ? today : shiftYmd(today, 1), editTo };
}

function isMissingTable(e) { return attendancePref.isMissingTable(e); }

async function loadRosterRows(userIds, from, to, runner = pool) {
  if (!userIds.length) return [];
  try {
    const [rows] = await runner.query(
      `SELECT user_id, DATE_FORMAT(roster_date, '%Y-%m-%d') AS roster_date, day_type,
              TIME_FORMAT(shift_start, '%H:%i') AS shift_start, source
         FROM tbl_employee_roster
        WHERE user_id IN (${userIds.map(() => '?').join(',')}) AND roster_date BETWEEN ? AND ?`,
      [...userIds, from, to]
    );
    return rows;
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    logger.warn('Roster read skipped · table missing — apply migrations/2026-09-29-employee-roster-01-tables.sql');
    return [];
  }
}

/*
 * THE resolution. Returns { byUser: Map<userId, { [date]: cell }>, prefs } where
 * cell = { type, shift, source, rowSource }. rowSource (GRID/PATTERN/COPY) is
 * internal — it powers "keep cells already edited by hand".
 */
async function resolveDays(userIds, from, to) {
  const ids = [...new Set(userIds.map(Number).filter(Boolean))];
  const [prefs, rows] = await Promise.all([attendancePref.loadPreferences(ids), loadRosterRows(ids, from, to)]);
  const planned = new Map();
  for (const r of rows) planned.set(`${r.user_id}|${r.roster_date}`, r);
  const dates = listDates(from, to);
  const byUser = new Map();
  for (const uid of ids) {
    const pref = prefs.get(uid) || attendancePref.defaultPreference();
    const days = {};
    for (const d of dates) {
      const r = planned.get(`${uid}|${d}`);
      days[d] = r
        ? { type: r.day_type === 'WO' ? 'WO' : 'PR', shift: r.shift_start || pref.default_shift_start, source: 'ROSTER', rowSource: r.source }
        : { type: pref[attendancePref.dayKeyOfDate(d)] === 'WO' ? 'WO' : 'PR', shift: pref.default_shift_start, source: 'WEEKLY', rowSource: null };
    }
    byUser.set(uid, days);
  }
  return { byUser, prefs };
}

/** Set of the given user ids who are on Week Off on `date` (default: today IST). */
async function weekOffSet(userIds, date = todayIst()) {
  const { byUser } = await resolveDays(userIds, date, date);
  const out = new Set();
  for (const [uid, days] of byUser) if (days[date].type === 'WO') out.add(uid);
  return out;
}

// ─── Scope ────────────────────────────────────────────────────────────
/*
 * Who may the actor plan for? Their hierarchy descendants (reporting_manager
 * DFS), never themselves; a roster admin (isRosterAdmin) — anyone but themselves.
 * Always only ACTIVE internal users.
 */
async function actorReach(actorId, isAdmin) {
  const { findDescendantUserIds } = require('./user.service');
  const { descendants } = await findDescendantUserIds(actorId);
  return { actorId: Number(actorId), isAdmin: Boolean(isAdmin), descendants: new Set(descendants.map(Number)) };
}

function canEditUser(reach, uid) {
  if (uid === reach.actorId) return false;
  return reach.isAdmin || reach.descendants.has(uid);
}

async function loadActiveUsers(userIds) {
  if (!userIds.length) return [];
  const [rows] = await pool.query(
    `SELECT u.user_id, u.user_name, u.user_code, u.reporting_manager, r.role_name
       FROM tbl_user u LEFT JOIN tbl_role r ON r.role_id = u.user_role
      WHERE u.user_id IN (${userIds.map(() => '?').join(',')}) AND u.user_status = 1 AND u.user_type_id = 5
      ORDER BY u.user_name`,
    userIds
  );
  return rows;
}

/** 403 unless every id is an active user the actor may edit. Returns Map<id, user_code>. */
async function assertEditable(reach, userIds) {
  const ids = [...new Set(userIds.map(Number))];
  if (!ids.length) throw mkErr(400, 'No members selected');
  const denied = ids.filter((id) => !canEditUser(reach, id));
  if (denied.length) throw mkErr(403, 'You can only plan the roster for your own team members, not yourself');
  const users = await loadActiveUsers(ids);
  if (users.length !== ids.length) throw mkErr(400, 'Some selected members are inactive or not CRM users');
  return new Map(users.map((u) => [Number(u.user_id), u.user_code || null]));
}

function assertInWindow(win, dates) {
  const bad = dates.find((d) => d < win.editFrom || d > win.editTo);
  if (bad) throw mkErr(400, `Date ${bad} is outside the editable range ${win.editFrom} → ${win.editTo}`);
}

// ─── Reads ────────────────────────────────────────────────────────────
/*
 * teamOf absent = "All Employees": a roster admin sees every active employee;
 * anyone else sees themselves + their reporting line. teamOf = that manager +
 * their hierarchy (within reach). maxDays: 62 for the grid, more for export.
 */
async function getGrid({ actorId, isAdmin, from, to, teamOf, maxDays = MAX_RANGE_DAYS }) {
  assertYmd(from, 'from'); assertYmd(to, 'to');
  if (from > to) throw mkErr(400, 'from must be on or before to');
  if (listDates(from, to).length > maxDays) throw mkErr(400, `Range cannot exceed ${maxDays} days`);

  const reach = await actorReach(actorId, isAdmin);
  const root = teamOf ? Number(teamOf) : reach.actorId;
  if (root !== reach.actorId && !reach.isAdmin && !reach.descendants.has(root)) {
    throw mkErr(403, 'That team is outside your reporting line');
  }
  const { findDescendantUserIds } = require('./user.service');
  let scopeIds;
  if (!teamOf && reach.isAdmin) {
    // ponytail: every active employee in one grid (71 on QA); page it if this grows to thousands.
    const [all] = await pool.query('SELECT user_id FROM tbl_user WHERE user_status = 1 AND user_type_id = 5');
    scopeIds = all.map((r) => Number(r.user_id));
  } else {
    const { descendants } = await findDescendantUserIds(root);
    scopeIds = [root, ...descendants];
  }
  const users = await loadActiveUsers(scopeIds);
  const ids = users.map((u) => Number(u.user_id));
  const { byUser, prefs } = await resolveDays(ids, from, to);
  const win = editWindow({ canEditToday: reach.isAdmin });
  const dates = listDates(from, to);

  const members = users.map((u) => {
    const uid = Number(u.user_id);
    const days = {};
    for (const d of dates) { const c = byUser.get(uid)[d]; days[d] = { type: c.type, shift: c.shift, source: c.source }; }
    return {
      userId: uid, name: u.user_name, empCode: u.user_code || null, roleName: u.role_name || null,
      editable: canEditUser(reach, uid),
      // The preference's shift — independent of any planned row's own shift.
      defaultShift: prefs.get(uid)?.default_shift_start || null,
      days,
    };
  });

  const headcount = {};
  for (const d of dates) {
    headcount[d] = { onDuty: members.filter((m) => m.days[d].type === 'PR').length, total: members.length };
  }

  // Team selector: people with direct reports, within the actor's reach.
  const [mgrRows] = await pool.query(
    `SELECT DISTINCT m.user_id, m.user_name
       FROM tbl_user u JOIN tbl_user m ON m.user_id = u.reporting_manager
      WHERE u.user_status = 1 AND u.user_type_id = 5 AND m.user_status = 1
      ORDER BY m.user_name`
  );
  const managers = mgrRows
    .filter((m) => reach.isAdmin || Number(m.user_id) === reach.actorId || reach.descendants.has(Number(m.user_id)))
    .map((m) => ({ userId: Number(m.user_id), name: m.user_name }));

  return { window: win, dates, holidays: holidays.getRange({ from, to }), managers, members, headcount };
}

/*
 * Dashboard: the caller's own next `days` days, their next week off (looked up
 * to 90 days ahead), and — for anyone with reports — today's team status.
 */
async function getMine(userId, { days = 14 } = {}) {
  const uid = Number(userId);
  const today = todayIst();
  const span = Math.max(1, Math.min(Number(days) || 14, 31));
  const lookahead = shiftYmd(today, 90);
  const { byUser } = await resolveDays([uid], today, lookahead);
  const mine = byUser.get(uid);
  const hol = new Map(holidays.getRange({ from: today, to: shiftYmd(today, span - 1) }).map((h) => [h.date, h.name]));
  const list = listDates(today, shiftYmd(today, span - 1)).map((d) => ({
    date: d, type: mine[d].type, shift: mine[d].shift, source: mine[d].source,
    holiday: hol.has(d) ? { name: hol.get(d) } : null,
  }));
  const nextWeekOff = listDates(shiftYmd(today, 1), lookahead).find((d) => mine[d].type === 'WO') || null;

  const { findDescendantUserIds } = require('./user.service');
  const { descendants } = await findDescendantUserIds(uid);
  let team = null;
  if (descendants.length) {
    const users = await loadActiveUsers(descendants);
    const off = await weekOffSet(users.map((u) => Number(u.user_id)), today);
    const offToday = users.filter((u) => off.has(Number(u.user_id))).map((u) => ({ userId: Number(u.user_id), name: u.user_name }));
    team = { date: today, total: users.length, weekOff: offToday.length, onDuty: users.length - offToday.length, offToday };
  }
  return { days: list, nextWeekOff, team };
}

// ─── Writes ───────────────────────────────────────────────────────────
/*
 * Human summary for the Action Log (the UI adds the verb and the employee
 * count): "01 Oct – 31 Dec 2026", optionally "· Week Off: Wed · Shift 01:00 PM".
 */
function rangeLabel(from, to) {
  const d = (ymd) => `${ymd.slice(8)} ${MONTH_ABBR[Number(ymd.slice(5, 7)) - 1]}`;
  if (from === to) return `${d(from)} ${from.slice(0, 4)}`;
  return from.slice(0, 4) === to.slice(0, 4) ? `${d(from)} – ${d(to)} ${to.slice(0, 4)}` : `${d(from)} ${from.slice(0, 4)} – ${d(to)} ${to.slice(0, 4)}`;
}

async function insertAction(conn, { action, actorId, scope, params, users, cells, status = 200 }) {
  const [r] = await conn.query(
    `INSERT INTO tbl_employee_roster_action_log
       (action, actor_user_id, scope_summary, params, affected_users, affected_cells, status_code, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [action, actorId, String(scope || '').slice(0, 500), params ? JSON.stringify(params).slice(0, 60000) : null,
      users, cells, status, new Date()]
  );
  return r.insertId;
}

/*
 * Best-effort record of a DENIED or failed attempt (4xx/5xx), written outside
 * any transaction. Never throws — the real error must reach the caller.
 */
async function logFailedAction({ action, actorId, scope, status }) {
  try {
    await insertAction(pool, { action, actorId, scope, users: 0, cells: 0, status });
  } catch (e) {
    logger.warn('Roster action log write failed · action=' + action + ' · ' + e.message);
  }
}

/*
 * Upsert planned cells and log what really changed. `cells`:
 * [{ userId, date, dayType, shift (string|null|undefined = keep existing) }].
 * Existing rows are read FOR UPDATE inside the caller's transaction.
 */
async function applyCells(conn, { actorId, actionId, source, cells, empCodes }) {
  if (!cells.length) return 0;
  const pairs = cells.map((c) => [c.userId, c.date]);
  const [existing] = await conn.query(
    `SELECT user_id, DATE_FORMAT(roster_date, '%Y-%m-%d') AS roster_date, day_type,
            TIME_FORMAT(shift_start, '%H:%i') AS shift_start
       FROM tbl_employee_roster
      WHERE (user_id, roster_date) IN (${pairs.map(() => '(?, ?)').join(', ')})
      FOR UPDATE`,
    pairs.flat()
  );
  const prior = new Map(existing.map((r) => [`${r.user_id}|${r.roster_date}`, r]));
  const now = new Date();
  const writes = [];
  const logs = [];
  for (const c of cells) {
    const old = prior.get(`${c.userId}|${c.date}`);
    const shift = c.shift === undefined ? (old ? old.shift_start : null) : c.shift;
    const oldType = old ? old.day_type : null;
    const oldShift = old ? old.shift_start : null;
    if (old && oldType === c.dayType && (oldShift || null) === (shift || null)) continue;

    writes.push([c.userId, empCodes.get(c.userId) ?? null, c.date, c.dayType, shift || null, source, actorId, now]);
    if (oldType !== c.dayType) logs.push([actionId, c.userId, c.date, 'day_type', oldType, c.dayType, actorId, now]);
    if ((oldShift || null) !== (shift || null)) logs.push([actionId, c.userId, c.date, 'shift_start', oldShift, shift || null, actorId, now]);
  }
  for (let i = 0; i < writes.length; i += 500) {
    const chunk = writes.slice(i, i + 500);
    await conn.query(
      `INSERT INTO tbl_employee_roster
         (user_id, emp_code, roster_date, day_type, shift_start, source, updated_by, updated_at)
       VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
       ON DUPLICATE KEY UPDATE emp_code = VALUES(emp_code), day_type = VALUES(day_type),
         shift_start = VALUES(shift_start), source = VALUES(source),
         updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
      chunk.flat()
    );
  }
  await insertChangeLogs(conn, logs);
  return writes.length;
}

async function insertChangeLogs(conn, logs) {
  for (let i = 0; i < logs.length; i += 500) {
    const chunk = logs.slice(i, i + 500);
    await conn.query(
      `INSERT INTO tbl_employee_roster_change_log
         (action_id, user_id, roster_date, field, old_value, new_value, changed_by, created_at)
       VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      chunk.flat()
    );
  }
}

async function inTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

function normaliseShift(v, name) {
  if (v === undefined) return undefined;
  const s = attendancePref.toShift(v);
  if (s === undefined) throw mkErr(400, `${name} must be a :00 or :30 time (HH:MM)`);
  return s;
}

/** Save Grid. */
async function saveCells({ actorId, isAdmin, cells }) {
  if (!Array.isArray(cells) || !cells.length) throw mkErr(400, 'No changes to save');
  if (cells.length > MAX_CELLS) throw mkErr(400, `At most ${MAX_CELLS} cells per save`);
  const dedup = new Map();
  for (const c of cells) {
    const userId = Number(c.userId);
    const date = assertYmd(c.date, 'date');
    const dayType = String(c.dayType || '').toUpperCase();
    if (!userId) throw mkErr(400, 'userId is required');
    if (!DAY_TYPES.includes(dayType)) throw mkErr(400, 'dayType must be PR or WO');
    dedup.set(`${userId}|${date}`, { userId, date, dayType, shift: normaliseShift(c.shiftStart, 'shiftStart') });
  }
  const list = [...dedup.values()];
  const win = editWindow({ canEditToday: isAdmin });
  assertInWindow(win, list.map((c) => c.date));
  const reach = await actorReach(actorId, isAdmin);
  const empCodes = await assertEditable(reach, list.map((c) => c.userId));
  const users = new Set(list.map((c) => c.userId)).size;

  const changed = await inTransaction(async (conn) => {
    const actionId = await insertAction(conn, {
      action: 'SAVE_GRID', actorId, users, cells: list.length,
      scope: rangeLabel(list.reduce((m, c) => (c.date < m ? c.date : m), list[0].date), list.reduce((m, c) => (c.date > m ? c.date : m), list[0].date)),
    });
    return applyCells(conn, { actorId, actionId, source: 'GRID', cells: list, empCodes });
  });
  logger.info('Roster grid saved · actor=' + actorId + ' · cells=' + list.length + ' · changed=' + changed);
  return { saved: list.length, changed };
}

function parseRange(from, to, win) {
  assertYmd(from, 'from'); assertYmd(to, 'to');
  if (from > to) throw mkErr(400, 'from must be on or before to');
  assertInWindow(win, [from, to]);
  return listDates(from, to);
}

/** Fill From Pattern (dryRun → counts only). */
async function fillPattern({ actorId, isAdmin, userIds, from, to, weekOffDays, shiftStart, keepManual = true, dryRun = false }) {
  const win = editWindow({ canEditToday: isAdmin });
  const dates = parseRange(from, to, win);
  const offs = new Set((weekOffDays || []).map(Number));
  if ([...offs].some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw mkErr(400, 'weekOffDays must be 0 (Mon) … 6 (Sun)');
  if (offs.size === 7) throw mkErr(400, 'At least one day must be a working day');
  const shift = normaliseShift(shiftStart ?? null, 'shiftStart');
  const reach = await actorReach(actorId, isAdmin);
  const empCodes = await assertEditable(reach, userIds || []);
  const ids = [...empCodes.keys()];

  const existing = await loadRosterRows(ids, from, to);
  const manual = new Set(existing.filter((r) => r.source === 'GRID').map((r) => `${r.user_id}|${r.roster_date}`));
  const cells = [];
  let kept = 0;
  for (const uid of ids) {
    for (const d of dates) {
      if (keepManual && manual.has(`${uid}|${d}`)) { kept++; continue; }
      cells.push({ userId: uid, date: d, dayType: offs.has(weekdayIndex(d)) ? 'WO' : 'PR', shift });
    }
  }
  const counts = {
    users: ids.length, cells: cells.length, keptManual: kept,
    wo: cells.filter((c) => c.dayType === 'WO').length, pr: cells.filter((c) => c.dayType === 'PR').length,
  };
  if (dryRun) return counts;

  const dayNames = [...offs].sort().map((i) => DAY_ABBR[i]);
  const extra = `${rangeLabel(from, to)} · Week Off: ${dayNames.join(', ') || 'None'} · ${shift ? 'Shift ' + shift12(shift) : 'Default Shift'}`;
  await inTransaction(async (conn) => {
    const actionId = await insertAction(conn, {
      action: 'FILL_PATTERN', actorId, scope: extra,
      params: { userIds: ids, from, to, weekOffDays: [...offs], shiftStart: shift, keepManual }, users: ids.length, cells: cells.length,
    });
    await applyCells(conn, { actorId, actionId, source: 'PATTERN', cells, empCodes });
  });
  logger.info('Roster pattern filled · actor=' + actorId + ' · users=' + ids.length + ' · cells=' + cells.length);
  return counts;
}

/** Reset To Weekly Days: delete planned rows in range. */
async function resetRange({ actorId, isAdmin, userIds, from, to }) {
  const win = editWindow({ canEditToday: isAdmin });
  parseRange(from, to, win);
  const reach = await actorReach(actorId, isAdmin);
  const empCodes = await assertEditable(reach, userIds || []);
  const ids = [...empCodes.keys()];

  const removed = await inTransaction(async (conn) => {
    const [rows] = await conn.query(
      `SELECT user_id, DATE_FORMAT(roster_date, '%Y-%m-%d') AS roster_date, day_type
         FROM tbl_employee_roster
        WHERE user_id IN (${ids.map(() => '?').join(',')}) AND roster_date BETWEEN ? AND ?
        FOR UPDATE`,
      [...ids, from, to]
    );
    const actionId = await insertAction(conn, {
      action: 'RESET', actorId, scope: rangeLabel(from, to),
      params: { userIds: ids, from, to }, users: ids.length, cells: rows.length,
    });
    if (!rows.length) return 0;
    await conn.query(
      `DELETE FROM tbl_employee_roster
        WHERE user_id IN (${ids.map(() => '?').join(',')}) AND roster_date BETWEEN ? AND ?`,
      [...ids, from, to]
    );
    const now = new Date();
    await insertChangeLogs(conn, rows.map((r) => [actionId, r.user_id, r.roster_date, 'day_type', r.day_type, null, actorId, now]));
    return rows.length;
  });
  logger.info('Roster reset to weekly · actor=' + actorId + ' · removed=' + removed);
  return { removed };
}

// ─── Notify ───────────────────────────────────────────────────────────
const DAY_ABBR = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayLabel(ymd) { return `${DAY_ABBR[weekdayIndex(ymd)]} ${ymd.slice(8)} ${MONTH_ABBR[Number(ymd.slice(5, 7)) - 1]}`; }
function shift12(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return `${String(h % 12 === 0 ? 12 : h % 12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/*
 * Notify: put each member's roster for [from, to] in their CRM inbox (the bell)
 * — one line per day, the same resolution the grid shows. Same scope as
 * editing (your reporting line, never yourself); range clipped to start today
 * (IST), at most MAX_RANGE_DAYS. In-app only: e-mail / SMS need registered
 * templates and are not wired.
 */
async function notifyMembers({ actorId, isAdmin, userIds, from, to }) {
  assertYmd(from, 'from'); assertYmd(to, 'to');
  const today = todayIst();
  const start = from > today ? from : today;
  if (start > to) throw mkErr(400, 'Nothing to notify — the range is in the past');
  const dates = listDates(start, to);
  if (dates.length > MAX_RANGE_DAYS) throw mkErr(400, `Range cannot exceed ${MAX_RANGE_DAYS} days`);
  const reach = await actorReach(actorId, isAdmin);
  const empCodes = await assertEditable(reach, userIds || []);
  const ids = [...empCodes.keys()];
  const { byUser } = await resolveDays(ids, start, to);
  const hol = new Map(holidays.getRange({ from: start, to }).map((h) => [h.date, h.name]));
  const inbox = require('./notification-inbox.service');

  const title = `Your Roster: ${dayLabel(start)} – ${dayLabel(to)}`;
  for (const uid of ids) {
    const days = byUser.get(uid);
    const lines = dates.map((d) => {
      const c = days[d];
      const what = c.type === 'WO' ? 'Week Off' : `Present · ${shift12(c.shift) || '—'}`;
      return `${dayLabel(d)} · ${what}${hol.has(d) ? ` (${hol.get(d)})` : ''}`;
    });
    await inbox.create({ userId: uid, title, desc: lines.join('\n') });
  }
  await insertAction(pool, {
    action: 'NOTIFY', actorId, scope: rangeLabel(start, to),
    params: { userIds: ids, from: start, to }, users: ids.length, cells: dates.length * ids.length,
  });
  logger.info('Roster notified · actor=' + actorId + ' · users=' + ids.length + ' · ' + start + '→' + to);
  return { notified: ids.length, from: start, to };
}

// ─── Logs ─────────────────────────────────────────────────────────────
function paging(page, limit) {
  const l = Math.max(1, Math.min(Number(limit) || 50, 200));
  const p = Math.max(1, Number(page) || 1);
  return { limit: l, offset: (p - 1) * l };
}

async function listUpdateLog({ actorId, isAdmin, page, limit, userId, from, to, actionId }) {
  const reach = await actorReach(actorId, isAdmin);
  const where = [];
  const params = [];
  if (!reach.isAdmin) {
    const ids = [...reach.descendants];
    if (!ids.length) return { items: [], total: 0 };
    where.push(`c.user_id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }
  if (userId) { where.push('c.user_id = ?'); params.push(Number(userId)); }
  if (actionId) { where.push('c.action_id = ?'); params.push(Number(actionId)); }
  if (from) { where.push('c.created_at >= ?'); params.push(assertYmd(from, 'from') + ' 00:00:00'); }
  if (to) { where.push('c.created_at < ?'); params.push(shiftYmd(assertYmd(to, 'to'), 1) + ' 00:00:00'); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const { limit: l, offset } = paging(page, limit);
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM tbl_employee_roster_change_log c ${clause}`, params);
  const [rows] = await pool.query(
    `SELECT c.id, DATE_FORMAT(c.created_at, '%Y-%m-%d %H:%i:%s') AS created_at, c.user_id, u.user_name, u.user_code,
            DATE_FORMAT(c.roster_date, '%Y-%m-%d') AS roster_date, c.field, c.old_value, c.new_value,
            c.changed_by, b.user_name AS changed_by_name, a.action
       FROM tbl_employee_roster_change_log c
       LEFT JOIN tbl_employee_roster_action_log a ON a.id = c.action_id
       LEFT JOIN tbl_user u ON u.user_id = c.user_id
       LEFT JOIN tbl_user b ON b.user_id = c.changed_by
       ${clause}
      ORDER BY c.id DESC
      LIMIT ?, ?`,
    [...params, offset, l]
  );
  return {
    total: Number(total),
    items: rows.map((r) => ({
      id: Number(r.id), createdAt: r.created_at, userId: Number(r.user_id), userName: r.user_name, empCode: r.user_code || null,
      rosterDate: r.roster_date || null, field: r.field, oldValue: r.old_value, newValue: r.new_value,
      changedBy: Number(r.changed_by), changedByName: r.changed_by_name || null,
      source: r.action ? (ACTION_SOURCE[r.action] || r.action) : 'EDIT_USER',
    })),
  };
}

async function listActionLog({ actorId, isAdmin, page, limit }) {
  const reach = await actorReach(actorId, isAdmin);
  const where = [];
  const params = [];
  if (!reach.isAdmin) {
    const ids = [reach.actorId, ...reach.descendants];
    where.push(`a.actor_user_id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const { limit: l, offset } = paging(page, limit);
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM tbl_employee_roster_action_log a ${clause}`, params);
  const [rows] = await pool.query(
    `SELECT a.id, DATE_FORMAT(a.created_at, '%Y-%m-%d %H:%i:%s') AS created_at, a.action, a.actor_user_id,
            u.user_name AS actor_name, a.scope_summary, a.affected_users, a.affected_cells, a.status_code
       FROM tbl_employee_roster_action_log a
       LEFT JOIN tbl_user u ON u.user_id = a.actor_user_id
       ${clause}
      ORDER BY a.id DESC
      LIMIT ?, ?`,
    [...params, offset, l]
  );
  return {
    total: Number(total),
    items: rows.map((r) => ({
      id: Number(r.id), createdAt: r.created_at, action: r.action, actorUserId: Number(r.actor_user_id),
      actorName: r.actor_name || null, summary: r.scope_summary || '', affectedUsers: Number(r.affected_users),
      statusCode: Number(r.status_code),
    })),
  };
}

module.exports = {
  DAY_TYPES,
  MAX_RANGE_DAYS,
  listDates,
  weekdayIndex,
  editWindow,
  resolveDays,
  weekOffSet,
  canEditUser,
  getGrid,
  getMine,
  saveCells,
  fillPattern,
  resetRange,
  notifyMembers,
  listUpdateLog,
  listActionLog,
  logFailedAction,
  insertAction,
  rangeLabel,
};
