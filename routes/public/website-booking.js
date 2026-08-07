/*
 * /api/public/website-booking — the EasyFix marketing-site QR booking surface.
 *
 * WHAT IT IS
 *   A customer scans a QR printed on product packaging, lands on the public
 *   site's /consumer-services?code=<reference_code> page, fills one form, and
 *   the booking arrives in the CRM's "Unconfirmed" bucket (tbl_job.job_status
 *   = 9) with source_type = 'website', mapped to the client whose
 *   reference_code the QR carried. Ops then confirms it like any other
 *   unconfirmed order. Nothing here schedules, assigns, or dispatches.
 *
 *   Three endpoints:
 *     GET  /context                  — what the form needs to render itself
 *                                      (client display name, service categories,
 *                                      time slots, job types, photo limits)
 *     GET  /serviceability?pincode=  — ADVISORY "do we cover this pincode?".
 *                                      Read-only, never blocks a booking.
 *     POST /                         — creates the status-9 job, optionally with
 *                                      up to FIVE customer photos of the problem,
 *                                      a GPS fix, and the customer's finer
 *                                      preferred time window.
 *
 * ─── SECURITY MODEL ──────────────────────────────────────────────────────
 *
 *   (a) UNAUTHENTICATED BY DESIGN — and it is the ONLY sub-router under
 *       /api/public that both writes a row AND verifies no token of any kind.
 *       Every sibling here (job-completion, shared-job, easyfixer-profile-
 *       update, email-verify, plivo-answer) is gated on a signed JWT that
 *       pins it to one job / one technician. This one cannot be: the customer
 *       has never interacted with EasyFix before they scan the QR, so there is
 *       no identity to mint a token against. The QR `code` is a CLIENT
 *       reference, not a credential — it is printed on retail packaging and
 *       must be assumed public. It is never treated as authorisation, only as
 *       a lookup key.
 *
 *   (b) LEAST PRIVILEGE — the router can only ever produce a status-9
 *       (Unconfirmed) job. `initial_status: 9` is hard-coded, not read from
 *       the body, and job.service.create()'s own `effectiveStatus` gate
 *       (services/job.service.js) honours only 7 and 9 and coerces anything
 *       else to 0 — so even a future edit that let a caller pick a status
 *       could not reach SCHEDULED / IN_PROGRESS / COMPLETED through here.
 *       There is no update, no status transition, no assignment, and no way
 *       to address an EXISTING job: the only SQL identifiers a caller
 *       influences are a client lookup by reference_code and a pincode
 *       lookup by value. The two GETs (/context, /serviceability) are
 *       advisory catalogue reads that expose no job, customer or client id.
 *       The file writes (`photos`) are inline on the POST and can only ever
 *       attach to the job that same request creates. A status-9 job is inert
 *       until a human in the CRM confirms it, which is what keeps the blast
 *       radius of abuse at "ops has junk rows to reject", never "a
 *       technician was dispatched".
 *
 *   (c) SELF-LIMITING — two defences, because there is no credential to
 *       throttle on:
 *         · Per-IP rate limits (middleware/rate-limit): generous on the
 *           read-only /context and /serviceability lookups, strict on the
 *           write. The write limit also caps the Google Geocoding spend the
 *           pincode fallback can trigger (see resolveCityId below) AND the
 *           volume of customer photos one IP can push into S3.
 *         · A honeypot field (`website`). Real browsers leave it empty
 *           because the form hides it; naive bots fill every input they find.
 *           A filled honeypot gets a 200 that looks exactly like success and
 *           creates NOTHING — never tell a bot why it failed, or it adapts.
 *
 *   (d) NO CLIENT ID EVER LEAVES THIS FILE. GET /context returns the client's
 *       DISPLAY NAME and the echoed reference_code only. `client_id` is an
 *       internal key that appears in scoping predicates across the whole
 *       platform; publishing it on an unauthenticated endpoint would hand an
 *       attacker a valid id to try elsewhere. The POST resolves the id
 *       server-side from the same code and never reflects it back either.
 *
 *   (e) NEVER LOSE A BOOKING ON CLIENT RESOLUTION (2026-08-07, product call).
 *       This used to fail CLOSED — an unmatched code meant a 503 and a
 *       discarded lead. The business owner reversed that: a captured lead ops
 *       can re-map is worth more than a rejected one. The rule is exactly two
 *       branches:
 *         1. `code` matches an ACTIVE tbl_client.reference_code → that client
 *         2. else client 1 (RETAIL) — the hard-coded catch-all
 *       There is no 503 branch left, and (2026-08-07, second pass) no env
 *       override either: a WEBSITE_BOOKING_CLIENT_ID third branch was deleted
 *       as redundant. It only ever moved the catch-all from one client to
 *       another, which is the same manual re-mapping decision ops already make
 *       in the CRM — but with an invisible, deploy-time input that made the
 *       resolved client depend on container config rather than on the row in
 *       tbl_client. DO NOT REINTRODUCE IT. If code-less leads should pool
 *       somewhere other than RETAIL, change FALLBACK_CLIENT_ID below (a one-
 *       line, reviewable, greppable edit) rather than adding an env var back.
 *       Every resolution logs which branch it took + the resolved id (see
 *       resolveClientId) so ops can find the fallback rows and re-map them to
 *       the real client from the CRM. Misattribution is handled by ops
 *       re-mapping, not by dropping the customer's request.
 *
 *   (f) Parameterised SQL only; the sole query here binds `reference_code`.
 *       The customer's mobile is masked (utils/mask-mobile) in every log line
 *       this file writes — the number is PII and these logs ship to
 *       CloudWatch.
 *
 * All responses use the modern `{success, data, error}` envelope
 * (utils/response), matching every other /api/public sub-router.
 */

const router = require('express').Router();
const Joi = require('joi');

const { pool } = require('../../db');
const logger = require('../../logger');
const jobService = require('../../services/job.service');
const lookupService = require('../../services/lookup.service');
const pincodeService = require('../../services/pincode.service');
const { modernOk, modernError } = require('../../utils/response');
const { maskMobile } = require('../../utils/mask-mobile');
const s3Storage = require('../../utils/s3-storage');
const fileStorage = require('../../utils/file-storage');
const validate = require('../../middleware/validate');
const { rateLimit } = require('../../middleware/rate-limit');
const {
  BAND_MORNING,
  BAND_AFTERNOON,
  BAND_EVENING,
} = require('../../services/time-slot');

// ─── Constants ───────────────────────────────────────────────────────
/*
 * The three bands the PUBLIC form offers. Deliberately imported from
 * services/time-slot.js rather than re-typed: that module owns the exact
 * spelling of tbl_job.time_slot's four canonical bands and warns against
 * "tidying" them. 'After Hours' is intentionally NOT offered to walk-up
 * website customers — an after-hours visit is an ops decision, not something
 * an unauthenticated form may promise.
 */
const PUBLIC_TIME_SLOTS = Object.freeze([BAND_MORNING, BAND_AFTERNOON, BAND_EVENING]);

/*
 * Band → the IST clock hour a visit in that band STARTS at. Per
 * services/time-slot.js, tbl_job.time_slot is DERIVED from the appointment
 * instant (resolveTimeSlot: "the appointment INSTANT wins"), so the hour we
 * store has to fall inside the band we intend or the stored label silently
 * flips to a different band. 9 → morning [9,12), 12 → afternoon [12,15),
 * 15 → evening [15,19). Do not change these without re-reading bandForHour().
 */
