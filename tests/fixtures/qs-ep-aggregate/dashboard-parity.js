/*
 * Parity oracle for services/quicksight/employee-performance/aggregate.js.
 *
 * HOW. The Employee Performance dashboard's OWN inline <script>
 * (assets/quicksight/employee-performance/dashboard.html, unedited) runs in
 * node:vm against a fake DOM. Only presentation is intercepted, inside the vm
 * realm:
 *   Number.prototype.toFixed / toLocaleString → ⟦n:<String(value)>⟧
 *   Date.prototype.toLocaleDateString         → ⟦d:YYYY-MM-DD⟧
 * so money(), pct(), .toFixed() and fmt() print the exact double they were
 * handed (String(number) round-trips a double) instead of a rounded label.
 * names(), selectedDates(), aggregate(), every render block and the member
 * modal run as shipped.
 *
 * The API output is then formatted the way the page formats it (same esc(),
 * same markers) and compared cell by cell, row order included. Anything the
 * page shows that the API computes differently — a count, a sum taken in a
 * different order, a missing row, a different sort — is a mismatch.
 *
 * The DOM stub covers exactly what the script touches: getElementById (value,
 * innerHTML, add(), min/max, classList, hidden, onclick), querySelectorAll for
 * the team-member chips (rebuilt from the rendered team panel), and
 * addEventListener. `new Option` is a plain object.
 *
 * Used by tests/quicksight-ep-aggregate.test.js with the synthetic fixture, and
 * runnable by hand against a real data.js (never committed).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const agg = require('../../../services/quicksight/employee-performance/aggregate');

const TEMPLATE = path.join(__dirname, '..', '..', '..', 'assets', 'quicksight', 'employee-performance', 'dashboard.html');

/* ── the page, in a vm ───────────────────────────────────────────────────── */

function dashboardScript(htmlPath = TEMPLATE) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const m = html.match(/<script src="data\.js"><\/script>\s*<script>([\s\S]*?)<\/script><\/body>/);
  if (!m) throw new Error('dashboard inline script not found in ' + htmlPath);
  return m[1];
}

const unescapeHtml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'")
  .replace(/&amp;/g, '&');

function classList() {
  const set = new Set();
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toggle: (c, on) => { const want = on === undefined ? !set.has(c) : !!on; if (want) set.add(c); else set.delete(c); return want; },
  };
}

function element(id) {
  let html = '';
  const el = {
    id, value: '', min: '', max: '', hidden: false, onclick: null, onchange: null, options: [],
    classList: classList(),
    // A <select>: the first option added becomes the selected value.
    add(opt) { if (el.options.length === 0) el.value = opt.value; el.options.push(opt); },
    querySelectorAll: () => [],
    getAttribute: () => null,
  };
  Object.defineProperty(el, 'innerHTML', {
    get: () => html,
    set: (v) => { html = String(v); el.options = []; el.value = ''; },
  });
  return el;
}

