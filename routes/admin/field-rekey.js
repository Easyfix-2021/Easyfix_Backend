const router = require('express').Router();
const Joi = require('joi');

const validate = require('../../middleware/validate');
const requireAction = require('../../middleware/require-action');
const { requirePropertyAllowlist } = require('../../middleware/require-property-allowlist');
const { FEATURES } = require('../../services/feature-access.service');
const { rateLimit } = require('../../middleware/rate-limit');
const { pool } = require('../../db');
const { modernOk, modernError } = require('../../utils/response');
const logger = require('../../logger');
const rekeyService = require('../../services/field-rekey.service');

const { GROUP_KEYS, REKEY_MODES } = rekeyService;

/*
 * /api/admin/field-rekey — Admin Actions → "Secrets Manager".
 *
 * The operator surface for services/field-rekey.service.js: rotate the
 * operational key, recover from a lost one, seal rows written without a
 * recovery key, or re-seal to a new one — in bulk, without an SSH session.
 * Mount inherits requireAuth + role(['admin']) + scope from
 * routes/admin/index.js; on top of that every route here carries its own ACTION
 * KEY, seeded on the Admin Actions hub and granted to role_id 2 by
 * migrations/2026-09-01-hrms-07-rekey-rbac.sql:
 *
 *   isFieldRekeyRun      POST /dry-run, POST /run
 *   isRecoveryKeyManage  POST /recovery-key, GET /recovery-key
 *
 * An action key rather than a bare role check, because /api/admin/* already
 * admits ten roles and this is the single most sensitive endpoint in the
 * backend.
 *
 * ══════════════════════════════════════════════════════════════════════
 * AND THE EMAIL ALLOWLIST ON TOP — AND, NEVER OR
 * ══════════════════════════════════════════════════════════════════════
 * Every route here also requires the caller's official_email to appear in
 * easyfix_properties['secrets.manager.emails'] (FEATURES.canManageSecrets).
 * RBAC says the screen EXISTS; the allowlist says WHO MAY REACH IT. Both must
 * pass, and the allowlist is what makes removal effective: taking a person off
 * the property revokes them immediately even though their role still carries
 * the action key. An OR would hand that back to whoever administers roles,
 * which is the opposite of the point — this screen can rewrite the key
 * protecting every bank account number in the company, so its blast radius
 * follows a PERSON, not a role that gets handed out later.
 *
 * IT IS MOUNTED router-wide AND FIRST, before the rate limiters, before
 * validate(), before requireAction — deliberately:
 *   · a denied caller never reaches a handler that has their pasted recovery
 *     private key in scope, and never reaches validate(), whose error details
 *     travel back to the client
 *   · it costs ZERO queries (the property list is a cached in-process read),
 *     so a rejected caller cannot make this endpoint do database work
 * The GET is gated too. It is tempting to leave a read open, but it reports the
 * active recovery key's fingerprint and whether rows carry a seal — precise
 * reconnaissance for the one person being kept out, and free to close.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE PASTED PRIVATE KEY IS THE SECURITY BOUNDARY OF THIS FEATURE
 * ══════════════════════════════════════════════════════════════════════
 * Every measure below exists for one input: `recoveryPrivateKey` on POST /run.
 * Between them they mean the key is in this process's memory for the length of
 * one request and lands in NO sink at all.
 *
 *   POST ONLY          a GET puts it in browser history, in proxy logs and in
 *                      the referer header, and makes the call triggerable from
 *                      an <img src>.
 *   no-store           the response is not written to the disk cache. Applied
 *                      to every route here, including the GET, so there is no
 *                      route on this surface whose caching has to be reasoned
 *                      about separately.
 *   scrubbed           deleted from req.body in a `finally` the moment the
 *                      service returns — before the response is serialised and
 *                      before any error can travel to middleware/error-handler,
 *                      which logs an error's message and stack.
 *   never echoed       no handler here puts a request field into a response, a
 *                      log line or an error message. The service is written to
 *                      the same rule: see its header.
 *   Joi cannot leak it the schema below uses LENGTH and TYPE rules only. Joi's
 *                      `string.pattern.base` message QUOTES THE OFFENDING VALUE
 *                      ("... with value \"-----BEGIN...\" fails to match ..."),
 *                      and validate() ships `details` straight to the client and
 *                      into a warn log. So the SHAPE of a key is checked in the
 *                      service, where the message is ours to author. Do not add
 *                      a .pattern(), a .valid() or a .regex() to any key field
 *                      here.
 *   rate limited       a handful per hour, per operator. This endpoint can
 *                      re-key every protected value in the company; it must not
 *                      also be a place to test guessed recovery keys. Note that
 *                      /api/admin/* is deliberately exempt from the global
 *                      limiter, so these per-route limiters are the ONLY bound.
 *   audited            one row in tbl_sensitive_reveal_log per run, written by
 *                      the service even when the run fails — including when it
 *                      fails on the key pre-flight, so a guessing attempt is on
 *                      the record. It names the actor, the group, the mode and
 *                      the row count. It never names the key.
 *
 * ── THE MASTER KEY IS OPTIONAL, AND THE FORM MUST SAY SO ────────────────
 * `rotate` needs the NEW key and nothing else — the current operational key
 * still works and is what unwraps each data key. `seal` needs NOTHING pasted at
 * all: it uses the operational key from env and the active recovery key from the
 * store. The recovery private key is required ONLY by `recover` and `reseal`.
 * Every time a recovery key is typed somewhere is an exposure, and neither of
 * the two ordinary paths may create one.
 *
 * ── WHICH MODES THE FORM MAY OFFER ──────────────────────────────────────
 * This deployment runs with NO recovery key by the owner's decision, so rows are
 * written UNSEALED and `recover` — which opens a SEALED data key with a private
 * key — cannot work on them at all. GET /recovery-key answers that: it returns
 * `active` (is a recovery key registered), `seals` (are there sealed rows,
 * unsealed rows, or both) and a ready-made `modes` map. The UI must hide or
 * disable a mode whose flag is false rather than let the operator find out by
 * pasting their master key into a run that was never going to work.
 */

