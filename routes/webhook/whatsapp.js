const router = require('express').Router();
const crypto = require('crypto');
const logger = require('../../logger');
const { modernOk, modernError } = require('../../utils/response');
const { pool } = require('../../db');
const convo = require('../../services/whatsapp-conversation.service');
/*
 * Imported for normaliseIndianPhone ONLY — the sender-identity check below has
 * to compare numbers the same way the rest of the codebase does, and a third
 * private copy of India's dialling rules is how those comparisons drift apart.
 *
 * No cycle: this route already requires whatsapp-conversation.service, which
 * itself requires this module, and nothing under services/ requires routes/.
 * (Checked rather than assumed — a require cycle here would surface as an empty
 * object at call time, i.e. a TypeError on the first webhook of the day.)
 */
const gallabox = require('../../services/gallabox.whatsapp.service');
const { rateLimit, failureBreaker } = require('../../middleware/rate-limit');
const { maskMobile } = require('../../utils/mask-mobile');

/*
 * Inbound WhatsApp webhook (Gallabox → us) for the conversational
 * order-confirmation flow. Mounted at /api/webhook/whatsapp.
 *
 * Security: a shared secret (GALLABOX_WEBHOOK_SECRET) is required on every
 * request — accepted via the `x-webhook-secret` header OR `?secret=` query
 * (Gallabox lets you configure a custom header on the webhook). No JWT — this
 * is a provider→server callback. If the secret is unset we FAIL CLOSED (reject)
 * so a half-configured deploy can't accept spoofed inbound traffic.
 *
 * We always reply 200 once the secret checks out (even when we don't act on a
 * message) so the provider doesn't retry-storm; real processing errors are
 * logged server-side, not surfaced to the BSP.
 *
 * NOTE: the exact Gallabox inbound payload shape must be confirmed against the
 * Gallabox dashboard/docs at rollout. normaliseInbound() is intentionally
 * tolerant of several likely field paths so we can adapt without a rewrite.
 */

// The header we read the shared secret from. Gallabox lets you configure a
// custom header on the webhook, so this name has to be mirrored there — which
// is why the refusal log names it rather than leaving ops to grep for it.
const SECRET_HEADER = 'x-webhook-secret';

function secretOk(req) {
  /*
   * TRIM BOTH SIDES. This is a value a human pastes into a .env file on one
   * host and into a provider dashboard on another, and both routinely pick up a
   * trailing newline or space that is invisible in every window you would look
   * at. Untrimmed, that produces `bad secret, refused` on a secret that reads as
   * identical in both places — an hour of debugging for a character nobody can
   * see. Trimming cannot weaken the check: surrounding whitespace carries no
   * entropy, and the comparison stays constant-time on the trimmed bytes.
   */
  const expected = String(process.env.GALLABOX_WEBHOOK_SECRET || '').trim();
  // Fail closed on an UNSET secret — a half-configured deploy must not accept
  // spoofed inbound traffic. (This is why a blank env var rejects every inbound
  // no matter how correctly the provider is configured.)
  if (!expected) return { ok: false, cause: 'not_configured' };
  const got = String(req.get(SECRET_HEADER) || req.query.secret || '').trim();
  if (!got) return { ok: false, cause: 'absent' };
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  return ok ? { ok: true } : { ok: false, cause: 'mismatch', sameLength: a.length === b.length };
}

/*
 * ── ONE REFUSAL, THREE DIFFERENT INCIDENTS ────────────────────────────────
 *
 * secretOk() used to answer a bare boolean, so every rejection logged the same
 * line: `bad secret, refused`. Three causes wear that label, they need three
 * different people to do three different things, and the log could not tell
 * them apart:
 *
 *   not_configured — OUR env var is blank, so the guard above refuses EVERY
 *                    inbound however perfectly Gallabox is set up. The whole
 *                    conversational flow is inert and every customer reply is
 *                    dropped. That is a deployment gap, not a security event,
 *                    and it is the one this wording most badly misrepresented:
 *                    it reads like somebody probing us.
 *   absent         — we hold a secret; the request carried none. Gallabox is
 *                    not sending it, or is sending a DIFFERENTLY-NAMED header —
 *                    so the header names present are logged (names only) and
 *                    the one we expect is named outright.
 *   mismatch       — both present, different. Almost always a paste that picked
 *                    up or lost characters, which is why the length comparison
 *                    is reported: equal lengths point at a wrong value, unequal
 *                    at truncation.
 *
 * NEVER log either secret, at any level, in any branch. The length RELATION is
 * a single bit about a value the caller already supplied and reveals nothing
 * about ours.
 */