/* dataScript: JavaScript that declares D — exactly what data.js holds. */
function loadDashboard(dataScript, { htmlPath } = {}) {
  const els = new Map();
  const byId = (id) => { if (!els.has(id)) els.set(id, element(id)); return els.get(id); };
  let chips = [];
  let chipsFor = null;
  const memberChips = () => {
    const panel = byId('teamPanel').innerHTML;
    if (panel !== chipsFor) {
      chipsFor = panel;
      chips = [...panel.matchAll(/data-member="([^"]*)"/g)].map((mm) => {
        const member = unescapeHtml(mm[1]);
        return { member, onclick: null, classList: classList(), getAttribute: (n) => (n === 'data-member' ? member : null) };
      });
    }
    return chips;
  };
  const document = {
    getElementById: byId,
    querySelectorAll: (sel) => (sel === '.team-member-btn' ? memberChips() : []),
    addEventListener: () => {},
  };
  const ctx = vm.createContext({ document, Option: function Option(text, value) { return { text, value }; } });
  vm.runInContext(`
    Number.prototype.toFixed = function () { return '\\u27E6n:' + String(Number(this)) + '\\u27E7'; };
    Number.prototype.toLocaleString = function () { return '\\u27E6n:' + String(Number(this)) + '\\u27E7'; };
    Date.prototype.toLocaleDateString = function () {
      const p = (v) => String(v).padStart(2, '0');
      return '\\u27E6d:' + this.getFullYear() + '-' + p(this.getMonth() + 1) + '-' + p(this.getDate()) + '\\u27E7';
    };
  `, ctx);
  vm.runInContext(dataScript, ctx, { filename: 'data.js' });
  vm.runInContext(dashboardScript(htmlPath), ctx, { filename: 'dashboard.html' });
  const run = (code) => vm.runInContext(code, ctx);

  return {
    // The page's select state; every value is an option value or 'ALL'.
    setFilters({ vertical = 'ALL', employee = 'ALL', zm = 'ALL', month = 'ALL', from = '', to = '' } = {}) {
      byId('vert').value = vertical;
      run('fillEmployees()');                          // what V.onchange does
      byId('emp').value = employee;
      byId('zman').value = zm;
      byId('month').value = month;
      run('monthDates()');                             // what M.onchange does
      byId('fromDate').value = from;
      byId('toDate').value = to;
    },
    setSort(key, col, dir, type) { run(`sortState[${JSON.stringify(key)}] = ${JSON.stringify({ col, dir, type })};`); },
    clearSort() { run('for (const k of Object.keys(sortState)) delete sortState[k];'); },
    render() { run('render()'); return pageSnapshot(byId); },
    chips: () => memberChips().map((c) => c.member),
    // Click one chip on a closed modal. null when the page ignores the click.
    clickMember(name) {
      const chip = memberChips().find((c) => c.member === name);
      if (!chip) throw new Error('no team-member chip for ' + name);
      memberChips().forEach((c) => c.classList.remove('active'));
      ['memberProductivityTitle', 'memberProductivityTable', 'memberRevenueTable'].forEach((id) => { byId(id).innerHTML = ''; });
      chip.onclick();
      return byId('memberRevenueTable').innerHTML ? memberSnapshot(byId) : null;
    },
    options: (id) => byId(id).options.map((o) => ({ value: o.value, text: o.text })),
    dateBounds: () => ({ min: byId('fromDate').min, max: byId('fromDate').max }),
  };
}

/* ── reading the rendered HTML ───────────────────────────────────────────── */

function parseTable(html) {
  const cols = [...html.matchAll(/<th[^>]*data-sc="([^"]*)"[^>]*>/g)].map((m) => m[1]);
  const body = (html.match(/<tbody>([\s\S]*?)<\/tbody>/) || [])[1] || '';
  const rows = [];
  for (const tr of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    if (/<td colspan=/.test(tr[1])) continue;            // the "No data" row
    rows.push([...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]));
  }
  return { cols, rows };
}

function pairs(html, re) {
  const out = {};
  for (const m of html.matchAll(re)) out[unescapeHtml(m[1])] = m[2];
  return out;
}

