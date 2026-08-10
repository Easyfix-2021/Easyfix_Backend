'use strict';

/*
 * DECISION 3 — a conference must READ correctly on every call-history surface.
 *
 * ─── WHY THESE TESTS EXIST ────────────────────────────────────────────────
 *
 * A conference is ONE call that gained people. The schema says so exactly:
 * tbl_job_caller_info keeps ONE row per call, while each LEG is a
 * tbl_plivo_call_log row sharing that call's job_caller_info_id plus a
 * conference_id and a participant_role.
 *
 * That makes job_caller_info_id genuinely 1:N for the first time, and it puts
 * two opposite failure modes one line of SQL apart:
 *
 *   1. FAN-OUT. GET /api/admin/calls INNER JOINs the call log. Unrestricted, a
 *      3-party conference comes back as THREE near-identical rows — same jci id
 *      (so React sees duplicate keys), same duration, same recording — and
 *      `total` reads 3. Every count built on that endpoint inflates: the Click
 *      To Call tab's pagination, its "N calls" figure, the per-job tooltip.
 *      Worse, it is FILTER-DEPENDENT: with hasAnalysis or minScore set, the
 *      WHERE only matches the operator's leg and the fan-out silently vanishes,
 *      so the bug appears and disappears depending on which filter is on.
 *   2. LOST DETAIL. Collapse to one row and stop there, and the technician who
 *      was conferenced in becomes invisible — which is exactly what the owner
 *      asked to fix ("an info tooltip on each jobId showing the complete call
 *      history for the job — make sure we handle all according to the
 *      conference call flow").
 *
 * The shipped answer is BOTH: one row per call (counts untouched) with the legs
 * nested on it (detail not lost). These tests pin both halves, plus the
 * property that makes the fix safe — `conference_id IS NULL` is true for every
 * 1:1 call and every row written before this feature, so the restricted join
 * selects precisely what the unrestricted one did for all historical data.
 *
 * Non-destructive: fake pool, no real DB, no provider call. The REAL express
 * router and the REAL QuickSight service are exercised; nothing is
 * re-implemented. Runner: `npm test` / `node --test`.
 */

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { installFakePool } = require('./helpers/fake-pool');

/* ───────────────────── the numbers under test ──────────────────────────── */

// Real digits live ONLY in fixtures. No response may contain one.
const CUSTOMER_MOBILE = '9812345678';
const TECH_MOBILE = '9834567890';
const ALL_REAL_NUMBERS = [CUSTOMER_MOBILE, TECH_MOBILE];

const JOB_ID = 482491;
const CONF_ID = 77;
const JCI_CONF = 5001;      // the ONE audit row of the 3-party conference
const JCI_PLAIN = 5002;     // an ordinary 1:1 call

/* ───────────────────────── mutable fake DB ─────────────────────────────── */

const S = {
  total: 0,
  rows: [],
  legs: [],
  jobParties: [],
  detailRows: [],
  detailLegs: [],
};

/*
 * One page row, as the GET / projection returns it. `leg_id` / `conference_id`
 * / `participant_role` are the three columns the primary-leg join added.
 */
function callRow(over = {}) {
  return {
    id: JCI_PLAIN,
    job_id: JOB_ID,
    unique_id: 'cu-plain',
    caller: '919867890123',
    caller_id: 12,
    caller_name: 'Ops Tester',
    receiver: `91${CUSTOMER_MOBILE}`,
    receiver_id: 3001,
    receiver_name: 'Test Customer',
    call_type: 'OUT',
    start_time: '2026-08-04 15:00:05',
    end_time: '2026-08-04 15:04:00',
    duration: 235,
    caller_status: 'completed',
    receiver_status: null,
    recording: 'CallRecordings/5002',
    location: null,
    provider: 'plivo',
    inserted_time: '2026-08-04 15:00:00',
    is_updated: 1,
    leg_id: 8001,
    conference_id: null,
    participant_role: null,
    ...over,
  };
}

/*
 * A LEG, as loadConferenceLegs' projection returns it.
 *
 * ⚠ `dialed_number` IS DELIBERATELY PRESENT and is the point of the masking
 * assertions. The real projection never selects it — only
 * LEFT(RIGHT(dialed_number,10),4) AS number_prefix — but the fake pool does not
 * execute SQL, so the fixture hands the route a row that DOES contain a real
 * number. If the leg mapper ever degrades to `{ ...row }`, the number reaches
 * the response and the scan below fails. A fixture without it proves nothing.
 */
