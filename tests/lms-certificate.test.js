'use strict';
/*
 * Course-completion certificates and the derived badge.
 *
 * Two things are pinned here that are not obvious from reading the route:
 *
 *   1. certificateData answers FOUR separate "no certificate" cases with one
 *      query, and every one of them must 404 rather than render a blank but
 *      official-looking document.
 *   2. The route validates two path parameters. validate() runs Joi with
 *      stripUnknown and assigns the result back over req.params, so a
 *      one-key schema on a two-parameter route does not fail to check the
 *      second — it DELETES it. That was a live bug for the length of one
 *      edit, and nothing about the route reads wrong afterwards.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const { installFakePool } = require('./helpers/fake-pool');

const ROOT = path.join(__dirname, '..');
const ROW = {
  enrolment_id: 42,
  completion_date: '2026-08-30 14:22:10',
  score: 88,
  course_name: 'Induction & Safety',
  efr_name: 'Ramesh Kumar',
  efr_no: '9876543210',
};

const fake = installFakePool([[/./, []]]);
after(() => fake.restore());

const svc = require('../services/lms.service');
const { renderCertificatePdf, formatDate } = require('../utils/pdf-certificate');

test('no eligible row is a 404, never a blank certificate', async () => {
  fake.reset();
  await assert.rejects(() => svc.certificateData(3, 9), /no certificate available/);
});

test('entitlement is the STAMP, not the course\'s current settings', async () => {
  fake.reset();
  await svc.certificateData(3, 9).catch(() => {});
  const sql = fake.calls.map((c) => c.sql).find((s) => /enrolment_id/.test(s)) || '';
  assert.match(sql, /ec\.badge_earned_at IS NOT NULL/);
  assert.match(sql, /ec\.course_id = \?[\s\S]*ec\.easyfixer_id = \?/,
    'both the course and the technician must be named');
  /*
   * THE POINT OF THE CHANGE. Re-checking the course's live flags at download
   * time let an admin revoke a certificate somebody had already earned, just by
   * turning the toggle off or retiring the course.
   */
  assert.doesNotMatch(sql, /c\.certificate_enabled/,
    'a flag flip must not revoke an earned certificate');
  assert.doesNotMatch(sql, /c\.status = 1/,
    'retiring a course must not revoke certificates already earned from it');
});

