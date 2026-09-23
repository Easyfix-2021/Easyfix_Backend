/*
 * QuickSight — Employee Performance: compose(), the JavaScript port of
 * build_data.py:build().
 *
 * build_data.py (MIS, off-platform) turns one raw workbook into `const D=...`,
 * the object the dashboard renders. compose() builds the SAME object — keys,
 * nesting, ordering, rounding — from NORMALISED inputs, so the data can come
 * from anywhere: live jobs from the DB, uploaded TimeChamp/IVR days, monthly
 * roster and target uploads, or (for parity) the old workbook itself through
 * fromWorkbookSheets() below.
 *
 * ─── PURE ────────────────────────────────────────────────────────────────────
 *
 * No DB, no I/O, no logger, no clock. Every date comes from the inputs, so the
 * same inputs always give the same D. The inputs are never mutated. The result
 * SHARES arrays between employees the way build_data.py shared its blocks (a
 * team member's `daily`/`clients`/… are the lead's arrays, every txRow's
 * `dates` is D.dates): treat the result as read-only, or JSON round-trip it.
 *
 * ─── THE NORMALISED INPUT SHAPE (what a DB adapter must produce) ─────────────
 *
 * Person fields (`spoc`, `aco`, `key`) already hold the EMPLOYEE KEY: the
 * string D.employees is keyed by. Resolving users to keys (user_id, aliases,
 * the frozen SPOC of a closed job) happens before compose(). Blank values may
 * be passed as null; compose applies build_data.py's blank rules.
 *
 *   inputs = {
 *     window?:   { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
 *                Inclusive calendar for D.dates. When omitted it is derived as
 *                build_data.py did: min..max over closedRows, timechamp, crm
 *                and ivr dates. When given, closed rows dated outside it are
 *                ignored.
 *     employees: [{ key, display, vertical, teams }]
 *                The roster. key: employee key (blank rows are skipped).
 *                display: EMPLOYE NAME for D.displayNames. vertical: own
 *                vertical or null (null/'' = take the team lead's).
 *                teams: { 'YYYY-MM': 'Team name' } — the person is ON THAT
 *                MONTH'S ROSTER when the month is a key ('' = no team).
 *                Row order is kept; a repeated key: last row wins, first
 *                position kept (legacy mode also repeats it in teamMembers).
 *     targets: {
 *       spocs:    [key]                      names on the primary target list
 *       daily:    { key: { 'YYYY-MM': n } }  primary SPOC daily target
 *       monthly:  { key: { 'YYYY-MM': n } }  primary SPOC Target Amount (perMonth)
 *       total:    { key: n }                 sum of Target Amount (legacy)
 *       personal: { key: { 'YYYY-MM': n } }  secondary target / 26 per day
 *     }
 *     openRows:   [{ jobId, vertical, state, city, client, aging, dueTo,
 *                    reason, zm, tx, txid, spoc }]
 *     closedRows: [{ spoc, charge, margin, date, client, tat, sda, zm,
 *                    vertical, tx, txid, aco }]
 *                 date: 'YYYY-MM-DD' checkout day or null. margin/tat/sda:
 *                 number or null (null is skipped by the means). charge and
 *                 aging: null = 0. Blank state/city/dueTo/reason = em dash,
 *                 blank zm = 'Unassigned', other blanks = ''.
 *     timechamp:  [{ key, date, working, productive, away }]  first row per
 *                 (key, date) is used
 *     crm:        [{ key, date, booked, scheduled, audit, closed, cancelled }]
 *                 summed per (key, date)
 *     ivr:        [{ key, date, incoming, outgoing, missed, aht }]  counts
 *                 summed, aht averaged per (key, date)
 *   }
 *
 * ROW ORDER MATTERS where build_data.py was order-dependent: clients, tatSda,
 * cityWise and zonal rows appear in first-seen order, and a txRow's vertical is
 * the LAST order seen. Feed rows in a stable, documented order (the workbook's
 * was checkout DESC for closed jobs).
 *
 * ─── TEAM MODES (options.teamMode) ──────────────────────────────────────────
 *
 * 'legacy'   exact build_data.py: employee.team is the EARLIEST month's team,
 *            D.teamMembers comes from the LATEST month's team, a member
 *            inherits the lead of their earliest-month team for the whole
 *            window. Kept for the golden parity test — including that script's
 *            six-key daily row, so the closed-job split columns below
 *            (CLOSED_SPLIT_FIELD) are perMonth's, not legacy's.
 * 'perMonth' (default; owner decision 5) every date uses THAT month's roster:
 *            - a team's lead in month M is the primary SPOC on M's roster in
 *              that team with the largest Target Amount for M (ties: name);
 *            - a non-SPOC member's block is built from each month's lead's
 *              closed jobs in that month, that lead's daily target on those
 *              dates, and the open jobs of their latest team's lead;
 *            - employee.team / teamSize / D.teamMembers use each person's
 *              latest roster month in the window, so they always agree;
 *            - a blank team is no team: it has no lead, no members list and
 *              teamSize 0 (legacy grouped blanks under the '' team);
 *            - owner decision 4: in a month someone is NOT on the roster their
 *              productivity, revPerf, targets and SPOC jobs are hidden (zero
 *              rows), and people on no roster month in the window are left out;
 *            - owner decision 6: a month is rostered ONLY by its own emp
 *              detail. A window month with no roster rows at all (not uploaded
 *              yet) has nobody on it — it inherits no earlier month — so every
 *              one of its jobs is on no PERSON's block. Those rows are not
 *              dropped: they land on the Unattributed BUCKET rows below, which
 *              are ordinary D.employees entries, so they keep counting.
 *
 * ─── THE UNATTRIBUTED BUCKET (perMonth only) ────────────────────────────────
 *
 * A row whose `spoc` is the literal 'Unattributed' (what sources.resolvePeople
 * writes when the job's SPOC is on no emp detail the window shows) belongs to
 * NOBODY, but its jobs and rupees are still the company's. Hiding a person must
 * never hide their work, so those rows get their own block(s) in D.employees
 * and their own entries in D.primarySpocs — one per JOB VERTICAL, keyed
 * unattributedKey(vertical) ('Unattributed' for a blank vertical, otherwise
 * 'Unattributed — <vertical>'). They are buckets, not people:
 *   - every filter the dashboard already has (vertical at SPOC level, zonal
 *     manager through byZm, month and date range through `daily`) narrows them
 *     exactly as it narrows a person, which is WHY they are split by vertical:
 *     one lump row would be dropped whole by any explicit vertical choice, and
 *     a bucket per vertical makes the verticals partition the totals again;
 *   - they carry NO productivity and NO revPerf (TimeChamp / CRM / IVR belong
 *     to named people), no team, teamSize 0 and no target, so they cannot move
 *     a per-person average or a target;
 *   - they are left out of D.verticals (the Vertical select is the roster's
 *     verticals, not the jobs'), and aggregate.js leaves them out of the team
 *     panel, the Team Members KPI, the Employee options and member detail.
 * D.displayNames labels every bucket 'Unattributed', and so does the `pmoc`
 * written on its open rows, so nothing shows the synthetic key to a user.
 *
 * ─── NUMERIC FIDELITY ───────────────────────────────────────────────────────
 *
 * The golden test compares floats, so each aggregate uses the summation its
 * pandas/Python original used, not a generic reduce:
 *   Series.sum()/mean()          numpy pairwise summation      (npSum/npMean)
 *   groupby(...).sum()/mean()    pandas' Kahan compensated sum (kahan*)
 *   Python sum() / `+=` loops    plain left-to-right addition
 *   round(x, 4)                  Python's exact half-even rounding (pyRound)
 * and sorted() order is Unicode code-point order, not UTF-16 unit order.
 */

'use strict';

const { shiftYmd } = require('../../../utils/ist-calendar');

const TEAM_MODES = Object.freeze(['legacy', 'perMonth']);
const DASH = '\u2014';
const UNASSIGNED = 'Unassigned';

/*
 * The Unattributed bucket (see the header). UNATTRIBUTED is the exact string
 * sources.resolvePeople writes on a row it could not attribute; the per-vertical
 * bucket keys hang off it with an em dash, a separator no CRM name carries.
 * The string never occurs in the old MIS data, so keying on it cannot change
 * what the golden fixture or the legacy mode produce.
 */
const UNATTRIBUTED = 'Unattributed';
const UNATTRIBUTED_SEP = ` ${DASH} `;
const unattributedKey = (vertical) => (vertical === '' ? UNATTRIBUTED : UNATTRIBUTED + UNATTRIBUTED_SEP + vertical);
/** Is this D.employees / D.primarySpocs entry a bucket rather than a person? */
const isUnattributedKey = (name) => typeof name === 'string'
  && (name === UNATTRIBUTED || name.startsWith(UNATTRIBUTED + UNATTRIBUTED_SEP));