function legRow(over = {}) {
  return {
    id: 8001,
    conference_id: CONF_ID,
    job_caller_info_id: JCI_CONF,
    participant_role: 'operator',
    display_name: 'Test Customer',
    number_prefix: '9812',
    dialed_number: `91${CUSTOMER_MOBILE}`,
    status: 'answered',
    hangup_cause: null,
    call_flow: 'job',
    initiated_on: '2026-08-04 15:00:00',
    answered_on: '2026-08-04 15:00:05',
    ended_on: '2026-08-04 15:04:00',
    duration: 235,
    ...over,
  };
}

/*
 * ⚠ ROUTE ORDER AND SPECIFICITY MATTER — first regex wins, and the CRM page
 * query and the QuickSight drill-down BOTH begin `SELECT jci.job_caller_info AS
 * id,`. Matching on that shared prefix would silently feed one query the
 * other's fixture, so each is keyed on a column only IT projects: `jci.is_updated`
 * for the CRM list, `AS receiverName` for the drill-down.
 */
const fake = installFakePool([
  // Column probes. `information_schema` answers hasConferenceColumns(); the
  // SHOW COLUMNS probes answer the transcription / analysis column guards.
  [/information_schema\.columns/i, () => [{ 1: 1 }]],
  [/SHOW COLUMNS FROM tbl_plivo_call_log/i, () => [{ Field: 'x' }]],

  [/SELECT COUNT\(\*\) AS total FROM tbl_job_caller_info/i, () => [{ total: S.total }]],
  [/jci\.is_updated/i, () => S.rows],

  // The batch leg read added by decision 3 (GET /admin/calls).
  [/FROM tbl_plivo_call_log\s+WHERE conference_id IN/i, () => S.legs],
  // …and the QuickSight drill-down's own leg read.
  [/FROM tbl_plivo_call_log\s+WHERE conference_id IS NOT NULL/i, () => S.detailLegs],

  // The QuickSight per-call drill-down.
  [/AS receiverName/i, () => S.detailRows],

  // resolveJobParties, for the job-scoped labelling.
  [/FROM tbl_job j/i, () => S.jobParties],
]);

/* ───────────────────────── app under test ──────────────────────────────── */

const callsRouter = require('../routes/admin/calls');
const qs = require('../services/quicksight/quicksight-call-tracking.service');
const plivoLog = require('../services/plivo-call-log.service');

/*
 * hasConferenceColumns() caches its answer for the life of the process (it is a
 * schema probe, and re-running it per request would be a query per request). So
 * the pre-migration case cannot be simulated by changing what the fake pool
 * returns — by then the probe has already resolved. Both call sites read it as
 * a PROPERTY at call time, so swapping the function is the honest seam.
 */
async function withoutConferenceColumns(fn) {
  const real = plivoLog.hasConferenceColumns;
  plivoLog.hasConferenceColumns = async () => false;
  try { return await fn(); } finally { plivoLog.hasConferenceColumns = real; }
}

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  // Stand-in for routes/admin/index.js. GET / carries no permission middleware
  // of its own (it is history, not an action), so req.user is all it needs.
  app.use((req, _res, next) => { req.user = { user_id: 12, user_name: 'Ops Tester', user_role: 2 }; next(); });
  app.use('/calls', callsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => { res.status(500).json({ success: false, error: String(err && err.message) }); });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  fake.restore();
});

beforeEach(() => {
  fake.reset();
  S.total = 0;
  S.rows = [];
  S.legs = [];
  S.jobParties = [];
  S.detailRows = [];
  S.detailLegs = [];
});

/* ────────────────────────────── helpers ────────────────────────────────── */

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

const sqlMatching = (re) => fake.calls.filter((c) => re.test(c.sql));

/*
 * Leak scan over a subtree, at any depth, under any key.
 *
 * ⚠ SCOPED TO THE NEW MATERIAL ON PURPOSE. The top-level `caller` / `receiver`
 * columns of GET /admin/calls are the raw legacy tbl_job_caller_info columns and
 * have always been masked one layer up, by the maskMobile middleware that
 * routes/admin/index.js mounts on the whole group (they are MOBILE_FIELDS keys).
 * This app deliberately does NOT mount it — the point is to prove the LEGS mask
 * structurally, on their own, rather than leaning on that safety net. Asserting
 * over the whole body would only re-test the middleware, and would fail on
 * behaviour this change never touched.
 */
