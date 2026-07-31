const logger = require('../logger');
const gallabox = require('./gallabox.whatsapp.service');
const ai = require('./ai.service');
const maps = require('./maps.service');
const jml = require('./job-magic-link.service');
const addressService = require('./address.service');
const s3 = require('../utils/s3-storage');

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
 * The state machine owns the flow + every DB write; ai.service only INTERPRETS
 * free text and never decides a write. All outbound sends honour
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
 * buttonValues for the three template quick replies. Index order MUST match
 * the approved template (0 = confirm, 1 = reschedule, 2 = not required).
 * The Gallabox wrapper passes this through untouched.
 */
function templateButtonValues() {
  return [
    { index: 0, type: 'quick_reply', payload: BTN_PAYLOAD.CONFIRM },
    { index: 1, type: 'quick_reply', payload: BTN_PAYLOAD.RESCHEDULE },
    { index: 2, type: 'quick_reply', payload: BTN_PAYLOAD.NOT_REQUIRED },
  ];
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
 * ⚠ LABEL WIDTH: the en-dash carries NO surrounding spaces, unlike the legacy
 * 3-hour labels in job-magic-link.service.js TIME_SLOTS ('3 PM – 7 PM'). The
 * label is written to tbl_job.time_slot, whose width is not declared in any
 * migration we own (legacy column) and whose longest legacy value is exactly
 * 12 chars. Dropping the spaces caps every label at 11 chars, so a narrow
 * VARCHAR cannot silently truncate — truncation would break the
 * `AND time_slot = ?` equality candidate-ranking relies on.
 */
const SLOT_START_HOURS = Object.freeze([9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);

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

async function getActiveByMobile(mobile, pool) {
  const norm = gallabox.normaliseIndianPhone(mobile) || String(mobile || '');
  const last10 = norm.replace(/\D/g, '').slice(-10);
  // Match on the last 10 digits so 91-prefix / no-prefix variants both resolve.
  const [rows] = await pool.query(
    `SELECT * FROM tbl_whatsapp_conversation
      WHERE status = 'active' AND RIGHT(REPLACE(customer_mob_no, ' ', ''), 10) = ?
      ORDER BY conversation_id DESC LIMIT 1`,
    [last10],
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
 *               SNAPSHOT, so it is NOT what the customer should be shown) plus
 *               tbl_job.time_slot, falling back to tbl_job.requested_time.
 *               requested_time is HH:MM-style TEXT, hence the string handling
 *               rather than date arithmetic.
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
 * on file ("Wed, 05 Aug 2026, 3 PM – 7 PM"). Returns null when the job has no
 * scheduled date at all — the caller substitutes a friendly fallback so the
 * template never renders "null"/"undefined".
 */
function jobDateLabel(job) {
  const dateLabel = formatCustomerDateLabel(job && job.appointment_date);
  if (!dateLabel) return null;
  const slot = job.time_slot && String(job.time_slot).trim();
  if (slot) return `${dateLabel}, ${slot}`;
  // requested_time is HH:MM(:SS) TEXT — a separate legacy column, not a date.
  // '00:00' is the "no time captured" sentinel on legacy rows, so skip it.
  const t = /^(\d{1,2}):(\d{2})/.exec(String(job.requested_time || '').trim());
  if (t) {
    const h = Number(t[1]);
    const mins = t[2];
    if (!(h === 0 && mins === '00') && h >= 0 && h <= 23) {
      const h12 = ((h + 11) % 12) + 1;
      const suffix = h < 12 ? 'AM' : 'PM';
      return `${dateLabel}, ${mins === '00' ? `${h12} ${suffix}` : `${h12}:${mins} ${suffix}`}`;
    }
  }
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

  logger.info({ jobId, conversationId, delivered: result.delivered }, 'whatsapp-conversation: started');
  return { delivered: !!result.delivered, suppressed: !!result.disabled, conversationId };
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

/*
 * handleInbound(inbound, pool)
 *
 * Entry point from the webhook. `inbound` is the normalised shape the webhook
 * builds:
 *   { from, messageId, type: 'text'|'button'|'location'|'image'|'video',
 *     text?, buttonId?, location?: {lat,lng}, media?: {url, kind:'image'|'video'} }
 * Returns { handled: boolean, step?, reason? }.
 */
async function handleInbound(inbound, pool) {
  logger.info('Handling inbound WhatsApp message · type=' + (inbound && inbound.type));
  const convo = await getActiveByMobile(inbound.from, pool);
  if (!convo) logger.info('No active WhatsApp conversation for inbound message');
  if (!convo) return { handled: false, reason: 'no_active_conversation' };

  // Dedupe provider retries.
  if (inbound.messageId && convo.last_inbound_msg_id === inbound.messageId) {
    logger.info('Ignoring duplicate inbound message · job=' + convo.job_id);
    return { handled: false, reason: 'duplicate' };
  }

  // Session expiry — free-form replies are only valid inside the 24h window.
  if (convo.expires_at && new Date(convo.expires_at).getTime() < Date.now()) {
    logger.info('WhatsApp conversation expired · job=' + convo.job_id);
    await updateConversation(convo.conversation_id, { status: 'expired' }, pool);
    return { handled: false, reason: 'expired' };
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
function sendSlotPrompt(to, dateLabel, { retry = false } = {}) {
  const head = retry
    ? 'Sorry, I couldn’t read that time.'
    : `Great — we’ll keep your visit on ${dateLabel}.`;
  return gallabox.sendText({
    to,
    body: `${head}\n\nWhich 1-hour slot suits you best? Just reply with the start time (e.g. "10 AM" or "4 PM").\n\nAvailable slots:\n${ONE_HOUR_SLOT_LABELS.join('\n')}`,
  });
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
function sendReschedulePrompt(to, { reason = null } = {}) {
  const head = RESCHEDULE_HEADS[reason] || 'No problem — we’ll move your visit.';
  return gallabox.sendText({
    to,
    body: `${head}\n\nWhich date would you prefer? Please share a future date (e.g. "tomorrow", "5 Aug" or "05-08-2026").`,
  });
}

function sendCancelReasonPrompt(to, { retry = false } = {}) {
  return gallabox.sendText({
    to,
    body: retry
      ? 'Could you tell us in a few words why the service is not required? Your reply is passed on to our team as-is.'
      : 'Understood. May I know the reason? Please reply in your own words — it helps us improve.',
  });
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
 * Columns written on tbl_job: requested_date_time (IST 'YYYY-MM-DD HH:MM:SS'),
 * time_slot (1-hour label), requested_time (HH:MM start — the legacy text
 * column), customer_submitted_at, customer_submitted_payload, last_update_time.
 */
async function finaliseConfirmed(convo, ctx, { date, slot }, to, pool, meta) {
  // IST wall-clock literal. The pool is `timezone: '+05:30'` + dateStrings, so a
  // pre-formatted string stores verbatim — no driver UTC conversion, and no SQL
  // NOW() for an application timestamp.
  const requestedDateTime = `${date} ${slot.start}:00`;
  const payload = {
    ...ctx,
    channel: 'whatsapp_conversation',
    confirmed_date: date,
    time_slot: slot.label,
    requested_time: slot.start,
    requested_date_time: requestedDateTime,
    confirmed_via: ctx.branch === 'reschedule' ? 'reschedule' : 'confirm',
  };
  if (meta && meta.gpsCaptured) payload.gps_location = meta.gpsCaptured;

  await jml.writeCustomerOrderDetails(convo.job_id, {
    requested_date_time: requestedDateTime,
    time_slot: slot.label,
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

  await gallabox.sendText({
    to,
    body: `Your visit is confirmed ✅\n\n🗓️ ${formatCustomerDateLabel(date)}\n⏰ ${slot.label}\n\nOur technician will reach you within this 1-hour window. Thank you!`,
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