const SLOT_START_HOUR = Object.freeze({
  [BAND_MORNING]: 9,
  [BAND_AFTERNOON]: 12,
  [BAND_EVENING]: 15,
});

/* The job types the public form may book. Mirrors the CRM's own vocabulary. */
const PUBLIC_JOB_TYPES = Object.freeze(['Installation', 'Repair', 'UnInstallation']);

/*
 * tbl_job.source_type for everything this router creates. EXACT STRING —
 * CRM filters, the Source column and downstream reports match on it verbatim.
 *
 * LOWERCASE 'website' ON PURPOSE (2026-08-07, business-owner call). This is the
 * value the LEGACY marketing site already writes, so the new QR booking flow
 * lands in the same reporting bucket as the old one and the website funnel
 * stays continuous across the cutover instead of splitting across two labels.
 * Verified against prod before switching: tbl_job holds 6,050 rows at
 * source_type = 'website' (most recent 2026-04-29) and ZERO at the previous
 * 'Easyfix Website' — so nothing is stranded by the rename and no backfill is
 * needed. (The originally-quoted "~481 rows" did not match any label in the
 * table; the real 'website' count is 6,050. Separately, 'Website Bot' (229
 * rows, last written 2026-01-09) is a DIFFERENT legacy surface — do not merge
 * it into this one.)
 *
 * ⚠ TRADE-OFF, ACCEPTED: sharing the label means source_type alone no longer
 * distinguishes a QR booking from a legacy-site booking. Use the
 * `Website booking client resolved · branch=…` log lines, or the status-9
 * Unconfirmed bucket, to isolate this router's rows when that matters.
 *
 * Case matters — 'Website' or 'WEBSITE' would create a THIRD bucket on a
 * case-sensitive report. Keep it lowercase.
 */
const SOURCE_TYPE = 'website';

/* Unconfirmed. Hard-coded — see the least-privilege note in the header. */
const INITIAL_STATUS = jobService.STATUS.UNCONFIRMED; // 9

/*
 * Last-resort client for a booking that carries no code, or a code we cannot
 * match to an ACTIVE client. tbl_client.client_id 1 is RETAIL — the generic
 * walk-up bucket ops already triage by hand.
 *
 * Deliberately a CONSTANT and the ONLY fallback. There is no env override —
 * WEBSITE_BOOKING_CLIENT_ID was deleted on 2026-08-07 as a redundant third
 * branch (see (e) in the header). To pool code-less leads under a different
 * client, change THIS LINE: it is greppable, reviewable in a diff, and cannot
 * differ between two containers running the same image.
 */
const FALLBACK_CLIENT_ID = 1; // RETAIL

// ─── Customer photos ─────────────────────────────────────────────────
/*
 * The optional "photos of the problem" — up to MAX_PHOTOS of them.
 *
 * WIRE SHAPE — an ARRAY of base64 DATA URL STRINGS on the POST body:
 *
 *   { ..., "photos": ["data:image/jpeg;base64,/9j/4AAQSkZJRg...", "data:..."] }
 *
 * i.e. exactly what the browser's FileReader.readAsDataURL() produces per file,
 * passed through verbatim. NOT objects, NOT multipart, NOT bare base64 without
 * the `data:` prefix — the prefix carries the declared MIME we cross-check
 * against the decoded bytes.
 *
 * LEGACY SINGULAR `photo` IS STILL ACCEPTED. The original contract was one
 * string on `photo`; anything already integrated against it keeps working. A
 * `photo` string is normalised to a 1-element array (see collectPhotos) and
 * then travels the identical path. If BOTH are sent, `photos` wins and `photo`
 * is ignored — `photos` is the deliberate choice of a caller that knows about
 * the new field, so it cannot be the accidental one.
 *
 * ⚠ BODY-SIZE CEILING — THE HARD LIMIT IS server.js's GLOBAL 25 MB, AND IT
 * CANNOT BE OVERRIDDEN FROM HERE. This was TESTED, not assumed:
 *
 *   server.js mounts `express.json({ limit: '25mb' })` at the APP level, before
 *   the /api/public mount further down the same file. body-parser sets
 *   `req._body` once it has parsed, and every later express.json() instance
 *   short-circuits on that flag — so a router-level `express.json({...})`
 *   mounted here NEVER RUNS. Worse, the global parser reaches its limit first
 *   and throws `entity.too.large` (HTTP 413) before any handler in this file is
 *   reached. Reproduced against exactly this mount order: the inner parser sees
 *   `req._body` already true, and an over-limit body returns HTTP 413, type
 *   `entity.too.large`, with the router-level middleware never invoked. A
 *   router-level override is therefore dead code that LOOKS load-bearing, and
 *   is deliberately NOT shipped.
 *
 *   The consequence is that MAX_TOTAL_PHOTO_BYTES must be small enough that a
 *   payload we would ACCEPT always fits in 25 MB of JSON — otherwise a valid
 *   booking dies at body-parser with an opaque 413 instead of our own message.
 *   See MAX_TOTAL_PHOTO_BYTES for the arithmetic. The global limit was raised
 *   from 10 MB to 25 MB on 2026-08-07 SPECIFICALLY so this router could carry
 *   the 12 MB combined photo budget the product wanted; that is a whole-API
 *   decision (every route now buffers up to 25 MB) and the trade-off is
 *   documented at the `express.json` line in server.js. Raising
 *   MAX_TOTAL_PHOTO_BYTES or MAX_PHOTOS again means re-doing that arithmetic
 *   and, if it no longer fits, raising the global limit again — do not raise
 *   one without the other.
 */
const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5 MB DECODED, PER PHOTO

/* How many photos one booking may carry. Published on /context as maxPhotos. */
const MAX_PHOTOS = 5;

/*
 * COMBINED decoded ceiling across all photos in one request.
 *
 * 12 MB — the value originally specced, restored on 2026-08-07 once the global
 * JSON limit in server.js went from 10 MB to 25 MB. (It sat at 7 MB while the
 * wire limit was 10 MB; that interim number is gone, do not reinstate it.)
 *
 * Still NOT 5 × MAX_PHOTO_BYTES (25 MB): that is the wire limit exactly, with
 * zero room for the base64 expansion, so it could not fit by construction. The
 * budget works backwards from the 25 MB limit:
 *
 *   12 MB decoded                                 = 12,582,912 bytes
 *   × 4/3 (base64 emits 4 chars per 3 bytes)      = 16,777,216 chars
 *   + the five ~24-char `data:image/jpeg;base64,` prefixes,
 *     the JSON array syntax, and the non-photo fields
 *     (address 2000 + description 5000 + name/email/…)  ≈    16,384
 *   = worst-case legal body                       ≈ 16,793,600 chars
 *   vs the 25 MB body limit                       = 26,214,400 chars
 *
 * ~9 MB of headroom at the worst legal payload. So every request this router
 * ACCEPTS is guaranteed to survive body-parser, and the only requests that hit
 * a 413 are ones our own 400 would have rejected anyway.
 */
const MAX_TOTAL_PHOTO_BYTES = 12 * 1024 * 1024; // 12 MB DECODED, ALL PHOTOS

