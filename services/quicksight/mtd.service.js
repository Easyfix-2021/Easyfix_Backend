/*
 * QuickSight — MTD: five job counts per PERSON, live from easyfix_core.
 *
 *   getMtdTable({ from, to, verticalId, zonalManagerId, sortBy, sortDir, page, size })
 *   getMtdSummary({ from, to, verticalId, zonalManagerId })
 *
 * One row per person, five numbers on it:
 *
 *   Ticket Created · In Progress · Open · Completed · Cancelled
 *
 * ─── WHO A ROW IS, AND WHY IT DISAGREES WITH EMPLOYEE PRODUCTIVITY ──────────
 *
 * The person is the CLIENT'S PRIMARY SPOC — the same attribution the Employee
 * Performance tab's job half uses (resolveClientPrimarySpoc, services/
 * job.service.js, the ONE definition of that rule). It is deliberately NOT the
 * Employee Productivity rule of "whoever performed the action", and the two
 * reports WILL disagree on the same window. That is the point, and it is the
 * owner's decision, not an accident to be reconciled away:
 *
 *   MTD                    "whose BOOK OF BUSINESS is this" — the account the
 *                          job belongs to, whoever happened to touch it.
 *   Employee Productivity  "who DID THE WORK" — the user who booked, scheduled,
 *                          closed or cancelled it.
 *
 * The owner confirmed this against their own MIS engine, whose field map reads
 *   "pspoc": ("Primary SPOC", "cat")
 * so this dashboard groups on the same column the workbook pivots on.
 *
 * Anyone comparing the two tabs should read this paragraph before filing the
 * difference as a bug.
 *
 * ─── THE FIVE SETS ─────────────────────────────────────────────────────────
 *
 * Every one is the EXISTING Manage Jobs definition, read through
 * employee-performance/sources.service.js. Nothing here re-derives a set:
 *
 *   TICKET CREATED  ticket_created_date_time inside the window, ANY status
 *                   (loadTicketCreatedJobs).
 *   IN PROGRESS     the open rows whose status is 2 or its on-app sibling 20
 *                   (IN_PROGRESS_STATUSES). A SUBSET of Open, shown beside it —
 *                   filtered out of the same read, so it can never exceed Open.
 *   OPEN            every job currently in the Open bucket (OPEN_STATUSES =
 *                   every status minus the terminal ones), with NO date filter
 *                   at all: a snapshot of what is open NOW, not of the window.
 *                   Changing the dates does not move this column, by design.
 *   COMPLETED       CLOSED_STATUSES (3,5) with checkout_date_time in the window.
 *   CANCELLED       job_status = 6 with cancel_date_time in the window.
 *
 * Windows are IST days, both ends inclusive of the whole day, exactly as
 * loadClosedJobs applies them; the default is the current IST month, 1st ..
 * today, which is what "MTD" means. The window is validated ONCE here, through
 * sources.checkWindow, because Open reads no window and so could never surface
 * a bad one on its own.
 *
 * ─── UNATTRIBUTED ──────────────────────────────────────────────────────────
 *
 * A job whose client resolves to no INTERNAL staff SPOC is never dropped. It
 * lands on the Unattributed row, following the Employee Performance precedent,
 * so the named rows plus that row always equal `totals` — `reconciled` says so
 * per metric and an inequality is logged as an error rather than rendered as a
 * quietly short report. Three things land there: a client with no Primary SPOC
 * mapping at all, a mapping pointing at a deleted user, and a mapping pointing
 * at an account that is not office staff (a technician or a client-dashboard
 * login whose name collides with an employee's).
 *
 * Unattributed is NOT a member of `data`: it is its own field, returned whole
 * on every page, because a paged-away or sorted-away reconciliation line is
 * worse than none at all.
 *
 * ─── FILTERS, SORTING, PAGING ──────────────────────────────────────────────
 *
 * verticalId / zonalManagerId are the same two the other QuickSight reports
 * expose and are applied as the EXPORT's own predicates (0 / omitted = All).
 * Sorting and paging follow quicksight-employee-productivity.service.js: a
 * named sort key, a direction, 1-based page, capped size, and `total` /
 * `totalPages` over the WHOLE filtered set rather than the page.
 *
 * ─── THE CACHE ─────────────────────────────────────────────────────────────
 *
 * One built object per (from, to, verticalId, zonalManagerId), kept
 * CACHE_TTL_MS, at most CACHE_MAX_ENTRIES (least recently used evicted), with
 * concurrent callers for the same key sharing one build. It exists because one
 * build walks the export FOUR times and the table and summary endpoints are
 * fetched together by the same tab. Every viewer holding the view key sees the
 * same global report (the loaders take no req.scope), so a cache keyed on the
 * window and the two filters cannot leak one user's data to another.
 *
 * The cached object is SHARED: callers must treat it as read-only. Sorting and
 * paging below copy before they touch anything.
 *
 * GET PATHS NEVER WRITE. Every statement this module reaches is a SELECT.
 */

