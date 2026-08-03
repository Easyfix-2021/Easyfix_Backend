/*
 * services/time-slot.js — the ONE place that knows what an appointment's
 * time columns mean. Pure functions, no DB, no logger, no imports: safe to
 * require from anywhere (job.service, candidate-ranking.service,
 * whatsapp-conversation.service, job-magic-link.service, integration.service)
 * without dragging a dependency graph along.
 *
 * ─── THE MODEL (owner decision, 2026-07-31) ──────────────────────────────
 *
 *   tbl_job.requested_date_time  the APPOINTMENT INSTANT. Its time-of-day is
 *                                the START of the 1-HOUR frame ops / the
 *                                customer actually picked (10 AM–11 AM → 10:00).
 *   tbl_job.requested_time       the same 1-hour START as legacy HH:MM TEXT.
 *   tbl_job.time_slot            the BROAD BOOKING BAND containing that start.
 *                                EXACTLY FOUR values, nothing else:
 *                                  '9AM to 12PM'  '12PM to 3PM'
 *                                  '3PM to 7PM'   'After Hours'
 *
 * So the 1-HOUR granularity lives in requested_date_time / requested_time, and
 * time_slot is a derived, coarse label. A 1-hour frame label ('3 PM–4 PM') must
 * NEVER be written to time_slot again — that experiment is reversed.
 *
 * ─── WHY THE STRING IS NO LONGER LOAD-BEARING ────────────────────────────
 *
 * tbl_job.time_slot holds at least 12 distinct free-text values accumulated
 * from two backends and a decade of pickers (verified on prod 2026-07-31):
 *   'Morning 9 to 2' (79,364) · '9AM to 12PM' (39,997) · 'Evening 2 to 7'
 *   (18,763) · '12PM to 3PM' (14,665) · 'Morning 9 to 12' (3,193) ·
 *   '3PM to 7PM' (2,204) · 'Afternoon 12 to 2' · 'After Hours - 19:00' ·
 *   'morning 9 to night 8' · 'After 7PM' · '9-12' · '9 am to 12 pm' · …
 * Any logic that does string equality on that column is broken by
 * construction. Nothing in this codebase may branch on the STRING any more —
 * derive from requested_date_time instead. Historical rows are NOT migrated;
 * they simply stop mattering.
 *
 * ─── THE MIDNIGHT SENTINEL ───────────────────────────────────────────────
 *
 * A large tail of rows carries requested_date_time at exactly 00:00:00 (and/or
 * requested_time NULL/'00:00:00'). That is NOT "a booking at midnight" — it is
 * "no time-of-day was ever captured" (date-only bookings, legacy imports).
 * Every time-of-day comparison here refuses to treat it as a real instant, via
 * hasTimeOfDay(); otherwise every such job would collide with every other one
 * at 00:00 and the conflict filter would exclude technicians far more
 * aggressively than the band-equality it replaces.
 */

// ─── The four canonical bands ────────────────────────────────────────
// These are the NEW-CRM picker's own strings and already the dominant live
// values. Spelling is deliberate: no spaces around the hour tokens, the word
// "to" as the separator (NOT an en-dash). Do not "tidy" them.
const BAND_MORNING     = '9AM to 12PM';
const BAND_AFTERNOON   = '12PM to 3PM';
const BAND_EVENING     = '3PM to 7PM';
const BAND_AFTER_HOURS = 'After Hours';

const TIME_SLOT_BANDS = Object.freeze([
  BAND_MORNING, BAND_AFTERNOON, BAND_EVENING, BAND_AFTER_HOURS,
]);
const BAND_SET = new Set(TIME_SLOT_BANDS);

/*
 * The 1-HOUR frames a booking may start on, 9 AM → 7 PM. Presentation-only:
 * the picker (CRM chips, WhatsApp quick replies) offers these, and the chosen
 * START is stored in requested_date_time / requested_time. NOTHING derived
 * from this list is ever written to time_slot.
 */
