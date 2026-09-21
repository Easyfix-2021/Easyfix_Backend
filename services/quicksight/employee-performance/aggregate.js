/*
 * QuickSight — Employee Performance: the dashboard's aggregation, server-side.
 *
 * SOURCE OF TRUTH. The inline <script> of
 * assets/quicksight/employee-performance/dashboard.html (byte-identical to the
 * MIS original): names(), selectedDates(), aggregate(), monthTargetBase(), each
 * render* block and the team-member modal. Every function below is a PURE
 * port over the dashboard data object D (the `const D={...}` that
 * build_data.py writes, or the same shape composed from live data). No DB, no
 * I/O, no logger, no mutation of D.
 *
 * PARITY IS THE CONTRACT. tests/quicksight-ep-aggregate.test.js runs the
 * dashboard's own script in node:vm against a synthetic D and asserts these
 * functions return the same numbers, row order included. Additions keep the
 * same floating-point operation ORDER as the page (a sum taken in a different
 * order can differ in the last bit), so treat "tidying" a loop here as a
 * behaviour change and re-run that test.
 *
 * QUIRKS COPIED ON PURPOSE (numbers match the page; do not "fix" silently):
 *   - Zonal Manager fallback. A SPOC with no byZm[zm] block falls back to an
 *     empty block that has NO openRows key, so Object.assign keeps the SPOC's
 *     UNSLICED openRows: with a Zonal Manager selected, Jobs Open can be 0 while
 *     the Open Job Record (and its aging tiles) lists every open job.
 *   - teamSize is the uploaded per-SPOC length of teamMembers (duplicates
 *     included), so the Team Members KPI can exceed the de-duplicated chips.
 *   - Client Avg Age / City Avg Aging are unweighted means of per-SPOC means
 *     (closed-only client rows contribute avg_age 0).
 *   - Client aging buckets are 0-2 / 3-5 / 6-8 / 9+ (a9 = aging > 8) while the
 *     Open Job Record tiles are 0-2 / 3-5 / 6-9 / >9. The "aged" count in the
 *     summary and suggestions uses the CLIENT a9.
 *   - Clients, TAT/SDA, City and Pending tables and the open counts ignore the
 *     date filter (whole upload period / current snapshot).
 *   - Unassigned count follows Vertical (at SPOC level) and Employee, ignores
 *     Zonal Manager and dates. Technician rows filter Vertical on the ROW.
 *   - Member detail applies ONLY the month and date range, never Vertical,
 *     Zonal Manager or Employee.
 *
 * INTENTIONAL, PARITY-PRESERVING DIFFERENCES:
 *   - Filters are multi-select ({verticals[], employees[]}). An empty list, a
 *     list containing 'ALL', or a list of 2+ entries that covers every option
 *     (every D.verticals entry; every Employee option for the chosen
 *     verticals) is "Select All", because an explicit `in` check would drop
 *     rows whose vertical is not an option ('Easyfix' zonal/TX rows, 'Admin'
 *     team chips). A single option stays explicit: the page can select the
 *     only option as well as "Select All", and they differ.
 *   - Lookups keyed by user input (employee, zonal manager, member name) are
 *     own-property only, so '__proto__'/'constructor' cannot reach
 *     Object.prototype.
 *   - A txRow with no `dates` array (a cache may strip the identical copies)
 *     is treated as spanning D.dates.
 *   - Optional D.teamsByMonth (see teamPanel) lets the team panel and the Team
 *     Members KPI follow each selected month's roster. Absent → exactly the
 *     page's behaviour.
 *
 * Returned rows may be the very objects inside D (open-job rows, revPerf rows):
 * treat results as read-only, especially when D is a cached snapshot.
 */

'use strict';

const ALL = 'ALL';
// Daily target = monthly / 26, so a month's target = its daily target × 26.
const WORKING_DAYS_PER_MONTH = 26;
const PRODUCTIVE_HOURS_BASE = 9;
const LOW_DAY_RATIO = 0.85;

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