test('it rides a STAMP, never a recomputation', async () => {
  fake.reset();
  await svc.certificateData(3, 9).catch(() => {});
  const sql = fake.calls.map((c) => c.sql).find((s) => /enrolment_id/.test(s)) || '';
  assert.doesNotMatch(sql, /lms_content|COUNT\(/,
    'recomputing completion would revoke a certificate the moment an admin '
    + 'added a video to the course next month');
});

test('an eligible row returns everything the document prints', async () => {
  const f2 = installFakePool([[/enrolment_id/i, [ROW]], [/./, []]]);
  try {
    const row = await svc.certificateData(3, 9);
    for (const k of ['completion_date', 'score', 'course_name', 'efr_name', 'efr_no']) {
      assert.ok(k in row, `${k} must be selected`);
    }
  } finally { f2.restore(); }
});

test('the renderer emits a real PDF', async () => {
  const chunks = [];
  const sink = new PassThrough();
  sink.on('data', (c) => chunks.push(c));
  const done = new Promise((res) => sink.on('end', res));
  renderCertificatePdf({
    technician: { efr_name: ROW.efr_name, efr_no: ROW.efr_no },
    course: { name: ROW.course_name },
    completedOn: ROW.completion_date, score: ROW.score, stream: sink,
  });
  await done;
  const buf = Buffer.concat(chunks);
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-', 'must be a PDF');
  assert.ok(buf.length > 1000, 'a one-page certificate is ~2KB, not empty');
});

test('a course with no assessment renders without a score', async () => {
  const chunks = [];
  const sink = new PassThrough();
  sink.on('data', (c) => chunks.push(c));
  const done = new Promise((res) => sink.on('end', res));
  renderCertificatePdf({
    technician: { efr_name: 'A B', efr_no: null },
    course: { name: 'Reading Only' },
    completedOn: ROW.completion_date, score: null, stream: sink,
  });
  await done;
  assert.equal(Buffer.concat(chunks).subarray(0, 5).toString(), '%PDF-',
    'a null score must not throw — a printed "0%" would read as a failure');
});

test('an IST datetime string is printed verbatim, never re-zoned', () => {
  /*
   * The pool runs with dateStrings, so completion_date arrives already in IST.
   * Parsing it into a Date and formatting locally is the shift that has bitten
   * this codebase repeatedly.
   */
  assert.equal(formatDate('2026-08-30 14:22:10'), '30/08/2026');
  assert.equal(formatDate('2026-01-01 00:15:00'), '01/01/2026',
    'a just-past-midnight IST stamp must not slide to the previous day');
  assert.equal(formatDate(null), '—');
  assert.equal(formatDate('not a date'), '—');
});

test('REGRESSION: the certificate route validates BOTH path params', () => {
  /*
   * With validate(idParam) this route 400s on every request, because
   * stripUnknown removes easyfixerId from req.params before the handler runs.
   */
  const src = fs.readFileSync(path.join(ROOT, 'routes/admin/lms.js'), 'utf8');
  const line = src.split('\n').findIndex((l) => l.includes("/courses/:courseId/certificate/:easyfixerId"));
  assert.ok(line > 0, 'the route must use :courseId, matching assignmentParams');
  const near = src.split('\n').slice(line, line + 4).join('\n');
  assert.match(near, /validate\(assignmentParams, 'params'\)/);
  assert.doesNotMatch(near, /validate\(idParam/,
    'a one-key schema DELETES the second parameter rather than checking it');
});

test('the download is streamed, not JSON-wrapped, and not cached', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes/admin/lms.js'), 'utf8');
  const i = src.indexOf("/courses/:courseId/certificate/:easyfixerId");
  const block = src.slice(i, i + 2200);
  assert.match(block, /application\/pdf/);
  assert.match(block, /Content-Disposition/);
  assert.match(block, /no-store/, 'a named individual should not sit in a shared cache');
  assert.match(block, /await svc\.certificateData[\s\S]*renderCertificatePdf/,
    'data must be fetched BEFORE piping — once the stream starts the status '
    + 'line is already sent and an error can no longer become a 404');
});

test('the training report ships the ONE field the CRM needs to HIDE the button', () => {
  /*
   * The download route is gated on three facts; the report row used to expose
   * only one of them, so the CRM could offer a certificate for a course that
   * does not issue one and the operator found out from an error toast. If this
   * projection ever loses these two columns the button silently starts 404ing
   * again, and nothing else in the suite would notice.
   */
  const src = fs.readFileSync(path.join(ROOT, 'services/lms.service.js'), 'utf8');
  const i = src.indexOf('async function trainingReport');
  assert.ok(i > 0, 'trainingReport must exist');
  const body = src.slice(i, i + 4000);
  assert.match(body, /ec\.badge_earned_at/,
    'the download gates on the earn stamp, so the button must too');
});

/* ── Durability: the property the stamp exists to guarantee ───────────────── */

test('the badge stamp only ever fills NULLs — an earn time is never rewritten', async () => {
  fake.reset();
  await svc.stampBadges({ efrIds: [9] });
  const sql = fake.calls.map((c) => c.sql).find((x) => /badge_earned_at = \?/.test(x)) || '';
  assert.match(sql, /ec\.badge_earned_at IS NULL/,
    're-settling a completed course must not move the date it was earned');
  assert.match(sql, /ec\.completion_date IS NOT NULL/, 'it must be finished');
  assert.match(sql, /c\.certificate_enabled = 1/,
    'the flag decides eligibility HERE, at earn time — and nowhere else');
});

test('the badge stamp refuses to run unscoped', async () => {
  fake.reset();
  const r = await svc.stampBadges({});
  assert.equal(r.stamped, 0);
  assert.equal(fake.calls.some((c) => /badge_earned_at = \?/.test(c.sql)), false,
    'an unscoped run would back-date badges platform-wide the first time an '
    + 'operator enables the flag on an old course');
});

test('the badge stamp narrows by course for the bulk path', async () => {
  fake.reset();
  await svc.stampBadges({ courseId: 3 });
  const sql = fake.calls.map((c) => c.sql).find((x) => /badge_earned_at = \?/.test(x)) || '';
  assert.match(sql, /ec\.course_id = \?/);
  assert.doesNotMatch(sql, /ec\.easyfixer_id IN/);
});

test("the technician's course list ships the stamp, never the course flag", () => {
  const src = fs.readFileSync(path.join(ROOT, 'services/lms.service.js'), 'utf8');
  const i = src.indexOf('async function coursesForTech');
  const block = src.slice(i - 2500, i + 1500);
  assert.match(block, /ec\.badge_earned_at/);
  /*
   * Shipping certificate_enabled would let the app render a trophy for a course
   * the technician has not earned — the flag says the course OFFERS one.
   */
  const projection = block.slice(block.indexOf('SELECT ec.course_id'), block.indexOf('FROM easyfixer_courses'));
  assert.doesNotMatch(projection, /certificate_enabled/,
    'the app must not be able to draw a trophy from the course\'s offer alone');
});

/* ── The technician's own download ────────────────────────────────────────── */

test('the mobile certificate route takes NO technician id from the request', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes/mobile/lms.js'), 'utf8');
  const i = src.indexOf("/courses/:courseId/certificate");
  assert.ok(i > 0, 'the technician self-serve route must exist');
  const block = src.slice(i, i + 1600);
  assert.match(block, /req\.tech\.efr_id/, 'identity comes from the verified token');
  assert.doesNotMatch(block, /req\.(params|query|body)\.(efrId|easyfixerId|efr_id)/,
    'a request-supplied id would let any technician fetch another one\'s certificate');
  assert.match(block, /application\/pdf/);
  assert.match(block, /no-store/);
  assert.match(block, /await lms\.certificateData[\s\S]*renderCertificatePdf/,
    'fetch before piping — once the stream starts a 404 can no longer be sent');
});