const SLOT_START_HOURS = Object.freeze([9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);

// ─── Wall-clock helpers ──────────────────────────────────────────────
/*
 * Every datetime here is an IST WALL-CLOCK string — 'YYYY-MM-DD HH:MM:SS' as
 * mysql2 returns it under dateStrings:true, or the 'YYYY-MM-DDTHH:MM' variant
 * an FE datetime-local sends. We never construct a JS Date from it for
 * timezone purposes: arithmetic is done on the wall clock read AS IF UTC, so
 * the result is identical on a UTC container and an IST laptop.
 */
const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/;

function pad2(n) { return String(n).padStart(2, '0'); }

/*
 * Split a wall-clock string into its parts. Returns null when the value is
 * absent or isn't a date at all. `hasTime` is false for a date-only value.
 */
function parseWallClock(dt) {
  if (!dt) return null;
  const m = WALL_CLOCK_RE.exec(String(dt));
  if (!m) return null;
  const hasTime = m[4] !== undefined;
  return {
    y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]),
    h: hasTime ? Number(m[4]) : 0,
    mi: hasTime ? Number(m[5]) : 0,
    s: hasTime && m[6] !== undefined ? Number(m[6]) : 0,
    hasTime,
  };
}

/* Canonical 'YYYY-MM-DD HH:MM:SS' for a parsed wall clock. */
function formatWallClock(p) {
  return `${p.y}-${pad2(p.mo)}-${pad2(p.d)} ${pad2(p.h)}:${pad2(p.mi)}:${pad2(p.s)}`;
}

/*
 * slotHour(dt) → 0–23, or null when the value carries no hour at all.
 *
 * NOTE this returns 0 for the midnight sentinel — it reports the hour it sees
 * and says nothing about whether that hour is meaningful. Callers that need
 * "is there a real time-of-day here?" must use hasTimeOfDay().
 */
function slotHour(dt) {
  const p = parseWallClock(dt);
  if (!p || !p.hasTime) return null;
  return (p.h >= 0 && p.h <= 23) ? p.h : null;
}

/*
 * hasTimeOfDay(dt) → true only when the value carries a REAL time-of-day.
 *
 * THE SENTINEL GUARD. Midnight is rejected: on this data 00:00:00 means "no
 * appointment time was captured", not "a visit at midnight". A genuine
 * after-midnight visit is booked as 'After Hours' with the actual hour (00:30,
 * 01:00, …) and passes. Nothing scheduled by any current picker lands on
 * exactly 00:00:00.
 */
function hasTimeOfDay(dt) {
  const p = parseWallClock(dt);
  if (!p || !p.hasTime) return false;
  return !(p.h === 0 && p.mi === 0 && p.s === 0);
}

/*
 * wallClockTime(dt) → 'HH:MM' for the legacy tbl_job.requested_time column,
 * read STRAIGHT off an IST wall-clock string. Null when there is no time part.
 *
 * ⚠ USE THIS, NOT job.service's formatTimeIST(), whenever the input is already
 * an IST literal like '2026-07-20 14:30:00'. formatTimeIST() runs the value
 * through `new Date(...)`, which parses a space-separated datetime as SERVER
 * LOCAL time and then adds +05:30 — so on our UTC containers an IST 14:30
 * came back as '20:00'. That double shift is visible in prod (e.g. job 482474:
 * requested_date_time 16:00, requested_time 21:30). formatTimeIST is still
 * correct for a real instant (a JS Date / a Z-suffixed ISO); it is only wrong
 * for a string that is ALREADY wall clock.
 */
function wallClockTime(dt) {
  const p = parseWallClock(dt);
  if (!p || !p.hasTime) return null;
  return `${pad2(p.h)}:${pad2(p.mi)}`;
}