function assertNoUnmaskedNumbers(subtree) {
  const text = JSON.stringify(subtree);
  for (const num of ALL_REAL_NUMBERS) {
    assert.ok(!text.includes(num), `leaked the unmasked number ${num}\n${text}`);
  }
}

/*
 * The three legs of one conference: the operator's own leg (which IS the
 * call-history row), the customer dialled into the room, and the technician
 * conferenced in afterwards. All three share JCI_CONF.
 */
function threeLegs() {
  return [
    legRow({ id: 8001, participant_role: 'operator' }),
    legRow({ id: 8002, participant_role: 'customer', display_name: 'Test Customer' }),
    legRow({
      id: 8003,
      participant_role: 'technician',
      display_name: 'Ravi Kumar',
      number_prefix: '9834',
      dialed_number: `91${TECH_MOBILE}`,
      duration: 120,
    }),
  ];
}

/* ═════════ 1. THE COUNT — a conference is ONE call, not three ═══════════ */

test('the call-log join is restricted to the PRIMARY leg, on BOTH the count and the page', async () => {
  S.total = 1;
  S.rows = [callRow({ id: JCI_CONF, conference_id: CONF_ID, participant_role: 'operator' })];
  S.legs = threeLegs();

  const res = await get('/calls?page=1&limit=20');
  assert.equal(res.status, 200);

  /*
   * THE PREDICATE, on both statements. If it were on the page only, the count
   * would say 3 above a single row; if on the count only, the page would show
   * three copies of one call under a total of 1. Both are worse than either
   * bug alone, which is why this asserts the pair rather than one of them.
   */
  const countSql = sqlMatching(/SELECT COUNT\(\*\) AS total FROM tbl_job_caller_info/i);
  const pageSql = sqlMatching(/SELECT jci\.job_caller_info AS id/i);
  assert.equal(countSql.length, 1);
  assert.equal(pageSql.length, 1);
  for (const c of [countSql[0], pageSql[0]]) {
    assert.match(
      c.sql,
      /pcl\.conference_id IS NULL OR pcl\.participant_role = 'operator'/i,
      'without this a 3-party conference fans out into three rows and total reads 3',
    );
  }

  // ONE row for the call, and the total the FE paginates on is the call count.
  assert.equal(res.body.data.items.length, 1);
  assert.equal(res.body.data.total, 1, 'a 3-party conference is ONE call wherever a count is shown');
  assert.equal(res.body.data.items[0].id, JCI_CONF);
});

test('the predicate is true for every 1:1 call, so no historical count moves', async () => {
  /*
   * The safety property behind the whole fix. Every row written before this
   * feature — and every ordinary click-to-call since — has conference_id NULL,
   * so `conference_id IS NULL OR participant_role = 'operator'` selects exactly
   * what the unrestricted join selected. This is the absence of a count change,
   * not a count change dressed up as a fix.
   */
  S.total = 1;
  S.rows = [callRow()];   // conference_id: null

  const res = await get('/calls?page=1&limit=20');
  assert.equal(res.body.data.total, 1);
  assert.equal(res.body.data.items.length, 1);
  assert.equal(res.body.data.items[0].is_conference, false);
  assert.equal(res.body.data.items[0].leg_count, 0);
  assert.deepEqual(res.body.data.items[0].legs, []);

  // …and the leg read is not issued at all: no conference on the page, no query.
  assert.equal(sqlMatching(/WHERE conference_id IN/i).length, 0,
    'an ordinary page must not pay for a query about conferences it does not contain');
});

test('a pre-migration environment behaves exactly as it did before conferences existed', async () => {
  // The conference columns do not exist yet. Naming them in the ON clause would
  // make EVERY call-history request 500 — a far worse regression than not
  // having conferences.
  S.total = 1;
  S.rows = [callRow()];

  const res = await withoutConferenceColumns(() => get('/calls?page=1&limit=20'));
  assert.equal(res.status, 200);
  for (const c of sqlMatching(/tbl_job_caller_info jci/i)) {
    assert.doesNotMatch(c.sql, /conference_id|participant_role/i,
      'no conference column may be named pre-migration, on the count or the page');
  }
  assert.equal(res.body.data.items[0].leg_count, 0);
  assert.equal(sqlMatching(/WHERE conference_id IN/i).length, 0);
});

/* ══════ 2. THE DETAIL — the extra legs, labelled by participant_role ════ */