'use strict';

const logger = require('../../logger');
const sources = require('./employee-performance/sources.service');

/* ═══ Constants ═════════════════════════════════════════════════════════════ */

const UNATTRIBUTED = sources.UNATTRIBUTED;
const IN_PROGRESS = new Set(sources.IN_PROGRESS_STATUSES);

// The five counts, in the order the tab shows them. Also the shape of every
// totals object below, so a metric added here appears everywhere at once.
const METRICS = Object.freeze(['ticketCreated', 'inProgress', 'open', 'completed', 'cancelled']);

// What ?sortBy accepts. 'name' is the person; the rest are the counts.
const SORT_KEYS = Object.freeze(['name', ...METRICS]);
/*
 * Biggest book of business first. The report answers "whose accounts are
 * these", so the person with the most tickets raised this month is the one the
 * reader is looking for; alphabetical would bury them on page 3.
 */
const DEFAULT_SORT_BY = 'ticketCreated';
const DEFAULT_SORT_DIR = 'desc';

const MAX_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = 50;

const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = 4;

/* ═══ Small helpers ═════════════════════════════════════════════════════════ */

const zeroCounts = () => Object.fromEntries(METRICS.map((m) => [m, 0]));

function getOrSet(map, key, make) {
  let v = map.get(key);
  if (v === undefined) {
    v = make();
    map.set(key, v);
  }
  return v;
}

/** 0, '', null and undefined all mean "no restriction" — the pickers' All. */
const filterId = (v) => (Number(v) > 0 ? Number(v) : null);

/**
 * The person a job row belongs to, or null for the Unattributed line.
 *
 * Three ways to be nobody, all of them ordinary rather than exceptional:
 * the client has no Primary SPOC mapping (spocUserId null), the mapping points
 * at a user that no longer exists (no name came back from tbl_user), or it
 * points at an account that is not office staff (spocInternal false — a
 * technician or a client-dashboard login). The loaders resolve all three; this
 * only reads their answer, so the rule stays in one place.
 */
function personIdOf(row) {
  if (row.spocUserId === null || row.spocUserId === undefined) return null;
  if (!row.spocInternal) return null;
  if (typeof row.spocName !== 'string' || row.spocName.trim() === '') return null;
  return row.spocUserId;
}

/* ═══ 1. The build ══════════════════════════════════════════════════════════ */

/**
 * Read the four job sets and tally them per person.
 *
 * @returns {{
 *   window: {from, to},
 *   scope: {verticalId: number|null, zonalManagerId: number|null},
 *   rows: Array<{userId, name, ticketCreated, inProgress, open, completed, cancelled}>,
 *   totals: object, attributed: object, unattributed: object, reconciled: boolean,
 *   meta: {readAt, jobsRead: object, ms: number}
 * }}
 *
 * `rows` holds the NAMED people only, in the default order. `totals` counts
 * every job the filters matched; `attributed` is the sum over rows and
 * `unattributed` the rest, so attributed + unattributed === totals.
 */