const noStore = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  next();
};
router.use(noStore);

/*
 * THE PER-PERSON GATE. First real guard on every route in this file — see the
 * header. Kept as a router.use rather than repeated per route so a route added
 * later is gated by default rather than by remembering.
 */
router.use(requirePropertyAllowlist(FEATURES.canManageSecrets, { label: 'Secrets Manager' }));

/* Same contract as the reveal routes' helper — see routes/profile.js. */
function clientIp(req) {
  try {
    return req.ip || (req.connection && req.connection.remoteAddress) || null;
  } catch { return null; }
}

/*
 * Delete the key material from the request object as soon as it has been used.
 * Called from a `finally`, so it runs on the error path too — which is the path
 * that matters, because that is the one that reaches the error handler.
 *
 * It cannot un-write a copy something else already took; what it does is stop
 * `req` from carrying a secret through the rest of the middleware chain for the
 * remainder of the response, which is where an innocent-looking future addition
 * (a body-logging middleware, an APM hook) would find it.
 */
function scrubKeys(req) {
  if (!req.body || typeof req.body !== 'object') return;
  delete req.body.recoveryPrivateKey;
  delete req.body.newKey;
}

// ── Rate limits ─────────────────────────────────────────────────────────
/*
 * Instantiated ONCE at module scope: rateLimit() closes over its own Map, so a
 * per-request instance would cap nothing. Keyed on the OPERATOR rather than the
 * IP — an office NATs to one address and what is being bounded is a person.
 *
 * Three a run and five a key registration per HOUR, not per minute. A re-key is
 * an operation performed a handful of times in the life of the system; anything
 * beyond that is either a stuck client or someone working through a list of
 * candidate keys. The dry run is looser because it writes nothing, holds no key
 * and decrypts nothing — it only reads fingerprints — but it is still bounded,
 * since it is a full scan of two tables.
 */
const runLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 3,
  key: (req) => `field-rekey-run:${(req.user && req.user.user_id) || req.ip}`,
});

const dryRunLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 30,
  key: (req) => `field-rekey-dry:${(req.user && req.user.user_id) || req.ip}`,
});

const recoveryKeyLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 5,
  key: (req) => `field-rekey-recovery-key:${(req.user && req.user.user_id) || req.ip}`,
});

/*
 * The GET is a screen load, so it is far looser than the write above — but it is
 * bounded, because answering "are any rows unsealed" is a scan of the protected
 * columns (see sealCensus). Read-only, no key material, one operator.
 */
const recoveryStatusLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 60,
  key: (req) => `field-rekey-recovery-status:${(req.user && req.user.user_id) || req.ip}`,
});

// ── Schemas ─────────────────────────────────────────────────────────────
/*
 * LENGTH AND TYPE ONLY on the two key fields — see the header for why a
 * .pattern() here would ship the key back to the browser inside a 400.
 *
 * The bounds are sanity rails, not format checks: 32 base64 bytes is 44
 * characters, an RSA-4096 PKCS#8 PEM is roughly 3.2 KB, and the ceilings are
 * generous enough for a larger key while still refusing a paste of a whole
 * file. `.max()` and `.min()` messages state a length and never a value.
 */
const dryRunBody = Joi.object({
  group: Joi.string().valid(...GROUP_KEYS).required(),
});

const runBody = Joi.object({
  group: Joi.string().valid(...GROUP_KEYS).required(),
  mode: Joi.string().valid(...REKEY_MODES).required(),
  // Required by rotate and recover, unused by reseal. Which of those applies is
  // decided in the service, so the requirement and its message live in one
  // place with the rest of the mode's rules.
  newKey: Joi.string().trim().min(24).max(512).optional(),
  recoveryPrivateKey: Joi.string().trim().min(64).max(20000).optional(),
});

/*
 * There is deliberately NO `newRecoveryPublicKey`. A reseal targets the ACTIVE
 * row in tbl_field_recovery_key, which the operator populated by registering
 * the public half of the keypair their browser generated. Accepting it again
 * here would add a way for a typo or a stale clipboard to seal every protected
 * value in the company to a key nobody holds — unrecoverable, and with no
 * upside, since the server already has the authoritative copy.
 */
const recoveryKeyBody = Joi.object({
  publicKeyPem: Joi.string().trim().min(80).max(20000).required(),
});

/* Service errors carry { status, code }; anything else is a real 500. */
function fail(res, next, e, what) {
  if (e.status) {
    logger.warn(what + ' failed · ' + e.message);
    return modernError(res, e.status, e.message, e.code ? { code: e.code } : undefined);
  }
  return next(e);
}

// ── DRY RUN ──────────────────────────────────────────────────────────
/*
 * POST /dry-run — what a run WOULD do. Writes nothing, needs no key.
 *
 * POST rather than GET despite being read-only: it is a full scan of every
 * protected column, and the rate limiter above is keyed per operator, both of
 * which make it the wrong thing to have prefetched or retried by a browser.
 */
router.post('/dry-run',
  requireAction('isFieldRekeyRun'),
  dryRunLimiter,
  validate(dryRunBody),
  async (req, res, next) => {
    try {
      logger.info('Field re-key dry run · group=' + req.body.group
        + ' actor=' + (req.user && req.user.user_id));
      modernOk(res, await rekeyService.dryRunReKey(req.body, pool));
    } catch (e) { fail(res, next, e, 'Field re-key dry run'); }
  },
);

