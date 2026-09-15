'use strict';
/*
 * listOffers() — ACCEPTED rows, the job's holder, and what a closed offer says.
 *
 * ─── THE REPORT THIS EXISTS FOR (2026-09-15) ───────────────────────────────
 *
 * Job 540158 was offered to two technicians at 09:35:06. Technician 8079
 * accepted at 10:33:07 and now holds the job; technician 9427's offer closed
 * in the same second, as EXPIRED, with a NULL closed_reason. Schedule & Assign
 * showed ONLY 9427, as EXPIRED — listOffers() filtered ACCEPTED out on the
 * theory that an accepted job "leaves this modal". With offer expiry switched
 * off in production, the one visible row read as a technician letting a job
 * lapse, and the row that explained it was the one hidden.
 *
 * ─── WHAT IS PINNED, AND WHY ───────────────────────────────────────────────
 *
 * The fake pool never runs the SQL, so the SQL is asserted as TEXT (the
 * filter, the holder-first sort, the column gate, the sibling window) and the
 * mapping is asserted on rows shaped like what that SQL would return. The two
 * halves only mean something together: the internal columns the mapping reads
 * are the ones the SELECT is shown to project, and are shown to be stripped.
 *
 * The fairness claim gets its own pin. EXPIRED and "no response" are a claim
 * about a named person, and exactly ONE input may produce them.
 *
 * Runner: `TZ=UTC node --test --require ./tests/helpers/close-pool.js
 * tests/job-offers-list-outcome.test.js`. No DB.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { installFakePool } = require('./helpers/fake-pool');

const ROOT = path.join(__dirname, '..');
const JOB_ID = 540158;

/* Mutable per call; the routes read it, so one installed fake serves every case. */
const state = { rows: [], reasonCol: true, tableAbsent: false };

const fake = installFakePool([
  // 1. The list itself. First, so nothing below can capture it.
  [/FROM tbl_job_offer jo/, () => state.rows],
  // 2. The shared closed_reason column probe (services/offer-closed-reason.js).
  [/SHOW COLUMNS FROM tbl_job_offer LIKE 'closed_reason'/, () => (state.reasonCol ? [{ Field: 'closed_reason' }] : [])],
  // 3. jobOfferTableExists(). ANCHORED: the main SELECT's EXISTS clause also
  //    contains "SELECT 1 FROM tbl_job_offer acc", and an unanchored route
  //    could swallow it. Unmatched → [] → the probe reads "present".
  [/^SELECT 1 FROM tbl_job_offer LIMIT 1$/, () => {
    if (state.tableAbsent) {
      throw Object.assign(new Error("Table 'tbl_job_offer' doesn't exist"), { code: 'ER_NO_SUCH_TABLE' });
    }
    return [];
  }],
]);

const { OFFER_CLOSED_REASON, OFFER_CLOSED_REASON_LABEL } = require(path.join(ROOT, 'services/offer-closed-reason'));

after(() => fake.restore());

/**
 * Load FRESH copies of offer-closed-reason and job.service, so both memos (the
 * table probe and the column probe) start cold, then list job 540158 as a pure
 * read. Returns the items and every statement the service issued.
 */
async function list({ rows = [], reasonCol = true, tableAbsent = false } = {}) {
  state.rows = rows;
  state.reasonCol = reasonCol;
  state.tableAbsent = tableAbsent;
  for (const m of ['services/offer-closed-reason', 'services/job.service']) {
    delete require.cache[require.resolve(path.join(ROOT, m))];
  }
  fake.reset();
  const jobSvc = require(path.join(ROOT, 'services/job.service'));
  const items = await jobSvc.listOffers(JOB_ID, { sweep: false });
  const calls = fake.calls.slice();
  return { items, calls, main: calls.find((c) => /FROM tbl_job_offer jo/.test(c.sql)) };
}

const LABEL_BY_STATUS = { 0: 'OFFERED', 1: 'ACCEPTED', 2: 'REJECTED', 3: 'EXPIRED' };