const PRODUCTIVE_HOURS_BASE = 9;      // productivity % = productive hours / 9
const WORKING_DAYS_PER_MONTH = 26;    // secondary daily target = monthly / 26
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ═══ 1. Numeric fidelity helpers ═══════════════════════════════════════════ */

/**
 * numpy float64 add.reduce (what pandas Series.sum() calls): pairwise
 * summation with 8 unrolled accumulators, blocks of 128. Mirrors
 * numpy/_core/src/umath/loops_utils.h.src @TYPE@_pairwise_sum.
 */
function pairwiseSum(a, lo, n) {
  if (n < 8) {
    let res = -0;
    for (let i = 0; i < n; i += 1) res += a[lo + i];
    return res;
  }
  if (n <= 128) {
    const r = [a[lo], a[lo + 1], a[lo + 2], a[lo + 3], a[lo + 4], a[lo + 5], a[lo + 6], a[lo + 7]];
    let i = 8;
    for (; i < n - (n % 8); i += 8) {
      r[0] += a[lo + i];
      r[1] += a[lo + i + 1];
      r[2] += a[lo + i + 2];
      r[3] += a[lo + i + 3];
      r[4] += a[lo + i + 4];
      r[5] += a[lo + i + 5];
      r[6] += a[lo + i + 6];
      r[7] += a[lo + i + 7];
    }
    let res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
    for (; i < n; i += 1) res += a[lo + i];
    return res;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return pairwiseSum(a, lo, n2) + pairwiseSum(a, lo + n2, n - n2);
}

const NPY_BUFSIZE = 8192;

/**
 * pandas Series.sum() on float64: NaN counts as 0; the reduction runs over
 * numpy's 8192-element buffers, each summed pairwise (measured, numpy 2.0).
 */
function npSum(values) {
  const a = values.map((v) => (Number.isNaN(v) ? 0 : v));
  let acc = 0;
  for (let lo = 0; lo < a.length; lo += NPY_BUFSIZE) acc += pairwiseSum(a, lo, Math.min(NPY_BUFSIZE, a.length - lo));
  return acc;
}

/** pandas Series.mean(): pairwise sum (NaN as 0) / count of non-NaN; NaN if none. */
function npMean(values) {
  let count = 0;
  for (const v of values) if (!Number.isNaN(v)) count += 1;
  return count > 0 ? npSum(values) / count : NaN;
}

/** pandas groupby sum/mean accumulator (_libs/groupby.pyx Kahan summation). */
function kahanNew() {
  return { sum: 0, comp: 0, n: 0 };
}
function kahanAdd(k, val) {
  if (Number.isNaN(val)) return;
  k.n += 1;
  const y = val - k.comp;
  const t = k.sum + y;
  k.comp = t - k.sum - y;
  if (Number.isNaN(k.comp)) k.comp = 0;
  k.sum = t;
}
const kahanMean = (k) => (k.n > 0 ? k.sum / k.n : NaN);

/** Python 3.9 sum() over floats: plain left-to-right addition from 0. */
function naiveSum(values) {
  let s = 0;
  for (const v of values) s += v;
  return s;
}

/** Python round(x, ndigits): exact decimal value of the double, half-even. */
function pyRound(x, ndigits) {
  if (!Number.isFinite(x) || x === 0) return x;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const negative = hi >>> 31 === 1;
  const biased = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let exp;
  if (biased === 0) {
    exp = -1074;
  } else {
    mant |= 1n << 52n;
    exp = biased - 1075;
  }
  let num = mant * 10n ** BigInt(ndigits);
  let den = 1n;
  if (exp >= 0) num <<= BigInt(exp);
  else den <<= BigInt(-exp);
  let q = num / den;
  const twice = 2n * (num - q * den);
  if (twice > den || (twice === den && (q & 1n) === 1n)) q += 1n;
  const out = Number(`${q.toString()}e-${ndigits}`);
  return negative ? -out : out;
}

const pctOrZero = (num, den) => (den ? (num / den) * 100 : 0);
const fnum = (v) => (Number.isNaN(v) ? 0 : v);
const pyInt = (v) => Math.trunc(v) + 0;   // int(float): toward zero, never -0

/** Python str ordering: Unicode code points (JS `<` compares UTF-16 units). */
function cmpCodePoints(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x !== y) {
      const xs = x >= 0xd800 && x <= 0xdfff;
      const ys = y >= 0xd800 && y <= 0xdfff;
      if (xs !== ys && (xs ? y >= 0xe000 : x >= 0xe000)) return xs ? 1 : -1;
      return x < y ? -1 : 1;
    }
  }
  return a.length - b.length;
}
const sortedStrings = (iterable) => [...new Set(iterable)].sort(cmpCodePoints);

/* ═══ 2. Small structural helpers ═══════════════════════════════════════════ */

const own = (obj, k) => obj != null && Object.prototype.hasOwnProperty.call(obj, k);
const groupKey = (...parts) => JSON.stringify(parts);

function mapGetOrSet(map, key, make) {
  let v = map.get(key);
  if (v === undefined) {
    v = make();
    map.set(key, v);
  }
  return v;
}

/** { key: { month: n } } (plain object or Map) -> Map<key, Map<month, n>> */
function nestedMap(src) {
  const out = new Map();
  if (src == null) return out;
  const entries = src instanceof Map ? src.entries() : Object.entries(src);
  for (const [k, inner] of entries) {
    if (inner == null) continue;
    const innerEntries = inner instanceof Map ? inner.entries() : Object.entries(inner);
    out.set(k, new Map([...innerEntries].map(([m, v]) => [m, toNumber(v, 0)])));
  }
  return out;
}

function flatMap(src) {
  const out = new Map();
  if (src == null) return out;
  const entries = src instanceof Map ? src.entries() : Object.entries(src);
  for (const [k, v] of entries) out.set(k, toNumber(v, 0));
  return out;
}

/** null/undefined/'' -> fallback; NaN stays NaN only when fallback is NaN. */
function toNumber(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isNaN(n) ? fallback : n;
}

const toText = (v, fallback) => (v === null || v === undefined ? fallback : String(v));

/** A real calendar 'YYYY-MM-DD' (V8 would silently roll 2026-02-30 into March). */
function isYmd(s) {
  if (typeof s !== 'string' || !YMD_RE.test(s)) return false;
  try {
    return shiftYmd(s, 0) === s;
  } catch {
    return false;
  }
}

/** obj[k] = v as an own data property, even for k === '__proto__'. */
function setOwn(obj, k, v) {
  Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
}

function dateRange(from, to) {
  const out = [];
  for (let d = from; d <= to; d = shiftYmd(d, 1)) out.push(d);
  return out;
}

/* ═══ 3. Input normalisation ════════════════════════════════════════════════ */

function normaliseOpen(r) {
  return {
    jobId: toText(r.jobId, ''),
    vertical: toText(r.vertical, ''),
    state: toText(r.state, DASH),
    city: toText(r.city, DASH),
    client: toText(r.client, ''),
    aging: toNumber(r.aging, 0),
    dueTo: toText(r.dueTo, DASH),
    reason: toText(r.reason, DASH),
    zm: toText(r.zm, UNASSIGNED),
    tx: toText(r.tx, ''),
    txid: toText(r.txid, ''),
    spoc: toText(r.spoc, ''),
  };
}

function normaliseClosed(r) {
  return {
    spoc: toText(r.spoc, ''),
    charge: toNumber(r.charge, 0),
    margin: toNumber(r.margin, NaN),
    date: r.date === undefined || r.date === '' ? null : r.date,
    client: toText(r.client, ''),
    tat: toNumber(r.tat, NaN),
    sda: toNumber(r.sda, NaN),
    zm: toText(r.zm, UNASSIGNED),
    vertical: toText(r.vertical, ''),
    tx: toText(r.tx, ''),
    txid: toText(r.txid, ''),
    aco: toText(r.aco, ''),
  };
}

function normaliseEmployee(r) {
  const teams = new Map();
  const src = r.teams instanceof Map ? [...r.teams.entries()] : Object.entries(r.teams || {});
  for (const [m, t] of src) teams.set(m, toText(t, ''));
  const vertical = r.vertical === null || r.vertical === undefined || r.vertical === ''
    ? null : String(r.vertical);
  return { key: toText(r.key, ''), display: toText(r.display, ''), vertical, teams };
}

function arrayInput(inputs, name) {
  const v = inputs[name];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new TypeError(`compose: inputs.${name} must be an array`);
  return v;
}