function pageSnapshot(byId) {
  const h = (id) => byId(id).innerHTML;
  const team = h('teamPanel');
  return {
    kpis: pairs(h('kpis'), /<div class="label">([^<]*)<\/div><div class="value">([^<]*)<\/div>/g),
    teamName: (team.match(/<div style="font-size:16px;font-weight:700;margin-top:5px">([^<]*)<\/div>/) || [])[1],
    teamChips: [...team.matchAll(/data-member="([^"]*)"[^>]*>([^<]*)<\/button>/g)].map((m) => [m[1], m[2]]),
    ojrKpis: pairs(h('ojrKpis'), /<div class="l">([^<]*)<\/div><div class="v">([^<]*)<\/div>/g),
    openJobRecord: parseTable(h('openJobRecord')),
    revtable: parseTable(h('revtable')),
    revProd: parseTable(h('revProd')),
    txpanel: parseTable(h('txpanel')),
    unassigned: (h('unassignedNote').match(/Unassigned Jobs: <b>([^<]*)<\/b>/) || [])[1],
    client: parseTable(h('client')),
    tat: parseTable(h('tat')),
    prodtable: parseTable(h('prodtable')),
    cityWise: parseTable(h('cityWise')),
    zmScope: (h('zmBreakdown').match(/Showing: ([^<]*)<\/div>/) || [])[1],
    zmBreakdown: parseTable(h('zmBreakdown')),
    jobchart: parseTable(h('jobchart')),
    weeklyJobs: pairs(h('weeklyjobs'), /<div class="mini">([^<]*)<b>([^<]*)<\/b><\/div>/g),
    weeklyRev: {
      width: (h('weeklyrev').match(/width:([^%]*)%/) || [])[1],
      ...pairs(h('weeklyrev'), /<span>([^<]*)<\/span><b>([^<]*)<\/b>/g),
    },
    summary: h('summary'),
    suggest: h('suggest'),
  };
}

function memberSnapshot(byId) {
  const rev = byId('memberRevenueTable').innerHTML;
  return {
    title: byId('memberProductivityTitle').innerHTML,
    productivity: parseTable(byId('memberProductivityTable').innerHTML),
    isLead: /Team-lead view/.test(rev),
    totals: pairs(rev, /<div class="mini">([^<]*)<b>([^<]*)<\/b><\/div>/g),
    revenue: parseTable(rev),
  };
}

/* ── the page's formatting, applied to API values ────────────────────────── */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
const mark = (v) => '⟦n:' + String(Number(v)) + '⟧';
const money = (n) => '₹' + mark(Number(n || 0));
const pct = (n) => mark(Number(n || 0)) + '%';
const fixed = (n) => mark(n);
const day = (d) => '⟦d:' + d + '⟧';
const raw = (v) => String(v);

const TABLES = {
  openJobRecord: {
    jobId: (x) => esc(x.jobId), vertical: (x) => esc(x.vertical), state: (x) => esc(x.state), city: (x) => esc(x.city),
    client: (x) => esc(x.client), aging: (x) => raw(Number(x.aging) || 0), pendingDueTo: (x) => esc(x.pendingDueTo),
    pendingReason: (x) => esc(x.pendingReason), pmoc: (x) => esc(x.pmoc),
  },
  revtable: {
    date: (x) => day(x.date), target: (x) => money(x.target), revenue: (x) => money(x.revenue),
    completed: (x) => raw(x.completed || 0), pct: (x) => pct(x.pct), due: (x) => money(x.due),
  },
  revProd: {
    date: (x) => day(x.date), working: (x) => fixed(x.working), productive: (x) => fixed(x.productive), positive: (x) => raw(x.positive),
  },
  txpanel: {
    txid: (x) => esc(x.txId || '—'), tx: (x) => esc(x.txName || '—'), total: (x) => raw(x.total), closed: (x) => raw(x.closed),
    open: (x) => raw(x.open), avgAging: (x) => (x.open ? fixed(Number(x.avgAging)) + ' days' : '0.0 days'),
  },
  client: {
    client: (x) => esc(x.client), total: (x) => raw(x.total), a02: (x) => raw(x.a02), a35: (x) => raw(x.a35), a68: (x) => raw(x.a68),
    a9: (x) => raw(x.a9), open: (x) => raw(x.open), completed: (x) => raw(x.completed), avg_age: (x) => fixed(Number(x.avg_age)),
  },
  tat: { client: (x) => esc(x.client), tat: (x) => pct(x.tat), sda: (x) => pct(x.sda) },
  prodtable: {
    date: (x) => day(x.date), working: (x) => fixed(x.working), productive: (x) => fixed(x.productive), pct: (x) => pct(x.pct),
    openJobs: (x) => raw(x.openJobs), closed: (x) => raw(x.closed), cancelled: (x) => raw(x.cancelled), positive: (x) => raw(x.positive),
    incoming: (x) => raw(x.incoming), outgoing: (x) => raw(x.outgoing), missed: (x) => raw(x.missed), missedPct: (x) => pct(x.missedPct),
  },
  cityWise: {
    city: (x) => esc(x.city), open: (x) => raw(x.open), a02: (x) => raw(x.a02), a35: (x) => raw(x.a35), a68: (x) => raw(x.a68),
    a9: (x) => raw(x.a9), avg_age: (x) => fixed(Number(x.avg_age)) + ' days',
  },
  zmBreakdown: { zonalManager: (x) => esc(x.zonalManager), open: (x) => raw(x.open), closed: (x) => raw(x.closed), revenue: (x) => money(x.revenue) },
  jobchart: {
    dueTo: (x) => esc(x.dueTo), reason: (x) => esc(x.reason), a02: (x) => raw(x.a02), a35: (x) => raw(x.a35), a68: (x) => raw(x.a68),
    a9: (x) => raw(x.a9), total: (x) => raw(x.total),
  },
  memberProductivity: {
    date: (x) => day(x.date), working: (x) => fixed(x.working), productive: (x) => fixed(x.productive), pct: (x) => pct(x.pct),
    openJobs: (x) => raw(x.openJobs), away: (x) => fixed(x.away), closed: (x) => raw(x.closed), cancelled: (x) => raw(x.cancelled),
    positive: (x) => raw(x.positive), incoming: (x) => raw(x.incoming), outgoing: (x) => raw(x.outgoing), missed: (x) => raw(x.missed),
    missedPct: (x) => pct(x.missedPct),
  },
  memberRevenue: {
    date: (x) => day(x.date), target: (x) => money(x.target), achieved: (x) => money(x.achieved), pct: (x) => pct(x.pct), due: (x) => money(x.due),
  },
};

