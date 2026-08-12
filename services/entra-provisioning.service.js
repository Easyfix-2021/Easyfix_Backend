const crypto = require('crypto');

const { pool } = require('../db');
const logger = require('../logger');
const { graphRequest } = require('./ms-graph-token.service');
const { getProperty } = require('./properties.service');
// Only for the property KEY name in the skip reason — the allowlist decision
// itself is taken by the caller (route middleware / route handler), never here.

/*
 * ══════════════════════════════════════════════════════════════════════════
 *  Microsoft 365 / Entra ID mailbox provisioning for CRM users.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * THE BUG THIS FIXES
 * ──────────────────
 * Before this file existed, the ONLY Graph endpoint in the whole backend was
 * sendMail. `createUser()` wrote a tbl_user row with `official_email` set and
 * stopped there — no Entra account, no Exchange mailbox, no record of that
 * fact anywhere. The address looked real in the CRM, OTP email to it was
 * "delivered" (Graph 202-accepts anything, see services/email.service.js), and
 * the bounce went to the sender mailbox that nobody reads. Reported case:
 * user_id 8710 / ankitjha@easyfix.in — a Project Manager who simply could not
 * log in and no screen could say why.
 *
 * TWO INDEPENDENT OUTCOMES, ON PURPOSE
 * ────────────────────────────────────
 * Creating an Entra user does NOT create a mailbox. Exchange Online only
 * provisions one when the account holds a LICENCE. So the account step and the
 * licence step can fail independently, and "directory account exists but has
 * no mailbox" is exactly the silent state we were bitten by. They are recorded
 * as two separate columns (account_status, licence_status) in
 * tbl_user_entra_provisioning — never collapsed into one boolean.
 *
 * FAIL-CLOSED
 * ───────────
 * `entra.provisioning.enabled` in easyfix_properties gates every directory
 * WRITE and defaults to FALSE both in the seed migration and in this code, so
 * merging this cannot start creating AD accounts in production. Turning it on
 * is a deliberate, revertible act (see docs/ENTRA_PROVISIONING.md).
 *
 * FAIL-SOFT
 * ─────────
 * Nothing in here may ever break CRM user creation. Every Graph call is
 * status-inspected instead of thrown, every DB write is wrapped, and the
 * orchestrator always returns an outcome object rather than raising.
 *
 * GRAPH CALLS + APPLICATION PERMISSIONS
 * ─────────────────────────────────────
 *   GET  /v1.0/users/{upn}?$select=…              User.ReadWrite.All (or .Read.All)
 *   GET  /v1.0/users?$filter=mail eq '…'          User.ReadWrite.All (alias fallback)
 *   POST /v1.0/users                              User.ReadWrite.All
 *   GET  /v1.0/subscribedSkus                     Organization.Read.All
 *   POST /v1.0/users/{id}/assignLicense           User.ReadWrite.All
 * All application (daemon) permissions — this is a client-credentials flow, so
 * Delegated permissions do nothing. Admin consent required.
 */

// ── Feature flags / config ────────────────────────────────────────────────

const PROP_ENABLED   = 'entra.provisioning.enabled';
const PROP_SKU       = 'entra.provisioning.sku.part.number';
const PROP_DOMAINS   = 'entra.managed.domains';
const PROP_PRECHECK  = 'login.otp.email.mailbox.precheck';

function propBool(key, fallback) {
  const v = String(getProperty(key) ?? '').trim().toLowerCase();
  if (v === 'true')  return true;
  if (v === 'false') return false;
  return fallback;
}

/*
 * MASTER switch for every directory WRITE. Defaults FALSE in code as well as
 * in the seed, so a host that never ran the migration is also off.
 */
function provisioningEnabled() {
  return propBool(PROP_ENABLED, false);
}

/*
 * The read-only mailbox-existence pre-check used by the OTP path. Defaults
 * TRUE — unlike the provisioning master switch — and that difference is
 * deliberate:
 *   - it performs NO writes; it cannot create, licence or modify anything;
 *   - it is fail-OPEN on every outcome except a clean "no such mailbox", so
 *     before admin consent is granted it answers 403 → 'unknown' → the email
 *     is attempted exactly as it is today;
 *   - it only applies to addresses in our OWN verified domains, so a user who
 *     signs in with a gmail.com address is never affected;
 *   - and it IS the fix for the reported bug. Defaulting it off would ship the
 *     diagnosis without the cure.
 * Flip `login.otp.email.mailbox.precheck` to 'false' to disable it with no
 * redeploy if it ever misbehaves.
 */
function mailboxPrecheckEnabled() {
  return propBool(PROP_PRECHECK, true);
}

/*
 * Licence SKU chosen by PART NUMBER (e.g. 'O365_BUSINESS_ESSENTIALS',
 * 'SPB', 'EXCHANGESTANDARD') — never a hardcoded GUID, because SKU GUIDs are
 * tenant-agnostic but opaque and the part number is what the M365 admin centre
 * and `GET /subscribedSkus` both show. Property wins; env is the bootstrap
 * fallback for a host whose property row is still empty.
 */
function configuredSkuPartNumber() {
  const fromProp = String(getProperty(PROP_SKU) ?? '').trim();
  if (fromProp) return fromProp;
  return String(process.env.MS_GRAPH_LICENSE_SKU_PART_NUMBER || '').trim();
}

/*
 * Domains this tenant actually owns. Two jobs:
 *   1. we refuse to create an account for an address we don't control;
 *   2. the OTP pre-check only runs for these domains — a personal address
 *      (gmail.com, and there are real CRM users on those) will ALWAYS 404 in
 *      our directory, and suppressing their OTP email would lock them out.
 */