/*
 * ── TWO LAYERS, BOUNDING TWO DIFFERENT THINGS ─────────────────────────────
 *
 * A misconfigured provider does not send one bad request; it retries. The log
 * that prompted this shows twelve refusals in fifteen seconds, and it would
 * have gone on indefinitely, because nothing here ever told Gallabox to stop.
 *
 *   breaker — charges ONLY refusals, and one authenticated request clears it.
 *             This is the layer that matters: it opens fast on exactly the
 *             failure we are in, and correct traffic can never trip it however
 *             heavy, so a real burst of customer replies is never dropped.
 *   ceiling — a plain per-IP cap on everything, deliberately generous. It is
 *             not aimed at this incident but at the one the breaker cannot see:
 *             a provider bug retry-storming messages that DO authenticate.
 *
 * Both are per-process (see middleware/rate-limit.js). With several replicas
 * each holds its own view, so the effective limits are per-replica — fine for a
 * backstop, and Redis is the answer if these ever need to be exact.
 *
 * KEYED ON IP. A shared secret has no identity to key on before it verifies,
 * and by definition the requests being bounded are the ones we cannot attribute.
 */
const inboundCeiling = rateLimit({
  windowMs: 60_000,
  max: 600,                       // ~10/s sustained from one address
  key: (req) => `wa-hook:${req.ip}`,
});

const authBreaker = failureBreaker({
  windowMs: 60_000,
  maxFailures: 20,
  key: (req) => `wa-hook-fail:${req.ip}`,
  /*
   * Logged ONCE per window, at ERROR. Once at error beats twenty at warn: the
   * per-request line is what buried the signal, and an integration that has
   * been refusing every message for a minute is a real incident rather than a
   * routine rejection.
   */
  onOpen: (info) => logger.error(
    `WhatsApp webhook · CIRCUIT OPEN after ${info.failures} refused requests in `
    + `${Math.round(info.windowMs / 1000)}s from one address — further requests get 429 + `
    + `Retry-After ${info.retryAfterSec}s until a request authenticates. The cause is in the `
    + 'refusal line logged just above this one; fix that and the breaker clears on the first '
    + 'request that gets through.',
  ),
});

function refuse(res, req, verdict, what) {
  if (verdict.cause === 'not_configured') {
    logger.error(`${what} · GALLABOX_WEBHOOK_SECRET is not set on this server — the WhatsApp webhook `
      + 'refuses EVERY inbound message while it is blank, so the conversational job-completion flow '
      + 'cannot progress. Set it here AND on the Gallabox webhook, to the same value.');
  } else if (verdict.cause === 'absent') {
    logger.warn({ headerNames: Object.keys(req.headers || {}).slice(0, 40) },
      `${what} · no secret on the request. We read the "${SECRET_HEADER}" header (or ?secret=); `
      + 'the header names actually received are above — if Gallabox is sending its own differently '
      + 'named header, configure the custom header on the webhook to match.');
  } else {
    logger.warn(`${what} · secret MISMATCH — the value sent does not match GALLABOX_WEBHOOK_SECRET `
      + `(lengths ${verdict.sameLength ? 'match, so it is a different value' : 'differ, so it is truncated or a different secret entirely'}).`);
  }
  /*
   * Charged AFTER the cause has been logged, so the very refusal that opens the
   * breaker still explains itself. Reversing these would open the circuit on a
   * line that says only "429" — and the diagnosis would be gone with it.
   */
  authBreaker.recordFailure(req);
  return modernError(res, 401, 'unauthorized');
}

/*
 * A body's KEY PATHS with the leaf VALUES replaced by their types. Shared by
 * both diagnostic branches — the fully-unparseable one and the found-a-sender-
 * but-no-content one — so a body can never be described one way in one log line
 * and another way in the next.
 *
 * ⚠ KEYS ONLY, NEVER VALUES. An inbound WhatsApp body carries the customer's
 * phone number and the words they typed. This is a diagnostic about SHAPE, and
 * the moment it prints a value it becomes a PII leak in a log nobody audits.
 */
function shapeOf(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 2) return undefined;
  const out = {};
  for (const k of Object.keys(o).slice(0, 25)) {
    const v = o[k];
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? (shapeOf(v, depth + 1) || '{…}') : typeof v;
  }
  return out;
}

// Best-effort normaliser: Gallabox wraps the WhatsApp message in an event
// envelope. We probe the common locations for each field.
/*
 * ⚠ SEARCH EVERY CANDIDATE ENVELOPE, don't commit to one.
 *
 * This was `const p = body.payload || body.message || body.data || body`, and
 * `body.message` is present on the real Gallabox envelope — so it won the chain
 * and every field was then read out of a nested object that does not hold them.
 * The symptom was a conversation that existed, was `active`, and never once
 * matched an inbound: `from` resolved to something other than the customer's
 * number, and the reply text was at no probed path, so every message logged
 * `type=unknown` and `no_active_conversation`.
 *
 * The identical defect was in normaliseStatus and had silently broken delivery
 * receipts for as long as they have existed. One `||` chain over candidate
 * envelopes, two functions, two outages — because the chain quietly asserts
 * that the first non-null candidate is the right one, and says nothing when it
 * is wrong.
 *
 * So: no choosing. Probe the SAME key names as before, across every plausible
 * envelope, first hit wins. The key lists are deliberately unchanged — inventing
 * new provider field names is the guess that started this. If a real reply still
 * lands as `type=unknown`, the CONTENT NOT FOUND log prints the actual key paths
 * and we widen from evidence.
 */