/*
 * formatClock12(dt) → the human 12-hour appointment time — '5:30 AM', '3 PM' —
 * or null when the value carries no REAL time-of-day.
 *
 * Whole hours drop the ':00' ("3 PM", not "3:00 PM"): that is how the approved
 * WhatsApp template already reads the appointment back to the customer
 * (whatsapp-conversation.service.js jobDateLabel), and the two must not diverge
 * now that the public shared-job page states a time as well.
 *
 * Gated on hasTimeOfDay, NOT slotHour, so the 00:00 midnight sentinel returns
 * null instead of rendering "12 AM" for a date-only booking that never had a
 * time captured at all. A caller that gets null must show the band alone.
 *
 * Lives here rather than beside its callers because this module already owns
 * every reading of an appointment's time columns (wallClockTime, slotHour) and
 * is pure + dependency-free, so a display surface can require it without
 * dragging a service graph along.
 */
function formatClock12(dt) {
  if (!hasTimeOfDay(dt)) return null;
  const p = parseWallClock(dt);
  if (!p) return null;
  const h12 = ((p.h + 11) % 12) + 1;
  const suffix = p.h < 12 ? 'AM' : 'PM';
  return p.mi === 0 ? `${h12} ${suffix}` : `${h12}:${pad2(p.mi)} ${suffix}`;
}

// ─── Band derivation ─────────────────────────────────────────────────
/*
 * bandForHour(h) → one of the four bands.
 * Boundaries: [9,12) morning · [12,15) afternoon · [15,19) evening ·
 * everything else (including the whole night) After Hours.
 */
function bandForHour(h) {
  if (!Number.isFinite(h)) return null;
  if (h >= 9  && h < 12) return BAND_MORNING;
  if (h >= 12 && h < 15) return BAND_AFTERNOON;
  if (h >= 15 && h < 19) return BAND_EVENING;
  return BAND_AFTER_HOURS;
}

/*
 * deriveTimeSlot(dt) → the BAND containing an IST wall-clock datetime.
 *
 * This is THE writer-side derivation: create() and reschedule() put its output
 * in tbl_job.time_slot. Returns null when there is no hour to read (absent /
 * date-only / unparseable) so a `?? existing` or COALESCE guard leaves the
 * column alone rather than inventing a band.
 *
 * The midnight sentinel deliberately maps to 'After Hours' here — that is the
 * historical create()-fallback behaviour for a date-only booking and nothing
 * downstream branches on it. The sentinel only has to be EXCLUDED from
 * time-of-day comparisons (see hasTimeOfDay / conflictFrame).
 */
function deriveTimeSlot(dt) {
  const h = slotHour(dt);
  if (h === null) return null;
  return bandForHour(h);
}

// ─── Cosmetic fold vs. interpretation ────────────────────────────────
/*
 * TWO DIFFERENT QUESTIONS, TWO DIFFERENT FUNCTIONS. They live side by side so
 * the distinction is impossible to miss, and they must NEVER be merged or
 * implemented in terms of each other.
 *
 *   canonicalSlot(v)      "are these two strings the SAME SPELLING of a band?"
 *                         A purely COSMETIC fold — case and whitespace, nothing
 *                         else. It never interprets: a value that is not one of
 *                         the four bands modulo case/spacing comes back
 *                         UNCHANGED. Safe on the READ side — comparing,
 *                         grouping, deciding which chip renders selected,
 *                         widening a SQL match.
 *
 *   normaliseSlotLabel(v) "what band does this label MEAN?" It parses an hour
 *                         out of the label and answers with the CONTAINING
 *                         band. That is a WRITER-SIDE JUDGEMENT — it picks a
 *                         band on the caller's behalf — and it is what
 *                         resolveTimeSlot uses at save time.
 *
 * They disagree on purpose, e.g. on '9-12':
 *     canonicalSlot('9-12')      === '9-12'          (not a band spelling)
 *     normaliseSlotLabel('9-12') === '9AM to 12PM'   (the band it denotes)
 * …and on '3 PM–4 PM' (a 1-hour frame): canonicalSlot leaves it alone,
 * normaliseSlotLabel answers '3PM to 7PM'.
 *
 * Swapping one for the other is a real bug in both directions. Using
 * normaliseSlotLabel on the READ side silently re-labels the 79,364 rows of
 * legacy free text this column carries; using canonicalSlot on the WRITE side
 * would let a 1-hour frame label back into tbl_job.time_slot, which is the
 * experiment the whole module exists to keep reversed.
 */