/*
 * The only three types accepted, both as the DECLARED data-URL MIME and as the
 * DECODED magic bytes. No GIF (animation is pointless for a fault photo) and
 * absolutely no SVG — an SVG is a script container and this image is rendered
 * in the CRM via <img> for ops review, so it would be a stored-XSS vector from
 * an unauthenticated surface.
 */
const ACCEPTED_PHOTO_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);

/*
 * Validator-layer gate on the data URL: allowlisted MIME + a strict base64
 * alphabet. Anchored at both ends, and the character class excludes `=` so the
 * padding group can't backtrack — no catastrophic-regex risk on a multi-MB
 * string.
 */
const PHOTO_DATA_URL_RE = /^data:(image\/jpeg|image\/png|image\/webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/*
 * Encoded ceiling that caps the DECODED image at MAX_PHOTO_BYTES. base64 emits
 * 4 characters per 3 bytes; +64 is slack for the `data:<mime>;base64,` prefix
 * (23 chars at most) and padding. This is a CHEAP PRE-FILTER so a 50 MB string
 * is rejected by Joi without ever being decoded — the authoritative check is
 * the decoded buffer length in decodePhoto().
 */
const MAX_PHOTO_DATA_URL_CHARS = Math.ceil(MAX_PHOTO_BYTES / 3) * 4 + 64;

/*
 * Magic-byte signatures, checked against the DECODED buffer. The declared MIME
 * in the data URL is attacker-controlled text and is never trusted on its own —
 * a `data:image/png;base64,` header wrapped around an HTML or SVG payload would
 * otherwise sail through the regex above and land in S3 as an "image".
 *
 *   JPEG  FF D8 FF
 *   PNG   89 50 4E 47            ("\x89PNG")
 *   WEBP  52 49 46 46 …. 57 45 42 50   (RIFF <4-byte size> WEBP)
 */
function sniffPhotoMime(buf) {
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/* File extension for the storage layer, derived from the SNIFFED type. */
const PHOTO_EXT = Object.freeze({
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
});

// ─── Customer GPS ────────────────────────────────────────────────────
/*
 * The optional "use my current location" fix from the website form.
 *
 * SHAPE: "<lat>,<lng>" — the SAME regex `gpsPair` uses in
 * validators/job.validator.js, which is what tbl_address.gps_location holds
 * across every other booking surface. It is COPIED rather than imported
 * because job.validator.js does not export `gpsPair` (only the composed
 * schemas: listQuery, createBody, updateBody, …). If it is ever exported,
 * import it and delete this constant — two spellings of "what a GPS pair is"
 * is exactly the drift this router already avoids for mobile and pincode.
 */
const GPS_PAIR_RE = /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/;

/*
 * India-ish bounding box. Mainland + islands, generously padded:
 *   lat  6 – 38   (Indira Point ~6.7°N  →  Siachen ~37.1°N)
 *   lng 68 – 98   (Guhar Moti ~68.1°E   →  Kibithu ~97.4°E)
 *
 * A fix outside this box is not a customer in India — it is a browser
 * geolocation failure, a desktop IP-based guess landing on a datacentre, a
 * default (0,0), or a swapped lat/lng. Storing it would put a technician's map
 * pin in the Gulf of Guinea.
 *
 * ⚠ OUT-OF-BOUNDS IS DROPPED, NEVER A 400. The GPS fix is a CONVENIENCE on top
 * of an address the customer has already typed in full — the booking is
 * complete and dispatchable without it. Rejecting the submission would cost a
 * real lead because a browser returned a bad number the customer never saw and
 * cannot correct. So we log it (so a systematically broken FE geolocation call
 * is visible in the logs) and carry on with gps_location NULL.
 */
const GPS_BOUNDS = Object.freeze({ minLat: 6, maxLat: 38, minLng: 68, maxLng: 98 });

// ─── Helpers ─────────────────────────────────────────────────────────
/*
 * The caller's IP as seen past the proxy. Honours the FIRST hop of
 * x-forwarded-for (the original client; later hops are the proxies) and falls
 * back to req.ip. Used ONLY as a rate-limit bucket key — never as an
 * authorisation input — so a spoofed header costs the spoofer their own
 * bucket and nothing more.
 */
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim() !== '') {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  return req.ip || 'unknown';
}

/*
 * Today's date in IST as 'YYYY-MM-DD'. Reuses job.service's exported
 * formatMysqlDateTimeIST — the ONE correct +05:30 projection in this repo
 * (server-TZ independent; our containers run UTC) — rather than adding a
 * date library or hand-rolling a second offset calculation.
 */
function todayIST() {
  return jobService.formatMysqlDateTimeIST(new Date()).slice(0, 10);
}

/*
 * Look up an ACTIVE client by the reference_code the QR carried.
 * Returns { client_id, client_name, reference_code } or null.
 * client_id stays inside this module — see (d) in the header.
 */
async function findClientByCode(code) {
  const clean = String(code || '').trim();
  if (!clean) return null;
  const [[row]] = await pool.query(
    `SELECT client_id, client_name, reference_code
       FROM tbl_client
      WHERE reference_code = ? AND client_status = 1
      LIMIT 1`,
    [clean],
  );
  return row || null;
}

/* Throwable 400 in the `{status, message}` shape the catch blocks below map. */
function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

/*
 * Sanity-bound the optional GPS fix. Returns the pair verbatim when it lands
 * inside India, or null when it does not (or none was sent).
 *
 * Shape is already guaranteed by GPS_PAIR_RE at the Joi layer, so this only has
 * to decide whether the NUMBERS are plausible. Deliberately returns null rather
 * than throwing — see GPS_BOUNDS: a bad reading must never cost us a booking.
 * The caller logs the rejection.
 */
function sanitiseGps(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const [lat, lng] = value.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < GPS_BOUNDS.minLat || lat > GPS_BOUNDS.maxLat) return null;
  if (lng < GPS_BOUNDS.minLng || lng > GPS_BOUNDS.maxLng) return null;
  return value;
}

/*
 * Resolve tbl_address.city_id from a 6-digit pincode.
 *
 * Cheap path first: getPincodeByValue() is a pure DB read and covers every
 * pincode already on tbl_pincode (the overwhelming majority).
 *
 * ⚠ COST + ABUSE NOTE: the fallback, ensurePincode(), can call the GOOGLE
 * GEOCODING API and, on success, CREATE tbl_pincode / tbl_city / tbl_state
 * rows. That is a paid, rate-limited third-party call reachable from an
 * unauthenticated endpoint — which is precisely why the POST below carries a
 * strict per-IP limit. Do not loosen that limit without re-reading this.
 *
 * ensurePincode throws a 400 for a non-Indian / ungeocodable pincode; we let
 * that surface to the customer verbatim (it names the offending pincode and
 * is safe to show — it leaks nothing about our data).
 */
async function resolveCityId(pincode) {
  const existing = await pincodeService.getPincodeByValue(pincode);
  if (existing && existing.city_id) return Number(existing.city_id);

  // Not on file — geocode + create. userId null: there is no authenticated
  // actor on a public booking, and the pincode service tolerates that.
  const ensured = await pincodeService.ensurePincode(pincode, { userId: null });
  if (!ensured || !ensured.city_id) {
    throw badRequest(`Could not resolve a city for pincode ${pincode}`);
  }
  return Number(ensured.city_id);
}

