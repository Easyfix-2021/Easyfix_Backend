const logger = require('../logger');
const gallabox = require('./gallabox.whatsapp.service');
const ai = require('./ai.service');
const maps = require('./maps.service');
const jml = require('./job-magic-link.service');
const addressService = require('./address.service');
const s3 = require('../utils/s3-storage');
// The appointment slot model. The chat OFFERS 1-hour frames; STORAGE is
// requested_date_time + requested_time (the 1-hour start) and a BAND in
// time_slot. See services/time-slot.js.
const slotModel = require('./time-slot');

/*
 * services/whatsapp-conversation.service.js
 *
 * Inbound, stateful, AI-assisted WhatsApp conversation that CONFIRMS an
 * unconfirmed order's already-scheduled visit IN CHAT (an alternative to the
 * magic-link FORM, selectable per client). Built on Gallabox.
 *
 * ─── FLOW (2026-07-30 rework) ─────────────────────────────────────────
 *
 * The opening template's premise INVERTED. It used to be "tell us when you
 * want the service" (template `confirm_order_flow`, step awaiting_datetime).
 * It is now "your visit is ALREADY scheduled — please confirm it"
 * (template `customer_interactive_msg`, step awaiting_choice) with three
 * pre-approved quick-reply buttons.
 *
 *   awaiting_choice            → 3 template buttons:
 *                                 "Yes, Confirm"          → Branch A
 *                                 "Need a Reschdeule"     → Branch B  [sic]
 *                                 "Service Not Required"  → Branch C
 *
 *   BRANCH A — confirm the existing date
 *     awaiting_slot            → customer picks a 1-HOUR frame (free text,
 *                                deterministically parsed, AI fallback)
 *                              → FINALISE IMMEDIATELY (writeCustomerOrderDetails)
 *                              → awaiting_extras
 *
 *   BRANCH B — reschedule
 *     awaiting_reschedule_date → customer gives a FUTURE date (past rejected
 *                                with a friendly re-ask; we never write a past
 *                                appointment)
 *                              → awaiting_slot → FINALISE → awaiting_extras
 *
 *   BRANCH C — not required
 *     awaiting_cancel_reason   → FREE TEXT; AI classifies into the existing
 *                                reason categories (+ 'Other'), the VERBATIM
 *                                text is stored alongside → close
 *
 *   awaiting_extras            → PURELY OPTIONAL, runs AFTER the job is
 *                                already confirmed:
 *                                  • photos/videos → existing media ingest
 *                                  • location pin  → tbl_address.gps_location
 *                                  • silence       → still fully confirmed
 *
 * ⚠ ORDERING IS DELIBERATE: the confirmation write happens BEFORE the optional
 * extras step, so a customer who drops off after confirming is still fully
 * confirmed. Nothing in awaiting_extras can invalidate the confirmation.
 *
 * ⚠ awaiting_extras keeps the conversation row `status = 'active'` on purpose —
 * getActiveByMobile() only resolves active rows, so closing the row at finalise
 * time would make the optional photos/location unroutable. `context.finalised`
 * marks that the job is already committed.
 *
 * State lives in tbl_whatsapp_conversation (one active row per job).
 * `current_step` is VARCHAR(40) (migrations/executed/2026-06-03-whatsapp-
 * conversation.sql) — NOT an enum — so the new step names need no migration.
 * The state machine owns the flow + every DB write. ai.service INTERPRETS
 * inbound free text and, since 2026-08-13, also PHRASES the outbound step
 * prompts and the closing confirmation — but it never decides a step and never
 * decides a write. See `phrase()` below for the exact boundary and why it is a
 * safety property rather than an implementation detail. All outbound sends honour
 * NOTIFICATIONS_DISABLE + TEST_MOBILE via the gallabox senders. The FIRST
 * message is a pre-approved template (24h-window rule); everything after is
 * free-form/interactive in-session.
 */

/*
 * ⚠ EXACT quick-reply payload strings from the APPROVED Gallabox template
 * `customer_interactive_msg`. Gallabox/Meta match a tapped button on the
 * PAYLOAD string, so these must go out verbatim.
 *
 * "Need a Reschdeule" is MISSPELLED. The misspelling is INTENTIONAL here
 * because it is what the UPSTREAM approved template contains. Do NOT "fix"
 * the spelling: correcting it silently breaks button matching (and a template
 * edit requires re-approval by Meta). Inbound matching is case-insensitive and
 * trimmed, and also tolerates the correctly-spelled variant, so a future
 * template re-approval will not need a code change here — but the OUTBOUND
 * payload stays byte-for-byte as approved.
 */
const BTN_PAYLOAD = Object.freeze({
  CONFIRM:      'Yes, Confirm',
  RESCHEDULE:   'Need a Reschdeule', // [sic] — upstream template misspelling, keep verbatim
  NOT_REQUIRED: 'Service Not Required',
});

// Stable button ids the inbound webhook maps interactive replies onto.
const BTN = {
  // In-session (non-template) buttons.
  EXTRAS_DONE:  'extras_done',
  // ── Superseded by the 2026-07-30 rework, retained for IN-FLIGHT rows ──
  NO_SERVICE:   'no_service',
  REASON_SELF:  'reason_self_assembly',
  REASON_SITE:  'reason_site_not_ready',
  REASON_DONE:  'reason_work_completed',
  UPLOAD:       'upload_media',
  NO_PICS:      'no_pics',
  MEDIA_DONE:   'media_done',
};

const STEP = {
  // ── Current flow ──
  CHOICE:        'awaiting_choice',
  SLOT:          'awaiting_slot',
  RESCHED_DATE:  'awaiting_reschedule_date',
  CANCEL_REASON: 'awaiting_cancel_reason',
  EXTRAS:        'awaiting_extras',
  // ── Reused ──
  MEDIA:         'awaiting_media',            // media ingest (shared with EXTRAS)
  /*
   * ── SUPERSEDED (2026-07-30) ──────────────────────────────────────────
   * DATETIME / LOCATION / MEDIA_PICK / NO_SERVICE are no longer reachable from
   * a NEW conversation (startConversation now opens at CHOICE). They are kept —
   * not ripped out — because rows created before this deploy can still be
   * parked on them inside their 24h window, and the DB default for
   * `current_step` is still 'awaiting_datetime'. Their handlers below are
   * likewise retained. Delete only once no active row references them.
   */
  DATETIME:      'awaiting_datetime',
  NO_SERVICE:    'awaiting_no_service_reason',
  MEDIA_PICK:    'awaiting_media_choice',
  LOCATION:      'awaiting_location',
};

const MAX_PHOTOS = 5;
const SESSION_HOURS = 24;

/*
 * Pre-approved Gallabox template that OPENS the conversation. The Gallabox
 * wrapper resolves templates by NAME (the dashboard id is authoring-only).
 *
 * Body variables are NAMED (not positional 1/2 like the superseded
 * `confirm_order_flow`): client_name, name, date, address.
 */
const CONVERSATION_TEMPLATE_NAME = 'customer_interactive_msg';

/*
 * buttonValues for `customer_interactive_msg` — deliberately EMPTY.
 *
 * ─── WHY EMPTY, AND NOT "THE THREE QUICK REPLIES" ──────────────────────────
 *
 * This used to send:
 *   [{ index: 0, type: 'quick_reply', payload: BTN_PAYLOAD.CONFIRM }, …]
 * and Gallabox rejected EVERY send with HTTP 400:
 *   whatsapp.template.buttonValues.0.parameters: Path `parameters` is required.
 * (observed on jobId 523247, 2026-08-03 — a Mongoose "required path" error, so
 * `parameters` is a hard schema requirement on each buttonValues entry.)
 *
 * A button component exists to carry a VARIABLE into a button. These three quick
 * replies have no variable: their payloads are baked into the Meta-approved
 * template — which is exactly why BTN_PAYLOAD.RESCHEDULE has to stay misspelled
 * ("Need a Reschdeule"). We were sending a component to restate constants the
 * template already owns, and getting the schema wrong doing it.
 *
 * The shape was wrong in two ways at once, which is worth recording so nobody
 * "fixes" it by adding `parameters` to the old structure. Every working Gallabox
 * call in the legacy Java services (ACD_APIs/WhatsNotificationUtil.java,
 * EasyFix_CRM/NewAppAllNotification.java) uses:
 *     { "index": 0, "sub_type": "url", "parameters": { "type": "text", "text": … } }
 * — `sub_type`, not `type`, and `parameters` as an OBJECT, not an array. Those
 * are all URL buttons carrying a real variable. No legacy sender uses
 * quick_reply at all, so there is no in-repo evidence for a quick_reply
 * parameter shape, and Gallabox's public docs do not specify one.
 *
 * `[]` is not a guess: the same legacy senders ship `"buttonValues": []` for
 * templates with no dynamic button data (eta_sent_clone_clone, cancel_order) and
 * those deliver in production. Inbound matching is unaffected — the webhook
 * reports the button payload the TEMPLATE defines, which is what
 * routes/webhook/whatsapp.js already matches on.
 *
 * If Meta ever re-approves this template with variable button payloads, the send
 * will fail loudly with a button-parameter-count error rather than silently — at
 * which point the correct shape must be confirmed against Gallabox, not guessed.
 */
function templateButtonValues() {
  return [];
}

// ── Pure helpers (exported — unit-tested in tests/whatsapp-conversation.test.js) ──

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// IST calendar day ('YYYY-MM-DD') for a UTC instant. IST is a fixed +05:30
// offset (no DST), so shifting then reading UTC getters yields IST wall-clock —
// independent of the server's own timezone.
function istDateString(nowMs = Date.now()) {
  return new Date(nowMs + IST_OFFSET_MS).toISOString().slice(0, 10);
}

// IST wall-clock 'HH:MM' for a UTC instant.
function istTimeString(nowMs = Date.now()) {
  return new Date(nowMs + IST_OFFSET_MS).toISOString().slice(11, 16);
}

/*
 * The 1-HOUR appointment frames the customer may choose (IST wall-clock).
 * 9 AM → 7 PM, i.e. ten one-hour frames starting on the hour.
 *
 * PRESENTATION ONLY. These labels are what the customer sees and taps; the
 * chosen frame's START is what gets persisted (requested_date_time's
 * time-of-day + requested_time), and tbl_job.time_slot receives the BAND
 * containing it. No label from this list is ever written to a column, so the
 * old "the en-dash spacing is load-bearing because candidate-ranking does
 * `AND time_slot = ?`" constraint is retired — that equality is gone (the
 * conflict test is a datetime overlap now). Spelling is kept stable anyway
 * because parseOneHourSlot round-trips our own echoed labels.
 *
 * Shared shape with services/time-slot.js SLOT_START_HOURS — same ten hours.
 */
const SLOT_START_HOURS = slotModel.SLOT_START_HOURS;

/*
 * hour12Label(h) → '9 AM', '12 PM', '7 PM' — ONE END of a frame label.
 *
 * ⚠ NOT time-slot.formatClock12, and deliberately not delegating to it.
 *   • Different input: a bare 0–23 HOUR, not an IST wall-clock datetime.
 *     Routing it through formatClock12 would mean fabricating a meaningless
 *     calendar date ('2000-01-01 09:00') just to get the hour back out.
 *   • Different midnight rule, which is the substantive one. formatClock12
 *     treats 00:00 as the "no time was ever captured" SENTINEL and returns
 *     null; here hour 0 is a real clock position and must render '12 AM'. The
 *     two agree on every other hour (verified 0–24), so the divergence is
 *     exactly midnight — and midnight is precisely where an 'After Hours'
 *     frame would land if SLOT_START_HOURS is ever widened past 9 AM–7 PM.
 *     Delegating would turn that into a label reading 'null–1 AM'.
 * Today only hours 9–19 reach this (SLOT_START_HOURS and their +1), where the
 * two are identical — but the sentinel semantics are not, so it stays local.
 */
