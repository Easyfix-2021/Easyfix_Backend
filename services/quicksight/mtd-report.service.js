/*
 * QuickSight — MTD Client Report: every KPI and every section, live.
 *
 *   getMtdReport({ from, to, verticalId, zonalManagerId, clientIds, verticals,
 *                  spocUserIds })      → the six KPI tiles + sections 1..10
 *   getMtdJobs({ ...the same filters, status, bucket, q, sort, page, size })
 *                                      → section 11, the job list
 *
 * ─── WHAT THIS IS A COPY OF ────────────────────────────────────────────────
 *
 * The owner's MIS automation, "MTD Dashboard", builds this report from an
 * uploaded workbook: engine/prep.py flattens the Open / Closed / Cancelled /
 * ticket-created sheets, engine/themes.py tags the cancellation comments and
 * engine/template.html does the arithmetic and draws it. THAT FILE IS THE
 * SPEC. Every count below is the count its JavaScript makes, over the same job
 * set, grouped by the same column — the only difference is that we read the
 * live database through the Manage Jobs export instead of an .xlsx, so the
 * numbers move as the day does instead of as the last upload did.
 *
 * Where the template's arithmetic is surprising, it is surprising HERE too,
 * with the surprise written down. Three of them are worth knowing before
 * reading any number this module returns:
 *
 *  1. ORDERS CREATED IS NOT PART OF ANYTHING ELSE. It counts the tickets
 *     RAISED in the window (the ticket-created set). Completed / Cancelled /
 *     Open count jobs by when they CLOSED, were CANCELLED, or simply are —
 *     mostly other jobs, raised in other months. `ordersCreated` therefore
 *     does not equal, bound, or reconcile against `inHand`, and a month can
 *     easily complete more jobs than it created. The template says the same
 *     thing in its footnote; people still file it as a bug.
 *
 *  2. THERE ARE TWO COMPLETION PERCENTAGES AND THEY DISAGREE ON PURPOSE.
 *       KPI tile   completionPct = (completed + open) / (completed +
 *                  cancelled + open). "Of everything in hand this period, how
 *                  much did we NOT lose." It is exactly 100% − cancelledPct,
 *                  which is why the two tiles always add up.
 *       Section 2  completionRatePct = completed / (completed + cancelled),
 *                  over FINISHED jobs only. The donut. Open jobs are not in it
 *                  at all, so it is always the higher of the two.
 *     (The owner set the first one on 22 Sep; the template carries her name
 *     against that line. Do not "fix" either into the other.)
 *
 *  3. OPEN IS A BACKLOG, NOT A WINDOW. The open set is every job that is open
 *     NOW and was raised on or before the END of the window. It has no start
 *     date: moving `from` does not change it. That is what makes "jobs in
 *     hand" mean jobs in hand.
 *
 * ─── THE FOUR SETS ─────────────────────────────────────────────────────────
 *
 * Read through employee-performance/sources.service.js — the same four
 * loaders the per-SPOC table uses, no new SQL, no second definition of any
 * bucket:
 *
 *   CREATED    loadTicketCreatedJobs  ticket_created_date_time in window, any
 *              status.                     (prep.py's "ticket created" sheet)
 *   COMPLETED  loadClosedJobs         status 3/5, checkout_date_time in
 *              window.                                  (the "Closed" sheet)
 *   CANCELLED  loadCancelledJobs      status 6, cancel_date_time in window.
 *                                                    (the "Cancelled" sheet)
 *   OPEN       loadOpenJobs           the Open bucket as it stands now, then
 *              narrowed HERE to jobs raised on or before `to`, which is the
 *              template's own rule for its Open sheet.     (the "Open" sheet)
 *
 * A job can be in CREATED and in one of the other three at once. That is not
 * double counting: they answer different questions (see 1 above).
 *
 * ─── FILTERS ───────────────────────────────────────────────────────────────
 *
 * verticalId and zonalManagerId are the EXPORT's own predicates, exactly as
 * every other QuickSight report passes them, so they narrow the read itself.
 *
 * client, vertical NAME and Primary SPOC are the template's three pickers and
 * are applied HERE, over the rows already read, because they are multi-select
 * and the export takes one id per key. They are the same three dimensions the
 * MIS filter bar offers, and `filters` in the response carries each one's
 * options with the count it would have — counted with that dimension's OWN
 * selection ignored, which is what makes ticking a second client show you how
 * many jobs it would add rather than zero.
 *
 * ─── THE CACHE ─────────────────────────────────────────────────────────────
 *
 * One built report per full filter set, CACHE_TTL_MS, LRU-evicted. The report
 * endpoint and the job-list endpoint SHARE it — the job list is a slice of the
 * same build — so the tab costs one pass over the export, not two. Like the
 * per-SPOC table's cache, the loaders take no req.scope: every viewer holding
 * the view key sees the same global report, so a key over the window and the
 * filters cannot leak one user's rows to another.
 *
 * The cached object is SHARED and must be treated as read-only; the job list
 * copies before it sorts.
 *
 * GET PATHS NEVER WRITE. Every statement this module reaches is a SELECT.
 */

'use strict';

