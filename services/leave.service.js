const { pool } = require('../db');
const logger = require('../logger');
const roster = require('./roster.service');
const holidays = require('./holiday.service');
const inbox = require('./notification-inbox.service');
const emailService = require('./email.service');
const { crmSignInUrl } = require('./user-welcome-mail.service');
const { todayIst, shiftYmd, currentIstMonth, monthBounds } = require('../utils/ist-calendar');

/*
 * Employee Hub — leave requests (spec: docs/superpowers/specs/2026-09-30-employee-hub-leave-design.md).
 *
 * Every rule of §4 lives in ONE validator (checkRequest), shared by the dry run
 * and the create, so the live "N working days" in the dialog cannot disagree
 * with what gets saved. Working days are counted on the PLAN alone
 * (resolveDays { leaves: false }) — PR and not a holiday; a half day is 0.5.
 *
 * Approver = the requester's reporting_manager at request time (an ACTIVE
 * user, never themselves), snapshotted on the row. None → NULL: routed to the
 * Roster Admins (isRosterAdmin), who may act on any request anyway.
 *
 * The roster reads leave through roster.service resolveDays (approved full
 * day = LV / SL + locked; half day / pending = the planned day + `leave`).
 */

const KINDS = Object.freeze(['LV', 'SL']);
const DURATIONS = Object.freeze(['FULL', 'FIRST_HALF', 'SECOND_HALF']);
const STATUS = Object.freeze({ PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED', WITHDRAWN: 'WITHDRAWN', CANCELLED: 'CANCELLED' });
const LV_LEAD_DAYS = 2;
const MAX_SPAN_DAYS = roster.MAX_RANGE_DAYS;
const KIND_NAME = { LV: 'Leave', SL: 'Sick Leave' };
const DURATION_NAME = { FULL: 'Full Day', FIRST_HALF: 'First Half', SECOND_HALF: 'Second Half' };

function mkErr(status, message) { const e = new Error(message); e.status = status; return e; }
const YMD_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
function assertYmd(v, name) {
  if (!YMD_RE.test(String(v || ''))) throw mkErr(400, `${name} must be YYYY-MM-DD`);
  return String(v);
}

// ─── Rules ────────────────────────────────────────────────────────────
async function countWorkingDays(userId, from, to, duration) {
  const uid = Number(userId);
  const { byUser } = await roster.resolveDays([uid], from, to, { leaves: false });
  const hol = new Set(holidays.getRange({ from, to }).map((h) => h.date));
  const n = roster.listDates(from, to).filter((d) => byUser.get(uid)[d].type === 'PR' && !hol.has(d)).length;
  return duration === 'FULL' ? n : n * 0.5;
}

/*
 * PENDING / APPROVED requests of the user intersecting the range. Two half
 * days on one date are fine when they are different halves. `lock` = FOR
 * UPDATE inside the create transaction (next-key locks on idx_elr_user_dates
 * serialise two concurrent creates for the same user).
 */
async function assertNoOverlap(runner, { userId, fromDate, toDate, duration, lock = false }) {
  const [rows] = await runner.query(
    `SELECT id, kind, duration, status, DATE_FORMAT(from_date, '%Y-%m-%d') AS from_date, DATE_FORMAT(to_date, '%Y-%m-%d') AS to_date
       FROM tbl_employee_leave_request
      WHERE user_id = ? AND status IN ('PENDING', 'APPROVED') AND from_date <= ? AND to_date >= ?${lock ? ' FOR UPDATE' : ''}`,
    [Number(userId), toDate, fromDate]
  );
  const clash = rows.find((r) => !(r.duration !== 'FULL' && duration !== 'FULL' && r.duration !== duration));
  if (clash) {
    throw mkErr(409, `You already have a ${clash.status.toLowerCase()} ${KIND_NAME[clash.kind] || clash.kind} for ${roster.rangeLabel(clash.from_date, clash.to_date)}`
      + (clash.duration !== 'FULL' ? ` (${DURATION_NAME[clash.duration]})` : ''));
  }
}

/** Every §4 create rule. Returns the working days (0.5 steps). */
async function checkRequest({ userId, kind, fromDate, toDate, duration, runner = pool, lock = false, now = new Date() }) {
  if (!KINDS.includes(kind)) throw mkErr(400, 'kind must be LV or SL');
  if (!DURATIONS.includes(duration)) throw mkErr(400, 'duration must be FULL, FIRST_HALF or SECOND_HALF');
  assertYmd(fromDate, 'fromDate'); assertYmd(toDate, 'toDate');
  const today = todayIst(now);
  if (fromDate < today) throw mkErr(400, 'Leave cannot start in the past');
  if (toDate < fromDate) throw mkErr(400, 'The end date must be on or after the start date');
  if (kind === 'SL' && (fromDate !== today || toDate !== today)) {
    throw mkErr(400, 'Sick Leave is for today only — still unwell tomorrow? Raise a new one tomorrow');
  }
  const earliest = shiftYmd(today, LV_LEAD_DAYS);
  if (kind === 'LV' && fromDate < earliest) {
    throw mkErr(400, `Leave must be requested at least ${LV_LEAD_DAYS} days ahead — the earliest start is ${roster.rangeLabel(earliest, earliest)}`);
  }
  if (duration !== 'FULL' && fromDate !== toDate) throw mkErr(400, 'A half day must be a single date');
  if (roster.listDates(fromDate, toDate).length > MAX_SPAN_DAYS) throw mkErr(400, `A request can cover at most ${MAX_SPAN_DAYS} days`);
  const days = await countWorkingDays(userId, fromDate, toDate, duration);
  if (!days) throw mkErr(400, 'Those dates are week offs or holidays');
  await assertNoOverlap(runner, { userId, fromDate, toDate, duration, lock });
  return days;
}

// ─── Reads ────────────────────────────────────────────────────────────
const REQ_COLS = `r.id, r.user_id, r.kind, DATE_FORMAT(r.from_date, '%Y-%m-%d') AS from_date, DATE_FORMAT(r.to_date, '%Y-%m-%d') AS to_date,
       r.duration, r.days, r.reason, r.status, r.approver_user_id, r.decided_by,
       DATE_FORMAT(r.decided_at, '%Y-%m-%d %H:%i:%s') AS decided_at, r.decision_note,
       r.cancelled_by, DATE_FORMAT(r.cancelled_at, '%Y-%m-%d %H:%i:%s') AS cancelled_at, r.cancel_note,
       DATE_FORMAT(r.created_at, '%Y-%m-%d %H:%i:%s') AS created_at`;
const REQ_SELECT = `SELECT ${REQ_COLS}, u.user_name, u.user_code, ro.role_name, d.user_name AS decided_by_name
  FROM tbl_employee_leave_request r
  LEFT JOIN tbl_user u ON u.user_id = r.user_id
  LEFT JOIN tbl_role ro ON ro.role_id = u.user_role
  LEFT JOIN tbl_user d ON d.user_id = r.decided_by`;

async function lockRequest(conn, id) {
  const [[row]] = await conn.query(`SELECT ${REQ_COLS} FROM tbl_employee_leave_request r WHERE r.id = ? FOR UPDATE`, [Number(id)]);
  if (!row) throw mkErr(404, 'Leave request not found');
  return row;
}

async function loadRequest(id) {
  const [[row]] = await pool.query(`${REQ_SELECT} WHERE r.id = ?`, [Number(id)]);
  return row || null;
}

const EMPTY = new Set();
// Who may do what — the same predicates gate the writes and feed the can* flags.
//
// Approver scope (owner, 2026-10-01): requests from people in YOUR reporting
// hierarchy (any level below you — `team`, from findDescendantUserIds), never
// your own. A Roster Admin additionally covers requests with no Reporting Head
// (approver_user_id NULL), so those are never stranded. Roster Admin is NOT
// "see everything" any more.
const isRequester = (r, actorId) => Number(r.user_id) === Number(actorId);
const isApprover = (r, actorId, isAdmin, team = EMPTY) => !isRequester(r, actorId)
  && (team.has(Number(r.user_id)) || (Boolean(isAdmin) && r.approver_user_id == null));
async function teamOf(actorId) {
  const { findDescendantUserIds } = require('./user.service');
  const { descendants } = await findDescendantUserIds(actorId);
  return new Set(descendants.map(Number).filter((id) => id !== Number(actorId)));
}
function cancelVerdict(r, actorId, isAdmin, today, team = EMPTY) {
  if (r.status !== STATUS.APPROVED) return { ok: false, status: 409, message: 'Only an approved leave can be cancelled' };
  if (r.to_date < today) return { ok: false, status: 409, message: 'This leave is already over' };
  if (isRequester(r, actorId)) {
    return r.from_date > today ? { ok: true }
      : { ok: false, status: 403, message: 'Your leave has already started — ask your Reporting Head to end it early' };
  }
  return isApprover(r, actorId, isAdmin, team) ? { ok: true } : { ok: false, status: 403, message: 'Only the requester or a manager in their reporting line can cancel this leave' };
}

/** RequestRow (+ the ApprovalRow fields — a superset, so one shape serves every endpoint). */
function toRow(r, { actorId, isAdmin = false, today = todayIst(), team = EMPTY }) {
  return {
    id: Number(r.id), kind: r.kind, fromDate: r.from_date, toDate: r.to_date, duration: r.duration,
    days: Number(r.days), reason: r.reason || null, status: r.status, createdAt: r.created_at,
    decidedByName: r.decided_by_name || null, decidedAt: r.decided_at || null, decisionNote: r.decision_note || null,
    endedEarly: r.status === STATUS.APPROVED && Boolean(r.cancelled_at),
    canWithdraw: r.status === STATUS.PENDING && isRequester(r, actorId),
    canCancel: cancelVerdict(r, actorId, isAdmin, today, team).ok,
    userId: Number(r.user_id), userName: r.user_name || null, empCode: r.user_code || null, roleName: r.role_name || null,
    canDecide: r.status === STATUS.PENDING && isApprover(r, actorId, isAdmin, team),
  };
}

async function loadUsers(ids) {
  const uniq = [...new Set(ids.map(Number).filter(Boolean))];
  if (!uniq.length) return new Map();
  const [rows] = await pool.query(
    `SELECT user_id, user_name, official_email FROM tbl_user WHERE user_id IN (${uniq.map(() => '?').join(',')})`, uniq);
  return new Map(rows.map((u) => [Number(u.user_id), u]));
}

/** The active reporting manager, never the requester themselves; null = none. */
async function findApprover(userId) {
  const [[row]] = await pool.query(
    `SELECT m.user_id FROM tbl_user u JOIN tbl_user m ON m.user_id = u.reporting_manager AND m.user_status = 1
      WHERE u.user_id = ? LIMIT 1`,
    [Number(userId)]
  );
  return row && Number(row.user_id) !== Number(userId) ? Number(row.user_id) : null;
}

/** Active employees whose role holds isRosterAdmin — where an RH-less request is routed. */
async function rosterAdminIds() {
  const [rows] = await pool.query(
    `SELECT u.user_id FROM tbl_user u JOIN tbl_role r ON r.role_id = u.user_role AND r.role_status = 1
      WHERE u.user_status = 1 AND u.user_type_id = 5 AND u.user_role IN (
        SELECT rma.role_id FROM role_menu_action rma JOIN menu_action ma ON ma.id = rma.menu_action_id
         WHERE rma.isDeleted = 0 AND ma.action_name = 'isRosterAdmin')`
  );
  return rows.map((r) => Number(r.user_id));
}

// ─── Notifications (§7) — never fail the request ─────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function composeMail({ greeting, intro, r, note, link, button }) {
  const rows = [
    ['Kind', KIND_NAME[r.kind] || r.kind],
    ['Dates', roster.rangeLabel(r.from_date, r.to_date)],
    ['Duration', DURATION_NAME[r.duration] || r.duration],
    ['Working Days', String(Number(r.days))],
    ['Reason', r.reason || '—'],
    ...(note ? [['Note', note]] : []),
  ];
  const td = 'padding:8px 12px;border-bottom:1px solid #e5e7eb;';
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111827;line-height:1.5">
<p>${esc(greeting)}</p>
<p>${esc(intro)}</p>
<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #e5e7eb;min-width:360px">
${rows.map(([k, v]) => `<tr><td style="${td}color:#6b7280;width:130px">${esc(k)}</td><td style="${td}">${esc(v)}</td></tr>`).join('\n')}
</table>
${link ? `<p style="margin-top:20px"><a href="${esc(link)}" style="display:inline-block;background:#0f766e;color:#ffffff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold">${esc(button)}</a></p>` : ''}
<p style="color:#6b7280;font-size:12px">EasyFix CRM · Employee Hub</p>
</div>`;
  const text = [greeting, '', intro, '', ...rows.map(([k, v]) => `${k}: ${v}`), ...(link ? ['', `${button}: ${link}`] : [])].join('\n');
  return { html, text };
}

/*
 * event: REQUESTED | APPROVED | REJECTED | CANCELLED | ENDED_EARLY.
 *   REQUESTED / CANCELLED / ENDED_EARLY → to the RH (or the Roster Admins), cc the employee
 *   APPROVED / REJECTED                 → to the employee, cc the RH
 * Inbox item for every "to" recipient (+ the employee when someone else cut
 * their leave). Inbox first, then mail; each step fails soft.
 */
async function notify(event, r, { note } = {}) {
  try {
    const empId = Number(r.user_id);
    const rhIds = r.approver_user_id ? [Number(r.approver_user_id)] : await rosterAdminIds();
    const toEmployee = event === 'APPROVED' || event === 'REJECTED';
    const toIds = toEmployee ? [empId] : rhIds.filter((id) => id !== empId);
    const ccIds = toEmployee ? (r.approver_user_id ? [Number(r.approver_user_id)] : []) : [empId];
    const users = await loadUsers([...toIds, ...ccIds, empId]);
    const emp = users.get(empId) || { user_name: 'An employee' };
    const kind = KIND_NAME[r.kind] || r.kind;
    const dates = roster.rangeLabel(r.from_date, r.to_date);
    const base = crmSignInUrl();
    const link = base ? (toEmployee ? `${base}/employee-hub/attendance` : `${base}/employee-hub/approvals?request=${Number(r.id)}`) : null;

    const copy = {
      REQUESTED: { subject: `${kind} Request · ${emp.user_name} · ${dates}`, intro: `${emp.user_name} has requested ${kind.toLowerCase()} and needs your approval.`, title: `${kind} Request · ${emp.user_name}` },
      APPROVED: { subject: `Your ${kind} Is Approved · ${dates}`, intro: `Your ${kind.toLowerCase()} request has been approved.`, title: `${kind} Approved · ${dates}` },
      REJECTED: { subject: `Your ${kind} Is Rejected · ${dates}`, intro: `Your ${kind.toLowerCase()} request has been rejected.`, title: `${kind} Rejected · ${dates}` },
      CANCELLED: { subject: `${kind} Cancelled · ${emp.user_name} · ${dates}`, intro: `The approved ${kind.toLowerCase()} of ${emp.user_name} has been cancelled.`, title: `${kind} Cancelled · ${emp.user_name}` },
      ENDED_EARLY: { subject: `${kind} Ended Early · ${emp.user_name} · ${dates}`, intro: `The approved ${kind.toLowerCase()} of ${emp.user_name} has been ended early — it now runs ${dates}.`, title: `${kind} Ended Early · ${emp.user_name}` },
    }[event];

    const inboxIds = [...toIds];
    if ((event === 'CANCELLED' || event === 'ENDED_EARLY') && !inboxIds.includes(empId)) inboxIds.push(empId);
    const desc = `${kind} · ${dates} · ${DURATION_NAME[r.duration]} · ${Number(r.days)} Working Day${Number(r.days) === 1 ? '' : 's'}${note ? ` · Note: ${note}` : ''}`;
    for (const uid of inboxIds) {
      try { await inbox.create({ userId: uid, title: copy.title, desc }); } catch (e) { logger.warn('Leave inbox item failed · requestId=' + r.id + ' · userId=' + uid + ' · ' + e.message); }
    }

    const emails = (ids) => ids.map((id) => users.get(id)?.official_email).filter(Boolean);
    const to = emails(toIds);
    if (!to.length) { logger.warn('Leave mail skipped · no recipient address · requestId=' + r.id + ' · event=' + event); return; }
    const greetName = toIds.length === 1 ? users.get(toIds[0])?.user_name : null;
    const { html, text } = composeMail({
      greeting: greetName ? `Hi ${greetName},` : 'Hi,', intro: copy.intro, r, note, link,
      button: toEmployee ? 'Open In CRM' : 'Review In CRM',
    });
    const cc = emails(ccIds).filter((a) => !to.includes(a));
    const out = await emailService.send({ to, cc: cc.length ? cc : undefined, subject: copy.subject, html, text, category: 'employee-leave' });
    if (out && out.error) logger.warn('Leave mail not sent · requestId=' + r.id + ' · event=' + event + ' · ' + out.error);
  } catch (e) {
    logger.warn('Leave notification failed · requestId=' + r.id + ' · event=' + event + ' · ' + e.message);
  }
}

// ─── Writes ───────────────────────────────────────────────────────────
async function updateRequest(conn, id, fields) {
  const cols = Object.keys(fields);
  await conn.query(`UPDATE tbl_employee_leave_request SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => fields[c]), Number(id)]);
}