/* ── comparison ──────────────────────────────────────────────────────────── */

function differ(out, where, what, page, api) {
  out.push(`${where} · ${what}: page=${JSON.stringify(page)} api=${JSON.stringify(api)}`);
}

function compareTable(out, where, name, spec, table, rows) {
  const cols = Object.keys(spec);
  if (JSON.stringify(table.cols) !== JSON.stringify(cols)) { differ(out, where, name + ' columns', table.cols, cols); return; }
  if (table.rows.length !== rows.length) { differ(out, where, name + ' row count', table.rows.length, rows.length); return; }
  table.rows.forEach((cells, i) => cols.forEach((c, j) => {
    const want = spec[c](rows[i]);
    if (cells[j] !== want) differ(out, where, `${name}[${i}].${c}`, cells[j], want);
  }));
}

function compareValue(out, where, what, page, api) {
  if (page !== api) differ(out, where, what, page, api);
}

// Every page of a server-paged list, concatenated.
function allPages(fn, D, filters, paging = {}) {
  const rows = [];
  let page = 1;
  for (;;) {
    const r = fn(D, filters, { ...paging, page, pageSize: agg.MAX_PAGE_SIZE });
    rows.push(...r.rows);
    if (page >= r.totalPages) return { rows, total: r.total };
    page++;
  }
}

const toApiFilters = ({ vertical = 'ALL', employee = 'ALL', zm = 'ALL', month = 'ALL', from = '', to = '' }) => ({
  verticals: vertical === 'ALL' ? [] : [vertical],
  employees: employee === 'ALL' ? [] : [employee],
  zm, month, from, to,
});

