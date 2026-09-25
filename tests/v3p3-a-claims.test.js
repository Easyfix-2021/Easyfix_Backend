'use strict';
/*
 * V3 Phase 3 — the technician's on-site claims (services/mobile-job-claims
 * .service.js, job-tx-report, job-chat, job-incentive reverseVisitCharge).
 *
 * The fake DB below is STATEFUL: tx_report rows honour the generated
 * open_dedupe_key's UNIQUE rule (a second open row per job+kind throws
 * ER_DUP_ENTRY, as MySQL does), job_material honours awardOnce's NOT EXISTS,
 * and the ledger's "posted" tables can be switched on. So "idempotent" and
 * "paid once" are proven against the constraint, not against a mock that
 * returns whatever the test wanted.
 *
 * Each rule here fails SILENTLY in production when broken: a second claim, a
 * second ₹250, a ₹250 taken back after the wallet has it, a checked-in man
 * dropped to "Start job" by an undo, a chat line posted twice.
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { installFakePool } = require('./helpers/fake-pool');

/* ─── The in-memory tables ───────────────────────────────────────────── */
let JOB; let REPORTS; let IMAGES; let MATERIAL; let POSTED; let LOGS; let CHAT; let hideOpenReads;
const OPEN = ['open', 'priced', 'returned'];
const dup = () => Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });

function reset() {
  JOB = { job_id: 42, job_status: 2, fk_easyfixter_id: 7, checkin_date_time: '2026-09-24 11:00:00', is_cancelled_by_app: 0 };
  REPORTS = []; MATERIAL = []; LOGS = []; CHAT = []; POSTED = false; hideOpenReads = 0;
  IMAGES = [
    { image_id: 501, job_id: 42, image_category: 'checkin' },
    { image_id: 502, job_id: 42, image_category: 'checkin' },
    { image_id: 601, job_id: 42, image_category: 'proof' },
    { image_id: 602, job_id: 42, image_category: 'proof' },
    { image_id: 701, job_id: 99, image_category: 'proof' },   // another job's proof
    { image_id: 503, job_id: 42, image_category: 'booking' },  // the CUSTOMER's photo
  ];
}
reset();

const reportById = (id) => REPORTS.find((r) => r.id === Number(id));
const openOf = (jobId, kind) => REPORTS.filter((r) => r.job_id === Number(jobId) && r.kind === kind && OPEN.includes(r.status));