async function buildMtd({ from, to, verticalId, zonalManagerId, now = new Date() } = {}) {
  const started = Date.now();
  // Once, here: Open takes no window, so a bad one would otherwise reach the
  // caller as a perfectly successful report over the wrong days.
  const window = sources.checkWindow({ from, to }, now);
  const scope = { verticalId: filterId(verticalId), zonalManagerId: filterId(zonalManagerId) };

  const common = {
    now,
    verticalId: scope.verticalId === null ? undefined : scope.verticalId,
    zonalManagerId: scope.zonalManagerId === null ? undefined : scope.zonalManagerId,
  };
  const windowed = { ...common, from: window.from, to: window.to };

  /*
   * TWO LANES OF TWO, not four at once. Each export walk holds a connection
   * plus the SPOC resolver's 8-at-a-time burst, so two lanes is the same pool
   * budget employee-performance/live.service.js documents for its own build.
   * Four parallel walks would double it for a report whose whole output is
   * twenty-five integers.
   */
  const [[ticketRows, openRows], [closedRows, cancelledRows]] = await Promise.all([
    (async () => [
      await sources.loadTicketCreatedJobs(windowed),
      await sources.loadOpenJobs(common),
    ])(),
    (async () => [
      await sources.loadClosedJobs(windowed),
      await sources.loadCancelledJobs(windowed),
    ])(),
  ]);

  const people = new Map();           // userId → the row being built
  const unattributed = zeroCounts();
  const totals = zeroCounts();

  /*
   * Credit one job set to one metric. `keep` narrows a set without re-reading
   * it (In Progress over the open rows). Every row counts exactly once into
   * `totals`, and then onto a person or onto Unattributed — which is what makes
   * the reconciliation below an identity rather than a hope.
   */
  const credit = (rows, metric, keep = null) => {
    for (const row of rows) {
      if (keep !== null && !keep(row)) continue;
      totals[metric] += 1;
      const userId = personIdOf(row);
      if (userId === null) {
        unattributed[metric] += 1;
        continue;
      }
      const person = getOrSet(people, userId, () => ({ userId, name: row.spocName.trim(), ...zeroCounts() }));
      person[metric] += 1;
    }
  };

  credit(ticketRows, 'ticketCreated');
  credit(openRows, 'open');
  credit(openRows, 'inProgress', (row) => IN_PROGRESS.has(row.status));
  credit(closedRows, 'completed');
  credit(cancelledRows, 'cancelled');

  const rows = [...people.values()].sort(comparator(DEFAULT_SORT_BY, DEFAULT_SORT_DIR));
  const attributed = zeroCounts();
  for (const row of rows) for (const m of METRICS) attributed[m] += row[m];

  const reconciled = METRICS.every((m) => attributed[m] + unattributed[m] === totals[m]);
  if (!reconciled) {
    // Counts are integers; an off-by-one here is a lost job, never rounding.
    logger.error('QuickSight MTD does NOT reconcile · attributed=' + JSON.stringify(attributed)
      + ' unattributed=' + JSON.stringify(unattributed) + ' totals=' + JSON.stringify(totals));
  }

  const ms = Date.now() - started;
  const jobsRead = {
    ticketCreated: ticketRows.length,
    open: openRows.length,
    completed: closedRows.length,
    cancelled: cancelledRows.length,
  };
  logger.info(`QuickSight MTD built · ${window.from}..${window.to}`
    + ` · verticalId=${scope.verticalId} zonalManagerId=${scope.zonalManagerId}`
    + ` · people=${rows.length} · jobs=${JSON.stringify(jobsRead)}`
    + ` · unattributed=${JSON.stringify(unattributed)} · reconciled=${reconciled} · ${ms}ms`);

  return {
    window,
    scope,
    rows,
    totals,
    attributed,
    unattributed: { userId: null, name: UNATTRIBUTED, ...unattributed },
    reconciled,
    meta: { readAt: new Date().toISOString(), jobsRead, ms },
  };
}

/* ═══ 2. The cache ══════════════════════════════════════════════════════════ */

const cache = new Map();   // key → { at, promise }

const cacheKey = (window, scope) =>
  `${window.from}|${window.to}|${scope.verticalId ?? 'all'}|${scope.zonalManagerId ?? 'all'}`;

/**
 * buildMtd through the TTL cache. The window and the filters are normalised
 * BEFORE the key is made — so '?verticalId=0', '?verticalId=' and no
 * verticalId at all are one cache entry rather than three, and a bad window is
 * still a 400 from checkWindow rather than a cached anything.
 */
