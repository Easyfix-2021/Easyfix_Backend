/*
 * The SPACING-INSENSITIVE SLOT FOLD, and the live capacity bug it fixes.
 *
 * ─── THE TWO THINGS PINNED HERE ───────────────────────────────────────────
 *
 * 1. slotModel.canonicalSlot is a COSMETIC fold — case and spacing, nothing
 *    else — and stays permanently distinct from normaliseSlotLabel, which
 *    INTERPRETS a label and answers with the band it denotes. Merging them is
 *    the obvious "cleanup" a future reader will reach for, and it is wrong in
 *    both directions: canonicalSlot on the write side lets a 1-hour frame back
 *    into tbl_job.time_slot, and normaliseSlotLabel on the read side silently
 *    re-labels the 79,364 rows of legacy free text the column carries.
 *
 * 2. checkFirefoxAvailability's capacity COUNT actually contains the SQL mirror
 *    of that fold, with its parameters in the right places.
 *
 * ─── THE BUG (part 2 of this change) ──────────────────────────────────────
 *
 * MySQL's default collation is case-insensitive, so `time_slot = '9AM to 12PM'`
 * DOES match a row storing '9am to 12pm'. It does NOT match '9 am to 12 pm' —
 * collation folds CASE, not SPACES — and that spelling is live on prod.
 *
 * A row holding '9 am to 12 pm' AND the 00:00 midnight sentinel therefore
 * matched NONE of the count's original three arms at once: the two equality
 * arms miss it on the interior spaces, and the appointment-hour arm is
 * explicitly gated out by `TIME(...) <> '00:00:00'`. Those bookings were
 * invisible to the capacity count, so a city already at its slot limit kept
 * answering `isAvailabil: "Yes"` and got overbooked. That exact row is
 * reconstructed below and shown crossing from invisible to counted.
 *
 * Non-destructive: fake pool, no real DB, zero writes. Runner: `node --test`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeFakePool } = require('./helpers/fake-pool');

const slotModel = require('../services/time-slot');
const { checkFirefoxAvailability } = require('../services/integration.service');

/*
 * The canonical four, spelled out rather than imported from the module under
 * test — importing them would make every assertion below vacuous. These strings
 * are the wire format shared with Easyfix_CRM_UI/src/lib/job-slots.ts and a
 * decade of rows; if a "tidy-up" ever reflows them, this is the alarm.
 */
const MORNING     = '9AM to 12PM';
const AFTERNOON   = '12PM to 3PM';
const EVENING     = '3PM to 7PM';
const AFTER_HOURS = 'After Hours';

/*
 * ─── THE PRODUCTION CENSUS ────────────────────────────────────────────────
 *
 * Every distinct value verified on prod 2026-07-31 (counts in the header of
 * services/time-slot.js), plus the customer-facing spellings and the cosmetic
 * variant from job #482491.
 *
 * ⚠ KEEP CONSISTENT WITH Easyfix_CRM_UI/tests/job-slots.test.js — same rows, same
 * order, same `stored`/`canonical` pairs. The two repos implement the same fold
 * and must agree about it row for row; a divergence here means one side started
 * folding something the other does not, which re-splits a band across the wire.
 * `isBand` is that file's `!extraChip`: true when the value IS one of the four
 * modulo case/spacing, and therefore must fold.
 */
const CENSUS = [
  // ── the four canonical bands (identity) ────────────────────────────────
  { stored: MORNING,                canonical: MORNING,     isBand: true,  note: '39,997 rows' },
  { stored: AFTERNOON,              canonical: AFTERNOON,   isBand: true,  note: '14,665 rows' },
  { stored: EVENING,                canonical: EVENING,     isBand: true,  note: '2,204 rows' },
  { stored: AFTER_HOURS,            canonical: AFTER_HOURS, isBand: true },

  // ── cosmetic variants: SAME band, different case/spacing. Must fold. ────
  { stored: '3pm to 7pm',           canonical: EVENING,     isBand: true,  note: 'job #482491' },
  { stored: '9 am to 12 pm',        canonical: MORNING,     isBand: true,  note: 'live on prod — THE capacity bug' },
  { stored: '9 AM to 12 PM',        canonical: MORNING,     isBand: true },
  { stored: '  3PM to 7PM  ',       canonical: EVENING,     isBand: true,  note: 'stray padding' },
  { stored: 'AFTER HOURS',          canonical: AFTER_HOURS, isBand: true },

  // ── genuinely different strings. Must NOT fold. ─────────────────────────
  { stored: 'Morning 9 to 2',       canonical: 'Morning 9 to 2',       isBand: false, note: '79,364 rows — the largest bucket' },
  { stored: 'Evening 2 to 7',       canonical: 'Evening 2 to 7',       isBand: false, note: '18,763 rows' },
  { stored: 'Morning 9 to 12',      canonical: 'Morning 9 to 12',      isBand: false, note: '3,193 rows' },
  { stored: 'Afternoon 12 to 5',    canonical: 'Afternoon 12 to 5',    isBand: false },
  { stored: 'Afternoon 12 to 2',    canonical: 'Afternoon 12 to 2',    isBand: false },
  { stored: 'After Hours - 19:00',  canonical: 'After Hours - 19:00',  isBand: false, note: 'NOT the After Hours band — carries an hour' },
  { stored: 'morning 9 to night 8', canonical: 'morning 9 to night 8', isBand: false },
  { stored: 'After 7PM',            canonical: 'After 7PM',            isBand: false },
  { stored: '9-12',                 canonical: '9-12',                 isBand: false },
  { stored: '3 PM–4 PM',            canonical: '3 PM–4 PM',            isBand: false, note: 'WhatsApp 1-hour frame (en-dash)' },
  { stored: '9 AM – 12 PM',         canonical: '9 AM – 12 PM',         isBand: false, note: 'customer form spelling (spaced en-dash)' },
];