/** A row as the SELECT returns it: every existing column plus the three new ones. */
function row(over = {}) {
  const status = over.offer_status ?? 3;
  return {
    efr_id: 9427,
    efr_name: 'Technician 9427',
    offered_at: new Date('2026-09-15T09:35:06Z'),
    responded_at: new Date('2026-09-15T10:33:07Z'),
    offer_status: status,
    offer_status_label: LABEL_BY_STATUS[status],
    offer_count: 1,
    offer_source: 'manual',
    reject_reason: null,
    mobile: 'XXXXXX1234',
    offered_by_user_id: 77,
    offered_by_name: 'Ops User',
    assigned_efr_id: 8079,
    sibling_accept_match: 0,
    closed_reason: null,
    ...over,
  };
}

const outcomeOf = (item) => [item.outcome, item.outcome_label, item.outcome_detail, item.outcome_inferred];
const byEfr = (items, efrId) => {
  const it = items.find((i) => i.efr_id === efrId);
  assert.ok(it, `expected an item for efr_id ${efrId}`);
  return it;
};

const R = OFFER_CLOSED_REASON;
const SIBLING_LABEL = OFFER_CLOSED_REASON_LABEL[R.SIBLING_ACCEPTED];
const TTL_LABEL = OFFER_CLOSED_REASON_LABEL[R.TTL_ELAPSED];

/* ─── the SQL ──────────────────────────────────────────────────────────── */

test('SQL: ACCEPTED is listed, the holder sorts first, and the job id is the only param', async () => {
  const { main } = await list();
  assert.ok(main, 'listOffers must issue its SELECT');
  assert.match(main.sql, /offer_status IN \(0, 1, 2, 3\)/,
    'ACCEPTED (1) must be in the filter — job 540158 hid the technician who accepted');
  assert.match(main.sql,
    /CASE WHEN jo\.fk_easyfixter_id = j\.fk_easyfixter_id THEN 0 ELSE 1 END,\s*FIELD\(jo\.offer_status, 0, 2, 1, 3\)/,
    'holder first regardless of status (CASE, so a NULL holder sorts with everyone else), '
    + 'then all four statuses named in FIELD — an unlisted one returns 0 and sorts first');
  assert.match(main.sql, /JOIN tbl_job j ON j\.job_id = jo\.job_id/,
    'the holder comes from tbl_job, not from a possibly stale ACCEPTED row');
  assert.deepEqual(main.params, [JOB_ID], 'the join and the EXISTS add no bind params');
});

test('SQL: closed_reason is named only when the column exists, and only for EXPIRED rows', async () => {
  const absent = await list({ reasonCol: false });
  assert.match(absent.main.sql, /NULL AS closed_reason/);
  assert.doesNotMatch(absent.main.sql, /jo\.closed_reason/,
    'naming a column the host never migrated would fail the whole list');

  const present = await list({ reasonCol: true });
  assert.match(present.main.sql, /CASE WHEN jo\.offer_status = 3 THEN jo\.closed_reason END AS closed_reason/,
    'EXPIRED only: a re-opened row keeps its old reason, which describes an earlier offer');
});

test('SQL: the sibling-accept window is another technician, ACCEPTED, 0–1s, offered before it', async () => {
  const { main } = await list();
  assert.ok(main.sql.includes('acc.offer_status = 1'), 'matches only an ACCEPTED row');
  assert.ok(main.sql.includes('acc.fk_easyfixter_id <> jo.fk_easyfixter_id'), 'never the row itself');
  assert.match(main.sql, /BETWEEN acc\.responded_at AND acc\.responded_at \+ INTERVAL 1 SECOND/,
    'the winner and the sibling close are two statements with their own NOW() on a whole-second column');
  assert.ok(main.sql.includes('jo.offered_at <= acc.responded_at'),
    'an offer made after the accept (a later re-offer round) cannot be its sibling');
});

/* ─── the mapping ──────────────────────────────────────────────────────── */

test('job 540158: the winner reads ACCEPTED, the sibling reads CLOSED with an inferred cause', async () => {
  const { items } = await list({
    rows: [
      row({ efr_id: 8079, efr_name: 'Technician 8079', offer_status: 1, offer_status_label: 'ACCEPTED' }),
      row({ efr_id: 9427, offer_status: 3, closed_reason: null, sibling_accept_match: 1 }),
    ],
  });
  assert.deepEqual(outcomeOf(byEfr(items, 8079)), ['accepted', 'ACCEPTED', null, false]);
  assert.deepEqual(outcomeOf(byEfr(items, 9427)), ['closed', 'CLOSED', SIBLING_LABEL, true],
    'NULL was stored, so the cause is inferred — the CRM shows that as a tooltip');
  assert.equal(SIBLING_LABEL, 'Another technician accepted', 'wording comes from the shared label');
});