test('a conference carries its legs as nested detail, each labelled by role', async () => {
  S.total = 1;
  S.rows = [callRow({ id: JCI_CONF, conference_id: CONF_ID, participant_role: 'operator', leg_id: 8001 })];
  S.legs = threeLegs();

  const res = await get('/calls?page=1&limit=20');
  const [row] = res.body.data.items;

  assert.equal(row.is_conference, true);
  assert.equal(row.leg_count, 3);
  assert.equal(row.legs.length, 3);

  /*
   * THE LABELS ARE THE POINT. Every leg of this call shares one
   * tbl_job_caller_info row, so jci.reciever is IDENTICAL on all three — a
   * classifier reading it would label the technician "Customer". These labels
   * come from each leg's OWN participant_role instead.
   */
  assert.deepEqual(row.legs.map((l) => l.party_role), ['Operator', 'Customer', 'Technician']);
  assert.equal(row.legs[2].display_name, 'Ravi Kumar',
    'the conferenced-in technician is named, not inherited from the original receiver');

  /*
   * is_primary marks the leg that IS this row, so a consumer can render "and 2
   * others" without double-counting the call it is already showing. It is why
   * the operator's leg is included at all: dropping it would make the array
   * read as the whole room when it is the room minus one.
   */
  assert.deepEqual(row.legs.map((l) => l.is_primary), [true, false, false]);
});

test('legs carry MASKED numbers only — never the digits, at any depth', async () => {
  S.total = 1;
  S.rows = [callRow({ id: JCI_CONF, conference_id: CONF_ID, participant_role: 'operator' })];
  S.legs = threeLegs();

  const res = await get('/calls?page=1&limit=20');

  // The scan that matters: the leg fixtures CARRY dialed_number, so a mapper
  // that spread the row would fail right here.
  assertNoUnmaskedNumbers(res.body.data.items[0].legs);

  // …and prove the assertion is not vacuous — the masked forms ARE present, so
  // the tooltip is still usable for recognition.
  const text = JSON.stringify(res.body.data.items[0].legs);
  assert.ok(text.includes('9812••••••'), 'the masked form is what the operator sees');
  assert.ok(text.includes('9834••••••'), 'including for the conferenced-in technician');
  assert.ok(!text.includes('dialed_number'), 'the column name must not even appear');
});

test('per-leg status is the call log\'s own vocabulary, so a leg reads like any other Plivo leg', async () => {
  S.total = 1;
  S.rows = [callRow({ id: JCI_CONF, conference_id: CONF_ID, participant_role: 'operator' })];
  S.legs = threeLegs().concat([
    legRow({ id: 8004, participant_role: 'job_spoc', display_name: 'Client SPOC', status: 'no_answer', duration: null }),
  ]);

  const res = await get('/calls?page=1&limit=20');
  const statuses = res.body.data.items[0].legs.map((l) => l.status);
  assert.deepEqual(statuses, ['answered', 'answered', 'answered', 'no_answer'],
    "ops must be able to tell 'nobody picked up' from 'they hung up', on a leg as on a call");
});

test('the job-scoped ROW label still describes the CALL, not the operator leg', async () => {
  /*
   * The subtlest thing in this change. The row is the CALL, so its party is
   * derived from jci.reciever — the number originally dialled. The primary
   * leg's participant_role is 'operator', which describes OUR side of the call:
   * preferring it here would label every single call "Operator".
   */
  S.total = 1;
  S.rows = [callRow({ id: JCI_CONF, conference_id: CONF_ID, participant_role: 'operator' })];
  S.legs = threeLegs();
  S.jobParties = [{
    customer_mob_no: CUSTOMER_MOBILE,
    customer_name: 'Test Customer',
    additional_number: null,
    additional_name: null,
    client_spoc: null,
    client_spoc_name: null,
    technician_mob: TECH_MOBILE,
    technician_name: 'Ravi Kumar',
  }];

  const res = await get(`/calls?jobId=${JOB_ID}&page=1&limit=20`);
  const [row] = res.body.data.items;
  assert.equal(row.party_role, 'Customer', 'the call was with the customer');
  assert.equal(row.party_name, 'Test Customer');
  // …while the legs keep their own, finer labels.
  assert.deepEqual(row.legs.map((l) => l.party_role), ['Operator', 'Customer', 'Technician']);
  assertNoUnmaskedNumbers(row.legs);
});

/* ═══ 3. QUICKSIGHT DRILL-DOWN — legs reachable, rows still reconcilable ══ */