// ─── canonicalSlot ────────────────────────────────────────────────────────

test('canonicalSlot resolves every production value as documented', () => {
  for (const row of CENSUS) {
    assert.equal(
      slotModel.canonicalSlot(row.stored),
      row.canonical,
      `${JSON.stringify(row.stored)}${row.note ? ` (${row.note})` : ''}`,
    );
  }
});

test('canonicalSlot folds onto a band ONLY for a cosmetic restatement of one', () => {
  const BANDS = new Set(slotModel.TIME_SLOT_BANDS);
  for (const row of CENSUS) {
    assert.equal(
      BANDS.has(slotModel.canonicalSlot(row.stored)),
      row.isBand,
      `${JSON.stringify(row.stored)} — folding a genuinely different string onto a band would PICK a window on the caller's behalf`,
    );
  }
});

test('canonicalSlot treats absent values as empty, never as a band', () => {
  for (const empty of ['', '   ', null, undefined]) {
    assert.equal(slotModel.canonicalSlot(empty), '', JSON.stringify(empty));
  }
});

test('canonicalSlot is idempotent — folding an already-folded value is a no-op', () => {
  for (const row of CENSUS) {
    assert.equal(
      slotModel.canonicalSlot(slotModel.canonicalSlot(row.stored)),
      row.canonical,
      row.stored,
    );
  }
});

/*
 * The FE keeps the byte-identical list. This asserts the shared vocabulary the
 * two folds resolve ONTO, which is the part that actually crosses the wire.
 */
test('the fold targets are the backend band constants, byte for byte', () => {
  assert.deepEqual(slotModel.TIME_SLOT_BANDS, [MORNING, AFTERNOON, EVENING, AFTER_HOURS]);
  for (const b of slotModel.TIME_SLOT_BANDS) {
    assert.equal(slotModel.canonicalSlot(b), b, `${b} must be its own canonical form`);
  }
});

// ─── canonicalSlot vs normaliseSlotLabel: NEVER the same function ─────────

/*
 * THE DISTINCTION, pinned on the values where the two genuinely disagree.
 *
 *   canonicalSlot       "is this the same SPELLING of a band?" — case/spacing
 *                       only, safe to READ with, never re-labels anything.
 *   normaliseSlotLabel  "what band does this MEAN?" — parses an hour out of the
 *                       label and returns the CONTAINING band. A writer-side
 *                       judgement; it is what resolveTimeSlot uses at save time.
 *
 * If a future edit implements one in terms of the other, every row below flips.
 */
const DISAGREE = [
  // stored,           canonicalSlot (cosmetic),  normaliseSlotLabel (interpreted)
  ['9-12',             '9-12',                    MORNING],
  ['12-3',             '12-3',                    AFTERNOON],
  ['3 PM–4 PM',        '3 PM–4 PM',               EVENING],
  ['10 AM - 11 AM',    '10 AM - 11 AM',           MORNING],
  ['9 AM – 12 PM',     '9 AM – 12 PM',            MORNING],
  ['15:00',            '15:00',                   EVENING],
  ['After Hours - 19:00', 'After Hours - 19:00',  AFTER_HOURS],
];

test('canonicalSlot and normaliseSlotLabel answer DIFFERENT questions', () => {
  for (const [stored, cosmetic, meaning] of DISAGREE) {
    assert.equal(slotModel.canonicalSlot(stored), cosmetic,
      `${JSON.stringify(stored)} — canonicalSlot must NOT interpret it`);
    assert.equal(slotModel.normaliseSlotLabel(stored), meaning,
      `${JSON.stringify(stored)} — normaliseSlotLabel must interpret it`);
    assert.notEqual(slotModel.canonicalSlot(stored), slotModel.normaliseSlotLabel(stored),
      `${JSON.stringify(stored)} — the two functions have collapsed into one`);
  }
});

