/*
 * QuickSight — Employee Performance: the LIVE dashboard object.
 *
 *   buildLiveD({ from, to, now, db }) → { D, meta }
 *
 * D is the object build_data.py used to write as `const D=` — the one
 * aggregate.js reads — composed from:
 *
 *   sources.service.js   open jobs (every open job, no date filter), closed jobs
 *                        (checked out in the window), CRM counts per user per
 *                        IST day, all LIVE from easyfix_core; resolvePeople()
 *                        maps the users on them to employee keys
 *   uploads.service.js   the stored uploads for the window: emp detail, targets,
 *                        TimeChamp, IVR (loadUploads)
 *   compose.js           compose(inputs, { teamMode: 'perMonth' }) — each day
 *                        uses THAT month's emp detail team (owner decision 4)
 *
 * Nothing here re-derives a number: this file only fetches, wires and caches.
 * GET PATHS NEVER WRITE — every statement below is a SELECT.
 *
 * ─── THE WINDOW ─────────────────────────────────────────────────────────────
 *
 * resolveLiveWindow(): the tab's Month / From-To (owner decision 2).
 *   - nothing given              the current IST month, 1st .. today
 *   - month only (YYYY-MM)       that month, 1st .. last day
 *   - to only                    the 1st of to's month .. to
 *   - from only                  from .. today
 *   - from must not be after today (IST) and must be on or before to
 *   - at most MAX_RANGE_MONTHS CALENDAR months: `to` may not go past the end of
 *     the 3rd month, counting from's own month as the first (see lastAllowedTo)
 *   - a to after today is clamped to today (there is nothing to read there, and
 *     future days would count as "below target" days)
 *   - a month given together with from/to must fall inside them
 * The EFFECTIVE window is what is cached, composed and returned in meta.
 *
 * ─── EMPLOYEES ──────────────────────────────────────────────────────────────
 *
 * The uploaded emp detail is the only source of who exists (owner decisions 6
 * and 7, implemented in resolvePeople): a name shows for a month only if that
 * month's emp detail lists it, a window of several months shows only the people
 * on EVERY one of them, and a month with no emp detail shows nobody. Nobody is
 * ever invented from a job SPOC or a CRM user, and no month inherits another's
 * roster. The employees passed to compose() are therefore the uploaded entries
 * (compose-exact, proven against the MIS workbook) narrowed to that visible set.
 *
 * Every row a visible employee does not own — an unrostered month's jobs, a
 * hidden person's jobs, a user nobody's emp detail names — lands on an
 * Unattributed BUCKET instead of being dropped. A bucket is an ordinary
 * D.employees entry (compose.js builds one per job vertical), so hiding a
 * person moves their work sideways instead of deleting it: every KPI tile,
 * every table and the zonal breakdown still count it, and with no filter on,
 * the tiles equal meta.totals exactly. meta.attributed is what the named people
 * carry, meta.bucketed what the buckets do, and meta.reconciled says both add
 * up to meta.totals AND that the buckets hold precisely what resolvePeople
 * could not place (meta.unattributed). meta.visibility says how many people the
 * window hid and which of its months have no emp detail uploaded, which is what
 * the tab tells the user to fix.
 *
 * ─── THE CACHE ──────────────────────────────────────────────────────────────
 *
 * One composed { D, meta } per (from, to, latest upload batch id), kept
 * CACHE_TTL_MS after it is built, at most CACHE_MAX_ENTRIES (least recently
 * used evicted). Concurrent requests for the same key share one build. The
 * batch id is read on EVERY call (one indexed SELECT), so an upload saved on
 * any replica replaces the entry on the next read; a commit on this replica
 * also calls invalidateLiveCache(). Failed builds are never cached.
 *
 * Every viewer holding the view key sees the same global report (the loaders
 * take no req.scope), so a cache keyed on the window alone cannot leak one
 * user's data to another. The cached object is SHARED: callers must treat D
 * and meta as read-only (aggregate.js never mutates D).
 *
 * POOL BUDGET. A build reads in two lanes — closed jobs | open jobs → CRM →
 * uploads → coverage — so it holds at most ~2 connections plus the SPOC
 * resolver's 8-at-a-time burst per lane. At most MAX_CONCURRENT_BUILDS builds
 * run at once (different windows); further ones queue.
 */

'use strict';

const { pool } = require('../../../db');
const logger = require('../../../logger');
const sources = require('./sources.service');
const uploads = require('./uploads.service');
const { compose, isUnattributedKey } = require('./compose');
const { shiftMonth, shiftYmd, todayIst, istStringToDate } = require('../../../utils/ist-calendar');
const { isAbsentAnswer } = require('../../../utils/schema-absent-error');