function hour12Label(h) {
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12} ${suffix}`;
}

function pad2(n) { return String(n).padStart(2, '0'); }

// Build the slot descriptor for a 24h start hour, or null when the hour is not
// one of the offered frames.
function slotForHour(h) {
  if (!SLOT_START_HOURS.includes(h)) return null;
  return Object.freeze({
    hour:  h,
    start: `${pad2(h)}:00`,
    end:   `${pad2(h + 1)}:00`,
    label: `${hour12Label(h)}–${hour12Label(h + 1)}`,
  });
}

const ONE_HOUR_SLOTS = Object.freeze(SLOT_START_HOURS.map(slotForHour));
const ONE_HOUR_SLOT_LABELS = Object.freeze(ONE_HOUR_SLOTS.map((s) => s.label));

/*
 * Normalise customer free text for parsing: lowercase, unicode dashes → '-',
 * collapse whitespace. Never throws on non-strings.
 */
function normaliseCustomerText(raw) {
  return String(raw == null ? '' : raw)
    .toLowerCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

const CLOCK_RE = /(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/g;
// A range separator between two clock tokens ("3-4 pm", "4 to 5", "9 am - 10 am").
const RANGE_SEP_RE = /(?:-|\bto\b|\band\b|\btill\b|\buntil\b|\bthru\b)/;

/*
 * parseOneHourSlot(text) → slot descriptor | null
 *
 * Deterministic parse of messy customer input into one of ONE_HOUR_SLOTS.
 * Handles: "10am", "10 AM", "16:00", "4pm", "3-4 pm", "between 4 and 5",
 * "9 AM–10 AM" (our own echoed label), "noon", "10:30" (snaps DOWN to the
 * containing hour).
 *
 * Rules:
 *   • RANGE input ("3-4 pm") → the FIRST token is the slot START.
 *   • non-range input → prefer the token that carries its own am/pm.
 *   • a bare 1–8 with no meridiem is read as afternoon/evening (1 → 13:00),
 *     because no frame starts before 9 AM.
 *   • anything landing outside SLOT_START_HOURS returns null, so the caller
 *     re-asks (or hands off to ai.service) rather than writing a bad slot.
 */
function parseOneHourSlot(text) {
  const s = normaliseCustomerText(text);
  if (!s) return null;

  const cands = [];
  for (const m of s.matchAll(CLOCK_RE)) {
    cands.push({
      h:     Number(m[1]),
      mer:   m[3] ? (m[3][0] === 'a' ? 'am' : 'pm') : null,
      start: m.index,
      stop:  m.index + m[0].length,
    });
  }
  if (!cands.length) return /\bnoon\b/.test(s) ? slotForHour(12) : null;

  const isRange = cands.length >= 2 && RANGE_SEP_RE.test(s.slice(cands[0].stop, cands[1].start));
  const pick = isRange ? cands[0] : (cands.find((c) => c.mer) || cands[0]);
  const mer = pick.mer || (cands.find((c) => c.mer) || {}).mer || null;

  let h = pick.h;
  if (!Number.isInteger(h) || h < 0 || h > 24) return null;
  if (mer === 'pm' && h < 12) h += 12;
  else if (mer === 'am' && h === 12) h = 0;
  else if (!mer && h >= 1 && h <= 8) h += 12; // no frame starts before 9 AM
  return slotForHour(h);
}

/*
 * slotByLabelOrStart(value) → slot descriptor | null
 *
 * Exact-ish lookup used for AI output ('HH:MM' start) and for a tapped button
 * whose id/title is one of our own labels.
 */
function slotByLabelOrStart(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return null;
  const hhmm = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (hhmm) return slotForHour(Number(hhmm[1]));
  const norm = normaliseCustomerText(raw);
  const hit = ONE_HOUR_SLOTS.find((s) => normaliseCustomerText(s.label) === norm);
  return hit || null;
}

/*
 * matchTemplateChoice(value) → 'confirm' | 'reschedule' | 'not_required' | null
 *
 * Matches an inbound button payload (or the raw text a customer typed / the
 * button TITLE, depending on how the BSP delivers a quick reply) onto one of
 * the three template branches.
 *
 * Matching is case-insensitive + whitespace-trimmed for robustness, and
 * tolerates BOTH the upstream misspelling "Need a Reschdeule" AND the correct
 * "Need a Reschedule" — so a future template re-approval that fixes the typo
 * needs no code change. The OUTBOUND payload stays exactly as approved.
 */
function matchTemplateChoice(value) {
  const s = normaliseCustomerText(value).replace(/[.!]+$/, '');
  if (!s) return null;
  if (s === normaliseCustomerText(BTN_PAYLOAD.CONFIRM)) return 'confirm';
  if (s === normaliseCustomerText(BTN_PAYLOAD.RESCHEDULE)) return 'reschedule';
  if (s === normaliseCustomerText(BTN_PAYLOAD.NOT_REQUIRED)) return 'not_required';
  // Tolerant variants (typed replies, corrected template spelling, BSP quirks).
  if (/^(yes,?\s*confirm(ed)?|confirm(ed)?|yes)$/.test(s)) return 'confirm';
  if (/resch?ed(ule|eule|uele)?/.test(s) || /\breschdeule\b/.test(s)) return 'reschedule';
  if (/(service\s+)?not\s+(required|needed)/.test(s) || /don'?t\s+need/.test(s)) return 'not_required';
  return null;
}

/*
 * parseCustomerDate(text, nowMs) → 'YYYY-MM-DD' | null
 *
 * Deterministic date parse for the reschedule step. Understands
 * today/tomorrow/day-after, ISO, DD-MM(-YYYY), "5 Aug"/"Aug 5" (+optional
 * year) and bare weekday names ("monday", "next monday"). Everything is
 * resolved against the IST calendar day.
 *
 * When no year is given we take the current IST year and roll forward one year
 * if that lands in the past — so "5 Jan" in December means next January.
 * Returns null for anything ambiguous; the caller then asks ai.service.
 */
function parseCustomerDate(text, nowMs = Date.now()) {
  const s = normaliseCustomerText(text);
  if (!s) return null;
  const today = istDateString(nowMs);

  const addDays = (isoDate, n) => new Date(Date.parse(`${isoDate}T00:00:00Z`) + n * 86400000)
    .toISOString().slice(0, 10);

  if (/\b(today|tonight|aaj)\b/.test(s)) return today;
  if (/\bday\s*after\s*(tomorrow|tmrw)?\b/.test(s)) return addDays(today, 2);
  if (/\b(tomorrow|tomorow|tmrw|tmr|kal)\b/.test(s)) return addDays(today, 1);

  // ISO YYYY-MM-DD
  const iso = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(s);
  if (iso) return buildIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // "5 Aug 2026" / "5 August" / "5th aug"
  const dm = /\b(\d{1,2})(?:st|nd|rd|th)?[\s./-]*([a-z]{3,9})\.?(?:[\s,./-]*(\d{2,4}))?\b/.exec(s);
  if (dm) {
    const mon = monthIndex(dm[2]);
    if (mon != null) return resolveYear(Number(dm[1]), mon, dm[3], today);
  }
  // "Aug 5 2026" / "august 5th"
  const md = /\b([a-z]{3,9})\.?[\s./-]*(\d{1,2})(?:st|nd|rd|th)?(?:[\s,./-]*(\d{2,4}))?\b/.exec(s);
  if (md) {
    const mon = monthIndex(md[1]);
    if (mon != null) return resolveYear(Number(md[2]), mon, md[3], today);
  }
  // DD-MM-YYYY / DD/MM/YY / DD-MM  (day-first — Indian convention)
  const numeric = /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/.exec(s);
  if (numeric) return resolveYear(Number(numeric[1]), Number(numeric[2]) - 1, numeric[3], today);

  // Bare weekday → the NEXT occurrence strictly after today.
  const wd = /\b(sun|mon|tues?|wed(nes)?|thur?s?|fri|sat(ur)?)(day)?\b/.exec(s);
  if (wd) {
    const target = WEEKDAYS.findIndex((w) => wd[1].startsWith(w.toLowerCase().slice(0, 3))
      || w.toLowerCase().startsWith(wd[1].slice(0, 3)));
    if (target >= 0) {
      const todayDow = new Date(`${today}T00:00:00Z`).getUTCDay();
      let delta = (target - todayDow + 7) % 7;
      if (delta === 0) delta = 7;
      return addDays(today, delta);
    }
  }
  return null;
}

function monthIndex(name) {
  const n = String(name || '').slice(0, 3).toLowerCase();
  const i = MONTHS.findIndex((m) => m.toLowerCase() === n);
  return i >= 0 ? i : null;
}

function buildIsoDate(year, month1, day) {
  const mon = month1 - 1;
  if (!(mon >= 0 && mon <= 11) || !(day >= 1 && day <= 31)) return null;
  const d = new Date(Date.UTC(year, mon, day));
  // Reject overflow ("31 Feb" → 3 Mar).
  if (d.getUTCMonth() !== mon || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

// Resolve a day/month(+optional 2-or-4-digit year) against the IST today,
// rolling forward a year when the year was omitted and the date already passed.
function resolveYear(day, mon0, yearRaw, today) {
  if (!(mon0 >= 0 && mon0 <= 11)) return null;
  const curYear = Number(today.slice(0, 4));
  if (yearRaw) {
    let y = Number(yearRaw);
    if (y < 100) y += 2000;
    return buildIsoDate(y, mon0 + 1, day);
  }
  const same = buildIsoDate(curYear, mon0 + 1, day);
  if (!same) return null;
  return same < today ? buildIsoDate(curYear + 1, mon0 + 1, day) : same;
}

/*
 * isPastIstDate(dateStr, nowMs) → boolean
 * True when the calendar date is strictly BEFORE the IST today.
 */
function isPastIstDate(dateStr, nowMs = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return false;
  return String(dateStr) < istDateString(nowMs);
}

/*
 * validateAppointment(dateStr, startHHMM, nowMs)
 *   → { ok: true } | { ok: false, reason: 'invalid' | 'past_date' | 'past_slot' }
 *
 * The conversational twin of the platform's past-appointment gate: we NEVER
 * write an appointment that is already in the past.
 *   past_date — the calendar date itself has gone by.
 *   past_slot — the date is TODAY but the chosen 1-hour frame has already ended.
 * `startHHMM` may be omitted to validate the date alone (reschedule step).
 */
function validateAppointment(dateStr, startHHMM, nowMs = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return { ok: false, reason: 'invalid' };
  const today = istDateString(nowMs);
  if (String(dateStr) < today) return { ok: false, reason: 'past_date' };
  if (!startHHMM) return { ok: true };
  if (!/^\d{2}:\d{2}$/.test(String(startHHMM))) return { ok: false, reason: 'invalid' };
  if (String(dateStr) === today) {
    // The frame is one hour long; allow it while it has not yet ENDED.
    const endHour = Number(String(startHHMM).slice(0, 2)) + 1;
    if (`${pad2(endHour)}:00` <= istTimeString(nowMs)) return { ok: false, reason: 'past_slot' };
  }
  return { ok: true };
}

/*
 * formatCustomerDateLabel('2026-08-05') → 'Wed, 05 Aug 2026'
 * Customer-facing date rendering for the template's {{date}} and for the
 * confirmation message. Returns null on unparseable input so callers can
 * substitute a graceful fallback rather than "null"/"undefined".
 */
function formatCustomerDateLabel(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || '').trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(+d)) return null;
  return `${WEEKDAYS[d.getUTCDay()]}, ${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/*
 * formatGpsLocation(lat, lng) → "lat,lng" | null
 *
 * ⚠ FORMAT IS LOAD-BEARING. tbl_address.gps_location stores the legacy
 * "lat,lng" string (see routes/admin/customers.js and
 * maps.service.reverseGeocode, which builds `${latNum},${lngNum}`), and the
 * technician app reads that column for navigation. This helper reproduces that
 * exact serialisation — no JSON, no spaces, no parentheses. Non-finite input
 * returns null so we never persist "NaN,NaN".
 */
function formatGpsLocation(lat, lng) {
  // ⚠ Number(null) === 0 and Number('') === 0, so a missing coordinate would
  // otherwise serialise to "0,0" — a real point in the Gulf of Guinea that the
  // technician app would happily navigate to. Reject the empties BEFORE coercing.
  const empty = (v) => v == null || (typeof v === 'string' && v.trim() === '') || typeof v === 'boolean';
  if (empty(lat) || empty(lng)) return null;
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return null;
  if (Math.abs(latNum) > 90 || Math.abs(lngNum) > 180) return null;
  return `${latNum},${lngNum}`;
}

/*
 * composeAddressLine({ address, landmark, city_name, pin_code }) → string
 *
 * Single-line address for the template's {{address}} variable.
 *
 * • NEWLINES/TABS ARE STRIPPED — WhatsApp rejects a template body parameter
 *   containing newlines, tabs or runs of 4+ spaces, and tbl_address.address is
 *   free text that frequently contains them.
 * • `building` is deliberately EXCLUDED. Per this codebase's address column
 *   roles, `address` is the booked address text while `building` doubles as the
 *   MAP-SEARCH field (see tests/job-magic-link-write.test.js "the map-search
 *   text persists to tbl_address.building") — injecting search text into a
 *   customer-facing message would garble it.
 * • Duplicate fragments are dropped (a landmark often repeats the city).
 * • Truncated to 900 chars: comfortably inside the template body limit.
 */
function composeAddressLine(parts = {}) {
  const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const seen = new Set();
  const out = [];
  for (const v of [parts.address, parts.landmark, parts.city_name, parts.pin_code]) {
    const c = clean(v);
    if (!c) continue;
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out.join(', ').slice(0, 900);
}

/*
 * Reason model for Branch C. The three labels are the ones the SUPERSEDED
 * awaiting_no_service_reason step already wrote to tbl_job_customer_request, so
 * existing CRM reporting keeps working unchanged; 'other' is the new fallback
 * for free text that matches none of them.
 *
 * request_type drives the CRM chip: 'cancel' vs 'reschedule'.
 */
const REASON_BY_CODE = Object.freeze({
  self_assembly:  { type: 'cancel',     label: 'Self Assembly' },
  site_not_ready: { type: 'reschedule', label: 'Site Not Ready' },
  work_completed: { type: 'cancel',     label: 'Work already completed' },
  other:          { type: 'cancel',     label: 'Other' },
});

// mapReasonCode(code) → { code, type, label } — always resolves (unknown → other).
function mapReasonCode(code) {
  const key = String(code || '').toLowerCase().trim();
  const hit = REASON_BY_CODE[key];
  return hit ? { code: key, ...hit } : { code: 'other', ...REASON_BY_CODE.other };
}

/*
 * classifyReasonKeyword(text) → reason code | null
 *
 * Deterministic keyword fallback used when ai.service is disabled/unavailable,
 * so Branch C still classifies (degraded) instead of crashing or dropping the
 * reply. Returns null when nothing matches — the caller then stores 'other'
 * with the verbatim text, which is the honest outcome.
 */
function classifyReasonKeyword(text) {
  const s = normaliseCustomerText(text);
  if (!s) return null;
  if (/(self|myself|my own|own self|diy)\b.*(assembl|install|fix|did)|assembled?\s+(it\s+)?(myself|my own)|did it myself/.test(s)) return 'self_assembly';
  if (/(site|place|room|house|flat|premises).*(not ready|isn'?t ready|under (renovation|construction))|not ready/.test(s)) return 'site_not_ready';
  if (/(already|has been|have been)\s*(done|completed|fixed|installed|serviced)|work\s+(is\s+)?(done|completed)|someone else (did|fixed)/.test(s)) return 'work_completed';
  return null;
}

// ── Conversation row plumbing ───────────────────────────────────────────

function parseContext(row) {
  if (!row || row.context == null) return {};
  if (typeof row.context === 'object') return row.context;
  try { return JSON.parse(row.context); } catch { return {}; }
}

/*
 * THE ONE phone-matching rule, shared by every conversation lookup.
 *
 * Match on the LAST 10 DIGITS so 91-prefix / +91 / no-prefix variants all
 * resolve to the same customer.
 *
 * ⚠ Both halves live here on purpose. getActiveByMobile below and the
 * no-active-conversation DIAGNOSIS further down must match identically: if the
 * two drifted, the diagnosis would describe a row the real lookup never
 * considered — it would lie about the very lookup it exists to explain, which
 * is the exact failure mode it was written to end.
 *
 * The SQL fragment is a module constant interpolated into the query text; the
 * phone itself stays a bound `?` parameter.
 *
 * Not sargable (the expression wraps the column), so idx_wac_mob cannot serve
 * either query — known and accepted: the table is small, and the diagnosis only
 * ever runs on the unhappy path.
 */
const MOBILE_MATCH_SQL = "RIGHT(REPLACE(customer_mob_no, ' ', ''), 10) = ?";

function mobileMatchKey(mobile) {
  const norm = gallabox.normaliseIndianPhone(mobile) || String(mobile || '');
  return norm.replace(/\D/g, '').slice(-10);
}

async function getActiveByMobile(mobile, pool) {
  const [rows] = await pool.query(
    `SELECT * FROM tbl_whatsapp_conversation
      WHERE status = 'active' AND ${MOBILE_MATCH_SQL}
      ORDER BY conversation_id DESC LIMIT 1`,
    [mobileMatchKey(mobile)],
  );
  return rows[0] || null;
}

async function updateConversation(id, fields, pool) {
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'context') { sets.push('context = ?'); params.push(JSON.stringify(v || {})); }
    else { sets.push(`${k} = ?`); params.push(v); }
  }
  if (!sets.length) return;
  params.push(id);
  await pool.query(`UPDATE tbl_whatsapp_conversation SET ${sets.join(', ')} WHERE conversation_id = ?`, params);
}

/*
 * loadJobForConversation(jobId, pool)
 *
 * Everything the opening template + the state machine need about the job.
 *
 * {{date}}    ← tbl_job.requested_date_time (the scheduled/appointment date;
 *               `original_appointment_date_time` is the pre-reschedule
 *               SNAPSHOT, so it is NOT what the customer should be shown) —
 *               BOTH its date (`appointment_date`) and its hour
 *               (`appointment_time`), falling back to tbl_job.time_slot's band
 *               label only when the hour is the 00:00 sentinel. See
 *               jobDateLabel for why the legacy requested_time TEXT column is
 *               projected but NOT used for the hour.
 * {{address}} ← tbl_address (via tbl_job.fk_address_id) `address` + `landmark`
 *               + tbl_city.city_name + `pin_code`. See composeAddressLine for
 *               why `building` is excluded.
 *
 * requested_date_time is projected through DATE_FORMAT so we get the stored IST
 * wall-clock date as a plain 'YYYY-MM-DD' string, never a driver-localised Date.
 */
async function loadJobForConversation(jobId, pool) {
  const [[job]] = await pool.query(
    `SELECT j.job_id, j.job_status, j.time_slot, j.requested_time,
            DATE_FORMAT(j.requested_date_time, '%Y-%m-%d') AS appointment_date,
            -- The AUTHORITATIVE appointment hour. requested_time is a legacy
            -- TEXT twin that is corrupted on historical rows (job.service's old
            -- reschedule ran an IST wall-clock literal back through
            -- formatTimeIST(), adding +05:30 a second time — job 482474 has
            -- requested_date_time 16:00 and requested_time 21:30), and those
            -- rows are deliberately NOT migrated. So the DATETIME's own
            -- time-of-day is projected and preferred; see jobDateLabel.
            DATE_FORMAT(j.requested_date_time, '%H:%i') AS appointment_time,
            j.fk_address_id,
            c.customer_mob_no,
            COALESCE(j.job_customer_name, c.customer_name) AS customer_name,
            cl.client_name,
            ad.address, ad.landmark, ad.pin_code,
            ci.city_name
       FROM tbl_job j
  LEFT JOIN tbl_customer c  ON c.customer_id = j.fk_customer_id
  LEFT JOIN tbl_client   cl ON cl.client_id  = j.fk_client_id
  LEFT JOIN tbl_address  ad ON ad.address_id = j.fk_address_id
  LEFT JOIN tbl_city     ci ON ci.city_id    = ad.city_id
      WHERE j.job_id = ? LIMIT 1`,
    [jobId],
  );
  return job || null;
}

/*
 * Human {{date}} value: "Wed, 05 Aug 2026" plus the booked window when one is
 * on file ("Wed, 05 Aug 2026, 3 PM"). Returns null when the job has no
 * scheduled date at all — the caller substitutes a friendly fallback so the
 * template never renders "null"/"undefined".
 *
 * PRECEDENCE 2026-07-31 — the APPOINTMENT HOUR first, the band only as the
 * fallback. The customer chose a 1-hour frame, so telling them "3 PM" is both
 * more precise and what they actually said; echoing "3PM to 7PM" back would
 * read as if we'd lost their choice.
 *
 * ⚠ THE HOUR COMES FROM requested_date_time, NOT requested_time. The two are
 * supposed to be twins, but requested_time is corrupted on every row that ever
 * passed through the old reschedule() — it re-parsed an IST wall-clock literal
 * as a real instant and added +05:30 again, so job 482474 carries
 * requested_date_time 16:00 alongside requested_time 21:30. Historical rows are
 * deliberately not migrated, so preferring the TEXT column would have sent that
 * customer a template reading "9:30 PM" for a 4 PM appointment. requested_date_time
 * is the appointment instant by definition and cannot drift from itself; it is
 * projected as `appointment_time` in loadJobForConversation.
 *
 * Legacy rows with no usable hour at all (the 00:00 sentinel) still fall back to
 * whatever label time_slot carries, in whichever of the dozen vocabularies it
 * happens to use — coarse, but never a wrong hour.
 */
function jobDateLabel(job) {
  const dateLabel = formatCustomerDateLabel(job && job.appointment_date);
  if (!dateLabel) return null;
  /*
   * appointment_date and appointment_time are two DATE_FORMAT projections of
   * the SAME column, so pairing them back up reconstitutes the IST wall clock
   * that time-slot.formatClock12 reads. That shared formatter owns both rules
   * this used to repeat inline: the 00:00 "no time captured" sentinel yields
   * null (so a legacy row falls through to its band instead of announcing
   * "12 AM"), and a whole hour drops the ':00' — "3 PM", not "3:00 PM".
   *
   * slice(0, 10) takes the 'YYYY-MM-DD' prefix formatCustomerDateLabel has
   * already validated; using the prefix rather than the whole value stops a
   * stray 'T00:00:00Z' tail from being read as the time-of-day.
   *
   * Equivalence with the inline formatter this replaced was checked over all
   * 1440 values DATE_FORMAT('%H:%i') can emit — byte-identical on every one.
   * It does rely on that projection's zero-padding ('09:30', never '9:30');
   * see the SELECT in loadJobForConversation.
   */
  const day = String((job && job.appointment_date) || '').trim().slice(0, 10);
  const clock = slotModel.formatClock12(`${day} ${String((job && job.appointment_time) || '').trim()}`);
  if (clock) return `${dateLabel}, ${clock}`;
  /*
   * Last resort: no readable clock, so the stored band is the only time signal
   * we have. canonicalSlot folds CASE AND SPACING ONLY — '3pm to 7pm' becomes
   * '3PM to 7PM' — so the customer never sees a lower-cased variant of a band
   * every other surface spells one way. Anything that is not cosmetically one of
   * the four bands ('Morning 9 to 2', '9-12') passes through untouched: this
   * must not GUESS a band, only tidy the spelling of one already stored.
   */
  const slot = slotModel.canonicalSlot(job.time_slot);
  if (slot) return `${dateLabel}, ${slot}`;
  return dateLabel;
}

const DATE_FALLBACK    = 'To be confirmed';
const ADDRESS_FALLBACK = 'The address on your order';

/*
 * startConversation(jobId, { action }, pool)
 *
 * Sends the initiating (pre-approved) template and upserts an active
 * conversation row at step awaiting_choice. Reuses the magic_link_* audit
 * columns on tbl_job for send cadence/cap (shared with the form path).
 * Returns { delivered, conversationId } or { error }.
 */
async function startConversation(jobId, { action = 'first' } = {}, pool) {
  logger.info('Starting WhatsApp conversation · job=' + jobId + ' · action=' + action);
  const job = await loadJobForConversation(jobId, pool);
  if (!job) logger.warn('Start conversation skipped · job ' + jobId + ' not found');
  if (!job) return { error: 'job not found' };
  if (Number(job.job_status) !== 9) logger.warn('Start conversation skipped · job=' + jobId + ' not Unconfirmed · status=' + job.job_status);
  if (Number(job.job_status) !== 9) return { error: 'job is not Unconfirmed (status != 9)' };
  if (!job.customer_mob_no) logger.warn('Start conversation skipped · job=' + jobId + ' has no customer mobile on file');
  if (!job.customer_mob_no) return { error: 'no customer mobile on file' };

  const dateLabel = jobDateLabel(job);
  const addressLine = composeAddressLine(job);
  if (!dateLabel) {
    logger.warn('Conversation template · job=' + jobId + ' has no scheduled date — sending the "' + DATE_FALLBACK + '" fallback');
  }

  const result = await gallabox.sendTemplate({
    to: job.customer_mob_no,
    recipientName: job.customer_name || '',
    templateName: CONVERSATION_TEMPLATE_NAME,
    // NAMED body variables (the approved template uses names, not 1/2/3).
    bodyValues: {
      client_name: job.client_name || 'EasyFix',
      name:        job.customer_name || 'there',
      date:        dateLabel || DATE_FALLBACK,
      address:     addressLine || ADDRESS_FALLBACK,
    },
    buttonValues: templateButtonValues(),
  });

  // Upsert the conversation row regardless of delivery (so an inbound reply
  // still resolves even if the provider ack was flaky) — but only when we
  // actually attempted a send (not suppressed-disabled in dev).
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600 * 1000);
  // Seed the context with the appointment we just ASKED the customer to
  // confirm, so Branch A does not have to re-read the job (and so the audit
  // payload records exactly what was shown).
  const seedCtx = {
    offered_date: job.appointment_date || null,
    offered_date_label: dateLabel || null,
    offered_address: addressLine || null,
  };
  const [existing] = await pool.query(
    `SELECT conversation_id FROM tbl_whatsapp_conversation
      WHERE job_id = ? AND status = 'active' ORDER BY conversation_id DESC LIMIT 1`,
    [jobId],
  );
  let conversationId;
  if (existing[0]) {
    conversationId = existing[0].conversation_id;
    await updateConversation(conversationId, {
      current_step: STEP.CHOICE, context: seedCtx, expires_at: expiresAt,
    }, pool);
  } else {
    const [ins] = await pool.query(
      `INSERT INTO tbl_whatsapp_conversation
         (job_id, customer_mob_no, status, current_step, context, expires_at)
       VALUES (?, ?, 'active', ?, ?, ?)`,
      [jobId, job.customer_mob_no, STEP.CHOICE, JSON.stringify(seedCtx), expiresAt],
    );
    conversationId = ins.insertId;
  }

  // Reuse the magic-link audit columns for cadence (shared cron cap).
  // Bound as a JS Date (NOT SQL NOW()): the pool is configured
  // `timezone: '+05:30'`, so a JS Date serialises to the IST wall-clock the
  // column is expected to hold, whereas NOW() resolves in the MySQL session
  // timezone (UTC on our hosts) and would store a 5h30m-early value.
  await pool.query(
    `UPDATE tbl_job
        SET magic_link_sent_at = ?,
            magic_link_send_count = magic_link_send_count + 1,
            magic_link_last_action = ?
      WHERE job_id = ?`,
    [new Date(), `conversation_${action}`, jobId],
  );

  /*
   * A NOT-DELIVERED send is a WARN, and the provider's reason is propagated.
   *
   * This returned `{delivered, suppressed, conversationId}` and dropped
   * `result.error` on the floor, so a provider rejection left one WARN line from
   * the Gallabox wrapper and an INFO line here saying the conversation started.
   * The route then logged "Magic link sent" and answered 200. Every send of
   * `customer_interactive_msg` was failing with an HTTP 400 and the CRM was
   * reporting success — which is why it took a log read to notice at all.
   *
   * `suppressed` (NOTIFICATIONS_DISABLE in dev) stays INFO: that is a
   * deliberately silenced send, not a failure.
   */
  const failed = !result.delivered && !result.disabled;
  const logLine = { jobId, conversationId, delivered: !!result.delivered };
  if (failed) {
    logger.warn({ ...logLine, err: result.error }, 'whatsapp-conversation: started but NOT delivered');
  } else {
    logger.info(logLine, 'whatsapp-conversation: started');
  }
  return {
    delivered: !!result.delivered,
    suppressed: !!result.disabled,
    conversationId,
    // Surfaced so the caller can tell the operator the message did not go out.
    error: failed ? (result.error || 'provider rejected the message') : undefined,
  };
}

/*
 * captureCustomerGps(jobId, location, pool) → "lat,lng" | null
 *
 * Persist the customer's shared location pin as NAVIGATION COORDINATES for the
 * technician. Writes ONLY tbl_address.gps_location (the GPS varchar) — it does
 * NOT reverse-geocode and does NOT touch the booked address text, which is ops
 * data with a different role.
 *
 * Best-effort by design: a failure here must never break the customer's reply,
 * because by the time we ask for a pin the visit is already confirmed.
 */
async function captureCustomerGps(jobId, location, pool) {
  const gps = formatGpsLocation(location && location.lat, location && location.lng);
  if (!gps) return null;
  try {
    const [[job]] = await pool.query('SELECT fk_address_id FROM tbl_job WHERE job_id = ? LIMIT 1', [jobId]);
    const addressId = job && job.fk_address_id;
    if (!addressId) {
      logger.warn('GPS capture skipped · job=' + jobId + ' has no fk_address_id');
      return null;
    }
    // COALESCE-guarded shared builder: every other address column arrives NULL
    // and therefore keeps its existing value.
    const write = addressService.buildCoalesceAddressUpdate(addressId, { gps_location: gps });
    await pool.query(write.sql, write.params);
    logger.info('Captured customer GPS · job=' + jobId + ' · gps=' + gps);
    return gps;
  } catch (err) {
    logger.warn({ jobId, err: err && err.message }, 'whatsapp-conversation: gps capture failed');
    return null;
  }
}

// ── No ACTIVE conversation: say WHICH case, and re-engage a late reply ───

/*
 * `reason=no_active_conversation` used to cover FOUR situations that need four
 * different responses, while distinguishing none of them:
 *
 *   never_started      no row has EVER existed for this number. The customer is
 *                      texting us cold, or the mobile on the job is not the one
 *                      they message from. Nothing to re-open.
 *   expired            a row existed and OUR OWN 24h session on it lapsed
 *                      (SESSION_HOURS — not Meta's customer service window,
 *                      which the customer's inbound has just re-opened) —
 *                      reported WITH AN AGE, because "expired 3h ago" and "9d
 *                      ago" are different problems: the first says re-trigger
 *                      the confirmation, the second says stop looking here.
 *   completed          the customer already finished the flow. Their reply is
 *                      conversation, not an unanswered prompt.
 *   closed_no_service  they told us they do not need the service at all.
 *
 * Telling those apart by hand cost four wrong turns during the 2026-08 inbound
 * incident — whose real cause was the envelope bug in routes/webhook/whatsapp.js
 * (see its normaliseInbound comment). This string was not the bug; it was what
 * made the bug unfalsifiable, twice supporting the wrong conclusion.
 *
 * ⚠ `reason` STAYS 'no_active_conversation' byte-for-byte: the webhook prints it
 * into its NOT-handled WARN and tests assert on it. The case rides in `detail`,
 * and the whole sentence in the INFO line below — which has to be actionable
 * without opening this file, because the person reading it at 11pm will not.
 */
const NO_CONVO = Object.freeze({
  NEVER_STARTED:     'never_started',
  EXPIRED:           'expired',
  COMPLETED:         'completed',
  CLOSED_NO_SERVICE: 'closed_no_service',
  UNKNOWN:           'diagnosis_failed',
});

/*
 * Coarse age for a log line: '45m', '3h', '9d'. Coarse ON PURPOSE — the reader
 * is deciding "re-trigger, or go looking somewhere else?", and that turns on the
 * order of magnitude, never on the minutes.
 */
function humanAgo(sinceMs, nowMs = Date.now()) {
  if (!Number.isFinite(sinceMs)) return null;
  const mins = Math.max(0, Math.floor((nowMs - sinceMs) / 60000));
  if (mins < 60) return mins + 'm';
  const hours = Math.floor(mins / 60);
  if (hours < 48) return hours + 'h';
  return Math.floor(hours / 24) + 'd';
}

/*
 * reengageExpired(row, pool) → outcome code
 *
 * A customer who replies after OUR conversation row expired otherwise gets
 * silence: nothing reaches them, nothing reaches ops. They get a FREE-FORM
 * reply carrying the confirmation link.
 *
 * ⚠ FREE-FORM IS LAWFUL HERE, AND A TEMPLATE WOULD BE A MISTAKE.
 * Meta's 24-hour customer service window OPENS on a customer message and RESETS
 * on each further one; inside it a business may send free-form service messages,
 * and a template is required only OUTSIDE it. We are replying WHILE HANDLING
 * THEIR INBOUND — their message just opened the window, so free-form is
 * deliverable right now.
 *
 * `status = 'expired'` on the row is OUR OWN bookkeeping (SESSION_HOURS, measured
 * from when WE started the conversation). It is not Meta's window and says
 * nothing about what we may send.
 *
 * This used to call jml.sendForJob, which sends the approved `confirm_order`
 * TEMPLATE and consumes the per-client "Max Magic-Link Send Count". That was not
 * merely unnecessary, it was harmful: it burned the client's magic-link budget
 * BECAUSE THE CUSTOMER TEXTED US. The cap exists to bound OUR outreach, so
 * spending it on their inbound is backwards — and a chatty customer could drain
 * the quota meant for other jobs. So: no template, no approval, no cap.
 *
 * ⚠ The LINK still comes from job-magic-link.service (buildShortLinkForJob), the
 * one place that mints the token, builds the url and shortens it. Re-deriving it
 * here is how the two links drift and one of them starts 404ing.
 * (job-magic-link.service does not require this module back, so the long-standing
 * `jml` import at the top of this file is not a cycle.)
 *
 * GUARD ORDER IS COST ORDER: the caller has already established EXPIRED from the
 * row in hand; we then spend one read on the job, and only then claim the
 * once-only marker. Nothing is claimed for a job we were never going to message.
 */
async function reengageExpired(row, pool) {
  const jobId = row.job_id;
  // Which side of the send a failure landed on. Without it, a DB hiccup on the
  // guard reads as "the provider rejected our message" — the same
  // one-string-four-causes mistake this whole change exists to undo.
  let claimed = false;
  try {
    /*
     * GUARD — still Unconfirmed. Past status 9 the visit is already settled and
     * the confirmation link would ask the customer to complete something that no
     * longer exists.
     */
    const [[job]] = await pool.query('SELECT job_status FROM tbl_job WHERE job_id = ? LIMIT 1', [jobId]);
    if (!job || Number(job.job_status) !== 9) return 'job_not_unconfirmed';

    /*
     * GUARD — AT MOST ONCE per conversation row. A customer who texts five times
     * must get one reply, not five, so the marker is CLAIMED (not merely read)
     * before the send: a single conditional UPDATE, serialised by the InnoDB row
     * lock, so two concurrent inbounds cannot both see "not yet re-engaged".
     * affectedRows === 0 means someone else already holds it.
     *
     * The flag lives in the row's `context` JSON — no migration, and it travels
     * with the conversation it describes. JSON_TYPE(...) = 'OBJECT' guards the
     * rows whose context is NULL or a JSON scalar; JSON_SET on those would
     * otherwise no-op and silently read as "already claimed".
     *
     * Bound as a JS Date, never NOW(): the pool is `timezone: '+05:30'`, so a JS
     * Date serialises to the IST wall clock every other stamp in this file uses.
     *
     * Trade-off, deliberate: the marker is burned even if the send then fails.
     * At-most-once is the property that protects the customer; a lost
     * re-engagement is a missing nicety, five of them is spam. Nothing else is
     * spent — this reply costs no template and no send-count slot.
     */
    const [claim] = await pool.query(
      `UPDATE tbl_whatsapp_conversation
          SET context = JSON_SET(IF(JSON_TYPE(context) = 'OBJECT', context, JSON_OBJECT()), '$.reengaged_at', ?)
        WHERE conversation_id = ?
          AND JSON_EXTRACT(IF(JSON_TYPE(context) = 'OBJECT', context, JSON_OBJECT()), '$.reengaged_at') IS NULL`,
      [new Date(), row.conversation_id],
    );
    if (!claim || !claim.affectedRows) return 'already_reengaged';
    claimed = true;

    /*
     * The link is built AFTER the claim so two concurrent inbounds cannot both
     * mint a token (the loser's shortener row would be a link nobody receives).
     *
     * Its own try/catch, so a link failure is never reported as a SEND failure —
     * the two want different fixes (a missing JWT_SECRET vs a provider outage),
     * and one line covering both is how this path became unreadable the first
     * time. Either way NOTHING is sent: a message telling the customer to tap
     * something that is not there reads as a broken system and invites a call.
     */
    let link = null;
    try {
      link = await jml.buildShortLinkForJob(jobId, pool);
    } catch (err) {
      logger.warn({ jobId, conversationId: row.conversation_id, err: err && err.message },
        'whatsapp-conversation: re-engagement link could not be built');
    }
    if (!link) {
      logger.warn({ jobId, conversationId: row.conversation_id },
        'whatsapp-conversation: re-engagement skipped — no confirmation link, so NOTHING was sent');
      return 'no_link';
    }

    const res = await gallabox.sendText({
      to: row.customer_mob_no,
      body: 'Sorry — our earlier chat timed out, so we can’t carry on here.\n\n'
        + `Please use this link to confirm your visit:\n${link}`,
    });
    // `disabled` is NOTIFICATIONS_DISABLE in dev — a deliberately silenced send,
    // not a failure. Anything else not delivered must not read as 'sent': the
    // claim is already burned, so this customer gets no second attempt.
    if (res && !res.delivered && !res.disabled) {
      logger.warn({ jobId, conversationId: row.conversation_id, err: res.error },
        'whatsapp-conversation: re-engagement reply was REJECTED by the provider');
      return 'send_failed';
    }
    /*
     * AUDIT — leave a CRM-VISIBLE trace that we answered this customer.
     *
     * Everything else about this reply is invisible to ops: it touches no
     * magic_link_* column (deliberately — it is not our outreach, see above),
     * so without this the only evidence is a log line, and nobody browsing the
     * job can tell whether the late customer was answered or ignored. The job
     * comment thread is the surface ops already reads for exactly this, and the
     * one this service already writes to for WhatsApp cancel/reschedule
     * reasons — same call, same comment_on=1 (lifecycle). No new column, no
     * migration.
     *
     * The LINK is deliberately NOT quoted in the comment: it carries a signed
     * token, and a job comment is the wrong place to park credentials.
     *
     * Fail-soft, and the ORDER is the point: the message is already delivered,
     * so a comment hiccup must neither undo it nor be reported as a send
     * failure — this runs after the send and swallows its own error.
     */
    try {
      await require('./job-comment.service').addComment(jobId, {
        comments: 'Customer replied on WhatsApp after the confirmation chat had expired — '
          + 'we answered with the confirmation link (free-form reply, so no template and no magic-link send-count slot was used).',
        comment_on: 1,
        commented_by: null,
        appointment_on: null,
      });
    } catch (e) {
      logger.warn({ jobId, conversationId: row.conversation_id, err: e && e.message },
        'whatsapp-conversation: re-engagement audit comment failed — the reply WAS delivered');
    }

    logger.info({ jobId, conversationId: row.conversation_id },
      'whatsapp-conversation: re-engaged a late-replying customer with a free-form confirmation link');
    return 'sent';
  } catch (err) {
    // Fail-soft. This runs inside a webhook that must still
    // answer 200; neither a provider outage nor a DB hiccup may become a 500.
    if (claimed) {
      logger.warn({ jobId, err: err && err.message }, 'whatsapp-conversation: re-engagement send failed');
      return 'send_failed';
    }
    logger.warn({ jobId, err: err && err.message }, 'whatsapp-conversation: re-engagement guards could not be evaluated — nothing was sent');
    return 'guard_failed';
  }
}

/*
 * explainNoActiveConversation(inbound, pool) → the handleInbound result
 *
 * ONE extra query, and it runs ONLY here — i.e. only after getActiveByMobile has
 * already come back empty. The healthy path pays nothing for it. (The next
 * reader will ask; tests/whatsapp-conversation-reengage.test.js asserts it on
 * the captured SQL rather than trusting this sentence.)
 */
async function explainNoActiveConversation(inbound, pool) {
  let row = null;
  let lookupFailed = false;
  try {
    // The LATEST row for this number whatever its status — same matching rule as
    // getActiveByMobile, minus the status filter that made it invisible.
    // customer_mob_no is projected because reengageExpired replies to the number
    // ON THE ROW: it is the same person by construction (the last-10-digit match
    // above), stored in the form our own sender already normalises.
    const [rows] = await pool.query(
      `SELECT conversation_id, job_id, status, current_step, expires_at, customer_mob_no
         FROM tbl_whatsapp_conversation
        WHERE ${MOBILE_MATCH_SQL}
        ORDER BY conversation_id DESC LIMIT 1`,
      [mobileMatchKey(inbound.from)],
    );
    row = rows[0] || null;
  } catch (err) {
    // A DIAGNOSIS must never be the thing that breaks the webhook — and must
    // never claim "never started" when it simply failed to look.
    lookupFailed = true;
    logger.warn({ err: err && err.message }, 'whatsapp-conversation: no-active-conversation diagnosis failed');
  }

  const status = row ? String(row.status || '') : null;
  const jobId = row ? row.job_id : null;
  let detail;
  let age = null;
  let note;
  if (lookupFailed) {
    detail = NO_CONVO.UNKNOWN;
    note = 'could not read the conversation history for this number (see the warning above) — the case is UNKNOWN, not "never started"';
  } else if (!row) {
    detail = NO_CONVO.NEVER_STARTED;
    note = 'no conversation has EVER been opened for this number — nothing to reply to. Check that the mobile on the job is the number they messaged from';
  } else if (status === 'expired') {
    detail = NO_CONVO.EXPIRED;
    age = humanAgo(row.expires_at ? new Date(row.expires_at).getTime() : NaN);
    note = 'the last conversation (job ' + jobId + ', parked at ' + row.current_step + ') EXPIRED '
      + (age ? age + ' ago' : 'at an unrecorded time')
      + ' — our own session bookkeeping, so the state machine has nowhere to route this reply';
  } else if (status === 'completed') {
    detail = NO_CONVO.COMPLETED;
    note = 'the last conversation (job ' + jobId + ') was already COMPLETED by the customer — they are done, so this reply needs no automated answer';
  } else if (status === 'closed_no_service') {
    detail = NO_CONVO.CLOSED_NO_SERVICE;
    note = 'the customer closed the last conversation (job ' + jobId + ') as SERVICE NOT REQUIRED — do not re-open it automatically';
  } else {
    // An unrecognised status is still a FACT, so print it rather than folding it
    // into one of the four and being wrong in a new way.
    detail = 'status_' + (status || 'unknown');
    note = 'the last conversation (job ' + jobId + ') is in the unrecognised status "' + status + '"';
  }

  /*
   * RE-ENGAGE ONLY THE EXPIRED CASE. completed / closed_no_service mean the
   * customer already reached a decision; messaging them again would spam them and
   * undo that decision. never_started has no job to link to.
   */
  const reengage = detail === NO_CONVO.EXPIRED ? await reengageExpired(row, pool) : 'not_applicable';
  if (reengage === 'sent') note += '; we replied free-form with the confirmation link (their message re-opened the service window, so this cost no template and no send-count slot)';
  else if (reengage === 'already_reengaged') note += '; already re-engaged once — not messaging them again';
  else if (reengage === 'no_link') note += '; not re-engaging: no confirmation link could be built, and a message pointing at a missing link is worse than silence';
  else if (reengage === 'job_not_unconfirmed') note += '; not re-engaging: the job is no longer Unconfirmed, so there is nothing left to confirm';
  else if (reengage === 'send_failed') note += '; the re-engagement send FAILED after being claimed (see the warning above) — they get no second attempt';
  else if (reengage === 'guard_failed') note += '; the re-engagement guards could not be read, so NOTHING was sent (see the warning above)';

  logger.info({ jobId, conversationId: row ? row.conversation_id : null, detail, age, reengage },
    'whatsapp-conversation: no ACTIVE conversation for this inbound — ' + note);
  return { handled: false, reason: 'no_active_conversation', detail, age, jobId, reengage };
}

/*
 * handleInbound(inbound, pool)
 *
 * Entry point from the webhook. `inbound` is the normalised shape the webhook
 * builds:
 *   { from, messageId, type: 'text'|'button'|'location'|'image'|'video',
 *     text?, buttonId?, location?: {lat,lng}, media?: {url, kind:'image'|'video'} }
 * Returns { handled: boolean, step?, reason? }. The no-active-conversation
 * answer carries three more fields — detail / age / reengage — see
 * explainNoActiveConversation above.
 */
async function handleInbound(inbound, pool) {
  logger.info('Handling inbound WhatsApp message · type=' + (inbound && inbound.type));
  const convo = await getActiveByMobile(inbound.from, pool);
  // No active row is FOUR different situations, and one of them (an expired
  // window) deserves a reply rather than silence. Diagnosing costs one query and
  // only ever runs here — never on the path where the conversation resolves.
  if (!convo) return await explainNoActiveConversation(inbound, pool);

  // Dedupe provider retries.
  if (inbound.messageId && convo.last_inbound_msg_id === inbound.messageId) {
    logger.info('Ignoring duplicate inbound message · job=' + convo.job_id);
    return { handled: false, reason: 'duplicate' };
  }

  // OUR session lapsed: the state machine's context is stale, so the row is
  // retired rather than resumed. (This says nothing about DELIVERABILITY — the
  // customer's inbound has just re-opened Meta's service window. Once the row is
  // retired here, a further reply finds no active row and lands in
  // explainNoActiveConversation, which answers the expired case free-form.)
  if (convo.expires_at && new Date(convo.expires_at).getTime() < Date.now()) {
    logger.info('WhatsApp conversation expired · job=' + convo.job_id);
    await updateConversation(convo.conversation_id, { status: 'expired' }, pool);
    /*
     * ⚠ RE-ENGAGE HERE TOO — THIS is the message that arrives late.
     *
     * Without this the feature answers the wrong message. THIS branch handles a
     * customer's FIRST text after the session lapsed: it flips the row to
     * 'expired' and returns silently. Only their NEXT text finds no active row
     * and reaches the re-engagement path below. So a customer who texts once —
     * the ordinary case — got nothing at all, and the reply only ever went to
     * someone who had already been ignored once.
     *
     * Safe to call from both sites: reengageExpired's claim is an atomic
     * conditional UPDATE on `$.reengaged_at IS NULL`, so whichever path gets
     * there first wins and the other is a no-op. The row is passed with the
     * status we just wrote, because that is what it now is.
     */
    const reengage = await reengageExpired({ ...convo, status: 'expired' }, pool);
    logger.info('WhatsApp late reply · job=' + convo.job_id + ' · reengage=' + reengage);
    return { handled: false, reason: 'expired', reengage };
  }

  await updateConversation(convo.conversation_id, {
    last_inbound_msg_id: inbound.messageId || null,
    last_inbound_at: new Date(),
  }, pool);

  const ctx = parseContext(convo);
  const to = convo.customer_mob_no;

  /*
   * A location pin is captured WHEREVER it arrives — it is always useful and
   * always safe to store (coordinates only), so it must never be treated as
   * unparseable input. The one exception is the SUPERSEDED awaiting_location
   * step, which owns its own legacy handling for in-flight rows.
   */
  const meta = { gpsCaptured: null };
  if (inbound.type === 'location' && inbound.location && convo.current_step !== STEP.LOCATION) {
    meta.gpsCaptured = await captureCustomerGps(convo.job_id, inbound.location, pool);
  }

  logger.info('Routing WhatsApp inbound · job=' + convo.job_id + ' · step=' + convo.current_step + ' · type=' + inbound.type);
  try {
    switch (convo.current_step) {
      // ── Current flow ──
      case STEP.CHOICE:        return await stepChoice(convo, ctx, inbound, to, pool, meta);
      case STEP.SLOT:          return await stepSlot(convo, ctx, inbound, to, pool, meta);
      case STEP.RESCHED_DATE:  return await stepRescheduleDate(convo, ctx, inbound, to, pool, meta);
      case STEP.CANCEL_REASON: return await stepCancelReason(convo, ctx, inbound, to, pool, meta);
      case STEP.EXTRAS:        return await stepExtras(convo, ctx, inbound, to, pool, meta);
      // ── Reused + superseded (in-flight rows) ──
      case STEP.MEDIA:         return await stepMedia(convo, ctx, inbound, to, pool, meta);
      case STEP.DATETIME:      return await stepDatetime(convo, ctx, inbound, to, pool, meta);
      case STEP.NO_SERVICE:    return await stepNoServiceReason(convo, ctx, inbound, to, pool, meta);
      case STEP.MEDIA_PICK:    return await stepMediaChoice(convo, ctx, inbound, to, pool, meta);
      case STEP.LOCATION:      return await stepLocation(convo, ctx, inbound, to, pool, meta);
      default:
        return { handled: false, reason: `unknown_step:${convo.current_step}` };
    }
  } catch (err) {
    logger.error({ jobId: convo.job_id, step: convo.current_step, err: err && err.message }, 'whatsapp-conversation: step failed');
    await gallabox.sendText({ to, body: 'Sorry, something went wrong on our side. Please try again in a moment.' });
    return { handled: false, reason: 'error' };
  }
}

// ── Prompts ─────────────────────────────────────────────────────────────

/*
 * phrase({ kind, ask, facts, fallback }) → the message body to send
 *
 * ⚠ THE BOUNDARY. AI PHRASES; IT NEVER DECIDES AND NEVER SUPPLIES FACTS.
 *
 * Every customer-facing message below still has its full deterministic copy
 * written out inline — that copy is the PRODUCT, and it is what goes out
 * whenever AI is off, unkeyed, erroring, slow, or writes something that fails
 * validation. Generation is only ever allowed to improve on it.
 *
 * What crosses to ai.service is (a) the instruction the state machine chose and
 * (b) the facts the state machine has already confirmed — never the job row,
 * never the conversation history. What comes back is validated there (length,
 * no unsupplied URL, no unsupplied digit sequence) before it can be returned.
 * The reason is not stylistic: a model that invents an appointment time, a
 * price, a technician name or a link has made a written commitment to a
 * customer over WhatsApp that we then have to honour.
 *
 * NOTHING about the flow may depend on which text won. The step, the DB write
 * and the next question are decided before this is called and are unchanged by
 * its result (tests/whatsapp-conversation-phrasing.test.js drives the same
 * inbound both ways and compares).
 *
 * ai.service.composeMessage already returns the fallback on every failure and
 * never throws; the belt-and-braces guard here is what makes "AI off ⇒ today's
 * bytes" true even if that contract is ever broken.
 */
async function phrase({ kind, ask, facts, fallback }) {
  try {
    const out = await ai.composeMessage({ kind, ask, facts, fallback });
    if (out && out.generated && typeof out.text === 'string' && out.text.trim()) return out.text;
    return fallback;
  } catch (err) {
    logger.warn({ kind, err: err && err.message }, 'whatsapp-conversation: ai phrasing failed — sending the deterministic copy');
    return fallback;
  }
}

// The three template choices, re-offered in-session when we could not read a
// reply. The button IDs are the EXACT approved payload strings; the visible
// TITLE spells "Reschedule" correctly (matchTemplateChoice accepts both, so the
// customer never has to look at the upstream typo twice).
function sendChoiceButtons(to, body) {
  return gallabox.sendButtons({
    to,
    body: body || 'Please tap one of the options below so we can proceed.',
    buttons: [
      { id: BTN_PAYLOAD.CONFIRM,      title: 'Yes, Confirm' },
      { id: BTN_PAYLOAD.RESCHEDULE,   title: 'Need a Reschedule' },
      { id: BTN_PAYLOAD.NOT_REQUIRED, title: 'Not Required' },
    ],
  });
}

// Slot prompt. WhatsApp reply buttons cap at 3 and there are ten 1-hour
// frames, and this repo has no verified Gallabox interactive-LIST sender — so
// we ask in text and parse the answer (deterministically first, ai.service as
// the fallback for messy phrasing).
async function sendSlotPrompt(to, dateLabel, { retry = false } = {}) {
  const head = retry
    ? 'Sorry, I couldn’t read that time.'
    : `Great — we’ll keep your visit on ${dateLabel}.`;
  const fallback = `${head}\n\nWhich 1-hour slot suits you best? Just reply with the start time (e.g. "10 AM" or "4 PM").\n\nAvailable slots:\n${ONE_HOUR_SLOT_LABELS.join('\n')}`;
  const body = await phrase({
    kind: retry ? 'ask_time_slot_retry' : 'ask_time_slot',
    ask: retry
      ? 'We could not read the time they just sent. Apologise in one line, then ask again which 1-hour slot they want, telling them to reply with the start time. List the available slots exactly as given, one per line.'
      : 'Tell them their visit stays on the date given, then ask which 1-hour slot suits them, telling them to reply with the start time. List the available slots exactly as given, one per line.',
    // The date is the one already in the conversation's context (what we asked
    // them to confirm, or the future date they just gave us) — never re-derived.
    facts: { 'visit date': dateLabel, 'available 1-hour slots': ONE_HOUR_SLOT_LABELS.join(', ') },
    fallback,
  });
  return gallabox.sendText({ to, body });
}

/*
 * `reason` explains WHY we are asking, so the customer never sees a generic
 * re-ask that looks like the bot ignored them:
 *   past_date — they proposed (or the order carried) a date that has gone by
 *   invalid   — the order has no usable scheduled date at all
 *   unclear   — we could not read what they sent
 *   null      — first ask, straight after they tapped "Need a Reschdeule"
 */
const RESCHEDULE_HEADS = Object.freeze({
  past_date: 'That date has already passed.',
  invalid:   'Let’s fix a date for your visit.',
  unclear:   'Sorry, I couldn’t read that date.',
});
async function sendReschedulePrompt(to, { reason = null } = {}) {
  const head = RESCHEDULE_HEADS[reason] || 'No problem — we’ll move your visit.';
  const fallback = `${head}\n\nWhich date would you prefer? Please share a future date (e.g. "tomorrow", "5 Aug" or "05-08-2026").`;
  const body = await phrase({
    kind: 'ask_reschedule_date' + (reason ? `_${reason}` : ''),
    // The WHY is the state machine's, not the model's — it already decided that
    // the date passed / is missing / was unreadable.
    ask: `Open with this, in your own words: "${head}" Then ask which future date they would prefer, and invite them to reply in any of the example formats given. Ask for a DATE only — the time is a separate question we ask next.`,
    facts: { 'example date formats you may quote': 'tomorrow, 5 Aug, 05-08-2026' },
    fallback,
  });
  return gallabox.sendText({ to, body });
}

async function sendCancelReasonPrompt(to, { retry = false } = {}) {
  const fallback = retry
    ? 'Could you tell us in a few words why the service is not required? Your reply is passed on to our team as-is.'
    : 'Understood. May I know the reason? Please reply in your own words — it helps us improve.';
  const body = await phrase({
    kind: retry ? 'ask_cancel_reason_retry' : 'ask_cancel_reason',
    ask: retry
      ? 'They did not give us a readable reason. Ask again, gently and in a few words, why the service is not required, and tell them their reply reaches our team as they wrote it. Do not argue or try to talk them out of it.'
      : 'Acknowledge that they do not need the visit, then ask why, in their own words, explaining it helps us improve. Do not argue or try to talk them out of it.',
    facts: {},
    fallback,
  });
  return gallabox.sendText({ to, body });
}

/*
 * The OPTIONAL post-confirmation step. Sent as a location-request interactive
 * message so the customer gets a native "Send location" button, while the body
 * also invites photos. Both are optional and may arrive in any order, or not
 * at all — the visit is already confirmed.
 */
function sendExtrasPrompt(to) {
  return gallabox.sendLocationRequest({
    to,
    body: 'Two optional extras — your visit is already confirmed, so feel free to ignore this message:\n\n📷 Send photos of the item so the technician comes prepared.\n📍 Share your location pin so the technician can navigate to you (tap the button below).',
  });
}

// ── Step handlers · current flow ────────────────────────────────────────

/*
 * stepChoice — the reply to the opening `customer_interactive_msg` template.
 *
 * A tapped quick reply may surface as inbound.buttonId (payload/title) or, on
 * some BSP configurations, as plain text — matchTemplateChoice handles both.
 */
async function stepChoice(convo, ctx, inbound, to, pool, meta) {
  const choice = matchTemplateChoice(inbound.buttonId)
    || (inbound.type === 'text' ? matchTemplateChoice(inbound.text) : null)
    || (inbound.type === 'text' ? await aiChoice(inbound.text) : null);

  if (choice === 'not_required') {
    await updateConversation(convo.conversation_id, { current_step: STEP.CANCEL_REASON }, pool);
    await sendCancelReasonPrompt(to);
    return { handled: true, step: STEP.CANCEL_REASON };
  }

  if (choice === 'reschedule') {
    await updateConversation(convo.conversation_id, { current_step: STEP.RESCHED_DATE }, pool);
    await sendReschedulePrompt(to);
    return { handled: true, step: STEP.RESCHED_DATE };
  }

  if (choice === 'confirm') {
    /*
     * Confirming keeps the job's EXISTING scheduled date. But we must never
     * write a past appointment (platform past-appointment gate), so if that
     * date is missing or already gone we transparently divert to the
     * reschedule branch instead of confirming something unstaffable.
     */
    const offered = ctx.offered_date || null;
    const check = validateAppointment(offered, null);
    if (!check.ok) {
      logger.info('Confirm diverted to reschedule · job=' + convo.job_id + ' · offered=' + (offered || 'none') + ' · reason=' + check.reason);
      await updateConversation(convo.conversation_id, { current_step: STEP.RESCHED_DATE }, pool);
      await sendReschedulePrompt(to, { reason: check.reason });
      return { handled: true, step: STEP.RESCHED_DATE };
    }
    const nextCtx = { ...ctx, confirmed_date: offered, branch: 'confirm' };
    await updateConversation(convo.conversation_id, { current_step: STEP.SLOT, context: nextCtx }, pool);
    await sendSlotPrompt(to, ctx.offered_date_label || formatCustomerDateLabel(offered));
    return { handled: true, step: STEP.SLOT };
  }

  // Unreadable — re-offer the three options in-session.
  await sendChoiceButtons(to, meta.gpsCaptured
    ? 'Thanks, we’ve saved your location 📍 Please also tap one of the options below.'
    : 'Sorry, I didn’t catch that. Please tap one of the options below.');
  return { handled: true, step: STEP.CHOICE };
}

/*
 * stepRescheduleDate — Branch B's date question. FUTURE dates only.
 */
async function stepRescheduleDate(convo, ctx, inbound, to, pool, meta) {
  if (inbound.type !== 'text' || !inbound.text) {
    if (meta.gpsCaptured) await gallabox.sendText({ to, body: 'Thanks, we’ve saved your location 📍' });
    await sendReschedulePrompt(to, { reason: 'unclear' });
    return { handled: true, step: STEP.RESCHED_DATE };
  }

  let date = parseCustomerDate(inbound.text);
  if (!date) {
    // ai.service INTERPRETS only — the state machine still validates and owns
    // the write. A disabled/failing AI degrades to the plain re-ask below.
    const nlu = await safeInterpret({ step: STEP.RESCHED_DATE, text: inbound.text, timeSlots: ONE_HOUR_SLOT_LABELS });
    date = normaliseAiDate(nlu.date) || normaliseAiDate(nlu.datetime);
  }
  if (!date) {
    await sendReschedulePrompt(to, { reason: 'unclear' });
    return { handled: true, step: STEP.RESCHED_DATE };
  }

  const check = validateAppointment(date, null);
  if (!check.ok) {
    logger.info('Reschedule date rejected · job=' + convo.job_id + ' · date=' + date + ' · reason=' + check.reason);
    await sendReschedulePrompt(to, { reason: check.reason });
    return { handled: true, step: STEP.RESCHED_DATE };
  }

  const nextCtx = { ...ctx, confirmed_date: date, branch: 'reschedule' };
  await updateConversation(convo.conversation_id, { current_step: STEP.SLOT, context: nextCtx }, pool);
  logger.info('Captured reschedule date · job=' + convo.job_id + ' · date=' + date);
  await sendSlotPrompt(to, formatCustomerDateLabel(date));
  return { handled: true, step: STEP.SLOT };
}

/*
 * stepSlot — shared by both branches. Parses a 1-hour frame, then FINALISES.
 */
async function stepSlot(convo, ctx, inbound, to, pool, meta) {
  const date = ctx.confirmed_date || null;
  if (!date) {
    // Defensive: context lost (manual DB edit / partial write). Re-ask the date
    // rather than guessing one.
    await updateConversation(convo.conversation_id, { current_step: STEP.RESCHED_DATE }, pool);
    await sendReschedulePrompt(to);
    return { handled: true, step: STEP.RESCHED_DATE };
  }

  let slot = slotByLabelOrStart(inbound.buttonId);
  if (!slot && inbound.type === 'text' && inbound.text) slot = parseOneHourSlot(inbound.text);
  if (!slot && inbound.type === 'text' && inbound.text) {
    const nlu = await safeInterpret({ step: STEP.SLOT, text: inbound.text, timeSlots: ONE_HOUR_SLOT_LABELS });
    slot = slotByLabelOrStart(nlu.slot_start) || slotByLabelOrStart(nlu.time_slot);
  }

  if (!slot) {
    /*
     * Not a time — but the customer may be changing the DATE instead (the
     * past_slot nudge below explicitly invites that). Accept a future date here
     * rather than looping on the slot question, which would make that
     * invitation a dead end.
     */
    if (inbound.type === 'text' && inbound.text) {
      const newDate = parseCustomerDate(inbound.text);
      if (newDate && validateAppointment(newDate, null).ok) {
        const nextCtx = { ...ctx, confirmed_date: newDate, branch: 'reschedule' };
        await updateConversation(convo.conversation_id, { context: nextCtx }, pool);
        logger.info('Date changed at the slot step · job=' + convo.job_id + ' · date=' + newDate);
        await sendSlotPrompt(to, formatCustomerDateLabel(newDate));
        return { handled: true, step: STEP.SLOT };
      }
    }
    await sendSlotPrompt(to, formatCustomerDateLabel(date), { retry: true });
    return { handled: true, step: STEP.SLOT };
  }

  const check = validateAppointment(date, slot.start);
  if (check.reason === 'past_slot') {
    await gallabox.sendText({
      to,
      body: `The ${slot.label} slot today has already passed. Please pick a later slot for today, or reply with another date.`,
    });
    return { handled: true, step: STEP.SLOT };
  }
  if (!check.ok) {
    logger.info('Slot rejected · job=' + convo.job_id + ' · reason=' + check.reason);
    await updateConversation(convo.conversation_id, { current_step: STEP.RESCHED_DATE }, pool);
    await sendReschedulePrompt(to, { reason: check.reason });
    return { handled: true, step: STEP.RESCHED_DATE };
  }

  return finaliseConfirmed(convo, ctx, { date, slot }, to, pool, meta);
}

/*
 * finaliseConfirmed — THE commit point.
 *
 * Writes the confirmed date + 1-hour slot, then acknowledges, and only THEN
 * opens the optional extras step. The order is deliberate: the confirmation
 * must not be lost to drop-off.
 *
 * WRITE PATH — jml.writeCustomerOrderDetails (the shared customer-submit
 * writer), NOT setStatus. Same rationale the sibling magic-link submit relies
 * on: this stamps customer_submitted_at / customer_submitted_payload so the CRM
 * "Customer Submitted" pill + Confirm-mode prefill light up identically for the
 * form and the chat, while OPS still reviews before the status/notification
 * machinery fires. Going through setStatus here would transition the job and
 * fire notifications on a customer tap, which is exactly what that bypass
 * exists to prevent.
 *
 * Columns written on tbl_job: requested_date_time (IST 'YYYY-MM-DD HH:MM:SS',
 * its time-of-day = the 1-hour frame's START), requested_time (that same start
 * as the legacy HH:MM text column), time_slot (the BROAD BAND containing it),
 * customer_submitted_at, customer_submitted_payload, last_update_time.
 *
 * ⚠ THE CHAT STILL OFFERS 1-HOUR FRAMES — only the STORAGE changed
 * (2026-07-31). We used to write the frame LABEL ('3 PM–4 PM') into time_slot,
 * which made that column speak yet another vocabulary. time_slot is now
 * strictly one of the four bands; the customer's 1-hour choice survives in
 * requested_date_time / requested_time, which is where the ranking engine's
 * conflict window reads it from. `slot.label` is kept in the audit payload so
 * the exact frame the customer picked is never lost.
 */
async function finaliseConfirmed(convo, ctx, { date, slot }, to, pool, meta) {
  // IST wall-clock literal. The pool is `timezone: '+05:30'` + dateStrings, so a
  // pre-formatted string stores verbatim — no driver UTC conversion, and no SQL
  // NOW() for an application timestamp.
  const requestedDateTime = `${date} ${slot.start}:00`;
  // The band CONTAINING the chosen frame — derived from the appointment
  // instant, exactly as every other write path derives it.
  const band = slotModel.deriveTimeSlot(requestedDateTime);
  const payload = {
    ...ctx,
    channel: 'whatsapp_conversation',
    confirmed_date: date,
    // Audit: BOTH the band we store and the 1-hour frame the customer actually
    // tapped, so the choice is reconstructable from the payload alone.
    time_slot: band,
    slot_label: slot.label,
    requested_time: slot.start,
    requested_date_time: requestedDateTime,
    confirmed_via: ctx.branch === 'reschedule' ? 'reschedule' : 'confirm',
  };
  if (meta && meta.gpsCaptured) payload.gps_location = meta.gpsCaptured;

  await jml.writeCustomerOrderDetails(convo.job_id, {
    requested_date_time: requestedDateTime,
    time_slot: band,
    requested_time: slot.start,
    payload,
  }, pool);

  /*
   * Stay 'active' at EXTRAS on purpose — getActiveByMobile only resolves active
   * rows, so closing here would make the optional photos/location pin
   * unroutable. `finalised: true` records that the job is already committed, so
   * nothing downstream can mistake this for an unconfirmed conversation.
   */
  await updateConversation(convo.conversation_id, {
    current_step: STEP.EXTRAS,
    context: { ...payload, finalised: true },
  }, pool);

  /*
   * THE CLOSING MESSAGE — read back what we captured, warmly and CORRECTLY.
   *
   * ⚠ EVERY FACT HERE COMES FROM `payload`, i.e. from the values we JUST WROTE,
   * never from anything the model remembers of the conversation. That is why
   * the labels are re-derived from payload.confirmed_date / payload.slot_label
   * rather than from `date` / `slot`: those two are the same values, but going
   * through the payload makes it structurally true that the customer is read
   * back the row, and keeps it true if the write path ever normalises a value.
   */
  const confirmedDateLabel = formatCustomerDateLabel(payload.confirmed_date);
  const fallbackBody = `Your visit is confirmed ✅\n\n🗓️ ${confirmedDateLabel}\n⏰ ${payload.slot_label}\n\nOur technician will reach you within this 1-hour window. Thank you!`;
  await gallabox.sendText({
    to,
    body: await phrase({
      kind: 'visit_confirmed',
      ask: 'Confirm their visit is booked and read the details back clearly, on their own lines, so they can see the date and the time window at a glance. Say the technician will arrive within that 1-hour window, and close warmly. Add nothing else — no arrival promises, no names, no next steps.',
      facts: { 'visit date': confirmedDateLabel, 'time window (1 hour)': payload.slot_label },
      fallback: fallbackBody,
    }),
  });
  await sendExtrasPrompt(to);

  logger.info({ jobId: convo.job_id, date, slot: slot.label, branch: ctx.branch || 'confirm' }, 'whatsapp-conversation: visit confirmed');
  return { handled: true, step: STEP.EXTRAS, confirmed: true };
}

/*
 * stepExtras — OPTIONAL, post-confirmation. Accepts photos, videos, a location
 * pin, any combination, in any order, or nothing at all.
 */
async function stepExtras(convo, ctx, inbound, to, pool, meta) {
  // The pin was already captured in handleInbound (coordinates only).
  if (meta.gpsCaptured) {
    const nextCtx = { ...ctx, gps_location: meta.gpsCaptured };
    await updateConversation(convo.conversation_id, { context: nextCtx }, pool);
    await gallabox.sendText({
      to,
      body: 'Got your location 📍 The technician will use it to navigate to you. You can also send photos, or simply reply "Done".',
    });
    return { handled: true, step: STEP.EXTRAS };
  }

  if (inbound.type === 'image' || inbound.type === 'video') {
    const res = await ingestMedia(convo, ctx, inbound, pool);
    if (res.error) {
      await gallabox.sendText({ to, body: 'Sorry, we couldn’t download that file. Please try again, or reply "Done".' });
      return { handled: true, step: STEP.EXTRAS };
    }
    if (res.atLimit) {
      await gallabox.sendText({ to, body: `You’ve reached the limit of ${MAX_PHOTOS} photos. Nothing else is needed — your visit is confirmed.` });
      return { handled: true, step: STEP.EXTRAS };
    }
    await gallabox.sendText({ to, body: 'Got it ✅ Send another if you like, or reply "Done".' });
    return { handled: true, step: STEP.EXTRAS };
  }

  const isDone = (inbound.type === 'button' && (inbound.buttonId === BTN.EXTRAS_DONE || inbound.buttonId === BTN.MEDIA_DONE))
    || (inbound.type === 'text' && /^\s*(done|no|nope|nothing|thanks?|thank you|ok(ay)?|that'?s all)\s*[.!]*\s*$/i.test(inbound.text || ''));
  if (isDone) {
    await updateConversation(convo.conversation_id, { status: 'completed' }, pool);
    await gallabox.sendText({ to, body: 'Perfect — you’re all set. See you at your appointment! 🙌' });
    logger.info({ jobId: convo.job_id }, 'whatsapp-conversation: completed (extras closed)');
    return { handled: true, step: 'completed' };
  }

  // Anything else: gently restate that nothing more is required. The job is
  // already confirmed, so this can never block completion.
  await gallabox.sendText({
    to,
    body: 'Your visit is already confirmed ✅ If you’d like, send photos of the item or share your location pin — otherwise just reply "Done".',
  });
  return { handled: true, step: STEP.EXTRAS };
}

/*
 * stepCancelReason — Branch C. FREE TEXT in, classification + VERBATIM out.
 *
 * ai.service classifies; the verbatim text is stored regardless, because the
 * classification is for REPORTING while the customer's own words are the
 * evidence. AI unavailable → deterministic keyword fallback → 'Other'.
 */
async function stepCancelReason(convo, ctx, inbound, to, pool, meta) {
  const verbatim = (inbound.type === 'text' && inbound.text) ? String(inbound.text).trim() : '';
  if (!verbatim) {
    await sendCancelReasonPrompt(to, { retry: true });
    return { handled: true, step: STEP.CANCEL_REASON };
  }

  const nlu = await safeInterpret({ step: STEP.CANCEL_REASON, text: verbatim, timeSlots: [] });
  const code = nlu.reason || classifyReasonKeyword(verbatim) || 'other';
  const reason = mapReasonCode(code);
  logger.info('Classified no-service reason · job=' + convo.job_id + ' · code=' + reason.code + ' · aiUsed=' + Boolean(nlu.reason));

  // reason = the classified label (VARCHAR(120)); remarks = the customer's own
  // words (TEXT), prefixed so ops can see the channel at a glance.
  await pool.query(
    `INSERT INTO tbl_job_customer_request (job_id, request_type, reason, remarks)
     VALUES (?, ?, ?, ?)`,
    [convo.job_id, reason.type, reason.label, `Customer said (via WhatsApp): ${verbatim}`],
  );
  // Mirror the ask into the job comment thread (tbl_job_comment) so it also
  // shows in the CRM "Remarks / Comments" panel — the web magic-link path
  // (routes/public/job-completion.js) already does this; without the mirror a
  // WhatsApp-origin reschedule/cancel reason is invisible there. Best-effort:
  // the request row above is the source of truth, so a comment hiccup must
  // never break the customer's WhatsApp reply. comment_on=1 = lifecycle.
  try {
    const label = reason.type === 'cancel' ? 'Cancellation' : 'Reschedule';
    await require('./job-comment.service').addComment(convo.job_id, {
      comments: `${label} requested (via WhatsApp): ${reason.label} — "${verbatim}"`,
      comment_on: 1,
      commented_by: null,
      appointment_on: null,
    });
  } catch (e) {
    logger.warn({ jobId: convo.job_id, err: e && e.message }, 'whatsapp-conversation: comment mirror failed');
  }

  await updateConversation(convo.conversation_id, {
    status: 'closed_no_service',
    context: {
      ...ctx,
      no_service_reason: reason.label,
      no_service_reason_code: reason.code,
      no_service_reason_verbatim: verbatim,
      request_type: reason.type,
      ...(meta && meta.gpsCaptured ? { gps_location: meta.gpsCaptured } : {}),
    },
  }, pool);
  await gallabox.sendText({ to, body: 'Thank you for letting us know — we’ve passed this to our team and no visit will be scheduled.' });
  logger.info({ jobId: convo.job_id, reason: reason.label, type: reason.type }, 'whatsapp-conversation: no-service request logged');
  return { handled: true, step: 'closed_no_service' };
}

// ── Media ingest (shared by EXTRAS and the superseded MEDIA step) ───────

/*
 * ingestMedia — download an inbound photo/video and persist it
 * (tbl_job_image for photos, capped at MAX_PHOTOS; tbl_job_media for videos).
 * Returns { saved } | { atLimit: true } | { error }.
 */
async function ingestMedia(convo, ctx, inbound, pool) {
  if (!inbound.media || !inbound.media.url) return { error: 'no_media_url' };
  const isVideo = inbound.type === 'video';
  const dl = await gallabox.fetchInboundMedia({ url: inbound.media.url });
  if (dl.error) return { error: dl.error };

  if (isVideo) {
    const [[{ vcount }]] = await pool.query('SELECT COUNT(*) AS vcount FROM tbl_job_media WHERE job_id = ?', [convo.job_id]);
    const seq = Number(vcount) + 1;
    const key = await s3.putJobImage({
      jobId: convo.job_id, seq, buffer: dl.buffer,
      contentType: dl.contentType, originalName: `whatsapp_video_${seq}`, category: 'BookingVideo',
    });
    await pool.query(
      `INSERT INTO tbl_job_media (job_id, s3_key, content_type, source) VALUES (?, ?, ?, 'customer_whatsapp')`,
      [convo.job_id, key, dl.contentType || null],
    );
    logger.info('Saved customer WhatsApp video · job=' + convo.job_id + ' · seq=' + seq);
    await updateConversation(convo.conversation_id, {
      context: { ...ctx, video_count: (ctx.video_count || 0) + 1 },
    }, pool);
    return { saved: true, kind: 'video' };
  }

  const [[{ icount }]] = await pool.query('SELECT COUNT(*) AS icount FROM tbl_job_image WHERE job_id = ?', [convo.job_id]);
  if (Number(icount) >= MAX_PHOTOS) return { atLimit: true };
  const seq = Number(icount) + 1;
  const key = await s3.putJobImage({
    jobId: convo.job_id, seq, buffer: dl.buffer,
    contentType: dl.contentType, originalName: `whatsapp_photo_${seq}`, category: 'Booking',
  });
  // created_date is the row's own insert stamp (not an application timestamp we
  // reason about) — NOW() here matches the legacy write and is left as-is.
  await pool.query(
    `INSERT INTO tbl_job_image (job_id, image, image_category, job_stage, created_date)
     VALUES (?, ?, 'booking', 0, NOW())`,
    [convo.job_id, key],
  );
  logger.info('Saved customer WhatsApp photo · job=' + convo.job_id + ' · seq=' + seq);
  await updateConversation(convo.conversation_id, {
    context: { ...ctx, photo_count: (ctx.photo_count || 0) + 1 },
  }, pool);
  return { saved: true, kind: 'image' };
}

// ── ai.service adapters ─────────────────────────────────────────────────

/*
 * safeInterpret — ai.service already returns (never throws) a normalised
 * object, but it is a network call: wrap it so an unexpected throw degrades to
 * "unclear" instead of crashing the webhook. The caller then re-asks in plain
 * words.
 */
async function safeInterpret(args) {
  try {
    const out = await ai.interpretReply(args);
    return (out && typeof out === 'object') ? out : { intent: 'unclear' };
  } catch (err) {
    logger.warn({ step: args && args.step, err: err && err.message }, 'whatsapp-conversation: ai interpret failed');
    return { intent: 'unclear' };
  }
}

// AI-assisted read of the opening choice when the customer typed instead of
// tapping ("yes please", "can we move it", "I don't need it any more").
async function aiChoice(text) {
  const nlu = await safeInterpret({ step: STEP.CHOICE, text, timeSlots: ONE_HOUR_SLOT_LABELS });
  if (nlu.intent === 'no_service') return 'not_required';
  if (nlu.intent === 'affirm') return 'confirm';
  if (nlu.intent === 'datetime' || nlu.date) return 'reschedule';
  return null;
}

// Accept 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:mm' from the model; anything else → null.
function normaliseAiDate(value) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || '').trim());
  return m ? m[1] : null;
}

