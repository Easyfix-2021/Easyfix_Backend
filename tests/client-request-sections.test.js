'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sectionFor, SECTIONS, SECTION_META } = require('../services/client-request.service');

/*
 * The five My Orders -> Unconfirmed sections.
 *
 * Ops's rule, in their words: "one job should be in any one of the section
 * only. No job should ever be in 2 sections." That is a PROPERTY, not a
 * collection of cases, so it is asserted as one — over the whole input space
 * rather than over the examples someone thought to write down.
 *
 * sectionFor is pure and takes `today` as an argument precisely so this file
 * needs no DB and no clock. A classifier that read the clock itself could not
 * be tested near midnight, which is the one time its behaviour matters.
 */

const TODAY = '2026-09-04';
const YESTERDAY = '2026-09-03';
const TOMORROW = '2026-09-05';
const LATER = '2026-09-30';

const j = (o = {}) => ({
  hasClientRequest: false, hasUnreachableOutcome: false, appointmentYmd: null, ...o,
});

// ── the five memberships ──────────────────────────────────────────────────

test('a client request puts the job in Actioned By Client', () => {
  assert.equal(sectionFor(j({ hasClientRequest: true }), TODAY), 'actioned_by_client');
});

test('an unreachable outcome with no client reply is Pending Action from Client', () => {
  assert.equal(sectionFor(j({ hasUnreachableOutcome: true }), TODAY), 'pending_with_client');
});

test('an appointment before today is Overdue', () => {
  assert.equal(sectionFor(j({ appointmentYmd: YESTERDAY }), TODAY), 'overdue');
});

test('today and tomorrow are both Upcoming — the boundary ops actually reads', () => {
  assert.equal(sectionFor(j({ appointmentYmd: TODAY }), TODAY), 'upcoming');
  assert.equal(sectionFor(j({ appointmentYmd: TOMORROW }), TODAY), 'upcoming');
});

test('later than tomorrow is Future', () => {
  assert.equal(sectionFor(j({ appointmentYmd: LATER }), TODAY), 'future_unscheduled');
});

/*
 * The case that is easiest to forget and most common in this tab: being
 * UNCONFIRMED is frequently the reason no appointment exists yet. Ops chose to
 * file these with Future, which is why the section is named for both. Dropping
 * them instead would silently shrink the page and nothing would report it.
 */
test('a job with NO appointment date lands in Future & Unscheduled, never nowhere', () => {
  assert.equal(sectionFor(j({ appointmentYmd: null }), TODAY), 'future_unscheduled');
  assert.equal(sectionFor(j({ appointmentYmd: '' }), TODAY), 'future_unscheduled');
});

// ── precedence: the conversation beats the calendar ───────────────────────
/*
 * A client-actioned job also HAS an appointment date, so without a precedence
 * chain it would qualify for two sections at once. The conversation wins: a job
 * blocked on a person is not usefully filed under a date, and burying it in
 * Overdue is how a client request goes unanswered.
 */
test('a client request outranks every date bucket', () => {
  for (const ymd of [YESTERDAY, TODAY, TOMORROW, LATER, null]) {
    assert.equal(sectionFor(j({ hasClientRequest: true, appointmentYmd: ymd }), TODAY),
      'actioned_by_client', `an appointment of ${ymd} must not pull it out of the client section`);
  }
});

test('a client request outranks a pending unreachable — the newest fact wins', () => {
  assert.equal(
    sectionFor(j({ hasClientRequest: true, hasUnreachableOutcome: true }), TODAY),
    'actioned_by_client',
    'every client request FOLLOWS an unreachable outcome, so both flags are the normal case, '
    + 'not an edge one — if the outcome won, no request would ever be visible',
  );
});

test('a pending unreachable outranks the date buckets', () => {
  for (const ymd of [YESTERDAY, TODAY, LATER, null]) {
    assert.equal(sectionFor(j({ hasUnreachableOutcome: true, appointmentYmd: ymd }), TODAY),
      'pending_with_client');
  }
});

// ── the property ops asked for ────────────────────────────────────────────

test('EVERY combination lands in exactly one known section', () => {
  const dates = [YESTERDAY, TODAY, TOMORROW, LATER, null, ''];
  let n = 0;
  for (const hasClientRequest of [true, false]) {
    for (const hasUnreachableOutcome of [true, false]) {
      for (const appointmentYmd of dates) {
        const got = sectionFor({ hasClientRequest, hasUnreachableOutcome, appointmentYmd }, TODAY);
        assert.ok(SECTIONS.includes(got),
          `${JSON.stringify({ hasClientRequest, hasUnreachableOutcome, appointmentYmd })} -> ${got}, `
          + 'which is not one of the five sections. A job that classifies to nothing '
          + 'disappears from the page with no error anywhere.');
        n += 1;
      }
    }
  }
  assert.equal(n, 2 * 2 * dates.length, 'the sweep must actually have run');
});

/*
 * sectionFor returns ONE string, so "no job in two sections" is true by
 * construction — which is the point of classifying rather than filtering five
 * times. This pins the shape so a later refactor to five predicates (the
 * obvious way to write it, and the way that CAN double-count) fails here.
 */
test('the classifier returns a single section, not a set', () => {
  const got = sectionFor(j({ hasClientRequest: true, hasUnreachableOutcome: true, appointmentYmd: TODAY }), TODAY);
  assert.equal(typeof got, 'string');
  assert.ok(!Array.isArray(got));
});

test('SECTION_META covers every section exactly once, in the order ops chose', () => {
  assert.deepEqual(SECTION_META.map((m) => m.key),
    ['actioned_by_client', 'overdue', 'upcoming', 'future_unscheduled', 'pending_with_client'],
    'this is the DEFAULT display order ops specified; the CRM lets them drag it, '
    + 'but a section missing here renders nowhere');
  assert.equal(new Set(SECTION_META.map((m) => m.key)).size, SECTIONS.length);
  for (const m of SECTION_META) assert.ok(m.label && m.label.length > 3, `${m.key} needs a label`);
});