function inboundEnvelopes(body) {
  const out = [];
  const push = (o) => {
    if (!o || typeof o !== 'object' || Array.isArray(o) || out.includes(o)) return;
    out.push(o);
    if (o.whatsapp && typeof o.whatsapp === 'object') out.push(o.whatsapp);
  };
  // Outermost first: a top-level field beats the same name nested inside
  // `message`, which is where the previous chain went wrong.
  push(body);
  push(body.payload);
  push(body.data);
  push(body.message);
  return out;
}

/** First non-empty value for any of `keys`, across all candidate envelopes. */
function firstOf(envs, keys) {
  for (const o of envs) {
    for (const k of keys) {
      const v = o[k];
      if (v != null && v !== '') return v;
    }
  }
  return null;
}

/*
 * ⚠ THE SENDER IS CHOSEN BY CONTENT, NOT BY POSITION.
 *
 * firstOf walks envelope-outer / key-inner, so a TOP-LEVEL `sender` wins before
 * `whatsapp.from` is ever looked at. Gallabox's envelope carries both:
 *
 *   { id, conversationId, accountId, channelId, channelType, localMessageId,
 *     contactId, sender, senderType, contact:{name},
 *     whatsapp:{ to, time, status, type, interactive, … } }
 *
 * `sender` sits amongst `contactId` / `senderType` / `contact.name` — Gallabox's
 * own contact model — so it is not guaranteed to be a dialable number, while the
 * customer's actual number lives in the `whatsapp` sub-envelope. Resolving the
 * sender positionally therefore hands a NON-PHONE to the conversation lookup,
 * which matches on the last ten digits of a mobile and so matches nothing.
 *
 * That is not theoretical. Production, 2026-08-18: a conversation was opened for
 * job 523247 (conversationId=9, delivered=true, status='active') and the
 * customer's button reply arrived TEN SECONDS later, parsed correctly as
 * `type=button buttonId="Need a Reschdeule"` — and was answered with "no
 * conversation has EVER been opened for this number". `never_started` comes from
 * a query with NO status filter, so it means no row was found for that number AT
 * ALL, ten seconds after one was written. Across the whole log corpus not one of
 * 14,380 inbound messages has ever been handled.
 *
 * This is the same defect this file has already been repaired for twice — the
 * comments on normaliseStatus and normaliseInbound both describe an `||` chain
 * over candidate envelopes that "silently assumes the first non-null one is the
 * right one". Those repairs widened the SEARCH but kept positional precedence,
 * so the assumption survived. The prescription in those comments is the fix:
 * choose by content — whichever candidate is actually a phone number is the
 * phone number.
 *
 * FAIL SAFE: if NO candidate parses as a mobile, this returns exactly what
 * firstOf would have. An envelope we do not understand behaves as it does today
 * rather than resolving the sender to null, which would turn a matching failure
 * into a dropped message.
 */
function looksLikeMobile(v) {
  if (v == null || (typeof v !== 'string' && typeof v !== 'number')) return false;
  return gallabox.normaliseIndianPhone(String(v)) != null;
}

function firstPhoneOf(envs, keys) {
  for (const o of envs) {
    for (const k of keys) {
      if (looksLikeMobile(o[k])) return o[k];
    }
  }
  return firstOf(envs, keys);
}