// Sortable columns of the two server-paged tables → the page's sort type.
const OPEN_JOB_SORT_KEYS = Object.freeze({
  jobId: 'str', vertical: 'str', state: 'str', city: 'str', client: 'str',
  aging: 'num', pendingDueTo: 'str', pendingReason: 'str', pmoc: 'str',
});
const TECHNICIAN_SORT_KEYS = Object.freeze({
  txId: 'str', txName: 'str', total: 'num', closed: 'num', open: 'num', avgAging: 'num',
});

const hasOwn = (obj, key) => obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
const own = (obj, key) => (hasOwn(obj, key) ? obj[key] : undefined);
const list = (v) => (Array.isArray(v) ? v : []);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function stringList(v) {
  const raw = Array.isArray(v) ? v : (v === undefined || v === null || v === '' ? [] : [v]);
  return [...new Set(raw.filter((x) => typeof x === 'string' && x !== ''))];
}

/* ── filters ──────────────────────────────────────────────────────────────── */

/*
 * {verticals[], zm, employees[], month, from, to} → the page's select state:
 *   verticalSet / employeeSet: null means "Select All".
 */
function normaliseFilters(D, filters) {
  const f = isPlainObject(filters) ? filters : {};
  const employees = D.employees || {};

  const verticals = stringList(f.verticals);
  const options = list(D.verticals);
  const verticalAll = verticals.length === 0
    || verticals.includes(ALL)
    || (options.length > 1 && options.every((v) => verticals.includes(v)));
  const verticalSet = verticalAll ? null : new Set(verticals);

  // The Employee options fillEmployees() would show for this vertical choice.
  const employeeOptions = list(D.primarySpocs).filter((n) => {
    const e = own(employees, n);
    return e && (verticalSet === null || verticalSet.has(e.vertical));
  });
  const picked = stringList(f.employees);
  const employeeAll = picked.length === 0
    || picked.includes(ALL)
    || (employeeOptions.length > 1 && employeeOptions.every((n) => picked.includes(n)));
  const employeeSet = employeeAll ? null : new Set(picked);

  const str = (v) => (typeof v === 'string' ? v : '');
  const zm = str(f.zm) || ALL;
  const month = str(f.month) || ALL;
  return { verticalSet, employeeSet, zm, month, from: str(f.from), to: str(f.to) };
}

const verticalOk = (nf, vertical) => nf.verticalSet === null || nf.verticalSet.has(vertical);
const employeeOk = (nf, name) => nf.employeeSet === null || nf.employeeSet.has(name);

// selectedDates(): ordered like D.dates.
function selectedDateList(D, nf) {
  const from = nf.from || '0000-00-00';
  const to = nf.to || '9999-99-99';
  let ds = list(D.dates).filter((x) => x >= from && x <= to);
  if (nf.month !== ALL) ds = ds.filter((x) => x.slice(0, 7) === nf.month);
  return ds;
}

// names(): the selected primary SPOCs, in D.primarySpocs order.
function selectedSpocs(D, nf) {
  const employees = D.employees || {};
  return list(D.primarySpocs).filter((n) => {
    const e = own(employees, n);
    return e && verticalOk(nf, e.vertical) && employeeOk(nf, n);
  });
}

/* ── aggregation ──────────────────────────────────────────────────────────── */

function monthTargetBase(arr) {
  const mx = {};
  list(arr).forEach((x) => {
    const m = (x.date || '').slice(0, 7);
    if (m) mx[m] = Math.max(mx[m] || 0, x.target || 0);
  });
  return Object.values(mx).reduce((s, v) => s + v * WORKING_DAYS_PER_MONTH, 0);
}

// The Zonal Manager slice of one SPOC — including the page's fallback, which
// has no openRows key (see QUIRKS in the header).
function sliceForZm(eAll, zm) {
  if (zm === ALL) return eAll;
  return Object.assign({}, eAll, own(eAll.byZm, zm)
    || { daily: [], clients: [], tatSda: [], cityWise: [], pendingReasons: [], revenue: 0, open: 0 });
}