/**
 * Every dated input must carry a real 'YYYY-MM-DD' (closed rows may be null):
 * a Date object or '2026-9-1' from an adapter would otherwise be silently
 * unmatched. The window is inputs.window, or min..max of those dates.
 */
function resolveWindow(inputs, closedRows) {
  let from = null;
  let to = null;
  const checked = new Set();
  const see = (d, where, nullable) => {
    if (d === null || d === undefined) {
      if (nullable) return;
      throw new TypeError(`compose: ${where} needs a date`);
    }
    if (!checked.has(d)) {
      if (!isYmd(d)) throw new TypeError(`compose: ${where} date ${JSON.stringify(d)} is not YYYY-MM-DD`);
      checked.add(d);
    }
    if (from === null || d < from) from = d;
    if (to === null || d > to) to = d;
  };
  for (const r of closedRows) see(r.date, 'closedRows', true);
  for (const name of ['timechamp', 'crm', 'ivr']) for (const r of arrayInput(inputs, name)) see(r.date, name, false);
  if (inputs.window) {
    const w = inputs.window;
    if (!isYmd(w.from) || !isYmd(w.to) || w.from > w.to) {
      throw new TypeError('compose: inputs.window needs from <= to as YYYY-MM-DD');
    }
    return { from: w.from, to: w.to };
  }
  if (from === null) throw new Error('compose: no usable dates in the inputs');
  return { from, to };
}

/* ═══ 4. Order blocks ═══════════════════════════════════════════════════════ */

const BYZM_KEYS = ['revenue', 'completed', 'open', 'daily', 'clients', 'tatSda', 'cityWise',
  'pendingReasons', 'openRows'];

function bucket(z, ag) {
  if (ag <= 2) z.a02 += 1;
  else if (ag <= 5) z.a35 += 1;
  else if (ag <= 8) z.a68 += 1;
  else z.a9 += 1;
}

/*
 * ─── THE CLOSED-JOB SPLIT (daily rows: compOem / compRet / compRel) ─────────
 *
 * The current MIS dashboard's Daily Revenue table counts a day's closed jobs in
 * three columns beside the revenue — "Closed Jobs — OEM (Furniture, Sports)",
 * "Closed Jobs — Retail Maintenance", "Closed Jobs — Relocation" — so each
 * daily row carries them next to `completed`.
 *
 * MATCHING. The vertical is compared exactly as every other vertical in this
 * file is (the Unattributed buckets, zmBreakdown, the zonal rows): the string
 * the row already carries, which reaches compose() trimmed on both paths —
 * sval() strips it out of the workbook, sources.service.js trims the live job's
 * Vertical Name. There is deliberately no second, looser rule here (no
 * lower-casing, no fuzzy match): a vertical spelled differently upstream is a
 * data problem to fix upstream, not one to paper over in two places.
 *
 * THE THREE DO NOT PARTITION `completed`. A closed job in any other vertical
 * (Easyfix, Amazon, Admin, IT, HR, oprations …) counts in `completed` and in
 * none of the three, so completed >= compOem + compRet + compRel, and the gap
 * is real work, not a rounding artefact. That is the dashboard's own behaviour;
 * anything reading these columns must not treat them as a breakdown of a total.
 */
const CLOSED_SPLIT_FIELD = new Map([
  ['Furniture', 'compOem'],
  ['Sports', 'compOem'],
  ['Retail Maintenance', 'compRet'],
  ['Relocation', 'compRel'],
]);
// Key order is the dashboard's column order, and the daily row's.
const newSplit = () => ({ compOem: 0, compRet: 0, compRel: 0 });
const ZERO_SPLIT = Object.freeze(newSplit());

/**
 * build_data.py order_block() over explicit row sets. `c`/`o` are the closed
 * and open rows of the block in feed order, `targetFor(date)` the daily target,
 * `pmoc` the name written on openRows. `opts.zonal` adds the zonal/margin/zms
 * keys a top-level block carries; `opts.splits` adds the three closed-job
 * columns of the current dashboard to every daily row (see CLOSED_SPLIT_FIELD).
 */
function buildBlock(c, o, targetFor, pmoc, dates, opts) {
  const withZonal = opts.zonal;
  const withSplits = opts.splits;
  const b = {};
  b.revenue = npSum(c.map((r) => r.charge));
  b.completed = c.length;
  b.open = o.length;

  const revByDate = new Map();
  const splitByDate = new Map();
  for (const r of c) {
    if (r.date === null) continue;
    kahanAdd(mapGetOrSet(revByDate, r.date, kahanNew), r.charge);
    if (!withSplits) continue;
    const field = CLOSED_SPLIT_FIELD.get(r.vertical);
    if (field !== undefined) mapGetOrSet(splitByDate, r.date, newSplit)[field] += 1;
  }
  b.daily = dates.map((d) => {
    const t = targetFor(d);
    const agg = revByDate.get(d);
    const rv = agg ? agg.sum : 0;
    const row = { date: d, target: t, revenue: rv, pct: pctOrZero(rv, t), due: Math.max(t - rv, 0),
      completed: agg ? agg.n : 0 };
    if (!withSplits) return row;
    const s = splitByDate.get(d) || ZERO_SPLIT;
    return { ...row, compOem: s.compOem, compRet: s.compRet, compRel: s.compRel };
  });

  const clients = new Map();
  const newClient = (client) => ({ client, total: 0, completed: 0, open: 0, a02: 0, a35: 0, a68: 0, a9: 0, ages: [] });
  for (const r of c) {
    const z = mapGetOrSet(clients, r.client, () => newClient(r.client));
    z.total += 1;
    z.completed += 1;
  }
  for (const r of o) {
    const z = mapGetOrSet(clients, r.client, () => newClient(r.client));
    z.total += 1;
    z.open += 1;
    z.ages.push(r.aging);
    bucket(z, r.aging);
  }
  b.clients = [...clients.values()].map((z) => ({
    client: z.client, total: z.total, completed: z.completed, open: z.open,
    a02: z.a02, a35: z.a35, a68: z.a68, a9: z.a9,
    avg_age: z.ages.length ? pyRound(naiveSum(z.ages) / z.ages.length, 4) : 0,
  }));

  const ts = new Map();
  for (const r of c) {
    const z = mapGetOrSet(ts, r.client, () => ({ tat: kahanNew(), sda: kahanNew() }));
    kahanAdd(z.tat, r.tat);
    kahanAdd(z.sda, r.sda);
  }
  b.tatSda = [...ts.entries()].map(([client, z]) => ({
    client,
    tat: pyRound(fnum(kahanMean(z.tat)) * 100, 4),
    sda: pyRound(fnum(kahanMean(z.sda)) * 100, 4),
  }));

  const cities = new Map();
  for (const r of o) {
    if (r.city === DASH) continue;
    const z = mapGetOrSet(cities, r.city, () => ({ city: r.city, open: 0, a02: 0, a35: 0, a68: 0, a9: 0, ages: [] }));
    z.open += 1;
    z.ages.push(r.aging);
    bucket(z, r.aging);
  }
  b.cityWise = [...cities.values()].map((z) => ({
    city: z.city, open: z.open, a02: z.a02, a35: z.a35, a68: z.a68, a9: z.a9,
    avg_age: z.ages.length ? pyRound(naiveSum(z.ages) / z.ages.length, 4) : 0,
  }));

  const pend = new Map();
  for (const r of o) {
    const z = mapGetOrSet(pend, groupKey(r.dueTo, r.reason),
      () => ({ dueTo: r.dueTo, reason: r.reason, a02: 0, a35: 0, a68: 0, a9: 0, total: 0 }));
    z.total += 1;
    bucket(z, r.aging);
  }
  b.pendingReasons = [...pend.values()].sort((x, y) => y.total - x.total);

  b.openRows = o.map((r) => ({
    jobId: r.jobId, vertical: r.vertical, state: r.state, city: r.city, client: r.client,
    aging: r.aging, pendingDueTo: r.dueTo, pendingReason: r.reason, pmoc,
  }));

  if (withZonal) {
    const zon = [];
    const g = new Map();
    for (const r of c) {
      if (r.date === null) continue;
      const z = mapGetOrSet(g, groupKey(r.zm, r.vertical, r.date),
        () => ({ zm: r.zm, vertical: r.vertical, date: r.date, n: 0, revenue: kahanNew() }));
      z.n += 1;
      kahanAdd(z.revenue, r.charge);
    }
    for (const z of g.values()) {
      zon.push({ zm: z.zm, vertical: z.vertical, date: z.date, open: 0, closed: z.n, revenue: z.revenue.sum });
    }
    const g2 = new Map();
    for (const r of o) {
      const z = mapGetOrSet(g2, groupKey(r.zm, r.vertical), () => ({ zm: r.zm, vertical: r.vertical, n: 0 }));
      z.n += 1;
    }
    for (const z of g2.values()) {
      zon.push({ zm: z.zm, vertical: z.vertical, date: null, open: z.n, closed: 0, revenue: 0 });
    }
    b.zonal = zon;
    b.margin = fnum(npMean(c.map((r) => r.margin)));
    b.zms = sortedStrings([...o.map((r) => r.zm), ...c.map((r) => r.zm)]);
  }
  return b;
}