// ── RUN ──────────────────────────────────────────────────────────────
/*
 * POST /run — the real thing.
 *
 * The log line names the group and the mode and NOTHING ELSE from the body.
 * `mode` is exactly the fact worth recording — it says whether a recovery key
 * was used — and it is not itself sensitive.
 */
router.post('/run',
  requireAction('isFieldRekeyRun'),
  runLimiter,
  validate(runBody),
  async (req, res, next) => {
    const { group, mode } = req.body;
    try {
      logger.info('Field re-key RUN · group=' + group + ' mode=' + mode
        + ' actor=' + (req.user && req.user.user_id));
      const data = await rekeyService.runReKey(req.body, req.user, pool, clientIp(req));
      modernOk(res, data, `Re-keyed ${data.totals.changed} row(s)`);
    } catch (e) {
      fail(res, next, e, 'Field re-key run · group=' + group + ' mode=' + mode);
    } finally {
      // Before the response is serialised, and before any error reaches the
      // handler that logs message + stack.
      scrubKeys(req);
    }
  },
);

// ── RECOVERY KEY ─────────────────────────────────────────────────────
/*
 * POST /recovery-key — register the PUBLIC half of a new recovery keypair and
 * make it the active one.
 *
 * The private half is generated in the browser (WebCrypto, RSA-OAEP 4096),
 * shown once, and never posted. Nothing here can receive it, and the service
 * refuses a PEM that declares itself private rather than storing it — the one
 * paste mistake that would invert this whole feature.
 *
 * REGISTERING DOES NOT BY ITSELF PROTECT EXISTING ROWS, and the UI says so.
 * What fixes them depends on what they carry, and the two cases need different
 * keys:
 *
 *   written with NO recovery key (this deployment's normal state) → POST /run
 *   with mode=seal. It needs only the OPERATIONAL key, so registering a recovery
 *   key TODAY retro-protects everything written before it. Nothing is pasted.
 *
 *   sealed to a PREVIOUS key that LEAKED and is still held → mode=reseal with
 *   the OLD private key.
 *
 *   sealed to a previous key that was LOST → neither works; those rows keep the
 *   old seal. The data is not lost, the operational key still reads it, and the
 *   path moves as rows are rewritten.
 */
router.post('/recovery-key',
  requireAction('isRecoveryKeyManage'),
  recoveryKeyLimiter,
  validate(recoveryKeyBody),
  async (req, res, next) => {
    try {
      const data = await rekeyService.storeRecoveryPublicKey(req.body, req.user, pool);
      logger.warn('Recovery key registered · fingerprint=' + data.fingerprint
        + ' actor=' + (req.user && req.user.user_id));
      modernOk(res, data, data.already_active
        ? 'That key is already the active recovery key'
        : 'Recovery key registered and made active');
    } catch (e) { fail(res, next, e, 'Register recovery key'); }
  },
);

/*
 * GET /recovery-key — everything the screen needs to draw itself:
 *
 *   { fingerprint, created_on,        the active recovery key, or nulls
 *     active,                         is one registered at all
 *     seals: { sealed, unsealed },    what the stored rows actually carry
 *     modes: { rotate, recover,       which re-key modes can work right now
 *              reseal, seal } }
 *
 * ⚠ It no longer returns `null` when nothing is registered — "no recovery key"
 * is a supported configuration here, not an unfinished setup, and the screen has
 * to say so accurately. Branch on `active`, not on the payload being truthy.
 *
 * NEVER any private material, and not the PEM either: the operator already has
 * the public key, and a fingerprint is a hash prefix, safe to print.
 */
router.get('/recovery-key',
  requireAction('isRecoveryKeyManage'),
  recoveryStatusLimiter,
  async (req, res, next) => {
    try {
      modernOk(res, await rekeyService.getActiveRecoveryKey(pool));
    } catch (e) { fail(res, next, e, 'Read active recovery key'); }
  },
);

module.exports = router;
