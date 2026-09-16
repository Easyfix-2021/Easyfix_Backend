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
const { todayIst, shiftYmd } = require('../utils/ist-calendar');

const UNCONFIRMED_STATUS = 9;

/*
 * The calendar date each fixture row's SQL appointment expression resolves to.
 * Kept beside PLAN so the two descriptions of one row cannot drift.
 */
function apptOf(row, todayYmd) {
  return row.days === null ? null : shiftYmd(todayYmd, row.days);
}


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
   * the same shape sectionsFor() builds. `today` is the IST day from the app
   * clock — the same clock sectionPredicate() binds (DATE(?)) since 2026-09-16,
   * so both sides are answering about the same day.
   */
  const todayYmd = todayIst();

  /*
   * ─── SYNTHETIC BOOK ──────────────────────────────────────────────────────
   *
   * WHY. Running against the live book only tests the predicates that happen to
   * have rows today. Measured when this was written: overdue 121,
   * pending_with_client 29, and ZERO in the other three — so mutation-testing
   * this check caught a broken `overdue` and sailed straight past a broken
   * `upcoming` and a broken `future_unscheduled`. It reported a clean run while
   * exercising 2 of 5 expressions.
   *
   * So before comparing the real book, build one. Eight jobs pinned to the
   * app's IST day cover every section, both date boundaries, the
   * NULL-appointment branch, and the precedence rule that a client request wins
   * over an unreachable outcome — none of which today's data can test.
   *
   * INSERTED AND ROLLED BACK, never committed. QA's Unconfirmed tab is a real
   * screen real people use; seeding permanent fixtures into it would trade a
   * blind check for a dirty book. A transaction gives the real tables and the
   * real predicates with no residue.
   *
   * The column list is derived from INFORMATION_SCHEMA rather than hardcoded,
   * so a future NOT NULL column added to tbl_job makes this fill it in instead
   * of failing — the same lesson as check:migrations.
   */
  const conn = await pool.getConnection();
  let syntheticFailures = 0;
  try {
    await conn.beginTransaction();

    const [cols] = await conn.query(
      `SELECT COLUMN_NAME n, DATA_TYPE d FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tbl_job'
          AND IS_NULLABLE = 'NO' AND COLUMN_DEFAULT IS NULL
          AND EXTRA NOT LIKE '%auto_increment%' AND EXTRA NOT LIKE '%GENERATED%'`,
      [process.env.DB_NAME],
    );
    // A zero value per type: enough to satisfy NOT NULL, meaningless by design.
    const filler = (d) => (/int|decimal|double|float|bit|year/i.test(d) ? 0
      : /date|time/i.test(d) ? '2000-01-01 00:00:00' : 'check:sections fixture');
    const fixed = cols.filter((c) => !['job_status', 'requested_date_time'].includes(c.n));

    /*
     * `days` is an offset from the app's IST day; apptOf() turns it into the
     * bound appointment and the JS side's expectation, so the two cannot drift.
     */
    const PLAN = [
      { tag: 'req-only',       days: null, req: true,  unr: false, want: 'actioned_by_client' },
      { tag: 'req-and-unr',    days: -3,   req: true,  unr: true,  want: 'actioned_by_client' },
      { tag: 'unr-only',       days: -3,   req: false, unr: true,  want: 'pending_with_client' },
      { tag: 'overdue',        days: -1,   req: false, unr: false, want: 'overdue' },
      { tag: 'today',          days: 0,    req: false, unr: false, want: 'upcoming' },
      { tag: 'tomorrow',       days: 1,    req: false, unr: false, want: 'upcoming' },
      { tag: 'day-after',      days: 2,    req: false, unr: false, want: 'future_unscheduled' },
      { tag: 'no-appointment', days: null, req: false, unr: false, want: 'future_unscheduled' },
    ];

    const made = [];
    for (const row of PLAN) {
      const names = [...fixed.map((c) => c.n), 'job_status', 'requested_date_time'];
      const vals = fixed.map((c) => filler(c.d));
      const [res] = await conn.query(
        `INSERT INTO tbl_job (${names.map((n) => `\`${n}\``).join(', ')})
         VALUES (${vals.map(() => '?').join(', ')}, ?, ?)`,
        [...vals, UNCONFIRMED_STATUS, apptOf(row, todayYmd)],
      );
      const id = res.insertId;
      made.push({ ...row, id });
      if (row.req) {
        await conn.query('INSERT INTO tbl_job_comment (job_id, comments, enum_reason_id) VALUES (?, ?, ?)',
          [id, 'fixture: client request', ids.cancel]);
      }
      if (row.unr) {
        await conn.query('INSERT INTO tbl_job_comment (job_id, comments, comment_on) VALUES (?, ?, 16)',
          [id, 'fixture: unreachable outcome']);
      }
    }

    const idList = made.map((m) => m.id);
    const placeholders = idList.map(() => '?').join(', ');
    const matched = new Map();
    for (const section of cr.SECTIONS) {
      const pred = cr.sectionPredicate(section, ids);
      const [rows] = await conn.query(
        `SELECT j.job_id FROM tbl_job j
          WHERE j.job_id IN (${placeholders}) AND j.job_status = ? AND (${pred.sql})`,
        [...idList, UNCONFIRMED_STATUS, ...pred.params],
      );
      for (const r of rows) {
        const id = Number(r.job_id);
        if (matched.has(id)) {
          console.error(`  ✗ fixture job ${id} matches BOTH ${matched.get(id)} and ${section}`);
          syntheticFailures += 1;
        }
        matched.set(id, section);
      }
    }

    console.log(`  synthetic book: ${made.length} job(s) covering all ${cr.SECTIONS.length} sections`);
    for (const m of made) {
      const got = matched.get(m.id) || '<no section>';
      // The JS classifier gets the SAME facts, so a divergence here is the two
      // expressions disagreeing rather than the fixture being wrong.
      const js = cr.sectionFor(
        { hasClientRequest: m.req, hasUnreachableOutcome: m.unr, appointmentYmd: apptOf(m, todayYmd) },
        todayYmd,
      );
      const ok = got === m.want && js === m.want;
      if (!ok) syntheticFailures += 1;
      console.log(`    ${ok ? '✓' : '✗'} ${m.tag.padEnd(15)} want ${m.want.padEnd(19)} sql ${got.padEnd(19)} js ${js}`);
    }
    if (syntheticFailures) {
      console.error(`\n  ${syntheticFailures} synthetic case(s) wrong — the section rule is broken for a`);
      console.error('  case the live book cannot show you. Fix sectionFor AND sectionPredicate.');
      process.exitCode = 1;
    }
  } finally {
    // Never committed. The fixture exists for the length of this check only.
    await conn.rollback();
    conn.release();
  }

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
   * That gap is now closed by the SYNTHETIC BOOK above, which exercises all
   * five predicates (plus both date boundaries and the precedence rule) on any
   * environment, including a fresh one. Both mutations that used to slip
   * through — `upcoming` shifted a day, `future` losing its NULL branch — are
   * caught by it and exit 1.
   *
   * This line is kept anyway, because the two books answer different questions:
   * the synthetic one asks "is the rule right?", the live one asks "does the
   * rule still partition the data we actually have?". Only the live book can
   * find a row shape nobody thought to invent.
   */
  const exercised = cr.SECTIONS.filter((s) => counts[s] > 0);
  const blind = cr.SECTIONS.filter((s) => counts[s] === 0);
  console.log(`  coverage: live book exercised ${exercised.length} of ${cr.SECTIONS.length}; `
    + `synthetic book exercised all ${cr.SECTIONS.length}`);
  if (blind.length) {
    console.log(`    (no live rows today for: ${blind.join(', ')} — covered synthetically above)`);
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