/** Create (dryRun → { days } after every rule). */
async function create({ userId, kind, fromDate, toDate, duration, reason, dryRun = false }) {
  // Reason is mandatory (owner, 2026-10-01) — but only on submit: the dialog's
  // live working-day count dry-runs before a reason has been typed.
  if (!dryRun && !String(reason || '').trim()) throw mkErr(400, 'Enter a reason for the leave');
  const uid = Number(userId);
  if (dryRun) return { days: await checkRequest({ userId: uid, kind, fromDate, toDate, duration }) };
  const approver = await findApprover(uid);
  const id = await roster.inTransaction(async (conn) => {
    const days = await checkRequest({ userId: uid, kind, fromDate, toDate, duration, runner: conn, lock: true });
    const now = new Date();
    const [res] = await conn.query(
      `INSERT INTO tbl_employee_leave_request (user_id, kind, from_date, to_date, duration, days, reason, status, approver_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uid, kind, fromDate, toDate, duration, days, reason ? String(reason).slice(0, 500) : null, STATUS.PENDING, approver, now, now]
    );
    return res.insertId;
  });
  const row = await loadRequest(id);
  logger.info('Leave requested · id=' + id + ' · userId=' + uid + ' · ' + kind + ' ' + fromDate + '→' + toDate + ' · ' + duration + ' · approver=' + (approver || 'roster admins'));
  await notify('REQUESTED', row);
  return { request: toRow(row, { actorId: uid }) };
}

async function withdraw({ actorId, id }) {
  await roster.inTransaction(async (conn) => {
    const r = await lockRequest(conn, id);
    if (!isRequester(r, actorId)) throw mkErr(403, 'Only the requester can withdraw a request');
    if (r.status !== STATUS.PENDING) throw mkErr(409, 'Only a pending request can be withdrawn');
    await updateRequest(conn, id, { status: STATUS.WITHDRAWN, updated_at: new Date() });
  });
  logger.info('Leave withdrawn · id=' + id + ' · actor=' + actorId);
  return { request: toRow(await loadRequest(id), { actorId }) };
}

/*
 * Cancel an APPROVED leave. Not started (from_date ≥ today) → CANCELLED.
 * Started → the past days stay leave: to_date trimmed to yesterday, days
 * re-counted, status stays APPROVED, cancelled_* say who ended it early.
 */
async function cancel({ actorId, isAdmin, id, note }) {
  const today = todayIst();
  const team = await teamOf(actorId);
  let event;
  await roster.inTransaction(async (conn) => {
    const r = await lockRequest(conn, id);
    const v = cancelVerdict(r, actorId, isAdmin, today, team);
    if (!v.ok) throw mkErr(v.status, v.message);
    const now = new Date();
    const who = { cancelled_by: Number(actorId), cancelled_at: now, cancel_note: note ? String(note).slice(0, 500) : null, updated_at: now };
    if (r.from_date >= today) {
      event = 'CANCELLED';
      await updateRequest(conn, id, { status: STATUS.CANCELLED, ...who });
    } else {
      event = 'ENDED_EARLY';
      const yesterday = shiftYmd(today, -1);
      await updateRequest(conn, id, { to_date: yesterday, days: await countWorkingDays(r.user_id, r.from_date, yesterday, r.duration), ...who });
    }
  });
  const row = await loadRequest(id);
  logger.info('Leave ' + (event === 'CANCELLED' ? 'cancelled' : 'ended early') + ' · id=' + id + ' · actor=' + actorId);
  await notify(event, row, { note });
  return { request: toRow(row, { actorId, isAdmin, today, team }) };
}

/** Approve / reject. Approve re-counts the working days on the current roster. */
async function decide({ actorId, isAdmin, id, decision, note }) {
  const approve = decision === 'APPROVE';
  if (!approve && decision !== 'REJECT') throw mkErr(400, 'decision must be APPROVE or REJECT');
  if (!approve && !String(note || '').trim()) throw mkErr(400, 'A note is required to reject');
  const team = await teamOf(actorId);
  await roster.inTransaction(async (conn) => {
    const r = await lockRequest(conn, id);
    if (isRequester(r, actorId)) throw mkErr(403, 'You cannot decide your own leave');
    if (!isApprover(r, actorId, isAdmin, team)) throw mkErr(403, 'This request is not from your team');
    if (r.status !== STATUS.PENDING) throw mkErr(409, `This request is already ${r.status.toLowerCase()}`);
    const now = new Date();
    const fields = { status: approve ? STATUS.APPROVED : STATUS.REJECTED, decided_by: Number(actorId), decided_at: now, decision_note: note ? String(note).slice(0, 500) : null, updated_at: now };
    if (approve) {
      fields.days = await countWorkingDays(r.user_id, r.from_date, r.to_date, r.duration);
      if (!fields.days) throw mkErr(409, 'Those dates are now week offs or holidays on the roster — reject the request instead');
    }
    await updateRequest(conn, id, fields);
  });
  const row = await loadRequest(id);
  logger.info('Leave ' + (approve ? 'approved' : 'rejected') + ' · id=' + id + ' · actor=' + actorId);
  await notify(approve ? 'APPROVED' : 'REJECTED', row, { note });
  return { request: toRow(row, { actorId, isAdmin, team }) };
}

// ─── Lists ────────────────────────────────────────────────────────────
async function approvals({ actorId, isAdmin, status = 'pending', page = 1, limit = 20 }) {
  const team = await teamOf(actorId);
  const ids = [...team];
  const scope = [];
  if (ids.length) scope.push(`r.user_id IN (${ids.map(() => '?').join(',')})`);
  if (isAdmin) scope.push('r.approver_user_id IS NULL');
  if (!scope.length) return { total: 0, items: [] };
  const where = [status === 'history' ? "r.status <> 'PENDING'" : "r.status = 'PENDING'", `(${scope.join(' OR ')})`, 'r.user_id <> ?'];
  const params = [...ids, Number(actorId)];
  const clause = 'WHERE ' + where.join(' AND ');
  const l = Math.max(1, Math.min(Number(limit) || 20, 100));
  const offset = (Math.max(1, Number(page) || 1) - 1) * l;
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM tbl_employee_leave_request r ${clause}`, params);
  const [rows] = await pool.query(
    `${REQ_SELECT} ${clause} ORDER BY ${status === 'history' ? 'r.id DESC' : 'r.from_date, r.id'} LIMIT ?, ?`,
    [...params, offset, l]
  );
  const today = todayIst();
  return { total: Number(total), items: rows.map((r) => toRow(r, { actorId, isAdmin, today, team })) };
}

/** The Attendance & Leaves page: one month of resolved days, its summary, my requests. */
async function me({ userId, month }) {
  const uid = Number(userId);
  const m = month || currentIstMonth();
  const { start, end } = monthBounds(m);
  const last = shiftYmd(end, -1);
  const today = todayIst();
  const { byUser } = await roster.resolveDays([uid], start, last);
  const hol = new Map();
  for (const h of holidays.getRange({ from: start, to: last })) if (!hol.has(h.date)) hol.set(h.date, h.name);

  const summary = { totalDays: 0, elapsed: 0, plannedPresent: 0, leaves: 0, weekOffsAndHolidays: 0 };
  const days = roster.listDates(start, last).map((d) => {
    const c = byUser.get(uid)[d];
    summary.totalDays++;
    if (d < today) summary.elapsed++;
    if (c.type === 'WO' || hol.has(d)) summary.weekOffsAndHolidays++;
    else if (c.source === 'LEAVE') summary.leaves++;
    else if (c.leave && c.leave.status === STATUS.APPROVED) { summary.plannedPresent += 0.5; summary.leaves += 0.5; }
    else summary.plannedPresent++;
    return { date: d, type: c.type, holiday: hol.get(d) || null, leave: c.leave || null };
  });

  // My Requests (owner, 2026-10-01): Pending + Approved requests that touch the
  // CURRENT month or later — independent of the month being viewed.
  const [rows] = await pool.query(
    `${REQ_SELECT} WHERE r.user_id = ? AND r.status IN ('PENDING', 'APPROVED') AND r.to_date >= ?
      ORDER BY r.from_date, r.id LIMIT 100`,
    [uid, monthBounds(currentIstMonth()).start]
  );
  return {
    month: m, today,
    rules: { lvEarliest: shiftYmd(today, LV_LEAD_DAYS), slDate: today },
    days, summary,
    requests: rows.map((r) => toRow(r, { actorId: uid, today })),
  };
}

// ─── SL popup ─────────────────────────────────────────────────────────
/*
 * Unacked PENDING sick leave I must decide: approver = me, or — for a Roster
 * Admin — no approver at all (the request was routed to the Roster Admins).
 */
async function alerts({ userId, isAdmin }) {
  const uid = Number(userId);
  const [rows] = await pool.query(
    `SELECT r.id, r.duration, r.reason, DATE_FORMAT(r.from_date, '%Y-%m-%d') AS from_date,
            DATE_FORMAT(r.created_at, '%Y-%m-%d %H:%i:%s') AS created_at, u.user_name
       FROM tbl_employee_leave_request r
       LEFT JOIN tbl_user u ON u.user_id = r.user_id
       LEFT JOIN tbl_user_alert_ack a ON a.user_id = ? AND a.alert_key = CONCAT('leave:', r.id)
      WHERE r.status = 'PENDING' AND r.kind = 'SL' AND r.user_id <> ?
        AND (r.approver_user_id = ?${isAdmin ? ' OR r.approver_user_id IS NULL' : ''})
        AND a.user_id IS NULL
      ORDER BY r.id`,
    [uid, uid, uid]
  );
  return {
    items: rows.map((r) => ({
      key: `leave:${Number(r.id)}`, requestId: Number(r.id), kind: 'SL', userName: r.user_name || null,
      date: r.from_date, duration: r.duration, reason: r.reason || null, createdAt: r.created_at,
    })),
  };
}

async function ackAlert({ userId, key }) {
  await pool.query(
    'INSERT INTO tbl_user_alert_ack (user_id, alert_key, acked_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE acked_at = VALUES(acked_at)',
    [Number(userId), String(key).slice(0, 64), new Date()]
  );
  return { ok: true };
}

module.exports = {
  KINDS, DURATIONS, STATUS,
  checkRequest, countWorkingDays, composeMail,
  create, withdraw, cancel, decide, approvals, me, alerts, ackAlert,
};