// ── Step handlers · SUPERSEDED (retained for in-flight conversation rows) ──
//
// Nothing in the CURRENT flow routes here: startConversation opens at
// awaiting_choice. These remain because (a) rows created before the 2026-07-30
// deploy can still be parked on these steps inside their 24h window, and (b)
// tbl_whatsapp_conversation.current_step still DEFAULTS to 'awaiting_datetime'.
// Retire them once no active row references these steps.

async function sendNoServiceButtons(to) {
  return gallabox.sendButtons({
    to,
    body: 'No problem. Could you tell us why?',
    buttons: [
      { id: BTN.REASON_SELF, title: 'Self Assembly' },
      { id: BTN.REASON_SITE, title: 'Site not ready' },
      { id: BTN.REASON_DONE, title: 'Work already done' },
    ],
  });
}

async function sendMediaChoice(to) {
  return gallabox.sendButtons({
    to,
    body: 'Great! To help us understand the problem and bring the right solution, you can share photos or a short video.',
    buttons: [
      { id: BTN.UPLOAD, title: 'Upload Pics/Video' },
      { id: BTN.NO_PICS, title: "I don't have pics" },
    ],
  });
}

async function sendLocationPrompt(to) {
  return gallabox.sendLocationRequest({
    to,
    body: 'Lastly, please share your address location so the technician can reach you. Tap the button to share your GPS location, or simply type your full address.',
  });
}

