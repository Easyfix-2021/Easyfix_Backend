const { pool } = require('../db');
const logger = require('../logger');
const { todayIst } = require('../utils/ist-calendar');
const {
  encryptField, decryptField, maskAccountNumber, maskName,
} = require('../lib/field-crypto');

/*
 * profile-self.service — the SELF-SERVICE half of HRMS "My Profile".
 *
 * Backs /api/profile/* (routes/profile.js). Every function here takes the
 * caller's OWN user id, resolved by the route from req.user.user_id and never
 * from the path, the query or the body — that is the entire security boundary
 * of this feature. /api/profile is reachable by EVERY authenticated CRM user
 * (unlike /api/admin/users, which is Admin-gated), so a `:userId` anywhere in
 * this surface would be a self-serve edit of any colleague's record.
 *
 * Two write paths live here, and only two:
 *   PATCH /alternate-no    — free-form, no approval. The alternate number is a
 *                            convenience contact, not an identity key, and it
 *                            can be CLEARED ('' or null → NULL) without one.
 *   POST  /date-of-birth   — the ONE FREE SET. Writes directly only while the
 *                            stored value is NULL; after that the user must go
 *                            through profile-update-request.service.
 * Everything else (mobile, a DOB correction, bank) is HR-approved.
 *
 * BANK HAS NO EQUIVALENT FREE FIRST SET, and that is deliberate. A user with no
 * bank details on record still raises an approval request to ADD them: the
 * payout path reads those columns, so the first write is exactly as
 * money-adjacent as every later one. The date-of-birth exemption is a
 * convenience for a fact nobody is paid against, and it does not transfer.
 *
 * This module also owns the FIELD RULES (validateMobile / validateDateOfBirth /
 * normaliseBank) because they are needed in three places — the free set, the
 * request submission, and the re-validation at approve time. They are exported
 * and imported by profile-update-request.service so there is exactly one
 * definition of "what a valid date of birth is". A second copy would drift, and
 * the copy that drifts is the one at approve time, which is the one that writes.
 *
 * Errors throw { status, code, message } (the withdrawal.service shape) so the
 * route can surface e.status + a machine `code` the FE branches on.
 */

function mkErr(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

// ─── FIELD RULES — the single definition (contract §Validation) ──────
/*
 * The canonical Indian-mobile rule, matching the CRM's INDIAN_MOBILE_REGEX in
 * src/lib/format.ts and the tightened Joi patterns in routes/admin/users.js.
 *
 * This was briefly the loose /^[0-9]{10}$/, on the reasoning that a client
 * check tighter than the server's rejects values the server accepts. That was
 * the right instinct applied to the wrong side of the mismatch: the answer is
 * to tighten the SERVER, not to loosen the rule. tbl_user.mobile_no is an OTP
 * login channel, and an Indian mobile starts 6-9 — a number outside that range
 * cannot receive an SMS, so accepting one stores a value that silently costs
 * the employee one of their two ways into the CRM.
 */
const MOBILE_RE = /^[6-9][0-9]{9}$/;
const IFSC_RE   = /^[A-Za-z]{4}0[A-Za-z0-9]{6}$/;
const DOB_RE    = /^\d{4}-\d{2}-\d{2}$/;
const MIN_AGE = 15;
const MAX_AGE = 100;
// Account numbers vary wildly by bank (9–18 is the usual range); the column is
// VARCHAR(32). Alphanumeric only, so a pasted "1234 5678" or "A/c 1234" is
// rejected at the boundary rather than stored and failing at payout time.
const ACCOUNT_NUMBER_RE = /^[0-9A-Za-z]{6,32}$/;
const BANK_KEYS = ['account_number', 'ifsc', 'account_name', 'bank_name'];

/*
 * 'YYYY-MM-DD' shifted by whole years, for the age bounds. Feb 29 shifted into
 * a non-leap year lands on Mar 1 — a one-day slop on a 15/100-year boundary,
 * which is not worth a calendar library.
 */
function shiftYears(ymd, delta) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y + delta, m - 1, d)).toISOString().slice(0, 10);
}