function pickByZm(block) {
  const out = {};
  for (const k of BYZM_KEYS) out[k] = block[k];
  return out;
}

/* ═══ 5. compose() ══════════════════════════════════════════════════════════ */

/**
 * @param {object} inputs  normalised inputs (see the header)
 * @param {{teamMode?: 'legacy'|'perMonth'}} [options]
 * @returns {object} D — the object build_data.py writes as `const D=`
 */
function compose(inputs, options = {}) {
  if (inputs === null || typeof inputs !== 'object') throw new TypeError('compose: inputs must be an object');
  const teamMode = options.teamMode === undefined ? 'perMonth' : options.teamMode;
  if (!TEAM_MODES.includes(teamMode)) {
    throw new TypeError(`compose: options.teamMode must be one of ${TEAM_MODES.join(', ')}`);
  }
  if (!Array.isArray(inputs.employees)) throw new TypeError('compose: inputs.employees must be an array');

  const closedAll = arrayInput(inputs, 'closedRows').map(normaliseClosed);
  const openRows = arrayInput(inputs, 'openRows').map(normaliseOpen);
  const { from, to } = resolveWindow(inputs, closedAll);
  const dates = dateRange(from, to);
  const dateSet = new Set(dates);
  const months = sortedStrings(dates.map((d) => d.slice(0, 7)));
  const lastMonth = months[months.length - 1];
  const closedRows = closedAll.filter((r) => r.date === null || dateSet.has(r.date));

  const targets = inputs.targets || {};
  const T = {
    spocs: (targets.spocs || []).map((s) => toText(s, '')),
    daily: nestedMap(targets.daily),
    monthly: nestedMap(targets.monthly),
    total: flatMap(targets.total),
    personal: nestedMap(targets.personal),
  };

  // Per-person daily series (TimeChamp first row, CRM sums, IVR sums/mean, A&CO revenue).
  const tcIdx = new Map();
  for (const r of arrayInput(inputs, 'timechamp')) {
    const byDate = mapGetOrSet(tcIdx, toText(r.key, ''), () => new Map());
    if (!byDate.has(r.date)) byDate.set(r.date, r);
  }
  const crmIdx = new Map();
  for (const r of arrayInput(inputs, 'crm')) {
    const byDate = mapGetOrSet(crmIdx, toText(r.key, ''), () => new Map());
    const z = mapGetOrSet(byDate, r.date, () => ({
      booked: kahanNew(), scheduled: kahanNew(), audit: kahanNew(), closed: kahanNew(), cancelled: kahanNew(),
    }));
    for (const f of ['booked', 'scheduled', 'audit', 'closed', 'cancelled']) kahanAdd(z[f], toNumber(r[f], 0));
  }
  const ivrIdx = new Map();
  for (const r of arrayInput(inputs, 'ivr')) {
    const byDate = mapGetOrSet(ivrIdx, toText(r.key, ''), () => new Map());
    const z = mapGetOrSet(byDate, r.date, () => ({
      incoming: kahanNew(), outgoing: kahanNew(), missed: kahanNew(), aht: kahanNew(),
    }));
    for (const f of ['incoming', 'outgoing', 'missed', 'aht']) kahanAdd(z[f], toNumber(r[f], 0));
  }
  const acoIdx = new Map();
  for (const r of closedRows) {
    if (r.date === null) continue;
    kahanAdd(mapGetOrSet(mapGetOrSet(acoIdx, r.aco, () => new Map()), r.date, kahanNew), r.charge);
  }

  const closedBySpoc = new Map();
  for (const r of closedRows) mapGetOrSet(closedBySpoc, r.spoc, () => []).push(r);
  const openBySpoc = new Map();
  for (const r of openRows) mapGetOrSet(openBySpoc, r.spoc, () => []).push(r);

  const ctx = { dates, dateSet, months, lastMonth, closedRows, openRows, closedBySpoc, openBySpoc, T,
    tcIdx, crmIdx, ivrIdx, acoIdx };

  const rosterRows = inputs.employees.map(normaliseEmployee).filter((e) => e.key !== '');
  const built = teamMode === 'legacy' ? buildLegacy(ctx, rosterRows) : buildPerMonth(ctx, rosterRows);

  const txMap = new Map();
  for (const [rows, kind] of [[closedRows, 'closed'], [openRows, 'open']]) {
    for (const r of rows) {
      if (r.spoc === '' || r.txid === '') continue;
      const z = mapGetOrSet(txMap, groupKey(r.spoc, r.tx, r.txid, r.zm), () => ({
        spoc: r.spoc, tx: r.tx, vertical: r.vertical, zm: r.zm, total: 0, closed: 0, open: 0,
        ageSum: 0, dates, txid: r.txid,
      }));
      z.vertical = r.vertical;
      z.total += 1;
      if (kind === 'closed') {
        z.closed += 1;
      } else {
        z.open += 1;
        z.ageSum += r.aging;
      }
    }
  }

  const unassigned = built.primarySpocs.map((n) => ({
    spoc: n,
    date: dates[dates.length - 1],
    count: built.openRowsOf(n).filter((r) => r.tx === '').length,
  }));

  const zmb = new Map();
  for (const r of closedRows) {
    const z = mapGetOrSet(zmb, groupKey(r.vertical, r.zm),
      () => ({ vertical: r.vertical, zonalManager: r.zm, open: 0, closed: 0, revenue: 0 }));
    z.closed += 1;
    z.revenue += r.charge;
  }
  for (const r of openRows) {
    const z = mapGetOrSet(zmb, groupKey(r.vertical, r.zm),
      () => ({ vertical: r.vertical, zonalManager: r.zm, open: 0, closed: 0, revenue: 0 }));
    z.open += 1;
  }

  return {
    employees: Object.fromEntries(built.employees),
    // The Vertical select is the ROSTER's verticals: a bucket's vertical is a
    // job's, which may be one the emp detail never names ('Easyfix'), and an
    // option nobody can be filtered to would only widen the select.
    verticals: sortedStrings(built.primarySpocs.filter((n) => !isUnattributedKey(n))
      .map((n) => built.employees.get(n).vertical).filter(Boolean)),
    months,
    dates,
    primarySpocs: built.primarySpocs,
    zonalManagers: sortedStrings([...openRows.map((r) => r.zm), ...closedRows.map((r) => r.zm)]),
    teamMembers: Object.fromEntries(built.teamMembers),
    displayNames: Object.fromEntries(built.displayNames),
    txRows: [...txMap.values()],
    unassigned,
    zmBreakdown: [...zmb.values()],
  };
}

/* ── shared per-person series ─────────────────────────────────────────────── */

const ZERO_TC = { working: 0, productive: 0, away: 0 };

function productivityRows(ctx, key, visible) {
  const tcBy = ctx.tcIdx.get(key);
  const crmBy = ctx.crmIdx.get(key);
  const ivrBy = ctx.ivrIdx.get(key);
  return ctx.dates.map((d) => {
    const show = visible(d);
    const t = (show && tcBy && tcBy.get(d)) || null;
    const tc = t ? { working: toNumber(t.working, 0), productive: toNumber(t.productive, 0), away: toNumber(t.away, 0) } : ZERO_TC;
    const cr = show && crmBy ? crmBy.get(d) : undefined;
    const booked = cr ? cr.booked.sum : 0;
    const sched = cr ? cr.scheduled.sum : 0;
    const audit = cr ? cr.audit.sum : 0;
    const closed = cr ? cr.closed.sum : 0;
    const canc = cr ? cr.cancelled.sum : 0;
    const iv = show && ivrBy ? ivrBy.get(d) : undefined;
    const inc = iv ? iv.incoming.sum : 0;
    const out = iv ? iv.outgoing.sum : 0;
    const mis = iv ? iv.missed.sum : 0;
    const aht = iv ? kahanMean(iv.aht) : 0;
    const p = tc.productive;
    return {
      date: d, working: tc.working, productive: p, away: tc.away, pct: (p / PRODUCTIVE_HOURS_BASE) * 100,
      status: p >= 7.5 ? 'green' : (p < 7 ? 'red' : 'orange'),
      closed: pyInt(closed), cancelled: pyInt(canc), positive: pyInt(booked + sched + audit + closed),
      openJobs: pyInt(booked + sched + audit), incoming: inc, outgoing: out, missed: mis,
      missedPct: pctOrZero(mis, inc + out), avgEng: aht,
    };
  });
}