function normaliseInbound(body) {
  if (!body || typeof body !== 'object') return null;
  const envs = inboundEnvelopes(body);
  // Kept so the existing per-field probes below read unchanged.
  const p = envs[0];
  const wa = p.whatsapp || p;

  // `wa_id` / `waId` are Meta's own spellings and cost nothing to probe; the
  // resolution is by content, so an extra key cannot pick a worse candidate.
  const from = firstPhoneOf(envs, ['from', 'sender', 'phone', 'mobile', 'wa_id', 'waId']);
  const messageId = firstOf(envs, ['id', 'messageId', 'whatsappMessageId']);
  const rawType = String(firstOf(envs, ['type']) || '').toLowerCase();

  // Interactive button reply — id is the stable thing we keyed our buttons on.
  //
  // TEMPLATE quick replies (the `customer_interactive_msg` confirm/reschedule/
  // not-required buttons) are matched by Gallabox/Meta on the PAYLOAD string, and
  // different envelope shapes surface it as `payload`, `id` or the button
  // `title`/`text`. Probe all of them — whatsapp-conversation.service's
  // matchTemplateChoice() normalises case/whitespace and also accepts the raw
  // text, so any of these resolves to the right branch.
  const interactive = firstOf(envs, ['interactive']);
  const buttonReply = interactive?.button_reply || interactive?.reply || firstOf(envs, ['button']);
  const buttonId = buttonReply?.id
    || buttonReply?.payload
    || buttonReply?.title
    || buttonReply?.text
    || firstOf(envs, ['buttonId'])
    || p.payload?.id
    || null;

  // Location
  const loc = firstOf(envs, ['location']);
  const lat = loc?.latitude ?? loc?.lat ?? null;
  const lng = loc?.longitude ?? loc?.lng ?? null;

  // Media (image/video) — Gallabox typically gives a hosted url.
  const mediaObj = firstOf(envs, ['image', 'video', 'media']);
  const mediaUrl = mediaObj?.url || mediaObj?.link || mediaObj?.mediaUrl || null;

  /*
   * Text arrives either as a string or as { body }. Resolved across envelopes
   * for the same reason as everything else above — the customer's words being
   * one level further in than we looked is exactly what produced `type=unknown`
   * on every real reply.
   */
  const textRaw = firstOf(envs, ['text', 'body']);
  const text = (textRaw && typeof textRaw === 'object')
    ? (textRaw.body || null)
    : (textRaw || null);

  let type = 'unknown';
  if (buttonId) type = 'button';
  else if (lat != null && lng != null) type = 'location';
  else if (rawType === 'image' || (mediaObj && /image/i.test(mediaObj.mime || mediaObj.contentType || ''))) type = 'image';
  else if (rawType === 'video' || (mediaObj && /video/i.test(mediaObj.mime || mediaObj.contentType || ''))) type = 'video';
  else if (text) type = 'text';

  if (!from) return null;
  return {
    from,
    messageId,
    type,
    text: text || null,
    buttonId: buttonId || null,
    location: (lat != null && lng != null) ? { lat: Number(lat), lng: Number(lng) } : null,
    media: mediaUrl ? { url: mediaUrl, kind: type } : null,
  };
}

// Delivery-STATUS callback normaliser. Distinct from normaliseInbound (which
// only understands CUSTOMER messages and returns null for a status callback).
//
// LOAD OPTIMISATION: we recognise ONLY the FAILURE states (failed/undelivered).
// WhatsApp fires a status callback for EVERY message transition
// (sent → delivered → read), so acting on all of them would mean 3+ DB writes
// per message for ZERO UI benefit — the only surface is the "Delivery Failed"
// chip. Non-failure callbacks return null here and fall through to the cheap
// "not actionable, ignored" path (no DB touch). So only genuinely-failed sends
// ever hit the (indexed) UPDATE — the write path stays near-zero. delivery_status
// is optimistically seeded 'sent' at dispatch, so "no failure callback" already
// reads as sent. Field-probing is tolerant of the envelope shape.
const DELIVERY_FAILURE_STATES = new Set(['failed', 'undelivered']);

/*
 * ⚠ RECOGNISE a receipt even when we do not ACT on one.
 *
 * The paragraph above is right that only failures deserve a DB write — but the
 * first version expressed that by returning null for every non-failure, which
 * dropped `sent`/`delivered`/`read` into the UNPARSEABLE branch below. Those
 * three fire for EVERY message we send, so roughly half the webhook log became
 * a WARN reading "normaliseInbound found no actionable fields … widen the
 * probes" — advice that is simply wrong. Nothing needs widening: a receipt is
 * not a customer message and never will be.
 *
 * The cost is not CPU, it is that UNPARSEABLE stopped meaning anything. It
 * exists to say "a customer sent something we could not read", which is a real
 * and urgent thing, and it was firing constantly for traffic that is entirely
 * normal. So receipts are identified here and acknowledged quietly; only
 * failures carry `actionable`.
 *
 * Identified by SHAPE, not by an allow-list of status words: a delivery receipt
 * carries a recipient and a message id and no message content. Guessing at the
 * provider's vocabulary is what produced the original gap.
 */
const DELIVERY_STATUS_STATES = new Set([
  'sent', 'delivered', 'read', 'failed', 'undelivered', 'deleted', 'accepted', 'queued',
]);

/*
 * Markers that identify a receipt when it carries NO status word at all.
 * Production sends both of these shapes:
 *   { id, status, timestamp, errors, recipient_id, message:{recipient_id} }
 *   { id, timestamp,          recipient_id, message:{recipient_id}, localMessageId }
 * The second has neither `status` nor `errors`, so the first version of this
 * check missed it and it kept landing in UNPARSEABLE — harmless, but exactly the
 * noise this function exists to stop.
 */
const RECEIPT_MARKERS = ['errors', 'localMessageId'];