/*
 * Resolve the tbl_client.client_id this booking belongs to. NEVER FAILS —
 * see (e) in the header. Exactly TWO branches:
 *
 *   'code'          — `code` matched an ACTIVE tbl_client.reference_code.
 *   'default-retail'— it didn't; fall back to client 1 (RETAIL).
 *
 * The WEBSITE_BOOKING_CLIENT_ID env branch that used to sit between these was
 * removed on 2026-08-07: "client 1 unless the reference code matches" is the
 * whole rule, and a third branch only added a deploy-time input nobody could
 * see from the code. Don't add it back — change FALLBACK_CLIENT_ID instead.
 *
 * Returns { clientId, branch }. The branch label exists to be LOGGED — it is
 * how ops finds the bookings whose client is still a placeholder and re-maps
 * them in the CRM. It is never returned to the caller (see (d) in the header:
 * no client id, and no hint of our client list, leaves this file).
 */
async function resolveClientId(code) {
  const client = await findClientByCode(code);
  if (client) {
    return { clientId: Number(client.client_id), branch: 'code' };
  }
  return { clientId: FALLBACK_CLIENT_ID, branch: 'default-retail' };
}

/*
 * Normalise the two accepted wire shapes into ONE array of data-URL strings.
 *
 * `photos` (array, current contract) wins when present and non-empty; `photo`
 * (string, legacy contract) is promoted to a 1-element array otherwise. Blank
 * entries are dropped so a form that always sends `photos: ['']` for "no photo"
 * is treated as no photo rather than as a malformed one.
 */
function collectPhotos(body) {
  const list = Array.isArray(body.photos) ? body.photos : [];
  const raw = list.length ? list : (body.photo ? [body.photo] : []);
  return raw.map((p) => String(p || '').trim()).filter((p) => p !== '');
}

/*
 * Decode + hard-validate every supplied photo data URL.
 *
 * Returns an ARRAY of { buffer, mime, ext } — empty when no photo was sent.
 * THROWS a 400 (badRequest) when a photo WAS sent but is not a genuine image of
 * an accepted type — a spoofed payload is a caller error we refuse loudly, not
 * something to silently swallow. One bad photo fails the whole request: it is a
 * caller bug, and silently dropping it would leave the customer believing they
 * attached something they did not. (Contrast with the STORAGE failure below,
 * which IS non-fatal and per-photo.)
 *
 * The offending INDEX is named in every message so a customer with five files
 * knows which one to replace.
 *
 * Three independent gates, because the declared type is attacker-controlled:
 *   1. the data-URL MIME must be on ACCEPTED_PHOTO_TYPES (already enforced by
 *      PHOTO_DATA_URL_RE at the Joi layer; re-asserted here so this function is
 *      safe on its own terms),
 *   2. the DECODED bytes must carry that exact type's magic number
 *      (sniffPhotoMime). A mismatch — `data:image/png` wrapping a JPEG, an
 *      SVG, a ZIP, anything — is rejected, and
 *   3. the running COMBINED decoded total must stay under
 *      MAX_TOTAL_PHOTO_BYTES.
 *
 * ⚠ NOTE the combined check is enforced HERE and not at the Joi layer: Joi sees
 * base64 character counts, and the authoritative number is decoded bytes. The
 * cheap encoded-character pre-sum below rejects an obviously-oversized batch
 * before we allocate a single Buffer, mirroring how MAX_PHOTO_DATA_URL_CHARS
 * pre-filters an individual photo.
 */
function decodePhotos(rawList) {
  if (!rawList.length) return [];

  const totalMb = Math.round(MAX_TOTAL_PHOTO_BYTES / (1024 * 1024));
  // Cheap pre-filter: encoded chars × 3/4 is a close upper bound on decoded
  // bytes, so an over-budget batch is refused before anything is decoded.
  const encodedChars = rawList.reduce((sum, s) => sum + s.length, 0);
  if ((encodedChars / 4) * 3 > MAX_TOTAL_PHOTO_BYTES) {
    throw badRequest(`Photos exceed the combined ${totalMb}MB limit`);
  }

  const out = [];
  let totalBytes = 0;

  for (let i = 0; i < rawList.length; i += 1) {
    const label = `Photo ${i + 1}`;
    const parts = /^data:([^;,]+);base64,([\s\S]*)$/.exec(rawList[i]);
    const declared = parts ? parts[1] : '';
    if (!parts || !ACCEPTED_PHOTO_TYPES.includes(declared)) {
      throw badRequest(`${label} must be one of ${ACCEPTED_PHOTO_TYPES.join(', ')}`);
    }

    const buffer = Buffer.from(parts[2], 'base64');
    if (!buffer.length) throw badRequest(`${label} could not be decoded`);
    // Authoritative per-photo size check — the Joi `.max()` was only a pre-filter.
    if (buffer.length > MAX_PHOTO_BYTES) {
      throw badRequest(`${label} exceeds the ${Math.round(MAX_PHOTO_BYTES / (1024 * 1024))}MB limit`);
    }

    totalBytes += buffer.length;
    if (totalBytes > MAX_TOTAL_PHOTO_BYTES) {
      throw badRequest(`Photos exceed the combined ${totalMb}MB limit`);
    }

    const sniffed = sniffPhotoMime(buffer);
    if (!sniffed || sniffed !== declared) {
      throw badRequest(
        `${label} content does not match its declared type (${declared})`,
      );
    }
    out.push({ buffer, mime: sniffed, ext: PHOTO_EXT[sniffed] });
  }
  return out;
}

/*
 * Persist the decoded photo and return the value to store on
 * tbl_job_image.image (via jobService.create's `job_image_filename`).
 *
 * NON-FATAL BY CONTRACT: returns null on ANY storage failure after logging a
 * warn. A customer must never lose a booking because an image write failed —
 * the lead is the valuable thing, the photo is a nice-to-have ops can chase by
 * phone. The caller creates the job either way.
 *
 * No new storage path is invented. Both branches are the EXISTING job-image
 * utilities, in the priority s3-storage.js itself documents:
 *   · S3 when S3_BUCKET_NAME is set (this deploy) — s3Storage.putAtKey, the
 *     same helper the Deep Skill preview uses to stage an object BEFORE its DB
 *     row exists, which is exactly our situation: the canonical
 *     `JobSupportings/Booking_<jobId>_<seq>` key needs a jobId we do not have
 *     until create() commits. We stay under the SAME `JobSupportings/` prefix
 *     (lifecycle/audit policies target that directory) with a
 *     `WebsiteBooking_<epoch>_<rand>` discriminator, and s3-storage's
 *     resolveImageUrl() tries the stored value VERBATIM first, so the CRM
 *     renders it with no read-path change. Extension lives in Content-Type,
 *     per the key convention.
 *   · local filesystem otherwise — fileStorage.writeBuffer('job_files', …),
 *     the pre-S3 path resolveImageUrl() still falls back to for bare filenames.
 */