// SUPERSEDED entry step (old `confirm_order_flow` template premise).
async function stepDatetime(convo, ctx, inbound, to, pool) {
  // Explicit "no service" button on the old initiating template.
  if (inbound.type === 'button' && inbound.buttonId === BTN.NO_SERVICE) {
    await sendNoServiceButtons(to);
    await updateConversation(convo.conversation_id, { current_step: STEP.NO_SERVICE }, pool);
    return { handled: true, step: STEP.NO_SERVICE };
  }
  // A row parked here that receives one of the NEW template payloads (e.g. the
  // customer scrolled back to an older message) is handed to the new flow.
  if (matchTemplateChoice(inbound.buttonId) || (inbound.type === 'text' && matchTemplateChoice(inbound.text))) {
    return stepChoice(convo, ctx, inbound, to, pool, { gpsCaptured: null });
  }

  if (inbound.type !== 'text' || !inbound.text) {
    await gallabox.sendText({ to, body: 'Please reply with your preferred date and time for the technician visit (e.g. "15 Jun, 3–7 PM").' });
    return { handled: true, step: STEP.DATETIME };
  }

  const nlu = await safeInterpret({ step: STEP.DATETIME, text: inbound.text, timeSlots: jml.TIME_SLOTS });

  if (nlu.intent === 'no_service') {
    await sendNoServiceButtons(to);
    await updateConversation(convo.conversation_id, { current_step: STEP.NO_SERVICE }, pool);
    return { handled: true, step: STEP.NO_SERVICE };
  }

  if (nlu.intent === 'datetime') {
    const mysqlDt = toMysqlDatetime(nlu.datetime);
    if (!mysqlDt) {
      await gallabox.sendText({ to, body: 'Sorry, I couldn’t read that date/time. Please share it like "15 Jun, 3–7 PM" or "tomorrow 11am".' });
      return { handled: true, step: STEP.DATETIME };
    }
    const nextCtx = { ...ctx, requested_date_time: mysqlDt, time_slot: nlu.time_slot || null };
    logger.info('Captured requested date/time · job=' + convo.job_id + ' · when=' + mysqlDt);
    await updateConversation(convo.conversation_id, { current_step: STEP.MEDIA_PICK, context: nextCtx }, pool);
    const human = nlu.datetime.replace('T', ' ');
    await gallabox.sendText({ to, body: `Thanks! We’ve noted ${human}${nlu.time_slot ? ` (${nlu.time_slot})` : ''} for the visit.` });
    await sendMediaChoice(to);
    return { handled: true, step: STEP.MEDIA_PICK };
  }

  // unclear / disabled
  await gallabox.sendText({ to, body: 'Sorry, I didn’t catch that. Please reply with a date and time for the technician visit (e.g. "15 Jun, 3–7 PM"), or tap "I Don\'t Need a Service".' });
  return { handled: true, step: STEP.DATETIME };
}