/*
 * ⚠ A SENDER THAT IS US IS NOT A SENDER.
 *
 * Gallabox posts events ABOUT MESSAGES WE SENT to this same URL, and those
 * carry a `from` — our OWN WhatsApp Business (WABA) number. Measured in
 * production over one week: 9,631 of them, 67% of everything arriving on this
 * endpoint, each one logging
 *
 *   "WhatsApp inbound · CONTENT NOT FOUND — a real sender, but no text, button,
 *    location or media at any probed path"
 *
 * because the `from` cleared the veto below, normaliseInbound then found a
 * sender and no content, and the route WARNed asking the reader to widen the
 * probes. There is nothing to widen. Their bodyShape is
 * `{ id, accountId, channelId, channelType, localMessageId, contactId … }` —
 * an event about our own outbound, not a customer reply, and no probe will ever
 * find words in it that a customer did not type. Two thirds of this endpoint's
 * log was advice that could not be followed.
 *
 * The veto exists so a CUSTOMER message can never be classified as a receipt:
 * normaliseStatus runs BEFORE normaliseInbound, so anything looksLikeReceipt
 * returns true for never reaches the conversation handler, and a misclassified
 * reply is dropped in silence — strictly worse than any amount of log noise.
 * Narrowing it from "a sender" to "a sender that is not us" preserves that
 * guarantee exactly: our own WABA number is the one number on WhatsApp that
 * can never belong to a customer talking to us.
 */

/*
 * Our own WABA sender number(s), as they appear in a `from`.
 *
 * ⚠ NOTHING EXISTING HOLDS THIS. GALLABOX_CHANNEL_ID is an opaque Gallabox
 * channel ObjectId and META_WHATSAPP_PHONE_NUMBER_ID is Meta's internal numeric
 * id — neither is the dialable number a payload names as its sender, so neither
 * can be reused here. This is the first place the NUMBER itself is needed, and
 * therefore the first place it is read; if a shared accessor for it is ever
 * added, this should move to it rather than a second one growing alongside.
 *
 * Comma-separated: the Gallabox channel and the Meta phone number are
 * configured independently (services/gallabox.whatsapp.service.js,
 * services/meta.whatsapp.service.js) and are not required to be one number.
 *
 * Not in .env.example yet — adding it there is an ops follow-up. Until it is
 * set, see ownWabaNumberKeys(): the behaviour is exactly today's.
 */
const OWN_WABA_NUMBER_ENV = 'WHATSAPP_BUSINESS_NUMBER';

/*
 * Compare by the LAST 10 DIGITS, the same key the rest of the codebase matches
 * phone numbers on (services/whatsapp-conversation.service.js mobileMatchKey /
 * MOBILE_MATCH_SQL), built on the same normaliser. "+91 98123 45678",
 * "919812345678" and "9812345678" are one number and must produce one key.
 *
 * Null unless a full 10 digits survive, and that is load-bearing rather than
 * tidy: a short key of '' would compare EQUAL to another '' and lift the veto
 * for any body whose sender field is junk or an object — which is precisely the
 * silent customer-message drop this guard exists to make impossible.
 */
const PHONE_KEY_DIGITS = 10;

/*
 * ⚠ NO RAW-DIGIT FALLBACK. The normaliser must SUCCEED, or there is no key.
 *
 * This read `normaliseIndianPhone(raw) || String(raw ?? '')`, and that fallback
 * made the fail-safe claim below false in the one way that costs a customer
 * their reply. Any string carrying ten digits produced a live key from its last
 * ten:
 *
 *   phoneMatchKey('6239ce4aa43d5900047800d1')  ->  '9000478001'
 *
 * — that is a GALLABOX_CHANNEL_ID, the single most likely thing for an operator
 * to paste into a new variable named WHATSAPP_BUSINESS_NUMBER. Set it and the
 * genuine customer on 9000478001 has every reply classified as a receipt:
 * never routed, never logged, gone. Reproduced against the mounted router, not
 * reasoned about.
 *
 * Requiring the normaliser to parse the value means an unrecognisable token
 * yields NO key, isOwnWabaNumber() is false for everything, and the veto
 * reverts to its original all-senders form — noisy, and correct.
 *
 * Applied to BOTH sides on purpose. A payload `from` we cannot parse is not a
 * number we can claim is ours, so it counts as a third-party sender and the
 * message goes to the inbound handler. Every unparseable input therefore fails
 * towards "this is a customer", which is the only direction that is safe.
 */
function phoneMatchKey(raw) {
  const norm = gallabox.normaliseIndianPhone(raw);
  if (!norm) return null;
  const key = String(norm).replace(/\D/g, '').slice(-PHONE_KEY_DIGITS);
  return key.length === PHONE_KEY_DIGITS ? key : null;
}