async function storePhoto(photo, index) {
  try {
    if (s3Storage.isEnabled()) {
      const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
      return await s3Storage.putAtKey({
        key: `JobSupportings/WebsiteBooking_${suffix}`,
        buffer: photo.buffer,
        contentType: photo.mime,
        originalName: `website-booking${photo.ext}`,
      });
    }
    const written = fileStorage.writeBuffer(
      'job_files', photo.buffer, `website-booking${photo.ext}`, photo.mime,
    );
    return written.filename;
  } catch (e) {
    logger.warn(
      { err: e && e.message, photoIndex: index + 1 },
      'Website booking photo storage failed — continuing WITHOUT this photo',
    );
    return null;
  }
}

/*
 * Store every decoded photo, PER-PHOTO NON-FATAL.
 *
 * Returns the filenames that stored successfully, in submission order. A photo
 * whose write failed is simply absent from the result — storePhoto() has
 * already warned with its index — so one S3 hiccup costs that one image, never
 * the booking and never its siblings. Sequential rather than Promise.all on
 * purpose: five parallel multi-MB S3 PUTs from an UNAUTHENTICATED endpoint is a
 * burst one IP shouldn't be able to trigger (the 8/10min submit limit caps the
 * request rate, not the fan-out of a single request).
 */
async function storePhotos(photos) {
  const filenames = [];
  for (let i = 0; i < photos.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- deliberately sequential; see above.
    const name = await storePhoto(photos[i], i);
    if (name) filenames.push(name);
  }
  return filenames;
}

/*
 * Attach photos 2..N to an already-created job.
 *
 * WHY THIS EXISTS: jobService.create() persists exactly ONE image — its
 * `job_image_filename` branch is a single INSERT (services/job.service.js). So
 * the first stored photo rides through create() inside the job's own
 * transaction, and any remainder is inserted here, immediately after.
 *
 * The column set and values MIRROR THAT BRANCH VERBATIM:
 *   INSERT INTO tbl_job_image (job_id, image, image_category, job_stage, created_date)
 *   VALUES (?, ?, 'booking', 0, NOW())
 * so photo 1 and photos 2..N are indistinguishable in the table. `status` is
 * intentionally NOT in the list even though routes/integration/v1/index.js
 * names it explicitly: tbl_job_image.status is `int NULL DEFAULT 1`, so
 * omitting it yields status = 1 anyway — which is exactly what every existing
 * `image_category = 'booking'` row in prod carries (verified 2026-08-07:
 * 30/30 rows are job_stage 0, status 1). Adding it here would make these rows
 * differ from the create() row in SQL while being identical in data. No new
 * columns are invented.
 *
 * NON-FATAL: the job is already committed. A failed attach logs a warn and the
 * booking stands — same contract as storePhoto. Never throw from here.
 */
async function attachExtraPhotos(jobId, filenames) {
  let attached = 0;
  for (const filename of filenames) {
    try {
      // eslint-disable-next-line no-await-in-loop -- one row per photo, max 4.
      await pool.query(
        `INSERT INTO tbl_job_image (job_id, image, image_category, job_stage, created_date)
         VALUES (?, ?, ?, ?, NOW())`,
        [jobId, filename, 'booking', 0],
      );
      attached += 1;
    } catch (e) {
      logger.warn(
        { err: e && e.message, jobId },
        'Website booking extra photo row failed — booking kept, image dropped',
      );
    }
  }
  return attached;
}

/*
 * Map a thrown error onto the response. Anything carrying a numeric `.status`
 * (badRequest above, pincode.service's badReq, job.service's own 400s) becomes
 * a modernError with that status; everything else is an unexpected server
 * fault and goes to the global error handler via next(). Same contract as
 * routes/public/job-completion.js's mapKnownError.
 */
function mapKnownError(res, next, e) {
  if (e && typeof e.status === 'number') {
    return modernError(res, e.status, e.message || 'request failed');
  }
  return next(e);
}

// ─── Validators ──────────────────────────────────────────────────────
/*
 * Field constraints mirror validators/job.validator.js's customerBlock /
 * addressBlock / createBody (same mobile + pincode regexes, same max lengths)
 * so a payload that passes here cannot be rejected deeper in the stack. They
 * are re-declared rather than imported because this router accepts a FLAT,
 * website-shaped body — not the CRM's nested customer/address blocks — and
 * because job.validator.js must not grow a public-form dialect.
 */
const contextQuery = Joi.object({
  code: Joi.string().max(50).allow('', null).optional(),
});

/*
 * /serviceability takes exactly one required 6-digit pincode. Same regex as
 * bookingBody.pincode so the two surfaces can never disagree about what a
 * pincode is. Anything else is a 400 from the validate() middleware.
 */
const serviceabilityQuery = Joi.object({
  pincode: Joi.string()
    .pattern(/^[0-9]{6}$/)
    .required()
    .messages({ 'string.pattern.base': 'Pincode must be exactly 6 digits' }),
});

/*
 * ONE photo data URL. Declared once and reused by BOTH `photos[]` (current
 * contract) and the legacy singular `photo`, so the two shapes can never drift
 * apart on what an acceptable photo is. See the `photos` field below for why
 * the custom messages are mandatory here.
 */
const photoDataUrl = Joi.string()
  .max(MAX_PHOTO_DATA_URL_CHARS)
  .pattern(PHOTO_DATA_URL_RE)
  .allow('', null)
  .optional()
  .messages({
    'string.max': `Each photo must be under ${Math.round(MAX_PHOTO_BYTES / (1024 * 1024))}MB`,
    'string.pattern.base':
      `Photo must be a base64 data URL of type ${ACCEPTED_PHOTO_TYPES.join(', ')}`,
  });