/* One page render vs buildSummary + the paged lists (+ each chip's modal). */
function compareRender(page, D, pageFilters, { members = true, out = [] } = {}) {
  const where = JSON.stringify(pageFilters);
  page.setFilters(pageFilters);
  const p = page.render();
  const f = toApiFilters(pageFilters);
  const s = agg.buildSummary(D, f);

  const k = s.kpis;
  const kpis = {
    'Total Revenue': money(k.revenue), 'Jobs Completed': raw(k.completed), 'Jobs Open': raw(k.open), 'Total Jobs': raw(k.total),
    'Completion Rate': pct(k.completionRate), 'Target Achieved': pct(k.targetAchieved), 'Team Members': raw(k.teamSize),
  };
  compareValue(out, where, 'kpis', JSON.stringify(p.kpis), JSON.stringify(kpis));

  compareValue(out, where, 'team name', p.teamName, esc(s.team.name));
  compareValue(out, where, 'team chips', JSON.stringify(p.teamChips), JSON.stringify(s.team.members.map((m) => [esc(m.key), esc(m.label)])));

  const oa = s.openAging;
  const ojr = { 'Open Jobs': raw(oa.total), '0–2 Days': raw(oa.d0_2), '3–5 Days': raw(oa.d3_5), '6–9 Days': raw(oa.d6_9), '>9 Days': raw(oa.d10p) };
  compareValue(out, where, 'open aging tiles', JSON.stringify(p.ojrKpis), JSON.stringify(ojr));

  const open = allPages(agg.pageOpenJobs, D, f);
  compareTable(out, where, 'openJobRecord', TABLES.openJobRecord, p.openJobRecord, open.rows);
  compareValue(out, where, 'open jobs total', oa.total, open.total);

  compareTable(out, where, 'revtable', TABLES.revtable, p.revtable, s.daily);
  compareTable(out, where, 'revProd', TABLES.revProd, p.revProd, s.productivity);
  compareTable(out, where, 'txpanel', TABLES.txpanel, p.txpanel, allPages(agg.pageTechnicians, D, f).rows);
  compareValue(out, where, 'unassigned', p.unassigned, raw(s.unassigned));
  compareTable(out, where, 'client', TABLES.client, p.client, s.clients);
  compareTable(out, where, 'tat', TABLES.tat, p.tat, s.tatSda);
  compareTable(out, where, 'prodtable', TABLES.prodtable, p.prodtable, s.productivity);
  compareTable(out, where, 'cityWise', TABLES.cityWise, p.cityWise, s.cityWise);
  compareValue(out, where, 'zonal scope', p.zmScope, esc(s.zonal.scope));
  compareTable(out, where, 'zmBreakdown', TABLES.zmBreakdown, p.zmBreakdown, s.zonal.rows);
  compareTable(out, where, 'jobchart', TABLES.jobchart, p.jobchart, s.pendingReasons);

  const perf = s.performance;
  compareValue(out, where, 'weekly jobs', JSON.stringify(p.weeklyJobs),
    JSON.stringify({ 'Total Jobs': raw(perf.totalJobs), Completed: raw(perf.completed), Open: raw(perf.open) }));
  compareValue(out, where, 'weekly revenue', JSON.stringify(p.weeklyRev),
    JSON.stringify({ width: raw(perf.revenueBarPct), Revenue: money(perf.revenue), Target: money(perf.target) }));

  const ss = s.shortSummary;
  compareValue(out, where, 'summary', p.summary, '<b>Selected period summary:</b> ' + ss.completed + ' jobs completed, ' + ss.open
    + ' open jobs and ' + money(ss.revenue) + ' revenue against ' + money(ss.target) + ' target. '
    + (ss.aged ? ss.aged + ' open jobs are aged 9+ days.' : 'No 9+ day open backlog.') + ' '
    + (ss.lowDays ? ss.lowDays + ' day(s) below 85% target.' : 'No reported day below 85% target.'));
  compareValue(out, where, 'suggestions', p.suggest,
    s.suggestions.map((x) => '<div class="s ' + x.tone + '"><b>' + x.title + '</b><br>' + x.text + '</div>').join(''));

  if (members) page.chips().forEach((name) => compareMember(page, D, f, name, where, out));
  return out;
}