const logger = require('../../logger');
const { todayIst } = require('../../utils/ist-calendar');
const sources = require('./employee-performance/sources.service');
const { personIdOf } = require('./mtd.service');
const themes = require('./mtd-comment-themes');

/* ═══ Constants ═════════════════════════════════════════════════════════════ */

const UNATTRIBUTED = sources.UNATTRIBUTED;
// The template's own label for a dimension value the job does not carry.
const BLANK = '(Blank)';
const BLANK_CITY = '(City not given)';
const NO_REASON_PICKED = '(No reason picked)';

/*
 * Days open, sections 3 and 4 (the grouped bars and the tiles beside them).
 * template.html AGE_BUCKETS / ageBucket: each band INCLUDES its upper bound,
 * so no job can land in two of them and none can fall between two.
 */
const AGE_BUCKETS = Object.freeze([
  { key: '0-2', label: '0–2 days', max: 2 },
  { key: '3-5', label: '3–5 days', max: 5 },
  { key: '6-9', label: '6–9 days', max: 9 },
  { key: '9+', label: 'Over 9 days', max: Infinity },
]);

/*
 * Days open, sections 9 and 10 (the status × aging matrix). A DIFFERENT set of
 * bands from AGE_BUCKETS above — the owner asked for six here and four there,
 * and template.html carries both. Keeping them as two constants is the point:
 * one of them changing must not move the other.
 */
const SA_BUCKETS = Object.freeze([
  { key: '0-3', label: '0–3 days', short: '0–3', max: 3 },
  { key: '4-5', label: '4–5 days', short: '4–5', max: 5 },
  { key: '6-9', label: '6–9 days', short: '6–9', max: 9 },
  { key: '10-15', label: '10–15 days', short: '10–15', max: 15 },
  { key: '16-30', label: '16–30 days', short: '16–30', max: 30 },
  { key: '30+', label: 'Over 30 days', short: '>30', max: Infinity },
]);

// The three rows of the status × aging matrix, in the template's order.
const SA_STATUSES = Object.freeze(['completed', 'cancelled', 'open']);

/*
 * Day view up to this many days; beyond it the day-wise chart rolls up to
 * weeks, because 90 bars on one axis is not a chart. template.html: `weekly =
 * span > 62`. Weeks start on MONDAY.
 */
const MAX_DAY_BUCKETS = 62;

/*
 * The next-day forecast averages this many COMPLETE days. The owner moved it
 * from 7 to 2 on 21 Sep; template.html's AVG_WINDOW carries her name.
 */
const AVG_WINDOW = 2;

/*
 * A day is still filling until 23:00 IST. The template asks the same question
 * of its export's timestamp (`asof % 1440 < 1380`); live, the timestamp is the
 * clock. A partial day is excluded from the forecast's average — averaging a
 * half-finished day would drag every forecast down by lunchtime.
 */
const DAY_COMPLETE_AFTER_MIN = 23 * 60;
const IST_OFFSET_MIN = 5 * 60 + 30;

const MAX_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = 50;
const JOB_SORT_KEYS = Object.freeze(['jobId', 'jobStatus', 'daysOpen']);

const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX_ENTRIES = 6;

/* ═══ Small helpers ═════════════════════════════════════════════════════════ */

const MS_PER_DAY = 86400000;