function aggregate(D, nf, ns, ds) {
  const employees = D.employees || {};
  const zm = nf.zm;
  // Team Members KPI and the team panel live in teamPanel().
  const a = { open: 0, daily: {}, clients: {}, tat: {}, prod: {}, city: {}, zonal: {}, pending: {} };

  ns.forEach((n) => {
    const eAll = own(employees, n);
    const e = sliceForZm(eAll, zm);
    a.open += e.open || 0;
    list(e.daily).forEach((x) => {
      if (!ds.has(x.date)) return;
      if (!a.daily[x.date]) a.daily[x.date] = { date: x.date, target: 0, revenue: 0, completed: 0 };
      const z = a.daily[x.date];
      z.target += x.target || 0; z.revenue += x.revenue || 0; z.completed += x.completed || 0;
    });
    list(e.clients).forEach((x) => {
      if (!hasOwn(a.clients, x.client)) a.clients[x.client] = { client: x.client, total: 0, completed: 0, open: 0, a02: 0, a35: 0, a68: 0, a9: 0, age: 0, n: 0 };
      const z = a.clients[x.client];
      z.total += x.total; z.completed += x.completed; z.open += x.open;
      z.a02 += x.a02; z.a35 += x.a35; z.a68 += x.a68; z.a9 += x.a9;
      z.age += x.avg_age; z.n++;
    });
    list(e.tatSda).forEach((x) => {
      if (!hasOwn(a.tat, x.client)) a.tat[x.client] = { client: x.client, t: 0, s: 0, n: 0 };
      const z = a.tat[x.client];
      z.t += x.tat; z.s += x.sda; z.n++;
    });
    // Productivity is person-based: always the unsliced employee.
    list(e.productivity).forEach((x) => {
      if (!ds.has(x.date)) return;
      if (!a.prod[x.date]) a.prod[x.date] = { date: x.date, working: 0, productive: 0, away: 0, closed: 0, cancelled: 0, positive: 0, openJobs: 0, incoming: 0, outgoing: 0, missed: 0, eng: 0, n: 0 };
      const z = a.prod[x.date];
      ['working', 'productive', 'away', 'closed', 'cancelled', 'positive', 'openJobs', 'incoming', 'outgoing', 'missed']
        .forEach((k) => { z[k] += x[k] || 0; });
      z.eng += x.avgEng || 0; z.n++;
    });
    list(e.cityWise).forEach((x) => {
      if (!hasOwn(a.city, x.city)) a.city[x.city] = { city: x.city, open: 0, a02: 0, a35: 0, a68: 0, a9: 0, age: 0, n: 0 };
      const z = a.city[x.city];
      z.open += x.open; z.a02 += x.a02 || 0; z.a35 += x.a35 || 0; z.a68 += x.a68 || 0; z.a9 += x.a9 || 0;
      z.age += x.avg_age; z.n++;
    });
    list(e.pendingReasons).forEach((x) => {
      // The page separates the two with U+0001 (an invisible byte in its source).
      const k = x.dueTo + '\u0001' + x.reason;
      if (!hasOwn(a.pending, k)) a.pending[k] = { dueTo: x.dueTo, reason: x.reason, a02: 0, a35: 0, a68: 0, a9: 0, total: 0 };
      const z = a.pending[k];
      z.a02 += x.a02 || 0; z.a35 += x.a35 || 0; z.a68 += x.a68 || 0; z.a9 += x.a9 || 0; z.total += x.total || 0;
    });
  });

  // Zonal breakdown: Employee (not SPOC vertical), ROW vertical, dates and zm.
  // Closed/revenue rows are dated; open rows carry date null and always count.
  list(D.primarySpocs)
    .filter((n) => own(employees, n) && employeeOk(nf, n))
    .forEach((n) => {
      list(own(employees, n).zonal).forEach((x) => {
        if (x.date && !ds.has(x.date)) return;
        if (!verticalOk(nf, x.vertical)) return;
        if (zm !== ALL && x.zm !== zm) return;
        if (!hasOwn(a.zonal, x.zm)) a.zonal[x.zm] = { zonalManager: x.zm, open: 0, closed: 0, revenue: 0 };
        const z = a.zonal[x.zm];
        z.open += x.open || 0; z.closed += x.closed || 0; z.revenue += x.revenue || 0;
      });
    });

  const daily = Object.values(a.daily).sort((x, y) => x.date.localeCompare(y.date));
  return {
    open: a.open,
    daily,
    completed: daily.reduce((s, x) => s + (x.completed || 0), 0),
    clients: Object.values(a.clients).map((x) => ({
      client: x.client, total: x.total, completed: x.completed, open: x.open,
      a02: x.a02, a35: x.a35, a68: x.a68, a9: x.a9, avg_age: x.n ? x.age / x.n : 0,
    })),
    tatSda: Object.values(a.tat).map((x) => ({ client: x.client, tat: x.n ? x.t / x.n : 0, sda: x.n ? x.s / x.n : 0 })),
    productivity: Object.values(a.prod).sort((x, y) => x.date.localeCompare(y.date)).map((x) => ({
      date: x.date, working: x.working, productive: x.productive, away: x.away,
      closed: x.closed, cancelled: x.cancelled, positive: x.positive, openJobs: x.openJobs,
      incoming: x.incoming, outgoing: x.outgoing, missed: x.missed,
      pct: x.productive / PRODUCTIVE_HOURS_BASE * 100,
      avgEng: x.n ? x.eng / x.n : 0,
      missedPct: (x.incoming + x.outgoing) ? x.missed / (x.incoming + x.outgoing) * 100 : 0,
    })),
    cityWise: Object.values(a.city).map((x) => ({
      city: x.city, open: x.open, a02: x.a02, a35: x.a35, a68: x.a68, a9: x.a9, avg_age: x.n ? x.age / x.n : 0,
    })),
    pendingReasons: Object.values(a.pending).sort((x, y) => y.total - x.total),
    zonal: Object.values(a.zonal),
  };
}