/*
 * foldSlot(v) → the COMPARISON form of a slot string: lower-cased with ALL
 * whitespace removed. Never stored, never displayed, never returned to a
 * caller — it exists only to answer "do these two strings name the same band?".
 *
 * WHY IT HAS TO EXIST. MySQL's default collation is case-insensitive, so
 * `time_slot = '9AM to 12PM'` DOES match a row storing '9am to 12pm' — but it
 * does NOT match '9 am to 12 pm', because collation folds CASE, not SPACES.
 * Prod carries both spellings of the morning band, so byte (or collation)
 * equality silently drops rows that are unambiguously the same window.
 *
 * Byte-mirror of `foldSlot` in Easyfix_CRM_UI/src/lib/job-slots.ts, and mirrored
 * again in SQL as REPLACE(LOWER(col), ' ', '') by the availability count in
 * services/integration.service.js. Keep all three in step.
 */
function foldSlot(v) {
  return String(v == null ? '' : v).toLowerCase().replace(/\s+/g, '');
}

/* Folded spelling → the canonical band it names. Built once, from the four. */
const BAND_BY_FOLD = new Map(TIME_SLOT_BANDS.map((b) => [foldSlot(b), b]));

/*
 * canonicalSlot(value) → the canonical spelling of a stored slot when it names
 * one of the four bands with only cosmetic differences ('3pm to 7pm' →
 * '3PM to 7PM', '9 am to 12 pm' → '9AM to 12PM'); the TRIMMED INPUT otherwise,
 * and '' for an absent value.
 *
 * DELIBERATELY NARROW — case and spacing only. 'Morning 9 to 2', '9-12' and
 * '3 PM–4 PM' are genuinely different strings and pass through untouched.
 * Folding those would mean PICKING a band on the caller's behalf, which is
 * normaliseSlotLabel's job at save time, not something a read-side compare may
 * do silently.
 *
 * READ-SIDE ONLY. It does not decide what gets stored — resolveTimeSlot has the
 * final say on what lands in tbl_job.time_slot.
 */
function canonicalSlot(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  return BAND_BY_FOLD.get(foldSlot(raw)) || raw;
}

/*
 * normaliseSlotLabel(label) → the canonical band a slot LABEL denotes, or null
 * when the label carries no readable hour.
 *
 * ⚠ NOT canonicalSlot. This one INTERPRETS — see the comparison note above.
 * It is a writer-side judgement; canonicalSlot is the read-side cosmetic fold.
 *
 * Accepts, without caring which picker produced it:
 *   - the four canonical bands (identity)
 *   - the spaced-en-dash bands the customer form still displays
 *     ('9 AM – 12 PM', '12 PM – 3 PM', '3 PM – 7 PM')
 *   - the 1-hour frames ('3 PM–4 PM', '10 AM - 11 AM') → the CONTAINING band
 *   - bare clock text ('15:00', '9-12', '12-3')
 *   - the 'After Hours' family, including 'After Hours - 19:00'
 * Returns null for the free-text legacy vocabulary ('Morning 9 to 2',
 * 'morning 9 to night 8', 'Anytime', …) — we refuse to guess an hour that was
 * never written down; the caller falls back to the appointment datetime.
 */
function normaliseSlotLabel(label) {
  const raw = String(label == null ? '' : label).trim();
  if (!raw) return null;
  if (BAND_SET.has(raw)) return raw;
  if (/^after\s*hours?\b/i.test(raw)) return BAND_AFTER_HOURS;

  // Leading clock token: "3 PM–4 PM" / "9 AM – 12 PM" / "15:00" / "9-12".
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i.exec(raw);
  if (!m) return null;
  let h = Number(m[1]);
  if (!Number.isFinite(h) || h > 23) return null;
  const mer = m[3] ? m[3].replace(/\./g, '').toLowerCase() : null;
  if (mer === 'pm') { if (h < 12) h += 12; }
  else if (mer === 'am') { if (h === 12) h = 0; }
  // No meridiem: a bare 1–8 is afternoon/evening — no booking window starts
  // before 9 AM, so "3-7" means 3 PM, never 3 AM. Same rule the WhatsApp
  // free-text parser applies (parseOneHourSlot).
  else if (h >= 1 && h <= 8) h += 12;
  return bandForHour(h);
}