const bookingBody = Joi.object({
  code: Joi.string().max(50).allow('', null).optional(),
  name: Joi.string().max(255).required(),
  mobile: Joi.string()
    .pattern(/^[6-9]\d{9}$/)
    .required()
    .messages({
      'string.pattern.base': 'Must be a 10-digit Indian mobile starting with 6, 7, 8, or 9',
    }),
  email: Joi.string().email().max(255).allow('', null).optional(),
  address: Joi.string().max(2000).required(),
  building: Joi.string().max(500).allow('', null).optional(),
  landmark: Joi.string().max(500).allow('', null).optional(),
  pincode: Joi.string()
    .pattern(/^[0-9]{6}$/)
    .required()
    .messages({ 'string.pattern.base': 'Pincode must be exactly 6 digits' }),
  description: Joi.string().max(5000).required(),
  jobType: Joi.string().valid(...PUBLIC_JOB_TYPES).default('Installation'),
  serviceCategoryId: Joi.number().integer().positive().optional(),
  date: Joi.string()
    .pattern(/^\d{4}-\d{2}-\d{2}$/)
    .required()
    .messages({ 'string.pattern.base': 'Date must be in YYYY-MM-DD format' }),
  timeSlot: Joi.string().valid(...PUBLIC_TIME_SLOTS).required(),
  consent: Joi.boolean().valid(true).required(),
  /*
   * OPTIONAL array of customer photos — up to MAX_PHOTOS base64 DATA URL
   * STRINGS. See the MAX_PHOTO_BYTES / MAX_TOTAL_PHOTO_BYTES block above for
   * the wire shape and the 25 MB body arithmetic.
   *
   * Per item, `.max()` is declared BEFORE `.pattern()` so an oversized string
   * is cheap to reject. Both rules carry CUSTOM messages on purpose: Joi's
   * default `string.pattern.base` text INTERPOLATES THE OFFENDING VALUE, which
   * here would splice a multi-megabyte base64 blob into the 400 response body
   * and into the validation warn log. (The middleware's own redaction only
   * covers the request sample, not the Joi message.) `array.max` gets a custom
   * message too — the default is fine, but stating the number keeps the FE's
   * copy and ours in step.
   *
   * The COMBINED size ceiling is NOT enforced here: Joi counts base64
   * characters and the authoritative unit is decoded bytes. decodePhotos()
   * owns that check.
   */
  photos: Joi.array()
    .items(photoDataUrl)
    .max(MAX_PHOTOS)
    .optional()
    .messages({ 'array.max': `At most ${MAX_PHOTOS} photos may be attached` }),
  /*
   * LEGACY SINGULAR. The original contract was one photo on `photo`; kept so
   * anything already integrated keeps working. collectPhotos() promotes it to a
   * 1-element array, after which it is indistinguishable from `photos: [x]`.
   * `photos` wins if both are sent.
   */
  photo: photoDataUrl,
  /*
   * OPTIONAL GPS fix from the website's "use my current location" button.
   * Shape-checked here (GPS_PAIR_RE — the same pair shape job.validator.js
   * uses); RANGE-checked in sanitiseGps(), which drops an implausible reading
   * silently rather than 400ing. Custom message so a malformed pair doesn't
   * echo the raw value back.
   */
  gps: Joi.string()
    .pattern(GPS_PAIR_RE)
    .allow('', null)
    .optional()
    .messages({ 'string.pattern.base': 'GPS must be "<latitude>,<longitude>"' }),
  /*
   * OPTIONAL finer time preference, e.g. "08:00-10:00". The website offers SIX
   * 2-hour windows and maps each onto one of the three canonical bands before
   * sending `timeSlot`; this preserves what the customer actually picked.
   *
   * FREE TEXT ON PURPOSE — deliberately NOT `.valid(...)` against a fixed list
   * of six windows. It never influences scheduling (see the POST handler), so
   * an unrecognised value is harmless, whereas hard-coding the list here would
   * mean a 400 for every customer the moment marketing adds a seventh window.
   * Capped at 40 chars so it cannot be used as free storage in `remarks`.
   */
  preferredWindow: Joi.string().max(40).allow('', null).optional(),
  /*
   * HONEYPOT. Hidden in the form's CSS, so a human never fills it. Declared
   * here (rather than dropped by stripUnknown) precisely so the handler can
   * SEE it and silently discard the submission.
   */
  website: Joi.string().allow('', null).optional(),
});

// ─── Rate limiters ───────────────────────────────────────────────────
/*
 * /context is a read-only lookup the landing page calls on every page load
 * (and again on a code change), so its budget is generous — 60 / 10 min per
 * IP. Note a shared corporate NAT or a mobile carrier CGNAT presents ONE IP
 * for many genuine customers; this ceiling is set so ordinary browsing under
 * a shared egress IP never trips it.
 */
const contextRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  key: (req) => `wb-ctx:${clientIp(req)}`,
});

/*
 * /serviceability is the same kind of traffic as /context — a read-only lookup
 * the form fires as the customer types their pincode — so it gets the same
 * generous 60 / 10 min per IP budget, on its OWN bucket prefix so a chatty
 * pincode field can never exhaust the /context allowance (or vice versa).
 * Unlike the POST, this endpoint can trigger NO third-party spend at all: it
 * never calls ensurePincode, so there is no Google Geocoding cost to cap here.
 */
const serviceabilityRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  key: (req) => `wb-serv:${clientIp(req)}`,
});

/*
 * The write. 8 submissions / 10 min per IP — a real customer submits once,
 * twice if they fat-finger something. This is also the ceiling on how often
 * one IP can push us into a paid Google Geocoding call via the unknown-
 * pincode path in resolveCityId(), AND — since CHANGE 3 — the ceiling on how
 * many customer photos one IP can write into S3. Deliberately left at 8: it is
 * now doing double duty as the abuse cap on image storage, so LOOSENING IT
 * COSTS BOTH GEOCODING SPEND AND STORAGE. Distinct bucket prefix so read
 * traffic and write traffic never share a budget.
 */
const submitRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 8,
  key: (req) => `wb-post:${clientIp(req)}`,
});

// ─── GET /api/public/website-booking/context ──────────────────────────
/*
 * Everything the public booking form needs to render itself:
 *   { client: { name, code } | null, serviceCategories[], timeSlots[], jobTypes[] }
 *
 * An unknown or absent `code` yields client:null with HTTP 200 — NOT an
 * error. The page must still render a generic booking form for a customer who
 * reached it without a QR, and a 404 here would also turn the endpoint into a
 * reference_code ORACLE (probe codes, read the status, enumerate our client
 * list). Same 200 either way; only the `client` field differs.
 */
router.get('/context', contextRateLimit, validate(contextQuery, 'query'), async (req, res, next) => {
  try {
    const code = String(req.query.code || '').trim();
    const client = code ? await findClientByCode(code) : null;

    const categories = await lookupService.serviceCategories();

    logger.info(
      'Website booking context · code=' + (code || '-')
      + ' · clientMatched=' + (client ? 'yes' : 'no')
      + ' · categories=' + categories.length,
    );

    return modernOk(res, {
      // Display name + the canonical code from the DB row. NEVER client_id.
      client: client
        ? { name: client.client_name, code: client.reference_code }
        : null,
      serviceCategories: categories.map((c) => ({
        id: c.service_catg_id,
        name: c.service_catg_name,
      })),
      timeSlots: [...PUBLIC_TIME_SLOTS],
      jobTypes: [...PUBLIC_JOB_TYPES],
      /*
       * Photo constraints, published so the website can validate client-side
       * (reject / downscale before a 6 MB upload) WITHOUT hard-coding numbers
       * that would silently drift from the server's. Both byte figures are
       * DECODED ceilings — the FE checks them against File.size, not against
       * the length of the base64 string. Server-side validation is
       * unconditional and authoritative regardless of what the FE does here.
       *
       * All THREE limits must be honoured by the form or a submission 400s:
       *   maxPhotos          — how many files the picker may accept
       *   maxPhotoBytes      — per-file ceiling
       *   maxTotalPhotoBytes — SUM across the selection. This is the one a
       *                        naive FE misses: five files each under
       *                        maxPhotoBytes can still be over budget.
       */
      maxPhotos: MAX_PHOTOS,
      maxPhotoBytes: MAX_PHOTO_BYTES,
      maxTotalPhotoBytes: MAX_TOTAL_PHOTO_BYTES,
      acceptedPhotoTypes: [...ACCEPTED_PHOTO_TYPES],
    });
  } catch (e) {
    return mapKnownError(res, next, e);
  }
});

