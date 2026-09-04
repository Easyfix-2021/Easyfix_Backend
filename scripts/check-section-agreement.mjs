#!/usr/bin/env node
/*
 * check-section-agreement — do the SQL predicate and the JS classifier put every
 * job in the SAME My Orders -> Unconfirmed section?
 *
 * WHY THIS EXISTS. The five sections are expressed TWICE, and neither can be
 * derived from the other:
 *
 *   sectionFor()        JavaScript over rows the browser already has
 *   sectionPredicate()  a WHERE clause the database evaluates for a paged,
 *                       searched, sorted query nobody has fetched yet
 *
 * Per-section pagination needs the SQL one (a section must be able to page
 * beyond what is on screen). Nothing else can check it, because a unit test that
 * re-implements the SQL in JS is just the same arithmetic twice and agrees with
 * itself by construction.
 *
 * So this runs BOTH over the real book and compares the partitions row for row.
 * It needs a database, which makes it a pre-deploy check rather than a CI gate —
 * the same call as `npm run check:migrations`.
 *
 *   npm run check:sections
 *
 * Exit 1 on any disagreement. Exit 2 if the DB is unreachable — never 0, because
 * "I could not check" must not read as "they agree".
 */
import process from 'node:process';
import 'dotenv/config';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cr = require('../services/client-request.service');

const UNCONFIRMED_STATUS = 9;

let pool;
try {
  ({ pool } = require('../db'));
  await pool.query('SELECT 1');
} catch (e) {
  console.error(`cannot reach the database, so nothing was compared: ${e.message}`);
  console.error('exiting 2 — an unchecked partition must not look like an agreeing one.');
  process.exit(2);
}

try {
  const ids = await cr.reasonIds(pool);
  if (!ids) {
    console.error('the client-request reason rows are not seeded on this host — run');
    console.error('migrations/2026-09-04-seed-client-request-reasons.sql first.');
    console.error('exiting 2: without them the two sides agree only by both being blind.');
    process.exit(2);
  }

  /*
   * The JS side. Facts are read ONCE, in one query, and fed to sectionFor —
   * the same shape sectionsFor() builds. `today` comes from the DATABASE
   * (CURDATE()) rather than from this process, so both sides are answering
   * about the same day even if the two clocks disagree.
   */
  const [[{ today }]] = await pool.query('SELECT CURDATE() AS today');
  const todayYmd = today instanceof Date
    ? new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
    : String(today);

  const [facts] = await pool.query(
    `SELECT j.job_id,
            DATE_FORMAT(j.requested_date_time, '%Y-%m-%d') AS appt,
            MAX(c.comment_on = 16)                  AS unreachable,
            MAX(c.enum_reason_id IN (?, ?))         AS client_req
       FROM tbl_job j
       LEFT JOIN tbl_job_comment c ON c.job_id = j.job_id
      WHERE j.job_status = ?
      GROUP BY j.job_id, appt`,
    [ids.cancel, ids.retry, UNCONFIRMED_STATUS],
  );

  const byJs = new Map();
  for (const f of facts) {
    byJs.set(Number(f.job_id), cr.sectionFor({
      hasClientRequest: !!Number(f.client_req),
      hasUnreachableOutcome: !!Number(f.unreachable),
      appointmentYmd: f.appt || null,
    }, todayYmd));
  }

  // The SQL side: one query per section, exactly as the list endpoint runs it.
  const bySql = new Map();
  const counts = {};
  for (const section of cr.SECTIONS) {
    const pred = cr.sectionPredicate(section, ids);
    const [rows] = await pool.query(
      `SELECT j.job_id FROM tbl_job j WHERE j.job_status = ? AND (${pred.sql})`,
      [UNCONFIRMED_STATUS, ...pred.params],
    );
    counts[section] = rows.length;
    for (const r of rows) {
      const id = Number(r.job_id);
      /*
       * A job matched by TWO predicates is the failure ops explicitly ruled out
       * ("no job should ever be in 2 sections"), and it is invisible in the UI:
       * the row simply appears twice and the section counts stop summing to the
       * tab total. Caught here rather than by someone adding up headings.
       */
      if (bySql.has(id)) {
        console.error(`✗ job ${id} matches BOTH ${bySql.get(id)} and ${section} — the predicates overlap`);
        process.exitCode = 1;
      }
      bySql.set(id, section);
    }
  }

  console.log(`  ${byJs.size} unconfirmed job(s); section counts from SQL:`);
  for (const s of cr.SECTIONS) console.log(`    ${s.padEnd(20)} ${counts[s]}`);

  const disagree = [];
  for (const [id, js] of byJs) {
    const sql = bySql.get(id) || '<matched no section>';
    if (js !== sql) disagree.push({ id, js, sql });
  }
  const onlySql = [...bySql.keys()].filter((id) => !byJs.has(id));

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`  SQL total ${total} vs ${byJs.size} rows — ${total === byJs.size ? 'partitions the book exactly' : 'DOES NOT partition the book'}`);

  /*
   * ⚠ COVERAGE, BECAUSE A GREEN RUN HERE IS ONLY AS BROAD AS THE DATA.
   *
   * A predicate matching zero rows was not tested by this run — there was
   * nothing for it to get wrong. Measured when this was written: 121 overdue,
   * 29 pending, and ZERO in the other three, so mutation-testing the check
   * caught a broken `overdue` and sailed past a broken `upcoming` and a broken
   * `future_unscheduled`. It agreed on 2 of 5 predicates and was blind to the
   * rest, while printing a clean result.
   *
   * So the coverage is stated rather than implied. The five branches ARE fully
   * covered on the JS side by tests/client-request-sections.test.js, which is
   * pure and needs no data; this line says how much of the SQL side today's
   * book could exercise.
   */
  const exercised = cr.SECTIONS.filter((s) => counts[s] > 0);
  const blind = cr.SECTIONS.filter((s) => counts[s] === 0);
  console.log(`  coverage: ${exercised.length} of ${cr.SECTIONS.length} SQL predicates had rows to test`);
  if (blind.length) {
    console.log(`  ⚠ NOT exercised by this data (agreement above says nothing about them): ${blind.join(', ')}`);
    console.log('    The JS side of these IS covered by tests/client-request-sections.test.js.');
  }

  if (disagree.length || onlySql.length || process.exitCode === 1) {
    for (const d of disagree.slice(0, 15)) {
      console.error(`✗ job ${d.id}: classifier says ${d.js}, SQL says ${d.sql}`);
    }
    if (disagree.length > 15) console.error(`  … and ${disagree.length - 15} more`);
    for (const id of onlySql.slice(0, 5)) console.error(`✗ job ${id} matched by SQL but absent from the classifier's input`);
    console.error('\nThe two expressions of the section rule have drifted. Fix BOTH — '
      + 'sectionFor and sectionPredicate in services/client-request.service.js.');
    process.exit(1);
  }
  console.log('  ✓ both expressions agree on every job.');
} finally {
  await pool.end();
}