/** 10 digits, or throw. `label` names the offending field in the message. */
function validateMobile(raw, label = 'mobile_no') {
  const v = String(raw ?? '').trim();
  if (!MOBILE_RE.test(v)) {
    throw mkErr(400, 'INVALID_MOBILE', `${label} must be exactly 10 digits`);
  }
  return v;
}

/*
 * 'YYYY-MM-DD', a real calendar date, not in the future, age 15..100.
 * The round-trip check is what rejects 2026-02-30 — it matches DOB_RE and
 * Date.UTC silently rolls it over to Mar 2.
 * Accepts a value that arrives with a time component (a DATE column read back
 * through a driver that appends one) by taking the first 10 characters.
 */
function validateDateOfBirth(raw) {
  const v = String(raw ?? '').trim().slice(0, 10);
  if (!DOB_RE.test(v)) {
    throw mkErr(400, 'INVALID_DOB', 'date_of_birth must be a date in YYYY-MM-DD format');
  }
  const parsed = new Date(`${v}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== v) {
    throw mkErr(400, 'INVALID_DOB', `date_of_birth "${v}" is not a real calendar date`);
  }
  // IST "today" — the CRM's clock. A UTC `new Date()` would call the Indian
  // morning of the 1st "yesterday" for five and a half hours.
  const today = todayIst();
  if (v > today) {
    throw mkErr(400, 'DOB_IN_FUTURE', 'date_of_birth cannot be in the future');
  }
  if (v > shiftYears(today, -MIN_AGE)) {
    throw mkErr(400, 'DOB_TOO_RECENT', `date_of_birth must be at least ${MIN_AGE} years ago`);
  }
  if (v < shiftYears(today, -MAX_AGE)) {
    throw mkErr(400, 'DOB_TOO_OLD', `date_of_birth cannot be more than ${MAX_AGE} years ago`);
  }
  return v;
}

/*
 * Bank details are ONE value, not four. All four fields are required together
 * and are approved or rejected as a unit — a half-applied account (new number,
 * old IFSC) is a failed payout, so there is no partial write anywhere in this
 * feature. Returns the normalised object; IFSC is upper-cased because that is
 * how every bank prints it and two casings must not read as two accounts.
 */
function normaliseBank(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw mkErr(400, 'INVALID_BANK', 'bank must be an object with all four fields');
  }
  const unknown = Object.keys(raw).filter((k) => !BANK_KEYS.includes(k));
  if (unknown.length) {
    throw mkErr(400, 'INVALID_BANK', `bank has unknown field(s): ${unknown.join(', ')}`);
  }
  const out = {};
  for (const key of BANK_KEYS) {
    const v = String(raw[key] ?? '').trim();
    if (!v) throw mkErr(400, 'INVALID_BANK', `bank.${key} is required`);
    out[key] = v;
  }
  if (!ACCOUNT_NUMBER_RE.test(out.account_number)) {
    throw mkErr(400, 'INVALID_BANK', 'bank.account_number must be 6-32 letters or digits');
  }
  if (!IFSC_RE.test(out.ifsc)) {
    throw mkErr(400, 'INVALID_BANK', `bank.ifsc "${out.ifsc}" is not a valid IFSC code`);
  }
  out.ifsc = out.ifsc.toUpperCase();
  if (out.account_name.length > 120) {
    throw mkErr(400, 'INVALID_BANK', 'bank.account_name must be 120 characters or fewer');
  }
  if (out.bank_name.length > 120) {
    throw mkErr(400, 'INVALID_BANK', 'bank.bank_name must be 120 characters or fewer');
  }
  return out;
}

/*
 * TEXT column → object, or null when the column is empty/corrupt. Null is the
 * signal, not `{}`: an unparseable `changes` payload must be distinguishable
 * from "no changes" so the approve path can refuse to apply it instead of
 * silently applying nothing and flipping the request to approved.
 */
function parseJson(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/*
 * DATETIME → 'YYYY-MM-DD HH:mm:ss', the IST wall clock exactly as stored.
 *
 * The pool runs dateStrings:true with session timezone +05:30, so these columns
 * already arrive in that shape and this is a normaliser, not a converter. It
 * exists to make the invariant explicit and unbreakable: NEVER hand these
 * through `new Date()` / `.toISOString()` on the way out. The containers run
 * UTC, so that round trip shifts every displayed timestamp by 5h30m — the
 * classic IST rendering bug — and appends a Z that claims the value is UTC.
 */
function istTimestamp(value) {
  if (value == null || value === '') return null;
  return String(value).slice(0, 19).replace('T', ' ');
}

// The personal-details columns this feature reads. tbl_user_personal_details is
// EasyFix-owned; the five bank_* columns and date_of_birth are added by the
// HRMS migration alongside the pre-existing personal_email.
const PERSONAL_COLUMNS = `personal_email, date_of_birth,
         bank_account_number, bank_ifsc, bank_account_name, bank_name,
         bank_account_last4,
         date_of_joining, uan, address, pan_last4, aadhaar_last4`;

/*
 * The column list as it stood BEFORE the 2026-09-02 identifier migration, and
 * the reason it still exists: this service deploys through GitHub Actions and
 * the migration is applied by hand, so there is a real window — minutes on a
 * good day — in which this code is live and the five columns are not. A plain
 * SELECT of them in that window is ER_BAD_FIELD_ERROR, and it would take out
 * the ENTIRE profile page (name, bank, everything) over five optional fields
 * that are blank on every row anyway.
 *
 * readPersonalRow() below tries the full list once, falls back to this one on
 * 1054, and logs. Delete both this constant and the fallback once the
 * migration is applied everywhere — it is scaffolding with an expiry date, not
 * a permanent compatibility layer.
 */
const PERSONAL_COLUMNS_PRE_IDENTIFIERS = `personal_email, date_of_birth,
         bank_account_number, bank_ifsc, bank_account_name, bank_name,
         bank_account_last4`;

/*
 * MySQL "unknown column" — 1054. Narrower than catching everything: a genuine
 * connection failure or a syntax error must still surface.
 */
function isMissingIdentifierColumn(err) {
  return Boolean(err) && (err.code === 'ER_BAD_FIELD_ERROR' || err.errno === 1054);
}

async function readPersonalRow(userId, runner) {
  try {
    const [[row]] = await runner.query(
      `SELECT ${PERSONAL_COLUMNS} FROM tbl_user_personal_details WHERE user_id = ? LIMIT 1`,
      [Number(userId)],
    );
    return row;
  } catch (e) {
    if (!isMissingIdentifierColumn(e)) throw e;
    logger.warn('Profile identifier columns are missing on this host · userId=' + userId
      + ' — apply migrations/2026-09-02-add-hr-identifiers-user-personal-details.sql');
    const [[row]] = await runner.query(
      `SELECT ${PERSONAL_COLUMNS_PRE_IDENTIFIERS} FROM tbl_user_personal_details WHERE user_id = ? LIMIT 1`,
      [Number(userId)],
    );
    return row;
  }
}

/*
 * NOTE WHAT IS ABSENT: `pan` and `aadhaar` themselves. Only their clear
 * last4 columns are selected, because this projection feeds the profile page
 * and there is no path on it that may return either plaintext. Selecting the
 * ciphertext "just in case" would put it one careless spread away from the
 * response body — the same reasoning that keeps bank_account_number out of
 * every payload except the audited reveal.
 */

/*
 * ═══════════════════════════════════════════════════════════════════════
 * BANK DETAILS AT REST — THREE SHAPES, AND THE RULE FOR EACH
 * ═══════════════════════════════════════════════════════════════════════
 *
 * A bank object exists in exactly three forms in this feature, and mixing them
 * up is how a secret leaks. They are named consistently everywhere:
 *
 *   PLAIN    { account_number, ifsc, account_name, bank_name }
 *            What the user typed and what normaliseBank() validates. Exists
 *            ONLY inside a request/response cycle. NEVER written to a column,
 *            NEVER written into request JSON, NEVER put in a log line.
 *
 *   STORED   { account_number: '<v1:…>', ifsc, account_name: '<v1:…>',
 *              bank_name, account_last4 }
 *            What sits in tbl_user_personal_details AND inside the `changes` /
 *            `old_values` JSON of tbl_user_profile_update_request. The account
 *            number and the holder name are AES-256-GCM ciphertext; the IFSC,
 *            the bank name and the last four digits are clear on purpose.
 *
 *   MASKED   { account_number_masked, account_name_masked, ifsc, bank_name,
 *              has_details }
 *            The ONLY shape that crosses the wire by default — from
 *            GET /api/profile/details, from the HR approvals list, from
 *            everywhere. Never the ciphertext: "it is encrypted" is not a
 *            reason to ship a decryptable secret to a browser, it is one
 *            config leak away from being the plaintext.
 *
 * ── THE MISTAKE THIS LAYOUT EXISTS TO PREVENT ───────────────────────────
 * Encrypting the COLUMN and forgetting the request JSON. The pending queue
 * holds the same account number, in a table with no masking in front of it, and
 * an attacker reads that instead. So encryptBank/decryptBank are used at BOTH
 * write sites, and there is no path that JSON.stringify()s a PLAIN bank.
 */

/*
 * A tbl_user_personal_details row → the STORED bank shape. The columns already
 * hold ciphertext, so this is a projection, not a conversion: it is what gets
 * copied verbatim into an `old_values` snapshot, with no decrypt/re-encrypt
 * round trip (which would buy nothing and add a failure point on a path whose
 * only job is to remember what was there).
 */
function bankFromRow(row) {
  return {
    account_number: (row && row.bank_account_number) || null,
    ifsc:           (row && row.bank_ifsc) || null,
    account_name:   (row && row.bank_account_name) || null,
    bank_name:      (row && row.bank_name) || null,
    account_last4:  (row && row.bank_account_last4) || null,
  };
}

/*
 * PLAIN → STORED. Throws if EASYFIX_FIELD_ENC_KEY is missing or malformed —
 * see lib/field-crypto.js. There is deliberately no branch here that stores the
 * plaintext when encryption is unavailable: the write fails, loudly, and the
 * operator sets the key.
 *
 * `account_last4` is derived HERE, from the plaintext, and is the only part of
 * the number that stays readable. Deriving it later would mean decrypting on
 * every list render.
 */
function encryptBank(plain) {
  return {
    account_number: encryptField(plain.account_number),
    ifsc:           plain.ifsc,
    account_name:   encryptField(plain.account_name),
    bank_name:      plain.bank_name,
    account_last4:  String(plain.account_number).slice(-4),
  };
}

/*
 * STORED → PLAIN. Used on exactly two paths: the approve-time re-validation
 * (normaliseBank rejects a ciphertext, and rightly so) and the two audited
 * reveal endpoints. Throws on a missing key, a tampered value or anything that
 * is not a v1 envelope — it never returns the stored bytes as if they were a
 * number.
 */
function decryptBank(stored) {
  if (!stored || typeof stored !== 'object') return null;
  return {
    account_number: decryptField(stored.account_number),
    ifsc:           stored.ifsc || null,
    account_name:   decryptField(stored.account_name),
    bank_name:      stored.bank_name || null,
  };
}

/*
 * STORED → MASKED, and it CANNOT throw.
 *
 * This runs on every profile read and on every row of the HR queue, so a
 * missing key or one corrupt row must not take a whole page down — but it also
 * must not degrade into showing the value. A name that will not decrypt yields
 * null and an error log; nothing else changes. That is still refusing: no
 * plaintext and no ciphertext leaves this function on any path.
 *
 * The account number needs no decryption at all — the masked form is built from
 * the clear last-four column, which is the entire reason that column exists.
 */
function maskBank(stored) {
  const s = (stored && typeof stored === 'object') ? stored : {};
  let accountNameMasked = null;
  if (s.account_name) {
    try {
      accountNameMasked = maskName(decryptField(s.account_name));
    } catch (e) {
      logger.error('Bank account name could not be decrypted for display · ' + e.message);
    }
  }
  return {
    account_number_masked: s.account_last4 ? maskAccountNumber(s.account_last4) : null,
    account_name_masked:   accountNameMasked,
    ifsc:                  s.ifsc || null,
    bank_name:             s.bank_name || null,
    has_details:           Boolean(s.account_number),
  };
}

/*
 * A `changes` / `old_values` object with its bank block masked. Applied at
 * EVERY point one of those objects becomes a response — the self profile's
 * pending strip, the HR list, the row echoed back after approve/reject — so
 * there is no reader that has to remember to do it.
 */
function maskChangesBank(obj) {
  if (!obj || typeof obj !== 'object' || !obj.bank) return obj;
  return { ...obj, bank: maskBank(obj.bank) };
}

/*
 * One audit row per REVEAL, written on the caller's connection so it lands
 * inside the same transaction as the read and BEFORE the response is sent.
 *
 * `conn` is required and is deliberately NOT defaulted to the pool: an audit
 * written on a different connection is an audit that can commit while the read
 * rolls back, or survive while the read fails — and one written after the
 * response is the one that is missing exactly when the process dies mid-request.
 * Making the connection an explicit argument is what stops that being an easy
 * mistake at the next call site.
 */
async function recordReveal(conn, { actorUserId, subjectUserId, context, refId = null, ipAddress = null }) {
  await conn.query(
    `INSERT INTO tbl_sensitive_reveal_log
       (actor_user_id, subject_user_id, context, ref_id, ip_address, revealed_on)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [Number(actorUserId), Number(subjectUserId), String(context),
      refId == null ? null : Number(refId),
      /*
       * Truncated rather than rejected. The column is VARCHAR(64) and a
       * forwarded-for chain can run longer; on a non-STRICT MySQL an oversized
       * value truncates silently, and on a strict one it would throw and take
       * the whole reveal transaction — and therefore the audit row — with it.
       * Losing the row is the worse outcome of the two, so the address is
       * clipped and the reveal still records.
       */
      ipAddress == null ? null : String(ipAddress).slice(0, 64),
      new Date()],
  );
  logger.warn('Sensitive bank reveal · actor=' + actorUserId + ' subject=' + subjectUserId
    + ' context=' + context + ' ref=' + (refId ?? '-'));
}