// SUPERSEDED by stepCancelReason (which accepts free text + stores the verbatim).
async function stepNoServiceReason(convo, ctx, inbound, to, pool) {
  // Map a button id, else let AI map typed text to a reason.
  let reason = null;
  const byId = {
    [BTN.REASON_SELF]: mapReasonCode('self_assembly'),
    [BTN.REASON_SITE]: mapReasonCode('site_not_ready'),
    [BTN.REASON_DONE]: mapReasonCode('work_completed'),
  };
  if (inbound.type === 'button' && byId[inbound.buttonId]) {
    reason = byId[inbound.buttonId];
  } else if (inbound.type === 'text') {
    const nlu = await safeInterpret({ step: STEP.NO_SERVICE, text: inbound.text, timeSlots: [] });
    const code = nlu.reason || classifyReasonKeyword(inbound.text);
    if (code && code !== 'other') reason = mapReasonCode(code);
  }

  if (!reason) {
    await sendNoServiceButtons(to);
    return { handled: true, step: STEP.NO_SERVICE };
  }

  await pool.query(
    `INSERT INTO tbl_job_customer_request (job_id, request_type, reason, remarks)
     VALUES (?, ?, ?, ?)`,
    [convo.job_id, reason.type, reason.label, 'Logged via WhatsApp conversation'],
  );
  try {
    const label = reason.type === 'cancel' ? 'Cancellation' : 'Reschedule';
    await require('./job-comment.service').addComment(convo.job_id, {
      comments: `${label} requested (via WhatsApp): ${reason.label}`,
      comment_on: 1,
      commented_by: null,
      appointment_on: null,
    });
  } catch (e) {
    logger.warn({ jobId: convo.job_id, err: e && e.message }, 'whatsapp-conversation: comment mirror failed');
  }
  await updateConversation(convo.conversation_id, {
    status: 'closed_no_service',
    context: { ...ctx, no_service_reason: reason.label, request_type: reason.type },
  }, pool);
  await gallabox.sendText({ to, body: 'Thank you — we’ve noted that and our team will update your order. No visit will be scheduled.' });
  logger.info({ jobId: convo.job_id, reason: reason.label, type: reason.type }, 'whatsapp-conversation: no-service request logged');
  return { handled: true, step: 'closed_no_service' };
}

