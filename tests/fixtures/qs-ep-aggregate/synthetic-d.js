/*
 * A small, fully synthetic dashboard data object D (the shape build_data.py
 * writes). No real people, clients or revenue. Every value is here to push one
 * branch of the dashboard's aggregation; the notes say which.
 *
 * Returns a fresh copy on every call so a test cannot leak mutations.
 */
'use strict';

const DATES = ['2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03'];

// Dense daily target/revenue rows, as build_data.py writes them.
function daily(targetAug, targetSep, revenue, completed) {
  return DATES.map((date, i) => {
    const target = date.startsWith('2026-08') ? targetAug : targetSep;
    return { date, target, revenue: revenue[i], pct: target ? revenue[i] / target * 100 : 0, due: Math.max(target - revenue[i], 0), completed: completed[i] };
  });
}

// [working, productive, away, closed, cancelled, positive, openJobs, incoming, outgoing, missed, missedPct, avgEng]
function productivity(rows) {
  return DATES.map((date, i) => {
    const [working, productive, away, closed, cancelled, positive, openJobs, incoming, outgoing, missed, missedPct, avgEng] = rows[i];
    const r = { date, working, productive, away, pct: productive / 9 * 100, status: productive >= 7.5 ? 'green' : (productive < 7 ? 'red' : 'orange'), closed, cancelled, positive, openJobs, incoming, outgoing, missed, missedPct, avgEng };
    if (openJobs === undefined) delete r.openJobs;       // an absent key: the page shows 0 / sums 0
    return r;
  });
}

function revPerf(targetAug, targetSep, achieved) {
  return DATES.map((date, i) => {
    const target = date.startsWith('2026-08') ? targetAug : targetSep;
    return { date, target, achieved: achieved[i], pct: target ? achieved[i] / target * 100 : 0, due: Math.max(target - achieved[i], 0) };
  });
}

const openRow = (jobId, vertical, state, city, client, aging, pendingDueTo, pendingReason, pmoc) =>
  ({ jobId, vertical, state, city, client, aging, pendingDueTo, pendingReason, pmoc });

const zonal = (zm, vertical, date, open, closed, revenue) => ({ zm, vertical, date, open, closed, revenue });