test('a stale ACCEPTED row keeps its word but says the job has moved on', async () => {
  const { items } = await list({
    rows: [
      row({ efr_id: 5001, offer_status: 1, assigned_efr_id: null }),
      row({ efr_id: 5002, offer_status: 1, assigned_efr_id: 1111 }),
    ],
  });
  assert.deepEqual(outcomeOf(byEfr(items, 5001)), ['accepted_released', 'ACCEPTED', 'Job later released', false]);
  assert.deepEqual(outcomeOf(byEfr(items, 5002)), ['accepted_reassigned', 'ACCEPTED', 'Job later reassigned', false]);
});

test('the holder on a non-ACCEPTED row reads ASSIGNED, whatever that row says', async () => {
  const holder = (over) => row({ efr_id: 6000, assigned_efr_id: 6000, ...over });
  const cases = [
    holder({ offer_status: 3, closed_reason: R.JOB_ASSIGNED }),
    holder({ offer_status: 3, closed_reason: null, sibling_accept_match: 1 }),
    holder({ offer_status: 2, reject_reason: 'Too far' }),
    holder({ offer_status: 0 }),
  ];
  for (const fixture of cases) {
    const { items } = await list({ rows: [fixture] });
    assert.deepEqual(outcomeOf(items[0]), ['assigned', 'ASSIGNED', 'Assigned directly', false],
      `holder with status ${fixture.offer_status} / reason ${fixture.closed_reason} / match ${fixture.sibling_accept_match}`);
  }
});

test('stored reasons with no sibling match', async () => {
  const others = Object.values(R).filter((v) => v !== R.TTL_ELAPSED && v !== R.SIBLING_ACCEPTED);
  assert.ok(others.length >= 6, 'the loop below must not be vacuous');
  const rows = others.map((reason, i) => row({ efr_id: 7000 + i, closed_reason: reason }));
  rows.push(row({ efr_id: 7100, closed_reason: R.TTL_ELAPSED }));
  rows.push(row({ efr_id: 7101, closed_reason: R.SIBLING_ACCEPTED }));
  const { items } = await list({ rows });

  others.forEach((reason, i) => {
    assert.deepEqual(outcomeOf(byEfr(items, 7000 + i)), ['closed', 'CLOSED', OFFER_CLOSED_REASON_LABEL[reason], false],
      `${reason} must read CLOSED with its shared label`);
  });
  assert.deepEqual(outcomeOf(byEfr(items, 7100)), ['expired', 'EXPIRED', TTL_LABEL, false]);
  assert.equal(TTL_LABEL, 'No response in time');
  assert.deepEqual(outcomeOf(byEfr(items, 7101)), ['closed', 'CLOSED', null, false],
    "acceptOffer's lost-race branch stores sibling_accepted when nobody accepted — no label without proof");
});

test('a sibling match overrides any stored reason', async () => {
  const { items } = await list({
    rows: [
      row({ efr_id: 7200, closed_reason: R.TTL_ELAPSED, sibling_accept_match: 1 }),
      row({ efr_id: 7201, closed_reason: R.REOFFERED, sibling_accept_match: 1 }),
      row({ efr_id: 7202, closed_reason: R.JOB_ASSIGNED, sibling_accept_match: 1 }),
      row({ efr_id: 7203, closed_reason: R.SIBLING_ACCEPTED, sibling_accept_match: 1 }),
    ],
  });
  for (const efr of [7200, 7201, 7202]) {
    assert.deepEqual(outcomeOf(byEfr(items, efr)), ['closed', 'CLOSED', SIBLING_LABEL, true],
      'no OFFERED row survives an accept, so a different stored reason is a leftover from before a re-open');
  }
  assert.deepEqual(outcomeOf(byEfr(items, 7203)), ['closed', 'CLOSED', SIBLING_LABEL, false],
    'the stored reason agrees, so nothing is inferred');
});