// ─── GET /api/public/website-booking/serviceability?pincode=NNNNNN ────
/*
 * "Do you cover my area?" — the answer the website shows BEFORE the customer
 * fills the form, so a non-serviceable pincode sets expectations up front
 * instead of surprising them after a visit is booked.
 *
 *   → { known: boolean, serviceable: boolean, cityName: string|null }
 *
 *   unknown pincode → { known:false, serviceable:false, cityName:null }
 *   known pincode   → known:true, `serviceable` from tbl_pincode.pincode_status,
 *                     `cityName` from the joined tbl_city row.
 *
 * ⚠ ADVISORY ONLY — IT MUST NEVER BLOCK A BOOKING. `known:false` or
 * `serviceable:false` is guidance for the UI's copy ("we may need to send a
 * technician from a nearby city"), NOT a gate. POST / does not consult this
 * endpoint and will happily accept a booking for a pincode this call reported
 * as unknown or non-serviceable — those become status-9 rows ops triages like
 * any other. Do NOT "tighten" this by making the POST reject on it: coverage
 * changes the moment a technician is onboarded, and the whole point of the
 * Unconfirmed bucket is that a human decides.
 *
 * ⚠ READ-ONLY BY DESIGN — getPincodeByValue() ONLY. This deliberately does NOT
 * call pincodeService.ensurePincode(), which the POST path uses: ensurePincode
 * hits the PAID Google Geocoding API and, on success, CREATES tbl_pincode /
 * tbl_city / tbl_state rows. An unauthenticated read endpoint must be able to
 * trigger NEITHER — otherwise anyone could walk 000000→999999 and both run up a
 * Google bill and stuff our geography tables with junk. A pincode we do not
 * hold is simply reported as unknown.
 *
 * SERVICEABILITY COLUMN: `tbl_pincode.pincode_status`, where 1 = Serviceable.
 * It is recomputed in bulk by pincodeService.recomputeServiceableStatus() —
 * "covered by ≥1 ACTIVE + VERIFIED technician", via the union of
 * tbl_efr_serviceable_pincodes.pincodes (CSV, FIND_IN_SET) and the tech's own
 * efr_pin_no. getPincodeById() already projects it as the boolean `is_active`,
 * so we read that rather than re-deriving it here. Defensive fallback: if the
 * projection ever stops yielding a boolean (schema drift), we degrade to
 * serviceable:true for a KNOWN pincode rather than crashing or telling a real
 * customer in a covered area that we don't serve them.
 */
router.get(
  '/serviceability',
  serviceabilityRateLimit,
  validate(serviceabilityQuery, 'query'),
  async (req, res, next) => {
    try {
      const pincode = String(req.query.pincode);
      const row = await pincodeService.getPincodeByValue(pincode);

      if (!row) {
        logger.info('Website booking serviceability · pincode=' + pincode + ' · known=no');
        return modernOk(res, { known: false, serviceable: false, cityName: null });
      }

      const serviceable = typeof row.is_active === 'boolean' ? row.is_active : true;
      logger.info(
        'Website booking serviceability · pincode=' + pincode
        + ' · known=yes · serviceable=' + serviceable
        + ' · city=' + (row.city_name || '-'),
      );
      return modernOk(res, {
        known: true,
        serviceable,
        cityName: row.city_name || null,
      });
    } catch (e) {
      return mapKnownError(res, next, e);
    }
  },
);

// ─── POST /api/public/website-booking ─────────────────────────────────
/*
 * Creates ONE Unconfirmed (status 9) job. Returns { jobId, referenceId }.
 *
 * No services[] is sent: the services[]-required gate (routes/admin/jobs.js)
 * applies to BOOKED (status 0) creates only, and an unconfirmed website lead
 * has no priced line items yet — ops adds them at confirmation.
 *
 * Optionally carries up to MAX_PHOTOS customer photos of the problem, as base64
 * data URLs on `photos` (or the legacy singular `photo` — see MAX_PHOTO_BYTES).
 * They are validated hard — 400 on a bad type, oversize, over the combined
 * budget, or a magic-byte mismatch — but stored SOFT: a per-photo storage
 * failure logs a warn, and the booking (and the other photos) still land.
 *
 * Also optionally carries `gps` (dropped silently when implausible) and
 * `preferredWindow` (folded into remarks; never influences scheduling).
 */