// d.openRows — the same Zonal Manager slice (and fallback) as aggregate().
function collectOpenRows(D, nf, ns) {
  const rows = [];
  ns.forEach((n) => list(sliceForZm(own(D.employees, n), nf.zm).openRows).forEach((x) => rows.push(x)));
  return rows;
}

function openAging(rows) {
  const b = { total: 0, d0_2: 0, d3_5: 0, d6_9: 0, d10p: 0 };
  rows.forEach((x) => {
    const ag = Number(x.aging) || 0;
    b.total++;
    if (ag <= 2) b.d0_2++;
    else if (ag <= 5) b.d3_5++;
    else if (ag <= 9) b.d6_9++;
    else b.d10p++;
  });
  return b;
}

/* ── team panel ───────────────────────────────────────────────────────────── */

/*
 * Default (no D.teamsByMonth): the page exactly — each SPOC's uploaded `team`,
 * members from D.teamMembers[team] (or just the SPOC), de-duplicated, filtered
 * to the selected verticals (people not in D.employees always pass), sorted;
 * Team Members KPI = sum of each SPOC's uploaded teamSize.
 *
 * Month-aware (owner decision: every day uses THAT month's roster team), when
 * D.teamsByMonth = { 'YYYY-MM': { team: {crmName: teamName},
 * teamMembers: {teamName: [crmName…]} } } is present: the months are those of
 * the selected dates (the latest D.months entry when no date is selected); a
 * SPOC's teams and members are the union over those months; the KPI adds, per
 * SPOC, the number of DISTINCT people on its team(s) in those months.
 */