function compareMember(page, D, apiFilters, name, where, out) {
  const at = `${where} member ${JSON.stringify(name)}`;
  const p = page.clickMember(name);
  const m = agg.memberDetail(D, apiFilters, name);
  if (p === null || m === null) { if (p !== m) differ(out, at, 'exists', p !== null, m !== null); return; }
  if (!p.title.startsWith('TEAM MEMBER — ' + esc(m.displayName))) differ(out, at, 'title', p.title, m.displayName);
  compareTable(out, at, 'productivity', TABLES.memberProductivity, p.productivity, m.productivity);
  compareValue(out, at, 'view', p.isLead ? 'team' : 'member', m.view);
  const t = m.revenue.totals;
  compareValue(out, at, 'revenue totals', JSON.stringify(p.totals), JSON.stringify({
    'Total Target': money(t.target), [m.view === 'team' ? 'Total Achieved' : 'Total Achieved (A&CO)']: money(t.achieved),
    'Achieved %': pct(t.pct), 'Total Shortfall': money(t.shortfall),
  }));
  compareTable(out, at, 'revenue', TABLES.memberRevenue, p.revenue, m.revenue.rows);
}

// Page sort state (a clicked header) vs the API's sortBy/sortDir, every key both ways.
const PAGE_COL = { txId: 'txid', txName: 'tx' };
function compareSorting(page, D, pageFilters, out = []) {
  const f = toApiFilters(pageFilters);
  page.setFilters(pageFilters);
  for (const [key, type] of Object.entries(agg.OPEN_JOB_SORT_KEYS)) {
    for (const dir of ['asc', 'desc']) {
      page.clearSort();
      page.setSort('ojr', key, dir, type);
      compareTable(out, `${JSON.stringify(pageFilters)} ojr sort ${key} ${dir}`, 'openJobRecord', TABLES.openJobRecord,
        page.render().openJobRecord, allPages(agg.pageOpenJobs, D, f, { sortBy: key, sortDir: dir }).rows);
    }
  }
  for (const [key, type] of Object.entries(agg.TECHNICIAN_SORT_KEYS)) {
    for (const dir of ['asc', 'desc']) {
      page.clearSort();
      page.setSort('tx', PAGE_COL[key] || key, dir, type);
      compareTable(out, `${JSON.stringify(pageFilters)} tx sort ${key} ${dir}`, 'txpanel', TABLES.txpanel,
        page.render().txpanel, allPages(agg.pageTechnicians, D, f, { sortBy: key, sortDir: dir }).rows);
    }
  }
  page.clearSort();
  return out;
}

// The page's selects (and fillEmployees / monthDates) vs buildOptions.
function compareOptions(page, D, out = []) {
  const o = agg.buildOptions(D);
  page.setFilters({});
  compareValue(out, 'options', 'verticals', JSON.stringify(page.options('vert').map((x) => x.value)), JSON.stringify(['ALL', ...o.verticals]));
  compareValue(out, 'options', 'zonal managers', JSON.stringify(page.options('zman').map((x) => x.value)), JSON.stringify(['ALL', ...o.zonalManagers]));
  compareValue(out, 'options', 'months', JSON.stringify(page.options('month').slice(1)), JSON.stringify(o.months.map((m) => ({ value: m.value, text: m.label }))));
  compareValue(out, 'options', 'all-month bounds', JSON.stringify(page.dateBounds()), JSON.stringify({ min: o.dateFrom, max: o.dateTo }));
  for (const vertical of ['ALL', ...o.verticals]) {
    page.setFilters({ vertical });
    const want = o.employees.filter((e) => vertical === 'ALL' || e.vertical === vertical).map((e) => e.value);
    compareValue(out, 'options ' + vertical, 'employees', JSON.stringify(page.options('emp').slice(1).map((x) => x.value)), JSON.stringify(want));
  }
  for (const m of o.months) {
    page.setFilters({ month: m.value });
    compareValue(out, 'options ' + m.value, 'bounds', JSON.stringify(page.dateBounds()), JSON.stringify({ min: m.from, max: m.to }));
  }
  return out;
}

module.exports = { loadDashboard, compareRender, compareSorting, compareOptions, toApiFilters };
