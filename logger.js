/*
 * Human-readable logger with semantic emoji helpers.
 *
 * Design rule: every log line is one sentence a non-developer could understand.
 * No JSON dumps. No full HTTP header trees. No internal field names unless useful.
 *
 * Two call styles — both supported so existing call sites keep working:
 *   logger.info('Server ready on port 5100')
 *   logger.info({ jobId: 123 }, 'Job created')   // object appended as `key=value`
 *
 * Semantic helpers (preferred at call sites):
 *   logger.ready('Server ready on port 5100')      → 🚀  green
 *   logger.db('Connected to easyfix_core …')       → 💾  blue
 *   logger.otp('OTP for X: 1234')                  → 🔑  cyan
 *   logger.sms('sent · to=… status=200')           → 📱  blue
 *   logger.email('sent · to=…')                    → 📧  blue
 *   logger.whatsapp('sent · template=login_otp')   → 💬  green
 *   logger.push('FCM sent')                        → 📲  blue
 *   logger.webhook('dispatched TechAssigned')      → 📡  magenta
 *   logger.security('401 refused — bad token')     → 🔒  yellow
 *   logger.rate('throttled · per=client')          → 🛑  yellow
 *   logger.test('TEST MODE redirecting …')         → 🧪  yellow
 *   logger.shutdown('SIGTERM — draining…')         → 🌙  gray
 *   logger.event(icon, color, msg)                 → custom (escape hatch)
 *
 * In TTY (terminal) we add colour + icons. In non-TTY (log file, CI, container
 * stdout) we skip colour but keep structure. Timestamps are local HH:MM:SS.
 */

const { current } = require('./utils/request-context');
const { contextLine, methodTag, redactUrl } = require('./utils/log-format');

const isTTY = process.stdout.isTTY;

const ANSI = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m',
};
const paint = (color, s) => (isTTY ? `${ANSI[color]}${s}${ANSI.reset}` : String(s));
const now = () => new Date().toLocaleTimeString('en-GB', { hour12: false });

// Core-level icons → log LEVEL label. A line emitted INSIDE a request renders in
// the contextual `[time] [surface] identity → [LEVEL] msg` shape; the semantic
// emoji helpers (📱 📧 🔑 …) aren't core levels, so their icon is kept inline so
// the event type still reads at a glance.
const CORE_LEVEL = { 'ℹ': 'INFO', '⚠': 'WARN', '✗': 'ERROR', '·': 'DEBUG' };

// Max characters of ONE structured value before it is cut. This cap is not
// cosmetic: `logger.warn({ someObject }, …)` renders the whole object, so a
// single stray payload on a hot path would otherwise blow the log line out at
// request rate. Keep it tight for everything that has not opted out below.
const EXTRA_VALUE_MAX = 120;

/*
 * Per-key overrides for EXTRA_VALUE_MAX. A map rather than a special case in the
 * truncation expression so the NEXT diagnostic can opt in by adding one line
 * here, instead of editing the rendering logic again.
 *
 * A key earns a place here only when BOTH hold: the field is useless unless it
 * can be read whole, AND its exposure has been reasoned about — not assumed.
 *
 * `bodyShape` — emitted by the webhook diagnostics (routes/webhook/whatsapp.js
 * x2, routes/webhook/plivo-conference.js) through their shapeOf()/shape()
 * helpers. Those helpers replace every leaf VALUE with its `typeof`, so the
 * words a customer typed and the number they typed them from cannot appear.
 *
 * ⚠ BUT "no values" IS NOT "no PII", and the distinction is the whole reason
 * this paragraph is careful. KEY NAMES survive verbatim, so a body that used a
 * phone number AS A KEY would print it:
 *
 *   shapeOf({ contacts: { '919812345678': { name: 'x' } } })
 *     -> {"contacts":{"919812345678":{"name":"string"}}}
 *
 * Today's Gallabox and Plivo envelopes are fixed-schema — every key is a field
 * name — so nothing leaks in practice, and that is the actual reason this key
 * is safe to raise. It is a fact about those providers' payloads, NOT a
 * guarantee shapeOf() makes. Anyone adding a key here must re-check that its
 * emitter cannot produce data-derived key names; raising a cap raises the
 * exposure ceiling by the same multiple.
 *
 * WHY IT HAD TO BE RAISED: at 120 chars every one of these lines was cut
 * mid-key just after "contactId" — 9,631 times in a single week — so the one
 * field whose entire purpose is to reveal an unrecognised envelope never once
 * revealed it.
 *
 * WHY 4000, NOT UNLIMITED: real envelopes render small — the production receipt
 * shape measures 126 characters, a full Gallabox inbound 518 — so 4000 is 8-30x
 * headroom over anything actually seen. It still BOUNDS the pathological case,
 * and that bound is load-bearing rather than decorative: the helpers cap the
 * key COUNT per level (25 in whatsapp's shapeOf, 30 in plivo's shape) and the
 * DEPTH at 2, but that still permits a saturated body serialising to ~316KB.
 * A quarter-megabyte log line written at webhook rate is exactly what the cap
 * exists to stop, so shapeOf() must not be mistaken for self-limiting.
 *
 * Null-prototype so a body key like `toString`, `constructor` or `valueOf` looks
 * up as undefined and falls back to the default cap.
 *
 * With a plain object literal it would instead find the inherited
 * Object.prototype FUNCTION, and the failure is the opposite of the obvious
 * one: `val.length > cap` compares a number to a function, which is NaN-false,
 * so the ternary takes the else branch and renders the value IN FULL AND
 * UNBOUNDED. The slice is never reached — nothing is truncated to nothing;
 * everything is truncated to nothing at all. Measured, not reasoned: a
 * 400-character value under key `toString` renders at 400.
 */