/*
 * ⚠ FAIL SAFE — the most important line in this change.
 *
 * Unset, blank, or unparseable — a name, a Gallabox channel id, a shortcode —
 * all yield NO keys, isOwnWabaNumber() is then false for every value, and the
 * veto behaves EXACTLY as it did before any of this existed: any sender vetoes.
 * (This sentence was WRONG until phoneMatchKey stopped falling back to raw
 * digits: a channel id yielded a live key. It is true now because the
 * normaliser has to parse the token, and it is pinned by a test that uses a
 * digit-bearing unparseable value rather than a digit-free one.) A
 * deployment that never sets the variable keeps the old log noise and keeps
 * every customer message — it must never start swallowing replies as the price
 * of a quieter log.
 *
 * Read per call, not cached at module load, so an env change takes effect on a
 * restart-free config reload (and so a test can set one). The cost is splitting
 * a short string on a path that has already parsed a JSON body.
 */
function ownWabaNumberKeys() {
  return String(process.env[OWN_WABA_NUMBER_ENV] || '')
    .split(',')
    .map(phoneMatchKey)
    .filter((k) => k != null);
}

function isOwnWabaNumber(value) {
  const own = ownWabaNumberKeys();
  if (!own.length) return false;   // not configured → nothing is "us" → old behaviour
  const key = phoneMatchKey(value);
  return key != null && own.includes(key);
}

/*
 * The fields a body can name its sender in — the original inline chain, moved
 * out so the veto can apply the SAME test to each one. The list is deliberately
 * unchanged; only the test applied to each value has narrowed.
 */
const SENDER_KEYS = ['from', 'sender', 'phone', 'mobile'];

/*
 * ⚠ `from` IS THE VETO, and it is what makes widening the markers safe.
 *
 * normaliseStatus runs BEFORE normaliseInbound in the route, so anything this
 * returns truthy for never reaches the conversation handler. Calling a real
 * customer message a receipt would therefore drop it silently — the worst
 * outcome available here, and strictly worse than the log noise being fixed.
 *
 * The two are cleanly separable by direction: a RECEIPT is about a message WE
 * sent, so it names a `recipient_id` and no sender OTHER THAN US. An INBOUND
 * names a `from` belonging to someone else. Requiring the absence of a
 * third-party sender means a message can never be swallowed by a marker that a
 * future provider payload happens to share.
 *
 * "No sender at all" was the original rule and it is still the rule whenever
 * OWN_WABA_NUMBER_ENV is unconfigured — see isOwnWabaNumber() above for the
 * one, fail-safe exception and the 9,631-a-week reason it exists.
 */
function looksLikeReceipt(p) {
  if (!p || typeof p !== 'object') return false;

  /*
   * THE VETO GOES FIRST, and it applies to the status word too.
   *
   * The obvious shape of this function is "known status word → receipt, else
   * check markers", which returns early and lets `status` outrank a real sender.
   * A body carrying BOTH would then be classified as a receipt and never reach
   * the conversation handler — a customer reply dropped in silence, to save a
   * log line. `status` is a generic key name; it is not ours to reserve.
   *
   * Neither production receipt shape carries a sender (both name only
   * recipient_id), so vetoing on one costs us nothing and closes the hole.
   */
  /*
   * ANY sender that is not US vetoes — not merely the first sender field
   * present. If a body ever carried both our number and a customer's, the
   * customer's still wins and the body stays a message. The asymmetry is
   * deliberate: guessing "message" costs a log line, guessing "receipt" costs a
   * customer's reply.
   *
   * With OWN_WABA_NUMBER_ENV unset this reduces, value for value, to the
   * original `p.from != null || p.sender != null || …`.
   */
  const hasSender = SENDER_KEYS.some((k) => p[k] != null && !isOwnWabaNumber(p[k]));
  if (hasSender) return false;

  const state = String(p.status || p.deliveryStatus || p.event || '').toLowerCase();
  if (DELIVERY_STATUS_STATES.has(state)) return true;

  const hasRecipient = p.recipient_id != null
    || (p.message && typeof p.message === 'object' && p.message.recipient_id != null);
  if (!hasRecipient) return false;
  return RECEIPT_MARKERS.some((k) => k in p);
}