function revPerfRows(ctx, key, personalFor) {
  const acoBy = ctx.acoIdx.get(key);
  return ctx.dates.map((d) => {
    const t = personalFor(d);
    const k = acoBy ? acoBy.get(d) : undefined;
    const ach = t === null ? 0 : (k ? k.sum : 0);
    const tt = t === null ? 0 : t;
    return { date: d, target: tt, achieved: ach, pct: pctOrZero(ach, tt), due: Math.max(tt - ach, 0) };
  });
}

function assembleEmployee(fields) {
  const { team, teamSize, vertical, revView, blk, hasSrc, margin, targetBase, byZm, productivity, revPerf, zonal } = fields;
  return {
    team,
    teamSize,
    vertical,
    revView,
    revenue: blk.revenue,
    completed: blk.completed,
    open: blk.open,
    completionRate: pctOrZero(blk.completed, blk.completed + blk.open),
    margin: hasSrc ? margin : 0,
    targetAchieved: hasSrc ? pctOrZero(blk.revenue, targetBase) : 0,
    daily: blk.daily,
    clients: blk.clients,
    tatSda: blk.tatSda,
    cityWise: blk.cityWise,
    pendingReasons: blk.pendingReasons,
    openRows: blk.openRows,
    byZm,
    productivity,
    revPerf,
    zonal,
  };
}

/* ── legacy: exact build_data.py ──────────────────────────────────────────── */

function buildLegacy(ctx, rosterRows) {
  const { dates, T } = ctx;
  const meta = new Map();
  for (const e of rosterRows) {
    const monthKeys = [...e.teams.keys()].sort(cmpCodePoints);
    meta.set(e.key, {
      key: e.key,
      display: e.display,
      vertical: e.vertical,
      team: monthKeys.length ? e.teams.get(monthKeys[0]) : '',
      teamLast: monthKeys.length ? e.teams.get(monthKeys[monthKeys.length - 1]) : '',
    });
  }
  const displayNames = new Map([...meta.values()].map((m) => [m.key, m.display]));
  const teamMembers = new Map();
  for (const e of rosterRows) mapGetOrSet(teamMembers, meta.get(e.key).teamLast, () => []).push(e.key);

  const candidates = new Set(T.spocs.filter((n) => n !== ''));
  for (const r of ctx.openRows) candidates.add(r.spoc);
  for (const r of ctx.closedRows) if (r.spoc !== '') candidates.add(r.spoc);
  const primarySpocs = sortedStrings(candidates).filter((n) => meta.has(n));
  const spocSet = new Set(primarySpocs);

  const dailyFor = (name) => {
    const byMonth = T.daily.get(name);
    return (d) => (byMonth && byMonth.has(d.slice(0, 7)) ? byMonth.get(d.slice(0, 7)) : 0);
  };
  /*
   * splits: false throughout legacy mode. This mode exists for ONE reason — to
   * reproduce, byte for byte, the build_data.py the golden fixture was made
   * with (tests/quicksight-ep-compose.test.js), and THAT script's daily row had
   * six keys, not nine. Emitting compOem/compRet/compRel here would not make
   * the port more faithful, it would make it less. The live pipeline is
   * perMonth (live.service.js), and that is where the columns are built.
   * When the fixture is regenerated from the MIS script that writes these
   * columns, turn them on here in the same commit as the new fixture.
   */
  const orderBlock = (name, zm, withZonal) => {
    let c = ctx.closedBySpoc.get(name) || [];
    let o = ctx.openBySpoc.get(name) || [];
    if (zm !== null) {
      c = c.filter((r) => r.zm === zm);
      o = o.filter((r) => r.zm === zm);
    }
    return buildBlock(c, o, dailyFor(name), name, dates, { zonal: withZonal, splits: false });
  };

  const emptyBlock = buildBlock([], [], () => 0, '', dates, { zonal: false, splits: false });
  const spocBlocks = new Map(primarySpocs.map((n) => [n, orderBlock(n, null, true)]));
  const totalOf = (n) => (T.total.has(n) ? T.total.get(n) : 0);
  const leadOfTeam = new Map();
  for (const n of [...primarySpocs].sort((a, b) => (-totalOf(a) < -totalOf(b) ? -1 : (-totalOf(a) > -totalOf(b) ? 1 : 0)))) {
    const team = meta.get(n).team;
    if (!leadOfTeam.has(team)) leadOfTeam.set(team, n);
  }

  const byZmCache = new Map();
  const byZmOf = (srcName, blk) => mapGetOrSet(byZmCache, srcName, () => {
    const out = {};
    for (const zm of blk.zms) setOwn(out, zm, pickByZm(orderBlock(srcName, zm, false)));
    return out;
  });

  const employees = new Map();
  for (const [key, m] of meta) {
    const size = (teamMembers.get(m.team) || []).length;
    const isSpoc = spocSet.has(key);
    const lead = leadOfTeam.get(m.team);
    const srcName = isSpoc ? key : (lead || null);
    const src = srcName ? spocBlocks.get(srcName) : null;
    const blk = src || emptyBlock;
    const personal = T.personal.get(key);
    employees.set(key, assembleEmployee({
      team: m.team,
      teamSize: size,
      vertical: m.vertical || (srcName ? meta.get(srcName).vertical : null),
      revView: isSpoc && size > 0 ? 'team' : 'member',
      blk,
      hasSrc: Boolean(src),
      margin: src ? src.margin : 0,
      targetBase: totalOf(srcName),
      byZm: src ? byZmOf(srcName, src) : {},
      productivity: productivityRows(ctx, key, () => true),
      revPerf: revPerfRows(ctx, key, (d) => (personal && personal.has(d.slice(0, 7)) ? personal.get(d.slice(0, 7)) : 0)),
      zonal: isSpoc ? blk.zonal : [],
    }));
  }

  return {
    employees,
    primarySpocs,
    teamMembers,
    displayNames,
    openRowsOf: (n) => ctx.openBySpoc.get(n) || [],
  };
}

/* ── perMonth: each date uses that month's roster (owner decisions 4 and 5) ─ */