function managedDomains() {
  const raw = String(getProperty(PROP_DOMAINS) ?? '').trim()
    || String(process.env.MS_GRAPH_MANAGED_DOMAINS || '').trim()
    || 'easyfix.in';
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function isManagedDomain(address, domains = managedDomains()) {
  const at = String(address || '').lastIndexOf('@');
  if (at < 0) return false;
  const dom = String(address).slice(at + 1).trim().toLowerCase();
  return domains.includes(dom);
}

// Entra requires a usageLocation (ISO-3166 alpha-2) before some SKUs can be
// assigned; assignLicense fails outright without it. Set at create time.
function usageLocation() {
  return String(process.env.MS_GRAPH_USAGE_LOCATION || 'IN').trim().toUpperCase();
}

// ── Status vocabularies (mirrored in the migration comment) ───────────────

const ACCOUNT_STATUS = Object.freeze({
  SKIPPED_DISABLED:   'skipped_disabled',      // feature flag off
  SKIPPED_NOT_ALLOWED:'skipped_not_allowed',   // actor is not on the per-person allowlist
  SKIPPED_DOMAIN:     'skipped_domain',        // email not in a managed domain
  SKIPPED_INVALID:    'skipped_invalid_email', // unusable official_email
  CREATED:            'created',
  ALREADY_EXISTS:     'already_exists',
  /*
   * The address is already held by a directory object that is NOT this user's.
   *
   * DISTINCT FROM ALREADY_EXISTS ON PURPOSE. `already_exists` means "our own
   * earlier attempt for THIS user_id got there first" — an idempotent retry,
   * safe to reuse and licence. This one means a DIFFERENT person owns the
   * mailbox at that address, and reusing it would assign a licence to a
   * stranger's account and store that stranger's objectId against the new CRM
   * row. Two people called Mohit Kumar is all it takes. Nothing is written to
   * the directory in this state; the operator has to pick another address (the
   * numbered suggestion from suggestAvailableUpn is exactly that).
   *
   * ⚠ Not in the vocabulary list of migrations/executed/2026-07-30-create-tbl-
   * user-entra-provisioning.sql — that file is frozen. account_status is a
   * VARCHAR(32), so the value stores fine.
   */
  COLLISION:          'collision_other_object',
  FAILED:             'failed',
});

const LICENCE_STATUS = Object.freeze({
  NOT_ATTEMPTED:      'not_attempted',   // no account to licence
  SKIPPED:            'skipped',         // provisioning skipped entirely
  NO_SKU_CONFIGURED:  'no_sku_configured',
  SKU_NOT_FOUND:      'sku_not_found',
  SKU_NOT_ACTIVE:     'sku_not_active',
  NO_SEATS:           'no_seats_available',
  ALREADY_LICENSED:   'already_licensed',
  ASSIGNED:           'assigned',           // read back from Entra — the seat is REALLY there
  /*
   * Graph 2xx-ed the assignLicense call but a read-back could not see the SKU on
   * the user. Observed on anand.thakur@easyfix.in (2026-08-04): this table said
   * `assigned` with the right SKU while the M365 admin centre showed EVERY
   * licence box unticked, and the user could not open anything until an admin
   * ticked Microsoft 365 Business Basic by hand.
   *
   * NOT a synonym for `assigned`. It is the honest answer when Graph accepted
   * the request and the seat did not appear — deliberately kept out of
   * mailboxLikelyExists below so nothing downstream treats it as a live mailbox.
   */
  ASSIGNED_UNCONFIRMED: 'assigned_unconfirmed',
  FAILED:             'failed',
});

/*
 * A mailbox only exists once BOTH steps landed.
 *
 * ⚠ ASSIGNED_UNCONFIRMED is deliberately absent from `licenceOk`. This function
 * gates the OTP mailbox pre-check, so calling an unconfirmed licence "ready"
 * would mail a login OTP into a mailbox that does not exist and suppress the
 * WhatsApp/SMS fallback — the exact failure this whole file was written to stop,
 * one step further down the pipeline.
 */
function mailboxLikelyExists(accountStatus, licenceStatus) {
  const accountOk = accountStatus === ACCOUNT_STATUS.CREATED || accountStatus === ACCOUNT_STATUS.ALREADY_EXISTS;
  const licenceOk = licenceStatus === LICENCE_STATUS.ASSIGNED || licenceStatus === LICENCE_STATUS.ALREADY_LICENSED;
  return accountOk && licenceOk;
}

/*
 * Does this Graph user object actually have a MAILBOX behind it?
 *
 * "A directory object exists" and "a mailbox exists" are NOT the same claim —
 * that gap is the whole reason this file exists (see the header). An Entra user
 * created without a licence is a perfectly valid object with `mail: null` and no
 * SMTP proxy address, because Exchange Online never provisioned anything for it.
 * So the object's presence alone must never be read as "email is a live
 * channel"; we have to look at the mail-enabled attributes we already $select.
 *
 * Two signals, either is sufficient:
 *   mail            the primary SMTP address Exchange stamped on the object;
 *   proxyAddresses  contains 'SMTP:primary@…' / 'smtp:alias@…' entries for any
 *                   mail-enabled object, including hybrid/on-prem-synced ones
 *                   whose `mail` can lag or be unset.
 * Requiring BOTH to be empty before we doubt the mailbox keeps the false-negative
 * rate down — a false "no mailbox" is the expensive direction here.
 */
function directoryObjectHasMailbox(user) {
  if (!user || typeof user !== 'object') return false;
  if (String(user.mail || '').trim()) return true;
  const proxies = Array.isArray(user.proxyAddresses) ? user.proxyAddresses : [];
  return proxies.some((p) => /^smtp:[^\s@]+@[^\s@]+$/i.test(String(p || '').trim()));
}

// ── Pure helpers (unit-tested; no network, no DB) ─────────────────────────

/*
 * Temp password for the new account.
 *
 * crypto ONLY — Math.random is not a CSPRNG and a predictable first-sign-in
 * password on a mail-enabled account is a real takeover path.
 *
 * ⚠ WHERE THIS VALUE MAY GO — the complete list (2026-08-03).
 * It used to be generated inline in the Graph create body and dropped on the
 * floor. That was safe and completely unusable: the mailbox we had just paid a
 * licence for had a password that existed for one HTTP request and then existed
 * nowhere, so the new joiner could not sign in. It now travels to EXACTLY ONE
 * consumer, via the `onTempPassword` sink callback threaded through
 * createEntraUser() → provisionUserMailbox(): the caller holds it as a local
 * value for the life of the request and hands it to
 * services/user-welcome-mail.service.js.
 *
 * It is still, on every path including errors:
 *   - NEVER logged (no logger line in this file interpolates it);
 *   - NEVER persisted — not to tbl_user_entra_provisioning, not anywhere;
 *   - NEVER placed on the outcome object, which IS published in the
 *     POST /api/admin/users response body;
 *   - NEVER returned from createEntraUser(), so it cannot be picked up by a
 *     future `{ ...created }` spread.
 * forceChangePasswordNextSignIn stays true, so it is single-use by design and
 * the M365 admin centre reset remains the fallback.
 *
 * Shape: 20 chars, at least two each of lower/upper/digit/symbol (Entra wants
 * 3 of 4 categories and 8–256 chars, so this clears it comfortably), from a
 * symbol set that survives copy/paste through the admin centre and shells.
 */
const PW_LOWER  = 'abcdefghijkmnopqrstuvwxyz';   // no 'l'
const PW_UPPER  = 'ABCDEFGHJKLMNPQRSTUVWXYZ';    // no 'I', no 'O'
const PW_DIGIT  = '23456789';                    // no 0/1
const PW_SYMBOL = '!@#$%^*()-_=+?';
const PW_ALL    = PW_LOWER + PW_UPPER + PW_DIGIT + PW_SYMBOL;

function pick(alphabet, n) {
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[crypto.randomInt(0, alphabet.length)];
  return out;
}

function generateTempPassword(length = 20) {
  const len = Math.max(16, Math.min(64, Number(length) || 20));
  const chars = (
    pick(PW_LOWER, 2) + pick(PW_UPPER, 2) + pick(PW_DIGIT, 2) + pick(PW_SYMBOL, 2)
    + pick(PW_ALL, len - 8)
  ).split('');
  // Fisher–Yates with a CSPRNG so the guaranteed-class characters aren't
  // pinned to the first eight positions.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/*
 * Derive the Entra identity from a CRM user's name + official_email.
 *
 * THE UPN IS THE EMAIL, VERBATIM. It is tempting to "clean up" the local part,
 * but the whole point is that mail sent to tbl_user.official_email must land in
 * this mailbox — a derived-but-different UPN would create a mailbox at an
 * address nobody writes to, which is the bug we are fixing wearing a hat.
 * mailNickname (the Exchange alias seed) is allowed to differ and IS sanitised.
 *
 *   → { ok: true, userPrincipalName, mailNickname, displayName, givenName, surname, domain }
 *   → { ok: false, reason, accountStatus }
 */
function deriveIdentity({ user_name, official_email } = {}, domains = managedDomains()) {
  const email = String(official_email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, accountStatus: ACCOUNT_STATUS.SKIPPED_INVALID, reason: `official_email "${official_email || ''}" is not a usable email address` };
  }
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  if (!domains.includes(domain)) {
    return {
      ok: false,
      accountStatus: ACCOUNT_STATUS.SKIPPED_DOMAIN,
      reason: `domain "${domain}" is not an EasyFix-managed Microsoft 365 domain (managed: ${domains.join(', ')}) — no mailbox can be created for it`,
    };
  }
  // A UPN local part is narrower than an email local part: '+' and '%' are
  // legal in SMTP but not in a UPN, so we refuse rather than silently mangle.
  if (!/^[a-z0-9._'-]+$/.test(local)) {
    return { ok: false, accountStatus: ACCOUNT_STATUS.SKIPPED_INVALID, reason: `local part "${local}" contains characters that are not valid in a userPrincipalName` };
  }

  const mailNickname = (local.replace(/[^a-z0-9._-]/g, '').replace(/\.{2,}/g, '.').replace(/^\.+|\.+$/g, '') || 'user').slice(0, 64);
  const fullName = String(user_name || '').trim().replace(/\s+/g, ' ');
  const displayName = (fullName || local).slice(0, 256);

  /*
   * givenName / surname — Entra's First name and Last name fields.
   *
   * These were simply never sent: the create body carried displayName and
   * nothing else name-shaped, so every account landed with a full name in
   * Display name and both name fields BLANK. That is visible in the Microsoft
   * 365 admin centre, in Outlook's address book sort order, and in any Teams or
   * SharePoint surface that renders first name — and it cannot be inferred back
   * out of displayName by Microsoft.
   *
   * tbl_user has ONE name column, so the split is positional: the first
   * whitespace-separated token is the given name, EVERYTHING after it is the
   * surname. "Vijay Kumar Nailwal" → "Vijay" / "Kumar Nailwal". That is the
   * right call for Indian names in a single-field system — a middle name
   * belongs with the family name far more often than it belongs alone, and
   * dropping it entirely would lose data the CRM holds.
   *
   * A single-word name yields a given name and NO surname, and the key is then
   * omitted from the request rather than sent empty: Graph treats '' as a value
   * to store, so sending it writes a blank where "absent" is the honest answer.
   *
   * When user_name is blank there is nothing to split. displayName falls back to
   * the email local part above, but a local part is an ADDRESS, not a name —
   * splitting "vijay.nailwal" on the dot would be inventing a first and last
   * name from a mailbox alias. Both fields stay unset instead.
   *
   * 64 chars is Graph's limit on each field (displayName allows 256).
   */
  const nameParts = fullName ? fullName.split(' ') : [];
  const givenName = nameParts.length ? nameParts[0].slice(0, 64) : null;
  const surname = nameParts.length > 1 ? nameParts.slice(1).join(' ').slice(0, 64) : null;

  return { ok: true, userPrincipalName: email, mailNickname, displayName, givenName, surname, domain };
}

/*
 * Turn a Graph error response into something an operator can act on, and keep
 * the correlation id — it is the first thing Microsoft support asks for.
 *
 *   → { status, code, reason, requestId, permissionIssue, notFound,
 *       alreadyExists, throttled }
 */
function graphErrorToReason(result) {
  const status = result && typeof result.status === 'number' ? result.status : 0;
  // graphRequest() already lifts the correlation id out of the response headers;
  // fall back to the body's innerError for callers handing us a raw payload
  // (and for the endpoints that only put it there).
  const inner = result && result.json && result.json.error && result.json.error.innerError;
  const requestId = (result && result.requestId)
    || (inner && (inner['request-id'] || inner.requestId || inner['client-request-id']))
    || null;

  if (result && result.networkError) {
    return { status: 0, code: 'network', reason: `could not reach Microsoft Graph — ${result.networkError}`, requestId, permissionIssue: false, notFound: false, alreadyExists: false, throttled: false };
  }

  const err     = (result && result.json && result.json.error) || null;
  const code    = (err && err.code) || null;
  const message = (err && err.message) || (result && result.text ? String(result.text).slice(0, 300) : '');
  const lower   = String(message).toLowerCase();

  const permissionIssue = status === 401 || status === 403;
  const notFound        = status === 404 || code === 'Request_ResourceNotFound';
  const alreadyExists   = status === 409
    || (code === 'Request_BadRequest' && /already exists|conflicting object/.test(lower))
    || /another object with the same value for property userprincipalname/.test(lower);
  const throttled       = status === 429;

  let reason;
  if (status === 401) {
    reason = 'Graph rejected the token (401) — check MS_GRAPH_CLIENT_SECRET has not expired';
  } else if (status === 403) {
    reason = 'Graph denied the call (403) — the app registration is missing admin consent for User.ReadWrite.All / Organization.Read.All. See docs/ENTRA_PROVISIONING.md';
  } else if (notFound) {
    reason = 'not found in the directory (404)';
  } else if (alreadyExists) {
    reason = 'an object with this userPrincipalName already exists in the directory';
  } else if (throttled) {
    reason = 'Graph throttled the request (429) — retry shortly';
  } else if (status >= 500) {
    reason = `Microsoft Graph service error (${status})`;
  } else if (message) {
    reason = `${code ? code + ': ' : ''}${String(message).slice(0, 240)}`;
  } else {
    reason = `Graph call failed with HTTP ${status}`;
  }

  return { status, code, reason, requestId, permissionIssue, notFound, alreadyExists, throttled };
}

/*
 * Idempotency decision. Called with the directory lookup result BEFORE any
 * write, so a second click (or a retry after a partial failure) never creates a
 * duplicate account.
 *
 *   found + it IS our object  → reuse it (already_exists), then check the licence
 *   found + a DIFFERENT one   → COLLISION. Somebody else owns that mailbox.
 *   definitely gone           → create
 *   can't tell                → ABORT. Creating while blind is how you end up
 *                               with two accounts; and if the lookup 403s the
 *                               create would 403 too, so aborting loses nothing
 *                               and reports a clean reason the operator can fix.
 *
 * `recordedObjectId` is the entra_object_id tbl_user_entra_provisioning already
 * holds for THIS user_id, and it is the whole discriminator. `found` alone
 * cannot tell "my own earlier attempt for this user" from "a different employee
 * who already owns this address" — and before this argument existed it did not
 * try to: ANY object at that UPN was reused, so a second Mohit Kumar would have
 * been silently attached to the first one's mailbox.
 *
 * ⚠ NO RECORDED ID + THE ACCOUNT EXISTS IS A COLLISION, NOT A RETRY.
 * That is the tempting branch to get wrong, because it looks like "first run,
 * account already there, must be mine". It is not: recordProvisioning() writes
 * a row on EVERY path — including every failure — and stamps entra_object_id
 * the moment Graph confirms an account, so one of our own attempts always
 * leaves a claim behind. "The directory has this address and we have never
 * recorded owning it" therefore means somebody else's object.
 * The residual false positive (account created, then the process died before
 * the row was written) fails SAFE: we refuse, name the address, and an operator
 * confirms it in the M365 admin centre. The false negative — licensing and
 * mailing a new joiner into a stranger's mailbox — is not recoverable.
 */
function decideAccountAction(lookup, { recordedObjectId = null } = {}) {
  if (lookup && lookup.found) {
    const foundId = String((lookup.user && lookup.user.id) || '').trim();
    const ourId   = String(recordedObjectId || '').trim();
    if (ourId && foundId && ourId.toLowerCase() === foundId.toLowerCase()) {
      return { action: 'reuse', accountStatus: ACCOUNT_STATUS.ALREADY_EXISTS, entraObjectId: foundId };
    }
    const address = (lookup.user && (lookup.user.userPrincipalName || lookup.user.mail)) || 'this address';
    return {
      action: 'collision',
      accountStatus: ACCOUNT_STATUS.COLLISION,
      // Deliberately NOT returned as entraObjectId: a stranger's object id must
      // not end up recorded against this user_id, which is the very outcome
      // this branch exists to prevent.
      foundObjectId: foundId || null,
      reason: ourId
        ? `${address} now belongs to a DIFFERENT directory object (${foundId || 'unknown id'}) than the one recorded for this user (${ourId})`
        : `${address} already belongs to a different directory object (${foundId || 'unknown id'}) — this user has no Microsoft 365 account recorded, so the mailbox is somebody else's. Choose a different official email (e.g. a numbered variant) instead of taking over an existing mailbox`,
    };
  }
  if (lookup && lookup.status === 'missing') {
    return { action: 'create' };
  }
  return {
    action: 'abort',
    accountStatus: ACCOUNT_STATUS.FAILED,
    reason: (lookup && lookup.reason) || 'directory lookup did not return a definitive answer',
  };
}

/*
 * ── Availability pre-flight (Add User) ────────────────────────────────────
 *
 * The owner's rule: check BEFORE the CRM row is written, and if the address is
 * taken, offer a numbered alternative for the operator to confirm. Aborting
 * mid-create would leave an orphan tbl_user row whose official_email no longer
 * matches the directory, so this is a read-only pre-flight, not a mid-flight
 * abort. The route publishing it is POST /api/admin/users/check-official-email.
 *
 * ⚠ "CANNOT TELL" IS NOT "AVAILABLE". Every inconclusive outcome — 403 before
 * admin consent, 429, a 5xx, a network timeout, an unmanaged domain — answers
 * unavailable WITH the reason. This is the same discipline decideAccountAction
 * applies when it refuses to create blind, and it matters more here because the
 * answer is TRUSTED: a check that says "free" when it does not know is worse
 * than no check at all, since the operator stops looking.
 *
 *   → { available: true,  email }
 *   → { available: false, email, taken, reason }
 *
 * `taken` is true ONLY for a definitive directory hit. It is what tells the
 * caller a numbered suggestion makes sense — there is no point suggesting
 * mohit.kumar2@ when the real problem is that Graph is down or the domain is
 * not ours.
 */
async function isUpnAvailable(email) {
  /*
   * deriveIdentity does the validation this needs and nothing else does: an
   * unusable local part or a domain we do not own can never become a mailbox,
   * so both are reported as unavailable-with-a-reason rather than probed.
   */
  const ident = deriveIdentity({ official_email: email });
  if (!ident.ok) {
    return {
      available: false,
      email: String(email || '').trim().toLowerCase(),
      taken: false,
      reason: ident.reason,
    };
  }
  const addr = ident.userPrincipalName;

  /*
   * findByUpn, NOT a bare GET /users/{upn}. It also runs the `mail` alias probe,
   * and that is load-bearing here: an address that is free as a userPrincipalName
   * but is some other mailbox's SMTP address is NOT free, and handing it out
   * with full confidence is exactly the failure this endpoint is meant to stop.
   */
  const lookup = await findByUpn(addr, { select: 'id,mail,userPrincipalName,accountEnabled,proxyAddresses' });
  if (lookup.found) {
    const owner = (lookup.user && (lookup.user.userPrincipalName || lookup.user.mail)) || addr;
    return {
      available: false,
      email: addr,
      taken: true,
      reason: `${addr} is already in use in Microsoft 365${owner && owner !== addr ? ` (as an address of ${owner})` : ''}`,
    };
  }
  if (lookup.status === 'missing') return { available: true, email: addr };

  return {
    available: false,
    email: addr,
    taken: false,
    reason: `the directory could not confirm that ${addr} is free — ${lookup.reason || 'lookup inconclusive'}`,
  };
}

/*
 * How many numbered variants to probe before giving up. Bounded rather than
 * looping to the first free slot: each probe is one or two Graph round-trips on
 * an operator's blocked form, and if twenty are taken the honest answer is a
 * clear reason, not a hundred more calls.
 */
const MAX_UPN_SUGGESTION_PROBES = 20;

/*
 * Next free numbered variant of a taken address: mohit.kumar@ → mohit.kumar2@,
 * mohit.kumar3@ … Numbering starts at 2 because the unnumbered address IS the
 * first one, so the owner's own example (mohit.kumar3@ suggested) is the case
 * where mohit.kumar@ and mohit.kumar2@ are both taken.
 *
 *   → { suggested: 'mohit.kumar3@easyfix.in', probes }
 *   → { suggested: null, reason }
 *
 * An INCONCLUSIVE probe stops the walk instead of skipping to the next number:
 * once the directory has stopped answering, every later "free" is a guess, and
 * a guessed suggestion is the same trusted-but-wrong answer isUpnAvailable
 * refuses to give.
 */
async function suggestAvailableUpn(email, { maxProbes = MAX_UPN_SUGGESTION_PROBES } = {}) {
  const ident = deriveIdentity({ official_email: email });
  if (!ident.ok) return { suggested: null, reason: ident.reason };

  const at = ident.userPrincipalName.lastIndexOf('@');
  const local = ident.userPrincipalName.slice(0, at);
  const domain = ident.userPrincipalName.slice(at + 1);
  const limit = Math.max(1, Math.min(50, Number(maxProbes) || MAX_UPN_SUGGESTION_PROBES));

  for (let n = 2; n < 2 + limit; n++) {
    const candidate = `${local}${n}@${domain}`;
    const probe = await isUpnAvailable(candidate);
    if (probe.available) return { suggested: candidate, probes: n - 1 };
    if (!probe.taken) {
      return { suggested: null, reason: `could not check ${candidate} — ${probe.reason}` };
    }
  }
  return {
    suggested: null,
    reason: `${local}2@${domain} through ${local}${limit + 1}@${domain} are all in use — choose the address by hand`,
  };
}

/*
 * Choose a licence SKU from GET /subscribedSkus by part number, and refuse to
 * pretend when there is nothing to assign. Every negative outcome carries the
 * PRECISE reason, because "licence failed" is what made the original bug
 * undiagnosable.
 */
function pickSku(skus, wantedPartNumber) {
  const wanted = String(wantedPartNumber || '').trim();
  if (!wanted) {
    return { ok: false, status: LICENCE_STATUS.NO_SKU_CONFIGURED, reason: `no licence SKU configured — set easyfix_properties["${PROP_SKU}"] (or MS_GRAPH_LICENSE_SKU_PART_NUMBER) to a skuPartNumber from GET /subscribedSkus` };
  }
  const list = Array.isArray(skus) ? skus : [];
  const match = list.find((s) => String(s && s.skuPartNumber || '').trim().toLowerCase() === wanted.toLowerCase());
  if (!match) {
    return {
      ok: false,
      status: LICENCE_STATUS.SKU_NOT_FOUND,
      reason: `skuPartNumber "${wanted}" is not present on this tenant’s subscriptions${list.length ? ` (available: ${list.map((s) => s.skuPartNumber).filter(Boolean).join(', ')})` : ' (tenant returned no subscribed SKUs)'}`,
    };
  }
  const capability = String(match.capabilityStatus || '').trim();
  if (capability && capability !== 'Enabled' && capability !== 'Warning') {
    return { ok: false, status: LICENCE_STATUS.SKU_NOT_ACTIVE, reason: `SKU "${match.skuPartNumber}" is ${capability}, not Enabled — it cannot be assigned`, skuPartNumber: match.skuPartNumber };
  }
  const enabled  = Number(match.prepaidUnits && match.prepaidUnits.enabled) || 0;
  const consumed = Number(match.consumedUnits) || 0;
  const seats    = enabled - consumed;
  if (seats <= 0) {
    return { ok: false, status: LICENCE_STATUS.NO_SEATS, reason: `SKU "${match.skuPartNumber}" has no free seats (${consumed}/${enabled} used) — buy or free a seat, then retry`, skuPartNumber: match.skuPartNumber, seats };
  }
  return { ok: true, skuId: match.skuId, skuPartNumber: match.skuPartNumber, seats };
}

// ── Graph calls ───────────────────────────────────────────────────────────

/*
 * GET /v1.0/users/{upn} — the directory existence check. ALSO used by the OTP
 * mailbox pre-check, hence the shared implementation.
 *
 *   → { found: true, status: 'found', user }
 *   → { found: false, status: 'missing' }               definitive 404
 *   → { found: false, status: 'unknown', reason, … }    anything else
 *
 * The alias fallback matters: GET /users/{address} matches only
 * userPrincipalName or id, so a mailbox reachable at a secondary SMTP address
 * 404s on the direct lookup. We therefore re-ask with a `mail` filter before
 * concluding "no such mailbox" — a false 'missing' would suppress a working
 * OTP channel.
 */
async function findByUpn(upn, { select = 'id,mail,userPrincipalName,accountEnabled,proxyAddresses' } = {}) {
  const address = String(upn || '').trim().toLowerCase();
  if (!address) return { found: false, status: 'unknown', reason: 'no address supplied' };

  // $select is a fixed, code-controlled field list — left UNENCODED so the
  // commas reach OData as separators (a %2C is not universally decoded before
  // the $select parser sees it). The address IS encoded: it is data.
  const direct = await graphRequest(`/users/${encodeURIComponent(address)}?$select=${select}`);
  if (direct.ok && direct.json && direct.json.id) {
    return { found: true, status: 'found', user: direct.json, requestId: direct.requestId };
  }
  const err = graphErrorToReason(direct);
  if (!err.notFound) {
    return { found: false, status: 'unknown', reason: err.reason, permissionIssue: err.permissionIssue, httpStatus: err.status, requestId: err.requestId };
  }

  // 404 on the direct lookup → could still be an alias. `$filter=mail eq …`
  // needs no advanced-query headers and works with User.Read.All.
  const quoted = address.replace(/'/g, "''");
  const byMail = await graphRequest(`/users?$filter=${encodeURIComponent(`mail eq '${quoted}'`)}&$select=${select}&$top=1`);
  if (byMail.ok && byMail.json && Array.isArray(byMail.json.value) && byMail.json.value.length) {
    return { found: true, status: 'found', user: byMail.json.value[0], matchedBy: 'mail', requestId: byMail.requestId };
  }
  if (!byMail.ok) {
    const e2 = graphErrorToReason(byMail);
    // The direct call already gave a clean 404; if the alias probe failed for
    // an unrelated reason we must NOT upgrade that to a definitive "missing".
    return { found: false, status: 'unknown', reason: `direct lookup returned 404 but the alias probe failed — ${e2.reason}`, permissionIssue: e2.permissionIssue, httpStatus: e2.status, requestId: e2.requestId };
  }
  return { found: false, status: 'missing', reason: 'no directory object with this userPrincipalName or mail address', requestId: direct.requestId };
}

async function listSubscribedSkus() {
  const res = await graphRequest('/subscribedSkus?$select=skuId,skuPartNumber,capabilityStatus,consumedUnits,prepaidUnits');
  if (res.ok && res.json && Array.isArray(res.json.value)) return { ok: true, skus: res.json.value };
  const err = graphErrorToReason(res);
  return { ok: false, reason: err.reason, requestId: err.requestId, permissionIssue: err.permissionIssue };
}

/*
 * POST /v1.0/users — create the directory account.
 * ⚠ `password` is inside `body` and must never reach a log line or a response.
 *
 * `onTempPassword` is the ONLY way the generated password leaves this function.
 * It is a SINK, not a return value, on purpose: a return value would end up in
 * `created`, one careless `{ ...created }` away from the outcome object that is
 * serialised into the HTTP response. A sink can only reach the one caller that
 * deliberately supplies it. It fires ONLY after Graph confirmed the account was
 * created — a failed create has no account and therefore no credential to share.
 * The sink is invoked inside a try/catch so a throwing consumer can never turn a
 * successful provisioning run into a failure.
 */
async function createEntraUser({ userPrincipalName, displayName, mailNickname, givenName, surname }, onTempPassword) {
  const tempPassword = generateTempPassword();
  const body = {
    accountEnabled: true,
    displayName,
    mailNickname,
    userPrincipalName,
    usageLocation: usageLocation(),
    passwordProfile: {
      forceChangePasswordNextSignIn: true,
      password: tempPassword,
    },
  };
  /*
   * Only send a name field we actually have. Graph stores '' as a value, so an
   * unconditional `givenName` would write an empty string for a user whose CRM
   * name we could not split — indistinguishable in the admin centre from the
   * blank-fields bug this fixes, but now deliberate. See deriveIdentity().
   */
  if (givenName) body.givenName = givenName;
  if (surname) body.surname = surname;
  const res = await graphRequest('/users', { method: 'POST', body });
  if (res.ok && res.json && res.json.id) {
    // Deliberately logs the UPN and NOTHING from passwordProfile.
    logger.info('Entra account created · upn=' + userPrincipalName + ' · objectId=' + res.json.id);
    if (typeof onTempPassword === 'function') {
      try {
        onTempPassword(tempPassword);
      } catch (e) {
        // Never interpolate the password into this (or any) log line.
        logger.warn('Temp-password sink threw · upn=' + userPrincipalName + ' · ' + e.message);
      }
    }
    // NOTE: tempPassword is deliberately NOT on this object.
    return { ok: true, id: res.json.id, requestId: res.requestId };
  }
  const err = graphErrorToReason(res);
  return { ok: false, ...err };
}

/*
 * PATCH /v1.0/users/{id} — mint a FRESH temp password for an account that
 * already exists.
 *
 * WHY THIS EXISTS. The welcome mail has three gates, and a user whose first
 * provisioning run failed AFTER the account was created can never satisfy all
 * three: run 1 held the password but had no mailbox (GATE 1), and every later
 * run takes the REUSE branch, which mints nothing (GATE 3). Observed on
 * mohit.kumar@easyfix.in — account created 05:40:01, licence unconfirmed
 * 05:40:04, retry at 06:16 completed cleanly, and no credential mail was ever
 * sent to anyone. Without a way to issue a NEW password those users are
 * stranded permanently.
 *
 * ⚠ DELIBERATE ACTION ONLY. This is wired to its own admin endpoint
 * (POST /api/admin/users/:userId/reset-mailbox-password) and must NEVER become
 * a silent fallback inside the existing retry: resetting the password of an
 * account somebody is already using locks them out of Outlook and Teams.
 *
 * Same containment as createEntraUser: `onTempPassword` is a SINK and the only
 * exit. The value is inside `body`, is not returned, is not persisted, and no
 * log line in this function interpolates it. forceChangePasswordNextSignIn
 * stays true, so it is single-use.
 *
 * Graph answers 204 (no content) on success.
 */
async function resetEntraPassword(objectId, onTempPassword) {
  const id = String(objectId || '').trim();
  if (!id) return { ok: false, reason: 'no directory object id supplied' };

  const tempPassword = generateTempPassword();
  const res = await graphRequest(`/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: {
      passwordProfile: {
        forceChangePasswordNextSignIn: true,
        password: tempPassword,
      },
    },
  });
  if (res.ok) {
    // Deliberately logs the object id and NOTHING from passwordProfile.
    logger.info('Entra password reset · objectId=' + id);
    if (typeof onTempPassword === 'function') {
      try {
        onTempPassword(tempPassword);
      } catch (e) {
        // Never interpolate the password into this (or any) log line.
        logger.warn('Temp-password sink threw on reset · objectId=' + id + ' · ' + e.message);
      }
    }
    // NOTE: tempPassword is deliberately NOT on this object.
    return { ok: true, requestId: res.requestId };
  }
  const err = graphErrorToReason(res);
  return { ok: false, ...err };
}

/*
 * How long to keep RE-READING the user after Graph accepts the assignment.
 *
 * THIS NUMBER WAS THE BUG. It used to be two reads 1200ms apart, above a comment
 * claiming that was "enough for the normal case". It provably is not: Entra
 * licence propagation routinely takes tens of seconds. On user 8805
 * (mohit.kumar@easyfix.in) the account was created at 05:40:01, the seat was
 * assigned, and at 05:40:04 the read-back still could not see it — so we recorded
 * assigned_unconfirmed, skipped the welcome mail, and discarded the temp
 * password. Every later retry took the REUSE branch, which mints no password, so
 * that user could never be mailed by anyone. We were not detecting a failure; we
 * were giving up 1.2 seconds before the answer existed.
 *
 * So the wait is now EXPONENTIAL — 2s, 4s, 8s, 16s, 32s, capped per sleep — under
 * a total BUDGET, and it returns the instant the SKU is observed.
 *
 * WHY A BUDGET LONGER THAN THE HTTP RESPONSE IS SAFE. services/user.service.js
 * races provisioning against PROVISION_INLINE_DEADLINE_MS (20s) and, when the
 * deadline wins, answers welcome.status = PENDING with the words "the sign-in
 * details are mailed automatically if it completes" — while the SAME promise
 * carries on with the temp password still in its closure and its .then() still
 * calling sendWelcomeMail. Outliving the response is precisely what makes that
 * sentence true; no background job is needed. Do NOT "fix" this by raising the
 * inline deadline — the operator's request must still return in ~20s.
 *
 * ⚠ THE READ-BACK ITSELF IS UNCHANGED. Only its DURATION moved. A 2xx from
 * assignLicense still proves nothing (see assignLicense), and a budget that
 * expires still answers verified:false — accepted-but-unobservable stays its own
 * honest state and never becomes a mailbox.
 *
 * ⚠ RESIDUAL CASE, DELIBERATELY LEFT OPEN: a process restart mid-wait still
 * loses the mail. The credential exists only in memory while the account now
 * exists in the directory — exactly the stranded state above. The backoff
 * shortens that window, it cannot close it, and the recovery is
 * POST /api/admin/users/:userId/reset-mailbox-password, which mints a FRESH
 * password and re-sends (see resetEntraPassword).
 *
 * Read LAZILY, like every other config reader in this file (propBool,
 * configuredSkuPartNumber, managedDomains) rather than snapshotted at require
 * time: a module-load snapshot cannot be overridden by a host — or a test —
 * that sets the variable after this file is required, and the require graph here
 * is deep enough that "after" is easy to hit by accident. Floor-guarded exactly
 * like PROVISION_INLINE_DEADLINE_MS, so a typo'd 0 cannot silently disable the
 * read-back loop.
 */
function licenceVerifyBudgetMs() {
  return Math.max(1000, Number(process.env.ENTRA_LICENCE_VERIFY_BUDGET_MS) || 90000);
}
const LICENCE_VERIFY_FIRST_DELAY_MS = 2000;
const LICENCE_VERIFY_MAX_DELAY_MS = 32000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * Is `skuId` actually on the user's assignedLicenses RIGHT NOW?
 * Read-back, not inference — see assignLicense() for why that distinction is
 * the whole point here.
 */
async function holdsLicence(objectId, skuId) {
  const res = await graphRequest(`/users/${encodeURIComponent(objectId)}?$select=id,assignedLicenses`);
  if (!res.ok || !res.json || !Array.isArray(res.json.assignedLicenses)) {
    return { readable: false, held: false, requestId: res.requestId };
  }
  const want = String(skuId).toLowerCase();
  const held = res.json.assignedLicenses.some((l) => String(l && l.skuId).toLowerCase() === want);
  return { readable: true, held, requestId: res.requestId };
}

/*
 * assignLicense — and then CHECK THAT IT STUCK.
 *
 * THE BUG THIS EXISTS FOR. graphRequest sets `ok` from `res.ok`, which is true
 * for ANY 2xx — including 202 Accepted, which on assignLicense means "queued for
 * processing", not "the seat is on the user". We recorded `assigned` off that
 * and never looked again. On anand.thakur@easyfix.in the provisioning row said
 * `assigned` / O365_BUSINESS_ESSENTIALS while the admin centre showed no licence
 * ticked at all, and the account could not open anything until an admin assigned
 * it by hand. A 2xx told us Microsoft had heard the request. It never told us
 * Microsoft had honoured it.
 *
 * This is the same "accepted ≠ done" trap the header of this file documents for
 * mail (Graph 202-accepts a send to a mailbox that does not exist). Same lesson,
 * one API further along: when the provider offers a way to OBSERVE the end
 * state, observe it — do not infer it from the acknowledgement.
 *
 *   → { ok: true,  verified: true,  reads, waitedMs }   seat read back from Entra
 *   → { ok: true,  verified: false, reads, waitedMs }   Graph accepted it, seat never visible
 *   → { ok: false, reason }                             Graph refused it outright
 *
 * `opts` exists so the BOUND can be tested without a test that really sleeps for
 * the production budget — such a test gets deleted by the next person and takes
 * the guard with it. Production callers pass nothing.
 */
async function assignLicense(objectId, skuId, {
  budgetMs = licenceVerifyBudgetMs(),
  firstDelayMs = LICENCE_VERIFY_FIRST_DELAY_MS,
  maxDelayMs = LICENCE_VERIFY_MAX_DELAY_MS,
} = {}) {
  const res = await graphRequest(`/users/${encodeURIComponent(objectId)}/assignLicense`, {
    method: 'POST',
    body: { addLicenses: [{ skuId, disabledPlans: [] }], removeLicenses: [] },
  });
  if (!res.ok) {
    const err = graphErrorToReason(res);
    return { ok: false, ...err };
  }

  const budget = Math.max(0, Number(budgetMs) || 0);
  const startedAt = Date.now();
  let delay = Math.max(1, Number(firstDelayMs) || LICENCE_VERIFY_FIRST_DELAY_MS);
  let last = { readable: false, held: false };
  let reads = 0;

  /*
   * The FIRST read is immediate — a seat that is already visible must cost no
   * wait at all — and the loop returns the moment it is observed, so a fast
   * tenant is no slower than the old two-read version. Only the failing path
   * spends the budget. Each sleep is clamped to what is LEFT of the budget, so
   * the total wait is bounded by `budget` however the doubling lands.
   */
  for (;;) {
    last = await holdsLicence(objectId, skuId);
    reads++;
    if (last.held) {
      return {
        ok: true, verified: true, reads, waitedMs: Date.now() - startedAt,
        requestId: last.requestId || res.requestId,
      };
    }
    const left = budget - (Date.now() - startedAt);
    if (left <= 0) break;
    await sleep(Math.min(delay, left));
    delay = Math.min(delay * 2, Math.max(1, Number(maxDelayMs) || LICENCE_VERIFY_MAX_DELAY_MS));
  }

  // Accepted but not observable, even after waiting. Report it as such — the
  // caller records a status that does NOT claim a working mailbox.
  const waitedMs = Date.now() - startedAt;
  return {
    ok: true,
    verified: false,
    reads,
    waitedMs,
    requestId: last.requestId || res.requestId,
    reason: last.readable
      ? `Graph accepted the assignment (HTTP ${res.status}) but the SKU is still not on the user after `
        + `${reads} read-backs over ${Math.round(waitedMs / 1000)}s — check seat availability and usageLocation in the M365 admin centre`
      : `Graph accepted the assignment (HTTP ${res.status}) but the user could not be re-read to confirm the seat `
        + `in ${reads} attempts over ${Math.round(waitedMs / 1000)}s`,
  };
}

// ── OTP mailbox pre-check (Job 1b) ────────────────────────────────────────

/*
 * Short-TTL in-process cache so the login path doesn't add a Graph round-trip
 * per OTP. Positive answers are stable, so they live longer; negative and
 * unknown answers expire fast, so a mailbox created a minute ago starts being
 * used almost immediately and a transient outage doesn't stick.
 */
const EXISTS_TTL_MS  = 10 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const _mailboxCache = new Map(); // address → { at, status, reason }

function _cacheGet(address) {
  const hit = _mailboxCache.get(address);
  if (!hit) return null;
  const ttl = hit.status === 'exists' ? EXISTS_TTL_MS : NEGATIVE_TTL_MS;
  if (Date.now() - hit.at > ttl) { _mailboxCache.delete(address); return null; }
  return hit;
}

function _cacheSet(address, status, reason) {
  if (_mailboxCache.size >= MAX_CACHE_ENTRIES) {
    // Cheap bounded eviction — drop the oldest inserted key.
    const oldest = _mailboxCache.keys().next().value;
    if (oldest !== undefined) _mailboxCache.delete(oldest);
  }
  _mailboxCache.set(address, { at: Date.now(), status, reason });
}

function clearMailboxCache() { _mailboxCache.clear(); }

/**
 * Is there a mailbox behind this address?
 *
 *   { status: 'exists'     } → a MAIL-ENABLED directory object (see
 *                              directoryObjectHasMailbox); email is a real channel
 *   { status: 'no_mailbox' } → the directory object EXISTS but carries no mail
 *                              address and no SMTP proxy address. This is the
 *                              "account created, licence never assigned" state
 *                              the header describes — an object, no mailbox. It
 *                              does NOT suppress the send (the attributes can lag
 *                              a freshly licensed account), but the caller must
 *                              not count the send as a delivered channel, so the
 *                              WhatsApp/SMS fallback still runs.
 *   { status: 'missing'    } → clean 404 in a domain we own. The ONLY value that
 *                              suppresses the email channel outright.
 *   { status: 'unknown'    } → 401/403/429/5xx/timeout. FAIL OPEN: behave exactly
 *                              as before this check existed and attempt the email.
 *   { status: 'skipped'    } → check disabled, or the address is outside our
 *                              managed domains (personal Gmail etc.), so the
 *                              directory can say nothing useful about it.
 *
 * The fail-open-on-permission-errors rule is load-bearing: User.Read.All comes
 * with the User.ReadWrite.All consent that provisioning needs, and until an
 * admin grants it every call here answers 403. Treating that as "no mailbox"
 * would block OTP email for EVERY user the moment this shipped.
 */
async function mailboxExists(address) {
  const addr = String(address || '').trim().toLowerCase();
  if (!addr) return { status: 'skipped', reason: 'no address' };
  if (!mailboxPrecheckEnabled()) return { status: 'skipped', reason: 'pre-check disabled (' + PROP_PRECHECK + '=false)' };
  if (!isManagedDomain(addr)) {
    return { status: 'skipped', reason: 'address is outside the EasyFix-managed domains — the directory cannot confirm or deny it' };
  }

  const cached = _cacheGet(addr);
  if (cached) return { status: cached.status, reason: cached.reason, cached: true };

  const lookup = await findByUpn(addr);
  let out;
  if (lookup.found) {
    /*
     * FOUND ≠ HAS A MAILBOX. Reading `found` as 'exists' is exactly the bug this
     * whole feature was written to catch: a partially provisioned user (POST
     * /users succeeded, the licence step did not) would pass the pre-check, the
     * OTP email would be 202-accepted into a void and the fallback would never
     * fire. Consult the mail-enabled attributes findByUpn already fetched.
     */
    out = directoryObjectHasMailbox(lookup.user)
      ? { status: 'exists', reason: 'mail-enabled directory object found' }
      : {
        status: 'no_mailbox',
        reason: 'directory object exists but has no mail address and no SMTP proxy address '
          + '— the account is almost certainly unlicensed, so Exchange Online never provisioned a mailbox',
      };
  } else if (lookup.status === 'missing') {
    out = { status: 'missing', reason: lookup.reason || 'no such mailbox in the directory' };
  } else {
    out = { status: 'unknown', reason: lookup.reason || 'lookup inconclusive', permissionIssue: !!lookup.permissionIssue };
  }
  _cacheSet(addr, out.status, out.reason);
  return out;
}

// ── Persistence (tbl_user_entra_provisioning) ─────────────────────────────

// COALESCE(?, col) only guards NULL — '' would overwrite. Normalise first.
const nz = (v) => {
  const s = v === undefined || v === null ? '' : String(v).trim();
  return s === '' ? null : s;
};

/*
 * Upsert the one row per CRM user. ALWAYS called — including for
 * 'skipped: feature disabled' — because the whole point is that a missing
 * mailbox must be discoverable instead of silent.
 *
 * DATETIME columns are bound as `new Date()` (the pool runs at +05:30, so the
 * IST wall-clock is stored verbatim). Never SQL NOW() for application stamps.
 *
 * Fail-soft: a host that hasn't run the migration yet must still be able to
 * create users, so a missing table logs a warn and returns false.
 */
async function recordProvisioning({
  userId, userPrincipalName, entraObjectId, accountStatus, licenceStatus,
  skuPartNumber, lastError, graphRequestId, countAttempt = false,
}) {
  const now = new Date();
  try {
    await pool.query(
      `INSERT INTO tbl_user_entra_provisioning
         (user_id, user_principal_name, entra_object_id, account_status, licence_status,
          sku_part_number, last_error, graph_request_id, attempts, created_on, updated_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         user_principal_name = VALUES(user_principal_name),
         entra_object_id     = COALESCE(VALUES(entra_object_id), entra_object_id),
         account_status      = VALUES(account_status),
         licence_status      = VALUES(licence_status),
         sku_part_number     = COALESCE(VALUES(sku_part_number), sku_part_number),
         last_error          = VALUES(last_error),
         graph_request_id    = VALUES(graph_request_id),
         attempts            = attempts + VALUES(attempts),
         updated_on          = VALUES(updated_on)`,
      [
        Number(userId), nz(userPrincipalName), nz(entraObjectId),
        String(accountStatus), String(licenceStatus),
        nz(skuPartNumber), nz(lastError) ? String(lastError).slice(0, 500) : null, nz(graphRequestId),
        countAttempt ? 1 : 0, now, now,
      ],
    );
    return true;
  } catch (e) {
    logger.warn('Could not record Entra provisioning outcome · userId=' + userId + ' · ' + (e.code || e.message)
      + ' — has migrations/2026-07-30-create-tbl-user-entra-provisioning.sql been applied?');
    return false;
  }
}

/** Current recorded provisioning state for a CRM user (null when never run). */
async function getProvisioning(userId) {
  try {
    const [[row]] = await pool.query(
      `SELECT id, user_id, user_principal_name, entra_object_id, account_status,
              licence_status, sku_part_number, last_error, graph_request_id,
              attempts, created_on, updated_on
         FROM tbl_user_entra_provisioning
        WHERE user_id = ?
        LIMIT 1`,
      [Number(userId)],
    );
    if (!row) return null;
    row.mailbox_ready = mailboxLikelyExists(row.account_status, row.licence_status);
    return row;
  } catch (e) {
    logger.warn('Could not read Entra provisioning state · userId=' + userId + ' · ' + (e.code || e.message));
    return null;
  }
}

// ── Orchestrator ──────────────────────────────────────────────────────────

/**
 * Provision (or repair) the Microsoft 365 mailbox for one CRM user.
 *
 * NEVER throws and NEVER participates in the caller's transaction — CRM user
 * creation must succeed whether or not Azure is reachable. The return value is
 * the outcome, and the same outcome is persisted.
 *
 * @param {Object}  args
 * @param {number}  args.userId          tbl_user.user_id
 * @param {string}  args.userName        tbl_user.user_name  (→ displayName)
 * @param {string}  args.officialEmail   tbl_user.official_email (→ UPN)
 * @param {string} [args.trigger]        'create-user' | 'admin-retry' (logs only)
 * @param {number} [args.actorId]        who triggered it (logs only)
 * @param {Function} [args.onTempPassword]
 *        Sink for the temp password of a NEWLY created account. Called at most
 *        once, only on the create path, only after Graph confirmed the account.
 *        The value is NOT on the returned outcome (which is published in the
 *        API response) and is NOT written to tbl_user_entra_provisioning — the
 *        sink is the single exit. Omit it and the password is generated,
 *        used in the Graph body, and dropped exactly as before.
 * @param {Object} [args.licenceVerify]
 *        Overrides for the licence read-back backoff ({ budgetMs, firstDelayMs,
 *        maxDelayMs }) — forwarded verbatim to assignLicense. Exists so a test
 *        can prove the wait is bounded without sleeping the real budget.
 *        Production callers omit it.
 */
async function provisionUserMailbox({
  userId, userName, officialEmail, trigger = 'create-user', actorId, onTempPassword,
  licenceVerify,
} = {}) {
  const base = {
    userId: Number(userId),
    trigger,
    userPrincipalName: String(officialEmail || '').trim().toLowerCase() || null,
    entraObjectId: null,
    skuPartNumber: null,
    graphRequestId: null,
  };

  /*
   * The per-person `access.entraprovision.emails` gate that used to sit here
   * was REMOVED (2026-08-03). It fails closed on an unset property, and the
   * property was never set in production, so every Add User recorded
   * skipped_not_allowed and no mailbox was ever created — while the repair
   * endpoint it pointed people at was gated by the same empty list. The
   * authority is the roleByName(['Admin']) on both routes; the master switch is
   * entra.provisioning.enabled, checked above.
   *
   * ACCOUNT_STATUS.SKIPPED_NOT_ALLOWED is deliberately KEPT in the vocabulary:
   * historical rows still carry it (e.g. user 8735) and must stay readable.
   * Nothing writes it any more.
   */

  // 1 ── FAIL-CLOSED GATE. Recorded, not silent: an operator looking at the
  //      row must be able to tell "nobody tried" from "it failed".
  if (!provisioningEnabled()) {
    const outcome = {
      ...base,
      attempted: false,
      accountStatus: ACCOUNT_STATUS.SKIPPED_DISABLED,
      licenceStatus: LICENCE_STATUS.SKIPPED,
      mailboxReady: false,
      reason: `mailbox provisioning is off — set easyfix_properties["${PROP_ENABLED}"] = 'true' to enable it`,
    };
    logger.info('Entra provisioning skipped (feature off) · userId=' + userId + ' · trigger=' + trigger);
    await recordProvisioning({ ...outcome, lastError: outcome.reason });
    return outcome;
  }

  // 2 ── Identity. Refuses addresses we cannot own a mailbox for.
  const ident = deriveIdentity({ user_name: userName, official_email: officialEmail });
  if (!ident.ok) {
    const outcome = {
      ...base,
      attempted: false,
      accountStatus: ident.accountStatus,
      licenceStatus: LICENCE_STATUS.NOT_ATTEMPTED,
      mailboxReady: false,
      reason: ident.reason,
    };
    logger.warn('Entra provisioning not possible · userId=' + userId + ' · ' + ident.reason);
    await recordProvisioning({ ...outcome, lastError: ident.reason });
    return outcome;
  }
  base.userPrincipalName = ident.userPrincipalName;

  logger.info('Entra provisioning start · userId=' + userId + ' · upn=' + ident.userPrincipalName
    + ' · trigger=' + trigger + (actorId ? ' · actorId=' + actorId : ''));

  // 3 ── IDEMPOTENCY: look before you leap. Also pulls assignedLicenses so a
  //      re-run on an already-licensed account is a no-op.
  /*
   * What this user_id ALREADY owns in the directory, read before the lookup so
   * the decision below can tell our own retry from a collision with a different
   * person's mailbox. getProvisioning is fail-soft (null on a missing table or
   * a read error), and null means "we have no recorded claim on this address" —
   * the conservative direction, which refuses rather than reuses.
   */
  const recorded = await getProvisioning(userId);
  const recordedObjectId = (recorded && recorded.entra_object_id) || null;

  const lookup = await findByUpn(ident.userPrincipalName, {
    select: 'id,mail,userPrincipalName,accountEnabled,assignedLicenses',
  });
  const decision = decideAccountAction(lookup, { recordedObjectId });

  let accountStatus;
  let entraObjectId = null;
  let graphRequestId = lookup.requestId || null;
  let accountError = null;

  if (decision.action === 'abort') {
    const outcome = {
      ...base,
      attempted: true,
      accountStatus: ACCOUNT_STATUS.FAILED,
      licenceStatus: LICENCE_STATUS.NOT_ATTEMPTED,
      mailboxReady: false,
      reason: `directory lookup failed, refusing to create blind — ${decision.reason}`,
      graphRequestId,
    };
    logger.error('Entra provisioning aborted · userId=' + userId + ' · ' + outcome.reason);
    await recordProvisioning({ ...outcome, lastError: outcome.reason, countAttempt: true });
    return outcome;
  }

  /*
   * COLLISION — the address exists in the directory and it is not ours. Nothing
   * is written: no account, no licence, and crucially no entra_object_id, since
   * `base.entraObjectId` is still null and recording the stranger's id against
   * this user_id is the exact damage being prevented. The operator's fix is a
   * different official email — POST /api/admin/users/check-official-email will
   * suggest the next free numbered one.
   */
  if (decision.action === 'collision') {
    const outcome = {
      ...base,
      attempted: true,
      accountStatus: ACCOUNT_STATUS.COLLISION,
      licenceStatus: LICENCE_STATUS.NOT_ATTEMPTED,
      mailboxReady: false,
      reason: decision.reason,
      graphRequestId,
    };
    logger.error('Entra provisioning refused — UPN belongs to another directory object · userId=' + userId
      + ' · upn=' + ident.userPrincipalName + ' · ' + decision.reason);
    await recordProvisioning({ ...outcome, lastError: decision.reason, countAttempt: true });
    return outcome;
  }

  if (decision.action === 'reuse') {
    accountStatus = ACCOUNT_STATUS.ALREADY_EXISTS;
    entraObjectId = decision.entraObjectId || null;
    logger.info('Entra account already exists — not creating a second one · upn=' + ident.userPrincipalName);
  } else {
    // The sink rides along ONLY on the create path — the reuse branch above
    // mints nothing, so there is no credential to hand out for an account that
    // already existed (see GATE 3 in services/user-welcome-mail.service.js).
    const created = await createEntraUser(ident, onTempPassword);
    if (created.ok) {
      accountStatus = ACCOUNT_STATUS.CREATED;
      entraObjectId = created.id;
      graphRequestId = created.requestId || graphRequestId;
    } else if (created.alreadyExists) {
      /*
       * Lost a race (or an alias we couldn't see). Re-resolve rather than fail.
       *
       * NOT the collision case, despite there being no recorded object id: the
       * lookup a moment ago was a DEFINITIVE miss, so the object appeared
       * between that read and this write — which in practice is our own second
       * concurrent attempt for this same user (a double-clicked Provision
       * Mailbox). A different employee's long-standing mailbox would have been
       * seen by the lookup and stopped at the collision branch above.
       */
      const again = await findByUpn(ident.userPrincipalName, { select: 'id,mail,userPrincipalName,assignedLicenses' });
      accountStatus = again.found ? ACCOUNT_STATUS.ALREADY_EXISTS : ACCOUNT_STATUS.FAILED;
      entraObjectId = again.found ? again.user.id : null;
      accountError = again.found ? null : created.reason;
      graphRequestId = created.requestId || graphRequestId;
    } else {
      accountStatus = ACCOUNT_STATUS.FAILED;
      accountError = created.reason;
      graphRequestId = created.requestId || graphRequestId;
    }
  }

  if (accountStatus === ACCOUNT_STATUS.FAILED || !entraObjectId) {
    const reason = accountError || 'account creation did not return a directory object id';
    const outcome = {
      ...base,
      attempted: true,
      accountStatus: ACCOUNT_STATUS.FAILED,
      licenceStatus: LICENCE_STATUS.NOT_ATTEMPTED,
      mailboxReady: false,
      reason,
      graphRequestId,
    };
    logger.error('Entra account step failed · userId=' + userId + ' · upn=' + ident.userPrincipalName + ' · ' + reason);
    await recordProvisioning({ ...outcome, lastError: reason, countAttempt: true });
    return outcome;
  }
  base.entraObjectId = entraObjectId;

  // 4 ── LICENCE — a SEPARATE outcome. Without it the account exists in the
  //      directory and NO mailbox is ever provisioned in Exchange Online.
  const wanted = configuredSkuPartNumber();
  const alreadyHeld = (lookup.found && lookup.user && Array.isArray(lookup.user.assignedLicenses))
    ? lookup.user.assignedLicenses.map((l) => String(l && l.skuId || '').toLowerCase())
    : [];

  let licenceStatus = LICENCE_STATUS.NOT_ATTEMPTED;
  let licenceReason = null;
  let skuPartNumber = null;

  if (!wanted) {
    const p = pickSku([], '');
    licenceStatus = p.status;
    licenceReason = p.reason;
  } else {
    const skuList = await listSubscribedSkus();
    if (!skuList.ok) {
      licenceStatus = LICENCE_STATUS.FAILED;
      licenceReason = `could not read subscribed SKUs — ${skuList.reason}`;
      graphRequestId = skuList.requestId || graphRequestId;
    } else {
      const chosen = pickSku(skuList.skus, wanted);
      skuPartNumber = chosen.skuPartNumber || wanted;
      if (!chosen.ok) {
        licenceStatus = chosen.status;
        licenceReason = chosen.reason;
      } else if (alreadyHeld.includes(String(chosen.skuId).toLowerCase())) {
        licenceStatus = LICENCE_STATUS.ALREADY_LICENSED;
        licenceReason = `already holds ${chosen.skuPartNumber}`;
      } else {
        const assigned = await assignLicense(entraObjectId, chosen.skuId, licenceVerify);
        graphRequestId = assigned.requestId || graphRequestId;
        if (assigned.ok && assigned.verified) {
          licenceStatus = LICENCE_STATUS.ASSIGNED;
          logger.info('Entra licence assigned + verified · upn=' + ident.userPrincipalName + ' · sku=' + chosen.skuPartNumber);
        } else if (assigned.ok) {
          /*
           * Accepted, not observed. WARN — this is the state that previously
           * recorded a clean `assigned` and sent a new joiner to a mailbox they
           * could not open. Distinct status so the row is findable and the
           * repair endpoint can be re-run against exactly these users.
           */
          licenceStatus = LICENCE_STATUS.ASSIGNED_UNCONFIRMED;
          licenceReason = assigned.reason;
          logger.warn('Entra licence NOT confirmed · upn=' + ident.userPrincipalName
            + ' · sku=' + chosen.skuPartNumber + ' · ' + assigned.reason);
        } else {
          licenceStatus = LICENCE_STATUS.FAILED;
          licenceReason = `licence assignment failed — ${assigned.reason}`;
        }
      }
    }
  }

  const mailboxReady = mailboxLikelyExists(accountStatus, licenceStatus);
  const outcome = {
    ...base,
    attempted: true,
    accountStatus,
    licenceStatus,
    skuPartNumber,
    mailboxReady,
    graphRequestId,
    reason: licenceReason || (mailboxReady ? 'account and licence in place' : null),
  };

  if (mailboxReady) {
    logger.info('Entra provisioning complete · userId=' + userId + ' · upn=' + ident.userPrincipalName
      + ' · account=' + accountStatus + ' · licence=' + licenceStatus);
  } else {
    // The exact state that produced the reported bug: directory account, no
    // mailbox. Warn loudly with the address so ops can find it.
    logger.warn('Entra provisioning INCOMPLETE — account without a mailbox · userId=' + userId
      + ' · upn=' + ident.userPrincipalName + ' · account=' + accountStatus + ' · licence=' + licenceStatus
      + (licenceReason ? ' · ' + licenceReason : '')
      + (graphRequestId ? ' · graph-request-id=' + graphRequestId : ''));
  }

  // A freshly provisioned (or repaired) mailbox must not stay negatively
  // cached in the OTP pre-check.
  _mailboxCache.delete(ident.userPrincipalName);

  await recordProvisioning({ ...outcome, lastError: licenceReason || accountError, countAttempt: true });
  return outcome;
}

module.exports = {
  // orchestrator + persistence
  provisionUserMailbox,
  getProvisioning,
  recordProvisioning,
  // OTP pre-check
  mailboxExists,
  clearMailboxCache,
  // Add User pre-flight (availability + numbered suggestion)
  isUpnAvailable,
  suggestAvailableUpn,
  // graph calls
  findByUpn,
  createEntraUser,
  resetEntraPassword,
  assignLicense,
  listSubscribedSkus,
  // pure helpers (unit-tested)
  generateTempPassword,
  deriveIdentity,
  graphErrorToReason,
  decideAccountAction,
  pickSku,
  isManagedDomain,
  mailboxLikelyExists,
  directoryObjectHasMailbox,
  // config readers
  provisioningEnabled,
  mailboxPrecheckEnabled,
  configuredSkuPartNumber,
  licenceVerifyBudgetMs,
  managedDomains,
  // vocabularies + property keys
  ACCOUNT_STATUS,
  LICENCE_STATUS,
  PROP_ENABLED,
  PROP_SKU,
  PROP_DOMAINS,
  PROP_PRECHECK,
};