function teamPanel(D, nf, ns, dates) {
  const employees = D.employees || {};
  const members = [];
  const teamNames = [];
  let teamSize = 0;

  if (isPlainObject(D.teamsByMonth)) {
    let months = [...new Set(dates.map((x) => x.slice(0, 7)))];
    if (months.length === 0 && list(D.months).length) months = [list(D.months)[list(D.months).length - 1]];
    ns.forEach((n) => {
      const mine = new Set();
      months.forEach((m) => {
        const roster = own(D.teamsByMonth, m) || {};
        const team = own(roster.team, n);
        if (team) teamNames.push(team);
        const listed = team ? own(roster.teamMembers, team) : undefined;
        list(listed).forEach((x) => mine.add(x));
        (Array.isArray(listed) ? listed : [n]).forEach((x) => members.push(x));
      });
      teamSize += mine.size;
    });
  } else {
    ns.forEach((n) => {
      const e = own(employees, n);
      teamSize += e.teamSize || 0;
      if (e.team) teamNames.push(e.team);
      (own(D.teamMembers, e.team) || [n]).forEach((x) => members.push(x));
    });
  }

  const uniqueTeams = [...new Set(teamNames)];
  const mem = [...new Set(members)]
    .filter((x) => {
      const e = own(employees, x);
      return nf.verticalSet === null || !e || nf.verticalSet.has(e.vertical);
    })
    .sort();
  const displayNames = D.displayNames || {};
  return {
    teamSize,
    team: {
      name: uniqueTeams.length === 1 ? uniqueTeams[0] : 'All Teams',
      teams: uniqueTeams,
      members: mem.map((x) => ({ key: x, label: own(displayNames, x) || x })),
    },
  };
}

/* ── sorting and paging ───────────────────────────────────────────────────── */

// sortRows(): strings by localeCompare of String(v ?? ''), numbers by Number(v) || 0.
function sortBy(rows, col, dir, type) {
  const asc = dir === 'asc';
  return rows.slice().sort((a, b) => {
    let va = a[col];
    let vb = b[col];
    if (type === 'str') {
      va = String(va ?? ''); vb = String(vb ?? '');
      return asc ? va.localeCompare(vb) : vb.localeCompare(va);
    }
    va = Number(va) || 0; vb = Number(vb) || 0;
    return asc ? va - vb : vb - va;
  });
}

function toPositiveInt(v, fallback) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// A whitelisted sort, or the default order. The page's first click on a
// header sorts descending, so that is the default direction.
function applySort(rows, options, sortKeys) {
  const o = isPlainObject(options) ? options : {};
  const sortKey = typeof o.sortBy === 'string' && hasOwn(sortKeys, o.sortBy) ? o.sortBy : null;
  const sortDir = o.sortDir === 'asc' ? 'asc' : 'desc';
  return {
    rows: sortKey ? sortBy(rows, sortKey, sortDir, sortKeys[sortKey]) : rows,
    sortBy: sortKey,
    sortDir: sortKey ? sortDir : null,
  };
}