router.post('/', submitRateLimit, validate(bookingBody), async (req, res, next) => {
  const b = req.body;
  try {
    /*
     * 1. HONEYPOT. A filled `website` field means a bot walked the DOM and
     *    populated every input. Return a response that is indistinguishable
     *    from success to anything not counting rows, and create nothing. No
     *    400, no "spam detected" — a bot that learns why it was rejected
     *    simply stops filling the field next time.
     */
    if (typeof b.website === 'string' && b.website.trim() !== '') {
      logger.info(
        'Website booking honeypot tripped · ip=' + clientIp(req)
        + ' · mobile=' + maskMobile(b.mobile),
      );
      return modernOk(res, { accepted: true });
    }

    /*
     * 2. Past-date guard, in IST. String comparison is safe and exact here:
     *    both sides are zero-padded 'YYYY-MM-DD', which sorts
     *    lexicographically the same as chronologically. Uses the IST wall
     *    clock, not the container's (UTC) local date — between 18:30 and
     *    24:00 UTC those are different days, and a customer booking
     *    "tomorrow" late in the IST evening must not be rejected.
     */
    const today = todayIST();
    if (b.date < today) {
      logger.warn(
        'Website booking rejected · past date · date=' + b.date + ' · todayIST=' + today
        + ' · mobile=' + maskMobile(b.mobile),
      );
      return modernError(res, 400, 'Appointment date cannot be in the past');
    }

    /*
     * 3. Resolve the client — NEVER FAILS. The QR code wins; otherwise client
     *    1 (RETAIL). The old 503 "not configured" branch is GONE, and so is
     *    the WEBSITE_BOOKING_CLIENT_ID override that briefly sat between the
     *    two (2026-08-07, see (e) in the header): a lead ops can re-map beats
     *    a lead we threw away, and a third branch only hid WHICH client that
     *    was behind an env var. The info line below is the ops handle for
     *    finding these — grep `branch=default-retail` to list every booking
     *    whose client still needs mapping in the CRM.
     */
    const { clientId, branch } = await resolveClientId(b.code);
    logger.info(
      'Website booking client resolved · branch=' + branch
      + ' · clientId=' + clientId
      + ' · code=' + (b.code ? String(b.code).trim() : '-')
      + ' · mobile=' + maskMobile(b.mobile),
    );

    /*
     * 4. Decode + hard-validate the optional photos BEFORE anything is written.
     *    A spoofed/oversized image (or an over-budget batch) is a 400 and no job
     *    is created — cheaper for everyone than creating a job and then
     *    rejecting its attachments. A STORAGE failure, by contrast, is
     *    non-fatal and per-photo (see storePhotos).
     */
    const photos = decodePhotos(collectPhotos(b));

    /*
     * 4b. Sanity-bound the optional GPS fix. Out-of-range is DROPPED, not
     *     rejected — a browser that returned a bad reading (or (0,0), or a
     *     desktop IP guess) must not cost the customer their booking, and they
     *     have already typed a full address. Logged so a systematically broken
     *     FE geolocation call is visible. See GPS_BOUNDS.
     */
    const gps = sanitiseGps(b.gps);
    if (b.gps && !gps) {
      logger.info(
        'Website booking GPS dropped · out of India bounds · value=' + String(b.gps).trim()
        + ' · mobile=' + maskMobile(b.mobile),
      );
    }

    // 5. Pincode → city_id (may geocode — see resolveCityId).
    const cityId = await resolveCityId(b.pincode);

    /*
     * 6. Appointment instant, as the IST wall clock the customer picked.
     *
     *    ⚠ READ BEFORE CHANGING. job.service.create() runs
     *    `requested_date_time` through combineDateTime(), which does
     *    `new Date(value)`. A NAIVE ISO string ('2026-08-12T09:00:00', no
     *    offset) is parsed by JS as SERVER-LOCAL time — and our containers
     *    run UTC (node:20-alpine, no TZ set) — after which
     *    formatMysqlDateTimeIST adds +05:30. A naive 09:00 therefore lands
     *    in the DB as 14:30 IST, i.e. in the '12PM to 3PM' band, not the
     *    morning band the customer chose. (Verified against the helpers in
     *    services/job.service.js; the same +05:30 double-shift is documented
     *    in services/time-slot.js's wallClockTime note.)
     *
     *    So we use the path create() explicitly supports instead: a UTC
     *    MIDNIGHT date sentinel plus the time-of-day in `requested_time`.
     *    combineDateTime detects the midnight sentinel and SPLICES the
     *    HH:MM in as IST clock time, producing '<date> 09:00:00' verbatim —
     *    identical on a UTC container and an IST laptop, with no Date-parse
     *    ambiguity anywhere in the chain. This is the same shape the CRM's
     *    Book-New-Call form sends.
     *
     *    The hour must sit inside the chosen band because resolveTimeSlot()
     *    derives tbl_job.time_slot from the INSTANT, overriding any label we
     *    pass — SLOT_START_HOUR above is what guarantees agreement.
     */
    const startHour = SLOT_START_HOUR[b.timeSlot];
    const requestedTime = String(startHour).padStart(2, '0') + ':00';
    const requestedDateSentinel = `${b.date}T00:00:00.000Z`;

    /*
     * 6b. The customer's finer time preference, folded into `remarks`.
     *
     *     jobService.create() runs `remarks` through its own composeRemarks()
     *     (services/job.service.js), whose convention for a value that has no
     *     tbl_job column of its own is a named `[Label] value` line —
     *     `[Product Code]`, `[Building / Property]`. We follow it exactly
     *     rather than inventing a second remarks dialect, so ops read the same
     *     shape here as on a Book-New-Call job and decomposeRemarks() (which
     *     only claims its own two prefixes) leaves ours untouched.
     *
     *     We cannot add a `preferred_window` key to composeRemarks itself
     *     without editing job.service.js, so the composed line is passed AS
     *     `remarks`; composeRemarks pushes it through verbatim as the first
     *     part. Same output either way.
     *
     *     ⚠ PRESENTATION ONLY. It must NOT touch `timeSlot` or
     *     `requested_time` — the canonical band computed in step 6 still
     *     governs scheduling, and resolveTimeSlot() would override a
     *     disagreeing label anyway. This is the record of what the customer
     *     ASKED for, next to what we actually booked.
     */
    const preferredWindow = String(b.preferredWindow || '').trim();
    const remarks = preferredWindow ? `[Preferred Window] ${preferredWindow}` : undefined;

    /*
     * 7. Store the photos, if any. NON-FATAL AND PER-PHOTO: storePhotos()
     *    swallows and warns on each storage error, so the booking below is
     *    created either way and one bad write never takes its siblings with
     *    it. A customer must NEVER lose a booking because an image failed to
     *    write — the lead is the asset, the photos are a bonus.
     */
    const photoFilenames = await storePhotos(photos);

    // 8. Create. Actor is null — there is no authenticated user behind a
    //    public booking, and job.service tolerates a null actor throughout.
    const created = await jobService.create(
      {
        fk_client_id: clientId,
        initial_status: INITIAL_STATUS,
        source_type: SOURCE_TYPE,
        job_type: b.jobType,
        job_desc: b.description,
        fk_service_catg_id: b.serviceCategoryId || undefined,
        requested_date_time: requestedDateSentinel,
        requested_time: requestedTime,
        time_slot: b.timeSlot,
        /*
         * FIRST booking-time photo only. create() INSERTs this verbatim into
         * tbl_job_image (image_category 'booking', job_stage 0) inside the same
         * transaction as the job — see the `job_image_filename` branch in
         * services/job.service.js, which handles exactly ONE image. Photos
         * 2..N are inserted by attachExtraPhotos() after the commit, with the
         * identical column set. null/undefined ⇒ that branch is skipped
         * entirely, which is exactly the no-photo and all-storage-failed case.
         */
        job_image_filename: photoFilenames[0] || undefined,
        /*
         * Composed remarks — currently only the customer's preferred window.
         * undefined when they didn't pick one, which leaves tbl_job.remarks
         * NULL exactly as before (composeRemarks returns null for no parts).
         */
        remarks,
        /*
         * ⚠ NO client_spoc / client_spoc_name / client_spoc_email — DELIBERATE.
         * Those columns stay NULL on a website booking. The SPOC is the CLIENT's
         * named contact for the order, and on a walk-up lead we do not yet know
         * which client this really belongs to (it may well be sitting on the
         * RETAIL fallback). Ops fills the SPOC in the CRM at the same time they
         * map the real client. Guessing one here would stamp a real person's
         * name and email onto an order they have never heard of.
         *
         * NOTE this is NOT the same thing as `job_client_owner`, which
         * create() auto-resolves from the client's Primary SPOC in
         * tbl_vertical_mapping. That is existing, correct, platform-wide
         * behaviour and is intentionally left alone — do not try to suppress it.
         */
        customer: {
          customer_name: b.name,
          customer_mob_no: b.mobile,
          customer_email: b.email || undefined,
        },
        address: {
          address: b.address,
          building: b.building || undefined,
          landmark: b.landmark || undefined,
          city_id: cityId,
          pin_code: b.pincode,
          mobile_number: b.mobile,
          /*
           * "<lat>,<lng>" or undefined. addressService.insertCustomerAddress()
           * writes it to tbl_address.gps_location (`addr.gps_location || null`),
           * the same column the CRM and mobile booking paths use — so the map
           * pin in the CRM and the technician app works with no read-path
           * change. Already range-checked in step 4b; an implausible fix
           * arrives here as null.
           */
          gps_location: gps || undefined,
        },
      },
      { user_id: null },
    );

    /*
     * 9. Attach photos 2..N. AFTER the commit and deliberately not awaited into
     *    the job's transaction: the booking is already safe, and an image row
     *    failing here must not roll it back. Non-fatal by contract.
     */
    const extraAttached = photoFilenames.length > 1
      ? await attachExtraPhotos(created.job_id, photoFilenames.slice(1))
      : 0;

    logger.info(
      'Website booking created · jobId=' + created.job_id
      + ' · ref=' + (created.job_reference_id || '-')
      + ' · clientId=' + clientId
      + ' · clientBranch=' + branch
      + ' · code=' + (b.code ? String(b.code).trim() : '-')
      + ' · slot=' + b.timeSlot
      + ' · preferredWindow=' + (preferredWindow || '-')
      + ' · gps=' + (gps ? 'yes' : (b.gps ? 'dropped' : 'none'))
      + ' · photos=' + photos.length + ' sent/'
        + (photoFilenames.length ? 1 + extraAttached : 0) + ' attached'
      + ' · mobile=' + maskMobile(b.mobile),
    );

    return modernOk(
      res,
      { jobId: created.job_id, referenceId: created.job_reference_id || null },
      'booking received',
    );
  } catch (e) {
    return mapKnownError(res, next, e);
  }
});

module.exports = router;