const MAX_RANGE_MONTHS = 3;
/*
 * Reconciliation compares money, and the two sides are the same rupees added
 * in different orders: compose() sums a block with numpy's pairwise summation,
 * the raw total is a left-to-right reduce. Those agree to the last few bits,
 * not to the bit, so `===` reported a mismatch on perfectly healthy builds and
 * the one alarm that matters became noise. Half a paisa is far above the drift
 * a double accumulates over a month of charges (~1e-8 on a crore) and far below
 * any real mis-attribution, which is a whole job's charge. COUNTS stay exact:
 * they are integers, and an off-by-one there is a lost job.
 */
const REVENUE_EPSILON = 0.005;
const sameMoney = (a, b) => Math.abs(a - b) < REVENUE_EPSILON;
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = 3;
const MAX_CONCURRENT_BUILDS = 2;

const TABLES = uploads._internals.TABLES;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/* ═══ 1. The window ═════════════════════════════════════════════════════════ */

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

const blank = (v) => v === undefined || v === null || v === '';

/** A real calendar 'YYYY-MM-DD' (2026-02-30 is not). */
function isYmd(s) {
  if (typeof s !== 'string' || !YMD_RE.test(s)) return false;
  try {
    return shiftYmd(s, 0) === s;
  } catch {
    return false;
  }
}

const monthEnd = (ym) => shiftYmd(`${shiftMonth(ym, 1)}-01`, -1);

/**
 * The last allowed `to` for a window starting at `from`: the end of the
 * MAX_RANGE_MONTHS-th CALENDAR month counting from's own as the first.
 *
 * Counting calendar months is the whole point. A duration cap (from + 3 months
 * − 1 day) let 2026-06-15 .. 2026-09-14 through: 92 days, but FOUR months of
 * emp detail, four months of roster intersection and four month columns — while
 * the refusal message and the tab's own hint both promise three. The rule the
 * user is told is now the rule enforced, and since this limit is never later
 * than the old one, no window that used to be accepted for the right reason is
 * refused now.
 */
function lastAllowedTo(from) {
  return monthEnd(shiftMonth(from.slice(0, 7), MAX_RANGE_MONTHS - 1));
}

/**
 * The tab's Month / From-To → the effective IST window { from, to } (see the
 * header). Throws status 400 with an operator-readable message.
 */
function resolveLiveWindow({ from, to, month } = {}, now = new Date()) {
  const today = todayIst(now);
  const m = blank(month) || month === 'ALL' ? null : month;
  if (m !== null && (typeof m !== 'string' || !MONTH_RE.test(m))) throw badRequest('"month" must be ALL or a month (YYYY-MM)');
  if (!blank(from) && !isYmd(from)) throw badRequest('"from" must be a real date (YYYY-MM-DD)');
  if (!blank(to) && !isYmd(to)) throw badRequest('"to" must be a real date (YYYY-MM-DD)');

  let f;
  let t;
  if (blank(from) && blank(to)) {
    if (m !== null) {
      f = `${m}-01`;
      t = monthEnd(m);
    } else {
      ({ from: f, to: t } = sources.defaultWindow(now));
    }
  } else {
    t = blank(to) ? today : to;
    f = blank(from) ? `${t.slice(0, 7)}-01` : from;
  }
  if (f > today) throw badRequest(`"from" (${f}) is after today (${today}, IST)`);
  if (f > t) throw badRequest('"from" must be on or before "to"');
  const limit = lastAllowedTo(f);
  if (t > limit) {
    throw badRequest(`The date range may span at most ${MAX_RANGE_MONTHS} calendar months`
      + ` — from ${f}, "to" can be at most ${limit}`);
  }
  if (m !== null && (m < f.slice(0, 7) || m > t.slice(0, 7))) {
    throw badRequest(`"month" ${m} is outside ${f} .. ${t}`);
  }
  return { from: f, to: t > today ? today : t };
}

/* ═══ 2. Upload bookkeeping (read-only) ═════════════════════════════════════ */

const isoOf = (v) => {
  const d = istStringToDate(v);
  return d ? d.toISOString() : null;
};

