const router = require('express').Router();
const Joi = require('joi');
const ExcelJS = require('exceljs');

const validate = require('../../middleware/validate');
const requireAction = require('../../middleware/require-action');
const { getEffectivePermissions } = require('../../services/role.service');
const roster = require('../../services/roster.service');
const { monthBounds, shiftYmd } = require('../../utils/ist-calendar');
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');

/*
 * Team Roster — /api/admin/roster. Mount inherits requireAuth + role(['admin']).
 *
 *   GET /me              every CRM user — their own days (dashboard widget)
 *   everything else      the RBAC action key isRosterManage — ROLE-based only.
 *                        Owner decision 2026-09-29: whoever can see the Team
 *                        Roster menu can use it, so there is deliberately NO
 *                        per-email allowlist on top (grant via Manage Roles).
 *
 * Which members a caller may edit is decided in services/roster.service.js
 * (their reporting-line descendants, never themselves; isRosterAdmin = anyone
 * but themselves, and may also edit today).
 */

const ymd = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);
const month = Joi.string().pattern(/^\d{4}-(0[1-9]|1[0-2])$/);
const hhmm = Joi.string().pattern(/^([01]\d|2[0-3]):(00|30)$/).allow(null, ''); // 30-minute slots only
const ids = Joi.array().items(Joi.number().integer().positive()).min(1).max(1000).required();

async function isRosterAdmin(req) {
  if (!req.user.permissions) req.user.permissions = await getEffectivePermissions(req.user.user_id);
  return (req.user.permissions.actionPermissions || []).includes('isRosterAdmin');
}

function sendError(res, next, e) {
  if (e.status) return modernError(res, e.status, e.message);
  return next(e);
}

// ── Own roster (no gate beyond being a CRM user) ────────────────────────
router.get('/me', validate(Joi.object({ days: Joi.number().integer().min(1).max(31).default(14) }), 'query'),
  async (req, res, next) => {
    try {
      logger.info('My roster · userId=' + req.user.user_id + ' · days=' + req.query.days);
      modernOk(res, await roster.getMine(req.user.user_id, { days: req.query.days }));
    } catch (e) { sendError(res, next, e); }
  });

// ── Management — isRosterManage from here on ────────────────────────────
const manage = require('express').Router();
manage.use(requireAction('isRosterManage'));

/*
 * Mutations: a denied or failed attempt (any 4xx/5xx) still leaves an Action
 * Log row — "who tried to change a team that isn't theirs" is exactly what the
 * log is for. Success rows are written inside the service transaction.
 */
function mutation(action, handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, await isRosterAdmin(req));
    } catch (e) {
      const status = e.status || 500;
      await roster.logFailedAction({
        action, actorId: req.user.user_id, status,
        scope: String(e.message || 'failed').slice(0, 200),
      });
      logger.warn('Roster ' + action + ' rejected · actor=' + req.user.user_id + ' · ' + status + ' · ' + e.message);
      sendError(res, next, e);
    }
  };
}

manage.get('/', validate(Joi.object({ from: ymd.required(), to: ymd.required(), teamOf: Joi.number().integer().positive() }), 'query'),
  async (req, res, next) => {
    try {
      logger.info('Roster grid · actor=' + req.user.user_id + ' · ' + req.query.from + '→' + req.query.to + ' · teamOf=' + (req.query.teamOf || 'self'));
      modernOk(res, await roster.getGrid({ actorId: req.user.user_id, isAdmin: await isRosterAdmin(req), ...req.query }));
    } catch (e) { sendError(res, next, e); }
  });

manage.put('/cells',
  validate(Joi.object({
    cells: Joi.array().items(Joi.object({
      userId: Joi.number().integer().positive().required(),
      date: ymd.required(),
      dayType: Joi.string().valid('PR', 'WO').required(),
      shiftStart: hhmm.optional(),
    })).min(1).max(5000).required(),
  })),
  mutation('SAVE_GRID', async (req, res, isAdmin) => {
    modernOk(res, await roster.saveCells({ actorId: req.user.user_id, isAdmin, cells: req.body.cells }), 'Roster saved');
  }));