function buildPerMonth(ctx, rosterRows) {
  const { dates, months, lastMonth, T } = ctx;
  const monthOf = (d) => d.slice(0, 7);

  const meta = new Map();
  for (const e of rosterRows) meta.set(e.key, e);

  // A month's roster is that month's own, never an earlier one's: nobody is on
  // the roster of a month whose emp detail was not uploaded (owner decision 6).
  const onRoster = (key, M) => {
    const e = meta.get(key);
    return Boolean(e && e.teams.has(M));
  };
  const teamOn = (key, M) => meta.get(key).teams.get(M);

  const included = [...meta.keys()].filter((k) => months.some((M) => onRoster(k, M)));
  const includedSet = new Set(included);
  const latestMonthOf = (k) => months.filter((M) => onRoster(k, M)).pop();

  const displayNames = new Map(included.map((k) => [k, meta.get(k).display]));
  // A blank team is NO team: nobody shares it, leads it or inherits through it.
  const teamMembers = new Map();
  for (const k of included) {
    const team = teamOn(k, latestMonthOf(k));
    if (team !== '') mapGetOrSet(teamMembers, team, () => []).push(k);
  }

  const candidates = new Set(T.spocs.filter((n) => n !== ''));
  for (const r of ctx.openRows) candidates.add(r.spoc);
  for (const r of ctx.closedRows) candidates.add(r.spoc);
  const primarySpocs = sortedStrings(candidates).filter((n) => n !== '' && includedSet.has(n));
  const spocSet = new Set(primarySpocs);

  const monthVal = (map, key, M) => {
    const byMonth = map.get(key);
    return onRoster(key, M) && byMonth && byMonth.has(M) ? byMonth.get(M) : 0;
  };

  // Lead of each team, per window month.
  const leadIn = new Map();
  for (const M of months) {
    const leads = new Map();
    const ranked = primarySpocs.filter((n) => onRoster(n, M));
    ranked.sort((a, b) => {
      const ta = -monthVal(T.monthly, a, M);
      const tb = -monthVal(T.monthly, b, M);
      return ta < tb ? -1 : (ta > tb ? 1 : 0);
    });
    for (const n of ranked) {
      const team = teamOn(n, M);
      if (team !== '' && !leads.has(team)) leads.set(team, n);
    }
    leadIn.set(M, leads);
  }

  const closedMonth = (r) => (r.date === null ? lastMonth : monthOf(r.date));
  const spocOpen = (n) => (onRoster(n, lastMonth) ? ctx.openBySpoc.get(n) || [] : []);

  /**
   * One person's block. For a SPOC: their own jobs in the months they are on
   * the roster. For a member: month M's closed jobs of their month-M lead, and
   * the open jobs of their latest team's lead.
   */
  const sourcesOf = (key) => {
    if (spocSet.has(key)) {
      const byMonth = new Map(months.map((M) => [M, onRoster(key, M) ? key : null]));
      return { byMonth, openLead: onRoster(key, lastMonth) ? key : null, spoc: true };
    }
    const byMonth = new Map(months.map((M) => [M, onRoster(key, M) ? leadIn.get(M).get(teamOn(key, M)) || null : null]));
    const latest = latestMonthOf(key);
    return { byMonth, openLead: latest === lastMonth ? byMonth.get(lastMonth) : null, spoc: false };
  };

  // Members of one team share a source signature, so they share one block
  // (as build_data.py shared the lead's block).
  const blockCache = new Map();
  const blocksFor = (src) => mapGetOrSet(blockCache, groupKey([...src.byMonth.values()], src.openLead), () => {
    const leads = new Set([...src.byMonth.values()].filter(Boolean));
    const c = leads.size
      ? ctx.closedRows.filter((r) => leads.has(r.spoc) && src.byMonth.get(closedMonth(r)) === r.spoc)
      : [];
    const o = src.openLead ? spocOpen(src.openLead) : [];
    const targetFor = (d) => {
      const lead = src.byMonth.get(monthOf(d));
      return lead ? monthVal(T.daily, lead, monthOf(d)) : 0;
    };
    const pmoc = src.openLead || '';
    const block = buildBlock(c, o, targetFor, pmoc, dates, { zonal: true, splits: true });
    // The byZm slices carry the splits too: with a Zonal Manager selected the
    // dashboard reads this block's `daily` instead of the unsliced one, and
    // three columns of zeros there would be a lie, not a filter.
    const byZm = {};
    for (const zm of block.zms) {
      setOwn(byZm, zm, pickByZm(buildBlock(c.filter((r) => r.zm === zm), o.filter((r) => r.zm === zm),
        targetFor, pmoc, dates, { zonal: false, splits: true })));
    }
    return { block, byZm };
  });

  // Every perMonth daily row has the same nine keys, this one included, so a
  // table never meets an undefined column on the one employee with no source.
  const emptyBlock = buildBlock([], [], () => 0, '', dates, { zonal: false, splits: true });
  const employees = new Map();
  for (const key of included) {
    const e = meta.get(key);
    const latest = latestMonthOf(key);
    const team = teamOn(key, latest);
    const size = (teamMembers.get(team) || []).length;
    const src = sourcesOf(key);
    const hasSrc = [...src.byMonth.values()].some(Boolean) || Boolean(src.openLead);
    const built = hasSrc ? blocksFor(src) : null;
    const blk = built ? built.block : emptyBlock;
    const byZm = built ? built.byZm : {};
    let targetBase = 0;
    for (const M of months) {
      const lead = src.byMonth.get(M);
      if (lead) targetBase += monthVal(T.monthly, lead, M);
    }
    const verticalLead = src.spoc ? null : src.byMonth.get(latest);
    employees.set(key, assembleEmployee({
      team,
      teamSize: size,
      vertical: e.vertical || (verticalLead ? meta.get(verticalLead).vertical : null),
      revView: src.spoc && size > 0 ? 'team' : 'member',
      blk,
      hasSrc,
      margin: hasSrc ? blk.margin : 0,
      targetBase,
      byZm,
      productivity: productivityRows(ctx, key, (d) => onRoster(key, monthOf(d))),
      revPerf: revPerfRows(ctx, key, (d) => (onRoster(key, monthOf(d)) ? monthVal(T.personal, key, monthOf(d)) : null)),
      zonal: src.spoc ? blk.zonal : [],
    }));
  }

  /*
   * The Unattributed buckets (see the header). Every closed / open row
   * resolvePeople could not put on a visible person carries the literal
   * 'Unattributed' as its SPOC: an unrostered month's jobs, a hidden person's
   * jobs, a job whose SPOC is nobody's. They are the company's work all the
   * same, so each JOB VERTICAL gets a block built exactly the way a SPOC's is
   * — same buildBlock, same byZm slices — and joins D.primarySpocs, where the
   * dashboard's own filters reach it. What a bucket does NOT get is anything
   * that belongs to a person: no target (so no Daily Target row of theirs
   * moves and targetAchieved stays 0), no TimeChamp / CRM / IVR productivity,
   * no revPerf, no team.
   *
   * If a real person's CRM name IS 'Unattributed' the two are indistinguishable
   * upstream, and closedBySpoc has already put both sets of rows on that
   * person's block; building a bucket as well would count them twice.
   */
  const bucketKeys = [];
  const bucketOpen = new Map();
  if (!includedSet.has(UNATTRIBUTED)) {
    const unClosed = ctx.closedBySpoc.get(UNATTRIBUTED) || [];
    const unOpen = ctx.openBySpoc.get(UNATTRIBUTED) || [];
    for (const vertical of sortedStrings([...unClosed, ...unOpen].map((r) => r.vertical))) {
      const key = unattributedKey(vertical);
      const c = unClosed.filter((r) => r.vertical === vertical);
      const o = unOpen.filter((r) => r.vertical === vertical);
      // A bucket's jobs are the company's jobs: they count in the three closed
      // columns exactly as a person's do, or a day's OEM total would drop the
      // moment a SPOC stopped being on the roster.
      const blk = buildBlock(c, o, () => 0, UNATTRIBUTED, dates, { zonal: true, splits: true });
      const byZm = {};
      for (const zm of blk.zms) {
        setOwn(byZm, zm, pickByZm(buildBlock(c.filter((r) => r.zm === zm), o.filter((r) => r.zm === zm),
          () => 0, UNATTRIBUTED, dates, { zonal: false, splits: true })));
      }
      bucketKeys.push(key);
      bucketOpen.set(key, o);
      displayNames.set(key, UNATTRIBUTED);
      employees.set(key, assembleEmployee({
        team: '',
        teamSize: 0,
        // A blank job vertical is no vertical, written the way a person's is.
        vertical: vertical === '' ? null : vertical,
        revView: 'member',
        blk,
        hasSrc: true,
        margin: blk.margin,
        targetBase: 0,
        byZm,
        productivity: [],
        revPerf: [],
        zonal: blk.zonal,
      }));
    }
  }

  return {
    employees,
    // People first, in the page's order; the buckets after them, so a table
    // that reads D.primarySpocs top-down still starts with the real team.
    primarySpocs: [...primarySpocs, ...bucketKeys],
    teamMembers,
    displayNames,
    openRowsOf: (n) => (bucketOpen.has(n) ? bucketOpen.get(n) : spocOpen(n)),
  };
}

/* ═══ 6. fromWorkbookSheets(): build_data.py's own normalisation ════════════ */

/*
 * Input: the workbook as pandas.read_excel(sheet_name=None, dtype=object) sees
 * it, JSON-ised — `[{ name, columns: [header], rows: [[cell]] }]` (or
 * `{ sheets: [...] }`). Cells: null = blank/NaN; numbers as-is (an integral
 * JSON number is a Python int); `{ "$float": x }` = a Python float that is
 * integral or non-finite ('inf'/'-inf'); `{ "$dt": "YYYY-MM-DD HH:MM:SS" }` = a
 * datetime (its Python str()); `{ "$time": "HH:MM:SS" }` = a time; true/false.
 */

const REQUIRED = [
  ['Open order', ['Job Id', 'Vertical Name', 'State', 'City', 'Client', 'Aging', 'Pending Due To',
    'Pending Reason', 'Zonal Manager', 'Current TX Name', 'Current TX Id', 'Primary SPOC']],
  ['Close order', ['Primary SPOC', 'Total Charge', 'Margin(%)', 'Audit & Checkout Date', 'Client',
    'TAT Status', 'SDA Status', 'Zonal Manager', 'Vertical Name', 'Current TX Name', 'Current TX Id', 'A & CO by']],
  ['target list', ['Primary spoc', 'Target Amount', 'Daily Target', 'month']],
  ['emp detail', ['EMP ID', 'EMPLOYE NAME', 'CRM CURRENT NAME', 'Row Labels', 'vertical']],
  ['Secondary spoc target list', ['Name', 'Total Target', 'month']],
  ['time champ data', ['Employee Id', 'Employee Name', 'Working Hours', 'Productive Hours', 'Away Hours', 'Date']],
  ['crm data', ['employee id', 'Booked', 'Scheduled', 'Audit', 'Closed', 'Cancelled', 'Date']],
  ['ivr data record', ['Agent Name', 'Total Incoming Calls', 'Total Outgoing Calls', 'Total Missed Calls',
    'Avg Handling Time', 'Date']],
];

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september',
  'october', 'november', 'december'];