/*
 * GET /api/profile/details — everything My Profile renders.
 *
 * Three statements rather than one join: a join that throws takes the whole
 * response with it, and these are three independent facts about one user.
 *
 * `pending` is at most ONE request (contract: ONE OPEN REQUEST PER USER) and is
 * returned as an object or null, not a list.
 */
async function getMyProfile(userId, runner = pool) {
  const [[user]] = await runner.query(
    'SELECT user_code, mobile_no, alternate_no FROM tbl_user WHERE user_id = ? LIMIT 1',
    [userId],
  );
  if (!user) throw mkErr(404, 'USER_NOT_FOUND', 'User not found');

  const personal = await readPersonalRow(userId, runner);
  const [[pending]] = await runner.query(
    `SELECT request_id, changes, old_values, requested_on, updated_on
       FROM tbl_user_profile_update_request
      WHERE user_id = ? AND status = 'pending'
      ORDER BY request_id DESC LIMIT 1`,
    [userId],
  );

  const dob = personal && personal.date_of_birth
    ? String(personal.date_of_birth).slice(0, 10)
    : null;

  /*
   * The avatar, resolved here so My Profile renders in ONE round trip instead
   * of loading, then discovering it has a photo, then fetching it — which shows
   * every returning user their own initials for a beat before the picture
   * appears.
   *
   * FAIL-SOFT, deliberately, and it is the only fail-soft read on this endpoint.
   * A presign needs S3 to be configured and reachable; an environment without it
   * (or a transient failure) must cost the user their avatar, not their whole
   * profile page. Every other field here comes from the database and has no such
   * dependency, so nothing else earns the same treatment.
   *
   * Required inside the function rather than at module scope: profile-photo
   * requires this module for nothing today, but a lazy require keeps that true
   * even if it ever does.
   */
  let photoUrl = null;
  try {
    // eslint-disable-next-line global-require
    const photos = require('./profile-photo.service');
    const shot = await photos.getPhoto(userId, runner);
    photoUrl = (shot && shot.url) || null;
  } catch (e) {
    // 404 NO_PROFILE_PHOTO is the normal state for most users, not a problem.
    if (!e || e.code !== 'NO_PROFILE_PHOTO') {
      logger.warn('Profile photo could not be resolved for the details payload · userId='
        + userId + ' · ' + ((e && e.code) || (e && e.message) || 'unknown'));
    }
  }

  return {
    user_code:      user.user_code || null,
    /* null = render the initials monogram. Never a placeholder image URL: a
       broken <img> and "no photo set" must not look the same to the UI. */
    photo_url:      photoUrl,
    mobile_no:      user.mobile_no || null,
    alternate_no:   user.alternate_no || null,
    personal_email: (personal && personal.personal_email) || null,
    date_of_birth:  dob,
    /*
     * ── HR MASTER DATA — READ-ONLY ON THIS PAGE ──────────────────────
     * These five come off the HR master sheet and are maintained by HR in
     * Manage Users, not by the employee. They are returned so the profile
     * page can SHOW them (an employee needs to check their own UAN before a
     * PF claim, and to spot a wrong PAN before payroll does), with no
     * corresponding write path here — a correction goes to HR.
     *
     * That is why there is no `*_locked` flag beside them, unlike
     * date_of_birth: locked/unlocked is a distinction that only means
     * something for a field the employee can set at all.
     */
    date_of_joining: (personal && personal.date_of_joining)
      ? String(personal.date_of_joining).slice(0, 10) : null,
    uan:     (personal && personal.uan) || null,
    address: (personal && personal.address) || null,
    /*
     * MASKED, always, and derived from the CLEAR last4 column — this code
     * never touches the ciphertext, so there is no decrypt to get wrong. A
     * PAN or an Aadhaar shipping in full on every profile load is one sitting
     * in the browser cache and the devtools network tab, and neither has a
     * reveal flow: the employee already knows their own number, and the only
     * job this display does is let them confirm HR holds the right one.
     */
    pan_masked:     (personal && personal.pan_last4) ? `XXXXXX${personal.pan_last4}` : null,
    aadhaar_masked: (personal && personal.aadhaar_last4) ? `XXXX XXXX ${personal.aadhaar_last4}` : null,
    /*
     * EXACTLY "a date_of_birth is currently stored" — nothing else. The free
     * set is spent the moment a value exists, and the FE treats this as
     * authoritative when choosing between the direct write and the request
     * form. It is derived from `dob` and only from `dob`, so the meaningless
     * combination (dob_locked:true, date_of_birth:null) cannot be produced.
     */
    dob_locked:     dob !== null,
    /*
     * MASKED, always. The account number and the holder name are encrypted in
     * the column and neither the ciphertext nor the plaintext belongs in this
     * payload — a value that ships on every profile load is a value sitting in
     * the browser cache, the devtools network tab and any error reporter that
     * captures responses. The full values come from POST /bank/reveal, one
     * deliberate click at a time, and every one of those is audited.
     */
    bank:           maskBank(bankFromRow(personal)),
    pending: pending ? {
      request_id:   pending.request_id,
      // Same rule inside the pending draft: a requested bank change carries the
      // same secret as the live record, so it is masked the same way.
      changes:      maskChangesBank(parseJson(pending.changes) || {}),
      /*
       * The "before" travels WITH the request rather than being inferred by
       * the FE from the live record. Comparing against the live record is
       * right today and wrong the moment an approver or an admin edits that
       * record while the request is still open.
       */
      old_values:   maskChangesBank(parseJson(pending.old_values) || {}),
      requested_on: istTimestamp(pending.requested_on),
      updated_on:   istTimestamp(pending.updated_on),
    } : null,
  };
}