function pageOf(sorted, paging) {
  const p = isPlainObject(paging) ? paging : {};
  const page = toPositiveInt(p.page, 1);
  const pageSize = Math.min(toPositiveInt(p.pageSize, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const start = (page - 1) * pageSize;
  return {
    rows: sorted.rows.slice(start, start + pageSize),
    total: sorted.rows.length,
    page,
    pageSize,
    totalPages: Math.ceil(sorted.rows.length / pageSize),
    sortBy: sorted.sortBy,
    sortDir: sorted.sortDir,
  };
}

/* ── public API ───────────────────────────────────────────────────────────── */

/*
 * Filter options: the page's Vertical / Zonal Manager / Month selects and the
 * Employee list (callers narrow employees by `vertical`, as fillEmployees()
 * does). The page labels Employee options with the raw CRM name; `label` adds
 * the display name when it differs so a label-only search finds either.
 */
function buildOptions(D) {
  const dates = list(D.dates);
  const displayNames = D.displayNames || {};
  const employees = D.employees || {};
  return {
    dateFrom: dates.length ? dates[0] : null,
    dateTo: dates.length ? dates[dates.length - 1] : null,
    verticals: list(D.verticals).slice(),
    zonalManagers: list(D.zonalManagers).slice(),
    months: list(D.months).map((m) => {
      const inMonth = dates.filter((x) => x.slice(0, 7) === m);
      return {
        value: m,
        label: new Date(m + '-01T00:00:00').toLocaleString('en-US', { month: 'long', year: 'numeric' }),
        from: inMonth.length ? inMonth[0] : null,
        to: inMonth.length ? inMonth[inMonth.length - 1] : null,
      };
    }),
    employees: list(D.primarySpocs).slice().sort()
      .filter((n) => own(employees, n))
      .map((n) => {
        const displayName = own(displayNames, n) || n;
        return {
          value: n,
          label: displayName === n ? n : displayName + ' (' + n + ')',
          displayName,
          vertical: own(employees, n).vertical ?? null,
        };
      }),
  };
}

function buildSummary(D, filters) {
  const nf = normaliseFilters(D, filters);
  const dates = selectedDateList(D, nf);
  const ds = new Set(dates);
  const ns = selectedSpocs(D, nf);
  const d = aggregate(D, nf, ns, ds);
  const { teamSize, team } = teamPanel(D, nf, ns, dates);

  const target = monthTargetBase(d.daily);
  const revenue = d.daily.reduce((s, x) => s + x.revenue, 0);
  const total = d.completed + d.open;
  const achievedPct = target ? revenue / target * 100 : 0;

  const unassigned = ns.reduce((s, n) => s + list(D.unassigned)
    .filter((u) => u.spoc === n)
    .reduce((acc, u) => acc + Number(u.count || 0), 0), 0);

  const aged = d.clients.reduce((s, x) => s + x.a9, 0);
  const lowDays = d.daily.filter((x) => x.target && x.revenue / x.target < LOW_DAY_RATIO).length;
  const onlyVerticals = nf.verticalSet === null ? null : [...nf.verticalSet];

  return {
    dates: { from: dates.length ? dates[0] : null, to: dates.length ? dates[dates.length - 1] : null, count: dates.length },
    kpis: {
      revenue,
      target,
      completed: d.completed,
      open: d.open,
      total,
      completionRate: total ? d.completed / total * 100 : 0,
      targetAchieved: achievedPct,
      teamSize,
    },
    team,
    daily: d.daily.map((x) => ({
      date: x.date, target: x.target, revenue: x.revenue, completed: x.completed,
      pct: x.target ? x.revenue / x.target * 100 : 0,
      due: Math.max(x.target - x.revenue, 0),
    })),
    productivity: d.productivity,
    openAging: openAging(collectOpenRows(D, nf, ns)),
    clients: d.clients,
    pendingReasons: d.pendingReasons,
    cityWise: d.cityWise,
    tatSda: d.tatSda,
    zonal: {
      scope: onlyVerticals === null ? 'all verticals' : onlyVerticals.join(', '),
      rows: d.zonal.slice().sort((a, b) => b.revenue - a.revenue),
    },
    unassigned,
    performance: {
      totalJobs: total,
      completed: d.completed,
      open: d.open,
      revenue,
      target,
      revenueBarPct: Math.min(100, achievedPct),
    },
    shortSummary: { completed: d.completed, open: d.open, revenue, target, aged, lowDays },
    suggestions: [
      { key: 'ageing', title: 'Ageing', tone: aged ? 'crit' : 'pos', text: aged ? aged + ' open jobs need priority closure.' : 'No 9+ day backlog.' },
      { key: 'revenue', title: 'Revenue', tone: lowDays ? 'att' : 'pos', text: lowDays ? lowDays + ' day(s) below 85% target.' : 'Daily target performance is healthy.' },
      { key: 'filters', title: 'Filters', tone: 'pos', text: 'Use Employee, Month and date range to drill down.' },
    ],
  };
}

// Open Job Record, every row (e.g. for an XLSX sheet). Default order is SPOC
// order, then each SPOC's row order. `sort` = {sortBy, sortDir}.
function listOpenJobs(D, filters, sort) {
  const nf = normaliseFilters(D, filters);
  return applySort(collectOpenRows(D, nf, selectedSpocs(D, nf)), sort, OPEN_JOB_SORT_KEYS).rows;
}

// paging = {page (1-based), pageSize (≤ MAX_PAGE_SIZE), sortBy, sortDir}.
function pageOpenJobs(D, filters, paging) {
  const nf = normaliseFilters(D, filters);
  return pageOf(applySort(collectOpenRows(D, nf, selectedSpocs(D, nf)), paging, OPEN_JOB_SORT_KEYS), paging);
}

// Current TX Performance: rows filtered on their own vertical/spoc/zm and on
// having any selected date, re-grouped by (spoc, tx, txid) in first-seen order.
function technicianGroups(D, filters) {
  const nf = normaliseFilters(D, filters);
  const ds = new Set(selectedDateList(D, nf));
  const allDates = list(D.dates);
  const groups = new Map();
  list(D.txRows)
    .filter((x) => verticalOk(nf, x.vertical) && employeeOk(nf, x.spoc) && (nf.zm === ALL || x.zm === nf.zm))
    .filter((x) => (Array.isArray(x.dates) ? x.dates : allDates).some((z) => ds.has(z)))
    .forEach((x) => {
      const k = x.spoc + '|' + x.tx + '|' + x.txid;
      if (!groups.has(k)) groups.set(k, { spoc: x.spoc, tx: x.tx, txid: x.txid, vertical: x.vertical, total: 0, closed: 0, open: 0, ageSum: 0 });
      const g = groups.get(k);
      g.total += x.total || 0; g.closed += x.closed || 0; g.open += x.open || 0; g.ageSum += x.ageSum || 0;
    });
  return [...groups.values()].map((g) => ({
    txId: g.txid,
    txName: g.tx,
    spoc: g.spoc,
    vertical: g.vertical,
    total: g.total,
    closed: g.closed,
    open: g.open,
    avgAging: g.open ? g.ageSum / g.open : 0,
  }));
}

// Every technician row (e.g. for an XLSX sheet). `sort` = {sortBy, sortDir}.
function listTechnicians(D, filters, sort) {
  return applySort(technicianGroups(D, filters), sort, TECHNICIAN_SORT_KEYS).rows;
}

function pageTechnicians(D, filters, paging) {
  return pageOf(applySort(technicianGroups(D, filters), paging, TECHNICIAN_SORT_KEYS), paging);
}

/*
 * Team-member modal. Only month / from / to apply. Team leads (revView 'team',
 * or a primary SPOC when revView is absent) get their team's daily target vs
 * revenue; members get their personal target vs A&CO achieved. Rows keep the
 * uploaded order. Returns null for a name that is not in D.employees.
 */
function memberDetail(D, filters, name) {
  const e = typeof name === 'string' ? own(D.employees, name) : undefined;
  if (!e) return null;
  const nf = normaliseFilters(D, filters);
  const ds = new Set(selectedDateList(D, nf));

  const productivity = list(e.productivity).filter((x) => ds.has(x.date)).map((x) => ({
    ...x,
    openJobs: x.openJobs || 0,
    missedPct: x.missedPct || (x.incoming + x.outgoing ? x.missed / (x.incoming + x.outgoing) * 100 : 0),
  }));

  const isLead = e.revView ? e.revView === 'team' : list(D.primarySpocs).includes(name);
  const source = isLead
    ? list(e.daily).map((x) => ({
      date: x.date, target: x.target, achieved: x.revenue,
      pct: x.target ? x.revenue / x.target * 100 : 0,
      due: Math.max(0, x.target - x.revenue),
    }))
    : list(e.revPerf);
  const rows = source.filter((x) => ds.has(x.date));
  const target = monthTargetBase(rows);
  const achieved = rows.reduce((s, x) => s + (x.achieved || 0), 0);

  return {
    key: name,
    displayName: own(D.displayNames, name) || name,
    view: isLead ? 'team' : 'member',
    productivity,
    revenue: {
      rows,
      totals: { target, achieved, pct: target ? achieved / target * 100 : 0, shortfall: Math.max(0, target - achieved) },
    },
  };
}

module.exports = {
  buildOptions,
  buildSummary,
  pageOpenJobs,
  listOpenJobs,
  pageTechnicians,
  listTechnicians,
  memberDetail,
  OPEN_JOB_SORT_KEYS,
  TECHNICIAN_SORT_KEYS,
  MAX_PAGE_SIZE,
};