const ZERO_PROD = DATES.map(() => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

function build() {
  // ── Asha: Furniture SPOC, team Alpha (with a duplicated member) ──────────
  const ashaOpen = [
    openRow(1001, 'Furniture', 'MH', 'Pune', 'Acme', 2, 'ab', 'c', 'Asha'),
    openRow(1002, 'Furniture', 'MH', 'Pune', 'Acme', 7.5, 'Customer', 'Not reachable', 'Asha'),
    openRow(1003, 'Furniture', 'DL', 'Delhi', '<Bold & "Co">', 10, 'Customer', 'Not reachable', 'Asha'),
    // aging as a string "9": 6–9 tile in the Open Job Record, 9+ in the client table
    openRow(1004, 'Easyfix', 'DL', 'Delhi', '<Bold & "Co">', '9', 'ab', 'c', 'Asha'),
  ];
  const asha = {
    team: 'Alpha', teamSize: 4, vertical: 'Furniture', revView: 'team',
    revenue: 2250.55, completed: 9, open: 4,
    // 0.1 + 0.2 style revenues: the sum ORDER shows in the last bit
    daily: daily(1000.5, 1200, [0.1, 950.25, 0.2, 1300, 0], [1, 3, 1, 4, 0]),
    clients: [
      { client: 'Acme', total: 5, completed: 3, open: 2, a02: 1, a35: 0, a68: 1, a9: 0, avg_age: 4.75 },
      { client: 'Zen Homes', total: 2, completed: 2, open: 0, a02: 0, a35: 0, a68: 0, a9: 0, avg_age: 0 },
      { client: '<Bold & "Co">', total: 2, completed: 0, open: 2, a02: 0, a35: 0, a68: 0, a9: 2, avg_age: 9.5 },
    ],
    tatSda: [{ client: 'Acme', tat: 66.6667, sda: 50 }, { client: 'Zen Homes', tat: 100, sda: 0 }],
    cityWise: [
      { city: 'Pune', open: 2, a02: 1, a35: 0, a68: 1, a9: 0, avg_age: 4.75 },
      { city: 'Delhi', open: 2, a02: 0, a35: 0, a68: 0, a9: 2, avg_age: 9.5 },
    ],
    // 'ab'+'c' vs Bharat's 'a'+'bc': distinct rows only because the page's key has a U+0001 separator
    pendingReasons: [
      { dueTo: 'ab', reason: 'c', a02: 1, a35: 0, a68: 0, a9: 1, total: 2 },
      { dueTo: 'Customer', reason: 'Not reachable', a02: 0, a35: 0, a68: 1, a9: 1, total: 2 },
    ],
    openRows: ashaOpen,
    byZm: {
      Zed: {
        revenue: 2250.35, completed: 8, open: 3,
        daily: daily(1000.5, 1200, [0.1, 950.25, 0, 1300, 0], [1, 3, 0, 4, 0]),
        clients: [
          { client: 'Acme', total: 5, completed: 3, open: 2, a02: 1, a35: 0, a68: 1, a9: 0, avg_age: 4.75 },
          { client: '<Bold & "Co">', total: 1, completed: 0, open: 1, a02: 0, a35: 0, a68: 0, a9: 1, avg_age: 10 },
        ],
        tatSda: [{ client: 'Acme', tat: 66.6667, sda: 50 }],
        cityWise: [
          { city: 'Pune', open: 2, a02: 1, a35: 0, a68: 1, a9: 0, avg_age: 4.75 },
          { city: 'Delhi', open: 1, a02: 0, a35: 0, a68: 0, a9: 1, avg_age: 10 },
        ],
        pendingReasons: [
          { dueTo: 'Customer', reason: 'Not reachable', a02: 0, a35: 0, a68: 1, a9: 1, total: 2 },
          { dueTo: 'ab', reason: 'c', a02: 1, a35: 0, a68: 0, a9: 0, total: 1 },
        ],
        openRows: ashaOpen.slice(0, 3),
      },
      Yan: {
        revenue: 0.2, completed: 1, open: 1,
        daily: daily(1000.5, 1200, [0, 0, 0.2, 0, 0], [0, 0, 1, 0, 0]),
        clients: [
          { client: 'Zen Homes', total: 2, completed: 2, open: 0, a02: 0, a35: 0, a68: 0, a9: 0, avg_age: 0 },
          { client: '<Bold & "Co">', total: 1, completed: 0, open: 1, a02: 0, a35: 0, a68: 0, a9: 1, avg_age: 9 },
        ],
        tatSda: [{ client: 'Zen Homes', tat: 100, sda: 0 }],
        cityWise: [{ city: 'Delhi', open: 1, a02: 0, a35: 0, a68: 0, a9: 1, avg_age: 9 }],
        pendingReasons: [{ dueTo: 'ab', reason: 'c', a02: 0, a35: 0, a68: 0, a9: 1, total: 1 }],
        openRows: ashaOpen.slice(3),
      },
    },
    productivity: productivity([
      [9.25, 7.5, 1.75, 3, 1, 9, 5, 20, 40, 6, 10, 180.5],
      [8.1, 6.95, 1.15, 2, 0, 4, 2, 0, 0, 0, 0, 0],
      [9, 7.25, 1.5, 4, 2, 11, 7, 12, 30, 12, 28.5714, 200.25],
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [10.5, 9.75, 0.75, 1, 0, 3, 2, 5, 5, 1, 10, 150],
    ]),
    revPerf: revPerf(500, 600, [0, 100.5, 0.1, 0.2, 700]),
    zonal: [
      zonal('Zed', 'Furniture', '2026-08-30', 0, 1, 0.1),
      zonal('Zed', 'Furniture', '2026-08-31', 0, 3, 950.25),
      zonal('Yan', 'Easyfix', '2026-09-01', 0, 1, 0.2),         // a row vertical that is not a D.verticals option
      zonal('Zed', 'Furniture', '2026-09-02', 0, 4, 1300),
      zonal('Zed', 'Sports', '2026-09-02', 0, 1, 77),           // Sports row under a Furniture SPOC
      zonal('Yan', 'Furniture', '2026-07-31', 0, 2, 500),       // a date outside D.dates
      zonal('Zed', 'Furniture', null, 3, 0, 0),                 // open rows: date null, always counted
      zonal('Yan', 'Easyfix', null, 1, 0, 0),
    ],
  };

  // ── Bharat: Sports SPOC with no revView key (lead by primarySpocs) ───────
  const bharatOpen = [
    openRow(2001, 'Sports', 'KA', 'Chennai', 'Sporty', null, 'a', 'bc', 'Bharat'),   // aging null → 0
    openRow(2002, 'Sports', 'MH', 'Pune', 'Acme', 3, 'Technician', 'Parts', 'Bharat'),
  ];
  const bharat = {
    team: 'Beta', teamSize: 4, vertical: 'Sports',
    revenue: 530.29, completed: 4, open: 2,
    daily: daily(500, 0, [400, 0, 30.3, 0, 99.99], [2, 0, 1, 0, 1]),   // September target 0
    clients: [
      { client: 'Acme', total: 3, completed: 2, open: 1, a02: 0, a35: 1, a68: 0, a9: 0, avg_age: 3 },
      { client: 'Sporty', total: 3, completed: 2, open: 1, a02: 1, a35: 0, a68: 0, a9: 0, avg_age: 0 },
    ],
    tatSda: [{ client: 'Acme', tat: 33.3333, sda: 25.5 }, { client: 'Sporty', tat: 0, sda: 100 }],
    cityWise: [
      { city: 'Pune', open: 1, a02: 0, a35: 1, a68: 0, a9: 0, avg_age: 3 },
      { city: 'Chennai', open: 1, avg_age: 0 },                              // bucket keys absent
    ],
    pendingReasons: [
      { dueTo: 'a', reason: 'bc', a02: 1, a35: 0, a68: 0, a9: 0, total: 1 },
      { dueTo: 'Technician', reason: 'Parts', a02: 0, a35: 1, a68: 0, a9: 0, total: 1 },
    ],
    openRows: bharatOpen,
    byZm: {
      // Bharat has NO Zed or Unassigned block → the page's fallback keeps his unsliced openRows
      Yan: {
        revenue: 530.29, completed: 4, open: 2,
        daily: daily(500, 0, [400, 0, 30.3, 0, 99.99], [2, 0, 1, 0, 1]),
        clients: [
          { client: 'Acme', total: 3, completed: 2, open: 1, a02: 0, a35: 1, a68: 0, a9: 0, avg_age: 3 },
          { client: 'Sporty', total: 3, completed: 2, open: 1, a02: 1, a35: 0, a68: 0, a9: 0, avg_age: 0 },
        ],
        tatSda: [{ client: 'Acme', tat: 33.3333, sda: 25.5 }, { client: 'Sporty', tat: 0, sda: 100 }],
        cityWise: [
          { city: 'Pune', open: 1, a02: 0, a35: 1, a68: 0, a9: 0, avg_age: 3 },
          { city: 'Chennai', open: 1, avg_age: 0 },
        ],
        pendingReasons: [
          { dueTo: 'a', reason: 'bc', a02: 1, a35: 0, a68: 0, a9: 0, total: 1 },
          { dueTo: 'Technician', reason: 'Parts', a02: 0, a35: 1, a68: 0, a9: 0, total: 1 },
        ],
        openRows: bharatOpen,
      },
    },
    productivity: productivity([
      [7, 6.5, 0.5, 1, 1, 2, 1, 3, 7, 2, 20, 90],
      [9.5, 8, 1.5, 0, 0, 0, 0, 10, 0, 0, 0, 60.75],
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [8.75, 7.4, 1.35, 2, 0, 6, 4, 1, 1, 1, 50, 30],
      [6, 5.5, 0.5, 0, 1, 1, 1, 0, 2, 0, 0, 45.5],
    ]),
    revPerf: revPerf(0, 0, [0, 0, 0, 0, 0]),
    zonal: [
      zonal('Yan', 'Sports', '2026-08-30', 0, 2, 400),
      zonal('Yan', 'Furniture', '2026-09-01', 0, 1, 30.3),     // Furniture row under a Sports SPOC
      zonal('Yan', 'Sports', '2026-09-03', 0, 1, 99.99),
      zonal('Yan', 'Sports', null, 2, 0, 0),
    ],
  };

  // ── Chitra: Furniture SPOC with no team (empty team name, teamSize 0) ────
  const chitraOpen = [openRow(3001, 'Furniture', 'DL', 'Delhi', 'Zen Homes', 12.25, 'Customer', 'Not reachable', 'Chitra')];
  const chitra = {
    team: '', teamSize: 0, vertical: 'Furniture', revView: 'member',
    revenue: 360.3, completed: 4, open: 1,
    daily: daily(0, 250.75, [0, 0, 260, 100, 0.3], [0, 0, 2, 1, 1]),
    clients: [{ client: 'Zen Homes', total: 5, completed: 4, open: 1, a02: 0, a35: 0, a68: 0, a9: 1, avg_age: 12.25 }],
    tatSda: [{ client: 'Zen Homes', tat: 75, sda: 75 }],
    cityWise: [{ city: 'Delhi', open: 1, a02: 0, a35: 0, a68: 0, a9: 1, avg_age: 12.25 }],
    pendingReasons: [{ dueTo: 'Customer', reason: 'Not reachable', a02: 0, a35: 0, a68: 0, a9: 1, total: 1 }],
    openRows: chitraOpen,
    byZm: {
      Unassigned: {
        revenue: 100, completed: 1, open: 1,
        daily: daily(0, 250.75, [0, 0, 0, 100, 0], [0, 0, 0, 1, 0]),
        clients: [{ client: 'Zen Homes', total: 2, completed: 1, open: 1, a02: 0, a35: 0, a68: 0, a9: 1, avg_age: 12.25 }],
        tatSda: [{ client: 'Zen Homes', tat: 100, sda: 100 }],
        cityWise: [{ city: 'Delhi', open: 1, a02: 0, a35: 0, a68: 0, a9: 1, avg_age: 12.25 }],
        pendingReasons: [{ dueTo: 'Customer', reason: 'Not reachable', a02: 0, a35: 0, a68: 0, a9: 1, total: 1 }],
        openRows: chitraOpen,
      },
      Zed: {
        revenue: 260.3, completed: 3, open: 0,
        daily: daily(0, 250.75, [0, 0, 260, 0, 0.3], [0, 0, 2, 0, 1]),
        clients: [{ client: 'Zen Homes', total: 3, completed: 3, open: 0, a02: 0, a35: 0, a68: 0, a9: 0, avg_age: 0 }],
        tatSda: [{ client: 'Zen Homes', tat: 66.6667, sda: 66.6667 }],
        cityWise: [],
        pendingReasons: [],
        openRows: [],
      },
    },
    productivity: productivity([
      [9, 8, 1, 1, 0, 1, 0, 4, 4, 0, 0, 100],
      [9, 7.75, 1.25, 0, 0, 2, 2, 0, 3, 3, 100, 20.5],
      [8.5, 7, 1.5, 2, 1, 5, 3, 2, 2, 1, 25, 33.3],
      [9.1, 7.6, 1.5, 1, 0, 1, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ]),
    revPerf: revPerf(300, 400.25, [0, 50, 260, 100, 0.3]),
    zonal: [
      zonal('Zed', 'Furniture', '2026-09-01', 0, 2, 260),
      zonal('Unassigned', 'Furniture', '2026-09-02', 0, 1, 100),
      zonal('Zed', 'Furniture', '2026-09-03', 0, 1, 0.3),
      zonal('Unassigned', 'Furniture', null, 1, 0, 0),
    ],
  };

  // Team members carry a copy of their lead's block in build_data.py; the
  // aggregation never reads it, so members get only what the modal reads.
  const member = (over) => ({
    teamSize: 0, revenue: 0, completed: 0, open: 0, daily: [], clients: [], tatSda: [], cityWise: [], pendingReasons: [],
    openRows: [], byZm: {}, zonal: [], productivity: productivity(ZERO_PROD), revPerf: [], ...over,
  });

  const employees = {
    Asha: asha,
    Bharat: bharat,
    Chitra: chitra,
    Esha: member({
      team: 'Alpha', teamSize: 4, vertical: 'Furniture', revView: 'member',
      productivity: productivity([
        [9, 7.8, 1.2, 2, 0, 5, 3, 10, 10, 4, 0, 70],      // missedPct 0 with calls: the modal recomputes it
        [9, 6.2, 2.8, 1, 1, 2, 1, 0, 0, 0, 0, 0],
        [9, 7.1, 1.9, 0, 0, 0, 0, 5, 0, 5, 100, 12],
        [9, 7.9, 1.1, 3, 0, 8, 5, 8, 12, 2, 10, 80],
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      ]),
      revPerf: revPerf(250, 300, [10, 20.5, 30.25, 0, 400]),
    }),
    Farid: member({ team: 'Alpha', teamSize: 4, vertical: 'Operations', revView: 'member', revPerf: revPerf(100, 100, [0, 0, 0, 0, 0]) }),
    Gita: member({
      team: 'Beta', teamSize: 4, vertical: null, revView: 'member',
      productivity: productivity([
        [8, 7.6, 0.4, 1, 0, 1, undefined, 2, 2, 0, 0, 10],   // openJobs key absent
        [8, 7.6, 0.4, 1, 0, 1, undefined, 2, 2, 0, 0, 10],
        [8, 7.6, 0.4, 1, 0, 1, undefined, 2, 2, 0, 0, 10],
        [8, 7.6, 0.4, 1, 0, 1, undefined, 2, 2, 0, 0, 10],
        [8, 7.6, 0.4, 1, 0, 1, undefined, 2, 2, 0, 0, 10],
      ]),
      revPerf: revPerf(80, 90, [80, 0, 95, 0, 0]),
    }),
    // no revView and no revPerf: member view with an empty revenue table
    Ishan: (() => { const e = member({ team: 'Beta', teamSize: 4, vertical: 'Sports' }); delete e.revPerf; return e; })(),
  };

  return {
    employees,
    verticals: ['Furniture', 'Sports'],
    months: ['2026-08', '2026-09'],
    dates: DATES.slice(),
    // Dev is a primary SPOC with no employee row: skipped everywhere
    primarySpocs: ['Asha', 'Bharat', 'Chitra', 'Dev'],
    zonalManagers: ['Unassigned', 'Yan', 'Zed'],
    // Hari is on a team but not in employees: his chip always shows, his click does nothing
    teamMembers: { Alpha: ['Asha', 'Esha', 'Farid', 'Esha'], Beta: ['Bharat', 'Gita', 'Hari', 'Ishan'] },
    displayNames: { Asha: 'Asha Rao', Bharat: 'Bharat', Chitra: 'Chitra & <Co>', Esha: 'Esha K', Farid: 'Farid', Gita: 'Gita', Ishan: 'Ishan' },
    txRows: [
      { spoc: 'Asha', tx: 'Tech One', vertical: 'Furniture', zm: 'Zed', total: 3, closed: 1, open: 2, ageSum: 9.5, dates: DATES.slice(), txid: 'T1' },
      { spoc: 'Asha', tx: 'Tech One', vertical: 'Furniture', zm: 'Yan', total: 2, closed: 1, open: 1, ageSum: 9, dates: DATES.slice(), txid: 'T1' },
      { spoc: 'Asha', tx: '', vertical: 'Easyfix', zm: 'Yan', total: 1, closed: 1, open: 0, ageSum: 0, dates: DATES.slice(), txid: 'T9' },
      { spoc: 'Bharat', tx: 'Tech Two', vertical: 'Sports', zm: 'Yan', total: 4, closed: 3, open: 1, ageSum: 3, dates: DATES.slice(), txid: 'T2' },
      { spoc: 'Rishi', tx: 'Tech Three', vertical: 'Furniture', zm: 'Zed', total: 2, closed: 2, open: 0, ageSum: 0, dates: DATES.slice(), txid: 'T3' },
      { spoc: 'Chitra', tx: 'Tech Four', vertical: 'Furniture', zm: 'Unassigned', total: 1, closed: 0, open: 1, ageSum: 12.25, dates: ['2026-08-30'], txid: 'T4' },
      // same (spoc, tx, txid) as the Sports row above: the group keeps the first-seen vertical
      { spoc: 'Bharat', tx: 'Tech Two', vertical: 'Furniture', zm: 'Yan', total: 1, closed: 1, open: 0, ageSum: 0, dates: DATES.slice(), txid: 'T2' },
      { spoc: 'Chitra', tx: 'Tech & <Five>', vertical: 'Furniture', zm: 'Zed', total: 2, closed: 1, open: 1, ageSum: 0.3333333333333333, dates: DATES.slice(), txid: '' },
    ],
    unassigned: [
      { spoc: 'Asha', date: '2026-09-03', count: 2 },
      { spoc: 'Bharat', date: '2026-09-03', count: 0 },
      { spoc: 'Asha', date: '2026-09-03', count: '1' },
      { spoc: 'Rishi', date: '2026-09-03', count: 5 },
      { spoc: 'Chitra', date: '2026-09-03', count: 1 },
    ],
    zmBreakdown: [
      { vertical: 'Furniture', zonalManager: 'Zed', open: 3, closed: 10, revenue: 2510.65 },
      { vertical: 'Sports', zonalManager: 'Yan', open: 2, closed: 3, revenue: 499.99 },
    ],
  };
}

module.exports = { syntheticD: build, DATES };
