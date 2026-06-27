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
const { contextLine, methodTag } = require('./utils/log-format');

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
    pairs.push(`${k}=${val.length > 120 ? val.slice(0, 117) + '…' : val}`);
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
  console.log(contextLine(req, 'INFO', `${methodTag(req.method)} ${req.originalUrl}`));
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