manage.post('/fill-pattern',
  validate(Joi.object({ dryRun: Joi.boolean().truthy('1').falsy('0').default(false) }), 'query'),
  validate(Joi.object({
    userIds: ids, from: ymd.required(), to: ymd.required(),
    weekOffDays: Joi.array().items(Joi.number().integer().min(0).max(6)).max(6).required(),
    shiftStart: hhmm.optional(), keepManual: Joi.boolean().default(true),
  })),
  async (req, res, next) => {
    // A dry run is a read — it neither needs nor deserves an Action Log row.
    if (req.query.dryRun) {
      try {
        return modernOk(res, await roster.fillPattern({ actorId: req.user.user_id, isAdmin: await isRosterAdmin(req), ...req.body, dryRun: true }));
      } catch (e) { return sendError(res, next, e); }
    }
    return mutation('FILL_PATTERN', async (rq, rs, isAdmin) => {
      modernOk(rs, await roster.fillPattern({ actorId: rq.user.user_id, isAdmin, ...rq.body }), 'Pattern applied');
    })(req, res, next);
  });

manage.post('/copy-month',
  validate(Joi.object({ userIds: ids, fromMonth: month.required(), toMonth: month.required() })),
  mutation('COPY_MONTH', async (req, res, isAdmin) => {
    modernOk(res, await roster.copyMonth({ actorId: req.user.user_id, isAdmin, ...req.body }), 'Month copied');
  }));

manage.post('/reset',
  validate(Joi.object({ userIds: ids, from: ymd.required(), to: ymd.required() })),
  mutation('RESET', async (req, res, isAdmin) => {
    modernOk(res, await roster.resetRange({ actorId: req.user.user_id, isAdmin, ...req.body }), 'Reset to weekly days');
  }));

const pageQuery = { page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(200).default(50) };

manage.get('/logs/updates',
  validate(Joi.object({ ...pageQuery, userId: Joi.number().integer().positive(), from: ymd, to: ymd }), 'query'),
  async (req, res, next) => {
    try {
      modernOk(res, await roster.listUpdateLog({ actorId: req.user.user_id, isAdmin: await isRosterAdmin(req), ...req.query }));
    } catch (e) { sendError(res, next, e); }
  });

manage.get('/logs/actions', validate(Joi.object(pageQuery), 'query'), async (req, res, next) => {
  try {
    modernOk(res, await roster.listActionLog({ actorId: req.user.user_id, isAdmin: await isRosterAdmin(req), ...req.query }));
  } catch (e) { sendError(res, next, e); }
});

/*
 * Export one month of a team as .xlsx — one row per member, one column per date
 * (PR / WO), the layout of the monthly roster e-mail this replaces.
 */
manage.get('/export', validate(Joi.object({ month: month.required(), teamOf: Joi.number().integer().positive() }), 'query'),
  async (req, res, next) => {
    try {
      const { start, end } = monthBounds(req.query.month);
      const grid = await roster.getGrid({
        actorId: req.user.user_id, isAdmin: await isRosterAdmin(req), from: start, to: shiftYmd(end, -1), teamOf: req.query.teamOf,
      });
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet(`Roster ${req.query.month}`);
      const dayLabel = (d) => `${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][roster.weekdayIndex(d)]} ${d.slice(8)}`;
      ws.addRow(['Team Member', 'Emp Code', 'Role', 'Shift', ...grid.dates.map(dayLabel)]).font = { bold: true };
      const hol = new Set(grid.holidays.map((h) => h.date));
      for (const m of grid.members) {
        ws.addRow([m.name, m.empCode || '', m.roleName || '', m.defaultShift || '',
          ...grid.dates.map((d) => m.days[d].type)]);
      }
      ws.addRow(['On Duty', '', '', '', ...grid.dates.map((d) => `${grid.headcount[d].onDuty}/${grid.headcount[d].total}`)]).font = { bold: true };
      grid.dates.forEach((d, i) => { if (hol.has(d)) ws.getColumn(5 + i).eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDECEA' } }; }); });
      ws.getColumn(1).width = 26;
      await roster.insertAction(pool, {
        action: 'EXPORT', actorId: req.user.user_id, scope: `${grid.members.length} members · ${req.query.month}`,
        users: grid.members.length, cells: 0,
      });
      const buf = await wb.xlsx.writeBuffer();
      logger.info('Roster exported · actor=' + req.user.user_id + ' · month=' + req.query.month + ' · members=' + grid.members.length);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="team-roster-${req.query.month}.xlsx"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(Buffer.from(buf));
    } catch (e) { sendError(res, next, e); }
  });

router.use('/', manage);

module.exports = router;