/*
 * resolveTimeSlot(inputSlot, requestedDateTime) → the value to STORE in
 * tbl_job.time_slot. This is the single writer-side gate: every create /
 * schedule-edit / customer-submit path runs its slot through here, which is
 * what guarantees a 1-hour label can never land in the column again.
 *
 * Precedence:
 *   1. The appointment INSTANT wins whenever it carries a real time-of-day —
 *      time_slot is by definition the band containing requested_date_time, so
 *      a caller-supplied label can never contradict it.
 *   2. Otherwise (date-only booking / midnight sentinel) the caller's own
 *      label is the only signal we have: canonicalise it when we can read an
 *      hour out of it.
 *   3. An unrecognisable legacy label with no appointment time passes through
 *      VERBATIM. We do not invent a band we cannot justify — and since nothing
 *      matches on the string any more, carrying it costs nothing.
 *   4. Nothing at all → the datetime derivation (null, or 'After Hours' for a
 *      bare date), preserving the historical create() fallback.
 */
function resolveTimeSlot(inputSlot, requestedDateTime) {
  if (hasTimeOfDay(requestedDateTime)) return deriveTimeSlot(requestedDateTime);
  const band = normaliseSlotLabel(inputSlot);
  if (band) return band;
  const raw = String(inputSlot == null ? '' : inputSlot).trim();
  if (raw) return raw;
  return deriveTimeSlot(requestedDateTime);
}

// ─── 1-hour conflict window ──────────────────────────────────────────
/*
 * conflictFrame(dt) → { date: 'YYYY-MM-DD', hour: 0-23 } | null
 *
 * The 1-HOUR FRAME an appointment falls in — the unit of double-booking.
 *
 * A technician conflicts with another job when both sit in the SAME frame. This
 * is deliberately NOT a sliding ±1h window: under a sliding window a 09:00 job
 * and a 10:00 job "overlap" and one of them wrongly loses the technician, when
 * in reality they are two consecutive, perfectly bookable hours. Frame equality
 * says 09:00 and 10:00 are different slots, while 10:00 and 10:30 are the same
 * one — which is what "same 1-hour slot" actually means.
 *
 * No windowMinutes parameter: the frame IS the hour. Making the width
 * configurable would let a wider setting resurrect the band-style
 * over-exclusion this model was built to remove.
 *
 * Returns null when there is no real time-of-day (midnight sentinel, date-only,
 * NULL) — the caller must then skip the conflict check entirely rather than
 * excluding technicians on no evidence.
 */
function conflictFrame(dt) {
  if (!hasTimeOfDay(dt)) return null;
  const p = parseWallClock(dt);
  if (!p) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return { date: `${p.y}-${pad(p.mo)}-${pad(p.d)}`, hour: p.h };
}

/* JS mirror of the SQL predicate — same frame ⇒ conflict. Kept beside it so the
 * recommender, the unit tests and the query can never drift apart. */
function sameConflictFrame(a, b) {
  const fa = conflictFrame(a);
  const fb = conflictFrame(b);
  if (!fa || !fb) return false;
  return fa.date === fb.date && fa.hour === fb.hour;
}


module.exports = {
  TIME_SLOT_BANDS,
  BAND_MORNING,
  BAND_AFTERNOON,
  BAND_EVENING,
  BAND_AFTER_HOURS,
  SLOT_START_HOURS,
  slotHour,
  hasTimeOfDay,
  wallClockTime,
  formatClock12,
  bandForHour,
  deriveTimeSlot,
  // READ-side cosmetic fold (case + spacing). NOT interchangeable with
  // normaliseSlotLabel below — see the comparison note above canonicalSlot.
  canonicalSlot,
  normaliseSlotLabel,
  resolveTimeSlot,
  conflictFrame,
  sameConflictFrame,
};