function normaliseStatus(body) {
  if (!body || typeof body !== 'object') return null;
  /*
   * ⚠ PICK THE ENVELOPE THAT ACTUALLY CARRIES THE STATUS, don't take the first
   * truthy probe.
   *
   * This was `body.payload || body.data || body.message || body`, and the real
   * Gallabox receipt is shaped:
   *
   *   { id, status, timestamp, errors, recipient_id, message: { recipient_id } }
   *
   * — status and errors at the TOP, and a nested `message` that holds only a
   * recipient. So `body.message` won the || chain and shadowed the whole
   * envelope: `p.status` was undefined, `s` was '', and the function returned
   * null for EVERY receipt. Not just the routine ones — the FAILURES too, which
   * means the "Delivery Failed" chip this code exists to drive has never once
   * been populated for this provider.
   *
   * An || chain over candidate envelopes silently assumes the first non-null one
   * is the right one. Choose by content instead: whichever candidate looks like
   * a receipt is the receipt.
   */
  const candidates = [body.payload, body.data, body, body.message]
    .filter((o) => o && typeof o === 'object');
  const p = candidates.find(looksLikeReceipt) || candidates[0] || body;
  const s = String(p.status || p.deliveryStatus || p.event || '').toLowerCase();
  // Not a receipt at all → let the inbound normaliser have it.
  if (!looksLikeReceipt(p) && !DELIVERY_FAILURE_STATES.has(s)) return null;
  if (!DELIVERY_FAILURE_STATES.has(s)) {
    // A receipt we deliberately do not act on. Returned rather than nulled so
    // the route can acknowledge it without calling it unparseable.
    return { actionable: false, status: s || 'unknown' };
  }
  const msgId = p.whatsappMessageId || p.messageId || p.id || p.channelMessageId || null;
  if (!msgId) return { actionable: false, status: s };
  const errObj = p.failedReason || p.error || (Array.isArray(p.errors) ? p.errors[0] : null) || null;
  const reason = errObj
    ? String(errObj.message || errObj.title || errObj.reason || errObj.code || '').slice(0, 255)
    : null;
  return { msgId, status: s, reason };
}

// Optional GET verify handshake (some BSPs ping the URL with the secret).
router.get('/whatsapp', inboundCeiling, authBreaker.guard, (req, res) => {
  const verdict = secretOk(req);
  if (!verdict.ok) return refuse(res, req, verdict, 'WhatsApp verify handshake');
  authBreaker.recordSuccess(req);
  logger.info('WhatsApp verify handshake · ok');
  return modernOk(res, { ok: true });
});