/** The latest committed upload batch, or storage 'missing' before the migration. One indexed row. */
async function readLatestBatch(db) {
  let rows;
  try {
    [rows] = await db.query(
      `SELECT b.batch_id, b.file_name, b.sheets, b.date_from, b.date_to, b.month_from, b.month_to,
              b.uploaded_by, b.uploaded_on, u.user_name AS uploaded_by_name
         FROM ${TABLES.batch} b
         LEFT JOIN tbl_user u ON u.user_id = b.uploaded_by
        ORDER BY b.batch_id DESC
        LIMIT 1`,
    );
  } catch (err) {
    if (!isAbsentAnswer(err)) throw err;
    return { storage: 'missing', batchId: null, batch: null };
  }
  const r = rows[0];
  if (!r) return { storage: 'ready', batchId: null, batch: null };
  return {
    storage: 'ready',
    batchId: Number(r.batch_id),
    batch: {
      batchId: Number(r.batch_id),
      fileName: r.file_name,
      sheets: String(r.sheets || '').split(',').filter(Boolean),
      dateFrom: r.date_from || null,
      dateTo: r.date_to || null,
      monthFrom: r.month_from || null,
      monthTo: r.month_to || null,
      uploadedAt: isoOf(r.uploaded_on),
      uploadedBy: { userId: r.uploaded_by === null ? null : Number(r.uploaded_by), name: r.uploaded_by_name || null },
    },
  };
}

/**
 * What is stored, per source, across ALL uploads (not just the window):
 * daily sources as { from, to, days, rows }, monthly ones as { months, rows }.
 * null when the tables are not there.
 */
async function readCoverage(db) {
  try {
    const [[daily], [monthly]] = await Promise.all([
      db.query(
        `SELECT 'timechamp' AS source, MIN(work_date) AS date_from, MAX(work_date) AS date_to,
                COUNT(DISTINCT work_date) AS days, COUNT(*) AS row_count
           FROM ${TABLES.timechamp}
         UNION ALL
         SELECT 'ivr', MIN(call_date), MAX(call_date), COUNT(DISTINCT call_date), COUNT(*)
           FROM ${TABLES.ivr}`,
      ),
      db.query(
        `SELECT 'empDetail' AS source, month, COUNT(*) AS row_count FROM ${TABLES.roster} GROUP BY month
         UNION ALL
         SELECT 'primaryTargets', month, COUNT(*) FROM ${TABLES.primary} GROUP BY month
         UNION ALL
         SELECT 'secondaryTargets', month, COUNT(*) FROM ${TABLES.secondary} GROUP BY month`,
      ),
    ]);
    const out = {};
    for (const source of ['timechamp', 'ivr']) {
      const r = daily.find((x) => x.source === source) || {};
      out[source] = { from: r.date_from || null, to: r.date_to || null, days: Number(r.days) || 0, rows: Number(r.row_count) || 0 };
    }
    for (const source of ['empDetail', 'primaryTargets', 'secondaryTargets']) {
      const list = monthly.filter((x) => x.source === source).sort((a, b) => (a.month < b.month ? -1 : 1));
      out[source] = { months: list.map((x) => x.month), rows: list.reduce((s, x) => s + (Number(x.row_count) || 0), 0) };
    }
    return out;
  } catch (err) {
    if (!isAbsentAnswer(err)) throw err;
    return null;
  }
}

function hiddenSummary(hidden) {
  const names = (list, nameOf) => [...new Set(list.map(nameOf).filter(Boolean))].sort();
  const h = hidden || {};
  const of = (list, nameOf) => ({ rows: (list || []).length, names: names(list || [], nameOf) });
  return {
    timechamp: of(h.timechamp, (r) => r.employeeName),
    ivr: of(h.ivr, (r) => r.agentName),
    primaryTargets: of(h.primaryTargets, (r) => r.personName),
    secondaryTargets: of(h.secondaryTargets, (r) => r.personName),
  };
}

/* ═══ 3. Composition ════════════════════════════════════════════════════════ */

/**
 * compose() employees: the uploaded roster's people, narrowed to the ones this
 * window SHOWS. resolvePeople is the one answer to who that is (owner decisions
 * 6 and 7) and it read the same loadUploads emp detail rows, so the two agree
 * on keys; what the uploaded entry adds is the display name, vertical and
 * per-month teams loadUploads proved compose-exact against the MIS workbook.
 */
function visibleEmployees(uploadedEmployees, people) {
  const visible = new Set(people.employees.map((e) => e.key));
  return uploadedEmployees
    .filter((e) => visible.has(e.key))
    .map((e) => ({ key: e.key, display: e.display, vertical: e.vertical, teams: { ...e.teams } }));
}

/** Runs the thunks concurrently and waits for ALL of them before rethrowing the first failure. */
async function allSettledOrThrow(thunks) {
  const settled = await Promise.allSettled(thunks.map((fn) => fn()));
  const failed = settled.find((s) => s.status === 'rejected');
  if (failed) throw failed.reason;
  return settled.map((s) => s.value);
}