/*
 * PATCH /api/profile/alternate-no — direct write, no approval.
 * Blank clears the field (stored NULL, never '').
 *
 * No affectedRows check: the caller was just loaded FROM tbl_user by
 * requireAuth, so the row exists by construction — and MySQL reports
 * affectedRows=0 for a no-op UPDATE (the pool does not set CLIENT_FOUND_ROWS),
 * so re-saving the same number would look like a missing user.
 */
async function setAlternateNo(userId, raw, runner = pool) {
  const blank = raw == null || String(raw).trim() === '';
  const value = blank ? null : validateMobile(raw, 'alternate_no');
  await runner.query('UPDATE tbl_user SET alternate_no = ? WHERE user_id = ?', [value, userId]);
  logger.info('Profile alternate number updated · userId=' + userId + ' cleared=' + blank);
  return { alternate_no: value };
}

/*
 * POST /api/profile/date-of-birth — THE ONE FREE SET.
 *
 * Writes only while the stored date_of_birth is NULL. Every later correction is
 * an HR-approved request, because a date of birth is a payroll/compliance fact
 * once it is on file.
 *
 * The "only if NULL" is enforced IN THE STATEMENT, not by a read followed by a
 * write: two tabs (or two clicks) would both read NULL and both write, and the
 * one free set would become two. The IF() guards make the whole upsert a no-op
 * when a value is already present, and affectedRows===0 is the 409.
 *
 * ORDER OF THE TWO ASSIGNMENTS IS LOAD-BEARING. MySQL evaluates
 * ON DUPLICATE KEY UPDATE left to right, and a later expression sees the value
 * already assigned by an earlier one. `updated_on` must therefore be assigned
 * FIRST, while `date_of_birth` still holds the OLD value — otherwise its guard
 * reads the value we just wrote, always evaluates false, and a locked row still
 * gets its updated_on bumped (making affectedRows 2 and the 409 unreachable).
 *
 * affectedRows: 1 = inserted, 2 = updated, 0 = the row exists and is locked.
 */