test('the QuickSight per-call drill-down returns ONE row per call with nested legs', async () => {
  S.detailRows = [{
    id: JCI_CONF,
    jobId: JOB_ID,
    callAt: '2026-08-04 15:00:00',
    callerUserId: 12,
    callerName: 'Ops Tester',
    receiverName: 'Test Customer',
    partyRole: 'Customer',
    jobStatusAtCall: 1,
    assignedFlag: 1,
    durationSecs: 235,
    provider: 'plivo',
    callerStatus: 'completed',
    recordingFlag: 1,
  }];
  S.detailLegs = [
    { callId: JCI_CONF, legId: 8001, conferenceId: CONF_ID, role: 'operator', name: 'Test Customer', status: 'answered', duration: 235, joinedAt: null, leftAt: null },
    { callId: JCI_CONF, legId: 8002, conferenceId: CONF_ID, role: 'customer', name: 'Test Customer', status: 'answered', duration: 230, joinedAt: null, leftAt: null },
    { callId: JCI_CONF, legId: 8003, conferenceId: CONF_ID, role: 'technician', name: 'Ravi Kumar', status: 'answered', duration: 120, joinedAt: null, leftAt: null },
  ];

  const out = await qs.getCallDetails({ dateFrom: '2026-08-04', dateTo: '2026-08-04' }, { jobId: JOB_ID });

  /*
   * ONE row. The header of quicksight-call-tracking.service.js makes
   * reconciliation with the summary a hard invariant, so legs are NESTED —
   * flattening them into extra top-level rows would make the drill-down
   * disagree with the count it was opened from.
   */
  assert.equal(out.items.length, 1);
  const [item] = out.items;
  assert.equal(item.isConference, true);
  assert.equal(item.legCount, 3);
  assert.equal(item.conferenceId, CONF_ID);
  assert.deepEqual(item.legs.map((l) => l.partyRole), ['Operator', 'Customer', 'Technician']);
  assert.equal(item.legs[2].name, 'Ravi Kumar');
});

test('the drill-down leg read returns NO number at all — not even a masked prefix', async () => {
  S.detailRows = [{
    id: JCI_CONF, jobId: JOB_ID, callAt: '2026-08-04 15:00:00', callerUserId: 12,
    callerName: 'Ops Tester', receiverName: 'Test Customer', partyRole: 'Customer',
    jobStatusAtCall: 1, assignedFlag: 1, durationSecs: 235, provider: 'plivo',
    callerStatus: 'completed', recordingFlag: 1,
  }];
  // The fixture carries digits the projection must never have selected.
  S.detailLegs = [{
    callId: JCI_CONF, legId: 8003, conferenceId: CONF_ID, role: 'technician',
    name: 'Ravi Kumar', status: 'answered', duration: 120, joinedAt: null, leftAt: null,
    dialed_number: `91${TECH_MOBILE}`, receiver_number: `91${TECH_MOBILE}`,
  }];

  const out = await qs.getCallDetails({ dateFrom: '2026-08-04', dateTo: '2026-08-04' }, { jobId: JOB_ID });

  /*
   * This report's contract is STRICTER than the CRM's: it feeds an export and a
   * chart, so it returns names and derived roles only — no number, masked or
   * otherwise. The SQL is the guarantee; this asserts the mapper does not
   * reintroduce one by spreading the row.
   */
  assertNoUnmaskedNumbers(out);

  const legSql = sqlMatching(/FROM tbl_plivo_call_log\s+WHERE conference_id IS NOT NULL/i);
  assert.equal(legSql.length, 1, 'ONE batch query for the whole page, never one per row');
  assert.doesNotMatch(legSql[0].sql, /dialed_number|receiver_number/i,
    'the projection must not select a number column at all');
});

test('an ordinary 1:1 call in the drill-down gets an empty legs array, never null', async () => {
  S.detailRows = [{
    id: JCI_PLAIN, jobId: JOB_ID, callAt: '2026-08-04 15:00:00', callerUserId: 12,
    callerName: 'Ops Tester', receiverName: 'Test Customer', partyRole: 'Customer',
    jobStatusAtCall: 1, assignedFlag: 0, durationSecs: 60, provider: 'plivo',
    callerStatus: 'completed', recordingFlag: 0,
  }];
  S.detailLegs = [];

  const out = await qs.getCallDetails({ dateFrom: '2026-08-04', dateTo: '2026-08-04' }, {});
  const [item] = out.items;
  // Shape is constant so a consumer branches on isConference, never on shape.
  assert.deepEqual(item.legs, []);
  assert.equal(item.legCount, 0);
  assert.equal(item.isConference, false);
  assert.equal(item.conferenceId, null);
});