router.post('/whatsapp', inboundCeiling, authBreaker.guard, async (req, res) => {
  const verdict = secretOk(req);
  if (!verdict.ok) return refuse(res, req, verdict, 'WhatsApp inbound webhook');
  /*
   * Clear the budget the moment anything authenticates. This is what makes the
   * breaker safe to leave on: the instant the provider's header is fixed, the
   * first request through returns the full allowance, and a legitimate backlog
   * of queued customer replies is never penalised for the misconfiguration that
   * preceded it.
   */
  authBreaker.recordSuccess(req);

  // Delivery-status callback FIRST — these were previously swallowed by the
  // "not actionable" branch below. Reflect the real WhatsApp outcome onto the
  // job (keyed by the provider msg id we stamped at send time). Unmatched id →
  // affectedRows 0, benign (covers non-magic-link sends). Always 200 so the BSP
  // doesn't retry-storm. Column-tolerant: pre-migration deploys just log + skip.
  const statusCb = normaliseStatus(req.body);
  /*
   * A receipt we do not act on: sent / delivered / read. Acknowledged at DEBUG
   * so it stops drowning the log, and so UNPARSEABLE below goes back to meaning
   * "a CUSTOMER sent something we could not read" — the only reading that is
   * worth waking up for.
   */
  if (statusCb && statusCb.actionable === false) {
    logger.debug('WhatsApp delivery receipt · status=' + statusCb.status + ' — noted, no action');
    return modernOk(res, { received: true, status: statusCb.status, handled: false });
  }
  if (statusCb) {
    try {
      const [r] = await pool.query(
        `UPDATE tbl_job SET magic_link_delivery_status = ?, magic_link_delivery_reason = ?
          WHERE magic_link_provider_msg_id = ?`,
        [statusCb.status, statusCb.reason, statusCb.msgId],
      );
      const matched = (r && r.affectedRows != null) ? r.affectedRows : 0;
      /*
       * matchedJobs=0 ON A FAILURE IS NOT ROUTINE — it is the chip silently not
       * lighting, and it deserves to be loud.
       *
       * The UPDATE keys on magic_link_provider_msg_id, seeded from the Gallabox
       * SEND response; the receipt carries whatever id the RECEIPT uses. If those
       * are different id spaces, this matches nothing, forever, and the whole
       * delivery-failure surface stays blank while looking healthy. Zero is
       * legitimate for a send this feature did not make (an OTP, a notification),
       * so it cannot be an error — but on a genuine failure it is the one number
       * worth reading, and at INFO nobody was going to.
       */
      if (matched === 0) {
        logger.warn('WhatsApp status callback · status=' + statusCb.status + ' msgId=' + statusCb.msgId
          + ' matchedJobs=0 — no job carries this provider message id. Either the send was not a '
          + 'magic-link/conversation message, or the receipt id and the id stored at send time are '
          + 'different id spaces, in which case the Delivery Failed chip can never light.');
      } else {
        logger.info('WhatsApp status callback · status=' + statusCb.status + ' msgId=' + statusCb.msgId + ' matchedJobs=' + matched);
      }
    } catch (err) {
      logger.warn({ err: err && err.message }, 'whatsapp status callback update failed (pre-migration columns?)');
    }
    return modernOk(res, { received: true, status: statusCb.status });
  }

  const inbound = normaliseInbound(req.body);
  if (!inbound) {
    /*
     * Not a customer message we can act on (status callback, unparseable, …).
     *
     * LOG THE SHAPE, NOT JUST THE FACT. This used to log one bare line, which
     * made three very different failures indistinguishable from the outside:
     *   (a) Gallabox never called us at all — no log line exists
     *   (b) it called us and normaliseInbound could not find the fields
     *   (c) the secret was wrong — that one at least says so
     * The header of this file admits the inbound envelope was never confirmed
     * against a real Gallabox payload, so (b) is a live possibility every time a
     * customer taps a button and nothing happens. Logging the KEY PATHS turns
     * the next tap into the answer.
     *
     * Keys only — never values. An inbound WhatsApp body carries the customer's
     * phone number and message text, and this log line is not the place for it.
     */
    logger.warn({ bodyShape: shapeOf(req.body) },
      'WhatsApp inbound · UNPARSEABLE — normaliseInbound found no actionable fields. '
      + 'Compare the key paths above with normaliseInbound() and widen the probes.');
    return modernOk(res, { received: true, handled: false });
  }

  logger.info('WhatsApp inbound · type=' + inbound.type
    + ' messageId=' + (inbound.messageId || 'n/a')
    // The button payload IS the routing key for the template quick replies, and
    // a mismatch here is the difference between the reschedule branch and
    // nothing at all. It is not PII — it is one of three fixed constants.
    + (inbound.buttonId ? ' buttonId="' + String(inbound.buttonId).slice(0, 60) + '"' : ''));

  /*
   * `type=unknown` means we found a SENDER but no content — the message came
   * from a real customer and normaliseInbound could not tell what they said.
   * That is a probe gap, and it is invisible today: the shape is logged only on
   * the fully-unparseable path, so the one case that could tell us where the
   * text actually lives is the one case that never prints it.
   *
   * Keys only, same helper and same rule as below: an inbound body carries the
   * customer's number and their words, and neither belongs in a log line.
   */
  if (inbound.type === 'unknown') {
    logger.warn({ bodyShape: shapeOf(req.body) },
      'WhatsApp inbound · CONTENT NOT FOUND — a real sender, but no text, button, '
      + 'location or media at any probed path. The key paths above are where their '
      + 'reply actually is; widen normaliseInbound() to match.');
  }
  try {
    const result = await convo.handleInbound(inbound, pool);
    const handled = result && result.handled;
    /*
     * NOT-HANDLED is a WARN with the reason. `handled:false` means the customer
     * tapped or typed something and we did nothing — no_active_conversation,
     * expired, duplicate, or an unmatched payload. At INFO it read the same as
     * success and told you nothing about which.
     */
    if (handled) {
      logger.info('WhatsApp inbound handled · type=' + inbound.type);
    } else {
      /*
       * `never_started` is the ONE drop reason that means we could not find the
       * customer, rather than a decision we took about them: its query carries
       * no status filter, so it fires only when NO row exists for that number.
       * Every other reason (expired, completed, closed) is a real state.
       *
       * So that case — and only that case — prints what it looked the number up
       * WITH. The masked form shows the prefix and the LENGTH, which is the
       * whole diagnostic: a 10/12-digit `9310••••••••` is a phone that simply
       * did not match a row, while a 24-character `6847••••••••••••••` is a
       * Gallabox contact id that could never have matched anything. Diagnosing
       * that distinction previously required pulling the log archive.
       *
       * The keys-only bodyShape rides along for the same reason it exists on the
       * CONTENT NOT FOUND branch: if the number we resolved is wrong, the next
       * question is always "then where is the right one".
       */
      const detail = result && result.detail;
      const base = 'WhatsApp inbound NOT handled · type=' + inbound.type
        + ' reason=' + ((result && result.reason) || 'unknown')
        + (inbound.buttonId ? ' buttonId="' + String(inbound.buttonId).slice(0, 60) + '"' : '');
      if (detail === 'never_started') {
        logger.warn({ resolvedFrom: maskMobile(inbound.from), bodyShape: shapeOf(req.body) },
          base + ' — no row for this number; the masked sender above is what we searched on');
      } else {
        logger.warn(base);
      }
    }
    return modernOk(res, { received: true, ...result });
  } catch (err) {
    logger.error({ err: err && err.message }, 'whatsapp inbound webhook failed');
    // Still 200 — we logged it; don't invite a provider retry storm.
    return modernOk(res, { received: true, handled: false, error: 'internal' });
  }
});

module.exports = router;
/*
 * Test seam, same convention as routes/webhook/plivo-conference.js. The breaker
 * is module-scoped BY DESIGN (a per-request instance would reset its window on
 * every call and bound nothing), so a test that drives refusals has to be able
 * to clear it between cases — otherwise the cases leak into each other and the
 * one that matters passes for the wrong reason.
 */
module.exports.__test = { authBreaker };