const EXTRA_VALUE_MAX_BY_KEY = Object.assign(Object.create(null), {
  bodyShape: 4000,
});

function splitArgs(arg1, arg2) {
  if (typeof arg1 === 'string') return { obj: arg2 && typeof arg2 === 'object' ? arg2 : null, msg: arg1 };
  if (arg1 && typeof arg1 === 'object') return { obj: arg1, msg: typeof arg2 === 'string' ? arg2 : '' };
  return { obj: null, msg: String(arg1 ?? '') };
}

function renderExtras(obj) {
  if (!obj) return '';
  const pairs = [];
  for (const [k, v] of Object.entries(obj)) {
    if (['service', 'pid', 'hostname', 'level', 'time'].includes(k)) continue;
    if (v == null || v === '') continue;
    if (k === 'err' && v && typeof v === 'object') {
      const e = v;
      pairs.push(`error="${e.message || String(e)}"`);
      continue;
    }
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
    // Unknown keys get EXTRA_VALUE_MAX — an unrecognised key must behave exactly
    // as it does today. `slice(cap - 1) + '…'` keeps the rendered value at
    // exactly `cap` characters: the ellipsis is ONE character and replaces the
    // last one rather than being appended past the cap. (The old form sliced to
    // 117 for a cap of 120, budgeting three chars for a one-char ellipsis.)
    const cap = EXTRA_VALUE_MAX_BY_KEY[k] || EXTRA_VALUE_MAX;
    pairs.push(`${k}=${val.length > cap ? val.slice(0, cap - 1) + '…' : val}`);
  }
  return pairs.length ? `  ${paint('dim', pairs.join(' '))}` : '';
}

// The FIRST app-log of a request prints a header line (the request's
// method + path) so the endpoint heads its group of logs; the access line at
// finish then collapses to a compact `↳ <status> (<ms>)` (see http-log.js).
// Requests with NO app logs never call this → they get a single full access line.
function maybeHeader(req) {
  if (req._logHeaderEmitted) return;
  req._logHeaderEmitted = true;
  // Redacted for the same reason as the access line in http-log.js: this header
  // prints the URL for EVERY request that emits an app log, so an identity value
  // in the path would be written out at request rate.
  console.log(contextLine(req, 'INFO', `${methodTag(req.method)} ${redactUrl(req.originalUrl)}`));
}

function line(icon, color, arg1, arg2) {
  const { obj, msg } = splitArgs(arg1, arg2);
  const body = `${msg}${renderExtras(obj)}`;
  const req = current();
  if (req) {
    // Inside a request → contextual line. Core levels map to a [LEVEL] tag;
    // semantic-emoji events keep their icon inline so the type still shows.
    maybeHeader(req);
    const level = CORE_LEVEL[icon] || 'INFO';
    const message = CORE_LEVEL[icon] ? body : `${icon} ${body}`;
    console.log(contextLine(req, level, message));
  } else {
    console.log(`${paint('gray', now())}  ${paint(color, icon)}  ${body}`);
  }
}

const logger = {
  // Core levels
  info:     (a, b) => line('ℹ', 'blue',    a, b),
  warn:     (a, b) => line('⚠', 'yellow',  a, b),
  error:    (a, b) => line('✗', 'red',     a, b),
  debug:    (a, b) => { if (process.env.LOG_LEVEL === 'debug') line('·', 'gray', a, b); },

  // Semantic helpers — icon + colour baked in
  ready:    (a, b) => line('🚀', 'green',   a, b),
  db:       (a, b) => line('💾', 'blue',    a, b),
  otp:      (a, b) => line('🔑', 'cyan',    a, b),
  sms:      (a, b) => line('📱', 'blue',    a, b),
  email:    (a, b) => line('📧', 'blue',    a, b),
  whatsapp: (a, b) => line('💬', 'green',   a, b),
  push:     (a, b) => line('📲', 'blue',    a, b),
  webhook:  (a, b) => line('📡', 'magenta', a, b),
  security: (a, b) => line('🔒', 'yellow',  a, b),
  rate:     (a, b) => line('🛑', 'yellow',  a, b),
  test:     (a, b) => line('🧪', 'yellow',  a, b),
  shutdown: (a, b) => line('🌙', 'gray',    a, b),
  upload:   (a, b) => line('⬆️', 'blue',    a, b),
  job:      (a, b) => line('🧾', 'cyan',    a, b),

  // Escape hatch for one-off icons
  event:    (icon, color, a, b) => line(icon, color, a, b),

  // Pre-formatted passthrough — the caller owns the ENTIRE line layout. Used by
  // middleware/http-log.js, whose `[Surface] [Identity] [Time] …` prefix doesn't
  // fit the standard `<time> <icon> <msg>` shape; emitted verbatim.
  http:     (s) => console.log(String(s)),
};

module.exports = logger;
