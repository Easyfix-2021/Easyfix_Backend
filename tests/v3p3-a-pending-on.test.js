'use strict';
/*
 * V3 Phase 3 — "pending on" (services/job-pending-on.js), the ONE function the
 * ops desk and the technician app both read, plus the schema facts it rests on.
 *
 * What fails silently if these go:
 *   · a precedence swap — every rule still "works", the desk and the phone just
 *     show the wrong owner for the jobs where two rules overlap;
 *   · a per-row query — correct answers, 200 queries per list page;
 *   · the dedupe predicate drifting from OPEN_STATUSES — the index stops
 *     enforcing the rule the service thinks it enforces;
 *   · a migration column missing from schema-verify EXPECTED — the boot gate
 *     guards nothing for the new tables.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');
const { readMigration } = require('./helpers/migration-file');

const fake = installFakePool([
  [/FROM tbl_job_tx_report/i, (_sql, params) => REPORTS.filter((r) => params[0].includes(r.job_id))],
  [/FROM tbl_job j\s+LEFT JOIN tbl_job_verification/i, (_sql, params) => FACTS.filter((f) => params[params.length - 1].includes(f.job_id))],
]);
let REPORTS = [];
let FACTS = [];

const { pendingOnForJobs, _internals: { decide } } = require('../services/job-pending-on');
const txReports = require('../services/job-tx-report.service');
const { _internals: sv } = require('../scripts/schema-verify');

const d = (job_status, facts = {}, reports = []) => decide({ job_status }, facts, reports);
const r = (kind, status = 'open', extra = {}) => ({ kind, status, ...extra });

/* ─── Each rule, in isolation ────────────────────────────────────────── */

test('every rule answers with its own owner, code and band', () => {
  const cases = [
    [d(2, {}, [r('help', 'open', { reason_code: 'gate' })]), ['easyfix', 'help', 'A', 'help:gate']],
    [d(2, {}, [r('cant_complete')]), ['easyfix', 'verify_claim', 'D', 'cant_complete']],
    [d(1, { cancel_request: 1 }), ['easyfix', 'verify_claim', 'D', 'cancel_request']],
    [d(1, { reschedule_request: 1 }), ['easyfix', 'reschedule_request', 'D', 'reschedule_request']],
    [d(2, {}, [r('additional_work')]), ['easyfix', 'pricing', 'A', 'additional_work_reported']],
    [d(15), ['client', 'client_approval', 'B', 'estimate_with_client']],
    [d(2, {}, [r('additional_work', 'returned')]), ['technician', 'resend_photos', 'A', 'additional_work_returned']],
    [d(16), ['easyfix', 'material_review', 'A', 'material_review']],
    [d(2, { site_access: 1 }), ['client', 'site_access', 'B', 'site_access']],
    [d(3), ['easyfix', 'audit', 'C', 'submitted_for_audit']],
    [d(5, { verified_on: '2026-09-24 10:00:00', qc_status: 'pending' }), ['client', 'client_qc', 'C', 'client_qc']],
    [d(2), ['technician', 'working', 'A', 'working']],
    [d(1), ['technician', 'not_started', null, 'not_started']],
    [d(0), ['technician', 'not_started', null, 'not_started']],
  ];
  for (const [got, [pendingOn, waitingFor, band, situation]] of cases) {
    assert.deepEqual(got, { pendingOn, waitingFor, band, situation });
  }
});

test('the cases the spec list has no line for do not fall through to "technician · not started"', () => {
  // Client disputed: a claim against finished work — the desk's, band D.
  assert.deepEqual(d(3, { verified_on: 'x', qc_status: 'disputed' }),
    { pendingOn: 'easyfix', waitingFor: 'audit', band: 'D', situation: 'qc_disputed' });
  // QC passed / auto, cancelled: nobody is waiting on anybody.
  for (const got of [d(3, { verified_on: 'x', qc_status: 'passed' }), d(10, { verified_on: 'x', qc_status: 'auto' }), d(6)]) {
    assert.equal(got.pendingOn, null);
    assert.equal(got.situation, 'closed');
  }
});

test('"he has left" rides on the situation of an in-flight additional-work claim', () => {
  const left = [r('additional_work', 'open', { left_site_on: '2026-09-24 13:40:00' })];
  assert.equal(d(2, {}, left).situation, 'additional_work_reported_left');
  assert.equal(d(15, {}, [r('additional_work', 'priced', { left_site_on: 'x' })]).situation, 'estimate_with_client_left');
});

/* ─── Precedence: the prototype's renderDesk() order ─────────────────── */

test('precedence — the higher rule wins every overlap, in renderDesk order', () => {
  // help beats a claim beats pricing beats the client beats work in progress.
  assert.equal(d(2, { cancel_request: 1 }, [r('help', 'open', { reason_code: 'unsafe' }), r('cant_complete')]).waitingFor, 'help');
  assert.equal(d(2, { reschedule_request: 1 }, [r('cant_complete'), r('additional_work')]).waitingFor, 'verify_claim');
  assert.equal(d(1, { cancel_request: 1, reschedule_request: 1 }).waitingFor, 'verify_claim');
  assert.equal(d(1, { reschedule_request: 1 }, [r('additional_work')]).waitingFor, 'reschedule_request');
  assert.equal(d(15, {}, [r('additional_work')]).waitingFor, 'pricing', 'an unpriced report is the desk\'s even at 15');
  assert.equal(d(15, {}, [r('additional_work', 'returned')]).waitingFor, 'client_approval');
  assert.equal(d(16, {}, [r('additional_work', 'returned')]).waitingFor, 'resend_photos');
  assert.equal(d(16, { site_access: 1 }).waitingFor, 'material_review');
  assert.equal(d(3, { site_access: 1 }).waitingFor, 'site_access');
  assert.equal(d(2, { site_access: 1 }).waitingFor, 'site_access', 'a gate pass outranks "working"');
});