test('NULL, unknown and prototype-named reasons — and EXPIRED is reachable from ONE input only', async () => {
  const { items: small } = await list({
    rows: [
      row({ efr_id: 7300, closed_reason: null }),
      row({ efr_id: 7301, closed_reason: 'made_up' }),
      row({ efr_id: 7302, closed_reason: 'toString' }),
    ],
  });
  assert.deepEqual(outcomeOf(byEfr(small, 7300)), ['closed', 'CLOSED', 'Cause not recorded', false]);
  assert.deepEqual(outcomeOf(byEfr(small, 7301)), ['closed', 'CLOSED', null, false]);
  assert.deepEqual(outcomeOf(byEfr(small, 7302)), ['closed', 'CLOSED', null, false],
    'an own-key check, or toString would resolve to a function');

  /*
   * The fairness pin. Every status-3, non-holder shape: each stored reason,
   * NULL, and two unknown strings, each with and without a match. Only
   * (ttl_elapsed, no match) may say EXPIRED or "no response".
   */
  const reasons = [...Object.values(R), null, 'made_up', 'toString'];
  const rows = [];
  let id = 8000;
  for (const reason of reasons) {
    for (const match of [0, 1]) rows.push(row({ efr_id: id++, closed_reason: reason, sibling_accept_match: match }));
  }
  const { items } = await list({ rows });
  assert.equal(items.length, rows.length);
  const blaming = items.filter((it) => it.outcome === 'expired'
    || it.outcome_label === 'EXPIRED'
    || /no response/i.test(String(it.outcome_detail)));
  assert.equal(blaming.length, 1, `exactly one shape may blame the technician; got ${blaming.length}`);
  const src = rows.find((r) => r.efr_id === blaming[0].efr_id);
  assert.equal(src.closed_reason, R.TTL_ELAPSED);
  assert.equal(src.sibling_accept_match, 0);
});

test('a non-holder OFFERED or REJECTED row keeps its stored label and no detail', async () => {
  const { items } = await list({
    rows: [
      row({ efr_id: 7400, offer_status: 0 }),
      row({ efr_id: 7401, offer_status: 2, reject_reason: 'Busy' }),
    ],
  });
  assert.deepEqual(outcomeOf(byEfr(items, 7400)), ['offered', 'OFFERED', null, false]);
  assert.deepEqual(outcomeOf(byEfr(items, 7401)), ['rejected', 'REJECTED', null, false]);
});

/* ─── contract ─────────────────────────────────────────────────────────── */

test('back-compat: existing keys pass through unchanged, internal columns are stripped', async () => {
  const EXISTING = [
    'efr_id', 'efr_name', 'offered_at', 'responded_at', 'offer_status', 'offer_status_label',
    'offer_count', 'offer_source', 'reject_reason', 'mobile', 'offered_by_user_id', 'offered_by_name',
  ];
  const NEW = ['closed_reason', 'outcome', 'outcome_label', 'outcome_detail', 'outcome_inferred'];
  const fixture = row({ efr_id: 7500, offer_status: 2, reject_reason: 'Out of town', closed_reason: null });
  const { items } = await list({ rows: [fixture] });
  const item = items[0];
  for (const k of EXISTING) {
    assert.deepEqual(item[k], fixture[k], `${k} must pass through unchanged — older CRMs read it`);
  }
  assert.ok(!('assigned_efr_id' in item), 'assigned_efr_id is internal');
  assert.ok(!('sibling_accept_match' in item), 'sibling_accept_match is internal');
  assert.deepEqual(Object.keys(item).sort(), [...EXISTING, ...NEW].sort());
});

test('pure read: sweep:false issues no write', async () => {
  const { calls } = await list({ rows: [row(), row({ efr_id: 8079, offer_status: 1 })] });
  assert.ok(calls.length > 0, 'the service must have queried, or this proves nothing');
  const writes = calls.filter((c) => /^\s*(UPDATE|INSERT|DELETE)/i.test(c.sql));
  assert.deepEqual(writes, [], 'the hover card fires on mouse-over; a read must not change offer state');
});

test('table absent: [] and no list query', async () => {
  const { items, calls } = await list({ rows: [row()], tableAbsent: true });
  assert.deepEqual(items, []);
  assert.ok(calls.some((c) => /^SELECT 1 FROM tbl_job_offer LIMIT 1$/.test(c.sql)), 'the probe must have run');
  assert.ok(!calls.some((c) => /FROM tbl_job_offer jo/.test(c.sql)), 'nothing past the probe on an un-migrated host');
});