/*
 * The mirror image: values normaliseSlotLabel REFUSES to read (it is anchored on
 * a leading digit, so the entire word-leading legacy vocabulary returns null)
 * while canonicalSlot happily carries them through untouched. This is why
 * canonicalSlot cannot be built on top of normaliseSlotLabel — it would start
 * returning null for the largest bucket in the table.
 */
test('normaliseSlotLabel refuses the word-leading legacy vocabulary canonicalSlot carries', () => {
  for (const stored of ['Morning 9 to 2', 'Evening 2 to 7', 'Afternoon 12 to 5', 'morning 9 to night 8']) {
    assert.equal(slotModel.normaliseSlotLabel(stored), null, `normaliseSlotLabel(${stored})`);
    assert.equal(slotModel.canonicalSlot(stored), stored, `canonicalSlot(${stored}) must pass it through`);
  }
});

// ─── the availability count SQL ───────────────────────────────────────────

const CITY_ID  = 7;
const NO_SLOTS = 5;

/*
 * The two SQL fragments this test is about. `EXACT_ARM` is the ORIGINAL legacy
 * predicate and must survive verbatim — the widened count is only ever allowed
 * to be a strict SUPERSET of it, so availability can never get LOOSER than the
 * contract external partners already depend on.
 */
const EXACT_ARM = 'tj.time_slot = ?';
const FOLD_ARM  = "REPLACE(LOWER(tj.time_slot), ' ', '') = REPLACE(LOWER(?), ' ', '')";

/* Runs the check against a fake pool and hands back the two statements it made. */
async function runAvailability({ timeSlot, requestedDate = '05-08-2026', cnt = 0 }) {
  const fake = makeFakePool([
    [/pincode_firefox_city_mapping/i, [{ city_id: CITY_ID, no_of_slot: NO_SLOTS }]],
    [/SELECT COUNT\(\*\) AS cnt/i,    [{ cnt }]],
  ]);
  const available = await checkFirefoxAvailability(fake.pool, {
    pincode: '110001', requestedDate, timeSlot,
  });
  return {
    available,
    count: fake.calls.find((c) => /SELECT COUNT\(\*\) AS cnt/i.test(c.sql)),
  };
}

test('the availability count carries the spacing-insensitive arm', async () => {
  const { count } = await runAvailability({ timeSlot: MORNING });
  assert.ok(count, 'the capacity COUNT statement must have run');
  const occurrences = count.sql.split(FOLD_ARM).length - 1;
  assert.equal(occurrences, 2,
    'each equality arm needs its own folded twin: one for the partner string, one for the canonical band');
});

test('the ORIGINAL exact arm survives — the count is a strict SUPERSET, never looser', async () => {
  const { count } = await runAvailability({ timeSlot: MORNING });
  assert.ok(count.sql.includes(EXACT_ARM), 'the legacy `tj.time_slot = ?` predicate was dropped');
  // …and the appointment-hour arm is still gated on the midnight sentinel, which
  // is precisely why it could not rescue the invisible row on its own.
  assert.match(count.sql, /TIME\(tj\.requested_date_time\) <> '00:00:00'/);
});

/*
 * NO DOUBLE-COUNTING. The five alternatives are ORed inside ONE COUNT(*) over a
 * single row source, so they are a row-level predicate rather than a join fan-out:
 * a row matching an exact arm AND its folded twin still contributes exactly 1.
 * Asserted on the SQL SHAPE, since that is the property that makes it true.
 */