// Python's str.isspace() set, which `\s` and str.strip() use.
const PY_WS = '\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_WS_RUN = new RegExp(`[${PY_WS}]+`, 'g');
const PY_STRIP = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, 'g');
const pyStrip = (s) => s.replace(PY_STRIP, '');

const isTagged = (v, tag) => v !== null && typeof v === 'object' && own(v, tag);

function taggedFloat(v) {
  const x = v.$float;
  if (x === 'inf') return Infinity;
  if (x === '-inf') return -Infinity;
  if (x === 'nan') return NaN;
  return Number(x);
}

/** Python repr() of a float. */
function pyFloatRepr(x) {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const sign = x < 0 ? '-' : '';
  const [mant, expStr] = Math.abs(x).toExponential().split('e');
  const digits = mant.replace('.', '');
  const exp = Number(expStr);
  const decpt = exp + 1;
  if (decpt <= -4 || decpt > 16) {
    const frac = digits.length > 1 ? `.${digits.slice(1)}` : '';
    return `${sign}${digits[0]}${frac}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  if (decpt <= 0) return `${sign}0.${'0'.repeat(-decpt)}${digits}`;
  if (decpt >= digits.length) return `${sign}${digits}${'0'.repeat(decpt - digits.length)}.0`;
  return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
}

/** Python str(cell). A blank (NaN) cell is 'nan'. */
function pyStr(v) {
  if (v === null || v === undefined) return 'nan';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return Number.isInteger(v) ? BigInt(v).toString() : pyFloatRepr(v);
  if (isTagged(v, '$float')) return pyFloatRepr(taggedFloat(v));
  if (isTagged(v, '$dt')) return String(v.$dt);
  if (isTagged(v, '$time')) return String(v.$time);
  return String(v);
}

const isBlank = (v) => v === null || v === undefined || (isTagged(v, '$float') && Number.isNaN(taggedFloat(v)));
/** build_data.py norm(): collapse whitespace, strip, lower-case. */
const norm = (v) => pyStrip(pyStr(v).replace(PY_WS_RUN, ' ')).toLowerCase();
/** build_data.py sval(). */
const sval = (v, dflt = '') => (isBlank(v) ? dflt : pyStrip(pyStr(v)));
/** build_data.py sval_raw(). */
const svalRaw = (v) => (isBlank(v) ? '' : pyStr(v));

/** Python float(str): undefined where Python raises ValueError. */
function pyFloatParse(s) {
  const t = pyStrip(s);
  const special = /^([+-]?)(inf|infinity|nan)$/i.exec(t);
  if (special) {
    if (special[2].toLowerCase() === 'nan') return NaN;
    return special[1] === '-' ? -Infinity : Infinity;
  }
  const digits = '\\d(?:_?\\d)*';
  const re = new RegExp(`^[+-]?(?:${digits}(?:\\.(?:${digits})?)?|\\.${digits})(?:[eE][+-]?${digits})?$`);
  return re.test(t) ? Number(t.replace(/_/g, '')) : undefined;
}

/** pd.to_numeric(cell, errors='coerce'). */
function toNum(v) {
  if (isBlank(v)) return NaN;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isTagged(v, '$float')) return taggedFloat(v);
  if (typeof v !== 'string') return NaN;
  const m = /^[ \t\n\v\f\r]*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)[ \t\n\v\f\r]*$/.exec(v);
  if (m) return Number(m[1]);
  const special = /^([+-]?)(inf|infinity)$/i.exec(v);
  if (special) return special[1] === '-' ? -Infinity : Infinity;
  return NaN;
}

/** pd.to_datetime(cell, errors='coerce').strftime('%Y-%m-%d'); null for NaT. */
function toDate(v) {
  if (isBlank(v) || typeof v === 'boolean') return null;
  if (isTagged(v, '$dt')) return String(v.$dt).slice(0, 10);
  if (typeof v === 'number' || isTagged(v, '$float')) {
    const n = typeof v === 'number' ? v : taggedFloat(v);
    if (!Number.isFinite(n)) return null;
    try {
      return shiftYmd('1970-01-01', Math.floor(n / 86400e9));   // pandas reads a number as epoch ns
    } catch {
      return null;                                             // out of bounds: NaT
    }
  }
  if (typeof v !== 'string') return null;
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?\s*$/.exec(v);
  if (!m) return null;
  const ymd = `${m[1]}-${m[2]}-${m[3]}`;
  return isYmd(ymd) ? ymd : null;
}

/** build_data.py clean_id(): '8388', 8388 and 8388.0 are all '8388'. */
function cleanId(v) {
  const s = sval(v);
  if (s === '') return '';
  const f = pyFloatParse(s);
  if (f === undefined || Number.isNaN(f)) return s;
  if (!Number.isFinite(f)) throw new Error(`fromWorkbookSheets: id '${s}' is infinite (build_data.py crashes here)`);
  return f === Math.trunc(f) ? BigInt(f).toString() : s;
}

/** build_data.py vertical_or_none(). */
function verticalOrNone(v) {
  const s = sval(v);
  if (s === '') return null;
  const f = pyFloatParse(s);
  return f !== undefined && f === 0 ? null : s;
}

/** build_data.py month_of_header(). */
function monthOfHeader(header) {
  for (const word of norm(header).replace(/_/g, ' ').split(PY_WS_RUN).filter(Boolean)) {
    for (let i = 0; i < MONTH_NAMES.length; i += 1) {
      if (MONTH_NAMES[i].startsWith(word.slice(0, 3)) && word.length >= 3) return i + 1;
    }
  }
  return null;
}

function indexWorkbook(workbook) {
  const list = Array.isArray(workbook) ? workbook : (workbook && workbook.sheets);
  if (!Array.isArray(list)) throw new TypeError('fromWorkbookSheets: expected [{ name, columns, rows }]');
  const sheets = new Map();
  for (const s of list) {
    const map = new Map();
    (s.columns || []).forEach((c, i) => {
      if (!map.has(norm(c))) map.set(norm(c), i);
    });
    sheets.set(norm(s.name), { name: s.name, rows: s.rows || [], map });
  }
  return sheets;
}

function validateWorkbook(sheets) {
  const problems = [];
  for (const [sname, cols] of REQUIRED) {
    const sh = sheets.get(norm(sname));
    if (!sh) {
      problems.push(`Sheet '${sname}' is missing from the workbook.`);
      continue;
    }
    const missing = cols.filter((c) => !sh.map.has(norm(c)));
    if (missing.length) problems.push(`Sheet '${sname}' is missing column(s): ${missing.join(', ')}`);
  }
  const ed = sheets.get(norm('emp detail'));
  if (ed && ![...ed.map.keys()].some((k) => /^team name/.test(k))) {
    problems.push("Sheet 'emp detail' has no 'Team Name ...' column.");
  }
  if (problems.length) {
    const err = new Error(`fromWorkbookSheets: invalid workbook structure: ${problems.join(' ')}`);
    err.problems = problems;
    throw err;
  }
}

/**
 * Reproduce build_data.py's normalisation and canon_name resolution from the
 * eight workbook sheets, producing compose() inputs (legacy-mode parity).
 */
function fromWorkbookSheets(workbook) {
  const sheets = indexWorkbook(workbook);
  validateWorkbook(sheets);
  const sheet = (name) => sheets.get(norm(name));
  const col = (sh, header) => {
    const idx = sh.map.get(norm(header));
    return sh.rows.map((row) => (row[idx] === undefined ? null : row[idx]));
  };
  const zip = (sh, spec) => {
    const cols = Object.entries(spec).map(([k, [header, fn]]) => [k, col(sh, header), fn]);
    return sh.rows.map((_, i) => Object.fromEntries(cols.map(([k, values, fn]) => [k, fn(values[i])])));
  };
  const dash = (v) => sval(v, DASH);
  const zmOf = (v) => sval(v, UNASSIGNED);
  const filled = (v) => fnum(toNum(v));

  const O = zip(sheet('Open order'), {
    jobId: ['Job Id', cleanId], vertical: ['Vertical Name', sval], state: ['State', dash], city: ['City', dash],
    client: ['Client', sval], aging: ['Aging', filled], dueTo: ['Pending Due To', dash],
    reason: ['Pending Reason', dash], zm: ['Zonal Manager', zmOf], tx: ['Current TX Name', svalRaw],
    txid: ['Current TX Id', cleanId], spoc: ['Primary SPOC', sval],
  });
  const C = zip(sheet('Close order'), {
    spoc: ['Primary SPOC', sval], charge: ['Total Charge', filled], margin: ['Margin(%)', toNum],
    date: ['Audit & Checkout Date', toDate], client: ['Client', sval], tat: ['TAT Status', toNum],
    sda: ['SDA Status', toNum], zm: ['Zonal Manager', zmOf], vertical: ['Vertical Name', sval],
    tx: ['Current TX Name', svalRaw], txid: ['Current TX Id', cleanId], aco: ['A & CO by', sval],
  });
  const TC = zip(sheet('time champ data'), {
    empId: ['Employee Id', sval], name: ['Employee Name', norm], working: ['Working Hours', filled],
    productive: ['Productive Hours', filled], away: ['Away Hours', filled], date: ['Date', toDate],
  });
  const CR = zip(sheet('crm data'), {
    empId: ['employee id', sval], booked: ['Booked', filled], scheduled: ['Scheduled', filled],
    audit: ['Audit', filled], closed: ['Closed', filled], cancelled: ['Cancelled', filled], date: ['Date', toDate],
  });
  const IV = zip(sheet('ivr data record'), {
    agent: ['Agent Name', norm], incoming: ['Total Incoming Calls', filled], outgoing: ['Total Outgoing Calls', filled],
    missed: ['Total Missed Calls', filled], aht: ['Avg Handling Time', filled], date: ['Date', toDate],
  });

  let d0 = null;
  let d1 = null;
  for (const rows of [C, TC, CR, IV]) {
    for (const r of rows) {
      if (r.date === null) continue;
      if (d0 === null || r.date < d0) d0 = r.date;
      if (d1 === null || r.date > d1) d1 = r.date;
    }
  }
  if (d0 === null) throw new Error('fromWorkbookSheets: no usable dates found in the workbook');
  const dates = dateRange(d0, d1);
  const yearHint = d1.slice(0, 4);
  const monthKey = (v) => {
    const i = MONTH_NAMES.indexOf(norm(v));
    return i >= 0 ? `${yearHint}-${String(i + 1).padStart(2, '0')}` : null;
  };

  // emp detail: team columns ordered by the month in their header (stable).
  const ed = sheet('emp detail');
  const teamCols = [...ed.map.entries()].filter(([k]) => /^team name/.test(k))
    .map(([k, idx]) => ({ idx, month: monthOfHeader(k) || 0 }))
    .sort((a, b) => a.month - b.month);
  const colKey = (tc) => `${yearHint}-${String(tc.month).padStart(2, '0')}`;
  const cell = (row, header) => {
    const v = row[ed.map.get(norm(header))];
    return v === undefined ? null : v;
  };
  const empRows = [];
  for (const row of ed.rows) {
    const crm = sval(cell(row, 'CRM CURRENT NAME'));
    if (!crm) continue;
    const teams = Object.create(null);
    teamCols.forEach((tc, i) => {
      const k = colKey(tc);
      // Legacy reads the FIRST column of the earliest month and the LAST of the latest.
      if (!own(teams, k) || i === teamCols.length - 1 || k !== colKey(teamCols[0])) {
        teams[k] = sval(row[tc.idx] === undefined ? null : row[tc.idx]);
      }
    });
    empRows.push({
      key: crm,
      empId: sval(cell(row, 'EMP ID')),
      display: sval(cell(row, 'EMPLOYE NAME')),
      rowLabel: sval(cell(row, 'Row Labels')),
      vertical: verticalOrNone(cell(row, 'vertical')),
      teams,
    });
  }
  const meta = new Map();
  for (const e of empRows) meta.set(e.key, e);
  const canon = new Map();
  const claim = (name, key) => {
    if (!canon.has(norm(name))) canon.set(norm(name), key);
  };
  for (const e of empRows) {
    claim(e.key, e.key);
    if (e.rowLabel) claim(e.rowLabel, e.key);
    if (e.display) claim(e.display, e.key);
  }
  const canonName = (v) => (canon.has(norm(v)) ? canon.get(norm(v)) : sval(v));
  for (const r of O) r.spoc = canonName(r.spoc);
  for (const r of C) {
    r.spoc = canonName(r.spoc);
    r.aco = canonName(r.aco);
  }

  // Targets.
  const tl = sheet('target list');
  const tlName = col(tl, 'Primary spoc');
  const tlMonth = col(tl, 'month');
  const tlDaily = col(tl, 'Daily Target');
  const tlAmount = col(tl, 'Target Amount');
  // Null-prototype dictionaries: a person literally named '__proto__' stays data.
  const dict = () => Object.create(null);
  const daily = dict();
  const monthly = dict();
  const total = dict();
  const spocs = [];
  tl.rows.forEach((_, i) => {
    const n = canonName(tlName[i]);
    if (n) spocs.push(n);
    const mk = monthKey(tlMonth[i]);
    if (!n || !mk) return;
    if (!own(daily, n)) daily[n] = dict();
    daily[n][mk] = fnum(toNum(tlDaily[i]));
    const amount = fnum(toNum(tlAmount[i]));
    total[n] = (own(total, n) ? total[n] : 0) + amount;
    if (!own(monthly, n)) monthly[n] = dict();
    monthly[n][mk] = (own(monthly[n], mk) ? monthly[n][mk] : 0) + amount;
  });
  const st = sheet('Secondary spoc target list');
  const stName = col(st, 'Name');
  const stMonth = col(st, 'month');
  const stTotal = col(st, 'Total Target');
  const personal = dict();
  st.rows.forEach((_, i) => {
    const n = canonName(stName[i]);
    const mk = monthKey(stMonth[i]);
    if (!n || !mk) return;
    if (!own(personal, n)) personal[n] = dict();
    personal[n][mk] = fnum(toNum(stTotal[i])) / WORKING_DAYS_PER_MONTH;
  });

  // TimeChamp: by EMPLOYE NAME / CRM name first, then EMP ID plus ids seen with those names.
  const tcIdx = new Map();
  const tcByName = new Map();
  const tcIdsOfName = new Map();
  for (const r of TC) {
    tcIdx.set(groupKey(r.empId, r.date), r);
    const nk = groupKey(r.name, r.date);
    if (!tcByName.has(nk)) tcByName.set(nk, r);
    mapGetOrSet(tcIdsOfName, r.name, () => new Set()).add(r.empId);
  }
  const timechamp = [];
  const crmRows = [];
  const ivrRows = [];
  const crByEmp = new Map();
  for (const r of CR) if (r.date !== null) mapGetOrSet(crByEmp, r.empId, () => []).push(r);
  const ivByAgent = new Map();
  for (const r of IV) if (r.date !== null) mapGetOrSet(ivByAgent, r.agent, () => []).push(r);
  for (const e of meta.values()) {
    const keys = [...new Set([norm(e.display), norm(e.key)])];
    const ids = [e.empId, ...sortedStrings(keys.flatMap((k) => [...(tcIdsOfName.get(k) || [])]))];
    for (const d of dates) {
      let t = null;
      for (const k of keys) {
        t = tcByName.get(groupKey(k, d)) || null;
        if (t) break;
      }
      if (!t) {
        for (const id of ids) {
          t = tcIdx.get(groupKey(id, d)) || null;
          if (t) break;
        }
      }
      if (t) timechamp.push({ key: e.key, date: d, working: t.working, productive: t.productive, away: t.away });
    }
    for (const r of crByEmp.get(e.empId) || []) {
      crmRows.push({ key: e.key, date: r.date, booked: r.booked, scheduled: r.scheduled, audit: r.audit,
        closed: r.closed, cancelled: r.cancelled });
    }
    for (const r of ivByAgent.get(norm(e.key)) || []) {
      ivrRows.push({ key: e.key, date: r.date, incoming: r.incoming, outgoing: r.outgoing, missed: r.missed,
        aht: r.aht });
    }
  }

  return {
    window: { from: d0, to: d1 },
    employees: empRows.map((e) => ({ key: e.key, empId: e.empId, display: e.display, vertical: e.vertical, teams: e.teams })),
    targets: { spocs, daily, monthly, total, personal },
    openRows: O,
    closedRows: C,
    timechamp,
    crm: crmRows,
    ivr: ivrRows,
  };
}

module.exports = {
  compose,
  fromWorkbookSheets,
  TEAM_MODES,
  // The Unattributed bucket's identity, shared with aggregate.js (which leaves
  // buckets out of everything that names a person) and live.service.js (which
  // reconciles them against the raw totals).
  UNATTRIBUTED,
  unattributedKey,
  isUnattributedKey,
  // build_data.py's cell rules, shared with the Excel upload parser
  // (uploads.service.js) so an uploaded sheet is read exactly as above.
  workbookCells: { REQUIRED, MONTH_NAMES, norm, sval, toNum, toDate, verticalOrNone, monthOfHeader },
  _internals: { npSum, npMean, kahanNew, kahanAdd, kahanMean, naiveSum, pyRound, pyFloatRepr, cmpCodePoints },
};