test('a PRICED report whose job has left 15 is not "waiting for the client" forever', () => {
  // The client approved (15 → 1, report may still say priced) — derive, don't trust the flag.
  assert.equal(d(1, {}, [r('additional_work', 'priced')]).waitingFor, 'not_started');
  assert.equal(d(2, {}, [r('additional_work', 'priced')]).waitingFor, 'working');
});

/* ─── The batch: fixed query budget, CRM predicate for the requests ──── */

test('two queries for ONE job and two for FIFTY — never per row', async () => {
  for (const n of [1, 50]) {
    fake.reset();
    const rows = Array.from({ length: n }, (_, i) => ({ job_id: 1000 + i, job_status: 2, checkin_date_time: 'x' }));
    const out = await pendingOnForJobs(require('../db').pool, rows);
    assert.equal(out.size, n, 'every job gets an answer');
    assert.equal(fake.calls.length, 2, `${n} job(s) must cost exactly two queries`);
  }
  fake.reset();
  assert.equal((await pendingOnForJobs(require('../db').pool, [])).size, 0);
  assert.equal(fake.calls.length, 0, 'an empty page costs nothing');
});

test('the request flags are read with the CRM queue\'s own predicate (status 1 AND flag)', async () => {
  fake.reset();
  REPORTS = [{ job_id: 7, kind: 'help', status: 'open', reason_code: 'colour' }];
  FACTS = [{ job_id: 8, cancel_request: 1 }, { job_id: 9, site_access: 1 }];
  const out = await pendingOnForJobs(require('../db').pool, [
    { job_id: 7, job_status: 2 }, { job_id: 8, job_status: 1 }, { job_id: 9, job_status: 2 },
  ]);
  const factsCall = fake.calls.find((c) => /LEFT JOIN tbl_job_verification/.test(c.sql));
  assert.ok(factsCall, 'the facts query must have run');
  assert.match(factsCall.sql, /\(j\.job_status = \? AND COALESCE\(j\.is_cancelled_by_app, 0\) = 1\) AS cancel_request/);
  assert.match(factsCall.sql, /\(j\.job_status = \? AND COALESCE\(j\.is_rescheduled_by_app, 0\) = 1\) AS reschedule_request/);
  assert.deepEqual(factsCall.params.slice(0, 3), [1, 1, 'requested'], 'status 1 for both asks, then the open permission status');
  assert.equal(out.get(7).situation, 'help:colour');
  assert.equal(out.get(8).waitingFor, 'verify_claim');
  assert.equal(out.get(9).waitingFor, 'site_access');
  REPORTS = []; FACTS = [];
});

/* ─── Schema: the index predicate, EXPECTED, REQUIRED_INDEXES ────────── */

const SQL = readMigration('2026-09-24-v3-phase3-tables.sql');

function createdColumns(table) {
  const m = SQL.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\) ENGINE`));
  assert.ok(m, `${table} must be created by the migration`);
  return m[1].split('\n').map((l) => l.trim())
    .filter((l) => /^[a-z_]+\s/.test(l) && !/^(PRIMARY|KEY|UNIQUE)\b/i.test(l))
    .map((l) => l.split(/\s+/)[0]);
}

test('the generated dedupe key covers EXACTLY the service\'s OPEN_STATUSES', () => {
  const m = SQL.match(/open_dedupe_key\s+VARCHAR\(64\) AS \(IF\(status IN \(([^)]*)\)/);
  assert.ok(m, 'tbl_job_tx_report must carry the generated open_dedupe_key');
  const inIndex = m[1].split(',').map((s) => s.trim().replace(/'/g, '')).sort();
  assert.deepEqual(inIndex, [...txReports.OPEN_STATUSES].sort());
  assert.match(SQL, /UNIQUE KEY uq_jtr_open \(open_dedupe_key\)/);
  assert.match(SQL, /UNIQUE KEY uq_jc_client \(job_id, client_msg_id\)/);
  const statements = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.match(statements, /CREATE TABLE IF NOT EXISTS tbl_job_chat/, 'the comment filter must leave the statements');
  assert.doesNotMatch(statements, /@\w+\s*:?=|PREPARE|DEFAULT CURRENT_TIMESTAMP/i, 'house style: plain statements, no DB-clock default');
});

test('schema-verify EXPECTED lists every column the migration creates, and both unique keys', () => {
  const tables = ['tbl_job_tx_report', 'tbl_job_chat', 'tbl_job_verification', 'tbl_client_qc_timing'];
  let seen = 0;
  for (const t of tables) {
    const cols = createdColumns(t);
    assert.ok(cols.length >= 4, `${t}: the column parser must find the columns (found ${cols.length})`);
    assert.deepEqual([...sv.EXPECTED[t]].sort(), [...cols].sort(), `${t}: EXPECTED must match the CREATE`);
    seen += cols.length;
  }
  assert.equal(seen, 20 + 8 + 10 + 4, 'denominator: 42 columns across the four tables');
  const req = sv.REQUIRED_INDEXES;
  assert.ok(req.some((i) => i.table === 'tbl_job_tx_report' && i.unique && i.columns.join() === 'open_dedupe_key' && i.impact));
  assert.ok(req.some((i) => i.table === 'tbl_job_chat' && i.unique && i.columns.join() === 'job_id,client_msg_id' && i.impact));
});