test('the widened predicate is one ORed block inside a single COUNT — no fan-out', async () => {
  const { count } = await runAvailability({ timeSlot: MORNING });
  assert.equal(count.sql.match(/COUNT\(\*\)/g).length, 1, 'exactly one aggregate');
  assert.equal(count.sql.match(/\bFROM tbl_job tj\b/g).length, 1, 'one row source, not a self-join');
  assert.doesNotMatch(count.sql, /\bUNION\b/i, 'a UNION ALL of the arms WOULD double-count');
  // The slot alternatives live in a single parenthesised AND-term, so widening
  // it cannot multiply rows — only admit more of them.
  assert.match(count.sql, /AND \(\s*\n\s*tj\.time_slot = \?/);
});

test('the params line up with the widened arm order', async () => {
  // '9 am to 12 pm' is chosen deliberately: raw and folded differ, so each
  // position is distinguishable instead of being the same string seven times.
  const { count } = await runAvailability({ timeSlot: '9 am to 12 pm' });
  assert.deepEqual(count.params, [
    '2026-08-05',      // DATEDIFF target — 'DD-MM-YYYY' in, 'YYYY-MM-DD' out
    '9 am to 12 pm',   // arm 1 · exact, the partner's own spelling
    MORNING,           // arm 2 · folded twin, via canonicalSlot
    MORNING, MORNING,  // arm 3 · exact, the canonical band (guard + value)
    MORNING, MORNING,  // arm 4 · folded twin of the band  (guard + value)
    1, 9, 12,          // arm 5 · appointment-hour range for the morning band
    CITY_ID,
  ]);
});

test('the params line up when the label is legacy free text and has NO band', async () => {
  // normaliseSlotLabel('Morning 9 to 2') is null — it refuses to guess an hour
  // that was never written down — so both band arms must null out together
  // while the raw arm and its fold still carry the partner's string.
  const { count } = await runAvailability({ timeSlot: 'Morning 9 to 2' });
  assert.deepEqual(count.params, [
    '2026-08-05',
    'Morning 9 to 2',                 // arm 1 · exact
    'Morning 9 to 2',                 // arm 2 · folded — NOT folded onto a band
    null, null,                       // arm 3 · no band to compare
    null, null,                       // arm 4 · …so its fold is inert too
    1, 9, 14,                         // arm 5 · SLOT_HOURS['morning 9 to 2']
    CITY_ID,
  ]);
});

test('a cosmetic partner spelling is folded onto the canonical band it names', async () => {
  const { count } = await runAvailability({ timeSlot: '3pm to 7pm' });
  assert.equal(count.params[1], '3pm to 7pm', 'the exact arm keeps the partner string verbatim');
  assert.equal(count.params[2], EVENING,      'the folded arm carries the canonical band');
});

// ─── the worked example: the row that used to be invisible ────────────────

/*
 * The predicate arms, evaluated in JS exactly as MySQL would. This is how the
 * bug is demonstrated without a live database: `collationEq` is the default
 * case-insensitive collation (folds case, NOT spaces), `sqlFold` is the
 * REPLACE(LOWER(x), ' ', '') the new arms run.
 */
const collationEq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const sqlFold     = (s) => String(s).toLowerCase().split(' ').join('');

test('THE BUG: a "9 am to 12 pm" row at the midnight sentinel escaped all three original arms', () => {
  const stored = { time_slot: '9 am to 12 pm', requested_date_time: '2026-08-05 00:00:00' };
  const partnerSlot = MORNING;                                  // what the partner asks about
  const band = slotModel.normaliseSlotLabel(partnerSlot);       // '9AM to 12PM'

  // Arm 1 — collation folds the CASE but leaves the interior spaces alone.
  assert.equal(collationEq(stored.time_slot, partnerSlot), false, 'arm 1 missed it');
  // Arm 3 — same string, same miss, for the same reason.
  assert.equal(collationEq(stored.time_slot, band), false, 'arm 3 missed it');
  // Arm 5 — gated out entirely by the midnight sentinel.
  assert.equal(slotModel.hasTimeOfDay(stored.requested_date_time), false, 'arm 5 was gated out');

  // …so the booking existed, occupied a slot, and was invisible to the count.
  // The proof that collation is not the fix: it DOES rescue a pure case variant.
  assert.equal(collationEq('9am to 12pm', partnerSlot), true,
    'case-only variants were never the problem — spacing is');
});

test('THE FIX: the folded arm counts that row, and the fold mirrors canonicalSlot', () => {
  const stored = '9 am to 12 pm';
  const bound  = slotModel.canonicalSlot(MORNING);              // what the query binds

  assert.equal(sqlFold(stored), sqlFold(bound), 'the folded arm now matches the row');
  // The SQL fold and the JS fold must agree, or the query would match rows the
  // rest of the codebase considers different (and vice versa).
  assert.equal(slotModel.canonicalSlot(stored), slotModel.canonicalSlot(bound));

  // Still narrow: the fold must NOT start matching a genuinely different label.
  for (const other of ['Morning 9 to 2', '9-12', '3 PM–4 PM']) {
    assert.notEqual(sqlFold(other), sqlFold(bound), `${other} must stay out of the morning count`);
  }
});

/*
 * End to end: five jobs already booked into a city with five slots. Before the
 * fix those five rows were uncounted and the endpoint answered "Yes" into a full
 * city; the widened count sees them and the capacity gate closes.
 */
test('a city at capacity now reports unavailable instead of being overbooked', async () => {
  const full  = await runAvailability({ timeSlot: MORNING, cnt: NO_SLOTS });
  const room  = await runAvailability({ timeSlot: MORNING, cnt: NO_SLOTS - 1 });
  const blind = await runAvailability({ timeSlot: MORNING, cnt: 0 });   // the old, blind count

  assert.equal(full.available, false, 'five of five booked ⇒ no availability');
  assert.equal(room.available, true,  'four of five booked ⇒ still bookable');
  assert.equal(blind.available, true, 'the pre-fix count saw zero and overbooked the city');
});