async function buildMtdCached(args = {}) {
  const now = args.now || new Date();
  const window = sources.checkWindow({ from: args.from, to: args.to }, now);
  const scope = { verticalId: filterId(args.verticalId), zonalManagerId: filterId(args.zonalManagerId) };
  const key = cacheKey(window, scope);

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    // Refresh recency: Map preserves insertion order, so re-inserting moves the
    // entry to the end and the eviction below drops the least recently USED.
    cache.delete(key);
    cache.set(key, hit);
    return hit.promise;
  }

  const entry = { at: Date.now(), promise: buildMtd({ ...args, ...window, ...scope, now }) };
  cache.set(key, entry);
  // A failed build must never be served for the next minute.
  entry.promise.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });
  while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return entry.promise;
}

/** Drop everything cached — for tests, and for anything that changes the data. */
function invalidateMtdCache() {
  cache.clear();
}

/* ═══ 3. Sorting and paging ═════════════════════════════════════════════════ */

/*
 * A total order, always. The chosen key first, then name, then userId — so two
 * people with the same count never swap places between two requests and page 2
 * never repeats a row page 1 already showed. Names compare case-insensitively
 * with localeCompare, the way the person reading the list would sort them.
 */
function comparator(sortBy, sortDir) {
  const key = SORT_KEYS.includes(sortBy) ? sortBy : DEFAULT_SORT_BY;
  const sign = sortDir === 'asc' ? 1 : -1;
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' });
  return (a, b) => {
    if (key === 'name') {
      const n = byName(a, b);
      if (n !== 0) return sign * n;
    } else if (a[key] !== b[key]) {
      return sign * (a[key] - b[key]);
    }
    const n = byName(a, b);
    if (n !== 0) return n;
    return a.userId - b.userId;
  };
}

function pageOf(rows, { page, size }) {
  const pageSize = Math.min(Math.max(Number(size) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const totalPages = Math.ceil(rows.length / pageSize);
  // A page past the end is an empty page, not a 404 and not page 1 again.
  const pageNumber = Math.max(Number(page) || 1, 1);
  const start = (pageNumber - 1) * pageSize;
  return { data: rows.slice(start, start + pageSize), total: rows.length, pageNumber, pageSize, totalPages };
}

/* ═══ 4. The report ═════════════════════════════════════════════════════════ */

/**
 * The per-person table: one page of named people, plus the totals, the
 * Unattributed row and the reconciliation flag — all three over the WHOLE
 * filtered set, never the page.
 */
async function getMtdTable({ from, to, verticalId, zonalManagerId, sortBy, sortDir, page, size, now } = {}) {
  const built = await buildMtdCached({ from, to, verticalId, zonalManagerId, now });
  // Copy before sorting: `built` is the shared cache entry.
  const sorted = built.rows.slice().sort(comparator(sortBy, sortDir));
  return {
    window: built.window,
    scope: built.scope,
    sort: { sortBy: SORT_KEYS.includes(sortBy) ? sortBy : DEFAULT_SORT_BY, sortDir: sortDir === 'asc' ? 'asc' : 'desc' },
    ...pageOf(sorted, { page, size }),
    totals: built.totals,
    attributed: built.attributed,
    unattributed: built.unattributed,
    reconciled: built.reconciled,
    meta: built.meta,
  };
}

/**
 * The KPI half of the same report: the five totals, what the named people carry
 * and what Unattributed does, with no rows at all. Shares the table's cache
 * entry, so opening the tab is one build rather than two.
 */
async function getMtdSummary({ from, to, verticalId, zonalManagerId, now } = {}) {
  const built = await buildMtdCached({ from, to, verticalId, zonalManagerId, now });
  return {
    window: built.window,
    scope: built.scope,
    people: built.rows.length,
    totals: built.totals,
    attributed: built.attributed,
    unattributed: built.unattributed,
    reconciled: built.reconciled,
    meta: built.meta,
  };
}

module.exports = {
  METRICS,
  SORT_KEYS,
  DEFAULT_SORT_BY,
  DEFAULT_SORT_DIR,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  UNATTRIBUTED,
  defaultWindow: sources.defaultWindow,
  checkWindow: sources.checkWindow,
  buildMtd,
  getMtdTable,
  getMtdSummary,
  invalidateMtdCache,
};