async function setDateOfBirthOnce(userId, raw, runner = pool) {
  const dob = validateDateOfBirth(raw);
  const now = new Date();
  const [res] = await runner.query(
    `INSERT INTO tbl_user_personal_details (user_id, date_of_birth, created_on, updated_on)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       updated_on    = IF(date_of_birth IS NULL, VALUES(updated_on), updated_on),
       date_of_birth = IF(date_of_birth IS NULL, VALUES(date_of_birth), date_of_birth)`,
    [userId, dob, now, now],
  );
  if (!res.affectedRows) {
    throw mkErr(409, 'DOB_ALREADY_SET',
      'Your date of birth is already on file — submit a change request for HR approval');
  }
  logger.info('Profile date of birth set (first time) · userId=' + userId);
  return { date_of_birth: dob, dob_locked: true };
}

/*
 * POST /api/profile/bank/reveal — the caller's OWN bank details, in full.
 *
 * `userId` is req.user.user_id and nothing else; there is no id parameter on
 * this route, so "reveal my details" cannot become "reveal anyone's".
 *
 * THE AUDIT ROW IS WRITTEN BEFORE THE VALUE IS RETURNED, inside the same
 * transaction as the read. Order matters more than it looks: an INSERT issued
 * after the response — or on a different connection — is the one that is
 * missing when the process is killed mid-request, the pool is exhausted, or the
 * transaction rolls back, which is to say exactly during the incident the log
 * exists to explain. A reveal that cannot be recorded does not happen.
 *
 * A self-reveal is logged as loudly as any other. It is unremarkable on its own,
 * and it is the baseline that makes "this actor reveals other people's details"
 * a query rather than a hunch.
 */