// SUPERSEDED by the optional EXTRAS step (media is no longer a gated choice).
async function stepMediaChoice(convo, ctx, inbound, to, pool) {
  if (inbound.type === 'button' && inbound.buttonId === BTN.UPLOAD) {
    await updateConversation(convo.conversation_id, { current_step: STEP.MEDIA }, pool);
    await gallabox.sendButtons({
      to,
      body: 'Please send your photos or video now. Tap "Done" when you’ve finished.',
      buttons: [{ id: BTN.MEDIA_DONE, title: 'Done' }],
    });
    return { handled: true, step: STEP.MEDIA };
  }
  if (inbound.type === 'button' && inbound.buttonId === BTN.NO_PICS) {
    await updateConversation(convo.conversation_id, { current_step: STEP.LOCATION }, pool);
    await sendLocationPrompt(to);
    return { handled: true, step: STEP.LOCATION };
  }
  // Anything else → re-show the choice.
  await sendMediaChoice(to);
  return { handled: true, step: STEP.MEDIA_PICK };
}

/*
 * stepMedia — the legacy media-ingest step. Still routed for in-flight rows;
 * the ingest itself is the SHARED ingestMedia() the new EXTRAS step uses, so
 * both paths write identically.
 */
async function stepMedia(convo, ctx, inbound, to, pool) {
  // "Done" → move on to location.
  if ((inbound.type === 'button' && inbound.buttonId === BTN.MEDIA_DONE)
      || (inbound.type === 'text' && /^\s*done\s*$/i.test(inbound.text || ''))) {
    await updateConversation(convo.conversation_id, { current_step: STEP.LOCATION }, pool);
    await sendLocationPrompt(to);
    return { handled: true, step: STEP.LOCATION };
  }

  if (inbound.type === 'image' || inbound.type === 'video') {
    const res = await ingestMedia(convo, ctx, inbound, pool);
    if (res.error) {
      await gallabox.sendText({ to, body: 'Sorry, we couldn’t download that file. Please try again, or tap "Done".' });
      return { handled: true, step: STEP.MEDIA };
    }
    if (res.atLimit) {
      await gallabox.sendButtons({
        to, body: `You’ve reached the limit of ${MAX_PHOTOS} photos. Tap "Done" to continue.`,
        buttons: [{ id: BTN.MEDIA_DONE, title: 'Done' }],
      });
      return { handled: true, step: STEP.MEDIA };
    }
    await gallabox.sendButtons({
      to, body: 'Got it ✅ Send another, or tap "Done".',
      buttons: [{ id: BTN.MEDIA_DONE, title: 'Done' }],
    });
    return { handled: true, step: STEP.MEDIA };
  }

  // Unexpected input at media step — nudge.
  await gallabox.sendButtons({
    to, body: 'Please send a photo or video, or tap "Done".',
    buttons: [{ id: BTN.MEDIA_DONE, title: 'Done' }],
  });
  return { handled: true, step: STEP.MEDIA };
}