async function composeLive({ window, at, db, batch }) {
  const started = Date.now();
  const timings = {};
  const timed = async (name, fn) => {
    const s = Date.now();
    try {
      return await fn();
    } finally {
      timings[name] = Date.now() - s;
    }
  };
  const range = { from: window.from, to: window.to };

  const [closedRows, rest] = await allSettledOrThrow([
    () => timed('closedMs', () => sources.loadClosedJobs({ ...range, now: at })),
    async () => {
      const openRows = await timed('openMs', () => sources.loadOpenJobs({ now: at }));
      const crm = await timed('crmMs', () => sources.loadCrmCounts({ ...range, now: at }));
      const stored = await timed('uploadsMs', () => uploads.loadUploads({ ...range, db }));
      const coverage = stored.storage === 'ready' ? await readCoverage(db) : null;
      return { openRows, crm, stored, coverage };
    },
  ]);
  const { openRows, crm, stored, coverage } = rest;

  const people = sources.resolvePeople({ rows: { openRows, closedRows, crm }, rosterByMonth: stored.roster, window: range });
  const inputs = {
    window: range,
    employees: visibleEmployees(stored.employees, people),
    targets: stored.targets,
    openRows: people.openRows,
    closedRows: people.closedRows,
    crm: people.crm,
    timechamp: stored.timechamp,
    ivr: stored.ivr,
  };
  const composeStarted = Date.now();
  const D = compose(inputs, { teamMode: 'perMonth' });
  timings.composeMs = Date.now() - composeStarted;
  timings.totalMs = Date.now() - started;

  // Every closed / open job is on a named person's block or on an Unattributed
  // bucket, and D now holds BOTH: `attributed` sums the people, `bucketed` the
  // buckets. Checking each against the raw rows is what keeps the tiles honest
  // — a bucket dropped from D.primarySpocs again would make the KPIs go quiet
  // while attributed + unattributed still added up, which is exactly how this
  // went unnoticed before.
  const u = people.unattributed;
  const attributed = { closedJobs: 0, revenue: 0, openJobs: 0 };
  const bucketed = { closedJobs: 0, revenue: 0, openJobs: 0 };
  for (const n of D.primarySpocs) {
    const into = isUnattributedKey(n) ? bucketed : attributed;
    into.closedJobs += D.employees[n].completed;
    into.revenue += D.employees[n].revenue;
    into.openJobs += D.employees[n].open;
  }
  const totals = {
    closedJobs: closedRows.length,
    revenue: closedRows.reduce((s, r) => s + (Number(r.charge) || 0), 0),
    openJobs: openRows.length,
    crmRows: crm.length,
  };
  const reconciled = attributed.closedJobs + bucketed.closedJobs === totals.closedJobs
    && attributed.openJobs + bucketed.openJobs === totals.openJobs
    && sameMoney(attributed.revenue + bucketed.revenue, totals.revenue)
    // …and the buckets carry precisely the rows resolvePeople could not place.
    && bucketed.closedJobs === u.closedJobs
    && bucketed.openJobs === u.openJobs
    && sameMoney(bucketed.revenue, u.revenue);

  const meta = {
    from: range.from,
    to: range.to,
    generatedAt: new Date().toISOString(),
    jobsAsOf: at.toISOString(),
    months: people.months,
    visibility: people.visibility,
    uploads: {
      storage: stored.storage,
      lastBatch: batch.batch,
      uploadedBy: batch.batch ? batch.batch.uploadedBy : null,
      uploadedAt: batch.batch ? batch.batch.uploadedAt : null,
      coverage,
      rosterMonthsInWindow: stored.rosterMonths || [],
      hidden: hiddenSummary(stored.hidden),
    },
    totals,
    attributed,
    bucketed,
    reconciled,
    unattributed: u,
    warnings: people.warnings,
    timings,
  };

  const line = `Employee Performance live build · ${range.from}..${range.to} · batch=${batch.batchId ?? 'none'}`
    + ` · closed=${totals.closedJobs} · open=${totals.openJobs} · crmRows=${totals.crmRows}`
    + ` · employees=${Object.keys(D.employees).length} · spocs=${D.primarySpocs.length}`
    + ` · buckets=${D.primarySpocs.filter(isUnattributedKey).length}`
    + ` · hidden=${people.visibility.hidden} · noEmpDetail=${people.visibility.missingMonths.join(',') || 'none'}`
    + ` · unattributed=${u.closedJobs}/${u.openJobs} · reconciled=${reconciled} · ${timings.totalMs}ms`;
  // Not reconciled = a job the tab's own tables would not show: worth a look.
  if (reconciled) logger.info(line);
  else {
    logger.warn(line, { totals, attributed, bucketed,
      unattributed: { closedJobs: u.closedJobs, revenue: u.revenue, openJobs: u.openJobs } });
  }
  return { D, meta };
}