async function revealOwnBank(userId, poolRef = pool, ipAddress = null) {
  const conn = await poolRef.getConnection();
  try {
    await conn.beginTransaction();
    const personal = await readPersonalRow(userId, conn);
    const stored = bankFromRow(personal);
    if (!stored.account_number) {
      throw mkErr(404, 'NO_BANK_DETAILS', 'You have no bank details on file');
    }
    // Throws on a missing key or a tampered value — the reveal fails rather
    // than returning something that only looks like an account number.
    const plain = decryptBank(stored);
    await recordReveal(conn, {
      actorUserId: userId, subjectUserId: userId, context: 'profile_self', refId: null, ipAddress,
    });
    await conn.commit();
    return plain;
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = {
  getMyProfile,
  setAlternateNo,
  setDateOfBirthOnce,
  revealOwnBank,
  // Field rules — imported by profile-update-request.service so submission and
  // approve-time re-validation share ONE definition.
  validateMobile,
  validateDateOfBirth,
  normaliseBank,
  parseJson,
  bankFromRow,
  istTimestamp,
  mkErr,
  MOBILE_RE,
  IFSC_RE,
  BANK_KEYS,
  // Bank shape conversions — the ONE place PLAIN ⇄ STORED ⇄ MASKED happens, so
  // profile-update-request.service cannot grow a second, drifting copy.
  encryptBank,
  decryptBank,
  maskBank,
  maskChangesBank,
  recordReveal,
  PERSONAL_COLUMNS,
};
