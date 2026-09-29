const { pool } = require('../db');
const logger = require('../logger');

/*
 * Weekly working days for CRM users — tbl_employee_attendance_preference.
 *
 * One row per user: seven day columns holding 'PR' (Present) or 'WO' (Week Off),
 * an optional default shift start, and working_days. The Add/Edit User form shows
 * the seven days as toggle cards, all selected (7 working days) by default.
 *
 * working_days is DERIVED here from the seven columns and never taken from the
 * request — a stored count that disagrees with the days is a lie the roster,
 * the dashboard and job routing would all repeat.
 *
 * Team Roster rows (tbl_employee_roster) override single dates on top of this;
 * see services/roster.service.js resolveDays(). Employees on a roster are meant
 * to keep all 7 days here and have their week offs planned on the roster.
 */

const DAY_TYPES = Object.freeze(['PR', 'WO']);
// Index 0 = Monday. JS Date#getDay() is 0 = Sunday — convert with dayKeyOfDate().
const DAY_KEYS = Object.freeze(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
const DEFAULT_DAYS = Object.freeze(Object.fromEntries(DAY_KEYS.map((d) => [d, 'PR'])));
/*
 * Everyone's shift unless set otherwise (owner, 2026-09-29). Applied on READ to
 * rows whose column is NULL too, so no backfill is needed. Shifts are 30-minute
 * slots only (:00 / :30) — the CRM picker offers nothing else.
 */
const DEFAULT_SHIFT = '10:00';

const MIGRATION_HINT = 'apply migrations/2026-09-29-employee-roster-01-tables.sql';

function mkErr(status, message) { const e = new Error(message); e.status = status; return e; }

function isMissingTable(err) {
  return Boolean(err) && (err.code === 'ER_NO_SUCH_TABLE' || err.errno === 1146);
}

/** 'YYYY-MM-DD' (a calendar date, no timezone) → 'monday' … 'sunday'. */
function dayKeyOfDate(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const jsDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return DAY_KEYS[(jsDay + 6) % 7];
}

/** MySQL TIME ('10:00:00') or form input ('10:00') → 'HH:MM', else null. */
function toHhMm(v) {
  if (v === null || v === undefined || v === '') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(String(v).trim());
  return m ? `${m[1]}:${m[2]}` : undefined;
}

/** Like toHhMm, but only the 30-minute slots a shift may start on ('undefined' = invalid). */
function toShift(v) {
  const s = toHhMm(v);
  if (s === undefined || s === null) return s;
  return s.endsWith(':00') || s.endsWith(':30') ? s : undefined;
}

function workingDays(days) {
  return DAY_KEYS.filter((k) => days[k] !== 'WO').length;
}

/*
 * Validate an `attendance_preference` payload. All seven days are REQUIRED when
 * the object is sent at all — a partial object would leave "which days did the
 * operator mean?" to a merge rule, and the form always sends all seven.
 *
 * Returns { values } or throws 400.
 */
function normalisePreference(raw) {
  if (!raw || typeof raw !== 'object') throw mkErr(400, 'attendance_preference must be an object');
  const values = {};
  for (const k of DAY_KEYS) {
    const v = String(raw[k] ?? '').trim().toUpperCase();
    if (!DAY_TYPES.includes(v)) throw mkErr(400, `attendance_preference.${k} must be PR or WO`);
    values[k] = v;
  }
  if (workingDays(values) === 0) throw mkErr(400, 'Select at least one working day');
  const shift = toShift(raw.default_shift_start);
  if (shift === undefined) throw mkErr(400, 'attendance_preference.default_shift_start must be a :00 or :30 time (HH:MM)');
  values.default_shift_start = shift || DEFAULT_SHIFT;
  return { values };
}

function rowToPreference(r) {
  const days = Object.fromEntries(DAY_KEYS.map((k) => [k, r[k] === 'WO' ? 'WO' : 'PR']));
  return { ...days, default_shift_start: toHhMm(r.default_shift_start) || DEFAULT_SHIFT, working_days: workingDays(days) };
}

/*
 * READ — fail-soft. A host without the migration loses this one field, not the
 * whole Manage Users surface (getUserById feeds every PATCH and both bulk paths).
 * Returns Map<user_id, preference>; users without a row are simply absent.
 */
async function loadPreferences(userIds, runner = pool) {
  const ids = [...new Set((userIds || []).map(Number).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  try {
    const [rows] = await runner.query(
      `SELECT user_id, emp_code, default_shift_start, ${DAY_KEYS.join(', ')}
         FROM tbl_employee_attendance_preference
        WHERE user_id IN (${ids.map(() => '?').join(',')})`,
      ids
    );
    for (const r of rows) out.set(Number(r.user_id), { ...rowToPreference(r), emp_code: r.emp_code ?? null });
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    logger.warn('Attendance preference read skipped · table missing — ' + MIGRATION_HINT);
  }
  return out;
}

async function loadPreference(userId, runner = pool) {
  return (await loadPreferences([userId], runner)).get(Number(userId)) || null;
}

/** The preference a user without a row is treated as having. */
function defaultPreference() {
  return { ...DEFAULT_DAYS, default_shift_start: DEFAULT_SHIFT, working_days: DAY_KEYS.length };
}

/*
 * [field, old, new] for every value that differs between the stored preference
 * (or the 7-day default when there is no row) and normalised `values`.
 * working_days is compared on its DERIVED value — never on anything sent.
 */
function diffPreference(stored, values) {
  const before = stored || defaultPreference();
  const after = { ...values, working_days: workingDays(values) };
  const changes = [];
  for (const k of DAY_KEYS) if (before[k] !== after[k]) changes.push([`pref.${k}`, before[k], after[k]]);
  if (before.working_days !== after.working_days) {
    changes.push(['pref.working_days', String(before.working_days), String(after.working_days)]);
  }
  if ((before.default_shift_start ?? null) !== (after.default_shift_start ?? null)) {
    changes.push(['pref.shift', before.default_shift_start ?? null, after.default_shift_start ?? null]);
  }
  return changes;
}

/*
 * WRITE — upsert the full preference and log every changed value to
 * tbl_employee_roster_change_log (field 'pref.<day>' / 'pref.working_days' /
 * 'pref.shift', roster_date NULL). The diff is against the stored row, or
 * against the 7-day default when there is none — so a first save that unselects
 * Sunday logs "pref.sunday PR → WO", which is what actually changed for routing.
 *
 * NOT fail-soft: the operator just chose these days, and swallowing the write
 * would report success and discard them. A missing table is a 503 naming the
 * migration. Takes a `runner` so createUser can write inside its transaction.
 */
async function upsertPreference(userId, empCode, values, actorId, runner = pool) {
  const uid = Number(userId);
  let stored;
  try {
    stored = await loadPreferenceStrict(uid, runner);
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    throw mkErr(503, 'Working days storage is unavailable on this host — ' + MIGRATION_HINT + ', then retry');
  }
  const after = { ...values, working_days: workingDays(values) };
  const changes = diffPreference(stored, values);

  const code = empCode ? String(empCode) : null;
  if (stored && !changes.length && (stored.emp_code ?? null) === code) return { changed: [] };

  const now = new Date();
  await runner.query(
    `INSERT INTO tbl_employee_attendance_preference
       (user_id, emp_code, working_days, default_shift_start, ${DAY_KEYS.join(', ')}, updated_by, updated_on, created_on)
     VALUES (?, ?, ?, ?, ${DAY_KEYS.map(() => '?').join(', ')}, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       emp_code = VALUES(emp_code), working_days = VALUES(working_days),
       default_shift_start = VALUES(default_shift_start),
       ${DAY_KEYS.map((k) => `${k} = VALUES(${k})`).join(', ')},
       updated_by = VALUES(updated_by), updated_on = VALUES(updated_on)`,
    [uid, code, after.working_days, after.default_shift_start, ...DAY_KEYS.map((k) => after[k]),
      actorId || null, now, now]
  );
  if (changes.length) {
    /*
     * One Action Log row per Working Days save ('WORKING_DAYS'), and the value
     * changes hang off it — so an Edit User change shows up in Team Roster →
     * Logs like any roster action and expands to its details. Written inline
     * (not via roster.service) because roster.service requires this module.
     */
    const off = DAY_KEYS.filter((k) => after[k] === 'WO').map((k) => k[0].toUpperCase() + k.slice(1, 3));
    const [h, m] = (after.default_shift_start || DEFAULT_SHIFT).split(':').map(Number);
    const shift = `${String(h % 12 === 0 ? 12 : h % 12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
    const [act] = await runner.query(
      `INSERT INTO tbl_employee_roster_action_log
         (action, actor_user_id, scope_summary, params, affected_users, affected_cells, status_code, created_at)
       VALUES ('WORKING_DAYS', ?, ?, NULL, 1, 0, 200, ?)`,
      [actorId || 0, `Week Off: ${off.join(', ') || 'None'} · Shift ${shift}`, now]
    );
    await runner.query(
      `INSERT INTO tbl_employee_roster_change_log
         (action_id, user_id, roster_date, field, old_value, new_value, changed_by, created_at)
       VALUES ${changes.map(() => '(?, ?, NULL, ?, ?, ?, ?, ?)').join(', ')}`,
      changes.flatMap(([field, o, n]) => [act.insertId, uid, field, o, n, actorId || 0, now])
    );
  }
  logger.info('Working days saved · userId=' + uid + ' · workingDays=' + after.working_days
    + ' · changes=' + (changes.map((c) => c[0]).join(',') || '-'));
  return { changed: changes.map((c) => c[0]) };
}

// Same query as loadPreferences but lets ER_NO_SUCH_TABLE escape (write path).
async function loadPreferenceStrict(userId, runner) {
  const [rows] = await runner.query(
    `SELECT user_id, emp_code, default_shift_start, ${DAY_KEYS.join(', ')}
       FROM tbl_employee_attendance_preference WHERE user_id = ? LIMIT 1`,
    [userId]
  );
  return rows[0] ? { ...rowToPreference(rows[0]), emp_code: rows[0].emp_code ?? null } : null;
}

/*
 * AUTO-BACKFILL for existing users: called after any real Edit User write that
 * did not carry a preference (bulk edits, older clients). Inserts the 7-day
 * default when no row exists; on an existing row it ONLY re-syncs emp_code
 * (an edited Employee Code) and never touches the days — a choice is never
 * overwritten by a default.
 * Fail-SOFT: a host without the migration must not break user editing.
 */
async function ensurePreferenceRow(userId, empCode, runner = pool) {
  const now = new Date();
  try {
    await runner.query(
      `INSERT INTO tbl_employee_attendance_preference
         (user_id, emp_code, working_days, created_on, updated_on)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE emp_code = VALUES(emp_code)`,
      [Number(userId), empCode ? String(empCode) : null, DAY_KEYS.length, now, now]
    );
  } catch (e) {
    if (!isMissingTable(e)) throw e;
    logger.warn('Working days backfill skipped · userId=' + userId + ' · table missing — ' + MIGRATION_HINT);
  }
}

module.exports = {
  DAY_TYPES,
  DAY_KEYS,
  DEFAULT_SHIFT,
  toShift,
  dayKeyOfDate,
  toHhMm,
  workingDays,
  normalisePreference,
  defaultPreference,
  diffPreference,
  loadPreferences,
  loadPreference,
  upsertPreference,
  ensurePreferenceRow,
  isMissingTable,
};