const fake = installFakePool([
  // getOwnedJob
  [/SELECT job_id, job_status, fk_easyfixter_id, fk_customer_id/, (_s, [id]) => (Number(id) === JOB.job_id ? [JOB] : [])],
  // lookup: cannot-complete (26) and app-cancel (27)
  [/FROM action_taken_reason/, (_s, [type]) => (type === 26
    ? [{ id: 262, reason: 'Product damaged' }, { id: 263, reason: 'Site not ready' }]
    : [{ id: 267, reason: 'Customer want Cancellation' }])],
  [/SELECT image_id FROM tbl_job_image WHERE job_id = \? AND image_id IN \(\?\) AND image_category = \?/,
    (_s, [jobId, ids, cat]) => IMAGES.filter((i) => i.job_id === jobId && ids.includes(i.image_id) && i.image_category === cat)],
  [/SELECT image_id FROM tbl_job_image\s+WHERE job_id = \? AND image_category IN \(\?\)/,
    (_s, [jobId, cats]) => IMAGES.filter((i) => i.job_id === jobId && cats.includes(i.image_category)).sort((a, b) => b.image_id - a.image_id)],
  // tx_report reads
  [/FROM tbl_job_tx_report\s+WHERE job_id = \? AND kind = \? AND status IN \(\?\)/, (_s, [jobId, kind]) => {
    if (hideOpenReads > 0) { hideOpenReads -= 1; return []; }
    return openOf(jobId, kind).slice(-1);
  }],
  [/FROM tbl_job_tx_report WHERE id = \?/, (_s, [id]) => [reportById(id)].filter(Boolean)],
  [/FROM tbl_job_tx_report\s+WHERE job_id = \? AND status IN \(\?\)/,
    (_s, [jobId, statuses]) => REPORTS.filter((r) => r.job_id === jobId && statuses.includes(r.status)).reverse()],
  [/INSERT INTO tbl_job_tx_report/, (_s, p) => {
    const [job_id, efr_id, kind, reason_code, reason_text, proof_image_ids, status, prev_job_status, reported_on] = p;
    if (openOf(job_id, kind).length) throw dup();          // uq_jtr_open
    const row = { id: REPORTS.length + 1, job_id, efr_id, kind, reason_code, reason_text, proof_image_ids, status,
      prev_job_status, reported_on, visit_charge_awarded: 0, booked_meanwhile: null, left_site_on: null };
    REPORTS.push(row);
    return { insertId: row.id, affectedRows: 1 };
  }],
  [/UPDATE tbl_job_tx_report SET status = \?, resolved_on = \?\s+WHERE id = \? AND status IN/, (_s, [st, , id, from]) => {
    const r = reportById(id);
    if (!r || !from.includes(r.status)) return { affectedRows: 0 };
    r.status = st; return { affectedRows: 1 };
  }],
  [/UPDATE tbl_job_tx_report SET visit_charge_awarded = \?/, (_s, [v, id]) => { reportById(id).visit_charge_awarded = v; return { affectedRows: 1 }; }],
  [/UPDATE tbl_job_tx_report SET booked_meanwhile = \?/, (_s, [v, id]) => { reportById(id).booked_meanwhile = v; return { affectedRows: 1 }; }],
  [/UPDATE tbl_job_tx_report SET left_site_on = \? WHERE id = \? AND left_site_on IS NULL/, (_s, [at, id]) => {
    const r = reportById(id); if (r.left_site_on) return { affectedRows: 0 };
    r.left_site_on = at; return { affectedRows: 1 };
  }],
  [/UPDATE tbl_job_tx_report SET status = \?, proof_image_ids = \?, reported_on = \?\s+WHERE id = \? AND status = \?/, (_s, [st, csv, , id, from]) => {
    const r = reportById(id); if (r.status !== from) return { affectedRows: 0 };
    Object.assign(r, { status: st, proof_image_ids: csv }); return { affectedRows: 1 };
  }],
  [/UPDATE tbl_job_tx_report SET reason_code = \?, reason_text = \?, proof_image_ids = \?/, (_s, [code, text, csv, , id]) => {
    Object.assign(reportById(id), { reason_code: code, reason_text: text, proof_image_ids: csv }); return { affectedRows: 1 };
  }],
  // job_material — awardOnce's INSERT … WHERE NOT EXISTS, and the reversal
  [/INSERT INTO job_material/, (_s, p) => {
    const [jobId, reason, tx, cx] = p;
    if (MATERIAL.some((m) => m.job_id === jobId && m.reason === reason)) return { affectedRows: 0 };
    MATERIAL.push({ job_id: jobId, reason, tx_charge: tx, client_charge: cx }); return { affectedRows: 1 };
  }],
  [/SELECT EXISTS \(SELECT 1 FROM tbl_job_transaction/, () => [{ posted: POSTED ? 1 : 0 }]],
  [/DELETE FROM job_material/, (_s, [jobId, reason]) => {
    if (POSTED) return { affectedRows: 0 };
    const before = MATERIAL.length;
    MATERIAL = MATERIAL.filter((m) => !(m.job_id === jobId && m.reason === reason));
    return { affectedRows: before - MATERIAL.length };
  }],
  // undoCancel
  [/UPDATE tbl_job SET is_cancelled_by_app = 0, job_status = \?/, (_s, [back, jobId, efrId, pending]) => {
    if (jobId !== JOB.job_id || efrId !== JOB.fk_easyfixter_id || JOB.job_status !== pending || !JOB.is_cancelled_by_app) return { affectedRows: 0 };
    Object.assign(JOB, { job_status: back, is_cancelled_by_app: 0 }); return { affectedRows: 1 };
  }],
  [/INSERT INTO tbl_job_logs/, (_s, p) => { LOGS.push({ logFor: p[0], oldData: p[1] }); return { insertId: LOGS.length }; }],
  // chat
  [/INSERT INTO tbl_job_chat/, (_s, [job_id, sender_kind, efr_id, user_id, body, client_msg_id, sent_on]) => {
    if (client_msg_id && CHAT.some((c) => c.job_id === job_id && c.client_msg_id === client_msg_id)) throw dup();
    const row = { id: CHAT.length + 1, job_id, sender_kind, efr_id, user_id, body, client_msg_id, sent_on };
    CHAT.push(row); return { insertId: row.id };
  }],
  [/FROM tbl_job_chat WHERE id = \?/, (_s, [id]) => CHAT.filter((c) => c.id === id)],
  [/FROM tbl_job_chat WHERE job_id = \? AND client_msg_id = \?/, (_s, [jobId, m]) => CHAT.filter((c) => c.job_id === jobId && c.client_msg_id === m)],
  [/FROM tbl_job_chat\s+WHERE job_id = \? AND id > \?/, (_s, [jobId, after, limit]) => CHAT.filter((c) => c.job_id === jobId && c.id > after).slice(0, limit)],
]);

const claims = require('../services/mobile-job-claims.service');
const chat = require('../services/job-chat.service');
const { REASON_VISIT } = require('../services/job-incentive.service');

beforeEach(() => { reset(); fake.reset(); });

const logsFor = (logFor) => LOGS.filter((l) => l.logFor === logFor);
const status = async (p) => { try { await p; return 200; } catch (e) { if (!e.status) throw e; return e.status; } };

/* ─── Additional work ────────────────────────────────────────────────── */

test('additional work: refused before check-in, and refused with no work-found photo', async () => {
  JOB.job_status = 1;
  assert.equal(await status(claims.reportAdditionalWork(42, 7)), 409);
  JOB.job_status = 2;
  IMAGES = IMAGES.filter((i) => i.image_category !== 'checkin');   // only the customer's booking photo left
  assert.equal(await status(claims.reportAdditionalWork(42, 7)), 422, 'the customer\'s photos are not his report');
  assert.equal(REPORTS.length, 0, 'neither refusal may leave a claim behind');
});

test('additional work: his photos ARE the report; a retry returns the SAME claim and logs once', async () => {
  const first = await claims.reportAdditionalWork(42, 7);
  assert.equal(first.created, true);
  assert.equal(REPORTS[0].proof_image_ids, '502,501', 'the work-found photos, newest first — never the customer\'s 503');
  const again = await claims.reportAdditionalWork(42, 7);
  assert.equal(again.created, false);
  assert.equal(again.report.id, first.report.id);
  assert.equal(REPORTS.length, 1);
  assert.equal(logsFor('additional work reported').length, 1);
  assert.equal(first.report.clientAmount, undefined, 'no client amount on the phone');
});

test('additional work: two taps that race past the read — the UNIQUE key decides, the loser gets the winner', async () => {
  await claims.reportAdditionalWork(42, 7);
  // The second request's TWO reads (the service's, then open()'s) both miss the
  // row the first just wrote — so only the INSERT's UNIQUE key can catch it.
  hideOpenReads = 2;
  const loser = await claims.reportAdditionalWork(42, 7);
  assert.equal(hideOpenReads, 0, 'both reads must have been hidden, or the race was never exercised');
  assert.equal(fake.calls.filter((c) => /INSERT INTO tbl_job_tx_report/.test(c.sql)).length, 2, 'the losing INSERT must have been attempted');
  assert.equal(loser.created, false);
  assert.equal(loser.report.id, REPORTS[0].id);
  assert.equal(REPORTS.length, 1, 'ER_DUP_ENTRY must resolve to the existing row, never a second one');
});

test('additional work: "send it again" re-opens the SAME returned claim and restarts it', async () => {
  await claims.reportAdditionalWork(42, 7);
  REPORTS[0].status = 'returned';
  REPORTS[0].return_note = 'Track photo not clear';
  const out = await claims.reportAdditionalWork(42, 7);
  assert.equal(REPORTS.length, 1);
  assert.equal(REPORTS[0].status, 'open');
  assert.equal(out.report.status, 'open');
  assert.equal(logsFor('additional work reported').length, 2, 'the resend is a history event too');
});

test('booked-meanwhile and leaving: recorded, a repeat is not a second history row', async () => {
  assert.equal(await status(claims.answerBooked(42, 7, 'yes')), 404, 'nothing to answer before a report');
  await claims.reportAdditionalWork(42, 7);
  await claims.answerBooked(42, 7, 'yes');
  await claims.answerBooked(42, 7, 'yes');
  await claims.answerBooked(42, 7, 'no');
  assert.deepEqual(logsFor('booked work meanwhile').map((l) => l.oldData), ['Answer: yes', 'Answer: no']);
  const a = await claims.leaveSite(42, 7);
  const b = await claims.leaveSite(42, 7);
  assert.ok(a.report.leftSiteOn);
  assert.equal(b.report.leftSiteOn, a.report.leftSiteOn, 'the first departure is the fact');
  assert.equal(logsFor('left site').length, 1);
});

test('checkout sees unresolved additional work (→ revisit) and stops seeing it once approved', async () => {
  assert.equal(await claims.hasUnresolvedAdditionalWork(42), false);
  await claims.reportAdditionalWork(42, 7);
  for (const s of ['open', 'priced', 'returned']) {
    REPORTS[0].status = s;
    assert.equal(await claims.hasUnresolvedAdditionalWork(42), true, `${s} is still waiting`);
  }
  REPORTS[0].status = 'approved';
  assert.equal(await claims.hasUnresolvedAdditionalWork(42), false);
});

/* ─── Can't complete + the ₹250 ──────────────────────────────────────── */

test('can\'t complete: an unknown reason, another job\'s photo, or a non-proof photo is refused', async () => {
  assert.equal(await status(claims.reportCantComplete(42, 7, { reasonId: 999, proofImageIds: [601] }, 7)), 400);
  assert.equal(await status(claims.reportCantComplete(42, 7, { reasonId: 262, proofImageIds: [701] }, 7)), 400);
  assert.equal(await status(claims.reportCantComplete(42, 7, { reasonId: 262, proofImageIds: [501] }, 7)), 400);
  assert.equal(await status(claims.reportCantComplete(42, 7, { reasonId: 262, proofImageIds: [] }, 7)), 400);
  assert.equal(REPORTS.length, 0);
  assert.equal(MATERIAL.length, 0);
});

test('can\'t complete on site: claim + ₹250 (tx 250 / client 250), flagged, logged — and a retry pays nothing more', async () => {
  const out = await claims.reportCantComplete(42, 7, { reasonId: 262, proofImageIds: [601, 602] }, 7);
  assert.equal(out.report.reasonText, 'Product damaged', 'the label is re-read from the lookup');
  assert.equal(out.report.visitCharge, 250);
  assert.deepEqual(MATERIAL, [{ job_id: 42, reason: REASON_VISIT, tx_charge: 250, client_charge: 250 }]);
  assert.equal(REPORTS[0].visit_charge_awarded, 1);
  assert.equal(REPORTS[0].proof_image_ids, '601,602');
  assert.deepEqual(logsFor('cannot complete reported').map((l) => l.oldData), ['Reason: 262']);
  assert.equal(logsFor('visit charge awarded').length, 1);
  await claims.reportCantComplete(42, 7, { reasonId: 262, proofImageIds: [601] }, 7);
  assert.equal(MATERIAL.length, 1);
  assert.equal(logsFor('visit charge awarded').length, 1);
  assert.equal(logsFor('cannot complete reported').length, 1);
});

test('no ₹250 unless he reached on THIS visit — at the door, or a revisit not yet started', async () => {
  JOB = { ...JOB, job_status: 1, checkin_date_time: null };
  let out = await claims.reportCantComplete(42, 7, { reasonId: 262, proofImageIds: [601] }, 7);
  assert.equal(out.report.visitCharge, null);
  REPORTS = [];
  JOB = { ...JOB, job_status: 1, checkin_date_time: '2026-09-20 10:00:00' };   // visit 1's write-once stamp
  out = await claims.reportCantComplete(42, 7, { reasonId: 262, proofImageIds: [601] }, 7);
  assert.equal(out.report.visitCharge, null);
  assert.equal(MATERIAL.length, 0);
});

test('undo gives the ₹250 back while the ledger is unposted — and only once', async () => {
  await claims.reportCantComplete(42, 7, { reasonId: 262, proofImageIds: [601] }, 7);
  const out = await claims.undoCantComplete(42, 7);
  assert.deepEqual(out.visitCharge, { reversed: true, reason: null });
  assert.equal(MATERIAL.length, 0);
  assert.equal(REPORTS[0].status, 'undone');
  assert.equal(REPORTS[0].visit_charge_awarded, 0);
  assert.deepEqual(logsFor('claim undone').map((l) => l.oldData), ['Kind: cant_complete']);
  assert.equal(await status(claims.undoCantComplete(42, 7)), 409, 'nothing left to undo');
});

test('undo after the ledger POSTED keeps the ₹250 — and never issues the DELETE', async () => {
  await claims.reportCantComplete(42, 7, { reasonId: 262, proofImageIds: [601] }, 7);
  POSTED = true;
  const out = await claims.undoCantComplete(42, 7);
  assert.deepEqual(out.visitCharge, { reversed: false, reason: 'ledger already posted' });
  assert.equal(MATERIAL.length, 1);
  assert.equal(fake.calls.filter((c) => /DELETE FROM job_material/.test(c.sql)).length, 0);
});

test('a ₹250 some OTHER flow paid (checkout "problem with job") is not this claim\'s to take back', async () => {
  MATERIAL.push({ job_id: 42, reason: REASON_VISIT, tx_charge: 250, client_charge: 250 });
  await claims.reportCantComplete(42, 7, { reasonId: 262, proofImageIds: [601] }, 7);
  assert.equal(REPORTS[0].visit_charge_awarded, 0);
  await claims.undoCantComplete(42, 7);
  assert.equal(MATERIAL.length, 1, 'the checkout\'s charge survives the claim\'s undo');
});

test('the reversal DELETE carries both ledger guards itself, not just the read before it', async () => {
  await require('../services/job-incentive.service').reverseVisitCharge(42);
  const del = fake.calls.find((c) => /DELETE FROM job_material/.test(c.sql));
  assert.ok(del, 'the DELETE must have run for an unposted job');
  assert.match(del.sql, /NOT EXISTS \(SELECT 1 FROM tbl_job_transaction WHERE fk_job_id = \?\)/);
  assert.match(del.sql, /NOT EXISTS \(SELECT 1 FROM tbl_easyfixer_transaction WHERE job_id = \?\)/);
  assert.match(del.sql, /type = 'Incentive' AND reason = \?/);
  assert.deepEqual(del.params, [42, REASON_VISIT, 42, 42]);
});

/* ─── Cancel claim + undo ────────────────────────────────────────────── */

test('cancel claim from a checked-in job: remembers status 2, pays ₹250; undo puts him BACK to 2', async () => {
  const before = { ...JOB };                        // read before the request parks the job
  const out = await claims.recordCancelClaim(before, 7, { reasonId: 267, proofImageIds: [601, 602] }, 7);
  assert.deepEqual(out, { proofCount: 2, visitCharge: 250 });
  assert.equal(REPORTS[0].prev_job_status, 2);
  assert.equal(REPORTS[0].reason_text, 'Customer want Cancellation');
  Object.assign(JOB, { job_status: 1, is_cancelled_by_app: 1 });   // what lifecycle.cancel() leaves
  const undo = await claims.undoCancel(42, 7);
  assert.equal(undo.jobStatus, 2);
  assert.equal(JOB.job_status, 2, 'a man mid-job must not be dropped to "Start job"');
  assert.equal(JOB.is_cancelled_by_app, 0);
  assert.equal(undo.visitCharge.reversed, true);
  assert.equal(MATERIAL.length, 0);
  assert.equal(await status(claims.undoCancel(42, 7)), 409, 'no open ask any more');
});

test('cancel claim before check-in stays at 1 on undo; a new ask REFRESHES a stale open claim', async () => {
  JOB = { ...JOB, job_status: 1, checkin_date_time: null };
  await claims.recordCancelClaim({ ...JOB }, 7, { reasonId: 267, proofImageIds: [601] }, 7);
  await claims.recordCancelClaim({ ...JOB }, 7, { reasonId: 267, proofImageIds: [601, 602] }, 7);
  assert.equal(REPORTS.length, 1, 'refreshed, not duplicated');
  assert.equal(REPORTS[0].proof_image_ids, '601,602');
  assert.equal(MATERIAL.length, 0, 'not on site → no ₹250');
  JOB.is_cancelled_by_app = 1;
  assert.equal((await claims.undoCancel(42, 7)).jobStatus, 1);
});

/* ─── Help ───────────────────────────────────────────────────────────── */

test('help: one open claim per job, logged once, closed jobs refused', async () => {
  const a = await claims.requestHelp(42, 7, 'gate');
  const b = await claims.requestHelp(42, 7, 'gate');
  assert.equal(a.help.id, b.help.id);
  assert.equal(REPORTS[0].reason_text, 'Stopped at the gate');
  assert.deepEqual(logsFor('help requested').map((l) => l.oldData), ['Reason: gate']);
  JOB.job_status = 3;
  REPORTS = [];
  assert.equal(await status(claims.requestHelp(42, 7, 'gate')), 409);
});

test('every claim 404s on another technician\'s job', async () => {
  for (const call of [
    () => claims.reportAdditionalWork(42, 8), () => claims.reportCantComplete(42, 8, { reasonId: 262, proofImageIds: [601] }, 8),
    () => claims.requestHelp(42, 8, 'gate'), () => claims.undoCancel(42, 8), () => claims.undoCantComplete(42, 8),
  ]) assert.equal(await status(call()), 404);
  assert.equal(REPORTS.length, 0);
});

/* ─── Chat ───────────────────────────────────────────────────────────── */

test('chat: a retried send returns the first row; body is 1..500; reads are after-id and capped at 100', async () => {
  const a = await chat.post(42, { senderKind: 'tx', efrId: 7, body: ' Customer is waiting ', clientMsgId: 'm-1' });
  const b = await chat.post(42, { senderKind: 'tx', efrId: 7, body: 'Customer is waiting', clientMsgId: 'm-1' });
  assert.equal(b.id, a.id);
  assert.equal(CHAT.length, 1);
  assert.equal(a.body, 'Customer is waiting');
  await chat.post(42, { senderKind: 'desk', userId: 5, body: '20 minutes.' });
  await chat.post(42, { senderKind: 'desk', userId: 5, body: 'Do the booked work.' });
  assert.equal(CHAT.length, 3, 'desk lines carry no client id and never dedupe against each other');
  await assert.rejects(chat.post(42, { senderKind: 'tx', body: 'x'.repeat(501) }), { status: 400 });
  await assert.rejects(chat.post(42, { senderKind: 'tx', body: '   ' }), { status: 400 });
  const since = await chat.list(42, { after: a.id, limit: 5000 });
  assert.deepEqual(since.map((m) => m.senderKind), ['desk', 'desk']);
  const read = fake.calls.filter((c) => /FROM tbl_job_chat\s+WHERE job_id = \? AND id > \?/.test(c.sql)).pop();
  assert.equal(read.params[2], 100, 'a 5000 request is capped at 100');
});

/* ─── The Phase 3 log writers take no caller free text ───────────────── */

test('Phase 3 log writers write only integers and closed vocabularies — anything else writes NO row', async () => {
  const jobLog = require('../services/job-log.service');
  const refused = [
    () => jobLog.logHelpRequested(42, { reason: 'my own words' }, { efr_id: 7 }),
    () => jobLog.logBookedMeanwhile(42, { answer: 'maybe' }, { efr_id: 7 }),
    () => jobLog.logClaimUndone(42, { kind: 'whatever' }, { efr_id: 7 }),
    () => jobLog.logClientQc(42, { outcome: 'fine' }, {}),
    () => jobLog.logAdditionalWorkPriced(42, { clientAmount: 2000 }, { user_id: 5 }),
    () => jobLog.logCannotCompleteReported(42, { reasonId: 'abc' }, { efr_id: 7 }),
  ];
  for (const w of refused) assert.equal(await w(), null);
  assert.equal(LOGS.length, 0, 'a refused event must not reach tbl_job_logs at all');
  await jobLog.logAdditionalWorkPriced(42, { clientAmount: 2000, txAmount: 1000 }, { user_id: 5 });
  await jobLog.logClientQc(42, { outcome: 'auto' }, {});
  assert.deepEqual(LOGS.map((l) => [l.logFor, l.oldData]),
    [['additional work priced', 'Client: 2000 Tx: 1000'], ['client qc', 'Outcome: auto']]);
});