/* ═══ 4. Cache + build slots ═══════════════════════════════════════════════ */

const cache = new Map();   // key → { value, expires } | { promise }
let generation = 0;

function evict() {
  const nowMs = Date.now();
  for (const [k, e] of cache) if (!e.promise && e.expires <= nowMs) cache.delete(k);
  let resolved = [...cache].filter(([, e]) => !e.promise);
  while (resolved.length > CACHE_MAX_ENTRIES) {
    cache.delete(resolved[0][0]);
    resolved = resolved.slice(1);
  }
}

async function cachedBuild(key, build) {
  const hit = cache.get(key);
  if (hit && hit.promise) return hit.promise;
  if (hit && hit.expires > Date.now()) {
    cache.delete(key);          // most recently used goes last
    cache.set(key, hit);
    return hit.value;
  }
  const startedIn = generation;
  const slot = { promise: build() };
  cache.set(key, slot);
  try {
    const value = await slot.promise;
    if (cache.get(key) === slot) {
      if (startedIn === generation) {
        cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
        evict();
      } else {
        cache.delete(key);
      }
    }
    return value;
  } catch (err) {
    if (cache.get(key) === slot) cache.delete(key);
    throw err;
  }
}

let runningBuilds = 0;
const waiting = [];

async function withBuildSlot(fn) {
  if (runningBuilds < MAX_CONCURRENT_BUILDS) runningBuilds += 1;
  else await new Promise((resolve) => waiting.push(resolve));   // the slot is handed over, not re-counted
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else runningBuilds -= 1;
  }
}

/** Drop every cached build (and any in flight from being stored). Called after an upload is saved. */
function invalidateLiveCache() {
  generation += 1;
  cache.clear();
}

/* ═══ 5. Public API ═════════════════════════════════════════════════════════ */

/**
 * The live dashboard object for the tab's window.
 *
 * @param {{ from?: string, to?: string, month?: string, now?: Date, db?: pool }} [options]
 *   from / to / month as the tab sends them (see resolveLiveWindow); `now` is
 *   the clock (default: now) — the default window, today and open-job Aging
 *   are measured to it; `db` carries the upload reads (sources use the pool).
 * @returns {Promise<{ D: object, meta: {
 *   from, to, generatedAt, jobsAsOf, months: [{ month, rosterUploaded, employees, rosterSize }],
 *   visibility: { mode: 'single'|'intersection', hidden: number, missingMonths: string[] },
 *   uploads: { storage: 'ready'|'missing', lastBatch: {batchId, fileName, sheets, dateFrom, dateTo, monthFrom,
 *              monthTo, uploadedAt, uploadedBy: {userId, name}} | null, uploadedBy, uploadedAt,
 *              coverage: { timechamp: {from, to, days, rows}, ivr: {...},
 *                          empDetail: {months, rows}, primaryTargets: {...}, secondaryTargets: {...} } | null,
 *              rosterMonthsInWindow: string[],
 *              hidden: { timechamp|ivr|primaryTargets|secondaryTargets: { rows, names } } },
 *   totals: { closedJobs, revenue, openJobs, crmRows }, attributed: { closedJobs, revenue, openJobs },
 *   bucketed: { closedJobs, revenue, openJobs }  (the Unattributed buckets inside D),
 *   reconciled: boolean, unattributed: (sources.resolvePeople().unattributed), warnings, timings } }>}
 *   Both are SHARED cached objects: read-only.
 * @throws 400 bad window · 422 too many jobs (sources) · DB errors
 */
async function buildLiveD({ from, to, month, now, db = pool } = {}) {
  const at = now instanceof Date ? now : new Date();
  const window = resolveLiveWindow({ from, to, month }, at);
  const batch = await readLatestBatch(db);
  const key = [window.from, window.to, batch.storage, batch.batchId === null ? 'none' : batch.batchId].join('|');
  return cachedBuild(key, () => withBuildSlot(() => composeLive({ window, at, db, batch })));
}

module.exports = {
  buildLiveD,
  resolveLiveWindow,
  invalidateLiveCache,
  MAX_RANGE_MONTHS,
  CACHE_TTL_MS,
  CACHE_MAX_ENTRIES,
  _internals: { visibleEmployees, readLatestBatch, readCoverage, sameMoney, REVENUE_EPSILON,
    lastAllowedTo, cacheSize: () => cache.size },
};