/*
 * SUPERSEDED finalize for the old flow: it reverse-geocoded the pin and wrote
 * the resulting formatted_address over tbl_address.address.
 *
 * ⚠ The NEW flow deliberately does NOT do that — captureCustomerGps() stores
 * coordinates ONLY. The booked address is ops-entered data with a different
 * role, and overwriting it with a Google-formatted string loses the flat/door
 * detail a technician actually needs. This legacy behaviour is left untouched
 * purely so in-flight rows finish the way they started.
 */
async function legacyFinalize(convo, ctx, addressFields, to, pool) {
  const fields = {
    requested_date_time: ctx.requested_date_time || null,
    time_slot: ctx.time_slot || null,
    ...addressFields,
    payload: { ...ctx, ...addressFields, channel: 'whatsapp_conversation' },
  };
  await jml.writeCustomerOrderDetails(convo.job_id, fields, pool);
  await updateConversation(convo.conversation_id, { status: 'completed', context: fields.payload }, pool);
  await gallabox.sendText({ to, body: 'Thank you! We’ve received all your details and will confirm your technician visit shortly. 🙌' });
  logger.info({ jobId: convo.job_id }, 'whatsapp-conversation: completed');
  return { handled: true, step: 'completed' };
}

async function stepLocation(convo, ctx, inbound, to, pool) {
  if (inbound.type === 'location' && inbound.location) {
    // Pass the pool so reverseGeocode also resolves city_name → city_id from
    // tbl_city (memoised). Falls back to null silently if no match, so the
    // finalize write still lands with gps + address + pin even when the city
    // name is novel.
    const geo = await maps.reverseGeocode(inbound.location.lat, inbound.location.lng, pool);
    return legacyFinalize(convo, ctx, {
      gps_location: geo.gps_location,
      address: geo.formatted_address || null,
      pin_code: geo.pin_code || null,
      city_id: geo.city_id || null,
    }, to, pool);
  }
  if (inbound.type === 'text' && inbound.text && inbound.text.trim()) {
    return legacyFinalize(convo, ctx, { address: inbound.text.trim() }, to, pool);
  }
  await sendLocationPrompt(to);
  return { handled: true, step: STEP.LOCATION };
}

// AI 'YYYY-MM-DDTHH:mm' (IST wall-clock) → MySQL 'YYYY-MM-DD HH:mm:00'. Null on
// anything that doesn't match — we never write a malformed datetime.
// (Used by the superseded awaiting_datetime step.)
function toMysqlDatetime(s) {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2})?$/.exec(String(s || '').trim());
  return m ? `${m[1]} ${m[2]}:00` : null;
}

module.exports = {
  startConversation,
  handleInbound,
  captureCustomerGps,
  STEP,
  BTN,
  BTN_PAYLOAD,
  CONVERSATION_TEMPLATE_NAME,
  ONE_HOUR_SLOTS,
  ONE_HOUR_SLOT_LABELS,
  // Pure helpers (unit-tested).
  templateButtonValues,
  matchTemplateChoice,
  parseOneHourSlot,
  slotByLabelOrStart,
  slotForHour,
  parseCustomerDate,
  isPastIstDate,
  validateAppointment,
  formatCustomerDateLabel,
  formatGpsLocation,
  composeAddressLine,
  classifyReasonKeyword,
  mapReasonCode,
  jobDateLabel,
  toMysqlDatetime,
};