/** 'YYYY-MM-DD' → whole days since 1970-01-01, so day maths is integer maths. */
const dayIndex = (ymd) => {
  if (typeof ymd !== 'string' || ymd.length < 10) return null;
  const t = Date.parse(`${ymd.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(t) ? null : Math.round(t / MS_PER_DAY);
};
const ymdOf = (index) => new Date(index * MS_PER_DAY).toISOString().slice(0, 10);

/** Monday of the week a day index falls in — the template's week start. */
const weekStart = (index) => index - ((new Date(index * MS_PER_DAY).getUTCDay() + 6) % 7);

/** Minutes past midnight, IST, for `now`. */
const istMinutesOfDay = (now) => {
  const shifted = new Date(now.getTime() + IST_OFFSET_MIN * 60000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
};

/**
 * One percentage, the way every tile and every table cell in the template
 * shows one: the two numbers it was made of, and the value rounded to a single
 * decimal. A zero denominator is `null` — the template prints an en dash
 * there, and 0% would be a claim the data does not support.
 */
const pct = (num, den) => ({
  num,
  den,
  pct: den > 0 ? Math.round((num / den) * 1000) / 10 : null,
});

const sum = (list) => list.reduce((a, b) => a + b, 0);

function getOrSet(map, key, make) {
  let v = map.get(key);
  if (v === undefined) {
    v = make();
    map.set(key, v);
  }
  return v;
}

const filterId = (v) => (Number(v) > 0 ? Number(v) : null);

/**
 * A repeatable filter as a Set, or null for "no restriction".
 *
 * An EMPTY selection is not the same as no selection anywhere else in this
 * codebase and is not here either: the pickers send nothing at all for "All",
 * so an empty array can only come from a caller that built one, and it means
 * "nothing selected" → no restriction, which is what the template's empty
 * `dim.sel` does.
 */
function selectionOf(values) {
  if (values === null || values === undefined) return null;
  const list = Array.isArray(values) ? values : [values];
  if (list.length === 0) return null;
  return new Set(list);
}

/**
 * Days open for one job row: the export's Aging column, floored at zero.
 *
 * template.html has two functions for this (`ageOf` and `daysOpen`) which
 * differ only in whether a negative aging is clamped — and since every band in
 * both bucket sets puts a negative in its first band anyway, they never
 * disagree about a bucket. One function, clamped, because a job list showing
 * "-1 days" is a bug report waiting to happen.
 */
const daysOpenOf = (row) => {
  const a = Number(row.aging);
  return Number.isFinite(a) ? Math.max(0, Math.floor(a)) : 0;
};

const bucketIndex = (buckets, days) => {
  for (let i = 0; i < buckets.length; i += 1) if (days <= buckets[i].max) return i;
  return buckets.length - 1;
};

/* ═══ 1. The dimensions ═════════════════════════════════════════════════════ */

/*
 * The template's three pickers. Each one says how to read its value off a job
 * row, how to label a job that has no value, and what the API calls it.
 *
 * `id` is what a request selects on and `name` is what the picker shows.
 * For client and vertical the blank is the template's '(Blank)'; for the SPOC
 * it is 'Unattributed', the label the per-SPOC table beside it already uses
 * for the very same jobs — two names for one row would be worse than either.
 */
const DIMENSIONS = Object.freeze([
  {
    key: 'client',
    param: 'clientId',
    idOf: (row) => (row.clientId === null || row.clientId === undefined ? 0 : row.clientId),
    nameOf: (row) => (row.client === null || row.client === undefined ? BLANK : row.client),
  },
  {
    key: 'vertical',
    param: 'vertical',
    // Verticals reach a job row as a NAME only (the export's Vertical Name);
    // the numeric verticalId is the export's own predicate and is applied
    // before these rows exist. So the name is both the id and the label.
    idOf: (row) => (row.vertical === null || row.vertical === undefined ? BLANK : row.vertical),
    nameOf: (row) => (row.vertical === null || row.vertical === undefined ? BLANK : row.vertical),
  },
  {
    key: 'spoc',
    param: 'spocUserId',
    idOf: (row) => personIdOf(row) ?? 0,
    nameOf: (row) => (personIdOf(row) === null ? UNATTRIBUTED : String(row.spocName).trim()),
  },
]);

/** Does this row pass every dimension filter except (optionally) one? */
function passesDims(row, selections, skipKey = null) {
  for (const dim of DIMENSIONS) {
    if (dim.key === skipKey) continue;
    const sel = selections[dim.key];
    if (sel === null) continue;
    if (!sel.has(dim.idOf(row))) return false;
  }
  return true;
}

/**
 * The options one picker offers, each with the count it would have — counted
 * with its OWN selection ignored, so the number beside an unticked option is
 * how many jobs ticking it would add rather than the zero it has today.
 * template.html countsFor(). Biggest first, then by name.
 */
function optionsFor(dim, rowSets, selections) {
  const seen = new Map();
  for (const rows of rowSets) {
    for (const row of rows) {
      if (!passesDims(row, selections, dim.key)) continue;
      const id = dim.idOf(row);
      const opt = getOrSet(seen, id, () => ({ id, name: dim.nameOf(row), jobs: 0 }));
      opt.jobs += 1;
    }
  }
  return [...seen.values()].sort((a, b) => b.jobs - a.jobs
    || String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' }));
}

/* ═══ 2. Section 1 — tickets created vs completed, day by day ═══════════════ */

/**
 * The bars, the lines and the open-jobs line, per day (or per week once the
 * range is longer than MAX_DAY_BUCKETS days).
 *
 * `open` on a bucket is THE BACKLOG AT THE END OF ITS LAST DAY: jobs raised on
 * or before that day that had not been completed or cancelled by then. It is
 * rebuilt from the three job sets with a difference array — each job is open
 * over [the day it was raised, the day before it closed], and a job that is
 * still open runs to the end of the range.
 *
 * It is `null` before `openFrom`, and that is not a gap to fill in. The window
 * only holds the jobs that CLOSED inside it, so a day before the first closure
 * we can see has no way of knowing which of its open jobs closed the week
 * after — it would draw a backlog far too high and call it history. The
 * template refuses the same days for the same reason.
 */
function buildDaily({ from, to, created, completed, cancelled, open, now }) {
  const lo = dayIndex(from);
  const hi = dayIndex(to);
  const span = hi - lo + 1;
  const weekly = span > MAX_DAY_BUCKETS;
  const step = weekly ? 7 : 1;
  const startOf = (d) => (weekly ? weekStart(d) : d);
  const first = startOf(lo);
  const count = Math.floor((startOf(hi) - first) / step) + 1;

  const createdPer = new Array(count).fill(0);
  const completedPer = new Array(count).fill(0);
  const slotOf = (d) => Math.floor((startOf(d) - first) / step);

  for (const row of created) {
    const d = dayIndex(row.date);
    if (d === null || d < lo || d > hi) continue;
    createdPer[slotOf(d)] += 1;
  }
  for (const row of completed) {
    const d = dayIndex(row.date);
    if (d === null || d < lo || d > hi) continue;
    completedPer[slotOf(d)] += 1;
  }

  /*
   * The backlog, as a difference array over [lo, hi]. One pass per job, not
   * one pass per day per job.
   */
  const diff = new Int32Array(span + 1);
  const addSpan = (a, b) => {
    if (a > b) return;
    diff[a - lo] += 1;
    diff[b - lo + 1] -= 1;
  };
  for (const row of open) {
    const raised = dayIndex(row.ticketDate);
    addSpan(raised === null ? lo : Math.max(lo, raised), hi);
  }
  for (const rows of [completed, cancelled]) {
    for (const row of rows) {
      const closed = dayIndex(row.date);
      if (closed === null) continue;
      const raised = dayIndex(row.ticketDate);
      addSpan(raised === null ? lo : Math.max(lo, raised), Math.min(hi, closed - 1));
    }
  }
  const backlog = new Int32Array(span);
  let running = 0;
  for (let k = 0; k < span; k += 1) {
    running += diff[k];
    backlog[k] = running;
  }

  // The first day we can honestly draw a backlog for: the day before the
  // earliest closure the window holds.
  let earliestClosure = Infinity;
  for (const rows of [completed, cancelled]) {
    for (const row of rows) {
      const d = dayIndex(row.date);
      if (d !== null && d < earliestClosure) earliestClosure = d;
    }
  }
  const openFrom = Number.isFinite(earliestClosure) ? earliestClosure - 1 : null;

  const today = todayIst(now);
  const asOfDay = dayIndex(today);
  const dayStillFilling = istMinutesOfDay(now) < DAY_COMPLETE_AFTER_MIN;

  const buckets = [];
  for (let k = 0; k < count; k += 1) {
    const a = Math.max(first + k * step, lo);
    const b = Math.min(first + k * step + step - 1, hi);
    const hasOpen = openFrom === null || b >= openFrom;
    buckets.push({
      from: ymdOf(a),
      to: ymdOf(b),
      created: createdPer[k],
      completed: completedPer[k],
      open: hasOpen ? backlog[b - lo] : null,
      partial: b === asOfDay && dayStillFilling,
    });
  }

  /*
   * The next-day forecast: the average of the last AVG_WINDOW COMPLETE
   * buckets, carried one bucket forward. Offered only in the day view and only
   * when the range actually runs up to today — forecasting the day after a
   * range that ended last month is a number about nothing.
   *
   * The day it lands on is the day after the last complete one, which is TODAY
   * while today is still filling (the chart draws it over the part-day bar)
   * and TOMORROW once today is done. `beyondRange` says which.
   *
   * ONE DELIBERATE DIFFERENCE FROM THE TEMPLATE. It may reach up to
   * AVG_WINDOW-1 days BEFORE the chosen range for its average (never before
   * that month's 1st), so that a range starting mid-month still averages two
   * days. We do not: the days before `from` are days we did not read, and
   * widening the whole report's window by a day to soften one dashed line
   * would move nothing else and cost another pass over the export. For the
   * default month-to-date view — where the range already starts on the 1st —
   * the two are identical, because the template's own reach stops there too.
   * A custom range whose first day is mid-month averages one day here and two
   * there, and only on its first day.
   */
  let forecast = null;
  const complete = [];
  buckets.forEach((b, i) => { if (!b.partial) complete.push(i); });
  if (!weekly && to === today && complete.length > 0) {
    const basis = complete.slice(-AVG_WINDOW);
    const day = dayIndex(buckets[complete[complete.length - 1]].to) + 1;
    forecast = {
      day: ymdOf(day),
      created: Math.round((sum(basis.map((i) => buckets[i].created)) / basis.length) * 100) / 100,
      completed: Math.round((sum(basis.map((i) => buckets[i].completed)) / basis.length) * 100) / 100,
      basisDays: basis.map((i) => buckets[i].to),
      window: AVG_WINDOW,
      beyondRange: day > hi,
    };
  }

  return {
    granularity: weekly ? 'week' : 'day',
    buckets,
    totals: {
      created: sum(buckets.map((b) => b.created)),
      completed: sum(buckets.map((b) => b.completed)),
    },
    openFrom: openFrom === null ? null : ymdOf(openFrom),
    forecast,
  };
}

/* ═══ 3. Sections 3–7 — days open, cancel reasons, comment themes ═══════════ */

/**
 * The days-open split of FINISHED jobs (completed + cancelled), and — for the
 * cancelled half only — why. Sections 3, 4, 5, 6 and 7 all come out of this
 * one pass, because they are all the same rows read three ways.
 *
 * Reasons and themes are returned PER DAYS-OPEN BUCKET as well as in total.
 * That is not decoration: the template lets you click a days-open tile and
 * watch "Why cancelled" narrow to it, and shipping the breakdown means that
 * click is instant instead of another trip to the server. The parts always sum
 * to the whole, which is also how the reconciliation below checks itself.
 */
function buildDaysOpen({ completed, cancelled }) {
  const n = AGE_BUCKETS.length;
  const done = new Array(n).fill(0);
  const canc = new Array(n).fill(0);
  const reasons = new Map();
  const themeCounts = new Map();

  for (const row of completed) done[bucketIndex(AGE_BUCKETS, daysOpenOf(row))] += 1;

  const tally = (map, name, slot) => {
    const e = getOrSet(map, name, () => ({ name, total: 0, byBucket: new Array(n).fill(0) }));
    e.total += 1;
    e.byBucket[slot] += 1;
  };
  for (const row of cancelled) {
    const slot = bucketIndex(AGE_BUCKETS, daysOpenOf(row));
    canc[slot] += 1;
    tally(reasons, row.cancelReason === null || row.cancelReason === undefined
      ? NO_REASON_PICKED : row.cancelReason, slot);
    tally(themeCounts, themes.themeOf(row.cancelComment), slot);
  }

  const byCount = (a, b) => b.total - a.total
    || String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' });

  const buckets = AGE_BUCKETS.map((b, i) => ({
    key: b.key,
    label: b.label,
    completed: done[i],
    cancelled: canc[i],
    total: done[i] + canc[i],
    cancelRate: pct(canc[i], done[i] + canc[i]),
  }));

  /*
   * The band the template highlights: the HIGHEST cancel rate, not the most
   * cancellations. A band with three jobs, two of them cancelled, is the one
   * worth looking at even though a busier band lost more.
   */
  let worst = null;
  let worstRate = -1;
  for (const b of buckets) {
    if (b.cancelRate.pct !== null && b.cancelRate.pct > worstRate) {
      worstRate = b.cancelRate.pct;
      worst = b.key;
    }
  }

  const totalDone = sum(done);
  const totalCanc = sum(canc);
  return {
    byDaysOpen: {
      buckets,
      totals: {
        completed: totalDone,
        cancelled: totalCanc,
        total: totalDone + totalCanc,
        cancelRate: pct(totalCanc, totalDone + totalCanc),
      },
      worstBucket: worst,
    },
    whyCancelled: {
      cancelled: totalCanc,
      buckets: AGE_BUCKETS.map((b) => ({ key: b.key, label: b.label })),
      reasons: [...reasons.values()].sort(byCount),
      themes: [...themeCounts.values()].sort(byCount),
      themeNames: themes.THEMES,
    },
  };
}

/* ═══ 4. Section 8 — city-wise ══════════════════════════════════════════════ */

/**
 * Orders created and completed per city — created from the ticket-created set
 * by the day the ticket was raised, completed from the closed set by the day
 * it was checked out. The same two numbers the KPI tiles show, cut by city.
 *
 * The state beside a city is the one MOST of that city's jobs carry, not the
 * one the first row happened to have: city names repeat across states and the
 * export fills the column per job, so a handful of mis-tagged rows must not
 * relabel a city. Ties keep the state seen first.
 */
function buildCities({ created, completed }) {
  const cities = new Map();
  const cityOf = (row) => (row.city === null || row.city === undefined ? BLANK_CITY : row.city);
  const entry = (row) => getOrSet(cities, cityOf(row), () => ({
    city: cityOf(row), state: null, created: 0, completed: 0, votes: new Map(),
  }));
  const vote = (e, row) => {
    if (row.state === null || row.state === undefined) return;
    e.votes.set(row.state, (e.votes.get(row.state) || 0) + 1);
  };

  for (const row of created) {
    const e = entry(row);
    e.created += 1;
    vote(e, row);
  }
  for (const row of completed) {
    const e = entry(row);
    e.completed += 1;
    vote(e, row);
  }

  return [...cities.values()].map((e) => {
    let best = 0;
    let state = null;
    for (const [name, n] of e.votes) {
      if (n > best) {
        best = n;
        state = name;
      }
    }
    return { city: e.city, state, created: e.created, completed: e.completed };
  }).sort((a, b) => b.created - a.created || b.completed - a.completed
    || String(a.city).localeCompare(String(b.city), 'en', { sensitivity: 'base' }));
}

/* ═══ 5. Sections 9–11 — status × days open, and the job list ═══════════════ */

/**
 * The matrix: completed / cancelled / open down the side, six days-open bands
 * across the top, every job in hand in exactly one cell. Its grand total is
 * the KPI tiles' `inHand`, by construction — these are the very same rows.
 *
 * The job list (section 11) is built in the same pass and kept whole, because
 * the list is what a reader clicks a cell to see and re-deriving it on that
 * click would mean reading the export again to answer a question we have
 * already answered.
 */
function buildStatusAging({ completed, cancelled, open }) {
  const nb = SA_BUCKETS.length;
  const matrix = SA_STATUSES.map(() => new Array(nb).fill(0));
  const jobs = [];

  SA_STATUSES.forEach((status, r) => {
    const rows = status === 'completed' ? completed : status === 'cancelled' ? cancelled : open;
    for (const row of rows) {
      const days = daysOpenOf(row);
      matrix[r][bucketIndex(SA_BUCKETS, days)] += 1;
      jobs.push({
        jobId: row.jobId,
        jobStatus: row.jobStatus === null || row.jobStatus === undefined ? BLANK : row.jobStatus,
        daysOpen: days,
        status,
      });
    }
  });

  const rowTotals = matrix.map((r) => sum(r));
  const columnTotals = SA_BUCKETS.map((_, b) => sum(matrix.map((r) => r[b])));
  return {
    statusAging: {
      buckets: SA_BUCKETS.map((b) => ({ key: b.key, label: b.label, short: b.short })),
      rows: SA_STATUSES.map((status, r) => ({
        status,
        label: status[0].toUpperCase() + status.slice(1),
        counts: matrix[r],
        total: rowTotals[r],
      })),
      columnTotals,
      grand: sum(rowTotals),
    },
    jobs,
  };
}

/* ═══ 6. The build ══════════════════════════════════════════════════════════ */

/**
 * Read the four job sets once and produce every number on the tab.
 *
 * @returns the object both endpoints answer from — see the module header for
 *          what each block means and the route file for the wire shape.
 */
async function buildMtdReport({
  from, to, verticalId, zonalManagerId, clientIds, verticals, spocUserIds, now = new Date(),
} = {}) {
  const started = Date.now();
  // Once, here: the open set reads NO window, so a bad one would otherwise
  // come back as a perfectly successful report over the wrong days.
  const window = sources.checkWindow({ from, to }, now);
  // The Sets ARE the filter; `scope` is only how they are reported back, so it
  // is derived from them rather than from the raw arguments. An empty pick and
  // no pick at all must not describe themselves differently when they behave
  // identically.
  const selections = {
    client: selectionOf(clientIds),
    vertical: selectionOf(verticals),
    spoc: selectionOf(spocUserIds),
  };
  const listOf = (set) => (set === null ? null : [...set]);
  const scope = {
    verticalId: filterId(verticalId),
    zonalManagerId: filterId(zonalManagerId),
    clientIds: listOf(selections.client),
    verticals: listOf(selections.vertical),
    spocUserIds: listOf(selections.spoc),
  };

  const common = {
    now,
    verticalId: scope.verticalId === null ? undefined : scope.verticalId,
    zonalManagerId: scope.zonalManagerId === null ? undefined : scope.zonalManagerId,
  };
  const windowed = { ...common, from: window.from, to: window.to };

  /*
   * Two lanes of two, the budget employee-performance/live.service.js
   * documents: each walk of the export holds a connection plus the SPOC
   * resolver's eight-at-a-time burst, and four at once would double that for a
   * report whose whole output is a few hundred integers.
   */
  const [[createdAll, openAll], [completedAll, cancelledAll]] = await Promise.all([
    (async () => [
      await sources.loadTicketCreatedJobs(windowed),
      await sources.loadOpenJobs(common),
    ])(),
    (async () => [
      await sources.loadClosedJobs(windowed),
      await sources.loadCancelledJobs(windowed),
    ])(),
  ]);

  /*
   * The open set's date rule, which is the template's and nobody else's: a job
   * that is open NOW counts if it was RAISED on or before the end of the
   * range. There is no lower bound — a job raised in March and still open is
   * part of September's backlog, which is exactly what "in hand" means. A job
   * with no ticket date at all is KEPT, as the template keeps it: the export
   * has it open, so it is open.
   */
  const hi = dayIndex(window.to);
  const openWindowed = openAll.filter((row) => {
    const d = dayIndex(row.ticketDate);
    return d === null || d <= hi;
  });

  const keep = (rows) => rows.filter((row) => passesDims(row, selections));
  const created = keep(createdAll);
  const completed = keep(completedAll);
  const cancelled = keep(cancelledAll);
  const open = keep(openWindowed);
  // The backlog line runs over the whole open bucket, not the windowed slice:
  // buildDaily clips each job to the range itself.
  const openForBacklog = keep(openAll);

  /* ── the six KPI tiles ─────────────────────────────────────────────────── */

  const ordersCreated = created.length;
  const nCompleted = completed.length;
  const nCancelled = cancelled.length;
  const nOpen = open.length;
  const inHand = nCompleted + nCancelled + nOpen;
  // TAT Status is the export's own 1 = closed inside TAT, 0 = outside. The
  // denominator is COMPLETED jobs — a cancelled or open job has no turnaround
  // to have met.
  const inTat = completed.reduce((a, row) => a + (Number(row.tat) === 1 ? 1 : 0), 0);

  const kpis = {
    ordersCreated,
    completed: nCompleted,
    cancelled: nCancelled,
    open: nOpen,
    inHand,
    completionPct: pct(nCompleted + nOpen, inHand),
    tatPct: pct(inTat, nCompleted),
    cancelledPct: pct(nCancelled, inHand),
  };

  const daily = buildDaily({
    from: window.from, to: window.to, created, completed, cancelled, open: openForBacklog, now,
  });
  const { byDaysOpen, whyCancelled } = buildDaysOpen({ completed, cancelled });
  const cities = buildCities({ created, completed });
  const { statusAging, jobs } = buildStatusAging({ completed, cancelled, open });

  const completionVsCancellation = {
    completed: nCompleted,
    cancelled: nCancelled,
    finished: nCompleted + nCancelled,
    // The DONUT's rate — finished jobs only. Not kpis.completionPct. See the
    // module header, point 2.
    completionRate: pct(nCompleted, nCompleted + nCancelled),
  };

  const rowSets = [completedAll, cancelledAll, openWindowed];
  const filters = {
    clients: optionsFor(DIMENSIONS[0], rowSets, selections),
    verticals: optionsFor(DIMENSIONS[1], rowSets, selections),
    spocs: optionsFor(DIMENSIONS[2], rowSets, selections),
  };

  /*
   * Reconciliation, the habit this codebase has: wherever a section SPLITS a
   * total, the parts plus any remainder must equal it. These are integer
   * counts, so a mismatch is a lost job, never rounding — it is logged as an
   * error and shipped on the response rather than quietly rendered as a short
   * report nobody notices.
   *
   * `ordersCreated` is deliberately absent: it counts a DIFFERENT set of jobs
   * and reconciles against nothing (module header, point 1).
   */
  const checks = {
    inHand: nCompleted + nCancelled + nOpen === inHand,
    // Completion % and Cancelled % are the two halves of one whole.
    percentHalves: kpis.completionPct.num + kpis.cancelledPct.num === inHand,
    daily: daily.totals.created === ordersCreated && daily.totals.completed === nCompleted,
    daysOpen: byDaysOpen.totals.completed === nCompleted && byDaysOpen.totals.cancelled === nCancelled
      && sum(byDaysOpen.buckets.map((b) => b.total)) === byDaysOpen.totals.total,
    reasons: sum(whyCancelled.reasons.map((r) => r.total)) === nCancelled
      && whyCancelled.reasons.every((r) => sum(r.byBucket) === r.total),
    themes: sum(whyCancelled.themes.map((t) => t.total)) === nCancelled
      && whyCancelled.themes.every((t) => sum(t.byBucket) === t.total),
    // Every cancelled job is in exactly one reason band AND one theme band, so
    // both breakdowns must agree with the days-open split column by column.
    cancelBands: byDaysOpen.buckets.every((b, i) => sum(whyCancelled.reasons.map((r) => r.byBucket[i])) === b.cancelled
      && sum(whyCancelled.themes.map((t) => t.byBucket[i])) === b.cancelled),
    cities: sum(cities.map((c) => c.created)) === ordersCreated
      && sum(cities.map((c) => c.completed)) === nCompleted,
    statusAging: statusAging.grand === inHand
      && sum(statusAging.columnTotals) === inHand
      && statusAging.rows[0].total === nCompleted
      && statusAging.rows[1].total === nCancelled
      && statusAging.rows[2].total === nOpen,
    jobs: jobs.length === inHand,
  };
  const reconciled = Object.values(checks).every(Boolean);
  if (!reconciled) {
    logger.error('QuickSight MTD report does NOT reconcile · ' + JSON.stringify(checks)
      + ' · kpis=' + JSON.stringify({ ordersCreated, nCompleted, nCancelled, nOpen, inHand }));
  }

  const ms = Date.now() - started;
  const jobsRead = {
    ticketCreated: createdAll.length,
    open: openAll.length,
    completed: completedAll.length,
    cancelled: cancelledAll.length,
  };
  logger.info(`QuickSight MTD report built · ${window.from}..${window.to}`
    + ` · verticalId=${scope.verticalId} zonalManagerId=${scope.zonalManagerId}`
    + ` · client=${scope.clientIds ? scope.clientIds.length : 'all'}`
    + ` vertical=${scope.verticals ? scope.verticals.length : 'all'}`
    + ` spoc=${scope.spocUserIds ? scope.spocUserIds.length : 'all'}`
    + ` · jobs=${JSON.stringify(jobsRead)} · inHand=${inHand} created=${ordersCreated}`
    + ` · reconciled=${reconciled} · ${ms}ms`);

  return {
    window,
    scope,
    asOf: {
      // The data is the database as of this instant — there is no upload date
      // to quote, which is the whole point of reading it live.
      readAt: new Date().toISOString(),
      day: todayIst(now),
      dayStillFilling: istMinutesOfDay(now) < DAY_COMPLETE_AFTER_MIN,
    },
    kpis,
    daily,
    completionVsCancellation,
    byDaysOpen,
    whyCancelled,
    cities,
    statusAging,
    jobs,
    filters,
    reconciled,
    checks,
    meta: { readAt: new Date().toISOString(), jobsRead, ms },
  };
}

/* ═══ 7. The cache ══════════════════════════════════════════════════════════ */

const cache = new Map();   // key → { at, promise }

const cacheKey = (window, scope) => [
  window.from, window.to,
  scope.verticalId ?? 'all',
  scope.zonalManagerId ?? 'all',
  scope.clientIds === null ? 'all' : [...scope.clientIds].sort().join('.'),
  scope.verticals === null ? 'all' : [...scope.verticals].sort().join('.'),
  scope.spocUserIds === null ? 'all' : [...scope.spocUserIds].sort().join('.'),
].join('|');

/**
 * buildMtdReport through the TTL cache. The window and every filter are
 * normalised BEFORE the key is made, so '?verticalId=0', '?verticalId=' and no
 * verticalId at all are one entry rather than three, and two requests that
 * picked the same clients in a different order share a build.
 */
async function buildMtdReportCached(args = {}) {
  const now = args.now || new Date();
  const window = sources.checkWindow({ from: args.from, to: args.to }, now);
  const scope = {
    verticalId: filterId(args.verticalId),
    zonalManagerId: filterId(args.zonalManagerId),
    clientIds: selectionOf(args.clientIds),
    verticals: selectionOf(args.verticals),
    spocUserIds: selectionOf(args.spocUserIds),
  };
  const key = cacheKey(window, scope);

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    // Map keeps insertion order, so re-inserting moves the entry to the end
    // and the eviction below drops the least recently USED.
    cache.delete(key);
    cache.set(key, hit);
    return hit.promise;
  }

  const entry = {
    at: Date.now(),
    promise: buildMtdReport({
      ...window,
      verticalId: scope.verticalId,
      zonalManagerId: scope.zonalManagerId,
      clientIds: scope.clientIds === null ? null : [...scope.clientIds],
      verticals: scope.verticals === null ? null : [...scope.verticals],
      spocUserIds: scope.spocUserIds === null ? null : [...scope.spocUserIds],
      now,
    }),
  };
  cache.set(key, entry);
  // A failed build must never be served for the next minute.
  entry.promise.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });
  while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  return entry.promise;
}

/** Drop everything cached — for tests, and for anything that changes the data. */
function invalidateMtdReportCache() {
  cache.clear();
}

/* ═══ 8. The two reports ════════════════════════════════════════════════════ */

/**
 * The tab: the six KPI tiles and sections 1 to 10, with the picker options
 * that produced them. The job list is NOT here — it is its own endpoint,
 * because it is the one part that can run to thousands of rows and the one
 * part that is paged.
 */
async function getMtdReport(args = {}) {
  const built = await buildMtdReportCached(args);
  const report = { ...built, jobCount: built.jobs.length };
  delete report.jobs;
  return report;
}

function jobComparator(sortBy, sortDir) {
  const key = JOB_SORT_KEYS.includes(sortBy) ? sortBy : 'daysOpen';
  const sign = sortDir === 'asc' ? 1 : -1;
  // A TOTAL order, always: the chosen key, then the job id. Two jobs with the
  // same days open must never swap places between two requests, or page 2
  // repeats a row page 1 already showed.
  return (a, b) => {
    if (key === 'jobStatus') {
      const s = String(a.jobStatus).localeCompare(String(b.jobStatus), 'en', { sensitivity: 'base' });
      if (s !== 0) return sign * s;
    } else if (a[key] !== b[key]) {
      return sign * (a[key] - b[key]);
    }
    return b.jobId - a.jobId;
  };
}

/**
 * Section 11: the jobs behind any cell of the status × days-open matrix.
 *
 * `status` picks a row of that matrix ('all' = every status) and `bucket` a
 * column by its key ('all' = every band), so the list the tab shows when a
 * reader clicks a number is the same set that number counted — `total` below
 * is that cell, and it is checked against the matrix it came from.
 *
 * `q` is the search box: a Job ID or a job status, matched as a substring the
 * way the template matches it. It narrows the LIST but not `total`, which
 * stays the size of the cell, so "12 match" reads against a real denominator.
 */
async function getMtdJobs({ status, bucket, q, sortBy, sortDir, page, size, ...args } = {}) {
  const built = await buildMtdReportCached(args);
  const wantStatus = SA_STATUSES.includes(status) ? status : null;
  const wantBucket = SA_BUCKETS.some((b) => b.key === bucket) ? bucket : null;
  const bucketAt = wantBucket === null ? -1 : SA_BUCKETS.findIndex((b) => b.key === wantBucket);

  const inCell = built.jobs.filter((job) => (wantStatus === null || job.status === wantStatus)
    && (bucketAt < 0 || bucketIndex(SA_BUCKETS, job.daysOpen) === bucketAt));

  const needle = typeof q === 'string' ? q.trim().toLowerCase() : '';
  const matched = needle === ''
    ? inCell
    : inCell.filter((job) => String(job.jobId).includes(needle)
      || String(job.jobStatus).toLowerCase().includes(needle));

  // Copy before sorting: `built` is the shared cache entry.
  const sorted = matched.slice().sort(jobComparator(sortBy, sortDir));
  const pageSize = Math.min(Math.max(Number(size) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const pageNumber = Math.max(Number(page) || 1, 1);
  const start = (pageNumber - 1) * pageSize;

  return {
    window: built.window,
    scope: built.scope,
    cell: { status: wantStatus ?? 'all', bucket: wantBucket ?? 'all', total: inCell.length },
    query: needle === '' ? null : q.trim(),
    sort: {
      sortBy: JOB_SORT_KEYS.includes(sortBy) ? sortBy : 'daysOpen',
      sortDir: sortDir === 'asc' ? 'asc' : 'desc',
    },
    data: sorted.slice(start, start + pageSize),
    total: matched.length,
    pageNumber,
    pageSize,
    totalPages: Math.ceil(matched.length / pageSize),
    reconciled: built.reconciled,
    meta: built.meta,
  };
}

module.exports = {
  AGE_BUCKETS,
  SA_BUCKETS,
  SA_STATUSES,
  AVG_WINDOW,
  MAX_DAY_BUCKETS,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  JOB_SORT_KEYS,
  BLANK,
  BLANK_CITY,
  NO_REASON_PICKED,
  THEMES: themes.THEMES,
  defaultWindow: sources.defaultWindow,
  checkWindow: sources.checkWindow,
  buildMtdReport,
  getMtdReport,
  getMtdJobs,
  invalidateMtdReportCache,
};
