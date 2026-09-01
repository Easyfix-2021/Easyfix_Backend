const { pool } = require('../db');
const logger = require('../logger');
const { todayIst } = require('../utils/ist-calendar');

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
// EasyFix-owned; the four bank_* columns and date_of_birth are added by the
// HRMS migration alongside the pre-existing personal_email.
const PERSONAL_COLUMNS = `personal_email, date_of_birth,
         bank_account_number, bank_ifsc, bank_account_name, bank_name`;

function bankFromRow(row) {
  return {
    account_number: (row && row.bank_account_number) || null,
    ifsc:           (row && row.bank_ifsc) || null,
    account_name:   (row && row.bank_account_name) || null,
    bank_name:      (row && row.bank_name) || null,
  };
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

  const [[personal]] = await runner.query(
    `SELECT ${PERSONAL_COLUMNS} FROM tbl_user_personal_details WHERE user_id = ? LIMIT 1`,
    [userId],
  );
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

  return {
    user_code:      user.user_code || null,
    mobile_no:      user.mobile_no || null,
    alternate_no:   user.alternate_no || null,
    personal_email: (personal && personal.personal_email) || null,
    date_of_birth:  dob,
    /*
     * EXACTLY "a date_of_birth is currently stored" — nothing else. The free
     * set is spent the moment a value exists, and the FE treats this as
     * authoritative when choosing between the direct write and the request
     * form. It is derived from `dob` and only from `dob`, so the meaningless
     * combination (dob_locked:true, date_of_birth:null) cannot be produced.
     */
    dob_locked:     dob !== null,
    bank:           bankFromRow(personal),
    pending: pending ? {
      request_id:   pending.request_id,
      changes:      parseJson(pending.changes) || {},
      /*
       * The "before" travels WITH the request rather than being inferred by
       * the FE from the live record. Comparing against the live record is
       * right today and wrong the moment an approver or an admin edits that
       * record while the request is still open.
       */
      old_values:   parseJson(pending.old_values) || {},
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

module.exports = {
  getMyProfile,
  setAlternateNo,
  setDateOfBirthOnce,
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
};
